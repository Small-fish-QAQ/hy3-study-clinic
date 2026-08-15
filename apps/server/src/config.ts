import { z } from 'zod';

/**
 * Server configuration parsed from environment variables.
 *
 * SECURITY: `hy3ApiKey` is held server-side only. It is never logged, never
 * echoed in errors, and never sent to the web client. `/api/config` exposes
 * only safe metadata and whether a credential is configured.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/clinic.sqlite'),
  LLM_PROVIDER: z.enum(['fake', 'hy3']).default('fake'),
  HY3_BASE_URL: z.string().url().optional(),
  HY3_API_KEY: z.string().min(1).optional(),
  HY3_MODEL: z.string().min(1).optional(),
  HY3_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
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

  return {
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    provider: e.LLM_PROVIDER,
    hy3BaseUrl: e.HY3_BASE_URL,
    hy3ApiKey: e.HY3_API_KEY,
    hy3Model: e.HY3_MODEL,
    hy3TimeoutMs: e.HY3_TIMEOUT_MS,
    providerConfigPath: e.PROVIDER_CONFIG_PATH,
  };
}
