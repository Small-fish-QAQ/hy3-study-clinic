import { z } from 'zod';
import { CoverageRiskSummarySchema } from './coverageRisk.js';
import {
  CurriculumHistoryItemSchema,
  CurriculumHierarchyViewSchema,
  CurriculumSchema,
} from './curriculum.js';
import {
  CourseExecutionCommandEnvelopeSchema,
  LearningContractFeasibilitySchema,
  LearningContractHistoryItemSchema,
  LearningContractSchema,
} from './learningContract.js';
import { PublicQuizSchema } from './quiz.js';
import { StudyPlanHistoryItemSchema, StudyPlanSchema } from './studyPlan.js';

export const CourseExecutionStatusSchema = z.enum(['active', 'paused', 'stopped']);
export type CourseExecutionStatus = z.infer<typeof CourseExecutionStatusSchema>;

export const SessionAgendaStatusSchema = z.enum([
  'draft',
  'active',
  'completed',
  'paused',
  'abandoned',
]);
export type SessionAgendaStatus = z.infer<typeof SessionAgendaStatusSchema>;

export const SessionAgendaItemKindSchema = z.enum([
  'due_review',
  'targeted_repair',
  'learning_unit_teaching',
  'informal_check',
  'formal_checkpoint',
  'synthesis',
  'learner_detour',
  'prerequisite_repair',
  'stretch_challenge',
  'adversarial_readiness',
]);
export type SessionAgendaItemKind = z.infer<typeof SessionAgendaItemKindSchema>;

export const SessionAgendaItemOriginSchema = z.enum([
  'accepted_plan',
  'due_review',
  'open_repair',
  'learner_insert',
  'learner_detour',
  'completion_policy',
  'local_recomposition',
]);
export type SessionAgendaItemOrigin = z.infer<typeof SessionAgendaItemOriginSchema>;

export const SessionAgendaItemStateSchema = z.enum([
  'queued',
  'active',
  'completed',
  'deferred',
  'cancelled',
  'blocked',
]);
export type SessionAgendaItemState = z.infer<typeof SessionAgendaItemStateSchema>;

export const AgendaLaunchCapabilitySchema = z
  .object({
    status: z.enum(['launchable', 'revalidation_required', 'blocked']),
    capability: z.string().min(1).max(100),
    resourceId: z.string().min(1).nullable(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type AgendaLaunchCapability = z.infer<typeof AgendaLaunchCapabilitySchema>;

export const SessionAgendaItemSchema = z
  .object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    kind: SessionAgendaItemKindSchema,
    origin: SessionAgendaItemOriginSchema,
    reason: z.string().min(1).max(1000),
    estimatedMinutes: z.number().int().positive(),
    linkedPlanItemId: z.string().min(1).nullable(),
    learningUnitId: z.string().min(1).nullable(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    state: SessionAgendaItemStateSchema,
    launch: AgendaLaunchCapabilitySchema,
    displacedAgendaItemIds: z.array(z.string().min(1)).max(100),
    timeImpactMinutes: z.number().int(),
  })
  .strict();
export type SessionAgendaItem = z.infer<typeof SessionAgendaItemSchema>;

export const SessionAgendaSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    version: z.number().int().positive(),
    status: SessionAgendaStatusSchema,
    availableMinutes: z.number().int().positive().nullable(),
    items: z.array(SessionAgendaItemSchema).max(200),
    currentItemId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SessionAgenda = z.infer<typeof SessionAgendaSchema>;

/** Pause/resume audit without changing the accepted StudyPlan lifecycle. */
export const CourseExecutionEventSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.enum(['paused', 'resumed', 'stopped']),
    reason: z.string().min(1).max(500).nullable(),
    actor: z.literal('learner'),
    expectedStudyPlanVersionId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CourseExecutionEvent = z.infer<typeof CourseExecutionEventSchema>;

export const CourseSetupStageSchema = z.enum([
  'contract_required',
  'contract_review',
  'curriculum_required',
  'curriculum_review',
  'plan_required',
  'plan_review',
  'route_active',
  'goal_closed',
]);
export type CourseSetupStage = z.infer<typeof CourseSetupStageSchema>;

export const CourseNextActionSchema = z
  .object({
    agendaId: z.string().min(1),
    agendaVersion: z.number().int().positive(),
    item: SessionAgendaItemSchema,
    whyNext: z.string().min(1).max(1000),
  })
  .strict();
export type CourseNextAction = z.infer<typeof CourseNextActionSchema>;

export const LaunchCourseActionRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    agendaId: z.string().min(1),
    expectedAgendaVersion: z.number().int().positive(),
    agendaItemId: z.string().min(1),
    expectedContractId: z.string().min(1),
    expectedStudyPlanId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1).max(200),
  })
  .strict();
export type LaunchCourseActionRequest = z.infer<typeof LaunchCourseActionRequestSchema>;

export const CourseActionLaunchResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('assessment'),
      agendaItemId: z.string().min(1),
      quiz: PublicQuizSchema,
      assessmentKind: z.enum(['formal_checkpoint', 'due_review', 'targeted_repair']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lesson'),
      agendaItemId: z.string().min(1),
      learningUnitId: z.string().min(1),
      conceptId: z.string().min(1),
      lessonId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('blocked'),
      agendaItemId: z.string().min(1),
      reason: z.string().min(1).max(500),
      stale: z.boolean(),
      recomposedAgenda: SessionAgendaSchema.nullable(),
    })
    .strict(),
]);
export type CourseActionLaunchResult = z.infer<typeof CourseActionLaunchResultSchema>;

/** Result of the one transaction that installs the first/successor executable route. */
export const ActiveCourseRouteSchema = z
  .object({
    contract: LearningContractSchema,
    curriculum: CurriculumSchema,
    studyPlan: StudyPlanSchema,
    agenda: SessionAgendaSchema,
    activatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.contract.status !== 'active') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contract', 'status'],
        message: 'an installed route requires an active Contract',
      });
    }
    if (route.curriculum.status !== 'accepted') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['curriculum', 'status'],
        message: 'an installed route requires an accepted Curriculum',
      });
    }
    if (route.studyPlan.status !== 'accepted') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studyPlan', 'status'],
        message: 'an installed route requires an accepted StudyPlan',
      });
    }
    if (route.studyPlan.contractVersionId !== route.contract.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studyPlan', 'contractVersionId'],
        message: 'StudyPlan and active Contract versions must match',
      });
    }
    if (route.studyPlan.curriculumVersionId !== route.curriculum.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studyPlan', 'curriculumVersionId'],
        message: 'StudyPlan and accepted Curriculum versions must match',
      });
    }
    if (
      route.agenda.contractVersionId !== route.contract.id ||
      route.agenda.curriculumVersionId !== route.curriculum.id ||
      route.agenda.studyPlanVersionId !== route.studyPlan.id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agenda'],
        message: 'Agenda versions must match the installed Contract/Curriculum/StudyPlan route',
      });
    }
  });
export type ActiveCourseRoute = z.infer<typeof ActiveCourseRouteSchema>;

export const StudyPlanDecisionResponseSchema = z
  .object({
    decision: z.enum(['accepted', 'rejected']),
    decidedPlan: StudyPlanSchema,
    activeRoute: ActiveCourseRouteSchema.nullable(),
    retainedRoute: ActiveCourseRouteSchema.nullable(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.decision === 'accepted' && response.activeRoute === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeRoute'],
        message: 'acceptance must return the atomically installed active route',
      });
    }
    if (response.decision === 'rejected' && response.decidedPlan.status !== 'rejected') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decidedPlan', 'status'],
        message: 'a rejected decision must retain a rejected proposal snapshot',
      });
    }
  });
export type StudyPlanDecisionResponse = z.infer<typeof StudyPlanDecisionResponseSchema>;

export const CourseHomeCapabilitiesSchema = z
  .object({
    canEditContract: z.boolean(),
    canConfirmContract: z.boolean(),
    canProposeCurriculum: z.boolean(),
    canAcceptCurriculum: z.boolean(),
    canProposeStudyPlan: z.boolean(),
    canEditStudyPlan: z.boolean(),
    canAcceptStudyPlan: z.boolean(),
    canContinueStudy: z.boolean(),
  })
  .strict();
export type CourseHomeCapabilities = z.infer<typeof CourseHomeCapabilitiesSchema>;

/** Bounded, version-consistent read model for Course Home. */
export const CourseExecutionOverviewSchema = z
  .object({
    workspaceId: z.string().min(1),
    setupStage: CourseSetupStageSchema,
    executionStatus: CourseExecutionStatusSchema,
    activeContract: LearningContractSchema.nullable(),
    pendingContract: LearningContractSchema.nullable(),
    contractFeasibility: LearningContractFeasibilitySchema.nullable(),
    acceptedCurriculum: CurriculumSchema.nullable(),
    proposedCurriculum: CurriculumSchema.nullable(),
    curriculumHierarchy: CurriculumHierarchyViewSchema.nullable(),
    acceptedStudyPlan: StudyPlanSchema.nullable(),
    proposedStudyPlan: StudyPlanSchema.nullable(),
    activeAgenda: SessionAgendaSchema.nullable(),
    nextAction: CourseNextActionSchema.nullable(),
    riskSummary: CoverageRiskSummarySchema,
    capabilities: CourseHomeCapabilitiesSchema,
    contractHistory: z.array(LearningContractHistoryItemSchema).max(50),
    curriculumHistory: z.array(CurriculumHistoryItemSchema).max(50),
    studyPlanHistory: z.array(StudyPlanHistoryItemSchema).max(50),
    generatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((overview, ctx) => {
    if ((overview.activeContract === null) !== (overview.acceptedStudyPlan === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedStudyPlan'],
        message: 'active Contract and accepted StudyPlan must appear as one compatible pair',
      });
    }
    if (overview.activeContract && overview.acceptedStudyPlan) {
      if (overview.activeContract.status !== 'active') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['activeContract', 'status'],
          message: 'Course Home active Contract must have active status',
        });
      }
      if (overview.acceptedStudyPlan.status !== 'accepted') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptedStudyPlan', 'status'],
          message: 'Course Home accepted Plan must have accepted status',
        });
      }
      if (overview.acceptedStudyPlan.contractVersionId !== overview.activeContract.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptedStudyPlan', 'contractVersionId'],
          message: 'Course Home active Contract/Plan pair is incompatible',
        });
      }
    }
    if (overview.nextAction && !overview.activeAgenda) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextAction'],
        message: 'a next action requires an active Agenda',
      });
    }
  });
export type CourseExecutionOverview = z.infer<typeof CourseExecutionOverviewSchema>;

export const CourseExecutionOverviewResponseSchema = z
  .object({ overview: CourseExecutionOverviewSchema })
  .strict();
export type CourseExecutionOverviewResponse = z.infer<typeof CourseExecutionOverviewResponseSchema>;
