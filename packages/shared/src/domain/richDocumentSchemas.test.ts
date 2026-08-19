import { describe, expect, it } from 'vitest';
import {
  EmbeddedAssetSchema,
  MaterialRevisionSchema,
  NormalizedStructuralUnitSchema,
  SourceBlockSchema,
} from './material.js';
import {
  NormalizedDocumentSchema,
  NormalizedDocumentUnitSchema,
  NormalizedLocationSchema,
} from './normalizedDocument.js';

const embeddedAsset = {
  id: 'asset_rev_1_0',
  materialId: 'mat_1',
  materialRevisionId: 'rev_1',
  index: 0,
  parentStructuralUnitId: 'unit_slide_2',
  sourcePath: 'ppt/media/image1.png',
  mediaType: 'image/png',
  byteHash: `sha256:${'a'.repeat(64)}`,
  byteLength: 128,
  width: 640,
  height: 480,
  location: { slideNumber: 2 },
  relationshipKind: 'image' as const,
  contentOrigin: 'extracted_original' as const,
  parserVersion: 'pptx-ooxml-v1',
};

describe('EmbeddedAssetSchema', () => {
  it('preserves revision, structural parent, byte identity, and slide provenance', () => {
    expect(EmbeddedAssetSchema.parse(embeddedAsset)).toEqual(embeddedAsset);
    expect(
      EmbeddedAssetSchema.parse({
        ...embeddedAsset,
        parentStructuralUnitId: null,
        width: null,
        height: null,
        location: { pageNumber: null, slideNumber: null, domPath: null },
        relationshipKind: 'unknown',
      }),
    ).toMatchObject({ parentStructuralUnitId: null, width: null, height: null });
  });

  it('rejects forged hashes, derived authority, invalid dimensions, and unknown fields', () => {
    expect(
      EmbeddedAssetSchema.safeParse({ ...embeddedAsset, byteHash: 'sha256:abc' }).success,
    ).toBe(false);
    expect(
      EmbeddedAssetSchema.safeParse({
        ...embeddedAsset,
        contentOrigin: 'derived_visual_description',
      }).success,
    ).toBe(false);
    expect(EmbeddedAssetSchema.safeParse({ ...embeddedAsset, width: 0 }).success).toBe(false);
    expect(
      EmbeddedAssetSchema.safeParse({
        ...embeddedAsset,
        location: { slideNumber: 2, relationshipId: 'rId1' },
      }).success,
    ).toBe(false);
  });

  it('requires positive slide provenance when it is present', () => {
    for (const slideNumber of [0, -1, 1.5]) {
      expect(
        EmbeddedAssetSchema.safeParse({ ...embeddedAsset, location: { slideNumber } }).success,
      ).toBe(false);
    }
    expect(
      EmbeddedAssetSchema.parse({ ...embeddedAsset, location: { slideNumber: null } }).location
        .slideNumber,
    ).toBeNull();
  });
});

describe('slide provenance schemas', () => {
  it('accepts an active asset-only revision without treating null content as valid', () => {
    const revision = {
      id: 'rev_asset_only',
      materialId: 'mat_asset_only',
      revision: 1,
      predecessorRevisionId: null,
      status: 'active' as const,
      sourceType: 'pptx' as const,
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
      originalFilename: 'diagram.pptx',
      normalizedContent: '',
      charCount: 0,
      parseStatus: 'parsed_with_warnings' as const,
      pageCount: null,
      extractionWarnings: ['No extractable text.'],
      parserVersion: 'pptx-ooxml-rich-v1',
      parserFingerprint: 'parser_fixture',
      chunkerVersion: 'structure-aware-v1',
      chunkerFingerprint: 'chunker_fixture',
      sourceFingerprint: `sha256:${'b'.repeat(64)}`,
      originalAssetFingerprint: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-08-19T00:00:00.000Z',
      activatedAt: '2026-08-19T00:00:00.000Z',
      retiredAt: null,
      failureCode: null,
      failureMessage: null,
    };
    expect(MaterialRevisionSchema.parse(revision).normalizedContent).toBe('');
    expect(MaterialRevisionSchema.safeParse({ ...revision, normalizedContent: null }).success).toBe(
      false,
    );
  });

  it('accepts asset-only originals but rejects a normalized document with neither text nor assets', () => {
    const assetOnly = {
      materialRevisionId: 'rev_1',
      sourceType: 'pptx' as const,
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
      content: '',
      units: [],
      capabilities: ['embedded_assets', 'slide_awareness'] as const,
      warnings: ['No extractable text.'],
      complete: false,
      parserVersion: 'pptx-ooxml-v1',
      parserFingerprint: 'pptx-ooxml-v1:fixture',
      assets: [{ ...embeddedAsset, parentStructuralUnitId: null }],
    };
    expect(NormalizedDocumentSchema.parse(assetOnly).content).toBe('');
    expect(NormalizedDocumentSchema.safeParse({ ...assetOnly, assets: [] }).success).toBe(false);
  });

  it('accepts a positive slide number across location, unit, and source-block contracts', () => {
    expect(NormalizedLocationSchema.parse({ slideNumber: 2 })).toEqual({ slideNumber: 2 });

    const unit = NormalizedDocumentUnitSchema.parse({
      id: 'unit_slide_2',
      materialRevisionId: 'rev_1',
      parentUnitId: null,
      kind: 'slide',
      index: 0,
      title: 'Slide 2',
      content: 'Slide content',
      startOffset: 0,
      endOffset: 13,
      headingPath: [],
      location: { slideNumber: 2 },
      contentOrigin: 'extracted_original',
      derivation: 'source_text',
    });
    expect(unit.location.slideNumber).toBe(2);

    const storedUnit = NormalizedStructuralUnitSchema.parse({
      id: unit.id,
      materialRevisionId: unit.materialRevisionId,
      parentUnitId: null,
      kind: 'slide',
      index: 0,
      title: unit.title,
      content: unit.content,
      sourceLocator: 'slide:2',
      derivation: 'source_text',
      confidence: null,
      slideNumber: 2,
    });
    expect(storedUnit.slideNumber).toBe(2);

    const block = SourceBlockSchema.parse({
      id: 'block_1',
      materialId: 'mat_1',
      materialRevisionId: 'rev_1',
      index: 0,
      heading: null,
      headingPath: [],
      pageNumber: null,
      pageEnd: null,
      slideNumber: 2,
      content: 'Slide content',
      startOffset: 0,
      endOffset: 13,
      structuralUnitId: unit.id,
      chunkerVersion: 'structure-aware-v1',
      contentOrigin: 'extracted_original',
    });
    expect(block.slideNumber).toBe(2);
  });

  it('rejects zero, negative, and fractional slide numbers in every projection', () => {
    const sourceBlock = {
      id: 'block_1',
      materialId: 'mat_1',
      index: 0,
      heading: null,
      headingPath: [],
      pageNumber: null,
      content: 'x',
      startOffset: 0,
      endOffset: 1,
    };
    const storedUnit = {
      id: 'unit_1',
      materialRevisionId: 'rev_1',
      parentUnitId: null,
      kind: 'slide' as const,
      index: 0,
      title: null,
      content: 'x',
      sourceLocator: null,
      derivation: 'source_text' as const,
      confidence: null,
    };
    for (const slideNumber of [0, -1, 1.5]) {
      expect(NormalizedLocationSchema.safeParse({ slideNumber }).success).toBe(false);
      expect(SourceBlockSchema.safeParse({ ...sourceBlock, slideNumber }).success).toBe(false);
      expect(NormalizedStructuralUnitSchema.safeParse({ ...storedUnit, slideNumber }).success).toBe(
        false,
      );
    }
  });

  it('validates normalized document spans and revision ownership around slide assets', () => {
    const document = {
      materialRevisionId: 'rev_1',
      sourceType: 'pptx' as const,
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const,
      content: 'Slide content',
      units: [
        {
          id: 'unit_slide_2',
          materialRevisionId: 'rev_1',
          parentUnitId: null,
          kind: 'slide' as const,
          index: 0,
          title: 'Slide 2',
          content: 'Slide content',
          startOffset: 0,
          endOffset: 13,
          headingPath: [],
          location: { slideNumber: 2 },
          contentOrigin: 'extracted_original' as const,
          derivation: 'source_text' as const,
        },
      ],
      capabilities: ['text_extraction', 'slide_awareness', 'embedded_assets'] as const,
      warnings: [],
      complete: true,
      parserVersion: 'pptx-ooxml-v1',
      parserFingerprint: 'pptx-ooxml-v1:fixture',
      assets: [embeddedAsset],
    };
    expect(NormalizedDocumentSchema.parse(document).assets[0]!.location.slideNumber).toBe(2);
    expect(
      NormalizedDocumentSchema.safeParse({
        ...document,
        assets: [{ ...embeddedAsset, materialRevisionId: 'rev_other' }],
      }).success,
    ).toBe(false);
    expect(
      NormalizedDocumentSchema.safeParse({
        ...document,
        assets: [embeddedAsset, { ...embeddedAsset, id: 'asset_rev_1_duplicate' }],
      }).success,
    ).toBe(false);
    expect(
      NormalizedDocumentSchema.safeParse({
        ...document,
        assets: [{ ...embeddedAsset, location: { slideNumber: 3 } }],
      }).success,
    ).toBe(false);
  });
});
