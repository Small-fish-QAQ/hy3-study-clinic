import { describe, expect, it } from 'vitest';
import { computeTotals, gradeObjective } from './score.js';
import { makeQuestion } from '../testing/fixtures.js';

describe('gradeObjective', () => {
  it('grades a correct single choice as full credit', () => {
    const q = makeQuestion();
    const outcome = gradeObjective(q, {
      questionId: q.id,
      type: 'single_choice',
      selectedOptionIds: ['A'],
    });
    expect(outcome).toEqual({ correct: true, normalizedScore: 1, awardedPoints: 1 });
  });

  it('grades a wrong single choice as zero', () => {
    const q = makeQuestion();
    const outcome = gradeObjective(q, {
      questionId: q.id,
      type: 'single_choice',
      selectedOptionIds: ['B'],
    });
    expect(outcome).toEqual({ correct: false, normalizedScore: 0, awardedPoints: 0 });
  });

  it('requires an exact set match for multiple choice (no partial credit)', () => {
    const q = makeQuestion({
      type: 'multiple_choice',
      options: [
        { id: 'A', text: '甲' },
        { id: 'B', text: '乙' },
        { id: 'C', text: '丙' },
      ],
      correctOptionIds: ['A', 'B'],
      points: 2,
    });
    expect(
      gradeObjective(q, {
        questionId: q.id,
        type: 'multiple_choice',
        selectedOptionIds: ['B', 'A'],
      }).correct,
    ).toBe(true);
    expect(
      gradeObjective(q, { questionId: q.id, type: 'multiple_choice', selectedOptionIds: ['A'] })
        .correct,
    ).toBe(false);
    expect(
      gradeObjective(q, {
        questionId: q.id,
        type: 'multiple_choice',
        selectedOptionIds: ['A', 'B', 'C'],
      }).correct,
    ).toBe(false);
  });

  it('treats an empty selection as incorrect', () => {
    const q = makeQuestion();
    expect(
      gradeObjective(q, { questionId: q.id, type: 'single_choice', selectedOptionIds: [] }).correct,
    ).toBe(false);
  });
});

describe('computeTotals', () => {
  it('sums points deterministically and normalizes the overall score', () => {
    const totals = computeTotals([
      { awardedPoints: 1, maxPoints: 1 },
      { awardedPoints: 1, maxPoints: 2 },
      { awardedPoints: 0, maxPoints: 2 },
    ]);
    expect(totals).toEqual({ totalAwarded: 2, totalPossible: 5, overallScore: 0.4 });
  });

  it('handles the empty edge case', () => {
    expect(computeTotals([])).toEqual({ totalAwarded: 0, totalPossible: 0, overallScore: 0 });
  });
});
