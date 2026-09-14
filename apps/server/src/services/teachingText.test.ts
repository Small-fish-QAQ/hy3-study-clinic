import { describe, expect, it } from 'vitest';
import { disclosesPracticeAnswer, literalTeachingText } from './teachingText.js';

describe('meaning-preserving teaching text checks', () => {
  it.each([
    ['(−4, 2)', '(4, −2)'],
    ['1.25', '125'],
    ['$B4', 'B$4'],
    ['x²', 'x2'],
    ['a < b', 'a > b'],
    ['item', 'Item'],
  ])('keeps distinct answers %s and %s', (a, b) => {
    expect(literalTeachingText(a)).not.toBe(literalTeachingText(b));
  });
  it('recognizes literal duplicates despite incidental whitespace', () => {
    expect(literalTeachingText('  A +\n B ')).toBe(literalTeachingText('A + B'));
  });
  it.each([
    ['A sequence has total 47. Calculate the common difference.', '4'],
    ['Given 4 + x = 8, find x.', '4'],
    ['Explain why the result is false.', 'false'],
    ['Translate the identifier Item.', 'item'],
    ['已知温度从25升到30，求温差。', '5'],
  ])('does not infer disclosure from a given or substring: %s', (prompt, answer) => {
    expect(disclosesPracticeAnswer(prompt, answer)).toBe(false);
  });
  it.each([
    ['正确答案是4。请选择。', '4'],
    ['The answer is −2. Choose it.', '−2'],
    [
      'Which explanation is correct: It changes candidate eligibility.',
      'It changes candidate eligibility.',
    ],
  ])('rejects an actual disclosed answer: %s', (prompt, answer) => {
    expect(disclosesPracticeAnswer(prompt, answer)).toBe(true);
  });
  it('does not truncate a disclosed number or identifier into another answer', () => {
    expect(disclosesPracticeAnswer('正确答案是47。', '4')).toBe(false);
    expect(disclosesPracticeAnswer('The answer is itemCount.', 'item')).toBe(false);
  });
});
