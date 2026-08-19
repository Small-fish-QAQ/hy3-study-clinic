import { z } from 'zod';
import { DifficultySchema, QuestionTypeSchema, VerifiedGroundingSchema } from './material.js';

/**
 * Question blueprints: the validated intermediate contract between "what the
 * assessment should test" and the generated questions.
 *
 * A blueprint is DATA ONLY. It never grades anything itself — grading always
 * flows through the existing deterministic/objective and rubric pipelines.
 * Blueprints exist so that every workspace-level (possibly cross-document)
 * question stays attributable: canonical target → source concepts → source
 * documents → evidence, with local validation at each hop.
 */

/** How a blueprint's question will be graded (derived from its type). */
export const GradingMethodSchema = z.enum(['objective', 'semantic_rubric']);
export type GradingMethod = z.infer<typeof GradingMethodSchema>;

/** Whether a blueprint spans one document or several. */
export const BlueprintScopeSchema = z.enum(['single_document', 'cross_document']);
export type BlueprintScope = z.infer<typeof BlueprintScopeSchema>;

/** Workspace assessment modes a session can be launched in. */
export const AssessmentModeSchema = z.enum([
  'diagnostic',
  'concept_practice',
  'prerequisite_repair',
  'cross_document',
  'review',
  'misconception_check',
]);
export type AssessmentMode = z.infer<typeof AssessmentModeSchema>;

/** Upper bound on questions per workspace assessment. */
export const MAX_ASSESSMENT_QUESTIONS = 8;
/** Upper bound on evidence records per blueprint. */
export const MAX_BLUEPRINT_EVIDENCE = 4;
/** Upper bound on reasoning steps per blueprint. */
export const MAX_BLUEPRINT_STEPS = 4;

/** One expected reasoning step, mapped to the evidence that supports it. */
export const BlueprintReasoningStepSchema = z.object({
  description: z.string().min(1).max(300),
  /** Indices into the blueprint's evidence array supporting this step. */
  evidenceIndexes: z.array(z.number().int().nonnegative()).max(MAX_BLUEPRINT_EVIDENCE),
});
export type BlueprintReasoningStep = z.infer<typeof BlueprintReasoningStepSchema>;

/** A locally-validated, persisted question blueprint. */
export const QuestionBlueprintSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Canonical concepts this blueprint targets (1-3). */
  targetCanonicalConceptIds: z.array(z.string().min(1)).min(1).max(3),
  /** Source concepts the canonical targets resolve to for this question. */
  sourceConceptIds: z.array(z.string().min(1)).min(1).max(6),
  /** Distinct documents the verified evidence comes from. */
  sourceDocumentIds: z.array(z.string().min(1)).min(1).max(4),
  questionType: QuestionTypeSchema,
  difficulty: DifficultySchema,
  learningObjective: z.string().min(1).max(300),
  expectedReasoningSteps: z.array(BlueprintReasoningStepSchema).min(1).max(MAX_BLUEPRINT_STEPS),
  /** Misconception this blueprint is designed to discriminate, if any. */
  misconceptionId: z.string().nullable(),
  /** Server-verified evidence quotes (order matters for step mapping). */
  evidence: z.array(VerifiedGroundingSchema).min(1).max(MAX_BLUEPRINT_EVIDENCE),
  scope: BlueprintScopeSchema,
  gradingMethod: GradingMethodSchema,
  /** Deterministic local validation outcome ('accepted' rows only persist). */
  validationState: z.literal('accepted'),
  createdAt: z.string().datetime(),
});
export type QuestionBlueprint = z.infer<typeof QuestionBlueprintSchema>;

/**
 * Client-visible blueprint projection: reasoning steps stay server-side
 * until grading (they describe the expected answer path), everything needed
 * to display provenance is public.
 */
export const PublicBlueprintSchema = QuestionBlueprintSchema.omit({
  expectedReasoningSteps: true,
});
export type PublicBlueprint = z.infer<typeof PublicBlueprintSchema>;

/** Runtime contract for POST /api/workspaces/:id/assessments. */
export const CreateAssessmentRequestSchema = z
  .object({
    mode: AssessmentModeSchema,
    /** Target source-concept ids (required for concept-scoped modes). */
    conceptIds: z.array(z.string().min(1)).max(3).optional(),
    /** Misconception to discriminate (misconception_check mode). */
    misconceptionId: z.string().min(1).optional(),
    /** Formal Study checks request short-answer-only generation. */
    formalOnly: z.boolean().optional(),
  })
  .strict();
export type CreateAssessmentRequest = z.infer<typeof CreateAssessmentRequestSchema>;

/** Grading method implied by each question type (single source of truth). */
export function gradingMethodForType(
  type: z.infer<typeof QuestionTypeSchema>,
): z.infer<typeof GradingMethodSchema> {
  return type === 'single_choice' || type === 'multiple_choice' ? 'objective' : 'semantic_rubric';
}
