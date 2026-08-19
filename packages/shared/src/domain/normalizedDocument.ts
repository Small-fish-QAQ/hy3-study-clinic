import { z } from 'zod';
import { MediaTypeSchema, SourceTypeSchema, StructuralUnitKindSchema } from './material.js';

/** Authority class for text carried by a normalized document. */
export const ContentOriginSchema = z.enum([
  'extracted_original',
  'derived_ocr',
  'derived_visual_description',
  'derived_layout_label',
  'derived_summary',
]);
export type ContentOrigin = z.infer<typeof ContentOriginSchema>;

export const ParserCapabilitySchema = z.enum([
  'text_extraction',
  'structural_hierarchy',
  'page_awareness',
  'slide_awareness',
  'embedded_assets',
  'table_structure',
  'exact_line_ranges',
  'visual_asset',
  'deterministic_text',
  'derived_visual_interpretation',
  'source_location_precision',
]);
export type ParserCapability = z.infer<typeof ParserCapabilitySchema>;

export const NormalizedLocationSchema = z
  .object({
    lineStart: z.number().int().positive().nullable().optional(),
    lineEnd: z.number().int().positive().nullable().optional(),
    pageNumber: z.number().int().positive().nullable().optional(),
    pageEnd: z.number().int().positive().nullable().optional(),
    slideNumber: z.number().int().positive().nullable().optional(),
    domPath: z.string().max(500).nullable().optional(),
    symbol: z.string().max(300).nullable().optional(),
  })
  .strict();
export type NormalizedLocation = z.infer<typeof NormalizedLocationSchema>;

/** One ordered, revision-owned structural extraction unit. */
export const NormalizedDocumentUnitSchema = z
  .object({
    id: z.string().min(1),
    materialRevisionId: z.string().min(1),
    parentUnitId: z.string().min(1).nullable(),
    kind: StructuralUnitKindSchema,
    index: z.number().int().nonnegative(),
    title: z.string().max(300).nullable(),
    content: z.string(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    headingPath: z.array(z.string()),
    location: NormalizedLocationSchema,
    contentOrigin: ContentOriginSchema,
    derivation: z.enum([
      'source_text',
      'parser_derived',
      'ocr_derived',
      'extracted_original',
      'derived_ocr',
      'derived_visual_description',
      'derived_layout_label',
      'derived_summary',
    ]),
  })
  .strict()
  .superRefine((unit, ctx) => {
    if (unit.endOffset <= unit.startOffset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endOffset'],
        message: 'unit span must be non-empty',
      });
    }
    if (unit.contentOrigin !== 'extracted_original' && unit.derivation === 'source_text') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['derivation'],
        message: 'derived content cannot use source_text derivation',
      });
    }
  });
export type NormalizedDocumentUnit = z.infer<typeof NormalizedDocumentUnitSchema>;

export const NormalizedDocumentSchema = z
  .object({
    materialRevisionId: z.string().min(1),
    sourceType: SourceTypeSchema,
    mediaType: MediaTypeSchema.nullable(),
    content: z.string().min(1),
    units: z.array(NormalizedDocumentUnitSchema).min(1).max(20_000),
    capabilities: z.array(ParserCapabilitySchema).max(32),
    warnings: z.array(z.string().max(500)).max(50),
    complete: z.boolean(),
    parserVersion: z.string().max(80),
    parserFingerprint: z.string().max(200),
  })
  .strict()
  .superRefine((document, ctx) => {
    const indexes = document.units.map((unit) => unit.index);
    if (new Set(indexes).size !== indexes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['units'],
        message: 'unit indexes must be unique',
      });
    }
    for (let index = 1; index < document.units.length; index += 1) {
      if (document.units[index - 1]!.index >= document.units[index]!.index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units'],
          message: 'units must preserve source order',
        });
        break;
      }
    }
    const unitIds = new Set(document.units.map((unit) => unit.id));
    for (const unit of document.units) {
      if (unit.materialRevisionId !== document.materialRevisionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units'],
          message: 'unit revision ownership mismatch',
        });
      }
      if (unit.startOffset < 0 || unit.endOffset > document.content.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units'],
          message: 'unit offsets exceed document content',
        });
      } else if (document.content.slice(unit.startOffset, unit.endOffset) !== unit.content) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units'],
          message: 'unit content does not match its source span',
        });
      }
      if (unit.parentUnitId && !unitIds.has(unit.parentUnitId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units'],
          message: 'unit parent is unknown',
        });
      }
    }
  });
export type NormalizedDocument = z.infer<typeof NormalizedDocumentSchema>;
