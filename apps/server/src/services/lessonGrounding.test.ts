import { describe, expect, it, vi } from 'vitest';
import {
  LESSON_GROUNDING_POLICY_VERSION,
  LessonGroundingResultSchema,
  type LessonGroundingReview,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { teachingContentReviewMessages } from '../llm/prompts.js';
import type { LessonSlotContentGenerationInput } from '../llm/provider.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';
import { prepareTeachingReview, verifyPreparedTeaching } from './teachingContentReview.js';
import { assertPreparedLessonGrounding, prepareLessonGroundingReview } from './lessonGrounding.js';

async function fixture(computedCases = false) {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: '容量约束',
    targetMinutes: 28,
    targetDepth: 'working_fluency',
    objectives: [
      {
        objectiveRef: 'O1',
        title: '解释容量约束',
        description: '说明容量如何限制任务启动。',
        priority: 'required',
        construct: 'apply',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  const context: LessonSlotContentGenerationInput = {
    workspaceName: 'Grounding',
    learnerLocale: 'zh-CN',
    skeleton,
    computedCases,
    courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'normal' },
    sourceContext: {
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 100,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: '容量',
          text: '容量约束限制任务启动。',
          headingPath: [],
          pageNumber: null,
          slideNumber: null,
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
  const candidate = await new FakeProvider().generateLessonSlotContent(context);
  const prepared = prepareLessonGroundingReview(context, candidate);
  const proof: LessonGroundingReview = {
    policyVersion: LESSON_GROUNDING_POLICY_VERSION,
    rounds: [
      {
        logicalCallId: 'grounding',
        candidateHash: prepared.candidateHash,
        claimsHash: prepared.claimsHash,
        inputHash: prepared.inputHash,
        result: { decisions: [], findings: [] },
      },
    ],
  };
  return { context, candidate, prepared, proof };
}

describe('complete Lesson grounding', () => {
  it.each([false, true])(
    'reviews all claims without changing blind choice visibility (computed=%s)',
    async (computed) => {
      const { context, candidate, prepared, proof } = await fixture(computed);
      const process = candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!;
      const blind = JSON.stringify(prepareTeachingReview(context, candidate).input);
      expect(blind).not.toContain('feedbackIfSelected');
      expect(blind).not.toContain('correctOptionId');
      expect(blind).not.toContain('whyResultFollows');
      expect(prepared.input.candidate).toEqual(candidate);
      expect(
        prepared.input.candidate.slots.find((slot) => slot.workedProcess)!.workedProcess,
      ).toEqual(process);
      expect(prepared.input.actionIds).toEqual([]);
      const prompt = teachingContentReviewMessages(prepared.input)[0]!.content;
      expect(prompt).toContain('Correct concise teaching is acceptable');
      expect(prompt).toContain('Intentional distractors');
      expect(prompt).toContain('Return no decisions');
      expect(() => assertPreparedLessonGrounding(candidate, context, proof)).not.toThrow();
      expect(await new FakeProvider().reviewTeachingContent(prepared.input)).toEqual({
        decisions: [],
        findings: [],
      });
    },
  );

  it.each([
    'claim',
    'key',
    'source',
    'authority',
    'policy',
    'plan',
    'visual',
    'learning',
    'locale',
  ] as const)('invalidates the exact prepared proof when %s changes', async (change) => {
    const f = await fixture();
    const process = f.candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!;
    if (change === 'claim')
      process.interaction!.activity.options[1]!.feedbackIfSelected += 'Changed claim.';
    else if (change === 'key') process.interaction!.activity.correctOptionId = 'C';
    else if (change === 'source') f.context.sourceContext.offers[0]!.text += 'Changed source.';
    else if (change === 'authority')
      f.context.sourceContext.offers[0]!.authorizedObjectiveRefs = [];
    else if (change === 'policy') f.proof.policyVersion = 'obsolete';
    else if (change === 'plan') f.context.skeleton.objectives[0]!.description += 'Changed plan.';
    else if (change === 'visual') f.context.visualContext.serializedBytes += 1;
    else if (change === 'learning')
      f.context.learningContext.concepts.push({ name: 'New', summary: 'Changed context.' });
    else f.context.workspaceName += 'Changed context.';
    expect(() => assertPreparedLessonGrounding(f.candidate, f.context, f.proof)).toThrow();
  });

  it.each(['packet', 'candidate', 'context'] as const)(
    'rejects %s mutation during review',
    async (change) => {
      const f = await fixture();
      if (change === 'packet') f.prepared.input.candidate.slots[0]!.explanation += 'Changed.';
      else if (change === 'candidate') f.candidate.narrative!.summary += 'Changed.';
      else f.context.sourceContext.offers[0]!.text += 'Changed.';
      expect(f.prepared.validate({ decisions: [], findings: [] }).valid).toBe(false);
    },
  );

  it('cannot turn rich authored answers into a solving proof and retains advisory quality opinions separately', async () => {
    const f = await fixture();
    const finding: TeachingContentReview['findings'][number] = {
      itemId: f.candidate.slots[0]!.slotId,
      code: 'shallow_task',
      problem: 'Prefer more detail.',
      repairInstruction: 'Make it longer.',
    };
    const qualityOnly = LessonGroundingResultSchema.parse({
      decisions: [],
      findings: [],
      advisories: [finding, { ...finding, code: 'weak_transfer' }],
    });
    expect(f.prepared.validate(qualityOnly).valid).toBe(true);
    expect(f.prepared.findings(qualityOnly)).toEqual([]);
    f.proof.rounds[0]!.result = qualityOnly;
    expect(() => assertPreparedLessonGrounding(f.candidate, f.context, f.proof)).not.toThrow();
    expect(f.proof.rounds[0]!.result.advisories).toHaveLength(2);
    expect(
      f.prepared.validate({
        decisions: [
          {
            actionId: 'L1.guided',
            answerId: 'A',
            requiresCaseInference: true,
            evidenceUsed: 'Authored key.',
          },
        ],
        findings: [],
      }).valid,
    ).toBe(false);
    expect(
      f.prepared.validate({ decisions: [], findings: [{ ...finding, itemId: 'L99' }] }).valid,
    ).toBe(false);
  });

  it.each([
    'accuracy',
    'grounding',
    'insufficient_evidence',
    'misconception',
    'answer_leak',
    'revealing_hint',
    'practice_replay',
    'shallow_task',
    'weak_transfer',
  ] as const)(
    'cannot certify a reported material false claim under generic code %s',
    async (code) => {
      const f = await fixture();
      const result = {
        decisions: [],
        findings: [
          {
            itemId: f.candidate.slots.find((slot) => slot.workedProcess)!.slotId,
            code,
            problem:
              'The final rationale contradicts the current state: 4 minus 2 leaves 2, not 3.',
            repairInstruction: 'Correct the delayed rationale.',
          },
        ],
      };
      const permitted = [
        'accuracy',
        'grounding',
        'insufficient_evidence',
        'misconception',
      ].includes(code);
      expect(f.prepared.validate(result).valid).toBe(permitted);
      if (permitted)
        expect(f.prepared.findings(result)).toEqual(
          result.findings.map((finding) => ({
            ...finding,
            problem: `${finding.itemId}: ${finding.problem}`,
          })),
        );
      f.proof.rounds[0]!.result = result;
      expect(() => assertPreparedLessonGrounding(f.candidate, f.context, f.proof)).toThrow();
    },
  );

  it('cannot hide a correctness finding in the quality inventory', async () => {
    const f = await fixture();
    expect(
      f.prepared.validate({
        decisions: [],
        findings: [],
        advisories: [
          {
            itemId: f.candidate.slots[0]!.slotId,
            code: 'insufficient_evidence',
            problem: 'An unsupported source claim.',
            repairInstruction: 'Remove or correct the claim.',
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it.each([false, true])(
    'actual Fake verifies its complete supported fixture (computed=%s)',
    async (computed) => {
      const f = await fixture(computed);
      const provider = new FakeProvider();
      const review = async (prepared: typeof f.prepared, round: number) => ({
        logicalCallId: `fake-ground-${round}`,
        result: await provider.reviewTeachingContent(prepared.input),
      });
      const verified = await verifyPreparedTeaching(
        f.context,
        f.candidate,
        vi.fn(),
        vi.fn(),
        new Set(),
        {
          reviewChoices: () => false,
          review,
        },
      );
      expect(verified.groundingReview!.rounds[0]!.result.findings).toEqual([]);
      expect(() =>
        assertPreparedLessonGrounding(f.candidate, f.context, verified.groundingReview),
      ).not.toThrow();
    },
  );

  it('verifies offered Lesson teaching without demanding Formal or Practice authority', async () => {
    const f = await fixture();
    f.context.sourceContext.offers[0]!.authorizedObjectiveRefs = [];
    const prepared = prepareLessonGroundingReview(f.context, f.candidate);
    expect(await new FakeProvider().reviewTeachingContent(prepared.input)).toEqual({
      decisions: [],
      findings: [],
    });
    // An earlier receipt still cannot inherit authority from this changed context.
    expect(() => assertPreparedLessonGrounding(f.candidate, f.context, f.proof)).toThrow();
  });

  it.each([
    'false_debrief',
    'false_continuation',
    'false_final_rationale',
    'wrong_private_key',
    'unknown_claim',
    'source_change',
    'missing_source',
  ] as const)('actual Fake fails closed for %s through the production verifier', async (defect) => {
    const f = await fixture(true);
    const process = f.candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!;
    if (defect === 'false_debrief')
      process.interaction!.activity.correctDebrief = '甲启动后仍有3个空闲配额，乙可以同时启动。';
    else if (defect === 'false_continuation')
      process.steps.at(-1)!.resultingState = '甲、乙同时运行，仍有空闲资源。';
    else if (defect === 'false_final_rationale')
      process.whyResultFollows = 'Two plus two equals five; the allocation is valid.';
    else if (defect === 'wrong_private_key') process.interaction!.transfer.correctOptionId = 'A';
    else if (defect === 'unknown_claim')
      process.whyResultFollows =
        'This previously unseen processor can borrow capacity from the future.';
    else if (defect === 'source_change')
      f.context.sourceContext.offers[0]!.text = 'A different authorized source.';
    else f.context.sourceContext.offers = [];
    const provider = new FakeProvider();
    const prepared = prepareLessonGroundingReview(f.context, f.candidate);
    const result = await provider.reviewTeachingContent(prepared.input);
    expect(prepared.validate(result).valid).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    const revise = vi.fn(async (draft: typeof f.candidate) => draft);
    await expect(
      verifyPreparedTeaching(f.context, f.candidate, vi.fn(), revise, new Set(), {
        reviewChoices: () => false,
        review: async (input, round) => ({
          result: await provider.reviewTeachingContent(input.input),
          logicalCallId: `fake-${round}`,
        }),
      }),
    ).rejects.toMatchObject({
      details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
    });
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps one bounded revision loop for grounding (improving=%s)',
    async (improving) => {
      const f = await fixture();
      const revised = vi.fn(async (draft: typeof f.candidate) => {
        const result = structuredClone(draft);
        if (improving) result.slots[0]!.explanation += ' Corrected.';
        return result;
      });
      const ground = vi.fn(async (prepared: typeof f.prepared, round: number) => ({
        logicalCallId: `ground-${round}`,
        result: {
          decisions: [],
          findings:
            round < (improving ? 2 : 3)
              ? [
                  {
                    itemId: prepared.input.candidate.slots[0]!.slotId,
                    code:
                      round === 0 || !improving ? ('accuracy' as const) : ('grounding' as const),
                    problem: 'Concrete wrong claim.',
                    repairInstruction: 'Correct the claim.',
                  },
                ]
              : [],
        },
      }));
      const blind = vi.fn();
      const pending = verifyPreparedTeaching(f.context, f.candidate, blind, revised, new Set(), {
        reviewChoices: () => false,
        review: ground,
      });
      if (improving) expect((await pending).groundingReview!.rounds).toHaveLength(3);
      else
        await expect(pending).rejects.toMatchObject({
          details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
        });
      expect(ground).toHaveBeenCalledTimes(improving ? 3 : 2);
      expect(revised).toHaveBeenCalledTimes(improving ? 2 : 1);
      expect(blind).not.toHaveBeenCalled();
    },
  );

  it('does not revise after a cancelled grounding call', async () => {
    const f = await fixture();
    const revise = vi.fn();
    await expect(
      verifyPreparedTeaching(f.context, f.candidate, vi.fn(), revise, new Set(), {
        reviewChoices: () => false,
        review: async () => {
          throw new Error('Cancelled');
        },
      }),
    ).rejects.toThrow('Cancelled');
    expect(revise).not.toHaveBeenCalled();
  });
});
