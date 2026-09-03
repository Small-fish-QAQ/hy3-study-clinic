import { createHash } from 'node:crypto';
import {
  CourseMapAnalysisSchema,
  CourseMapProposalPayloadSchema,
  CourseMapSourceAllocationSchema,
  type Concept,
  type CurriculumAuthorityEnvelope,
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
  CurriculumCapabilityRecoveryRequirementInput,
  CurriculumCanonicalConceptOffer,
  CurriculumContractContext,
  CurriculumEvidenceOffer,
  LlmProvider,
  ProviderCallOptions,
  ProviderCandidateValidation,
  ProviderCandidateFailureArtifact,
} from '../llm/provider.js';
import { canonicalizeCourseMapProposalOrder } from './courseMapOrdering.js';
import { CourseSourceMapSchema, type CourseSourceMap } from './courseSourceMap.js';
import { validateCourseSourceMapSelectionCorpus } from './curriculumEvidencePolicy.js';
import { validateCourseMapSemanticCoherence } from './curriculumSemanticEvaluator.js';

export const COURSE_MAP_SOURCE_REGION_LIMIT = 120;
export const COURSE_MAP_SOURCE_EVIDENCE_LIMIT = 160;
export const COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT = 2;
export const COURSE_MAP_CONCEPT_OFFER_LIMIT = 160;
export const COURSE_MAP_CANONICAL_OFFER_LIMIT = 120;
export const COURSE_MAP_CAPABILITY_REQUIREMENT_LIMIT = 192;
export const COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT = 4;
export const COURSE_MAP_RECOVERY_EVIDENCE_LIMIT = 240;

/**
 * Local recovery binding. Source-allocation identities and exact evidence
 * remain server-owned while the provider sees only operation-local aliases.
 */
export interface CurriculumCapabilityRecoveryRequirement extends CurriculumCapabilityRecoveryRequirementInput {
  allowedSourceAllocationRegionIds: string[];
}

export const COURSE_MAP_DEFAULT_LIMITS: CourseMapProposalInput['limits'] = {
  maxModules: 24,
  maxRegions: COURSE_MAP_SOURCE_REGION_LIMIT,
  maxPrerequisiteEdges: 240,
  maxPrerequisiteDegree: 8,
  maxSynthesisGroups: 60,
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

function hasFeasibleCapabilityPlacement(
  requirements: NonNullable<CourseMapProposalInput['capabilityRecovery']>['requirements'],
): boolean {
  const slotOwner = new Map<string, number>();
  const assign = (requirementIndex: number, visitedSlots: Set<string>): boolean => {
    const requirement = requirements[requirementIndex]!;
    for (const sourceRegionRef of requirement.allowedSourceRegionRefs) {
      for (
        let slotIndex = 0;
        slotIndex < COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT;
        slotIndex += 1
      ) {
        const slot = `${sourceRegionRef}\u0000${slotIndex}`;
        if (visitedSlots.has(slot)) continue;
        visitedSlots.add(slot);
        const owner = slotOwner.get(slot);
        if (owner === undefined || assign(owner, visitedSlots)) {
          slotOwner.set(slot, requirementIndex);
          return true;
        }
      }
    }
    return false;
  };
  return requirements.every((_requirement, index) => assign(index, new Set()));
}

function assertCourseMapCapabilityRecoveryInputIntegrity(
  providerInput: CourseMapProposalInput,
): void {
  const recovery = providerInput.capabilityRecovery;
  const requirements = recovery?.requirements;
  if (!requirements) return;
  if (requirements.length === 0) {
    throw new Error('Course Map capability recovery must not contain an empty requirement set.');
  }
  if (requirements.length > COURSE_MAP_CAPABILITY_REQUIREMENT_LIMIT) {
    throw new Error('Course Map capability recovery exceeds its hard requirement limit.');
  }
  assertUnique(
    requirements.map((requirement) => requirement.capabilityRef),
    'Course Map capability recovery references',
  );
  const knownSourceRegionRefs = new Set(
    providerInput.sourceRegions.map((region) => region.sourceRegionRef),
  );
  if (recovery.evidenceOffers.length === 0) {
    throw new Error('Course Map capability recovery requires exact placement evidence.');
  }
  if (recovery.evidenceOffers.length > COURSE_MAP_RECOVERY_EVIDENCE_LIMIT) {
    throw new Error('Course Map capability recovery exceeds its exact evidence hard limit.');
  }
  assertUnique(
    recovery.evidenceOffers.map((offer) => offer.recoveryEvidenceRef),
    'Course Map recovery evidence references',
  );
  const recoveryEvidenceByRef = new Map(
    recovery.evidenceOffers.map((offer, index) => {
      if (offer.recoveryEvidenceRef !== `CE${index + 1}`) {
        throw new Error(
          'Course Map recovery evidence references must be contiguous and deterministic.',
        );
      }
      if (
        offer.text.length === 0 ||
        offer.text.length > 320 ||
        !knownSourceRegionRefs.has(offer.sourceRegionRef)
      ) {
        throw new Error('Course Map recovery evidence is stale or outside its source region.');
      }
      return [offer.recoveryEvidenceRef, offer] as const;
    }),
  );
  const referencedRecoveryEvidenceRefs = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.allowedSourceRegionRefs.length === 0) {
      throw new Error(
        `Course Map recovery capability ${requirement.capabilityRef} has no eligible source region.`,
      );
    }
    assertUnique(
      requirement.allowedSourceRegionRefs,
      `Course Map recovery capability ${requirement.capabilityRef} source-region references`,
    );
    if (requirement.allowedSourceRegionRefs.some((ref) => !knownSourceRegionRefs.has(ref))) {
      throw new Error(
        `Course Map recovery capability ${requirement.capabilityRef} references an unknown source region.`,
      );
    }
    if (requirement.allowedRecoveryEvidenceRefs.length === 0) {
      throw new Error(
        `Course Map recovery capability ${requirement.capabilityRef} has no exact placement evidence.`,
      );
    }
    assertUnique(
      requirement.allowedRecoveryEvidenceRefs,
      `Course Map recovery capability ${requirement.capabilityRef} evidence references`,
    );
    const evidenceSourceRegionRefs = new Set<string>();
    for (const evidenceRef of requirement.allowedRecoveryEvidenceRefs) {
      const offer = recoveryEvidenceByRef.get(evidenceRef);
      if (!offer) {
        throw new Error(
          `Course Map recovery capability ${requirement.capabilityRef} references unknown placement evidence.`,
        );
      }
      referencedRecoveryEvidenceRefs.add(evidenceRef);
      evidenceSourceRegionRefs.add(offer.sourceRegionRef);
    }
    assertSameSet(
      evidenceSourceRegionRefs,
      new Set(requirement.allowedSourceRegionRefs),
      `Course Map recovery capability ${requirement.capabilityRef} source scope must derive exactly from its placement evidence.`,
    );
  }
  assertSameSet(
    referencedRecoveryEvidenceRefs,
    new Set(recoveryEvidenceByRef.keys()),
    'Course Map recovery evidence pool must contain exactly the referenced placement evidence.',
  );
  if (!hasFeasibleCapabilityPlacement(requirements)) {
    throw new Error(
      'Course Map capability recovery cannot satisfy the fixed four-objective region capacity.',
    );
  }
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
  const allocationMaterialIds = new Set([
    ...allocation.regions.map((region) => region.materialId),
    ...allocation.assetOnlyMaterials.map((disposition) => disposition.materialId),
  ]);
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
    providerInput.contractVersion !== 'course_map_proposal_v2' ||
    providerInput.sourceAllocationFingerprint !== allocation.fingerprint ||
    providerInput.courseSourceMapFingerprint !== allocation.courseSourceMapFingerprint
  ) {
    throw new Error('Course Map provider context fingerprints do not match the source allocation.');
  }

  assertUnique(
    providerInput.sourceRegions.map((region) => region.sourceRegionRef),
    'Course Map provider source-region references',
  );
  assertUnique(
    providerInput.sourceRegions.map((region) => region.sourceAllocationRegionId),
    'Course Map provider source-allocation bindings',
  );

  if (providerInput.sourceRegions.length !== allocation.regions.length) {
    throw new Error('Course Map provider context must expose every source-allocation region.');
  }
  assertCourseMapCapabilityRecoveryInputIntegrity(providerInput);
  const materialTitleById = new Map(
    providerInput.contract.materials.map((material) => [material.materialId, material.title]),
  );
  let evidenceOfferCount = 0;
  let anchorOptionCount = 0;
  const anchorOptionIds = new Set<string>();
  const offeredConceptIds = new Set<string>();
  const canonicalOwnerByConceptId = new Map<string, string>();
  for (const [index, allocationRegion] of allocation.regions.entries()) {
    const offeredRegion = providerInput.sourceRegions[index];
    const expectedEvidence = allocationRegion.evidence.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      text: evidence.quote,
    }));
    if (
      !offeredRegion ||
      offeredRegion.sourceRegionRef !== `R${index + 1}` ||
      offeredRegion.sourceAllocationRegionId !== allocationRegion.id ||
      offeredRegion.materialId !== allocationRegion.materialId ||
      offeredRegion.materialTitle !== materialTitleById.get(allocationRegion.materialId) ||
      offeredRegion.title !== allocationRegion.title ||
      offeredRegion.sectionCount !== allocationRegion.sourceSectionIds.length ||
      offeredRegion.blockCount !== allocationRegion.sourceBlockIds.length ||
      offeredRegion.charCount !== allocationRegion.charCount ||
      JSON.stringify(offeredRegion.evidence) !== JSON.stringify(expectedEvidence)
    ) {
      throw new Error('Course Map provider source-region view is stale, incomplete, or reordered.');
    }
    let localOptionIndex = 0;
    for (const option of offeredRegion.anchorOptions) {
      localOptionIndex += 1;
      anchorOptionCount += 1;
      if (option.anchorOptionId !== `${offeredRegion.sourceRegionRef}:A${localOptionIndex}`) {
        throw new Error(
          'Course Map anchor-option references must be contiguous and deterministic.',
        );
      }
      if (anchorOptionIds.has(option.anchorOptionId)) {
        throw new Error('Course Map anchor-option references must be globally unique.');
      }
      anchorOptionIds.add(option.anchorOptionId);
      if (
        offeredConceptIds.has(option.binding.conceptId) ||
        !allocationRegion.conceptIds.includes(option.binding.conceptId)
      ) {
        throw new Error('Course Map anchor-option Concept binding is stale or outside its region.');
      }
      offeredConceptIds.add(option.binding.conceptId);
      if (
        option.conceptName.length === 0 ||
        option.conceptSummary.length === 0 ||
        (option.binding.canonicalConceptId === null) !== (option.canonicalConceptName === null)
      ) {
        throw new Error('Course Map anchor-option semantic metadata is incomplete.');
      }
      const canonicalId = option.binding.canonicalConceptId;
      if (canonicalId) {
        const owner = canonicalOwnerByConceptId.get(option.binding.conceptId);
        if (owner && owner !== canonicalId) {
          throw new Error('Course Map Concept belongs to multiple canonical Concept bindings.');
        }
        canonicalOwnerByConceptId.set(option.binding.conceptId, canonicalId);
      }
    }
    if (offeredRegion.evidence.length > COURSE_MAP_SOURCE_EVIDENCE_PER_REGION_LIMIT) {
      throw new Error('Course Map provider evidence visibility exceeds its per-region hard limit.');
    }
    evidenceOfferCount += offeredRegion.evidence.length;
  }
  if (anchorOptionCount > COURSE_MAP_CONCEPT_OFFER_LIMIT) {
    throw new Error('Course Map anchor-option visibility exceeds its hard limit.');
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

  /**
   * Every scoped Material is accounted exactly once: text-allocatable Materials
   * receive at least one region, and a Material with no textual allocation
   * surface receives explicit material-level accounting instead. Zero sections
   * alone never qualifies; only original asset bytes make it legitimate.
   */
  const textAllocatableMaterials = sourceMap.materials.filter(
    (material) => material.sections.length > 0,
  );
  const assetOnlyMaterials: CourseMapSourceAllocation['assetOnlyMaterials'] = [];
  for (const material of sourceMap.materials) {
    if (material.sections.length > 0) continue;
    // Sections derive deterministically from blocks, so surviving text with no
    // section outline is a defect, never a licence to skip textual allocation.
    if (material.blocks.length > 0) {
      throw new Error(
        `Course Map source allocation cannot account for Material ${material.materialId}: it carries SourceBlocks but no derived section outline.`,
      );
    }
    // Defense in depth: `buildCurriculumCourseSourceMap` already refuses a
    // scoped Material with neither SourceBlocks nor original assets, and the
    // sealed source map refuses it again. Keep the check local so allocation
    // never depends on an upstream caller for its own accounting legitimacy.
    if (!material.visuals.some((visual) => visual.contentOrigin === 'extracted_original')) {
      throw new Error(
        `Course Map source allocation cannot account for Material ${material.materialId}: no textual allocation surface and no original visual asset.`,
      );
    }
    assetOnlyMaterials.push({
      materialId: material.materialId,
      materialRevisionId: material.activeMaterialRevisionId,
      reason: 'no_textual_allocation_surface',
      originalVisualCount: material.visuals.filter(
        (visual) => visual.contentOrigin === 'extracted_original',
      ).length,
    });
  }
  if (textAllocatableMaterials.length === 0) {
    throw new Error(
      'Course Map source allocation requires at least one Material with an authoritative textual allocation surface.',
    );
  }

  const totalSectionCount = sourceMap.materials.reduce(
    (count, material) => count + material.sections.length,
    0,
  );
  const targetRegionCount = Math.min(totalSectionCount, maxRegions);
  const quotaByMaterialId = new Map(
    textAllocatableMaterials.map((material) => [material.materialId, 1]),
  );
  let allocatedQuota = textAllocatableMaterials.length;
  while (allocatedQuota < targetRegionCount) {
    const candidate = textAllocatableMaterials
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
  for (const material of textAllocatableMaterials) {
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
    assetOnlyMaterials,
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
  authorityEnvelopesByRegionId?: Map<string, CurriculumAuthorityEnvelope>;
  capabilityRecoveryRequirements?: CurriculumCapabilityRecoveryRequirement[];
  /** Complete exact catalog is required only to construct recovery aliases. */
  evidenceCatalog?: CurriculumEvidenceOffer[];
}

/** Build the only provider-visible Course Map context; it contains no full SourceBlocks. */
export function buildCourseMapProposalInput({
  workspaceName,
  contract,
  sourceAllocation: rawAllocation,
  concepts,
  canonicalConcepts,
  limits: overrides = {},
  authorityEnvelopesByRegionId,
  capabilityRecoveryRequirements = [],
  evidenceCatalog = [],
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
  if (capabilityRecoveryRequirements.length > COURSE_MAP_CAPABILITY_REQUIREMENT_LIMIT) {
    throw new Error('Course Map capability recovery exceeds its hard requirement limit.');
  }
  assertUnique(
    capabilityRecoveryRequirements.map((requirement) => requirement.capabilityRef),
    'Course Map capability recovery references',
  );
  const sourceRegionRefByAllocationId = new Map(
    sourceAllocation.regions.map((region, index) => [region.id, `R${index + 1}`] as const),
  );
  assertUnique(
    evidenceCatalog.map((offer) => offer.id),
    'Course Map recovery evidence identities',
  );
  const evidenceById = new Map(evidenceCatalog.map((offer) => [offer.id, offer] as const));
  const referencedEvidenceIds = new Set(
    capabilityRecoveryRequirements.flatMap((requirement) => requirement.allowedEvidenceIds),
  );
  if (referencedEvidenceIds.size > COURSE_MAP_RECOVERY_EVIDENCE_LIMIT) {
    throw new Error('Course Map capability recovery exceeds its exact evidence hard limit.');
  }
  const recoveryEvidenceBindings = evidenceCatalog
    .filter((offer) => referencedEvidenceIds.has(offer.id))
    .map((offer, index) => {
      const matchingRegions = sourceAllocation.regions.filter(
        (region) =>
          region.materialId === offer.materialId &&
          region.materialRevisionId === offer.materialRevisionId &&
          region.sourceBlockIds.includes(offer.blockId),
      );
      if (matchingRegions.length !== 1) {
        throw new Error('Course Map recovery evidence is stale or outside the source allocation.');
      }
      const sourceAllocationRegionId = matchingRegions[0]!.id;
      return {
        recoveryEvidenceRef: `CE${index + 1}`,
        sourceRegionRef: sourceRegionRefByAllocationId.get(sourceAllocationRegionId)!,
        text: offer.quote,
        evidenceId: offer.id,
        sourceAllocationRegionId,
      };
    });
  if (recoveryEvidenceBindings.length !== referencedEvidenceIds.size) {
    throw new Error('Course Map recovery capability references unknown exact evidence.');
  }
  const recoveryEvidenceRefById = new Map(
    recoveryEvidenceBindings.map((offer) => [offer.evidenceId, offer.recoveryEvidenceRef]),
  );
  const recoveryEvidenceOffers = recoveryEvidenceBindings.map(
    ({ evidenceId: _evidenceId, sourceAllocationRegionId: _allocationId, ...offer }) => offer,
  );
  const providerCapabilityRequirements = capabilityRecoveryRequirements.map((requirement) => {
    assertUnique(
      requirement.allowedSourceAllocationRegionIds,
      `Course Map recovery capability ${requirement.capabilityRef} source-allocation identities`,
    );
    assertUnique(
      requirement.allowedEvidenceIds,
      `Course Map recovery capability ${requirement.capabilityRef} evidence identities`,
    );
    if (
      requirement.allowedSourceAllocationRegionIds.length === 0 ||
      requirement.allowedEvidenceIds.length === 0
    ) {
      throw new Error(
        `Course Map recovery capability ${requirement.capabilityRef} requires eligible source and evidence scope.`,
      );
    }
    if (
      requirement.allowedSourceAllocationRegionIds.some(
        (sourceAllocationRegionId) => !sourceRegionRefByAllocationId.has(sourceAllocationRegionId),
      )
    ) {
      throw new Error(
        `Course Map recovery capability ${requirement.capabilityRef} references an unknown source allocation.`,
      );
    }
    const exactAllocationIds = new Set<string>();
    const allowedRecoveryEvidenceRefs = requirement.allowedEvidenceIds.map((evidenceId) => {
      const offer = evidenceById.get(evidenceId);
      const evidenceRef = recoveryEvidenceRefById.get(evidenceId);
      const recoveryOffer = recoveryEvidenceBindings.find(
        (candidate) => candidate.recoveryEvidenceRef === evidenceRef,
      );
      if (!offer || !evidenceRef || !recoveryOffer) {
        throw new Error(
          `Course Map recovery capability ${requirement.capabilityRef} references unknown exact evidence.`,
        );
      }
      exactAllocationIds.add(recoveryOffer.sourceAllocationRegionId);
      return evidenceRef;
    });
    assertSameSet(
      exactAllocationIds,
      new Set(requirement.allowedSourceAllocationRegionIds),
      `Course Map recovery capability ${requirement.capabilityRef} source scope must derive exactly from its allowed evidence.`,
    );
    const allowedSourceRegionRefs = sourceAllocation.regions.flatMap((region) =>
      exactAllocationIds.has(region.id) ? [sourceRegionRefByAllocationId.get(region.id)!] : [],
    );
    return {
      capabilityRef: requirement.capabilityRef,
      title: requirement.title,
      description: requirement.description,
      originalProposition: requirement.originalProposition,
      construct: requirement.construct,
      priority: requirement.priority,
      subjectClass: requirement.subjectClass,
      scopeOrigin: requirement.scopeOrigin,
      allowedSourceRegionRefs,
      allowedRecoveryEvidenceRefs,
    };
  });
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
  };
  const canonicalBySourceConceptId = new Map<string, (typeof offeredCanonicalConcepts)[number]>();
  for (const canonical of offeredCanonicalConcepts) {
    for (const conceptId of canonical.sourceConceptIds) {
      canonicalBySourceConceptId.set(conceptId, canonical);
    }
  }
  const providerInput: CourseMapProposalInput = {
    contractVersion: 'course_map_proposal_v2',
    workspaceName,
    contract,
    courseSourceMapFingerprint: sourceAllocation.courseSourceMapFingerprint,
    sourceAllocationFingerprint: sourceAllocation.fingerprint,
    sourceRegions: sourceAllocation.regions.map((region, regionIndex) => {
      const sourceRegionRef = `R${regionIndex + 1}`;
      return {
        sourceRegionRef,
        sourceAllocationRegionId: region.id,
        materialId: region.materialId,
        materialTitle: materialTitleById.get(region.materialId)!,
        title: region.title,
        sectionCount: region.sourceSectionIds.length,
        blockCount: region.sourceBlockIds.length,
        charCount: region.charCount,
        anchorOptions: region.conceptIds
          .filter((conceptId) => offeredConceptIdSet.has(conceptId))
          .map((conceptId, optionIndex) => {
            const concept = conceptById.get(conceptId)!;
            const canonical = canonicalBySourceConceptId.get(conceptId) ?? null;
            return {
              anchorOptionId: `${sourceRegionRef}:A${optionIndex + 1}`,
              conceptName: concept.name,
              conceptSummary: concept.summary,
              importance: concept.importance,
              canonicalConceptName: canonical?.displayName ?? null,
              binding: {
                conceptId,
                canonicalConceptId: canonical?.id ?? null,
              },
            };
          }),
        evidence: region.evidence.map((evidence) => ({
          evidenceId: evidence.evidenceId,
          text: evidence.quote,
        })),
        ...(authorityEnvelopesByRegionId?.has(region.id)
          ? { authorityEnvelope: authorityEnvelopesByRegionId.get(region.id) }
          : {}),
      };
    }),
    ...(providerCapabilityRequirements.length > 0
      ? {
          capabilityRecovery: {
            evidenceOffers: recoveryEvidenceOffers,
            requirements: providerCapabilityRequirements,
          },
        }
      : {}),
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
  const emitted = CourseMapProposalPayloadSchema.parse(payload);
  const sourceAllocation = CourseMapSourceAllocationSchema.parse(context.sourceAllocation);
  assertCourseMapProviderInputIntegrity(sourceAllocation, context.providerInput);
  const allocationById = new Map(sourceAllocation.regions.map((region) => [region.id, region]));
  // Canonicalize before the fingerprint, so identity follows canonical order
  // rather than the order the provider happened to emit.
  const canonicalOrder = canonicalizeCourseMapProposalOrder(
    emitted,
    new Map(
      context.providerInput.sourceRegions.flatMap((region) => {
        const allocation = allocationById.get(region.sourceAllocationRegionId);
        return allocation ? [[region.sourceRegionRef, allocation.index] as const] : [];
      }),
    ),
  );
  const parsed = canonicalOrder.payload;
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

  const proposedSourceRefs = new Set(
    parsed.modules.flatMap((module) => module.regions.map((region) => region.sourceRegionRef)),
  );
  for (const disposition of parsed.sourceDispositions ?? []) {
    const sourceIndex = Number(disposition.sourceRegionRef.slice(1)) - 1;
    if (!sourceAllocation.regions[sourceIndex]) {
      add(
        'error',
        'unknown_source_disposition_region',
        'Course Map source disposition references an unknown offered source region.',
        [disposition.sourceRegionRef],
      );
      continue;
    }
    for (const representedRef of disposition.representedRegionRefs) {
      if (!proposedSourceRefs.has(representedRef)) {
        add(
          'error',
          'source_disposition_inconsistent',
          'A source disposition claims representation by a region that is not in the skeleton.',
          [disposition.sourceRegionRef, representedRef],
        );
      }
    }
    if (
      disposition.disposition === 'represented_directly' &&
      !proposedSourceRefs.has(disposition.sourceRegionRef)
    ) {
      add(
        'error',
        'source_disposition_inconsistent',
        'A directly represented source disposition has no corresponding skeleton region.',
        [disposition.sourceRegionRef],
      );
    }
  }

  const sourceOfferByRef = new Map(
    context.providerInput.sourceRegions.map((region) => [region.sourceRegionRef, region]),
  );
  const anchorOptionById = new Map(
    context.providerInput.sourceRegions.flatMap((region) =>
      region.anchorOptions.map((option) => [option.anchorOptionId, { region, option }] as const),
    ),
  );
  const regionIdByRef = new Map<string, string>();
  const regionOrderByRef = new Map<string, number>();
  const regionModuleKeyByRef = new Map<string, string>();
  const materializedModules: CourseMap['modules'] = [];
  const capabilityRequirementByRef = new Map(
    (context.providerInput.capabilityRecovery?.requirements ?? []).map((requirement) => [
      requirement.capabilityRef,
      requirement,
    ]),
  );
  const capabilityRequirementUseCount = new Map<string, number>();
  const allocationUseCount = new Map<string, number>();
  const sourceBlockIdsByProposedRegion = new Map<string, Set<string>>();
  let unsupportedRegionCount = 0;
  let invalidAnchorCount = 0;
  let globalRegionOrder = 0;

  for (const [modulePosition, proposedModule] of parsed.modules.entries()) {
    const moduleKey = `module-${modulePosition + 1}`;
    const moduleId = stableId('course_map_module', {
      allocation: sourceAllocation.fingerprint,
      proposal: proposalFingerprint,
      key: moduleKey,
      index: modulePosition,
    });
    const regions: CourseMap['modules'][number]['regions'] = [];
    for (const [regionPosition, proposedRegion] of proposedModule.regions.entries()) {
      const regionKey = `region-${globalRegionOrder + 1}`;
      const sourceOffer = sourceOfferByRef.get(proposedRegion.sourceRegionRef);
      const allocation = sourceOffer
        ? allocationById.get(sourceOffer.sourceAllocationRegionId)
        : undefined;
      if (!sourceOffer || !allocation) {
        add(
          'error',
          'unknown_source_region',
          'Course Map region references an unknown offered source-region ref.',
          [regionKey, proposedRegion.sourceRegionRef],
        );
      }
      if (!allocation) {
        unsupportedRegionCount += 1;
        add('error', 'unsupported_region', 'Course Map region has no valid source allocation.', [
          regionKey,
        ]);
      } else {
        allocationUseCount.set(allocation.id, (allocationUseCount.get(allocation.id) ?? 0) + 1);
      }
      const conceptIds: string[] = [];
      const canonicalConceptIds: string[] = [];
      const selectedConceptIds = new Set<string>();
      const selectedCanonicalIds = new Set<string>();
      for (const anchorOptionId of proposedRegion.anchorOptionRefs) {
        const resolved = anchorOptionById.get(anchorOptionId);
        if (!resolved) {
          invalidAnchorCount += 1;
          add(
            'error',
            'unknown_anchor_option',
            'Course Map region references an unknown offered anchor option.',
            [regionKey, anchorOptionId],
          );
          continue;
        }
        if (resolved.region.sourceRegionRef !== proposedRegion.sourceRegionRef) {
          invalidAnchorCount += 1;
          add(
            'error',
            'anchor_option_outside_region',
            'Course Map anchor option is outside the selected source region.',
            [regionKey, anchorOptionId],
          );
          continue;
        }
        const { conceptId, canonicalConceptId } = resolved.option.binding;
        if (!selectedConceptIds.has(conceptId)) {
          selectedConceptIds.add(conceptId);
          conceptIds.push(conceptId);
        }
        if (canonicalConceptId && !selectedCanonicalIds.has(canonicalConceptId)) {
          selectedCanonicalIds.add(canonicalConceptId);
          canonicalConceptIds.push(canonicalConceptId);
        }
      }
      if (conceptIds.length > 20 || canonicalConceptIds.length > 10) {
        add('error', 'region_limit_exceeded', 'Course Map region exceeds its anchor limit.', [
          regionKey,
        ]);
      }
      const capabilityRequirementRefs = proposedRegion.capabilityRequirementRefs ?? [];
      if (capabilityRequirementRefs.length > COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT) {
        add(
          'error',
          'recovery_capability_region_capacity_exceeded',
          'Course Map region exceeds the fixed recovery-capability capacity.',
          [regionKey],
        );
      }
      for (const capabilityRef of capabilityRequirementRefs) {
        const requirement = capabilityRequirementByRef.get(capabilityRef);
        if (!requirement) {
          add(
            'error',
            'recovery_capability_unknown',
            'Course Map region references an unknown or unsolicited recovery capability.',
            [regionKey, capabilityRef],
          );
          continue;
        }
        capabilityRequirementUseCount.set(
          capabilityRef,
          (capabilityRequirementUseCount.get(capabilityRef) ?? 0) + 1,
        );
        if (!requirement.allowedSourceRegionRefs.includes(proposedRegion.sourceRegionRef)) {
          add(
            'error',
            'recovery_capability_outside_source_envelope',
            'Course Map placed a recovery capability outside its eligible source envelope.',
            [regionKey, capabilityRef, proposedRegion.sourceRegionRef],
          );
        }
      }
      const regionId = stableId('course_map_region', {
        allocation: sourceAllocation.fingerprint,
        proposal: proposalFingerprint,
        moduleKey,
        key: regionKey,
        index: regionPosition,
      });
      if (!regionIdByRef.has(proposedRegion.sourceRegionRef)) {
        regionIdByRef.set(proposedRegion.sourceRegionRef, regionId);
        regionOrderByRef.set(proposedRegion.sourceRegionRef, globalRegionOrder);
        regionModuleKeyByRef.set(proposedRegion.sourceRegionRef, moduleKey);
      }
      globalRegionOrder += 1;
      const sourceBlockIds = new Set(allocation?.sourceBlockIds ?? []);
      sourceBlockIdsByProposedRegion.set(regionKey, sourceBlockIds);
      regions.push({
        id: regionId,
        proposalKey: regionKey,
        moduleId,
        index: regionPosition,
        title: proposedRegion.title,
        learningIntent: proposedRegion.learningIntent,
        approximateScope: proposedRegion.approximateScope,
        focus:
          context.providerInput.contract.focusRequest?.trim() && proposedRegion.focus === 'focused'
            ? 'focused'
            : 'normal',
        sourceAllocationRegionIds: allocation ? [allocation.id] : [proposedRegion.sourceRegionRef],
        materialIds: allocation ? [allocation.materialId] : [],
        conceptIds,
        canonicalConceptIds,
        expectedOutcome: proposedRegion.learningIntent.slice(0, 500),
        ...(capabilityRequirementRefs.length > 0
          ? { capabilityRequirementRefs: [...capabilityRequirementRefs] }
          : {}),
      });
    }
    materializedModules.push({
      id: moduleId,
      proposalKey: moduleKey,
      index: modulePosition,
      title: proposedModule.title,
      learningIntent: proposedModule.learningIntent,
      sequenceRationale: `按“${proposedModule.learningIntent}”建立从基础到应用的连续学习顺序。`,
      regions,
    });
  }

  for (const capabilityRef of capabilityRequirementByRef.keys()) {
    const useCount = capabilityRequirementUseCount.get(capabilityRef) ?? 0;
    if (useCount === 0) {
      add(
        'error',
        'recovery_capability_missing',
        'Course Map omitted an offered recovery capability.',
        [capabilityRef],
      );
    } else if (useCount > 1) {
      add(
        'error',
        'recovery_capability_duplicate',
        'Course Map placed a recovery capability more than once.',
        [capabilityRef],
      );
    }
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
    const dispositionsByRef = new Map(
      (parsed.sourceDispositions ?? []).map((disposition) => [
        disposition.sourceRegionRef,
        disposition,
      ]),
    );
    const unresolved = unallocatedSourceRegions.filter((region) => {
      const ref = `R${sourceAllocation.regions.indexOf(region) + 1}`;
      const disposition = dispositionsByRef.get(ref);
      return !disposition || disposition.disposition === 'unresolved_candidate_gap';
    });
    const explained = unallocatedSourceRegions.length - unresolved.length;
    if (explained > 0) {
      add(
        'warning',
        'unallocated_source_region',
        `${explained} source-allocation regions are intentionally classified rather than directly represented.`,
        unallocatedSourceRegions
          .filter((region) => !unresolved.includes(region))
          .slice(0, 20)
          .map((region) => {
            const sourceRef = `R${sourceAllocation.regions.indexOf(region) + 1}`;
            return `${sourceRef}:${region.id}`;
          }),
      );
    }
    if (unresolved.length > 0) {
      add(
        'error',
        'unallocated_source_region',
        `${unresolved.length} meaningful source-allocation regions have no explicit coverage disposition.`,
        unresolved.slice(0, 20).map((region) => {
          const sourceRef = `R${sourceAllocation.regions.indexOf(region) + 1}`;
          return `${sourceRef}:${region.id}`;
        }),
      );
    }
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
    const prerequisiteId = regionIdByRef.get(edge.prerequisiteRegionRef);
    const dependentId = regionIdByRef.get(edge.dependentRegionRef);
    if (!prerequisiteId || !dependentId) {
      prerequisiteTopologyValid = false;
      add(
        'error',
        'unknown_prerequisite_region',
        'Course Map prerequisite references an unknown offered source-region ref.',
        [edge.prerequisiteRegionRef, edge.dependentRegionRef],
      );
      continue;
    }
    if (prerequisiteId === dependentId) {
      prerequisiteTopologyValid = false;
      add('error', 'self_prerequisite', 'Course Map region cannot be its own prerequisite.', [
        edge.prerequisiteRegionRef,
      ]);
      continue;
    }
    const key = `${prerequisiteId}\u0000${dependentId}`;
    if (prerequisiteKeys.has(key)) {
      prerequisiteTopologyValid = false;
      add('error', 'duplicate_prerequisite', 'Course Map prerequisite edge is duplicated.', [
        edge.prerequisiteRegionRef,
        edge.dependentRegionRef,
      ]);
      continue;
    }
    prerequisiteKeys.add(key);
    if (
      regionOrderByRef.get(edge.prerequisiteRegionRef)! >=
      regionOrderByRef.get(edge.dependentRegionRef)!
    ) {
      prerequisiteTopologyValid = false;
      add(
        'error',
        'prerequisite_wrong_order',
        'Prerequisite region must occur before its dependent region.',
        [edge.prerequisiteRegionRef, edge.dependentRegionRef],
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
      rationale: '先完成前置区域的核心概念，再进入依赖该基础的区域。',
    });
  }
  const allRegionIds = [...regionIdByRef.values()];
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
  // A region graph can be acyclic while the same edges contracted onto modules
  // cycle. Module children must stay contiguous, so no canonical order exists.
  if (!hasCycle && !canonicalOrder.moduleOrderRepresentable) {
    prerequisiteTopologyValid = false;
    add(
      'error',
      'invalid_module_order',
      'Course Map prerequisites require modules to interleave, so no module order can satisfy them.',
    );
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
  const synthesisRegionIds = new Set<string>();
  if (parsed.synthesisGroups.length > context.providerInput.limits.maxSynthesisGroups) {
    add(
      'error',
      'invalid_synthesis_boundary',
      'Course Map exceeds the offered synthesis-group limit.',
    );
  }
  for (const [groupIndex, group] of parsed.synthesisGroups.entries()) {
    const groupKey = `synthesis-${groupIndex + 1}`;
    const localRegionKeys = new Set<string>();
    const regionIds: string[] = [];
    for (const regionRef of group.regionRefs) {
      const id = regionIdByRef.get(regionRef);
      if (!id) {
        add(
          'error',
          'unknown_synthesis_region',
          'Course Map synthesis group references an unknown offered source-region ref.',
          [groupKey, regionRef],
        );
      } else if (localRegionKeys.has(regionRef)) {
        add('error', 'duplicate_synthesis_region', 'Course Map synthesis group repeats a region.', [
          groupKey,
          regionRef,
        ]);
      } else {
        localRegionKeys.add(regionRef);
        regionIds.push(id);
        synthesisRegionIds.add(id);
      }
    }
    if (
      group.level === 'module' &&
      new Set(group.regionRefs.map((ref) => regionModuleKeyByRef.get(ref))).size !== 1
    ) {
      add(
        'error',
        'invalid_synthesis_boundary',
        'Module-level synthesis must stay within one Course Map module.',
        [groupKey],
      );
    }
    if (regionIds.length >= 2) {
      materializedSynthesis.push({
        id: stableId('course_map_synthesis', {
          allocation: sourceAllocation.fingerprint,
          proposal: proposalFingerprint,
          key: groupKey,
        }),
        proposalKey: groupKey,
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
            [left.sourceRegionRef, right.sourceRegionRef],
          );
        }
      } else if (nearDuplicate(left.learningIntent, right.learningIntent)) {
        nearDuplicateIntentPairCount += 1;
        if (nearDuplicateIntentPairCount <= 20) {
          add(
            'warning',
            'near_duplicate_region_intent',
            'Course Map regions have near-duplicate learning intents.',
            [left.sourceRegionRef, right.sourceRegionRef],
          );
        }
      }
    }
  }
  const flat = parsed.modules.length === 1 && proposedRegionCount >= 4;
  if (flat) {
    add('warning', 'flat_hierarchy', 'Course Map keeps a multi-region course in one module.', [
      'module-1',
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
    sourceDispositions: sourceAllocation.regions.map((region, regionIndex) => {
      const sourceRef = `R${regionIndex + 1}`;
      const explicit = (parsed.sourceDispositions ?? []).find(
        (candidate) => candidate.sourceRegionRef === sourceRef,
      );
      const directlyRepresented = parsed.modules
        .flatMap((module) => module.regions)
        .some((candidate) => candidate.sourceRegionRef === sourceRef);
      const disposition =
        explicit?.disposition ??
        (directlyRepresented ? 'represented_directly' : 'unresolved_candidate_gap');
      return {
        sourceAllocationRegionId: region.id,
        disposition,
        rationale:
          explicit?.rationale ??
          (directlyRepresented
            ? '该精确来源区域被纳入课程骨架并进入详细生成。'
            : '该来源区域尚未在课程骨架中找到可解释的覆盖归属。'),
        representedRegionRefs:
          explicit?.representedRegionRefs ?? (directlyRepresented ? [sourceRef] : []),
      };
    }),
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
      conceptAnchorCount: materializedModules
        .flatMap((module) => module.regions)
        .reduce((count, region) => count + region.conceptIds.length, 0),
      canonicalConceptAnchorCount: materializedModules
        .flatMap((module) => module.regions)
        .reduce((count, region) => count + region.canonicalConceptIds.length, 0),
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
  /** Exact downstream detail-budget preflight for each candidate analysis. */
  validateAnalysis?: (analysis: CourseMapAnalysis) => ProviderCandidateValidation;
}

export interface CourseMapPrototypeResult {
  analysis: CourseMapAnalysis;
  repairAttempted: boolean;
}

/**
 * Candidate diagnostics retain local identities for server-side inspection,
 * but a REAL_HY3 repair request may receive only the operation-local aliases
 * already present in the original Course Map prompt. Strip structured facts
 * and replace any local identity that reached a diagnostic string before the
 * validation result crosses that provider boundary.
 */
function courseMapProviderFacingValidation(
  validation: ProviderCandidateValidation,
  sourceAllocation: CourseMapSourceAllocation,
  courseMap: CourseMap,
): ProviderCandidateValidation {
  const sourceRefByAllocationId = new Map<string, string>(
    sourceAllocation.regions.map((region, index) => [region.id, `R${index + 1}`] as const),
  );
  const replacements: Array<readonly [string, string]> = [];
  for (const [index, region] of sourceAllocation.regions.entries()) {
    const sourceRef = `R${index + 1}`;
    replacements.push([`${sourceRef}:${region.id}`, sourceRef], [region.id, sourceRef]);
  }
  for (const [moduleIndex, module] of courseMap.modules.entries()) {
    replacements.push([module.id, `module-${moduleIndex + 1}`]);
    for (const [regionIndex, region] of module.regions.entries()) {
      const sourceRefs = region.sourceAllocationRegionIds
        .map((allocationId) => sourceRefByAllocationId.get(allocationId))
        .filter((value): value is string => value !== undefined);
      replacements.push([region.id, sourceRefs.join('+') || `region-${regionIndex + 1}`]);
    }
  }
  for (const [index, group] of courseMap.synthesisGroups.entries()) {
    replacements.push([group.id, `synthesis-${index + 1}`]);
  }
  replacements.push(
    [courseMap.id, 'course-map'],
    [sourceAllocation.fingerprint, 'source-allocation'],
    [sourceAllocation.courseSourceMapFingerprint, 'course-source-map'],
  );
  replacements.sort((left, right) => right[0].length - left[0].length);
  const sanitize = (value: string): string => {
    let result = value;
    for (const [localIdentity, alias] of replacements) {
      result = result.replaceAll(localIdentity, alias);
    }
    return result;
  };
  const {
    failureArtifact,
    targetedRepair: _targetedRepair,
    ...withoutProviderUnsafeDetails
  } = validation;
  return {
    ...withoutProviderUnsafeDetails,
    diagnostics: validation.diagnostics.map(sanitize),
    ...(failureArtifact
      ? {
          failureArtifact: {
            kind: failureArtifact.kind,
            context: {},
            diagnostics: failureArtifact.diagnostics.map((diagnostic) => ({
              code: diagnostic.code,
              message: sanitize(diagnostic.message),
            })),
          },
        }
      : {}),
  };
}

/**
 * Recover only omitted, unclassified source regions during the single bounded
 * candidate repair. Every recovered region becomes a real Course Map region;
 * disposition arithmetic is derived later from that region and is never used
 * as a substitute for final Curriculum membership.
 */
export function repairOmittedCourseMapCoverage(
  candidate: CourseMapProposalPayload,
  providerInput: CourseMapProposalInput,
  sourceAllocation: CourseMapSourceAllocation,
): boolean {
  const proposedRefs = new Set(
    candidate.modules.flatMap((module) => module.regions.map((region) => region.sourceRegionRef)),
  );
  const explicitRefs = new Set(
    (candidate.sourceDispositions ?? []).map((disposition) => disposition.sourceRegionRef),
  );
  const omitted = providerInput.sourceRegions.filter(
    (region) =>
      !proposedRefs.has(region.sourceRegionRef) && !explicitRefs.has(region.sourceRegionRef),
  );
  if (omitted.length === 0) return false;

  const proposedRegionCount = candidate.modules.reduce(
    (count, module) => count + module.regions.length,
    0,
  );
  if (proposedRegionCount + omitted.length > providerInput.limits.maxRegions) return false;
  const lastModule = candidate.modules.at(-1);
  if (!lastModule) return false;

  for (const sourceRegion of omitted) {
    const allocation = sourceAllocation.regions.find(
      (region) => region.id === sourceRegion.sourceAllocationRegionId,
    );
    if (!allocation) return false;
    lastModule.regions.push({
      sourceRegionRef: sourceRegion.sourceRegionRef,
      title: sourceRegion.title,
      learningIntent: `直接覆盖资料区域“${sourceRegion.title}”中的核心学习内容。`,
      approximateScope:
        sourceRegion.blockCount <= 2
          ? 'focused'
          : sourceRegion.blockCount >= 12
            ? 'extended'
            : 'standard',
      focus: 'normal',
      anchorOptionRefs: sourceRegion.anchorOptions.map((option) => option.anchorOptionId),
    });
  }
  return true;
}

/** Operation-local Course Map generation. It performs no persistence or learner governance. */
export async function generateCourseMapPrototype(
  { provider, providerInput, sourceAllocation, validateAnalysis }: GenerateCourseMapPrototypeInput,
  opts?: ProviderCallOptions,
): Promise<CourseMapPrototypeResult> {
  assertCourseMapProviderInputIntegrity(sourceAllocation, providerInput);
  let repairAttempted = false;
  let repairArmed = false;
  const payload = await provider.proposeCourseMap(structuredClone(providerInput), {
    ...opts,
    onRepairAttempt: (reason, category) => {
      repairAttempted = true;
      repairArmed = true;
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
      if (repairArmed) {
        repairOmittedCourseMapCoverage(
          candidate as CourseMapProposalPayload,
          providerInput,
          sourceAllocation,
        );
      }
      const repairedCandidate = CourseMapProposalPayloadSchema.parse(candidate);
      const analysis = analyzeCourseMapProposal(repairedCandidate, {
        providerInput,
        sourceAllocation,
      });
      const localDiagnostics = analysis.validation.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
      const local: ProviderCandidateValidation = {
        valid: analysis.validation.valid,
        diagnostics: localDiagnostics.map(
          (diagnostic) =>
            `${diagnostic.code}${diagnostic.entityKeys.length > 0 ? ` [${diagnostic.entityKeys.join(', ')}]` : ''}: ${diagnostic.message}`,
        ),
        diagnosticCodes: localDiagnostics.map((diagnostic) => diagnostic.code),
        ...(localDiagnostics.length > 0
          ? {
              failureArtifact: {
                kind: 'course_map_local_validation_failed',
                context: {
                  courseMapId: analysis.courseMap.id,
                  sourceAllocationFingerprint: sourceAllocation.fingerprint,
                },
                diagnostics: localDiagnostics.slice(0, 20).map((diagnostic) => ({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  facts: { entityKeys: diagnostic.entityKeys },
                })),
              },
            }
          : {}),
      };
      const semantic = validateCourseMapSemanticCoherence(
        analysis.courseMap,
        analysis.sourceAllocation,
      );
      const detailPlan = validateAnalysis?.(analysis);
      const external = opts?.validateCandidate?.(candidate);
      const validations = [
        local,
        semantic,
        ...(detailPlan ? [detailPlan] : []),
        ...(external ? [external] : []),
      ].map((validation) =>
        courseMapProviderFacingValidation(validation, sourceAllocation, analysis.courseMap),
      );
      const failedValidations = validations.filter((validation) => !validation.valid);
      const failureDiagnostics: ProviderCandidateFailureArtifact['diagnostics'] = failedValidations
        .flatMap(
          (validation) =>
            validation.failureArtifact?.diagnostics ??
            validation.diagnostics.map((message, index) => ({
              code: validation.diagnosticCodes?.[index] ?? 'candidate_validation_failed',
              message,
            })),
        )
        .slice(0, 20);
      return {
        valid: failedValidations.length === 0,
        diagnostics: validations.flatMap((validation) => validation.diagnostics).slice(0, 20),
        diagnosticCodes: validations
          .flatMap((validation) => validation.diagnosticCodes ?? [])
          .slice(0, 20),
        ...(failureDiagnostics.length > 0
          ? {
              failureArtifact: {
                kind: 'course_map_candidate_validation_failed',
                context: {},
                diagnostics: failureDiagnostics,
              },
            }
          : {}),
      };
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
  const semantic = validateCourseMapSemanticCoherence(
    analysis.courseMap,
    analysis.sourceAllocation,
  );
  if (!semantic.valid) {
    throw ProviderError.invalidOutput(semantic.diagnostics.slice(0, 20).join('; '), 'candidate');
  }
  const detailPlan = validateAnalysis?.(analysis);
  if (detailPlan && !detailPlan.valid) {
    throw ProviderError.invalidOutput(
      detailPlan.diagnostics.slice(0, 20).join('; '),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      false,
      detailPlan.failureArtifact,
    );
  }
  return { analysis, repairAttempted };
}
