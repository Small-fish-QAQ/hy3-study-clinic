import { z } from 'zod';
import { DifficultySchema, QuestionTypeSchema, VerifiedGroundingSchema } from './material.js';

/** Controlled remediation strategies the planner may propose. */
export const PlanStrategySchema = z.enum([
  'review',
  'contrast',
  'worked_example',
  'retrieval_practice',
  'prerequisite_repair',
  'application_practice',
]);
export type PlanStrategy = z.infer<typeof PlanStrategySchema>;

/** Upper bound on target concepts per remediation plan. */
export const MAX_PLAN_TARGETS = 4;
/** Upper bound on ordered steps per remediation plan. */
export const MAX_PLAN_STEPS = 6;
/** Upper bound on evidence records retained per plan target. */
export const MAX_PLAN_TARGET_EVIDENCE = 3;

/** One target concept of an accepted plan, with its evidence-backed reason. */
export const PlanTargetSchema = z.object({
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  /** Why this concept is targeted (shown to the learner). */
  reason: z.string().min(1).max(500),
  /** Server-verified evidence backing the reason; at least one record. */
  evidence: z.array(VerifiedGroundingSchema).min(1).max(MAX_PLAN_TARGET_EVIDENCE),
});
export type PlanTarget = z.infer<typeof PlanTargetSchema>;

/** One ordered step of an accepted plan. */
export const PlanStepSchema = z.object({
  index: z.number().int().nonnegative(),
  description: z.string().min(1).max(500),
  /** Optional concept this step focuses on (must exist in the workspace). */
  conceptId: z.string().min(1).nullable(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * A locally-validated, accepted remediation plan.
 *
 * The plan is DATA ONLY: accepting it never modifies mastery, never resolves
 * or closes mistakes, and never writes learning history. Learning state only
 * changes when the learner completes the launched assessment, through the
 * existing deterministic grading pipeline.
 */
export const RemediationPlanSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** The selected concept the plan was generated for. */
  conceptId: z.string().min(1),
  summary: z.string().min(1).max(600),
  /** Observed weakness / misconception hypothesis (model-proposed, labelled). */
  weaknessHypothesis: z.string().min(1).max(600),
  strategy: PlanStrategySchema,
  difficulty: DifficultySchema,
  /** Question types to practice; restricted to the existing assessment engine. */
  questionTypes: z.array(QuestionTypeSchema).min(1).max(3),
  steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
  targets: z.array(PlanTargetSchema).min(1).max(MAX_PLAN_TARGETS),
  provider: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
});
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;
