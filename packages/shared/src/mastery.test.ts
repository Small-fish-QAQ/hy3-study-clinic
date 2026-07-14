import { describe, expect, it } from 'vitest';
import { INITIAL_MASTERY, updateMastery, WEAK_MASTERY_THRESHOLD } from './mastery.js';

describe('updateMastery', () => {
  it('is deterministic', () => {
    expect(updateMastery(0.5, 1)).toBe(updateMastery(0.5, 1));
  });

  it('moves toward a perfect score without overshooting', () => {
    const next = updateMastery(0.5, 1);
    expect(next).toBeGreaterThan(0.5);
    expect(next).toBeLessThanOrEqual(1);
    expect(next).toBe(0.65); // 0.5 + 0.3 * (1 - 0.5)
  });

  it('moves toward zero on a failed answer', () => {
    const next = updateMastery(0.5, 0);
    expect(next).toBe(0.35); // 0.5 + 0.3 * (0 - 0.5)
  });

  it('always stays within [0, 1] even for out-of-range inputs', () => {
    expect(updateMastery(-5, -5)).toBeGreaterThanOrEqual(0);
    expect(updateMastery(5, 5)).toBeLessThanOrEqual(1);
    expect(updateMastery(0, 0)).toBe(0);
    expect(updateMastery(1, 1)).toBe(1);
  });

  it('converges monotonically toward 1 under repeated perfect scores', () => {
    let mastery = INITIAL_MASTERY;
    let previous = mastery;
    for (let i = 0; i < 20; i++) {
      mastery = updateMastery(mastery, 1);
      expect(mastery).toBeGreaterThanOrEqual(previous);
      expect(mastery).toBeLessThanOrEqual(1);
      previous = mastery;
    }
    expect(mastery).toBeGreaterThan(WEAK_MASTERY_THRESHOLD);
  });

  it('converges monotonically toward 0 under repeated zero scores', () => {
    let mastery = INITIAL_MASTERY;
    let previous = mastery;
    for (let i = 0; i < 20; i++) {
      mastery = updateMastery(mastery, 0);
      expect(mastery).toBeLessThanOrEqual(previous);
      expect(mastery).toBeGreaterThanOrEqual(0);
      previous = mastery;
    }
    expect(mastery).toBeLessThan(0.05);
  });
});
