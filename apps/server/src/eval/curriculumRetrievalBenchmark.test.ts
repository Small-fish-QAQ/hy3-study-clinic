import { fnv1a32, type SourceBlockRevision } from '@hy3-clinic/shared';
import { describe, expect, it } from 'vitest';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { CURRICULUM_EVIDENCE_SELECTION_SIGNALS } from '../services/curriculumEvidence.js';
import { buildCourseSourceMap, type CourseSourceMapInput } from '../services/courseSourceMap.js';
import { curriculumSourceBlockFingerprint } from '../services/curriculumValidation.js';
import {
  evaluateCurriculumRetrievalBenchmark,
  type CurriculumRetrievalBenchmarkInput,
  type CurriculumRetrievalComparisonProfile,
} from './curriculumRetrievalBenchmark.js';

function sourceBlock(input: {
  id: string;
  materialId: string;
  revisionId: string;
  index: number;
  heading: string;
}): SourceBlockRevision {
  const content = `${input.id} exact current evidence for ${input.heading}. ${'Additional bounded source evidence. '.repeat(20)}`;
  const source = {
    id: input.id,
    materialId: input.materialId,
    materialRevisionId: input.revisionId,
    structuralUnitId: null,
    index: input.index,
    heading: input.heading,
    headingPath: [input.heading],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: input.index * 1_000,
    endOffset: input.index * 1_000 + content.length,
  };
  return {
    ...source,
    revisionFingerprint: curriculumSourceBlockFingerprint(source, input.revisionId),
  };
}

function sourceMapFixture(): {
  sourceMap: ReturnType<typeof buildCourseSourceMap>;
  blocks: SourceBlockRevision[];
} {
  const materialABlocks = [
    sourceBlock({
      id: 'block_a0',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 0,
      heading: 'Section One',
    }),
    ...Array.from({ length: 3 }, (_, offset) =>
      sourceBlock({
        id: `block_a${offset + 1}`,
        materialId: 'material_a',
        revisionId: 'revision_a',
        index: offset + 1,
        heading: 'Section Two',
      }),
    ),
  ];
  const materialBBlocks = Array.from({ length: 2 }, (_, index) =>
    sourceBlock({
      id: `block_b${index}`,
      materialId: 'material_b',
      revisionId: 'revision_b',
      index,
      heading: 'Section B',
    }),
  );
  const revisions = [
    {
      materialId: 'material_a',
      materialRevisionId: 'revision_a',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-material-a',
      sourceBlockRevisionIds: materialABlocks.map((block) => block.id),
    },
    {
      materialId: 'material_b',
      materialRevisionId: 'revision_b',
      parserVersion: 'parser-1',
      parserFingerprint: 'parser-material-b',
      sourceBlockRevisionIds: materialBBlocks.map((block) => block.id),
    },
  ];
  const material = (
    materialId: string,
    revisionId: string,
    title: string,
    blocks: SourceBlockRevision[],
    parserFingerprint: string,
  ): CourseSourceMapInput['materials'][number] => ({
    materialId,
    workspaceId: 'course_a',
    title,
    availability: 'active',
    activeRevisionId: revisionId,
    revision: {
      id: revisionId,
      materialId,
      status: 'active',
      parserVersion: 'parser-1',
      parserFingerprint,
    },
    blocks,
  });
  const input: CourseSourceMapInput = {
    workspaceId: 'course_a',
    manifest: {
      fingerprint: `manifest_${fnv1a32(JSON.stringify(revisions)).toString(16).padStart(8, '0')}`,
      revisions,
    },
    materials: [
      material('material_a', 'revision_a', 'Material A', materialABlocks, 'parser-material-a'),
      material('material_b', 'revision_b', 'Material B', materialBBlocks, 'parser-material-b'),
    ],
    concepts: [],
    predecessor: null,
  };
  return {
    sourceMap: buildCourseSourceMap(input),
    blocks: [...materialABlocks, ...materialBBlocks],
  };
}

function catalogFor(blocks: readonly SourceBlockRevision[]): CurriculumEvidenceOffer[] {
  return blocks.map((block) => ({
    id: `binding_${block.id}`,
    bindingId: `binding_${block.id}`,
    materialId: block.materialId,
    materialRevisionId: block.materialRevisionId,
    blockId: block.id,
    startOffset: 0,
    endOffset: block.content.length,
    quote: block.content,
    headingPath: [...block.headingPath],
    pageNumber: block.pageNumber,
  }));
}

function selectedOffer(
  catalog: readonly CurriculumEvidenceOffer[],
  blockId: string,
  index: number,
): CurriculumEvidenceOffer {
  const source = catalog.find((offer) => offer.blockId === blockId)!;
  return { ...source, id: `E${index}` };
}

function benchmarkInput(): CurriculumRetrievalBenchmarkInput {
  const { sourceMap, blocks } = sourceMapFixture();
  const catalog = catalogFor(blocks);
  const baselineIds = ['block_a1', 'block_a2', 'block_a3'];
  return {
    workspaceId: 'course_a',
    sourceMap,
    catalog,
    requiredBlockIds: ['block_a0', 'block_b0'],
    baseline: {
      candidateBlockIds: baselineIds,
      offers: baselineIds.map((blockId, index) => selectedOffer(catalog, blockId, index + 1)),
    },
    signalRankings: [
      { signal: 'predecessor_reference', blockIds: ['block_a1', 'block_a2'] },
      { signal: 'concept_grounding', blockIds: ['block_a2', 'block_a1'] },
      { signal: 'locality_neighbor', blockIds: ['block_a3', 'block_a0'] },
      { signal: 'predecessor_lexical', blockIds: ['block_a1'] },
      { signal: 'contract_lexical', blockIds: ['block_a2'] },
      { signal: 'section_balance', blockIds: ['block_a0', 'block_a1', 'block_b0'] },
      { signal: 'fallback', blockIds: ['block_b1', 'block_a3'] },
    ],
    budgets: {
      maxBlocks: 6,
      maxOffers: 6,
      maxOffersPerBlock: 2,
      maxSerializedBytes: 100_000,
    },
    policies: {
      sectionQuota: { reservePerSection: 2, maxBlocksPerSection: 3 },
      weightedRrf: {
        k: 60,
        weights: CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
          signal,
          weight: 1,
        })),
      },
      hierarchy: { minimumSelectedBlocksPerSection: 2 },
    },
    diagnosticGroups: [
      { name: 'predecessor_evidence', blockIds: ['block_a1', 'block_a2'] },
      { name: 'distant_sections', blockIds: ['block_b0', 'block_b1'] },
    ],
  };
}

function policy(
  result: ReturnType<typeof evaluateCurriculumRetrievalBenchmark>,
  name: CurriculumRetrievalComparisonProfile['policy'],
): CurriculumRetrievalComparisonProfile {
  return result.policies.find((profile) => profile.policy === name)!;
}

describe('evaluateCurriculumRetrievalBenchmark', () => {
  it('preserves the caller-supplied production baseline and repeats deterministically', () => {
    const input = benchmarkInput();
    const first = evaluateCurriculumRetrievalBenchmark(input);
    const repeated = evaluateCurriculumRetrievalBenchmark(structuredClone(input));

    expect(repeated).toEqual(first);
    expect(first.baseline.candidateBlockIds).toEqual(input.baseline.candidateBlockIds);
    expect(first.baseline.offers).toEqual(input.baseline.offers);
    expect(first.baseline.serialization).toEqual({
      serializedBytes: Buffer.byteLength(JSON.stringify(input.baseline.offers), 'utf8'),
      byteMethod: 'utf8_internal_offer_json_array',
      estimatedTokens: Math.ceil(
        Buffer.byteLength(JSON.stringify(input.baseline.offers), 'utf8') / 4,
      ),
      tokenEstimateMethod: 'estimate_ceil_utf8_bytes_div_4',
    });
    expect(first.methodology.aggregateBestScore).toBeNull();
    expect(first.policies.map((profile) => profile.policy)).toEqual([
      'serialized_byte_budget',
      'section_quota',
      'weighted_rrf',
      'hierarchy_organization',
    ]);
  });

  it('applies an exact UTF-8 JSON byte budget only at whole-offer boundaries', () => {
    const input = benchmarkInput();
    input.budgets.maxSerializedBytes = Buffer.byteLength(
      JSON.stringify(input.baseline.offers.slice(0, 2)),
      'utf8',
    );

    const result = evaluateCurriculumRetrievalBenchmark(input);
    const bounded = policy(result, 'serialized_byte_budget');

    expect(bounded.offers).toEqual(input.baseline.offers.slice(0, 2));
    expect(bounded.serialization.serializedBytes).toBe(input.budgets.maxSerializedBytes);
    expect(bounded.budgets.serializedByteBudgetSatisfied).toBe(true);
    expect(bounded.offers.every((offer) => offer.quote.length === offer.endOffset)).toBe(true);
    expect(bounded.recall.atSerializedByteBudget.serializedBytes).toBe(
      input.budgets.maxSerializedBytes,
    );
  });

  it('keeps alternative selections within the fixed per-block offer budget', () => {
    const input = benchmarkInput();
    input.budgets.maxOffers = 12;
    input.budgets.maxOffersPerBlock = 1;
    input.catalog.push(
      ...input.catalog.map((offer) => ({
        ...offer,
        id: `alternate_${offer.bindingId}`,
        bindingId: `alternate_${offer.bindingId}`,
        startOffset: 1,
        quote: offer.quote.slice(1),
      })),
    );

    const result = evaluateCurriculumRetrievalBenchmark(input);

    for (const candidate of result.policies.filter(
      (profile) => profile.policy === 'section_quota' || profile.policy === 'weighted_rrf',
    )) {
      expect(candidate.offers.length).toBe(candidate.counts.offeredBlockCount);
    }
  });

  it('reserves source-order sections and redistributes unused reserve under the same caps', () => {
    const input = benchmarkInput();
    const result = evaluateCurriculumRetrievalBenchmark(input);
    const quota = policy(result, 'section_quota');

    expect(quota.candidateBlockIds).toEqual([
      'block_a0',
      'block_a1',
      'block_b0',
      'block_a2',
      'block_b1',
      'block_a3',
    ]);
    expect(quota.candidateTrace.map((trace) => trace.selectionReason)).toEqual([
      'section_reserve',
      'section_reserve',
      'section_reserve',
      'section_reserve',
      'section_reserve',
      'ranked_redistribution',
    ]);
    expect(quota.balance.sections.candidateCoverageRatio).toBe(1);
    expect(quota.balance.sections.candidateBlocksPerGroup.max).toBe(3);
    expect(quota.counts.candidateBlockCount).toBe(input.budgets.maxBlocks);
  });

  it('uses stable source identity ties and retains named weighted-RRF contributions', () => {
    const input = benchmarkInput();
    input.baseline.candidateBlockIds = ['block_a1', 'block_a2'];
    input.baseline.offers = input.baseline.offers.slice(0, 2);
    input.budgets.maxBlocks = 2;
    input.budgets.maxOffers = 2;
    input.signalRankings = CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
      signal,
      blockIds:
        signal === 'predecessor_reference'
          ? ['block_a1', 'block_a2']
          : signal === 'concept_grounding'
            ? ['block_a2', 'block_a1']
            : [],
    }));
    input.policies.weightedRrf.weights = CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
      signal,
      weight: signal === 'predecessor_reference' || signal === 'concept_grounding' ? 1 : 0,
    }));

    const tied = policy(evaluateCurriculumRetrievalBenchmark(input), 'weighted_rrf');
    expect(tied.candidateBlockIds).toEqual(['block_a1', 'block_a2']);
    expect(tied.candidateTrace[0]!.score).toBe(tied.candidateTrace[1]!.score);
    expect(tied.candidateTrace[0]!.contributions).toEqual([
      { signal: 'predecessor_reference', rank: 1, contribution: 0.5 / 61 },
      { signal: 'concept_grounding', rank: 2, contribution: 0.5 / 62 },
    ]);
    expect(
      tied.attribution.signals.find((item) => item.signal === 'predecessor_reference'),
    ).toMatchObject({ candidateBlockCount: 2, firstContributorBlockCount: 2 });

    const conceptHeavy = structuredClone(input);
    conceptHeavy.policies.weightedRrf.weights = CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map(
      (signal) => ({
        signal,
        weight: signal === 'predecessor_reference' ? 0.1 : signal === 'concept_grounding' ? 0.9 : 0,
      }),
    );
    const predecessorHeavy = structuredClone(input);
    predecessorHeavy.policies.weightedRrf.weights = CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map(
      (signal) => ({
        signal,
        weight: signal === 'predecessor_reference' ? 0.9 : signal === 'concept_grounding' ? 0.1 : 0,
      }),
    );

    expect(
      policy(evaluateCurriculumRetrievalBenchmark(conceptHeavy), 'weighted_rrf')
        .candidateBlockIds[0],
    ).toBe('block_a2');
    expect(
      policy(evaluateCurriculumRetrievalBenchmark(predecessorHeavy), 'weighted_rrf')
        .candidateBlockIds[0],
    ).toBe('block_a1');

    const conceptOnly = structuredClone(input);
    conceptOnly.policies.weightedRrf.weights = CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map(
      (signal) => ({ signal, weight: signal === 'concept_grounding' ? 1 : 0 }),
    );
    const conceptOnlyProfile = policy(
      evaluateCurriculumRetrievalBenchmark(conceptOnly),
      'weighted_rrf',
    );
    expect(conceptOnlyProfile.candidateTrace.map((trace) => trace.firstContributor)).toEqual([
      'concept_grounding',
      'concept_grounding',
    ]);
    expect(
      conceptOnlyProfile.attribution.signals.find(
        (item) => item.signal === 'predecessor_reference',
      ),
    ).toMatchObject({ firstContributorBlockCount: 0, totalContribution: 0 });
  });

  it('organizes existing sections without replacing or inventing exact child evidence', () => {
    const input = benchmarkInput();
    const extra = selectedOffer(input.catalog, 'block_b0', 3);
    input.baseline.candidateBlockIds = ['block_a1', 'block_a2', 'block_b0'];
    input.baseline.offers = [input.baseline.offers[0]!, input.baseline.offers[1]!, extra];

    const hierarchy = policy(evaluateCurriculumRetrievalBenchmark(input), 'hierarchy_organization');

    expect(hierarchy.hierarchy).not.toBeNull();
    expect(hierarchy.hierarchy!.organizedSectionCount).toBe(1);
    expect(hierarchy.hierarchy!.context.authority).toBe('organization_only');
    expect(hierarchy.hierarchy!.context.sections[0]).toMatchObject({
      authority: 'navigation_only',
      childBlockIds: ['block_a1', 'block_a2'],
    });
    expect(hierarchy.hierarchy!.context.sections[0]!.offers).toEqual(
      input.baseline.offers.slice(0, 2),
    );
    expect(hierarchy.hierarchy!.context.ungroupedOffers).toEqual([extra]);
    expect(hierarchy.hierarchy!.retainsEverySelectedOfferIdentity).toBe(true);
    expect(hierarchy.serialization.serializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(hierarchy.hierarchy!.context), 'utf8'),
    );
    expect(hierarchy.offers).toEqual(input.baseline.offers);
  });

  it('reports exact recall, baseline overlap, and diagnostic group retention separately', () => {
    const input = benchmarkInput();
    input.budgets.maxBlocks = 3;
    input.budgets.maxOffers = 3;
    input.policies.sectionQuota = { reservePerSection: 1, maxBlocksPerSection: 2 };

    const result = evaluateCurriculumRetrievalBenchmark(input);
    const quota = policy(result, 'section_quota');
    const distant = quota.diagnosticGroups.find((group) => group.name === 'distant_sections')!;

    expect(result.baseline.recall.candidate).toMatchObject({
      recalledRequiredBlockIds: [],
      missingRequiredBlockIds: ['block_a0', 'block_b0'],
      recall: 0,
    });
    expect(quota.recall.candidate).toMatchObject({
      recalledRequiredBlockIds: ['block_a0', 'block_b0'],
      recall: 1,
    });
    expect(quota.baselineOverlap.candidateBlockCount).toBe(1);
    expect(distant).toMatchObject({
      expectedBlockCount: 2,
      candidateRetainedBlockIds: ['block_b0'],
      candidateRetentionRatio: 0.5,
    });
  });

  it.each([
    {
      name: 'duplicate required identity',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.requiredBlockIds.push(input.requiredBlockIds[0]!);
      },
      error: /Required SourceBlock identities must be unique/u,
    },
    {
      name: 'unknown ranked block',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.signalRankings[0]!.blockIds.push('block_unknown');
      },
      error: /unknown or foreign SourceBlock/u,
    },
    {
      name: 'foreign Course map',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.workspaceId = 'course_foreign';
      },
      error: /foreign Course/u,
    },
    {
      name: 'foreign offer Material',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.catalog[0]!.materialId = 'material_foreign';
      },
      error: /foreign Material owner/u,
    },
    {
      name: 'stale offer revision',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.catalog[0]!.materialRevisionId = 'revision_old';
      },
      error: /stale MaterialRevision owner/u,
    },
    {
      name: 'duplicate offer binding',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.catalog.push(structuredClone(input.catalog[0]!));
      },
      error: /Catalog offer identities must be unique/u,
    },
    {
      name: 'invalid exact offer span',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.catalog[0]!.endOffset -= 1;
      },
      error: /not an exact current SourceBlock span/u,
    },
    {
      name: 'baseline offer outside exact catalog identity',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.baseline.offers[0]!.quote = 'Different exact-length fabricated text.';
        input.baseline.offers[0]!.endOffset = input.baseline.offers[0]!.quote.length;
      },
      error: /not an exact identity from the current catalog/u,
    },
    {
      name: 'baseline per-block offer budget overflow',
      mutate: (input: CurriculumRetrievalBenchmarkInput) => {
        input.budgets.maxOffersPerBlock = 1;
        const source = input.catalog.find(
          (offer) => offer.blockId === input.baseline.candidateBlockIds[0],
        )!;
        const second = {
          ...source,
          id: `alternate_${source.bindingId}`,
          bindingId: `alternate_${source.bindingId}`,
          startOffset: 1,
          quote: source.quote.slice(1),
        };
        input.catalog.push(second);
        input.baseline.offers.push({ ...second, id: 'E4' });
      },
      error: /fixed per-block offer budget/u,
    },
  ])('rejects $name before calculating a profile', ({ mutate, error }) => {
    const input = benchmarkInput();
    mutate(input);
    expect(() => evaluateCurriculumRetrievalBenchmark(input)).toThrow(error);
  });
});
