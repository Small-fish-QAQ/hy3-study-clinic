import { describe, expect, it, vi } from 'vitest';
import {
  CurriculumDetailProposalPayloadSchema,
  type CourseMap,
  type CurriculumDetailProposalPayload,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import {
  analyzeCourseMapProposal,
  buildCourseMapProposalInput,
  buildCourseMapSourceAllocation,
} from './courseMap.js';
import {
  CurriculumDetailBatchPlanningError,
  assertCurriculumCapabilityRecoveryDetailOutputFeasible,
  assembleCurriculumDetailBatches,
  buildCourseMapDeterministicCoverage,
  minimumCurriculumDetailObjectiveCount,
  planCurriculumDetailBatches,
  validateCurriculumDetailPlan,
  validateCurriculumDetailCandidate,
} from './curriculumMaterialization.js';

function planningInput() {
  const fixture = createCourseMapFixture();
  const courseMap = analyzeCourseMapProposal(fixture.good, fixture).courseMap satisfies CourseMap;
  return {
    workspaceName: 'Course Map fixture',
    contract: {
      ...fixture.providerInput.contract,
    },
    courseMap,
    sourceAllocation: fixture.sourceAllocation,
    evidenceCatalog: fixture.evidenceCatalog,
    concepts: fixture.concepts,
    canonicalConcepts: fixture.canonicalConcepts,
  };
}

function recoveryPlanningFixture() {
  const fixture = createCourseMapFixture();
  const requirement = {
    capabilityRef: 'legacy-capability-1',
    title: 'Recognize the complete predecessor capability',
    description: 'Preserve the complete predecessor capability without lowering its priority.',
    originalProposition: 'Recognize the complete predecessor capability and its exact scope.',
    construct: 'identify' as const,
    priority: 'normal' as const,
    subjectClass: 'general' as const,
    scopeOrigin: 'anchored' as const,
    // E2 is deliberately outside the one-offer Course Map visibility sample,
    // but remains exact evidence in R1's server-owned source allocation.
    allowedEvidenceIds: [fixture.evidenceCatalog[1]!.id],
    allowedSourceAllocationRegionIds: [fixture.sourceAllocation.regions[0]!.id],
  };
  const providerInput = buildCourseMapProposalInput({
    workspaceName: 'Course Map recovery fixture',
    contract: fixture.providerInput.contract,
    sourceAllocation: fixture.sourceAllocation,
    concepts: fixture.concepts,
    canonicalConcepts: fixture.canonicalConcepts,
    capabilityRecoveryRequirements: [requirement],
    evidenceCatalog: fixture.evidenceCatalog,
  });
  const candidate = structuredClone(fixture.good);
  candidate.modules[0]!.regions[0]!.capabilityRequirementRefs = [requirement.capabilityRef];
  const courseMap = analyzeCourseMapProposal(candidate, {
    sourceAllocation: fixture.sourceAllocation,
    providerInput,
  }).courseMap;
  return {
    requirement,
    providerInput,
    planning: {
      workspaceName: 'Course Map recovery fixture',
      contract: fixture.providerInput.contract,
      courseMap,
      sourceAllocation: fixture.sourceAllocation,
      evidenceCatalog: fixture.evidenceCatalog,
      concepts: fixture.concepts,
      canonicalConcepts: fixture.canonicalConcepts,
      capabilityRecoveryRequirements: [requirement],
    },
  };
}

function recoveryEvidenceBoundaryPlanning(offersPerRequirement: number, heavyAuthority = false) {
  const fixture = createCourseMapFixture();
  const template = fixture.evidenceCatalog[0]!;
  const recoveryOffers = Array.from({ length: offersPerRequirement * 4 }, (_, index) => ({
    ...template,
    id: `recovery-boundary-evidence-${index + 1}`,
    bindingId: `recovery-boundary-binding-${index + 1}`,
  }));
  const evidenceCatalog = [...fixture.evidenceCatalog, ...recoveryOffers];
  const sourceAllocation = buildCourseMapSourceAllocation({
    workspaceId: fixture.workspaceId,
    sourceMap: fixture.sourceMap,
    blocks: fixture.blocks,
    evidenceCatalog,
    maxRegions: 6,
    maxEvidenceOffers: 12,
    maxEvidenceOffersPerRegion: 2,
  });
  const requirements = Array.from({ length: 4 }, (_, requirementIndex) => ({
    capabilityRef: `boundary-capability-${requirementIndex + 1}`,
    title: `Explain bounded recovery capability ${requirementIndex + 1}`,
    description: `Explain the complete source-bounded recovery capability ${requirementIndex + 1}.`,
    originalProposition: `Explain bounded recovery capability ${requirementIndex + 1}\nExplain the complete source-bounded recovery capability ${requirementIndex + 1}.`,
    construct: 'explain' as const,
    priority: 'required' as const,
    subjectClass: 'source_specific' as const,
    scopeOrigin: 'anchored' as const,
    allowedEvidenceIds: recoveryOffers
      .slice(requirementIndex * offersPerRequirement, (requirementIndex + 1) * offersPerRequirement)
      .map((offer) => offer.id),
    allowedSourceAllocationRegionIds: [sourceAllocation.regions[0]!.id],
  }));
  const providerInput = buildCourseMapProposalInput({
    workspaceName: 'Recovery evidence boundary',
    contract: fixture.providerInput.contract,
    sourceAllocation,
    concepts: fixture.concepts,
    canonicalConcepts: fixture.canonicalConcepts,
    capabilityRecoveryRequirements: requirements,
    evidenceCatalog,
  });
  const candidate = structuredClone(fixture.good);
  candidate.modules[0]!.regions[0]!.capabilityRequirementRefs = requirements.map(
    (requirement) => requirement.capabilityRef,
  );
  const courseMap = analyzeCourseMapProposal(candidate, {
    sourceAllocation,
    providerInput,
  }).courseMap;
  const authorityEnvelopesByEvidenceId = heavyAuthority
    ? new Map(
        recoveryOffers.map(
          (offer) =>
            [
              offer.id,
              {
                sourceRegionId: offer.id,
                sourceBlockIds: [offer.blockId],
                formalEvidenceIds: [offer.id],
                supportedConstructs: ['identify', 'explain'] as const,
                strongestSupportedConstruct: 'explain' as const,
                narrowerClaim: 'N'.repeat(500),
                tier: 'formal_sufficient' as const,
                rationale: 'R'.repeat(500),
              },
            ] as const,
        ),
      )
    : undefined;
  return {
    workspaceName: 'Recovery evidence boundary',
    contract: fixture.providerInput.contract,
    courseMap,
    sourceAllocation,
    evidenceCatalog,
    concepts: fixture.concepts,
    canonicalConcepts: fixture.canonicalConcepts,
    capabilityRecoveryRequirements: requirements,
    ...(authorityEnvelopesByEvidenceId ? { authorityEnvelopesByEvidenceId } : {}),
  };
}

function twoBatchPlanningInput() {
  const expanded = structuredClone(planningInput());
  const templates = expanded.courseMap.modules.flatMap((module) => module.regions);
  const module = expanded.courseMap.modules[0]!;
  expanded.courseMap.modules = [
    {
      ...module,
      regions: Array.from({ length: 80 }, (_, index) => {
        const template = templates[index % templates.length]!;
        return {
          ...template,
          id: `course_map_region_${(index + 100).toString(16).padStart(24, '0')}`,
          moduleId: module.id,
          index,
        };
      }),
    },
  ];
  expanded.courseMap.prerequisites = [];
  expanded.courseMap.synthesisGroups = [];
  return expanded;
}

function expandDetailObjectives(
  payload: CurriculumDetailProposalPayload,
  objectiveCount: number,
): CurriculumDetailProposalPayload {
  const expanded = structuredClone(payload);
  let assigned = expanded.units.length;
  for (const [unitIndex, unit] of expanded.units.entries()) {
    const template = unit.objectives[0]!;
    while (unit.objectives.length < 4 && assigned < objectiveCount) {
      const objectiveIndex = unit.objectives.length;
      unit.objectives.push({
        ...structuredClone(template),
        key: `budget-objective-${unitIndex + 1}-${objectiveIndex + 1}`,
        priority: 'optional',
      });
      assigned += 1;
    }
  }
  if (assigned !== objectiveCount) throw new Error('Objective fixture exceeds detail capacity.');
  return expanded;
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeHy3Provider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'curriculum-detail-test-key',
    model: 'curriculum-detail-test-model',
    timeoutMs,
    fetchImpl,
  });
}

function hangingFetch(): typeof fetch {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      }),
  ) as unknown as typeof fetch;
}

describe('bounded Curriculum detail materialization', () => {
  it('preserves exact Course Map region membership for every real LearningUnit', () => {
    const input = planningInput();
    const coverage = buildCourseMapDeterministicCoverage(
      input.courseMap,
      input.sourceAllocation,
      input.sourceAllocation.regions.flatMap((region) =>
        region.sourceBlockIds.map((id, index) => ({
          id,
          materialId: region.materialId,
          materialRevisionId: region.materialRevisionId,
          structuralUnitId: index === 0 ? `structural-${region.index}` : null,
        })),
      ) as never,
    );
    const firstRegion = input.courseMap.modules[0]!.regions[0]!;
    const firstMembership = coverage.get('course-map-unit-1')!;
    expect(firstMembership.sourceBlockIds).toEqual(
      firstRegion.sourceAllocationRegionIds.flatMap(
        (allocationId) =>
          input.sourceAllocation.regions.find((region) => region.id === allocationId)!
            .sourceBlockIds,
      ),
    );
    expect(firstMembership.structuralUnitIds).toEqual(['structural-0']);
  });

  it('plans deterministic one-batch detail materialization with exact request accounting', () => {
    const input = planningInput();
    const first = planCurriculumDetailBatches(input);
    const second = planCurriculumDetailBatches(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.requestBytes).toBeGreaterThan(0);
    expect(first[0]!.input.regions.map((region) => region.regionId)).toEqual(
      input.courseMap.modules.flatMap((module) => module.regions.map((region) => region.id)),
    );
  });

  it('uses at most two stable batches without overlaps or omissions', async () => {
    const input = twoBatchPlanningInput();
    const expectedRegionIds = input.courseMap.modules.flatMap((module) =>
      module.regions.map((region) => region.id),
    );
    const batches = planCurriculumDetailBatches(input);

    expect(batches).toHaveLength(2);
    expect(
      batches.flatMap((batch) => batch.input.regions.map((region) => region.regionId)),
    ).toEqual(expectedRegionIds);
    expect(new Set(expectedRegionIds)).toHaveLength(expectedRegionIds.length);

    const provider = new FakeProvider();
    const completed = await Promise.all(
      batches.map(async (batch) => ({
        input: batch.input,
        payload: await provider.proposeCurriculumDetails(batch.input),
      })),
    );
    expect(assembleCurriculumDetailBatches(input.courseMap, completed).regionCount).toBe(80);
    expect(() => assembleCurriculumDetailBatches(input.courseMap, completed.slice(0, 1))).toThrow(
      /omits one or more Course Map regions/u,
    );
    expect(() =>
      assembleCurriculumDetailBatches(input.courseMap, [completed[0]!, completed[0]!]),
    ).toThrow(/Duplicate Course Map detail region/u);
  });

  it('materializes and assembles every region without losing prerequisites', async () => {
    const input = planningInput();
    const provider = new FakeProvider();
    const batches = planCurriculumDetailBatches(input);
    const completed = [];
    for (const batch of batches) {
      const payload = await provider.proposeCurriculumDetails(batch.input);
      expect(CurriculumDetailProposalPayloadSchema.safeParse(payload).success).toBe(true);
      expect(validateCurriculumDetailCandidate(payload, batch.input).valid).toBe(true);
      completed.push({ input: batch.input, payload });
    }
    const assembled = assembleCurriculumDetailBatches(input.courseMap, completed);
    expect(assembled.regionCount).toBe(6);
    expect(assembled.prerequisiteCount).toBe(input.courseMap.prerequisites.length);
    expect(assembled.payload.nodes.filter((node) => node.kind === 'learning_unit')).toHaveLength(6);
    expect(assembled.payload.nodes.some((node) => node.prerequisiteUnitKeys.length > 0)).toBe(true);
  });

  it('emits nodes in the same order a sibling-index traversal produces', async () => {
    // The stored node array and a traversal by sibling `index` are two carriers
    // of order. Both derive from the Course Map's canonical order, so on this
    // path they agree rather than drifting apart.
    const input = planningInput();
    const provider = new FakeProvider();
    const completed = [];
    for (const batch of planCurriculumDetailBatches(input)) {
      completed.push({
        input: batch.input,
        payload: await provider.proposeCurriculumDetails(batch.input),
      });
    }
    const { payload } = assembleCurriculumDetailBatches(input.courseMap, completed);

    const childrenOf = (parentKey: string | null) =>
      payload.nodes
        .filter((node) => node.parentKey === parentKey)
        .slice()
        .sort((left, right) => left.index - right.index);
    const traversal: string[] = [];
    const walk = (parentKey: string | null): void => {
      for (const node of childrenOf(parentKey)) {
        traversal.push(node.key);
        walk(node.key);
      }
    };
    walk(null);

    expect(traversal.length).toBe(payload.nodes.length);
    expect(traversal.length).toBeGreaterThan(0);
    expect(traversal).toEqual(payload.nodes.map((node) => node.key));
    // Sibling indexes are contiguous from zero within every parent.
    for (const parentKey of [null, ...payload.nodes.map((node) => node.key)]) {
      const siblings = childrenOf(parentKey);
      expect(siblings.map((node) => node.index)).toEqual(siblings.map((_node, index) => index));
    }
  });

  it('rejects foreign batch snapshots and invalid prerequisite topology during assembly', async () => {
    const input = planningInput();
    const batch = planCurriculumDetailBatches(input)[0]!;
    const completed = {
      input: batch.input,
      payload: await new FakeProvider().proposeCurriculumDetails(batch.input),
    };
    const foreign = structuredClone(completed);
    foreign.input.sourceAllocationFingerprint =
      'course_map_source_allocation_ffffffffffffffffffffffffffffffffffffffff';
    expect(() => assembleCurriculumDetailBatches(input.courseMap, [foreign])).toThrow(
      /foreign Course Map snapshot/u,
    );

    const cycle = structuredClone(input.courseMap);
    const regionIds = cycle.modules.flatMap((module) => module.regions.map((region) => region.id));
    cycle.prerequisites.push({
      prerequisiteRegionId: regionIds.at(-1)!,
      dependentRegionId: regionIds[0]!,
    });
    expect(() => assembleCurriculumDetailBatches(cycle, [completed])).toThrow(
      /prerequisite topology is invalid/u,
    );

    const foreignRegionInput = structuredClone(batch.input);
    foreignRegionInput.regions[0]!.title = 'Foreign detail title';
    const foreignRegionPayload = await new FakeProvider().proposeCurriculumDetails(
      foreignRegionInput,
    );
    expect(() =>
      assembleCurriculumDetailBatches(input.courseMap, [
        { input: foreignRegionInput, payload: foreignRegionPayload },
      ]),
    ).toThrow(/batch region snapshot is foreign/u);
  });

  it('fails closed on omitted, foreign, and outside-allocation evidence', async () => {
    const input = planningInput();
    const batch = planCurriculumDetailBatches(input)[0]!;
    const payload = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const foreign = structuredClone(payload);
    foreign.units[0]!.sourceEvidence[0]!.evidenceId = 'E999';
    expect(validateCurriculumDetailCandidate(foreign, batch.input).valid).toBe(false);

    const omitted = structuredClone(payload);
    omitted.units.pop();
    expect(validateCurriculumDetailCandidate(omitted, batch.input).valid).toBe(false);

    const outsideAllocation = structuredClone(payload);
    outsideAllocation.units[0]!.sourceEvidence[0]!.evidenceId =
      batch.input.regions[1]!.evidence[0]!.evidenceId;
    expect(validateCurriculumDetailCandidate(outsideAllocation, batch.input).valid).toBe(false);

    const unknownConcept = structuredClone(payload);
    unknownConcept.units[0]!.conceptIds = ['concept_foreign'];
    expect(validateCurriculumDetailCandidate(unknownConcept, batch.input).valid).toBe(false);
  });

  it('gives the Fake provider one bounded semantic repair', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const validateCandidate = vi
      .fn()
      .mockReturnValueOnce({ valid: false, diagnostics: ['synthetic detail rejection'] })
      .mockReturnValueOnce({ valid: true, diagnostics: [] });
    const onRepairAttempt = vi.fn();

    await expect(
      new FakeProvider().proposeCurriculumDetails(batch.input, {
        validateCandidate,
        onRepairAttempt,
      }),
    ).resolves.toMatchObject({ courseMapId: batch.input.courseMapId });
    expect(validateCandidate).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('candidate');
  });

  it('rejects a fixed-bound overflow instead of launching an unbounded partition', () => {
    const input = planningInput();
    const expanded = structuredClone(input);
    expanded.courseMap.modules = Array.from({ length: 3 }, (_, moduleIndex) => ({
      ...expanded.courseMap.modules[0]!,
      id: `course_map_module_${(moduleIndex + 10).toString(16).padStart(24, '0')}`,
      index: moduleIndex,
      regions: Array.from({ length: 50 }, (_, regionIndex) => ({
        ...expanded.courseMap.modules[0]!.regions[0]!,
        id: `course_map_region_${(moduleIndex * 50 + regionIndex + 100).toString(16).padStart(24, '0')}`,
        index: regionIndex,
        sourceAllocationRegionIds: [expanded.sourceAllocation.regions[0]!.id],
      })),
    }));
    expect(() => planCurriculumDetailBatches(expanded)).toThrow(CurriculumDetailBatchPlanningError);
  });

  it('offers exact recovery evidence beyond Course Map visibility and assembles its alias', async () => {
    const { planning, providerInput, requirement } = recoveryPlanningFixture();
    expect(
      planning.sourceAllocation.regions[0]!.evidence.map((offer) => offer.evidenceId),
    ).not.toContain(requirement.allowedEvidenceIds[0]);
    expect(providerInput.capabilityRecovery?.evidenceOffers).toEqual([
      expect.objectContaining({
        recoveryEvidenceRef: 'CE1',
        sourceRegionRef: 'R1',
        text: planning.evidenceCatalog[1]!.quote,
      }),
    ]);
    expect(JSON.stringify(providerInput.capabilityRecovery)).not.toContain('evidenceId');
    const batch = planCurriculumDetailBatches(planning)[0]!;
    const region = batch.input.regions[0]!;
    expect(region.capabilityRequirements).toEqual([
      expect.objectContaining({
        capabilityRef: requirement.capabilityRef,
        subjectClass: requirement.subjectClass,
        scopeOrigin: requirement.scopeOrigin,
        allowedEvidenceIds: requirement.allowedEvidenceIds,
      }),
    ]);
    expect(region.evidence.map((offer) => offer.evidenceId)).toEqual(
      expect.arrayContaining(requirement.allowedEvidenceIds),
    );

    const payload = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const objective = payload.units[0]!.objectives[0]!;
    objective.capabilityRequirementRef = requirement.capabilityRef;
    objective.construct = requirement.construct;
    delete objective.priority;
    objective.evidence = [{ evidenceId: requirement.allowedEvidenceIds[0]! }];
    expect(validateCurriculumDetailCandidate(payload, batch.input)).toMatchObject({ valid: true });

    const assembled = assembleCurriculumDetailBatches(planning.courseMap, [
      { input: batch.input, payload },
    ]);
    expect(
      assembled.payload.nodes
        .filter((node) => node.kind === 'learning_unit')
        .flatMap((node) => node.objectives)
        .find((candidate) => candidate.capabilityRequirementRef === requirement.capabilityRef),
    ).toMatchObject({
      construct: requirement.construct,
      evidence: [{ evidenceId: requirement.allowedEvidenceIds[0] }],
    });
  });

  it('requires exact once-only mapping with frozen construct, priority, and evidence scope', async () => {
    const { planning, requirement } = recoveryPlanningFixture();
    const batch = planCurriculumDetailBatches(planning)[0]!;
    const valid = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const objective = valid.units[0]!.objectives[0]!;
    objective.capabilityRequirementRef = requirement.capabilityRef;
    objective.construct = requirement.construct;
    delete objective.priority;
    objective.evidence = [{ evidenceId: requirement.allowedEvidenceIds[0]! }];
    expect(validateCurriculumDetailCandidate(valid, batch.input).valid).toBe(true);

    const missing = structuredClone(valid);
    delete missing.units[0]!.objectives[0]!.capabilityRequirementRef;
    expect(validateCurriculumDetailCandidate(missing, batch.input).diagnosticCodes).toContain(
      'recovery_capability_missing',
    );

    const duplicate = structuredClone(valid);
    duplicate.units[0]!.objectives.push({
      ...structuredClone(duplicate.units[0]!.objectives[0]!),
      key: 'duplicate-capability-objective',
    });
    expect(validateCurriculumDetailCandidate(duplicate, batch.input)).toMatchObject({
      valid: false,
      diagnosticCodes: ['schema_custom'],
    });

    const changedConstruct = structuredClone(valid);
    changedConstruct.units[0]!.objectives[0]!.construct = 'explain';
    expect(
      validateCurriculumDetailCandidate(changedConstruct, batch.input).diagnosticCodes,
    ).toContain('recovery_capability_construct_changed');

    const changedSubjectClass = structuredClone(valid);
    changedSubjectClass.units[0]!.objectives[0]!.subjectClass = 'source_specific';
    expect(
      validateCurriculumDetailCandidate(changedSubjectClass, batch.input).diagnosticCodes,
    ).toContain('recovery_capability_subject_class_changed');

    const changedScopeOrigin = structuredClone(valid);
    changedScopeOrigin.units[0]!.objectives[0]!.scopeOrigin = 'supplemental';
    expect(
      validateCurriculumDetailCandidate(changedScopeOrigin, batch.input).diagnosticCodes,
    ).toContain('recovery_capability_scope_origin_changed');

    const changedPriority = structuredClone(valid);
    changedPriority.units[0]!.objectives[0]!.priority = 'optional';
    expect(
      validateCurriculumDetailCandidate(changedPriority, batch.input).diagnosticCodes,
    ).toContain('recovery_capability_priority_changed');

    const foreignEvidence = structuredClone(valid);
    foreignEvidence.units[0]!.objectives[0]!.evidence = [
      { evidenceId: batch.input.regions[0]!.evidence[0]!.evidenceId },
    ];
    expect(
      validateCurriculumDetailCandidate(foreignEvidence, batch.input).diagnosticCodes,
    ).toContain('recovery_capability_evidence_outside_scope');

    const unsolicited = structuredClone(
      await new FakeProvider().proposeCurriculumDetails(
        planCurriculumDetailBatches(planningInput())[0]!.input,
      ),
    );
    const ordinaryInput = planCurriculumDetailBatches(planningInput())[0]!.input;
    unsolicited.units[0]!.objectives[0]!.capabilityRequirementRef = 'foreign-capability';
    expect(validateCurriculumDetailCandidate(unsolicited, ordinaryInput).diagnosticCodes).toContain(
      'recovery_capability_unknown',
    );
  });

  it('fails detail planning on missing, foreign, or region-ineligible recovery scope', () => {
    const { planning, requirement } = recoveryPlanningFixture();

    const missing = structuredClone(planning);
    delete missing.courseMap.modules[0]!.regions[0]!.capabilityRequirementRefs;
    expect(() => planCurriculumDetailBatches(missing)).toThrow(/must be placed exactly once/u);

    const unsolicited = structuredClone(planningInput());
    unsolicited.courseMap.modules[0]!.regions[0]!.capabilityRequirementRefs = [
      requirement.capabilityRef,
    ];
    expect(() => planCurriculumDetailBatches(unsolicited)).toThrow(/unknown or unsolicited/u);

    const foreignEvidence = structuredClone(planning);
    foreignEvidence.capabilityRecoveryRequirements[0]!.allowedEvidenceIds = ['foreign-evidence'];
    expect(() => planCurriculumDetailBatches(foreignEvidence)).toThrow(
      /stale or foreign evidence/u,
    );

    const noRegionalEvidence = structuredClone(planning);
    noRegionalEvidence.capabilityRecoveryRequirements[0]!.allowedSourceAllocationRegionIds.push(
      noRegionalEvidence.sourceAllocation.regions[1]!.id,
    );
    noRegionalEvidence.capabilityRecoveryRequirements[0]!.allowedEvidenceIds = [
      noRegionalEvidence.evidenceCatalog[2]!.id,
    ];
    expect(() => planCurriculumDetailBatches(noRegionalEvidence)).toThrow(
      /no eligible exact evidence/u,
    );
  });

  it('fits four disjoint 29-offer recovery scopes inside the exact region boundary', () => {
    const planning = recoveryEvidenceBoundaryPlanning(29);
    const batches = planCurriculumDetailBatches(planning);
    const recoveryRegion = batches
      .flatMap((batch) => batch.input.regions)
      .find((region) => region.capabilityRequirements?.length === 4)!;

    expect(batches).toHaveLength(2);
    expect(recoveryRegion.evidence).toHaveLength(118);
    expect(new Set(recoveryRegion.evidence.map((offer) => offer.evidenceId))).toHaveLength(118);
  });

  it('admits exactly 48 recovery objectives and rejects 49 by static output lower bound', () => {
    const { requirement } = recoveryPlanningFixture();
    const requirements = Array.from({ length: 49 }, (_, index) => ({
      ...requirement,
      capabilityRef: `static-output-capability-${index + 1}`,
      allowedSourceAllocationRegionIds: [`eligible-region-${Math.floor(index / 4) + 1}`],
    }));

    expect(() =>
      assertCurriculumCapabilityRecoveryDetailOutputFeasible(requirements.slice(0, 48)),
    ).not.toThrow();
    expect(() => assertCurriculumCapabilityRecoveryDetailOutputFeasible(requirements)).toThrow(
      /at most 48/u,
    );
  });

  it('rejects 48 capabilities forced into 48 distinct regions before Course Map work', () => {
    const { requirement } = recoveryPlanningFixture();
    const requirements = Array.from({ length: 48 }, (_, index) => ({
      ...requirement,
      capabilityRef: `forced-distinct-capability-${index + 1}`,
      allowedSourceAllocationRegionIds: [`forced-distinct-region-${index + 1}`],
    }));

    expect(() => assertCurriculumCapabilityRecoveryDetailOutputFeasible(requirements)).toThrow(
      /at least 48 distinct eligible regions/u,
    );
  });

  it('rejects forced exact-offer and request lower bounds before Course Map work', () => {
    for (const planning of [
      recoveryEvidenceBoundaryPlanning(30),
      recoveryEvidenceBoundaryPlanning(29, true),
    ]) {
      expect(() =>
        assertCurriculumCapabilityRecoveryDetailOutputFeasible(
          planning.capabilityRecoveryRequirements,
          {
            workspaceName: planning.workspaceName,
            contract: planning.contract,
            sourceAllocation: planning.sourceAllocation,
            evidenceCatalog: planning.evidenceCatalog,
            authorityEnvelopesByEvidenceId: planning.authorityEnvelopesByEvidenceId,
          },
        ),
      ).toThrow(CurriculumDetailBatchPlanningError);
    }
  });

  it('accepts 192 assembled objectives and rejects the 193rd during detail validation', async () => {
    const input = twoBatchPlanningInput();
    const batches = planCurriculumDetailBatches(input);
    const provider = new FakeProvider();
    const firstInput = {
      ...batches[0]!.input,
      limits: { ...batches[0]!.input.limits, maxObjectivesTotal: 162 },
    };
    const secondInput = {
      ...batches[1]!.input,
      limits: { ...batches[1]!.input.limits, maxObjectivesTotal: 92 },
    };
    const first = expandDetailObjectives(await provider.proposeCurriculumDetails(firstInput), 100);
    const secondAtLimit = expandDetailObjectives(
      await provider.proposeCurriculumDetails(secondInput),
      92,
    );
    const secondOverLimit = expandDetailObjectives(
      await provider.proposeCurriculumDetails(secondInput),
      93,
    );

    expect(validateCurriculumDetailCandidate(first, firstInput).valid).toBe(true);
    expect(validateCurriculumDetailCandidate(secondAtLimit, secondInput).valid).toBe(true);
    expect(validateCurriculumDetailCandidate(secondOverLimit, secondInput)).toMatchObject({
      valid: false,
      diagnosticCodes: ['curriculum_detail_objective_authority_semantic_budget_exceeded'],
    });
    expect(() =>
      assembleCurriculumDetailBatches(input.courseMap, [
        { input: firstInput, payload: first },
        { input: secondInput, payload: secondAtLimit },
      ]),
    ).not.toThrow();
    expect(() =>
      assembleCurriculumDetailBatches(input.courseMap, [
        { input: firstInput, payload: first },
        { input: secondInput, payload: secondOverLimit },
      ]),
    ).toThrow(/193 objectives/u);
  });

  it('reserves a non-coincident required apply objective beside packed recovery capabilities', () => {
    const { requirement } = recoveryPlanningFixture();
    const planning = recoveryPlanningFixture().planning;
    const [batch] = planCurriculumDetailBatches(planning);
    const baseRegion = batch!.input.regions[0]!;
    const applyEvidence = {
      ...baseRegion.evidence[0]!,
      authorityEnvelope: {
        sourceRegionId: baseRegion.evidence[0]!.evidenceId,
        sourceBlockIds: ['block-1'],
        formalEvidenceIds: [baseRegion.evidence[0]!.evidenceId],
        supportedConstructs: ['identify', 'explain', 'apply'] as const,
        strongestSupportedConstruct: 'apply' as const,
        narrowerClaim: baseRegion.evidence[0]!.text,
        tier: 'narrower_formal' as const,
        rationale: 'The exact selected evidence supports one bounded application procedure.',
      },
    };
    const nonApplyRequirements = Array.from({ length: 3 }, (_, capabilityIndex) => ({
      ...requirement,
      capabilityRef: `future-capability-${capabilityIndex + 1}`,
      construct: 'identify' as const,
      priority: 'normal' as const,
      allowedEvidenceIds: [applyEvidence.evidenceId],
    }));
    const packedApplyRegion = {
      ...baseRegion,
      evidence: [applyEvidence],
      capabilityRequirements: nonApplyRequirements,
    };
    const applicationTarget = 'Apply the source-stated procedure in a bounded decision.';

    expect(minimumCurriculumDetailObjectiveCount([packedApplyRegion], applicationTarget)).toBe(4);
    expect(
      minimumCurriculumDetailObjectiveCount(
        [
          {
            ...packedApplyRegion,
            capabilityRequirements: [
              ...nonApplyRequirements.slice(0, 2),
              {
                ...requirement,
                capabilityRef: 'future-required-apply',
                construct: 'apply' as const,
                priority: 'required' as const,
                allowedEvidenceIds: [applyEvidence.evidenceId],
              },
            ],
          },
        ],
        applicationTarget,
      ),
    ).toBe(3);
    expect(
      minimumCurriculumDetailObjectiveCount(
        [{ ...packedApplyRegion, capabilityRequirements: [] }],
        applicationTarget,
      ),
    ).toBe(1);
    expect(() =>
      minimumCurriculumDetailObjectiveCount(
        [
          {
            ...packedApplyRegion,
            capabilityRequirements: Array.from({ length: 4 }, (_, capabilityIndex) => ({
              ...requirement,
              capabilityRef: `full-non-apply-capability-${capabilityIndex + 1}`,
              construct: 'identify' as const,
              priority: 'normal' as const,
              allowedEvidenceIds: [applyEvidence.evidenceId],
            })),
          },
        ],
        applicationTarget,
      ),
    ).toThrow(/filled by four non-coincident recovery capabilities/u);

    const invalidInput = {
      ...batch!.input,
      contract: {
        ...batch!.input.contract,
        targetOutcome: {
          ...batch!.input.contract.targetOutcome,
          description: applicationTarget,
        },
      },
      regions: [packedApplyRegion],
      limits: { ...batch!.input.limits, maxObjectivesTotal: 3 },
    };
    const candidate = {
      courseMapId: invalidInput.courseMapId,
      sourceAllocationFingerprint: invalidInput.sourceAllocationFingerprint,
      units: [
        {
          regionId: packedApplyRegion.regionId,
          title: packedApplyRegion.title,
          sourceEvidence: [{ evidenceId: applyEvidence.evidenceId }],
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: nonApplyRequirements.map((capability, index) => ({
            key: `minimum-budget-objective-${index + 1}`,
            title: capability.title,
            description: capability.description,
            subjectClass: capability.subjectClass ?? ('source_specific' as const),
            scopeOrigin: capability.scopeOrigin ?? ('anchored' as const),
            construct: capability.construct,
            priority: capability.priority,
            evidence: [{ evidenceId: applyEvidence.evidenceId }],
            capabilityRequirementRef: capability.capabilityRef,
          })),
        },
      ],
    };

    expect(validateCurriculumDetailCandidate(candidate, invalidInput)).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining([
        'curriculum_detail_objective_budget_invalid',
        'required_target_apply_missing',
      ]),
    });
  });

  it('rejects recovery offer and exact request-byte overflow before detail-provider work', () => {
    const offerOverflow = validateCurriculumDetailPlan(recoveryEvidenceBoundaryPlanning(30));
    expect(offerOverflow).toMatchObject({
      valid: false,
      diagnosticCodes: ['recovery_capability_detail_evidence_budget_exceeded'],
    });

    const byteOverflow = validateCurriculumDetailPlan(recoveryEvidenceBoundaryPlanning(29, true));
    expect(byteOverflow.valid).toBe(false);
    expect(byteOverflow.diagnosticCodes).toContain('recovery_capability_detail_budget_exceeded');
    expect(byteOverflow.diagnostics.join(' ')).toContain('requestBytes=');
  });
});

describe('Curriculum detail Hy3 provider contract', () => {
  it('accepts valid detail output and repairs one semantic failure', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const valid = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const foreign = {
      ...valid,
      courseMapId: 'course_map_ffffffffffffffffffffffff',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(foreign)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(valid))) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    const payload = await makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, {
      validateCandidate: (candidate) => validateCurriculumDetailCandidate(candidate, batch.input),
      onRepairAttempt,
    });

    expect(payload).toEqual(valid);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith(
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
    );
    const firstRequest = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body),
    ) as { max_tokens: number; messages: Array<{ content: string }> };
    expect(firstRequest.max_tokens).toBe(16_000);
    expect(JSON.stringify(firstRequest.messages)).toContain(batch.input.regions[0]!.regionId);
  });

  it('rejects a changed frozen recovery proposition through the bounded provider retry', async () => {
    const { planning, requirement } = recoveryPlanningFixture();
    const batch = planCurriculumDetailBatches(planning)[0]!;
    const changed = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const recoveryObjective = changed.units
      .flatMap((unit) => unit.objectives)
      .find((objective) => objective.capabilityRequirementRef === requirement.capabilityRef)!;
    recoveryObjective.title = 'A provider-rewritten recovery objective';
    recoveryObjective.description = 'The provider changed the frozen predecessor capability.';
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(changed)),
    ) as unknown as typeof fetch;

    await expect(
      makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, {
        validateCandidate: (candidate) => validateCurriculumDetailCandidate(candidate, batch.input),
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'recovery_capability_proposition_changed' }),
          ]),
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps one independent candidate repair after a schema repair', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const valid = await new FakeProvider().proposeCurriculumDetails(batch.input);
    const foreign = {
      ...valid,
      courseMapId: 'course_map_ffffffffffffffffffffffff',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('not json'))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(foreign)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(valid))) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    const payload = await makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, {
      validateCandidate: (candidate) => validateCurriculumDetailCandidate(candidate, batch.input),
      onRepairAttempt,
    });

    expect(payload).toEqual(valid);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRepairAttempt.mock.calls).toEqual([
      ['schema', 'PROVIDER_FORMAT_INCOMPATIBILITY'],
      ['candidate', 'SEMANTIC_VALIDATION_FAILURE'],
    ]);
  });

  it('fails after one malformed-output repair', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const fetchImpl = vi.fn(async () => jsonResponse('not json')) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    await expect(
      makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, { onRepairAttempt }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: { validationKind: 'schema' },
      technicalFailureCode: 'REPAIR_EXHAUSTED:PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith(
      'schema',
      'PROVIDER_FORMAT_INCOMPATIBILITY',
    );
  });

  it('preserves provider objective wording after a schema retry at the authority boundary', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const candidate = await new FakeProvider().proposeCurriculumDetails(batch.input);
    candidate.units[0]!.title = 'Alpha material source boundary';
    const objective = candidate.units[0]!.objectives[0]!;
    objective.priority = 'required';
    objective.construct = 'apply';
    objective.title = 'Apply the source in production';
    objective.description = 'Apply a broader procedure than the evidence supports.';
    const selectedEvidenceId = objective.evidence[0]!.evidenceId;
    const selectedOffer = batch.input.regions[0]!.evidence.find(
      (offer) => offer.evidenceId === selectedEvidenceId,
    )!;
    selectedOffer.authorityEnvelope = {
      sourceRegionId: selectedEvidenceId,
      sourceBlockIds: ['block-1'],
      formalEvidenceIds: [selectedEvidenceId],
      supportedConstructs: ['identify', 'explain', 'apply'],
      strongestSupportedConstruct: 'apply',
      narrowerClaim: selectedOffer.text,
      tier: 'narrower_formal',
      rationale: 'The exact selected evidence supports the bounded application procedure.',
    };
    const originalObjective = structuredClone(objective);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('not json'))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(candidate))) as unknown as typeof fetch;

    const payload = await makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, {
      validateCandidate: (value) => validateCurriculumDetailCandidate(value, batch.input),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(payload.units[0]!.objectives[0]).toMatchObject({
      construct: 'apply',
      priority: 'required',
      evidence: [{ evidenceId: selectedEvidenceId }],
    });
    expect(payload.units[0]!.objectives[0]).toEqual(originalObjective);
    expect(payload.units[0]!.objectives[0]).toMatchObject({
      title: 'Apply the source in production',
      description: 'Apply a broader procedure than the evidence supports.',
    });
    expect(validateCurriculumDetailCandidate(payload, batch.input).valid).toBe(true);
  });

  it('preserves exact candidate diagnostics in a bounded safe failure artifact', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const candidate = await new FakeProvider().proposeCurriculumDetails(batch.input);
    candidate.units[0]!.title = 'Unsupported provider claim boundary';
    const objective = candidate.units[0]!.objectives[0]!;
    const selectedEvidenceId = objective.evidence[0]!.evidenceId;
    const selectedOffer = batch.input.regions[0]!.evidence.find(
      (offer) => offer.evidenceId === selectedEvidenceId,
    )!;
    const boundedNarrowerClaim = 'Only identify the exact source-supported boundary.';
    objective.priority = 'required';
    objective.construct = 'apply';
    objective.title = 'Apply an unsupported private provider claim';
    objective.description = 'PRIVATE_REPAIRED_PROVIDER_RESPONSE_TEXT';
    selectedOffer.authorityEnvelope = {
      sourceRegionId: selectedEvidenceId,
      sourceBlockIds: ['block-1'],
      formalEvidenceIds: [],
      supportedConstructs: [],
      strongestSupportedConstruct: null,
      narrowerClaim: boundedNarrowerClaim,
      tier: 'unavailable',
      rationale: 'The selected offer cannot support a formal objective.',
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(candidate)),
    ) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await makeHy3Provider(fetchImpl).proposeCurriculumDetails(batch.input, {
        validateCandidate: (value) => validateCurriculumDetailCandidate(value, batch.input),
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(thrown).toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          kind: 'curriculum_detail_candidate_validation_failed',
          context: {
            courseMapId: batch.input.courseMapId,
            batchKey: batch.input.batchKey,
          },
          diagnostics: [
            {
              code: 'required_objective_formal_authority_missing',
              facts: {
                courseMapRegionId: batch.input.regions[0]!.regionId,
                objectiveKey: objective.key,
                claimedConstruct: 'apply',
                protectedPriority: 'required',
                selectedEvidenceIds: [selectedEvidenceId],
                selectedEvidenceAuthority: [
                  {
                    evidenceId: selectedEvidenceId,
                    sourceAllocationRegionId: selectedOffer.sourceAllocationRegionId,
                    available: true,
                    authorityTier: 'unavailable',
                    supportedConstructs: [],
                    strongestSupportedConstruct: null,
                    formalEvidenceCount: 0,
                    narrowerClaim: boundedNarrowerClaim,
                  },
                ],
                repairAuthorityTier: 'unavailable',
                repairSupportedConstructs: [],
                repairNarrowerClaim: boundedNarrowerClaim,
              },
            },
          ],
        },
      },
    });
    const serialized = JSON.stringify(thrown);
    expect(serialized).toContain(boundedNarrowerClaim);
    expect(serialized).not.toContain('PRIVATE_REPAIRED_PROVIDER_RESPONSE_TEXT');
    expect(serialized).not.toContain('curriculum-detail-test-key');
    expect(serialized.length).toBeLessThan(16_000);
  });

  it('does not retry a timed-out detail request and supports cancellation', async () => {
    const batch = planCurriculumDetailBatches(planningInput())[0]!;
    const timeoutFetch = hangingFetch();
    await expect(
      makeHy3Provider(timeoutFetch, 20).proposeCurriculumDetails(batch.input),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const cancellationFetch = hangingFetch();
    const pending = makeHy3Provider(cancellationFetch).proposeCurriculumDetails(batch.input, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(cancellationFetch).toHaveBeenCalledTimes(1);
  });
});
