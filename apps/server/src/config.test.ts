import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to the fake provider with no env', () => {
    const config = loadConfig({});
    expect(config.provider).toBe('fake');
    expect(config.port).toBe(8787);
    expect(config.hy3TimeoutMs).toBe(30_000);
    expect(config.providerConfigPath).toBe('./data/provider-config.json');
  });

  it('accepts an explicit provider configuration path', () => {
    expect(loadConfig({ PROVIDER_CONFIG_PATH: 'C:/clinic/runtime-provider.json' })).toMatchObject({
      providerConfigPath: 'C:/clinic/runtime-provider.json',
    });
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

  it('allows incomplete startup Hy3 configuration only when runtime fallback is enabled', () => {
    const config = loadConfig(
      { LLM_PROVIDER: 'hy3', HY3_MODEL: 'environment-model' },
      { allowIncompleteProvider: true },
    );
    expect(config).toMatchObject({
      provider: 'hy3',
      hy3BaseUrl: undefined,
      hy3ApiKey: undefined,
      hy3Model: 'environment-model',
    });
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
