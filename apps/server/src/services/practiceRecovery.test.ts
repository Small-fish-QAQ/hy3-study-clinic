import { describe, it, expect } from 'vitest';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { validatePracticeRepair } from './practiceRecovery.js';
import { preparePracticeRepairReviews } from './practiceRepairAcceptance.js';
import { repairPublicTask } from '../llm/practiceRepair.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import {
  forwardTask,
  forwardTruth,
  reverseTask,
  reverseTruth,
  interventionTask,
  interventionTruth,
  literalTask,
  repairTemplate,
} from '../testing/practiceRepairComparisonFixture.js';

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
  unseenPracticeTasks: [],
  currentPracticeTasks: [],
  archivedRetestTasks: [],
};

describe('Practice repair content boundaries', () => {
  it.each(['missing key', 'unoffered key'])(
    'rejects a %s at actual candidate validation',
    async (defect) => {
      const content = await new FakeProvider().generatePracticeRepair(input);
      const valid = structuredClone(content);
      const raw: unknown = content;
      if (defect === 'missing key')
        delete (content.retest[0] as Partial<(typeof content.retest)[0]>)!.correctOptionId;
      else content.retest[0]!.correctOptionId = 'unoffered';
      expect(validatePracticeRepair(valid, input)).toEqual(valid);
      expect(() => validatePracticeRepair(raw, input)).toThrow();
    },
  );

  it.each([
    'failed case',
    'unseen Practice',
    'archive',
    'prior round',
    'worked example',
    'Tutor template',
  ])('admits new option-defined deciding cases despite the same prompt (%s)', async (location) => {
    expect(forwardTruth()).toEqual([true, false, false]);
    expect(reverseTruth()).toEqual([true, false, false]);
    expect(interventionTruth()).toEqual([true, false, false]);
    const content = await new FakeProvider().generatePracticeRepair(input);
    const context = structuredClone(input);
    const prior = structuredClone(content);
    prior.retest[0] = structuredClone(forwardTask);
    content.retest = [structuredClone(reverseTask), structuredClone(interventionTask)];
    if (location === 'failed case') {
      context.failedPrompt = forwardTask.prompt;
      context.failedCase!.options = forwardTask.options.map(({ text }) => text);
    }
    if (location === 'unseen Practice')
      context.unseenPracticeTasks = [repairPublicTask(forwardTask)];
    if (location === 'archive') context.archivedRetestTasks = [repairPublicTask(forwardTask)];
    if (location === 'prior round') context.priorRounds = [prior];
    if (location === 'worked example') content.workedExample.prompt = repairTemplate;
    if (location === 'Tutor template')
      context.tutorExplanations = [`通用问题模板：${repairTemplate}`];
    expect(validatePracticeRepair(content, context)).toEqual(content);
    // Local admission is never a novelty proof: both cases still reach the
    // actual integrity input, together with complete comparison alternatives.
    const prepared = preparePracticeRepairReviews(context, content);
    expect(prepared.integrity.candidate).toHaveLength(2);
    if (['failed case', 'prior round'].includes(location))
      expect(prepared.integrity.comparisonTasks).toContainEqual(repairPublicTask(forwardTask));
    if (['unseen Practice', 'archive'].includes(location))
      expect(prepared.integrity.comparisonTasks).not.toContainEqual(repairPublicTask(forwardTask));
  });

  it('preserves quoted literal whitespace instead of conflating different outcomes', async () => {
    expect('a b' === String('ab')).toBe(false);
    const content = await new FakeProvider().generatePracticeRepair(input);
    content.retest[0] = literalTask('ab');
    const context = {
      ...input,
      archivedRetestTasks: [repairPublicTask(literalTask('a b'))],
      tutorExplanations: [`已讲解：${literalTask('a b').prompt} 结论：禁止。`],
    };
    expect(validatePracticeRepair(content, context)).toEqual(content);
    expect(preparePracticeRepairReviews(context, content).integrity.priorTeaching).toContain(
      context.tutorExplanations[0],
    );
  });

  it.each(['identical', 'reordered and relabelled', 'private feedback'])(
    'rejects a complete reserved deciding task (%s), including on proof construction',
    async (change) => {
      const content = await new FakeProvider().generatePracticeRepair(input);
      content.retest[0] = structuredClone(reverseTask);
      const context = { ...input, archivedRetestTasks: [repairPublicTask(reverseTask)] };
      if (change === 'reordered and relabelled')
        content.retest[0]!.options = [...content.retest[0]!.options]
          .reverse()
          .map((option, index) => ({
            ...option,
            id: ['A', 'B', 'C'][index]!,
          }));
      if (change === 'private feedback')
        content.retest[0]!.explanation += ' Private author comment.';
      expect(() => validatePracticeRepair(content, context)).toThrow(/repeats/);
      expect(() => preparePracticeRepairReviews(context, content)).toThrow(/repeats/);
    },
  );

  it.each(['new options', 'corrected collision', 'exhausted collision'])(
    'runs the real Hy3 candidate callback through bounded local transport (%s)',
    async (mode) => {
      const candidate = await new FakeProvider().generatePracticeRepair(input);
      candidate.retest = [structuredClone(reverseTask), structuredClone(interventionTask)];
      const collision = {
        ...candidate,
        retest: [structuredClone(forwardTask), candidate.retest[1]!],
      };
      const context = { ...input, unseenPracticeTasks: [repairPublicTask(forwardTask)] };
      let calls = 0;
      const provider = new Hy3Provider({
        baseUrl: 'https://offline.test/v1',
        apiKey: 'test-only',
        model: 'stub',
        timeoutMs: 30000,
        fetchImpl: async () => {
          calls++;
          const content =
            mode === 'new options' || (mode === 'corrected collision' && calls > 1)
              ? candidate
              : collision;
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      });
      const run = provider.generatePracticeRepair(context, {
        validateCandidate: (raw) => {
          try {
            validatePracticeRepair(raw, context);
            return { valid: true, diagnostics: [] };
          } catch {
            return {
              valid: false,
              diagnostics: ['Complete public task replay.'],
              diagnosticCodes: ['practice_repair_invalid'],
            };
          }
        },
      });
      if (mode === 'exhausted collision')
        await expect(run).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
      else expect(await run).toEqual(candidate);
      expect(calls).toBe(mode === 'new options' ? 1 : 2);
    },
  );

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
        archivedRetestTasks: [repairPublicTask(content.retest[1]!)],
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
