/** Identity comparison must preserve symbols and case: they carry meaning in
 * quantities, formulas, vectors and code. Semantic equivalence needs review. */
export function literalTeachingText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Mentioning an offered label or a taught rule does not disclose a case result.
 * Only standalone answer announcements reject locally. Conditional/quoted
 * teaching and contextual disclosure belong to public integrity review. */
export function disclosesPracticeAnswer(prompt: string, answer: string): boolean {
  const text = literalTeachingText(prompt);
  const key = literalTeachingText(answer)
    .replace(/[.!。！]+$/u, '')
    .trim();
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const boundary = '(?![\\p{L}\\p{N}_]|\\.[\\p{L}\\p{N}_])';
  const currentQuestion =
    '(?:(?:本题|此题|这道题|当前问题)(?:的)?|for (?:this|the current) question)';
  const announcement = new RegExp(
    `(?:^|[.!?。！？])\\s*(?:${currentQuestion}\\s*[,，:：]?\\s*)?(?:正确答案(?:是|为)?|答案(?:是|为)|the (?:correct )?answer is)\\s*[:：]?\\s*${escaped}${boundary}(?=\\s*(?:[.!?。！？;；]|$))`,
    'iu',
  );
  return announcement.test(text);
}
