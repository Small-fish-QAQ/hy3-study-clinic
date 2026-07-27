import { z } from 'zod';
import { SourceBlockSchema } from './material.js';
import { PublicQuizSchema, QuestionSchema, QuizKindSchema } from './quiz.js';
import { AnswerSchema, GradingResultSchema, SubmissionStateChangesSchema } from './grading.js';

/**
 * Provider that produced a graded attempt. Recorded at grading time so a
 * historical result stays honestly labelled (offline Fake vs. live Hy3)
 * even after the server configuration changes. Attempts graded before this
 * field existed read back as null and must be shown as "not recorded",
 * never relabelled.
 */
export const AttemptProviderSchema = z.enum(['fake', 'hy3']);
export type AttemptProvider = z.infer<typeof AttemptProviderSchema>;

/** Most recent completed attempts returned per workspace history request. */
export const MAX_ATTEMPT_HISTORY = 50;

/**
 * One completed (graded) attempt in the workspace history list. `id` is the
 * grading-result id; a quiz submitted twice yields two independent entries.
 */
export const CompletedAttemptSummarySchema = z.object({
  id: z.string().min(1),
  quizId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: QuizKindSchema,
  assessmentMode: z.string().max(40).optional(),
  /** Owning document (null for workspace-scoped assessments). */
  materialId: z.string().min(1).nullable(),
  /** Document title at read time; null when the document no longer exists. */
  materialTitle: z.string().nullable(),
  questionCount: z.number().int().positive(),
  totalAwarded: z.number().nonnegative(),
  totalPossible: z.number().positive(),
  overallScore: z.number().min(0).max(1),
  provider: AttemptProviderSchema.nullable(),
  completedAt: z.string().datetime(),
});
export type CompletedAttemptSummary = z.infer<typeof CompletedAttemptSummarySchema>;

/**
 * Faithful read-only replay of one graded attempt. Everything except
 * `blocks` and `materialTitle` is the persisted original: questions (with
 * revealed answers/rubrics, exactly like the immediate post-submit
 * response), the learner's submitted answers, the grading result, and the
 * deterministic state-change summary recorded at submission time
 * (null for attempts graded before snapshots existed — never fabricated).
 *
 * `blocks` are the CURRENT source blocks referenced by the questions'
 * verified evidence. A block whose document was deleted or reprocessed is
 * simply absent; the persisted grounding quote inside each question remains
 * the honest historical evidence in that case.
 */
export const CompletedAttemptDetailSchema = z.object({
  summary: CompletedAttemptSummarySchema,
  quiz: PublicQuizSchema,
  questions: z.array(QuestionSchema).min(1),
  answers: z.array(AnswerSchema).min(1),
  grading: GradingResultSchema,
  stateChanges: SubmissionStateChangesSchema.nullable(),
  blocks: z.array(SourceBlockSchema),
});
export type CompletedAttemptDetail = z.infer<typeof CompletedAttemptDetailSchema>;
