import type { CourseLessonContent } from './course.js';

/** Only explicit learner tasks, never interrogative prose or a worked demonstration. */
export function lessonReflectionPrompt(segment: CourseLessonContent['segments'][number]) {
  if (segment.kind === 'optional_prompt') return { prompt: segment.text, introduction: '' };
  // Already published V2 Lessons occasionally put an explicitly optional task at
  // the end of a worked example. Keep its frozen text and expose that intent.
  const marker = /作为练习性的思考[（(]可选[）)]：/u.exec(segment.text);
  if (!marker) return null;
  return {
    introduction: segment.text.slice(0, marker.index).trim(),
    prompt: segment.text.slice(marker.index + marker[0].length).trim(),
  };
}

/** Matches the safe StudyText renderer's text surface for server quote validation. */
export function normalizeLessonSelection(text: string) {
  return text
    .replace(/\*\*([^*]+)\*\*|`([^`]+)`/gu, '$1$2')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/^```[^\n]*\n?|```$/gmu, '')
    .replace(/\|/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
