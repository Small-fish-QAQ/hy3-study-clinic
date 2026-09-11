import { describe, expect, it } from 'vitest';
import type {
  Concept,
  Curriculum,
  ExecutionSourceManifest,
  LearningContract,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import { verifyGrounding } from '../grounding/verify.js';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { searchSourceBlocks } from '../retrieval/lexical.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import {
  buildCurriculumEvidenceCatalog,
  buildCurriculumEvidenceSignalRankings,
  CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS,
  CURRICULUM_PROVIDER_APPLY_PROCEDURE_BLOCK_RESERVE,
  CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
  CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
  evaluateCurriculumEvidenceRecallAtBudgets,
  selectCurriculumEvidenceOffers,
  selectCurriculumEvidenceOffersWithTrace,
  type CurriculumEvidenceSelectionInput,
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

const REFERENCE_BLOCK_BUDGET = 160;
const REFERENCE_OFFER_BUDGET = 240;
const REFERENCE_OFFERS_PER_BLOCK = 2;
const REFERENCE_PREDECESSOR_REFS_PER_UNIT = 6;
const REFERENCE_MIN_FALLBACK_BLOCKS = 64;
const REFERENCE_NEIGHBOR_RADIUS = 1;

function referenceGroundingKey(grounding: Pick<VerifiedGrounding, 'blockId' | 'quote'>): string {
  return `${grounding.blockId}\u0000${grounding.quote}`;
}

function referencePredecessorSearchText(node: Curriculum['nodes'][number]): string {
  return [
    node.title,
    ...(node.learningUnit?.objectives.flatMap((objective) => [
      objective.title,
      objective.description,
    ]) ?? []),
  ].join(' ');
}

/** Frozen output-only copy of the production selector at 0836849. */
function selectCurriculumEvidenceOffersAt0836849({
  catalog,
  blocks,
  predecessor,
  concepts,
  contract,
  priorityGroundings,
}: CurriculumEvidenceSelectionInput): CurriculumEvidenceOffer[] {
  const blockById = new Map(blocks.map((candidate) => [candidate.id, candidate]));
  const orderedByMaterial = new Map<string, SourceBlock[]>();
  for (const candidate of blocks) {
    const materialBlocks = orderedByMaterial.get(candidate.materialId) ?? [];
    materialBlocks.push(candidate);
    orderedByMaterial.set(candidate.materialId, materialBlocks);
  }
  orderedByMaterial.forEach((materialBlocks) =>
    materialBlocks.sort(
      (left, right) => left.index - right.index || left.id.localeCompare(right.id),
    ),
  );

  const selectedBlockIds = new Set<string>();
  const addBlock = (blockId: string): void => {
    if (!blockById.has(blockId) || selectedBlockIds.has(blockId)) return;
    if (selectedBlockIds.size >= REFERENCE_BLOCK_BUDGET) return;
    selectedBlockIds.add(blockId);
  };

  for (const node of predecessor?.nodes.filter((candidate) => candidate.kind === 'learning_unit') ??
    []) {
    for (const ref of node.sourceReferences.slice(0, REFERENCE_PREDECESSOR_REFS_PER_UNIT)) {
      if (ref.sourceBlockId) addBlock(ref.sourceBlockId);
    }
  }
  for (const concept of concepts) addBlock(concept.grounding.blockId);

  for (const blockId of [...selectedBlockIds]) {
    const candidate = blockById.get(blockId);
    if (!candidate) continue;
    const siblings = orderedByMaterial.get(candidate.materialId) ?? [];
    const position = siblings.findIndex((sibling) => sibling.id === blockId);
    for (
      let offset = -REFERENCE_NEIGHBOR_RADIUS;
      offset <= REFERENCE_NEIGHBOR_RADIUS;
      offset += 1
    ) {
      const neighbor = siblings[position + offset];
      if (neighbor) addBlock(neighbor.id);
    }
  }

  for (const node of predecessor?.nodes.filter((candidate) => candidate.kind === 'learning_unit') ??
    []) {
    for (const result of searchSourceBlocks(blocks, referencePredecessorSearchText(node), {
      limit: 2,
    })) {
      addBlock(result.blockId);
    }
  }
  const contractQuery = [
    contract.intent,
    contract.targetOutcome.description,
    ...contract.courseScope.includedTopics,
  ].join(' ');
  for (const result of searchSourceBlocks(blocks, contractQuery)) addBlock(result.blockId);

  const sectionGroups = new Map<string, SourceBlock[]>();
  for (const candidate of blocks) {
    const key = `${candidate.materialId}\u0000${candidate.headingPath.join('\u0001')}`;
    const group = sectionGroups.get(key) ?? [];
    group.push(candidate);
    sectionGroups.set(key, group);
  }
  for (const group of sectionGroups.values()) {
    addBlock(group[0]!.id);
    addBlock(group[Math.floor(group.length / 2)]!.id);
  }
  if (selectedBlockIds.size < REFERENCE_MIN_FALLBACK_BLOCKS && blocks.length > 0) {
    const stride = blocks.length / REFERENCE_MIN_FALLBACK_BLOCKS;
    for (let index = 0; index < REFERENCE_MIN_FALLBACK_BLOCKS; index += 1) {
      addBlock(blocks[Math.min(blocks.length - 1, Math.floor(index * stride))]!.id);
    }
  }

  const priorityKeys = new Set(priorityGroundings.map(referenceGroundingKey));
  const offersByBlock = new Map<string, CurriculumEvidenceOffer[]>();
  for (const offer of catalog) {
    if (!selectedBlockIds.has(offer.blockId)) continue;
    const offers = offersByBlock.get(offer.blockId) ?? [];
    offers.push(offer);
    offersByBlock.set(offer.blockId, offers);
  }
  offersByBlock.forEach((offers) => {
    offers.sort((left, right) => {
      const leftPriority = priorityKeys.has(referenceGroundingKey(left)) ? 0 : 1;
      const rightPriority = priorityKeys.has(referenceGroundingKey(right)) ? 0 : 1;
      return (
        leftPriority - rightPriority ||
        left.startOffset - right.startOffset ||
        right.quote.length - left.quote.length ||
        left.bindingId.localeCompare(right.bindingId)
      );
    });
  });

  const selected: CurriculumEvidenceOffer[] = [];
  let offerBudgetReached = false;
  for (let pass = 0; pass < REFERENCE_OFFERS_PER_BLOCK; pass += 1) {
    for (const blockId of selectedBlockIds) {
      const offer = offersByBlock.get(blockId)?.[pass];
      if (!offer) continue;
      selected.push({ ...offer, id: `E${selected.length + 1}` });
      if (selected.length >= REFERENCE_OFFER_BUDGET) {
        offerBudgetReached = true;
        break;
      }
    }
    if (offerBudgetReached) break;
  }
  return selected;
}

function makeSelectionOffers(blocks: readonly SourceBlock[]): CurriculumEvidenceOffer[] {
  return blocks.flatMap((candidate) =>
    ['Primary', 'Priority', 'Tertiary'].map((label) => {
      const quote = `${label} evidence ${candidate.id}.`;
      const startOffset = candidate.content.indexOf(quote);
      return {
        id: `catalog_${candidate.id}_${label.toLowerCase()}`,
        bindingId: `binding_${candidate.id}_${label.toLowerCase()}`,
        materialId: candidate.materialId,
        materialRevisionId: candidate.materialRevisionId,
        blockId: candidate.id,
        startOffset,
        endOffset: startOffset + quote.length,
        quote,
        headingPath: candidate.headingPath,
        pageNumber: candidate.pageNumber,
      };
    }),
  );
}

function conceptFor(candidate: SourceBlock): Concept {
  const quote = `Primary evidence ${candidate.id}.`;
  return {
    id: `concept_${candidate.id}`,
    materialId: candidate.materialId,
    materialRevisionId: candidate.materialRevisionId,
    name: candidate.id,
    summary: quote,
    importance: 'high',
    grounding: {
      blockId: candidate.id,
      quote,
      startOffset: 0,
      endOffset: quote.length,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

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

  it('does not promote explicitly derived OCR or visual descriptions into evidence offers', () => {
    for (const contentOrigin of ['derived_ocr', 'derived_visual_description'] as const) {
      expect(
        buildCurriculumEvidenceCatalog({
          workspaceId: 'ws_a',
          manifest,
          blocks: [{ ...block, contentOrigin }],
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
        }),
      ).toEqual([]);
    }
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

  it('uses spare production capacity for later excerpts in the same source block', () => {
    const fixture = createCourseMapFixture();
    const first = fixture.evidenceCatalog[0]!;
    const extras = [4, 8, 12].map((offset) => ({
      ...first,
      id: `extra-${offset}`,
      bindingId: `extra-${offset}`,
      startOffset: first.startOffset + offset,
      quote: first.quote.slice(offset),
    }));
    const selected = selectCurriculumEvidenceOffers({
      catalog: [...fixture.evidenceCatalog, ...extras],
      blocks: fixture.blocks,
      predecessor: null,
      concepts: fixture.concepts,
      priorityGroundings: [],
      contract: {
        workspaceId: fixture.workspaceId,
        intent: 'Understand the material',
        targetOutcome: { description: 'Explain the material' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      sourceMap: fixture.sourceMap,
      policy: 'allocated_source_v1',
    });
    expect(selected.filter((offer) => offer.blockId === first.blockId).length).toBeGreaterThan(2);
    for (const extra of extras)
      expect(selected.map((offer) => offer.bindingId)).toContain(extra.bindingId);
    expect(selected.length).toBeLessThanOrEqual(CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET);
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

  it('preserves the 0836849 production output byte-for-byte across mixed signals and budgets', () => {
    const blocks = Array.from({ length: 210 }, (_, index): SourceBlock => {
      const id = `mixed_${index.toString().padStart(3, '0')}`;
      const lexicalText =
        index === 40 || index === 41
          ? ' predecessoralpha'
          : index === 42 || index === 43
            ? ' predecessorbeta'
            : index >= 80 && index < 88
              ? ' contractomega'
              : '';
      const content =
        `Primary evidence ${id}. Priority evidence ${id}. Tertiary evidence ${id}.` + lexicalText;
      const materialSuffix = index < 105 ? 'a' : 'b';
      return {
        ...block,
        id,
        materialId: `mat_${materialSuffix}`,
        materialRevisionId: `rev_${materialSuffix}`,
        index: index % 105,
        heading: `Section ${index}`,
        headingPath: ['Section', index.toString()],
        content,
        endOffset: content.length,
      };
    });
    const catalog = makeSelectionOffers(blocks);
    const predecessor = {
      nodes: [
        {
          id: 'unit_alpha',
          kind: 'learning_unit',
          title: 'predecessoralpha',
          sourceReferences: [150, 151, 152, 153, 154, 155, 156].map((index) => ({
            sourceBlockId: `mixed_${index.toString().padStart(3, '0')}`,
          })),
          learningUnit: { objectives: [] },
        },
        {
          id: 'unit_beta',
          kind: 'learning_unit',
          title: 'predecessorbeta',
          sourceReferences: [
            { sourceBlockId: 'foreign_block' },
            { sourceBlockId: 'mixed_010' },
            { sourceBlockId: 'mixed_011' },
          ],
          learningUnit: { objectives: [] },
        },
      ],
    } as unknown as Curriculum;
    const priorityBlock = blocks[150]!;
    const priorityQuote = `Priority evidence ${priorityBlock.id}.`;
    const priorityStart = priorityBlock.content.indexOf(priorityQuote);
    const input: CurriculumEvidenceSelectionInput = {
      catalog,
      blocks,
      predecessor,
      concepts: [conceptFor(blocks[60]!), conceptFor(blocks[100]!)],
      contract: {
        intent: 'contractomega',
        targetOutcome: { description: 'contractomega' },
        courseScope: { includedTopics: ['contractomega'] },
      } as unknown as LearningContract,
      priorityGroundings: [
        {
          blockId: priorityBlock.id,
          quote: priorityQuote,
          startOffset: priorityStart,
          endOffset: priorityStart + priorityQuote.length,
          occurrenceCount: 1,
          reanchored: false,
        },
      ],
    };

    const reference = selectCurriculumEvidenceOffersAt0836849(input);
    const current = selectCurriculumEvidenceOffers(input);
    const traced = selectCurriculumEvidenceOffersWithTrace(input);

    expect(
      Buffer.from(JSON.stringify(current)).equals(Buffer.from(JSON.stringify(reference))),
    ).toBe(true);
    expect(new Set(current.map((offer) => offer.blockId)).size).toBe(REFERENCE_BLOCK_BUDGET);
    expect(current).toHaveLength(REFERENCE_OFFER_BUDGET);
    expect(current[0]?.quote).toBe(priorityQuote);
    for (const signal of [
      'predecessor_reference',
      'concept_grounding',
      'locality_neighbor',
      'predecessor_lexical',
      'contract_lexical',
      'section_balance',
    ] as const) {
      expect(
        traced.trace.signals.find((candidate) => candidate.signal === signal)
          ?.firstContributorBlockCount,
      ).toBeGreaterThan(0);
    }
  });

  it('preserves the 0836849 fallback output byte-for-byte', () => {
    const blocks = Array.from({ length: 100 }, (_, index): SourceBlock => {
      const id = `fallback_parity_${index.toString().padStart(3, '0')}`;
      const content = `Primary evidence ${id}. Priority evidence ${id}. Tertiary evidence ${id}.`;
      return {
        ...block,
        id,
        index,
        heading: 'Shared section',
        headingPath: ['Shared section'],
        content,
        endOffset: content.length,
      };
    });
    const input: CurriculumEvidenceSelectionInput = {
      catalog: makeSelectionOffers(blocks),
      blocks,
      predecessor: null,
      concepts: [],
      contract: {
        intent: 'absentneedle',
        targetOutcome: { description: 'absentneedle' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      priorityGroundings: [],
    };

    const reference = selectCurriculumEvidenceOffersAt0836849(input);
    const current = selectCurriculumEvidenceOffers(input);
    const traced = selectCurriculumEvidenceOffersWithTrace(input);

    expect(
      Buffer.from(JSON.stringify(current)).equals(Buffer.from(JSON.stringify(reference))),
    ).toBe(true);
    expect(new Set(current.map((offer) => offer.blockId))).toHaveLength(
      REFERENCE_MIN_FALLBACK_BLOCKS,
    );
    expect(
      traced.trace.signals.find((candidate) => candidate.signal === 'fallback')
        ?.firstContributorBlockCount,
    ).toBeGreaterThan(0);
  });

  it('exposes exact deterministic production signal rankings for offline evaluation', () => {
    const rankingBlock = (
      id: string,
      materialId: string,
      index: number,
      headingPath: string[],
      content: string,
    ): SourceBlock => ({
      ...block,
      id,
      materialId,
      materialRevisionId: `rev_${materialId}`,
      index,
      heading: headingPath.at(-1) ?? null,
      headingPath,
      content,
      endOffset: content.length,
    });
    const blocks = [
      rankingBlock('rank_z', 'mat_a', 0, ['A'], 'rankterm shared'),
      rankingBlock('rank_a', 'mat_a', 0, ['A'], 'rankterm shared'),
      rankingBlock('rank_m', 'mat_a', 2, ['A'], 'ordinary source'),
      rankingBlock('rank_b', 'mat_b', 0, ['B'], 'contractterm shared'),
      rankingBlock('rank_c', 'mat_b', 1, ['B'], 'contractterm shared'),
      rankingBlock('rank_d', 'mat_b', 2, ['C'], 'ordinary source'),
    ];
    const foreign = rankingBlock('rank_foreign', 'mat_foreign', 0, ['Foreign'], 'rankterm');
    const input = {
      blocks,
      predecessor: {
        nodes: [
          {
            id: 'unit_rank',
            kind: 'learning_unit',
            title: 'rankterm',
            sourceReferences: [
              { sourceBlockId: foreign.id },
              { sourceBlockId: 'rank_z' },
              { sourceBlockId: 'rank_a' },
              { sourceBlockId: 'rank_z' },
              { sourceBlockId: 'rank_m' },
              { sourceBlockId: 'rank_b' },
              { sourceBlockId: 'rank_c' },
            ],
            learningUnit: { objectives: [] },
          },
          {
            id: 'section_rank',
            kind: 'section',
            title: 'Ignored organization node',
            sourceReferences: [{ sourceBlockId: 'rank_d' }],
          },
        ],
      } as unknown as Curriculum,
      concepts: [conceptFor(blocks[2]!), conceptFor(foreign), conceptFor(blocks[2]!)],
      contract: {
        intent: 'contractterm',
        targetOutcome: { description: 'contractterm' },
        courseScope: { includedTopics: ['contractterm'] },
      } as unknown as LearningContract,
    };

    const rankings = buildCurriculumEvidenceSignalRankings(input);

    expect(buildCurriculumEvidenceSignalRankings(input)).toEqual(rankings);
    expect(rankings).toEqual([
      {
        signal: 'predecessor_reference',
        blockIds: ['rank_z', 'rank_a', 'rank_m', 'rank_b'],
      },
      { signal: 'concept_grounding', blockIds: ['rank_m'] },
      {
        signal: 'locality_neighbor',
        blockIds: ['rank_a', 'rank_z', 'rank_m', 'rank_b', 'rank_c'],
      },
      { signal: 'predecessor_lexical', blockIds: ['rank_a', 'rank_z'] },
      { signal: 'contract_lexical', blockIds: ['rank_b', 'rank_c'] },
      { signal: 'section_balance', blockIds: ['rank_z', 'rank_a', 'rank_b', 'rank_c', 'rank_d'] },
      {
        signal: 'fallback',
        blockIds: ['rank_z', 'rank_a', 'rank_m', 'rank_b', 'rank_c', 'rank_d'],
      },
    ]);
    expect(rankings.flatMap((ranking) => ranking.blockIds)).not.toContain(foreign.id);
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

  it('reserves an exact apply-procedure offer beyond the ordinary block budget', () => {
    const procedure = '必须：先检索 → 按权限过滤 → 再给模型。';
    const blocks = Array.from({ length: 170 }, (_, index): SourceBlock => {
      const content =
        index === 169
          ? `边界资料。${procedure}仅限这个来源语境。`
          : `Ordinary evidence ${index}. ${'bounded detail '.repeat(30)}`;
      return {
        ...block,
        id: `procedure_budget_block_${index}`,
        index,
        heading: `Section ${index}`,
        headingPath: [`Section ${index}`],
        content,
        endOffset: content.length,
      };
    });
    const procedureBlock = blocks.at(-1)!;
    const procedureStart = procedureBlock.content.indexOf(procedure);
    const procedureGrounding: VerifiedGrounding = {
      blockId: procedureBlock.id,
      quote: procedure,
      startOffset: procedureStart,
      endOffset: procedureStart + procedure.length,
      occurrenceCount: 1,
      reanchored: false,
    };
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
      preferredGroundings: [procedureGrounding],
    });
    const input: CurriculumEvidenceSelectionInput = {
      catalog,
      blocks,
      predecessor: null,
      concepts: [],
      contract: {
        intent: 'Master the bounded source',
        targetOutcome: { description: 'Explain and apply the core procedures' },
        courseScope: { includedTopics: [] },
      } as unknown as LearningContract,
      priorityGroundings: [],
    };

    expect(
      selectCurriculumEvidenceOffers(input).some(
        (offer) => offer.blockId === procedureBlock.id && offer.quote === procedure,
      ),
    ).toBe(false);

    const traced = selectCurriculumEvidenceOffersWithTrace({
      ...input,
      applyProcedureGroundings: [procedureGrounding],
    });

    expect(CURRICULUM_PROVIDER_APPLY_PROCEDURE_BLOCK_RESERVE).toBeGreaterThan(0);
    expect(traced.offers[0]).toMatchObject({
      id: 'E1',
      blockId: procedureBlock.id,
      quote: procedure,
    });
    expect(traced.trace.counts.candidateBlocks).toBe(CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET);
    expect(traced.trace.counts.offeredEvidence).toBeLessThanOrEqual(
      CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
    );
    expect(traced.trace.priorityOrdering).toMatchObject({
      effect: 'offer_ordering_and_apply_procedure_block_reserve',
      requestedApplyProcedureGroundingCount: 1,
      matchingApplyProcedureOfferCount: 1,
      reservedApplyProcedureBlockCount: 1,
      selectedApplyProcedureOfferCount: 1,
    });
    expect(traced.trace.blocks[0]).toMatchObject({
      blockId: procedureBlock.id,
      policySelectionReason: 'apply_procedure_reserve',
    });
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
