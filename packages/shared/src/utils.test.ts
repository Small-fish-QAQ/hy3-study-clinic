import { describe, expect, it } from 'vitest';
import { clamp01, fnv1a32, roundTo } from './utils.js';

describe('clamp01', () => {
  it('clamps values below 0 to 0', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('clamps values above 1 to 1', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });

  it('keeps in-range values unchanged', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
  });

  it('maps NaN to 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('fnv1a32', () => {
  it('is deterministic for identical input', () => {
    expect(fnv1a32('学习资料')).toBe(fnv1a32('学习资料'));
  });

  it('differs for different input', () => {
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
  });

  it('matches known FNV-1a vectors', () => {
    // Well-known FNV-1a 32-bit test vectors.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = fnv1a32('任意中文内容,包括标点。');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('roundTo', () => {
  it('rounds to 4 decimals by default', () => {
    expect(roundTo(0.123456)).toBe(0.1235);
  });

  it('supports custom precision', () => {
    expect(roundTo(0.129, 2)).toBe(0.13);
  });
});
