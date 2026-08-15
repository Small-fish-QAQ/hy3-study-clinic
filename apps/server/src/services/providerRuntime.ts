import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ProviderConfigUpdateSchema,
  type ProviderMode,
  type ProviderConfigSource,
  type SafeProviderConfig,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { createProvider } from '../llm/factory.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { AppConfig } from '../config.js';

const StoredProviderConfigSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(['fake', 'hy3']),
    baseUrl: z.string().trim().max(2048).optional(),
    model: z.string().trim().max(256).optional(),
    apiKey: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type StoredProviderConfig = z.infer<typeof StoredProviderConfigSchema>;

export interface ProviderConfigStore {
  read(): StoredProviderConfig | null;
  write(config: StoredProviderConfig): void;
}

export class JsonProviderConfigStore implements ProviderConfigStore {
  constructor(readonly path: string) {}

  read(): StoredProviderConfig | null {
    try {
      return StoredProviderConfigSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return null;
    }
  }

  write(config: StoredProviderConfig): void {
    const absolute = resolve(this.path);
    mkdirSync(dirname(absolute), { recursive: true });
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        chmodSync(temp, 0o600);
      } catch {
        /* Windows ACLs are managed by the user. */
      }
      renameSync(temp, absolute);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort cleanup */
      }
      throw error;
    }
  }
}

export interface ProviderRuntimeConfig {
  provider: ProviderMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  source: ProviderConfigSource;
}

interface ActiveSnapshot extends ProviderRuntimeConfig {
  generation: number;
  providerInstance: LlmProvider;
}

export interface ProviderRuntimeOptions {
  startup: AppConfig;
  store?: ProviderConfigStore | null;
  initialProvider?: LlmProvider;
}

/** Server-owned provider configuration and atomic runtime activation. */
export class ProviderRuntime {
  private readonly requestSnapshots = new AsyncLocalStorage<ActiveSnapshot>();
  private readonly timeoutMs: number;
  private connectionTestId = 0;
  private active: ActiveSnapshot;
  private connection: SafeProviderConfig['externalConnection'] = {
    status: 'untested',
    testedGeneration: null,
    testedAt: null,
    message: null,
  };
  readonly store: ProviderConfigStore | null;

  constructor(options: ProviderRuntimeOptions) {
    this.timeoutMs = options.startup.hy3TimeoutMs;
    this.store = options.store ?? null;
    const saved = this.store?.read() ?? null;
    const savedConfig: ProviderRuntimeConfig | null = saved
      ? {
          provider: saved.provider,
          ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
          ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
          ...(saved.model ? { model: saved.model } : {}),
          source: 'saved',
        }
      : null;
    const savedIsUsable = savedConfig !== null && this.isValid(savedConfig);
    const environmentHasValues = Boolean(
      options.startup.provider !== 'fake' ||
      options.startup.hy3BaseUrl ||
      options.startup.hy3ApiKey ||
      options.startup.hy3Model,
    );
    const source: ProviderConfigSource = savedIsUsable
      ? 'saved'
      : environmentHasValues
        ? 'environment'
        : 'default';
    const environmentConfig: ProviderRuntimeConfig = {
      provider: options.startup.provider,
      ...(options.startup.hy3BaseUrl ? { baseUrl: options.startup.hy3BaseUrl } : {}),
      ...(options.startup.hy3ApiKey ? { apiKey: options.startup.hy3ApiKey } : {}),
      ...(options.startup.hy3Model ? { model: options.startup.hy3Model } : {}),
      source,
    };
    const config: ProviderRuntimeConfig = savedIsUsable
      ? savedConfig
      : this.isValid(environmentConfig)
        ? environmentConfig
        : {
            provider: 'fake',
            ...(this.isSafeBaseUrl(options.startup.hy3BaseUrl)
              ? { baseUrl: options.startup.hy3BaseUrl }
              : {}),
            ...(options.startup.hy3ApiKey ? { apiKey: options.startup.hy3ApiKey } : {}),
            ...(options.startup.hy3Model ? { model: options.startup.hy3Model } : {}),
            source,
          };
    this.validate(config);
    const providerInstance =
      options.initialProvider && !savedIsUsable && options.initialProvider.name === config.provider
        ? options.initialProvider
        : this.construct(config, this.timeoutMs);
    this.active = { ...config, generation: 1, providerInstance };
  }

  /** Enter a request-scoped immutable provider snapshot. */
  enterRequest(): void {
    this.requestSnapshots.enterWith(this.active);
  }
  get provider(): LlmProvider {
    return this.requestSnapshots.getStore()?.providerInstance ?? this.active.providerInstance;
  }
  get providerModel(): string | undefined {
    const snapshot = this.requestSnapshots.getStore();
    return snapshot ? snapshot.model : this.active.model;
  }
  get providerName(): ProviderMode {
    return this.provider.name;
  }
  get generation(): number {
    return this.requestSnapshots.getStore()?.generation ?? this.active.generation;
  }

  safeConfig(): SafeProviderConfig {
    const active = this.active;
    const baseUrl = active.baseUrl ?? null;
    const model = active.model ?? null;
    const complete = active.provider === 'fake' || Boolean(baseUrl && active.apiKey && model);
    return {
      provider: active.provider,
      baseUrl,
      model,
      apiKeyConfigured: Boolean(active.apiKey),
      source: active.source,
      complete,
      runtimeGeneration: active.generation,
      externalConnection: { ...this.connection },
    };
  }

  update(input: unknown): SafeProviderConfig {
    const parsed = ProviderConfigUpdateSchema.parse(input);
    const current = this.active;
    const next: ProviderRuntimeConfig = {
      provider: parsed.provider,
      baseUrl: parsed.baseUrl !== undefined ? parsed.baseUrl || undefined : current.baseUrl,
      model: parsed.model !== undefined ? parsed.model || undefined : current.model,
      apiKey: current.apiKey,
      source: 'saved',
    };
    if (parsed.secret?.action === 'replace') next.apiKey = parsed.secret.value;
    if (parsed.secret?.action === 'remove') next.apiKey = undefined;
    this.validate(next);
    const providerInstance =
      next.provider === current.provider &&
      next.baseUrl === current.baseUrl &&
      next.model === current.model &&
      next.apiKey === current.apiKey
        ? current.providerInstance
        : this.construct(next, this.timeoutMs);
    this.store?.write({
      version: 1,
      provider: next.provider,
      ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
      ...(next.model ? { model: next.model } : {}),
      ...(next.apiKey ? { apiKey: next.apiKey } : {}),
    });
    this.active = { ...next, generation: current.generation + 1, providerInstance };
    this.connectionTestId += 1;
    this.connection = { status: 'untested', testedGeneration: null, testedAt: null, message: null };
    return this.safeConfig();
  }

  async testConnection(
    signal?: AbortSignal,
    invoke?: (options: ProviderCallOptions) => Promise<void>,
  ): Promise<SafeProviderConfig> {
    const active = this.active;
    if (active.provider !== 'hy3') return this.safeConfig();
    if (!active.apiKey || !active.baseUrl || !active.model)
      throw new AppError('VALIDATION_ERROR', 'Hy3 配置尚未完整。');
    const testId = ++this.connectionTestId;
    this.connection = {
      status: 'testing',
      testedGeneration: active.generation,
      testedAt: null,
      message: null,
    };
    try {
      await (invoke ? invoke({ signal }) : active.providerInstance.testConnection({ signal }));
      if (this.active.generation === active.generation && this.connectionTestId === testId)
        this.connection = {
          status: 'verified',
          testedGeneration: active.generation,
          testedAt: new Date().toISOString(),
          message: '连接正常。',
        };
    } catch (error) {
      const normalized =
        error instanceof ProviderError
          ? error
          : signal?.aborted
            ? ProviderError.cancelled()
            : ProviderError.network();
      const cancelled = normalized.code === 'REQUEST_CANCELLED';
      if (this.active.generation === active.generation && this.connectionTestId === testId) {
        this.connection = cancelled
          ? { status: 'untested', testedGeneration: null, testedAt: null, message: null }
          : {
              status: 'failed',
              testedGeneration: active.generation,
              testedAt: new Date().toISOString(),
              message: normalized.message,
            };
      }
      throw normalized;
    }
    return this.safeConfig();
  }

  private validate(config: ProviderRuntimeConfig): void {
    if (config.provider === 'hy3' && (!config.baseUrl || !config.model || !config.apiKey))
      throw new AppError('VALIDATION_ERROR', 'Hy3 模式需要完整的 API 地址、API Key 和模型。');
    if (!config.baseUrl) return;
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'API 地址必须是有效的 URL。');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AppError('VALIDATION_ERROR', 'API 地址必须使用不含凭据的 HTTP(S) URL。');
  }

  private isValid(config: ProviderRuntimeConfig): boolean {
    try {
      this.validate(config);
      return true;
    } catch {
      return false;
    }
  }

  private isSafeBaseUrl(baseUrl: string | undefined): baseUrl is string {
    if (!baseUrl) return false;
    return this.isValid({ provider: 'fake', baseUrl, source: 'environment' });
  }

  private construct(config: ProviderRuntimeConfig, timeoutMs: number): LlmProvider {
    if (config.provider === 'fake')
      return createProvider({
        provider: 'fake',
        port: 0,
        host: '127.0.0.1',
        databasePath: '',
        hy3BaseUrl: undefined,
        hy3ApiKey: undefined,
        hy3Model: undefined,
        hy3TimeoutMs: timeoutMs,
        providerConfigPath: '',
      });
    return createProvider({
      provider: 'hy3',
      port: 0,
      host: '127.0.0.1',
      databasePath: '',
      hy3BaseUrl: config.baseUrl,
      hy3ApiKey: config.apiKey,
      hy3Model: config.model,
      hy3TimeoutMs: timeoutMs,
      providerConfigPath: '',
    });
  }
}

/** Request-facing facade; services continue to depend on the existing LlmProvider contract. */
export function createRuntimeProvider(runtime: ProviderRuntime): LlmProvider {
  return new Proxy({} as LlmProvider, {
    get(_target, property) {
      if (property === 'name') return runtime.providerName;
      if (property === 'model') return runtime.providerModel;
      const value = runtime.provider[property as keyof LlmProvider];
      return typeof value === 'function' ? value.bind(runtime.provider) : value;
    },
  });
}
