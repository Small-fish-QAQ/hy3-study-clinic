import { clamp01, roundTo } from './utils.js';

/**
 * Deterministic mastery model (no LLM involvement).
 *
 * Each concept starts at INITIAL_MASTERY (0.5, "unknown"). Every graded
 * question about the concept produces a normalized score in [0, 1], and
 * mastery moves toward that score by a fixed fraction ALPHA (exponential
 * moving average):
 *
 *   mastery_new = clamp01(mastery_old + ALPHA * (score - mastery_old))
 *
 * Properties (covered by tests):
 * - output always stays inside [0, 1];
 * - repeated perfect scores converge monotonically toward 1;
 * - repeated zero scores converge monotonically toward 0;
 * - the update is deterministic: same inputs, same output.
 */
export const INITIAL_MASTERY = 0.5;
export const MASTERY_ALPHA = 0.3;
/** Concepts below this mastery (or with open mistakes) count as "weak". */
export const WEAK_MASTERY_THRESHOLD = 0.7;

export function updateMastery(previousMastery: number, score: number): number {
  const prev = clamp01(previousMastery);
  const s = clamp01(score);
  return roundTo(clamp01(prev + MASTERY_ALPHA * (s - prev)));
}
