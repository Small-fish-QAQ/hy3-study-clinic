import { z } from 'zod';
import { isTextAnswerType, QuestionTypeSchema } from './material.js';

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
 * The model reports coverage of rubric key points, a normalized score, and
 * its own uncertainty — the server maps these to points deterministically.
 */
export const RubricGradeSchema = z.object({
  /** Indices into the rubric.keyPoints array that the answer satisfied. */
  matchedKeyPointIndexes: z.array(z.number().int().nonnegative()),
  /** Model-normalized score in [0, 1]. */
  score: z.number().min(0).max(1),
  /** Model self-reported confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(1000),
});
export type RubricGrade = z.infer<typeof RubricGradeSchema>;

/** The grade for a single question. */
export const QuestionGradeSchema = z.object({
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
  /** Rubric key points the answer missed (short_answer only). */
  missedKeyPoints: z.array(z.string()).optional(),
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
