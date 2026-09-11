import { describe, it, expect } from 'vitest';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { practiceRepairReview, validatePracticeRepair } from './practiceRecovery.js';

const input: PracticeRepairInput = {
  desiredDepth: 'deep_transfer',
  unitFocus: 'focused',
  objective: {
    objectiveTitle: 'Check necessary conditions',
    construct: 'explain',
    capabilityTested: 'Distinguish a necessary condition from a sufficient one',
  },
  failedPrompt: 'The initial case has already been answered.',
  selectedAnswer: 'One satisfied condition always suffices.',
  feedback: 'The rule requires both conditions.',
  failedCase: {
    options: ['One satisfied condition always suffices.', 'Both required conditions must hold.'],
    expectedAnswer: 'Both required conditions must hold.',
    explanation: 'The original case requires a conjunction, with no additional hidden conditions.',
  },
  learnerNote: 'I confused AND with OR.',
  teachingContext: ['The original worked example is already visible.'],
  sourceExcerpts: ['The procedure requires both conditions.'],
  priorRounds: [],
  priorResponses: [],
  unseenPracticePrompts: [],
  archivedRetestPrompts: [],
};

describe('Practice repair content boundaries', () => {
  it('withholds keys and feedback from independent review while preserving the actual diagnosis evidence and depth', async () => {
    const content = await new FakeProvider().generatePracticeRepair(input);
    const review = practiceRepairReview(input, content);
    expect(review.desiredDepth).toBe('deep_transfer');
    expect(review.acceptedLesson).toMatchObject({
      selectedAnswer: input.selectedAnswer,
      learnerNote: input.learnerNote,
      failedCase: input.failedCase,
      failedChoiceFeedback: input.feedback,
    });
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain('correctOptionId');
    expect(serialized).not.toContain('feedbackIfSelected');
    expect(serialized).not.toContain(content.retest[0]!.explanation);
  });
  it('rejects replay of an exposed archived case and fabricated authority fields', async () => {
    const content = await new FakeProvider().generatePracticeRepair(input);
    expect(() =>
      validatePracticeRepair(content, {
        ...input,
        archivedRetestPrompts: [content.retest[1]!.prompt],
      }),
    ).toThrow(/repeats/);
    expect(() =>
      validatePracticeRepair({ ...content, formalEvidence: { supported: true } }, input),
    ).toThrow();
    expect(() =>
      validatePracticeRepair({ ...content, retest: [content.retest[0], content.retest[0]] }, input),
    ).toThrow(/repeats/);
  });
});
