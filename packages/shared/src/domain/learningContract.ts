import { z } from 'zod';
import { MaterialRoleSchema } from './material.js';

export const LearningContractStatusSchema = z.enum([
  'draft',
  'proposed',
  'learner_confirmed',
  'active',
  'closed',
  'superseded',
  'withdrawn',
]);
export type LearningContractStatus = z.infer<typeof LearningContractStatusSchema>;

export const DesiredDepthSchema = z.enum([
  'pass_oriented',
  'working_fluency',
  'high_performance',
  'deep_transfer',
]);
export type DesiredDepth = z.infer<typeof DesiredDepthSchema>;

export const ContractTargetOutcomeSchema = z
  .object({
    description: z.string().min(1).max(500),
    targetScore: z.number().min(0).max(100).nullable(),
    credential: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type ContractTargetOutcome = z.infer<typeof ContractTargetOutcomeSchema>;

export const ContractDeadlineSchema = z
  .object({
    at: z.string().datetime(),
    timeZone: z.string().min(1).max(100),
    /** New Contracts treat a deadline as a target unless explicitly hard. */
    hard: z.boolean().optional(),
  })
  .strict();
export type ContractDeadline = z.infer<typeof ContractDeadlineSchema>;

export const ContractUnavailablePeriodSchema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    reason: z.string().min(1).max(300).nullable(),
  })
  .strict()
  .refine((period) => Date.parse(period.endsAt) > Date.parse(period.startsAt), {
    path: ['endsAt'],
    message: 'unavailable period must end after it starts',
  });

export const ContractStudyBudgetSchema = z
  .object({
    minutesPerDay: z.number().int().positive().nullable(),
    minutesPerWeek: z.number().int().positive().nullable(),
    preferredSessionMinutes: z.number().int().positive().nullable(),
    unavailablePeriods: z.array(ContractUnavailablePeriodSchema).max(100),
    /** `estimate` is a planning preference; `hard_cap` is learner-enforced. */
    availabilityPolicy: z.enum(['estimate', 'hard_cap']).optional(),
  })
  .strict();
export type ContractStudyBudget = z.infer<typeof ContractStudyBudgetSchema>;

/** Stable learner-level scope. Revision IDs are intentionally rejected. */
export const ContractMaterialScopeSchema = z
  .object({
    materialId: z.string().min(1),
    materialRoleAssignmentId: z.string().min(1),
    materialRoleAssignmentVersion: z.number().int().positive(),
    role: MaterialRoleSchema,
    disposition: z.enum(['included', 'excluded']),
  })
  .strict();
export type ContractMaterialScope = z.infer<typeof ContractMaterialScopeSchema>;

export const ContractCourseScopeSchema = z
  .object({
    subjectBoundaries: z.array(z.string().min(1).max(300)).min(1).max(50),
    materials: z.array(ContractMaterialScopeSchema).max(100),
    includedTopics: z.array(z.string().min(1).max(300)).max(100),
    excludedTopics: z.array(z.string().min(1).max(300)).max(100),
  })
  .strict();
export type ContractCourseScope = z.infer<typeof ContractCourseScopeSchema>;

export const LearnerSelfReportSchema = z
  .object({
    priorStudy: z.string().max(1000).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    strengths: z.array(z.string().min(1).max(300)).max(30),
    knownGaps: z.array(z.string().min(1).max(300)).max(30),
  })
  .strict();

export const ContractExamContextSchema = z
  .object({
    examAt: z.string().datetime().nullable(),
    intendedScope: z.array(z.string().min(1).max(300)).max(100),
    /** Stable logical Materials only; exact revisions belong downstream. */
    materialIds: z.array(z.string().min(1)).max(50),
    format: z.string().max(500).nullable(),
    constraints: z.array(z.string().min(1).max(300)).max(30),
  })
  .strict();

export const ContractRiskToleranceSchema = z
  .object({
    description: z.string().max(500).nullable(),
    allowExplicitDeferral: z.boolean(),
    maximumUnresolvedPriority: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  })
  .strict();

export const LearningContractSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    intent: z.string().min(1).max(500),
    targetOutcome: ContractTargetOutcomeSchema,
    deadline: ContractDeadlineSchema.nullable(),
    studyBudget: ContractStudyBudgetSchema,
    desiredDepth: DesiredDepthSchema,
    courseScope: ContractCourseScopeSchema,
    learnerSelfReport: LearnerSelfReportSchema.nullable(),
    examContext: ContractExamContextSchema.nullable(),
    riskTolerance: ContractRiskToleranceSchema.nullable(),
    status: LearningContractStatusSchema,
    proposedBy: z.enum(['learner', 'local', 'model']),
    learnerConfirmedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (
      (contract.status === 'learner_confirmed' || contract.status === 'active') &&
      !contract.learnerConfirmedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learnerConfirmedAt'],
        message: 'a confirmed or active Contract requires learner confirmation',
      });
    }
  });
export type LearningContract = z.infer<typeof LearningContractSchema>;

export const LearningContractScopeIssueKindSchema = z.enum([
  'material_missing',
  'material_retired',
  'material_moved',
  'role_confirmation_missing',
  'material_role_changed',
]);
export type LearningContractScopeIssueKind = z.infer<typeof LearningContractScopeIssueKindSchema>;

/**
 * Learner-scope freshness is intentionally limited to stable Material identity
 * and learner-confirmed role. Revision-bound execution state is owned downstream.
 */
export const LearningContractScopeReadinessSchema = z
  .object({
    state: z.enum(['current', 'reconfirmation_required']),
    issues: z
      .array(
        z
          .object({
            kind: LearningContractScopeIssueKindSchema,
            materialId: z.string().min(1),
            contractedRole: MaterialRoleSchema,
            currentConfirmedRole: MaterialRoleSchema.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((readiness, ctx) => {
    if (readiness.state === 'current' && readiness.issues.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'current Contract scope cannot contain freshness issues',
      });
    }
    if (readiness.state === 'reconfirmation_required' && readiness.issues.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'Contract reconfirmation requires a concrete scope issue',
      });
    }
  });
export type LearningContractScopeReadiness = z.infer<typeof LearningContractScopeReadinessSchema>;

/** Common identity for consequential Course-execution commands. */
export const CourseExecutionCommandEnvelopeSchema = z
  .object({
    commandId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
    workspaceId: z.string().min(1),
    actor: z.enum(['learner', 'local']),
  })
  .strict();
export type CourseExecutionCommandEnvelope = z.infer<typeof CourseExecutionCommandEnvelopeSchema>;

/** Editable learner intention. It contains stable Material identity only. */
export const LearningContractDraftFieldsSchema = z
  .object({
    intent: z.string().min(1).max(500),
    targetOutcome: ContractTargetOutcomeSchema,
    deadline: ContractDeadlineSchema.nullable(),
    studyBudget: ContractStudyBudgetSchema,
    desiredDepth: DesiredDepthSchema,
    courseScope: ContractCourseScopeSchema,
    learnerSelfReport: LearnerSelfReportSchema.nullable(),
    examContext: ContractExamContextSchema.nullable(),
    riskTolerance: ContractRiskToleranceSchema.nullable(),
  })
  .strict();
export type LearningContractDraftFields = z.infer<typeof LearningContractDraftFieldsSchema>;

/**
 * Compatibility request boundary for Course creation. Historical callers may still
 * supply deadline and study-budget fields; current callers omit them and local code
 * materializes neutral stored values.
 */
export const LearningContractDraftRequestFieldsSchema = LearningContractDraftFieldsSchema.extend({
  deadline: ContractDeadlineSchema.nullable().optional().default(null),
  studyBudget: ContractStudyBudgetSchema.optional().default({
    minutesPerDay: null,
    minutesPerWeek: null,
    preferredSessionMinutes: null,
    unavailablePeriods: [],
    availabilityPolicy: 'estimate',
  }),
});
export type LearningContractDraftRequestFields = z.input<
  typeof LearningContractDraftRequestFieldsSchema
>;

export const ContractFeasibilityReasonCodeSchema = z.enum([
  'deadline_absent',
  'effort_unknown',
  'budget_unknown',
  'sufficient_slack',
  'low_slack',
  'insufficient_time',
  'deadline_elapsed',
  'unavailable_periods_reduce_capacity',
  'soft_availability_estimate',
  'hard_availability_cap',
]);
export type ContractFeasibilityReasonCode = z.infer<typeof ContractFeasibilityReasonCodeSchema>;

/** Deterministic time arithmetic; null means unknown, never zero-by-default. */
export const LearningContractFeasibilitySchema = z
  .object({
    state: z.enum(['feasible', 'at_risk', 'infeasible', 'unknown']),
    deadlineAt: z.string().datetime().nullable(),
    availableMinutes: z.number().int().nonnegative().nullable(),
    projectedMinutes: z.number().int().nonnegative().nullable(),
    slackMinutes: z.number().int().nullable(),
    reasonCodes: z.array(ContractFeasibilityReasonCodeSchema).min(1).max(20),
    assumptions: z.array(z.string().min(1).max(500)).max(50),
    policyVersion: z.string().min(1).max(100),
    computedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((feasibility, ctx) => {
    if (
      feasibility.availableMinutes !== null &&
      feasibility.projectedMinutes !== null &&
      feasibility.slackMinutes !== feasibility.availableMinutes - feasibility.projectedMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slackMinutes'],
        message: 'known slack must equal available minus projected minutes',
      });
    }
    if (
      (feasibility.availableMinutes === null || feasibility.projectedMinutes === null) &&
      feasibility.slackMinutes !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slackMinutes'],
        message: 'slack must be unknown when either input is unknown',
      });
    }
  });
export type LearningContractFeasibility = z.infer<typeof LearningContractFeasibilitySchema>;

export const CreateLearningContractDraftRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    fields: LearningContractDraftRequestFieldsSchema,
    predecessorContractId: z.string().min(1).nullable(),
    expectedActiveContractId: z.string().min(1).nullable(),
  })
  .strict();
export type CreateLearningContractDraftRequest = z.input<
  typeof CreateLearningContractDraftRequestSchema
>;

export const UpdateLearningContractDraftRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    contractId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    fields: LearningContractDraftRequestFieldsSchema,
  })
  .strict();
export type UpdateLearningContractDraftRequest = z.input<
  typeof UpdateLearningContractDraftRequestSchema
>;

export const TransitionLearningContractRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    contractId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    transition: z.enum(['propose', 'confirm', 'withdraw']),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.transition === 'confirm' && request.command.actor !== 'learner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'only the learner may confirm a Learning Contract',
      });
    }
  });
export type TransitionLearningContractRequest = z.infer<
  typeof TransitionLearningContractRequestSchema
>;

export const LearningContractDetailResponseSchema = z
  .object({
    contract: LearningContractSchema,
    feasibility: LearningContractFeasibilitySchema,
  })
  .strict();
export type LearningContractDetailResponse = z.infer<typeof LearningContractDetailResponseSchema>;

export const LearningContractHistoryItemSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    status: LearningContractStatusSchema,
    intent: z.string().min(1).max(500),
    targetDescription: z.string().min(1).max(500),
    deadlineAt: z.string().datetime().nullable(),
    desiredDepth: DesiredDepthSchema,
    learnerConfirmedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type LearningContractHistoryItem = z.infer<typeof LearningContractHistoryItemSchema>;

export const LearningContractHistoryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    activeContractId: z.string().min(1).nullable(),
    pendingContractId: z.string().min(1).nullable(),
    items: z.array(LearningContractHistoryItemSchema).max(500),
  })
  .strict();
export type LearningContractHistoryResponse = z.infer<typeof LearningContractHistoryResponseSchema>;
