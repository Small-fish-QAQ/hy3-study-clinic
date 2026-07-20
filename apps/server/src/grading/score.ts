import type { Answer, Question, QuestionType } from '@hy3-clinic/shared';
import { clamp01, roundTo } from '@hy3-clinic/shared';

/** Default point weights per question type (deterministic, documented). */
export const POINTS_BY_TYPE: Record<QuestionType, number> = {
  single_choice: 1,
  multiple_choice: 2,
  short_answer: 2,
  concept_comparison: 3,
};

/** A short-answer answer counts as "correct" at or above this score. */
export const SHORT_ANSWER_PASS = 0.6;
/** Grades below this confidence are flagged for human review. */
export const REVIEW_CONFIDENCE = 0.6;

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
