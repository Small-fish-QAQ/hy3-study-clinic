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
  /**
   * Exact immutable owner for revision-aware rows. Optional/null preserves
   * honest hydration of pre-lineage fixtures and historical snapshots.
   */
  materialRevisionId: z.string().min(1).nullable().optional(),
  index: z.number().int().nonnegative(),
  /** Heading text of the section this block belongs to (null for plain text). */
  heading: z.string().nullable(),
  /** Full heading path, e.g. ["记忆的类型", "工作记忆"]. */
  headingPath: z.array(z.string()),
  /** 1-based page the block starts on, for paginated sources (PDF); null otherwise. */
  pageNumber: z.number().int().positive().nullable(),
  /**
   * 1-based page the block ends on. Equal to `pageNumber` for single-page
   * blocks, greater when a block spans pages. Null for non-paginated sources
   * and for legacy rows persisted before page-range provenance existed
   * (legacy PDF blocks were page-bounded, so null never hides a real span).
   */
  pageEnd: z.number().int().positive().nullable().default(null),
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
  /** Active extraction pointer; optional for legacy fixtures and snapshots. */
  activeRevisionId: z.string().min(1).nullable().optional(),
  /** Retirement is recoverable history, distinct from destructive purge. */
  availability: z.enum(['active', 'retired']).optional(),
  retiredAt: z.string().datetime().nullable().optional(),
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

/** Learner-meaningful role of one stable logical Material in a Course. */
export const MaterialRoleSchema = z.enum([
  'course_material',
  'supplementary_reference',
  'past_exam',
  'exercise_sheet',
  'question_set',
]);
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;

/** Honest migration sentinels; accepted Contract scope still uses MaterialRoleSchema. */
export const StoredMaterialRoleSchema = z.enum([
  ...MaterialRoleSchema.options,
  'excluded',
  'unknown',
]);
export type StoredMaterialRole = z.infer<typeof StoredMaterialRoleSchema>;

/**
 * Role assignments are versioned independently from extraction revisions.
 * Confirming a role grants scope authority only; it never validates claims,
 * answers, or rubrics contained in the Material.
 */
export const MaterialRoleAssignmentStatusSchema = z.enum([
  'proposed',
  'learner_confirmed',
  'superseded',
  'withdrawn',
]);
export type MaterialRoleAssignmentStatus = z.infer<typeof MaterialRoleAssignmentStatusSchema>;

export const MaterialRoleAssignmentSchema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    role: StoredMaterialRoleSchema,
    status: MaterialRoleAssignmentStatusSchema,
    proposedBy: z.enum(['learner', 'local', 'model']),
    learnerConfirmedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (assignment.status === 'learner_confirmed' && !assignment.learnerConfirmedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learnerConfirmedAt'],
        message: 'a learner-confirmed material role requires confirmation time',
      });
    }
    if (
      assignment.status === 'learner_confirmed' &&
      (assignment.role === 'unknown' || assignment.role === 'excluded')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'learner-confirmed scope requires a learner-meaningful material role',
      });
    }
  });
export type MaterialRoleAssignment = z.infer<typeof MaterialRoleAssignmentSchema>;

/** Immutable extraction revision lifecycle; active selection is a local pointer. */
export const MaterialRevisionStatusSchema = z.enum([
  'candidate',
  'ready',
  'active',
  'superseded',
  'retired',
  'failed',
]);
export type MaterialRevisionStatus = z.infer<typeof MaterialRevisionStatusSchema>;

export const MaterialRevisionSchema = z
  .object({
    id: z.string().min(1),
    /** Stable logical identity; this is the ID used by Learning Contract scope. */
    materialId: z.string().min(1),
    revision: z.number().int().positive(),
    predecessorRevisionId: z.string().min(1).nullable(),
    status: MaterialRevisionStatusSchema,
    sourceType: SourceTypeSchema,
    mediaType: MediaTypeSchema.nullable(),
    originalFilename: z.string().max(255).nullable(),
    normalizedContent: z.string().min(1).nullable(),
    charCount: z.number().int().nonnegative().nullable(),
    parseStatus: ParseStatusSchema.nullable(),
    pageCount: z.number().int().positive().nullable(),
    extractionWarnings: z.array(z.string().max(500)).max(50),
    parserVersion: z.string().max(80).nullable(),
    /** Null for honest legacy revisions whose parser/extraction identity is unknown. */
    parserFingerprint: z.string().min(1).max(200).nullable(),
    sourceFingerprint: z.string().min(1).max(200).nullable(),
    originalAssetFingerprint: z.string().min(1).max(200).nullable(),
    createdAt: z.string().datetime(),
    activatedAt: z.string().datetime().nullable(),
    retiredAt: z.string().datetime().nullable(),
    failureCode: z.string().min(1).max(100).nullable(),
    failureMessage: z.string().min(1).max(1000).nullable(),
  })
  .strict()
  .superRefine((revision, ctx) => {
    if (revision.status === 'active' && (!revision.normalizedContent || !revision.parseStatus)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an active material revision requires validated normalized content',
      });
    }
    if (revision.status === 'failed' && !revision.failureMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureMessage'],
        message: 'a failed material revision requires a failure message',
      });
    }
  });
export type MaterialRevision = z.infer<typeof MaterialRevisionSchema>;

export const ParserAttemptStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
  'outcome_unknown',
]);
export type ParserAttemptStatus = z.infer<typeof ParserAttemptStatusSchema>;

export const MaterialParserAttemptSchema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1),
    candidateRevisionId: z.string().min(1).nullable(),
    status: ParserAttemptStatusSchema,
    parserVersion: z.string().max(80).nullable(),
    parserFingerprint: z.string().min(1).max(200).nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    errorMessage: z.string().min(1).max(1000).nullable(),
  })
  .strict();
export type MaterialParserAttempt = z.infer<typeof MaterialParserAttemptSchema>;

/** Normalized source structure owned by one exact MaterialRevision. */
export const StructuralUnitKindSchema = z.enum([
  'document',
  'chapter',
  'section',
  'paragraph',
  'page',
  'table',
  'formula',
  'figure',
  'other',
]);
export type StructuralUnitKind = z.infer<typeof StructuralUnitKindSchema>;

export const NormalizedStructuralUnitSchema = z
  .object({
    id: z.string().min(1),
    materialRevisionId: z.string().min(1),
    parentUnitId: z.string().min(1).nullable(),
    kind: StructuralUnitKindSchema,
    index: z.number().int().nonnegative(),
    title: z.string().min(1).max(300).nullable(),
    content: z.string(),
    sourceLocator: z.string().min(1).max(500).nullable(),
    derivation: z.enum(['source_text', 'parser_derived', 'ocr_derived']),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type NormalizedStructuralUnit = z.infer<typeof NormalizedStructuralUnitSchema>;

/** SourceBlock-compatible projection with immutable revision ownership. */
export const SourceBlockRevisionSchema = SourceBlockSchema.extend({
  materialRevisionId: z.string().min(1),
  structuralUnitId: z.string().min(1).nullable(),
  revisionFingerprint: z.string().min(1).max(200),
}).strict();
export type SourceBlockRevision = z.infer<typeof SourceBlockRevisionSchema>;

export const MaterialLineageMethodSchema = z.enum(['exact', 'near_exact', 'semantic', 'manual']);
export type MaterialLineageMethod = z.infer<typeof MaterialLineageMethodSchema>;

export const MaterialRevisionLineageSchema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1),
    fromRevisionId: z.string().min(1),
    toRevisionId: z.string().min(1),
    method: MaterialLineageMethodSchema,
    confidence: z.number().min(0).max(1).nullable(),
    status: z.enum(['proposed', 'accepted', 'rejected', 'uncertain']),
    actor: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MaterialRevisionLineage = z.infer<typeof MaterialRevisionLineageSchema>;

export const MaterialLineageItemSchema = z
  .object({
    id: z.string().min(1),
    lineageId: z.string().min(1),
    entityKind: z.enum(['source_block', 'concept', 'structural_unit']),
    fromEntityId: z.string().min(1),
    toEntityId: z.string().min(1),
    matchKind: MaterialLineageMethodSchema,
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type MaterialLineageItem = z.infer<typeof MaterialLineageItemSchema>;

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
  /** New concepts are revision-owned; legacy records may not carry this field. */
  materialRevisionId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(1000),
  importance: ImportanceSchema,
  grounding: VerifiedGroundingSchema,
  createdAt: z.string().datetime(),
});
export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Safety ceiling on concepts per document. Section-aware extraction stops
 * ACCEPTING new concepts at this bound (remaining sections stay visibly
 * unmapped). A tunable guard against runaway extraction — not a target.
 */
export const MAX_CONCEPTS_PER_DOCUMENT = 40;
