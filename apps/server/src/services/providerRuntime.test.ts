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
import { FakeProvider } from '../llm/fakeProvider.js';
import type { AppConfig } from '../config.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';

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

  it('ignores a saved Hy3 configuration with a missing secret in favor of complete environment', () => {
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
      baseUrl: 'https://environment.test/v1',
      model: 'environment-model',
      apiKeyConfigured: true,
      source: 'environment',
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
    expect(persisted).toContain('persisted-secret');
    const reloaded = new ProviderRuntime({ startup, store });
    expect(reloaded.safeConfig()).toMatchObject({
      provider: 'hy3',
      model: 'persisted-model',
      apiKeyConfigured: true,
      source: 'saved',
    });
    expect(JSON.stringify(reloaded.safeConfig())).not.toContain('persisted-secret');
  });

  it('ignores malformed saved data and falls back to startup environment configuration', () => {
    const path = temporaryConfigPath();
    writeFileSync(path, '{"version":1,"provider":"hy3","apiKey":', 'utf8');
    const runtime = new ProviderRuntime({
      startup: {
        ...startup,
        provider: 'hy3',
        hy3BaseUrl: 'https://environment.test/v1',
        hy3ApiKey: 'environment-secret',
        hy3Model: 'environment-model',
      },
      store: new JsonProviderConfigStore(path),
    });
    expect(runtime.safeConfig()).toMatchObject({
      provider: 'hy3',
      baseUrl: 'https://environment.test/v1',
      model: 'environment-model',
      apiKeyConfigured: true,
      source: 'environment',
    });
  });

  it('ignores semantically unsafe saved URLs and falls back without aborting startup', () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      provider: 'hy3',
      baseUrl: 'https://user:pass@example.test/v1?token=leak',
      apiKey: 'saved-secret',
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
      baseUrl: 'https://environment.test/v1',
      model: 'environment-model',
      source: 'environment',
    });
  });

  it('falls back to Fake when an environment-selected Hy3 configuration is incomplete', () => {
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
      provider: 'fake',
      baseUrl: 'https://environment.test/v1',
      model: 'environment-model',
      apiKeyConfigured: false,
      source: 'environment',
      complete: true,
    });
  });

  it('does not let an injected Hy3 provider contradict the Fake fallback mode', () => {
    const injected = mockedHy3Provider(async () => undefined);
    const runtime = new ProviderRuntime({
      startup: { ...startup, provider: 'hy3', hy3Model: 'incomplete-only' },
      initialProvider: injected,
    });
    expect(runtime.safeConfig()).toMatchObject({ provider: 'fake', complete: true });
    expect(runtime.providerName).toBe('fake');
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
