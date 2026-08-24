import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CourseMapSourceAllocation } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { ProviderUsage } from '../llm/provider.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { generateCourseMapPrototype, repairOmittedCourseMapCoverage } from './courseMap.js';

function jsonResponse(content: string, usage?: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeHy3Provider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'course-map-test-key',
    model: 'course-map-test-model',
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

function semanticScatteringFixture() {
  const fixture = createCourseMapFixture();
  const sourceAllocation = structuredClone(fixture.sourceAllocation);
  sourceAllocation.regions[0]!.title = 'Permissions model';
  sourceAllocation.regions[1]!.title = 'Permissions boundaries';
  const { fingerprint: _oldFingerprint, ...withoutFingerprint } = sourceAllocation;
  sourceAllocation.fingerprint = `course_map_source_allocation_${createHash('sha256')
    .update(JSON.stringify(withoutFingerprint))
    .digest('hex')
    .slice(0, 40)}` as CourseMapSourceAllocation['fingerprint'];
  const providerInput = structuredClone(fixture.providerInput);
  providerInput.sourceAllocationFingerprint = sourceAllocation.fingerprint;
  providerInput.sourceRegions[0]!.title = sourceAllocation.regions[0]!.title;
  providerInput.sourceRegions[1]!.title = sourceAllocation.regions[1]!.title;
  const scattered = structuredClone(fixture.good);
  scattered.modules = [
    {
      title: 'Permissions foundations',
      learningIntent: 'Establish the permissions model.',
      regions: [scattered.modules[0]!.regions[0]!],
    },
    {
      title: 'Permissions operations',
      learningIntent: 'Apply permission boundaries in later operations.',
      regions: [...scattered.modules[0]!.regions.slice(1), ...scattered.modules[1]!.regions],
    },
  ];
  scattered.modules[0]!.regions[0]!.title = 'Permissions model';
  scattered.modules[1]!.regions[0]!.title = 'Permissions boundaries';
  scattered.synthesisGroups = [];
  const repaired = structuredClone(fixture.good);
  repaired.modules[0]!.regions[0]!.title = 'Permissions model';
  repaired.modules[0]!.regions[1]!.title = 'Permissions boundaries';
  return { fixture, sourceAllocation, providerInput, scattered, repaired };
}

describe('Course Map Fake provider prototype', () => {
  it('produces a valid deterministic hierarchical map without repair', async () => {
    const fixture = createCourseMapFixture();
    const provider = new FakeProvider();

    const first = await generateCourseMapPrototype({
      provider,
      providerInput: fixture.providerInput,
      sourceAllocation: fixture.sourceAllocation,
    });
    const second = await generateCourseMapPrototype({
      provider,
      providerInput: fixture.providerInput,
      sourceAllocation: fixture.sourceAllocation,
    });

    expect(first).toEqual(second);
    expect(first.repairAttempted).toBe(false);
    expect(first.analysis.validation.valid).toBe(true);
    expect(first.analysis.qualityProfile.hierarchy).toMatchObject({
      moduleCount: 2,
      regionCount: 6,
    });
  });

  it('uses exactly one candidate repair and fails closed when repair remains invalid', async () => {
    const fixture = createCourseMapFixture();
    const repaired = vi
      .fn()
      .mockReturnValueOnce({
        valid: false,
        diagnostics: ['synthetic candidate rejection'],
      })
      .mockReturnValue({ valid: true, diagnostics: [] });
    const onRepairAttempt = vi.fn();

    const result = await generateCourseMapPrototype(
      {
        provider: new FakeProvider(),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      { validateCandidate: repaired, onRepairAttempt },
    );

    expect(result.repairAttempted).toBe(true);
    expect(repaired).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('candidate');

    const alwaysInvalid = vi.fn(() => ({
      valid: false,
      diagnostics: ['repair is still invalid'],
    }));
    await expect(
      generateCourseMapPrototype(
        {
          provider: new FakeProvider(),
          providerInput: fixture.providerInput,
          sourceAllocation: fixture.sourceAllocation,
        },
        { validateCandidate: alwaysInvalid },
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: { validationKind: 'candidate' },
    });
    expect(alwaysInvalid).toHaveBeenCalledTimes(2);
  });

  it('fails the Course Map candidate before detail work when exact downstream planning is impossible', async () => {
    const fixture = createCourseMapFixture();
    const validateAnalysis = vi.fn(() => ({
      valid: false,
      diagnostics: ['Recovery detail request exceeds its exact byte budget.'],
      diagnosticCodes: ['recovery_capability_detail_budget_exceeded'],
      failureArtifact: {
        kind: 'curriculum_detail_plan_invalid',
        context: {},
        diagnostics: [
          {
            code: 'recovery_capability_detail_budget_exceeded',
            message: 'Recovery detail request exceeds its exact byte budget.',
          },
        ],
      },
    }));
    const onRepairAttempt = vi.fn();

    await expect(
      generateCourseMapPrototype(
        {
          provider: new FakeProvider(),
          providerInput: fixture.providerInput,
          sourceAllocation: fixture.sourceAllocation,
          validateAnalysis,
        },
        { onRepairAttempt },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(validateAnalysis).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('candidate');
  });

  it('honors a zero prerequisite-degree bound', async () => {
    const fixture = createCourseMapFixture();
    const providerInput = {
      ...fixture.providerInput,
      limits: { ...fixture.providerInput.limits, maxPrerequisiteDegree: 0 },
    };
    const result = await generateCourseMapPrototype({
      provider: new FakeProvider(),
      providerInput,
      sourceAllocation: fixture.sourceAllocation,
    });

    expect(result.analysis.courseMap.prerequisites).toEqual([]);
    expect(result.analysis.validation.valid).toBe(true);
  });

  it('rejects stale local context before making a provider request', async () => {
    const fixture = createCourseMapFixture();
    const tamperedAllocation = structuredClone(fixture.sourceAllocation);
    tamperedAllocation.regions[0]!.title = 'Stale allocation title';
    const provider = new FakeProvider();
    const proposeCourseMap = vi.spyOn(provider, 'proposeCourseMap');

    await expect(
      generateCourseMapPrototype({
        provider,
        providerInput: fixture.providerInput,
        sourceAllocation: tamperedAllocation,
      }),
    ).rejects.toThrow(/fingerprint is stale or mismatched/u);
    expect(proposeCourseMap).not.toHaveBeenCalled();
  });

  it('recovers omitted unclassified regions during the one bounded repair', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.sparse)))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify(fixture.sparse)),
      ) as unknown as typeof fetch;

    const result = await generateCourseMapPrototype({
      provider: makeHy3Provider(fetchImpl),
      providerInput: fixture.providerInput,
      sourceAllocation: fixture.sourceAllocation,
    });

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.validation.valid).toBe(true);
    expect(result.analysis.courseMap.modules.flatMap((module) => module.regions)).toHaveLength(6);
    expect(result.analysis.courseMap.sourceDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceAllocationRegionId: fixture.sourceAllocation.regions[1]!.id,
          disposition: 'represented_directly',
        }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairPrompt = repairBody.messages.at(-1)!.content;
    expect(repairPrompt).toContain('R2');
    expect(repairPrompt).not.toContain(fixture.sourceAllocation.regions[1]!.id);
    expect(repairPrompt).not.toContain(fixture.sourceAllocation.fingerprint);
  });

  it('preserves explicit dispositions while repairing other omitted regions', () => {
    const fixture = createCourseMapFixture();
    const candidate = structuredClone(fixture.sparse);
    candidate.sourceDispositions = [
      {
        sourceRegionRef: 'R2',
        disposition: 'duplicate/redundant',
        rationale: 'Duplicate coverage is already present in the adjacent region.',
        representedRegionRefs: ['R1'],
      },
    ];

    expect(
      repairOmittedCourseMapCoverage(candidate, fixture.providerInput, fixture.sourceAllocation),
    ).toBe(true);
    expect(candidate.sourceDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRegionRef: 'R2',
          disposition: 'duplicate/redundant',
        }),
      ]),
    );
    expect(
      candidate.modules.flatMap((module) => module.regions).map((region) => region.sourceRegionRef),
    ).toEqual(expect.arrayContaining(['R1', 'R3', 'R4', 'R5', 'R6']));
    expect(
      candidate.modules.flatMap((module) => module.regions).map((region) => region.sourceRegionRef),
    ).not.toContain('R2');
  });

  it('fails closed when every omitted region is an unresolved candidate gap', async () => {
    const fixture = createCourseMapFixture();
    const candidate = structuredClone(fixture.sparse);
    candidate.sourceDispositions = ['R2', 'R3', 'R5', 'R6'].map((sourceRegionRef) => ({
      sourceRegionRef,
      disposition: 'unresolved_candidate_gap' as const,
      rationale: 'The candidate could not safely represent this meaningful region.',
      representedRegionRefs: [],
    }));
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(candidate)),
    ) as unknown as typeof fetch;

    await expect(
      generateCourseMapPrototype({
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: { validationKind: 'candidate' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Course Map Hy3 provider contract', () => {
  it('accepts one valid response and preserves physical-attempt callbacks', async () => {
    const fixture = createCourseMapFixture();
    const usage = { prompt_tokens: 41, completion_tokens: 19 };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens?: number;
        messages: Array<{ content: string }>;
      };
      expect(body.max_tokens).toBe(8_000);
      expect(JSON.stringify(body.messages)).not.toContain('block_1_1');
      return jsonResponse(JSON.stringify(fixture.good), usage);
    }) as unknown as typeof fetch;
    const onRequestSent = vi.fn();
    const onUsage = vi.fn<(usage: ProviderUsage) => void>();
    const onRepairAttempt = vi.fn();

    const result = await generateCourseMapPrototype(
      {
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      {
        onRequestSent,
        onUsage,
        onRepairAttempt,
        telemetry: {
          workspaceId: fixture.workspaceId,
          operationType: 'generate_course_map_prototype',
        },
      },
    );

    expect(result.repairAttempted).toBe(false);
    expect(result.analysis.validation.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRequestSent).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 41, outputTokens: 19 }),
    );
    expect(onRepairAttempt).not.toHaveBeenCalled();
  });

  it('fails after one bounded repair for malformed schema output', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"sourceAllocationFingerprint":"not-a-fingerprint","modules":[]}'),
    ) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    await expect(
      generateCourseMapPrototype(
        {
          provider: makeHy3Provider(fetchImpl),
          providerInput: fixture.providerInput,
          sourceAllocation: fixture.sourceAllocation,
        },
        { onRepairAttempt },
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: { validationKind: 'schema' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('schema', 'SCHEMA_VALIDATION_FAILURE');
  });

  it('repairs one malformed original into a valid compact Course Map', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('{"modules":[],"prerequisites":[],"synthesisGroups":[]}'))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.good))) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    const result = await generateCourseMapPrototype(
      {
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      { onRepairAttempt },
    );

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.validation.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('schema', 'SCHEMA_VALIDATION_FAILURE');
  });

  it('repairs one schema-valid semantic failure using local diagnostics', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.cycle)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.good))) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    const result = await generateCourseMapPrototype(
      {
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      { onRepairAttempt },
    );

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.validation.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith(
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
    );
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    expect(repairBody.messages.at(-1)!.content).toContain('prerequisite_cycle');
  });

  it('keeps private Course Map allocation identities out of a REAL-shaped recovery retry', async () => {
    const fixture = createCourseMapFixture();
    const sourceAllocation = structuredClone(fixture.sourceAllocation);
    const privateAllocationId = `course_map_source_region_${'f'.repeat(24)}` as const;
    sourceAllocation.regions[0]!.id = privateAllocationId;
    const { fingerprint: _oldFingerprint, ...withoutFingerprint } = sourceAllocation;
    sourceAllocation.fingerprint = `course_map_source_allocation_${createHash('sha256')
      .update(JSON.stringify(withoutFingerprint))
      .digest('hex')
      .slice(0, 40)}` as CourseMapSourceAllocation['fingerprint'];
    const providerInput = structuredClone(fixture.providerInput);
    providerInput.sourceAllocationFingerprint = sourceAllocation.fingerprint;
    providerInput.sourceRegions[0]!.sourceAllocationRegionId = privateAllocationId;
    const capabilityRef = 'recovery-capability-private-boundary';
    providerInput.capabilityRecovery = {
      evidenceOffers: [
        {
          recoveryEvidenceRef: 'CE1',
          sourceRegionRef: 'R1',
          text: providerInput.sourceRegions[0]!.evidence[0]!.text,
        },
      ],
      requirements: [
        {
          capabilityRef,
          title: 'Explain the preserved predecessor capability',
          description: 'Explain the complete source-bounded predecessor capability.',
          originalProposition:
            'Explain the preserved predecessor capability\nExplain the complete source-bounded predecessor capability.',
          construct: 'explain',
          priority: 'required',
          allowedSourceRegionRefs: ['R1'],
          allowedRecoveryEvidenceRefs: ['CE1'],
        },
      ],
    };
    const repaired = structuredClone(fixture.good);
    repaired.modules[0]!.regions[0]!.capabilityRequirementRefs = [capabilityRef];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.sparse)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await generateCourseMapPrototype({
      provider: makeHy3Provider(fetchImpl),
      providerInput,
      sourceAllocation,
    });

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.validation.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairPrompt = repairBody.messages.at(-1)!.content;
    expect(repairPrompt).toContain('R1');
    expect(repairPrompt).toContain(capabilityRef);
    expect(repairPrompt).not.toContain(privateAllocationId);
    expect(repairPrompt).not.toContain(sourceAllocation.fingerprint);
    for (const region of sourceAllocation.regions) {
      expect(repairPrompt).not.toContain(region.id);
    }
  });

  it('repairs exact cross-module semantic scattering once using module and source identities', async () => {
    const { fixture, sourceAllocation, providerInput, scattered, repaired } =
      semanticScatteringFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(scattered)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await generateCourseMapPrototype({
      provider: makeHy3Provider(fetchImpl),
      providerInput,
      sourceAllocation,
    });

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.validation.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairPrompt = repairBody.messages.at(-1)!.content;
    expect(repairPrompt).toContain('semantic_topic_scattering');
    expect(repairPrompt).toContain('module-1 (Permissions foundations)');
    expect(repairPrompt).toContain('module-2 (Permissions operations)');
    expect(repairPrompt).toContain('R1');
    expect(repairPrompt).toContain('R2');
    expect(repairPrompt).not.toContain(sourceAllocation.regions[0]!.id);
    expect(repairPrompt).not.toContain(sourceAllocation.regions[1]!.id);
    expect(repairPrompt).not.toContain(sourceAllocation.fingerprint);
    expect(result.analysis.courseMap.modules[0]!.regions.map((region) => region.title)).toEqual(
      expect.arrayContaining(['Permissions model', 'Permissions boundaries']),
    );
    expect(result.analysis.sourceAllocation.workspaceId).toBe(fixture.workspaceId);
  });

  it('repairs copied numbered source headings into learner-visible region identities', async () => {
    const fixture = createCourseMapFixture();
    const sourceAllocation = structuredClone(fixture.sourceAllocation);
    sourceAllocation.regions[0]!.title = '1. Parser source heading';
    const { fingerprint: _oldFingerprint, ...withoutFingerprint } = sourceAllocation;
    sourceAllocation.fingerprint = `course_map_source_allocation_${createHash('sha256')
      .update(JSON.stringify(withoutFingerprint))
      .digest('hex')
      .slice(0, 40)}` as CourseMapSourceAllocation['fingerprint'];
    const providerInput = structuredClone(fixture.providerInput);
    providerInput.sourceAllocationFingerprint = sourceAllocation.fingerprint;
    providerInput.sourceRegions[0]!.title = sourceAllocation.regions[0]!.title;
    const copied = structuredClone(fixture.good);
    copied.modules[0]!.regions[0]!.title = '1. Parser source heading';
    const repaired = structuredClone(copied);
    repaired.modules[0]!.regions[0]!.title = 'Semantic foundations';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(copied)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await generateCourseMapPrototype({
      provider: makeHy3Provider(fetchImpl),
      providerInput,
      sourceAllocation,
    });

    expect(result.repairAttempted).toBe(true);
    expect(result.analysis.courseMap.modules[0]!.regions[0]!.title).toBe('Semantic foundations');
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairPrompt = repairBody.messages.at(-1)!.content;
    expect(repairPrompt).toContain('source_heading_title_dump');
    expect(repairPrompt).toContain('R1');
    expect(repairPrompt).toContain('1. Parser source heading');
  });

  it('fails closed when bounded semantic-scattering repair returns an equivalent map', async () => {
    const { sourceAllocation, providerInput, scattered } = semanticScatteringFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(scattered)),
    ) as unknown as typeof fetch;

    await expect(
      generateCourseMapPrototype({
        provider: makeHy3Provider(fetchImpl),
        providerInput,
        sourceAllocation,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          kind: 'course_map_candidate_validation_failed',
          context: {},
          diagnostics: [
            {
              code: 'semantic_topic_scattering',
              message: expect.any(String),
            },
          ],
        },
      },
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the semantic repair remains invalid', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(fixture.cycle)),
    ) as unknown as typeof fetch;

    await expect(
      generateCourseMapPrototype({
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        validationKind: 'candidate',
      },
      technicalFailureCode: 'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not blindly retry a timed-out physical request', async () => {
    const fixture = createCourseMapFixture();
    const fetchImpl = hangingFetch();
    const onRepairAttempt = vi.fn();

    await expect(
      generateCourseMapPrototype(
        {
          provider: makeHy3Provider(fetchImpl, 20),
          providerInput: fixture.providerInput,
          sourceAllocation: fixture.sourceAllocation,
        },
        { onRepairAttempt },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRepairAttempt).not.toHaveBeenCalled();
  });

  it('supports cancellation during generation and during the repair request', async () => {
    const fixture = createCourseMapFixture();
    const generationController = new AbortController();
    const generationFetch = hangingFetch();
    const generation = generateCourseMapPrototype(
      {
        provider: makeHy3Provider(generationFetch),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      { signal: generationController.signal },
    );
    generationController.abort();
    await expect(generation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(generationFetch).toHaveBeenCalledTimes(1);

    const repairController = new AbortController();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(fixture.cycle)))
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      ) as unknown as typeof fetch;
    const repair = generateCourseMapPrototype(
      {
        provider: makeHy3Provider(fetchImpl),
        providerInput: fixture.providerInput,
        sourceAllocation: fixture.sourceAllocation,
      },
      { signal: repairController.signal },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    repairController.abort();

    await expect(repair).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
