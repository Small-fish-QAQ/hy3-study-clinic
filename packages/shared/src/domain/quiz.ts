import { z } from 'zod';
import { DifficultySchema, QuestionTypeSchema, VerifiedGroundingSchema } from './material.js';

/** Requested quiz shape. */
export const QuizConfigSchema = z.object({
  difficulty: DifficultySchema,
  types: z.array(QuestionTypeSchema).min(1).max(3),
  /** Number of questions per selected type. */
  countPerType: z.number().int().min(1).max(5),
});
export type QuizConfig = z.infer<typeof QuizConfigSchema>;

/** A choice option. Option ids are stable letters: "A", "B", ... */
export const OptionSchema = z.object({
  id: z.string().regex(/^[A-H]$/),
  text: z.string().min(1).max(500),
});
export type Option = z.infer<typeof OptionSchema>;

/** Rubric for short-answer grading. */
export const RubricSchema = z.object({
  keyPoints: z.array(z.string().min(1).max(300)).min(1).max(6),
});
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * A fully-specified question as stored on the server.
 * `correctOptionIds`, `expectedAnswer` and `rubric` are server-side secrets
 * until the quiz has been graded.
 */
export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    quizId: z.string().min(1),
    index: z.number().int().nonnegative(),
    type: QuestionTypeSchema,
    stem: z.string().min(1).max(2000),
    /** Present for single_choice / multiple_choice. */
    options: z.array(OptionSchema).min(2).max(8).optional(),
    /** Present for single_choice (exactly 1) / multiple_choice (>= 1). */
    correctOptionIds: z
      .array(z.string().regex(/^[A-H]$/))
      .min(1)
      .optional(),
    /** Present for short_answer. */
    expectedAnswer: z.string().min(1).max(2000).optional(),
    rubric: RubricSchema.optional(),
    conceptId: z.string().min(1),
    conceptName: z.string().min(1),
    grounding: VerifiedGroundingSchema,
    explanation: z.string().min(1).max(2000),
    points: z.number().positive(),
    /** For remediation questions: the mistakes this question re-tests. */
    sourceMistakeIds: z.array(z.string()).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'short_answer') {
      if (!q.expectedAnswer || !q.rubric) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'short_answer questions require expectedAnswer and rubric',
        });
      }
      if (q.options !== undefined || q.correctOptionIds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'short_answer questions must not define choice fields',
        });
      }
      return;
    }
    if (q.expectedAnswer !== undefined || q.rubric !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice questions must not define short-answer fields',
      });
    }
    if (!q.options || !q.correctOptionIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice questions require options and correctOptionIds',
      });
      return;
    }
    const optionIds = new Set(q.options.map((o) => o.id));
    if (optionIds.size !== q.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique' });
    }
    if (new Set(q.correctOptionIds).size !== q.correctOptionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'correctOptionIds must be unique',
      });
    }
    for (const id of q.correctOptionIds) {
      if (!optionIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `correct option ${id} is not one of the options`,
        });
      }
    }
    if (q.type === 'single_choice' && q.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_choice must have exactly one correct option',
      });
    }
    if (q.type === 'multiple_choice' && q.correctOptionIds.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'multiple_choice must have at least one correct option',
      });
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

export const QuizKindSchema = z.enum(['standard', 'remediation']);
export type QuizKind = z.infer<typeof QuizKindSchema>;

export const QuizSchema = z.object({
  id: z.string().min(1),
  materialId: z.string().min(1),
  kind: QuizKindSchema,
  config: QuizConfigSchema,
  questions: z.array(QuestionSchema).min(1),
  /** For remediation quizzes: the weak concepts being targeted. */
  targetConceptIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
});
export type Quiz = z.infer<typeof QuizSchema>;

/**
 * The client-visible projection of a question: no correct answers, no
 * expected answer, no rubric. The grounding quote IS visible — showing the
 * evidence is a core product feature ("open book" studying).
 */
export const PublicQuestionSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  type: QuestionTypeSchema,
  stem: z.string(),
  options: z.array(OptionSchema).optional(),
  conceptId: z.string(),
  conceptName: z.string(),
  grounding: VerifiedGroundingSchema,
  points: z.number().positive(),
});
export type PublicQuestion = z.infer<typeof PublicQuestionSchema>;

export const PublicQuizSchema = z.object({
  id: z.string(),
  materialId: z.string(),
  kind: QuizKindSchema,
  config: QuizConfigSchema,
  questions: z.array(PublicQuestionSchema).min(1),
  targetConceptIds: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
});
export type PublicQuiz = z.infer<typeof PublicQuizSchema>;
