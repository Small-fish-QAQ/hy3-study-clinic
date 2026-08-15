import { describe, expect, it } from 'vitest';
import { buildTestApp } from './testing/testApp.js';
import {
  ProviderRuntime,
  type ProviderConfigStore,
  type StoredProviderConfig,
} from './services/providerRuntime.js';
import { FakeProvider } from './llm/fakeProvider.js';
import { ProviderError } from './llm/errors.js';
import { AppError } from './errors.js';
import type { AppConfig } from './config.js';
import type { LlmProvider, ProviderCallOptions } from './llm/provider.js';

const hy3Startup: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  databasePath: ':memory:',
  provider: 'hy3',
  hy3BaseUrl: 'https://example.test/v1',
  hy3ApiKey: 'sentinel-key',
  hy3Model: 'mock-model',
  hy3TimeoutMs: 30_000,
  providerConfigPath: '',
};

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

function runtimeWithConnectionTest(
  testConnection: (opts?: ProviderCallOptions) => Promise<void>,
): ProviderRuntime {
  return new ProviderRuntime({
    startup: hy3Startup,
    initialProvider: mockedHy3Provider(testConnection),
  });
}

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'hy3-study-clinic-server' });
    await app.close();
  });
});

describe('GET /api/config', () => {
  it('exposes safe runtime state, never credentials', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'fake', apiKeyConfigured: false, complete: true });
    // Guard against leaking any credential-shaped fields.
    expect(res.body).not.toMatch(/secret|sentinel-key/i);
    await app.close();
  });
});

describe('provider configuration routes', () => {
  it('updates runtime configuration without echoing the secret', async () => {
    const store: ProviderConfigStore = {
      value: null as StoredProviderConfig | null,
      read() {
        return this.value;
      },
      write(value) {
        this.value = value;
      },
    };
    const { app } = buildTestApp({ providerConfigStore: store });
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: {
        provider: 'hy3',
        baseUrl: 'https://example.test/v1',
        model: 'm',
        secret: { action: 'replace', value: 'sentinel-key' },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.body).not.toContain('sentinel-key');
    const read = await app.inject({ method: 'GET', url: '/api/config' });
    expect(read.json()).toMatchObject({ provider: 'hy3', apiKeyConfigured: true, complete: true });
    await app.close();
  });

  it('records a successful explicit external connection test', async () => {
    let calls = 0;
    const runtime = runtimeWithConnectionTest(async (opts) => {
      calls += 1;
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({ method: 'POST', url: '/api/config/test' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'hy3',
      apiKeyConfigured: true,
      externalConnection: {
        status: 'verified',
        testedGeneration: 1,
        testedAt: expect.any(String),
      },
    });
    expect(response.body).not.toContain('sentinel-key');
    expect(calls).toBe(1);
    await app.close();
  });

  it.each([
    ['authentication failure', ProviderError.http(401), 502, 'PROVIDER_ERROR'],
    ['unreachable provider', ProviderError.network(), 502, 'PROVIDER_ERROR'],
    ['request cancellation', ProviderError.cancelled(), 499, 'REQUEST_CANCELLED'],
  ])('maps mocked %s without making a real request', async (_name, error, status, code) => {
    const runtime = runtimeWithConnectionTest(async (opts) => {
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      throw error;
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({ method: 'POST', url: '/api/config/test' });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toContain('sentinel-key');
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.json()).toMatchObject({
      externalConnection:
        code === 'REQUEST_CANCELLED'
          ? { status: 'untested', testedGeneration: null }
          : { status: 'failed', testedGeneration: 1 },
    });
    expect(config.body).not.toContain('sentinel-key');
    await app.close();
  });

  it('does not expose arbitrary provider error text in safe connection state', async () => {
    const runtime = runtimeWithConnectionTest(async () => {
      throw new Error('sentinel-secret-provider-detail');
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({ method: 'POST', url: '/api/config/test' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'PROVIDER_ERROR' } });
    expect(response.body).not.toContain('sentinel-secret-provider-detail');
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.body).not.toContain('sentinel-secret-provider-detail');
    expect(config.json()).toMatchObject({
      externalConnection: {
        status: 'failed',
        testedGeneration: 1,
        message: ProviderError.network().message,
      },
    });
    await app.close();
  });

  it('normalizes arbitrary AppError details from a provider connection test', async () => {
    const runtime = runtimeWithConnectionTest(async () => {
      throw new AppError('PROVIDER_ERROR', 'sentinel-provider-message', {
        secret: 'sentinel-provider-secret',
      });
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({ method: 'POST', url: '/api/config/test' });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('sentinel-provider-message');
    expect(response.body).not.toContain('sentinel-provider-secret');
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.body).not.toContain('sentinel-provider-message');
    expect(config.body).not.toContain('sentinel-provider-secret');
    expect(config.json()).toMatchObject({
      externalConnection: {
        status: 'failed',
        testedGeneration: 1,
        message: ProviderError.network().message,
      },
    });
    await app.close();
  });

  it('does not mutate learning-state storage when switching provider mode', async () => {
    const { app, db } = buildTestApp();
    const before = (db.prepare('SELECT total_changes() AS changes').get() as { changes: number })
      .changes;

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { provider: 'fake', secret: { action: 'unchanged' } },
    });

    const after = (db.prepare('SELECT total_changes() AS changes').get() as { changes: number })
      .changes;
    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
    await app.close();
  });

  it('rejects whitespace-only credentials without replacing the active configuration', async () => {
    const store: ProviderConfigStore = {
      value: {
        version: 1,
        provider: 'hy3',
        baseUrl: 'https://example.test/v1',
        model: 'mock-model',
        apiKey: 'sentinel-key',
      },
      read() {
        return this.value;
      },
      write(value) {
        this.value = value;
      },
    };
    const { app } = buildTestApp({ providerConfigStore: store });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { provider: 'fake', secret: { action: 'replace', value: '   ' } },
    });

    expect(response.statusCode).toBe(400);
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.json()).toMatchObject({ provider: 'hy3', apiKeyConfigured: true });
    expect(config.body).not.toContain('sentinel-key');
    await app.close();
  });

  it('rejects unknown external-test request fields before invoking the provider', async () => {
    let calls = 0;
    const runtime = runtimeWithConnectionTest(async () => {
      calls += 1;
    });
    const { app } = buildTestApp({ providerRuntime: runtime });
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/test',
      payload: { apiKey: 'sentinel-key' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('sentinel-key');
    expect(calls).toBe(0);
    await app.close();
  });

  it('rejects a non-loopback mutation even when the URL has a query string', async () => {
    const { app } = buildTestApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/config?source=settings',
      remoteAddress: '203.0.113.10',
      payload: { provider: 'fake' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await app.close();
  });

  it('rejects an external browser origin without invoking the provider', async () => {
    let calls = 0;
    const runtime = runtimeWithConnectionTest(async () => {
      calls += 1;
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({
      method: 'POST',
      url: '/api/config/test?source=settings',
      headers: { origin: 'https://attacker.example' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(calls).toBe(0);
    await app.close();
  });

  it('allows a loopback browser origin for an explicit connection test', async () => {
    let calls = 0;
    const runtime = runtimeWithConnectionTest(async () => {
      calls += 1;
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({
      method: 'POST',
      url: '/api/config/test?source=settings',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ externalConnection: { status: 'verified' } });
    expect(calls).toBe(1);
    await app.close();
  });

  it('allows an IPv6 loopback browser origin for an explicit connection test', async () => {
    let calls = 0;
    const runtime = runtimeWithConnectionTest(async () => {
      calls += 1;
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({
      method: 'POST',
      url: '/api/config/test',
      headers: { origin: 'http://[::1]:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toBe(1);
    await app.close();
  });

  it('does not call any provider connection method while Fake is active', async () => {
    let calls = 0;
    const provider = new Proxy(new FakeProvider() as LlmProvider, {
      get(target, property) {
        if (property === 'testConnection')
          return async () => {
            calls += 1;
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = new ProviderRuntime({
      startup: { ...hy3Startup, provider: 'fake' },
      initialProvider: provider,
    });
    const { app } = buildTestApp({ providerRuntime: runtime });

    const response = await app.inject({ method: 'POST', url: '/api/config/test' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'fake',
      externalConnection: { status: 'untested', testedGeneration: null },
    });
    expect(calls).toBe(0);
    await app.close();
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
