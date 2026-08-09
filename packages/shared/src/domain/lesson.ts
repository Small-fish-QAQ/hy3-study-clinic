import { z } from 'zod';
import { VerifiedGroundingSchema } from './material.js';

/**
 * Concept lesson cards — the teaching-enrichment layer.
 *
 * A lesson TEACHES a concept the course material established. Its content is
 * organized as typed sections of small segments, and provenance is decided
 * DETERMINISTICALLY at segment granularity:
 *
 * - a segment whose `anchor` passed exact-quote verification is
 *   course-source-backed (课程资料 / 本地已验证);
 * - a segment without a verified anchor is AI teaching
 *   (AI 辅助讲解,非资料原文) — the model may use its own knowledge to explain
 *   a course-confirmed concept, and that is labeled, never hidden.
 *
 * The model can never self-certify provenance: anchors it proposes are
 * verified server-side and dropped when they fail, which reclassifies the
 * segment as AI teaching. Lessons are display-layer teaching material only —
 * they are never grading truth, never rubric evidence, and never mutate
 * learner state.
 */

/** Controlled lesson-section kinds (no free-form chat). */
export const LessonSectionKindSchema = z.enum([
  'explanation',
  'intuition',
  'worked_example',
  'misconception_warning',
  'contrast',
  'application',
]);
export type LessonSectionKind = z.infer<typeof LessonSectionKindSchema>;

/** Bounds (tested): sections per lesson, segments per section, text length. */
export const MAX_LESSON_SECTIONS = 6;
export const MAX_LESSON_SEGMENTS = 10;
export const MAX_LESSON_SEGMENT_CHARS = 600;
/** Conflicts retained per lesson (each requires a verified source quote). */
export const MAX_LESSON_CONFLICTS = 3;

/** One lesson segment with server-decided provenance. */
export const LessonSegmentSchema = z.object({
  text: z.string().min(1).max(MAX_LESSON_SEGMENT_CHARS),
  /** Present ONLY when the segment's anchor passed exact-quote verification. */
  anchor: VerifiedGroundingSchema.optional(),
});
export type LessonSegment = z.infer<typeof LessonSegmentSchema>;

export const LessonSectionSchema = z.object({
  kind: LessonSectionKindSchema,
  segments: z.array(LessonSegmentSchema).min(1).max(MAX_LESSON_SEGMENTS),
});
export type LessonSection = z.infer<typeof LessonSectionSchema>;

export const ConceptLessonContentSchema = z.object({
  sections: z.array(LessonSectionSchema).min(1).max(MAX_LESSON_SECTIONS),
});
export type ConceptLessonContent = z.infer<typeof ConceptLessonContentSchema>;

/**
 * A place where the course material differs from the common presentation of
 * the concept. The claim is model text; the source quote is verified. For
 * course questions and grading, the source always wins.
 */
export const LessonConflictSchema = z.object({
  claim: z.string().min(1).max(300),
  sourceQuote: VerifiedGroundingSchema,
});
export type LessonConflict = z.infer<typeof LessonConflictSchema>;

/** One persisted lesson per concept (current version only, no history). */
export const ConceptLessonSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conceptId: z.string().min(1),
  content: ConceptLessonContentSchema,
  conflicts: z.array(LessonConflictSchema).max(MAX_LESSON_CONFLICTS),
  provider: z.string().min(1).max(40),
  providerModel: z.string().max(120).nullable(),
  promptVersion: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConceptLesson = z.infer<typeof ConceptLessonSchema>;

/** Fixed single-turn regeneration directives (not free-form chat). */
export const LessonDirectiveSchema = z.enum(['more_intuitive', 'more_examples', 'deeper']);
export type LessonDirective = z.infer<typeof LessonDirectiveSchema>;

/** Runtime contract for POST …/concepts/:conceptId/lesson. */
export const GenerateLessonRequestSchema = z
  .object({ directive: LessonDirectiveSchema.optional() })
  .strict();
export type GenerateLessonRequest = z.infer<typeof GenerateLessonRequestSchema>;
