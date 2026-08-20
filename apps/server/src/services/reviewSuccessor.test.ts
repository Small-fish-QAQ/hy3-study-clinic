import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../testing/testApp.js';
import { createReviewSuccessorService } from './reviewSuccessor.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from '../testing/fixtures.js';

function fixture() {
  const ctx = buildTestApp();
  const service = createReviewSuccessorService({ repos: ctx.repos, clock: fixedClock(T0) });
  const workspaceId = ctx.repos.workspaces.list()[0]!.id;
  return { ctx, service, workspaceId };
}

const targetInput = (workspaceId: string) => ({
  workspaceId,
  courseId: workspaceId,
  learningUnitId: 'unit-1',
  objectiveId: 'objective-1',
  contractVersionId: 'contract-1',
  curriculumVersionId: 'curriculum-1',
  manifestFingerprint: 'manifest-1',
});

describe('objective review successor', () => {
  it('creates one target and returns the same idempotent activation event', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    const first = service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const second = service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    expect(first?.id).toBeTruthy();
    expect(second).toEqual(first);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM review_targets').get()).toEqual({ n: 1 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get()).toEqual({
      n: 1,
    });
  });

  it('rolls back event, state, and execution together when a successor write fails', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    const activation = service.activate({
      ...input,
      sourceOutcomeId: 'evidence-1',
      eligible: true,
    })!;
    const targetId = `review-target:${workspaceId}:objective-1`;
    const before = ctx.repos.reviewSuccessor.getState(targetId)!;
    const execution = ctx.repos.reviewSuccessor.insertExecution({
      id: 'execution-1',
      reviewTargetId: targetId,
      bindingVersion: 1,
      consumedRowVersion: before.rowVersion,
      workspaceId,
      courseId: workspaceId,
      agendaId: null,
      assessmentVersionId: null,
      attemptId: null,
      status: 'active',
      failureReason: null,
      createdAt: T0,
      updatedAt: T0,
    });
    const next = {
      ...before,
      lastReviewEventId: 'failure-event',
      rowVersion: before.rowVersion + 1,
      updatedAt: T0,
    };
    const event = {
      ...activation,
      id: 'failure-event',
      kind: 'retrieval_failure' as const,
      sequence: activation.sequence + 1,
      sourceOutcomeId: 'failure-grade',
      reviewExecutionId: execution.id,
      rating: 'Again' as const,
      preState: before,
      postState: next,
      idempotencyKey: `${targetId}:failure-grade:${activation.policyVersion}`,
    };

    ctx.db.exec(`
      CREATE TRIGGER inject_memory_state_failure
      BEFORE UPDATE ON memory_schedule_states
      BEGIN SELECT RAISE(ABORT, 'injected memory state failure'); END;
    `);
    expect(() =>
      ctx.repos.reviewSuccessor.commitEventAndState(event, next, before.rowVersion, {
        id: execution.id,
        expectedConsumedRowVersion: execution.consumedRowVersion,
        nextConsumedRowVersion: next.rowVersion,
        status: 'active',
        updatedAt: T0,
      }),
    ).toThrow(/injected memory state failure/);
    expect(ctx.repos.reviewSuccessor.getState(targetId)).toEqual(before);
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(1);
    expect(ctx.repos.reviewSuccessor.getExecution(execution.id)).toEqual(execution);
    ctx.db.exec('DROP TRIGGER inject_memory_state_failure');

    ctx.db.exec(`
      CREATE TRIGGER inject_review_event_failure
      BEFORE INSERT ON successor_review_events
      BEGIN SELECT RAISE(ABORT, 'injected review event failure'); END;
    `);
    expect(() =>
      ctx.repos.reviewSuccessor.commitEventAndState(event, next, before.rowVersion, {
        id: execution.id,
        expectedConsumedRowVersion: execution.consumedRowVersion,
        nextConsumedRowVersion: next.rowVersion,
        status: 'active',
        updatedAt: T0,
      }),
    ).toThrow(/injected review event failure/);
    expect(ctx.repos.reviewSuccessor.getState(targetId)).toEqual(before);
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(1);
    expect(ctx.repos.reviewSuccessor.getExecution(execution.id)).toEqual(execution);
    ctx.db.exec('DROP TRIGGER inject_review_event_failure');

    ctx.repos.reviewSuccessor.commitEventAndState(event, next, before.rowVersion, {
      id: execution.id,
      expectedConsumedRowVersion: execution.consumedRowVersion,
      nextConsumedRowVersion: next.rowVersion,
      status: 'active',
      updatedAt: T0,
    });
    expect(ctx.repos.reviewSuccessor.getState(targetId)).toEqual(next);
    expect(ctx.repos.reviewSuccessor.getExecution(execution.id)).toMatchObject({
      consumedRowVersion: next.rowVersion,
    });
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(2);
  });
});
