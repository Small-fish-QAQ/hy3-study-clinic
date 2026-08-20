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
  workspaceId, courseId: workspaceId, learningUnitId: 'unit-1', objectiveId: 'objective-1',
  contractVersionId: 'contract-1', curriculumVersionId: 'curriculum-1', manifestFingerprint: 'manifest-1',
});

describe('objective review successor', () => {
  it('creates one target and idempotent activation event', () => {
    const { ctx, service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    const first = service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const second = service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    expect(first?.id).toBeTruthy();
    expect(second).toBeNull();
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM review_targets').get()).toEqual({ n: 1 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get()).toEqual({ n: 1 });
  });

  it('requires Again before fresh Good and fences stale executions', () => {
    const { service, workspaceId } = fixture();
    const input = targetInput(workspaceId);
    service.activate({ ...input, sourceOutcomeId: 'evidence-1', eligible: true });
    const targetId = `review-target:${workspaceId}:objective-1`;
    const execution = service.beginExecution({ targetId, workspaceId, courseId: workspaceId });
    expect(() => service.recordFreshSuccess({ targetId, sourceOutcomeId: 'good-before-again', executionId: execution.id })).toThrow(/Again/);
    service.recordDueFailure({ targetId, sourceOutcomeId: 'failure-1', executionId: execution.id });
    expect(() => service.recordFreshSuccess({ targetId, sourceOutcomeId: 'good-1', executionId: execution.id })).toThrow(/row version|inactive/);
  });
});
