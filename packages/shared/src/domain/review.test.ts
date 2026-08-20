import { describe, expect, it } from 'vitest';
import { CurrentReviewItemSchema } from './review.js';

const currentReviewItem = {
  reviewTargetId: 'review_target_1',
  workspaceId: 'workspace_1',
  courseId: 'workspace_1',
  learningUnitId: 'unit_1',
  objectiveId: 'objective_1',
  objectiveTitle: '解释工作记忆容量',
  conceptIds: ['concept_1'],
  targetStatus: 'active',
  lifecycleState: 'review',
  dueAt: '2026-08-21T08:00:00.000Z',
  lastReviewedAt: '2026-08-20T08:00:00.000Z',
  stability: 3,
  difficulty: 5,
  scheduledDays: 2,
  repetitions: 1,
  lapses: 0,
  policyVersion: 'fsrs-6-default-v1',
  createdAt: '2026-08-20T08:00:00.000Z',
  updatedAt: '2026-08-21T08:00:00.000Z',
};

describe('current Review workflow projection', () => {
  it('defaults older projections to a scheduled workflow without a retry', () => {
    expect(CurrentReviewItemSchema.parse(currentReviewItem)).toMatchObject({
      workflowPhase: 'scheduled',
      schedulingRetryRequired: false,
    });
  });

  it('accepts learner workflow phases and rejects unknown states', () => {
    expect(
      CurrentReviewItemSchema.parse({
        ...currentReviewItem,
        workflowPhase: 'scheduling_retry',
        schedulingRetryRequired: true,
      }),
    ).toMatchObject({ workflowPhase: 'scheduling_retry', schedulingRetryRequired: true });

    expect(() =>
      CurrentReviewItemSchema.parse({ ...currentReviewItem, workflowPhase: 'mastered' }),
    ).toThrow();
  });
});
