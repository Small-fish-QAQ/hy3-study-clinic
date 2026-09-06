import { describe, expect, it } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
} from './payloads.js';
import { ReasoningOperationSchema } from '../domain/reasoningOperation.js';
import {
  LearnerPracticeProjectionSchema,
  LessonPracticeSurfaceSchema,
} from '../domain/lessonPractice.js';

it('keeps the eight private cognitive operations out of learner Practice projections', () => {
  expect(ReasoningOperationSchema.options).toEqual([
    'recognize',
    'classify',
    'predict_outcome',
    'diagnose_cause',
    'locate_boundary',
    'identify_missing',
    'choose_design',
    'judge_tradeoff',
  ]);
  const authored = {
    prompt: 'Which delivery path satisfies the changed requirement?',
    options: ['A', 'B', 'C'].map((id) => ({
      id,
      text: `Candidate ${id}`,
      feedbackIfSelected: `Feedback for ${id}`,
    })),
    correctOptionId: 'A',
    hint: 'Inspect the destination.',
    explanation: 'The new destination changes the routing decision.',
    reasoningOperation: 'choose_design',
    decisiveCondition: 'The destination now requires an independent audit copy.',
    requiredInference: 'Add a separate audit consumer.',
    evidenceContrast: {
      evidence: 'The destination requires an audit copy.',
      replacement: 'The destination forbids additional copies.',
      alternativeOptionId: 'B',
    },
  };
  expect(LessonPracticeSurfaceSchema.parse(authored)).toEqual(authored);
  const item = {
    index: 0,
    objectiveTitle: 'Routing',
    construct: 'identify',
    surface: 'initial',
    prompt: authored.prompt,
    options: authored.options.map(({ id, text }) => ({ id, text })),
  };
  const projection = {
    status: 'available',
    currentItemIndex: 0,
    itemCount: 1,
    item,
    attempts: [],
    completedAt: null,
    credit: 'none',
  };
  expect(LearnerPracticeProjectionSchema.safeParse(projection).success).toBe(true);
  for (const [key, value] of Object.entries({
    reasoningOperation: authored.reasoningOperation,
    decisiveCondition: authored.decisiveCondition,
    requiredInference: authored.requiredInference,
    evidenceContrast: authored.evidenceContrast,
  })) {
    expect(
      LearnerPracticeProjectionSchema.safeParse({ ...projection, item: { ...item, [key]: value } })
        .success,
    ).toBe(false);
  }
});

function lessonSlot() {
  return {
    slotId: 'L1',
    explanation: 'Limited capacity changes the result when load rises.',
    sourceRefs: ['S1'],
    visualRefs: [],
    semanticRelations: [
      {
        kind: 'cause_consequence',
        fromProposition: 'Working memory has limited capacity.',
        toProposition: 'Additional load can reduce maintained information.',
        relevanceToObjective: 'The relation explains how capacity affects performance.',
        sourceRefs: ['S1'],
      },
    ],
    workedProcess: null,
  };
}

function surface(correctOptionRef: 'A' | 'B' = 'A') {
  return {
    prompt: 'Which response uses the stated condition to reach a conclusion?',
    options: [
      { optionRef: 'A', text: 'Use the condition.', feedbackIfSelected: 'Correct.' },
      { optionRef: 'B', text: 'Repeat the label.', feedbackIfSelected: 'Try again.' },
      { optionRef: 'C', text: 'Ignore the condition.', feedbackIfSelected: 'Too broad.' },
    ],
    correctOptionRef,
    hint: 'Make the condition affect the decision.',
    explanation: 'The condition bounds the justified conclusion.',
  };
}

function practiceItem() {
  return {
    practiceSlotId: 'PR1',
    capabilityTested: 'Use the offered procedure to choose the next action.',
    pedagogicalReason: 'This elicits procedural use rather than recognition.',
    sourceRefs: ['S1'],
    visualRefs: [],
    application: {
      startingState: 'The source-stated procedure has completed its first step.',
      sourceRuleOrProcedure: 'Inspect the condition before choosing the next action.',
      decisionRequired: 'Choose the action authorized by the current condition.',
      expectedAction: 'Inspect the condition, then take its matching action.',
    },
    initial: surface('A'),
    retry: surface('B'),
  };
}

describe('compositional provider payloads', () => {
  it('accepts stable Lesson slot content with typed semantic reasoning', () => {
    expect(
      LessonSlotContentProposalPayloadSchema.parse({ slots: [lessonSlot()] }).slots[0],
    ).toMatchObject({ slotId: 'L1', workedProcess: null });
  });

  it.each([
    ['objectiveRefs', ['O1']],
    ['construct', 'explain'],
    ['role', 'mechanism'],
    ['authorityMode', 'exact_source'],
    ['explanationAuthority', 'source_backed_teaching'],
    ['activityBudget', { minMinutes: 1, maxMinutes: 2 }],
  ])('rejects provider-owned Lesson %s', (field, value) => {
    expect(
      LessonSlotContentProposalPayloadSchema.safeParse({
        slots: [{ ...lessonSlot(), [field]: value }],
      }).success,
    ).toBe(false);
  });

  it('accepts bounded Practice content with an explicit application decision', () => {
    expect(
      PracticeContentProposalPayloadSchema.parse({ items: [practiceItem()] }).items[0]?.application,
    ).toMatchObject({ expectedAction: expect.any(String) });
  });

  it.each([
    ['objectiveRef', 'O1'],
    ['construct', 'apply'],
    ['authority', 'exact_source'],
    ['authorityMode', 'exact_source'],
    ['activityBudget', { minMinutes: 2, maxMinutes: 4 }],
    ['retryPermitted', true],
    ['credit', 'none'],
  ])('rejects provider-owned Practice %s', (field, value) => {
    expect(
      PracticeContentProposalPayloadSchema.safeParse({
        items: [{ ...practiceItem(), [field]: value }],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate and unknown stable identities', () => {
    expect(
      LessonSlotContentProposalPayloadSchema.safeParse({
        slots: [lessonSlot(), lessonSlot()],
      }).success,
    ).toBe(false);
    expect(
      PracticeContentProposalPayloadSchema.safeParse({
        items: [{ ...practiceItem(), practiceSlotId: 'practice-1' }],
      }).success,
    ).toBe(false);
  });
});
