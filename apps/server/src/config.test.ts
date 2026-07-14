import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to the fake provider with no env', () => {
    const config = loadConfig({});
    expect(config.provider).toBe('fake');
    expect(config.port).toBe(8787);
    expect(config.hy3TimeoutMs).toBe(30_000);
  });

  it('requires hy3 credentials when provider is hy3', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'hy3' })).toThrowError(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: 'hy3' })).toThrowError(/HY3_BASE_URL/);
  });

  it('accepts a fully configured hy3 provider', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'hy3',
      HY3_BASE_URL: 'https://example.test/v1',
      HY3_API_KEY: 'secret',
      HY3_MODEL: 'some-model',
      HY3_TIMEOUT_MS: '5000',
    });
    expect(config.provider).toBe('hy3');
    expect(config.hy3TimeoutMs).toBe(5000);
  });

  it('rejects an invalid base url', () => {
    expect(() =>
      loadConfig({
        LLM_PROVIDER: 'hy3',
        HY3_BASE_URL: 'not-a-url',
        HY3_API_KEY: 'secret',
        HY3_MODEL: 'm',
      }),
    ).toThrowError(ConfigError);
  });
});
