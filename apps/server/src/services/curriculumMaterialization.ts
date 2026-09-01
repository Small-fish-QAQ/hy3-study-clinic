import { createHash } from 'node:crypto';
import {
  CurriculumDetailProposalPayloadSchema,
  CurriculumProposalPayloadSchema,
  type Concept,
  type CourseMap,
  type CourseMapSourceAllocation,
  type CurriculumAuthorityEnvelope,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
  type LocallyAssembledCurriculumProposal,
  type SourceBlock,
} from '@hy3-clinic/shared';
import type {
  CurriculumCanonicalConceptOffer,
  CurriculumCapabilityRecoveryRequirementInput,
  CurriculumContractContext,
  CurriculumDetailProposalInput,
  CurriculumDetailRegionInput,
  CurriculumEvidenceOffer,
  ProviderCandidateFailureArtifact,
  ProviderCandidateValidation,
} from '../llm/provider.js';
import { measureCurriculumDetailRequest } from '../llm/prompts.js';
import {
  COURSE_MAP_CAPABILITY_REQUIREMENT_LIMIT,
  COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT,
  assertCourseMapSourceAllocationIntegrity,
  type CurriculumCapabilityRecoveryRequirement,
} from './courseMap.js';
import { hasCurriculumSemanticAnchor } from './curriculumSemanticEvaluator.js';
import {
  curriculumTargetRequestsApplication,
  isConstructSupported,
} from './curriculumAuthority.js';
import { OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES } from './objectiveAuthoritySemanticSupport.js';

export const MAX_DETAIL_BATCHES = 2;
export const MAX_DETAIL_REGIONS_PER_BATCH = 50;
export const MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH = 120;
export const MAX_DETAIL_REQUEST_BYTES = 120_000;
export const MAX_DETAIL_OUTPUT_ESTIMATE_BYTES = 62_000;
export const DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE = 1_200;
export const DETAIL_OUTPUT_BYTES_PER_RECOVERY_OBJECTIVE_ESTIMATE = 2_200;
const DETAIL_OUTPUT_BASE_BYTES_ESTIMATE = 2_000;

function minimumRecoveryDetailOutputBytes(requirementCount: number): number {
  const minimumRegionCount = Math.ceil(
    requirementCount / COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT,
  );
  return (
    DETAIL_OUTPUT_BASE_BYTES_ESTIMATE +
    minimumRegionCount * DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE +
    requirementCount * DETAIL_OUTPUT_BYTES_PER_RECOVERY_OBJECTIVE_ESTIMATE
  );
}

const MAX_RECOVERY_REQUIREMENTS_PER_DETAIL_BATCH = (() => {
  let count = 0;
  while (minimumRecoveryDetailOutputBytes(count + 1) <= MAX_DETAIL_OUTPUT_ESTIMATE_BYTES) {
    count += 1;
  }
  return count;
})();

export interface CurriculumDetailPlanningInput {
  workspaceName: string;
  contract: CurriculumContractContext;
  courseMap: CourseMap;
  sourceAllocation: CourseMapSourceAllocation;
  evidenceCatalog: CurriculumEvidenceOffer[];
  concepts: Concept[];
  canonicalConcepts: CurriculumCanonicalConceptOffer[];
  authorityEnvelopesByRegionId?: Map<string, CurriculumAuthorityEnvelope>;
  authorityEnvelopesByEvidenceId?: Map<string, CurriculumAuthorityEnvelope>;
  capabilityRecoveryRequirements?: CurriculumCapabilityRecoveryRequirement[];
}

export interface CurriculumCapabilityRecoveryDetailFeasibilityContext {
  workspaceName: string;
  contract: CurriculumContractContext;
  sourceAllocation: CourseMapSourceAllocation;
  evidenceCatalog: CurriculumEvidenceOffer[];
  authorityEnvelopesBySourceAllocationRegionId?: ReadonlyMap<string, CurriculumAuthorityEnvelope>;
  authorityEnvelopesByEvidenceId?: ReadonlyMap<string, CurriculumAuthorityEnvelope>;
}

export interface CurriculumDetailBatch {
  index: number;
  input: CurriculumDetailProposalInput;
  requestBytes: number;
  outputEstimateBytes: number;
}

/**
 * Every detail region needs one objective, while each immutable recovery
 * capability needs its own exact objective. An application target also needs
 * one required apply objective in a batch that exposes exact apply authority,
 * unless an ordinary slot or a required apply recovery capability can carry
 * that obligation.
 */
export function minimumCurriculumDetailObjectiveCount(
  regions: readonly Pick<CurriculumDetailRegionInput, 'capabilityRequirements' | 'evidence'>[],
  targetOutcomeDescription = '',
): number {
  const recoveryMinimum = regions.reduce(
    (count, region) => count + Math.max(1, region.capabilityRequirements?.length ?? 0),
    0,
  );
  if (!curriculumTargetRequestsApplication(targetOutcomeDescription)) return recoveryMinimum;

  const applyRegions = regions.filter((region) =>
    region.evidence.some((offer) => offer.authorityEnvelope?.supportedConstructs.includes('apply')),
  );
  if (applyRegions.length === 0) return recoveryMinimum;

  const hasCoincidentRequiredApply = applyRegions.some((region) => {
    const evidenceById = new Map(
      region.evidence.map((offer) => [offer.evidenceId, offer] as const),
    );
    return (region.capabilityRequirements ?? []).some(
      (requirement) =>
        requirement.construct === 'apply' &&
        requirement.priority === 'required' &&
        requirement.allowedEvidenceIds.some((evidenceId) =>
          evidenceById.get(evidenceId)?.authorityEnvelope?.supportedConstructs.includes('apply'),
        ),
    );
  });
  if (hasCoincidentRequiredApply) return recoveryMinimum;

  if (applyRegions.some((region) => (region.capabilityRequirements?.length ?? 0) === 0)) {
    return recoveryMinimum;
  }
  const applyRegionWithFreeObjective = applyRegions.find(
    (region) =>
      (region.capabilityRequirements?.length ?? 0) <
      COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT,
  );
  if (!applyRegionWithFreeObjective) {
    throw new CurriculumDetailBatchPlanningError(
      [
        'Application authority is available, but every eligible detail region is filled by four non-coincident recovery capabilities.',
      ],
      ['required_target_apply_capacity_unavailable'],
    );
  }
  return recoveryMinimum + 1;
}

/**
 * Preserve the server-owned Course Map allocation as exact final-node
 * membership. This is navigation/provenance identity only; it does not prove
 * that every block semantically entails every generated objective.
 */
export function buildCourseMapDeterministicCoverage(
  courseMap: CourseMap,
  sourceAllocation: CourseMapSourceAllocation,
  blocks: readonly SourceBlock[],
): Map<string, { structuralUnitIds: string[]; sourceBlockIds: string[] }> {
  assertCourseMapSourceAllocationIntegrity(sourceAllocation);
  const allocationById = new Map(sourceAllocation.regions.map((region) => [region.id, region]));
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const result = new Map<string, { structuralUnitIds: string[]; sourceBlockIds: string[] }>();
  let regionIndex = 0;
  for (const module of courseMap.modules) {
    for (const region of module.regions) {
      const sourceBlockIds = [
        ...new Set(
          region.sourceAllocationRegionIds.flatMap(
            (allocationId) => allocationById.get(allocationId)?.sourceBlockIds ?? [],
          ),
        ),
      ];
      const structuralUnitIds = [
        ...new Set(
          sourceBlockIds
            .map((blockId) => blockById.get(blockId)?.structuralUnitId ?? null)
            .filter((id): id is string => id !== null),
        ),
      ];
      result.set(`course-map-unit-${regionIndex + 1}`, { structuralUnitIds, sourceBlockIds });
      regionIndex += 1;
    }
  }
  return result;
}

export class CurriculumDetailBatchPlanningError extends Error {
  readonly diagnostics: string[];
  readonly diagnosticCodes: string[];

  constructor(
    diagnostics: string[],
    diagnosticCodes: string[] = diagnostics.map(() => 'curriculum_detail_planning_failed'),
  ) {
    super(diagnostics.join(' '));
    this.name = 'CurriculumDetailBatchPlanningError';
    this.diagnostics = diagnostics;
    this.diagnosticCodes = diagnosticCodes;
  }
}

function hasRecoveryPlacementMatching(
  requirements: readonly CurriculumCapabilityRecoveryRequirement[],
): boolean {
  const ownerBySlot = new Map<string, number>();
  const assign = (requirementIndex: number, seen: Set<string>): boolean => {
    const requirement = requirements[requirementIndex]!;
    for (const allocationId of requirement.allowedSourceAllocationRegionIds) {
      for (
        let slotIndex = 0;
        slotIndex < COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT;
        slotIndex += 1
      ) {
        const slot = `${allocationId}\u0000${slotIndex}`;
        if (seen.has(slot)) continue;
        seen.add(slot);
        const owner = ownerBySlot.get(slot);
        if (owner === undefined || assign(owner, seen)) {
          ownerBySlot.set(slot, requirementIndex);
          return true;
        }
      }
    }
    return false;
  };
  return requirements.every((_requirement, index) => assign(index, new Set()));
}

/**
 * Requirements whose eligible allocation sets overlap belong to one flexible
 * placement component. Different components can never share a Course Map
 * region, so their independently rounded capacities form a sound occupancy
 * lower bound without fixing any placement inside a flexible component.
 */
function minimumRecoveryRegionOccupancy(
  requirements: readonly CurriculumCapabilityRecoveryRequirement[],
): number {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current) {
      parent.set(id, id);
      return id;
    }
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const requirement of requirements) {
    const [first, ...rest] = requirement.allowedSourceAllocationRegionIds;
    if (!first) continue;
    find(first);
    for (const allocationId of rest) union(first, allocationId);
  }
  const requirementCountByComponent = new Map<string, number>();
  for (const requirement of requirements) {
    const allocationId = requirement.allowedSourceAllocationRegionIds[0];
    if (!allocationId) continue;
    const root = find(allocationId);
    requirementCountByComponent.set(root, (requirementCountByComponent.get(root) ?? 0) + 1);
  }
  return [...requirementCountByComponent.values()].reduce(
    (count, componentRequirementCount) =>
      count +
      Math.ceil(componentRequirementCount / COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT),
    0,
  );
}

function optimisticForcedRecoveryRegions(
  requirements: readonly CurriculumCapabilityRecoveryRequirement[],
  context: CurriculumCapabilityRecoveryDetailFeasibilityContext,
): CurriculumDetailRegionInput[] {
  assertCourseMapSourceAllocationIntegrity(context.sourceAllocation);
  const allocationById = new Map(
    context.sourceAllocation.regions.map((region) => [region.id, region] as const),
  );
  const evidenceById = new Map(context.evidenceCatalog.map((offer) => [offer.id, offer] as const));
  if (evidenceById.size !== context.evidenceCatalog.length) {
    throw new CurriculumDetailBatchPlanningError(
      ['Recovery detail feasibility received duplicate evidence identities.'],
      ['recovery_capability_detail_evidence_identity_duplicate'],
    );
  }
  const forcedByAllocationId = new Map<string, CurriculumCapabilityRecoveryRequirement[]>();
  for (const requirement of requirements) {
    for (const allocationId of requirement.allowedSourceAllocationRegionIds) {
      if (!allocationById.has(allocationId)) {
        throw new CurriculumDetailBatchPlanningError(
          [
            `Recovery capability ${requirement.capabilityRef} references an unknown source allocation before Course Map generation.`,
          ],
          ['recovery_capability_detail_source_allocation_unknown'],
        );
      }
    }
    if (requirement.allowedSourceAllocationRegionIds.length !== 1) continue;
    const allocationId = requirement.allowedSourceAllocationRegionIds[0]!;
    const entries = forcedByAllocationId.get(allocationId) ?? [];
    entries.push(requirement);
    forcedByAllocationId.set(allocationId, entries);
  }

  return [...forcedByAllocationId].map(([allocationId, forcedRequirements], index) => {
    const allocation = allocationById.get(allocationId)!;
    const offeredEvidence = new Map<string, CurriculumDetailRegionInput['evidence'][number]>();
    const addEvidence = (evidenceId: string): void => {
      const offer = evidenceById.get(evidenceId);
      if (
        !offer ||
        offer.materialId !== allocation.materialId ||
        offer.materialRevisionId !== allocation.materialRevisionId ||
        !allocation.sourceBlockIds.includes(offer.blockId)
      ) {
        throw new CurriculumDetailBatchPlanningError(
          [
            `Recovery capability detail feasibility contains stale or foreign evidence ${evidenceId} for ${allocationId}.`,
          ],
          ['recovery_capability_detail_evidence_outside_source_allocation'],
        );
      }
      offeredEvidence.set(evidenceId, {
        evidenceId,
        sourceAllocationRegionId: allocationId,
        text: offer.quote,
        ...(context.authorityEnvelopesByEvidenceId?.has(evidenceId)
          ? { authorityEnvelope: context.authorityEnvelopesByEvidenceId.get(evidenceId) }
          : {}),
      });
    };
    for (const visibility of allocation.evidence) addEvidence(visibility.evidenceId);
    for (const requirement of forcedRequirements) {
      for (const evidenceId of requirement.allowedEvidenceIds) addEvidence(evidenceId);
    }
    return {
      regionId: `course_map_region_${(index + 1).toString(16).padStart(24, '0')}`,
      moduleId: `course_map_module_${'0'.repeat(24)}`,
      moduleIndex: 0,
      moduleTitle: 'x',
      regionIndex: index,
      title: 'x',
      learningIntent: 'x',
      approximateScope: 'focused',
      sourceAllocationRegionIds: [allocationId],
      prerequisiteRegionIds: [],
      synthesisGroups: [],
      concepts: [],
      canonicalConcepts: [],
      evidence: [...offeredEvidence.values()],
      capabilityRequirements: forcedRequirements.map((requirement) => ({
        capabilityRef: requirement.capabilityRef,
        title: requirement.title,
        description: requirement.description,
        originalProposition: requirement.originalProposition,
        construct: requirement.construct,
        priority: requirement.priority,
        subjectClass: requirement.subjectClass,
        scopeOrigin: requirement.scopeOrigin,
        allowedEvidenceIds: [...requirement.allowedEvidenceIds],
      })),
      ...(context.authorityEnvelopesBySourceAllocationRegionId?.has(allocationId)
        ? {
            authorityEnvelope:
              context.authorityEnvelopesBySourceAllocationRegionId.get(allocationId),
          }
        : {}),
    };
  });
}

function assertForcedRecoveryOfferAndRequestFeasible(
  requirements: readonly CurriculumCapabilityRecoveryRequirement[],
  context: CurriculumCapabilityRecoveryDetailFeasibilityContext,
): void {
  const regions = optimisticForcedRecoveryRegions(requirements, context);
  if (regions.length === 0) return;
  for (const region of regions) {
    if (region.evidence.length > MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH) {
      throw new CurriculumDetailBatchPlanningError(
        [
          `Recovery capabilities forced into source allocation ${region.sourceAllocationRegionIds[0]} require ${region.evidence.length} exact offers, exceeding the unsplittable detail limit of ${MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH}.`,
        ],
        ['recovery_capability_detail_evidence_budget_exceeded'],
      );
    }
  }
  const forcedEvidenceCount = regions.reduce((count, region) => count + region.evidence.length, 0);
  if (forcedEvidenceCount > MAX_DETAIL_BATCHES * MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `Forced recovery placements require at least ${forcedEvidenceCount} exact detail offers, exceeding the ${MAX_DETAIL_BATCHES}-batch capacity of ${MAX_DETAIL_BATCHES * MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH}.`,
      ],
      ['recovery_capability_detail_evidence_budget_exceeded'],
    );
  }

  const minimalInput = (selectedRegions: CurriculumDetailRegionInput[]) => ({
    workspaceName: context.workspaceName,
    contract: {
      intent: context.contract.intent,
      targetOutcome: context.contract.targetOutcome,
      desiredDepth: context.contract.desiredDepth,
      subjectBoundaries: context.contract.subjectBoundaries,
      includedTopics: context.contract.includedTopics,
      excludedTopics: context.contract.excludedTopics,
    },
    courseMapId: `course_map_${'0'.repeat(24)}`,
    sourceAllocationFingerprint: context.sourceAllocation.fingerprint,
    batchKey: `detail_batch_${'0'.repeat(24)}`,
    regions: selectedRegions,
    limits: {
      maxUnits: MAX_DETAIL_REGIONS_PER_BATCH,
      maxObjectivesPerUnit: 4,
      maxObjectivesTotal: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
      maxEvidenceSelectionsPerUnit: 32,
    },
  });
  const emptyRequestBytes = measureCurriculumDetailRequest(minimalInput([])).messages.bytes;
  let mandatoryMarginalRequestBytes = 0;
  for (const region of regions) {
    const requestBytes = measureCurriculumDetailRequest(minimalInput([region])).messages.bytes;
    if (requestBytes > MAX_DETAIL_REQUEST_BYTES) {
      throw new CurriculumDetailBatchPlanningError(
        [
          `Recovery capabilities forced into source allocation ${region.sourceAllocationRegionIds[0]} require an optimistic ${requestBytes}-byte detail request, exceeding the unsplittable ${MAX_DETAIL_REQUEST_BYTES}-byte limit.`,
        ],
        ['recovery_capability_detail_request_budget_exceeded'],
      );
    }
    mandatoryMarginalRequestBytes += Math.max(0, requestBytes - emptyRequestBytes);
  }
  const minimumBatchCount = Math.max(
    1,
    Math.ceil(regions.length / MAX_DETAIL_REGIONS_PER_BATCH),
    Math.ceil(forcedEvidenceCount / MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH),
  );
  const requestLowerBound = mandatoryMarginalRequestBytes + minimumBatchCount * emptyRequestBytes;
  if (requestLowerBound > MAX_DETAIL_BATCHES * MAX_DETAIL_REQUEST_BYTES) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `Forced recovery content has an optimistic request lower bound of ${requestLowerBound} bytes, exceeding the ${MAX_DETAIL_BATCHES}-batch request capacity of ${MAX_DETAIL_BATCHES * MAX_DETAIL_REQUEST_BYTES}.`,
      ],
      ['recovery_capability_detail_request_budget_exceeded'],
    );
  }
}

/** Reject globally impossible recovery detail work before paying for a Course Map proposal. */
export function assertCurriculumCapabilityRecoveryDetailOutputFeasible(
  requirements: readonly CurriculumCapabilityRecoveryRequirement[],
  context?: CurriculumCapabilityRecoveryDetailFeasibilityContext,
): void {
  const capabilityRefs = requirements.map((requirement) => requirement.capabilityRef);
  if (new Set(capabilityRefs).size !== capabilityRefs.length) {
    throw new CurriculumDetailBatchPlanningError(
      ['Recovery capability references must be unique before Course Map generation.'],
      ['recovery_capability_detail_placement_invalid'],
    );
  }
  for (const requirement of requirements) {
    if (
      requirement.allowedSourceAllocationRegionIds.length === 0 ||
      new Set(requirement.allowedSourceAllocationRegionIds).size !==
        requirement.allowedSourceAllocationRegionIds.length
    ) {
      throw new CurriculumDetailBatchPlanningError(
        [
          `Recovery capability ${requirement.capabilityRef} has an empty or duplicate source-allocation scope.`,
        ],
        ['recovery_capability_detail_placement_invalid'],
      );
    }
  }
  if (!hasRecoveryPlacementMatching(requirements)) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `The immutable recovery frontier cannot fit its ${requirements.length} capabilities into eligible source-allocation regions at ${COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT} per region.`,
      ],
      ['recovery_capability_detail_placement_invalid'],
    );
  }
  const maximumRequirementCount = MAX_RECOVERY_REQUIREMENTS_PER_DETAIL_BATCH * MAX_DETAIL_BATCHES;
  const minimumRegionCount = minimumRecoveryRegionOccupancy(requirements);
  const minimumContentBytes =
    minimumRegionCount * DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE +
    requirements.length * DETAIL_OUTPUT_BYTES_PER_RECOVERY_OBJECTIVE_ESTIMATE;
  const contentCapacityBytes =
    MAX_DETAIL_BATCHES * (MAX_DETAIL_OUTPUT_ESTIMATE_BYTES - DETAIL_OUTPUT_BASE_BYTES_ESTIMATE);
  if (
    requirements.length > maximumRequirementCount ||
    minimumRegionCount > MAX_DETAIL_BATCHES * MAX_DETAIL_REGIONS_PER_BATCH ||
    minimumContentBytes > contentCapacityBytes
  ) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `The immutable recovery frontier requires ${requirements.length} detail objectives and at least ${minimumRegionCount} distinct eligible regions, but the fixed ${MAX_DETAIL_BATCHES}-batch output budget can contain at most ${maximumRequirementCount} objectives only under optimal ${COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT}-per-region packing.`,
      ],
      ['recovery_capability_detail_output_budget_exceeded'],
    );
  }
  if (context) assertForcedRecoveryOfferAndRequestFeasible(requirements, context);
}

function batchKey(courseMapId: string, regions: CurriculumDetailRegionInput[]): string {
  return `detail_batch_${createHash('sha256')
    .update(JSON.stringify({ courseMapId, regionIds: regions.map((region) => region.regionId) }))
    .digest('hex')
    .slice(0, 24)}`;
}

function assertUniqueStrings(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) {
    throw new CurriculumDetailBatchPlanningError([message]);
  }
}

function evidenceAllocationId(
  offer: CurriculumEvidenceOffer,
  allocationById: ReadonlyMap<string, CourseMapSourceAllocation['regions'][number]>,
  candidateAllocationIds: readonly string[],
): string | null {
  const matches = candidateAllocationIds.filter((allocationId) => {
    const allocation = allocationById.get(allocationId);
    return (
      allocation?.materialId === offer.materialId &&
      allocation.materialRevisionId === offer.materialRevisionId &&
      allocation.sourceBlockIds.includes(offer.blockId)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function buildDetailRegions(input: CurriculumDetailPlanningInput): CurriculumDetailRegionInput[][] {
  assertCourseMapSourceAllocationIntegrity(input.sourceAllocation);
  if (
    input.courseMap.sourceAllocationFingerprint !== input.sourceAllocation.fingerprint ||
    input.courseMap.courseSourceMapFingerprint !== input.sourceAllocation.courseSourceMapFingerprint
  ) {
    throw new CurriculumDetailBatchPlanningError([
      'Course Map detail planning fingerprints do not match the validated source allocation.',
    ]);
  }
  const allocationById = new Map(
    input.sourceAllocation.regions.map((region) => [region.id, region] as const),
  );
  const evidenceById = new Map(input.evidenceCatalog.map((offer) => [offer.id, offer] as const));
  if (evidenceById.size !== input.evidenceCatalog.length) {
    throw new CurriculumDetailBatchPlanningError([
      'Curriculum detail evidence catalog identities must be unique.',
    ]);
  }
  const recoveryRequirements = input.capabilityRecoveryRequirements ?? [];
  if (recoveryRequirements.length > COURSE_MAP_CAPABILITY_REQUIREMENT_LIMIT) {
    throw new CurriculumDetailBatchPlanningError([
      'Curriculum detail capability recovery exceeds its hard requirement limit.',
    ]);
  }
  assertUniqueStrings(
    recoveryRequirements.map((requirement) => requirement.capabilityRef),
    'Curriculum detail capability recovery references must be unique.',
  );
  const recoveryRequirementByRef = new Map(
    recoveryRequirements.map((requirement) => [requirement.capabilityRef, requirement] as const),
  );
  for (const requirement of recoveryRequirements) {
    assertUniqueStrings(
      requirement.allowedSourceAllocationRegionIds,
      `Curriculum detail recovery capability ${requirement.capabilityRef} source scope must be unique.`,
    );
    assertUniqueStrings(
      requirement.allowedEvidenceIds,
      `Curriculum detail recovery capability ${requirement.capabilityRef} evidence scope must be unique.`,
    );
    if (
      requirement.allowedSourceAllocationRegionIds.length === 0 ||
      requirement.allowedEvidenceIds.length === 0
    ) {
      throw new CurriculumDetailBatchPlanningError([
        `Curriculum detail recovery capability ${requirement.capabilityRef} has an empty source or evidence scope.`,
      ]);
    }
    for (const allocationId of requirement.allowedSourceAllocationRegionIds) {
      if (!allocationById.has(allocationId)) {
        throw new CurriculumDetailBatchPlanningError([
          `Curriculum detail recovery capability ${requirement.capabilityRef} references an unknown source allocation.`,
        ]);
      }
    }
    for (const evidenceId of requirement.allowedEvidenceIds) {
      const offer = evidenceById.get(evidenceId);
      if (
        !offer ||
        !evidenceAllocationId(offer, allocationById, requirement.allowedSourceAllocationRegionIds)
      ) {
        throw new CurriculumDetailBatchPlanningError([
          `Curriculum detail recovery capability ${requirement.capabilityRef} contains stale or foreign evidence ${evidenceId}.`,
        ]);
      }
    }
  }
  const capabilityPlacementCount = new Map<string, number>();
  for (const region of input.courseMap.modules.flatMap((module) => module.regions)) {
    const capabilityRefs = region.capabilityRequirementRefs ?? [];
    if (capabilityRefs.length > COURSE_MAP_CAPABILITY_REQUIREMENTS_PER_REGION_LIMIT) {
      throw new CurriculumDetailBatchPlanningError([
        `Course Map region ${region.id} exceeds the recovery-capability detail capacity.`,
      ]);
    }
    assertUniqueStrings(
      capabilityRefs,
      `Course Map region ${region.id} repeats a recovery capability.`,
    );
    for (const capabilityRef of capabilityRefs) {
      const requirement = recoveryRequirementByRef.get(capabilityRef);
      if (!requirement) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.id} references an unknown or unsolicited recovery capability ${capabilityRef}.`,
        ]);
      }
      if (
        !region.sourceAllocationRegionIds.some((allocationId) =>
          requirement.allowedSourceAllocationRegionIds.includes(allocationId),
        )
      ) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.id} places recovery capability ${capabilityRef} outside its source envelope.`,
        ]);
      }
      capabilityPlacementCount.set(
        capabilityRef,
        (capabilityPlacementCount.get(capabilityRef) ?? 0) + 1,
      );
    }
  }
  for (const requirement of recoveryRequirements) {
    if ((capabilityPlacementCount.get(requirement.capabilityRef) ?? 0) !== 1) {
      throw new CurriculumDetailBatchPlanningError([
        `Curriculum detail recovery capability ${requirement.capabilityRef} must be placed exactly once.`,
      ]);
    }
  }
  const conceptById = new Map(input.concepts.map((concept) => [concept.id, concept] as const));
  const canonicalById = new Map(
    input.canonicalConcepts.map((canonical) => [canonical.id, canonical] as const),
  );
  const prerequisitesByDependent = new Map<string, string[]>();
  for (const edge of input.courseMap.prerequisites) {
    const ids = prerequisitesByDependent.get(edge.dependentRegionId) ?? [];
    ids.push(edge.prerequisiteRegionId);
    prerequisitesByDependent.set(edge.dependentRegionId, ids);
  }

  return input.courseMap.modules.map((module) =>
    module.regions.map((region) => {
      const allocations = region.sourceAllocationRegionIds.map((id) => allocationById.get(id));
      if (allocations.some((allocation) => !allocation)) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map detail region references an unknown source allocation: ${region.id}.`,
        ]);
      }
      const baseEvidence = allocations.flatMap((allocation) =>
        allocation!.evidence.map((visibility) => {
          const offer = evidenceById.get(visibility.evidenceId);
          if (
            !offer ||
            offer.bindingId !== visibility.bindingId ||
            offer.blockId !== visibility.blockId ||
            offer.startOffset !== visibility.startOffset ||
            offer.endOffset !== visibility.endOffset ||
            offer.quote !== visibility.quote ||
            offer.materialId !== allocation!.materialId ||
            offer.materialRevisionId !== allocation!.materialRevisionId
          ) {
            throw new CurriculumDetailBatchPlanningError([
              `Curriculum detail evidence is stale or foreign for source allocation ${allocation!.id}.`,
            ]);
          }
          return {
            evidenceId: offer.id,
            sourceAllocationRegionId: allocation!.id,
            text: offer.quote,
            ...(input.authorityEnvelopesByEvidenceId?.has(offer.id)
              ? { authorityEnvelope: input.authorityEnvelopesByEvidenceId.get(offer.id) }
              : {}),
          };
        }),
      );
      const evidenceByOfferedId = new Map(
        baseEvidence.map((offer) => [offer.evidenceId, offer] as const),
      );
      const capabilityRequirements: CurriculumCapabilityRecoveryRequirementInput[] = [];
      for (const capabilityRef of region.capabilityRequirementRefs ?? []) {
        const requirement = recoveryRequirementByRef.get(capabilityRef)!;
        const allowedEvidenceIds: string[] = [];
        for (const evidenceId of requirement.allowedEvidenceIds) {
          const offer = evidenceById.get(evidenceId)!;
          const sourceAllocationRegionId = evidenceAllocationId(
            offer,
            allocationById,
            region.sourceAllocationRegionIds,
          );
          if (!sourceAllocationRegionId) continue;
          allowedEvidenceIds.push(evidenceId);
          if (!evidenceByOfferedId.has(evidenceId)) {
            evidenceByOfferedId.set(evidenceId, {
              evidenceId,
              sourceAllocationRegionId,
              text: offer.quote,
              ...(input.authorityEnvelopesByEvidenceId?.has(evidenceId)
                ? { authorityEnvelope: input.authorityEnvelopesByEvidenceId.get(evidenceId) }
                : {}),
            });
          }
        }
        if (allowedEvidenceIds.length === 0) {
          throw new CurriculumDetailBatchPlanningError([
            `Course Map region ${region.id} has no eligible exact evidence for recovery capability ${capabilityRef}.`,
          ]);
        }
        capabilityRequirements.push({
          capabilityRef: requirement.capabilityRef,
          title: requirement.title,
          description: requirement.description,
          originalProposition: requirement.originalProposition,
          construct: requirement.construct,
          priority: requirement.priority,
          subjectClass: requirement.subjectClass,
          scopeOrigin: requirement.scopeOrigin,
          allowedEvidenceIds,
        });
      }
      const evidence = [...evidenceByOfferedId.values()];
      if (evidence.length > MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH) {
        throw new CurriculumDetailBatchPlanningError(
          [
            `A Course Map recovery region offers ${evidence.length} exact excerpts, exceeding the unsplittable detail limit of ${MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH}. Redistribute flexible capabilityRef values within their allowed source scopes.`,
          ],
          ['recovery_capability_detail_evidence_budget_exceeded'],
        );
      }
      const evidenceSourceRegionIds = new Set(
        evidence.map((offer) => offer.sourceAllocationRegionId),
      );
      const unsupported = region.sourceAllocationRegionIds.filter(
        (id) => !evidenceSourceRegionIds.has(id),
      );
      if (unsupported.length > 0) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.id} cannot be materialized with exact evidence for source allocations: ${unsupported.join(', ')}.`,
        ]);
      }
      const concepts = region.conceptIds.map((id) => conceptById.get(id)).filter(Boolean);
      if (concepts.length !== region.conceptIds.length) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.id} contains a stale Concept anchor.`,
        ]);
      }
      const canonicalConcepts = region.canonicalConceptIds
        .map((id) => canonicalById.get(id))
        .filter(Boolean);
      if (canonicalConcepts.length !== region.canonicalConceptIds.length) {
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.id} contains a stale canonical Concept anchor.`,
        ]);
      }
      return {
        regionId: region.id,
        moduleId: module.id,
        moduleIndex: module.index,
        moduleTitle: module.title,
        regionIndex: region.index,
        title: region.title,
        learningIntent: region.learningIntent,
        approximateScope: region.approximateScope,
        sourceAllocationRegionIds: [...region.sourceAllocationRegionIds],
        prerequisiteRegionIds: prerequisitesByDependent.get(region.id) ?? [],
        synthesisGroups: input.courseMap.synthesisGroups
          .filter((group) => group.regionIds.includes(region.id))
          .map((group) => ({
            id: group.id,
            title: group.title,
            level: group.level,
          })),
        concepts: concepts.map((concept) => ({
          id: concept!.id,
          name: concept!.name,
          summary: concept!.summary,
        })),
        canonicalConcepts: canonicalConcepts.map((canonical) => ({
          ...canonical!,
          sourceConceptIds: [...canonical!.sourceConceptIds],
        })),
        evidence,
        ...(capabilityRequirements.length > 0 ? { capabilityRequirements } : {}),
        ...(input.authorityEnvelopesByRegionId?.has(region.id)
          ? { authorityEnvelope: input.authorityEnvelopesByRegionId.get(region.id) }
          : {}),
      };
    }),
  );
}

function detailInput(
  planning: CurriculumDetailPlanningInput,
  regions: CurriculumDetailRegionInput[],
): CurriculumDetailProposalInput {
  return {
    workspaceName: planning.workspaceName,
    contract: {
      intent: planning.contract.intent,
      targetOutcome: planning.contract.targetOutcome,
      desiredDepth: planning.contract.desiredDepth,
      subjectBoundaries: planning.contract.subjectBoundaries,
      includedTopics: planning.contract.includedTopics,
      excludedTopics: planning.contract.excludedTopics,
    },
    courseMapId: planning.courseMap.id,
    sourceAllocationFingerprint: planning.sourceAllocation.fingerprint,
    batchKey: batchKey(planning.courseMap.id, regions),
    regions,
    limits: {
      maxUnits: MAX_DETAIL_REGIONS_PER_BATCH,
      maxObjectivesPerUnit: 4,
      maxObjectivesTotal: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
      maxEvidenceSelectionsPerUnit: 32,
    },
  };
}

function measuredBatch(
  planning: CurriculumDetailPlanningInput,
  regions: CurriculumDetailRegionInput[],
  index: number,
): CurriculumDetailBatch | null {
  if (regions.length === 0 || regions.length > MAX_DETAIL_REGIONS_PER_BATCH) return null;
  const evidenceOffers = regions.reduce((count, region) => count + region.evidence.length, 0);
  if (evidenceOffers > MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH) return null;
  const input = detailInput(planning, regions);
  const requestBytes = measureCurriculumDetailRequest(input).messages.bytes;
  const outputEstimateBytes =
    DETAIL_OUTPUT_BASE_BYTES_ESTIMATE +
    regions.length * DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE +
    regions.reduce(
      (bytes, region) =>
        bytes +
        (region.capabilityRequirements?.length ?? 0) *
          DETAIL_OUTPUT_BYTES_PER_RECOVERY_OBJECTIVE_ESTIMATE,
      0,
    );
  if (
    requestBytes > MAX_DETAIL_REQUEST_BYTES ||
    outputEstimateBytes > MAX_DETAIL_OUTPUT_ESTIMATE_BYTES
  ) {
    return null;
  }
  return { index, input, requestBytes, outputEstimateBytes };
}

/** Deterministic, stable-order partitioning with a fixed provider-call bound. */
export function planCurriculumDetailBatches(
  planning: CurriculumDetailPlanningInput,
): CurriculumDetailBatch[] {
  const moduleRegions = buildDetailRegions(planning);
  const allRegions = moduleRegions.flat();
  const minimumObjectiveCount = minimumCurriculumDetailObjectiveCount(
    allRegions,
    planning.contract.targetOutcome.description,
  );
  if (minimumObjectiveCount > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `Course Map requires at least ${minimumObjectiveCount} objectives, exceeding the global semantic-evaluation ceiling of ${OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES}.`,
      ],
      ['objective_authority_semantic_support_budget_exceeded'],
    );
  }
  const single = measuredBatch(planning, allRegions, 0);
  if (single) return [single];

  const partitions: CurriculumDetailRegionInput[][] = [];
  let current: CurriculumDetailRegionInput[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    partitions.push(current);
    current = [];
  };
  for (const module of moduleRegions) {
    if (measuredBatch(planning, [...current, ...module], partitions.length)) {
      current.push(...module);
      continue;
    }
    flush();
    if (measuredBatch(planning, module, partitions.length)) {
      current.push(...module);
      continue;
    }
    for (const region of module) {
      if (measuredBatch(planning, [...current, region], partitions.length)) {
        current.push(region);
        continue;
      }
      flush();
      if (!measuredBatch(planning, [region], partitions.length)) {
        const exactInput = detailInput(planning, [region]);
        const evidenceOfferCount = region.evidence.length;
        const requestBytes = measureCurriculumDetailRequest(exactInput).messages.bytes;
        const outputEstimateBytes =
          DETAIL_OUTPUT_BASE_BYTES_ESTIMATE +
          DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE +
          (region.capabilityRequirements?.length ?? 0) *
            DETAIL_OUTPUT_BYTES_PER_RECOVERY_OBJECTIVE_ESTIMATE;
        const capabilityRefs = (region.capabilityRequirements ?? []).map(
          (requirement) => requirement.capabilityRef,
        );
        const recoveryBound = capabilityRefs.length > 0;
        throw new CurriculumDetailBatchPlanningError(
          [
            recoveryBound
              ? `A Course Map region containing recovery capabilities [${capabilityRefs.join(', ')}] exceeds an individual detail budget (evidenceOffers=${evidenceOfferCount}/${MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH}, requestBytes=${requestBytes}/${MAX_DETAIL_REQUEST_BYTES}, outputEstimateBytes=${outputEstimateBytes}/${MAX_DETAIL_OUTPUT_ESTIMATE_BYTES}). Redistribute only flexible capabilityRef values within their allowed R* source scopes.`
              : `A Course Map region exceeds an individual detail request budget (evidenceOffers=${evidenceOfferCount}/${MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH}, requestBytes=${requestBytes}/${MAX_DETAIL_REQUEST_BYTES}, outputEstimateBytes=${outputEstimateBytes}/${MAX_DETAIL_OUTPUT_ESTIMATE_BYTES}).`,
          ],
          [
            recoveryBound
              ? 'recovery_capability_detail_budget_exceeded'
              : 'curriculum_detail_region_budget_exceeded',
          ],
        );
      }
      current.push(region);
    }
  }
  flush();
  if (partitions.length > MAX_DETAIL_BATCHES) {
    throw new CurriculumDetailBatchPlanningError([
      `Course Map requires ${partitions.length} detail batches, exceeding the fixed maximum of ${MAX_DETAIL_BATCHES}.`,
    ]);
  }
  const batches = partitions.map((regions, index) => measuredBatch(planning, regions, index));
  if (batches.some((batch) => !batch)) {
    throw new CurriculumDetailBatchPlanningError([
      'Course Map detail partition no longer satisfies its exact request and output budgets.',
    ]);
  }
  const partitionMinimumObjectiveCount = (batches as CurriculumDetailBatch[]).reduce(
    (count, batch) =>
      count +
      minimumCurriculumDetailObjectiveCount(
        batch.input.regions,
        batch.input.contract.targetOutcome.description,
      ),
    0,
  );
  if (partitionMinimumObjectiveCount > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES) {
    throw new CurriculumDetailBatchPlanningError(
      [
        `Course Map detail partitions require at least ${partitionMinimumObjectiveCount} objectives, exceeding the global semantic-evaluation ceiling of ${OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES}.`,
      ],
      ['objective_authority_semantic_support_budget_exceeded'],
    );
  }
  const assignedIds = batches.flatMap((batch) =>
    batch!.input.regions.map((region) => region.regionId),
  );
  const expectedIds = allRegions.map((region) => region.regionId);
  if (
    assignedIds.length !== expectedIds.length ||
    assignedIds.some((id, index) => id !== expectedIds[index]) ||
    new Set(assignedIds).size !== assignedIds.length
  ) {
    throw new CurriculumDetailBatchPlanningError([
      'Course Map detail partition has an overlap, omission, or unstable region order.',
    ]);
  }
  return batches as CurriculumDetailBatch[];
}

/** Fail a Course Map candidate before any detail-provider call. */
export function validateCurriculumDetailPlan(
  planning: CurriculumDetailPlanningInput,
): ProviderCandidateValidation {
  try {
    planCurriculumDetailBatches(planning);
    return { valid: true, diagnostics: [], diagnosticCodes: [] };
  } catch (error) {
    if (!(error instanceof CurriculumDetailBatchPlanningError)) throw error;
    return {
      valid: false,
      diagnostics: error.diagnostics.slice(0, 20),
      diagnosticCodes: error.diagnosticCodes.slice(0, 20),
      failureArtifact: {
        kind: 'curriculum_detail_plan_invalid',
        context: {},
        diagnostics: error.diagnostics.slice(0, 20).map((message, index) => ({
          code: error.diagnosticCodes[index] ?? 'curriculum_detail_planning_failed',
          message,
        })),
      },
    };
  }
}

export function validateCurriculumDetailCandidate(
  candidate: unknown,
  input: CurriculumDetailProposalInput,
): ProviderCandidateValidation {
  const parsed = CurriculumDetailProposalPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 100);
    return {
      valid: false,
      diagnostics: issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`),
      diagnosticCodes: issues.map((issue) => `schema_${issue.code}`),
      failureArtifact: {
        kind: 'curriculum_detail_candidate_validation_failed',
        context: {
          courseMapId: input.courseMapId,
          batchKey: input.batchKey,
        },
        diagnostics: issues.slice(0, 20).map((issue) => ({
          code: `schema_${issue.code}`,
          message: `${issue.path.join('.') || 'payload'}: ${issue.message}`,
          facts: {
            path: issue.path.map(String),
          },
        })),
      },
    };
  }
  const diagnostics: string[] = [];
  const diagnosticCodes: string[] = [];
  const failureDiagnostics: ProviderCandidateFailureArtifact['diagnostics'] = [];
  const addDiagnostic = (
    code: string,
    message: string,
    facts?: ProviderCandidateFailureArtifact['diagnostics'][number]['facts'],
  ) => {
    diagnostics.push(message);
    diagnosticCodes.push(code);
    if (failureDiagnostics.length < 20) {
      failureDiagnostics.push({ code, message, ...(facts ? { facts } : {}) });
    }
  };
  const payload = parsed.data;
  const batchObjectiveLimit =
    input.limits.maxObjectivesTotal ?? input.regions.length * input.limits.maxObjectivesPerUnit;
  const minimumObjectiveCount = minimumCurriculumDetailObjectiveCount(
    input.regions,
    input.contract.targetOutcome.description,
  );
  const objectiveCount = payload.units.reduce((count, unit) => count + unit.objectives.length, 0);
  if (
    !Number.isSafeInteger(batchObjectiveLimit) ||
    batchObjectiveLimit < minimumObjectiveCount ||
    batchObjectiveLimit > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES
  ) {
    addDiagnostic(
      'curriculum_detail_objective_budget_invalid',
      'Curriculum detail input contains an invalid batch-wide objective budget.',
      {
        batchObjectiveLimit,
        minimumObjectiveCount,
        globalObjectiveLimit: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
      },
    );
  } else if (objectiveCount > batchObjectiveLimit) {
    addDiagnostic(
      'curriculum_detail_objective_authority_semantic_budget_exceeded',
      `Curriculum detail response contains ${objectiveCount} objectives, exceeding this batch's remaining semantic-evaluation budget of ${batchObjectiveLimit}.`,
      {
        objectiveCount,
        batchObjectiveLimit,
        globalObjectiveLimit: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
      },
    );
  }
  if (payload.courseMapId !== input.courseMapId) {
    addDiagnostic(
      'foreign_course_map',
      'Curriculum detail response references a foreign Course Map.',
      {
        expectedCourseMapId: input.courseMapId,
        actualCourseMapId: payload.courseMapId,
      },
    );
  }
  if (payload.sourceAllocationFingerprint !== input.sourceAllocationFingerprint) {
    addDiagnostic(
      'source_allocation_fingerprint_mismatch',
      'Curriculum detail response has a stale source-allocation fingerprint.',
      {
        expectedSourceAllocationFingerprint: input.sourceAllocationFingerprint,
        actualSourceAllocationFingerprint: payload.sourceAllocationFingerprint,
      },
    );
  }
  const expectedRegionIds = input.regions.map((region) => region.regionId);
  const actualRegionIds = payload.units.map((unit) => unit.regionId);
  if (
    actualRegionIds.length !== expectedRegionIds.length ||
    actualRegionIds.some((id, index) => id !== expectedRegionIds[index])
  ) {
    addDiagnostic(
      'region_set_or_order_mismatch',
      'Curriculum detail response must represent every offered region exactly once in order.',
      {
        expectedRegionIds,
        actualRegionIds,
      },
    );
  }
  const regionById = new Map(input.regions.map((region) => [region.regionId, region] as const));
  for (const unit of payload.units) {
    const region = regionById.get(unit.regionId);
    if (!region) {
      addDiagnostic(
        'unknown_region',
        `Curriculum detail response contains an unknown region: ${unit.regionId}.`,
        { regionId: unit.regionId },
      );
      continue;
    }
    const evidenceById = new Map(
      region.evidence.map((offer) => [offer.evidenceId, offer] as const),
    );
    const capabilityRequirementByRef = new Map(
      (region.capabilityRequirements ?? []).map((requirement) => [
        requirement.capabilityRef,
        requirement,
      ]),
    );
    if (capabilityRequirementByRef.size !== (region.capabilityRequirements ?? []).length) {
      addDiagnostic(
        'recovery_capability_input_duplicate',
        `Curriculum detail region ${unit.regionId} has duplicate recovery-capability requirements.`,
        { courseMapRegionId: unit.regionId },
      );
    }
    const capabilityUseCount = new Map<string, number>();
    const selectedAuthorityEnvelopes = (objective: (typeof unit.objectives)[number]) =>
      objective.evidence.flatMap((selection) => {
        const envelope = evidenceById.get(selection.evidenceId)?.authorityEnvelope;
        return envelope ? [envelope] : [];
      });
    const siblingUnitTitles = payload.units
      .filter((candidate) => candidate.regionId !== unit.regionId)
      .map((candidate) => candidate.title);
    const requiredObjectives = unit.objectives.filter(
      (objective) => objective.priority === 'required',
    );
    const ownAnchoredRequiredObjectiveCount = requiredObjectives.filter((objective) =>
      hasCurriculumSemanticAnchor(`${objective.title} ${objective.description}`, [unit.title]),
    ).length;
    for (const objective of unit.objectives) {
      const capabilityRef = objective.capabilityRequirementRef;
      if (capabilityRef) {
        const requirement = capabilityRequirementByRef.get(capabilityRef);
        if (!requirement) {
          addDiagnostic(
            'recovery_capability_unknown',
            `Curriculum detail objective ${objective.key} references an unknown or unsolicited recovery capability ${capabilityRef}.`,
            { courseMapRegionId: unit.regionId, objectiveKey: objective.key, capabilityRef },
          );
        } else {
          capabilityUseCount.set(capabilityRef, (capabilityUseCount.get(capabilityRef) ?? 0) + 1);
          if (
            objective.title !== requirement.title ||
            objective.description !== requirement.description
          ) {
            addDiagnostic(
              'recovery_capability_proposition_changed',
              `Curriculum detail objective ${objective.key} changes the frozen proposition for recovery capability ${capabilityRef}.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
              },
            );
          }
          if (objective.construct !== requirement.construct) {
            addDiagnostic(
              'recovery_capability_construct_changed',
              `Curriculum detail objective ${objective.key} changes the frozen construct for recovery capability ${capabilityRef}.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
                expectedConstruct: requirement.construct,
                actualConstruct: objective.construct,
              },
            );
          }
          if (
            requirement.subjectClass !== null &&
            objective.subjectClass !== requirement.subjectClass
          ) {
            addDiagnostic(
              'recovery_capability_subject_class_changed',
              `Curriculum detail objective ${objective.key} changes the frozen subject class for recovery capability ${capabilityRef}.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
                expectedSubjectClass: requirement.subjectClass,
                actualSubjectClass: objective.subjectClass,
              },
            );
          }
          if (
            requirement.scopeOrigin !== null &&
            objective.scopeOrigin !== requirement.scopeOrigin
          ) {
            addDiagnostic(
              'recovery_capability_scope_origin_changed',
              `Curriculum detail objective ${objective.key} changes the frozen scope origin for recovery capability ${capabilityRef}.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
                expectedScopeOrigin: requirement.scopeOrigin,
                actualScopeOrigin: objective.scopeOrigin,
              },
            );
          }
          const normalizedPriority = objective.priority ?? 'normal';
          if (normalizedPriority !== requirement.priority) {
            addDiagnostic(
              'recovery_capability_priority_changed',
              `Curriculum detail objective ${objective.key} changes the frozen priority for recovery capability ${capabilityRef}.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
                expectedPriority: requirement.priority,
                actualPriority: normalizedPriority,
              },
            );
          }
          const allowedEvidenceIds = new Set(requirement.allowedEvidenceIds);
          const selectedEvidenceIds = objective.evidence.map((selection) => selection.evidenceId);
          if (
            selectedEvidenceIds.length === 0 ||
            selectedEvidenceIds.some((evidenceId) => !allowedEvidenceIds.has(evidenceId))
          ) {
            addDiagnostic(
              'recovery_capability_evidence_outside_scope',
              `Curriculum detail objective ${objective.key} must select exact evidence entirely inside recovery capability ${capabilityRef}'s offered scope.`,
              {
                courseMapRegionId: unit.regionId,
                objectiveKey: objective.key,
                capabilityRef,
                selectedEvidenceIds,
                allowedEvidenceIds: requirement.allowedEvidenceIds,
              },
            );
          }
        }
      }
      if (objective.priority !== 'required') continue;
      const objectiveClaim = `${objective.title} ${objective.description}`;
      const matchingSiblingUnitTitles = siblingUnitTitles.filter((title) =>
        hasCurriculumSemanticAnchor(objectiveClaim, [title]),
      );
      if (!hasCurriculumSemanticAnchor(objectiveClaim, [unit.title])) {
        addDiagnostic(
          'required_objective_parent_topic_mismatch',
          `Required objective ${objective.key} has no meaningful semantic anchor in its own learner-visible LearningUnit title. Rename or regroup the unit so its title covers every required objective.`,
          {
            courseMapRegionId: region.regionId,
            learningUnitTitle: unit.title,
            objectiveKey: objective.key,
            objectiveTitle: objective.title,
            ownAnchoredRequiredObjectiveCount,
            matchingSiblingUnitTitles: matchingSiblingUnitTitles.slice(0, 20),
          },
        );
      }
    }
    for (const capabilityRef of capabilityRequirementByRef.keys()) {
      const useCount = capabilityUseCount.get(capabilityRef) ?? 0;
      if (useCount === 0) {
        addDiagnostic(
          'recovery_capability_missing',
          `Curriculum detail region ${unit.regionId} omitted recovery capability ${capabilityRef}.`,
          { courseMapRegionId: unit.regionId, capabilityRef },
        );
      } else if (useCount > 1) {
        addDiagnostic(
          'recovery_capability_duplicate',
          `Curriculum detail region ${unit.regionId} mapped recovery capability ${capabilityRef} more than once.`,
          { courseMapRegionId: unit.regionId, capabilityRef },
        );
      }
    }
    if (region.authorityEnvelope || region.evidence.some((offer) => offer.authorityEnvelope)) {
      for (const objective of unit.objectives) {
        if (objective.priority !== 'required') continue;
        const construct = objective.construct;
        const envelopes = selectedAuthorityEnvelopes(objective);
        if (envelopes.some((envelope) => isConstructSupported(construct, envelope))) {
          continue;
        }
        const repairEnvelope =
          envelopes.find((envelope) => envelope.supportedConstructs.includes(construct)) ??
          envelopes[0];
        const message = `required_objective_formal_authority_missing: objective ${objective.key} claims ${construct}, but its exact selected evidence in source region ${region.regionId} supports ${repairEnvelope?.supportedConstructs.join(', ') || 'no formal construct'}; narrowerClaim=${repairEnvelope?.narrowerClaim ?? 'none'}; protectedPriority=required.`;
        addDiagnostic('required_objective_formal_authority_missing', message, {
          courseMapRegionId: region.regionId,
          objectiveKey: objective.key,
          claimedConstruct: construct,
          protectedPriority: objective.priority,
          selectedEvidenceIds: objective.evidence.map((selection) => selection.evidenceId),
          selectedEvidenceAuthority: objective.evidence.map((selection) => {
            const offer = evidenceById.get(selection.evidenceId);
            const envelope = offer?.authorityEnvelope;
            return {
              evidenceId: selection.evidenceId,
              sourceAllocationRegionId: offer?.sourceAllocationRegionId ?? null,
              available: Boolean(offer),
              authorityTier: envelope?.tier ?? null,
              supportedConstructs: envelope?.supportedConstructs ?? [],
              strongestSupportedConstruct: envelope?.strongestSupportedConstruct ?? null,
              formalEvidenceCount: envelope?.formalEvidenceIds.length ?? 0,
              narrowerClaim: envelope?.narrowerClaim ?? null,
            };
          }),
          repairAuthorityTier: repairEnvelope?.tier ?? null,
          repairSupportedConstructs: repairEnvelope?.supportedConstructs ?? [],
          repairNarrowerClaim: repairEnvelope?.narrowerClaim ?? null,
        });
      }
    }
    const selectedEvidenceIds = [
      ...unit.sourceEvidence.map((item) => item.evidenceId),
      ...unit.objectives.flatMap((objective) => objective.evidence.map((item) => item.evidenceId)),
    ];
    for (const evidenceId of selectedEvidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        addDiagnostic(
          'unknown_evidence',
          `Curriculum detail region ${unit.regionId} selected unknown or foreign evidence: ${evidenceId}.`,
          {
            courseMapRegionId: unit.regionId,
            evidenceId,
            selectedEvidenceIds,
          },
        );
      }
    }
    const selectedSourceRegionIds = new Set(
      unit.sourceEvidence.flatMap((item) => {
        const offer = evidenceById.get(item.evidenceId);
        return offer ? [offer.sourceAllocationRegionId] : [];
      }),
    );
    for (const sourceRegionId of region.sourceAllocationRegionIds) {
      if (!selectedSourceRegionIds.has(sourceRegionId)) {
        addDiagnostic(
          'source_allocation_omitted',
          `Curriculum detail region ${unit.regionId} does not represent source allocation ${sourceRegionId}.`,
          {
            courseMapRegionId: unit.regionId,
            omittedSourceAllocationRegionId: sourceRegionId,
            requiredSourceAllocationRegionIds: region.sourceAllocationRegionIds,
            selectedUnitEvidenceIds: unit.sourceEvidence.map((item) => item.evidenceId),
            representedSourceAllocationRegionIds: [...selectedSourceRegionIds],
          },
        );
      }
    }
    const allowedConceptIds = new Set(region.concepts.map((concept) => concept.id));
    for (const conceptId of unit.conceptIds) {
      if (!allowedConceptIds.has(conceptId)) {
        addDiagnostic(
          'unknown_concept',
          `Curriculum detail region ${unit.regionId} selected an unknown Concept: ${conceptId}.`,
          {
            courseMapRegionId: unit.regionId,
            conceptId,
          },
        );
      }
    }
    const allowedCanonicalIds = new Set(region.canonicalConcepts.map((canonical) => canonical.id));
    for (const canonicalId of unit.canonicalConceptIds) {
      if (!allowedCanonicalIds.has(canonicalId)) {
        addDiagnostic(
          'unknown_canonical_concept',
          `Curriculum detail region ${unit.regionId} selected an unknown canonical Concept: ${canonicalId}.`,
          {
            courseMapRegionId: unit.regionId,
            canonicalConceptId: canonicalId,
          },
        );
      }
    }
  }
  const applyEvidenceOffers = input.regions.flatMap((region) =>
    region.evidence
      .filter((offer) => offer.authorityEnvelope?.supportedConstructs.includes('apply'))
      .map((offer) => ({ regionId: region.regionId, offer })),
  );
  if (
    curriculumTargetRequestsApplication(input.contract.targetOutcome.description) &&
    applyEvidenceOffers.length > 0
  ) {
    const regionByIdForApply = new Map(
      input.regions.map((region) => [region.regionId, region] as const),
    );
    const hasBoundedRequiredApply = payload.units.some((unit) => {
      const region = regionByIdForApply.get(unit.regionId);
      if (!region) return false;
      const evidenceById = new Map(
        region.evidence.map((offer) => [offer.evidenceId, offer] as const),
      );
      return unit.objectives.some((objective) => {
        if (objective.priority !== 'required' || objective.construct !== 'apply') {
          return false;
        }
        return objective.evidence.some((selection) => {
          const envelope = evidenceById.get(selection.evidenceId)?.authorityEnvelope;
          return envelope ? isConstructSupported(objective.construct, envelope) : false;
        });
      });
    });
    if (!hasBoundedRequiredApply) {
      addDiagnostic(
        'required_target_apply_missing',
        'The learner target explicitly requires application, exact source-stated procedure authority is available, but the detail candidate contains no required apply objective bounded to that procedure.',
        {
          targetOutcome: input.contract.targetOutcome.description,
          availableProcedureEvidence: applyEvidenceOffers
            .slice(0, 20)
            .map(({ regionId, offer }) => ({
              courseMapRegionId: regionId,
              evidenceId: offer.evidenceId,
              sourceAllocationRegionId: offer.sourceAllocationRegionId,
              supportedConstructs: offer.authorityEnvelope?.supportedConstructs ?? [],
              narrowerClaim: offer.authorityEnvelope?.narrowerClaim ?? null,
            })),
        },
      );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, 100),
    diagnosticCodes: diagnosticCodes.slice(0, 100),
    ...(failureDiagnostics.length > 0
      ? {
          failureArtifact: {
            kind: 'curriculum_detail_candidate_validation_failed',
            context: {
              courseMapId: input.courseMapId,
              batchKey: input.batchKey,
              sourceAllocationFingerprint: input.sourceAllocationFingerprint,
            },
            diagnostics: failureDiagnostics,
          },
        }
      : {}),
  };
}

export interface CurriculumDetailAssembly {
  payload: LocallyAssembledCurriculumProposal;
  regionCount: number;
  prerequisiteCount: number;
}

function assertCurriculumAssemblyStructure(courseMap: CourseMap): void {
  const orderedRegions = courseMap.modules.flatMap((module) => module.regions);
  const orderByRegionId = new Map(orderedRegions.map((region, index) => [region.id, index]));
  if (orderByRegionId.size !== orderedRegions.length) {
    throw new Error('Course Map detail assembly contains a duplicate region identity.');
  }
  for (const [moduleIndex, module] of courseMap.modules.entries()) {
    if (module.index !== moduleIndex) {
      throw new Error('Course Map module order changed before Curriculum assembly.');
    }
    for (const [regionIndex, region] of module.regions.entries()) {
      if (region.moduleId !== module.id || region.index !== regionIndex) {
        throw new Error('Course Map region order changed before Curriculum assembly.');
      }
    }
  }

  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of courseMap.prerequisites) {
    const prerequisiteOrder = orderByRegionId.get(edge.prerequisiteRegionId);
    const dependentOrder = orderByRegionId.get(edge.dependentRegionId);
    const edgeKey = `${edge.prerequisiteRegionId}\u0000${edge.dependentRegionId}`;
    if (
      prerequisiteOrder === undefined ||
      dependentOrder === undefined ||
      prerequisiteOrder >= dependentOrder ||
      edgeKeys.has(edgeKey)
    ) {
      throw new Error('Course Map prerequisite topology is invalid during Curriculum assembly.');
    }
    edgeKeys.add(edgeKey);
    const dependents = adjacency.get(edge.prerequisiteRegionId) ?? [];
    dependents.push(edge.dependentRegionId);
    adjacency.set(edge.prerequisiteRegionId, dependents);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (regionId: string): void => {
    if (visiting.has(regionId)) {
      throw new Error('Course Map prerequisite graph is cyclic during Curriculum assembly.');
    }
    if (visited.has(regionId)) return;
    visiting.add(regionId);
    for (const dependentId of adjacency.get(regionId) ?? []) visit(dependentId);
    visiting.delete(regionId);
    visited.add(regionId);
  };
  orderedRegions.forEach((region) => visit(region.id));

  for (const group of courseMap.synthesisGroups) {
    if (
      new Set(group.regionIds).size !== group.regionIds.length ||
      group.regionIds.some((regionId) => !orderByRegionId.has(regionId))
    ) {
      throw new Error('Course Map synthesis membership is invalid during Curriculum assembly.');
    }
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Assemble fixed detail partitions into the existing single Curriculum proposal schema. */
export function assembleCurriculumDetailBatches(
  courseMap: CourseMap,
  batches: Array<{
    input: CurriculumDetailProposalInput;
    payload: CurriculumDetailProposalPayload;
  }>,
): CurriculumDetailAssembly {
  assertCurriculumAssemblyStructure(courseMap);
  const objectiveCount = batches.reduce(
    (count, batch) =>
      count +
      batch.payload.units.reduce((batchCount, unit) => batchCount + unit.objectives.length, 0),
    0,
  );
  if (objectiveCount > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES) {
    throw new Error(
      `Curriculum detail assembly contains ${objectiveCount} objectives, exceeding the global semantic-evaluation ceiling of ${OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES}.`,
    );
  }
  const units = new Map<
    string,
    { input: CurriculumDetailRegionInput; output: CurriculumDetailProposalPayload['units'][number] }
  >();
  const courseMapRegions = new Map(
    courseMap.modules.flatMap((module) =>
      module.regions.map((region) => [region.id, { module, region }] as const),
    ),
  );
  const prerequisiteRegionIdsByDependent = new Map<string, string[]>();
  for (const edge of courseMap.prerequisites) {
    const ids = prerequisiteRegionIdsByDependent.get(edge.dependentRegionId) ?? [];
    ids.push(edge.prerequisiteRegionId);
    prerequisiteRegionIdsByDependent.set(edge.dependentRegionId, ids);
  }
  for (const batch of batches) {
    if (
      batch.input.courseMapId !== courseMap.id ||
      batch.input.sourceAllocationFingerprint !== courseMap.sourceAllocationFingerprint
    ) {
      throw new Error('Curriculum detail batch belongs to a foreign Course Map snapshot.');
    }
    for (const inputRegion of batch.input.regions) {
      const expected = courseMapRegions.get(inputRegion.regionId);
      const expectedPrerequisites =
        prerequisiteRegionIdsByDependent.get(inputRegion.regionId) ?? [];
      const expectedSynthesisGroups = courseMap.synthesisGroups
        .filter((group) => group.regionIds.includes(inputRegion.regionId))
        .map((group) => group.id);
      if (
        !expected ||
        expected.module.id !== inputRegion.moduleId ||
        expected.module.index !== inputRegion.moduleIndex ||
        expected.region.index !== inputRegion.regionIndex ||
        expected.region.title !== inputRegion.title ||
        expected.region.learningIntent !== inputRegion.learningIntent ||
        expected.region.approximateScope !== inputRegion.approximateScope ||
        !sameStringArray(
          expected.region.sourceAllocationRegionIds,
          inputRegion.sourceAllocationRegionIds,
        ) ||
        !sameStringArray(
          expected.region.conceptIds,
          inputRegion.concepts.map((concept) => concept.id),
        ) ||
        !sameStringArray(
          expected.region.canonicalConceptIds,
          inputRegion.canonicalConcepts.map((concept) => concept.id),
        ) ||
        !sameStringArray(
          expected.region.capabilityRequirementRefs ?? [],
          (inputRegion.capabilityRequirements ?? []).map(
            (requirement) => requirement.capabilityRef,
          ),
        ) ||
        !sameStringArray(expectedPrerequisites, inputRegion.prerequisiteRegionIds) ||
        !sameStringArray(
          expectedSynthesisGroups,
          inputRegion.synthesisGroups.map((group) => group.id),
        )
      ) {
        throw new Error(
          `Curriculum detail batch region snapshot is foreign: ${inputRegion.regionId}.`,
        );
      }
    }
    const validation = validateCurriculumDetailCandidate(batch.payload, batch.input);
    if (!validation.valid) throw new Error(validation.diagnostics.join(' '));
    for (const output of batch.payload.units) {
      if (units.has(output.regionId)) {
        throw new Error(`Duplicate Course Map detail region during assembly: ${output.regionId}.`);
      }
      const region = batch.input.regions.find(
        (candidate) => candidate.regionId === output.regionId,
      )!;
      units.set(output.regionId, { input: region, output });
    }
  }
  const orderedRegions = courseMap.modules.flatMap((module) => module.regions);
  if (
    units.size !== orderedRegions.length ||
    orderedRegions.some((region) => !units.has(region.id))
  ) {
    throw new Error('Curriculum detail assembly omits one or more Course Map regions.');
  }
  const unitKeyByRegionId = new Map(
    orderedRegions.map((region, index) => [region.id, `course-map-unit-${index + 1}`] as const),
  );
  const objectiveKeysByRegionId = new Map<string, string[]>();
  const nodes: CurriculumProposalPayload['nodes'] = [];
  let globalRegionIndex = 0;
  for (const module of courseMap.modules) {
    const chapterKey = `course-map-module-${module.index + 1}`;
    nodes.push({
      key: chapterKey,
      parentKey: null,
      kind: 'chapter',
      index: module.index,
      title: module.title,
      structuralUnitIds: [],
      sourceEvidence: [],
      conceptIds: [],
      canonicalConceptIds: [],
      objectives: [],
      prerequisiteUnitKeys: [],
      graphRelationIds: [],
    });
    for (const region of module.regions) {
      const detail = units.get(region.id)!;
      const sectionKey = `course-map-region-${globalRegionIndex + 1}`;
      const unitKey = unitKeyByRegionId.get(region.id)!;
      const objectiveKeys = detail.output.objectives.map(
        (_objective, objectiveIndex) =>
          `course-map-objective-${globalRegionIndex + 1}-${objectiveIndex + 1}`,
      );
      objectiveKeysByRegionId.set(region.id, objectiveKeys);
      nodes.push({
        key: sectionKey,
        parentKey: chapterKey,
        kind: 'section',
        index: region.index,
        title: region.title,
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      });
      nodes.push({
        key: unitKey,
        parentKey: sectionKey,
        kind: 'learning_unit',
        index: 0,
        title: detail.output.title,
        structuralUnitIds: [],
        sourceEvidence: detail.output.sourceEvidence,
        conceptIds: detail.output.conceptIds,
        canonicalConceptIds: detail.output.canonicalConceptIds,
        objectives: detail.output.objectives.map((objective, objectiveIndex) => ({
          ...objective,
          key: objectiveKeys[objectiveIndex]!,
        })),
        prerequisiteUnitKeys: courseMap.prerequisites
          .filter((edge) => edge.dependentRegionId === region.id)
          .map((edge) => unitKeyByRegionId.get(edge.prerequisiteRegionId)!),
        graphRelationIds: [],
      });
      globalRegionIndex += 1;
    }
  }
  const synthesisGroups: CurriculumProposalPayload['synthesisGroups'] =
    courseMap.synthesisGroups.map((group, index) => ({
      key: `course-map-synthesis-${index + 1}`,
      title: group.title,
      level: group.level === 'module' ? 'chapter' : group.level,
      learningUnitKeys: group.regionIds.map((regionId) => unitKeyByRegionId.get(regionId)!),
      objectiveKeys: group.regionIds.flatMap(
        (regionId) => objectiveKeysByRegionId.get(regionId) ?? [],
      ),
    }));
  const payload = CurriculumProposalPayloadSchema.parse({ nodes, synthesisGroups });
  const prerequisiteCount = payload.nodes.reduce(
    (count, node) => count + node.prerequisiteUnitKeys.length,
    0,
  );
  if (prerequisiteCount !== courseMap.prerequisites.length) {
    throw new Error('Course Map prerequisite structure was lost during Curriculum assembly.');
  }
  return { payload, regionCount: orderedRegions.length, prerequisiteCount };
}
