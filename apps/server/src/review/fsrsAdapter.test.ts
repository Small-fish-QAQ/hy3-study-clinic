import { describe, expect, it } from 'vitest';
import type { ScheduledMemoryScheduleState } from '@hy3-clinic/shared';
import { DEFAULT_CONFIGURATION, scheduleWithFsrs, replayFsrs } from './fsrsAdapter.js';
describe('Study Clinic FSRS-6 adapter', () => {
  const at = new Date('2026-01-01T09:00:00.000Z');
  it('freezes the production policy', () => {
    expect(DEFAULT_CONFIGURATION).toMatchObject({
      algorithmGeneration: 'FSRS-6',
      packageName: 'ts-fsrs',
      packageVersion: '5.4.1',
      requestedRetention: 0.9,
      fuzz: false,
      shortTerm: false,
      maximumDueHorizonDays: 365,
    });
  });
  it('maps Good and Again without short-term states', () => {
    const good = scheduleWithFsrs({ state: null, outcome: 'Good', reviewTime: at });
    const again = scheduleWithFsrs({ state: null, outcome: 'Again', reviewTime: at });
    expect(good.state.lifecycleState).toBe('review');
    expect(again.state.lifecycleState).toBe('review');
    expect(good.state.scheduledDays).toBeGreaterThan(0);
    expect(again.state.scheduledDays).toBeGreaterThan(0);
  });
  it('enforces the local 365-day ceiling after library scheduling', () => {
    const state: ScheduledMemoryScheduleState = {
      reviewTargetId: 't',
      policyVersion: DEFAULT_CONFIGURATION.version,
      lifecycleState: 'review',
      dueAt: '2026-01-02T09:00:00.000Z',
      lastReviewedAt: '2026-01-01T09:00:00.000Z',
      stability: 36500,
      difficulty: 1,
      scheduledDays: 36500,
      repetitions: 4,
      lapses: 0,
      lastReviewEventId: null,
      rowVersion: 1,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    const result = scheduleWithFsrs({ state, outcome: 'Good', reviewTime: at });
    expect(new Date(result.state.dueAt).getTime()).toBeLessThanOrEqual(
      at.getTime() + 365 * 86400000,
    );
    expect(result.state.scheduledDays).toBeLessThanOrEqual(365);
  });
  it('replays an exact epoch deterministically', () => {
    const events = [
      { outcome: 'Good' as const, occurredAt: at.toISOString() },
      { outcome: 'Again' as const, occurredAt: '2026-01-05T09:00:00.000Z' },
      { outcome: 'Good' as const, occurredAt: '2026-01-05T09:20:00.000Z' },
    ];
    expect(replayFsrs(events)).toEqual(replayFsrs(events));
  });
});
