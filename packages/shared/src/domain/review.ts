import { z } from 'zod';
import { CreateAssessmentRequestSchema } from './blueprint.js';

/**
 * Review scheduling — long-term memory state, kept strictly separate from
 * mastery:
 *
 * - mastery answers "how well has the learner demonstrated understanding?"
 *   (EMA over graded scores, see shared/mastery.ts);
 * - review scheduling answers "when should this concept be reviewed again?"
 *   (stability/difficulty state advanced only by completed graded events).
 *
 * Neither value ever overwrites the other. The scheduler implementation is a
 * compact local FSRS-inspired model (see server review/scheduler.ts) hidden
 * behind these shared shapes; scheduler internals never leak elsewhere.
 */

/** Version tag persisted with every item so future models can migrate. */
export const REVIEW_SCHEDULER_VERSION = 'local-fsrs-v1';

/** Successor objective-level Review scheduling contract (Phase 8B). */
export const REVIEW_ALGORITHM_GENERATION = 'FSRS-6' as const;
export const REVIEW_PACKAGE_NAME = 'ts-fsrs' as const;
export const REVIEW_PACKAGE_VERSION = '5.4.1' as const;
export const REVIEW_ADAPTER_VERSION = 'study-clinic-fsrs6-v1' as const;
export const REVIEW_RATING_POLICY_VERSION = 'formal-review-outcome-binary-v1' as const;
export const REVIEW_POLICY_VERSION = 'review-policy-fsrs6-v1' as const;
export const REVIEW_MAX_DUE_HORIZON_DAYS = 365 as const;

export const ReviewTargetStatusSchema = z.enum([
  'pending_initial_review',
  'active',
  'suspended',
  'retired',
]);
export type ReviewTargetStatus = z.infer<typeof ReviewTargetStatusSchema>;
export const ReviewTargetSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  courseId: z.string().min(1),
  targetKind: z.literal('curriculum_objective'),
  originEvidenceId: z.string().min(1).nullable(),
  status: ReviewTargetStatusSchema,
  currentBindingVersion: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export const ReviewTargetBindingSchema = z.object({
  reviewTargetId: z.string().min(1),
  bindingVersion: z.number().int().positive(),
  contractVersionId: z.string().min(1),
  curriculumVersionId: z.string().min(1),
  learningUnitId: z.string().min(1),
  objectiveId: z.string().min(1),
  executionSourceManifestFingerprint: z.string().min(1),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ReviewTargetBinding = z.infer<typeof ReviewTargetBindingSchema>;
export const SchedulerConfigurationSchema = z.object({
  version: z.string().min(1),
  algorithmGeneration: z.literal(REVIEW_ALGORITHM_GENERATION),
  packageName: z.literal(REVIEW_PACKAGE_NAME),
  packageVersion: z.literal(REVIEW_PACKAGE_VERSION),
  localAdapterVersion: z.literal(REVIEW_ADAPTER_VERSION),
  ratingPolicyVersion: z.literal(REVIEW_RATING_POLICY_VERSION),
  requestedRetention: z.literal(0.9),
  configHash: z.string().min(1),
  fuzz: z.literal(false),
  shortTerm: z.literal(false),
  maximumDueHorizonDays: z.literal(REVIEW_MAX_DUE_HORIZON_DAYS),
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

export const ReviewBackfillOutcomeSchema = z.enum(['created', 'already_present', 'skipped']);
export const ReviewBackfillReasonSchema = z.enum([
  'eligible_pending_created',
  'eligible_pending_present',
  'not_supported',
  'unsupported_policy',
  'reconciliation_not_applied',
  'invalid_formal_context',
  'ineligible_assessment_kind',
  'due_review_not_backfillable',
  'missing_exact_binding',
  'ambiguous_existing_target',
  'invalid_source_binding',
]);
export type ReviewBackfillReason = z.infer<typeof ReviewBackfillReasonSchema>;
export const ReviewBackfillAuditSchema = z.object({
  evidenceId: z.string().min(1),
  cutoverAt: z.string().datetime(),
  outcome: ReviewBackfillOutcomeSchema,
  reason: ReviewBackfillReasonSchema,
  reviewTargetId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
});
export type ReviewBackfillAudit = z.infer<typeof ReviewBackfillAuditSchema>;

/** Honest successor projection used by current Review APIs. */
export const CurrentReviewItemSchema = z.object({
  reviewTargetId: z.string().min(1),
  workspaceId: z.string().min(1),
  courseId: z.string().min(1),
  learningUnitId: z.string().min(1),
  objectiveId: z.string().min(1),
  objectiveTitle: z.string().min(1).max(300),
  conceptIds: z.array(z.string().min(1)).min(1).max(30),
  targetStatus: ReviewTargetStatusSchema,
  lifecycleState: z.enum(['pending_initial_review', 'new', 'review']),
  dueAt: z.string().datetime(),
  lastReviewedAt: z.string().datetime().nullable(),
  stability: z.number().finite().nonnegative().nullable(),
  difficulty: z.number().finite().min(1).max(10).nullable(),
  scheduledDays: z.number().finite().nonnegative().nullable(),
  repetitions: z.number().int().nonnegative().nullable(),
  lapses: z.number().int().nonnegative().nullable(),
  policyVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CurrentReviewItem = z.infer<typeof CurrentReviewItemSchema>;
export const ReviewEventKindSchema = z.enum([
  'activation',
  'retrieval_failure',
  'fresh_verification_success',
  'migration',
]);
export const SuccessorReviewRatingSchema = z.enum(['Again', 'Good']);
export const ReviewEventSchemaV2 = z.object({
  id: z.string().min(1),
  reviewTargetId: z.string().min(1),
  bindingVersion: z.number().int().positive().nullable(),
  policyVersion: z.string().min(1),
  kind: ReviewEventKindSchema,
  sequence: z.number().int().positive(),
  sourceOutcomeId: z.string().min(1),
  reviewExecutionId: z.string().min(1).nullable(),
  rating: SuccessorReviewRatingSchema.nullable(),
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  preState: z.record(z.unknown()),
  postState: z.record(z.unknown()),
  exactInputTime: z.string().datetime().nullable(),
  dueAt: z.string().datetime().nullable(),
  idempotencyKey: z.string().min(1),
});
export type SuccessorReviewEvent = z.infer<typeof ReviewEventSchemaV2>;
export const ReviewExecutionSchema = z.object({
  id: z.string().min(1),
  reviewTargetId: z.string().min(1),
  bindingVersion: z.number().int().positive(),
  consumedRowVersion: z.number().int().positive(),
  workspaceId: z.string().min(1),
  courseId: z.string().min(1),
  agendaId: z.string().min(1).nullable(),
  assessmentVersionId: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  status: z.enum(['active', 'completed', 'failed', 'cancelled']),
  failureReason: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReviewExecution = z.infer<typeof ReviewExecutionSchema>;

/** Discrete review ratings derived deterministically from graded scores. */
export const ReviewRatingSchema = z.enum(['again', 'hard', 'good', 'easy']);
export type ReviewRating = z.infer<typeof ReviewRatingSchema>;

/**
 * Deterministic score → rating mapping (documented, tested):
 * again < 0.6 ≤ hard < 0.75 ≤ good < 0.9 ≤ easy.
 */
export function ratingForScore(score: number): ReviewRating {
  if (Number.isNaN(score)) return 'again';
  if (score < 0.6) return 'again';
  if (score < 0.75) return 'hard';
  if (score < 0.9) return 'good';
  return 'easy';
}

/** Per-concept long-term review state. */
export const ReviewItemSchema = z.object({
  workspaceId: z.string().min(1),
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  /** Memory stability in days (>= 0.1). */
  stability: z.number().positive(),
  /** Item difficulty in [1, 10] (FSRS-style; higher = harder). */
  difficulty: z.number().min(1).max(10),
  dueAt: z.string().datetime(),
  lastReviewedAt: z.string().datetime(),
  /** Scheduled interval in days (>= 0). */
  intervalDays: z.number().nonnegative(),
  reviewCount: z.number().int().positive(),
  lapseCount: z.number().int().nonnegative(),
  lastRating: ReviewRatingSchema,
  schedulerVersion: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

/** One immutable review event (audit trail of scheduler updates). */
export const ReviewEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conceptId: z.string().min(1),
  quizId: z.string().nullable(),
  rating: ReviewRatingSchema,
  /** Normalized score the rating was derived from. */
  score: z.number().min(0).max(1),
  /** Interval scheduled by this event, in days. */
  intervalDays: z.number().nonnegative(),
  dueAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

/** Kinds of entries the deterministic daily learning queue can contain. */
export const QueueItemKindSchema = z.enum([
  'overdue_review',
  'misconception_repair',
  'open_mistakes',
  'weak_prerequisite',
  'due_review',
  'unassessed_next',
]);
export type QueueItemKind = z.infer<typeof QueueItemKindSchema>;

/** One entry of the daily learning queue (deterministic local priority). */
export const DailyQueueItemSchema = z.object({
  kind: QueueItemKindSchema,
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  /** Misconception driving a repair item, when applicable. */
  misconceptionId: z.string().nullable(),
  /** Deterministic human-readable reason (no invented numbers). */
  reason: z.string().min(1).max(200),
  /** Days overdue for review items (0 for non-review kinds). */
  overdueDays: z.number().nonnegative(),
  /**
   * Server-resolved assessment request that launches this item. Computed at
   * queue-composition time by the activity launch resolver, so every listed
   * item is launchable when returned; the assessment service revalidates at
   * launch. Clients send it verbatim and never re-derive modes.
   */
  launch: CreateAssessmentRequestSchema,
});
export type DailyQueueItem = z.infer<typeof DailyQueueItemSchema>;
