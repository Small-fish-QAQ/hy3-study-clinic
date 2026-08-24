import {
  ApiErrorCode,
  CurriculumProposalPayloadSchema,
  ObjectiveAuthorityCapabilityRecoveryOriginSchema,
  ObjectiveAuthorityRequiredCapabilityPreservationSchema,
  type CourseMapSourceAllocation,
  type Curriculum,
  type CurriculumNode,
  type CurriculumProposalPayload,
  type ExecutionSourceManifest,
  type LearningContract,
  type ObjectiveAuthorityCapabilityRecoveryOrigin,
  type ObjectiveAuthorityRequiredCapabilityPreservation,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type {
  CurriculumCapabilityRecoveryRequirementInput,
  CurriculumEvidenceOffer,
  ProviderCandidateFailureValue,
  ProviderCandidateValidation,
} from '../llm/provider.js';
import { CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET } from './curriculumEvidence.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';
import {
  curriculumObjectiveProposition,
  fingerprintObjectiveAuthorityAuditValue,
} from './objectiveAuthoritySemanticSupport.js';
import type { ObjectiveAuthoritySemanticRepairEvidenceScope } from './objectiveAuthoritySemanticRepair.js';
import type { CurriculumCapabilityRecoveryRequirement } from './courseMap.js';

export const CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS = 192;
/**
 * Four capabilities plus the two ordinary visibility offers must fit the
 * unsplittable 120-offer detail-region ceiling: floor((120 - 2) / 4) = 29.
 */
export const CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT = 29;
export const CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS_PER_REGION = 4;
export const CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL =
  CURRICULUM_PROVIDER_EVIDENCE_OFFER_BUDGET;

type RecoveryPriority = CurriculumCapabilityRecoveryRequirementInput['priority'];

export interface CurriculumCapabilityRecoveryBinding {
  requirement: CurriculumCapabilityRecoveryRequirementInput;
  requiredCapabilityPreservation: ObjectiveAuthorityRequiredCapabilityPreservation;
  recoveryOrigin: ObjectiveAuthorityCapabilityRecoveryOrigin;
  predecessorLearningUnitId: string;
  predecessorObjectiveId: string;
  allowedSourceBlockIds: string[];
}

export interface CurriculumCapabilityRecoveryFrontier {
  predecessorCurriculumId: string;
  predecessorCurriculumVersion: number;
  fingerprint: string;
  requirements: CurriculumCapabilityRecoveryRequirementInput[];
  bindingsByCapabilityRef: ReadonlyMap<string, CurriculumCapabilityRecoveryBinding>;
}

export type SourceAllocatedCurriculumCapabilityRecoveryRequirement =
  CurriculumCapabilityRecoveryRequirement;

export interface CurriculumCapabilityRecoveryEvidenceReservation {
  /** Merged provider-visible catalog: ordinary coverage plus bounded recovery additions. */
  evidenceCatalog: CurriculumEvidenceOffer[];
  /** Exact bounded recovery subset for each predecessor LearningUnit. */
  recoveryEvidenceIdsByLearningUnitId: ReadonlyMap<string, readonly string[]>;
}

interface RecoveryDiagnostic {
  code: string;
  message: string;
  facts?: Record<string, ProviderCandidateFailureValue>;
}

function normalizedPriority(
  priority: RecoveryPriority | 'optional' | undefined,
): RecoveryPriority | 'optional' {
  return priority ?? 'normal';
}

function recoveryError(
  code: string,
  message: string,
  facts: Record<string, ProviderCandidateFailureValue> = {},
): AppError {
  return new AppError(ApiErrorCode.GroundingFailed, message, {
    kind: 'curriculum_capability_recovery_invalid',
    diagnosticCode: code,
    ...facts,
  });
}

function failedValidation(diagnostics: RecoveryDiagnostic[]): ProviderCandidateValidation {
  return {
    valid: false,
    diagnostics: diagnostics.map((diagnostic) => diagnostic.message).slice(0, 100),
    diagnosticCodes: diagnostics.map((diagnostic) => diagnostic.code).slice(0, 100),
    failureArtifact: {
      kind: 'curriculum_capability_recovery_candidate_invalid',
      context: {},
      diagnostics: diagnostics.slice(0, 20).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.facts ? { facts: diagnostic.facts } : {}),
      })),
    },
  };
}

function successfulValidation(): ProviderCandidateValidation {
  return { valid: true, diagnostics: [], diagnosticCodes: [] };
}

/** Stable local identity for the predecessor LearningUnit's complete source envelope. */
export function fingerprintCurriculumCapabilitySourceEnvelope(
  node: Pick<CurriculumNode, 'id' | 'sourceReferences'>,
): string {
  return fingerprintObjectiveAuthorityAuditValue({
    predecessorLearningUnitId: node.id,
    sourceReferences: node.sourceReferences.map((reference) => ({
      materialId: reference.materialId,
      materialRevisionId: reference.materialRevisionId,
      structuralUnitId: reference.structuralUnitId,
      sourceBlockId: reference.sourceBlockId,
      sourceBlockRevisionFingerprint: reference.sourceBlockRevisionFingerprint,
    })),
  });
}

function assertRecoveryPredecessorCurrent(input: {
  predecessor: Curriculum;
  contract: LearningContract;
  manifest: ExecutionSourceManifest;
}): void {
  const { predecessor, contract, manifest } = input;
  if (!predecessor.acceptedAt) {
    throw recoveryError(
      'recovery_predecessor_not_historically_accepted',
      'Curriculum capability recovery requires the nearest historically accepted predecessor.',
      { predecessorCurriculumId: predecessor.id, predecessorStatus: predecessor.status },
    );
  }
  if (
    predecessor.workspaceId !== contract.workspaceId ||
    predecessor.contractVersionId !== contract.id
  ) {
    throw recoveryError(
      'recovery_predecessor_contract_mismatch',
      'Curriculum capability recovery cannot cross Course or Contract boundaries.',
      {
        predecessorCurriculumId: predecessor.id,
        predecessorContractVersionId: predecessor.contractVersionId,
        expectedContractVersionId: contract.id,
      },
    );
  }
  if (
    predecessor.executionSourceManifest.fingerprint !== manifest.fingerprint ||
    JSON.stringify(predecessor.executionSourceManifest) !== JSON.stringify(manifest)
  ) {
    throw recoveryError(
      'recovery_predecessor_manifest_mismatch',
      'Curriculum capability recovery cannot carry objectives across a changed source manifest.',
      {
        predecessorCurriculumId: predecessor.id,
        predecessorManifestFingerprint: predecessor.executionSourceManifest.fingerprint,
        expectedManifestFingerprint: manifest.fingerprint,
      },
    );
  }
}

/**
 * Build one provider-visible catalog while separately freezing the bounded
 * recovery subset for every non-optional predecessor LearningUnit. The minimum
 * recovery pass runs before ordinary evidence, while recovery enrichment runs
 * after it, so reaching the global catalog ceiling cannot silently erase the
 * selector's ordinary source coverage. Ordinary offers remain visible without
 * automatically becoming recovery-eligible; each LearningUnit subset stays
 * within the recovery ceiling and their catalog union stays within the
 * fixed provider budget.
 */
export function reserveCurriculumCapabilityRecoveryEvidence(input: {
  predecessor: Curriculum;
  fullEvidenceCatalog: readonly CurriculumEvidenceOffer[];
  selectedEvidenceCatalog: readonly CurriculumEvidenceOffer[];
}): CurriculumCapabilityRecoveryEvidenceReservation {
  const sameBinding = (left: CurriculumEvidenceOffer, right: CurriculumEvidenceOffer): boolean => {
    const { id: _leftId, ...leftBinding } = left;
    const { id: _rightId, ...rightBinding } = right;
    return JSON.stringify(leftBinding) === JSON.stringify(rightBinding);
  };
  const fullByBindingId = new Map<string, CurriculumEvidenceOffer>();
  for (const offer of input.fullEvidenceCatalog) {
    const existing = fullByBindingId.get(offer.bindingId);
    if (existing && !sameBinding(existing, offer)) {
      throw recoveryError(
        'recovery_capability_evidence_identity_collision',
        'The complete recovery evidence catalog contains a conflicting binding identity.',
        { evidenceId: offer.id, bindingId: offer.bindingId },
      );
    }
    fullByBindingId.set(offer.bindingId, offer);
  }
  const ordinarySelected = input.selectedEvidenceCatalog.map((offer) => {
    const complete = fullByBindingId.get(offer.bindingId);
    if (complete && !sameBinding(complete, offer)) {
      throw recoveryError(
        'recovery_capability_evidence_identity_collision',
        'Selected recovery evidence conflicts with its complete-catalog identity.',
        { evidenceId: offer.id, bindingId: offer.bindingId },
      );
    }
    return complete ?? offer;
  });
  const ordinarySelectedBindingIds = new Set(ordinarySelected.map((offer) => offer.bindingId));
  const groups: Array<{
    nodeId: string;
    sourceBlockIds: Set<string>;
    ordinaryCandidates: CurriculumEvidenceOffer[];
    candidates: CurriculumEvidenceOffer[];
    recoveryBindingIds: Set<string>;
    cursor: number;
  }> = [];
  for (const node of input.predecessor.nodes) {
    const hasRequiredCapability =
      node.learningUnit?.objectives.some(
        (objective) => normalizedPriority(objective.priority) !== 'optional',
      ) ?? false;
    if (!hasRequiredCapability) continue;
    const orderedBlockIds = [
      ...new Set(
        node.sourceReferences.flatMap((reference) =>
          reference.sourceBlockId ? [reference.sourceBlockId] : [],
        ),
      ),
    ];
    const sourceBlockIds = new Set(orderedBlockIds);
    const fullOffers = [...fullByBindingId.values()].filter((offer) =>
      sourceBlockIds.has(offer.blockId),
    );
    const firstOfferByBlock = orderedBlockIds.flatMap((blockId) => {
      const offer = fullOffers.find((candidate) => candidate.blockId === blockId);
      return offer ? [offer] : [];
    });
    const ordinaryCandidates = fullOffers.filter((offer) =>
      ordinarySelectedBindingIds.has(offer.bindingId),
    );
    const candidates = [
      ...firstOfferByBlock.slice(0, 1),
      ...ordinaryCandidates,
      ...firstOfferByBlock.slice(1),
      ...fullOffers,
    ].filter(
      (offer, index, offers) =>
        offers.findIndex((candidate) => candidate.bindingId === offer.bindingId) === index,
    );
    groups.push({
      nodeId: node.id,
      sourceBlockIds,
      ordinaryCandidates,
      candidates,
      recoveryBindingIds: new Set(),
      cursor: 0,
    });
  }
  const groupsByBlockId = new Map<string, typeof groups>();
  for (const group of groups) {
    for (const blockId of group.sourceBlockIds) {
      const memberships = groupsByBlockId.get(blockId) ?? [];
      memberships.push(group);
      groupsByBlockId.set(blockId, memberships);
    }
  }
  const merged = new Map<string, CurriculumEvidenceOffer>();
  const tryAddToCatalog = (offer: CurriculumEvidenceOffer): boolean => {
    if (merged.has(offer.bindingId)) return true;
    if (merged.size >= CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL) return false;
    merged.set(offer.bindingId, offer);
    return true;
  };
  const trySelectRecoveryEvidence = (
    group: (typeof groups)[number],
    offer: CurriculumEvidenceOffer,
  ): boolean => {
    if (group.recoveryBindingIds.has(offer.bindingId)) return false;
    if (
      group.recoveryBindingIds.size >= CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT
    ) {
      return false;
    }
    if (!tryAddToCatalog(offer)) return false;
    group.recoveryBindingIds.add(offer.bindingId);
    return true;
  };
  const addNextCandidate = (group: (typeof groups)[number]): boolean => {
    while (group.cursor < group.candidates.length) {
      const candidate = group.candidates[group.cursor++]!;
      if (trySelectRecoveryEvidence(group, candidate)) return true;
    }
    return false;
  };
  const addMinimumCandidate = (group: (typeof groups)[number]): boolean => {
    for (const candidate of group.ordinaryCandidates) {
      if (trySelectRecoveryEvidence(group, candidate)) return true;
    }
    return addNextCandidate(group);
  };

  // Guarantee one exact offer per LearningUnit before any other use of the
  // global budget. Prefer an ordinary selected binding already owed to source
  // coverage, avoiding a second global slot for the same LearningUnit. A
  // shared binding can satisfy more than one source envelope.
  for (const group of groups) {
    if (group.recoveryBindingIds.size === 0) addMinimumCandidate(group);
  }
  const unservedGroup = groups.find((group) => group.recoveryBindingIds.size === 0);
  if (unservedGroup) {
    throw recoveryError(
      'recovery_capability_source_envelope_missing',
      'A non-optional predecessor LearningUnit has no exact evidence inside the bounded recovery reserve.',
      {
        predecessorLearningUnitId: unservedGroup.nodeId,
        evidenceLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL,
      },
    );
  }

  // The ordinary selector's first pass contributes one binding per selected
  // block. Preserve that coverage layer exactly; losing one here can leave a
  // later source-allocation region with no exact evidence to select.
  const ordinaryCoverageBindingIds = new Set<string>();
  const ordinaryCoverageBlockIds = new Set<string>();
  for (const offer of ordinarySelected) {
    if (ordinaryCoverageBlockIds.has(offer.blockId)) continue;
    ordinaryCoverageBlockIds.add(offer.blockId);
    ordinaryCoverageBindingIds.add(offer.bindingId);
    if (!tryAddToCatalog(offer)) {
      throw recoveryError(
        'recovery_ordinary_evidence_coverage_budget_exceeded',
        'The combined provider evidence catalog cannot preserve ordinary exact source coverage.',
        {
          evidenceId: offer.id,
          bindingId: offer.bindingId,
          sourceBlockId: offer.blockId,
          recoveryLearningUnitIds:
            groupsByBlockId.get(offer.blockId)?.map((group) => group.nodeId) ?? [],
          evidenceLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_TOTAL,
        },
      );
    }
  }

  // Retain any second ordinary offer while feasible, still ahead of optional
  // recovery enrichment. The first-pass coverage above is never best-effort.
  for (const offer of ordinarySelected) {
    if (ordinaryCoverageBindingIds.has(offer.bindingId)) continue;
    tryAddToCatalog(offer);
  }

  for (
    let round = 0;
    round < CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT;
    round += 1
  ) {
    for (const group of groups) {
      if (
        group.recoveryBindingIds.size >= CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT
      ) {
        continue;
      }
      addNextCandidate(group);
    }
  }
  const evidenceCatalog = [...merged.values()].map((offer, index) => ({
    ...offer,
    id: `E${index + 1}`,
  }));
  const evidenceIdByBindingId = new Map(
    evidenceCatalog.map((offer) => [offer.bindingId, offer.id] as const),
  );
  return {
    evidenceCatalog,
    recoveryEvidenceIdsByLearningUnitId: new Map(
      groups.map((group) => [
        group.nodeId,
        [...group.recoveryBindingIds].map((bindingId) => {
          const evidenceId = evidenceIdByBindingId.get(bindingId);
          if (!evidenceId) {
            throw recoveryError(
              'recovery_capability_evidence_alias_missing',
              'A selected recovery evidence binding has no provider-visible alias.',
              { predecessorLearningUnitId: group.nodeId, bindingId },
            );
          }
          return evidenceId;
        }),
      ]),
    ),
  };
}

/**
 * Freeze the non-optional capability frontier of one accepted, same-contract,
 * same-manifest predecessor before any provider call. Source membership only
 * defines the repair universe; it does not itself establish semantic support.
 */
export function buildCurriculumCapabilityRecoveryFrontier(input: {
  predecessor: Curriculum;
  contract: LearningContract;
  manifest: ExecutionSourceManifest;
  sourceBlocks: readonly SourceBlock[];
  evidenceCatalog: readonly CurriculumEvidenceOffer[];
  recoveryEvidenceIdsByLearningUnitId: ReadonlyMap<string, readonly string[]>;
}): CurriculumCapabilityRecoveryFrontier {
  assertRecoveryPredecessorCurrent(input);
  const blockById = new Map(input.sourceBlocks.map((block) => [block.id, block] as const));
  const manifestBlockIds = new Set(
    input.manifest.revisions.flatMap((revision) => revision.sourceBlockRevisionIds),
  );
  const evidenceById = new Map(input.evidenceCatalog.map((offer) => [offer.id, offer] as const));
  if (evidenceById.size !== input.evidenceCatalog.length) {
    throw recoveryError(
      'recovery_capability_evidence_identity_duplicate',
      'Recovery evidence identities must be unique before freezing the predecessor frontier.',
    );
  }
  const bindings: CurriculumCapabilityRecoveryBinding[] = [];
  const objectiveIds = new Set<string>();
  const consumedRecoveryLearningUnitIds = new Set<string>();
  for (const node of input.predecessor.nodes) {
    if (!node.learningUnit) continue;
    const sourceBlockIds = [
      ...new Set(
        node.sourceReferences.flatMap((reference) =>
          reference.sourceBlockId ? [reference.sourceBlockId] : [],
        ),
      ),
    ];
    for (const sourceBlockId of sourceBlockIds) {
      const block = blockById.get(sourceBlockId);
      const reference = node.sourceReferences.find(
        (candidate) => candidate.sourceBlockId === sourceBlockId,
      );
      if (
        !block ||
        !reference ||
        !manifestBlockIds.has(sourceBlockId) ||
        block.materialId !== reference.materialId ||
        block.materialRevisionId !== reference.materialRevisionId ||
        reference.sourceBlockRevisionFingerprint !==
          curriculumSourceBlockFingerprint(block, reference.materialRevisionId)
      ) {
        throw recoveryError(
          'recovery_source_envelope_stale',
          'A predecessor LearningUnit source envelope is stale or outside the current manifest.',
          {
            predecessorCurriculumId: input.predecessor.id,
            predecessorLearningUnitId: node.id,
            sourceBlockId,
          },
        );
      }
    }
    const nonOptionalObjectives = node.learningUnit.objectives.filter(
      (objective) => normalizedPriority(objective.priority) !== 'optional',
    );
    const configuredEvidenceIds = input.recoveryEvidenceIdsByLearningUnitId.get(node.id);
    if (nonOptionalObjectives.length === 0 && configuredEvidenceIds) {
      throw recoveryError(
        'recovery_capability_evidence_reservation_unbound',
        'Recovery evidence cannot be reserved for an optional-only predecessor LearningUnit.',
        { predecessorLearningUnitId: node.id },
      );
    }
    if (nonOptionalObjectives.length > 0 && !configuredEvidenceIds) {
      throw recoveryError(
        'recovery_capability_evidence_reservation_missing',
        'A non-optional predecessor LearningUnit has no bounded recovery evidence reservation.',
        { predecessorLearningUnitId: node.id },
      );
    }
    if (configuredEvidenceIds) consumedRecoveryLearningUnitIds.add(node.id);
    const uniqueConfiguredEvidenceIds = [...new Set(configuredEvidenceIds ?? [])];
    if (uniqueConfiguredEvidenceIds.length !== (configuredEvidenceIds?.length ?? 0)) {
      throw recoveryError(
        'recovery_capability_evidence_reservation_duplicate',
        'A predecessor LearningUnit repeats a recovery evidence identity.',
        { predecessorLearningUnitId: node.id },
      );
    }
    if (
      uniqueConfiguredEvidenceIds.length >
      CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT
    ) {
      throw recoveryError(
        'recovery_capability_evidence_budget_exceeded',
        'A predecessor LearningUnit exceeds the bounded recovery evidence budget.',
        {
          predecessorLearningUnitId: node.id,
          evidenceCount: uniqueConfiguredEvidenceIds.length,
          evidenceLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_EVIDENCE_PER_REQUIREMENT,
        },
      );
    }
    const allowedEvidence = uniqueConfiguredEvidenceIds.flatMap((evidenceId) => {
      const offer = evidenceById.get(evidenceId);
      if (!offer) {
        throw recoveryError(
          'recovery_capability_evidence_unknown',
          'A predecessor capability references recovery evidence outside the provider catalog.',
          { predecessorLearningUnitId: node.id, evidenceId },
        );
      }
      if (!sourceBlockIds.includes(offer.blockId)) {
        throw recoveryError(
          'recovery_capability_evidence_outside_source_envelope',
          'A predecessor capability references evidence outside its LearningUnit source envelope.',
          { predecessorLearningUnitId: node.id, evidenceId, sourceBlockId: offer.blockId },
        );
      }
      return [offer];
    });
    for (const objective of node.learningUnit.objectives) {
      const priority = normalizedPriority(objective.priority);
      if (priority === 'optional') continue;
      if (objectiveIds.has(objective.id)) {
        throw recoveryError(
          'recovery_predecessor_objective_duplicate',
          'The accepted predecessor repeats an objective identity.',
          { predecessorObjectiveId: objective.id },
        );
      }
      objectiveIds.add(objective.id);
      const construct = objective.formalAssessmentConstruct;
      if (!construct) {
        throw recoveryError(
          'recovery_capability_construct_missing',
          'A non-optional predecessor objective has no frozen assessment construct.',
          {
            predecessorLearningUnitId: node.id,
            predecessorObjectiveId: objective.id,
          },
        );
      }
      if (construct === 'design' || construct === 'evaluate') {
        throw recoveryError(
          'recovery_capability_construct_prohibited',
          'A non-optional predecessor objective uses a construct prohibited by the current source-authority policy.',
          {
            predecessorLearningUnitId: node.id,
            predecessorObjectiveId: objective.id,
            construct,
            priority,
          },
        );
      }
      if (sourceBlockIds.length === 0 || allowedEvidence.length === 0) {
        throw recoveryError(
          'recovery_capability_source_envelope_missing',
          'A non-optional predecessor objective has no current exact evidence inside its LearningUnit source envelope.',
          {
            predecessorLearningUnitId: node.id,
            predecessorObjectiveId: objective.id,
          },
        );
      }
      const capabilityRef = `recovery_capability_${bindings.length + 1}`;
      const originalProposition = curriculumObjectiveProposition(objective);
      const requirement: CurriculumCapabilityRecoveryRequirementInput = {
        capabilityRef,
        title: objective.title,
        description: objective.description,
        originalProposition,
        construct,
        priority,
        allowedEvidenceIds: allowedEvidence.map((offer) => offer.id),
      };
      const requiredCapabilityPreservation =
        ObjectiveAuthorityRequiredCapabilityPreservationSchema.parse({
          originalProposition,
          originalFragments: [
            {
              fragmentId: `${capabilityRef}:F1`,
              text: originalProposition,
            },
          ],
        });
      const recoveryOrigin = ObjectiveAuthorityCapabilityRecoveryOriginSchema.parse({
        predecessorCurriculumId: input.predecessor.id,
        predecessorCurriculumVersion: input.predecessor.version,
        predecessorLearningUnitId: node.id,
        predecessorObjectiveId: objective.id,
        predecessorPriority: priority,
        contractVersionId: input.contract.id,
        executionSourceManifestFingerprint: input.manifest.fingerprint,
        sourceEnvelopeFingerprint: fingerprintCurriculumCapabilitySourceEnvelope(node),
      });
      bindings.push({
        requirement,
        requiredCapabilityPreservation,
        recoveryOrigin,
        predecessorLearningUnitId: node.id,
        predecessorObjectiveId: objective.id,
        allowedSourceBlockIds: sourceBlockIds,
      });
    }
  }
  if (consumedRecoveryLearningUnitIds.size !== input.recoveryEvidenceIdsByLearningUnitId.size) {
    const foreignLearningUnitId = [...input.recoveryEvidenceIdsByLearningUnitId.keys()].find(
      (nodeId) => !consumedRecoveryLearningUnitIds.has(nodeId),
    );
    throw recoveryError(
      'recovery_capability_evidence_reservation_foreign',
      'Recovery evidence was reserved for a foreign predecessor LearningUnit.',
      { predecessorLearningUnitId: foreignLearningUnitId ?? null },
    );
  }
  if (bindings.length > CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS) {
    throw recoveryError(
      'recovery_capability_requirement_budget_exceeded',
      'The predecessor capability frontier exceeds the fixed semantic-evaluation budget.',
      {
        requirementCount: bindings.length,
        requirementLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS,
      },
    );
  }
  const fingerprint = fingerprintObjectiveAuthorityAuditValue(
    bindings.map((binding) => ({
      requirement: binding.requirement,
      recoveryOrigin: binding.recoveryOrigin,
      allowedSourceBlockIds: binding.allowedSourceBlockIds,
    })),
  );
  return {
    predecessorCurriculumId: input.predecessor.id,
    predecessorCurriculumVersion: input.predecessor.version,
    fingerprint,
    requirements: bindings.map((binding) => ({
      ...binding.requirement,
      allowedEvidenceIds: [...binding.requirement.allowedEvidenceIds],
    })),
    bindingsByCapabilityRef: new Map(
      bindings.map((binding) => [binding.requirement.capabilityRef, binding] as const),
    ),
  };
}

function hasCapacityMatching(
  requirements: readonly SourceAllocatedCurriculumCapabilityRecoveryRequirement[],
  regionIds: readonly string[],
): boolean {
  const slots = regionIds.flatMap((regionId) =>
    Array.from(
      { length: CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS_PER_REGION },
      (_, index) => `${regionId}\u0000${index}`,
    ),
  );
  const regionIdBySlot = new Map(slots.map((slot) => [slot, slot.split('\u0000')[0]!] as const));
  const requirementBySlot = new Map<string, string>();
  const assign = (
    requirement: SourceAllocatedCurriculumCapabilityRecoveryRequirement,
    seen: Set<string>,
  ): boolean => {
    for (const slot of slots) {
      const regionId = regionIdBySlot.get(slot)!;
      if (!requirement.allowedSourceAllocationRegionIds.includes(regionId) || seen.has(slot))
        continue;
      seen.add(slot);
      const currentRef = requirementBySlot.get(slot);
      if (!currentRef) {
        requirementBySlot.set(slot, requirement.capabilityRef);
        return true;
      }
      const current = requirements.find((candidate) => candidate.capabilityRef === currentRef)!;
      if (assign(current, seen)) {
        requirementBySlot.set(slot, requirement.capabilityRef);
        return true;
      }
    }
    return false;
  };
  return requirements.every((requirement) => assign(requirement, new Set()));
}

/** Bind the frozen frontier only to exact evidence visible in source-allocation regions. */
export function allocateCurriculumCapabilityRecoveryFrontier(
  frontier: CurriculumCapabilityRecoveryFrontier,
  sourceAllocation: CourseMapSourceAllocation,
  evidenceCatalog: readonly CurriculumEvidenceOffer[],
): SourceAllocatedCurriculumCapabilityRecoveryRequirement[] {
  const evidenceById = new Map(evidenceCatalog.map((offer) => [offer.id, offer] as const));
  if (evidenceById.size !== evidenceCatalog.length) {
    throw recoveryError(
      'recovery_capability_evidence_identity_duplicate',
      'Recovery evidence identities must be unique before Course Map placement.',
    );
  }
  const result = frontier.requirements.map((requirement) => {
    const binding = frontier.bindingsByCapabilityRef.get(requirement.capabilityRef);
    if (!binding) {
      throw recoveryError(
        'recovery_capability_binding_missing',
        'A predecessor capability has no local source-envelope binding.',
        { capabilityRef: requirement.capabilityRef },
      );
    }
    const exactAllocationIds = new Set<string>();
    for (const evidenceId of requirement.allowedEvidenceIds) {
      const offer = evidenceById.get(evidenceId);
      const matchingRegions = offer
        ? sourceAllocation.regions.filter(
            (region) =>
              region.materialId === offer.materialId &&
              region.materialRevisionId === offer.materialRevisionId &&
              region.sourceBlockIds.includes(offer.blockId),
          )
        : [];
      if (!offer || matchingRegions.length !== 1) {
        throw recoveryError(
          'recovery_capability_evidence_outside_source_allocation',
          'A predecessor capability contains exact evidence outside the Course Map source allocation.',
          { capabilityRef: requirement.capabilityRef, evidenceId },
        );
      }
      exactAllocationIds.add(matchingRegions[0]!.id);
    }
    const allowedSourceAllocationRegionIds = sourceAllocation.regions.flatMap((region) =>
      exactAllocationIds.has(region.id) ? [region.id] : [],
    );
    if (allowedSourceAllocationRegionIds.length === 0) {
      throw recoveryError(
        'recovery_capability_outside_source_allocation',
        'A predecessor capability has no exact evidence visible in the Course Map source allocation.',
        { capabilityRef: requirement.capabilityRef },
      );
    }
    return {
      ...requirement,
      allowedEvidenceIds: [...requirement.allowedEvidenceIds],
      allowedSourceAllocationRegionIds,
    };
  });
  if (
    !hasCapacityMatching(
      result,
      sourceAllocation.regions.map((region) => region.id),
    )
  ) {
    throw recoveryError(
      'recovery_capability_region_capacity_exceeded',
      'The predecessor capability frontier cannot fit within the bounded Course Map detail regions.',
      {
        requirementCount: result.length,
        perRegionLimit: CURRICULUM_CAPABILITY_RECOVERY_MAX_REQUIREMENTS_PER_REGION,
      },
    );
  }
  return result;
}

/** Exact once-only alias, proposition, construct, priority, and source-envelope validation. */
export function validateCurriculumCapabilityRecoveryCandidate(
  candidate: CurriculumProposalPayload | unknown,
  frontier: CurriculumCapabilityRecoveryFrontier | null,
): ProviderCandidateValidation {
  const parsed = CurriculumProposalPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return failedValidation([
      {
        code: 'recovery_capability_candidate_schema_invalid',
        message: 'The Curriculum candidate is malformed before capability-recovery validation.',
      },
    ]);
  }
  const diagnostics: RecoveryDiagnostic[] = [];
  const locations = parsed.data.nodes.flatMap((node) =>
    node.objectives.flatMap((objective) =>
      objective.capabilityRequirementRef ? [{ node, objective }] : [],
    ),
  );
  if (!frontier) {
    for (const { objective } of locations) {
      diagnostics.push({
        code: 'recovery_capability_unsolicited',
        message: `Objective ${objective.key} emitted an unsolicited recovery capability reference.`,
        facts: { objectiveKey: objective.key, capabilityRef: objective.capabilityRequirementRef! },
      });
    }
    return diagnostics.length > 0 ? failedValidation(diagnostics) : successfulValidation();
  }
  const locationByRef = new Map<string, (typeof locations)[number][]>();
  for (const location of locations) {
    const capabilityRef = location.objective.capabilityRequirementRef!;
    const entries = locationByRef.get(capabilityRef) ?? [];
    entries.push(location);
    locationByRef.set(capabilityRef, entries);
    if (!frontier.bindingsByCapabilityRef.has(capabilityRef)) {
      diagnostics.push({
        code: 'recovery_capability_unknown',
        message: `Objective ${location.objective.key} references an unknown recovery capability.`,
        facts: { objectiveKey: location.objective.key, capabilityRef },
      });
    }
  }
  for (const requirement of frontier.requirements) {
    const entries = locationByRef.get(requirement.capabilityRef) ?? [];
    if (entries.length === 0) {
      diagnostics.push({
        code: 'recovery_capability_missing',
        message: `Recovery capability ${requirement.capabilityRef} is missing from the successor candidate.`,
        facts: { capabilityRef: requirement.capabilityRef },
      });
      continue;
    }
    if (entries.length !== 1) {
      diagnostics.push({
        code: 'recovery_capability_duplicate',
        message: `Recovery capability ${requirement.capabilityRef} must appear exactly once.`,
        facts: { capabilityRef: requirement.capabilityRef, occurrenceCount: entries.length },
      });
      continue;
    }
    const { objective } = entries[0]!;
    if (
      objective.title !== requirement.title ||
      objective.description !== requirement.description
    ) {
      diagnostics.push({
        code: 'recovery_capability_proposition_changed',
        message: `Recovery capability ${requirement.capabilityRef} changed its predecessor proposition.`,
        facts: { capabilityRef: requirement.capabilityRef, objectiveKey: objective.key },
      });
    }
    if (objective.construct !== requirement.construct) {
      diagnostics.push({
        code: 'recovery_capability_construct_changed',
        message: `Recovery capability ${requirement.capabilityRef} changed its frozen construct.`,
        facts: {
          capabilityRef: requirement.capabilityRef,
          expectedConstruct: requirement.construct,
          actualConstruct: objective.construct,
        },
      });
    }
    const actualPriority = normalizedPriority(objective.priority);
    if (actualPriority !== requirement.priority) {
      diagnostics.push({
        code: 'recovery_capability_priority_changed',
        message: `Recovery capability ${requirement.capabilityRef} changed its frozen priority.`,
        facts: {
          capabilityRef: requirement.capabilityRef,
          expectedPriority: requirement.priority,
          actualPriority,
        },
      });
    }
    const evidenceIds = objective.evidence.map((selection) => selection.evidenceId);
    if (evidenceIds.length === 0) {
      diagnostics.push({
        code: 'recovery_capability_evidence_missing',
        message: `Recovery capability ${requirement.capabilityRef} selected no exact evidence.`,
        facts: { capabilityRef: requirement.capabilityRef },
      });
    }
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      diagnostics.push({
        code: 'recovery_capability_evidence_duplicate',
        message: `Recovery capability ${requirement.capabilityRef} repeats an evidence selection.`,
        facts: { capabilityRef: requirement.capabilityRef },
      });
    }
    const allowedEvidenceIds = new Set(requirement.allowedEvidenceIds);
    const foreignEvidenceIds = evidenceIds.filter(
      (evidenceId) => !allowedEvidenceIds.has(evidenceId),
    );
    if (foreignEvidenceIds.length > 0) {
      diagnostics.push({
        code: 'recovery_capability_evidence_outside_envelope',
        message: `Recovery capability ${requirement.capabilityRef} selected evidence outside its predecessor LearningUnit envelope.`,
        facts: { capabilityRef: requirement.capabilityRef, foreignEvidenceIds },
      });
    }
  }
  return diagnostics.length > 0 ? failedValidation(diagnostics) : successfulValidation();
}

export interface MaterializedCurriculumCapabilityRecoveryBindings {
  requiredCapabilityPreservationByObjectiveId: ReadonlyMap<
    string,
    ObjectiveAuthorityRequiredCapabilityPreservation
  >;
  recoveryOriginByObjectiveId: ReadonlyMap<string, ObjectiveAuthorityCapabilityRecoveryOrigin>;
  /** Frozen local scope used only if independent semantic evaluation requests repair. */
  repairEvidenceScopeByObjectiveId: ReadonlyMap<
    string,
    ObjectiveAuthoritySemanticRepairEvidenceScope
  >;
}

function sameRecoveryOrigin(
  left: ObjectiveAuthorityCapabilityRecoveryOrigin | undefined,
  right: ObjectiveAuthorityCapabilityRecoveryOrigin,
): boolean {
  return (
    left?.predecessorCurriculumId === right.predecessorCurriculumId &&
    left.predecessorCurriculumVersion === right.predecessorCurriculumVersion &&
    left.predecessorLearningUnitId === right.predecessorLearningUnitId &&
    left.predecessorObjectiveId === right.predecessorObjectiveId &&
    left.predecessorPriority === right.predecessorPriority &&
    left.contractVersionId === right.contractVersionId &&
    left.executionSourceManifestFingerprint === right.executionSourceManifestFingerprint &&
    left.sourceEnvelopeFingerprint === right.sourceEnvelopeFingerprint
  );
}

/** Reattach local predecessor lineage after the server assigns successor objective IDs. */
export function bindMaterializedCurriculumCapabilityRecovery(input: {
  candidate: CurriculumProposalPayload;
  objectiveIdByProposalKey: ReadonlyMap<string, string>;
  frontier: CurriculumCapabilityRecoveryFrontier | null;
}): MaterializedCurriculumCapabilityRecoveryBindings {
  if (!input.frontier) {
    return {
      requiredCapabilityPreservationByObjectiveId: new Map(),
      recoveryOriginByObjectiveId: new Map(),
      repairEvidenceScopeByObjectiveId: new Map(),
    };
  }
  const validation = validateCurriculumCapabilityRecoveryCandidate(input.candidate, input.frontier);
  if (!validation.valid) {
    throw recoveryError(
      'recovery_capability_materialized_binding_invalid',
      'The successor capability frontier is invalid before semantic evaluation.',
      { diagnostics: validation.diagnostics.slice(0, 20) },
    );
  }
  const requiredCapabilityPreservationByObjectiveId = new Map<
    string,
    ObjectiveAuthorityRequiredCapabilityPreservation
  >();
  const recoveryOriginByObjectiveId = new Map<string, ObjectiveAuthorityCapabilityRecoveryOrigin>();
  const repairEvidenceScopeByObjectiveId = new Map<
    string,
    ObjectiveAuthoritySemanticRepairEvidenceScope
  >();
  for (const node of input.candidate.nodes) {
    for (const objective of node.objectives) {
      const capabilityRef = objective.capabilityRequirementRef;
      if (!capabilityRef) continue;
      const binding = input.frontier.bindingsByCapabilityRef.get(capabilityRef)!;
      const objectiveId = input.objectiveIdByProposalKey.get(objective.key);
      if (
        !objectiveId ||
        requiredCapabilityPreservationByObjectiveId.has(objectiveId) ||
        recoveryOriginByObjectiveId.has(objectiveId) ||
        repairEvidenceScopeByObjectiveId.has(objectiveId)
      ) {
        throw recoveryError(
          'recovery_capability_objective_binding_failed',
          'A successor recovery capability cannot be bound uniquely to its local objective identity.',
          { capabilityRef, objectiveKey: objective.key },
        );
      }
      requiredCapabilityPreservationByObjectiveId.set(
        objectiveId,
        binding.requiredCapabilityPreservation,
      );
      recoveryOriginByObjectiveId.set(objectiveId, binding.recoveryOrigin);
      repairEvidenceScopeByObjectiveId.set(objectiveId, {
        allowedEvidenceIds: [...binding.requirement.allowedEvidenceIds],
        allowedSourceBlockIds: [...binding.allowedSourceBlockIds],
      });
    }
  }
  if (requiredCapabilityPreservationByObjectiveId.size !== input.frontier.requirements.length) {
    throw recoveryError(
      'recovery_capability_objective_set_mismatch',
      'The successor recovery capability set changed during local materialization.',
      {
        expectedRequirementCount: input.frontier.requirements.length,
        actualRequirementCount: requiredCapabilityPreservationByObjectiveId.size,
      },
    );
  }
  return {
    requiredCapabilityPreservationByObjectiveId,
    recoveryOriginByObjectiveId,
    repairEvidenceScopeByObjectiveId,
  };
}

/** Final one-to-one audit over locally attached, independently passing lineage. */
export function assertCurriculumCapabilityRecoveryLineage(
  curriculum: Curriculum,
  frontier: CurriculumCapabilityRecoveryFrontier | null,
): void {
  if (!frontier) return;
  const objectives = curriculum.nodes.flatMap((node) => node.learningUnit?.objectives ?? []);
  for (const binding of frontier.bindingsByCapabilityRef.values()) {
    const matches = objectives.filter((objective) => {
      const origin = objective.semanticSupport?.capabilityPreservation?.recoveryOrigin;
      return (
        origin?.predecessorCurriculumId === binding.recoveryOrigin.predecessorCurriculumId &&
        origin.predecessorObjectiveId === binding.recoveryOrigin.predecessorObjectiveId
      );
    });
    if (matches.length !== 1) {
      throw recoveryError(
        'recovery_capability_lineage_set_mismatch',
        'A persisted successor must carry exactly one passing lineage artifact per predecessor capability.',
        {
          predecessorObjectiveId: binding.predecessorObjectiveId,
          occurrenceCount: matches.length,
        },
      );
    }
    const objective = matches[0]!;
    const preservation = objective.semanticSupport?.capabilityPreservation;
    const allowedSourceBlockIds = new Set(binding.allowedSourceBlockIds);
    if (
      objective.title !== binding.requirement.title ||
      objective.description !== binding.requirement.description ||
      objective.formalAssessmentConstruct !== binding.requirement.construct ||
      normalizedPriority(objective.priority) !== binding.requirement.priority ||
      objective.semanticSupport?.verdict !== 'pass' ||
      objective.semanticSupport.boundSourceBlockIds.some(
        (sourceBlockId) => !allowedSourceBlockIds.has(sourceBlockId),
      ) ||
      preservation?.verdict !== 'pass' ||
      preservation.originalProposition !== binding.requirement.originalProposition ||
      !sameRecoveryOrigin(preservation.recoveryOrigin, binding.recoveryOrigin)
    ) {
      throw recoveryError(
        'recovery_capability_lineage_invalid',
        'A successor capability lineage artifact does not match its immutable predecessor requirement.',
        {
          predecessorObjectiveId: binding.predecessorObjectiveId,
          successorObjectiveId: objective.id,
        },
      );
    }
  }
}
