import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonProviderConfigStore,
  ProviderRuntime,
  type ProviderConfigStore,
  type StoredProviderConfig,
} from './providerRuntime.js';
import { CourseFakeProvider as FakeProvider } from '../llm/courseFakeProvider.js';
import type { AppConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { CourseProvider as LlmProvider } from '../llm/courseContract.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryConfigPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hy3-provider-runtime-'));
  tempDirectories.push(directory);
  return join(directory, 'provider-config.json');
}

function mockedHy3Provider(
  testConnection: (opts?: ProviderCallOptions) => Promise<void>,
): LlmProvider {
  const fake = new FakeProvider();
  return new Proxy(fake as LlmProvider, {
    get(target, property) {
      if (property === 'name') return 'hy3';
      if (property === 'model') return 'mock-model';
      if (property === 'testConnection') return testConnection;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const startup: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  databasePath: ':memory:',
  provider: 'fake',
  hy3BaseUrl: undefined,
  hy3ApiKey: undefined,
  hy3Model: undefined,
  hy3TimeoutMs: 30_000,
  providerConfigPath: '',
};

class MemoryStore implements ProviderConfigStore {
  value: StoredProviderConfig | null = null;
  read() {
    return this.value;
  }
  write(config: StoredProviderConfig) {
    this.value = config;
  }
}

describe('ProviderRuntime', () => {
  it('推理偏好保存重启，显式平台默认可恢复自动；不改模型身份', () => {
    const store = new MemoryStore(),
      runtime = new ProviderRuntime({ startup, store });
    runtime.update({
      provider: 'moma',
      baseUrl: 'https://model.test/v1',
      model: 'glm-5.3',
      secret: { action: 'replace', value: 'offline-private' },
      reasoningEffort: 'high',
    });
    expect(store.value?.reasoningEffort).toBe('high');
    const restarted = new ProviderRuntime({ startup, store });
    expect(restarted.safeConfig()).toMatchObject({ model: 'glm-5.3', reasoningEffort: 'high' });
    restarted.update({ provider: 'moma', reasoningEffort: 'provider-default' });
    expect(restarted.safeConfig().reasoningEffort).toBe('provider-default');
    restarted.update({ provider: 'moma', reasoningEffort: 'auto' });
    expect(restarted.safeConfig()).toMatchObject({ model: 'glm-5.3', reasoningEffort: 'auto' });
  });
  it('keeps an unconfigured default MoMA identity without inventing environment provenance or Fake output', async () => {
    const runtime = new ProviderRuntime({
      startup: loadConfig({}, { allowIncompleteProvider: true }),
    });
    expect(runtime.safeConfig()).toMatchObject({
      provider: 'moma',
      source: 'default',
      complete: false,
      apiKeyConfigured: false,
    });
    await expect(runtime.provider.testConnection()).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
  it.each(['moma', 'compatible'] as const)(
    'keeps in-flight %s tasks on their endpoint while newly entered requests use the new connection',
    async (platform) => {
      const runtime = new ProviderRuntime({ startup });
      runtime.update({
        provider: platform,
        baseUrl: 'https://old.test/v1',
        model: 'shared-model',
        secret: { action: 'replace', value: 'offline-old-key' },
      });
      const scope = new AsyncResource('model-task-old');
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const pending = scope.runInAsyncScope(async () => {
        runtime.enterRequest();
        const oldProvider = runtime.provider;
        await gate;
        expect(runtime.provider).toBe(oldProvider);
        expect(runtime.provider.name).toBe(platform);
        expect(runtime.provider.model).toBe('shared-model');
        return runtime.provider.endpointIdentity;
      });
      runtime.update({
        provider: platform,
        baseUrl: 'https://new.test/v1',
        model: 'shared-model',
        secret: { action: 'replace', value: 'offline-new-key' },
      });
      const fresh = new AsyncResource('model-task-new');
      const newEndpoint = fresh.runInAsyncScope(() => {
        runtime.enterRequest();
        return runtime.provider.endpointIdentity;
      });
      release();
      expect(await pending).not.toBe(newEndpoint);
      expect(runtime.safeConfig()).toMatchObject({ provider: platform, runtimeGeneration: 3 });
      scope.emitDestroy();
      fresh.emitDestroy();
    },
  );
  it.each(['moma', 'compatible'] as const)(
    'encrypts and reloads %s independently of legacy environment settings',
    (platform) => {
      const path = temporaryConfigPath();
      const store = new JsonProviderConfigStore(path);
      const first = new ProviderRuntime({ startup, store });
      first.update({
        provider: platform,
        baseUrl: 'https://saved.test/v1/chat/completions/',
        model: 'saved-model',
        secret: { action: 'replace', value: 'offline-encrypted-secret' },
      });
      const reloaded = new ProviderRuntime({
        startup: {
          ...startup,
          provider: 'hy3',
          hy3BaseUrl: 'invalid-legacy-url',
          hy3ApiKey: 'old-secret',
          hy3Model: 'old-model',
        },
        store,
      });
      expect(reloaded.safeConfig()).toMatchObject({
        provider: platform,
        baseUrl: 'https://saved.test/v1',
        model: 'saved-model',
        source: 'saved',
        apiKeyConfigured: true,
      });
      expect(readFileSync(path, 'utf8')).not.toContain('offline-encrypted-secret');
      expect(readFileSync(`${path}.key`, 'utf8')).not.toContain('offline-encrypted-secret');
      expect(reloaded.provider.name).toBe(platform);
    },
  );
  it('encrypts a legacy v1 secret once without relabelling the historical Hy3 connection', () => {
    const path = temporaryConfigPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        provider: 'hy3',
        baseUrl: 'https://old.test/v1',
        model: 'legacy',
        apiKey: 'offline-legacy-key',
      }),
    );
    const store = new JsonProviderConfigStore(path);
    expect(store.read()).toMatchObject({ provider: 'hy3', apiKey: 'offline-legacy-key' });
    expect(readFileSync(path, 'utf8')).not.toContain('offline-legacy-key');
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  });
  it('fails closed after an encryption key is lost and does not overwrite the configuration', () => {
    const path = temporaryConfigPath();
    const store = new JsonProviderConfigStore(path);
    store.write({
      version: 1,
      provider: 'moma',
      baseUrl: 'https://model.test/v1',
      model: 'model',
      apiKey: 'offline-lost-key',
    });
    const original = readFileSync(path, 'utf8');
    rmSync(`${path}.key`);
    expect(() => new ProviderRuntime({ startup, store })).toThrow(/无法读取模型服务配置/);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('requires new credentials on a platform switch and rejects stale activation', () => {
    const runtime = new ProviderRuntime({ startup });
    runtime.update({
      provider: 'moma',
      baseUrl: 'https://saved.test/v1',
      model: 'model',
      secret: { action: 'replace', value: 'offline-key' },
    });
    expect(() =>
      runtime.update({
        provider: 'compatible',
        baseUrl: 'https://other.test/v1',
        model: 'model',
        secret: { action: 'unchanged' },
      }),
    ).toThrow(/完整/);
    expect(() => runtime.update({ provider: 'moma', expectedGeneration: 1 })).toThrow(/已更新/);
    expect(runtime.safeConfig().provider).toBe('moma');
  });
  it('returns safe state and persists intentional updates without returning a secret', () => {
    const store = new MemoryStore();
    const runtime = new ProviderRuntime({ startup, store, initialProvider: new FakeProvider() });
    const result = runtime.update({
      provider: 'hy3',
      baseUrl: 'https://example.test/v1',
      model: 'model',
      secret: { action: 'replace', value: 'sentinel-key' },
    });
    expect(result).toMatchObject({
      provider: 'hy3',
      apiKeyConfigured: true,
      source: 'saved',
      complete: true,
    });
    expect(JSON.stringify(result)).not.toContain('sentinel-key');
    expect(store.value.apiKey).toBe('sentinel-key');
    expect(runtime.safeConfig().externalConnection.status).toBe('untested');
  });

  it('preserves the prior secret when omitted and removes only explicitly', () => {
    const store = new MemoryStore();
    const runtime = new ProviderRuntime({ startup, store, initialProvider: new FakeProvider() });
    runtime.update({
      provider: 'hy3',
      baseUrl: 'https://example.test/v1',
      model: 'model',
      secret: { action: 'replace', value: 'sentinel-key' },
    });
    runtime.update({
      provider: 'hy3',
      baseUrl: 'https://example.test/v2',
      model: 'model',
      secret: { action: 'unchanged' },
    });
    expect(store.value.apiKey).toBe('sentinel-key');
    runtime.update({ provider: 'fake', secret: { action: 'remove' } });
    expect(store.value.apiKey).toBeUndefined();
  });

  it('rejects unsafe URLs and preserves the active configuration', () => {
    const runtime = new ProviderRuntime({ startup, initialProvider: new FakeProvider() });
    expect(() =>
      runtime.update({
        provider: 'hy3',
        baseUrl: 'https://user:pass@example.test',
        model: 'm',
        secret: { action: 'replace', value: 'key' },
      }),
    ).toThrow();
    expect(runtime.safeConfig().provider).toBe('fake');
  });

  it('uses a complete saved override ahead of an incomplete Hy3 environment', () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      provider: 'fake',
      baseUrl: 'https://example.test/v1',
      model: 'saved-model',
      apiKey: 'saved-key',
    };
    const runtime = new ProviderRuntime({
      startup: { ...startup, provider: 'hy3' },
      store,
    });
    expect(runtime.safeConfig()).toMatchObject({ provider: 'fake', source: 'saved' });
  });

  it('fails closed before provider use when Fake automation resolves saved Hy3', () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      provider: 'hy3',
      baseUrl: 'https://saved.test/v1',
      apiKey: 'saved-secret',
      model: 'saved-model',
    };
    let providerCalls = 0;
    const injected = mockedHy3Provider(async () => {
      providerCalls += 1;
    });

    expect(
      () =>
        new ProviderRuntime({
          startup: { ...startup, automationExpectedProvider: 'fake' },
          store,
          initialProvider: injected,
        }),
    ).toThrow(/首次提供程序请求前停止/);
    expect(providerCalls).toBe(0);
  });

  it('prevents guarded Fake automation from activating Hy3 at runtime', () => {
    const runtime = new ProviderRuntime({
      startup: { ...startup, automationExpectedProvider: 'fake' },
      initialProvider: new FakeProvider(),
    });

    expect(() =>
      runtime.update({
        provider: 'hy3',
        baseUrl: 'https://example.test/v1',
        model: 'model',
        secret: { action: 'replace', value: 'secret' },
      }),
    ).toThrow(/最终提供程序为 fake/);
    expect(runtime.safeConfig()).toMatchObject({ provider: 'fake', runtimeGeneration: 1 });
  });

  it('rejects external visual transport in guarded offline automation', () => {
    expect(
      () =>
        new ProviderRuntime({
          startup: {
            ...startup,
            automationExpectedProvider: 'fake',
            visualProvider: 'tokenhub',
          },
          initialProvider: new FakeProvider(),
        }),
    ).toThrow(/禁用外部视觉提供程序/);
  });

  it('keeps an intentionally disabled saved connection ahead of complete environment', () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      provider: 'hy3',
      baseUrl: 'https://saved.test/v1',
      model: 'saved-model',
    };
    const runtime = new ProviderRuntime({
      startup: {
        ...startup,
        provider: 'hy3',
        hy3BaseUrl: 'https://environment.test/v1',
        hy3ApiKey: 'environment-secret',
        hy3Model: 'environment-model',
      },
      store,
    });

    expect(runtime.safeConfig()).toMatchObject({
      provider: 'hy3',
      baseUrl: 'https://saved.test/v1',
      model: 'saved-model',
      apiKeyConfigured: false,
      source: 'saved',
      complete: false,
    });
  });

  it('preserves the active configuration when persistence fails', () => {
    const store: ProviderConfigStore = {
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
    };
    const runtime = new ProviderRuntime({ startup, store, initialProvider: new FakeProvider() });
    expect(() => runtime.update({ provider: 'fake' })).toThrow('disk full');
    expect(runtime.safeConfig()).toMatchObject({
      provider: 'fake',
      source: 'default',
      runtimeGeneration: 1,
    });
  });

  it('reloads a persisted configuration without exposing its credential', () => {
    const path = temporaryConfigPath();
    const store = new JsonProviderConfigStore(path);
    const first = new ProviderRuntime({ startup, store, initialProvider: new FakeProvider() });
    first.update({
      provider: 'hy3',
      baseUrl: 'https://example.test/v1',
      model: 'persisted-model',
      secret: { action: 'replace', value: 'persisted-secret' },
    });

    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain('persisted-secret');
    expect(JSON.parse(persisted)).toHaveProperty('encryptedSecret');
    const reloaded = new ProviderRuntime({ startup, store });
    expect(reloaded.safeConfig()).toMatchObject({
      provider: 'hy3',
      model: 'persisted-model',
      apiKeyConfigured: true,
      source: 'saved',
    });
    expect(JSON.stringify(reloaded.safeConfig())).not.toContain('persisted-secret');
  });

  it('fails closed on malformed saved data instead of substituting an environment connection', () => {
    const path = temporaryConfigPath();
    writeFileSync(path, '{"version":1,"provider":"hy3","apiKey":', 'utf8');
    expect(
      () => new ProviderRuntime({ startup, store: new JsonProviderConfigStore(path) }),
    ).toThrow(/无法读取模型服务配置/);
  });

  it('rejects unsafe saved URLs before constructing a transport', () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      provider: 'hy3',
      baseUrl: 'https://user:pass@example.test/v1?token=leak',
      apiKey: 'saved-secret',
      model: 'saved-model',
    };
    expect(() => new ProviderRuntime({ startup, store })).toThrow(/API 地址/);
  });

  it('keeps incomplete real configuration and reports it instead of falling back to Fake', () => {
    const runtime = new ProviderRuntime({
      startup: {
        ...startup,
        provider: 'hy3',
        hy3BaseUrl: 'https://environment.test/v1',
        hy3ApiKey: undefined,
        hy3Model: 'environment-model',
      },
    });

    expect(runtime.safeConfig()).toMatchObject({
      provider: 'hy3',
      baseUrl: 'https://environment.test/v1',
      model: 'environment-model',
      apiKeyConfigured: false,
      source: 'environment',
      complete: false,
    });
  });

  it('retains an injected provider with its matching real identity', () => {
    const injected = mockedHy3Provider(async () => undefined);
    const runtime = new ProviderRuntime({
      startup: { ...startup, provider: 'hy3', hy3Model: 'incomplete-only' },
      initialProvider: injected,
    });
    expect(runtime.safeConfig()).toMatchObject({ provider: 'hy3', complete: false });
    expect(runtime.providerName).toBe('hy3');
  });

  it('keeps an entered request on its immutable provider generation while new requests advance', async () => {
    const runtime = new ProviderRuntime({ startup, initialProvider: new FakeProvider() });
    let releaseOldRequest!: () => void;
    const oldRequestGate = new Promise<void>((resolve) => {
      releaseOldRequest = resolve;
    });
    const oldScope = new AsyncResource('provider-request-old');
    const oldRequest = oldScope.runInAsyncScope(async () => {
      runtime.enterRequest();
      const before = {
        provider: runtime.providerName,
        model: runtime.providerModel,
        generation: runtime.generation,
      };
      await oldRequestGate;
      return {
        before,
        after: {
          provider: runtime.providerName,
          model: runtime.providerModel,
          generation: runtime.generation,
        },
      };
    });

    runtime.update({
      provider: 'hy3',
      baseUrl: 'https://example.test/v1',
      model: 'new-model',
      secret: { action: 'replace', value: 'new-secret' },
    });
    const newScope = new AsyncResource('provider-request-new');
    const newRequest = newScope.runInAsyncScope(() => {
      runtime.enterRequest();
      return {
        provider: runtime.providerName,
        model: runtime.providerModel,
        generation: runtime.generation,
      };
    });
    releaseOldRequest();

    await expect(oldRequest).resolves.toEqual({
      before: { provider: 'fake', model: undefined, generation: 1 },
      after: { provider: 'fake', model: undefined, generation: 1 },
    });
    expect(newRequest).toEqual({ provider: 'hy3', model: 'new-model', generation: 2 });
    oldScope.emitDestroy();
    newScope.emitDestroy();
  });

  it('does not apply a stale connection-test result after the active generation changes', async () => {
    let finishTest!: () => void;
    const connectionGate = new Promise<void>((resolve) => {
      finishTest = resolve;
    });
    const runtime = new ProviderRuntime({
      startup: {
        ...startup,
        provider: 'hy3',
        hy3BaseUrl: 'https://example.test/v1',
        hy3ApiKey: 'secret',
        hy3Model: 'mock-model',
      },
      initialProvider: mockedHy3Provider(async () => connectionGate),
    });

    const pending = runtime.testConnection();
    expect(runtime.safeConfig().externalConnection).toMatchObject({
      status: 'testing',
      testedGeneration: 1,
    });
    runtime.update({ provider: 'fake' });
    expect(runtime.safeConfig()).toMatchObject({
      provider: 'fake',
      runtimeGeneration: 2,
      externalConnection: { status: 'untested', testedGeneration: null },
    });
    finishTest();

    await expect(pending).resolves.toMatchObject({
      provider: 'fake',
      runtimeGeneration: 2,
      externalConnection: { status: 'untested', testedGeneration: null },
    });
  });

  it('does not let an older overlapping connection test replace the newer result', async () => {
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let call = 0;
    const runtime = new ProviderRuntime({
      startup: {
        ...startup,
        provider: 'hy3',
        hy3BaseUrl: 'https://example.test/v1',
        hy3ApiKey: 'secret',
        hy3Model: 'mock-model',
      },
      initialProvider: mockedHy3Provider(async () => {
        call += 1;
        if (call === 1) await firstGate;
      }),
    });

    const first = runtime.testConnection();
    await expect(runtime.testConnection()).resolves.toMatchObject({
      externalConnection: {
        status: 'verified',
        testedGeneration: 1,
        testedAt: expect.any(String),
      },
    });
    finishFirst();
    await first;
    expect(runtime.safeConfig().externalConnection).toMatchObject({
      status: 'verified',
      testedGeneration: 1,
    });
  });
});
