import { describe, expect, it } from 'vitest';
import {
  InvalidRatingError,
  overdueDays,
  scheduleFirst,
  scheduleNext,
  type SchedulerState,
} from './scheduler.js';
import type { ReviewRating } from '@hy3-clinic/shared';

/** Fixed clock instant for every test (no wall-clock dependence). */
const NOW = new Date('2026-03-01T08:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('review scheduler — first review', () => {
  it('seeds stability/difficulty per rating and schedules the due date', () => {
    const good = scheduleFirst('good', NOW);
    expect(good.stability).toBe(3);
    expect(good.intervalDays).toBe(3);
    expect(good.dueAt).toBe(new Date(NOW.getTime() + 3 * DAY_MS).toISOString());
    expect(good.isLapse).toBe(false);

    const again = scheduleFirst('again', NOW);
    expect(again.stability).toBeLessThan(good.stability);
    expect(again.isLapse).toBe(true);

    const easy = scheduleFirst('easy', NOW);
    expect(easy.stability).toBeGreaterThan(good.stability);
    expect(easy.difficulty).toBeLessThan(good.difficulty);
  });

  it('is deterministic: identical inputs produce identical output', () => {
    expect(scheduleFirst('hard', NOW)).toEqual(scheduleFirst('hard', NOW));
  });
});

describe('review scheduler — subsequent reviews', () => {
  const state: SchedulerState = { stability: 3, difficulty: 5 };

  it('grows stability on success and never shrinks it', () => {
    const good = scheduleNext(state, 'good', NOW);
    expect(good.stability).toBeGreaterThan(state.stability);
    const hard = scheduleNext(state, 'hard', NOW);
    expect(hard.stability).toBeGreaterThanOrEqual(state.stability * 1.05);
    const easy = scheduleNext(state, 'easy', NOW);
    expect(easy.stability).toBeGreaterThan(good.stability);
  });

  it('collapses stability on a lapse and raises difficulty', () => {
    const lapse = scheduleNext({ stability: 20, difficulty: 5 }, 'again', NOW);
    expect(lapse.isLapse).toBe(true);
    expect(lapse.stability).toBeLessThan(20);
    expect(lapse.difficulty).toBeGreaterThan(5);
  });

  it('repeated success grows the interval monotonically', () => {
    let current: SchedulerState = { stability: 1, difficulty: 5 };
    let previousInterval = 0;
    for (let i = 0; i < 6; i++) {
      const next = scheduleNext(current, 'good', NOW);
      expect(next.intervalDays).toBeGreaterThan(previousInterval);
      previousInterval = next.intervalDays;
      current = { stability: next.stability, difficulty: next.difficulty };
    }
  });

  it('keeps difficulty clamped to [1, 10] and stability capped at one year', () => {
    const floor = scheduleNext({ stability: 300, difficulty: 1 }, 'easy', NOW);
    expect(floor.difficulty).toBeGreaterThanOrEqual(1);
    expect(floor.stability).toBeLessThanOrEqual(365);
    const ceil = scheduleNext({ stability: 0.5, difficulty: 10 }, 'again', NOW);
    expect(ceil.difficulty).toBeLessThanOrEqual(10);
    expect(ceil.stability).toBeGreaterThan(0);
  });

  it('rejects invalid ratings explicitly', () => {
    expect(() => scheduleNext(state, 'perfect' as ReviewRating, NOW)).toThrow(InvalidRatingError);
    expect(() => scheduleFirst('nope' as ReviewRating, NOW)).toThrow(InvalidRatingError);
  });
});

describe('overdueDays', () => {
  it('returns 0 before the due date and fractional days after it', () => {
    expect(overdueDays(new Date(NOW.getTime() + DAY_MS).toISOString(), NOW)).toBe(0);
    expect(overdueDays(NOW.toISOString(), NOW)).toBe(0);
    expect(overdueDays(new Date(NOW.getTime() - 36 * 60 * 60 * 1000).toISOString(), NOW)).toBe(1.5);
  });

  it('handles day boundaries across timezones via pure UTC arithmetic', () => {
    // 23:30 UTC on day N vs 00:30 UTC on day N+1 is exactly one hour
    // (values are rounded to 2 decimals by design).
    const due = '2026-03-01T23:30:00.000Z';
    const later = new Date('2026-03-02T00:30:00.000Z');
    expect(overdueDays(due, later)).toBeCloseTo(1 / 24, 2);
  });
});
