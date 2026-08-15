import { z } from 'zod';

export const LogicalCallStatusSchema = z.enum(['open', 'completed', 'failed', 'cancelled']);
export type LogicalCallStatus = z.infer<typeof LogicalCallStatusSchema>;

export const CacheLookupStatusSchema = z.enum(['not_checked', 'hit', 'miss', 'bypassed']);
export type CacheLookupStatus = z.infer<typeof CacheLookupStatusSchema>;

export const ModelAttemptKindSchema = z.enum(['original', 'repair', 'retry', 'fallback']);
export type ModelAttemptKind = z.infer<typeof ModelAttemptKindSchema>;

export const ModelAttemptStatusSchema = z.enum([
  'queued',
  'sent',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
]);
export type ModelAttemptStatus = z.infer<typeof ModelAttemptStatusSchema>;

export const ModelLogicalCallSchema = z
  .object({
    id: z.string().min(1),
    operationId: z.string().min(1).nullable(),
    workspaceId: z.string().min(1).nullable(),
    studySessionId: z.string().min(1).nullable(),
    learningUnitId: z.string().min(1).nullable(),
    assessmentId: z.string().min(1).nullable(),
    operationType: z.string().min(1).max(100),
    cacheKey: z.string().min(1).max(300).nullable(),
    cacheStatus: CacheLookupStatusSchema,
    promptFingerprint: z.string().min(1).max(200).nullable(),
    schemaFingerprint: z.string().min(1).max(200).nullable(),
    policyFingerprint: z.string().min(1).max(200).nullable(),
    sourceFingerprint: z.string().min(1).max(200).nullable(),
    status: LogicalCallStatusSchema,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ModelLogicalCall = z.infer<typeof ModelLogicalCallSchema>;

/** One real provider request. Repairs and retries are separate rows. */
export const ModelCallAttemptSchema = z
  .object({
    id: z.string().min(1),
    logicalCallId: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    attemptKind: ModelAttemptKindSchema,
    fencingToken: z.number().int().positive().nullable(),
    provider: z.string().min(1).max(40),
    model: z.string().max(120).nullable(),
    providerGeneration: z.number().int().positive().nullable(),
    status: ModelAttemptStatusSchema,
    startedAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
    firstTokenAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    latencyMs: z.number().int().nonnegative().nullable(),
    timeToFirstTokenMs: z.number().int().nonnegative().nullable(),
    errorCode: z.string().min(1).max(100).nullable(),
    errorMessage: z.string().min(1).max(1000).nullable(),
  })
  .strict();
export type ModelCallAttempt = z.infer<typeof ModelCallAttemptSchema>;

/** Usage is separate because providers may supply it after attempt finalization. */
export const ModelUsageRecordSchema = z
  .object({
    id: z.string().min(1),
    attemptId: z.string().min(1),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    /** Null means cost is honestly unknown, never zero. */
    estimatedCostMicrounits: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    pricingSource: z.string().min(1).max(200).nullable(),
    pricingVersion: z.string().min(1).max(100).nullable(),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((usage, ctx) => {
    if (usage.estimatedCostMicrounits !== null && usage.currency === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: 'known estimated cost requires a currency',
      });
    }
  });
export type ModelUsageRecord = z.infer<typeof ModelUsageRecordSchema>;

export const SemanticCacheEntrySchema = z
  .object({
    cacheKey: z.string().min(1).max(300),
    operationType: z.string().min(1).max(100),
    workspaceId: z.string().min(1).nullable(),
    result: z.unknown(),
    provider: z.string().max(40).nullable(),
    model: z.string().max(120).nullable(),
    promptFingerprint: z.string().min(1).max(200).nullable(),
    schemaFingerprint: z.string().min(1).max(200).nullable(),
    policyFingerprint: z.string().min(1).max(200).nullable(),
    sourceFingerprint: z.string().min(1).max(200).nullable(),
    validationFingerprint: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    invalidatedAt: z.string().datetime().nullable(),
    hitCount: z.number().int().nonnegative(),
    lastHitAt: z.string().datetime().nullable(),
  })
  .strict();
export type SemanticCacheEntry = z.infer<typeof SemanticCacheEntrySchema>;

/** Optional learner/operator monetary policy; absence means no product cap. */
export const CostPolicySchema = z
  .object({
    id: z.string().min(1),
    policyKey: z.string().min(1).max(200),
    workspaceId: z.string().min(1).nullable(),
    scopeType: z.enum(['operation', 'session', 'day', 'course']),
    scopeKey: z.string().min(1).max(200),
    limitMicrounits: z.number().int().nonnegative(),
    currency: z.string().length(3),
    onExceed: z.enum(['confirm', 'cache_only', 'lower_cost_or_confirm', 'refuse']),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CostPolicy = z.infer<typeof CostPolicySchema>;

/** `policy: null` is the explicit no-cap configuration and adds no hidden limit. */
export const MonetaryCostPolicyConfigurationSchema = z
  .object({ policy: CostPolicySchema.nullable() })
  .strict();
export type MonetaryCostPolicyConfiguration = z.infer<typeof MonetaryCostPolicyConfigurationSchema>;

export const ModelUsageSummarySchema = z
  .object({
    logicalCalls: z.number().int().nonnegative(),
    physicalAttempts: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    estimatedCostMicrounits: z.number().int().nonnegative(),
    attemptsWithKnownCost: z.number().int().nonnegative(),
  })
  .strict();
export type ModelUsageSummary = z.infer<typeof ModelUsageSummarySchema>;
