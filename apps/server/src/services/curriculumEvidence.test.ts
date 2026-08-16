import { describe, expect, it } from 'vitest';
import type {
  Curriculum,
  ExecutionSourceManifest,
  LearningContract,
  SourceBlock,
} from '@hy3-clinic/shared';
import { verifyGrounding } from '../grounding/verify.js';
import {
  buildCurriculumEvidenceCatalog,
  CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS,
  CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
  CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
  selectCurriculumEvidenceOffers,
} from './curriculumEvidence.js';

const block: SourceBlock = {
  id: 'blk_revision_a',
  materialId: 'mat_a',
  materialRevisionId: 'rev_a',
  index: 0,
  heading: 'Memory',
  headingPath: ['Memory'],
  pageNumber: 2,
  pageEnd: 2,
  content: 'Working memory is limited. It temporarily holds information for active reasoning.',
  startOffset: 0,
  endOffset: 83,
};
const preferredQuote = 'Working memory is limited.';

const manifest: ExecutionSourceManifest = {
  fingerprint: 'manifest_a',
  revisions: [
    {
      materialId: 'mat_a',
      materialRevisionId: 'rev_a',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-fingerprint-a',
      sourceBlockRevisionIds: [block.id],
    },
  ],
};

describe('Curriculum evidence catalog', () => {
  it('offers stable bounded exact excerpts and retains preferred authority text', () => {
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [
        {
          blockId: block.id,
          quote: preferredQuote,
          startOffset: 0,
          endOffset: preferredQuote.length,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    });
    expect(catalog.length).toBeGreaterThan(1);
    expect(
      catalog.every((offer) => offer.quote.length <= CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS),
    ).toBe(true);
    const selected = catalog.find((offer) => offer.quote === preferredQuote);
    expect(selected).toMatchObject({
      materialId: 'mat_a',
      materialRevisionId: 'rev_a',
      blockId: block.id,
      startOffset: 0,
      endOffset: preferredQuote.length,
    });
    expect(
      verifyGrounding([block], { blockId: selected!.blockId, quote: selected!.quote }).ok,
    ).toBe(true);
    expect(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block],
        preferredGroundings: [],
      }),
    ).toEqual(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block],
        preferredGroundings: [],
      }),
    );
  });

  it('does not offer a block outside the exact manifest', () => {
    const foreign: SourceBlock = { ...block, id: 'blk_foreign', materialId: 'mat_foreign' };
    expect(
      buildCurriculumEvidenceCatalog({
        workspaceId: 'ws_a',
        manifest,
        blocks: [block, foreign],
        preferredGroundings: [],
      }).every((offer) => offer.blockId !== foreign.id),
    ).toBe(true);
  });

  it('binds identities to the exact workspace and revision snapshot', () => {
    const original = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [],
    });
    const otherWorkspace = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_b',
      manifest,
      blocks: [block],
      preferredGroundings: [],
    });
    const otherRevisionBlock = { ...block, materialRevisionId: 'rev_b' };
    const otherRevision = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: {
        ...manifest,
        revisions: [{ ...manifest.revisions[0]!, materialRevisionId: 'rev_b' }],
      },
      blocks: [otherRevisionBlock],
      preferredGroundings: [],
    });
    expect(otherWorkspace.map((offer) => offer.id)).not.toEqual(original.map((offer) => offer.id));
    expect(otherRevision.map((offer) => offer.id)).not.toEqual(original.map((offer) => offer.id));
  });

  it('does not promote a paraphrase supplied as a preferred grounding', () => {
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [
        {
          blockId: block.id,
          quote: 'Working memory has a small capacity.',
          startOffset: 0,
          endOffset: 37,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    });
    expect(catalog.some((offer) => offer.quote === 'Working memory has a small capacity.')).toBe(
      false,
    );
  });

  it('keeps a large local catalog while bounding compact predecessor-aware provider offers', () => {
    const blocks = Array.from({ length: 300 }, (_, index): SourceBlock => ({
      ...block,
      id: `blk_${index.toString().padStart(3, '0')}`,
      index,
      content:
        index === 150
          ? 'Critical retrieval evidence survives deterministic narrowing.'
          : `Unrelated source paragraph ${index}.`,
      endOffset:
        index === 150
          ? 'Critical retrieval evidence survives deterministic narrowing.'.length
          : `Unrelated source paragraph ${index}.`.length,
    }));
    const largeManifest: ExecutionSourceManifest = {
      ...manifest,
      revisions: [
        { ...manifest.revisions[0]!, sourceBlockRevisionIds: blocks.map((item) => item.id) },
      ],
    };
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: largeManifest,
      blocks,
      preferredGroundings: [],
    });
    const predecessor = {
      nodes: [
        {
          id: 'unit_critical',
          kind: 'learning_unit',
          title: 'Critical retrieval',
          sourceReferences: [{ sourceBlockId: 'blk_150' }],
          learningUnit: { objectives: [] },
        },
      ],
    } as unknown as Curriculum;
    const contract = {
      intent: 'Understand critical retrieval',
      targetOutcome: { description: 'Explain critical retrieval' },
      courseScope: { includedTopics: ['critical retrieval'] },
    } as unknown as LearningContract;

    const selected = selectCurriculumEvidenceOffers({
      catalog,
      blocks,
      predecessor,
      concepts: [],
      contract,
      priorityGroundings: [],
    });

    expect(catalog.length).toBe(300);
    expect(selected.length).toBeLessThanOrEqual(CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET);
    expect(new Set(selected.map((offer) => offer.blockId)).size).toBeLessThanOrEqual(
      CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
    );
    expect(selected.some((offer) => offer.blockId === 'blk_150')).toBe(true);
    expect(selected.some((offer) => offer.blockId === 'blk_149')).toBe(true);
    expect(selected.some((offer) => offer.blockId === 'blk_151')).toBe(true);
    expect(selected.some((offer) => offer.blockId === 'blk_299')).toBe(false);
    expect(selected.every((offer, index) => offer.id === `E${index + 1}`)).toBe(true);
    expect(selected.every((offer) => offer.bindingId.startsWith('cev_'))).toBe(true);
  });

  it('widens deterministically to retain lexical evidence without fabricating authority', () => {
    const blocks = Array.from({ length: 200 }, (_, index): SourceBlock => ({
      ...block,
      id: `blk_${index}`,
      index,
      content: index === 187 ? 'Needle fallback evidence.' : `Ordinary paragraph ${index}.`,
      endOffset: index === 187 ? 25 : `Ordinary paragraph ${index}.`.length,
    }));
    const largeManifest: ExecutionSourceManifest = {
      ...manifest,
      revisions: [
        { ...manifest.revisions[0]!, sourceBlockRevisionIds: blocks.map((item) => item.id) },
      ],
    };
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: largeManifest,
      blocks,
      preferredGroundings: [],
    });
    const selected = selectCurriculumEvidenceOffers({
      catalog,
      blocks,
      predecessor: null,
      concepts: [],
      contract: {
        intent: 'Needle fallback',
        targetOutcome: { description: 'Find needle evidence' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      priorityGroundings: [],
    });

    const retained = selected.find((offer) => offer.blockId === 'blk_187');
    expect(retained?.quote).toBe('Needle fallback evidence.');
    expect(catalog.some((offer) => offer.bindingId === retained?.bindingId)).toBe(true);
    expect(selected.every((offer) => blocks.some((item) => item.id === offer.blockId))).toBe(true);
  });
});
