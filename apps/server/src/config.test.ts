import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to the fake provider with no env', () => {
    const config = loadConfig({});
    expect(config.provider).toBe('fake');
    expect(config.visualProvider).toBe('disabled');
    expect(config.tokenHubVisualModel).toBe('hy-vision-2.0-instruct');
    expect(config.tokenHubVisualTimeoutMs).toBe(120_000);
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

  it('requires a complete explicit TokenHub visual configuration', () => {
    expect(() => loadConfig({ VISUAL_PROVIDER: 'tokenhub' })).toThrowError(
      /TOKENHUB_VISUAL_BASE_URL, TOKENHUB_VISUAL_API_KEY/,
    );
  });

  it('accepts only the frozen TokenHub visual model', () => {
    expect(
      loadConfig({
        VISUAL_PROVIDER: 'tokenhub',
        TOKENHUB_VISUAL_BASE_URL: 'https://tokenhub.tencentmaas.com/v1',
        TOKENHUB_VISUAL_API_KEY: 'secret',
        TOKENHUB_VISUAL_MODEL: 'hy-vision-2.0-instruct',
        TOKENHUB_VISUAL_TIMEOUT_MS: '90000',
      }),
    ).toMatchObject({
      visualProvider: 'tokenhub',
      tokenHubVisualModel: 'hy-vision-2.0-instruct',
      tokenHubVisualTimeoutMs: 90_000,
    });
    expect(() =>
      loadConfig({
        VISUAL_PROVIDER: 'tokenhub',
        TOKENHUB_VISUAL_BASE_URL: 'https://tokenhub.tencentmaas.com/v1',
        TOKENHUB_VISUAL_API_KEY: 'secret',
        TOKENHUB_VISUAL_MODEL: 'youtu-vita',
      }),
    ).toThrowError(ConfigError);
  });

  it('treats blank optional secrets as absent in deterministic fake mode', () => {
    expect(
      loadConfig({
        LLM_PROVIDER: 'fake',
        HY3_API_KEY: '',
        VISUAL_PROVIDER: 'fake',
        TOKENHUB_VISUAL_API_KEY: '',
        TOKENHUB_VISUAL_MODEL: '',
      }),
    ).toMatchObject({
      provider: 'fake',
      hy3ApiKey: undefined,
      visualProvider: 'fake',
      tokenHubVisualApiKey: undefined,
      tokenHubVisualModel: 'hy-vision-2.0-instruct',
    });
  });

  it('rejects ambiguous or credential-bearing visual base URLs', () => {
    for (const baseUrl of [
      'ftp://tokenhub.tencentmaas.com/v1',
      'https://user:secret@tokenhub.tencentmaas.com/v1',
      'https://tokenhub.tencentmaas.com/v1?route=a',
      'https://tokenhub.tencentmaas.com/v1#route-a',
    ]) {
      expect(() =>
        loadConfig({
          VISUAL_PROVIDER: 'tokenhub',
          TOKENHUB_VISUAL_BASE_URL: baseUrl,
          TOKENHUB_VISUAL_API_KEY: 'secret',
        }),
      ).toThrowError(ConfigError);
    }
  });
});
