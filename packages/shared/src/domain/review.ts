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
