import { describe, expect, it } from 'vitest';
import { computeTotals, gradeObjective, requiredCoverageScore } from './score.js';
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

describe('requiredCoverageScore', () => {
  const points = [
    { text: '每 N 字符切', required: true },
    { text: '重叠 M', required: true },
    { text: '快但易切断语义', required: false },
  ];

  it('gives full score when all required points are covered, optional missing', () => {
    const outcome = requiredCoverageScore(points, [0, 1]);
    expect(outcome).toEqual({ score: 1, requiredCount: 2, fullyCovered: 2, partiallyCovered: 0 });
  });

  it('missing optional points never reduce the score (zero score-reducing weight)', () => {
    expect(requiredCoverageScore(points, [0, 1, 2]).score).toBe(1);
    expect(requiredCoverageScore(points, [0, 1]).score).toBe(1);
  });

  it('awards partial credit for partially covered required points', () => {
    const outcome = requiredCoverageScore(points, [0], [1]);
    expect(outcome).toEqual({
      score: 0.75,
      requiredCount: 2,
      fullyCovered: 1,
      partiallyCovered: 1,
    });
  });

  it('scores partial required coverage below full', () => {
    expect(requiredCoverageScore(points, [0]).score).toBe(0.5);
    expect(requiredCoverageScore(points, []).score).toBe(0);
  });

  it('normalizes weights over the required count only', () => {
    const many = [
      { text: 'a要点', required: true },
      { text: 'b要点', required: true },
      { text: 'c要点', required: true },
      { text: 'd补充', required: false },
      { text: 'e补充', required: false },
    ];
    expect(requiredCoverageScore(many, [0, 1]).score).toBeCloseTo(2 / 3, 10);
  });

  it('ignores out-of-range indexes and double-counted partials', () => {
    const outcome = requiredCoverageScore(points, [0, 9], [0, -1, 7]);
    expect(outcome).toEqual({
      score: 0.5,
      requiredCount: 2,
      fullyCovered: 1,
      partiallyCovered: 0,
    });
  });

  it('covering only the optional point earns nothing', () => {
    expect(requiredCoverageScore(points, [2]).score).toBe(0);
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
