import { REVIEW_SCHEDULER_VERSION, roundTo, type ReviewRating } from '@hy3-clinic/shared';

/**
 * Compact local FSRS-inspired review scheduler.
 *
 * Chosen over adding a third-party dependency deliberately: the state model
 * (stability/difficulty), the rating set, and the update rules follow the
 * FSRS family closely enough to migrate later, while staying ~100 lines of
 * fully-tested deterministic local code with zero supply-chain surface.
 * Everything here is a pure function of (state, rating, now) — the service
 * layer owns persistence and the "only graded events update the scheduler"
 * rule; nothing here reads or writes mastery.
 *
 * Model (all constants explicit and covered by tests):
 * - stability S: days until retrievability decays to ~90%;
 * - difficulty D ∈ [1, 10]: dampens stability growth for hard items;
 * - first rating seeds S and D; later ratings grow or collapse S:
 *     again → S' = max(MIN_S, S × LAPSE_FACTOR), D' = D + 1  (lapse)
 *     hard  → S' = S × growth × HARD_BRAKE,     D' = D + 0.3
 *     good  → S' = S × growth,                  D' = D − 0.2
 *     easy  → S' = S × growth × EASY_BOOST,     D' = D − 0.5
 *   with growth = 1 + GROWTH_K × (11 − D) ≥ MIN_GROWTH;
 * - next due = review time + S' days (interval = S', capped).
 */

export interface SchedulerState {
  stability: number;
  difficulty: number;
}

export interface ScheduledReview {
  stability: number;
  difficulty: number;
  intervalDays: number;
  dueAt: string;
  isLapse: boolean;
}

const MIN_STABILITY = 0.25;
const MAX_INTERVAL_DAYS = 365;
const LAPSE_FACTOR = 0.3;
const HARD_BRAKE = 0.6;
const EASY_BOOST = 1.4;
const GROWTH_K = 0.18;
const MIN_GROWTH = 1.05;

/** Initial state seeded by the first rating of a concept. */
const FIRST_STATE: Record<ReviewRating, SchedulerState> = {
  again: { stability: 0.5, difficulty: 7.5 },
  hard: { stability: 1, difficulty: 6.5 },
  good: { stability: 3, difficulty: 5 },
  easy: { stability: 7, difficulty: 3.5 },
};

const DIFFICULTY_DELTA: Record<ReviewRating, number> = {
  again: 1,
  hard: 0.3,
  good: -0.2,
  easy: -0.5,
};

export const SCHEDULER_VERSION = REVIEW_SCHEDULER_VERSION;

function clampDifficulty(value: number): number {
  return Math.min(10, Math.max(1, roundTo(value, 2)));
}

function clampStability(value: number): number {
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_STABILITY, roundTo(value, 2)));
}

function dueDate(now: Date, intervalDays: number): string {
  return new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
}

export class InvalidRatingError extends Error {
  constructor(rating: string) {
    super(`无效的复习评级:${rating}`);
    this.name = 'InvalidRatingError';
  }
}

function assertRating(rating: ReviewRating): void {
  if (!(rating in FIRST_STATE)) throw new InvalidRatingError(String(rating));
}

/** Schedule the FIRST review of a concept. */
export function scheduleFirst(rating: ReviewRating, now: Date): ScheduledReview {
  assertRating(rating);
  const seed = FIRST_STATE[rating];
  const stability = clampStability(seed.stability);
  return {
    stability,
    difficulty: clampDifficulty(seed.difficulty),
    intervalDays: stability,
    dueAt: dueDate(now, stability),
    isLapse: rating === 'again',
  };
}

/** Advance existing scheduler state with a new graded rating. */
export function scheduleNext(
  state: SchedulerState,
  rating: ReviewRating,
  now: Date,
): ScheduledReview {
  assertRating(rating);
  const difficulty = clampDifficulty(state.difficulty + DIFFICULTY_DELTA[rating]);

  let stability: number;
  if (rating === 'again') {
    stability = clampStability(state.stability * LAPSE_FACTOR);
  } else {
    const growth = Math.max(MIN_GROWTH, 1 + GROWTH_K * (11 - difficulty));
    const factor = rating === 'hard' ? HARD_BRAKE : rating === 'easy' ? EASY_BOOST : 1;
    stability = clampStability(state.stability * growth * factor);
    // A successful review never shortens the memory horizon.
    stability = clampStability(Math.max(stability, state.stability * MIN_GROWTH));
  }

  return {
    stability,
    difficulty,
    intervalDays: stability,
    dueAt: dueDate(now, stability),
    isLapse: rating === 'again',
  };
}

/** Days overdue relative to `now` (0 when not yet due). */
export function overdueDays(dueAt: string, now: Date): number {
  const diff = now.getTime() - new Date(dueAt).getTime();
  return diff <= 0 ? 0 : roundTo(diff / (24 * 60 * 60 * 1000), 2);
}
