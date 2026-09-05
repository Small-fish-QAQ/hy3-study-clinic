import { describe, expect, it } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type DesiredDepth,
  type TeachingBriefProposalPayload,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import {
  evaluateLessonPedagogy,
  evaluateLessonSlotPedagogy,
  evaluatePlannedPracticeQuality,
  evaluatePracticeQuality,
} from './lessonPedagogyEvaluator.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';

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
    const lesson = evaluateLessonPedagogy(candidate(), input(), { evaluatedAt });
    const practice = evaluatePracticeQuality(candidate(), input(), { evaluatedAt });
    expect(lesson.findings).toEqual([]);
    expect(practice.findings).toEqual([]);
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
      name: 'English causal keywords cannot authorize a tautological explanation',
      code: 'declarative_explanation_without_reasoning',
      mutate: (payload) => {
        payload.segments[1]!.explanation =
          'Because bounded retrieval is important, therefore bounded retrieval is important.';
      },
    },
    {
      name: 'Chinese causal keywords cannot authorize a tautological explanation',
      code: 'declarative_explanation_without_reasoning',
      mutate: (payload) => {
        payload.segments[1]!.explanation = '因为检索很重要，所以检索很重要。';
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
      name: 'worked-process sequence keywords cannot replace actual state progression',
      code: 'worked_example_has_no_visible_reasoning',
      mutate: (payload) => {
        const worked = payload.segments.find((segment) => segment.purpose === 'worked_example')!;
        worked.explanation =
          'Given retrieval input: first, next, then, finally; apply, inspect, choose a condition.';
        worked.example!.text = 'Starting state, step, transition, decision, therefore result.';
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
      name: 'construct and action keywords cannot authorize a Practice surface',
      code: 'practice_does_not_elicit_authorized_capability',
      mutate: (payload) => {
        payload.practice.items[0]!.initial.prompt =
          'Explain bounded retrieval: because, why, mechanism, therefore, result.';
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

  it('rejects APPLY/action marker stuffing without a meaningful state-to-action surface', () => {
    const payload = candidate();
    const context = input();
    context.learningUnit.objectives[0]!.construct = 'apply';
    payload.practice.items[0]!.construct = 'apply';
    payload.practice.items[0]!.capabilityTested =
      'Apply the bounded retrieval procedure to a stated case.';
    payload.practice.items[0]!.initial.prompt =
      'Apply bounded retrieval: choose the next step; condition, action, result.';
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

function compositionalInputs(
  construct: 'identify' | 'explain' | 'apply',
  targetMinutes = construct === 'identify' ? 14 : construct === 'apply' ? 20 : 18,
  targetDepth: DesiredDepth = 'pass_oriented',
): {
  lessonInput: LessonSlotContentGenerationInput;
  practiceInput: PracticeContentGenerationInput;
  lesson: LessonSlotContentProposalPayload;
  practice: PracticeContentProposalPayload;
} {
  const title =
    construct === 'apply'
      ? 'Use the bounded retrieval procedure'
      : construct === 'identify'
        ? 'Identify eligible retrieval candidates'
        : 'Explain bounded retrieval';
  const description =
    construct === 'apply'
      ? 'Use the source-stated retrieval condition to exclude incompatible candidates and return the eligible result.'
      : construct === 'identify'
        ? 'Distinguish candidates that satisfy the retrieval condition from candidates that do not.'
        : 'Explain how the retrieval condition controls candidate eligibility and the returned result.';
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: 'Bounded retrieval',
    targetMinutes,
    targetDepth,
    objectives: [
      {
        objectiveRef: 'O1',
        title,
        description,
        priority: 'required',
        construct,
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1', 'S2'],
        allowedVisualRefs: [],
      },
    ],
  });
  const sourceContext = {
    fingerprint: 'context_compositional',
    blockCount: 2,
    offerCount: 2,
    serializedBytes: 500,
    materialCount: 1,
    sectionCount: 1,
    offers: [
      {
        sourceRef: 'S1',
        materialTitle: 'Retrieval notes',
        headingPath: ['Bounded retrieval'],
        pageNumber: 1,
        slideNumber: null,
        text: 'The bounded retrieval procedure checks each candidate against a retrieval condition and excludes candidates that fail it.',
        authorizedObjectiveRefs: ['O1'],
      },
      {
        sourceRef: 'S2',
        materialTitle: 'Retrieval notes',
        headingPath: ['Bounded retrieval'],
        pageNumber: 2,
        slideNumber: null,
        text: 'After incompatible candidates are removed, the remaining eligible passage is returned as the retrieval result.',
        authorizedObjectiveRefs: ['O1'],
      },
    ],
  };
  const visualContext = { offerCount: 0, serializedBytes: 0, offers: [] };
  const lessonInput: LessonSlotContentGenerationInput = {
    workspaceName: 'Course',
    learnerLocale: 'zh-CN',
    skeleton,
    sourceContext,
    visualContext,
    learningContext: {
      concepts: [],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
  const lesson = LessonSlotContentProposalPayloadSchema.parse({
    slots: skeleton.lessonSlots.map((slot) => ({
      slotId: slot.slotId,
      explanation:
        slot.qualityContract === 'orientation'
          ? 'Bounded retrieval prepares the learner to make grounded candidate decisions.'
          : slot.qualityContract === 'semantic_relation'
            ? 'The retrieval condition filters candidate eligibility and changes the returned set.'
            : slot.qualityContract === 'worked_process'
              ? 'A concrete query is traced through the bounded retrieval procedure.'
              : slot.qualityContract === 'boundary_work'
                ? 'Eligible candidates satisfy the retrieval condition; surface similarity alone is insufficient.'
                : 'The learner commits to a retrieval decision before guidance is shown.',
      sourceRefs: slot.authorityMode === 'exact_source' ? ['S1', 'S2'] : [],
      visualRefs: [],
      semanticRelations:
        slot.qualityContract === 'semantic_relation'
          ? [
              {
                kind: slot.allowedRelations[0],
                fromProposition:
                  'The retrieval condition is checked against each candidate passage.',
                toProposition:
                  'Candidates that violate the condition are excluded from the returned set.',
                relevanceToObjective:
                  'This relation connects bounded retrieval to candidate eligibility and the returned result.',
                sourceRefs: ['S1', 'S2'],
              },
            ]
          : [],
      workedProcess:
        slot.qualityContract === 'worked_process'
          ? {
              startingState:
                'A query has three candidate passages, but only one satisfies the retrieval condition.',
              inputs: [
                'Three candidate passages.',
                'The retrieval condition used to decide eligibility.',
              ],
              ruleOrProcedure:
                'The bounded retrieval procedure checks every candidate against the condition and excludes each failing candidate.',
              steps: [
                {
                  action: 'Inspect every candidate against the retrieval condition.',
                  reason: 'The condition defines which candidate passage is eligible.',
                  resultingState:
                    'Two incompatible candidates are marked for exclusion from the returned set.',
                },
                {
                  action: 'Exclude the two candidates that fail the retrieval condition.',
                  reason: 'Only a candidate satisfying the condition may remain eligible.',
                  resultingState: 'One eligible candidate passage remains for retrieval.',
                },
              ],
              learnerDecision:
                'Choose whether each candidate satisfies the retrieval condition before returning a passage.',
              result: 'The single eligible candidate passage is returned as the retrieval result.',
              whyResultFollows:
                'The final passage follows from excluding every candidate that fails the retrieval condition.',
              sourceRefs: ['S1', 'S2'],
              interaction: {
                pauseAfterStepIndex: 0,
                sourceRefs: [],
                activity: {
                  reasoningOperation: 'predict_outcome',
                  decisiveCondition:
                    'Three candidates were inspected; two failed the eligibility condition.',
                  requiredInference:
                    'The returned set contains one passage and cannot fill a two-passage display.',
                  prompt:
                    'The display requests two passages. Using the inspected candidate state, what will it receive after retrieval?',
                  options: [
                    {
                      id: 'A',
                      text: 'It receives one passage, leaving one display position unfilled.',
                      feedbackIfSelected:
                        'This uses the checked condition to update candidate eligibility.',
                      misconception: null,
                    },
                    {
                      id: 'B',
                      text: 'Keep every candidate with familiar wording.',
                      feedbackIfSelected:
                        'Familiar wording does not establish eligibility under the condition.',
                      misconception: {
                        hypothesis: 'Surface similarity is enough for eligibility.',
                        whyTempting:
                          'Similar wording often looks relevant before the condition is applied.',
                        correction:
                          'Use the retrieval condition, not familiarity, to decide eligibility.',
                      },
                    },
                    {
                      id: 'C',
                      text: 'Return a passage before excluding any failure.',
                      feedbackIfSelected:
                        'Returning early skips the procedure that creates the bounded result.',
                      misconception: {
                        hypothesis: 'The first plausible candidate can be returned immediately.',
                        whyTempting:
                          'An early candidate may look sufficient before all constraints are checked.',
                        correction:
                          'Finish excluding failures before returning the remaining candidate.',
                      },
                    },
                  ],
                  correctOptionId: 'A',
                  correctDebrief:
                    'The condition has already classified eligibility, so exclusion is the next justified state change.',
                },
                hint: 'Use the condition to decide which candidates are allowed to remain.',
                scaffold: {
                  reasoningOperation: 'predict_outcome',
                  decisiveCondition: 'Two of the three inspected candidates fail the condition.',
                  requiredInference: 'One candidate remains eligible.',
                  prompt: 'What determines whether a candidate remains eligible?',
                  options: [
                    {
                      id: 'A',
                      text: 'Whether it satisfies the retrieval condition.',
                      feedbackIfSelected: 'Yes. The condition defines eligibility.',
                    },
                    {
                      id: 'B',
                      text: 'Whether its words look familiar.',
                      feedbackIfSelected: 'Familiarity does not establish the bounded condition.',
                    },
                  ],
                  correctOptionId: 'A',
                  debrief:
                    'Candidate eligibility is determined by the current retrieval condition.',
                },
                transfer: {
                  reasoningOperation: 'locate_boundary',
                  requiredInference:
                    'The formerly eligible result must be replaced because its eligibility changed.',
                  changedCondition:
                    'The retrieval condition changes and a formerly eligible passage now fails it.',
                  prompt: 'How should the retrieval result change?',
                  options: [
                    {
                      id: 'A',
                      text: 'Keep the former result because it was once eligible.',
                      feedbackIfSelected: 'Past eligibility cannot override the current condition.',
                    },
                    {
                      id: 'B',
                      text: 'Exclude the newly failing passage and return the remaining eligible one.',
                      feedbackIfSelected: 'Correct: eligibility follows the changed condition.',
                    },
                    {
                      id: 'C',
                      text: 'Return every passage without checking again.',
                      feedbackIfSelected: 'This removes the boundary created by the condition.',
                    },
                  ],
                  correctOptionId: 'B',
                  debrief:
                    'A changed condition changes eligibility and therefore the bounded result.',
                },
              },
            }
          : null,
      ...(slot.learnerActionRequired && slot.qualityContract !== 'worked_process'
        ? {
            informalCheck: {
              reasoningOperation: 'predict_outcome',
              decisiveCondition:
                'A candidate has familiar wording but fails the current condition.',
              requiredInference: 'That candidate cannot remain in the returned set.',
              kind: construct === 'apply' ? 'apply_simple_example' : 'choose_alternative',
              prompt:
                'Which candidate decision preserves the retrieval condition and the eligible returned result?',
              expectedSignal:
                'The learner connects the retrieval condition to candidate eligibility.',
              ...(construct === 'apply'
                ? {}
                : {
                    options: [
                      {
                        id: 'A',
                        text: 'Exclude candidates that fail the condition.',
                        feedbackIfSelected: 'Correct: eligibility follows the condition.',
                      },
                      {
                        id: 'B',
                        text: 'Keep every candidate because its label looks familiar.',
                        feedbackIfSelected: 'A familiar label does not establish eligibility.',
                      },
                    ],
                    correctOptionId: 'A',
                  }),
            },
          }
        : {}),
      ...(slot.qualityContract === 'boundary_work'
        ? {
            contrast: {
              text: 'A condition-eligible passage differs from a merely similar passage that fails the condition.',
              sourceRefs: ['S1'],
              visualRefs: [],
            },
          }
        : {}),
    })),
  });
  const practice = PracticeContentProposalPayloadSchema.parse({
    items: skeleton.practicePlan.slots.map((slot) => ({
      practiceSlotId: slot.practiceSlotId,
      capabilityTested:
        construct === 'apply'
          ? 'Use the retrieval condition to choose which candidate action preserves eligibility.'
          : construct === 'identify'
            ? 'Distinguish a retrieval candidate that satisfies the condition.'
            : 'Connect a changed retrieval condition to candidate eligibility and the returned result.',
      pedagogicalReason:
        'The selected account reveals whether the learner can connect retrieval conditions to candidate outcomes.',
      sourceRefs: ['S1', 'S2'],
      visualRefs: [],
      application:
        construct === 'apply'
          ? {
              startingState:
                'A query has three candidate passages and two fail the retrieval condition.',
              sourceRuleOrProcedure:
                'Check each candidate against the retrieval condition, exclude failures, and return the remaining eligible passage.',
              decisionRequired:
                'Choose what the retrieval pipeline should do with candidates that fail the condition.',
              expectedAction:
                'Exclude the failing candidates and return the remaining eligible passage.',
            }
          : null,
      initial: {
        reasoningOperation: 'predict_outcome',
        decisiveCondition: 'Two candidates fail the new query condition; the rest are eligible.',
        requiredInference:
          'Exclude the failing candidates and return the remaining eligible passage.',
        prompt:
          'A query has two candidates that fail its retrieval condition. Which system response preserves the eligible result?',
        options: [
          {
            optionRef: 'A',
            text: 'Exclude the failing candidates and return the remaining eligible passage.',
            feedbackIfSelected: 'Correct: the condition removes ineligible candidates.',
          },
          {
            optionRef: 'B',
            text: 'Return every candidate regardless of the retrieval condition.',
            feedbackIfSelected: 'This ignores candidate eligibility.',
          },
          {
            optionRef: 'C',
            text: 'Choose the passage with the most repeated words.',
            feedbackIfSelected: 'Surface repetition does not satisfy the condition.',
          },
        ],
        correctOptionRef: 'A',
        hint: 'Track which candidate remains eligible under the condition.',
        explanation:
          'Failing candidates are excluded, leaving the eligible passage as the retrieval result.',
      },
      retry: {
        reasoningOperation: 'locate_boundary',
        decisiveCondition: 'The later query changes a previously satisfied condition.',
        requiredInference:
          'Exclude the newly failing candidate and return the remaining eligible passage.',
        prompt:
          'A later query changes the retrieval condition, making one former candidate ineligible. Which response respects the new boundary?',
        options: [
          {
            optionRef: 'A',
            text: 'Keep the former candidate because it was previously eligible.',
            feedbackIfSelected: 'Past eligibility does not override the changed condition.',
          },
          {
            optionRef: 'B',
            text: 'Exclude the newly failing candidate and return the remaining eligible passage.',
            feedbackIfSelected: 'Correct: eligibility follows the current condition.',
          },
          {
            optionRef: 'C',
            text: 'Return all candidates without checking the condition.',
            feedbackIfSelected: 'This removes the retrieval boundary.',
          },
        ],
        correctOptionRef: 'B',
        hint: 'Use the current condition, not the earlier result.',
        explanation:
          'The changed condition excludes the newly failing candidate and preserves the eligible result.',
      },
    })),
  });
  const practiceInput: PracticeContentGenerationInput = {
    workspaceName: 'Course',
    learnerLocale: 'zh-CN',
    skeleton,
    acceptedLesson: lesson.slots,
    sourceContext,
    visualContext,
  };
  return { lessonInput, practiceInput, lesson, practice };
}

describe('compositional Lesson and Practice evaluators', () => {
  it('accepts an objective-aligned orientation', () => {
    const fixture = compositionalInputs('explain');
    const orientation = fixture.lesson.slots.find(
      (slot) =>
        fixture.lessonInput.skeleton.lessonSlots.find((planned) => planned.slotId === slot.slotId)
          ?.qualityContract === 'orientation',
    )!;
    expect(orientation.explanation).toContain('Bounded retrieval');
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status, JSON.stringify(evaluation.findings)).toBe('pass');
    expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('requires one conceptual worked interaction in a focused working-fluency Lesson', () => {
    const fixture = compositionalInputs('explain');
    fixture.lessonInput.courseDesign = {
      desiredDepth: 'working_fluency',
      unitFocus: 'focused',
    };
    const learnerSlot = fixture.lessonInput.skeleton.lessonSlots.find(
      (slot) => slot.learnerActionRequired,
    )!;
    const learnerContent = fixture.lesson.slots.find(
      (content) => content.slotId === learnerSlot.slotId,
    )!;
    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('missing_focused_worked_interaction');

    learnerContent.workedProcess = structuredClone(
      compositionalInputs('apply').lesson.slots.find((content) => content.workedProcess)!
        .workedProcess,
    );
    delete learnerContent.informalCheck;
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status, JSON.stringify(evaluation.findings)).toBe('pass');
    expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('rejects an unrelated orientation even when the immutable slot is present', () => {
    const fixture = compositionalInputs('explain');
    const orientation = fixture.lesson.slots.find(
      (slot) =>
        fixture.lessonInput.skeleton.lessonSlots.find((planned) => planned.slotId === slot.slotId)
          ?.qualityContract === 'orientation',
    )!;
    orientation.explanation =
      'Emperor penguins incubate eggs through the Antarctic winter while whales migrate north.';
    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('lesson_slot_content_not_objective_aligned');
  });

  it('rejects unrelated boundary work that is masked by an aligned slot explanation', () => {
    const fixture = compositionalInputs('explain', 30);
    const boundary = fixture.lesson.slots.find(
      (slot) =>
        fixture.lessonInput.skeleton.lessonSlots.find((planned) => planned.slotId === slot.slotId)
          ?.qualityContract === 'boundary_work',
    )!;
    expect(boundary.explanation).toContain('retrieval');
    boundary.contrast!.text =
      'Emperor penguins incubate eggs through the Antarctic winter while whales migrate north.';
    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('lesson_slot_content_not_objective_aligned');
  });

  it('T13: accepts depth-required boundary work and typed relation without any evaluator change', () => {
    const fixture = compositionalInputs('apply', 20, 'deep_transfer');
    const contracts = fixture.lessonInput.skeleton.lessonSlots.map((slot) => slot.qualityContract);

    expect(contracts).toEqual([
      'orientation',
      'worked_process',
      'boundary_work',
      'semantic_relation',
    ]);
    expect(
      fixture.lessonInput.skeleton.lessonSlots.every(
        (slot) => slot.qualityContract === 'orientation' || slot.protected,
      ),
    ).toBe(true);
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status, JSON.stringify(evaluation.findings)).toBe('pass');
    expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('T13: accepts a depth-added relation on identify when it is relevant to that objective', () => {
    const fixture = compositionalInputs('identify', 14, 'deep_transfer');
    const relationSlotId = fixture.lessonInput.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!.slotId;
    const relation = fixture.lesson.slots.find((slot) => slot.slotId === relationSlotId)!;

    // The shared harness writes one relevance line aimed at the explain/apply
    // wording. A depth-added relation on identify must speak to discrimination,
    // which is the obligation depth is actually adding here.
    relation.semanticRelations[0]!.relevanceToObjective =
      'Distinguishing eligible retrieval candidates depends on the condition that separates satisfying candidates from failing candidates.';

    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status).toBe('pass');
    expect(evaluation.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('T13: rejects a depth-required boundary slot whose boundary content is absent', () => {
    const fixture = compositionalInputs('identify', 14, 'deep_transfer');
    const boundarySlotId = fixture.lessonInput.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'boundary_work',
    )!.slotId;
    const boundary = fixture.lesson.slots.find((slot) => slot.slotId === boundarySlotId)!;

    delete boundary.contrast;
    delete boundary.misconception;

    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('missing_planned_boundary_work');
  });

  it('T13: rejects a depth-required relation slot that carries no typed relation', () => {
    const fixture = compositionalInputs('identify', 14, 'deep_transfer');
    const relationSlotId = fixture.lessonInput.skeleton.lessonSlots.find(
      (slot) => slot.qualityContract === 'semantic_relation',
    )!.slotId;
    const relation = fixture.lesson.slots.find((slot) => slot.slotId === relationSlotId)!;

    relation.semanticRelations = [];

    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('missing_typed_semantic_relation');
  });

  it('accepts a keyword-free typed relation and uses the full skeleton activity range', () => {
    const fixture = compositionalInputs('explain');
    const relation = fixture.lesson.slots.flatMap((slot) => slot.semanticRelations)[0]!;
    expect(
      `${relation.fromProposition} ${relation.toProposition} ${relation.relevanceToObjective}`,
    ).not.toMatch(/\b(?:because|therefore|why|how)\b|因为|所以|因此|导致/iu);
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.estimatedActiveMinutes).toEqual({
      min: fixture.lessonInput.skeleton.plannedActivityBudget.minMinutes,
      max: fixture.lessonInput.skeleton.plannedActivityBudget.maxMinutes,
    });
    expect(evaluation.claimedAgendaMinutes).toBe(fixture.lessonInput.skeleton.targetMinutes);
  });

  it('rejects lexical reasoning markers without typed propositions', () => {
    const fixture = compositionalInputs('explain');
    const relationSlot = fixture.lesson.slots.find((slot) => slot.semanticRelations.length > 0)!;
    relationSlot.explanation =
      'Because bounded retrieval is important, therefore bounded retrieval is important.';
    relationSlot.semanticRelations = [];
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.findings.map((finding) => finding.code)).toContain(
      'missing_typed_semantic_relation',
    );
  });

  it('demotes lexical source compatibility for an otherwise structured relation to a warning', () => {
    const fixture = compositionalInputs('explain');
    const relationSlot = fixture.lesson.slots.find((slot) => slot.semanticRelations.length > 0)!;
    relationSlot.semanticRelations = [
      {
        kind: 'mechanism_effect',
        fromProposition:
          'Bounded retrieval dragons guarantee perfect security for every deployment.',
        toProposition: 'Bounded retrieval unicorns eliminate every privacy and performance risk.',
        relevanceToObjective:
          'These bounded retrieval claims explain the returned result objective.',
        sourceRefs: ['S1', 'S2'],
      },
    ];
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status).toBe('pass');
    expect(evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'semantic_relation_source_incompatible',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('rejects a worked-process field whose start, rule, transitions, result, and why are labels', () => {
    const fixture = compositionalInputs('apply');
    const worked = fixture.lesson.slots.find((slot) => slot.workedProcess)!;
    worked.workedProcess = {
      startingState: 'Starting state details for this generic example.',
      ruleOrProcedure: 'Rule or procedure details for this generic example.',
      steps: [
        {
          action: 'Transition action details.',
          reason: 'Transition reason details.',
          resultingState: 'Resulting state details.',
        },
      ],
      learnerDecision: 'Learner decision details for the example.',
      result: 'Final result details for the generic example.',
      whyResultFollows: 'Why the result follows details for the example.',
      sourceRefs: ['S1'],
    };
    const evaluation = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(evaluation.status).toBe('fail');
    expect(evaluation.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'worked_process_missing_required_structure',
        'worked_process_source_incompatible',
      ]),
    );
  });

  it('does not require or permit a provider-added worked process for IDENTIFY', () => {
    const fixture = compositionalInputs('identify');
    const baseline = evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
      evaluatedAt,
    });
    expect(baseline.status).toBe('pass');
    expect(baseline.findings.every((finding) => finding.severity === 'warning')).toBe(true);
    fixture.lesson.slots[0]!.workedProcess = compositionalInputs('apply').lesson.slots.find(
      (slot) => slot.workedProcess,
    )!.workedProcess;
    expect(
      evaluateLessonSlotPedagogy(fixture.lesson, fixture.lessonInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('unplanned_worked_process');
  });

  it('accepts a source-compatible typed APPLY decision without apply/next-step wording', () => {
    const fixture = compositionalInputs('apply');
    expect(fixture.practice.items[0]!.initial.prompt).not.toMatch(/\bapply\b|next step/iu);
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map(({ code, severity }) => ({ code, severity })),
    ).toEqual([
      { code: 'practice_novelty_uncertain', severity: 'warning' },
      { code: 'practice_option_set_replays_lesson', severity: 'warning' },
    ]);
  });

  it('rejects apply/下一步 markers when typed application data is absent', () => {
    const fixture = compositionalInputs('apply');
    fixture.practice.items[0]!.application = null;
    fixture.practice.items[0]!.initial.prompt =
      'Apply the retrieval procedure: which next step preserves the eligible candidate?';
    const evaluation = evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
      evaluatedAt,
    });
    expect(evaluation.findings.map((finding) => finding.code)).toContain(
      'practice_apply_missing_typed_application',
    );
  });

  it('demotes lexical APPLY relevance/source compatibility to warnings', () => {
    const fixture = compositionalInputs('apply');
    fixture.practice.items[0]!.application = {
      startingState: 'Bounded retrieval dragons guarantee perfect security for every deployment.',
      sourceRuleOrProcedure:
        'Bounded retrieval unicorns eliminate every privacy and performance risk.',
      decisionRequired:
        'Choose whether the unsupported security guarantee should control the deployment.',
      expectedAction:
        'Trust the bounded retrieval unicorn and ignore every privacy or performance risk.',
    };
    const evaluation = evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
      evaluatedAt,
    });
    expect(evaluation.status).toBe('pass');
    expect(evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'practice_application_source_incompatible',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'practice_application_relevance_uncertain',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('treats worked-interaction hints, scaffolds, feedback, and transfer as Practice exposure', () => {
    const fixture = compositionalInputs('apply');
    const interaction = fixture.lesson.slots.find((slot) => slot.workedProcess?.interaction)!
      .workedProcess!.interaction!;
    fixture.practice.items[0]!.initial.prompt = interaction.transfer.prompt;
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('practice_repeats_accepted_lesson');

    fixture.practice.items[0]!.initial.prompt = interaction.scaffold.prompt;
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('practice_repeats_accepted_lesson');
  });

  it('rejects source-location trivia in compositional Practice', () => {
    const fixture = compositionalInputs('explain');
    fixture.practice.items[0]!.retry.prompt = 'On which page is the retrieval condition described?';
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('source_location_trivia');
  });

  it('accepts source-stated procedural action questions without treating them as location trivia', () => {
    const fixture = compositionalInputs('apply');
    fixture.practice.items[0]!.initial.prompt =
      'The bounded retrieval procedure has begun. Which action should happen next under the source-stated procedure?';
    fixture.practice.items[0]!.retry.prompt =
      'Which action completes the source-stated transition after the retrieval condition changes?';
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map(({ code, severity }) => ({ code, severity })),
    ).toEqual([
      { code: 'practice_novelty_uncertain', severity: 'warning' },
      { code: 'practice_option_set_replays_lesson', severity: 'warning' },
    ]);
  });

  it.each([
    'On which page is the retrieval condition described?',
    'Which section contains the retrieval condition?',
    'Which source mentions the retrieval condition?',
  ])('continues to reject actual source-location trivia: %s', (prompt) => {
    const fixture = compositionalInputs('explain');
    fixture.practice.items[0]!.retry.prompt = prompt;
    expect(
      evaluatePlannedPracticeQuality(fixture.practice, fixture.practiceInput, {
        evaluatedAt,
      }).findings.map((finding) => finding.code),
    ).toContain('source_location_trivia');
  });
});
