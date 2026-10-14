import { z } from 'zod';

export const ProviderModeSchema = z.enum(['fake', 'hy3', 'moma', 'compatible']);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;
export const ReasoningEffortPreferenceSchema = z.enum([
  'auto',
  'provider-default',
  'low',
  'high',
  'max',
]);
export type ReasoningEffortPreference = z.infer<typeof ReasoningEffortPreferenceSchema>;

export const ProviderConfigSourceSchema = z.enum(['saved', 'environment', 'default']);
export type ProviderConfigSource = z.infer<typeof ProviderConfigSourceSchema>;

export const ConnectionTestStatusSchema = z.enum(['untested', 'testing', 'verified', 'failed']);
export type ConnectionTestStatus = z.infer<typeof ConnectionTestStatusSchema>;

const ProviderSecretChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unchanged') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().trim().min(1).max(512) }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
]);

export const ProviderConfigUpdateSchema = z
  .object({
    provider: ProviderModeSchema,
    baseUrl: z.string().trim().max(2048).optional(),
    model: z.string().trim().max(256).optional(),
    secret: ProviderSecretChangeSchema.optional(),
    expectedGeneration: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    longTaskTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    reasoningEstimate: z.number().int().nonnegative().optional(),
    reasoningEffort: ReasoningEffortPreferenceSchema.optional(),
  })
  .strict();
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdateSchema>;

export const ProviderConnectionTestRequestSchema = z.object({}).strict();

export const ProviderModelsResponseSchema = z
  .object({
    models: z.array(z.string().trim().min(1).max(256)).max(1000),
  })
  .strict();
export const ProviderDraftTestResponseSchema = z
  .object({
    status: z.literal('verified'),
    message: z.string(),
  })
  .strict();

export const ProviderConnectionStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('untested'),
      testedGeneration: z.null(),
      testedAt: z.null(),
      message: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('testing'),
      testedGeneration: z.number().int().positive(),
      testedAt: z.null(),
      message: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('verified'),
      testedGeneration: z.number().int().positive(),
      testedAt: z.string().datetime(),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      testedGeneration: z.number().int().positive(),
      testedAt: z.string().datetime(),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export const SafeProviderConfigSchema = z
  .object({
    provider: ProviderModeSchema,
    baseUrl: z.string().url().nullable(),
    model: z.string().nullable(),
    apiKeyConfigured: z.boolean(),
    source: ProviderConfigSourceSchema,
    complete: z.boolean(),
    runtimeGeneration: z.number().int().positive(),
    externalConnection: ProviderConnectionStateSchema,
    timeoutMs: z.number().int().positive().optional(),
    longTaskTimeoutMs: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    contextTokens: z.number().int().positive().nullable().optional(),
    reasoningEstimate: z.number().int().nonnegative().nullable().optional(),
    reasoningEffort: ReasoningEffortPreferenceSchema.optional(),
  })
  .strict();
export type SafeProviderConfig = z.infer<typeof SafeProviderConfigSchema>;
