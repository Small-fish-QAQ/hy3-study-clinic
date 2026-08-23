import { createHash } from 'node:crypto';
import type {
  Concept,
  Curriculum,
  ExecutionSourceManifest,
  LearningContract,
  SourceBlock,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import type { CurriculumEvidenceOffer } from '../llm/provider.js';
import { verifyGrounding } from '../grounding/verify.js';
import { searchSourceBlocks } from '../retrieval/lexical.js';
import type { CourseSourceMap } from './courseSourceMap.js';
import {
  CURRICULUM_EVIDENCE_BASELINE_POLICY,
  selectDerivedSectionReserveCandidates,
  validateCourseSourceMapSelectionCorpus,
  type CurriculumEvidencePolicySelectionReason,
  type CurriculumEvidenceSelectorPolicy,
} from './curriculumEvidencePolicy.js';
import { curriculumTargetRequestsApplication } from './curriculumAuthority.js';

export const CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS = 320;
export const CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET = 160;
export const CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET = 240;
export const CURRICULUM_PROVIDER_OFFERS_PER_BLOCK = 2;
export const CURRICULUM_PROVIDER_APPLY_PROCEDURE_BLOCK_RESERVE = 8;
export const CURRICULUM_PREDECESSOR_REFS_PER_UNIT = 6;
const CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS = 64;
const CURRICULUM_PROVIDER_NEIGHBOR_RADIUS = 1;

interface CurriculumEvidenceCatalogInput {
  workspaceId: string;
  manifest: ExecutionSourceManifest;
  blocks: SourceBlock[];
  preferredGroundings: VerifiedGrounding[];
}

function safeChunkEnd(content: string, start: number): number {
  let end = Math.min(content.length, start + CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS);
  if (end < content.length) {
    const preferredStart = start + Math.floor(CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS * 0.6);
    const boundary = content.slice(preferredStart, end).search(/[。！？!?；;\n](?=\s|$)|\s(?=\S)/u);
    if (boundary >= 0) end = preferredStart + boundary + 1;
    const before = content.charCodeAt(end - 1);
    const after = content.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      end -= 1;
    }
  }
  return Math.max(start + 1, end);
}

function exactChunks(
  block: SourceBlock,
): Array<{ startOffset: number; endOffset: number; quote: string }> {
  const chunks: Array<{ startOffset: number; endOffset: number; quote: string }> = [];
  let start = 0;
  while (start < block.content.length) {
    const end = safeChunkEnd(block.content, start);
    chunks.push({ startOffset: start, endOffset: end, quote: block.content.slice(start, end) });
    start = end;
  }
  return chunks;
}

function offerId(input: {
  workspaceId: string;
  materialRevisionId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}): string {
  return `cev_${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 40)}`;
}

/**
 * Build the immutable evidence universe for one Curriculum logical operation.
 * Every offer is exact local text; preferred existing groundings are retained
 * in addition to deterministic bounded block excerpts.
 */
export function buildCurriculumEvidenceCatalog({
  workspaceId,
  manifest,
  blocks,
  preferredGroundings,
}: CurriculumEvidenceCatalogInput): CurriculumEvidenceOffer[] {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const revisionByBlockId = new Map<string, (typeof manifest.revisions)[number]>();
  for (const revision of manifest.revisions) {
    for (const blockId of revision.sourceBlockRevisionIds) {
      const block = blockById.get(blockId);
      if (
        block?.materialId === revision.materialId &&
        block.materialRevisionId === revision.materialRevisionId
      ) {
        revisionByBlockId.set(blockId, revision);
      }
    }
  }
  const exactByKey = new Map<string, { block: SourceBlock; grounding: VerifiedGrounding }>();

  const add = (block: SourceBlock, grounding: VerifiedGrounding): void => {
    if (!revisionByBlockId.has(block.id)) return;
    if (block.contentOrigin && block.contentOrigin !== 'extracted_original') return;
    if (grounding.quote.length > CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS) return;
    const verified = verifyGrounding(blocks, { blockId: block.id, quote: grounding.quote });
    if (!verified.ok || verified.grounding.blockId !== block.id) return;
    exactByKey.set(`${block.id}\u0000${verified.grounding.quote}`, {
      block,
      grounding: verified.grounding,
    });
  };

  for (const grounding of preferredGroundings) {
    const block = blockById.get(grounding.blockId);
    if (block) add(block, grounding);
  }
  for (const block of blocks) {
    if (!revisionByBlockId.has(block.id)) continue;
    for (const chunk of exactChunks(block)) {
      add(block, {
        blockId: block.id,
        quote: chunk.quote,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        occurrenceCount: 1,
        reanchored: false,
      });
    }
  }

  const ids = new Set<string>();
  return [...exactByKey.values()].map(({ block, grounding }) => {
    const revision = revisionByBlockId.get(block.id)!;
    const id = offerId({
      workspaceId,
      materialRevisionId: revision.materialRevisionId,
      blockId: block.id,
      startOffset: grounding.startOffset,
      endOffset: grounding.endOffset,
      quote: grounding.quote,
    });
    if (ids.has(id)) throw new Error('Curriculum evidence identity collision.');
    ids.add(id);
    return {
      id,
      bindingId: id,
      materialId: block.materialId,
      materialRevisionId: revision.materialRevisionId,
      blockId: block.id,
      startOffset: grounding.startOffset,
      endOffset: grounding.endOffset,
      quote: grounding.quote,
      headingPath: block.headingPath,
      pageNumber: block.pageNumber,
    };
  });
}

export interface CurriculumEvidenceSelectionInput {
  catalog: CurriculumEvidenceOffer[];
  blocks: SourceBlock[];
  predecessor: Curriculum | null;
  concepts: Concept[];
  contract: LearningContract;
  priorityGroundings: VerifiedGrounding[];
  applyProcedureGroundings?: VerifiedGrounding[];
  sourceMap?: CourseSourceMap;
  policy?: CurriculumEvidenceSelectorPolicy;
}

export const CURRICULUM_EVIDENCE_SELECTION_SIGNALS = [
  'predecessor_reference',
  'concept_grounding',
  'locality_neighbor',
  'predecessor_lexical',
  'contract_lexical',
  'section_balance',
  'fallback',
] as const;
export type CurriculumEvidenceSelectionSignal =
  (typeof CURRICULUM_EVIDENCE_SELECTION_SIGNALS)[number];

export interface CurriculumEvidenceSignalRanking {
  signal: CurriculumEvidenceSelectionSignal;
  blockIds: string[];
}

export interface CurriculumEvidenceBlockTrace {
  blockId: string;
  materialId: string;
  sectionKey: string;
  selectionIndex: number;
  firstContributor: CurriculumEvidenceSelectionSignal | null;
  signals: CurriculumEvidenceSelectionSignal[];
  policySelectionReason:
    'baseline_signal_order' | 'apply_procedure_reserve' | CurriculumEvidencePolicySelectionReason;
}

export interface CurriculumEvidenceSignalTrace {
  signal: CurriculumEvidenceSelectionSignal;
  attemptedBlockCount: number;
  selectedBlockCount: number;
  firstContributorBlockCount: number;
  budgetRejectedBlockCount: number;
}

export interface CurriculumEvidenceSelectionTrace {
  policy: CurriculumEvidenceSelectorPolicy;
  counts: {
    corpusBlocks: number;
    corpusMaterials: number;
    corpusSections: number;
    catalogBlocks: number;
    catalogOffers: number;
    candidateBlocks: number;
    offeredBlocks: number;
    offeredEvidence: number;
    overlapBlocks: number;
  };
  diversity: {
    candidateMaterials: number;
    candidateSections: number;
    materialCoverageRatio: number | null;
    sectionCoverageRatio: number | null;
  };
  serialization: {
    serializedInternalOfferBytes: number;
    byteMethod: 'utf8_internal_offer_json_array';
    estimatedTokens: number;
    tokenEstimateMethod: 'ceil_utf8_bytes_div_4';
  };
  budgets: {
    maxBlocks: number;
    maxOffers: number;
    maxOffersPerBlock: number;
    minFallbackBlocks: number;
    neighborRadius: number;
    maxExcerptChars: number;
  };
  priorityOrdering: {
    effect: 'offer_ordering_only' | 'offer_ordering_and_apply_procedure_block_reserve';
    requestedGroundingCount: number;
    uniqueGroundingCount: number;
    uniqueConceptGroundingCount: number;
    /** Current callers use this lane for predecessor authority excerpts. */
    uniqueNonConceptPriorityGroundingCount: number;
    matchingCatalogOfferCount: number;
    selectedPriorityOfferCount: number;
    selectedConceptPriorityOfferCount: number;
    selectedNonConceptPriorityOfferCount: number;
    selectedBlocksWithPriorityOffer: number;
    blocksWherePriorityChangedFirstOffer: number;
    requestedApplyProcedureGroundingCount: number;
    matchingApplyProcedureOfferCount: number;
    reservedApplyProcedureBlockCount: number;
    selectedApplyProcedureOfferCount: number;
  };
  signals: CurriculumEvidenceSignalTrace[];
  blocks: CurriculumEvidenceBlockTrace[];
}

export interface TracedCurriculumEvidenceSelection {
  offers: CurriculumEvidenceOffer[];
  trace: CurriculumEvidenceSelectionTrace;
}

interface InternalCurriculumEvidenceSelection {
  offers: CurriculumEvidenceOffer[];
  trace: CurriculumEvidenceSelectionTrace | null;
}

export interface CurriculumEvidenceRecallBudgetInput {
  offers: CurriculumEvidenceOffer[];
  requiredBlockIds: readonly string[];
  blockBudget: number;
  serializedByteBudget: number;
  estimatedTokenBudget: number;
}

export interface CurriculumEvidenceRecallPoint {
  recalledRequiredBlockIds: string[];
  missingRequiredBlockIds: string[];
  recall: number | null;
  includedBlockCount: number;
  includedOfferCount: number;
  serializedInternalOfferBytes: number;
  estimatedTokens: number;
}

export interface CurriculumEvidenceRecallAtBudgets {
  requiredBlockIds: string[];
  blockBudget: CurriculumEvidenceRecallPoint & { budget: number };
  serializedByteBudget: CurriculumEvidenceRecallPoint & {
    budgetBytes: number;
    budgetSatisfied: boolean;
    byteMethod: 'utf8_internal_offer_json_array';
  };
  estimatedTokenBudget: CurriculumEvidenceRecallPoint & {
    budgetTokens: number;
    budgetSatisfied: boolean;
    tokenEstimateMethod: 'ceil_utf8_bytes_div_4';
  };
}

function normalizedGroundingKey(grounding: Pick<VerifiedGrounding, 'blockId' | 'quote'>): string {
  return `${grounding.blockId}\u0000${grounding.quote}`;
}

function predecessorSearchText(node: Curriculum['nodes'][number]): string {
  return [
    node.title,
    ...(node.learningUnit?.objectives.flatMap((objective) => [
      objective.title,
      objective.description,
    ]) ?? []),
  ].join(' ');
}

function sectionKey(block: Pick<SourceBlock, 'materialId' | 'headingPath'>): string {
  return `${block.materialId}\u0000${block.headingPath.join('\u0001')}`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function serializedInternalOfferBytes(offers: readonly CurriculumEvidenceOffer[]): number {
  return Buffer.byteLength(JSON.stringify(offers), 'utf8');
}

function estimatedTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function requireBudget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Expose the production selector's named rank channels for offline evaluation.
 * The channels contain current-corpus identities only and do not grant source
 * or semantic authority. Production still applies its existing global budget
 * while consuming these channels in the established order below.
 */
export function buildCurriculumEvidenceSignalRankings({
  blocks,
  predecessor,
  concepts,
  contract,
}: Pick<
  CurriculumEvidenceSelectionInput,
  'blocks' | 'predecessor' | 'concepts' | 'contract'
>): CurriculumEvidenceSignalRanking[] {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const orderedByMaterial = new Map<string, SourceBlock[]>();
  for (const block of blocks) {
    const materialBlocks = orderedByMaterial.get(block.materialId) ?? [];
    materialBlocks.push(block);
    orderedByMaterial.set(block.materialId, materialBlocks);
  }
  orderedByMaterial.forEach((materialBlocks) =>
    materialBlocks.sort(
      (left, right) => left.index - right.index || left.id.localeCompare(right.id),
    ),
  );

  const selectedForProductionOrder = new Set<string>();
  const rankings = new Map<CurriculumEvidenceSelectionSignal, string[]>(
    CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => [signal, []]),
  );
  const addRanking = (
    signal: CurriculumEvidenceSelectionSignal,
    blockIds: readonly string[],
  ): void => {
    const currentIds = uniqueInOrder(blockIds.filter((blockId) => blockById.has(blockId)));
    rankings.set(signal, currentIds);
    for (const blockId of currentIds) {
      if (selectedForProductionOrder.size >= CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET) break;
      selectedForProductionOrder.add(blockId);
    }
  };

  addRanking(
    'predecessor_reference',
    predecessor?.nodes
      .filter((candidate) => candidate.kind === 'learning_unit')
      .flatMap((node) =>
        node.sourceReferences
          .slice(0, CURRICULUM_PREDECESSOR_REFS_PER_UNIT)
          .flatMap((ref) => (ref.sourceBlockId ? [ref.sourceBlockId] : [])),
      ) ?? [],
  );
  addRanking(
    'concept_grounding',
    concepts.map((concept) => concept.grounding.blockId),
  );

  const localityBlockIds: string[] = [];
  for (const blockId of [...selectedForProductionOrder]) {
    const block = blockById.get(blockId)!;
    const siblings = orderedByMaterial.get(block.materialId) ?? [];
    const position = siblings.findIndex((candidate) => candidate.id === blockId);
    for (
      let offset = -CURRICULUM_PROVIDER_NEIGHBOR_RADIUS;
      offset <= CURRICULUM_PROVIDER_NEIGHBOR_RADIUS;
      offset += 1
    ) {
      const neighbor = siblings[position + offset];
      if (neighbor) localityBlockIds.push(neighbor.id);
    }
  }
  addRanking('locality_neighbor', localityBlockIds);

  addRanking(
    'predecessor_lexical',
    predecessor?.nodes
      .filter((candidate) => candidate.kind === 'learning_unit')
      .flatMap((node) =>
        searchSourceBlocks(blocks, predecessorSearchText(node), { limit: 2 }).map(
          (result) => result.blockId,
        ),
      ) ?? [],
  );
  const contractQuery = [
    contract.intent,
    contract.targetOutcome.description,
    ...contract.courseScope.includedTopics,
  ].join(' ');
  addRanking(
    'contract_lexical',
    searchSourceBlocks(blocks, contractQuery).map((result) => result.blockId),
  );

  const sectionGroups = new Map<string, SourceBlock[]>();
  for (const block of blocks) {
    const key = sectionKey(block);
    const group = sectionGroups.get(key) ?? [];
    group.push(block);
    sectionGroups.set(key, group);
  }
  addRanking(
    'section_balance',
    [...sectionGroups.values()].flatMap((group) => [
      group[0]!.id,
      group[Math.floor(group.length / 2)]!.id,
    ]),
  );

  if (
    selectedForProductionOrder.size < CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS &&
    blocks.length > 0
  ) {
    const stride = blocks.length / CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS;
    addRanking(
      'fallback',
      Array.from(
        { length: CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS },
        (_unused, index) => blocks[Math.min(blocks.length - 1, Math.floor(index * stride))]!.id,
      ),
    );
  }

  return CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
    signal,
    blockIds: rankings.get(signal)!,
  }));
}

function recallPoint(
  offers: CurriculumEvidenceOffer[],
  requiredBlockIds: string[],
): CurriculumEvidenceRecallPoint {
  const includedBlockIds = new Set(offers.map((offer) => offer.blockId));
  const recalledRequiredBlockIds = requiredBlockIds.filter((id) => includedBlockIds.has(id));
  const missingRequiredBlockIds = requiredBlockIds.filter((id) => !includedBlockIds.has(id));
  const bytes = serializedInternalOfferBytes(offers);
  return {
    recalledRequiredBlockIds,
    missingRequiredBlockIds,
    recall:
      requiredBlockIds.length === 0
        ? null
        : recalledRequiredBlockIds.length / requiredBlockIds.length,
    includedBlockCount: includedBlockIds.size,
    includedOfferCount: offers.length,
    serializedInternalOfferBytes: bytes,
    estimatedTokens: estimatedTokensFromBytes(bytes),
  };
}

function largestSerializedPrefix(
  offers: CurriculumEvidenceOffer[],
  fits: (bytes: number) => boolean,
): CurriculumEvidenceOffer[] {
  let accepted: CurriculumEvidenceOffer[] = [];
  for (let count = 0; count <= offers.length; count += 1) {
    const candidate = offers.slice(0, count);
    if (!fits(serializedInternalOfferBytes(candidate))) break;
    accepted = candidate;
  }
  return accepted;
}

/**
 * Exact block-ID recall over the already-ranked internal offers. Byte budgets
 * use the internal offer JSON array exactly; token budgets are explicitly
 * estimates (`ceil(bytes / 4)`), never provider request or usage telemetry.
 */
export function evaluateCurriculumEvidenceRecallAtBudgets({
  offers,
  requiredBlockIds,
  blockBudget,
  serializedByteBudget,
  estimatedTokenBudget,
}: CurriculumEvidenceRecallBudgetInput): CurriculumEvidenceRecallAtBudgets {
  const checkedBlockBudget = requireBudget(blockBudget, 'blockBudget');
  const checkedByteBudget = requireBudget(serializedByteBudget, 'serializedByteBudget');
  const checkedTokenBudget = requireBudget(estimatedTokenBudget, 'estimatedTokenBudget');
  const required = uniqueInOrder(requiredBlockIds);
  const orderedBlocks = uniqueInOrder(offers.map((offer) => offer.blockId));
  const blockIdsWithinBudget = new Set(orderedBlocks.slice(0, checkedBlockBudget));
  const blockBudgetOffers = offers.filter((offer) => blockIdsWithinBudget.has(offer.blockId));
  const byteBudgetOffers = largestSerializedPrefix(offers, (bytes) => bytes <= checkedByteBudget);
  const tokenBudgetOffers = largestSerializedPrefix(
    offers,
    (bytes) => estimatedTokensFromBytes(bytes) <= checkedTokenBudget,
  );

  return {
    requiredBlockIds: required,
    blockBudget: {
      budget: checkedBlockBudget,
      ...recallPoint(blockBudgetOffers, required),
    },
    serializedByteBudget: {
      budgetBytes: checkedByteBudget,
      budgetSatisfied: serializedInternalOfferBytes(byteBudgetOffers) <= checkedByteBudget,
      byteMethod: 'utf8_internal_offer_json_array',
      ...recallPoint(byteBudgetOffers, required),
    },
    estimatedTokenBudget: {
      budgetTokens: checkedTokenBudget,
      budgetSatisfied:
        estimatedTokensFromBytes(serializedInternalOfferBytes(tokenBudgetOffers)) <=
        checkedTokenBudget,
      tokenEstimateMethod: 'ceil_utf8_bytes_div_4',
      ...recallPoint(tokenBudgetOffers, required),
    },
  };
}

/**
 * Select provider candidates without granting them authority. Exact bindings
 * remain in the full local catalog; this function only limits what Hy3 sees.
 */
function selectCurriculumEvidenceOffersInternal(
  {
    catalog,
    blocks,
    predecessor,
    concepts,
    contract,
    priorityGroundings,
    applyProcedureGroundings = [],
    sourceMap,
    policy = CURRICULUM_EVIDENCE_BASELINE_POLICY,
  }: CurriculumEvidenceSelectionInput,
  includeTrace: boolean,
): InternalCurriculumEvidenceSelection {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  if (sourceMap) {
    validateCourseSourceMapSelectionCorpus({
      workspaceId: contract.workspaceId,
      sourceMap,
      blocks,
    });
  }
  const rankings = buildCurriculumEvidenceSignalRankings({
    blocks,
    predecessor,
    concepts,
    contract,
  });
  const rankedBlockIds = uniqueInOrder(rankings.flatMap((ranking) => ranking.blockIds));
  const baselineCandidateBlockIds = rankedBlockIds.slice(
    0,
    CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
  );
  let selectedCandidateBlockIds = baselineCandidateBlockIds;
  let policyReasonByBlockId = new Map<
    string,
    'baseline_signal_order' | 'apply_procedure_reserve' | CurriculumEvidencePolicySelectionReason
  >(baselineCandidateBlockIds.map((blockId) => [blockId, 'baseline_signal_order']));
  if (policy !== CURRICULUM_EVIDENCE_BASELINE_POLICY) {
    if (!sourceMap) {
      throw new Error('The derived-section reserve policy requires a validated Course Source Map.');
    }
    const protectedBaselineBlockIds = new Set([
      ...rankings
        .filter(
          (ranking) =>
            ranking.signal === 'predecessor_reference' || ranking.signal === 'concept_grounding',
        )
        .flatMap((ranking) => ranking.blockIds),
      ...priorityGroundings.map((grounding) => grounding.blockId),
    ]);
    const reserved = selectDerivedSectionReserveCandidates({
      sourceMap,
      baselineCandidateBlockIds,
      rankedBlockIds,
      protectedBaselineBlockIds: baselineCandidateBlockIds.filter((blockId) =>
        protectedBaselineBlockIds.has(blockId),
      ),
      maxBlocks: CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
      reservePerSection: 1,
    });
    selectedCandidateBlockIds = reserved.blockIds;
    policyReasonByBlockId = reserved.reasonByBlockId;
  }
  const catalogKeys = new Set(catalog.map(normalizedGroundingKey));
  const matchingApplyProcedureGroundings = curriculumTargetRequestsApplication(
    contract.targetOutcome.description,
  )
    ? applyProcedureGroundings.filter(
        (grounding) =>
          blockById.has(grounding.blockId) && catalogKeys.has(normalizedGroundingKey(grounding)),
      )
    : [];
  const applyProcedureBlockIds = uniqueInOrder(
    matchingApplyProcedureGroundings.map((grounding) => grounding.blockId),
  ).slice(0, CURRICULUM_PROVIDER_APPLY_PROCEDURE_BLOCK_RESERVE);
  if (applyProcedureBlockIds.length > 0) {
    selectedCandidateBlockIds = uniqueInOrder([
      ...applyProcedureBlockIds,
      ...selectedCandidateBlockIds,
    ]).slice(0, CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET);
    for (const blockId of applyProcedureBlockIds) {
      if (selectedCandidateBlockIds.includes(blockId)) {
        policyReasonByBlockId.set(blockId, 'apply_procedure_reserve');
      }
    }
  }
  const selectedBlockIds = new Set(selectedCandidateBlockIds);
  const attemptedBySignal = includeTrace
    ? new Map(CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => [signal, new Set<string>()]))
    : null;
  const rejectedBySignal = includeTrace
    ? new Map(CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => [signal, new Set<string>()]))
    : null;
  const signalsByBlock = includeTrace
    ? new Map<string, Set<CurriculumEvidenceSelectionSignal>>()
    : null;
  const firstContributorByBlock = includeTrace
    ? new Map<string, CurriculumEvidenceSelectionSignal>()
    : null;
  if (includeTrace) {
    for (const blockId of selectedBlockIds) signalsByBlock!.set(blockId, new Set());
  }
  for (const ranking of rankings) {
    for (const blockId of ranking.blockIds) {
      if (!blockById.has(blockId)) continue;
      attemptedBySignal?.get(ranking.signal)!.add(blockId);
      if (!selectedBlockIds.has(blockId)) {
        rejectedBySignal?.get(ranking.signal)!.add(blockId);
        continue;
      }
      signalsByBlock?.get(blockId)!.add(ranking.signal);
      if (!firstContributorByBlock?.has(blockId)) {
        firstContributorByBlock?.set(blockId, ranking.signal);
      }
    }
  }

  const effectivePriorityGroundings = [...priorityGroundings, ...matchingApplyProcedureGroundings];
  const priorityKeys = new Set(effectivePriorityGroundings.map(normalizedGroundingKey));
  const applyProcedureKeys = new Set(matchingApplyProcedureGroundings.map(normalizedGroundingKey));
  const relevantOfferBlockIds = new Set([
    ...baselineCandidateBlockIds,
    ...selectedCandidateBlockIds,
  ]);
  const offersByBlock = new Map<string, CurriculumEvidenceOffer[]>();
  for (const offer of catalog) {
    if (!relevantOfferBlockIds.has(offer.blockId)) continue;
    const offers = offersByBlock.get(offer.blockId) ?? [];
    offers.push(offer);
    offersByBlock.set(offer.blockId, offers);
  }
  let blocksWherePriorityChangedFirstOffer = 0;
  offersByBlock.forEach((offers) => {
    const unprioritizedFirst = includeTrace
      ? [...offers].sort(
          (left, right) =>
            left.startOffset - right.startOffset ||
            right.quote.length - left.quote.length ||
            left.bindingId.localeCompare(right.bindingId),
        )[0]?.bindingId
      : undefined;
    offers.sort((left, right) => {
      const leftPriority = priorityKeys.has(normalizedGroundingKey(left)) ? 0 : 1;
      const rightPriority = priorityKeys.has(normalizedGroundingKey(right)) ? 0 : 1;
      return (
        leftPriority - rightPriority ||
        left.startOffset - right.startOffset ||
        right.quote.length - left.quote.length ||
        left.bindingId.localeCompare(right.bindingId)
      );
    });
    if (
      includeTrace &&
      selectedBlockIds.has(offers[0]!.blockId) &&
      offers[0]?.bindingId !== unprioritizedFirst
    ) {
      blocksWherePriorityChangedFirstOffer += 1;
    }
  });

  const selectOffers = (candidateBlockIds: readonly string[]): CurriculumEvidenceOffer[] => {
    const offers: CurriculumEvidenceOffer[] = [];
    let offerBudgetReached = false;
    for (let pass = 0; pass < CURRICULUM_PROVIDER_OFFERS_PER_BLOCK; pass += 1) {
      for (const blockId of candidateBlockIds) {
        const offer = offersByBlock.get(blockId)?.[pass];
        if (!offer) continue;
        offers.push({ ...offer, id: `E${offers.length + 1}` });
        if (offers.length >= CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET) {
          offerBudgetReached = true;
          break;
        }
      }
      if (offerBudgetReached) break;
    }
    return offers;
  };
  const baselineOffers = selectOffers(baselineCandidateBlockIds);
  const policyOffers = selectOffers(selectedCandidateBlockIds);
  const selected =
    policy === CURRICULUM_EVIDENCE_BASELINE_POLICY
      ? policyOffers
      : largestSerializedPrefix(
          policyOffers,
          (bytes) => bytes <= serializedInternalOfferBytes(baselineOffers),
        );

  if (!includeTrace) return { offers: selected, trace: null };

  const corpusMaterialIds = new Set(blocks.map((block) => block.materialId));
  const corpusSectionKeys = new Set(blocks.map(sectionKey));
  const catalogBlockIds = new Set(catalog.map((offer) => offer.blockId));
  const offeredBlockIds = new Set(selected.map((offer) => offer.blockId));
  const candidateBlocks = selectedCandidateBlockIds.map((blockId, selectionIndex) => {
    const block = blockById.get(blockId)!;
    return {
      blockId,
      materialId: block.materialId,
      sectionKey: sectionKey(block),
      selectionIndex,
      firstContributor: firstContributorByBlock!.get(blockId) ?? null,
      signals: CURRICULUM_EVIDENCE_SELECTION_SIGNALS.filter((signal) =>
        signalsByBlock!.get(blockId)!.has(signal),
      ),
      policySelectionReason: policyReasonByBlockId.get(blockId)!,
    } satisfies CurriculumEvidenceBlockTrace;
  });
  const candidateMaterialIds = new Set(candidateBlocks.map((block) => block.materialId));
  const candidateSectionKeys = new Set(candidateBlocks.map((block) => block.sectionKey));
  const conceptPriorityKeys = new Set(
    concepts.map((concept) => normalizedGroundingKey(concept.grounding)),
  );
  const selectedPriorityOffers = selected.filter((offer) =>
    priorityKeys.has(normalizedGroundingKey(offer)),
  );
  const selectedConceptPriorityOffers = selectedPriorityOffers.filter((offer) =>
    conceptPriorityKeys.has(normalizedGroundingKey(offer)),
  );
  const selectedApplyProcedureOffers = selected.filter((offer) =>
    applyProcedureKeys.has(normalizedGroundingKey(offer)),
  );
  const matchingCatalogOfferCount = catalog.filter((offer) =>
    priorityKeys.has(normalizedGroundingKey(offer)),
  ).length;
  const matchingApplyProcedureOfferCount = catalog.filter((offer) =>
    applyProcedureKeys.has(normalizedGroundingKey(offer)),
  ).length;
  const bytes = serializedInternalOfferBytes(selected);

  return {
    offers: selected,
    trace: {
      policy,
      counts: {
        corpusBlocks: blocks.length,
        corpusMaterials: corpusMaterialIds.size,
        corpusSections: corpusSectionKeys.size,
        catalogBlocks: catalogBlockIds.size,
        catalogOffers: catalog.length,
        candidateBlocks: selectedBlockIds.size,
        offeredBlocks: offeredBlockIds.size,
        offeredEvidence: selected.length,
        overlapBlocks: candidateBlocks.filter((block) => block.signals.length > 1).length,
      },
      diversity: {
        candidateMaterials: candidateMaterialIds.size,
        candidateSections: candidateSectionKeys.size,
        materialCoverageRatio: ratio(candidateMaterialIds.size, corpusMaterialIds.size),
        sectionCoverageRatio: ratio(candidateSectionKeys.size, corpusSectionKeys.size),
      },
      serialization: {
        serializedInternalOfferBytes: bytes,
        byteMethod: 'utf8_internal_offer_json_array',
        estimatedTokens: estimatedTokensFromBytes(bytes),
        tokenEstimateMethod: 'ceil_utf8_bytes_div_4',
      },
      budgets: {
        maxBlocks: CURRICULUM_PROVIDER_EVIDENCE_BLOCK_BUDGET,
        maxOffers: CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET,
        maxOffersPerBlock: CURRICULUM_PROVIDER_OFFERS_PER_BLOCK,
        minFallbackBlocks: CURRICULUM_PROVIDER_MIN_FALLBACK_BLOCKS,
        neighborRadius: CURRICULUM_PROVIDER_NEIGHBOR_RADIUS,
        maxExcerptChars: CURRICULUM_EVIDENCE_EXCERPT_MAX_CHARS,
      },
      priorityOrdering: {
        effect:
          applyProcedureBlockIds.length > 0
            ? 'offer_ordering_and_apply_procedure_block_reserve'
            : 'offer_ordering_only',
        requestedGroundingCount: effectivePriorityGroundings.length,
        uniqueGroundingCount: priorityKeys.size,
        uniqueConceptGroundingCount: [...priorityKeys].filter((key) => conceptPriorityKeys.has(key))
          .length,
        uniqueNonConceptPriorityGroundingCount: [...priorityKeys].filter(
          (key) => !conceptPriorityKeys.has(key),
        ).length,
        matchingCatalogOfferCount,
        selectedPriorityOfferCount: selectedPriorityOffers.length,
        selectedConceptPriorityOfferCount: selectedConceptPriorityOffers.length,
        selectedNonConceptPriorityOfferCount:
          selectedPriorityOffers.length - selectedConceptPriorityOffers.length,
        selectedBlocksWithPriorityOffer: new Set(
          selectedPriorityOffers.map((offer) => offer.blockId),
        ).size,
        blocksWherePriorityChangedFirstOffer,
        requestedApplyProcedureGroundingCount: applyProcedureGroundings.length,
        matchingApplyProcedureOfferCount,
        reservedApplyProcedureBlockCount: applyProcedureBlockIds.filter((blockId) =>
          selectedBlockIds.has(blockId),
        ).length,
        selectedApplyProcedureOfferCount: selectedApplyProcedureOffers.length,
      },
      signals: CURRICULUM_EVIDENCE_SELECTION_SIGNALS.map((signal) => ({
        signal,
        attemptedBlockCount: attemptedBySignal!.get(signal)!.size,
        selectedBlockCount: [...attemptedBySignal!.get(signal)!].filter((id) =>
          selectedBlockIds.has(id),
        ).length,
        firstContributorBlockCount: [...firstContributorByBlock!.values()].filter(
          (candidate) => candidate === signal,
        ).length,
        budgetRejectedBlockCount: rejectedBySignal!.get(signal)!.size,
      })),
      blocks: candidateBlocks,
    },
  };
}

/** Evaluation selector with deterministic signal, diversity, and serialization telemetry. */
export function selectCurriculumEvidenceOffersWithTrace(
  input: CurriculumEvidenceSelectionInput,
): TracedCurriculumEvidenceSelection {
  const result = selectCurriculumEvidenceOffersInternal(input, true);
  if (!result.trace) throw new Error('Curriculum evidence trace was not collected.');
  return { offers: result.offers, trace: result.trace };
}

/** Output-only selector; an omitted policy intentionally reproduces the frozen baseline. */
export function selectCurriculumEvidenceOffers(
  input: CurriculumEvidenceSelectionInput,
): CurriculumEvidenceOffer[] {
  return selectCurriculumEvidenceOffersInternal(input, false).offers;
}
