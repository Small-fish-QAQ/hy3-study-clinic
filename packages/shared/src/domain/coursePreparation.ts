import { z } from 'zod';
import { ApiErrorCodeSchema } from './errors.js';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';

export const CoursePreparationStateSchema = z.enum([
  'not_started',
  'preparing_materials',
  'preparing_concepts',
  'preparing_course_structure',
  'validating_course_plan',
  'preparing_assessment_readiness',
  'course_plan_ready',
  'awaiting_required_governance',
  'failed_recoverable',
  'blocked',
  'complete',
]);
export type CoursePreparationState = z.infer<typeof CoursePreparationStateSchema>;

export const CoursePreparationMachineActionSchema = z.enum([
  'prepare_concepts',
  'prepare_course_structure',
  'accept_prepared_course_structure',
  'prepare_course_plan',
  'activate_prepared_course_plan',
  'prepare_assessment_readiness',
]);
export type CoursePreparationMachineAction = z.infer<typeof CoursePreparationMachineActionSchema>;

export const CoursePreparationLearnerActionSchema = z.enum([
  'confirm_learning_goal',
  'reconfirm_learning_goal',
  'resume_preparation',
  'review_course_structure',
  'review_course_plan',
  'continue_study',
  'none',
]);
export type CoursePreparationLearnerAction = z.infer<typeof CoursePreparationLearnerActionSchema>;

export const CoursePreparationCheckpointStateSchema = z.enum([
  'pending',
  'in_progress',
  'complete',
  'blocked',
]);
export type CoursePreparationCheckpointState = z.infer<
  typeof CoursePreparationCheckpointStateSchema
>;

export const CoursePreparationCheckpointsSchema = z
  .object({
    materials: CoursePreparationCheckpointStateSchema,
    concepts: CoursePreparationCheckpointStateSchema,
    courseStructure: CoursePreparationCheckpointStateSchema,
    coursePlan: CoursePreparationCheckpointStateSchema,
    assessmentReadiness: CoursePreparationCheckpointStateSchema.optional(),
  })
  .strict();
export type CoursePreparationCheckpoints = z.infer<typeof CoursePreparationCheckpointsSchema>;

export const CoursePreparationBlockerCodeSchema = z.enum([
  'learning_goal_required',
  'learning_scope_changed',
  'material_not_ready',
  'course_structure_review_required',
  'course_structure_not_executable',
  'course_structure_generation_failed',
  'formal_assessment_readiness_unavailable',
  'preparation_failed',
  'preparation_interrupted',
]);
export type CoursePreparationBlockerCode = z.infer<typeof CoursePreparationBlockerCodeSchema>;

export const CoursePreparationBlockerSchema = z
  .object({
    code: CoursePreparationBlockerCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export const CoursePreparationFailureSchema = z
  .object({
    code: ApiErrorCodeSchema.nullable(),
    action: CoursePreparationMachineActionSchema,
    occurredAt: z.string().datetime(),
    /** False means the failed artifact needs review/reorganization, not another identical run. */
    retryable: z.boolean(),
  })
  .strict();
export type CoursePreparationFailure = z.infer<typeof CoursePreparationFailureSchema>;

export const CourseFormalReadinessSchema = z
  .object({
    status: z.enum(['pending', 'ready', 'blocked']),
    requiredObjectiveCount: z.number().int().nonnegative(),
    readyObjectiveCount: z.number().int().nonnegative(),
    unresolvedObjectiveIds: z.array(z.string().min(1)).max(200),
    teachingOnlyObjectiveIds: z.array(z.string().min(1)).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.readyObjectiveCount > value.requiredObjectiveCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readyObjectiveCount'],
        message: 'ready objectives cannot exceed required objectives',
      });
    }
    if (value.status === 'ready' && value.unresolvedObjectiveIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedObjectiveIds'],
        message: 'ready courses cannot retain unresolved objectives',
      });
    }
    if (value.status === 'ready' && value.readyObjectiveCount !== value.requiredObjectiveCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readyObjectiveCount'],
        message: 'ready courses require every required objective to be ready',
      });
    }
    if (
      value.readyObjectiveCount + value.unresolvedObjectiveIds.length !==
      value.requiredObjectiveCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredObjectiveCount'],
        message: 'readiness counts must partition required objectives',
      });
    }
  });
export type CourseFormalReadiness = z.infer<typeof CourseFormalReadinessSchema>;

/** Learner-safe, read-only projection over current Course authority and durable operations. */
export const CoursePreparationSchema = z
  .object({
    workspaceId: z.string().min(1),
    revision: z.string().min(1).max(100),
    operationKey: z.string().min(1).max(200).nullable(),
    state: CoursePreparationStateSchema,
    machineAction: CoursePreparationMachineActionSchema.nullable(),
    learnerAction: CoursePreparationLearnerActionSchema,
    learnerDecisionRequired: z.boolean(),
    canResume: z.boolean(),
    canCancel: z.boolean(),
    checkpoints: CoursePreparationCheckpointsSchema,
    formalReadiness: CourseFormalReadinessSchema.optional(),
    blocker: CoursePreparationBlockerSchema.nullable(),
    failure: CoursePreparationFailureSchema.nullable(),
    generatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((preparation, ctx) => {
    if (preparation.canResume !== (preparation.machineAction !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canResume'],
        message: 'resumable preparation requires exactly one machine action',
      });
    }
    if (preparation.canResume !== (preparation.operationKey !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationKey'],
        message: 'resumable preparation requires a stable operation key',
      });
    }
    if (
      preparation.learnerDecisionRequired !==
      ['reconfirm_learning_goal', 'review_course_structure', 'review_course_plan'].includes(
        preparation.learnerAction,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learnerDecisionRequired'],
        message: 'learner-decision state and learner action disagree',
      });
    }
    if (
      preparation.canCancel &&
      (!preparation.canResume ||
        ![
          'preparing_materials',
          'preparing_concepts',
          'preparing_course_structure',
          'validating_course_plan',
          'preparing_assessment_readiness',
        ].includes(preparation.state))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canCancel'],
        message: 'only active machine-owned preparation can be cancelled',
      });
    }
    if (
      (preparation.failure !== null) !==
      ['failed_recoverable', 'blocked'].includes(preparation.state)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'failure state and failure details disagree',
      });
    }
  });
export type CoursePreparation = z.infer<typeof CoursePreparationSchema>;

export const CoursePreparationResponseSchema = z
  .object({ preparation: CoursePreparationSchema })
  .strict();
export type CoursePreparationResponse = z.infer<typeof CoursePreparationResponseSchema>;

export const RunCoursePreparationRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    expectedRevision: z.string().min(1).max(100),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.command.actor !== 'learner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'Course Preparation must be started or resumed by the learner',
      });
    }
  });
export type RunCoursePreparationRequest = z.infer<typeof RunCoursePreparationRequestSchema>;
