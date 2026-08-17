import { z } from 'zod';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import {
  CURRICULUM_EVIDENCE_SELECTION_SIGNALS,
  type CurriculumEvidenceSelectionSignal,
  type CurriculumEvidenceSignalRanking,
} from '../services/curriculumEvidence.js';
import { CourseSourceMapSchema, type CourseSourceMap } from '../services/courseSourceMap.js';

const EvidenceOfferSchema = z
  .object({
    id: z.string().min(1),
    bindingId: z.string().min(1),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    blockId: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    quote: z.string().min(1),
    headingPath: z.array(z.string()),
    pageNumber: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((offer) => offer.endOffset > offer.startOffset, {
    message: 'Evidence offer endOffset must be greater than startOffset.',
  });

const SignalSchema = z.enum(CURRICULUM_EVIDENCE_SELECTION_SIGNALS);

const SignalRankingSchema = z
  .object({
    signal: SignalSchema,
    blockIds: z.array(z.string().min(1)).max(10_000),
  })
  .strict();

const DiagnosticGroupSchema = z
  .object({
    name: z.string().min(1).max(100),
    blockIds: z.array(z.string().min(1)).max(10_000),
  })
  .strict();

const RrfWeightSchema = z
  .object({
    signal: SignalSchema,
    weight: z.number().finite().nonnegative(),
  })
  .strict();

export const CurriculumRetrievalBenchmarkInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceMap: CourseSourceMapSchema,
    catalog: z.array(EvidenceOfferSchema).max(50_000),
    requiredBlockIds: z.array(z.string().min(1)).max(10_000),
    baseline: z
      .object({
        candidateBlockIds: z.array(z.string().min(1)).max(10_000),
        offers: z.array(EvidenceOfferSchema).max(50_000),
      })
      .strict(),
    signalRankings: z
      .array(SignalRankingSchema)
      .min(1)
      .max(CURRICULUM_EVIDENCE_SELECTION_SIGNALS.length),
    budgets: z
      .object({
        maxBlocks: z.number().int().nonnegative(),
        maxOffers: z.number().int().nonnegative(),
        maxOffersPerBlock: z.number().int().positive(),
        maxSerializedBytes: z.number().int().nonnegative(),
      })
      .strict(),
    policies: z
      .object({
        sectionQuota: z
          .object({
            reservePerSection: z.number().int().nonnegative(),
            maxBlocksPerSection: z.number().int().positive().nullable(),
          })
          .strict(),
        weightedRrf: z
          .object({
            k: z.number().int().positive().max(10_000),
            weights: z
              .array(RrfWeightSchema)
              .min(1)
              .max(CURRICULUM_EVIDENCE_SELECTION_SIGNALS.length),
          })
          .strict(),
        hierarchy: z
          .object({
            minimumSelectedBlocksPerSection: z.number().int().min(2).max(10_000),
          })
          .strict(),
      })
      .strict(),
    diagnosticGroups: z.array(DiagnosticGroupSchema).max(100),
  })
  .strict();

export type CurriculumRetrievalBenchmarkInput = z.input<
  typeof CurriculumRetrievalBenchmarkInputSchema
>;

type ParsedBenchmarkInput = z.output<typeof CurriculumRetrievalBenchmarkInputSchema>;
type SourceMapMaterial = CourseSourceMap['materials'][number];
type SourceMapBlock = SourceMapMaterial['blocks'][number];
type SourceMapSection = SourceMapMaterial['sections'][number];

export interface RetrievalCountDistribution {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
}

export interface RetrievalRecallPoint {
  recalledRequiredBlockIds: string[];
  missingRequiredBlockIds: string[];
  recall: number | null;
  selectedBlockCount: number;
}

export interface RetrievalSignalContribution {
  signal: CurriculumEvidenceSelectionSignal;
  rank: number;
  contribution: number | null;
}

export type RetrievalSelectionReason =
  | 'baseline'
  | 'byte_budget'
  | 'section_reserve'
  | 'ranked_redistribution'
  | 'source_order_redistribution'
  | 'weighted_rrf'
  | 'hierarchy_child';

export interface RetrievalCandidateTrace {
  blockId: string;
  courseSourceIndex: number;
  selectionIndex: number;
  selectionReason: RetrievalSelectionReason;
  firstContributor: CurriculumEvidenceSelectionSignal | null;
  score: number | null;
  contributions: RetrievalSignalContribution[];
}

export interface RetrievalHierarchySection {
  sectionId: string;
  materialId: string;
  materialRevisionId: string;
  title: string;
  boundaryProvenance: 'deterministic_compute_sections';
  titleProvenance: 'parser_heading_derived' | 'deterministic_synthetic';
  authority: 'navigation_only';
  childBlockIds: string[];
  offers: CurriculumEvidenceOffer[];
}

export interface RetrievalHierarchyContext {
  authority: 'organization_only';
  sections: RetrievalHierarchySection[];
  ungroupedOffers: CurriculumEvidenceOffer[];
}

interface GroupBalanceItem {
  id: string;
  materialId: string;
  eligibleBlockCount: number;
  candidateBlockCount: number;
  offeredBlockCount: number;
  candidateBlockRatio: number | null;
  offeredBlockRatio: number | null;
}

interface GroupBalanceProfile {
  eligibleCount: number;
  candidateCoveredCount: number;
  candidateCoverageRatio: number | null;
  offeredCoveredCount: number;
  offeredCoverageRatio: number | null;
  candidateBlocksPerGroup: RetrievalCountDistribution;
  offeredBlocksPerGroup: RetrievalCountDistribution;
  groups: GroupBalanceItem[];
}

interface DiagnosticRetentionProfile {
  name: string;
  expectedBlockCount: number;
  candidateRetainedBlockIds: string[];
  candidateRetentionRatio: number | null;
  offeredRetainedBlockIds: string[];
  offeredRetentionRatio: number | null;
}

interface SignalAttributionProfile {
  signal: CurriculumEvidenceSelectionSignal;
  attemptedBlockCount: number;
  candidateBlockCount: number;
  offeredBlockCount: number;
  firstContributorBlockCount: number;
  totalContribution: number | null;
}

export type CurriculumRetrievalPolicy =
  | 'baseline'
  | 'serialized_byte_budget'
  | 'section_quota'
  | 'weighted_rrf'
  | 'hierarchy_organization';

export interface CurriculumRetrievalComparisonProfile {
  policy: CurriculumRetrievalPolicy;
  authority: 'selection_scores_are_navigation_only';
  candidateBlockIds: string[];
  offers: CurriculumEvidenceOffer[];
  candidateTrace: RetrievalCandidateTrace[];
  counts: {
    eligibleBlockCount: number;
    requiredBlockCount: number;
    candidateBlockCount: number;
    offeredBlockCount: number;
    selectedOfferCount: number;
  };
  budgets: ParsedBenchmarkInput['budgets'] & {
    blockBudgetSatisfied: boolean;
    offerBudgetSatisfied: boolean;
    serializedByteBudgetSatisfied: boolean;
  };
  serialization: {
    serializedBytes: number;
    byteMethod: 'utf8_internal_offer_json_array' | 'utf8_hierarchy_organization_json';
    estimatedTokens: number;
    tokenEstimateMethod: 'estimate_ceil_utf8_bytes_div_4';
  };
  recall: {
    candidate: RetrievalRecallPoint;
    offered: RetrievalRecallPoint;
    atBlockBudget: RetrievalRecallPoint & { budgetBlocks: number };
    atSerializedByteBudget: RetrievalRecallPoint & {
      budgetBytes: number;
      serializedBytes: number;
      byteMethod: 'utf8_internal_offer_json_array' | 'utf8_hierarchy_organization_json';
    };
  };
  balance: {
    materials: GroupBalanceProfile;
    sections: GroupBalanceProfile;
  };
  attribution: {
    unattributedCandidateBlockCount: number;
    signals: SignalAttributionProfile[];
  };
  baselineOverlap: {
    candidateBlockCount: number;
    candidateBlockRatio: number | null;
    offeredBlockCount: number;
    offeredBlockRatio: number | null;
    offerBindingCount: number;
    offerBindingRatio: number | null;
  };
  diagnosticGroups: DiagnosticRetentionProfile[];
  policyConfiguration: {
    sectionReservePerSection: number | null;
    sectionMaxBlocksPerSection: number | null;
    rrfK: number | null;
    rrfWeights: Array<{
      signal: CurriculumEvidenceSelectionSignal;
      inputWeight: number;
      normalizedWeight: number;
    }>;
    hierarchyMinimumSelectedBlocksPerSection: number | null;
  };
  hierarchy: null | {
    context: RetrievalHierarchyContext;
    organizedSectionCount: number;
    exactChildBlockIds: string[];
    exactChildOfferBindingIds: string[];
    retainsEverySelectedOfferIdentity: boolean;
  };
}

export interface CurriculumRetrievalBenchmarkResult {
  schemaVersion: 1;
  workspaceId: string;
  sourceMapFingerprint: string;
  methodology: {
    comparisonProfileOnly: true;
    aggregateBestScore: null;
    exactIdentityAuthority: 'current_revision_source_blocks';
    rankScoreAuthority: 'navigation_only';
    byteMethod: 'exact_utf8_json';
    tokenMethod: 'estimate_ceil_utf8_bytes_div_4';
  };
  baseline: CurriculumRetrievalComparisonProfile;
  policies: CurriculumRetrievalComparisonProfile[];
}

interface SourceMapIndex {
  blocks: SourceMapBlock[];
  blockById: Map<string, SourceMapBlock>;
  materialById: Map<string, SourceMapMaterial>;
  sections: SourceMapSection[];
  sectionById: Map<string, SourceMapSection>;
  sectionByBlockId: Map<string, SourceMapSection>;
}

interface RrfScore {
  score: number;
  contributions: RetrievalSignalContribution[];
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function distribution(values: readonly number[]): RetrievalCountDistribution {
  if (values.length === 0) return { count: 0, min: null, max: null, mean: null, median: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median,
  };
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function tokenEstimate(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function exactOfferFieldsEqual(
  left: CurriculumEvidenceOffer,
  right: CurriculumEvidenceOffer,
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.materialId === right.materialId &&
    left.materialRevisionId === right.materialRevisionId &&
    left.blockId === right.blockId &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.quote === right.quote &&
    JSON.stringify(left.headingPath) === JSON.stringify(right.headingPath) &&
    left.pageNumber === right.pageNumber
  );
}

function validateSourceMap(sourceMap: CourseSourceMap, workspaceId: string): SourceMapIndex {
  if (sourceMap.workspaceId !== workspaceId) {
    throw new Error('Retrieval benchmark Course Source Map belongs to a foreign Course.');
  }
  if (sourceMap.materialCount !== sourceMap.materials.length) {
    throw new Error('Retrieval benchmark Course Source Map material count is incomplete.');
  }
  assertUnique(
    sourceMap.materials.map((material) => material.materialId),
    'Course Source Map Material identities',
  );
  assertUnique(
    sourceMap.materials.map((material) => material.activeMaterialRevisionId),
    'Course Source Map MaterialRevision identities',
  );

  const blocks: SourceMapBlock[] = [];
  const sections: SourceMapSection[] = [];
  let expectedCourseSourceIndex = 0;
  for (const [materialIndex, material] of sourceMap.materials.entries()) {
    if (material.sourceIndex !== materialIndex) {
      throw new Error('Course Source Map Material source order is not exact.');
    }
    if (
      material.blockCount !== material.blocks.length ||
      material.sectionCount !== material.sections.length
    ) {
      throw new Error('Course Source Map Material boundaries are incomplete.');
    }
    const flattenedSectionIds = material.sections.flatMap((section, sectionIndex) => {
      if (
        section.sectionIndex !== sectionIndex ||
        section.materialId !== material.materialId ||
        section.materialRevisionId !== material.activeMaterialRevisionId ||
        section.blockCount !== section.sourceBlockIds.length
      ) {
        throw new Error('Course Source Map contains a foreign or incomplete derived section.');
      }
      sections.push(section);
      return section.sourceBlockIds;
    });
    for (const [blockIndex, block] of material.blocks.entries()) {
      if (
        block.materialId !== material.materialId ||
        block.materialRevisionId !== material.activeMaterialRevisionId ||
        block.sourceIndex !== blockIndex ||
        block.courseSourceIndex !== expectedCourseSourceIndex
      ) {
        throw new Error('Course Source Map contains a foreign, stale, or misordered SourceBlock.');
      }
      if (flattenedSectionIds[blockIndex] !== block.sourceBlockId) {
        throw new Error(
          'Course Source Map section hierarchy does not retain exact SourceBlock order.',
        );
      }
      blocks.push(block);
      expectedCourseSourceIndex += 1;
    }
  }
  if (sourceMap.blockCount !== blocks.length || sourceMap.sectionCount !== sections.length) {
    throw new Error('Retrieval benchmark Course Source Map is incomplete.');
  }
  assertUnique(
    blocks.map((block) => block.sourceBlockId),
    'Course Source Map SourceBlock identities',
  );
  assertUnique(
    blocks.map((block) => block.sourceBlockRevisionFingerprint),
    'Course Source Map SourceBlock fingerprints',
  );
  assertUnique(
    sections.map((section) => section.id),
    'Course Source Map section identities',
  );

  const blockById = new Map(blocks.map((block) => [block.sourceBlockId, block]));
  const materialById = new Map(
    sourceMap.materials.map((material) => [material.materialId, material]),
  );
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const sectionByBlockId = new Map<string, SourceMapSection>();
  for (const section of sections) {
    for (const blockId of section.sourceBlockIds) {
      const block = blockById.get(blockId);
      if (!block || block.derivedSectionId !== section.id || sectionByBlockId.has(blockId)) {
        throw new Error(
          'Course Source Map has duplicate, unknown, or mismatched section ownership.',
        );
      }
      sectionByBlockId.set(blockId, section);
    }
  }
  return { blocks, blockById, materialById, sections, sectionById, sectionByBlockId };
}

function validateOffer(offer: CurriculumEvidenceOffer, index: SourceMapIndex): void {
  const block = index.blockById.get(offer.blockId);
  if (!block) throw new Error('Retrieval benchmark offer references an unknown SourceBlock.');
  if (offer.materialId !== block.materialId) {
    throw new Error('Retrieval benchmark offer has a foreign Material owner.');
  }
  if (offer.materialRevisionId !== block.materialRevisionId) {
    throw new Error('Retrieval benchmark offer has a stale MaterialRevision owner.');
  }
  const blockLength = block.endOffset - block.startOffset;
  if (
    offer.endOffset > blockLength ||
    offer.endOffset - offer.startOffset !== offer.quote.length ||
    JSON.stringify(offer.headingPath) !== JSON.stringify(block.headingPath) ||
    offer.pageNumber !== block.pageNumber
  ) {
    throw new Error('Retrieval benchmark offer is not an exact current SourceBlock span.');
  }
}

function orderedRankings(input: ParsedBenchmarkInput): CurriculumEvidenceSignalRanking[] {
  const rankingBySignal = new Map(input.signalRankings.map((ranking) => [ranking.signal, ranking]));
  return CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => rankingBySignal.get(signal)!);
}

function validateBenchmarkInput(input: ParsedBenchmarkInput, index: SourceMapIndex): void {
  assertUnique(input.requiredBlockIds, 'Required SourceBlock identities');
  assertUnique(input.baseline.candidateBlockIds, 'Baseline candidate SourceBlock identities');
  assertUnique(
    input.baseline.offers.map((offer) => offer.id),
    'Baseline offer identities',
  );
  assertUnique(
    input.baseline.offers.map((offer) => offer.bindingId),
    'Baseline offer bindings',
  );
  assertUnique(
    input.catalog.map((offer) => offer.id),
    'Catalog offer identities',
  );
  assertUnique(
    input.catalog.map((offer) => offer.bindingId),
    'Catalog offer bindings',
  );
  assertUnique(
    input.catalog.map(
      (offer) =>
        `${offer.blockId}\u0000${offer.startOffset}\u0000${offer.endOffset}\u0000${offer.quote}`,
    ),
    'Catalog exact offer spans',
  );
  if (input.baseline.candidateBlockIds.length > input.budgets.maxBlocks) {
    throw new Error('Baseline candidates exceed the fixed global block budget.');
  }
  if (input.baseline.offers.length > input.budgets.maxOffers) {
    throw new Error('Baseline offers exceed the fixed global offer budget.');
  }
  const baselineOfferCountByBlock = new Map<string, number>();
  for (const offer of input.baseline.offers) {
    const count = (baselineOfferCountByBlock.get(offer.blockId) ?? 0) + 1;
    if (count > input.budgets.maxOffersPerBlock) {
      throw new Error('Baseline offers exceed the fixed per-block offer budget.');
    }
    baselineOfferCountByBlock.set(offer.blockId, count);
  }
  for (const blockId of [...input.requiredBlockIds, ...input.baseline.candidateBlockIds]) {
    if (!index.blockById.has(blockId)) {
      throw new Error('Retrieval benchmark contains an unknown or foreign SourceBlock identity.');
    }
  }

  const catalogByBinding = new Map<string, CurriculumEvidenceOffer>();
  for (const offer of input.catalog) {
    validateOffer(offer, index);
    if (offer.id !== offer.bindingId) {
      throw new Error('Catalog offer identity must equal its immutable binding identity.');
    }
    catalogByBinding.set(offer.bindingId, offer);
  }
  const baselineCandidateIds = new Set(input.baseline.candidateBlockIds);
  for (const offer of input.baseline.offers) {
    validateOffer(offer, index);
    const catalogOffer = catalogByBinding.get(offer.bindingId);
    if (!catalogOffer || !exactOfferFieldsEqual(offer, catalogOffer)) {
      throw new Error('Baseline offer is not an exact identity from the current catalog.');
    }
    if (!baselineCandidateIds.has(offer.blockId)) {
      throw new Error('Baseline offer does not belong to a supplied production candidate.');
    }
  }

  assertUnique(
    input.signalRankings.map((ranking) => ranking.signal),
    'Signal ranking identities',
  );
  if (input.signalRankings.length !== CURRICULUM_EVIDENCE_SELECTION_SIGNALS.length) {
    throw new Error('Signal rankings must include every named production signal exactly once.');
  }
  for (const ranking of input.signalRankings) {
    assertUnique(ranking.blockIds, `${ranking.signal} ranked SourceBlock identities`);
    for (const blockId of ranking.blockIds) {
      if (!index.blockById.has(blockId)) {
        throw new Error(`Signal ${ranking.signal} contains an unknown or foreign SourceBlock.`);
      }
    }
  }

  const weights = input.policies.weightedRrf.weights;
  assertUnique(
    weights.map((weight) => weight.signal),
    'Weighted RRF signal identities',
  );
  if (
    weights.length !== CURRICULUM_EVIDENCE_SELECTION_SIGNALS.length ||
    weights.reduce((sum, weight) => sum + weight.weight, 0) <= 0
  ) {
    throw new Error(
      'Weighted RRF must provide every named signal and at least one positive weight.',
    );
  }
  if (
    input.policies.sectionQuota.maxBlocksPerSection !== null &&
    input.policies.sectionQuota.maxBlocksPerSection < input.policies.sectionQuota.reservePerSection
  ) {
    throw new Error('Section cap cannot be lower than the reserved block count.');
  }

  assertUnique(
    input.diagnosticGroups.map((group) => group.name),
    'Diagnostic group names',
  );
  for (const group of input.diagnosticGroups) {
    assertUnique(group.blockIds, `Diagnostic group ${group.name} SourceBlock identities`);
    for (const blockId of group.blockIds) {
      if (!index.blockById.has(blockId)) {
        throw new Error(`Diagnostic group ${group.name} contains an unknown SourceBlock.`);
      }
    }
  }
}

function rankingContributions(
  rankings: readonly CurriculumEvidenceSignalRanking[],
  normalizedWeightBySignal?: ReadonlyMap<CurriculumEvidenceSelectionSignal, number>,
  k?: number,
): Map<string, RetrievalSignalContribution[]> {
  const result = new Map<string, RetrievalSignalContribution[]>();
  for (const ranking of rankings) {
    for (const [position, blockId] of ranking.blockIds.entries()) {
      const contributions = result.get(blockId) ?? [];
      const rank = position + 1;
      const weight = normalizedWeightBySignal?.get(ranking.signal);
      contributions.push({
        signal: ranking.signal,
        rank,
        contribution: weight === undefined || k === undefined ? null : weight / (k + rank),
      });
      result.set(blockId, contributions);
    }
  }
  return result;
}

function rrfCandidateOrder(
  input: ParsedBenchmarkInput,
  index: SourceMapIndex,
): {
  blockIds: string[];
  scores: Map<string, RrfScore>;
  reportedWeights: CurriculumRetrievalComparisonProfile['policyConfiguration']['rrfWeights'];
} {
  const inputWeightBySignal = new Map(
    input.policies.weightedRrf.weights.map((weight) => [weight.signal, weight.weight]),
  );
  const totalWeight = [...inputWeightBySignal.values()].reduce((sum, weight) => sum + weight, 0);
  const normalizedWeightBySignal = new Map(
    CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => [
      signal,
      inputWeightBySignal.get(signal)! / totalWeight,
    ]),
  );
  const contributions = rankingContributions(
    orderedRankings(input),
    normalizedWeightBySignal,
    input.policies.weightedRrf.k,
  );
  const scores = new Map<string, RrfScore>();
  for (const [blockId, blockContributions] of contributions) {
    const score = blockContributions.reduce(
      (sum, contribution) => sum + (contribution.contribution ?? 0),
      0,
    );
    if (score > 0) scores.set(blockId, { score, contributions: blockContributions });
  }
  const blockIds = [...scores]
    .sort(([leftId, left], [rightId, right]) => {
      return (
        right.score - left.score ||
        index.blockById.get(leftId)!.courseSourceIndex -
          index.blockById.get(rightId)!.courseSourceIndex ||
        leftId.localeCompare(rightId)
      );
    })
    .slice(0, input.budgets.maxBlocks)
    .map(([blockId]) => blockId);
  return {
    blockIds,
    scores,
    reportedWeights: CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
      signal,
      inputWeight: inputWeightBySignal.get(signal)!,
      normalizedWeight: normalizedWeightBySignal.get(signal)!,
    })),
  };
}

function sectionQuotaCandidateOrder(
  input: ParsedBenchmarkInput,
  index: SourceMapIndex,
): { blockIds: string[]; reasonByBlock: Map<string, RetrievalSelectionReason> } {
  const rankedWithoutFallback = uniqueInOrder([
    ...input.baseline.candidateBlockIds,
    ...orderedRankings(input).flatMap((ranking) => ranking.blockIds),
  ]);
  const globalOrder = uniqueInOrder([
    ...rankedWithoutFallback,
    ...index.blocks.map((block) => block.sourceBlockId),
  ]);
  const orderIndex = new Map(globalOrder.map((blockId, position) => [blockId, position]));
  const rankedSet = new Set(rankedWithoutFallback);
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const selectedCountBySection = new Map<string, number>();
  const reasonByBlock = new Map<string, RetrievalSelectionReason>();
  const cap = input.policies.sectionQuota.maxBlocksPerSection ?? Number.POSITIVE_INFINITY;
  const candidatesBySection = new Map(
    index.sections.map((section) => [
      section.id,
      [...section.sourceBlockIds].sort(
        (left, right) =>
          orderIndex.get(left)! - orderIndex.get(right)! ||
          index.blockById.get(left)!.courseSourceIndex -
            index.blockById.get(right)!.courseSourceIndex ||
          left.localeCompare(right),
      ),
    ]),
  );
  const add = (blockId: string, reason: RetrievalSelectionReason): boolean => {
    if (selected.length >= input.budgets.maxBlocks || selectedSet.has(blockId)) return false;
    const section = index.sectionByBlockId.get(blockId)!;
    const sectionCount = selectedCountBySection.get(section.id) ?? 0;
    if (sectionCount >= cap) return false;
    selected.push(blockId);
    selectedSet.add(blockId);
    selectedCountBySection.set(section.id, sectionCount + 1);
    reasonByBlock.set(blockId, reason);
    return true;
  };

  for (
    let round = 0;
    round < input.policies.sectionQuota.reservePerSection &&
    selected.length < input.budgets.maxBlocks;
    round += 1
  ) {
    for (const section of index.sections) {
      const next = candidatesBySection
        .get(section.id)!
        .find((blockId) => !selectedSet.has(blockId));
      if (next) add(next, 'section_reserve');
      if (selected.length >= input.budgets.maxBlocks) break;
    }
  }

  for (const blockId of globalOrder) {
    if (selected.length >= input.budgets.maxBlocks) break;
    add(blockId, rankedSet.has(blockId) ? 'ranked_redistribution' : 'source_order_redistribution');
  }
  return { blockIds: selected, reasonByBlock };
}

function orderedCatalogByBlock(
  catalog: readonly CurriculumEvidenceOffer[],
): Map<string, CurriculumEvidenceOffer[]> {
  const result = new Map<string, CurriculumEvidenceOffer[]>();
  for (const offer of catalog) {
    const offers = result.get(offer.blockId) ?? [];
    offers.push(offer);
    result.set(offer.blockId, offers);
  }
  result.forEach((offers) =>
    offers.sort(
      (left, right) =>
        left.startOffset - right.startOffset ||
        right.quote.length - left.quote.length ||
        left.bindingId.localeCompare(right.bindingId),
    ),
  );
  return result;
}

function selectCatalogOffers(
  candidateBlockIds: readonly string[],
  input: ParsedBenchmarkInput,
): CurriculumEvidenceOffer[] {
  const byBlock = orderedCatalogByBlock(input.catalog);
  const selected: CurriculumEvidenceOffer[] = [];
  for (
    let pass = 0;
    pass < input.budgets.maxOffersPerBlock && selected.length < input.budgets.maxOffers;
    pass += 1
  ) {
    let foundAtPass = false;
    for (const blockId of candidateBlockIds) {
      const source = byBlock.get(blockId)?.[pass];
      if (!source) continue;
      foundAtPass = true;
      const offer = { ...source, id: `E${selected.length + 1}` };
      const attempted = [...selected, offer];
      if (serializedBytes(attempted) > input.budgets.maxSerializedBytes) return selected;
      selected.push(offer);
      if (selected.length >= input.budgets.maxOffers) break;
    }
    if (!foundAtPass) break;
  }
  return selected;
}

function hierarchyContext(
  offers: readonly CurriculumEvidenceOffer[],
  input: ParsedBenchmarkInput,
  index: SourceMapIndex,
): RetrievalHierarchyContext {
  const offeredBlockIds = new Set(offers.map((offer) => offer.blockId));
  const organizedSectionIds = new Set(
    index.sections
      .filter(
        (section) =>
          section.sourceBlockIds.filter((blockId) => offeredBlockIds.has(blockId)).length >=
          input.policies.hierarchy.minimumSelectedBlocksPerSection,
      )
      .map((section) => section.id),
  );
  const sections = index.sections
    .filter((section) => organizedSectionIds.has(section.id))
    .map((section): RetrievalHierarchySection => {
      const childBlockIds = section.sourceBlockIds.filter((blockId) =>
        offeredBlockIds.has(blockId),
      );
      const childSet = new Set(childBlockIds);
      return {
        sectionId: section.id,
        materialId: section.materialId,
        materialRevisionId: section.materialRevisionId,
        title: section.title,
        boundaryProvenance: section.boundaryProvenance,
        titleProvenance: section.titleProvenance,
        authority: section.authority,
        childBlockIds,
        offers: offers.filter((offer) => childSet.has(offer.blockId)),
      };
    });
  return {
    authority: 'organization_only',
    sections,
    ungroupedOffers: offers.filter(
      (offer) => !organizedSectionIds.has(index.sectionByBlockId.get(offer.blockId)!.id),
    ),
  };
}

function selectExistingOfferPrefix(
  offers: readonly CurriculumEvidenceOffer[],
  input: ParsedBenchmarkInput,
  bytesFor: (candidate: readonly CurriculumEvidenceOffer[]) => number,
): CurriculumEvidenceOffer[] {
  const selected: CurriculumEvidenceOffer[] = [];
  for (const offer of offers) {
    if (selected.length >= input.budgets.maxOffers) break;
    const attempted = [...selected, offer];
    if (bytesFor(attempted) > input.budgets.maxSerializedBytes) break;
    selected.push(offer);
  }
  return selected;
}

function recallPoint(
  blockIds: readonly string[],
  requiredBlockIds: readonly string[],
): RetrievalRecallPoint {
  const selected = new Set(blockIds);
  const recalledRequiredBlockIds = requiredBlockIds.filter((blockId) => selected.has(blockId));
  return {
    recalledRequiredBlockIds,
    missingRequiredBlockIds: requiredBlockIds.filter((blockId) => !selected.has(blockId)),
    recall: ratio(recalledRequiredBlockIds.length, requiredBlockIds.length),
    selectedBlockCount: selected.size,
  };
}

function groupBalance(
  groups: ReadonlyArray<{ id: string; materialId: string; sourceBlockIds: readonly string[] }>,
  candidateIds: ReadonlySet<string>,
  offeredIds: ReadonlySet<string>,
): GroupBalanceProfile {
  const items = groups.map((group): GroupBalanceItem => {
    const candidateBlockCount = group.sourceBlockIds.filter((blockId) =>
      candidateIds.has(blockId),
    ).length;
    const offeredBlockCount = group.sourceBlockIds.filter((blockId) =>
      offeredIds.has(blockId),
    ).length;
    return {
      id: group.id,
      materialId: group.materialId,
      eligibleBlockCount: group.sourceBlockIds.length,
      candidateBlockCount,
      offeredBlockCount,
      candidateBlockRatio: ratio(candidateBlockCount, group.sourceBlockIds.length),
      offeredBlockRatio: ratio(offeredBlockCount, group.sourceBlockIds.length),
    };
  });
  const candidateCoveredCount = items.filter((item) => item.candidateBlockCount > 0).length;
  const offeredCoveredCount = items.filter((item) => item.offeredBlockCount > 0).length;
  return {
    eligibleCount: items.length,
    candidateCoveredCount,
    candidateCoverageRatio: ratio(candidateCoveredCount, items.length),
    offeredCoveredCount,
    offeredCoverageRatio: ratio(offeredCoveredCount, items.length),
    candidateBlocksPerGroup: distribution(items.map((item) => item.candidateBlockCount)),
    offeredBlocksPerGroup: distribution(items.map((item) => item.offeredBlockCount)),
    groups: items,
  };
}

function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  return [...left].filter((value) => right.has(value)).length;
}

function largestByteBudgetPrefix(
  offers: readonly CurriculumEvidenceOffer[],
  maxBytes: number,
  bytesFor: (candidate: readonly CurriculumEvidenceOffer[]) => number,
): { offers: CurriculumEvidenceOffer[]; bytes: number } {
  let accepted: CurriculumEvidenceOffer[] = [];
  if (bytesFor(accepted) > maxBytes) return { offers: accepted, bytes: bytesFor(accepted) };
  for (const offer of offers) {
    const attempted = [...accepted, offer];
    if (bytesFor(attempted) > maxBytes) break;
    accepted = attempted;
  }
  return { offers: accepted, bytes: bytesFor(accepted) };
}

interface ProfileSpec {
  policy: CurriculumRetrievalPolicy;
  candidateBlockIds: string[];
  offers: CurriculumEvidenceOffer[];
  selectionReasonByBlock: Map<string, RetrievalSelectionReason>;
  rrfScores?: Map<string, RrfScore>;
  reportedRrfWeights?: CurriculumRetrievalComparisonProfile['policyConfiguration']['rrfWeights'];
  hierarchyContext?: RetrievalHierarchyContext;
}

function buildProfile(
  input: ParsedBenchmarkInput,
  index: SourceMapIndex,
  spec: ProfileSpec,
): CurriculumRetrievalComparisonProfile {
  const rankings = orderedRankings(input);
  const defaultContributions = rankingContributions(rankings);
  const candidateSet = new Set(spec.candidateBlockIds);
  const offeredBlockIds = uniqueInOrder(spec.offers.map((offer) => offer.blockId));
  const offeredSet = new Set(offeredBlockIds);
  const baselineCandidateSet = new Set(input.baseline.candidateBlockIds);
  const baselineOfferedSet = new Set(input.baseline.offers.map((offer) => offer.blockId));
  const baselineBindingSet = new Set(input.baseline.offers.map((offer) => offer.bindingId));
  const bindingSet = new Set(spec.offers.map((offer) => offer.bindingId));
  const candidateTrace = spec.candidateBlockIds.map((blockId, selectionIndex) => {
    const rrf = spec.rrfScores?.get(blockId);
    const contributions = rrf?.contributions ?? defaultContributions.get(blockId) ?? [];
    const firstContributor = rrf
      ? contributions.find((contribution) => (contribution.contribution ?? 0) > 0)?.signal
      : contributions[0]?.signal;
    return {
      blockId,
      courseSourceIndex: index.blockById.get(blockId)!.courseSourceIndex,
      selectionIndex,
      selectionReason: spec.selectionReasonByBlock.get(blockId) ?? 'baseline',
      firstContributor: firstContributor ?? null,
      score: rrf?.score ?? null,
      contributions,
    } satisfies RetrievalCandidateTrace;
  });
  const hierarchy = spec.hierarchyContext;
  const bytesFor = (offers: readonly CurriculumEvidenceOffer[]): number =>
    hierarchy ? serializedBytes(hierarchyContext(offers, input, index)) : serializedBytes(offers);
  const serializationValue = hierarchy ?? spec.offers;
  const exactBytes = serializedBytes(serializationValue);
  const byteMethod = hierarchy
    ? ('utf8_hierarchy_organization_json' as const)
    : ('utf8_internal_offer_json_array' as const);
  const atByteBudget = largestByteBudgetPrefix(
    spec.offers,
    input.budgets.maxSerializedBytes,
    bytesFor,
  );
  const materialGroups = input.sourceMap.materials.map((material) => ({
    id: material.materialId,
    materialId: material.materialId,
    sourceBlockIds: material.blocks.map((block) => block.sourceBlockId),
  }));
  const firstContributorCounts = new Map<CurriculumEvidenceSelectionSignal, number>();
  for (const trace of candidateTrace) {
    if (trace.firstContributor) {
      firstContributorCounts.set(
        trace.firstContributor,
        (firstContributorCounts.get(trace.firstContributor) ?? 0) + 1,
      );
    }
  }
  const signalAttribution = rankings.map((ranking): SignalAttributionProfile => ({
    signal: ranking.signal,
    attemptedBlockCount: ranking.blockIds.length,
    candidateBlockCount: ranking.blockIds.filter((blockId) => candidateSet.has(blockId)).length,
    offeredBlockCount: ranking.blockIds.filter((blockId) => offeredSet.has(blockId)).length,
    firstContributorBlockCount: firstContributorCounts.get(ranking.signal) ?? 0,
    totalContribution: spec.rrfScores
      ? candidateTrace.reduce(
          (sum, trace) =>
            sum +
            (trace.contributions.find((contribution) => contribution.signal === ranking.signal)
              ?.contribution ?? 0),
          0,
        )
      : null,
  }));
  const exactHierarchyChildBlockIds = hierarchy
    ? hierarchy.sections.flatMap((section) => section.childBlockIds)
    : [];
  const exactHierarchyOfferBindings = hierarchy
    ? [
        ...hierarchy.sections.flatMap((section) => section.offers.map((offer) => offer.bindingId)),
        ...hierarchy.ungroupedOffers.map((offer) => offer.bindingId),
      ]
    : [];

  return {
    policy: spec.policy,
    authority: 'selection_scores_are_navigation_only',
    candidateBlockIds: [...spec.candidateBlockIds],
    offers: [...spec.offers],
    candidateTrace,
    counts: {
      eligibleBlockCount: index.blocks.length,
      requiredBlockCount: input.requiredBlockIds.length,
      candidateBlockCount: candidateSet.size,
      offeredBlockCount: offeredSet.size,
      selectedOfferCount: spec.offers.length,
    },
    budgets: {
      ...input.budgets,
      blockBudgetSatisfied: candidateSet.size <= input.budgets.maxBlocks,
      offerBudgetSatisfied: spec.offers.length <= input.budgets.maxOffers,
      serializedByteBudgetSatisfied: exactBytes <= input.budgets.maxSerializedBytes,
    },
    serialization: {
      serializedBytes: exactBytes,
      byteMethod,
      estimatedTokens: tokenEstimate(exactBytes),
      tokenEstimateMethod: 'estimate_ceil_utf8_bytes_div_4',
    },
    recall: {
      candidate: recallPoint(spec.candidateBlockIds, input.requiredBlockIds),
      offered: recallPoint(offeredBlockIds, input.requiredBlockIds),
      atBlockBudget: {
        budgetBlocks: input.budgets.maxBlocks,
        ...recallPoint(
          spec.candidateBlockIds.slice(0, input.budgets.maxBlocks),
          input.requiredBlockIds,
        ),
      },
      atSerializedByteBudget: {
        budgetBytes: input.budgets.maxSerializedBytes,
        serializedBytes: atByteBudget.bytes,
        byteMethod,
        ...recallPoint(
          uniqueInOrder(atByteBudget.offers.map((offer) => offer.blockId)),
          input.requiredBlockIds,
        ),
      },
    },
    balance: {
      materials: groupBalance(materialGroups, candidateSet, offeredSet),
      sections: groupBalance(
        index.sections.map((section) => ({
          id: section.id,
          materialId: section.materialId,
          sourceBlockIds: section.sourceBlockIds,
        })),
        candidateSet,
        offeredSet,
      ),
    },
    attribution: {
      unattributedCandidateBlockCount: candidateTrace.filter(
        (trace) => trace.firstContributor === null,
      ).length,
      signals: signalAttribution,
    },
    baselineOverlap: {
      candidateBlockCount: overlapCount(candidateSet, baselineCandidateSet),
      candidateBlockRatio: ratio(
        overlapCount(candidateSet, baselineCandidateSet),
        baselineCandidateSet.size,
      ),
      offeredBlockCount: overlapCount(offeredSet, baselineOfferedSet),
      offeredBlockRatio: ratio(
        overlapCount(offeredSet, baselineOfferedSet),
        baselineOfferedSet.size,
      ),
      offerBindingCount: overlapCount(bindingSet, baselineBindingSet),
      offerBindingRatio: ratio(
        overlapCount(bindingSet, baselineBindingSet),
        baselineBindingSet.size,
      ),
    },
    diagnosticGroups: input.diagnosticGroups.map((group) => {
      const candidateRetainedBlockIds = group.blockIds.filter((blockId) =>
        candidateSet.has(blockId),
      );
      const offeredRetainedBlockIds = group.blockIds.filter((blockId) => offeredSet.has(blockId));
      return {
        name: group.name,
        expectedBlockCount: group.blockIds.length,
        candidateRetainedBlockIds,
        candidateRetentionRatio: ratio(candidateRetainedBlockIds.length, group.blockIds.length),
        offeredRetainedBlockIds,
        offeredRetentionRatio: ratio(offeredRetainedBlockIds.length, group.blockIds.length),
      };
    }),
    policyConfiguration: {
      sectionReservePerSection:
        spec.policy === 'section_quota' ? input.policies.sectionQuota.reservePerSection : null,
      sectionMaxBlocksPerSection:
        spec.policy === 'section_quota' ? input.policies.sectionQuota.maxBlocksPerSection : null,
      rrfK: spec.policy === 'weighted_rrf' ? input.policies.weightedRrf.k : null,
      rrfWeights: spec.reportedRrfWeights ?? [],
      hierarchyMinimumSelectedBlocksPerSection:
        spec.policy === 'hierarchy_organization'
          ? input.policies.hierarchy.minimumSelectedBlocksPerSection
          : null,
    },
    hierarchy: hierarchy
      ? {
          context: hierarchy,
          organizedSectionCount: hierarchy.sections.length,
          exactChildBlockIds: exactHierarchyChildBlockIds,
          exactChildOfferBindingIds: exactHierarchyOfferBindings,
          retainsEverySelectedOfferIdentity:
            exactHierarchyOfferBindings.length === spec.offers.length &&
            new Set(exactHierarchyOfferBindings).size === spec.offers.length &&
            spec.offers.every((offer) => exactHierarchyOfferBindings.includes(offer.bindingId)),
        }
      : null,
  };
}

/**
 * Compare bounded context policies offline. Source-map hierarchy and rank
 * scores organize current evidence only; neither can establish source truth.
 */
export function evaluateCurriculumRetrievalBenchmark(
  raw: CurriculumRetrievalBenchmarkInput,
): CurriculumRetrievalBenchmarkResult {
  const input = CurriculumRetrievalBenchmarkInputSchema.parse(raw);
  const index = validateSourceMap(input.sourceMap, input.workspaceId);
  validateBenchmarkInput(input, index);

  const baselineReason = new Map(
    input.baseline.candidateBlockIds.map((blockId) => [blockId, 'baseline' as const]),
  );
  const baseline = buildProfile(input, index, {
    policy: 'baseline',
    candidateBlockIds: input.baseline.candidateBlockIds,
    offers: input.baseline.offers,
    selectionReasonByBlock: baselineReason,
  });

  const byteBoundedOffers = selectExistingOfferPrefix(input.baseline.offers, input, (offers) =>
    serializedBytes(offers),
  );
  const bytePolicy = buildProfile(input, index, {
    policy: 'serialized_byte_budget',
    candidateBlockIds: input.baseline.candidateBlockIds,
    offers: byteBoundedOffers,
    selectionReasonByBlock: new Map(
      input.baseline.candidateBlockIds.map((blockId) => [blockId, 'byte_budget' as const]),
    ),
  });

  const quota = sectionQuotaCandidateOrder(input, index);
  const sectionPolicy = buildProfile(input, index, {
    policy: 'section_quota',
    candidateBlockIds: quota.blockIds,
    offers: selectCatalogOffers(quota.blockIds, input),
    selectionReasonByBlock: quota.reasonByBlock,
  });

  const rrf = rrfCandidateOrder(input, index);
  const rrfPolicy = buildProfile(input, index, {
    policy: 'weighted_rrf',
    candidateBlockIds: rrf.blockIds,
    offers: selectCatalogOffers(rrf.blockIds, input),
    selectionReasonByBlock: new Map(
      rrf.blockIds.map((blockId) => [blockId, 'weighted_rrf' as const]),
    ),
    rrfScores: rrf.scores,
    reportedRrfWeights: rrf.reportedWeights,
  });

  const hierarchyOffers = selectExistingOfferPrefix(input.baseline.offers, input, (offers) =>
    serializedBytes(hierarchyContext(offers, input, index)),
  );
  const organizedContext = hierarchyContext(hierarchyOffers, input, index);
  const hierarchyPolicy = buildProfile(input, index, {
    policy: 'hierarchy_organization',
    candidateBlockIds: input.baseline.candidateBlockIds,
    offers: hierarchyOffers,
    selectionReasonByBlock: new Map(
      input.baseline.candidateBlockIds.map((blockId) => [blockId, 'hierarchy_child' as const]),
    ),
    hierarchyContext: organizedContext,
  });

  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    sourceMapFingerprint: input.sourceMap.fingerprint,
    methodology: {
      comparisonProfileOnly: true,
      aggregateBestScore: null,
      exactIdentityAuthority: 'current_revision_source_blocks',
      rankScoreAuthority: 'navigation_only',
      byteMethod: 'exact_utf8_json',
      tokenMethod: 'estimate_ceil_utf8_bytes_div_4',
    },
    baseline,
    policies: [bytePolicy, sectionPolicy, rrfPolicy, hierarchyPolicy],
  };
}
