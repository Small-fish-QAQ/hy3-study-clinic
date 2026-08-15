import { describe, expect, it } from 'vitest';
import { ProviderConfigUpdateSchema, SafeProviderConfigSchema } from './providerConfig.js';

describe('ProviderConfigUpdateSchema', () => {
  it('accepts each explicit secret action', () => {
    expect(
      ProviderConfigUpdateSchema.parse({
        provider: 'hy3',
        baseUrl: 'https://example.test/v1',
        model: 'model',
        secret: { action: 'replace', value: 'secret' },
      }).secret,
    ).toEqual({ action: 'replace', value: 'secret' });
    expect(
      ProviderConfigUpdateSchema.parse({ provider: 'fake', secret: { action: 'unchanged' } })
        .secret,
    ).toEqual({ action: 'unchanged' });
    expect(
      ProviderConfigUpdateSchema.parse({ provider: 'fake', secret: { action: 'remove' } }).secret,
    ).toEqual({ action: 'remove' });
  });

  it('rejects raw credential fields, unknown fields, and malformed secret actions', () => {
    expect(
      ProviderConfigUpdateSchema.safeParse({ provider: 'hy3', apiKey: 'must-not-be-accepted' })
        .success,
    ).toBe(false);
    expect(ProviderConfigUpdateSchema.safeParse({ provider: 'fake', extra: true }).success).toBe(
      false,
    );
    expect(
      ProviderConfigUpdateSchema.safeParse({
        provider: 'hy3',
        secret: { action: 'replace' },
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdateSchema.safeParse({
        provider: 'hy3',
        secret: { action: 'remove', value: 'unexpected' },
      }).success,
    ).toBe(false);
  });

  it('enforces URL, model, and credential input limits', () => {
    expect(
      ProviderConfigUpdateSchema.safeParse({ provider: 'hy3', baseUrl: 'x'.repeat(2049) }).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdateSchema.safeParse({ provider: 'hy3', model: 'x'.repeat(257) }).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdateSchema.safeParse({
        provider: 'hy3',
        secret: { action: 'replace', value: 'x'.repeat(513) },
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdateSchema.safeParse({
        provider: 'fake',
        secret: { action: 'replace', value: '   ' },
      }).success,
    ).toBe(false);
    expect(
      ProviderConfigUpdateSchema.parse({
        provider: 'fake',
        secret: { action: 'replace', value: '  secret  ' },
      }).secret,
    ).toEqual({ action: 'replace', value: 'secret' });
  });
});

describe('SafeProviderConfigSchema', () => {
  const safeConfig = {
    provider: 'hy3' as const,
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKeyConfigured: true,
    source: 'saved' as const,
    complete: true,
    runtimeGeneration: 2,
    externalConnection: {
      status: 'verified' as const,
      testedGeneration: 2,
      message: 'connected',
    },
  };

  it('accepts the safe response contract without any raw credential', () => {
    expect(SafeProviderConfigSchema.parse(safeConfig)).toEqual(safeConfig);
  });

  it('rejects raw credentials and invalid generation state', () => {
    expect(SafeProviderConfigSchema.safeParse({ ...safeConfig, apiKey: 'secret' }).success).toBe(
      false,
    );
    expect(
      SafeProviderConfigSchema.safeParse({ ...safeConfig, runtimeGeneration: 0 }).success,
    ).toBe(false);
    expect(
      SafeProviderConfigSchema.safeParse({
        ...safeConfig,
        externalConnection: { ...safeConfig.externalConnection, testedGeneration: -1 },
      }).success,
    ).toBe(false);
    expect(
      SafeProviderConfigSchema.safeParse({
        ...safeConfig,
        externalConnection: { status: 'verified', testedGeneration: null, message: 'connected' },
      }).success,
    ).toBe(false);
    expect(
      SafeProviderConfigSchema.safeParse({
        ...safeConfig,
        externalConnection: { status: 'untested', testedGeneration: 2, message: null },
      }).success,
    ).toBe(false);
  });
});
