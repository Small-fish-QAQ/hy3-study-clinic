import { describe, expect, it } from 'vitest';
import type { TeachingBriefProposalPayload } from '@hy3-clinic/shared';
import type { TeachingBriefGenerationInput } from '../llm/provider.js';
import { evaluateLessonPedagogy, evaluatePracticeQuality } from './lessonPedagogyEvaluator.js';

function input(): TeachingBriefGenerationInput {
  return {
    workspaceName: 'Course',
    learningUnit: {
      title: 'Bounded retrieval',
      objectives: [
        {
          objectiveRef: 'O1',
          title: 'Explain bounded retrieval',
          description: 'Explain how a retrieval condition controls the returned result.',
          priority: 'required',
          construct: 'explain',
          authorityEnvelopeTier: 'formal_sufficient',
          practiceAuthority: 'exact_formal',
        },
      ],
      concepts: [],
      canonicalConcepts: [],
    },
    prerequisites: [],
    nextConnection: null,
    sourceContext: {
      blockCount: 2,
      offerCount: 2,
      serializedBytes: 200,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Notes',
          headingPath: ['Retrieval'],
          pageNumber: 1,
          slideNumber: null,
          text: 'The retrieval condition bounds the result.',
          authorizedObjectiveRefs: ['O1'],
        },
        {
          sourceRef: 'S2',
          materialTitle: 'Notes',
          headingPath: ['Retrieval'],
          pageNumber: 2,
          slideNumber: null,
          text: 'Changing the condition changes which result is returned.',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
    limits: { maxSegments: 12, maxSourceRefsPerSegment: 8, maxFormalOpportunities: 8 },
    plannedMinutes: 20,
  };
}

function candidate(): TeachingBriefProposalPayload {
  return {
    whyNow: 'This prepares the next route step.',
    prerequisites: [],
    segments: [
      {
        purpose: 'objective_orientation',
        objectiveRefs: ['O1'],
        explanation: 'Learn bounded retrieval now because later decisions depend on it.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: [],
      },
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation:
          'Bounded retrieval works because a stated condition limits which result can be returned.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'mechanism',
        objectiveRefs: ['O1'],
        explanation:
          'When the retrieval condition changes, the candidate set changes and therefore the returned result may change.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S2'],
      },
      {
        purpose: 'worked_example',
        objectiveRefs: ['O1'],
        explanation:
          'First read the condition, then eliminate incompatible candidates, and finally select the supported result.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        example: {
          text: 'Given three candidates, first apply the condition, next remove two mismatches, then return the remaining result.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'contrast',
        objectiveRefs: ['O1'],
        explanation:
          'Compare condition-based retrieval with keyword copying: only the first explains why the result is eligible.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S1'],
        contrast: {
          text: 'One path tests a condition; the other repeats a surface word.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'guided_practice',
        objectiveRefs: ['O1'],
        explanation:
          'Explain why the retrieval condition changes the result, then commit your response before coaching.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S2'],
        informalCheck: {
          kind: 'own_words',
          prompt: 'Explain how a changed retrieval condition controls the returned result.',
          expectedSignal: 'Connect the condition to candidate eligibility and result.',
        },
      },
    ],
    formalOpportunities: [],
    summary: 'Conditions bound retrieval results.',
    nextConnection: null,
    practice: {
      items: [
        {
          objectiveRef: 'O1',
          construct: 'explain',
          capabilityTested: 'Explain bounded retrieval from condition to result.',
          pedagogicalReason:
            'This diagnoses causal understanding rather than source-location recall.',
          authority: 'exact_source',
          sourceRefs: ['S1', 'S2'],
          visualRefs: [],
          initial: {
            prompt:
              'Which explanation best shows how and why a retrieval condition changes the result?',
            options: [
              {
                optionRef: 'A',
                text: 'It changes candidate eligibility.',
                feedbackIfSelected: 'Correct.',
              },
              {
                optionRef: 'B',
                text: 'It repeats a keyword.',
                feedbackIfSelected: 'Surface match.',
              },
              {
                optionRef: 'C',
                text: 'It ignores all conditions.',
                feedbackIfSelected: 'No boundary.',
              },
            ],
            correctOptionRef: 'A',
            hint: 'Trace the condition to candidate eligibility.',
            explanation: 'The condition changes eligibility and therefore the result.',
          },
          retry: {
            prompt:
              'When a candidate no longer meets the condition, which account best explains why the retrieval result narrows?',
            options: [
              { optionRef: 'A', text: 'The heading changed.', feedbackIfSelected: 'Irrelevant.' },
              { optionRef: 'B', text: 'Eligibility changed.', feedbackIfSelected: 'Correct.' },
              {
                optionRef: 'C',
                text: 'All candidates still qualify.',
                feedbackIfSelected: 'Ignores condition.',
              },
            ],
            correctOptionRef: 'B',
            hint: 'Ask which candidate remains eligible.',
            explanation: 'Removing eligibility narrows the supported result.',
          },
        },
      ],
    },
  };
}

const evaluatedAt = '2026-08-23T00:00:00.000Z';

describe('independent Lesson and Practice semantic evaluators', () => {
  it('passes a pedagogically complete, construct-valid source-grounded candidate', () => {
    expect(evaluateLessonPedagogy(candidate(), input(), { evaluatedAt }).status).toBe('pass');
    expect(evaluatePracticeQuality(candidate(), input(), { evaluatedAt }).status).toBe('pass');
  });

  const cases: Array<{
    name: string;
    code: string;
    mutate: (payload: TeachingBriefProposalPayload, context: TeachingBriefGenerationInput) => void;
  }> = [
    {
      name: 'one declarative segment cannot satisfy a nominal lesson',
      code: 'missing_objective_orientation',
      mutate: (payload) => {
        payload.segments = [payload.segments[1]!];
      },
    },
    {
      name: 'a claimed hour cannot be supported by a short activity sequence',
      code: 'agenda_duration_not_supported_by_learning_actions',
      mutate: (_payload, context) => {
        context.plannedMinutes = 60;
      },
    },
    {
      name: 'declarative prose without causal reasoning is rejected',
      code: 'declarative_explanation_without_reasoning',
      mutate: (payload) => {
        payload.segments[1]!.explanation = 'Bounded retrieval is a topic in the lesson.';
      },
    },
    {
      name: 'a missing worked example is rejected',
      code: 'missing_worked_example',
      mutate: (payload) => {
        payload.segments = payload.segments.filter(
          (segment) => segment.purpose !== 'worked_example',
        );
      },
    },
    {
      name: 'an example label without visible intermediate reasoning is rejected',
      code: 'worked_example_has_no_visible_reasoning',
      mutate: (payload) => {
        const worked = payload.segments.find((segment) => segment.purpose === 'worked_example')!;
        worked.explanation = 'A retrieval illustration.';
        worked.example!.text = 'A retrieval illustration.';
      },
    },
    {
      name: 'a lesson without learner action is rejected',
      code: 'missing_deliberate_learner_activity',
      mutate: (payload) => {
        delete payload.segments[5]!.informalCheck;
      },
    },
    {
      name: 'English page-location recall is rejected in a Lesson check',
      code: 'lesson_source_location_trivia',
      mutate: (payload) => {
        payload.segments[5]!.informalCheck!.prompt =
          'On which page is bounded retrieval mentioned?';
      },
    },
    {
      name: 'Chinese section-location recall is rejected in a Lesson check',
      code: 'lesson_source_location_trivia',
      mutate: (payload) => {
        payload.segments[5]!.informalCheck!.prompt = '这个定义位于资料的哪个章节？';
      },
    },
    {
      name: 'a lesson with no misconception or boundary contrast is rejected',
      code: 'missing_boundary_or_misconception_work',
      mutate: (payload) => {
        payload.segments = payload.segments.filter((segment) => segment.purpose !== 'contrast');
      },
    },
    {
      name: 'semantically repeated Lesson segments are rejected',
      code: 'semantically_redundant_lesson_segments',
      mutate: (payload) => {
        payload.segments.push({ ...payload.segments[1]! });
      },
    },
    {
      name: 'one token source citation is insufficient grounding',
      code: 'insufficient_source_grounded_teaching',
      mutate: (payload) => {
        payload.segments[2]!.explanationAuthority = 'ai_teaching_synthesis';
      },
    },
    {
      name: 'English source-location Practice trivia is rejected',
      code: 'source_location_trivia',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.prompt = 'Where in the source is retrieval explained?';
      },
    },
    {
      name: 'Chinese page-location Practice trivia is rejected',
      code: 'source_location_trivia',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.prompt = '检索条件写在资料第几页？';
      },
    },
    {
      name: 'Practice cannot raise the objective construct',
      code: 'practice_construct_exceeds_objective_authority',
      mutate: (payload) => {
        payload.practice.items[0]!.construct = 'evaluate';
      },
    },
    {
      name: 'Practice cannot use a source outside exact objective authority',
      code: 'practice_source_outside_objective_authority',
      mutate: (_payload, context) => {
        context.sourceContext.offers[0]!.authorizedObjectiveRefs = [];
      },
    },
    {
      name: 'Practice must elicit an observable action',
      code: 'practice_does_not_elicit_authorized_capability',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.prompt = 'Bounded retrieval is interesting.';
      },
    },
    {
      name: 'duplicate options make a Practice item invalid',
      code: 'invalid_or_duplicate_practice_options',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.options[1]!.text =
          payload.practice.items[0]!.initial.options[0]!.text;
      },
    },
    {
      name: 'a Practice prompt cannot contain its complete answer',
      code: 'practice_prompt_leaks_answer',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.prompt =
          'Which explanation is correct: It changes candidate eligibility.';
      },
    },
    {
      name: 'retry cannot repeat the original surface',
      code: 'retry_surface_not_meaningfully_changed',
      mutate: (payload) => {
        payload.practice.items[0]!.retry.prompt = payload.practice.items[0]!.initial.prompt;
      },
    },
    {
      name: 'required objectives cannot be omitted from Practice',
      code: 'required_objective_has_no_practice',
      mutate: (payload) => {
        payload.practice.items = [];
      },
    },
    {
      name: 'semantically repeated Practice items are rejected',
      code: 'semantically_redundant_practice_items',
      mutate: (payload) => {
        payload.practice.items.push(structuredClone(payload.practice.items[0]!));
      },
    },
  ];

  it.each(cases)('$name', ({ code, mutate }) => {
    const payload = candidate();
    const context = input();
    mutate(payload, context);
    const findings = [
      ...evaluateLessonPedagogy(payload, context, { evaluatedAt }).findings,
      ...evaluatePracticeQuality(payload, context, { evaluatedAt }).findings,
    ];
    expect(findings.map((finding) => finding.code)).toContain(code);
  });

  it('accepts a legitimate scenario-based apply item within exact apply authority', () => {
    const payload = candidate();
    const context = input();
    context.learningUnit.objectives[0]!.construct = 'apply';
    payload.practice.items[0]!.construct = 'apply';
    payload.practice.items[0]!.capabilityTested =
      'Apply bounded retrieval to a scenario using the stated condition.';
    payload.practice.items[0]!.initial.prompt =
      'Apply bounded retrieval in this scenario while preserving the source-stated condition. Which next step should the learner choose?';
    payload.practice.items[0]!.retry.prompt =
      'In a second case with a different candidate set, apply the retrieval condition to choose the next result.';
    expect(evaluatePracticeQuality(payload, context, { evaluatedAt }).status).toBe('pass');
  });

  it('rejects apply that only recognizes a procedure or definition', () => {
    const payload = candidate();
    const context = input();
    context.learningUnit.objectives[0]!.construct = 'apply';
    payload.practice.items[0]!.construct = 'apply';
    payload.practice.items[0]!.capabilityTested = 'Apply the bounded retrieval procedure.';
    payload.practice.items[0]!.initial.prompt =
      'Which definition names the bounded retrieval procedure?';
    expect(
      evaluatePracticeQuality(payload, context, { evaluatedAt }).findings.map(
        (finding) => finding.code,
      ),
    ).toContain('practice_does_not_elicit_authorized_capability');
  });

  it('accepts a source-bounded apply decision about the next procedural step', () => {
    const payload = candidate();
    const context = input();
    context.learningUnit.objectives[0]!.construct = 'apply';
    payload.practice.items[0]!.construct = 'apply';
    payload.practice.items[0]!.capabilityTested =
      'Apply the source-stated retrieval condition to choose the next step.';
    payload.practice.items[0]!.initial.prompt =
      'Given the source-stated condition, which next step should you choose before returning a retrieval result?';
    payload.practice.items[0]!.retry.prompt =
      'In a changed candidate set, which next step applies the retrieval condition before selecting the result?';
    expect(evaluatePracticeQuality(payload, context, { evaluatedAt }).status).toBe('pass');
  });

  it('does not accept duration by changing only the displayed target', () => {
    const payload = candidate();
    const context = input();
    context.plannedMinutes = 30;
    context.durationBudget = {
      targetMinutes: 30,
      acceptableActiveMinutes: { min: 22, max: 33 },
      protectedRoles: ['objective_orientation', 'explanation', 'worked_example', 'guided_practice'],
      protectedObjectiveRefs: ['O1'],
      reductionOrder: ['remove redundant explanation'],
    };
    payload.segments.push(
      {
        purpose: 'mechanism',
        objectiveRefs: ['O1'],
        explanation: 'A distinct second mechanism traces a different condition to its consequence.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S1'],
      },
      {
        purpose: 'contrast',
        objectiveRefs: ['O1'],
        explanation:
          'A second boundary comparison distinguishes the condition from a surface label.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S2'],
        contrast: {
          text: 'The second case changes the condition and therefore changes the decision.',
          authority: 'ai_teaching_synthesis',
          sourceRefs: [],
        },
      },
      {
        purpose: 'guided_practice',
        objectiveRefs: ['O1'],
        explanation: 'A second learner action applies the condition and commits a decision.',
        explanationAuthority: 'ai_teaching_synthesis',
        sourceRefs: ['S2'],
        informalCheck: {
          kind: 'apply_simple_example',
          prompt: 'Choose the next step under the changed condition.',
          expectedSignal: 'Connect condition and decision.',
        },
      },
      {
        purpose: 'explanation',
        objectiveRefs: ['O1'],
        explanation:
          'A final explanation makes a distinct causal relation explicit because the condition changes the result.',
        explanationAuthority: 'source_backed_teaching',
        sourceRefs: ['S2'],
      },
    );
    const evaluation = evaluateLessonPedagogy(payload, context, { evaluatedAt });
    expect(evaluation.findings.map((finding) => finding.code)).toContain(
      'agenda_duration_not_supported_by_learning_actions',
    );
  });
});
