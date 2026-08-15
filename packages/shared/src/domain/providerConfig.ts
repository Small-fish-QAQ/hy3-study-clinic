import { z } from 'zod';

export const ProviderModeSchema = z.enum(['fake', 'hy3']);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

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
  })
  .strict();
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdateSchema>;

export const ProviderConnectionTestRequestSchema = z.object({}).strict();

export const ProviderConnectionStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('untested'),
      testedGeneration: z.null(),
      message: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('testing'),
      testedGeneration: z.number().int().positive(),
      message: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal('verified'),
      testedGeneration: z.number().int().positive(),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      testedGeneration: z.number().int().positive(),
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
  })
  .strict();
export type SafeProviderConfig = z.infer<typeof SafeProviderConfigSchema>;
