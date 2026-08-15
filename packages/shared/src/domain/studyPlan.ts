import { z } from 'zod';
import { CourseExecutionCommandEnvelopeSchema, DesiredDepthSchema } from './learningContract.js';
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
    kind: z.enum([
      'added',
      'removed',
      'reordered',
      'resized',
      'depth_changed',
      'deferred',
      'schedule_changed',
      'source_rebound',
    ]),
    planItemId: z.string().min(1).nullable(),
    curriculumLearningUnitId: z.string().min(1).nullable(),
    beforeIndex: z.number().int().nonnegative().nullable(),
    afterIndex: z.number().int().nonnegative().nullable(),
    beforeMinutes: z.number().int().nonnegative().nullable(),
    afterMinutes: z.number().int().nonnegative().nullable(),
    beforeDepth: DesiredDepthSchema.nullable().optional(),
    afterDepth: DesiredDepthSchema.nullable().optional(),
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

export const ProposeStudyPlanRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    contractId: z.string().min(1),
    expectedContractVersion: z.number().int().positive(),
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
    curriculumId: z.string().min(1),
    expectedCurriculumVersion: z.number().int().positive(),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
    predecessorStudyPlanId: z.string().min(1).nullable(),
    expectedAcceptedStudyPlanId: z.string().min(1).nullable(),
    proposalTrigger: z.string().min(1).max(500),
  })
  .strict();
export type ProposeStudyPlanRequest = z.infer<typeof ProposeStudyPlanRequestSchema>;

export const StudyPlanDraftEditSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('add_unit'),
        curriculumLearningUnitId: z.string().min(1),
        afterPlanItemId: z.string().min(1).nullable(),
        estimatedMinutes: z.number().int().positive(),
        targetDepth: DesiredDepthSchema,
        reason: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        kind: z.literal('remove_with_reason'),
        planItemId: z.string().min(1),
        reason: z.string().min(1).max(500),
        riskIds: z.array(z.string().min(1)).min(1).max(20),
      })
      .strict(),
    z
      .object({
        kind: z.literal('reorder'),
        planItemId: z.string().min(1),
        afterPlanItemId: z.string().min(1).nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('resize_time'),
        planItemId: z.string().min(1),
        estimatedMinutes: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        kind: z.literal('change_depth'),
        planItemId: z.string().min(1),
        targetDepth: DesiredDepthSchema,
        reason: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        kind: z.literal('defer'),
        curriculumLearningUnitId: z.string().min(1),
        objectiveIds: z.array(z.string().min(1)).max(30),
        reason: z.string().min(1).max(500),
        riskIds: z.array(z.string().min(1)).min(1).max(20),
      })
      .strict(),
    z
      .object({
        kind: z.literal('restore_deferral'),
        curriculumLearningUnitId: z.string().min(1),
        afterPlanItemId: z.string().min(1).nullable(),
      })
      .strict(),
  ])
  .superRefine((edit, ctx) => {
    if (edit.kind === 'reorder' && edit.afterPlanItemId === edit.planItemId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['afterPlanItemId'],
        message: 'a Plan item cannot be ordered after itself',
      });
    }
  });
export type StudyPlanDraftEdit = z.infer<typeof StudyPlanDraftEditSchema>;

export const ApplyStudyPlanDraftEditRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    studyPlanId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    expectedContractId: z.string().min(1),
    expectedCurriculumId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
    edit: StudyPlanDraftEditSchema,
  })
  .strict();
export type ApplyStudyPlanDraftEditRequest = z.infer<typeof ApplyStudyPlanDraftEditRequestSchema>;

export const DecideStudyPlanRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    studyPlanId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    expectedContractId: z.string().min(1),
    expectedCurriculumId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
    decision: z.enum(['accept', 'reject']),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.command.actor !== 'learner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'only the learner may accept or reject a StudyPlan',
      });
    }
    if (request.decision === 'reject' && !request.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Plan rejection requires a reason',
      });
    }
  });
export type DecideStudyPlanRequest = z.infer<typeof DecideStudyPlanRequestSchema>;

export const StudyPlanHistoryItemSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    status: StudyPlanStatusSchema,
    proposalTrigger: z.string().min(1).max(500),
    itemCount: z.number().int().nonnegative(),
    deferredUnitCount: z.number().int().nonnegative(),
    projectedMinutes: z.number().int().nonnegative(),
    feasibilityState: StudyPlanFeasibilitySchema.shape.state,
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    learnerAcceptedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StudyPlanHistoryItem = z.infer<typeof StudyPlanHistoryItemSchema>;

export const StudyPlanPreflightSchema = z
  .object({
    curriculumVersionId: z.string().min(1),
    totalLearningUnitCount: z.number().int().nonnegative(),
    executableLearningUnitCount: z.number().int().nonnegative(),
    nonExecutableLearningUnitCount: z.number().int().nonnegative(),
    planningRepresentationCount: z.number().int().nonnegative(),
    deferredOrUnplannableCount: z.number().int().nonnegative(),
    allowedItemKindCounts: z
      .array(
        z
          .object({
            kind: z.union([StudyPlanItemKindSchema, z.literal('none')]),
            learningUnitCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
    promptStrategy: z.enum(['detailed_units', 'grouped_units', 'blocked']),
    planningInputCharacters: z.number().int().nonnegative(),
    providerPromptCharacters: z.number().int().nonnegative().nullable(),
    approximatePromptTokens: z.number().int().nonnegative().nullable(),
    canGenerate: z.boolean(),
    blockers: z
      .array(
        z
          .object({
            code: z.enum(['no_launchable_learning_unit', 'unlaunchable_unit_deferral_forbidden']),
            message: z.string().min(1).max(500),
            affectedLearningUnitCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .superRefine((preflight, ctx) => {
    if (
      preflight.executableLearningUnitCount + preflight.nonExecutableLearningUnitCount !==
      preflight.totalLearningUnitCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executableLearningUnitCount'],
        message: 'executable and non-executable counts must account for every LearningUnit',
      });
    }
    if (preflight.canGenerate === preflight.blockers.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canGenerate'],
        message: 'canGenerate must be false exactly when a launchability blocker exists',
      });
    }
  });
export type StudyPlanPreflight = z.infer<typeof StudyPlanPreflightSchema>;

export const StudyPlanHistoryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    acceptedStudyPlanId: z.string().min(1).nullable(),
    proposedStudyPlanId: z.string().min(1).nullable(),
    items: z.array(StudyPlanHistoryItemSchema).max(500),
  })
  .strict();
export type StudyPlanHistoryResponse = z.infer<typeof StudyPlanHistoryResponseSchema>;

export const StudyPlanProposalResponseSchema = z
  .object({
    studyPlan: StudyPlanSchema,
    retainedAcceptedStudyPlanId: z.string().min(1).nullable(),
    knownScopeAccounted: z.boolean(),
    launchabilityValid: z.boolean(),
    validationErrors: z.array(z.string().min(1).max(500)).max(100),
    validationWarnings: z.array(z.string().min(1).max(500)).max(100),
  })
  .strict();
export type StudyPlanProposalResponse = z.infer<typeof StudyPlanProposalResponseSchema>;
