import { describe, expect, it } from 'vitest';
import type {
  Concept,
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
  evaluateCurriculumEvidenceRecallAtBudgets,
  selectCurriculumEvidenceOffers,
  selectCurriculumEvidenceOffersWithTrace,
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

  it('traces deterministic overlapping signals without changing production selection', () => {
    const laterQuote = 'It temporarily holds information for active reasoning.';
    const laterStart = block.content.indexOf(laterQuote);
    const laterGrounding = {
      blockId: block.id,
      quote: laterQuote,
      startOffset: laterStart,
      endOffset: laterStart + laterQuote.length,
      occurrenceCount: 1,
      reanchored: false,
    };
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest,
      blocks: [block],
      preferredGroundings: [laterGrounding],
    });
    const predecessor = {
      nodes: [
        {
          id: 'unit_memory',
          kind: 'learning_unit',
          title: 'Working memory',
          sourceReferences: [{ sourceBlockId: block.id }],
          learningUnit: {
            objectives: [{ title: 'Working memory', description: 'Explain active reasoning.' }],
          },
        },
      ],
    } as unknown as Curriculum;
    const concept = {
      id: 'concept_memory',
      materialId: block.materialId,
      materialRevisionId: block.materialRevisionId,
      name: 'Working memory',
      summary: 'Limited active storage.',
      importance: 'high',
      grounding: laterGrounding,
      createdAt: '2026-01-01T00:00:00.000Z',
    } satisfies Concept;
    const input = {
      catalog,
      blocks: [block],
      predecessor,
      concepts: [concept],
      contract: {
        intent: 'Understand working memory',
        targetOutcome: { description: 'Explain active reasoning' },
        courseScope: { includedTopics: ['working memory'] },
      } as unknown as LearningContract,
      priorityGroundings: [laterGrounding, { ...laterGrounding, quote: preferredQuote }],
    };

    const first = selectCurriculumEvidenceOffersWithTrace(input);
    const repeated = selectCurriculumEvidenceOffersWithTrace(input);

    expect(repeated).toEqual(first);
    expect(selectCurriculumEvidenceOffers(input)).toEqual(first.offers);
    expect(first.offers[0]?.quote).toBe(laterQuote);
    expect(first.trace.counts).toMatchObject({
      corpusBlocks: 1,
      corpusMaterials: 1,
      corpusSections: 1,
      candidateBlocks: 1,
      offeredBlocks: 1,
      overlapBlocks: 1,
    });
    expect(first.trace.blocks[0]).toMatchObject({
      blockId: block.id,
      firstContributor: 'predecessor_reference',
    });
    expect(first.trace.blocks[0]!.signals).toEqual([
      'predecessor_reference',
      'concept_grounding',
      'locality_neighbor',
      'predecessor_lexical',
      'contract_lexical',
      'section_balance',
      'fallback',
    ]);
    expect(first.trace.priorityOrdering).toMatchObject({
      effect: 'offer_ordering_only',
      uniqueConceptGroundingCount: 1,
      uniqueNonConceptPriorityGroundingCount: 1,
      blocksWherePriorityChangedFirstOffer: 1,
    });
    expect(first.trace.serialization).toEqual({
      serializedInternalOfferBytes: Buffer.byteLength(JSON.stringify(first.offers), 'utf8'),
      byteMethod: 'utf8_internal_offer_json_array',
      estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(first.offers), 'utf8') / 4),
      tokenEstimateMethod: 'ceil_utf8_bytes_div_4',
    });
  });

  it('reports exact block and offer budgets while retaining trace/offer identity', () => {
    const blocks = Array.from({ length: 170 }, (_, index): SourceBlock => {
      const content = `Section ${index} ${'bounded evidence '.repeat(45)}`;
      return {
        ...block,
        id: `budget_block_${index}`,
        index,
        heading: `Section ${index}`,
        headingPath: [`Section ${index}`],
        content,
        endOffset: content.length,
      };
    });
    const budgetManifest: ExecutionSourceManifest = {
      ...manifest,
      revisions: [
        { ...manifest.revisions[0]!, sourceBlockRevisionIds: blocks.map((item) => item.id) },
      ],
    };
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: budgetManifest,
      blocks,
      preferredGroundings: [],
    });
    const input = {
      catalog,
      blocks,
      predecessor: null,
      concepts: [],
      contract: {
        intent: 'No lexical match',
        targetOutcome: { description: 'Unrelated target' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      priorityGroundings: [],
    };

    const traced = selectCurriculumEvidenceOffersWithTrace(input);

    expect(traced.trace.counts.candidateBlocks).toBe(CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET);
    expect(traced.trace.counts.offeredEvidence).toBe(CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET);
    expect(traced.trace.diversity).toEqual({
      candidateMaterials: 1,
      candidateSections: CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
      materialCoverageRatio: 1,
      sectionCoverageRatio: CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET / blocks.length,
    });
    expect(new Set(traced.offers.map((offer) => offer.blockId))).toEqual(
      new Set(traced.trace.blocks.map((candidate) => candidate.blockId)),
    );
    expect(traced.offers.every((offer, index) => offer.id === `E${index + 1}`)).toBe(true);
    expect(selectCurriculumEvidenceOffers(input)).toEqual(traced.offers);
  });

  it('attributes deterministic fallback widening without treating it as authority', () => {
    const blocks = Array.from({ length: 200 }, (_, index): SourceBlock => ({
      ...block,
      id: `fallback_block_${index}`,
      index,
      heading: 'One section',
      headingPath: ['One section'],
      content: `Ordinary source ${index}.`,
      endOffset: `Ordinary source ${index}.`.length,
    }));
    const fallbackManifest: ExecutionSourceManifest = {
      ...manifest,
      revisions: [
        { ...manifest.revisions[0]!, sourceBlockRevisionIds: blocks.map((item) => item.id) },
      ],
    };
    const catalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_a',
      manifest: fallbackManifest,
      blocks,
      preferredGroundings: [],
    });
    const input = {
      catalog,
      blocks,
      predecessor: null,
      concepts: [],
      contract: {
        intent: 'Needle absent',
        targetOutcome: { description: 'Target absent' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      priorityGroundings: [],
    };

    const traced = selectCurriculumEvidenceOffersWithTrace(input);
    const fallbackSignal = traced.trace.signals.find((signal) => signal.signal === 'fallback')!;

    expect(selectCurriculumEvidenceOffersWithTrace(input)).toEqual(traced);
    expect(traced.trace.counts.candidateBlocks).toBe(traced.trace.budgets.minFallbackBlocks);
    expect(fallbackSignal.firstContributorBlockCount).toBeGreaterThan(0);
    expect(fallbackSignal.selectedBlockCount).toBe(traced.trace.budgets.minFallbackBlocks);
    expect(traced.trace.priorityOrdering.effect).toBe('offer_ordering_only');
    expect(traced.trace.priorityOrdering.selectedPriorityOfferCount).toBe(0);
  });

  it('measures exact required-block recall at block, byte, and estimated-token budgets', () => {
    const offers = Array.from({ length: 3 }, (_, index) => ({
      id: `E${index + 1}`,
      bindingId: `binding_${index + 1}`,
      materialId: 'mat_a',
      materialRevisionId: 'rev_a',
      blockId: `required_block_${index + 1}`,
      startOffset: 0,
      endOffset: 10,
      quote: `Evidence ${index + 1}`,
      headingPath: [`Section ${index + 1}`],
      pageNumber: null,
    }));
    const twoOfferBytes = Buffer.byteLength(JSON.stringify(offers.slice(0, 2)), 'utf8');
    const result = evaluateCurriculumEvidenceRecallAtBudgets({
      offers,
      requiredBlockIds: ['required_block_1', 'required_block_2', 'missing', 'missing'],
      blockBudget: 1,
      serializedByteBudget: twoOfferBytes,
      estimatedTokenBudget: Math.ceil(twoOfferBytes / 4),
    });

    expect(result.requiredBlockIds).toEqual(['required_block_1', 'required_block_2', 'missing']);
    expect(result.blockBudget).toMatchObject({
      budget: 1,
      recalledRequiredBlockIds: ['required_block_1'],
      missingRequiredBlockIds: ['required_block_2', 'missing'],
      recall: 1 / 3,
      includedBlockCount: 1,
    });
    expect(result.serializedByteBudget).toMatchObject({
      budgetBytes: twoOfferBytes,
      budgetSatisfied: true,
      byteMethod: 'utf8_internal_offer_json_array',
      includedOfferCount: 2,
      recalledRequiredBlockIds: ['required_block_1', 'required_block_2'],
      recall: 2 / 3,
    });
    expect(result.estimatedTokenBudget).toMatchObject({
      budgetTokens: Math.ceil(twoOfferBytes / 4),
      budgetSatisfied: true,
      tokenEstimateMethod: 'ceil_utf8_bytes_div_4',
      includedOfferCount: 2,
      estimatedTokens: Math.ceil(twoOfferBytes / 4),
      recall: 2 / 3,
    });
  });

  it('reports when no serialized JSON array can fit a zero byte or token budget', () => {
    const result = evaluateCurriculumEvidenceRecallAtBudgets({
      offers: [],
      requiredBlockIds: [],
      blockBudget: 0,
      serializedByteBudget: 0,
      estimatedTokenBudget: 0,
    });

    expect(result.blockBudget).toMatchObject({ includedBlockCount: 0, recall: null });
    expect(result.serializedByteBudget).toMatchObject({
      budgetSatisfied: false,
      serializedInternalOfferBytes: Buffer.byteLength(JSON.stringify([]), 'utf8'),
      recall: null,
    });
    expect(result.estimatedTokenBudget).toMatchObject({
      budgetSatisfied: false,
      estimatedTokens: 1,
      recall: null,
    });
  });
});
