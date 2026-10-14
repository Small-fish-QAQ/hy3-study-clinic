import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ProviderConfigUpdateSchema,
  ProviderModeSchema,
  ReasoningEffortPreferenceSchema,
  type ReasoningEffortPreference,
  type ProviderMode,
  type ProviderConfigSource,
  type SafeProviderConfig,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { createProvider } from '../llm/courseFactory.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { CourseProvider } from '../llm/courseContract.js';
import type { AppConfig } from '../config.js';
import { normalizeApiBaseUrl } from '../llm/compatibleEndpoint.js';
import { apiEndpoint } from '../llm/compatibleEndpoint.js';
import { ProviderSecrets } from './providerSecrets.js';

const StoredProviderConfigSchema = z
  .object({
    version: z.literal(1),
    timeoutMs: z.number().int().positive().optional(),
    longTaskTimeoutMs: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    reasoningEstimate: z.number().int().nonnegative().optional(),
    reasoningEffort: ReasoningEffortPreferenceSchema.optional(),
    provider: ProviderModeSchema,
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
    let content: string;
    try {
      content = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AppError('INTERNAL', '无法读取模型服务配置，请检查本机存储权限。');
    }
    try {
      const raw: unknown = JSON.parse(content);
      const encrypted = StoredProviderConfigSchema.omit({ version: true, apiKey: true })
        .extend({
          version: z.literal(2),
          encryptedSecret: z
            .object({ iv: z.string(), tag: z.string(), ciphertext: z.string() })
            .strict()
            .optional(),
        })
        .strict();
      if ((raw as { version?: unknown })?.version === 2) {
        const stored = encrypted.parse(raw);
        const { encryptedSecret, ...metadata } = stored;
        return StoredProviderConfigSchema.parse({
          ...metadata,
          version: 1,
          ...(encryptedSecret
            ? { apiKey: new ProviderSecrets(`${this.path}.key`).decrypt(encryptedSecret) }
            : {}),
        });
      }
      const legacy = StoredProviderConfigSchema.parse(raw);
      this.write(legacy); // One-time credential encryption; historical course data is untouched.
      return legacy;
    } catch {
      throw new AppError('INTERNAL', '无法读取模型服务配置，请检查本机配置文件和加密密钥。');
    }
  }

  write(config: StoredProviderConfig): void {
    const absolute = resolve(this.path);
    mkdirSync(dirname(absolute), { recursive: true });
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    try {
      const { apiKey, ...metadata } = StoredProviderConfigSchema.parse(config);
      const stored = {
        ...metadata,
        version: 2,
        ...(apiKey
          ? { encryptedSecret: new ProviderSecrets(`${absolute}.key`).encrypt(apiKey) }
          : {}),
      };
      writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        chmodSync(temp, 0o600);
      } catch {
        /* Windows ACLs are managed by the user. */
      }
      renameSync(temp, absolute);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort cleanup */
      }
      throw new AppError('INTERNAL', '无法保存模型服务配置，请检查本机存储权限。');
    }
  }
}

export interface ProviderRuntimeConfig {
  provider: ProviderMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  source: ProviderConfigSource;
  timeoutMs?: number;
  longTaskTimeoutMs?: number;
  maxOutputTokens?: number;
  contextTokens?: number;
  reasoningEstimate?: number;
  reasoningEffort?: ReasoningEffortPreference;
}

interface ActiveSnapshot extends ProviderRuntimeConfig {
  generation: number;
  providerInstance: CourseProvider;
}

export interface ProviderRuntimeOptions {
  startup: AppConfig;
  store?: ProviderConfigStore | null;
  initialProvider?: CourseProvider;
}

/** Server-owned provider configuration and atomic runtime activation. */
export class ProviderRuntime {
  private readonly requestSnapshots = new AsyncLocalStorage<ActiveSnapshot>();
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly startup: AppConfig;
  private readonly automationExpectedProvider: 'fake' | undefined;
  private readonly externalVisualProviderEnabled: boolean;
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
    this.startup = options.startup;
    this.timeoutMs = options.startup.hy3TimeoutMs;
    this.maxOutputTokens = options.startup.modelMaxOutputTokens ?? 64_000;
    this.automationExpectedProvider = options.startup.automationExpectedProvider;
    this.externalVisualProviderEnabled = options.startup.visualProvider === 'tokenhub';
    this.store = options.store ?? null;
    const saved = this.store?.read() ?? null;
    const savedConfig: ProviderRuntimeConfig | null = saved
      ? {
          provider: saved.provider,
          ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
          ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
          ...(saved.model ? { model: saved.model } : {}),
          source: 'saved',
          timeoutMs: saved.timeoutMs,
          longTaskTimeoutMs: saved.longTaskTimeoutMs,
          maxOutputTokens: saved.maxOutputTokens,
          contextTokens: saved.contextTokens,
          reasoningEstimate: saved.reasoningEstimate,
          reasoningEffort: saved.reasoningEffort,
        }
      : null;
    const savedIsUsable = savedConfig !== null;
    const environmentHasValues =
      options.startup.providerEnvironmentConfigured ??
      Boolean(
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
      timeoutMs: options.startup.hy3TimeoutMs,
      longTaskTimeoutMs: options.startup.longTaskTimeoutMs,
      maxOutputTokens: options.startup.modelMaxOutputTokens,
      contextTokens: options.startup.modelContextTokens,
      reasoningEstimate: options.startup.modelReasoningEstimate,
      reasoningEffort: options.startup.modelReasoningEffort,
    };
    const config: ProviderRuntimeConfig = savedConfig ?? environmentConfig;
    if (config.baseUrl) config.baseUrl = normalizeApiBaseUrl(config.baseUrl);
    this.assertAutomationIsolation(config);
    this.validate(config, false);
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
  get provider(): CourseProvider {
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

  safeConfig(): SafeProviderConfig & {
    timeoutMs: number;
    longTaskTimeoutMs: number;
    maxOutputTokens: number;
    contextTokens: number | null;
    reasoningEstimate: number | null;
  } {
    const active = this.active;
    const baseUrl = active.baseUrl ?? null;
    const model = active.model ?? null;
    const complete = active.provider === 'fake' || Boolean(baseUrl && active.apiKey && model);
    return {
      provider: active.provider,
      timeoutMs: active.timeoutMs ?? this.timeoutMs,
      longTaskTimeoutMs: active.longTaskTimeoutMs ?? this.startup.longTaskTimeoutMs ?? 240_000,
      maxOutputTokens: active.maxOutputTokens ?? this.maxOutputTokens,
      contextTokens: active.contextTokens ?? this.startup.modelContextTokens ?? null,
      reasoningEstimate: active.reasoningEstimate ?? this.startup.modelReasoningEstimate ?? null,
      reasoningEffort: active.reasoningEffort ?? this.startup.modelReasoningEffort ?? 'auto',
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
    const next = this.resolveDraft(input);
    this.assertAutomationIsolation(next);
    // Explicit credential removal persists a disabled real connection, never Fake.
    this.validate(next, parsed.secret?.action !== 'remove');
    const providerInstance =
      next.provider === current.provider &&
      next.baseUrl === current.baseUrl &&
      next.model === current.model &&
      next.apiKey === current.apiKey &&
      next.timeoutMs === current.timeoutMs &&
      next.longTaskTimeoutMs === current.longTaskTimeoutMs &&
      next.maxOutputTokens === current.maxOutputTokens &&
      next.contextTokens === current.contextTokens &&
      next.reasoningEstimate === current.reasoningEstimate &&
      next.reasoningEffort === current.reasoningEffort
        ? current.providerInstance
        : this.construct(next, this.timeoutMs);
    this.store?.write({
      version: 1,
      provider: next.provider,
      timeoutMs: next.timeoutMs,
      longTaskTimeoutMs: next.longTaskTimeoutMs,
      maxOutputTokens: next.maxOutputTokens,
      contextTokens: next.contextTokens,
      reasoningEstimate: next.reasoningEstimate,
      reasoningEffort: next.reasoningEffort,
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
    if (active.provider === 'fake') return this.safeConfig();
    if (!active.apiKey || !active.baseUrl || !active.model)
      throw new AppError('VALIDATION_ERROR', '模型服务配置尚未完整。');
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

  draftProvider(input: unknown): CourseProvider {
    const config = this.resolveDraft(input);
    this.assertAutomationIsolation(config);
    this.validate(config);
    return this.construct(config, this.timeoutMs);
  }

  async listModels(input: unknown, signal?: AbortSignal): Promise<{ models: string[] }> {
    const config = this.resolveDraft(input);
    this.assertAutomationIsolation(config);
    if (config.provider === 'fake' || !config.baseUrl || !config.apiKey)
      throw new AppError('VALIDATION_ERROR', '获取模型需要 API 地址和 Key。');
    if (signal?.aborted) throw ProviderError.cancelled();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(this.timeoutMs, 15_000),
    );
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(apiEndpoint(config.baseUrl, 'models'), {
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw ProviderError.http(response.status);
      const raw: unknown = await response.json();
      if (controller.signal.aborted) throw new Error('aborted');
      const parsed = z
        .object({ data: z.array(z.object({ id: z.string().trim().min(1).max(256) })) })
        .safeParse(raw);
      if (!parsed.success) throw ProviderError.invalidOutput('模型列表格式不兼容。');
      return {
        models: [...new Set(parsed.data.data.map((model) => model.id))]
          .filter((model) => !model.includes(config.apiKey!))
          .slice(0, 1000),
      };
    } catch (error) {
      if (signal?.aborted) throw ProviderError.cancelled();
      if (timedOut) throw ProviderError.timeout(Math.min(this.timeoutMs, 15_000));
      if (error instanceof ProviderError) throw error;
      if (error instanceof SyntaxError) throw ProviderError.invalidOutput('模型列表格式不兼容。');
      throw ProviderError.network();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  private resolveDraft(input: unknown): ProviderRuntimeConfig {
    const parsed = ProviderConfigUpdateSchema.parse(input);
    const current = this.active;
    if (parsed.expectedGeneration !== undefined && parsed.expectedGeneration !== current.generation)
      throw new AppError('VERSION_CONFLICT', '模型服务配置已更新，请重新读取后再操作。');
    const samePlatform =
      parsed.provider === current.provider ||
      (current.provider === 'fake' && parsed.provider === 'hy3');
    const next: ProviderRuntimeConfig = {
      provider: parsed.provider,
      baseUrl:
        parsed.baseUrl !== undefined
          ? parsed.baseUrl || undefined
          : samePlatform
            ? current.baseUrl
            : undefined,
      model:
        parsed.model !== undefined
          ? parsed.model || undefined
          : samePlatform
            ? current.model
            : undefined,
      apiKey: samePlatform ? current.apiKey : undefined,
      source: 'saved',
      timeoutMs: parsed.timeoutMs ?? current.timeoutMs,
      longTaskTimeoutMs: parsed.longTaskTimeoutMs ?? current.longTaskTimeoutMs,
      maxOutputTokens: parsed.maxOutputTokens ?? current.maxOutputTokens,
      contextTokens: parsed.contextTokens ?? current.contextTokens,
      reasoningEstimate: parsed.reasoningEstimate ?? current.reasoningEstimate,
      reasoningEffort: parsed.reasoningEffort ?? current.reasoningEffort,
    };
    if (parsed.secret?.action === 'replace') next.apiKey = parsed.secret.value;
    if (parsed.secret?.action === 'remove') next.apiKey = undefined;
    if (next.baseUrl) next.baseUrl = normalizeApiBaseUrl(next.baseUrl);
    return next;
  }

  private validate(config: ProviderRuntimeConfig, requireComplete = true): void {
    if (
      requireComplete &&
      config.provider !== 'fake' &&
      (!config.baseUrl || !config.model || !config.apiKey)
    )
      throw new AppError('VALIDATION_ERROR', '模型服务需要完整的 API 地址、API Key 和 Model ID。');
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

  private assertAutomationIsolation(config: ProviderRuntimeConfig): void {
    if (!this.automationExpectedProvider) return;
    if (config.provider !== this.automationExpectedProvider || this.externalVisualProviderEnabled) {
      throw new AppError(
        'VALIDATION_ERROR',
        `自动化环境要求最终提供程序为 ${this.automationExpectedProvider} 且禁用外部视觉提供程序；` +
          `当前解析结果为 ${config.provider}（来源：${config.source}）。已在首次提供程序请求前停止。`,
      );
    }
  }

  private construct(config: ProviderRuntimeConfig, timeoutMs: number): CourseProvider {
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
        visualProvider: 'disabled',
        tokenHubVisualBaseUrl: undefined,
        tokenHubVisualApiKey: undefined,
        tokenHubVisualModel: 'hy-vision-2.0-instruct',
        tokenHubVisualTimeoutMs: 120_000,
        providerConfigPath: '',
      });
    return createProvider({
      provider: config.provider,
      port: 0,
      host: '127.0.0.1',
      databasePath: '',
      hy3BaseUrl: config.baseUrl,
      hy3ApiKey: config.apiKey,
      hy3Model: config.model,
      hy3TimeoutMs: config.timeoutMs ?? timeoutMs,
      longTaskTimeoutMs: config.longTaskTimeoutMs ?? this.startup.longTaskTimeoutMs ?? 240_000,
      modelMaxOutputTokens: config.maxOutputTokens ?? this.maxOutputTokens,
      modelContextTokens: config.contextTokens ?? this.startup.modelContextTokens,
      modelReasoningEstimate: config.reasoningEstimate ?? this.startup.modelReasoningEstimate,
      modelReasoningEffort: config.reasoningEffort ?? this.startup.modelReasoningEffort,
      visualProvider: 'disabled',
      tokenHubVisualBaseUrl: undefined,
      tokenHubVisualApiKey: undefined,
      tokenHubVisualModel: 'hy-vision-2.0-instruct',
      tokenHubVisualTimeoutMs: 120_000,
      providerConfigPath: '',
    });
  }
}

/** Request-facing facade; services continue to depend on the existing CourseProvider contract. */
export function createRuntimeProvider(runtime: ProviderRuntime): CourseProvider {
  return new Proxy({} as CourseProvider, {
    get(_target, property) {
      if (property === 'name') return runtime.providerName;
      if (property === 'model') return runtime.providerModel;
      const value = runtime.provider[property as keyof CourseProvider];
      return typeof value === 'function' ? value.bind(runtime.provider) : value;
    },
  });
}
