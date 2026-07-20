import { z } from 'zod';
import { VerifiedGroundingSchema } from './material.js';
import { AnswerSchema } from './grading.js';

/**
 * Misconception hypotheses.
 *
 * One wrong answer is never treated as a proven learner diagnosis: it may
 * create a PROPOSED hypothesis, which only a discriminating activity can
 * CONFIRM or REJECT, and only later correct performance can RESOLVE.
 * All transitions are executed by deterministic local code
 * (see server misconceptions service); the model can merely propose.
 */

export const MisconceptionStatusSchema = z.enum(['proposed', 'confirmed', 'rejected', 'resolved']);
export type MisconceptionStatus = z.infer<typeof MisconceptionStatusSchema>;

export const MisconceptionCategorySchema = z.enum([
  'definition_confusion',
  'prerequisite_gap',
  'reversed_causality',
  'category_confusion',
  'sequence_error',
  'overgeneralization',
  'undergeneralization',
  'application_error',
  'unknown',
]);
export type MisconceptionCategory = z.infer<typeof MisconceptionCategorySchema>;

/**
 * Deterministic transition table — the ONLY legal status changes.
 * Everything else must be rejected by the service layer.
 */
export const MISCONCEPTION_TRANSITIONS: Readonly<
  Record<MisconceptionStatus, readonly MisconceptionStatus[]>
> = {
  proposed: ['confirmed', 'rejected'],
  confirmed: ['resolved'],
  rejected: [],
  resolved: [],
};

export function isMisconceptionTransitionAllowed(
  from: MisconceptionStatus,
  to: MisconceptionStatus,
): boolean {
  return MISCONCEPTION_TRANSITIONS[from].includes(to);
}

/** A persisted misconception hypothesis with full audit linkage. */
export const MisconceptionRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Source concept the hypothesis is about (canonical view derives from it). */
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  /** Blueprint of the originating question (null for legacy quiz questions). */
  originBlueprintId: z.string().nullable(),
  originQuestionId: z.string().min(1),
  originQuizId: z.string().min(1),
  /** What the learner actually answered (audit evidence). */
  learnerAnswer: AnswerSchema,
  /** Server-verified source evidence backing the hypothesis. */
  evidence: z.array(VerifiedGroundingSchema).max(2),
  category: MisconceptionCategorySchema,
  /** Concise hypothesis text, always phrased as tentative. */
  hypothesis: z.string().min(1).max(400),
  provider: z.string().min(1).max(40),
  status: MisconceptionStatusSchema,
  /** Quiz that confirmed/rejected/resolved the hypothesis, when decided. */
  decidedByQuizId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MisconceptionRecord = z.infer<typeof MisconceptionRecordSchema>;

/** Compact per-concept misconception counts for graph/inspector badges. */
export const MisconceptionCountsSchema = z.object({
  conceptId: z.string().min(1),
  proposed: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
});
export type MisconceptionCounts = z.infer<typeof MisconceptionCountsSchema>;
