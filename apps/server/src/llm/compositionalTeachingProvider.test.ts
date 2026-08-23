import { describe, expect, it, vi } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  TeachingSkeletonSchema,
} from '@hy3-clinic/shared';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import { evaluateLessonSlotPedagogy } from '../services/lessonPedagogyEvaluator.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCandidateValidation,
} from './provider.js';

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
  return {
    workspaceName: lesson.workspaceName,
    skeleton: lesson.skeleton,
    acceptedLesson: LessonSlotContentProposalPayloadSchema.parse(lessonPayload()).slots,
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

function response(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
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
    };
    const practiceBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const lessonPrompt = lessonBody.messages.map((message) => message.content).join('\n');
    const practicePrompt = practiceBody.messages.map((message) => message.content).join('\n');
    expect(lessonPrompt).toContain('immutable Hy3 Study Clinic instructional spine');
    expect(lessonPrompt).toContain('semantic relation requires two distinct');
    expect(lessonPrompt).not.toContain('"practicePlan"');
    expect(lessonPrompt).not.toContain('"acceptedLesson"');
    expect(practicePrompt).toContain('already accepted Hy3 Study Clinic Lesson');
    expect(practicePrompt).toContain('"practicePlan"');
    expect(practicePrompt).toContain('"acceptedLesson"');
    expect(practicePrompt).toContain('never prove application');
    expect(schemaNames).toEqual([
      'lesson-slot-content-v1-compositional',
      'practice-content-v1-compositional',
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

  it('makes Fake apply content expose a worked process and a distinct pre-guidance action', async () => {
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

    expect(lesson.slots.find((slot) => slot.slotId === 'L2')?.workedProcess).toMatchObject({
      startingState: expect.any(String),
      ruleOrProcedure: expect.stringContaining('limited capacity'),
      result: expect.any(String),
      whyResultFollows: expect.any(String),
    });
    expect(lesson.slots.find((slot) => slot.slotId === 'L2')?.informalCheck).toMatchObject({
      kind: 'apply_simple_example',
      prompt: expect.stringContaining('choose the next action'),
      expectedSignal: expect.stringContaining('before coaching appears'),
    });
    expect(
      evaluateLessonSlotPedagogy(lesson, input, {
        evaluatedAt: '2026-08-24T00:00:00.000Z',
      }),
    ).toMatchObject({ status: 'pass', findings: [] });
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
