import type { Curriculum, Material, SourceBlock, SourceBlockRevision } from '@hy3-clinic/shared';
import { describe, expect, it } from 'vitest';
import { searchSourceBlocks } from '../retrieval/lexical.js';
import { buildTeachingBriefSourceContext } from './teachingBriefContext.js';

const revisionId = 'rev_slide';
const materialId = 'mat_slide';
const content = 'Retrieval practice strengthens durable memory.';

const block: SourceBlockRevision = {
  id: 'block_slide',
  materialId,
  materialRevisionId: revisionId,
  structuralUnitId: 'unit_slide_7',
  index: 0,
  heading: 'Practice',
  headingPath: ['Practice'],
  pageNumber: null,
  pageEnd: null,
  slideNumber: 7,
  content,
  startOffset: 0,
  endOffset: content.length,
  chunkerVersion: 'structure-aware-v1',
  contentOrigin: 'extracted_original',
  revisionFingerprint: 'block_revision_slide',
};

const material: Material = {
  id: materialId,
  workspaceId: 'ws_slide',
  activeRevisionId: revisionId,
  availability: 'active',
  retiredAt: null,
  title: 'Retrieval deck',
  sourceType: 'pptx',
  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  originalFilename: 'retrieval.pptx',
  content,
  charCount: content.length,
  parseStatus: 'parsed',
  pageCount: null,
  extractionWarnings: [],
  parserVersion: 'pptx-ooxml-v1',
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

const curriculum: Curriculum = {
  id: 'curriculum_slide',
  workspaceId: 'ws_slide',
  contractVersionId: 'contract_slide',
  version: 1,
  predecessorId: null,
  status: 'accepted',
  executionSourceManifest: {
    fingerprint: 'manifest_slide',
    revisions: [
      {
        materialId,
        materialRevisionId: revisionId,
        parserVersion: 'pptx-ooxml-v1',
        parserFingerprint: 'parser_slide',
        sourceBlockRevisionIds: [block.id],
      },
    ],
  },
  nodes: [
    {
      id: 'course_slide',
      parentId: null,
      kind: 'course',
      index: 0,
      title: 'Retrieval course',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'learning_unit_slide',
      parentId: 'course_slide',
      kind: 'learning_unit',
      index: 0,
      title: 'Practice retrieval',
      sourceReferences: [
        {
          materialId,
          materialRevisionId: revisionId,
          structuralUnitId: 'unit_slide_7',
          sourceBlockId: block.id,
          sourceBlockRevisionFingerprint: block.revisionFingerprint,
        },
      ],
      learningUnit: {
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            id: 'objective_slide',
            title: 'Explain retrieval practice',
            description: 'Explain why retrieval practice supports memory.',
            truthPremiseStatus: 'unverified',
            truthAuthorityRecordIds: [],
          },
        ],
        prerequisiteUnitIds: [],
        graphRelationIds: [],
        riskIds: [],
      },
    },
  ],
  synthesisGroups: [],
  validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
  provider: 'fake',
  providerModel: null,
  createdAt: '2026-08-19T00:00:00.000Z',
  acceptedAt: '2026-08-19T00:00:00.000Z',
};

describe('downstream slide provenance', () => {
  it('preserves slide ownership in lexical and graph-expanded retrieval', () => {
    expect(searchSourceBlocks([block], 'durable memory')).toEqual([
      expect.objectContaining({ blockId: block.id, pageNumber: null, slideNumber: 7 }),
    ]);
    expect(
      searchSourceBlocks([block as SourceBlock], 'no lexical match', {
        graphNeighborBlockIds: new Set([block.id]),
      }),
    ).toEqual([
      expect.objectContaining({
        blockId: block.id,
        pageNumber: null,
        slideNumber: 7,
        source: 'graph_expansion',
      }),
    ]);
  });

  it('preserves slide ownership in Teaching Brief offers and exact references', () => {
    const context = buildTeachingBriefSourceContext({
      workspaceId: 'ws_slide',
      curriculum,
      learningUnitId: 'learning_unit_slide',
      materials: [material],
      blocks: [block],
      concepts: [],
    });

    expect(context.offers).toEqual([
      expect.objectContaining({ materialTitle: material.title, pageNumber: null, slideNumber: 7 }),
    ]);
    expect(context.references).toEqual([
      expect.objectContaining({
        materialId,
        materialRevisionId: revisionId,
        sourceBlockId: block.id,
        pageNumber: null,
        slideNumber: 7,
        quote: content,
      }),
    ]);
  });
});
