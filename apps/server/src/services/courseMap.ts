import { createHash } from 'node:crypto';
import {
  CourseMapAnalysisSchema,
  CourseMapProposalPayloadSchema,
  CourseMapSourceAllocationSchema,
  type Concept,
  type CourseMap,
  type CourseMapAnalysis,
  type CourseMapDiagnostic,
  type CourseMapDiagnosticCode,
  type CourseMapProposalPayload,
  type CourseMapQualityProfile,
  type CourseMapSourceAllocation,
  type CourseMapSourceVisibilityEvidence,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { ProviderError } from '../llm/errors.js';
import type {
  CourseMapProposalInput,
  CurriculumCanonicalConceptOffer,
  CurriculumContractContext,
  CurriculumEvidenceOffer,
  LlmProvider,
  ProviderCallOptions,
} from '../llm/provider.js';
import { CourseSourceMapSchema, type CourseSourceMap } from './courseSourceMap.js';
import { validateCourseSourceMapSelectionCorpus } from './curriculumEvidencePolicy.js';

export const COURSE_MAP_SOURCE_REGION_LIMIT = 120;
export const COURSE_MAP_SOURCE_EVIDENCE_LIMIT = 160;
export const COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT = 2;
export const COURSE_MAP_CONCEPT_OFFER_LIMIT = 160;
export const COURSE_MAP_CANONICAL_OFFER_LIMIT = 120;

export const COURSE_MAP_DEFAULT_LIMITS: CourseMapProposalInput['limits'] = {
  maxModules: 24,
  maxRegions: COURSE_MAP_SOURCE_REGION_LIMIT,
  maxPrerequisiteEdges: 240,
  maxPrerequisiteDegree: 8,
  maxSynthesisGroups: 60,
  maxSourceRegionsPerRegion: 16,
};

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)}`;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function assertSameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  message: string,
): void {
  if (left.size !== right.size || [...left].some((value) => !right.has(value))) {
    throw new Error(message);
  }
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Recompute the content fingerprint before any allocation crosses a trust boundary. */
export function assertCourseMapSourceAllocationIntegrity(
  allocation: CourseMapSourceAllocation,
): void {
  const { fingerprint: claimedFingerprint, ...withoutFingerprint } = allocation;
  const expectedFingerprint = fingerprint('course_map_source_allocation', withoutFingerprint);
  if (claimedFingerprint !== expectedFingerprint) {
    throw new Error('Course Map source allocation fingerprint is stale or mismatched.');
  }
}

function assertCourseMapContractAllocationIntegrity(
  contract: CurriculumContractContext,
  allocation: CourseMapSourceAllocation,
): void {
  assertUnique(
    contract.materials.map((material) => material.materialId),
    'Course Map Contract Material identities',
  );
  const includedContractMaterialIds = new Set(
    contract.materials
      .filter((material) => material.disposition === 'included')
      .map((material) => material.materialId),
  );
  const allocationMaterialIds = new Set(allocation.regions.map((region) => region.materialId));
  assertSameSet(
    includedContractMaterialIds,
    allocationMaterialIds,
    'Course Map source allocation must exactly match the included Contract Material scope.',
  );
}

function assertCourseMapProviderInputIntegrity(
  allocation: CourseMapSourceAllocation,
  providerInput: CourseMapProposalInput,
): void {
  assertCourseMapSourceAllocationIntegrity(allocation);
  assertCourseMapContractAllocationIntegrity(providerInput.contract, allocation);
  if (
    providerInput.sourceAllocationFingerprint !== allocation.fingerprint ||
    providerInput.courseSourceMapFingerprint !== allocation.courseSourceMapFingerprint
  ) {
    throw new Error('Course Map provider context fingerprints do not match the source allocation.');
  }

  assertUnique(
    providerInput.sourceRegions.map((region) => region.id),
    'Course Map provider source-region identities',
  );
  assertUnique(
    providerInput.concepts.map((concept) => concept.id),
    'Course Map provider Concept identities',
  );
  assertUnique(
    providerInput.canonicalConcepts.map((canonical) => canonical.id),
    'Course Map provider canonical Concept identities',
  );
  if (providerInput.concepts.length > COURSE_MAP_CONCEPT_OFFER_LIMIT) {
    throw new Error('Course Map provider Concept visibility exceeds its hard limit.');
  }
  if (providerInput.canonicalConcepts.length > COURSE_MAP_CANONICAL_OFFER_LIMIT) {
    throw new Error('Course Map provider canonical Concept visibility exceeds its hard limit.');
  }

  const allocationConceptIds = new Set(allocation.regions.flatMap((region) => region.conceptIds));
  const offeredConceptIds = new Set(providerInput.concepts.map((concept) => concept.id));
  for (const conceptId of offeredConceptIds) {
    if (!allocationConceptIds.has(conceptId)) {
      throw new Error(
        'Course Map provider context contains a Concept outside the source allocation.',
      );
    }
  }
  const canonicalOwnerByConceptId = new Map<string, string>();
  for (const canonical of providerInput.canonicalConcepts) {
    assertUnique(
      canonical.sourceConceptIds,
      `Course Map provider canonical Concept ${canonical.id} member identities`,
    );
    for (const conceptId of canonical.sourceConceptIds) {
      if (!offeredConceptIds.has(conceptId)) {
        throw new Error('Course Map provider canonical Concept contains an unoffered Concept.');
      }
      const owner = canonicalOwnerByConceptId.get(conceptId);
      if (owner && owner !== canonical.id) {
        throw new Error('Course Map provider Concept belongs to multiple canonical Concepts.');
      }
      canonicalOwnerByConceptId.set(conceptId, canonical.id);
    }
  }

  if (providerInput.sourceRegions.length !== allocation.regions.length) {
    throw new Error('Course Map provider context must expose every source-allocation region.');
  }
  const materialTitleById = new Map(
    providerInput.contract.materials.map((material) => [material.materialId, material.title]),
  );
  let evidenceOfferCount = 0;
  for (const [index, allocationRegion] of allocation.regions.entries()) {
    const offeredRegion = providerInput.sourceRegions[index];
    const expectedConceptIds = allocationRegion.conceptIds.filter((id) =>
      offeredConceptIds.has(id),
    );
    const expectedEvidence = allocationRegion.evidence.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      text: evidence.quote,
    }));
    if (
      !offeredRegion ||
      offeredRegion.id !== allocationRegion.id ||
      offeredRegion.index !== allocationRegion.index ||
      offeredRegion.materialId !== allocationRegion.materialId ||
      offeredRegion.materialTitle !== materialTitleById.get(allocationRegion.materialId) ||
      offeredRegion.title !== allocationRegion.title ||
      offeredRegion.sectionCount !== allocationRegion.sourceSectionIds.length ||
      offeredRegion.blockCount !== allocationRegion.sourceBlockIds.length ||
      offeredRegion.charCount !== allocationRegion.charCount ||
      JSON.stringify(offeredRegion.conceptIds) !== JSON.stringify(expectedConceptIds) ||
      JSON.stringify(offeredRegion.evidence) !== JSON.stringify(expectedEvidence)
    ) {
      throw new Error('Course Map provider source-region view is stale, incomplete, or reordered.');
    }
    if (offeredRegion.evidence.length > COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT) {
      throw new Error('Course Map provider evidence visibility exceeds its per-region hard limit.');
    }
    evidenceOfferCount += offeredRegion.evidence.length;
  }
  if (evidenceOfferCount > COURSE_MAP_SOURCE_EVIDENCE_LIMIT) {
    throw new Error('Course Map provider evidence visibility exceeds its global hard limit.');
  }

  boundedInteger(providerInput.limits.maxModules, 1, 24, 'Course Map provider module limit');
  boundedInteger(
    providerInput.limits.maxRegions,
    allocation.regions.length,
    COURSE_MAP_SOURCE_REGION_LIMIT,
    'Course Map provider region limit',
  );
  boundedInteger(
    providerInput.limits.maxPrerequisiteEdges,
    0,
    384,
    'Course Map provider prerequisite-edge limit',
  );
  boundedInteger(
    providerInput.limits.maxPrerequisiteDegree,
    0,
    16,
    'Course Map provider prerequisite-degree limit',
  );
  boundedInteger(
    providerInput.limits.maxSynthesisGroups,
    0,
    100,
    'Course Map provider synthesis-group limit',
  );
  boundedInteger(
    providerInput.limits.maxSourceRegionsPerRegion,
    1,
    16,
    'Course Map provider source-regions-per-region limit',
  );
}

interface BuildCourseMapSourceAllocationInput {
  workspaceId: string;
  sourceMap: CourseSourceMap;
  blocks: SourceBlock[];
  evidenceCatalog: CurriculumEvidenceOffer[];
  maxRegions?: number;
  maxEvidenceOffers?: number;
  maxEvidenceOffersPerRegion?: number;
}

/**
 * Partition the exact Course Source Map into a bounded set of contiguous
 * planning regions. Every source section and block remains represented once.
 */
export function buildCourseMapSourceAllocation({
  workspaceId,
  sourceMap: rawSourceMap,
  blocks,
  evidenceCatalog,
  maxRegions = COURSE_MAP_SOURCE_REGION_LIMIT,
  maxEvidenceOffers = COURSE_MAP_SOURCE_EVIDENCE_LIMIT,
  maxEvidenceOffersPerRegion = COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT,
}: BuildCourseMapSourceAllocationInput): CourseMapSourceAllocation {
  const sourceMap = CourseSourceMapSchema.parse(rawSourceMap);
  validateCourseSourceMapSelectionCorpus({ workspaceId, sourceMap, blocks });
  maxRegions = boundedInteger(
    maxRegions,
    1,
    COURSE_MAP_SOURCE_REGION_LIMIT,
    'Course Map source-region limit',
  );
  maxEvidenceOffers = boundedInteger(
    maxEvidenceOffers,
    0,
    COURSE_MAP_SOURCE_EVIDENCE_LIMIT,
    'Course Map evidence-offer limit',
  );
  maxEvidenceOffersPerRegion = boundedInteger(
    maxEvidenceOffersPerRegion,
    0,
    COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT,
    'Course Map per-region evidence-offer limit',
  );
  if (sourceMap.materials.length > maxRegions) {
    throw new Error('Course Map source-region limit cannot represent every Material.');
  }

  assertUnique(
    evidenceCatalog.map((offer) => offer.id),
    'Course Map evidence offer identities',
  );
  assertUnique(
    evidenceCatalog.map((offer) => offer.bindingId),
    'Course Map evidence binding identities',
  );
  const sourceBlockById = new Map(blocks.map((block) => [block.id, block]));
  const mappedBlockById = new Map(
    sourceMap.materials.flatMap((material) =>
      material.blocks.map((block) => [block.sourceBlockId, block] as const),
    ),
  );
  for (const offer of evidenceCatalog) {
    const block = sourceBlockById.get(offer.blockId);
    const mapped = mappedBlockById.get(offer.blockId);
    if (
      !block ||
      !mapped ||
      offer.materialId !== mapped.materialId ||
      offer.materialRevisionId !== mapped.materialRevisionId ||
      offer.startOffset < 0 ||
      offer.endOffset > block.content.length ||
      offer.endOffset <= offer.startOffset ||
      block.content.slice(offer.startOffset, offer.endOffset) !== offer.quote
    ) {
      throw new Error('Course Map source allocation contains stale or foreign evidence.');
    }
  }

  const totalSectionCount = sourceMap.materials.reduce(
    (count, material) => count + material.sections.length,
    0,
  );
  const targetRegionCount = Math.min(totalSectionCount, maxRegions);
  const quotaByMaterialId = new Map(
    sourceMap.materials.map((material) => [material.materialId, 1]),
  );
  let allocatedQuota = sourceMap.materials.length;
  while (allocatedQuota < targetRegionCount) {
    const candidate = sourceMap.materials
      .filter((material) => quotaByMaterialId.get(material.materialId)! < material.sections.length)
      .sort((left, right) => {
        const leftQuota = quotaByMaterialId.get(left.materialId)!;
        const rightQuota = quotaByMaterialId.get(right.materialId)!;
        return (
          right.sections.length * leftQuota - left.sections.length * rightQuota ||
          left.sourceIndex - right.sourceIndex ||
          left.materialId.localeCompare(right.materialId)
        );
      })[0];
    if (!candidate) break;
    quotaByMaterialId.set(candidate.materialId, quotaByMaterialId.get(candidate.materialId)! + 1);
    allocatedQuota += 1;
  }

  const regionsWithoutEvidence: Array<
    Omit<CourseMapSourceAllocation['regions'][number], 'evidence'>
  > = [];
  for (const material of sourceMap.materials) {
    const quota = quotaByMaterialId.get(material.materialId)!;
    const blockById = new Map(
      material.blocks.map((block) => [block.sourceBlockId, block] as const),
    );
    for (let chunkIndex = 0; chunkIndex < quota; chunkIndex += 1) {
      const start = Math.floor((chunkIndex * material.sections.length) / quota);
      const end = Math.floor(((chunkIndex + 1) * material.sections.length) / quota);
      const sections = material.sections.slice(start, end);
      const sourceBlockIds = sections.flatMap((section) => section.sourceBlockIds);
      const mappedBlocks = sourceBlockIds.map((blockId) => blockById.get(blockId)!);
      const firstTitle = sections[0]!.title;
      const lastTitle = sections.at(-1)!.title;
      const title = (firstTitle === lastTitle ? firstTitle : `${firstTitle} - ${lastTitle}`).slice(
        0,
        300,
      );
      const sourceSectionIds = sections.map((section) => section.id);
      regionsWithoutEvidence.push({
        id: stableId('course_map_source_region', {
          sourceMapFingerprint: sourceMap.fingerprint,
          materialRevisionId: material.activeMaterialRevisionId,
          sourceSectionIds,
        }),
        index: regionsWithoutEvidence.length,
        materialId: material.materialId,
        materialRevisionId: material.activeMaterialRevisionId,
        title,
        firstCourseSourceIndex: mappedBlocks[0]!.courseSourceIndex,
        lastCourseSourceIndex: mappedBlocks.at(-1)!.courseSourceIndex,
        charCount: sections.reduce((count, section) => count + section.charCount, 0),
        sourceSectionIds,
        sourceBlockIds,
        conceptIds: [...new Set(mappedBlocks.flatMap((block) => block.conceptIds))],
      });
    }
  }

  const regionIdByBlockId = new Map(
    regionsWithoutEvidence.flatMap((region) =>
      region.sourceBlockIds.map((blockId) => [blockId, region.id] as const),
    ),
  );
  const offersByRegionId = new Map<string, CurriculumEvidenceOffer[]>();
  for (const offer of evidenceCatalog) {
    const regionId = regionIdByBlockId.get(offer.blockId);
    if (!regionId) throw new Error('Course Map source allocation evidence is outside its regions.');
    const offers = offersByRegionId.get(regionId) ?? [];
    offers.push(offer);
    offersByRegionId.set(regionId, offers);
  }
  const selectedByRegionId = new Map<string, CourseMapSourceVisibilityEvidence[]>();
  let selectedEvidenceCount = 0;
  for (
    let pass = 0;
    pass < maxEvidenceOffersPerRegion && selectedEvidenceCount < maxEvidenceOffers;
    pass += 1
  ) {
    for (const region of regionsWithoutEvidence) {
      if (selectedEvidenceCount >= maxEvidenceOffers) break;
      const offer = offersByRegionId.get(region.id)?.[pass];
      if (!offer) continue;
      const selected = selectedByRegionId.get(region.id) ?? [];
      selected.push({
        evidenceId: offer.id,
        bindingId: offer.bindingId,
        blockId: offer.blockId,
        startOffset: offer.startOffset,
        endOffset: offer.endOffset,
        quote: offer.quote,
      });
      selectedByRegionId.set(region.id, selected);
      selectedEvidenceCount += 1;
    }
  }

  const regions: CourseMapSourceAllocation['regions'] = regionsWithoutEvidence.map((region) => ({
    ...region,
    evidence: selectedByRegionId.get(region.id) ?? [],
  }));
  const allocationWithoutFingerprint = {
    schemaVersion: 1 as const,
    workspaceId,
    courseSourceMapFingerprint: sourceMap.fingerprint,
    authority: 'planning_visibility_only' as const,
    materialCount: sourceMap.materialCount,
    sourceSectionCount: sourceMap.sectionCount,
    sourceBlockCount: sourceMap.blockCount,
    limits: { maxRegions, maxEvidenceOffers, maxEvidenceOffersPerRegion },
    regions,
  };
  const allocation = CourseMapSourceAllocationSchema.parse({
    ...allocationWithoutFingerprint,
    fingerprint: fingerprint('course_map_source_allocation', allocationWithoutFingerprint),
  });
  assertCourseMapSourceAllocationIntegrity(allocation);
  return allocation;
}

function roundRobinIds(rows: readonly string[][], limit: number): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const maxLength = Math.max(0, ...rows.map((row) => row.length));
  for (let pass = 0; pass < maxLength && selected.length < limit; pass += 1) {
    for (const row of rows) {
      const id = row[pass];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      selected.push(id);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export interface BuildCourseMapProposalInput {
  workspaceName: string;
  contract: CurriculumContractContext;
  sourceAllocation: CourseMapSourceAllocation;
  concepts: Concept[];
  canonicalConcepts: CurriculumCanonicalConceptOffer[];
  limits?: Partial<CourseMapProposalInput['limits']>;
}

/** Build the only provider-visible Course Map context; it contains no full SourceBlocks. */
export function buildCourseMapProposalInput({
  workspaceName,
  contract,
  sourceAllocation: rawAllocation,
  concepts,
  canonicalConcepts,
  limits: overrides = {},
}: BuildCourseMapProposalInput): CourseMapProposalInput {
  const sourceAllocation = CourseMapSourceAllocationSchema.parse(rawAllocation);
  assertCourseMapSourceAllocationIntegrity(sourceAllocation);
  assertCourseMapContractAllocationIntegrity(contract, sourceAllocation);
  assertUnique(
    concepts.map((concept) => concept.id),
    'Course Map Concept identities',
  );
  const sourceRegionsByConceptId = new Map<string, CourseMapSourceAllocation['regions']>();
  for (const region of sourceAllocation.regions) {
    for (const conceptId of region.conceptIds) {
      const regions = sourceRegionsByConceptId.get(conceptId) ?? [];
      regions.push(region);
      sourceRegionsByConceptId.set(conceptId, regions);
    }
  }
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  for (const concept of concepts) {
    const regions = sourceRegionsByConceptId.get(concept.id);
    if (
      !regions ||
      !regions.some(
        (region) =>
          region.materialId === concept.materialId &&
          region.materialRevisionId === concept.materialRevisionId &&
          region.sourceBlockIds.includes(concept.grounding.blockId),
      )
    ) {
      throw new Error('Course Map Concept is stale or outside the source allocation.');
    }
  }
  const offeredConceptIds = roundRobinIds(
    sourceAllocation.regions.map((region) =>
      region.conceptIds.filter((conceptId) => conceptById.has(conceptId)),
    ),
    COURSE_MAP_CONCEPT_OFFER_LIMIT,
  );
  const offeredConceptIdSet = new Set(offeredConceptIds);
  assertUnique(
    canonicalConcepts.map((canonical) => canonical.id),
    'Course Map canonical Concept identities',
  );
  const canonicalOwnerByConceptId = new Map<string, string>();
  for (const canonical of canonicalConcepts) {
    assertUnique(
      canonical.sourceConceptIds,
      `Course Map canonical Concept ${canonical.id} member identities`,
    );
    for (const conceptId of canonical.sourceConceptIds) {
      if (!conceptById.has(conceptId)) {
        throw new Error('Course Map canonical Concept contains an unknown source Concept.');
      }
      const owner = canonicalOwnerByConceptId.get(conceptId);
      if (owner && owner !== canonical.id) {
        throw new Error('Course Map source Concept belongs to multiple canonical Concepts.');
      }
      canonicalOwnerByConceptId.set(conceptId, canonical.id);
    }
  }
  const offeredCanonicalConcepts = canonicalConcepts
    .map((canonical) => ({
      ...canonical,
      sourceConceptIds: canonical.sourceConceptIds.filter((conceptId) =>
        offeredConceptIdSet.has(conceptId),
      ),
    }))
    .filter((canonical) => canonical.sourceConceptIds.length > 0)
    .slice(0, COURSE_MAP_CANONICAL_OFFER_LIMIT);
  const materialTitleById = new Map(
    contract.materials.map((material) => [material.materialId, material.title]),
  );
  const regionCount = sourceAllocation.regions.length;
  const limits: CourseMapProposalInput['limits'] = {
    maxModules: boundedInteger(
      overrides.maxModules ?? COURSE_MAP_DEFAULT_LIMITS.maxModules,
      1,
      24,
      'Course Map module limit',
    ),
    maxRegions: boundedInteger(
      overrides.maxRegions ?? regionCount,
      regionCount,
      COURSE_MAP_SOURCE_REGION_LIMIT,
      'Course Map region limit',
    ),
    maxPrerequisiteEdges: boundedInteger(
      overrides.maxPrerequisiteEdges ?? Math.min(240, Math.max(0, regionCount * 2)),
      0,
      384,
      'Course Map prerequisite-edge limit',
    ),
    maxPrerequisiteDegree: boundedInteger(
      overrides.maxPrerequisiteDegree ?? COURSE_MAP_DEFAULT_LIMITS.maxPrerequisiteDegree,
      0,
      16,
      'Course Map prerequisite-degree limit',
    ),
    maxSynthesisGroups: boundedInteger(
      overrides.maxSynthesisGroups ?? Math.min(60, regionCount),
      0,
      100,
      'Course Map synthesis-group limit',
    ),
    maxSourceRegionsPerRegion: boundedInteger(
      overrides.maxSourceRegionsPerRegion ?? COURSE_MAP_DEFAULT_LIMITS.maxSourceRegionsPerRegion,
      1,
      16,
      'Course Map source-regions-per-region limit',
    ),
  };
  const providerInput: CourseMapProposalInput = {
    workspaceName,
    contract,
    courseSourceMapFingerprint: sourceAllocation.courseSourceMapFingerprint,
    sourceAllocationFingerprint: sourceAllocation.fingerprint,
    sourceRegions: sourceAllocation.regions.map((region) => ({
      id: region.id,
      index: region.index,
      materialId: region.materialId,
      materialTitle: materialTitleById.get(region.materialId)!,
      title: region.title,
      sectionCount: region.sourceSectionIds.length,
      blockCount: region.sourceBlockIds.length,
      charCount: region.charCount,
      conceptIds: region.conceptIds.filter((conceptId) => offeredConceptIdSet.has(conceptId)),
      evidence: region.evidence.map((evidence) => ({
        evidenceId: evidence.evidenceId,
        text: evidence.quote,
      })),
    })),
    concepts: offeredConceptIds.map((id) => {
      const concept = conceptById.get(id)!;
      return {
        id: concept.id,
        name: concept.name,
        summary: concept.summary,
        importance: concept.importance,
      };
    }),
    canonicalConcepts: offeredCanonicalConcepts,
    limits,
  };
  assertCourseMapProviderInputIntegrity(sourceAllocation, providerInput);
  return providerInput;
}

function normalizedIntent(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(value: string): Set<string> {
  const compact = normalizedIntent(value).replace(/\s+/gu, '');
  const result = new Set<string>();
  for (let index = 0; index <= compact.length - 3; index += 1) {
    result.add(compact.slice(index, index + 3));
  }
  return result;
}

function nearDuplicate(left: string, right: string): boolean {
  const leftGrams = trigrams(left);
  const rightGrams = trigrams(right);
  if (leftGrams.size < 8 || rightGrams.size < 8) return false;
  let intersection = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) intersection += 1;
  const union = leftGrams.size + rightGrams.size - intersection;
  return union > 0 && intersection / union >= 0.9;
}

export interface CourseMapValidationContext {
  sourceAllocation: CourseMapSourceAllocation;
  providerInput: CourseMapProposalInput;
}

/** Convert proposal-local keys to deterministic operation-local ids and profile the result. */
export function analyzeCourseMapProposal(
  payload: CourseMapProposalPayload,
  context: CourseMapValidationContext,
): CourseMapAnalysis {
  const parsed = CourseMapProposalPayloadSchema.parse(payload);
  const sourceAllocation = CourseMapSourceAllocationSchema.parse(context.sourceAllocation);
  assertCourseMapProviderInputIntegrity(sourceAllocation, context.providerInput);
  const proposalFingerprint = fingerprint('course_map_proposal', parsed);
  const diagnostics: CourseMapDiagnostic[] = [];
  const add = (
    severity: CourseMapDiagnostic['severity'],
    code: CourseMapDiagnosticCode,
    message: string,
    entityKeys: string[] = [],
  ): void => {
    if (diagnostics.length >= 300) return;
    diagnostics.push({ severity, code, message: message.slice(0, 500), entityKeys });
  };
  if (
    parsed.sourceAllocationFingerprint !== sourceAllocation.fingerprint ||
    context.providerInput.sourceAllocationFingerprint !== sourceAllocation.fingerprint ||
    context.providerInput.courseSourceMapFingerprint !== sourceAllocation.courseSourceMapFingerprint
  ) {
    add(
      'error',
      'source_allocation_fingerprint_mismatch',
      'Course Map proposal does not target the offered source allocation.',
    );
  }
  if (parsed.modules.length > context.providerInput.limits.maxModules) {
    add('error', 'module_limit_exceeded', 'Course Map exceeds the offered module limit.');
  }
  const proposedRegionCount = parsed.modules.reduce(
    (count, module) => count + module.regions.length,
    0,
  );
  if (proposedRegionCount > context.providerInput.limits.maxRegions) {
    add('error', 'region_limit_exceeded', 'Course Map exceeds the offered region limit.');
  }

  const allocationById = new Map(sourceAllocation.regions.map((region) => [region.id, region]));
  const conceptById = new Map(
    context.providerInput.concepts.map((concept) => [concept.id, concept]),
  );
  const canonicalById = new Map(
    context.providerInput.canonicalConcepts.map((canonical) => [canonical.id, canonical]),
  );
  const moduleIdByKey = new Map<string, string>();
  const regionIdByKey = new Map<string, string>();
  const regionOrderByKey = new Map<string, number>();
  const regionModuleKeyByKey = new Map<string, string>();
  const materializedModules: CourseMap['modules'] = [];
  const allocationUseCount = new Map<string, number>();
  const sourceBlockIdsByProposedRegion = new Map<string, Set<string>>();
  let unsupportedRegionCount = 0;
  let invalidAnchorCount = 0;
  let globalRegionOrder = 0;

  for (const [modulePosition, proposedModule] of parsed.modules.entries()) {
    if (proposedModule.index !== modulePosition) {
      add(
        'error',
        'invalid_module_order',
        'Course Map module indexes must be contiguous and match array order.',
        [proposedModule.key],
      );
    }
    const moduleId = stableId('course_map_module', {
      allocation: sourceAllocation.fingerprint,
      proposal: proposalFingerprint,
      key: proposedModule.key,
      index: proposedModule.index,
    });
    moduleIdByKey.set(proposedModule.key, moduleId);
    const regions: CourseMap['modules'][number]['regions'] = [];
    for (const [regionPosition, proposedRegion] of proposedModule.regions.entries()) {
      if (proposedRegion.index !== regionPosition) {
        add(
          'error',
          'invalid_region_order',
          'Inside each module, Course Map region indexes must restart at 0, be contiguous, and match that module regions array order; never use a course-global region index.',
          [proposedRegion.key],
        );
      }
      if (
        proposedRegion.sourceRegionIds.length >
        context.providerInput.limits.maxSourceRegionsPerRegion
      ) {
        add(
          'error',
          'region_limit_exceeded',
          'Course Map region exceeds the offered source-allocation reference limit.',
          [proposedRegion.key],
        );
      }
      const localSourceRegionIds = new Set<string>();
      const knownAllocations: CourseMapSourceAllocation['regions'] = [];
      for (const sourceRegionId of proposedRegion.sourceRegionIds) {
        const allocation = allocationById.get(sourceRegionId);
        if (!allocation) {
          add(
            'error',
            'unknown_source_region',
            'Course Map region references an unknown source-allocation region.',
            [proposedRegion.key, sourceRegionId],
          );
          continue;
        }
        if (localSourceRegionIds.has(sourceRegionId)) {
          add(
            'error',
            'duplicate_source_allocation',
            'Course Map region repeats a source-allocation region.',
            [proposedRegion.key, sourceRegionId],
          );
          allocationUseCount.set(sourceRegionId, (allocationUseCount.get(sourceRegionId) ?? 0) + 1);
          continue;
        }
        localSourceRegionIds.add(sourceRegionId);
        allocationUseCount.set(sourceRegionId, (allocationUseCount.get(sourceRegionId) ?? 0) + 1);
        knownAllocations.push(allocation);
      }
      if (knownAllocations.length === 0) {
        unsupportedRegionCount += 1;
        add('error', 'unsupported_region', 'Course Map region has no valid source allocation.', [
          proposedRegion.key,
        ]);
      }
      const allocatedConceptIds = new Set(
        knownAllocations.flatMap((allocation) => allocation.conceptIds),
      );
      for (const conceptId of proposedRegion.conceptIds) {
        if (!conceptById.has(conceptId)) {
          invalidAnchorCount += 1;
          add(
            'error',
            'unknown_concept_anchor',
            'Course Map region references an unknown offered Concept.',
            [proposedRegion.key, conceptId],
          );
        } else if (!allocatedConceptIds.has(conceptId)) {
          invalidAnchorCount += 1;
          add(
            'error',
            'concept_anchor_outside_allocation',
            'Course Map Concept anchor is outside the region source allocation.',
            [proposedRegion.key, conceptId],
          );
        }
      }
      for (const canonicalId of proposedRegion.canonicalConceptIds) {
        const canonical = canonicalById.get(canonicalId);
        if (!canonical) {
          invalidAnchorCount += 1;
          add(
            'error',
            'unknown_canonical_anchor',
            'Course Map region references an unknown canonical Concept.',
            [proposedRegion.key, canonicalId],
          );
        } else if (!canonical.sourceConceptIds.some((id) => allocatedConceptIds.has(id))) {
          invalidAnchorCount += 1;
          add(
            'error',
            'canonical_anchor_outside_allocation',
            'Course Map canonical Concept has no offered member in the region allocation.',
            [proposedRegion.key, canonicalId],
          );
        }
      }
      const regionId = stableId('course_map_region', {
        allocation: sourceAllocation.fingerprint,
        proposal: proposalFingerprint,
        moduleKey: proposedModule.key,
        key: proposedRegion.key,
        index: proposedRegion.index,
      });
      regionIdByKey.set(proposedRegion.key, regionId);
      regionOrderByKey.set(proposedRegion.key, globalRegionOrder);
      regionModuleKeyByKey.set(proposedRegion.key, proposedModule.key);
      globalRegionOrder += 1;
      const sourceBlockIds = new Set(
        knownAllocations.flatMap((allocation) => allocation.sourceBlockIds),
      );
      sourceBlockIdsByProposedRegion.set(proposedRegion.key, sourceBlockIds);
      regions.push({
        id: regionId,
        proposalKey: proposedRegion.key,
        moduleId,
        index: proposedRegion.index,
        title: proposedRegion.title,
        learningIntent: proposedRegion.learningIntent,
        approximateScope: proposedRegion.approximateScope,
        sourceAllocationRegionIds: proposedRegion.sourceRegionIds,
        materialIds: [...new Set(knownAllocations.map((allocation) => allocation.materialId))],
        conceptIds: proposedRegion.conceptIds,
        canonicalConceptIds: proposedRegion.canonicalConceptIds,
      });
    }
    materializedModules.push({
      id: moduleId,
      proposalKey: proposedModule.key,
      index: proposedModule.index,
      title: proposedModule.title,
      learningIntent: proposedModule.learningIntent,
      regions,
    });
  }

  let duplicateAllocationCount = 0;
  for (const [sourceRegionId, count] of allocationUseCount) {
    if (count <= 1) continue;
    duplicateAllocationCount += count - 1;
    add(
      'error',
      'duplicate_source_allocation',
      'A source-allocation region may belong to only one Course Map region.',
      [sourceRegionId],
    );
  }
  const unallocatedSourceRegions = sourceAllocation.regions.filter(
    (region) => !allocationUseCount.has(region.id),
  );
  if (unallocatedSourceRegions.length > 0) {
    add(
      'error',
      'unallocated_source_region',
      `${unallocatedSourceRegions.length} source-allocation regions are not represented.`,
      unallocatedSourceRegions.slice(0, 20).map((region) => region.id),
    );
  }

  const materializedPrerequisites: CourseMap['prerequisites'] = [];
  const prerequisiteKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  let prerequisiteTopologyValid = true;
  if (parsed.prerequisites.length > context.providerInput.limits.maxPrerequisiteEdges) {
    prerequisiteTopologyValid = false;
    add(
      'error',
      'prerequisite_edge_limit_exceeded',
      'Course Map exceeds the offered prerequisite-edge limit.',
    );
  }
  for (const edge of parsed.prerequisites) {
    const prerequisiteId = regionIdByKey.get(edge.prerequisiteRegionKey);
    const dependentId = regionIdByKey.get(edge.dependentRegionKey);
    if (!prerequisiteId || !dependentId) {
      prerequisiteTopologyValid = false;
      add(
        'error',
        'unknown_prerequisite_region',
        'Course Map prerequisite references an unknown region.',
        [edge.prerequisiteRegionKey, edge.dependentRegionKey],
      );
      continue;
    }
    if (prerequisiteId === dependentId) {
      prerequisiteTopologyValid = false;
      add('error', 'self_prerequisite', 'Course Map region cannot be its own prerequisite.', [
        edge.prerequisiteRegionKey,
      ]);
      continue;
    }
    const key = `${prerequisiteId}\u0000${dependentId}`;
    if (prerequisiteKeys.has(key)) {
      prerequisiteTopologyValid = false;
      add('error', 'duplicate_prerequisite', 'Course Map prerequisite edge is duplicated.', [
        edge.prerequisiteRegionKey,
        edge.dependentRegionKey,
      ]);
      continue;
    }
    prerequisiteKeys.add(key);
    if (
      regionOrderByKey.get(edge.prerequisiteRegionKey)! >=
      regionOrderByKey.get(edge.dependentRegionKey)!
    ) {
      prerequisiteTopologyValid = false;
      add(
        'error',
        'prerequisite_wrong_order',
        'Prerequisite region must occur before its dependent region.',
        [edge.prerequisiteRegionKey, edge.dependentRegionKey],
      );
    }
    const dependents = adjacency.get(prerequisiteId) ?? [];
    dependents.push(dependentId);
    adjacency.set(prerequisiteId, dependents);
    outDegree.set(prerequisiteId, (outDegree.get(prerequisiteId) ?? 0) + 1);
    inDegree.set(dependentId, (inDegree.get(dependentId) ?? 0) + 1);
    materializedPrerequisites.push({
      prerequisiteRegionId: prerequisiteId,
      dependentRegionId: dependentId,
    });
  }
  const allRegionIds = [...regionIdByKey.values()];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasCycle = false;
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      hasCycle = true;
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependentId of adjacency.get(id) ?? []) visit(dependentId);
    visiting.delete(id);
    visited.add(id);
  };
  allRegionIds.forEach(visit);
  if (hasCycle) {
    prerequisiteTopologyValid = false;
    add('error', 'prerequisite_cycle', 'Course Map prerequisite graph contains a cycle.');
  }
  const maxInDegree = Math.max(0, ...inDegree.values());
  const maxOutDegree = Math.max(0, ...outDegree.values());
  if (
    maxInDegree > context.providerInput.limits.maxPrerequisiteDegree ||
    maxOutDegree > context.providerInput.limits.maxPrerequisiteDegree
  ) {
    prerequisiteTopologyValid = false;
    add(
      'error',
      'prerequisite_degree_exceeded',
      'Course Map prerequisite degree exceeds the offered bound.',
    );
  }
  const isolatedRegionCount = allRegionIds.filter(
    (id) => (inDegree.get(id) ?? 0) + (outDegree.get(id) ?? 0) === 0,
  ).length;
  if (allRegionIds.length > 1 && isolatedRegionCount > 0) {
    add(
      'warning',
      'isolated_regions',
      `${isolatedRegionCount} Course Map regions have no prerequisite relation.`,
    );
  }

  const materializedSynthesis: CourseMap['synthesisGroups'] = [];
  const synthesisKeys = new Set<string>();
  const synthesisRegionIds = new Set<string>();
  if (parsed.synthesisGroups.length > context.providerInput.limits.maxSynthesisGroups) {
    add(
      'error',
      'invalid_synthesis_boundary',
      'Course Map exceeds the offered synthesis-group limit.',
    );
  }
  for (const group of parsed.synthesisGroups) {
    if (synthesisKeys.has(group.key)) {
      add(
        'error',
        'duplicate_synthesis_group',
        'Course Map synthesis-group identity is duplicated.',
        [group.key],
      );
      continue;
    }
    synthesisKeys.add(group.key);
    const localRegionKeys = new Set<string>();
    const regionIds: string[] = [];
    for (const regionKey of group.regionKeys) {
      const id = regionIdByKey.get(regionKey);
      if (!id) {
        add(
          'error',
          'unknown_synthesis_region',
          'Course Map synthesis group references an unknown region.',
          [group.key, regionKey],
        );
      } else if (localRegionKeys.has(regionKey)) {
        add('error', 'duplicate_synthesis_region', 'Course Map synthesis group repeats a region.', [
          group.key,
          regionKey,
        ]);
      } else {
        localRegionKeys.add(regionKey);
        regionIds.push(id);
        synthesisRegionIds.add(id);
      }
    }
    if (
      group.level === 'module' &&
      new Set(group.regionKeys.map((key) => regionModuleKeyByKey.get(key))).size !== 1
    ) {
      add(
        'error',
        'invalid_synthesis_boundary',
        'Module-level synthesis must stay within one Course Map module.',
        [group.key],
      );
    }
    if (regionIds.length >= 2) {
      materializedSynthesis.push({
        id: stableId('course_map_synthesis', {
          allocation: sourceAllocation.fingerprint,
          proposal: proposalFingerprint,
          key: group.key,
        }),
        proposalKey: group.key,
        title: group.title,
        level: group.level,
        regionIds,
      });
    }
  }
  if (proposedRegionCount >= 4 && parsed.synthesisGroups.length === 0) {
    add(
      'warning',
      'missing_synthesis_boundary',
      'Course Map declares no synthesis boundary across a multi-region course.',
    );
  }

  const proposedRegions = parsed.modules.flatMap((module) => module.regions);
  let duplicateIntentPairCount = 0;
  let nearDuplicateIntentPairCount = 0;
  for (let leftIndex = 0; leftIndex < proposedRegions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < proposedRegions.length; rightIndex += 1) {
      const left = proposedRegions[leftIndex]!;
      const right = proposedRegions[rightIndex]!;
      const leftIntent = normalizedIntent(left.learningIntent);
      const rightIntent = normalizedIntent(right.learningIntent);
      if (leftIntent === rightIntent) {
        duplicateIntentPairCount += 1;
        if (duplicateIntentPairCount <= 20) {
          add(
            'warning',
            'duplicate_region_intent',
            'Course Map regions have duplicate normalized learning intents.',
            [left.key, right.key],
          );
        }
      } else if (nearDuplicate(left.learningIntent, right.learningIntent)) {
        nearDuplicateIntentPairCount += 1;
        if (nearDuplicateIntentPairCount <= 20) {
          add(
            'warning',
            'near_duplicate_region_intent',
            'Course Map regions have near-duplicate learning intents.',
            [left.key, right.key],
          );
        }
      }
    }
  }
  const flat = parsed.modules.length === 1 && proposedRegionCount >= 4;
  if (flat) {
    add('warning', 'flat_hierarchy', 'Course Map keeps a multi-region course in one module.', [
      parsed.modules[0]!.key,
    ]);
  }

  const representedMaterialIds = new Set<string>();
  const representedSectionIds = new Set<string>();
  const representedBlockIds = new Set<string>();
  for (const sourceRegionId of allocationUseCount.keys()) {
    const allocation = allocationById.get(sourceRegionId);
    if (!allocation) continue;
    representedMaterialIds.add(allocation.materialId);
    allocation.sourceSectionIds.forEach((id) => representedSectionIds.add(id));
    allocation.sourceBlockIds.forEach((id) => representedBlockIds.add(id));
  }
  const allMaterialIds = new Set(sourceAllocation.regions.map((region) => region.materialId));
  const missingMaterialIds = [...allMaterialIds].filter((id) => !representedMaterialIds.has(id));
  if (missingMaterialIds.length > 0) {
    add(
      'error',
      'missing_material_representation',
      `${missingMaterialIds.length} Materials are not represented in the Course Map.`,
      missingMaterialIds.slice(0, 20),
    );
  }
  const maxAllocatedBlocks = Math.max(
    0,
    ...[...sourceBlockIdsByProposedRegion.values()].map((ids) => ids.size),
  );
  const maxRegionShare =
    representedBlockIds.size === 0 ? 0 : maxAllocatedBlocks / representedBlockIds.size;
  if (proposedRegionCount > 1 && representedBlockIds.size >= 10 && maxRegionShare > 0.6) {
    add(
      'warning',
      'source_allocation_concentration',
      'One Course Map region contains more than 60% of represented source blocks.',
    );
  }

  const courseMap: CourseMap = {
    schemaVersion: 1,
    id: stableId('course_map', {
      allocation: sourceAllocation.fingerprint,
      proposal: proposalFingerprint,
    }),
    workspaceId: sourceAllocation.workspaceId,
    courseSourceMapFingerprint: sourceAllocation.courseSourceMapFingerprint,
    sourceAllocationFingerprint: sourceAllocation.fingerprint,
    authority: 'planning_proposal_only',
    modules: materializedModules,
    prerequisites: materializedPrerequisites,
    synthesisGroups: materializedSynthesis,
  };
  const qualityProfile: CourseMapQualityProfile = {
    hierarchy: {
      moduleCount: parsed.modules.length,
      regionCount: proposedRegionCount,
      maxRegionsPerModule: Math.max(0, ...parsed.modules.map((module) => module.regions.length)),
      flat,
    },
    sourceAllocation: {
      sourceRegionCount: sourceAllocation.regions.length,
      allocatedSourceRegionCount: sourceAllocation.regions.length - unallocatedSourceRegions.length,
      unallocatedSourceRegionCount: unallocatedSourceRegions.length,
      duplicateAllocationCount,
      unsupportedRegionCount,
      representedMaterialCount: representedMaterialIds.size,
      totalMaterialCount: allMaterialIds.size,
      representedSectionCount: representedSectionIds.size,
      totalSectionCount: sourceAllocation.sourceSectionCount,
      representedBlockCount: representedBlockIds.size,
      totalBlockCount: sourceAllocation.sourceBlockCount,
      maxRegionShare,
    },
    prerequisites: {
      edgeCount: parsed.prerequisites.length,
      dagValid: prerequisiteTopologyValid,
      maxInDegree,
      maxOutDegree,
      isolatedRegionCount,
    },
    synthesis: {
      groupCount: parsed.synthesisGroups.length,
      boundaryRegionCount: synthesisRegionIds.size,
    },
    duplication: { duplicateIntentPairCount, nearDuplicateIntentPairCount },
    anchors: {
      conceptAnchorCount: proposedRegions.reduce(
        (count, region) => count + region.conceptIds.length,
        0,
      ),
      canonicalConceptAnchorCount: proposedRegions.reduce(
        (count, region) => count + region.canonicalConceptIds.length,
        0,
      ),
      invalidAnchorCount,
    },
  };
  const validation = {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
  return CourseMapAnalysisSchema.parse({
    sourceAllocation,
    courseMap,
    validation,
    qualityProfile,
  });
}

export interface GenerateCourseMapPrototypeInput extends CourseMapValidationContext {
  provider: LlmProvider;
}

export interface CourseMapPrototypeResult {
  analysis: CourseMapAnalysis;
  repairAttempted: boolean;
}

/** Operation-local Course Map generation. It performs no persistence or learner governance. */
export async function generateCourseMapPrototype(
  { provider, providerInput, sourceAllocation }: GenerateCourseMapPrototypeInput,
  opts?: ProviderCallOptions,
): Promise<CourseMapPrototypeResult> {
  assertCourseMapProviderInputIntegrity(sourceAllocation, providerInput);
  let repairAttempted = false;
  const payload = await provider.proposeCourseMap(providerInput, {
    ...opts,
    onRepairAttempt: (reason, category) => {
      repairAttempted = true;
      if (category) opts?.onRepairAttempt?.(reason, category);
      else opts?.onRepairAttempt?.(reason);
    },
    validateCandidate: (candidate) => {
      const parsed = CourseMapProposalPayloadSchema.safeParse(candidate);
      if (!parsed.success) {
        return {
          valid: false,
          diagnostics: parsed.error.issues
            .slice(0, 20)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          diagnosticCodes: parsed.error.issues.slice(0, 20).map((issue) => `schema_${issue.code}`),
        };
      }
      const analysis = analyzeCourseMapProposal(parsed.data, {
        providerInput,
        sourceAllocation,
      });
      const local = {
        valid: analysis.validation.valid,
        diagnostics: analysis.validation.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
        diagnosticCodes: analysis.validation.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.code),
      };
      const external = opts?.validateCandidate?.(candidate);
      return external && !external.valid
        ? {
            valid: false,
            diagnostics: [...local.diagnostics, ...external.diagnostics].slice(0, 20),
            diagnosticCodes: [
              ...local.diagnosticCodes,
              ...(external.diagnosticCodes ?? ['external_candidate_validation_failed']),
            ].slice(0, 20),
          }
        : local;
    },
  });
  const analysis = analyzeCourseMapProposal(payload, { providerInput, sourceAllocation });
  if (!analysis.validation.valid) {
    throw ProviderError.invalidOutput(
      analysis.validation.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .slice(0, 20)
        .join('; '),
      'candidate',
    );
  }
  return { analysis, repairAttempted };
}
