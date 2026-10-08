import { describe, it, expect } from 'vitest';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { validatePracticeRepair } from './practiceRecovery.js';
import { preparePracticeRepairReviews } from './practiceRepairAcceptance.js';

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
  it('grounds complete claims but isolates each blind solve from hidden and future evidence', async () => {
    const content = await new FakeProvider().generatePracticeRepair(input);
    const review = preparePracticeRepairReviews(input, content);
    expect(review.grounding.desiredDepth).toBe('deep_transfer');
    expect(review.grounding.evidence).toMatchObject({
      selectedAnswer: input.selectedAnswer,
      learnerNote: input.learnerNote,
      failedCase: input.failedCase,
      feedback: input.feedback,
    });
    expect(review.grounding.candidate).toEqual(content);
    const serialized = JSON.stringify(review.solves);
    expect(serialized).not.toContain('correctOptionId');
    expect(serialized).not.toContain('feedbackIfSelected');
    expect(serialized).not.toContain(content.retest[0]!.explanation);
    expect(JSON.stringify(review.solves[0])).not.toContain(content.retest[1]!.prompt);
    expect(JSON.stringify(review.solves[1])).not.toContain(content.retest[0]!.prompt);
    expect(serialized).not.toContain(input.failedCase!.explanation);
    expect(serialized).not.toContain(input.sourceExcerpts[0]);
    expect(serialized).not.toContain(input.learnerNote);
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
