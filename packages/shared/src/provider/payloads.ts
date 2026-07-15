import { z } from 'zod';
import { ImportanceSchema, QuestionTypeSchema } from '../domain/material.js';

/**
 * Structured payloads that LLM providers must return.
 *
 * These schemas are the ONLY accepted shapes for model output. Providers get
 * one bounded repair attempt on validation failure, then fail with a
 * structured error. Models cite sources as (blockId, exact quote) — never
 * offsets — and the server independently verifies every quote.
 */

export const ProposedConceptSchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(500),
  importance: ImportanceSchema,
  blockId: z.string().min(1),
  quote: z.string().min(1).max(500),
});
export type ProposedConcept = z.infer<typeof ProposedConceptSchema>;

export const ConceptAnalysisPayloadSchema = z.object({
  concepts: z.array(ProposedConceptSchema).min(1).max(12),
});
export type ConceptAnalysisPayload = z.infer<typeof ConceptAnalysisPayloadSchema>;

export const ProposedOptionSchema = z.object({
  id: z.string().regex(/^[A-H]$/),
  text: z.string().min(1).max(300),
});

export const ProposedQuestionSchema = z
  .object({
    type: QuestionTypeSchema,
    stem: z.string().min(1).max(500),
    options: z.array(ProposedOptionSchema).min(2).max(8).optional(),
    correctOptionIds: z
      .array(z.string().regex(/^[A-H]$/))
      .min(1)
      .optional(),
    expectedAnswer: z.string().min(1).max(1000).optional(),
    rubricKeyPoints: z.array(z.string().min(1).max(200)).min(1).max(6).optional(),
    conceptId: z.string().min(1),
    blockId: z.string().min(1),
    quote: z.string().min(1).max(500),
    explanation: z.string().min(1).max(1000),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'short_answer') {
      if (!q.expectedAnswer || !q.rubricKeyPoints) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'short_answer requires expectedAnswer and rubricKeyPoints',
        });
      }
      if (q.options !== undefined || q.correctOptionIds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'short_answer must not define choice fields',
        });
      }
      return;
    }
    if (q.expectedAnswer !== undefined || q.rubricKeyPoints !== undefined) {
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
    const ids = new Set(q.options.map((o) => o.id));
    if (ids.size !== q.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique' });
    }
    if (new Set(q.correctOptionIds).size !== q.correctOptionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'correctOptionIds must be unique',
      });
    }
    for (const id of q.correctOptionIds) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `correctOptionId ${id} not present in options`,
        });
      }
    }
    if (q.type === 'single_choice' && q.correctOptionIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_choice must have exactly one correct option',
      });
    }
  });
export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

export const QuizGenerationPayloadSchema = z.object({
  questions: z.array(ProposedQuestionSchema).min(1).max(30),
});
export type QuizGenerationPayload = z.infer<typeof QuizGenerationPayloadSchema>;
