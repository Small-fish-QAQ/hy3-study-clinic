import { z } from 'zod';
import type { ReasoningEffortPreference } from '@hy3-clinic/shared';
const TOKENHUB_VISUAL_MODEL = 'hy-vision-2.0-instruct' as const;
import { normalizeApiBaseUrl } from './llm/compatibleEndpoint.js';

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
  DATABASE_PATH: z.string().default('./data/clinic-v2.sqlite'),
  LLM_PROVIDER: z.enum(['fake', 'hy3', 'moma', 'compatible']).default('moma'),
  HY3_BASE_URL: optionalString(z.string().max(2048)),
  HY3_API_KEY: optionalString(z.string().min(1)),
  HY3_MODEL: optionalString(z.string().min(1)),
  HY3_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(30_000),
  LONG_TASK_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(240_000),
  MODEL_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(64_000),
  MODEL_CONTEXT_TOKENS: z.coerce.number().int().positive().optional(),
  MODEL_REASONING_ESTIMATE: z.coerce.number().int().nonnegative().optional(),
  MODEL_REASONING_EFFORT: z.enum(['auto', 'provider-default', 'low', 'high', 'max']).optional(),
  PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  OPERATION_LEASE_MS: z.coerce.number().int().positive().max(2_147_483_647).default(90000),
  OPERATION_HEARTBEAT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(20000),
  VISUAL_PROVIDER: z.enum(['disabled', 'fake', 'tokenhub']).default('disabled'),
  TOKENHUB_VISUAL_BASE_URL: optionalVisualBaseUrl,
  TOKENHUB_VISUAL_API_KEY: optionalString(z.string().min(1)),
  TOKENHUB_VISUAL_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.literal(TOKENHUB_VISUAL_MODEL).default(TOKENHUB_VISUAL_MODEL),
  ),
  TOKENHUB_VISUAL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(120_000),
  PROVIDER_CONFIG_PATH: z.string().min(1).default('./data/provider-config.json'),
  AUTOMATION_EXPECT_PROVIDER: z.literal('fake').optional(),
});

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  provider: 'fake' | 'hy3' | 'moma' | 'compatible';
  hy3BaseUrl: string | undefined;
  hy3ApiKey: string | undefined;
  hy3Model: string | undefined;
  hy3TimeoutMs: number;
  longTaskTimeoutMs?: number;
  modelContextTokens?: number;
  modelReasoningEstimate?: number;
  modelReasoningEffort?: ReasoningEffortPreference;
  providerConcurrency?: number;
  operationLeaseMs?: number;
  operationHeartbeatMs?: number;
  modelMaxOutputTokens?: number;
  providerEnvironmentConfigured?: boolean;
  visualProvider: 'disabled' | 'fake' | 'tokenhub';
  tokenHubVisualBaseUrl: string | undefined;
  tokenHubVisualApiKey: string | undefined;
  tokenHubVisualModel: typeof TOKENHUB_VISUAL_MODEL;
  tokenHubVisualTimeoutMs: number;
  providerConfigPath: string;
  /** Fail-closed provider expectation for automated/offline processes. */
  automationExpectedProvider?: 'fake';
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
  if (e.OPERATION_HEARTBEAT_MS >= e.OPERATION_LEASE_MS)
    throw new ConfigError('OPERATION_HEARTBEAT_MS 必须小于 OPERATION_LEASE_MS。');
  if (e.HY3_BASE_URL && !options.allowIncompleteProvider) {
    try {
      normalizeApiBaseUrl(e.HY3_BASE_URL);
    } catch {
      throw new ConfigError('HY3_BASE_URL 必须是有效且不含凭据的 API URL。');
    }
  }

  if (e.LLM_PROVIDER !== 'fake' && !options.allowIncompleteProvider) {
    const missing = [
      e.HY3_BASE_URL ? null : 'HY3_BASE_URL',
      e.HY3_API_KEY ? null : 'HY3_API_KEY',
      e.HY3_MODEL ? null : 'HY3_MODEL',
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      throw new ConfigError(
        `LLM_PROVIDER=${e.LLM_PROVIDER} 需要设置:${missing.join(', ')}(参考 .env.example;开发与测试可继续使用 LLM_PROVIDER=fake)`,
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
    providerEnvironmentConfigured: Boolean(
      env.LLM_PROVIDER || env.HY3_BASE_URL || env.HY3_API_KEY || env.HY3_MODEL,
    ),
    hy3BaseUrl: e.HY3_BASE_URL,
    hy3ApiKey: e.HY3_API_KEY,
    hy3Model: e.HY3_MODEL,
    hy3TimeoutMs: e.HY3_TIMEOUT_MS,
    longTaskTimeoutMs: e.LONG_TASK_TIMEOUT_MS,
    modelContextTokens: e.MODEL_CONTEXT_TOKENS,
    modelReasoningEstimate: e.MODEL_REASONING_ESTIMATE,
    modelReasoningEffort: e.MODEL_REASONING_EFFORT,
    providerConcurrency: e.PROVIDER_CONCURRENCY,
    operationLeaseMs: e.OPERATION_LEASE_MS,
    operationHeartbeatMs: e.OPERATION_HEARTBEAT_MS,
    modelMaxOutputTokens: e.MODEL_MAX_OUTPUT_TOKENS,
    visualProvider: e.VISUAL_PROVIDER,
    tokenHubVisualBaseUrl: e.TOKENHUB_VISUAL_BASE_URL,
    tokenHubVisualApiKey: e.TOKENHUB_VISUAL_API_KEY,
    tokenHubVisualModel: e.TOKENHUB_VISUAL_MODEL,
    tokenHubVisualTimeoutMs: e.TOKENHUB_VISUAL_TIMEOUT_MS,
    providerConfigPath: e.PROVIDER_CONFIG_PATH,
    automationExpectedProvider: e.AUTOMATION_EXPECT_PROVIDER,
  };
}
