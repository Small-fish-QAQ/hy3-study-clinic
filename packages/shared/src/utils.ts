/**
 * Clamp a number into the inclusive range [0, 1].
 * Used for mastery scores and normalized grading scores.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Deterministic 32-bit FNV-1a hash of a string.
 * Used to derive stable, reproducible "seeds" from source content so the
 * fake provider produces identical output for identical input.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit.
  return hash >>> 0;
}

/**
 * Round a number to a fixed number of decimal places (default 4).
 * Keeps persisted scores stable across platforms.
 */
export function roundTo(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
