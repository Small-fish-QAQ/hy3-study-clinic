import type { Answer, Question, QuestionType, RubricPoint } from '@hy3-clinic/shared';
import { clamp01, roundTo, SHORT_ANSWER_PASS } from '@hy3-clinic/shared';

/** Default point weights per question type (deterministic, documented). */
export const POINTS_BY_TYPE: Record<QuestionType, number> = {
  single_choice: 1,
  multiple_choice: 2,
  short_answer: 2,
  concept_comparison: 3,
};

/**
 * A short-answer answer counts as "correct" at or above this score.
 * Defined in @hy3-clinic/shared (the results UI derives status badges from
 * the same threshold); re-exported here for the server-side scoring code.
 */
export { SHORT_ANSWER_PASS };
/** Grades below this confidence are flagged for human review. */
export const REVIEW_CONFIDENCE = 0.6;
/** Credit a partially covered required point earns (documented, tested). */
export const PARTIAL_CREDIT = 0.5;

export interface ObjectiveOutcome {
  correct: boolean;
  normalizedScore: number;
  awardedPoints: number;
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Deterministically grade an objective (single/multiple choice) question.
 *
 * - single_choice: correct iff the one selected option equals the key.
 * - multiple_choice: EXACT set match — every correct option selected and no
 *   incorrect option selected. This is fully deterministic and easy to
 *   explain to learners; partial credit is intentionally not awarded.
 */
export function gradeObjective(question: Question, answer: Answer): ObjectiveOutcome {
  if (question.type === 'short_answer') {
    throw new Error('gradeObjective called on a short_answer question');
  }
  const correctIds = question.correctOptionIds ?? [];
  const selected = answer.selectedOptionIds ?? [];
  const correct = sortedEqual(correctIds, selected);
  const normalizedScore = correct ? 1 : 0;
  return {
    correct,
    normalizedScore,
    awardedPoints: roundTo(question.points * normalizedScore),
  };
}

/** Map a model rubric score in [0,1] to awarded points for a short answer. */
export function shortAnswerPoints(question: Question, score: number): number {
  return roundTo(question.points * clamp01(score));
}

export interface RequiredCoverageOutcome {
  /** Deterministic score: (full + PARTIAL_CREDIT × partial) / required. */
  score: number;
  requiredCount: number;
  fullyCovered: number;
  partiallyCovered: number;
}

/**
 * Deterministically score a short answer from the coverage of REQUIRED
 * rubric points only. Optional (enrichment) points never enter the
 * numerator or denominator, so their absence cannot reduce the score.
 * Indexes outside the rubric are ignored; an index in both lists counts as
 * fully covered. RubricSchema guarantees at least one required point.
 */
export function requiredCoverageScore(
  keyPoints: readonly RubricPoint[],
  matchedIndexes: readonly number[],
  partialIndexes: readonly number[] = [],
): RequiredCoverageOutcome {
  const matched = new Set(matchedIndexes.filter((i) => i >= 0 && i < keyPoints.length));
  const partial = new Set(
    partialIndexes.filter((i) => i >= 0 && i < keyPoints.length && !matched.has(i)),
  );
  let requiredCount = 0;
  let fullyCovered = 0;
  let partiallyCovered = 0;
  keyPoints.forEach((point, i) => {
    if (!point.required) return;
    requiredCount++;
    if (matched.has(i)) fullyCovered++;
    else if (partial.has(i)) partiallyCovered++;
  });
  const score =
    requiredCount === 0
      ? 0
      : clamp01((fullyCovered + PARTIAL_CREDIT * partiallyCovered) / requiredCount);
  return { score, requiredCount, fullyCovered, partiallyCovered };
}

export interface Totals {
  totalAwarded: number;
  totalPossible: number;
  overallScore: number;
}

/** Deterministically total per-question awards into an overall score. */
export function computeTotals(grades: Array<{ awardedPoints: number; maxPoints: number }>): Totals {
  const totalAwarded = roundTo(grades.reduce((sum, g) => sum + g.awardedPoints, 0));
  const totalPossible = roundTo(grades.reduce((sum, g) => sum + g.maxPoints, 0));
  const overallScore = totalPossible === 0 ? 0 : roundTo(clamp01(totalAwarded / totalPossible));
  return { totalAwarded, totalPossible, overallScore };
}
