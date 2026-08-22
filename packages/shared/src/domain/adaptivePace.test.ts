import { describe, expect, it } from 'vitest';
import {
  estimateAdaptivePace,
  PaceObservationSchema,
  RecordPaceObservationRequestSchema,
  type PaceObservation,
} from './adaptivePace.js';

const observation = (
  id: string,
  plannedMinutes: number,
  actualMinutes: number,
): PaceObservation => ({
  id,
  planItemId: `item_${id}`,
  plannedMinutes,
  actualMinutes,
  source: 'study_session',
  measuredAt: `2026-08-${10 + Number(id)}T00:00:00.000Z`,
  activeTimeMeasured: true,
});

describe('adaptive pace estimate', () => {
  it('stays unknown and cannot trigger a replan with insufficient evidence', () => {
    const result = estimateAdaptivePace([observation('1', 20, 40)], 100);
    expect(result).toMatchObject({
      confidence: 'unknown',
      meaningfulEvidence: false,
      shouldReplan: false,
    });
  });

  it('uses measured active time, bounds the adjustment, and predicts remaining effort', () => {
    const result = estimateAdaptivePace([observation('1', 30, 60), observation('2', 30, 60)], 120);
    expect(result).toMatchObject({
      adjustment: 2,
      confidence: 'low',
      remainingMinutes: 240,
      shouldReplan: true,
    });
  });

  it('does not let a fast learner trigger structural replanning for a small fluctuation', () => {
    const result = estimateAdaptivePace([observation('1', 30, 24), observation('2', 30, 24)], 120);
    expect(result.shouldReplan).toBe(false);
    expect(result.remainingMinutes).toBe(96);
  });

  it('requires an explicit active-time observation at the API boundary', () => {
    expect(
      PaceObservationSchema.safeParse({ ...observation('1', 20, 20), activeTimeMeasured: false })
        .success,
    ).toBe(false);
    expect(
      RecordPaceObservationRequestSchema.safeParse({
        command: {
          commandId: 'cmd_1',
          idempotencyKey: 'key_1',
          workspaceId: 'ws_1',
          actor: 'learner',
        },
        studyPlanId: 'plan_1',
        planItemId: 'item_1',
        plannedMinutes: 20,
        actualMinutes: 20,
        source: 'study_session',
      }).success,
    ).toBe(true);
  });
});
