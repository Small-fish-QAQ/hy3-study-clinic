import { z } from 'zod';
import { ApiErrorCodeSchema } from './errors.js';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';

export const CoursePreparationStateSchema = z.enum([
  'not_started',
  'preparing_materials',
  'preparing_concepts',
  'preparing_course_structure',
  'validating_course_plan',
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
  })
  .strict();
export type CoursePreparationCheckpoints = z.infer<typeof CoursePreparationCheckpointsSchema>;

export const CoursePreparationBlockerCodeSchema = z.enum([
  'learning_goal_required',
  'learning_scope_changed',
  'material_not_ready',
  'course_structure_review_required',
  'course_structure_not_executable',
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
    retryable: z.literal(true),
  })
  .strict();
export type CoursePreparationFailure = z.infer<typeof CoursePreparationFailureSchema>;

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
        ].includes(preparation.state))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canCancel'],
        message: 'only active machine-owned preparation can be cancelled',
      });
    }
    if ((preparation.failure !== null) !== (preparation.state === 'failed_recoverable')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'recoverable failure state and failure details disagree',
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
