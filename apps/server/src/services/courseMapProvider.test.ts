import { describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { ProviderUsage } from '../llm/provider.js';
import { createCourseMapFixture } from '../testing/courseMapFixtures.js';
import { generateCourseMapPrototype } from './courseMap.js';

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
