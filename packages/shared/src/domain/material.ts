import { z } from 'zod';

/**
 * Question types supported by the clinic. `concept_comparison` asks the
 * learner to compare/contrast two aligned concepts in free text; it is fully
 * wired end-to-end (generation, rubric grading, persistence, display, tests)
 * and shares the short-answer answering/grading pipeline.
 */
export const QuestionTypeSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'short_answer',
  'concept_comparison',
]);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

/** Question types answered as free text and graded via the semantic rubric. */
export const TEXT_ANSWER_TYPES: readonly QuestionType[] = ['short_answer', 'concept_comparison'];

export function isTextAnswerType(type: QuestionType): boolean {
  return TEXT_ANSWER_TYPES.includes(type);
}

/** Quiz difficulty levels. */
export const DifficultySchema = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof DifficultySchema>;

/** How a document was imported. */
export const SourceTypeSchema = z.enum(['paste', 'md', 'txt', 'pdf', 'docx']);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** Media types accepted for document ingestion. */
export const MediaTypeSchema = z.enum([
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

/**
 * Parsing outcome for a persisted document. Parsing failures are NEVER
 * persisted as empty documents — a failed parse rejects the whole import,
 * so persisted statuses only distinguish clean parses from parses that
 * produced visible extraction warnings.
 */
export const ParseStatusSchema = z.enum(['parsed', 'parsed_with_warnings']);
export type ParseStatus = z.infer<typeof ParseStatusSchema>;

/** Concept importance, as judged by the analysis step. */
export const ImportanceSchema = z.enum(['high', 'medium', 'low']);
export type Importance = z.infer<typeof ImportanceSchema>;

/**
 * Grounding as PROPOSED by a model (or the fake provider):
 * a reference to a source block plus an exact quote from it.
 *
 * Models are never trusted with character offsets — the server verifies the
 * quote against the original text and computes offsets itself.
 */
export const ProposedGroundingSchema = z.object({
  blockId: z.string().min(1),
  quote: z.string().min(1).max(2000),
});
export type ProposedGrounding = z.infer<typeof ProposedGroundingSchema>;

/**
 * Grounding after server-side verification. Offsets are UTF-16 code unit
 * indices into the source block's `content`, computed deterministically by
 * the server (never taken from a model).
 */
export const VerifiedGroundingSchema = z.object({
  blockId: z.string().min(1),
  quote: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  /** How many times the quote occurs in the block (1 = unambiguous). */
  occurrenceCount: z.number().int().positive(),
  /**
   * True when the quote was not found in the block the model named, but was
   * found in exactly one other block and safely re-anchored there.
   */
  reanchored: z.boolean(),
});
export type VerifiedGrounding = z.infer<typeof VerifiedGroundingSchema>;

/** A contiguous, deterministic segment of the imported material. */
export const SourceBlockSchema = z.object({
  id: z.string().min(1),
  materialId: z.string().min(1),
  index: z.number().int().nonnegative(),
  /** Heading text of the section this block belongs to (null for plain text). */
  heading: z.string().nullable(),
  /** Full heading path, e.g. ["记忆的类型", "工作记忆"]. */
  headingPath: z.array(z.string()),
  /** 1-based page number for paginated sources (PDF); null otherwise. */
  pageNumber: z.number().int().positive().nullable(),
  content: z.string().min(1),
  /** Offsets into the normalized material content (UTF-16 code units). */
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
});
export type SourceBlock = z.infer<typeof SourceBlockSchema>;

/**
 * An imported study document. Every document belongs to exactly one course
 * workspace; legacy single-material records were migrated into per-material
 * compatibility workspaces.
 */
export const MaterialSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200),
  sourceType: SourceTypeSchema,
  /** Media type of the original upload (null for legacy rows before backfill). */
  mediaType: MediaTypeSchema.nullable(),
  /** Original uploaded filename, when the document came from a file. */
  originalFilename: z.string().max(255).nullable(),
  /** Normalized content (LF line endings). */
  content: z.string().min(1),
  charCount: z.number().int().positive(),
  parseStatus: ParseStatusSchema,
  /** Total pages for paginated sources (PDF); null otherwise. */
  pageCount: z.number().int().positive().nullable(),
  /** Human-readable extraction warnings produced by the parser. */
  extractionWarnings: z.array(z.string().max(500)).max(50),
  /** Version tag of the parser that produced the stored text. */
  parserVersion: z.string().max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Material = z.infer<typeof MaterialSchema>;

/** Maximum length accepted when a learner renames an existing material. */
export const MATERIAL_TITLE_MAX_LENGTH = 120;

/** Runtime contract for PATCH /api/materials/:id. */
export const UpdateMaterialTitleRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, '资料标题不能为空。')
      .max(MATERIAL_TITLE_MAX_LENGTH, `资料标题不能超过 ${MATERIAL_TITLE_MAX_LENGTH} 个字符。`),
  })
  .strict();
export type UpdateMaterialTitleRequest = z.infer<typeof UpdateMaterialTitleRequestSchema>;

/** A key concept extracted from the material, with verified grounding. */
export const ConceptSchema = z.object({
  id: z.string().min(1),
  materialId: z.string().min(1),
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(1000),
  importance: ImportanceSchema,
  grounding: VerifiedGroundingSchema,
  createdAt: z.string().datetime(),
});
export type Concept = z.infer<typeof ConceptSchema>;
