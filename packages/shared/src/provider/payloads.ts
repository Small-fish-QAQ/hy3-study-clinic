import { z } from 'zod';
import { DifficultySchema, ImportanceSchema, QuestionTypeSchema } from '../domain/material.js';
import { GraphRelationSchema } from '../domain/graph.js';
import { PlanStrategySchema } from '../domain/plan.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLooseOptionId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = value
    .trim()
    .toUpperCase()
    .match(/^(?:OPTION|选项)?\s*([A-H])(?:[\s.)、:：-]*)$/u);
  return match?.[1] ?? value;
}

/**
 * Normalize harmless model-format variations before strict validation.
 *
 * Hy3 may occasionally emit choice labels such as "1"/"2" or "A."/"B.",
 * and may include empty placeholder fields for the other question kind. We
 * canonicalize unique option labels by their stable array order and remove
 * only EMPTY inapplicable fields. Non-empty conflicting fields still fail the
 * strict schema below.
 */
function normalizeProposedQuestion(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const question: Record<string, unknown> = { ...value };

  if (Array.isArray(question.options)) {
    const options = question.options;
    const rawIds = options.map((option) =>
      isRecord(option) && typeof option.id === 'string' ? option.id.trim() : null,
    );
    const canCanonicalize =
      options.length <= 8 &&
      rawIds.every((id): id is string => Boolean(id)) &&
      new Set(rawIds).size === rawIds.length;

    if (canCanonicalize) {
      const aliases = new Map<string, string>();
      question.options = options.map((option, index) => {
        if (!isRecord(option)) return option;
        const rawId = rawIds[index]!;
        const canonicalId = String.fromCharCode('A'.charCodeAt(0) + index);
        aliases.set(rawId, canonicalId);
        aliases.set(rawId.toUpperCase(), canonicalId);
        const loose = normalizeLooseOptionId(rawId);
        if (typeof loose === 'string') aliases.set(loose, canonicalId);
        return { ...option, id: canonicalId };
      });

      if (Array.isArray(question.correctOptionIds)) {
        question.correctOptionIds = question.correctOptionIds.map((id) => {
          if (typeof id !== 'string') return id;
          const rawId = id.trim();
          const loose = normalizeLooseOptionId(rawId);
          return (
            aliases.get(rawId) ??
            aliases.get(rawId.toUpperCase()) ??
            (typeof loose === 'string' ? (aliases.get(loose) ?? loose) : loose)
          );
        });
      }
    } else {
      question.options = options.map((option) =>
        isRecord(option) ? { ...option, id: normalizeLooseOptionId(option.id) } : option,
      );
      if (Array.isArray(question.correctOptionIds)) {
        question.correctOptionIds = question.correctOptionIds.map(normalizeLooseOptionId);
      }
    }
  }

  if (question.type === 'short_answer') {
    if (
      question.options === null ||
      (Array.isArray(question.options) && question.options.length === 0)
    ) {
      delete question.options;
    }
    if (
      question.correctOptionIds === null ||
      (Array.isArray(question.correctOptionIds) && question.correctOptionIds.length === 0)
    ) {
      delete question.correctOptionIds;
    }
  } else if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    if (
      question.expectedAnswer === null ||
      (typeof question.expectedAnswer === 'string' && question.expectedAnswer.trim() === '')
    ) {
      delete question.expectedAnswer;
    }
    if (
      question.rubricKeyPoints === null ||
      (Array.isArray(question.rubricKeyPoints) && question.rubricKeyPoints.length === 0)
    ) {
      delete question.rubricKeyPoints;
    }
  }

  return question;
}

const StrictProposedQuestionSchema = z
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

export const ProposedQuestionSchema = z.preprocess(
  normalizeProposedQuestion,
  StrictProposedQuestionSchema,
);
export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

export const QuizGenerationPayloadSchema = z.object({
  questions: z.array(ProposedQuestionSchema).min(1).max(30),
});
export type QuizGenerationPayload = z.infer<typeof QuizGenerationPayloadSchema>;

/**
 * Evidence as PROPOSED by a model: block reference plus exact quote.
 * The server verifies every quote and computes offsets itself.
 */
export const ProposedEvidenceSchema = z.object({
  blockId: z.string().min(1),
  quote: z.string().min(1).max(500),
});
export type ProposedEvidence = z.infer<typeof ProposedEvidenceSchema>;

/** One candidate concept-graph edge proposed by a provider. */
export const ProposedGraphEdgeSchema = z.object({
  sourceConceptId: z.string().min(1),
  targetConceptId: z.string().min(1),
  relation: GraphRelationSchema,
  explanation: z.string().min(1).max(500),
  evidence: z.array(ProposedEvidenceSchema).min(1).max(3),
});
export type ProposedGraphEdge = z.infer<typeof ProposedGraphEdgeSchema>;

/** Structured provider output for graph-edge proposal. */
export const GraphProposalPayloadSchema = z.object({
  edges: z.array(ProposedGraphEdgeSchema).min(1).max(60),
});
export type GraphProposalPayload = z.infer<typeof GraphProposalPayloadSchema>;

/** One target concept of a proposed remediation plan. */
export const ProposedPlanTargetSchema = z.object({
  conceptId: z.string().min(1),
  reason: z.string().min(1).max(500),
  evidence: z.array(ProposedEvidenceSchema).min(1).max(3),
});
export type ProposedPlanTarget = z.infer<typeof ProposedPlanTargetSchema>;

/** One ordered step of a proposed remediation plan. */
export const ProposedPlanStepSchema = z.object({
  description: z.string().min(1).max(500),
  conceptId: z.string().min(1).nullable().optional(),
});
export type ProposedPlanStep = z.infer<typeof ProposedPlanStepSchema>;

/** Structured provider output for remediation-plan proposal. */
export const RemediationPlanProposalPayloadSchema = z.object({
  summary: z.string().min(1).max(600),
  weaknessHypothesis: z.string().min(1).max(600),
  strategy: PlanStrategySchema,
  difficulty: DifficultySchema,
  questionTypes: z.array(QuestionTypeSchema).min(1).max(3),
  steps: z.array(ProposedPlanStepSchema).min(1).max(6),
  targets: z.array(ProposedPlanTargetSchema).min(1).max(4),
});
export type RemediationPlanProposalPayload = z.infer<typeof RemediationPlanProposalPayloadSchema>;
