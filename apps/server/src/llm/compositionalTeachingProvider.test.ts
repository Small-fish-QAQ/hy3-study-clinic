import { describe, expect, it, vi } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  TeachingSkeletonSchema,
} from '@hy3-clinic/shared';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import { lessonSlotContentMessages, practiceContentMessages } from './prompts.js';
import { evaluateLessonSlotPedagogy } from '../services/lessonPedagogyEvaluator.js';
import { validatePracticeContentCandidate } from '../services/teachingBriefContract.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCandidateValidation,
} from './provider.js';
import { MAX_COMPOSITIONAL_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL } from './provider.js';

function skeleton() {
  return TeachingSkeletonSchema.parse({
    id: `teaching_skeleton_${'a'.repeat(40)}`,
    schemaVersion: 1,
    plannerVersion: 'teaching-skeleton-v1',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    learningUnitTitle: 'Working-memory capacity',
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain working-memory capacity',
        description: 'Explain how limited capacity changes performance under load.',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
    targetMinutes: 15,
    acceptableActiveMinutes: { minMinutes: 10, maxMinutes: 20 },
    lessonSlots: [
      {
        slotId: 'L1',
        objectiveRefs: ['O1'],
        construct: null,
        role: 'objective_orientation',
        purpose: 'Orient the learner to the bounded session objective.',
        authorityMode: 'bounded_synthesis',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
        protected: true,
        activityBudget: { minMinutes: 2, maxMinutes: 3 },
        learnerActionRequired: false,
        qualityContract: 'orientation',
        allowedRelations: [],
      },
      {
        slotId: 'L2',
        objectiveRefs: ['O1'],
        construct: 'explain',
        role: 'mechanism',
        purpose: 'Expose the mechanism linking load to a performance consequence.',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
        protected: true,
        activityBudget: { minMinutes: 4, maxMinutes: 6 },
        learnerActionRequired: false,
        qualityContract: 'semantic_relation',
        allowedRelations: ['mechanism_effect'],
      },
    ],
    practicePlan: {
      schemaVersion: 1,
      slots: [
        {
          practiceSlotId: 'PR1',
          objectiveRef: 'O1',
          construct: 'explain',
          authorityMode: 'exact_source',
          allowedSourceRefs: ['S1'],
          allowedVisualRefs: [],
          capabilityToObserve: 'Explain how limited capacity changes performance.',
          prohibitedStrongerConstructs: ['apply', 'design', 'evaluate'],
          retryPermitted: true,
          activityBudget: { minMinutes: 3, maxMinutes: 4 },
        },
        {
          practiceSlotId: 'PR2',
          objectiveRef: 'O1',
          construct: 'explain',
          authorityMode: 'exact_source',
          allowedSourceRefs: ['S1'],
          allowedVisualRefs: [],
          capabilityToObserve: 'Relate increased load to its bounded consequence.',
          prohibitedStrongerConstructs: ['apply', 'design', 'evaluate'],
          retryPermitted: true,
          activityBudget: { minMinutes: 3, maxMinutes: 4 },
        },
      ],
      activityBudget: { minMinutes: 6, maxMinutes: 8 },
    },
    synthesisActivityBudget: { minMinutes: 1, maxMinutes: 2 },
    protectedActivityBudget: { minMinutes: 13, maxMinutes: 19 },
    plannedActivityBudget: { minMinutes: 13, maxMinutes: 19 },
  });
}

function lessonInput(): LessonSlotContentGenerationInput {
  return {
    workspaceName: 'Course',
    learnerLocale: 'zh-CN',
    courseDesign: { desiredDepth: 'deep_transfer', unitFocus: 'focused' },
    skeleton: skeleton(),
    sourceContext: {
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 48,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Memory',
          headingPath: ['Capacity'],
          pageNumber: 1,
          slideNumber: null,
          text: 'Working memory has limited capacity, so additional load can impair performance.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
    learningContext: {
      concepts: [{ name: 'Working memory', summary: 'A limited-capacity system.' }],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
}

function relation() {
  return {
    kind: 'mechanism_effect' as const,
    fromProposition: 'Working memory has limited capacity.',
    toProposition: 'Additional load can impair performance.',
    relevanceToObjective: 'This explains how load affects performance.',
    sourceRefs: ['S1'],
  };
}

function lessonPayload(l1 = 'original valid orientation', l2 = 'accepted mechanism') {
  return {
    narrative: {
      whyNow: 'Working-memory limits matter because they shape every later reasoning step.',
      summary: 'Capacity limits explain why added load can reduce performance.',
      forwardBridge: 'Next, use this model in a changed workload.',
    },
    slots: [
      {
        slotId: 'L1',
        explanation: l1,
        sourceRefs: [],
        visualRefs: [],
        semanticRelations: [],
        workedProcess: null,
      },
      {
        slotId: 'L2',
        explanation: l2,
        sourceRefs: ['S1'],
        visualRefs: [],
        semanticRelations: [relation()],
        workedProcess: null,
      },
    ],
  };
}

function surface(prompt: string, correctOptionRef: 'A' | 'B') {
  return {
    prompt,
    options: [
      { optionRef: 'A', text: 'Trace load to the limit.', feedbackIfSelected: 'Correct.' },
      { optionRef: 'B', text: 'Repeat the label.', feedbackIfSelected: 'Surface recall.' },
      { optionRef: 'C', text: 'Ignore capacity.', feedbackIfSelected: 'Misses the mechanism.' },
    ],
    correctOptionRef,
    hint: 'Connect the condition to its consequence.',
    explanation: 'Limited capacity makes added load consequential.',
  };
}

function practiceItem(id: 'PR1' | 'PR2', capability: string) {
  return {
    practiceSlotId: id,
    capabilityTested: capability,
    pedagogicalReason: 'This elicits a relation instead of source-location recall.',
    sourceRefs: ['S1'],
    visualRefs: [],
    application: null,
    initial: surface(`Initial ${id}: explain the mechanism.`, 'A'),
    retry: surface(`Changed ${id}: explain the same mechanism in a new case.`, 'B'),
  };
}

function practicePayload(pr1 = 'original valid capability', pr2 = 'accepted capability') {
  return { items: [practiceItem('PR1', pr1), practiceItem('PR2', pr2)] };
}

function practiceInput(): PracticeContentGenerationInput {
  const lesson = lessonInput();
  const payload = LessonSlotContentProposalPayloadSchema.parse(lessonPayload());
  return {
    workspaceName: lesson.workspaceName,
    learnerLocale: lesson.learnerLocale,
    courseDesign: lesson.courseDesign,
    skeleton: lesson.skeleton,
    acceptedLesson: payload.slots.map((content, index) =>
      index === 0 ? { ...content, lessonNarrative: payload.narrative } : content,
    ),
    sourceContext: lesson.sourceContext,
    visualContext: lesson.visualContext,
  };
}

function applyLessonInput(): LessonSlotContentGenerationInput {
  const input = lessonInput();
  const candidate = structuredClone(input.skeleton);
  candidate.objectives[0]!.construct = 'apply';
  candidate.objectives[0]!.title = 'Apply the bounded working-memory procedure';
  candidate.lessonSlots[1]!.construct = 'apply';
  candidate.lessonSlots[1]!.role = 'worked_example';
  candidate.lessonSlots[1]!.qualityContract = 'worked_process';
  candidate.lessonSlots[1]!.learnerActionRequired = true;
  candidate.lessonSlots[1]!.allowedRelations = ['step_purpose'];
  for (const slot of candidate.practicePlan.slots) {
    slot.construct = 'apply';
    slot.capabilityToObserve = 'Use the source-stated procedure to select an action.';
    slot.prohibitedStrongerConstructs = ['design', 'evaluate'];
  }
  return { ...input, skeleton: TeachingSkeletonSchema.parse(candidate) };
}

function response(content: string, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function hy3(fetchImpl: typeof fetch): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-secret',
    model: 'test-model',
    timeoutMs: 30_000,
    fetchImpl,
  });
}

function lessonValidation(candidate: unknown): ProviderCandidateValidation {
  const payload = LessonSlotContentProposalPayloadSchema.parse(candidate);
  const expected = ['L1', 'L2'];
  const actual = payload.slots.map((slot) => slot.slotId);
  const identityFailures = [
    ...expected.filter((id) => !actual.includes(id)),
    ...actual.filter((id) => !expected.includes(id)),
  ];
  const contentFailure = payload.slots.find(
    (slot) => slot.slotId === 'L2' && slot.explanation !== 'accepted mechanism',
  );
  const authorityFailures = payload.slots
    .filter((slot) => slot.sourceRefs.some((ref) => ref !== 'S1') || slot.visualRefs.length > 0)
    .map((slot) => slot.slotId);
  const invalidItemIds = [
    ...new Set([...identityFailures, ...authorityFailures, ...(contentFailure ? ['L2'] : [])]),
  ];
  return invalidItemIds.length === 0
    ? { valid: true, diagnostics: [] }
    : {
        valid: false,
        diagnostics: ['Lesson slots failed local validation.'],
        diagnosticCodes: ['lesson_slot_invalid'],
        targetedRepair: { invalidItemIds },
        failureArtifact: {
          kind: 'lesson_slot_validation',
          diagnostics: invalidItemIds.map((id) => ({
            code: 'lesson_slot_invalid',
            message: `Repair ${id}.`,
            facts: { slotId: id },
          })),
        },
      };
}

function practiceValidation(candidate: unknown): ProviderCandidateValidation {
  const payload = PracticeContentProposalPayloadSchema.parse(candidate);
  const invalidItemIds = payload.items
    .filter(
      (item) =>
        (item.practiceSlotId === 'PR2' && item.capabilityTested !== 'accepted capability') ||
        item.sourceRefs.some((ref) => ref !== 'S1') ||
        item.visualRefs.length > 0,
    )
    .map((item) => item.practiceSlotId);
  return invalidItemIds.length === 0
    ? { valid: true, diagnostics: [] }
    : {
        valid: false,
        diagnostics: ['Practice PR2 failed local validation.'],
        targetedRepair: { invalidItemIds },
        failureArtifact: {
          kind: 'practice_slot_validation',
          diagnostics: [{ code: 'practice_slot_invalid', message: 'Repair PR2.' }],
        },
      };
}

describe('compositional Teaching providers', () => {
  it('uses a separate bounded content review with independently solved decisions', async () => {
    const result = {
      decisions: [
        {
          actionId: 'L1.guided',
          answerId: 'B',
          requiresCaseInference: true,
          evidenceUsed: 'Two current grants are combined.',
        },
      ],
      findings: [],
    };
    const transport = vi
      .fn()
      .mockResolvedValue(response(JSON.stringify(result))) as unknown as typeof fetch;
    const reviewed = await hy3(transport).reviewTeachingContent({
      stage: 'lesson',
      desiredDepth: 'working_fluency',
      objectives: [
        { title: 'Role permissions', description: 'Explain indirect permission grants.' },
      ],
      sources: [],
      candidate: { visibleCase: 'Two current grants are combined.' },
      actionIds: ['L1.guided'],
    });
    expect(reviewed).toEqual(result);
    const body = JSON.parse(
      String((transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body),
    );
    expect(body.max_tokens).toBe(8000);
    expect(body.messages[0].content).toContain(
      'author reasoning labels and answer keys are removed',
    );
    expect(body.messages[0].content).toContain(
      'Direct user permissions alone are not attribute-based',
    );
  });
  it.each(['lesson', 'practice'] as const)(
    'reserves reasoning time for %s without overriding caller cancellation budgets',
    async (stage) => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn(
          (_url: unknown, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              const timer = setTimeout(
                () =>
                  resolve(
                    response(
                      JSON.stringify(stage === 'lesson' ? lessonPayload() : practicePayload()),
                    ),
                  ),
                130_000,
              );
              init.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        ) as unknown as typeof fetch;
        const provider = hy3(fetchImpl);
        const call =
          stage === 'lesson'
            ? provider.generateLessonSlotContent(lessonInput())
            : provider.generatePracticeContent(practiceInput());
        await vi.advanceTimersByTimeAsync(130_000);
        await expect(call).resolves.toBeDefined();
        const bounded =
          stage === 'lesson'
            ? provider.generateLessonSlotContent(lessonInput(), { timeoutMs: 1000 })
            : provider.generatePracticeContent(practiceInput(), { timeoutMs: 1000 });
        const rejection = expect(bounded).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('keeps depth cognitive and focus an independent investment signal', () => {
    const lessonPrompt = (
      desiredDepth: NonNullable<LessonSlotContentGenerationInput['courseDesign']>['desiredDepth'],
      unitFocus: 'normal' | 'focused',
    ) =>
      lessonSlotContentMessages({
        ...lessonInput(),
        courseDesign: { desiredDepth, unitFocus },
      })
        .map((message) => message.content)
        .join('\n');

    const working = lessonPrompt('working_fluency', 'normal');
    const high = lessonPrompt('high_performance', 'normal');
    const deep = lessonPrompt('deep_transfer', 'normal');
    const focused = lessonPrompt('working_fluency', 'focused');

    expect(working).toContain('mechanisms and causal relationships');
    expect(working).toContain('with a withheld inference');
    expect(high).toContain('realistic failure modes and competing constraints');
    expect(high).toContain('at least two distinct reasoning operations');
    expect(deep).toContain('unfamiliar transfer');
    expect(deep).toContain('offered adjacent Unit concept');
    expect(focused).toContain('keep the same global desiredDepth');
    expect(focused).toContain('Focus is angle coverage');
    expect(focused).toContain(
      'Focus grants no truth, citation, Formal, credit, or mastery authority',
    );
    expect(focused).toContain('"desiredDepth":"working_fluency"');
    expect(focused).not.toContain('"unitDepth"');

    const practice = practiceContentMessages({
      ...practiceInput(),
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'focused' },
    })
      .map((message) => message.content)
      .join('\n');
    expect(practice).toContain('materially changed scenario');
    expect(practice).toContain('focused Unit receives a richer case within the same global depth');
  });

  it('uses separate Lesson and Practice prompts with content-only output responsibilities', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(lessonPayload())))
      .mockResolvedValueOnce(
        response(JSON.stringify(practicePayload())),
      ) as unknown as typeof fetch;
    const provider = hy3(fetchImpl);
    const schemaNames: string[] = [];

    await provider.generateLessonSlotContent(lessonInput(), {
      onStructuredOutputDiagnostic: (diagnostic) => schemaNames.push(diagnostic.schemaName),
    });
    await provider.generatePracticeContent(practiceInput(), {
      onStructuredOutputDiagnostic: (diagnostic) => schemaNames.push(diagnostic.schemaName),
    });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lessonBody = JSON.parse(String(calls[0]![1]!.body)) as {
      messages: Array<{ content: string }>;
      max_tokens: number;
    };
    const practiceBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
      max_tokens: number;
    };
    expect([lessonBody.max_tokens, practiceBody.max_tokens]).toEqual([16000, 16000]);
    const lessonPrompt = lessonBody.messages.map((message) => message.content).join('\n');
    const practicePrompt = practiceBody.messages.map((message) => message.content).join('\n');
    expect(lessonPrompt).toContain('one competent teacher writing one coherent');
    expect(lessonPrompt).toContain('determines what the Lesson can prove');
    expect(lessonPrompt).toContain('does not determine everything you may teach');
    expect(lessonPrompt).toContain('two strict epistemic lanes');
    expect(lessonPrompt).not.toContain('immutable Hy3 Study Clinic instructional spine');
    expect(lessonPrompt).toContain('"desiredDepth":"deep_transfer"');
    expect(lessonPrompt).toContain('"unitFocus":"focused"');
    expect(lessonPrompt).not.toContain('"practicePlan"');
    expect(lessonPrompt).not.toContain('"acceptedLesson"');
    expect(practicePrompt).toContain('already accepted Hy3 Study Clinic Lesson');
    expect(practicePrompt).toContain('"practicePlan"');
    expect(practicePrompt).toContain('"acceptedLesson"');
    expect(practicePrompt).toContain('"desiredDepth":"deep_transfer"');
    expect(practicePrompt).toContain('"unitFocus":"focused"');
    expect(practicePrompt).toContain('Never quote or closely reproduce');
    expect(practicePrompt).toContain('never prove application');
    expect(schemaNames).toEqual([
      'lesson-slot-content-v5-evidence-decisions',
      'practice-content-v5-evidence-decisions',
    ]);
  });

  it('freezes valid Lesson slots during one targeted candidate repair', async () => {
    const first = lessonPayload('original valid orientation', 'invalid mechanism');
    const repaired = lessonPayload('provider tried to rewrite orientation', 'accepted mechanism');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
    });

    expect(result.slots[0]?.explanation).toBe('original valid orientation');
    expect(result.slots[1]?.explanation).toBe('accepted mechanism');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    expect(repairBody.messages.at(-1)?.content).toContain('L2');
    expect(repairBody.messages.at(-1)?.content).toContain('frozen');
    expect(repairBody.messages.at(-1)?.content).toContain('Other learnerActionRequired slots');
    expect(repairBody.messages.at(-1)?.content).toContain('omit informalCheck from that slot');
  });

  it('freezes valid Lesson peers when one first-pass slot is schema-invalid', async () => {
    const first = lessonPayload('schema-valid orientation', 'accepted mechanism') as unknown as {
      slots: Array<Record<string, unknown>>;
    };
    first.slots[1]!.sourceRefs = 'S1';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ slots: [lessonPayload().slots[1]] })),
      ) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
    });

    expect(result.slots[0]?.explanation).toBe('schema-valid orientation');
    expect(result.slots[1]?.explanation).toBe('accepted mechanism');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    expect(repairBody.messages.at(-1)?.content).toContain('L2');
    expect(repairBody.messages.at(-1)?.content).toContain('frozen');
  });

  it('repairs missing/unknown Lesson identities without allowing new authority', async () => {
    const first = {
      slots: [lessonPayload().slots[0], { ...lessonPayload().slots[1], slotId: 'L9' }],
    };
    const repaired = lessonPayload('provider tried to rewrite orientation', 'accepted mechanism');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
    });

    expect(result.slots.map((slot) => slot.slotId)).toEqual(['L1', 'L2']);
    expect(result.slots[0]?.explanation).toBe('original valid orientation');
  });

  it('T6 repairs reordered Lesson inventory as a whole and restores exact skeleton order', async () => {
    const first = lessonPayload();
    first.slots.reverse();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(JSON.stringify(lessonPayload()))) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: (candidate) => {
        const parsed = LessonSlotContentProposalPayloadSchema.parse(candidate);
        return parsed.slots.map((slot) => slot.slotId).join(',') === 'L1,L2'
          ? { valid: true, diagnostics: [] }
          : {
              valid: false,
              diagnostics: ['Lesson slots do not preserve the immutable skeleton order.'],
              diagnosticCodes: ['lesson_slot_order_mismatch'],
            };
      },
    });

    expect(result.slots.map((slot) => slot.slotId)).toEqual(['L1', 'L2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('repairs a Lesson source selection outside its exact slot authority', async () => {
    const first = lessonPayload();
    first.slots[1]!.sourceRefs = ['S9'];
    first.slots[1]!.semanticRelations[0]!.sourceRefs = ['S9'];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ slots: [lessonPayload().slots[1]] })),
      ) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
    });

    expect(result.slots[0]?.explanation).toBe('original valid orientation');
    expect(result.slots[1]?.sourceRefs).toEqual(['S1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('freezes valid Practice and never returns or mutates accepted Lesson content', async () => {
    const first = practicePayload('original valid capability', 'invalid capability');
    const repaired = practicePayload('provider tried to rewrite PR1', 'accepted capability');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(JSON.stringify(repaired))) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generatePracticeContent(practiceInput(), {
      validateCandidate: practiceValidation,
    });

    expect(result.items[0]?.capabilityTested).toBe('original valid capability');
    expect(result.items[1]?.capabilityTested).toBe('accepted capability');
    expect(result).not.toHaveProperty('acceptedLesson');
    expect(result).not.toHaveProperty('lesson');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('freezes valid Practice peers when one first-pass item is schema-invalid', async () => {
    const first = practicePayload('schema-valid capability', 'accepted capability') as unknown as {
      items: Array<Record<string, unknown>>;
    };
    first.items[1]!.visualRefs = 'V1';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ items: [practicePayload().items[1]] })),
      ) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generatePracticeContent(practiceInput(), {
      validateCandidate: practiceValidation,
    });

    expect(result.items[0]?.capabilityTested).toBe('schema-valid capability');
    expect(result.items[1]?.capabilityTested).toBe('accepted capability');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    expect(repairBody.messages.at(-1)?.content).toContain('PR2');
    expect(repairBody.messages.at(-1)?.content).toContain('frozen');
  });

  it('repairs a Practice source selection outside its exact slot authority', async () => {
    const first = practicePayload();
    first.items[1]!.sourceRefs = ['S9'];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ items: [practicePayload().items[1]] })),
      ) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generatePracticeContent(practiceInput(), {
      validateCandidate: practiceValidation,
    });

    expect(result.items[0]?.capabilityTested).toBe('original valid capability');
    expect(result.items[1]?.sourceRefs).toEqual(['S1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('T1/T2 normalizes optional nulls and mechanical omissions before any repair request', async () => {
    const first = lessonPayload() as unknown as {
      narrative: Record<string, unknown>;
      slots: Array<Record<string, unknown>>;
    };
    delete first.narrative.forwardBridge;
    delete first.slots[0]!.visualRefs;
    delete first.slots[0]!.semanticRelations;
    delete first.slots[0]!.workedProcess;
    first.slots[0]!.example = null;
    first.slots[0]!.contrast = null;
    first.slots[0]!.misconception = null;
    first.slots[0]!.informalCheck = null;
    const diagnostics: Array<{
      normalizationRan?: boolean;
      normalizationActions?: Array<{ code: string; paths: string[] }>;
    }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first))) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.slots[0]).toMatchObject({
      slotId: 'L1',
      visualRefs: [],
      semanticRelations: [],
      workedProcess: null,
    });
    expect(result.slots[0]).not.toHaveProperty('example');
    expect(diagnostics[0]).toMatchObject({ normalizationRan: true });
    expect(diagnostics[0]!.normalizationActions!.map((action) => action.code)).toEqual(
      expect.arrayContaining([
        'optional_null_omitted',
        'empty_array_defaulted',
        'nullable_field_defaulted',
      ]),
    );
  });

  it('T3 does not normalize a missing substantive explanation or source selection', async () => {
    const first = lessonPayload() as unknown as { slots: Array<Record<string, unknown>> };
    delete first.slots[1]!.explanation;
    delete first.slots[1]!.sourceRefs;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ slots: [lessonPayload().slots[1]] })),
      ) as unknown as typeof fetch;
    const diagnostics: Array<{ schemaIssues: Array<{ path: string }> }> = [];

    await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate: lessonValidation,
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics[0]!.schemaIssues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['slots.1.explanation', 'slots.1.sourceRefs']),
    );
  });

  it('T5/T6 permits one narrow alias follow-up after structural repair and freezes all other data', async () => {
    const first = lessonPayload('frozen orientation', 'invalid mechanism') as unknown as {
      slots: Array<Record<string, unknown>>;
    };
    first.slots[1]!.sourceRefs = 'S1';
    const aliasRepair = {
      slots: [
        {
          ...lessonPayload().slots[1],
          explanation: 'The accepted mechanism follows from S1.',
        },
      ],
    };
    const cleanRepair = {
      slots: [
        {
          slotId: 'L2',
          explanation: 'The accepted mechanism follows from the cited course material.',
          sourceRefs: ['S9'],
          workedProcess: {
            startingState: 'Provider tried to replace unrelated valid R1.3 content.',
          },
        },
      ],
    };
    const recoveryActions: string[] = [];
    const diagnostics: Array<{
      attemptKind: string;
      semanticIssueCodes?: string[];
      recoveryAction?: string;
      localizedRepair?: boolean;
      affectedComponents?: string[];
    }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(JSON.stringify(aliasRepair)))
      .mockResolvedValueOnce(response(JSON.stringify(cleanRepair))) as unknown as typeof fetch;
    const validateCandidate = (candidate: unknown): ProviderCandidateValidation => {
      const parsed = LessonSlotContentProposalPayloadSchema.parse(candidate);
      const ids = parsed.slots.map((slot) => slot.slotId);
      if (ids.join(',') !== 'L1,L2') {
        return {
          valid: false,
          diagnostics: ['Immutable Lesson inventory is incomplete.'],
          diagnosticCodes: ['missing_lesson_slot'],
          targetedRepair: { invalidItemIds: ['L1', 'L2'] },
        };
      }
      const slot = parsed.slots[1]!;
      if (/\bS1\b/u.test(slot.explanation)) {
        return {
          valid: false,
          diagnostics: ['L2 exposes an internal source alias.'],
          diagnosticCodes: ['lesson_internal_alias_leak'],
          targetedRepair: {
            invalidItemIds: ['L2'],
            localizedTextRepair: {
              rootNarrative: false,
              items: [{ itemId: 'L2', components: ['explanation'] }],
            },
          },
        };
      }
      return slot.explanation.includes('cited course material') &&
        slot.sourceRefs.join(',') === 'S1' &&
        slot.semanticRelations.length === 1
        ? { valid: true, diagnostics: [] }
        : {
            valid: false,
            diagnostics: ['Alias repair changed immutable valid data.'],
            diagnosticCodes: ['lesson_slot_invalid'],
          };
    };

    const result = await hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
      validateCandidate,
      onRepairAttempt: (_reason, _category, action) => recoveryActions.push(action ?? 'none'),
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(MAX_COMPOSITIONAL_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL);
    expect(recoveryActions).toEqual(['targeted_repair', 'localized_alias_repair']);
    expect(result.slots.map((slot) => slot.slotId)).toEqual(['L1', 'L2']);
    expect(result.slots[0]!.explanation).toBe('frozen orientation');
    expect(result.slots[1]).toMatchObject({
      explanation: 'The accepted mechanism follows from the cited course material.',
      sourceRefs: ['S1'],
    });
    expect(result.slots[1]!.semanticRelations).toHaveLength(1);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptKind: 'repair',
          semanticIssueCodes: ['lesson_internal_alias_leak'],
          recoveryAction: 'localized_alias_repair',
          localizedRepair: true,
          affectedComponents: ['L2.explanation'],
        }),
      ]),
    );
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const thirdBody = JSON.parse(String(calls[2]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(thirdBody.messages.at(-1)!.content).toContain('L1, L2');
    expect(thirdBody.messages.at(-1)!.content).toContain('L2.explanation');
    expect(thirdBody.messages.at(-1)!.content).toContain(
      'local code will ignore all other changes',
    );
  });

  it('T7 rejects a repair that drops immutable Practice slot PR1', async () => {
    const first = practicePayload('invalid capability', 'accepted capability');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        response(JSON.stringify({ items: [practicePayload().items[1]] })),
      ) as unknown as typeof fetch;
    const validateCandidate = (candidate: unknown): ProviderCandidateValidation => {
      const parsed = PracticeContentProposalPayloadSchema.parse(candidate);
      const ids = parsed.items.map((item) => item.practiceSlotId);
      const missing = ['PR1', 'PR2'].filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        return {
          valid: false,
          diagnostics: [`Missing immutable Practice slot ${missing[0]}.`],
          diagnosticCodes: ['missing_practice_slot'],
          targetedRepair: { invalidItemIds: missing },
        };
      }
      return parsed.items[0]!.capabilityTested === 'accepted capability'
        ? { valid: true, diagnostics: [] }
        : {
            valid: false,
            diagnostics: ['Repair PR1.'],
            diagnosticCodes: ['practice_slot_invalid'],
            targetedRepair: { invalidItemIds: ['PR1'] },
          };
    };

    await expect(
      hy3(fetchImpl).generatePracticeContent(practiceInput(), { validateCandidate }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        structuredFailure: {
          preparationFailure: {
            failureClass: 'STRUCTURAL',
            failureCode: 'missing_immutable_slot',
          },
          recoveryAction: 'exhausted',
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('T7 treats reordered Practice inventory as a whole-collection structural failure', () => {
    const reordered = practicePayload();
    reordered.items.reverse();

    const result = validatePracticeContentCandidate(reordered, practiceInput());

    expect(result.diagnosticCodes).toContain('practice_slot_order_mismatch');
    expect(result.targetedRepair).toBeUndefined();
  });

  it('T8 cleanly regenerates truncated output without treating partial bytes as repair context', async () => {
    const partial = '{"items":[{"practiceSlotId":"PR1","capabilityTested":"UNIQUE_PARTIAL_BYTES"';
    const recoveryActions: string[] = [];
    const diagnostics: Array<{
      attemptKind: string;
      preparationFailure?: { failureClass: string; failureCode: string };
      recoveryAction?: string;
    }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(partial, 'length'))
      .mockResolvedValueOnce(
        response(JSON.stringify(practicePayload())),
      ) as unknown as typeof fetch;

    const result = await hy3(fetchImpl).generatePracticeContent(practiceInput(), {
      validateCandidate: practiceValidation,
      onRepairAttempt: (_reason, _category, action) => recoveryActions.push(action ?? 'none'),
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.items.map((item) => item.practiceSlotId)).toEqual(['PR1', 'PR2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recoveryActions).toEqual(['clean_regeneration']);
    expect(diagnostics[0]).toMatchObject({
      attemptKind: 'original',
      preparationFailure: { failureClass: 'OUTPUT', failureCode: 'truncated_output' },
      recoveryAction: 'clean_regeneration',
    });
    expect(diagnostics[1]).toMatchObject({ attemptKind: 'retry' });
    const secondBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const secondPrompt = secondBody.messages.map((message) => message.content).join('\n');
    expect(secondPrompt).not.toContain('UNIQUE_PARTIAL_BYTES');
    expect(secondPrompt).toContain('Discard its partial bytes completely');
    expect(secondPrompt).toContain('PR1, PR2');
  });

  it('T8 treats structurally incomplete preparation JSON as truncation even without finish metadata', async () => {
    const recoveryActions: string[] = [];
    const diagnostics: Array<{
      possiblyIncomplete: boolean;
      preparationFailure?: { failureCode: string };
    }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('{"items":[{"practiceSlotId":"PR1"'))
      .mockResolvedValueOnce(
        response(JSON.stringify(practicePayload())),
      ) as unknown as typeof fetch;

    await hy3(fetchImpl).generatePracticeContent(practiceInput(), {
      validateCandidate: practiceValidation,
      onRepairAttempt: (_reason, _category, action) => recoveryActions.push(action ?? 'none'),
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(recoveryActions).toEqual(['clean_regeneration']);
    expect(diagnostics[0]).toMatchObject({
      possiblyIncomplete: true,
      preparationFailure: { failureCode: 'truncated_output' },
    });
  });

  it('T8/T14 exhausts after one clean regeneration even when it omits PR1', async () => {
    const partial = '{"items":[{"practiceSlotId":"PR1"';
    const diagnostics: Array<{ attemptKind: string; recoveryAction?: string }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(partial, 'length'))
      .mockResolvedValueOnce(
        response(JSON.stringify({ items: [practicePayload().items[1]] })),
      ) as unknown as typeof fetch;

    await expect(
      hy3(fetchImpl).generatePracticeContent(practiceInput(), {
        validateCandidate: (candidate) =>
          validatePracticeContentCandidate(candidate, practiceInput()),
        onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({ attemptKind: 'original', recoveryAction: 'clean_regeneration' }),
      expect.objectContaining({ attemptKind: 'retry', recoveryAction: 'exhausted' }),
    ]);
  });

  it('permits only original plus one compositional repair even when failure kinds differ', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('{"slots":'))
      .mockResolvedValueOnce(
        response(JSON.stringify(lessonPayload('valid', 'still invalid'))),
      ) as unknown as typeof fetch;

    await expect(
      hy3(fetchImpl).generateLessonSlotContent(lessonInput(), {
        validateCandidate: lessonValidation,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps Fake and Hy3 compositional contracts compatible', async () => {
    const provider = new FakeProvider();
    const lesson = await provider.generateLessonSlotContent(lessonInput());
    const practice = await provider.generatePracticeContent({
      ...practiceInput(),
      acceptedLesson: lesson.slots,
    });

    expect(LessonSlotContentProposalPayloadSchema.safeParse(lesson).success).toBe(true);
    expect(PracticeContentProposalPayloadSchema.safeParse(practice).success).toBe(true);
    expect(lesson.slots.map((slot) => slot.slotId)).toEqual(['L1', 'L2']);
    expect(practice.items.map((item) => item.practiceSlotId)).toEqual(['PR1', 'PR2']);
    expect(lesson).not.toHaveProperty('practice');
    expect(practice.items[0]).not.toHaveProperty('objectiveRef');
    expect(practice.items[0]).not.toHaveProperty('construct');
    expect(practice.items[0]).not.toHaveProperty('authorityMode');
  });

  it('makes Fake apply content expose a staged worked interaction instead of a post-solution check', async () => {
    const provider = new FakeProvider();
    const input = applyLessonInput();
    const lesson = await provider.generateLessonSlotContent(input);
    const practice = await provider.generatePracticeContent({
      workspaceName: input.workspaceName,
      skeleton: input.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: input.sourceContext,
      visualContext: input.visualContext,
    });

    expect(lesson.narrative.whyNow).toContain('具体问题');
    expect(lesson.narrative.whyNow).toContain('从条件经过机制走向结果的心智模型');
    expect(lesson.narrative.summary).toContain('现在回到开头的问题');
    expect(lesson.slots[0]?.explanation).toContain('先抓住中心模型');
    expect(lesson.slots.find((slot) => slot.slotId === 'L2')?.workedProcess).toMatchObject({
      startingState: expect.any(String),
      inputs: expect.arrayContaining([expect.any(String)]),
      ruleOrProcedure: expect.stringContaining('启动时从空闲数扣除占用量'),
      steps: [
        expect.objectContaining({
          action: expect.any(String),
          reason: expect.any(String),
          resultingState: expect.any(String),
        }),
        expect.objectContaining({
          action: expect.any(String),
          reason: expect.any(String),
          resultingState: expect.any(String),
        }),
      ],
      result: expect.any(String),
      whyResultFollows: expect.stringContaining('超分配'),
      interaction: {
        pauseAfterStepIndex: 0,
        sourceRefs: [],
        activity: {
          prompt: expect.stringContaining('刚算出的快照'),
          reasoningOperation: 'predict_outcome',
          options: expect.arrayContaining([
            expect.objectContaining({ id: 'A', misconception: null }),
            expect.objectContaining({
              id: 'B',
              misconception: {
                hypothesis: expect.any(String),
                whyTempting: expect.any(String),
                correction: expect.any(String),
              },
            }),
          ]),
          correctDebrief: expect.any(String),
        },
        hint: expect.any(String),
        scaffold: { prompt: expect.any(String), correctOptionId: 'A' },
        transfer: {
          changedCondition: expect.stringContaining('备用处理器'),
          prompt: expect.any(String),
          correctOptionId: 'B',
        },
      },
    });
    expect(lesson.slots.find((slot) => slot.slotId === 'L2')?.example?.text).toContain(
      '观察中间状态怎样改变',
    );
    expect(lesson.slots.find((slot) => slot.slotId === 'L2')?.informalCheck).toBeUndefined();
    expect(
      evaluateLessonSlotPedagogy(lesson, input, {
        evaluatedAt: '2026-08-24T00:00:00.000Z',
      }),
    ).toMatchObject({ status: 'pass' });
    expect(practice.items[0]?.application).toMatchObject({
      startingState: expect.any(String),
      sourceRuleOrProcedure: expect.stringContaining('limited capacity'),
      decisionRequired: expect.any(String),
      expectedAction: expect.any(String),
    });
    expect(practice.items[0]?.initial.prompt).toContain(
      practice.items[0]!.application!.startingState,
    );
    expect(practice.items[0]?.initial.options[0]?.text).toBe(
      practice.items[0]!.application!.expectedAction,
    );
  });
});
