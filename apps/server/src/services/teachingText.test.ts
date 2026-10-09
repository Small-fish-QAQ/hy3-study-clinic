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
    [
      'Allowed labels: Above the limit, At the limit, Below the limit. The load is 12 and the limit is 10. Which label applies?',
      'Above the limit',
    ],
    [
      'Given the rule: It changes candidate eligibility. Which changed records now qualify?',
      'It changes candidate eligibility.',
    ],
    [
      '对任意有符号数 n：若 n > 0，正确答案是正数；若 n = 0，正确答案是零；若 n < 0，正确答案是负数。本题 n = 7 - 4，应选哪个标签？',
      '正数',
    ],
    [
      '对任意有符号数 n：若 n > 0，正确答案是正数；若 n = 0，正确答案是零；若 n < 0，正确答案是负数。本题 n = 2 - 6，应选哪个标签？',
      '负数',
    ],
    ['If n > 0, the answer is Positive. Given n = 7 - 4, which label applies?', 'Positive'],
    ['The answer is Positive if n > 0. Given n = 7 - 4, which label applies?', 'Positive'],
    ['规则示例说“正确答案是正数”。本题 n = 7 - 4，应选哪个标签？', '正数'],
  ])('does not infer disclosure from a given or substring: %s', (prompt, answer) => {
    expect(disclosesPracticeAnswer(prompt, answer)).toBe(false);
  });
  it.each([
    ['正确答案是4。请选择。', '4'],
    ['The answer is −2. Choose it.', '−2'],
    ['本题 n = 7 - 4，应选哪个标签？本题的正确答案是正数。', '正数'],
    [
      'Given n = 7 - 4, which label applies? For this question, the answer is Positive.',
      'Positive',
    ],
    [
      'The correct answer is It changes candidate eligibility.',
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
