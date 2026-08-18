import {
  CurriculumSchema,
  fnv1a32,
  LearningContractSchema,
  type Concept,
  type Curriculum,
  type LearningContract,
  type SourceBlockRevision,
} from '@hy3-clinic/shared';
import { describe, expect, it } from 'vitest';
import { evaluateCurriculumRetrievalBenchmark } from '../eval/curriculumRetrievalBenchmark.js';
import { buildCourseSourceMap, type CourseSourceMapInput } from './courseSourceMap.js';
import {
  buildCurriculumEvidenceCatalog,
  buildCurriculumEvidenceSignalRankings,
  CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS,
  CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
  CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
  CURRICULUM_PROVIDER_OFFERS_PER_BLOCK,
  selectCurriculumEvidenceOffers,
  selectCurriculumEvidenceOffersWithTrace,
} from './curriculumEvidence.js';
import {
  CURRICULUM_EVIDENCE_BASELINE_POLICY,
  CURRICULUM_EVIDENCE_PRODUCTION_POLICY,
  CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
  selectDerivedSectionReserveCandidates,
} from './curriculumEvidencePolicy.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';

const WORKSPACE_ID = 'course_representative';
const NOW = '2026-08-18T00:00:00.000Z';
const REQUIRED_COMPANION_CASES = [
  { blockId: 'companion_000', label: 'initial conditions case' },
  { blockId: 'companion_013', label: 'boundary conditions case' },
  { blockId: 'companion_026', label: 'failure analysis case' },
  { blockId: 'companion_039', label: 'transfer conditions case' },
] as const;

function manifestFingerprint(revisions: CourseSourceMapInput['manifest']['revisions']): string {
  return `manifest_${fnv1a32(JSON.stringify(revisions)).toString(16).padStart(8, '0')}`;
}

function sourceBlock(input: {
  id: string;
  materialId: string;
  revisionId: string;
  index: number;
  heading: string;
  targetLength: number;
}): SourceBlockRevision {
  const prefix = `${input.id} exact labeled course evidence. `;
  const content = (prefix + 'Deterministic bounded context. '.repeat(20)).slice(
    0,
    input.targetLength,
  );
  const block = {
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
    ...block,
    revisionFingerprint: curriculumSourceBlockFingerprint(block, input.revisionId),
  };
}

function contract(): LearningContract {
  return LearningContractSchema.parse({
    id: 'contract_representative',
    workspaceId: WORKSPACE_ID,
    version: 1,
    predecessorId: null,
    intent: 'Retain foundation evidence and cover applied companion material.',
    targetOutcome: {
      description: 'Explain foundations and apply the companion cases.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Representative bounded retrieval'],
      materials: [
        {
          materialId: 'material_foundations',
          materialRoleAssignmentId: 'role_foundations',
          materialRoleAssignmentVersion: 1,
          role: 'course_material',
          disposition: 'included',
        },
        {
          materialId: 'material_companion',
          materialRoleAssignmentId: 'role_companion',
          materialRoleAssignmentVersion: 1,
          role: 'supplementary_reference',
          disposition: 'included',
        },
      ],
      includedTopics: ['Foundations', 'Companion cases'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: null,
    },
    status: 'learner_confirmed',
    proposedBy: 'learner',
    learnerConfirmedAt: NOW,
    createdAt: NOW,
  });
}

function predecessor(
  manifest: CourseSourceMapInput['manifest'],
  blocks: readonly SourceBlockRevision[],
): Curriculum {
  const referenced = blocks.slice(0, 150);
  const units = Array.from({ length: Math.ceil(referenced.length / 6) }, (_, unitIndex) => {
    const unitBlocks = referenced.slice(unitIndex * 6, unitIndex * 6 + 6);
    return {
      id: `predecessor_unit_${unitIndex}`,
      parentId: 'predecessor_course',
      kind: 'learning_unit' as const,
      index: unitIndex,
      title: `Foundation unit ${unitIndex}`,
      sourceReferences: unitBlocks.map((block) => ({
        materialId: block.materialId,
        materialRevisionId: block.materialRevisionId,
        structuralUnitId: null,
        sourceBlockId: block.id,
        sourceBlockRevisionFingerprint: block.revisionFingerprint,
      })),
      learningUnit: {
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            id: `predecessor_objective_${unitIndex}`,
            title: `Foundation objective ${unitIndex}`,
            description: `Use the exact foundation evidence for unit ${unitIndex}.`,
            truthPremiseStatus: 'unverified' as const,
            truthAuthorityRecordIds: [],
          },
        ],
        prerequisiteUnitIds: [],
        graphRelationIds: [],
        riskIds: [],
      },
    };
  });
  return CurriculumSchema.parse({
    id: 'curriculum_predecessor_representative',
    workspaceId: WORKSPACE_ID,
    contractVersionId: 'contract_previous',
    version: 1,
    predecessorId: null,
    status: 'accepted',
    executionSourceManifest: manifest,
    nodes: [
      {
        id: 'predecessor_course',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Representative predecessor',
        sourceReferences: [],
        learningUnit: null,
      },
      ...units,
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fixture',
    providerModel: null,
    createdAt: NOW,
    acceptedAt: NOW,
  });
}

function concept(id: string, block: SourceBlockRevision): Concept {
  const quote = block.content.slice(0, block.content.indexOf('.') + 1);
  return {
    id,
    materialId: block.materialId,
    materialRevisionId: block.materialRevisionId,
    name: id,
    summary: quote,
    importance: 'high',
    grounding: {
      blockId: block.id,
      quote,
      startOffset: 0,
      endOffset: quote.length,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: NOW,
  };
}

function fixture() {
  const foundationBlocks = Array.from({ length: 160 }, (_, index) =>
    sourceBlock({
      id: `foundation_${index.toString().padStart(3, '0')}`,
      materialId: 'material_foundations',
      revisionId: 'revision_foundations_current',
      index,
      heading: index < 120 ? 'Dense foundations' : 'Foundation transfer',
      targetLength: 140,
    }),
  );
  // One parser heading intentionally splits into several derived budgeting
  // sections, so raw heading balance cannot by itself prevent starvation.
  const companionBlocks = Array.from({ length: 52 }, (_, index) =>
    sourceBlock({
      id: `companion_${index.toString().padStart(3, '0')}`,
      materialId: 'material_companion',
      revisionId: 'revision_companion_current',
      index,
      heading: 'Companion cases',
      targetLength: 300,
    }),
  );
  for (const requirement of REQUIRED_COMPANION_CASES) {
    const block = companionBlocks.find((candidate) => candidate.id === requirement.blockId)!;
    block.content = `${requirement.label}. ${block.content}`.slice(0, 300);
    block.endOffset = block.startOffset + block.content.length;
    block.revisionFingerprint = curriculumSourceBlockFingerprint(block, block.materialRevisionId);
  }
  const revisions = [
    {
      materialId: 'material_foundations',
      materialRevisionId: 'revision_foundations_current',
      parserVersion: 'fixture-parser-1',
      parserFingerprint: 'fixture-parser-foundations',
      sourceBlockRevisionIds: foundationBlocks.map((block) => block.id),
    },
    {
      materialId: 'material_companion',
      materialRevisionId: 'revision_companion_current',
      parserVersion: 'fixture-parser-1',
      parserFingerprint: 'fixture-parser-companion',
      sourceBlockRevisionIds: companionBlocks.map((block) => block.id),
    },
  ];
  const manifest = { fingerprint: manifestFingerprint(revisions), revisions };
  const previous = predecessor(manifest, foundationBlocks);
  const concepts = [
    concept('concept_foundation_priority', foundationBlocks[3]!),
    concept('concept_foundation_transfer', foundationBlocks[130]!),
  ];
  const material = (
    materialId: string,
    revisionId: string,
    title: string,
    blocks: SourceBlockRevision[],
    parserFingerprint: string,
  ): CourseSourceMapInput['materials'][number] => ({
    materialId,
    workspaceId: WORKSPACE_ID,
    title,
    availability: 'active',
    activeRevisionId: revisionId,
    revision: {
      id: revisionId,
      materialId,
      status: 'active',
      parserVersion: 'fixture-parser-1',
      parserFingerprint,
    },
    blocks,
  });
  const sourceMap = buildCourseSourceMap({
    workspaceId: WORKSPACE_ID,
    manifest,
    materials: [
      material(
        'material_foundations',
        'revision_foundations_current',
        'Foundations',
        foundationBlocks,
        'fixture-parser-foundations',
      ),
      material(
        'material_companion',
        'revision_companion_current',
        'Companion',
        companionBlocks,
        'fixture-parser-companion',
      ),
    ],
    concepts,
    predecessor: previous,
  });
  const blocks = [...foundationBlocks, ...companionBlocks];
  const priorityGroundings = [
    concepts[0]!.grounding,
    {
      blockId: foundationBlocks[0]!.id,
      quote: foundationBlocks[0]!.content,
      startOffset: 0,
      endOffset: foundationBlocks[0]!.content.length,
      occurrenceCount: 1,
      reanchored: false,
    },
  ];
  const catalog = buildCurriculumEvidenceCatalog({
    workspaceId: WORKSPACE_ID,
    manifest,
    blocks,
    preferredGroundings: priorityGroundings,
  });
  return {
    blocks,
    catalog,
    concepts,
    contract: contract(),
    predecessor: previous,
    priorityGroundings,
    sourceMap,
  };
}

describe('representative multi-Material Curriculum evidence policy validation', () => {
  it('keeps priority evidence and fixed budgets while preventing derived-section starvation', () => {
    expect(CURRICULUM_EVIDENCE_PRODUCTION_POLICY).toBe(CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY);
    const input = fixture();
    const selectorInput = {
      catalog: input.catalog,
      blocks: input.blocks,
      predecessor: input.predecessor,
      concepts: input.concepts,
      contract: input.contract,
      priorityGroundings: input.priorityGroundings,
      sourceMap: input.sourceMap,
    };
    const baseline = selectCurriculumEvidenceOffersWithTrace({
      ...selectorInput,
      policy: CURRICULUM_EVIDENCE_BASELINE_POLICY,
    });
    const reserve = selectCurriculumEvidenceOffersWithTrace({
      ...selectorInput,
      policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
    });
    const repeated = selectCurriculumEvidenceOffersWithTrace({
      ...structuredClone(selectorInput),
      policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
    });
    expect(
      selectCurriculumEvidenceOffers({
        ...structuredClone(selectorInput),
        policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
      }),
    ).toEqual(reserve.offers);
    const baselineBlockIds = new Set(baseline.trace.blocks.map((block) => block.blockId));
    const reserveBlockIds = new Set(reserve.trace.blocks.map((block) => block.blockId));
    const labeledAtRiskBlockIds = REQUIRED_COMPANION_CASES.map(
      (requirement) => requirement.blockId,
    );
    const highPriorityPredecessorBlockIds = input.blocks.slice(0, 24).map((block) => block.id);
    const conceptBlockIds = input.concepts.map((item) => item.grounding.blockId);
    const retained = (ids: readonly string[], selected: ReadonlySet<string>) =>
      ids.filter((id) => selected.has(id));

    expect(input.blocks).toHaveLength(212);
    expect(input.sourceMap.sectionCount).toBe(11);
    expect(retained(labeledAtRiskBlockIds, baselineBlockIds)).toEqual([
      'companion_000',
      'companion_026',
    ]);
    expect(retained(labeledAtRiskBlockIds, reserveBlockIds)).toEqual(labeledAtRiskBlockIds);
    expect(retained(highPriorityPredecessorBlockIds, reserveBlockIds)).toEqual(
      highPriorityPredecessorBlockIds,
    );
    expect(retained(conceptBlockIds, reserveBlockIds)).toEqual(conceptBlockIds);
    expect(reserve.trace.diversity.candidateMaterials).toBe(
      baseline.trace.diversity.candidateMaterials,
    );
    const derivedSectionCoverage = (selected: ReadonlySet<string>) =>
      input.sourceMap.materials
        .flatMap((material) => material.sections)
        .filter((section) => section.sourceBlockIds.some((blockId) => selected.has(blockId)))
        .length;
    expect(derivedSectionCoverage(baselineBlockIds)).toBe(9);
    expect(derivedSectionCoverage(reserveBlockIds)).toBe(11);
    expect(reserve.trace.counts.candidateBlocks).toBe(CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET);
    expect(reserve.trace.counts.offeredEvidence).toBeLessThanOrEqual(
      CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
    );
    expect(baseline.trace.counts.offeredEvidence).toBe(161);
    expect(reserve.trace.counts.offeredEvidence).toBe(161);
    expect(baseline.trace.serialization.serializedInternalOfferBytes).toBe(69_661);
    expect(reserve.trace.serialization.serializedInternalOfferBytes).toBeLessThanOrEqual(
      baseline.trace.serialization.serializedInternalOfferBytes,
    );
    expect(
      Math.max(
        ...reserve.offers.map(
          (offer) =>
            reserve.offers.filter((candidate) => candidate.blockId === offer.blockId).length,
        ),
      ),
    ).toBeLessThanOrEqual(CURRICULUM_PROVIDER_OFFERS_PER_BLOCK);
    expect(
      reserve.offers.every((offer) => offer.quote.length <= CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS),
    ).toBe(true);
    expect(repeated).toEqual(reserve);
    expect(reserve.trace.priorityOrdering.selectedPriorityOfferCount).toBe(
      baseline.trace.priorityOrdering.selectedPriorityOfferCount,
    );
    expect(
      retained([...highPriorityPredecessorBlockIds, ...labeledAtRiskBlockIds], baselineBlockIds),
    ).toHaveLength(26);
    expect(
      retained([...highPriorityPredecessorBlockIds, ...labeledAtRiskBlockIds], reserveBlockIds),
    ).toHaveLength(28);

    const signalRankings = buildCurriculumEvidenceSignalRankings(selectorInput);
    const exactBaselineBytes = Buffer.byteLength(JSON.stringify(baseline.offers), 'utf8');
    const benchmark = evaluateCurriculumRetrievalBenchmark({
      workspaceId: WORKSPACE_ID,
      sourceMap: input.sourceMap,
      catalog: input.catalog,
      requiredBlockIds: [...highPriorityPredecessorBlockIds, ...labeledAtRiskBlockIds],
      baseline: {
        candidateBlockIds: baseline.trace.blocks.map((block) => block.blockId),
        offers: baseline.offers,
      },
      signalRankings,
      budgets: {
        maxBlocks: CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
        maxOffers: CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
        maxOffersPerBlock: CURRICULUM_PROVIDER_OFFERS_PER_BLOCK,
        maxSerializedBytes: exactBaselineBytes,
      },
      policies: {
        sectionQuota: {
          reservePerSection: 1,
          maxBlocksPerSection: null,
          protectBaselinePriority: true,
        },
        weightedRrf: {
          k: 60,
          weights: signalRankings.map((ranking) => ({ signal: ranking.signal, weight: 1 })),
        },
        hierarchy: { minimumSelectedBlocksPerSection: 2 },
      },
      diagnosticGroups: [
        { name: 'high_priority_predecessor', blockIds: highPriorityPredecessorBlockIds },
        { name: 'concept_grounded', blockIds: conceptBlockIds },
        { name: 'starved_sections', blockIds: labeledAtRiskBlockIds },
      ],
    });
    const quota = benchmark.policies.find((policy) => policy.policy === 'section_quota')!;
    const byteBound = quota.recall.atSerializedByteBudget;

    expect(quota.candidateBlockIds).toEqual(reserve.trace.blocks.map((block) => block.blockId));
    expect(quota.counts.candidateBlockCount).toBe(CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET);
    expect(quota.budgets.serializedByteBudgetSatisfied).toBe(true);
    expect(byteBound.serializedBytes).toBeLessThanOrEqual(exactBaselineBytes);
    expect(byteBound.selectedBlockCount).toBe(
      new Set(quota.offers.map((offer) => offer.blockId)).size,
    );
    expect(
      quota.offers.every((offer) =>
        input.catalog.some(
          (catalogOffer) =>
            catalogOffer.bindingId === offer.bindingId &&
            catalogOffer.quote === offer.quote &&
            catalogOffer.startOffset === offer.startOffset &&
            catalogOffer.endOffset === offer.endOffset,
        ),
      ),
    ).toBe(true);
  });

  it('retains protected baseline evidence when sections exceed the block budget', () => {
    const input = fixture();
    const protectedBlockId = 'companion_039';
    const selected = selectDerivedSectionReserveCandidates({
      sourceMap: input.sourceMap,
      baselineCandidateBlockIds: [protectedBlockId, 'foundation_001'],
      rankedBlockIds: [protectedBlockId, 'foundation_001'],
      protectedBaselineBlockIds: [protectedBlockId],
      maxBlocks: 2,
      reservePerSection: 1,
    });

    expect(input.sourceMap.sectionCount).toBeGreaterThan(2);
    expect(selected.blockIds).toHaveLength(2);
    expect(selected.blockIds).toContain(protectedBlockId);
    expect(selected.reasonByBlockId.get(protectedBlockId)).toBe('protected_baseline');
  });

  it('fails closed for a stale or foreign production projection', () => {
    const input = fixture();
    const stale = structuredClone(input.sourceMap);
    stale.materials[0]!.blocks[0]!.endOffset -= 1;
    expect(() =>
      selectCurriculumEvidenceOffersWithTrace({
        catalog: input.catalog,
        blocks: input.blocks,
        predecessor: input.predecessor,
        concepts: input.concepts,
        contract: input.contract,
        priorityGroundings: input.priorityGroundings,
        sourceMap: stale,
        policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
      }),
    ).toThrow(/stale, foreign, or out of source order/u);

    const foreign = structuredClone(input.sourceMap);
    foreign.workspaceId = 'course_foreign';
    expect(() =>
      selectCurriculumEvidenceOffersWithTrace({
        catalog: input.catalog,
        blocks: input.blocks,
        predecessor: input.predecessor,
        concepts: input.concepts,
        contract: input.contract,
        priorityGroundings: input.priorityGroundings,
        sourceMap: foreign,
        policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
      }),
    ).toThrow(/foreign Course/u);

    const incomplete = structuredClone(input.sourceMap);
    incomplete.materials[0]!.sections[0]!.sourceBlockIds.shift();
    expect(() =>
      selectCurriculumEvidenceOffersWithTrace({
        catalog: input.catalog,
        blocks: input.blocks,
        predecessor: input.predecessor,
        concepts: input.concepts,
        contract: input.contract,
        priorityGroundings: input.priorityGroundings,
        sourceMap: incomplete,
        policy: CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY,
      }),
    ).toThrow(/derived sections are incomplete/u);
  });
});
