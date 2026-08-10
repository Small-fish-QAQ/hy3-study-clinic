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
  })
  .strict()
  .refine((budget) => budget.minutesPerDay !== null || budget.minutesPerWeek !== null, {
    message: 'study budget requires daily or weekly available minutes',
  });
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
