import { describe, expect, it, vi } from 'vitest';
import { CurriculumDetailProposalPayloadSchema, type CourseMap } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { analyzeCourseMapProposal } from './courseMap.js';
import {
  CurriculumDetailBatchPlanningError,
  assembleCurriculumDetailBatches,
  buildCourseMapDeterministicCoverage,
  planCurriculumDetailBatches,
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
