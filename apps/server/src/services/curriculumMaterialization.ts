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
  type SourceBlock,
} from '@hy3-clinic/shared';
import type {
  CurriculumCanonicalConceptOffer,
  CurriculumContractContext,
  CurriculumDetailProposalInput,
  CurriculumDetailRegionInput,
  CurriculumEvidenceOffer,
  ProviderCandidateFailureArtifact,
  ProviderCandidateValidation,
} from '../llm/provider.js';
import { measureCurriculumDetailRequest } from '../llm/prompts.js';
import { assertCourseMapSourceAllocationIntegrity } from './courseMap.js';
import { hasCurriculumSemanticAnchor } from './curriculumSemanticEvaluator.js';
import {
  curriculumTargetRequestsApplication,
  detectFormalConstruct,
  formatNarrowedFormalObjective,
  isFormalObjectiveSupported,
  strongestNarrowableConstruct,
} from './curriculumAuthority.js';

export const MAX_DETAIL_BATCHES = 2;
export const MAX_DETAIL_REGIONS_PER_BATCH = 50;
export const MAX_DETAIL_EVIDENCE_OFFERS_PER_BATCH = 120;
export const MAX_DETAIL_REQUEST_BYTES = 120_000;
export const MAX_DETAIL_OUTPUT_ESTIMATE_BYTES = 62_000;
export const DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE = 1_200;
const DETAIL_OUTPUT_BASE_BYTES_ESTIMATE = 2_000;

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
}

export interface CurriculumDetailBatch {
  index: number;
  input: CurriculumDetailProposalInput;
  requestBytes: number;
  outputEstimateBytes: number;
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

  constructor(diagnostics: string[]) {
    super(diagnostics.join(' '));
    this.name = 'CurriculumDetailBatchPlanningError';
    this.diagnostics = diagnostics;
  }
}

function batchKey(courseMapId: string, regions: CurriculumDetailRegionInput[]): string {
  return `detail_batch_${createHash('sha256')
    .update(JSON.stringify({ courseMapId, regionIds: regions.map((region) => region.regionId) }))
    .digest('hex')
    .slice(0, 24)}`;
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
      const evidence = allocations.flatMap((allocation) =>
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
    DETAIL_OUTPUT_BASE_BYTES_ESTIMATE + regions.length * DETAIL_OUTPUT_BYTES_PER_REGION_ESTIMATE;
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
        throw new CurriculumDetailBatchPlanningError([
          `Course Map region ${region.regionId} exceeds an individual detail request budget.`,
        ]);
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
    const selectedAuthorityEnvelopes = (objective: (typeof unit.objectives)[number]) => {
      const exact = objective.evidence.flatMap((selection) => {
        const envelope = evidenceById.get(selection.evidenceId)?.authorityEnvelope;
        return envelope ? [envelope] : [];
      });
      return exact.length > 0 ? exact : region.authorityEnvelope ? [region.authorityEnvelope] : [];
    };
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
    if (region.authorityEnvelope || region.evidence.some((offer) => offer.authorityEnvelope)) {
      for (const objective of unit.objectives) {
        if (objective.priority !== 'required') continue;
        const construct = detectFormalConstruct(`${objective.title} ${objective.description}`);
        const envelopes = selectedAuthorityEnvelopes(objective);
        const objectiveClaim = `${objective.title} ${objective.description}`;
        if (envelopes.some((envelope) => isFormalObjectiveSupported(objectiveClaim, envelope))) {
          continue;
        }
        const repairEnvelope =
          envelopes.find((envelope) => envelope.supportedConstructs.includes('apply')) ??
          envelopes.find((envelope) => envelope.supportedConstructs.includes('explain')) ??
          envelopes.find((envelope) => envelope.supportedConstructs.includes('identify')) ??
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
        const claim = `${objective.title} ${objective.description}`;
        if (objective.priority !== 'required' || detectFormalConstruct(claim) !== 'apply') {
          return false;
        }
        return objective.evidence.some((selection) => {
          const envelope = evidenceById.get(selection.evidenceId)?.authorityEnvelope;
          return envelope ? isFormalObjectiveSupported(claim, envelope) : false;
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

/** Narrow one over-broad required detail objective using its local envelope. */
export function repairCurriculumDetailAuthorityCandidate(
  candidate: CurriculumDetailProposalPayload,
  input: CurriculumDetailProposalInput,
): { candidate: CurriculumDetailProposalPayload; repaired: boolean } {
  const parsed = CurriculumDetailProposalPayloadSchema.parse(candidate);
  let repaired = false;
  for (const unit of parsed.units) {
    const region = input.regions.find((candidate) => candidate.regionId === unit.regionId);
    if (!region) continue;
    const evidenceById = new Map(
      region.evidence.map((offer) => [offer.evidenceId, offer] as const),
    );
    for (const objective of unit.objectives) {
      if (objective.priority !== 'required') continue;
      const exactEnvelopes = objective.evidence.flatMap((selection) => {
        const envelope = evidenceById.get(selection.evidenceId)?.authorityEnvelope;
        return envelope ? [envelope] : [];
      });
      const envelopes =
        exactEnvelopes.length > 0
          ? exactEnvelopes
          : region.authorityEnvelope
            ? [region.authorityEnvelope]
            : [];
      const envelope =
        envelopes.find((candidate) => candidate.supportedConstructs.includes('apply')) ??
        envelopes.find((candidate) => candidate.supportedConstructs.includes('explain')) ??
        envelopes.find((candidate) => candidate.supportedConstructs.includes('identify'));
      if (
        envelopes.some((candidate) =>
          isFormalObjectiveSupported(`${objective.title} ${objective.description}`, candidate),
        ) ||
        !envelope ||
        !envelope.narrowerClaim ||
        (envelope.tier !== 'formal_sufficient' && envelope.tier !== 'narrower_formal') ||
        envelope.supportedConstructs.length === 0
      )
        continue;
      const narrowerConstruct = strongestNarrowableConstruct(envelope);
      if (!narrowerConstruct) continue;
      const wording = formatNarrowedFormalObjective(narrowerConstruct, envelope.narrowerClaim);
      objective.title = wording.title;
      objective.description = wording.description;
      repaired = true;
    }
  }
  return { candidate: parsed, repaired };
}

export interface CurriculumDetailAssembly {
  payload: CurriculumProposalPayload;
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
