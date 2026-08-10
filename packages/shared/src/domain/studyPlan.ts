import { z } from 'zod';
import { DesiredDepthSchema } from './learningContract.js';
import { EvidenceAdmissibilityTierSchema } from './sourceAuthority.js';

export const StudyPlanStatusSchema = z.enum([
  'candidate',
  'proposed',
  'accepted',
  'rejected',
  'superseded',
  'closed',
]);
export type StudyPlanStatus = z.infer<typeof StudyPlanStatusSchema>;

export const StudyPlanItemKindSchema = z.enum([
  'teach_unit',
  'informal_check',
  'formal_checkpoint',
  'synthesis',
  'targeted_repair',
  'due_review',
  'adversarial_readiness',
]);
export type StudyPlanItemKind = z.infer<typeof StudyPlanItemKindSchema>;

export const CompletionPolicyReferenceSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();
export type CompletionPolicyReference = z.infer<typeof CompletionPolicyReferenceSchema>;

export const PlanCompletionRequirementSchema = z
  .object({
    id: z.string().min(1),
    objectiveIds: z.array(z.string().min(1)).min(1).max(30),
    description: z.string().min(1).max(500),
    blocking: z.boolean(),
    admissibilityTier: EvidenceAdmissibilityTierSchema,
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (requirement.blocking && requirement.admissibilityTier === 'tier_3_advisory') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['admissibilityTier'],
        message: 'tier-3 advisory evidence cannot be a blocking completion requirement',
      });
    }
  });
export type PlanCompletionRequirement = z.infer<typeof PlanCompletionRequirementSchema>;

export const StudyPlanItemSchema = z
  .object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    phase: z.string().min(1).max(200),
    kind: StudyPlanItemKindSchema,
    curriculumLearningUnitId: z.string().min(1).nullable(),
    rationale: z.string().min(1).max(1000),
    estimatedMinutes: z.number().int().positive(),
    targetDepth: DesiredDepthSchema,
    objectiveIds: z.array(z.string().min(1)).max(30),
    prerequisitePlanItemIds: z.array(z.string().min(1)).max(30),
    completionPolicy: CompletionPolicyReferenceSchema.nullable(),
    completionRequirements: z.array(PlanCompletionRequirementSchema).max(30),
  })
  .strict();
export type StudyPlanItem = z.infer<typeof StudyPlanItemSchema>;

export const StudyPlanDeferralSchema = z
  .object({
    curriculumLearningUnitId: z.string().min(1),
    objectiveIds: z.array(z.string().min(1)).max(30),
    reason: z.string().min(1).max(500),
    riskIds: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();
export type StudyPlanDeferral = z.infer<typeof StudyPlanDeferralSchema>;

export const StudyPlanFeasibilitySchema = z
  .object({
    projectedMinutes: z.number().int().nonnegative(),
    availableMinutes: z.number().int().nonnegative().nullable(),
    slackMinutes: z.number().int().nullable(),
    state: z.enum(['feasible', 'at_risk', 'infeasible', 'unknown']),
    assumptions: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();
export type StudyPlanFeasibility = z.infer<typeof StudyPlanFeasibilitySchema>;

export const PaceBaselineSchema = z
  .object({
    id: z.string().min(1),
    policyVersion: z.string().min(1).max(100),
    contractVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    timeZone: z.string().min(1).max(100),
    expectedSessionCadencePerWeek: z.number().positive().nullable(),
    explicitSlackMinutes: z.number().int().nonnegative(),
    estimateConfidence: z.enum(['low', 'medium', 'high']),
    estimateSource: z.enum(['local', 'learner', 'model_assisted']),
    milestones: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            cumulativeMinutes: z.number().int().nonnegative(),
            throughPlanItemId: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type PaceBaseline = z.infer<typeof PaceBaselineSchema>;

export const StudyPlanDiffOperationSchema = z
  .object({
    kind: z.enum(['added', 'removed', 'reordered', 'resized', 'depth_changed', 'deferred']),
    planItemId: z.string().min(1).nullable(),
    curriculumLearningUnitId: z.string().min(1).nullable(),
    beforeIndex: z.number().int().nonnegative().nullable(),
    afterIndex: z.number().int().nonnegative().nullable(),
    beforeMinutes: z.number().int().nonnegative().nullable(),
    afterMinutes: z.number().int().nonnegative().nullable(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type StudyPlanDiffOperation = z.infer<typeof StudyPlanDiffOperationSchema>;

export const StudyPlanSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    proposalTrigger: z.string().min(1).max(500),
    status: StudyPlanStatusSchema,
    rationale: z.string().min(1).max(1000),
    items: z.array(StudyPlanItemSchema).min(1).max(1000),
    deferrals: z.array(StudyPlanDeferralSchema).max(500),
    feasibility: StudyPlanFeasibilitySchema,
    paceBaseline: PaceBaselineSchema.nullable(),
    diff: z.array(StudyPlanDiffOperationSchema).max(2000),
    provider: z.string().min(1).max(40),
    providerModel: z.string().max(120).nullable(),
    learnerAcceptedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.status === 'accepted' && (!plan.learnerAcceptedAt || !plan.paceBaseline)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an accepted StudyPlan requires learner acceptance and a PaceBaseline',
      });
    }
  });
export type StudyPlan = z.infer<typeof StudyPlanSchema>;

export const StudyPlanProgressStateSchema = z.enum([
  'not_started',
  'started',
  'completed',
  'repair_needed',
  'deferred',
  'obsolete',
]);
export type StudyPlanProgressState = z.infer<typeof StudyPlanProgressStateSchema>;
