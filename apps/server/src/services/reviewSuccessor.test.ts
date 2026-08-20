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

  it('persists exact Again then Good order while advancing one execution fence', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const targetId = `review-target:${workspaceId}:objective-1`;
    const execution = service.beginExecution({ targetId, workspaceId, courseId: workspaceId });
    expect(() =>
      service.recordFreshSuccess({
        targetId,
        sourceOutcomeId: 'good-before-again',
        executionId: execution.id,
      }),
    ).toThrow(/Again/);
    service.recordDueFailure({ targetId, sourceOutcomeId: 'failure-1', executionId: execution.id });
    const good = service.recordFreshSuccess({
      targetId,
      sourceOutcomeId: 'good-1',
      executionId: execution.id,
    });
    expect(good.rating).toBe('Good');
    expect(ctx.repos.reviewSuccessor.listEvents(targetId).map((event) => event.rating)).toEqual([
      'Good',
      'Again',
      'Good',
    ]);
    expect(ctx.repos.reviewSuccessor.getExecution(execution.id)).toMatchObject({
      status: 'completed',
      consumedRowVersion: 4,
    });
    expect(
      service.recordFreshSuccess({
        targetId,
        sourceOutcomeId: 'good-1',
        executionId: execution.id,
      }),
    ).toEqual(good);
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(3);
  });

  it('rolls back event and state together when either successor write fails', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const targetId = `review-target:${workspaceId}:objective-1`;
    const execution = service.beginExecution({ targetId, workspaceId, courseId: workspaceId });
    const before = ctx.repos.reviewSuccessor.getState(targetId)!;

    ctx.db.exec(`
      CREATE TRIGGER inject_memory_state_failure
      BEFORE UPDATE ON memory_schedule_states
      BEGIN SELECT RAISE(ABORT, 'injected memory state failure'); END;
    `);
    expect(() =>
      service.recordDueFailure({
        targetId,
        sourceOutcomeId: 'failure-state-trigger',
        executionId: execution.id,
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
      service.recordDueFailure({
        targetId,
        sourceOutcomeId: 'failure-event-trigger',
        executionId: execution.id,
      }),
    ).toThrow(/injected review event failure/);
    expect(ctx.repos.reviewSuccessor.getState(targetId)).toEqual(before);
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(1);
    ctx.db.exec('DROP TRIGGER inject_review_event_failure');

    service.recordDueFailure({
      targetId,
      sourceOutcomeId: 'failure-event-trigger',
      executionId: execution.id,
    });
    service.recordDueFailure({
      targetId,
      sourceOutcomeId: 'failure-event-trigger',
      executionId: execution.id,
    });
    expect(ctx.repos.reviewSuccessor.listEvents(targetId)).toHaveLength(2);
    expect(ctx.repos.reviewSuccessor.getState(targetId)?.rowVersion).toBe(3);
  });

  it('blocks Good after a failed Again, then retries to exact Again then Good', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const targetId = `review-target:${workspaceId}:objective-1`;
    const execution = service.beginExecution({ targetId, workspaceId, courseId: workspaceId });
    ctx.db.exec(`
      CREATE TRIGGER inject_again_failure
      BEFORE INSERT ON successor_review_events
      WHEN NEW.kind = 'retrieval_failure'
      BEGIN SELECT RAISE(ABORT, 'injected Again failure'); END;
    `);
    expect(() =>
      service.recordDueFailure({ targetId, sourceOutcomeId: 'again-1', executionId: execution.id }),
    ).toThrow(/injected Again failure/);
    expect(() =>
      service.recordFreshSuccess({
        targetId,
        sourceOutcomeId: 'good-1',
        executionId: execution.id,
      }),
    ).toThrow(/Again/);
    ctx.db.exec('DROP TRIGGER inject_again_failure');

    service.recordDueFailure({ targetId, sourceOutcomeId: 'again-1', executionId: execution.id });
    service.recordFreshSuccess({ targetId, sourceOutcomeId: 'good-1', executionId: execution.id });
    expect(
      ctx.repos.reviewSuccessor
        .listEvents(targetId)
        .filter((event) => event.reviewExecutionId === execution.id)
        .map((event) => event.rating),
    ).toEqual(['Again', 'Good']);
  });
});
