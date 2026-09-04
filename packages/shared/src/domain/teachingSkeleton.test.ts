import { describe, expect, it } from 'vitest';
import {
  AcceptedLessonCheckpointSchema,
  TeachingLessonSlotContentSchema,
  TeachingPracticeApplicationContentSchema,
  TeachingSemanticRelationSchema,
  TeachingSkeletonSchema,
  TeachingWorkedProcessSchema,
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
  type TeachingLessonSlotContent,
  type TeachingSkeleton,
} from './teachingSkeleton.js';

function skeleton(): TeachingSkeleton {
  return TeachingSkeletonSchema.parse({
    id: `teaching_skeleton_${'a'.repeat(40)}`,
    schemaVersion: 1,
    plannerVersion: 'teaching-skeleton-planner-v1',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    learningUnitTitle: 'Bounded retrieval',
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Identify the retrieval boundary',
        description: 'Distinguish a bounded retrieval case from an unbounded one.',
        priority: 'required',
        construct: 'identify',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
    targetMinutes: 12,
    acceptableActiveMinutes: { minMinutes: 4, maxMinutes: 15 },
    lessonSlots: [
      {
        slotId: 'L1',
        objectiveRefs: ['O1'],
        construct: null,
        role: 'objective_orientation',
        purpose: 'Orient the learner to the locally selected objective.',
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
        construct: 'identify',
        role: 'guided_practice',
        purpose: 'Require meaningful discrimination rather than source-location recall.',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
        protected: true,
        activityBudget: { minMinutes: 3, maxMinutes: 5 },
        learnerActionRequired: true,
        qualityContract: 'discrimination',
        allowedRelations: ['difference_discrimination'],
      },
    ],
    practicePlan: {
      schemaVersion: 1,
      slots: [
        {
          practiceSlotId: 'PR1',
          objectiveRef: 'O1',
          construct: 'identify',
          authorityMode: 'exact_source',
          allowedSourceRefs: ['S1'],
          allowedVisualRefs: [],
          capabilityToObserve: 'Distinguish the bounded case from an unbounded case.',
          prohibitedStrongerConstructs: ['explain', 'apply', 'design', 'evaluate'],
          retryPermitted: true,
          activityBudget: { minMinutes: 3, maxMinutes: 5 },
        },
      ],
      activityBudget: { minMinutes: 3, maxMinutes: 5 },
    },
    synthesisActivityBudget: { minMinutes: 2, maxMinutes: 3 },
    protectedActivityBudget: { minMinutes: 10, maxMinutes: 16 },
    plannedActivityBudget: { minMinutes: 10, maxMinutes: 16 },
  });
}

function content(): TeachingLessonSlotContent[] {
  return [
    {
      slotId: 'L1',
      lessonNarrative: {
        whyNow: 'This boundary matters before the learner makes a retrieval decision.',
        summary: 'A bounded case applies its defining condition before accepting a candidate.',
        forwardBridge: 'Next, use the boundary in a changed retrieval case.',
      },
      explanation: 'This objective prepares a bounded retrieval decision.',
      sourceRefs: ['S1'],
      visualRefs: [],
      semanticRelations: [],
      workedProcess: null,
    },
    {
      slotId: 'L2',
      explanation: 'A bounded case tests the stated condition; an unbounded case ignores it.',
      sourceRefs: ['S1'],
      visualRefs: [],
      semanticRelations: [
        {
          kind: 'difference_discrimination',
          fromProposition: 'The bounded case tests the stated retrieval condition.',
          toProposition: 'The unbounded case accepts candidates without that condition.',
          relevanceToObjective: 'The difference lets the learner identify the bounded case.',
          sourceRefs: ['S1'],
        },
      ],
      workedProcess: null,
      informalCheck: {
        kind: 'choose_alternative',
        prompt: 'Which case actually enforces the stated retrieval boundary?',
        expectedSignal: 'Choose the case that tests the condition.',
        options: [
          {
            id: 'A',
            text: 'The case checks the condition.',
            feedbackIfSelected: 'Correct: the boundary is enforced.',
          },
          {
            id: 'B',
            text: 'The case ignores the condition.',
            feedbackIfSelected: 'This removes the boundary.',
          },
        ],
        correctOptionId: 'A',
      },
    },
  ];
}

function checkpoint(): AcceptedLessonCheckpoint {
  return AcceptedLessonCheckpointSchema.parse({
    id: 'accepted_lesson_1',
    workspaceId: 'workspace_1',
    studySessionId: 'session_1',
    sessionAgendaId: 'agenda_1',
    agendaItemId: 'agenda_item_1',
    expectedSessionVersion: 2,
    expectedAgendaVersion: 3,
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    studyPlanItemId: 'plan_item_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest_1',
    sourceContextFingerprint: 'context_1',
    skeleton: skeleton(),
    lessonContent: content(),
    lessonEvaluation: {
      schemaVersion: 1,
      policyVersion: 'lesson-pedagogy-v3-compositional',
      evaluator: 'independent-deterministic-lesson-evaluator',
      independent: true,
      status: 'pass',
      boundedRepairAttempted: false,
      estimatedActiveMinutes: { min: 10, max: 16 },
      claimedAgendaMinutes: 12,
      findings: [],
      evaluatedAt: '2026-08-24T00:00:00.000Z',
    },
    operationId: 'operation_1',
    provider: 'fake',
    providerModel: null,
    promptVersion: 'teaching-brief-v2-pedagogy-practice-compositional-v1',
    createdAt: '2026-08-24T00:00:00.000Z',
  });
}

function workedInteraction() {
  return {
    pauseAfterStepIndex: 0,
    sourceRefs: [],
    activity: {
      prompt: 'Which action should happen after the condition has been checked?',
      options: [
        {
          id: 'A',
          text: 'Apply the action authorized by the condition.',
          feedbackIfSelected: 'The condition now justifies this state change.',
          misconception: null,
        },
        {
          id: 'B',
          text: 'Choose the most familiar action.',
          feedbackIfSelected: 'Familiarity does not prove that the action is allowed.',
          misconception: {
            hypothesis: 'A familiar action is always applicable.',
            whyTempting: 'It appeared in the earlier typical case.',
            correction: 'Check the current condition before selecting the action.',
          },
        },
        {
          id: 'C',
          text: 'Jump directly to the final result.',
          feedbackIfSelected: 'This skips the state transition that supports the result.',
          misconception: {
            hypothesis: 'A plausible final result does not need intermediate support.',
            whyTempting: 'The final result resembles the modelled example.',
            correction: 'Complete the condition-authorized transition first.',
          },
        },
      ],
      correctOptionId: 'A',
      correctDebrief: 'The checked condition makes this the next justified action.',
    },
    hint: 'Ask which action the current condition permits.',
    scaffold: {
      prompt: 'What determines whether an action is permitted?',
      options: [
        {
          id: 'A',
          text: 'The current condition.',
          feedbackIfSelected: 'Correct; it bounds the action set.',
        },
        {
          id: 'B',
          text: 'The action label.',
          feedbackIfSelected: 'A label does not establish applicability.',
        },
      ],
      correctOptionId: 'A',
      debrief: 'The current condition, not the label, bounds the next action.',
    },
    transfer: {
      changedCondition: 'The condition that permitted the original action is absent.',
      prompt: 'What should happen in the changed case?',
      options: [
        {
          id: 'A',
          text: 'Repeat the original action.',
          feedbackIfSelected: 'The original authorization is gone.',
        },
        {
          id: 'B',
          text: 'Re-evaluate and withhold the original action.',
          feedbackIfSelected: 'Correct; the changed condition changes the action set.',
        },
        {
          id: 'C',
          text: 'Ignore the rule entirely.',
          feedbackIfSelected: 'The rule still bounds the revised decision.',
        },
      ],
      correctOptionId: 'B',
      debrief: 'Changing the governing condition changes which action is justified.',
    },
  } as const;
}

describe('Teaching Skeleton contracts', () => {
  it('accepts an immutable construct-aware plan without generated prose ownership', () => {
    expect(skeleton()).toMatchObject({
      schemaVersion: 1,
      targetMinutes: 12,
      objectives: [expect.objectContaining({ objectiveRef: 'O1', construct: 'identify' })],
      lessonSlots: [
        expect.objectContaining({ slotId: 'L1', qualityContract: 'orientation' }),
        expect.objectContaining({ slotId: 'L2', qualityContract: 'discrimination' }),
      ],
      practicePlan: { slots: [expect.objectContaining({ practiceSlotId: 'PR1' })] },
    });
  });

  it('rejects unknown objective ownership and source authority outside an objective envelope', () => {
    const unknownObjective = structuredClone(skeleton());
    unknownObjective.lessonSlots[1]!.objectiveRefs = ['O2'];
    expect(TeachingSkeletonSchema.safeParse(unknownObjective).success).toBe(false);

    const foreignSource = structuredClone(skeleton());
    foreignSource.lessonSlots[1]!.allowedSourceRefs = ['S2'];
    expect(TeachingSkeletonSchema.safeParse(foreignSource).success).toBe(false);
  });

  it('rejects duplicate stable slot identities and inconsistent locally derived budgets', () => {
    const duplicate = structuredClone(skeleton());
    duplicate.lessonSlots[1]!.slotId = 'L1';
    expect(TeachingSkeletonSchema.safeParse(duplicate).success).toBe(false);

    const displayOnlyDurationChange = structuredClone(skeleton());
    displayOnlyDurationChange.targetMinutes = 40;
    displayOnlyDurationChange.acceptableActiveMinutes = { minMinutes: 32, maxMinutes: 43 };
    expect(TeachingSkeletonSchema.safeParse(displayOnlyDurationChange).success).toBe(false);

    const dishonestBudget = structuredClone(skeleton());
    dishonestBudget.plannedActivityBudget.minMinutes = 4;
    expect(TeachingSkeletonSchema.safeParse(dishonestBudget).success).toBe(false);
  });

  it('keeps objective, construct, role, duration, protection, and authority out of provider content', () => {
    const valid = content()[0]!;
    expect(TeachingLessonSlotContentSchema.parse(valid)).toEqual(valid);

    for (const providerOwnedField of [
      ['objectiveRefs', ['O1']],
      ['construct', 'identify'],
      ['role', 'guided_practice'],
      ['authorityMode', 'exact_source'],
      ['activityBudget', { minMinutes: 1, maxMinutes: 2 }],
      ['protected', false],
    ] as const) {
      expect(
        TeachingLessonSlotContentSchema.safeParse({
          ...valid,
          [providerOwnedField[0]]: providerOwnedField[1],
        }).success,
      ).toBe(false);
    }
  });

  it('keeps structured choice feedback valid without making reflective checks falsely gradable', () => {
    const choice = content()[1]!.informalCheck!;
    expect(choice.options).toHaveLength(2);
    expect(choice.correctOptionId).toBe('A');

    const invalidChoice = structuredClone(content()[1]!);
    invalidChoice.informalCheck!.correctOptionId = 'C';
    expect(TeachingLessonSlotContentSchema.safeParse(invalidChoice).success).toBe(false);

    const reflective = structuredClone(content()[1]!);
    reflective.informalCheck = {
      kind: 'own_words',
      prompt: 'Explain the boundary in your own words.',
      expectedSignal: 'Mention the governing condition.',
    };
    expect(TeachingLessonSlotContentSchema.safeParse(reflective).success).toBe(true);
  });

  it('rejects lexical reasoning without two distinct propositions', () => {
    expect(
      TeachingSemanticRelationSchema.safeParse({
        kind: 'cause_consequence',
        fromProposition: 'Because embedding is important.',
        toProposition: 'Embedding is important!',
        relevanceToObjective: 'It says embedding matters.',
        sourceRefs: ['S1'],
      }).success,
    ).toBe(false);

    expect(
      TeachingSemanticRelationSchema.safeParse({
        kind: 'mechanism_effect',
        fromProposition: 'The retrieval filter removes candidates outside the condition.',
        toProposition: 'The returned set contains only candidates that meet the condition.',
        relevanceToObjective: 'This connects the filtering mechanism to its bounded result.',
        sourceRefs: ['S1'],
      }).success,
    ).toBe(true);
  });

  it('requires a genuine structured worked process instead of a worked-example label', () => {
    expect(
      TeachingWorkedProcessSchema.safeParse({
        startingState: 'Three source chunks are waiting to be indexed.',
        ruleOrProcedure: 'Chunk, embed, and store each chunk before querying.',
        steps: [],
        learnerDecision: null,
        result: 'The index is ready.',
        whyResultFollows: 'Worked example.',
        sourceRefs: ['S1'],
      }).success,
    ).toBe(false);

    expect(
      TeachingWorkedProcessSchema.safeParse({
        startingState: 'Three source chunks are waiting to be indexed.',
        ruleOrProcedure: 'Chunk, embed, and store each chunk before querying.',
        steps: [
          {
            action: 'Embed each prepared chunk.',
            reason: 'The retrieval index compares query and chunk representations.',
            resultingState: 'Every prepared chunk has a vector representation.',
          },
          {
            action: 'Store the vectors with their source chunks.',
            reason: 'A later query must resolve a vector match back to grounded content.',
            resultingState: 'The index can return a matched source chunk.',
          },
        ],
        learnerDecision: 'Choose storage, not query generation, as the next action.',
        result: 'The source chunks are available for bounded retrieval.',
        whyResultFollows: 'Every source-stated ingestion step has produced its required state.',
        sourceRefs: ['S1'],
      }).success,
    ).toBe(true);
    expect(
      TeachingWorkedProcessSchema.safeParse({
        startingState: 'A new system receives an unfamiliar retrieval case.',
        ruleOrProcedure: 'Compare the case condition with the candidate boundary.',
        steps: [
          {
            action: 'Change one condition and inspect the candidate set.',
            reason: 'The changed condition can alter eligibility.',
            resultingState: 'A different bounded candidate set remains.',
          },
        ],
        learnerDecision: 'Decide whether the earlier conclusion still follows.',
        result: 'The conclusion is revised for the changed case.',
        whyResultFollows: 'The boundary changed with the condition.',
        sourceRefs: [],
      }).success,
    ).toBe(true);
  });

  it('represents one bounded worked interaction with targeted misconceptions and scaffold help', () => {
    const process = {
      startingState: 'Three candidates await a bounded retrieval decision.',
      inputs: ['The current condition.', 'Three candidate states.'],
      ruleOrProcedure: 'Check the condition, then apply only an authorized action.',
      steps: [
        {
          action: 'Check the condition against every candidate.',
          reason: 'The condition establishes eligibility.',
          resultingState: 'Eligible and ineligible candidates are distinguished.',
        },
        {
          action: 'Apply the authorized action to the eligible candidate.',
          reason: 'Only eligible candidates may advance.',
          resultingState: 'One bounded result remains.',
        },
      ],
      learnerDecision: 'Choose the next authorized action.',
      result: 'The eligible candidate becomes the bounded result.',
      whyResultFollows: 'The condition justified each state transition.',
      sourceRefs: ['S1'],
      interaction: workedInteraction(),
    };
    expect(
      TeachingWorkedProcessSchema.parse(process).interaction?.activity.options[1],
    ).toMatchObject({
      misconception: {
        hypothesis: 'A familiar action is always applicable.',
        whyTempting: expect.any(String),
        correction: expect.any(String),
      },
    });

    const missingWrongMapping = structuredClone(process);
    missingWrongMapping.interaction.activity.options[1]!.misconception = null;
    expect(TeachingWorkedProcessSchema.safeParse(missingWrongMapping).success).toBe(false);

    const noContinuation = structuredClone(process);
    noContinuation.interaction.pauseAfterStepIndex = 1;
    expect(TeachingWorkedProcessSchema.safeParse(noContinuation).success).toBe(false);
  });

  it('validates bounded Practice application facts without giving them construct authority', () => {
    expect(
      TeachingPracticeApplicationContentSchema.safeParse({
        startingState: 'The source chunks have been extracted but not embedded.',
        sourceRuleOrProcedure: 'Embedding precedes vector-store insertion.',
        decisionRequired: 'Choose the next source-stated ingestion step.',
        expectedAction: 'Embed the extracted chunks.',
      }).success,
    ).toBe(true);
    expect(
      TeachingPracticeApplicationContentSchema.safeParse({
        startingState: 'The chunks are ready.',
        sourceRuleOrProcedure: 'Use the procedure.',
        decisionRequired: 'Choose what happens next.',
        expectedAction: '',
        construct: 'apply',
      }).success,
    ).toBe(false);
  });
});

describe('accepted Lesson checkpoint contract', () => {
  it('retains one exact passing Lesson predecessor before Practice generation', () => {
    expect(checkpoint()).toMatchObject({
      studySessionId: 'session_1',
      sessionAgendaId: 'agenda_1',
      agendaItemId: 'agenda_item_1',
      expectedSessionVersion: 2,
      expectedAgendaVersion: 3,
      lessonEvaluation: { status: 'pass' },
    });
  });

  it('retains a failed Lesson diagnostic while rejecting deleted or unknown slots', () => {
    const failed = structuredClone(checkpoint());
    failed.lessonEvaluation.status = 'fail';
    expect(AcceptedLessonCheckpointSchema.safeParse(failed).success).toBe(true);

    const deleted = structuredClone(checkpoint());
    deleted.lessonContent = deleted.lessonContent.filter((entry) => entry.slotId !== 'L2');
    expect(AcceptedLessonCheckpointSchema.safeParse(deleted).success).toBe(false);

    const unknown = structuredClone(checkpoint());
    unknown.lessonContent[1]!.slotId = 'L3';
    expect(AcceptedLessonCheckpointSchema.safeParse(unknown).success).toBe(false);
  });

  it('rejects provider-selected evidence outside the immutable slot authority', () => {
    const foreign = structuredClone(checkpoint());
    foreign.lessonContent[1]!.semanticRelations[0]!.sourceRefs = ['S2'];
    expect(AcceptedLessonCheckpointSchema.safeParse(foreign).success).toBe(false);
  });

  it('projects additive worked-interaction bytes while historical Lesson payloads remain readable', () => {
    const historical = checkpoint();
    expect(AcceptedLessonCheckpointSchema.safeParse(historical).success).toBe(true);

    const interactive = structuredClone(historical);
    interactive.skeleton.objectives[0]!.construct = 'apply';
    interactive.skeleton.lessonSlots[1]!.construct = 'apply';
    interactive.skeleton.lessonSlots[1]!.role = 'worked_example';
    interactive.skeleton.lessonSlots[1]!.qualityContract = 'worked_process';
    interactive.skeleton.practicePlan.slots[0]!.construct = 'apply';
    interactive.skeleton.practicePlan.slots[0]!.prohibitedStrongerConstructs = [
      'design',
      'evaluate',
    ];
    interactive.lessonContent[1]!.informalCheck = undefined;
    interactive.lessonContent[1]!.workedProcess = {
      startingState: 'Three candidates await a bounded retrieval decision.',
      inputs: ['The current condition.', 'Three candidate states.'],
      ruleOrProcedure: 'Check the condition, then apply only an authorized action.',
      steps: [
        {
          action: 'Check the condition against every candidate.',
          reason: 'The condition establishes eligibility.',
          resultingState: 'Eligible and ineligible candidates are distinguished.',
        },
        {
          action: 'Apply the authorized action to the eligible candidate.',
          reason: 'Only eligible candidates may advance.',
          resultingState: 'One bounded result remains.',
        },
      ],
      learnerDecision: 'Choose the next authorized action.',
      result: 'The eligible candidate becomes the bounded result.',
      whyResultFollows: 'The condition justified each state transition.',
      sourceRefs: ['S1'],
      interaction: workedInteraction(),
    };
    const parsed = AcceptedLessonCheckpointSchema.parse(interactive);
    expect(projectAcceptedLessonSegments(parsed, ['objective_1'])[1]?.workedProcess).toMatchObject({
      inputs: ['The current condition.', 'Three candidate states.'],
      interaction: { pauseAfterStepIndex: 0 },
      sourceRefIds: ['S1'],
    });
    const foreignInteractionSource = structuredClone(interactive);
    foreignInteractionSource.lessonContent[1]!.workedProcess!.interaction!.sourceRefs = ['S2'];
    expect(AcceptedLessonCheckpointSchema.safeParse(foreignInteractionSource).success).toBe(false);
  });
});
