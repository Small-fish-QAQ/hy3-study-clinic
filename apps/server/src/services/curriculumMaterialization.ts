import { createHash } from 'node:crypto';
import {
  CurriculumDetailProposalPayloadSchema,
  CurriculumProposalPayloadSchema,
  type Concept,
  type CourseMap,
  type CourseMapSourceAllocation,
  type CurriculumAuthorityEnvelope,
  type FormalAssessmentConstruct,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
} from '@hy3-clinic/shared';
import type {
  CurriculumCanonicalConceptOffer,
  CurriculumContractContext,
  CurriculumDetailProposalInput,
  CurriculumDetailRegionInput,
  CurriculumEvidenceOffer,
  ProviderCandidateValidation,
} from '../llm/provider.js';
import { measureCurriculumDetailRequest } from '../llm/prompts.js';
import { assertCourseMapSourceAllocationIntegrity } from './courseMap.js';
import { detectFormalConstruct, isConstructSupported } from './curriculumAuthority.js';

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
}

export interface CurriculumDetailBatch {
  index: number;
  input: CurriculumDetailProposalInput;
  requestBytes: number;
  outputEstimateBytes: number;
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
    return {
      valid: false,
      diagnostics: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`,
      ),
      diagnosticCodes: parsed.error.issues.map((issue) => `schema_${issue.code}`),
    };
  }
  const diagnostics: string[] = [];
  const diagnosticCodes: string[] = [];
  const payload = parsed.data;
  if (payload.courseMapId !== input.courseMapId) {
    diagnostics.push('Curriculum detail response references a foreign Course Map.');
    diagnosticCodes.push('foreign_course_map');
  }
  if (payload.sourceAllocationFingerprint !== input.sourceAllocationFingerprint) {
    diagnostics.push('Curriculum detail response has a stale source-allocation fingerprint.');
    diagnosticCodes.push('source_allocation_fingerprint_mismatch');
  }
  const expectedRegionIds = input.regions.map((region) => region.regionId);
  const actualRegionIds = payload.units.map((unit) => unit.regionId);
  if (
    actualRegionIds.length !== expectedRegionIds.length ||
    actualRegionIds.some((id, index) => id !== expectedRegionIds[index])
  ) {
    diagnostics.push(
      'Curriculum detail response must represent every offered region exactly once in order.',
    );
    diagnosticCodes.push('region_set_or_order_mismatch');
  }
  const regionById = new Map(input.regions.map((region) => [region.regionId, region] as const));
  for (const unit of payload.units) {
    const region = regionById.get(unit.regionId);
    if (!region) {
      diagnostics.push(`Curriculum detail response contains an unknown region: ${unit.regionId}.`);
      diagnosticCodes.push('unknown_region');
      continue;
    }
    if (region.authorityEnvelope) {
      for (const objective of unit.objectives) {
        if (objective.priority !== 'required') continue;
        const construct = detectFormalConstruct(`${objective.title} ${objective.description}`);
        if (isConstructSupported(construct, region.authorityEnvelope)) continue;
        diagnostics.push(
          `required_objective_formal_authority_missing: objective ${objective.key} claims ${construct}, but source region ${region.regionId} supports ${region.authorityEnvelope.supportedConstructs.join(', ') || 'no formal construct'}; narrowerClaim=${region.authorityEnvelope.narrowerClaim ?? 'none'}; protectedPriority=required.`,
        );
        diagnosticCodes.push('required_objective_formal_authority_missing');
      }
    }
    const evidenceById = new Map(
      region.evidence.map((offer) => [offer.evidenceId, offer] as const),
    );
    const selectedEvidenceIds = [
      ...unit.sourceEvidence.map((item) => item.evidenceId),
      ...unit.objectives.flatMap((objective) => objective.evidence.map((item) => item.evidenceId)),
    ];
    for (const evidenceId of selectedEvidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        diagnostics.push(
          `Curriculum detail region ${unit.regionId} selected unknown or foreign evidence: ${evidenceId}.`,
        );
        diagnosticCodes.push('unknown_evidence');
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
        diagnostics.push(
          `Curriculum detail region ${unit.regionId} does not represent source allocation ${sourceRegionId}.`,
        );
        diagnosticCodes.push('source_allocation_omitted');
      }
    }
    const allowedConceptIds = new Set(region.concepts.map((concept) => concept.id));
    for (const conceptId of unit.conceptIds) {
      if (!allowedConceptIds.has(conceptId)) {
        diagnostics.push(
          `Curriculum detail region ${unit.regionId} selected an unknown Concept: ${conceptId}.`,
        );
        diagnosticCodes.push('unknown_concept');
      }
    }
    const allowedCanonicalIds = new Set(region.canonicalConcepts.map((canonical) => canonical.id));
    for (const canonicalId of unit.canonicalConceptIds) {
      if (!allowedCanonicalIds.has(canonicalId)) {
        diagnostics.push(
          `Curriculum detail region ${unit.regionId} selected an unknown canonical Concept: ${canonicalId}.`,
        );
        diagnosticCodes.push('unknown_canonical_concept');
      }
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, 100),
    diagnosticCodes: diagnosticCodes.slice(0, 100),
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
    const envelope = input.regions.find(
      (region) => region.regionId === unit.regionId,
    )?.authorityEnvelope;
    if (!envelope) continue;
    for (const objective of unit.objectives) {
      if (objective.priority !== 'required') continue;
      const construct = detectFormalConstruct(`${objective.title} ${objective.description}`);
      if (
        isConstructSupported(construct, envelope) ||
        !envelope.narrowerClaim ||
        (envelope.tier !== 'formal_sufficient' && envelope.tier !== 'narrower_formal') ||
        envelope.supportedConstructs.length === 0
      )
        continue;
      const narrowerConstruct: FormalAssessmentConstruct = envelope.supportedConstructs.includes(
        'explain',
      )
        ? 'explain'
        : 'identify';
      const verb = narrowerConstruct === 'explain' ? 'Explain' : 'Identify';
      const claim = envelope.narrowerClaim.slice(0, 500);
      objective.title = `${verb} the source-supported claim: ${claim}`.slice(0, 300);
      objective.description =
        `${verb} only what the current source explicitly states: ${claim}`.slice(0, 1_000);
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
