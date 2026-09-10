import { TransferPerformanceSchema } from './transferAssessment.js';
import { z } from 'zod';
import { isTextAnswerType, QuestionTypeSchema, type QuestionType } from './material.js';

/** A single answer submitted by the learner. */
export const AnswerSchema = z
  .object({
    questionId: z.string().min(1),
    type: QuestionTypeSchema,
    /** For single_choice: exactly one id. For multiple_choice: >= 0 ids. */
    selectedOptionIds: z.array(z.string().regex(/^[A-H]$/)).optional(),
    /** For text-answered types (short_answer / concept_comparison). */
    text: z.string().max(4000).optional(),
  })
  .superRefine((a, ctx) => {
    if (isTextAnswerType(a.type)) {
      if (a.selectedOptionIds && a.selectedOptionIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${a.type} must not include selectedOptionIds`,
        });
      }
    } else if (a.text !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice answers must not include free text',
      });
    }
  });
export type Answer = z.infer<typeof AnswerSchema>;

export const SubmissionSchema = z.object({
  id: z.string().min(1),
  quizId: z.string().min(1),
  answers: z.array(AnswerSchema).min(1),
  createdAt: z.string().datetime(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const SubmissionRequestSchema = z.object({
  quizId: z.string().min(1),
  answers: z.array(AnswerSchema).min(1),
});
export type SubmissionRequest = z.infer<typeof SubmissionRequestSchema>;

/** Who produced a per-question grade. */
export const GradedBySchema = z.enum(['deterministic', 'model', 'model_fallback']);
export type GradedBy = z.infer<typeof GradedBySchema>;

/**
 * Model output for short-answer grading (validated with Zod).
 * The model reports coverage of rubric key points and its own uncertainty —
 * the server computes the score deterministically from the coverage of
 * REQUIRED points only (optional points can never reduce it).
 */
export const RubricGradeSchema = z.object({
  transferPerformance: TransferPerformanceSchema.optional(),
  /** Indices into the rubric.keyPoints array that the answer fully satisfied. */
  matchedKeyPointIndexes: z.array(z.number().int().nonnegative()),
  /**
   * Indices the answer only partially satisfied (half credit for required
   * points). Optional for backward compatibility with older grade payloads.
   */
  partialKeyPointIndexes: z.array(z.number().int().nonnegative()).optional(),
  /** Model-normalized score in [0, 1] (advisory; the server recomputes). */
  score: z.number().min(0).max(1),
  /** Model self-reported confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(1000),
});
export type RubricGrade = z.infer<typeof RubricGradeSchema>;

/** The grade for a single question. */
export const QuestionGradeSchema = z.object({
  transferPerformance: TransferPerformanceSchema.optional(),
  questionId: z.string().min(1),
  type: QuestionTypeSchema,
  gradedBy: GradedBySchema,
  correct: z.boolean(),
  awardedPoints: z.number().nonnegative(),
  maxPoints: z.number().positive(),
  /** Normalized [0,1] score for this question. */
  normalizedScore: z.number().min(0).max(1),
  /** Rubric key points the answer covered (short_answer only). */
  matchedKeyPoints: z.array(z.string()).optional(),
  /** REQUIRED rubric key points the answer missed (short_answer only). */
  missedKeyPoints: z.array(z.string()).optional(),
  /** REQUIRED rubric key points only partially covered (short_answer only). */
  partialKeyPoints: z.array(z.string()).optional(),
  /**
   * OPTIONAL rubric key points the answer did not mention. Enrichment
   * suggestions (可补充) — they never reduce the score and must not be
   * displayed as errors.
   */
  enrichmentKeyPoints: z.array(z.string()).optional(),
  /** Model confidence, surfaced to the learner (short_answer only). */
  confidence: z.number().min(0).max(1).optional(),
  feedback: z.string().max(1000).optional(),
  /** True when this grade is uncertain and worth human review. */
  needsReview: z.boolean(),
});
export type QuestionGrade = z.infer<typeof QuestionGradeSchema>;

export const GradingResultSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  quizId: z.string().min(1),
  grades: z.array(QuestionGradeSchema).min(1),
  totalAwarded: z.number().nonnegative(),
  totalPossible: z.number().positive(),
  /** Normalized overall score in [0, 1], computed deterministically. */
  overallScore: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
});
export type GradingResult = z.infer<typeof GradingResultSchema>;

/** One per-concept mastery movement recorded by a graded submission. */
export const MasteryChangeSchema = z.object({
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  before: z.number().min(0).max(1).nullable(),
  after: z.number().min(0).max(1),
});
export type MasteryChange = z.infer<typeof MasteryChangeSchema>;

/**
 * Deterministic summary of every learning-state change a graded submission
 * caused. Computed locally while persisting outcomes (never by the model)
 * and returned with the grading result so the UI can explain what happened.
 */
export const SubmissionStateChangesSchema = z.object({
  /** Source concepts the submission assessed. */
  assessedConceptIds: z.array(z.string()).max(20),
  /** Distinct documents the questions drew evidence from. */
  documentIds: z.array(z.string()).max(10),
  mistakesCreated: z.number().int().nonnegative(),
  mistakesResolved: z.number().int().nonnegative(),
  misconceptionsProposed: z.number().int().nonnegative(),
  misconceptionsConfirmed: z.number().int().nonnegative(),
  misconceptionsRejected: z.number().int().nonnegative(),
  misconceptionsResolved: z.number().int().nonnegative(),
  masteryChanges: z.array(MasteryChangeSchema).max(20),
  /** Concepts whose review item was created or rescheduled. */
  reviewScheduled: z
    .array(
      z.object({
        conceptId: z.string().min(1),
        conceptName: z.string().min(1),
        rating: z.string().min(1).max(10),
        dueAt: z.string().datetime(),
      }),
    )
    .max(20),
  /** Deterministic recommended next step (concise Chinese sentence). */
  recommendedNextStep: z.string().min(1).max(300),
});
export type SubmissionStateChanges = z.infer<typeof SubmissionStateChangesSchema>;

// ---------------------------------------------------------------------------
// Graded-status classification (shared by server scoring and the results UI)
// ---------------------------------------------------------------------------

/**
 * A short answer counts as "passed" at or above this normalized score.
 * With required-coverage scoring (full = 1, partial = 0.5 per required
 * point), 0.6 means e.g. 2 of 3 required points fully covered, or 1 full +
 * 1 partial of 2. The same threshold also gates mistake creation.
 */
export const SHORT_ANSWER_PASS = 0.6;

/**
 * Learner-facing result classification. Thresholds are NOT arbitrary — they
 * are derived from required-criterion coverage:
 * - correct:      every required point fully covered (score ≈ 1); missing
 *                 optional enrichment never demotes this;
 * - mostly_correct: passed (score ≥ SHORT_ANSWER_PASS) but at least one
 *                 required point is missing or partial;
 * - partial:      some required coverage (score > 0) below the pass line;
 * - insufficient: no required coverage at all.
 * Choice questions stay binary (exact match): correct / insufficient.
 */
export type GradeStatus = 'correct' | 'mostly_correct' | 'partial' | 'insufficient';

/** Tolerance for floating-point score accumulation (e.g. 2/3 + 1/3). */
const FULL_SCORE_EPSILON = 1e-6;

export function classifyGradeStatus(grade: {
  type: QuestionType;
  correct: boolean;
  normalizedScore: number;
}): GradeStatus {
  if (!isTextAnswerType(grade.type)) {
    return grade.correct ? 'correct' : 'insufficient';
  }
  if (grade.normalizedScore >= 1 - FULL_SCORE_EPSILON) return 'correct';
  if (grade.normalizedScore >= SHORT_ANSWER_PASS) return 'mostly_correct';
  if (grade.normalizedScore > 0) return 'partial';
  return 'insufficient';
}
