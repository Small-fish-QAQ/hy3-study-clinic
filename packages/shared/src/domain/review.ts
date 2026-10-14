import { z } from 'zod';

export const REVIEW_ALGORITHM_GENERATION = 'FSRS-6' as const;
export const REVIEW_PACKAGE_NAME = 'ts-fsrs' as const;
export const REVIEW_PACKAGE_VERSION = '5.4.1' as const;
export const REVIEW_ADAPTER_VERSION = 'study-clinic-fsrs6-v1' as const;
export const REVIEW_RATING_POLICY_VERSION = 'graded-study-outcome-binary-v2' as const;
export const REVIEW_POLICY_VERSION = 'review-policy-fsrs6-v1' as const;
export const REVIEW_MAX_DUE_HORIZON_DAYS = 365 as const;

export const SchedulerConfigurationSchema = z.object({
  version: z.string().min(1),
  algorithmGeneration: z.literal(REVIEW_ALGORITHM_GENERATION),
  packageName: z.literal(REVIEW_PACKAGE_NAME),
  packageVersion: z.literal(REVIEW_PACKAGE_VERSION),
  localAdapterVersion: z.literal(REVIEW_ADAPTER_VERSION),
  ratingPolicyVersion: z.literal(REVIEW_RATING_POLICY_VERSION),
  requestedRetention: z.number().finite().min(0.7).max(0.99),
  configHash: z.string().min(1),
  fuzz: z.literal(false),
  shortTerm: z.literal(false),
  maximumDueHorizonDays: z.number().int().positive(),
  weights: z.array(z.number().finite()).length(21).optional(),
  effectiveAt: z.string().datetime(),
  retiredAt: z.string().datetime().nullable(),
});
export type SchedulerConfiguration = z.infer<typeof SchedulerConfigurationSchema>;
const MemoryScheduleIdentitySchema = z.object({
  reviewTargetId: z.string().min(1),
  policyVersion: z.string().min(1),
  dueAt: z.string().datetime(),
  rowVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const PendingMemoryScheduleStateSchema = MemoryScheduleIdentitySchema.extend({
  lifecycleState: z.literal('pending_initial_review'),
  lastReviewedAt: z.null(),
  stability: z.null(),
  difficulty: z.null(),
  scheduledDays: z.null(),
  repetitions: z.null(),
  lapses: z.null(),
  lastReviewEventId: z.null(),
});
export type PendingMemoryScheduleState = z.infer<typeof PendingMemoryScheduleStateSchema>;

export const ScheduledMemoryScheduleStateSchema = MemoryScheduleIdentitySchema.extend({
  lifecycleState: z.enum(['new', 'review']),
  lastReviewedAt: z.string().datetime().nullable(),
  stability: z.number().finite().nonnegative(),
  difficulty: z.number().finite().min(1).max(10),
  scheduledDays: z.number().finite().nonnegative(),
  repetitions: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  lastReviewEventId: z.string().min(1).nullable(),
});
export type ScheduledMemoryScheduleState = z.infer<typeof ScheduledMemoryScheduleStateSchema>;

export const MemoryScheduleStateSchema = z.discriminatedUnion('lifecycleState', [
  PendingMemoryScheduleStateSchema,
  ScheduledMemoryScheduleStateSchema,
]);
export type MemoryScheduleState = z.infer<typeof MemoryScheduleStateSchema>;
