import { z } from 'zod';
import { TOKENHUB_VISUAL_MODEL } from './llm/tokenHubVisionProvider.js';

/**
 * Server configuration parsed from environment variables.
 *
 * SECURITY: `hy3ApiKey` is held server-side only. It is never logged, never
 * echoed in errors, and never sent to the web client. `/api/config` exposes
 * only safe metadata and whether a credential is configured.
 */
const optionalString = (schema: z.ZodString) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const optionalVisualBaseUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .url()
    .superRefine((value, context) => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) {
        context.addIssue({ code: 'custom', message: 'must use HTTP or HTTPS' });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: 'custom',
          message: 'must not include credentials, query parameters, or a fragment',
        });
      }
    })
    .optional(),
);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/clinic.sqlite'),
  LLM_PROVIDER: z.enum(['fake', 'hy3']).default('fake'),
  HY3_BASE_URL: optionalString(z.string().url()),
  HY3_API_KEY: optionalString(z.string().min(1)),
  HY3_MODEL: optionalString(z.string().min(1)),
  HY3_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  VISUAL_PROVIDER: z.enum(['disabled', 'fake', 'tokenhub']).default('disabled'),
  TOKENHUB_VISUAL_BASE_URL: optionalVisualBaseUrl,
  TOKENHUB_VISUAL_API_KEY: optionalString(z.string().min(1)),
  TOKENHUB_VISUAL_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.literal(TOKENHUB_VISUAL_MODEL).default(TOKENHUB_VISUAL_MODEL),
  ),
  TOKENHUB_VISUAL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(120_000),
  PROVIDER_CONFIG_PATH: z.string().min(1).default('./data/provider-config.json'),
});

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  provider: 'fake' | 'hy3';
  hy3BaseUrl: string | undefined;
  hy3ApiKey: string | undefined;
  hy3Model: string | undefined;
  hy3TimeoutMs: number;
  visualProvider: 'disabled' | 'fake' | 'tokenhub';
  tokenHubVisualBaseUrl: string | undefined;
  tokenHubVisualApiKey: string | undefined;
  tokenHubVisualModel: typeof TOKENHUB_VISUAL_MODEL;
  tokenHubVisualTimeoutMs: number;
  providerConfigPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowIncompleteProvider?: boolean } = {},
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`环境变量配置无效:${summary}`);
  }
  const e = parsed.data;

  if (e.LLM_PROVIDER === 'hy3' && !options.allowIncompleteProvider) {
    const missing = [
      e.HY3_BASE_URL ? null : 'HY3_BASE_URL',
      e.HY3_API_KEY ? null : 'HY3_API_KEY',
      e.HY3_MODEL ? null : 'HY3_MODEL',
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      throw new ConfigError(
        `LLM_PROVIDER=hy3 需要设置:${missing.join(', ')}(参考 .env.example;开发与测试可继续使用 LLM_PROVIDER=fake)`,
      );
    }
  }

  if (e.VISUAL_PROVIDER === 'tokenhub') {
    const missing = [
      e.TOKENHUB_VISUAL_BASE_URL ? null : 'TOKENHUB_VISUAL_BASE_URL',
      e.TOKENHUB_VISUAL_API_KEY ? null : 'TOKENHUB_VISUAL_API_KEY',
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      throw new ConfigError(`VISUAL_PROVIDER=tokenhub requires: ${missing.join(', ')}`);
    }
  }

  return {
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    provider: e.LLM_PROVIDER,
    hy3BaseUrl: e.HY3_BASE_URL,
    hy3ApiKey: e.HY3_API_KEY,
    hy3Model: e.HY3_MODEL,
    hy3TimeoutMs: e.HY3_TIMEOUT_MS,
    visualProvider: e.VISUAL_PROVIDER,
    tokenHubVisualBaseUrl: e.TOKENHUB_VISUAL_BASE_URL,
    tokenHubVisualApiKey: e.TOKENHUB_VISUAL_API_KEY,
    tokenHubVisualModel: e.TOKENHUB_VISUAL_MODEL,
    tokenHubVisualTimeoutMs: e.TOKENHUB_VISUAL_TIMEOUT_MS,
    providerConfigPath: e.PROVIDER_CONFIG_PATH,
  };
}
