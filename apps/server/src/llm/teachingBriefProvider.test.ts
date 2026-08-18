import { describe, expect, it, vi } from 'vitest';
import { Hy3Provider } from './hy3Provider.js';
import type { TeachingBriefGenerationInput } from './provider.js';
import { validateTeachingBriefCandidate } from '../services/teachingBriefContract.js';

function input(): TeachingBriefGenerationInput {
  return {
    workspaceName: 'Course',
    learningUnit: {
      title: 'Working memory',
      objectives: [{ objectiveRef: 'O1', title: 'Explain capacity', description: 'Explain it.' }],
      concepts: [{ name: 'Working memory', summary: 'A limited-capacity system.' }],
      canonicalConcepts: [],
    },
    prerequisites: [],
    nextConnection: null,
    sourceContext: {
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 100,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Material',
          headingPath: ['Memory'],
          pageNumber: 1,
          text: 'Working memory has limited capacity.',
        },
      ],
    },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
  };
}

function validPayload(sourceRef = 'S1') {
  return {
    whyNow: 'This concept supports later learning.',
    prerequisites: [],
    segments: [
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation: 'Capacity is limited.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: [sourceRef],
      },
    ],
    formalOpportunities: [],
    summary: 'Capacity is limited.',
    nextConnection: null,
  };
}

function response(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function provider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-secret',
    model: 'test-model',
    timeoutMs,
    fetchImpl,
  });
}

describe('Hy3 Teaching Brief provider contract', () => {
  it('parses valid direct JSON in one physical request', async () => {
    const fetchImpl = vi.fn(async () =>
      response(JSON.stringify(validPayload())),
    ) as unknown as typeof fetch;
    const result = await provider(fetchImpl).generateTeachingBrief(input(), {
      validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, input()),
    });
    expect(result.segments).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', '{"whyNow":'],
    ['schema-invalid JSON', JSON.stringify({ whyNow: 'missing fields' })],
    ['prose-wrapped JSON', `result: ${JSON.stringify(validPayload())}`],
  ])('uses one bounded repair for %s', async (_name, invalid) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(invalid))
      .mockResolvedValueOnce(response(JSON.stringify(validPayload()))) as unknown as typeof fetch;
    await expect(provider(fetchImpl).generateTeachingBrief(input())).resolves.toMatchObject({
      summary: 'Capacity is limited.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('repairs an unknown compact source ref through candidate validation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(validPayload('S9'))))
      .mockResolvedValueOnce(response(JSON.stringify(validPayload()))) as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).generateTeachingBrief(input(), {
        validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, input()),
      }),
    ).resolves.toMatchObject({ segments: [{ sourceRefs: ['S1'] }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed after an invalid repair', async () => {
    const fetchImpl = vi.fn(async () =>
      response(JSON.stringify(validPayload('S9'))),
    ) as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).generateTeachingBrief(input(), {
        validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, input()),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timeout or pre-request cancellation', async () => {
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    await expect(provider(hangingFetch, 5).generateTeachingBrief(input())).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    const cancelledFetch = vi.fn() as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider(cancelledFetch).generateTeachingBrief(input(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(cancelledFetch).not.toHaveBeenCalled();
  });
});
