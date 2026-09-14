/** Identity comparison must preserve symbols and case: they carry meaning in
 * quantities, formulas, vectors and code. Semantic equivalence needs review. */
export function literalTeachingText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** A value occurring among the givens is not proof that the task is solved.
 * Reject explicit answer announcements and full verbal answer disclosures;
 * leave case-dependent inference and paraphrases to independent review. */
export function disclosesPracticeAnswer(prompt: string, answer: string): boolean {
  const text = literalTeachingText(prompt);
  const key = literalTeachingText(answer)
    .replace(/[.!。！]+$/u, '')
    .trim();
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const boundary = '(?![\\p{L}\\p{N}_]|\\.[\\p{L}\\p{N}_])';
  const announcement = new RegExp(
    `(?:正确答案(?:是|为)?|答案(?:是|为)|the (?:correct )?answer is)\\s*[:：]?\\s*${escaped}${boundary}`,
    'iu',
  );
  if (announcement.test(text)) return true;
  // Atomic answers (numbers, signs, identifiers, single words) are frequently
  // legitimate inputs or subjects of a question, including explain/prove tasks.
  if (!/\s/u.test(key) && !/\p{Script=Han}{2}/u.test(key)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}${boundary}`, 'u').test(text);
}
