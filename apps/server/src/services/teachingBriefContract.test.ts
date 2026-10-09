import { describe, expect, it } from 'vitest';
import {
  TeachingBriefProposalPayloadSchema,
  type TeachingBriefSegment,
  type TeachingLessonSlotContent,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { lessonSlotContentMessages, practiceContentMessages } from '../llm/prompts.js';
import {
  validateLessonSlotContentCandidate,
  validatePracticeContentCandidate,
  validateTeachingBriefCandidate,
} from './teachingBriefContract.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';
import { evaluateLessonSlotPedagogy } from './lessonPedagogyEvaluator.js';
import { prepareLessonGroundingReview } from './lessonGrounding.js';
import { FAKE_LESSON_MATH_SOURCE } from '../llm/fakeLessonFixtures.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';

function input(): TeachingBriefGenerationInput {
  return {
    workspaceName: 'Course',
    learningUnit: {
      title: 'Unit',
      objectives: [
        {
          objectiveRef: 'O1',
          title: 'Objective mechanism',
          description: 'Explain how the objective mechanism works.',
          priority: 'required',
          construct: 'explain',
          authorityEnvelopeTier: 'teaching_only',
          practiceAuthority: 'exact_teaching',
        },
      ],
      concepts: [],
      canonicalConcepts: [],
    },
    prerequisites: [{ prerequisiteRef: 'P1', title: 'Prior unit', objectiveSummaries: [] }],
    nextConnection: null,
    sourceContext: {
      fingerprint: 'context_1',
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 10,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Material',
          headingPath: ['Section'],
          pageNumber: null,
          slideNumber: null,
          text: 'Source.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
    plannedMinutes: 20,
  };
}

function payload() {
  return TeachingBriefProposalPayloadSchema.parse({
    whyNow: 'It is next.',
    prerequisites: [{ prerequisiteRef: 'P1', reason: 'Needed.', readinessHint: null }],
    segments: [
      {
        purpose: 'objective_orientation',
        objectiveRefs: ['O1'],
        explanation: 'Learn the Objective mechanism now because later decisions depend on it.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [],
      },
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation:
          'The Objective mechanism works because the source condition controls the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'mechanism',
        objectiveRefs: ['O1'],
        explanation:
          'When the source condition holds, the Objective mechanism therefore changes the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'worked_example',
        objectiveRefs: ['O1'],
        explanation:
          'First inspect the condition, then trace its effect, and finally justify the result.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        example: {
          text: 'Given a small case, first mark the condition, next infer the consequence, then state the result.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'contrast',
        objectiveRefs: ['O1'],
        explanation:
          'Compare causal Objective reasoning with a surface label that does not explain why.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        contrast: {
          text: 'One account uses the condition; the other only repeats vocabulary.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'guided_practice',
        objectiveRefs: ['O1'],
        explanation:
          'Explain why the Objective condition controls a new case, then commit your reasoning.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        informalCheck: {
          kind: 'own_words',
          prompt: 'Explain how the Objective mechanism controls the result.',
          expectedSignal: 'Connect the condition to the result.',
        },
      },
    ],
    formalOpportunities: ['A later assessment can attach here.'],
    summary: 'Summary.',
    nextConnection: null,
    practice: {
      items: [
        {
          objectiveRef: 'O1',
          construct: 'explain',
          capabilityTested: 'Explain the Objective mechanism from condition to result.',
          pedagogicalReason: 'This checks causal explanation rather than source-location recall.',
          authority: 'exact_source',
          sourceRefs: ['S1'],
          visualRefs: [],
          initial: {
            prompt:
              'Which explanation best shows how and why the Objective mechanism changes the result?',
            options: [
              {
                optionRef: 'A',
                text: 'It traces the condition to its consequence.',
                feedbackIfSelected: 'Correct.',
              },
              {
                optionRef: 'B',
                text: 'It repeats the label.',
                feedbackIfSelected: 'Surface recall.',
              },
              {
                optionRef: 'C',
                text: 'It ignores the condition.',
                feedbackIfSelected: 'Missing cause.',
              },
            ],
            correctOptionRef: 'A',
            hint: 'Look for causal reasoning.',
            explanation: 'The condition explains the consequence.',
          },
          retry: {
            prompt:
              'In a changed case, which account best explains why the Objective result must be narrowed?',
            options: [
              {
                optionRef: 'A',
                text: 'The label looks similar.',
                feedbackIfSelected: 'Not causal.',
              },
              {
                optionRef: 'B',
                text: 'A required condition changed.',
                feedbackIfSelected: 'Correct.',
              },
              { optionRef: 'C', text: 'The page is longer.', feedbackIfSelected: 'Irrelevant.' },
            ],
            correctOptionRef: 'B',
            hint: 'Inspect the changed condition.',
            explanation: 'Changed conditions change the supported conclusion.',
          },
        },
      ],
    },
  });
}

describe('Teaching Brief provider candidate validation', () => {
  it('accepts offered refs and complete objective coverage', () => {
    expect(validateTeachingBriefCandidate(payload(), input())).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('rejects unknown source/objective/prerequisite refs and unsupported claims', () => {
    const invalid = payload();
    invalid.prerequisites[0]!.prerequisiteRef = 'P9';
    invalid.segments[0]!.objectiveRefs = ['O9'];
    invalid.segments[0]!.sourceRefs = ['S9'];
    const result = validateTeachingBriefCandidate(invalid, input());
    expect(result.valid).toBe(false);
    expect(result.diagnosticCodes).toEqual(
      expect.arrayContaining([
        'unknown_prerequisite_ref',
        'unknown_objective_ref',
        'unknown_source_ref',
      ]),
    );
  });

  it('rejects duplicated teaching intents and a sequence without source references', () => {
    const invalid = payload();
    invalid.segments = [
      { ...invalid.segments[0]!, explanationAuthority: 'ai_teaching_synthesis', sourceRefs: [] },
      { ...invalid.segments[0]!, explanationAuthority: 'ai_teaching_synthesis', sourceRefs: [] },
    ];
    const result = validateTeachingBriefCandidate(invalid, input());
    expect(result.diagnosticCodes).toEqual(
      expect.arrayContaining(['duplicate_teaching_intent', 'no_source_backed_segment']),
    );
  });
});

describe('Teaching Brief quality profile', () => {
  it('reports structural dimensions and explicit nonclaims without a universal score', () => {
    const segments: TeachingBriefSegment[] = [
      {
        index: 0,
        purpose: 'explanation',
        objectiveIds: ['objective_1'],
        explanation: 'Explain.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefIds: ['S1'],
        example: { text: 'Example.', authority: 'ai_teaching_synthesis', sourceRefIds: [] },
        contrast: { text: 'Contrast.', authority: 'ai_teaching_synthesis', sourceRefIds: [] },
        informalCheck: { kind: 'own_words', prompt: 'Explain.', expectedSignal: null },
      },
    ];
    const profile = profileTeachingBrief({
      objectiveIds: ['objective_1'],
      segments,
      sourceReferences: [
        {
          refId: 'S1',
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          sourceBlockId: 'block_1',
          sourceBlockRevisionFingerprint: 'block_fp',
          startOffset: 0,
          endOffset: 7,
          quote: 'Source.',
          headingPath: [],
          pageNumber: null,
        },
      ],
      prerequisiteCount: 1,
      formalOpportunityCount: 1,
      summary: 'Summary.',
      nextConnection: null,
    });
    expect(profile).toMatchObject({
      objectiveCoverage: 1,
      sourceBackedSegmentRatio: 1,
      exampleCount: 1,
      contrastCount: 1,
      informalCheckCount: 1,
      unsupportedSourceRefCount: 0,
    });
    expect(profile.nonclaims.join(' ')).toContain('does not prove teaching effectiveness');
    expect(profile).not.toHaveProperty('score');
  });
});

function compositionalContractInput(
  construct: 'explain' | 'apply' = 'explain',
): LessonSlotContentGenerationInput {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: 'Bounded retrieval',
    targetMinutes: 18,
    targetDepth: 'pass_oriented',
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain bounded retrieval',
        description:
          'Explain how a retrieval condition controls candidate eligibility and the returned result.',
        priority: 'required',
        construct,
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1', 'S2'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    workspaceName: 'Course',
    learnerLocale: 'zh-CN',
    skeleton,
    sourceContext: {
      fingerprint: 'context_contract',
      blockCount: 2,
      offerCount: 2,
      serializedBytes: 500,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Retrieval notes',
          headingPath: ['Mechanism'],
          pageNumber: 1,
          slideNumber: null,
          text: 'A retrieval condition is checked against each candidate, and candidates that fail the condition are excluded.',
          authorizedObjectiveRefs: ['O1'],
        },
        {
          sourceRef: 'S2',
          materialTitle: 'Retrieval notes',
          headingPath: ['Result'],
          pageNumber: 2,
          slideNumber: null,
          text: 'The remaining eligible candidate is returned as the bounded retrieval result.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
    learningContext: {
      concepts: [],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
}

function lessonContractPrompt(
  desiredDepth: NonNullable<LessonSlotContentGenerationInput['courseDesign']>['desiredDepth'],
  unitFocus: 'normal' | 'focused' = 'normal',
): string {
  return lessonSlotContentMessages({
    ...compositionalContractInput(),
    courseDesign: { desiredDepth, unitFocus },
  })
    .map((message) => message.content)
    .join('\n');
}

describe('compositional provider candidate validation', () => {
  it('admits an eleven-slot high-warning Lesson with actual Fake grounding and retains late hard defects', async () => {
    const provider = new FakeProvider();
    const input = compositionalContractInput('apply');
    const objectives = Array.from({ length: 5 }, (_, index) => ({
      ...input.skeleton.objectives[0]!,
      objectiveRef: `O${index + 1}`,
    }));
    input.skeleton = planTeachingSkeleton({
      learningUnitTitle: input.skeleton.learningUnitTitle,
      targetMinutes: 80,
      targetDepth: 'working_fluency',
      objectives,
    });
    input.courseDesign = { desiredDepth: 'working_fluency', unitFocus: 'focused' };
    for (const offer of input.sourceContext.offers) {
      offer.authorizedObjectiveRefs = objectives.map((objective) => objective.objectiveRef);
      offer.text +=
        ' 根据资料，O1 denotes a tree whose global depth is two. “Prompt instructions guarantee models never fabricate answers” is false.';
    }
    const lesson = await provider.generateLessonSlotContent(input);
    expect(lesson.slots).toHaveLength(11);
    for (const slot of lesson.slots) {
      slot.semanticRelations = [];
      if (slot.workedProcess) slot.workedProcess.learnerDecision = null;
      const interaction = slot.workedProcess?.interaction;
      for (const action of [
        slot.informalCheck,
        interaction?.activity,
        interaction?.scaffold,
        interaction?.transfer,
      ]) {
        if (!action) continue;
        delete action.reasoningOperation;
        delete action.requiredInference;
        delete action.evidenceContrast;
        if ('decisiveCondition' in action) delete action.decisiveCondition;
      }
      if (interaction) {
        interaction.scaffold.options[0]!.feedbackIfSelected = '对。';
      }
    }
    const evaluate = () =>
      evaluateLessonSlotPedagogy(lesson, input, { evaluatedAt: '2026-01-01T00:00:00.000Z' });
    const evaluation = evaluate();
    expect(evaluation.status).toBe('pass');
    expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(
      evaluation.findings.reduce((count, finding) => count + (finding.occurrenceCount ?? 1), 0),
    ).toBe(102);
    expect(evaluation.findings.length).toBeLessThanOrEqual(100);
    expect(validateLessonSlotContentCandidate(lesson, input).valid).toBe(true);
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toEqual([]);

    // This error is appended by the slot checks after the large warning inventory.
    const lastIndex = lesson.slots.length - 1;
    lesson.slots[lastIndex]!.semanticRelations = [
      {
        kind: 'difference_discrimination',
        fromProposition: 'The eligibility condition excludes a failing candidate.',
        toProposition: 'The remaining candidate is returned.',
        relevanceToObjective: 'O99',
        sourceRefs: ['S1'],
      },
    ];
    lesson.slots[lastIndex]!.workedProcess = structuredClone(
      lesson.slots.find((slot) => slot.workedProcess)!.workedProcess,
    );
    const invalid = evaluate();
    expect(invalid.status).toBe('fail');
    expect(invalid.findings).toContainEqual(
      expect.objectContaining({
        code: 'relation_objective_reference_outside_slot',
        severity: 'error',
        segmentIndexes: [lastIndex],
      }),
    );
    expect(invalid.findings).toContainEqual(
      expect.objectContaining({
        code: 'unplanned_worked_process',
        severity: 'error',
        segmentIndexes: [lastIndex],
      }),
    );
    const admission = validateLessonSlotContentCandidate(lesson, input);
    expect(admission.valid).toBe(false);
    expect(admission.diagnosticCodes).toContain('relation_objective_reference_outside_slot');
  });

  it('allows uncited supplementary teaching while still rejecting foreign citation aliases', async () => {
    const input = compositionalContractInput();
    const provider = new FakeProvider();
    const lesson = await provider.generateLessonSlotContent(input);
    const clearSources = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'sourceRefs') (value as Record<string, unknown>)[key] = [];
        else clearSources(child);
      }
    };
    clearSources(lesson);
    expect(validateLessonSlotContentCandidate(lesson, input).valid).toBe(true);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: input.workspaceName,
      learnerLocale: input.learnerLocale,
      skeleton: input.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: input.sourceContext,
      visualContext: input.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    clearSources(practice);
    expect(validatePracticeContentCandidate(practice, practiceInput).valid).toBe(true);
    practice.items[0]!.sourceRefs = ['S99'];
    expect(validatePracticeContentCandidate(practice, practiceInput).diagnosticCodes).toContain(
      'practice_source_alias_outside_slot_authority',
    );
    lesson.slots[0]!.sourceRefs = ['S99'];
    expect(validateLessonSlotContentCandidate(lesson, input).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );
  });

  it('prompts for the minimum sufficient worked-process contract without a duplicate relation', () => {
    const prompt = lessonSlotContentMessages(compositionalContractInput())
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('Every declared interaction requires explicit inputs');
    expect(prompt).toContain('Typed semantic relations are optional');
    expect(prompt).toContain(
      'A correct worked example plus an ordinary informalCheck is also supported',
    );
    expect(prompt).toContain('withhold its result until the guided response');
    expect(prompt).toContain('hypothesis, whyTempting and correction');
    expect(prompt).toContain('Hint/scaffold are delayed until a wrong guided response');
    expect(prompt).toContain('must not disclose an unanswered scaffold or future transfer result');
    expect(prompt).toContain('No live generation during interaction');
    expect(prompt).toContain('component-level sourceRefs independently');
    expect(prompt).toContain('keep interaction.sourceRefs empty');
    expect(prompt).toContain('An ordinary action is also valid there');
    expect(prompt).toContain('Keep ownership fixed');
    expect(prompt).not.toContain('worked_process needs both a semantic relation');
  });

  it('T1/T2 prioritizes a private whole-Lesson pedagogical arc and central mental model', () => {
    const prompt = lessonContractPrompt('working_fluency');

    expect(prompt).toContain('Objectives are mandatory teaching obligations');
    expect(prompt).toContain('They are not the learner-facing Lesson outline');
    expect(prompt).toContain('whole-Lesson pedagogical arc determines how the learner is taught');
    expect(prompt).toContain('do not recite Objective 1, then Objective 2, then Objective 3');
    expect(prompt).toContain('privately design one coherent learner-facing pedagogical arc');
    expect(prompt).toContain('concrete problem, situation, question, surprising behavior');
    expect(prompt).toContain('useful central mental model');
    expect(prompt).toContain('work through a concrete journey');
    expect(prompt).toContain('abstract that journey back to the general concept');
    expect(prompt).toContain('test a boundary or nearby contrast');
    expect(prompt).toContain('repair a plausible misconception or failure mode');
    expect(prompt).toContain('changed-situation transfer or prediction');
    expect(prompt).toContain('pedagogical functions, not mandatory cards or headings');
    expect(prompt).toContain('Do not output this planning object');
    expect(prompt).toContain('signal the core idea');
    expect(prompt).toContain('revisit the anchor after explaining the mechanism');
  });

  it('T3-T5 prefers a useful worked trace without making prose length a correctness requirement', () => {
    const prompt = lessonContractPrompt('working_fluency');

    expect(prompt).toContain(
      'every required objective needs at least one reasoning-class Lesson action',
    );
    expect(prompt).toContain('with a withheld inference');
    expect(prompt).toContain('mechanisms and causal relationships');
    expect(prompt).toContain('plausible competing model');
    expect(prompt).toContain('transfer and Practice initial must be reasoning-class');
    expect(prompt).toContain('Prefer a useful trace with explicit inputs');
    expect(prompt).toContain(
      'Concise truthful examples and state-preserving verification are valid',
    );
    expect(prompt).toContain('Every declared interaction requires explicit inputs');
    expect(prompt).toContain('process, mechanism, causal chain, architecture, workflow');
    expect(prompt).toContain('trace at least one concrete instance end to end');
    expect(prompt).toContain(
      'worked comparison, concrete reasoning case, counterexample, boundary case',
    );
    expect(prompt).toContain('Teach causality with the reveal order');
    expect(prompt).toContain('Fact -> mechanism -> learner inference -> consequence');
    expect(prompt).not.toContain('user query ->');
  });

  it('T6/T7 actively uses supplementary teaching without granting it source or Formal authority', () => {
    const prompt = lessonContractPrompt('working_fluency');

    expect(prompt).toContain('too terse to establish the mental model');
    expect(prompt).toContain('SHOULD add relevant Hy3 supplementary teaching');
    expect(prompt).toContain('keeps sourceRefs empty');
    expect(prompt).toContain('never presented as quoted material or Formal authority');
    expect(prompt).toContain('Do not generate Practice, grading, Formal Evidence, mastery');
  });

  it('T8/T9 gives focus more useful investment while rejecting length as a proxy', () => {
    const normalPrompt = lessonContractPrompt('working_fluency');
    const focusedPrompt = lessonContractPrompt('working_fluency', 'focused');

    expect(focusedPrompt).toContain('same global desiredDepth');
    expect(focusedPrompt).toContain('never depth + 1');
    expect(focusedPrompt).toContain('Focus is angle coverage');
    expect(focusedPrompt).toContain('preserve the required worked interaction');
    expect(focusedPrompt).toContain('at least three reasoning operations');
    expect(focusedPrompt).toContain(
      'diagnose_cause or identify_missing AND choose_design or judge_tradeoff',
    );
    expect(focusedPrompt).toContain('Transfer changes a component, field, scale');
    expect(focusedPrompt).toContain('Practice can supply missing Lesson angles');
    expect(focusedPrompt).toContain('Focus grants no truth, citation, Formal, credit, or mastery');
    expect(focusedPrompt).toContain('Teaching depth is not a length proxy');
    expect(focusedPrompt).toContain('one excellent worked case');
    expect(focusedPrompt).toContain('over repeated definitions, generic examples, extra headings');
    expect(normalPrompt).not.toContain('FOCUSED UNIT');
  });

  it('T10/T11 prefers useful reasoning without granting operation coverage hard authority', () => {
    const lessonInput = {
      ...compositionalContractInput(),
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'focused' },
    } satisfies LessonSlotContentGenerationInput;
    const lessonPrompt = lessonSlotContentMessages(lessonInput)
      .map((message) => message.content)
      .join('\n');

    expect(lessonPrompt).toContain('already planned learnerActionRequired slots');
    expect(lessonPrompt).toContain('prefer reasoning and transfer beyond recognition when useful');
    expect(lessonPrompt).toContain('Operation coverage is a quality goal');
    expect(lessonPrompt).toContain('do not add slots or length merely to satisfy it');
    expect(lessonPrompt).toContain('Do not simply restate the exact worked case in its check');
    expect(lessonPrompt).toContain('scenario A');
    expect(lessonPrompt).toContain('scenario B, a changed variable, a removed stage');
    expect(lessonPrompt).toContain('Do not add extra checks merely for quantity');

    const acceptedLesson = [
      {
        slotId: 'L1',
        explanation: '一个已接受的讲解。',
        sourceRefs: [],
        visualRefs: [],
        semanticRelations: [],
        workedProcess: null,
      },
    ] satisfies PracticeContentGenerationInput['acceptedLesson'];
    const practicePrompt = practiceContentMessages({
      workspaceName: lessonInput.workspaceName,
      learnerLocale: lessonInput.learnerLocale,
      courseDesign: lessonInput.courseDesign,
      skeleton: lessonInput.skeleton,
      acceptedLesson,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    })
      .map((message) => message.content)
      .join('\n');
    expect(practicePrompt).toContain('Do not replay the same publicly exposed deciding case');
    expect(practicePrompt).toContain('use a materially changed scenario');
    expect(practicePrompt).toContain(
      'materially changed retry scenario—not merely changed wording',
    );
  });

  it('propagates zh-CN as a generation contract without adding a lexical hard gate', async () => {
    const provider = new FakeProvider();
    const lessonInput = {
      ...compositionalContractInput(),
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'focused' },
    } satisfies LessonSlotContentGenerationInput;
    const lessonPrompt = lessonSlotContentMessages(lessonInput)
      .map((message) => message.content)
      .join('\n');
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput = {
      workspaceName: lessonInput.workspaceName,
      learnerLocale: lessonInput.learnerLocale,
      courseDesign: lessonInput.courseDesign,
      skeleton: lessonInput.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    } satisfies PracticeContentGenerationInput;
    const practicePrompt = practiceContentMessages(practiceInput)
      .map((message) => message.content)
      .join('\n');

    for (const prompt of [lessonPrompt, practicePrompt]) {
      expect(prompt).toContain('LEARNER LANGUAGE (zh-CN)');
      expect(prompt).toContain('natural Simplified Chinese');
      expect(prompt).toContain('Do not drift into Traditional Chinese');
      expect(prompt).toContain('generation responsibility');
    }
    expect(lessonPrompt).toContain('inline-check prompts/options/feedback');
    expect(practicePrompt).toContain('both attempts and all option-contingent feedback');
    expect(lessonInput.learnerLocale).toBe('zh-CN');
    expect(practiceInput.learnerLocale).toBe('zh-CN');
  });

  it('accepts Fake Lesson then Practice content inside the immutable plans', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    expect(validateLessonSlotContentCandidate(lesson, lessonInput)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      learnerLocale: 'zh-CN',
      skeleton: lessonInput.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    expect(validatePracticeContentCandidate(practice, practiceInput)).toEqual({
      valid: true,
      diagnostics: [],
      diagnosticCodes: [],
    });
  });

  it('accepts optional Lesson annotations and concise truthful feedback with actual Fake grounding', async () => {
    const provider = new FakeProvider();
    const input = {
      ...compositionalContractInput('apply'),
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'normal' } as const,
    };
    const lesson = await provider.generateLessonSlotContent(input);
    for (const slot of lesson.slots) {
      slot.semanticRelations = [];
      if (slot.workedProcess) slot.workedProcess.learnerDecision = null;
      const interaction = slot.workedProcess?.interaction;
      for (const action of [
        slot.informalCheck,
        interaction?.activity,
        interaction?.scaffold,
        interaction?.transfer,
      ]) {
        if (!action) continue;
        delete action.reasoningOperation;
        delete action.requiredInference;
        delete action.evidenceContrast;
        if ('decisiveCondition' in action) delete action.decisiveCondition;
      }
    }
    const slot = lesson.slots.find((slot) => slot.workedProcess)!;
    const scaffold = slot.workedProcess!.interaction!.scaffold;
    scaffold.options[0]!.feedbackIfSelected = '对。';
    expect(validateLessonSlotContentCandidate(lesson, input).valid).toBe(true);
    const evaluation = evaluateLessonSlotPedagogy(lesson, input, {
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(evaluation.status).toBe('pass');
    expect(evaluation.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_reasoning_declaration', severity: 'warning' }),
    );
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toEqual([]);
    for (const feedback of ['不对。', '3减2等于2。']) {
      scaffold.options[0]!.feedbackIfSelected = feedback;
      expect(
        (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
          .findings,
      ).toContainEqual(expect.objectContaining({ itemId: slot.slotId }));
    }
    scaffold.correctOptionId = 'E';
    expect(validateLessonSlotContentCandidate(lesson, input).diagnosticCodes).toContain(
      'invalid_lesson_slot_content_shape',
    );
  });

  it('retains contextual vocabulary/guarantee advisories while grounding rejects a new unsupported claim', async () => {
    const provider = new FakeProvider();
    const input = compositionalContractInput();
    input.sourceContext.offers[0]!.text =
      '“Prompt instructions guarantee models never fabricate answers” is false. O1 denotes a tree whose global depth is two.';
    const lesson = await provider.generateLessonSlotContent(input);
    expect(validateLessonSlotContentCandidate(lesson, input).valid).toBe(true);
    const evaluation = evaluateLessonSlotPedagogy(lesson, input, {
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    });
    for (const code of [
      'lesson_internal_alias_leak',
      'lesson_planning_language_leak',
      'probabilistic_control_overclaimed',
    ])
      expect(evaluation.findings).toContainEqual(
        expect.objectContaining({ code, severity: 'warning' }),
      );
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toEqual([]);
    const slot = lesson.slots.find((slot) => slot.semanticRelations.length)!;
    slot.explanation += ' Prompt instructions guarantee models never fabricate answers.';
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toContainEqual(expect.objectContaining({ itemId: slot.slotId }));
    slot.sourceRefs = ['S9'];
    expect(validateLessonSlotContentCandidate(lesson, input).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );
  });

  it('accepts symbol-distinct concise mathematics while grounding rejects the reversed implication', async () => {
    const provider = new FakeProvider();
    const input = compositionalContractInput();
    input.sourceContext.offers[0]!.text = FAKE_LESSON_MATH_SOURCE;
    const lesson = await provider.generateLessonSlotContent(input);
    const planned = input.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!;
    const slot = lesson.slots.find((slot) => slot.slotId === planned.slotId)!;
    slot.semanticRelations = [
      {
        kind: 'condition_action',
        fromProposition: 'x>0',
        toProposition: 'x>=0',
        relevanceToObjective: planned.objectiveRefs[0]!,
        sourceRefs: [planned.allowedSourceRefs[0]!],
      },
    ];
    expect(validateLessonSlotContentCandidate(lesson, input).valid).toBe(true);
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toEqual([]);
    slot.semanticRelations[0]!.fromProposition = 'x>=0';
    slot.semanticRelations[0]!.toProposition = 'x>0';
    expect(
      (await provider.reviewTeachingContent(prepareLessonGroundingReview(input, lesson).input))
        .findings,
    ).toContainEqual(expect.objectContaining({ itemId: slot.slotId }));
  });

  it.each(['5.2×10^0', '2.4×10^1', '2.4×10^-1'])(
    'accepts complete scientific notation through the Lesson candidate contract: %s',
    async (result) => {
      const input = compositionalContractInput('apply');
      const candidate = await new FakeProvider().generateLessonSlotContent(input);
      candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!.result = result;
      expect(validateLessonSlotContentCandidate(candidate, input)).toEqual({
        valid: true,
        diagnostics: [],
        diagnosticCodes: [],
      });
    },
  );

  it.each(['5.2×10^', '10^^2', '×10^1'])(
    'leaves malformed mathematical claims to complete grounding: %s',
    async (result) => {
      const input = compositionalContractInput('apply');
      const candidate = await new FakeProvider().generateLessonSlotContent(input);
      const slot = candidate.slots.find((slot) => slot.workedProcess)!;
      slot.workedProcess!.result = result;
      const validation = validateLessonSlotContentCandidate(candidate, input);
      expect(validation.valid).toBe(true);
      const reviewed = await new FakeProvider().reviewTeachingContent(
        prepareLessonGroundingReview(input, candidate).input,
      );
      expect(reviewed.findings).toContainEqual(expect.objectContaining({ itemId: slot.slotId }));
    },
  );

  it.each([
    [
      'empty rule',
      'invalid_lesson_slot_content_shape',
      (slot: TeachingLessonSlotContent) => {
        slot.workedProcess!.ruleOrProcedure = '';
      },
    ],
    [
      'missing rule',
      'invalid_lesson_slot_content_shape',
      (slot: TeachingLessonSlotContent) => {
        Reflect.deleteProperty(slot.workedProcess!, 'ruleOrProcedure');
      },
    ],
    [
      'foreign source alias',
      'lesson_source_alias_outside_slot_authority',
      (slot: TeachingLessonSlotContent) => {
        slot.workedProcess!.sourceRefs = ['S9'];
      },
    ],
    [
      'unoffered answer key',
      'invalid_lesson_slot_content_shape',
      (slot: TeachingLessonSlotContent) => {
        slot.workedProcess!.interaction!.activity.correctOptionId = 'D';
      },
    ],
    [
      'duplicate option id',
      'invalid_lesson_slot_content_shape',
      (slot: TeachingLessonSlotContent) => {
        const options = slot.workedProcess!.interaction!.activity.options;
        options[1]!.id = options[0]!.id;
      },
    ],
  ] as const)(
    'keeps rejecting %s with a complete scientific notation result',
    async (_name, code, mutate) => {
      const input = compositionalContractInput('apply');
      const candidate = await new FakeProvider().generateLessonSlotContent(input);
      const slot = candidate.slots.find((slot) => slot.workedProcess)!;
      slot.workedProcess!.result = '5.2×10^0';
      expect(validateLessonSlotContentCandidate(candidate, input).valid).toBe(true);
      mutate(slot);
      const validation = validateLessonSlotContentCandidate(candidate, input);
      expect(validation.valid).toBe(false);
      expect(validation.diagnosticCodes).toContain(code);
      expect(validation.targetedRepair).toEqual({ invalidItemIds: [slot.slotId] });
      expect(validation.failureArtifact?.context).toMatchObject({
        frozenValidItemIds: input.skeleton.lessonSlots
          .map((planned) => planned.slotId)
          .filter((id) => id !== slot.slotId),
      });
    },
  );

  it('reports one invalid Lesson slot and freezes every unaffected stable slot', async () => {
    const input = compositionalContractInput();
    const candidate = await new FakeProvider().generateLessonSlotContent(input);
    const invalidSlotId = input.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!.slotId;
    candidate.slots.find((slot) => slot.slotId === invalidSlotId)!.sourceRefs = ['S9'];
    const result = validateLessonSlotContentCandidate(candidate, input);
    expect(result.valid).toBe(false);
    expect(result.diagnosticCodes).toContain('lesson_source_alias_outside_slot_authority');
    expect(result.targetedRepair).toEqual({ invalidItemIds: [invalidSlotId] });
    expect(result.failureArtifact?.context).toMatchObject({
      invalidItemIds: [invalidSlotId],
      frozenValidItemIds: input.skeleton.lessonSlots
        .map((slot) => slot.slotId)
        .filter((slotId) => slotId !== invalidSlotId),
    });
  });

  it('rejects missing, unknown, duplicate, and provider-authored local Lesson authority', async () => {
    const input = compositionalContractInput();
    const valid = await new FakeProvider().generateLessonSlotContent(input);
    const missingNarrative = structuredClone(valid);
    delete missingNarrative.narrative;
    expect(validateLessonSlotContentCandidate(missingNarrative, input).diagnosticCodes).toContain(
      'missing_lesson_narrative',
    );
    const missing = structuredClone(valid);
    const removedId = missing.slots.splice(1, 1)[0]!.slotId;
    expect(validateLessonSlotContentCandidate(missing, input).diagnosticCodes).toContain(
      'missing_lesson_slot',
    );

    const unknown = structuredClone(valid);
    unknown.slots[1]!.slotId = 'L99';
    expect(validateLessonSlotContentCandidate(unknown, input).diagnosticCodes).toEqual(
      expect.arrayContaining(['missing_lesson_slot', 'unknown_lesson_slot']),
    );

    const duplicate = structuredClone(valid);
    duplicate.slots.push(structuredClone(duplicate.slots[0]!));
    expect(validateLessonSlotContentCandidate(duplicate, input).diagnosticCodes).toContain(
      'duplicate_lesson_slot',
    );

    const reordered = structuredClone(valid);
    reordered.slots.reverse();
    const reorderedResult = validateLessonSlotContentCandidate(reordered, input);
    expect(reorderedResult.diagnosticCodes).toContain('lesson_slot_order_mismatch');
    expect(reorderedResult.targetedRepair).toBeUndefined();

    const mutation = structuredClone(valid) as unknown as {
      slots: Array<Record<string, unknown>>;
    };
    mutation.slots[1]!.construct = 'evaluate';
    const mutationResult = validateLessonSlotContentCandidate(mutation, input);
    expect(mutationResult.diagnosticCodes).toContain('lesson_attempted_local_authority_mutation');
    expect(mutationResult.targetedRepair?.invalidItemIds).toContain(
      input.skeleton.lessonSlots[1]!.slotId,
    );
    expect(removedId).toBe(input.skeleton.lessonSlots[1]!.slotId);
  });

  it('rejects structured Lesson aliases outside a slot while keeping Practice trivia advisory', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    lesson.slots[1]!.sourceRefs = ['S9'];
    expect(validateLessonSlotContentCandidate(lesson, lessonInput).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );

    const acceptedLesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      learnerLocale: 'zh-CN',
      skeleton: lessonInput.skeleton,
      acceptedLesson: acceptedLesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    practice.items[0]!.initial.prompt = 'On which page is bounded retrieval described?';
    const result = validatePracticeContentCandidate(practice, practiceInput);
    expect(result.valid).toBe(true);
    expect(result.targetedRepair).toBeUndefined();
  });

  it('T3/T4/T6 keeps source and supplementary lanes distinct and blocks learner-facing internals', async () => {
    const provider = new FakeProvider();
    const input = compositionalContractInput();
    const valid = await provider.generateLessonSlotContent(input);
    const supplementary = valid.slots.find((slot) => slot.sourceRefs.length === 0);
    const sourceBacked = valid.slots.find((slot) => slot.sourceRefs.length > 0);
    expect(supplementary).toBeDefined();
    expect(sourceBacked?.sourceRefs).toEqual(expect.arrayContaining(['S1']));
    expect(validateLessonSlotContentCandidate(valid, input).valid).toBe(true);

    const unknownEvidence = structuredClone(valid);
    unknownEvidence.slots.find((slot) => slot.sourceRefs.length > 0)!.sourceRefs = ['S9'];
    expect(validateLessonSlotContentCandidate(unknownEvidence, input).diagnosticCodes).toContain(
      'lesson_source_alias_outside_slot_authority',
    );

    const leaked = structuredClone(valid);
    leaked.narrative!.summary =
      'This Lesson develops O1 through the locally planned instructional spine and S1.';
    const leakage = validateLessonSlotContentCandidate(leaked, input);
    expect(leakage.valid).toBe(true);
    const evaluate = (candidate: typeof valid) =>
      evaluateLessonSlotPedagogy(candidate, input, {
        evaluatedAt: '2026-01-01T00:00:00.000Z',
      });
    expect(evaluate(leaked).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'lesson_internal_alias_leak', severity: 'warning' }),
        expect.objectContaining({ code: 'lesson_planning_language_leak', severity: 'warning' }),
      ]),
    );

    const copiedPurpose = structuredClone(valid);
    copiedPurpose.slots[0]!.explanation = input.skeleton.lessonSlots[0]!.purpose;
    expect(validateLessonSlotContentCandidate(copiedPurpose, input).valid).toBe(true);
    expect(evaluate(copiedPurpose).findings).toContainEqual(
      expect.objectContaining({ code: 'lesson_planning_language_leak', severity: 'warning' }),
    );
  });

  it('T4/T5 keeps lexical display aliases advisory without a correctness repair', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    const target = lesson.slots.find((slot) => slot.sourceRefs.length > 0)!;
    target.explanation = `${target.explanation} Internal citation S1.`;

    const lessonResult = validateLessonSlotContentCandidate(lesson, lessonInput);
    expect(lessonResult.valid).toBe(true);
    expect(lessonResult.targetedRepair).toBeUndefined();

    const cleanLesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      learnerLocale: 'zh-CN',
      skeleton: lessonInput.skeleton,
      acceptedLesson: cleanLesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);
    practice.items[0]!.initial.hint = `${practice.items[0]!.initial.hint} See S1.`;
    const practiceResult = validatePracticeContentCandidate(practice, practiceInput);
    expect(practiceResult.valid).toBe(true);
    expect(practiceResult.targetedRepair).toBeUndefined();
  });

  it('T12-T14 leaves quotation, prose overlap and same-prompt task integrity to public review', async () => {
    const provider = new FakeProvider();
    const lessonInput = compositionalContractInput();
    const lesson = await provider.generateLessonSlotContent(lessonInput);
    const practiceInput: PracticeContentGenerationInput = {
      workspaceName: 'Course',
      learnerLocale: 'zh-CN',
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'normal' },
      skeleton: lessonInput.skeleton,
      acceptedLesson: lesson.slots,
      sourceContext: lessonInput.sourceContext,
      visualContext: lessonInput.visualContext,
    };
    const practice = await provider.generatePracticeContent(practiceInput);

    const quoted = structuredClone(practice);
    quoted.items[0]!.initial.prompt = `${lessonInput.sourceContext.offers[0]!.text} Which conclusion follows?`;
    const quotedResult = validatePracticeContentCandidate(quoted, practiceInput);
    expect(quotedResult.valid).toBe(true);

    const repeatedCase =
      'A concrete retrieval case begins with three candidates, removes two that fail the condition, and returns the remaining eligible passage.';
    const exposureInput = structuredClone(practiceInput);
    exposureInput.acceptedLesson[0]!.example = {
      text: repeatedCase,
      sourceRefs: [],
      visualRefs: [],
    };
    const repeated = structuredClone(practice);
    repeated.items[0]!.initial.prompt = `${repeatedCase} Which result should the learner choose?`;
    const repeatedResult = validatePracticeContentCandidate(repeated, exposureInput);
    expect(repeatedResult.valid).toBe(true);

    const sameRetry = structuredClone(practice);
    sameRetry.items[0]!.retry.prompt = sameRetry.items[0]!.initial.prompt;
    expect(validatePracticeContentCandidate(sameRetry, practiceInput).valid).toBe(true);
  });
});
