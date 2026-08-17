import { describe, expect, it } from 'vitest';
import {
  CoursePreparationBlockerSchema,
  CoursePreparationCheckpointsSchema,
  CoursePreparationFailureSchema,
  CoursePreparationResponseSchema,
  CoursePreparationSchema,
  RunCoursePreparationRequestSchema,
} from './coursePreparation.js';

const T0 = '2026-08-17T12:00:00.000Z';

const checkpoints = {
  materials: 'complete' as const,
  concepts: 'pending' as const,
  courseStructure: 'pending' as const,
  coursePlan: 'pending' as const,
};

const preparation = {
  workspaceId: 'ws_1',
  revision: 'prep_rev_1',
  operationKey: null,
  state: 'not_started' as const,
  machineAction: null,
  learnerAction: 'confirm_learning_goal' as const,
  learnerDecisionRequired: false,
  canResume: false,
  canCancel: false,
  checkpoints,
  blocker: null,
  failure: null,
  generatedAt: T0,
};

const resumablePreparation = {
  ...preparation,
  operationKey: 'course-preparation:ws_1:prep_rev_1:prepare_concepts',
  state: 'preparing_concepts' as const,
  machineAction: 'prepare_concepts' as const,
  learnerAction: 'resume_preparation' as const,
  canResume: true,
  canCancel: true,
};

const command = {
  commandId: 'cmd_1',
  idempotencyKey: 'idem_1',
  workspaceId: 'ws_1',
  actor: 'learner' as const,
};

describe('CoursePreparationSchema', () => {
  it('accepts coherent idle and resumable projections', () => {
    expect(CoursePreparationSchema.parse(preparation)).toEqual(preparation);
    expect(CoursePreparationSchema.parse(resumablePreparation)).toEqual(resumablePreparation);
  });

  it.each([
    {
      name: 'resumable without a machine action',
      value: { ...resumablePreparation, machineAction: null },
      path: 'canResume',
    },
    {
      name: 'machine action present while not resumable',
      value: { ...preparation, machineAction: 'prepare_concepts' as const },
      path: 'canResume',
    },
    {
      name: 'resumable without an operation key',
      value: { ...resumablePreparation, operationKey: null },
      path: 'operationKey',
    },
    {
      name: 'operation key present while not resumable',
      value: { ...preparation, operationKey: 'course-preparation:ws_1:prep_rev_1' },
      path: 'operationKey',
    },
  ])('rejects $name', ({ value, path }) => {
    const result = CoursePreparationSchema.safeParse(value);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === path)).toBe(true);
    }
  });

  it.each(['reconfirm_learning_goal', 'review_course_structure', 'review_course_plan'] as const)(
    'requires learnerDecisionRequired for %s',
    (learnerAction) => {
      expect(
        CoursePreparationSchema.safeParse({
          ...preparation,
          learnerAction,
          learnerDecisionRequired: false,
        }).success,
      ).toBe(false);
      expect(
        CoursePreparationSchema.safeParse({
          ...preparation,
          learnerAction,
          learnerDecisionRequired: true,
        }).success,
      ).toBe(true);
    },
  );

  it.each(['confirm_learning_goal', 'resume_preparation', 'continue_study', 'none'] as const)(
    'forbids learnerDecisionRequired for %s',
    (learnerAction) => {
      expect(
        CoursePreparationSchema.safeParse({
          ...preparation,
          learnerAction,
          learnerDecisionRequired: true,
        }).success,
      ).toBe(false);
    },
  );

  it('allows cancellation only for active machine-owned preparation', () => {
    expect(CoursePreparationSchema.safeParse({ ...preparation, canCancel: true }).success).toBe(
      false,
    );
    expect(
      CoursePreparationSchema.safeParse({
        ...resumablePreparation,
        state: 'blocked',
        canCancel: true,
      }).success,
    ).toBe(false);
    expect(CoursePreparationSchema.safeParse(resumablePreparation).success).toBe(true);
  });

  it('requires recoverable failure details exactly in recoverable failure state', () => {
    const failure = {
      code: 'PROVIDER_TIMEOUT' as const,
      action: 'prepare_concepts' as const,
      occurredAt: T0,
      retryable: true as const,
    };
    expect(
      CoursePreparationSchema.safeParse({
        ...resumablePreparation,
        state: 'failed_recoverable',
        canCancel: false,
        failure,
      }).success,
    ).toBe(true);
    expect(
      CoursePreparationSchema.safeParse({
        ...resumablePreparation,
        state: 'failed_recoverable',
        canCancel: false,
      }).success,
    ).toBe(false);
    expect(CoursePreparationSchema.safeParse({ ...resumablePreparation, failure }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields on the projection and its nested objects', () => {
    expect(
      CoursePreparationSchema.safeParse({ ...preparation, internalState: 'hidden' }).success,
    ).toBe(false);
    expect(
      CoursePreparationSchema.safeParse({
        ...preparation,
        checkpoints: { ...checkpoints, graph: 'pending' },
      }).success,
    ).toBe(false);
    expect(
      CoursePreparationSchema.safeParse({
        ...preparation,
        blocker: {
          code: 'material_not_ready',
          message: 'Material is still processing.',
          internalId: 'op_1',
        },
      }).success,
    ).toBe(false);
    expect(
      CoursePreparationSchema.safeParse({
        ...preparation,
        failure: {
          code: 'PROVIDER_ERROR',
          action: 'prepare_concepts',
          occurredAt: T0,
          retryable: true,
          rawProviderError: 'hidden',
        },
      }).success,
    ).toBe(false);
  });

  it('enforces identifiers, bounded learner-safe text, and timestamps', () => {
    expect(CoursePreparationSchema.safeParse({ ...preparation, workspaceId: '' }).success).toBe(
      false,
    );
    expect(
      CoursePreparationSchema.safeParse({ ...preparation, revision: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(
      CoursePreparationSchema.safeParse({ ...preparation, generatedAt: 'not-a-date' }).success,
    ).toBe(false);
    expect(
      CoursePreparationBlockerSchema.safeParse({
        code: 'preparation_failed',
        message: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe('Course Preparation nested contracts', () => {
  it('keeps checkpoints strict and limited to controlled states', () => {
    expect(CoursePreparationCheckpointsSchema.safeParse(checkpoints).success).toBe(true);
    expect(
      CoursePreparationCheckpointsSchema.safeParse({
        ...checkpoints,
        concepts: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      CoursePreparationCheckpointsSchema.safeParse({ ...checkpoints, extra: 'pending' }).success,
    ).toBe(false);
  });

  it('accepts only retryable, structured failures with controlled actions', () => {
    const failure = {
      code: 'PROVIDER_TIMEOUT' as const,
      action: 'prepare_course_plan' as const,
      occurredAt: T0,
      retryable: true as const,
    };

    expect(CoursePreparationFailureSchema.safeParse(failure).success).toBe(true);
    expect(CoursePreparationFailureSchema.safeParse({ ...failure, retryable: false }).success).toBe(
      false,
    );
    expect(
      CoursePreparationFailureSchema.safeParse({ ...failure, action: 'accept_course_plan' })
        .success,
    ).toBe(false);
    expect(
      CoursePreparationFailureSchema.safeParse({ ...failure, occurredAt: 'yesterday' }).success,
    ).toBe(false);
    expect(
      CoursePreparationFailureSchema.safeParse({ ...failure, providerPayload: {} }).success,
    ).toBe(false);
  });
});

describe('Course Preparation API contracts', () => {
  it('keeps the response envelope strict', () => {
    expect(CoursePreparationResponseSchema.safeParse({ preparation }).success).toBe(true);
    expect(
      CoursePreparationResponseSchema.safeParse({ preparation, operationId: 'internal' }).success,
    ).toBe(false);
  });

  it('accepts learner commands and rejects local authority', () => {
    const request = { command, expectedRevision: preparation.revision };

    expect(RunCoursePreparationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      RunCoursePreparationRequestSchema.safeParse({
        ...request,
        command: { ...command, actor: 'local' },
      }).success,
    ).toBe(false);
  });

  it('keeps the request and command envelopes strict', () => {
    const request = { command, expectedRevision: preparation.revision };

    expect(RunCoursePreparationRequestSchema.safeParse({ ...request, force: true }).success).toBe(
      false,
    );
    expect(
      RunCoursePreparationRequestSchema.safeParse({
        ...request,
        command: { ...command, bypassGovernance: true },
      }).success,
    ).toBe(false);
    expect(
      RunCoursePreparationRequestSchema.safeParse({ ...request, expectedRevision: '' }).success,
    ).toBe(false);
    expect(
      RunCoursePreparationRequestSchema.safeParse({
        ...request,
        expectedRevision: 'x'.repeat(101),
      }).success,
    ).toBe(false);
  });
});
