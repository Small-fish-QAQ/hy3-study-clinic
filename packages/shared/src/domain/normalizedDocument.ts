import { z } from 'zod';
import {
  EmbeddedAssetSchema,
  MediaTypeSchema,
  SourceTypeSchema,
  StructuralUnitKindSchema,
} from './material.js';

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
    endOffset: z.number().int().nonnegative(),
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
    const emptyContainerKinds = new Set([
      'document',
      'section',
      'page',
      'slide',
      'image',
      'figure',
    ]);
    if (unit.endOffset < unit.startOffset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endOffset'],
        message: 'unit span must not be negative',
      });
    }
    if (
      unit.endOffset === unit.startOffset &&
      (unit.content.length > 0 || !emptyContainerKinds.has(unit.kind))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endOffset'],
        message: 'only empty structural containers may use an empty span',
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
    content: z.string(),
    units: z.array(NormalizedDocumentUnitSchema).max(20_000),
    capabilities: z.array(ParserCapabilitySchema).max(32),
    warnings: z.array(z.string().max(500)).max(50),
    complete: z.boolean(),
    parserVersion: z.string().max(80),
    parserFingerprint: z.string().max(200),
    /** Original package assets; descriptions/OCR are intentionally absent. */
    assets: z.array(EmbeddedAssetSchema).max(2_000).default([]),
  })
  .strict()
  .superRefine((document, ctx) => {
    if (document.content.length === 0 && document.assets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'a normalized document must contain text or original assets',
      });
    }
    if (document.content.length > 0 && document.units.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['units'],
        message: 'textual content requires structural units',
      });
    }
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
    const unitsById = new Map(document.units.map((unit) => [unit.id, unit]));
    const unitIds = new Set(unitsById.keys());
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
    const assetIds = new Set<string>();
    const assetIndexes = new Set<number>();
    for (const asset of document.assets) {
      if (assetIds.has(asset.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: 'asset ids must be unique',
        });
      }
      assetIds.add(asset.id);
      if (assetIndexes.has(asset.index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: 'asset indexes must be unique',
        });
      }
      assetIndexes.add(asset.index);
      if (asset.materialRevisionId !== document.materialRevisionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: 'asset revision ownership mismatch',
        });
      }
      if (asset.parentStructuralUnitId && !unitIds.has(asset.parentStructuralUnitId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: 'asset parent structural unit is unknown',
        });
      } else if (asset.parentStructuralUnitId) {
        const parentLocation = unitsById.get(asset.parentStructuralUnitId)!.location;
        for (const field of ['pageNumber', 'slideNumber'] as const) {
          const assetValue = asset.location[field];
          const parentValue = parentLocation[field];
          if (assetValue != null && parentValue != null && assetValue !== parentValue) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['assets'],
              message: `asset ${field} conflicts with its parent structural unit`,
            });
          }
        }
      }
    }
  });
export type NormalizedDocument = z.infer<typeof NormalizedDocumentSchema>;
