import { describe, expect, it, vi } from 'vitest';
import { Hy3Provider } from './hy3Provider.js';
import type { TeachingBriefGenerationInput } from './provider.js';
import { validateTeachingBriefCandidate } from '../services/teachingBriefContract.js';

function input(): TeachingBriefGenerationInput {
  return {
    workspaceName: 'Course',
    learningUnit: {
      title: 'Working memory',
      objectives: [
        {
          objectiveRef: 'O1',
          title: 'Explain working-memory capacity',
          description: 'Explain how limited capacity affects a case.',
          priority: 'required',
          construct: 'explain',
          authorityEnvelopeTier: 'formal_sufficient',
          practiceAuthority: 'exact_formal',
        },
      ],
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
          slideNumber: null,
          text: 'Working memory has limited capacity.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
    plannedMinutes: 20,
  };
}

function validPayload(sourceRef = 'S1') {
  return {
    whyNow: 'This concept supports later learning.',
    prerequisites: [],
    segments: [
      {
        purpose: 'objective_orientation',
        objectiveRefs: ['O1'],
        explanation: 'Learn working-memory capacity now because later reasoning depends on it.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [],
      },
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation: 'Working-memory capacity matters because limited space constrains the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: [sourceRef],
      },
      {
        purpose: 'mechanism',
        objectiveRefs: ['O1'],
        explanation: 'When load rises, limited capacity therefore changes what can be maintained.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: [sourceRef],
      },
      {
        purpose: 'worked_example',
        objectiveRefs: ['O1'],
        explanation:
          'First count the active demands, then compare them with capacity, and finally infer the result.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [sourceRef],
        example: {
          text: 'Given a learner holding several items, first identify the load, next inspect interference, then state the consequence.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'contrast',
        objectiveRefs: ['O1'],
        explanation:
          'Compare a capacity explanation with a surface description that does not explain why performance changes.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [sourceRef],
        contrast: {
          text: 'One account traces load to consequence; the other only names memory.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'guided_practice',
        objectiveRefs: ['O1'],
        explanation:
          'Explain how limited capacity controls a new result, then commit your reasoning.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [sourceRef],
        informalCheck: {
          kind: 'own_words',
          prompt: 'Explain how working-memory capacity changes the result in a loaded case.',
          expectedSignal: 'Connect load, capacity, and consequence.',
        },
      },
    ],
    formalOpportunities: [],
    summary: 'Capacity is limited.',
    nextConnection: null,
    practice: {
      items: [
        {
          objectiveRef: 'O1',
          construct: 'explain',
          capabilityTested: 'Explain working-memory capacity through load and consequence.',
          pedagogicalReason: 'This checks causal explanation rather than location recall.',
          authority: 'exact_source',
          sourceRefs: [sourceRef],
          visualRefs: [],
          initial: {
            prompt:
              'Which explanation best shows how and why limited working-memory capacity changes performance?',
            options: [
              {
                optionRef: 'A',
                text: 'Load competes for limited capacity.',
                feedbackIfSelected: 'Correct.',
              },
              {
                optionRef: 'B',
                text: 'Memory is a familiar word.',
                feedbackIfSelected: 'Surface label.',
              },
              {
                optionRef: 'C',
                text: 'All information is retained.',
                feedbackIfSelected: 'Contradicts the limit.',
              },
            ],
            correctOptionRef: 'A',
            hint: 'Trace load to capacity.',
            explanation: 'Competing load explains the performance consequence.',
          },
          retry: {
            prompt:
              'When task load changes, which account best explains why working-memory performance also changes?',
            options: [
              {
                optionRef: 'A',
                text: 'The page number changed.',
                feedbackIfSelected: 'Irrelevant.',
              },
              {
                optionRef: 'B',
                text: 'Demand on limited capacity changed.',
                feedbackIfSelected: 'Correct.',
              },
              {
                optionRef: 'C',
                text: 'The label stayed the same.',
                feedbackIfSelected: 'Not causal.',
              },
            ],
            correctOptionRef: 'B',
            hint: 'Look at demand on the bounded system.',
            explanation: 'Changed demand changes the consequence of a capacity limit.',
          },
        },
      ],
    },
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
  it('states required segment base fields and the nullable root connection in original and repair prompts', async () => {
    const schemaInvalid = { ...validPayload(), nextConnection: undefined };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(schemaInvalid)))
      .mockResolvedValueOnce(response(JSON.stringify(validPayload()))) as unknown as typeof fetch;

    await provider(fetchImpl).generateTeachingBrief(input());

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const originalBody = JSON.parse(String(calls[0]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const originalPrompt = originalBody.messages.map((message) => message.content).join('\n');
    const repairPrompt = repairBody.messages.at(-1)!.content;
    for (const field of [
      'purpose',
      'objectiveRefs',
      'explanation',
      'explanationAuthority',
      'sourceRefs',
    ]) {
      expect(originalPrompt).toContain(field);
      expect(repairPrompt).toContain(field);
    }
    expect(originalPrompt).toContain('Every object in segments MUST contain all five base fields');
    expect(originalPrompt).toContain('nextConnection is required');
    expect(originalPrompt).toContain('cause -> consequence');
    expect(originalPrompt).toContain('durationBudget');
    expect(originalPrompt).toContain('practiceEnvelope');
    expect(originalPrompt).toContain('source-stated rule/procedure');
    expect(repairPrompt).toContain('Always include nextConnection as a string or JSON null');
    expect(originalPrompt).not.toContain('Optional segment fields may be omitted');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('parses valid direct JSON in one physical request', async () => {
    const fetchImpl = vi.fn(async () =>
      response(JSON.stringify(validPayload())),
    ) as unknown as typeof fetch;
    const result = await provider(fetchImpl).generateTeachingBrief(input(), {
      validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, input()),
    });
    expect(result.segments).toHaveLength(6);
    expect(result.practice.items).toHaveLength(1);
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
    const result = await provider(fetchImpl).generateTeachingBrief(input(), {
      validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, input()),
    });
    expect(result.segments.some((segment) => segment.sourceRefs.includes('S1'))).toBe(true);
    expect(result.practice.items[0]?.sourceRefs).toEqual(['S1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes exact semantic authority facts into bounded candidate repair', async () => {
    const context = input();
    context.sourceContext.offers.push({
      sourceRef: 'S2',
      materialTitle: 'Material',
      headingPath: ['Memory'],
      pageNumber: 1,
      slideNumber: null,
      text: 'A second authorized explanation of the capacity condition.',
      authorizedObjectiveRefs: ['O1'],
    });
    context.sourceContext.offers[0]!.authorizedObjectiveRefs = [];
    const invalid = validPayload('S1');
    const repaired = validPayload('S2');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(JSON.stringify(repaired))) as unknown as typeof fetch;

    await provider(fetchImpl).generateTeachingBrief(context, {
      validateCandidate: (candidate) => validateTeachingBriefCandidate(candidate, context),
    });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const repairPrompt = repairBody.messages.at(-1)!.content;
    expect(repairPrompt).toContain('practice_source_outside_objective_authority');
    expect(repairPrompt).toContain('allowedEvidenceAliases');
    expect(repairPrompt).toContain('S2');
    expect(repairPrompt).toContain('targetConstruct');
    expect(repairPrompt).toContain('allowedApplyForms');
    expect(repairPrompt).toContain('source-stated state-to-action decision');
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
