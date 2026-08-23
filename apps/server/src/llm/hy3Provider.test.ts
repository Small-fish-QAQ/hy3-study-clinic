import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_MATERIAL_TITLE, type SourceBlock } from '@hy3-clinic/shared';
import { Hy3Provider } from './hy3Provider.js';
import { ProviderError } from './errors.js';
import type {
  RepairGenerationInput,
  StudyPlanProposalInput,
  VisualDescriptionInput,
} from './provider.js';
import { groupedStudyPlanProposalMessages } from './prompts.js';

const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆',
    headingPath: ['记忆'],
    content: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
  },
];

function jsonResponse(content: string, usage?: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-should-never-leak',
    model: 'test-model',
    timeoutMs,
    fetchImpl,
  });
}

const visualInput: VisualDescriptionInput = {
  image: {
    dataBase64: 'iVBORw0KGgo=',
    mediaType: 'image/png',
    width: 1,
    height: 1,
    byteLength: 8,
  },
  limits: {
    maxDescriptionChars: 1200,
    maxVisibleTextChars: 2000,
    maxConcepts: 12,
    maxPedagogicalNotes: 6,
    maxUncertaintyItems: 6,
  },
};

describe('Hy3Provider visual transport boundary', () => {
  it('fails closed without fetching when image transport is not configured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).describeVisual(visualInput)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prioritizes an already-aborted visual request without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeProvider(fetchImpl).describeVisual(visualInput, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function largeStudyPlanInput(): StudyPlanProposalInput {
  const units = Array.from({ length: 80 }, (_, index) => ({
    id: `unit_${index + 1}`,
    title: `Unit ${index + 1}`,
    objectiveIds: [`objective_${index + 1}`],
    objectiveSummaries: [
      {
        id: `objective_${index + 1}`,
        title: `Objective ${index + 1}`,
        description: `PRIVATE_VERBOSE_OBJECTIVE_${index + 1}`,
      },
    ],
    prerequisiteUnitIds: index === 0 ? [] : [`unit_${index}`],
    blockingEligibleObjectiveIds: [],
    synthesisGroupIds: [],
  }));
  return {
    workspaceName: 'Large course',
    contract: {
      contractVersionId: 'contract_1',
      intent: 'Learn the course.',
      targetOutcome: { description: 'Working fluency', targetScore: null },
      deadline: null,
      studyBudget: {
        minutesPerDay: 60,
        minutesPerWeek: null,
        preferredSessionMinutes: 30,
      },
      desiredDepth: 'working_fluency',
      subjectBoundaries: [],
      materials: [],
      includedTopics: [],
      excludedTopics: [],
      allowExplicitDeferral: false,
    },
    curriculumVersionId: 'curriculum_1',
    executionSourceManifestFingerprint: 'manifest_1',
    units,
    synthesisGroups: [],
    learnerState: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      state: 'unassessed',
      observedMinutes: null,
      openMistakes: 0,
    })),
    requiredLearningUnitIds: units.map((unit) => unit.id),
    allowedItemKinds: ['teach_unit'],
    allowedDepths: ['working_fluency'],
    launchCapabilities: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      allowedItemKinds: ['teach_unit'],
      launchableAssessmentModes: [],
    })),
    feasibility: {
      projectedMinutes: 0,
      availableMinutes: null,
      slackMinutes: null,
      state: 'unknown',
      assumptions: [],
    },
  };
}

function detailedStudyPlanInput(): StudyPlanProposalInput {
  const large = largeStudyPlanInput();
  const units = large.units.slice(0, 2);
  return {
    ...large,
    workspaceName: 'Detailed course',
    units,
    learnerState: large.learnerState.slice(0, 2),
    requiredLearningUnitIds: units.map((unit) => unit.id),
    launchCapabilities: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      allowedItemKinds: ['teach_unit'],
      launchableAssessmentModes: [],
    })),
  };
}

function validDetailedProposal() {
  return {
    rationale: 'Teach both required units in prerequisite order.',
    items: [
      {
        key: 'item-1',
        phase: 'Core route',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_1',
        rationale: 'Teach the prerequisite.',
        estimatedMinutes: 20,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_1'],
        prerequisiteItemKeys: [],
      },
      {
        key: 'item-2',
        phase: 'Core route',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_2',
        rationale: 'Teach the dependent unit.',
        estimatedMinutes: 20,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_2'],
        prerequisiteItemKeys: ['item-1'],
      },
    ],
    deferrals: [],
  } as const;
}

describe('Hy3Provider happy path', () => {
  it('sends a bearer token and parses a valid concept payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
      ),
    ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts[0]?.name).toBe('工作记忆');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer test-key-should-never-leak');
  });

  it('reports available standard usage without deriving unreported cost', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(JSON.stringify({ concepts: [] }), {
        prompt_tokens: 17,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    );
    const onUsage = vi.fn();
    await makeProvider(fetchMock).analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { onUsage },
    );
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 17,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      estimatedCostMicrounits: null,
      currency: null,
      pricingSource: null,
      pricingVersion: null,
    });
  });
});

describe('Hy3Provider detailed StudyPlan input-aware repair', () => {
  const invalidCases = [
    {
      name: 'unavailable capability',
      mutate: () => {
        const proposal = structuredClone(validDetailedProposal());
        proposal.items[1]!.kind = 'formal_checkpoint';
        return proposal;
      },
      expected: 'unavailable for LearningUnit unit_2',
    },
    {
      name: 'unknown LearningUnit id',
      mutate: () => {
        const proposal = structuredClone(validDetailedProposal());
        proposal.items[1]!.curriculumLearningUnitId = 'unit_unknown';
        return proposal;
      },
      expected: 'unknown or non-required LearningUnit',
    },
    {
      name: 'omitted required objective',
      mutate: () => ({
        ...structuredClone(validDetailedProposal()),
        items: [validDetailedProposal().items[0]],
      }),
      expected: 'objective is omitted',
    },
    {
      name: 'Contract-forbidden deferral',
      mutate: () => ({
        ...structuredClone(validDetailedProposal()),
        items: [validDetailedProposal().items[0]],
        deferrals: [
          {
            curriculumLearningUnitId: 'unit_2',
            objectiveIds: ['objective_2'],
            reason: 'Defer it.',
          },
        ],
      }),
      expected: 'Deferrals are not allowed',
    },
  ];

  it.each(invalidCases)(
    'repairs $name inside the one-repair contract',
    async ({ mutate, expected }) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(JSON.stringify(mutate())))
        .mockResolvedValueOnce(
          jsonResponse(JSON.stringify(validDetailedProposal())),
        ) as unknown as typeof fetch;

      const proposal = await makeProvider(fetchImpl).proposeStudyPlan(detailedStudyPlanInput());

      expect(proposal).toEqual(validDetailedProposal());
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const repairBody = JSON.parse(
        String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
      ) as { messages: Array<{ content: string }> };
      expect(repairBody.messages.at(-1)!.content).toContain(expected);
    },
  );

  it('fails closed after exactly one repair when the second detailed result is still invalid', async () => {
    const invalid = invalidCases[1]!.mutate();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(invalid)),
    ) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl).proposeStudyPlan(detailedStudyPlanInput()),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Hy3Provider connection probe', () => {
  it('sends one bounded minimal chat request without entering repair flow', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
      };
      expect(body).toMatchObject({
        model: 'test-model',
        temperature: 0,
        max_tokens: 1,
        messages: [
          { role: 'system', content: expect.stringContaining('OK') },
          { role: 'user', content: 'OK' },
        ],
      });
      return jsonResponse('OK');
    }) as unknown as typeof fetch;

    await makeProvider(fetchImpl).testConnection();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('uses a short timeout override without changing normal provider calls', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl, 30_000).testConnection({ timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', details: { timeoutMs: 20 } });
  });
});

describe('Hy3Provider large StudyPlan output', () => {
  it('places exact offered kinds beside units and does not advertise unavailable literals', () => {
    const input = largeStudyPlanInput();
    const content = groupedStudyPlanProposalMessages(input)[1]!.content;

    expect(content).toContain('"allowedItemKinds":["teach_unit"]');
    expect(content).toContain('kind MUST be exactly one of these offered literals: `teach_unit`');
    expect(content).toContain('Never invent, combine, translate, or paraphrase a kind literal');
    expect(content).not.toContain('teach_unit|');
    expect(content).not.toContain('`formal_checkpoint`');
    expect(content).not.toContain('`targeted_repair`');
    expect(content).not.toContain('`due_review`');
  });

  it('uses compact grouped output and derives objective and prerequisite ids locally', async () => {
    const input = largeStudyPlanInput();
    const unitIds = input.units.map((unit) => unit.id);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_VERBOSE_OBJECTIVE');
      return jsonResponse(
        JSON.stringify({
          format: 'grouped_units',
          rationale: 'Follow the accepted prerequisite order.',
          groups: [
            {
              key: 'core',
              phase: 'Core route',
              kind: 'teach_unit',
              curriculumLearningUnitIds: unitIds,
              rationale: 'Advance each accepted LearningUnit.',
              estimatedMinutesPerUnit: 20,
              targetDepth: 'working_fluency',
            },
          ],
          deferrals: [],
        }),
      );
    }) as unknown as typeof fetch;

    const proposal = await makeProvider(fetchImpl).proposeStudyPlan(input);

    expect(proposal.items).toHaveLength(80);
    expect(proposal.items[0]).toMatchObject({
      curriculumLearningUnitId: 'unit_1',
      objectiveIds: ['objective_1'],
      prerequisiteItemKeys: [],
    });
    expect(proposal.items[79]).toMatchObject({
      curriculumLearningUnitId: 'unit_80',
      objectiveIds: ['objective_80'],
      prerequisiteItemKeys: ['item-79'],
    });
  });

  it('rejects unknown, omitted, and out-of-order unit accounting', async () => {
    const input = largeStudyPlanInput();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        JSON.stringify({
          format: 'grouped_units',
          rationale: 'Invalid route.',
          groups: [
            {
              key: 'core',
              phase: 'Core route',
              kind: 'teach_unit',
              curriculumLearningUnitIds: ['unit_2', 'unknown_unit'],
              rationale: 'Invalid order and identity.',
              estimatedMinutesPerUnit: 20,
              targetDepth: 'working_fluency',
            },
          ],
          deferrals: [],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).proposeStudyPlan(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('repairs a schema-valid teach_unit assignment that violates per-unit capabilities', async () => {
    const input = largeStudyPlanInput();
    input.contract.allowExplicitDeferral = true;
    input.launchCapabilities[79] = {
      curriculumLearningUnitId: 'unit_80',
      allowedItemKinds: [],
      launchableAssessmentModes: [],
    };
    const first = {
      format: 'grouped_units',
      rationale: 'Teach every required unit.',
      groups: [
        {
          key: 'core',
          phase: 'Core route',
          kind: 'teach_unit',
          curriculumLearningUnitIds: input.requiredLearningUnitIds,
          rationale: 'Teach the route.',
          estimatedMinutesPerUnit: 20,
          targetDepth: 'working_fluency',
        },
      ],
      deferrals: [],
    };
    const repaired = {
      ...first,
      groups: [
        {
          ...first.groups[0],
          curriculumLearningUnitIds: input.requiredLearningUnitIds.slice(0, -1),
        },
      ],
      deferrals: [
        {
          curriculumLearningUnitIds: ['unit_80'],
          reason: 'No launch capability is currently available.',
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(first)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(repaired))) as unknown as typeof fetch;

    const proposal = await makeProvider(fetchImpl).proposeStudyPlan(input);

    expect(proposal.items).toHaveLength(79);
    expect(proposal.deferrals).toEqual([
      {
        curriculumLearningUnitId: 'unit_80',
        objectiveIds: ['objective_80'],
        reason: 'No launch capability is currently available.',
      },
    ]);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairInstruction = repairBody.messages.at(-1)!.content;
    expect(repairInstruction).toContain('teach_unit is unavailable for LearningUnit unit_80');
    expect(repairInstruction).toContain('Allowed kind literals for this request: teach_unit');
    expect(repairInstruction).toContain('must be moved to deferrals');
    expect(repairInstruction).toContain(
      'Preserve every otherwise-valid field and exact supplied ID',
    );
  });

  it('still rejects arbitrary unknown kind aliases after exactly one repair', async () => {
    const input = largeStudyPlanInput();
    const invalid = {
      format: 'grouped_units',
      rationale: 'Use an invented action.',
      groups: [
        {
          key: 'core',
          phase: 'Core route',
          kind: 'teach_course_unit',
          curriculumLearningUnitIds: input.requiredLearningUnitIds,
          rationale: 'Invented alias.',
          estimatedMinutesPerUnit: 20,
          targetDepth: 'working_fluency',
        },
      ],
      deferrals: [],
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(invalid)),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).proposeStudyPlan(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        validationKind: 'schema',
        structuredFailure: {
          attemptNumber: 2,
          attemptKind: 'repair',
          jsonParseSuccess: true,
          schemaIssueCount: 1,
          schemaIssues: [{ path: 'groups.0.kind', code: 'invalid_enum_value' }],
          failureCategory: 'SCHEMA_VALIDATION_FAILURE',
          repairAction: 'exhausted',
        },
      },
      technicalFailureCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Hy3Provider bounded repair', () => {
  it('carries the locally required Repair mode into the first request and exact mismatch into the one repair', async () => {
    const input: RepairGenerationInput = {
      targetLearningUnitId: 'unit_1',
      diagnosticCategory: 'RELATION_REVERSAL',
      requiredInterventionMode: 'CONTRAST',
      gapSummary: 'The relation was reversed.',
      affectedCriteria: ['States the correct relation.'],
      sourceContext: [{ blockId: 'block_1', quote: 'A precedes B.' }],
      failedPrompt: 'Explain the relation.',
    };
    const wrong = {
      interventionMode: 'TARGETED_PROMPT',
      diagnosticCategory: 'RELATION_REVERSAL',
      explanation: 'Ask the learner to reconsider.',
      practicePrompt: 'Try again.',
      hints: [],
    };
    const corrected = { ...wrong, interventionMode: 'CONTRAST' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(wrong)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(corrected))) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const payload = await provider.generateRepair(input, {
      validateCandidate: (candidate) => ({
        valid: (candidate as { interventionMode?: string }).interventionMode === 'CONTRAST',
        diagnostics: [
          'interventionMode mismatch: returned TARGETED_PROMPT, required CONTRAST for RELATION_REVERSAL.',
        ],
        diagnosticCodes: ['repair_intervention_mode_mismatch'],
      }),
    });
    expect(payload.interventionMode).toBe('CONTRAST');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const firstBody = JSON.parse(String(calls[0]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(JSON.stringify(firstBody.messages)).toContain('requiredInterventionMode');
    expect(JSON.stringify(firstBody.messages)).toContain('CONTRAST');
    expect(repairBody.messages.at(-1)!.content).toContain(
      'returned TARGETED_PROMPT, required CONTRAST for RELATION_REVERSAL',
    );
    expect(repairBody.messages.at(-1)!.content).toContain('这两个值不可更改');
  });

  it('retries exactly once on invalid output, then succeeds', async () => {
    const onRepairAttempt = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('这不是 JSON'))
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts(
      {
        materialTitle: SAMPLE_MATERIAL_TITLE,
        blocks,
      },
      { onRepairAttempt },
    );
    expect(payload.concepts).toHaveLength(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(onRepairAttempt).toHaveBeenCalledTimes(1);
  });

  it('fails with PROVIDER_INVALID_OUTPUT after the repair also fails (no unbounded retry)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('仍然不是 JSON')) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    // Exactly two calls: initial + one repair.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('repairs a schema-valid-but-wrong payload once', async () => {
    // NOTE: an EMPTY concepts array is deliberately legal since the
    // section-aware extraction upgrade (a thin section may yield nothing),
    // so the invalid first payload violates the importance enum instead.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"CRITICAL","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"low","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts).toHaveLength(1);
  });
});

describe('Hy3Provider error mapping', () => {
  it('maps non-2xx to PROVIDER_ERROR', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps network failure to PROVIDER_ERROR without leaking details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderError &&
        err.code === 'PROVIDER_ERROR' &&
        !err.message.includes('ECONNREFUSED') &&
        !err.message.includes('10.0.0.1')
      );
    });
  });

  it('maps a timeout to PROVIDER_TIMEOUT', async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('maps external cancellation to REQUEST_CANCELLED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('never includes the API key in a thrown error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderError && !err.message.includes('test-key'),
    );
  });
});

describe('Hy3Provider response-body cancellation', () => {
  function responseWithHangingBody(signal: AbortSignal): Response {
    return {
      ok: true,
      status: 200,
      text: () =>
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(Object.assign(new Error('aborted while reading body'), { name: 'AbortError' }));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        }),
    } as unknown as Response;
  }

  it('keeps the timeout active while reading the response body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('keeps external cancellation active while reading the response body', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});
