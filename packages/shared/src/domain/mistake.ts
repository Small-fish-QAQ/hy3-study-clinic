import { z } from 'zod';
import { AnswerSchema } from './grading.js';
import { QuestionSchema } from './quiz.js';

export const MistakeStatusSchema = z.enum(['open', 'resolved']);
export type MistakeStatus = z.infer<typeof MistakeStatusSchema>;

/**
 * A recorded mistake: the full question snapshot (including the correct
 * answer and rubric — the learner has already been graded on it), what the
 * learner answered, and the grading feedback.
 */
export const MistakeRecordSchema = z.object({
  id: z.string().min(1),
  materialId: z.string().min(1),
  quizId: z.string().min(1),
  questionId: z.string().min(1),
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  question: QuestionSchema,
  userAnswer: AnswerSchema,
  /** Normalized score the learner got on this question ([0, 1)). */
  score: z.number().min(0).max(1),
  feedback: z.string().max(1000).optional(),
  status: MistakeStatusSchema,
  /** How many remediation questions have been generated from this mistake. */
  remediationCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type MistakeRecord = z.infer<typeof MistakeRecordSchema>;

/**
 * Per-concept mastery state.
 *
 * Deterministic update formula (documented, no model involvement):
 *
 *   mastery_new = clamp01(mastery_old + ALPHA * (score - mastery_old))
 *
 * with ALPHA = 0.3 and initial mastery 0.5. See `mastery.ts`.
 */
export const MasteryStateSchema = z.object({
  materialId: z.string().min(1),
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  mastery: z.number().min(0).max(1),
  attempts: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  lastScore: z.number().min(0).max(1).nullable(),
  updatedAt: z.string().datetime(),
});
export type MasteryState = z.infer<typeof MasteryStateSchema>;
