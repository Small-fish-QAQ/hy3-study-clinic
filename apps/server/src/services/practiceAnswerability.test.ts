import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiErrorCode,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  PracticeContentProposalPayloadSchema,
  TeachingBriefSchema,
  TeachingLessonSlotContentsSchema,
  TeachingSkeletonSchema,
  projectLearnerPracticeSurface,
  projectPracticePriorTeaching,
  type TeachingBrief,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import type {
  PracticeContentGenerationInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import { teachingContentReviewMessages } from '../llm/prompts.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { validatePracticeContentCandidate } from './teachingBriefContract.js';
import {
  hasCurrentPracticeAnswerabilityReview,
  preparePracticeAnswerabilityReview,
  prepareTeachingReview,
  verifyPreparedPractice,
} from './teachingContentReview.js';

const snapshot = JSON.parse(
  readFileSync(
    new URL(
      '../../../../eval/final-showcase/runs/scored-01/cases/J18/final.snapshot.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  rows: {
    teaching_briefs: Array<{ payload: string }>;
    accepted_lesson_checkpoints: Array<{
      skeleton_payload: string;
      lesson_payload: string;
      lesson_evaluation_payload: string;
    }>;
  };
};

const publicGivens =
  '记录集：A(优先级1,时长5), B(优先级1,时长9), C(优先级2,时长2), D(优先级2,时长4)。';

function fixture(complete = false) {
  const row = snapshot.rows.accepted_lesson_checkpoints[0]!;
  const evaluation = JSON.parse(row.lesson_evaluation_payload) as {
    jointAuthoring: { practiceCandidate: unknown };
  };
  const candidate = PracticeContentProposalPayloadSchema.parse(
    evaluation.jointAuthoring.practiceCandidate,
  );
  if (complete)
    candidate.items[0]!.initial.prompt = publicGivens + candidate.items[0]!.initial.prompt;
  // Keep the unsupported captured Brief intact for public-content projection.
  // This fixture is never admitted as a current Brief; the regression below
  // asserts its strict rejection. Each solve test obtains fresh purpose proofs.
  const brief = JSON.parse(snapshot.rows.teaching_briefs[0]!.payload) as TeachingBrief;
  // Only this quoted rule is exposed by the Lesson. The full source offer is
  // available to grounding, but must not become a new case's missing givens.
  const quote = '仅当主键相等时比较次键；每个键有独立方向。';
  brief.sourceReferences[0]!.quote = quote;
  brief.segments[0]!.sourceRefIds = [brief.sourceReferences[0]!.refId];
  const context: PracticeContentGenerationInput = {
    workspaceName: 'J18 regression',
    learnerLocale: 'zh-CN',
    skeleton: TeachingSkeletonSchema.parse(JSON.parse(row.skeleton_payload)),
    acceptedLesson: TeachingLessonSlotContentsSchema.parse(JSON.parse(row.lesson_payload)),
    sourceContext: {
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 200,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: 'Stable sorting',
          headingPath: [],
          pageNumber: null,
          slideNumber: null,
          text: `${quote} PRIVATE_UNSHOWN_SOURCE_GIVENS ${publicGivens}`,
          authorizedObjectiveRefs: ['O1', 'O2'],
        },
      ],
    },
    visualContext: { offerCount: 0, serializedBytes: 0, offers: [] },
  };
  const priorTeaching = projectPracticePriorTeaching(brief);
  const requests: TeachingContentReviewInput[] = [];
  const review = vi.fn(async (prepared: { input: TeachingContentReviewInput }, round: number) => {
    const input = structuredClone(prepared.input);
    requests.push(input);
    const result: TeachingContentReview = { decisions: [], findings: [] };
    if (input.purpose === 'practice_answerability') {
      const actionId = input.actionIds[0]!;
      // Fixed J18 truth table, using the public question only. This is a
      // transport stub, not a general language solver or a private-key oracle.
      const answerId =
        actionId === 'PR1.initial'
          ? input.candidate.prompt.includes(publicGivens)
            ? 'A'
            : null
          : actionId.endsWith('.retry')
            ? 'B'
            : 'A';
      result.decisions.push({
        actionId,
        answerId,
        requiresCaseInference: true,
        evidenceUsed:
          answerId === null
            ? 'The current prompt omits the records and their comparison keys.'
            : 'The visible records and stated rule distinguish this one offered answer.',
      });
    }
    return {
      result,
      logicalCallId: `${input.purpose}:${round}:${input.actionIds[0] ?? 'grounding'}`,
    };
  });
  const revise = vi.fn(async (draft: typeof candidate) => draft);
  const verify = () => verifyPreparedPractice(context, candidate, priorTeaching, review, revise);
  const saved = (verified: Awaited<ReturnType<typeof verify>>) => {
    for (const [index, item] of verified.candidate.items.entries())
      for (const name of ['initial', 'retry'] as const) {
        const surface = brief.practice!.items[index]![name];
        const authored = item[name];
        surface.prompt = authored.prompt;
        surface.correctOptionId = `${brief.practice!.items[index]!.id}_${name}_${authored.correctOptionRef}`;
        surface.options = authored.options.map(({ optionRef, text, feedbackIfSelected }) => ({
          id: `${brief.practice!.items[index]!.id}_${name}_${optionRef}`,
          text,
          feedbackIfSelected,
        }));
      }
    brief.practice!.qualityEvaluation.contentReview = verified.receipts;
    brief.practice!.qualityEvaluation.answerabilityReview = verified.answerabilityReview;
    return brief;
  };
  return { candidate, context, brief, priorTeaching, requests, review, revise, verify, saved };
}

describe('learner-visible prepared Practice answerability', () => {
  it('rejects the intact captured J18 Brief instead of stripping its obsolete combined receipt', () => {
    const payload = snapshot.rows.teaching_briefs[0]!.payload;
    const captured = JSON.parse(payload) as TeachingBrief;
    const review = captured.practice!.qualityEvaluation.contentReview![0]!;
    expect(review.result.decisions.length).toBeGreaterThan(0);
    const parsed = TeachingBriefSchema.safeParse(captured);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['practice', 'qualityEvaluation', 'contentReview', 0, 'result', 'decisions'],
          code: 'too_big',
        }),
      );
    fixture(true);
    expect(JSON.parse(snapshot.rows.teaching_briefs[0]!.payload)).toEqual(captured);
    expect(snapshot.rows.teaching_briefs[0]!.payload).toBe(payload);
  });

  it('projects completed prior teaching without conditional help, private Lesson declarations or unused source offers', () => {
    const f = fixture(true);
    const worked = f.brief.segments.find(
      (segment) => segment.workedProcess?.interaction,
    )!.workedProcess!;
    worked.learnerDecision = 'PRIVATE_LESSON_DECISION';
    worked.interaction!.hint = 'PRIVATE_CONDITIONAL_HINT';
    worked.interaction!.scaffold.prompt = 'PRIVATE_CONDITIONAL_SCAFFOLD';
    worked.interaction!.activity.correctDebrief = 'PRIVATE_AUTHOR_DEBRIEF';
    worked.interaction!.activity.options[0]!.feedbackIfSelected = 'PRIVATE_UNSELECTED_FEEDBACK';
    worked.interaction!.sourceRefs = [f.brief.sourceReferences[0]!.refId];
    const visible = projectPracticePriorTeaching(f.brief);
    expect(JSON.stringify(visible)).not.toMatch(/PRIVATE_[A-Z_]+/u);
    expect(JSON.stringify(visible)).toContain(worked.ruleOrProcedure);
    expect(JSON.stringify(visible)).toContain(worked.result);
    expect(JSON.stringify(visible)).toContain(worked.steps.at(-1)!.resultingState);
    expect(
      visible.segments.find((segment) => segment.workedProcess?.activity)!.workedProcess!
        .interactionSources,
    ).toEqual([{ exactExcerpt: f.brief.sourceReferences[0]!.quote }]);
    const nonInteractive = structuredClone(f.brief);
    const publicProcess = nonInteractive.segments.find(
      (segment) => segment.workedProcess,
    )!.workedProcess!;
    delete publicProcess.interaction;
    publicProcess.learnerDecision = 'PUBLIC_LESSON_DECISION';
    expect(JSON.stringify(projectPracticePriorTeaching(nonInteractive))).toContain(
      'PUBLIC_LESSON_DECISION',
    );
  });
  it('rejects historical J18 despite complete private application and successful rich grounding', async () => {
    const f = fixture();
    expect(f.candidate.items[0]!.application!.startingState).toContain(publicGivens.slice(4));
    await expect(f.verify()).rejects.toMatchObject({
      details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
    });
    expect(f.revise).toHaveBeenCalledTimes(1);
    expect(f.requests.filter((input) => input.purpose === 'practice_grounding')).toHaveLength(2);
    const initial = f.requests.find(
      (input) => input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
    )!;
    expect(JSON.stringify(initial)).not.toContain(publicGivens);
    expect(JSON.stringify(initial)).not.toContain('PRIVATE_UNSHOWN_SOURCE_GIVENS');
    await expect(f.review.mock.results[0]!.value).resolves.toMatchObject({
      result: { findings: [], decisions: [] },
    });
  });

  it('accepts complete visible J18 givens, verifies the unique offered answer and binds the saved key', async () => {
    const f = fixture(true);
    const records = [
      { name: 'A', priority: 1, duration: 5 },
      { name: 'B', priority: 1, duration: 9 },
      { name: 'C', priority: 2, duration: 2 },
      { name: 'D', priority: 2, duration: 4 },
    ];
    const orders = [
      [-1, -1],
      [1, 1],
      [1, -1],
    ].map(([primary, secondary]) =>
      records
        .toSorted(
          (a, b) => primary! * (a.priority - b.priority) || secondary! * (a.duration - b.duration),
        )
        .map((record) => record.name)
        .join(','),
    );
    expect(orders).toEqual(['D,C,B,A', 'A,B,C,D', 'B,A,D,C']);
    expect(orders.filter((order) => order === 'D,C,B,A')).toHaveLength(1);
    const verified = await f.verify();
    expect(verified.answerabilityReview.rounds).toHaveLength(1);
    expect(verified.answerabilityReview.rounds[0]!.solves).toHaveLength(4);
    expect(hasCurrentPracticeAnswerabilityReview(f.saved(verified))).toBe(true);
    expect(f.revise).not.toHaveBeenCalled();
  });

  it('rejects the same visible question with saved key B instead of A', async () => {
    const f = fixture(true);
    f.candidate.items[0]!.initial.correctOptionRef = 'B';
    f.candidate.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
    await expect(f.verify()).rejects.toBeDefined();
    expect(f.revise.mock.calls[0]![0].items[0]!.initial.correctOptionRef).toBe('B');
    expect(
      f.requests.filter(
        (input) =>
          input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
      ),
    ).toHaveLength(2);
  });

  it('accepts a bounded revision that adds missing public givens and rechecks every surface', async () => {
    const f = fixture();
    f.revise.mockImplementation(async (draft) => {
      const revised = structuredClone(draft);
      revised.items[0]!.initial.prompt = publicGivens + revised.items[0]!.initial.prompt;
      return revised;
    });
    const verified = await f.verify();
    expect(f.revise).toHaveBeenCalledTimes(1);
    expect(verified.answerabilityReview.rounds).toHaveLength(2);
    expect(
      verified.answerabilityReview.rounds.map(
        (round) => round.solves[0]!.result.decisions[0]!.answerId,
      ),
    ).toEqual([null, 'A']);
    expect(verified.receipts.map((receipt) => receipt.result.findings)).toEqual([[], []]);
    expect(hasCurrentPracticeAnswerabilityReview(f.saved(verified))).toBe(true);
  });

  it('does not let retry or another future question supply initial givens', async () => {
    const f = fixture();
    expect(f.candidate.items[0]!.retry.prompt).toContain('A(1,5)');
    f.candidate.items[1]!.initial.prompt += ` FUTURE_PRACTICE_SURFACE ${publicGivens}`;
    await expect(f.verify()).rejects.toBeDefined();
    const initial = f.requests.filter(
      (input) => input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
    );
    expect(initial).toHaveLength(2);
    for (const input of initial) {
      expect(JSON.stringify(input)).not.toContain('A(1,5)');
      expect(JSON.stringify(input)).not.toContain('FUTURE_PRACTICE_SURFACE');
      expect(input.actionIds).toEqual(['PR1.initial']);
    }
  });

  it('keeps all private sentinels out of the serialized solve while preserving public teaching and excerpts', async () => {
    const f = fixture(true);
    const item = f.candidate.items[0]!;
    item.application!.startingState += ' PRIVATE_APPLICATION';
    item.application!.sourceRuleOrProcedure += ' PRIVATE_RULE';
    item.application!.expectedAction += ' PRIVATE_EXPECTED_ACTION';
    item.capabilityTested += ' PRIVATE_CAPABILITY';
    item.pedagogicalReason += ' PRIVATE_PEDAGOGY';
    item.initial.requiredInference = 'PRIVATE_INFERENCE';
    item.initial.hint = 'PRIVATE_HINT';
    item.initial.explanation = 'PRIVATE_EXPLANATION';
    item.initial.options[0]!.feedbackIfSelected = 'PRIVATE_FEEDBACK';
    f.context.acceptedLesson[0]!.workedProcess = f.context.acceptedLesson[1]!.workedProcess;
    f.context.acceptedLesson[0]!.workedProcess!.learnerDecision = 'PRIVATE_LESSON_DECISION';
    await f.verify();
    const solves = f.requests.filter((input) => input.purpose === 'practice_answerability');
    for (const input of solves) {
      const messages = JSON.stringify(teachingContentReviewMessages(input));
      expect(messages).not.toMatch(/PRIVATE_[A-Z_]+/u);
      expect(messages).not.toContain('"correctOptionRef"');
      expect(messages).not.toContain('"correctOptionId"');
      expect(messages).toContain('仅当主键相等时比较次键');
      expect(messages).toContain(f.brief.segments[0]!.explanation);
    }
    const rich = f.requests.find((input) => input.purpose === 'practice_grounding')!;
    expect(JSON.stringify(rich)).toContain('PRIVATE_APPLICATION');
    expect(JSON.stringify(rich)).toContain('PRIVATE_UNSHOWN_SOURCE_GIVENS');
    const authoredSurface = {
      ...item.initial,
      options: item.initial.options.map(({ optionRef, ...option }) => ({
        id: optionRef,
        ...option,
      })),
      correctOptionId: 'PRIVATE_KEY',
    };
    const prepared = preparePracticeAnswerabilityReview(
      authoredSurface,
      f.priorTeaching,
      'PR1.initial',
      'PR1',
    );
    expect(JSON.stringify(prepared.input)).not.toContain('PRIVATE_KEY');
    expect(prepared.input.candidate).toEqual({
      actionId: 'PR1.initial',
      ...projectLearnerPracticeSurface(authoredSurface),
    });
  });

  it('rejects source/factual defects even when every learner-visible solve succeeds', async () => {
    const f = fixture(true);
    const review = f.review.getMockImplementation()!;
    f.review.mockImplementation(async (prepared, round) => {
      const response = await review(prepared, round);
      if (prepared.input.purpose === 'practice_grounding')
        response.result.findings.push({
          itemId: 'PR1',
          code: 'accuracy',
          problem: 'The authored rule contradicts the source at the equality boundary.',
          responsibility: 'grounding',
          repairInstruction: 'Restore the exact source rule.',
        });
      return response;
    });
    await expect(f.verify()).rejects.toMatchObject({
      details: {
        candidateFailure: {
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'accuracy' })]),
        },
      },
    });
  });

  it.each(['source-backed', 'supplementary', 'computed'] as const)(
    'retains valid %s Practice and independently checks every surface',
    async (kind) => {
      const f = fixture(true);
      f.candidate.items[0]!.sourceRefs = kind === 'source-backed' ? ['S1'] : [];
      if (kind === 'source-backed')
        f.context.sourceContext.offers[0]!.text =
          f.candidate.items[0]!.application!.sourceRuleOrProcedure;
      f.context.computedCases = kind === 'computed';
      expect(validatePracticeContentCandidate(f.candidate, f.context).diagnostics).toEqual([]);
      const verified = await f.verify();
      expect(verified.answerabilityReview.policyVersion).toBe(
        PRACTICE_ANSWERABILITY_POLICY_VERSION,
      );
      expect(f.requests.filter((input) => input.purpose === 'practice_answerability')).toHaveLength(
        4,
      );
      expect(f.requests.filter((input) => input.purpose === 'practice_grounding')).toHaveLength(1);
      expect(hasCurrentPracticeAnswerabilityReview(f.saved(verified))).toBe(true);
    },
  );

  it('rejects an unoffered option through bounded revision and never exempts computed surfaces', async () => {
    const f = fixture(true);
    f.context.computedCases = true;
    const review = f.review.getMockImplementation()!;
    f.review.mockImplementation(async (prepared, round) => {
      const response = await review(prepared, round);
      if (prepared.input.purpose === 'practice_answerability')
        response.result.decisions[0]!.answerId = 'E';
      return response;
    });
    await expect(f.verify()).rejects.toBeDefined();
    expect(f.revise).toHaveBeenCalledTimes(1);
    const prepared = preparePracticeAnswerabilityReview(
      { prompt: 'Public question?', options: [{ id: 'A', text: 'First' }] },
      f.priorTeaching,
      'PR1.initial',
      'PR1',
    );
    expect(prepared.validate({ decisions: [], findings: [] }).valid).toBe(false);
    expect(
      prepared.validate({
        decisions: [
          {
            actionId: 'PR2.initial',
            answerId: 'A',
            requiresCaseInference: true,
            evidenceUsed: 'A fact',
          },
        ],
        findings: [],
      }).valid,
    ).toBe(false);
  });

  it('refuses missing/stale proofs, changed visible inputs, changed saved keys and transplanted source context', async () => {
    const f = fixture(true);
    const saved = f.saved(await f.verify());
    expect(hasCurrentPracticeAnswerabilityReview(saved)).toBe(true);
    for (const mutate of [
      (brief: typeof saved) => {
        delete brief.practice!.qualityEvaluation.answerabilityReview;
      },
      (brief: typeof saved) => {
        brief.practice!.qualityEvaluation.answerabilityReview!.policyVersion =
          'practice-answerability-obsolete';
      },
      (brief: typeof saved) => {
        brief.practice!.items[0]!.initial.prompt += ' changed case';
      },
      (brief: typeof saved) => {
        brief.practice!.items[0]!.initial.correctOptionId =
          brief.practice!.items[0]!.initial.options[1]!.id;
      },
      (brief: typeof saved) => {
        brief.sourceReferences[0]!.quote += ' new rule';
      },
    ]) {
      const changed = structuredClone(saved);
      mutate(changed);
      expect(hasCurrentPracticeAnswerabilityReview(changed)).toBe(false);
    }
  });
});

/** Keep J18's first authored case; use explicit generated Fake fixtures elsewhere. */
async function realFakeFixture(complete = false) {
  const f = fixture(complete);
  const provider = new FakeProvider();
  const known = await provider.generatePracticeContent(f.context);
  f.candidate.items[0]!.retry = known.items[0]!.retry;
  for (let index = 1; index < f.candidate.items.length; index += 1)
    f.candidate.items[index] = known.items[index]!;
  const requests: TeachingContentReviewInput[] = [];
  const reviews: TeachingContentReview[] = [];
  const review: Parameters<typeof verifyPreparedPractice>[3] = async (prepared, round) => {
    requests.push(structuredClone(prepared.input));
    const result = await provider.reviewTeachingContent(prepared.input, {
      validateCandidate: prepared.validate,
    });
    expect(prepared.validate(result).valid).toBe(true);
    reviews.push(result);
    return {
      result,
      logicalCallId: `real-fake:${round}:${prepared.input.actionIds[0] ?? 'grounding'}`,
    };
  };
  const verify = () =>
    verifyPreparedPractice(f.context, f.candidate, f.priorTeaching, review, f.revise);
  return { ...f, provider, requests, reviews, review, verify };
}

describe('real FakeProvider learner-visible Practice answerability', () => {
  it.each(['missing_givens', 'wrong_key', 'grounding'] as const)(
    'keeps %s hard with complete or absent declarations',
    async (defect) => {
      for (const omit of [false, true]) {
        const f = await realFakeFixture(defect !== 'missing_givens');
        if (omit)
          for (const item of f.candidate.items)
            for (const surface of [item.initial, item.retry]) {
              delete surface.reasoningOperation;
              delete surface.requiredInference;
              delete surface.decisiveCondition;
            }
        if (defect === 'wrong_key') {
          f.candidate.items[0]!.initial.correctOptionRef = 'B';
          f.candidate.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
        }
        const review: typeof f.review = async (prepared, round) => {
          const response = await f.review(prepared, round);
          if (defect === 'grounding' && prepared.input.purpose === 'practice_grounding')
            response.result.findings.push({
              itemId: 'PR1',
              code: 'grounding',
              problem: 'The stated direction is not supported by the offered rule.',
              responsibility: 'grounding',
              repairInstruction: 'Use the exact supported direction.',
            });
          return response;
        };
        await expect(
          verifyPreparedPractice(f.context, f.candidate, f.priorTeaching, review, f.revise),
        ).rejects.toMatchObject({
          details: {
            candidateFailure: {
              diagnostics: expect.arrayContaining([
                expect.objectContaining({
                  code: defect === 'grounding' ? 'grounding' : 'insufficient_evidence',
                }),
              ]),
            },
          },
        });
        const solve =
          f.reviews[
            f.requests.findIndex(
              (input) =>
                input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
            )
          ];
        expect(solve!.decisions[0]!.answerId).toBe(defect === 'missing_givens' ? null : 'A');
      }
    },
  );

  it('rejects J18 missing public values despite complete private application and passing Fake grounding', async () => {
    const f = await realFakeFixture();
    expect(f.candidate.items[0]!.application!.startingState).toContain(publicGivens.slice(4));
    await expect(f.verify()).rejects.toMatchObject({
      details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
    });
    const groundingIndex = f.requests.findIndex((input) => input.purpose === 'practice_grounding');
    expect(JSON.stringify(f.requests[groundingIndex])).toContain(publicGivens.slice(4));
    expect(f.reviews[groundingIndex]).toEqual({ decisions: [], findings: [] });
    const initialIndex = f.requests.findIndex(
      (input) => input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
    );
    expect(f.reviews[initialIndex]!.decisions[0]!.answerId).toBeNull();
    expect(JSON.stringify(f.requests[initialIndex])).not.toContain(publicGivens);
    expect(JSON.stringify(f.requests[initialIndex])).not.toContain('"application"');
    expect(f.revise).toHaveBeenCalledTimes(1);
  });

  it.each(['A', 'B'] as const)(
    'independently solves complete J18 as A with saved key %s',
    async (key) => {
      const f = await realFakeFixture(true);
      f.candidate.items[0]!.initial.correctOptionRef = key;
      if (key === 'B') f.candidate.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
      if (key === 'A') {
        const verified = await f.verify();
        expect(hasCurrentPracticeAnswerabilityReview(f.saved(verified))).toBe(true);
        expect(f.revise).not.toHaveBeenCalled();
      } else await expect(f.verify()).rejects.toBeDefined();
      const index = f.requests.findIndex(
        (input) =>
          input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
      );
      expect(f.reviews[index]!.decisions[0]!.answerId).toBe('A');
    },
  );

  it('returns null for unknown or altered cases regardless of action suffix, call order or public prior teaching', async () => {
    const f = await realFakeFixture(true);
    for (const actionId of ['PR1.initial', 'PR1.retry', 'PR1.transfer', 'PR1.initial']) {
      const input = preparePracticeAnswerabilityReview(
        {
          prompt: 'Unknown case: which intervention is justified?',
          options: [
            { id: 'A', text: 'Intervention one' },
            { id: 'B', text: 'Intervention two' },
          ],
        },
        f.priorTeaching,
        actionId,
        'PR1',
      ).input;
      const result = await f.provider.reviewTeachingContent(input);
      expect(result.decisions).toMatchObject([{ actionId, answerId: null }]);
    }
    const surface = projectLearnerPracticeSurface({
      prompt: f.candidate.items[0]!.initial.prompt.replace(publicGivens, ''),
      options: f.candidate.items[0]!.initial.options.map(({ optionRef, text }) => ({
        id: optionRef,
        text,
      })),
    });
    const result = await f.provider.reviewTeachingContent(
      preparePracticeAnswerabilityReview(surface, f.priorTeaching, 'PR1.retry', 'PR1').input,
    );
    expect(result.decisions[0]!.answerId).toBeNull();
  });

  it('binds the known answer to option text rather than option position, label or initial/retry identity', async () => {
    const f = await realFakeFixture(true);
    const authored = f.candidate.items[0]!.initial;
    const surface = {
      prompt: authored.prompt,
      options: [
        { id: 'B', text: authored.options[2]!.text },
        { id: 'C', text: authored.options[0]!.text },
        { id: 'A', text: authored.options[1]!.text },
      ],
    };
    const result = await f.provider.reviewTeachingContent(
      preparePracticeAnswerabilityReview(surface, f.priorTeaching, 'OTHER.retry', 'OTHER').input,
    );
    expect(result.decisions[0]!.answerId).toBe('C');
    for (const changed of [
      { ...surface, options: surface.options.slice(0, 2) },
      { ...surface, options: [surface.options[1]!, surface.options[1]!, surface.options[2]!] },
      { ...surface, prompt: surface.prompt + ' Additional unspecified constraint.' },
    ]) {
      const unresolved = await f.provider.reviewTeachingContent(
        preparePracticeAnswerabilityReview(changed, f.priorTeaching, 'OTHER.initial', 'OTHER')
          .input,
      );
      expect(unresolved.decisions[0]!.answerId).toBeNull();
    }
  });

  it('invalidates a prior suffix-certified cached candidate and reruns current Fake solving', async () => {
    const f = await realFakeFixture(true);
    const previouslySolved = await f.verify();
    f.candidate.items[0]!.initial.prompt = f.candidate.items[0]!.initial.prompt.replace(
      publicGivens,
      '',
    );
    const oldHash = prepareTeachingReview(f.context, f.candidate).candidateHash;
    const oldProof = structuredClone(previouslySolved.answerabilityReview);
    oldProof.policyVersion = 'practice-answerability-v1-learner-visible';
    oldProof.rounds[0]!.candidateHash = oldHash;
    for (const solve of oldProof.rounds[0]!.solves) {
      const authored = f.candidate.items[solve.itemIndex]![solve.surface];
      solve.inputHash = preparePracticeAnswerabilityReview(
        {
          prompt: authored.prompt,
          options: authored.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
        },
        f.priorTeaching,
        solve.actionId,
        f.candidate.items[solve.itemIndex]!.practiceSlotId,
      ).inputHash;
      solve.result.decisions[0]!.answerId = solve.surface === 'retry' ? 'B' : 'A';
      solve.result.decisions[0]!.evidenceUsed = 'Prior Fake action-suffix certification.';
    }
    const old = f.saved({
      candidate: f.candidate,
      answerabilityReview: oldProof,
      receipts: previouslySolved.receipts.map((receipt) => ({
        ...receipt,
        candidateHash: oldHash,
      })),
    });
    expect(hasCurrentPracticeAnswerabilityReview(old)).toBe(false);
    f.requests.length = 0;
    f.reviews.length = 0;
    const cachedCandidate = PracticeContentProposalPayloadSchema.parse(
      JSON.parse(JSON.stringify(f.candidate)),
    );
    await expect(
      verifyPreparedPractice(f.context, cachedCandidate, f.priorTeaching, f.review, f.revise),
    ).rejects.toBeDefined();
    const index = f.requests.findIndex(
      (input) => input.purpose === 'practice_answerability' && input.actionIds[0] === 'PR1.initial',
    );
    expect(f.reviews[index]!.decisions[0]!.answerId).toBeNull();
  });

  it.each(['source-backed', 'supplementary', 'computed'] as const)(
    'keeps explicitly solvable %s offline fixtures valid through real Fake review',
    async (kind) => {
      const f = await realFakeFixture(true);
      f.candidate.items[0]!.sourceRefs = kind === 'source-backed' ? ['S1'] : [];
      if (kind === 'source-backed')
        f.context.sourceContext.offers[0]!.text =
          f.candidate.items[0]!.application!.sourceRuleOrProcedure;
      f.context.computedCases = kind === 'computed';
      expect(validatePracticeContentCandidate(f.candidate, f.context).diagnostics).toEqual([]);
      const verified = await f.verify();
      expect(hasCurrentPracticeAnswerabilityReview(f.saved(verified))).toBe(true);
      expect(f.requests.filter((input) => input.purpose === 'practice_grounding')).toHaveLength(1);
      expect(f.requests.filter((input) => input.purpose === 'practice_answerability')).toHaveLength(
        4,
      );
    },
  );

  it('supports the explicit generated Fake fixtures at every depth and focus without using action identity', async () => {
    const f = await realFakeFixture();
    for (const desiredDepth of [
      'pass_oriented',
      'working_fluency',
      'high_performance',
      'deep_transfer',
    ] as const)
      for (const unitFocus of ['normal', 'focused'] as const) {
        const known = await f.provider.generatePracticeContent({
          ...f.context,
          courseDesign: { desiredDepth, unitFocus },
        });
        for (const item of known.items)
          for (const surface of ['initial', 'retry'] as const) {
            const authored = item[surface];
            const result = await f.provider.reviewTeachingContent(
              preparePracticeAnswerabilityReview(
                {
                  prompt: authored.prompt,
                  options: authored.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
                },
                f.priorTeaching,
                surface === 'initial' ? 'OTHER.retry' : 'OTHER.initial',
                'OTHER',
              ).input,
            );
            expect(result.decisions[0]!.answerId).toBe(surface === 'initial' ? 'A' : 'B');
          }
      }
  });

  it('preserves Fake cancellation instead of certifying an interrupted fixture', async () => {
    const f = await realFakeFixture(true);
    const surface = f.candidate.items[0]!.initial;
    const input = preparePracticeAnswerabilityReview(
      {
        prompt: surface.prompt,
        options: surface.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
      },
      f.priorTeaching,
      'PR1.initial',
      'PR1',
    ).input;
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.provider.reviewTeachingContent(input, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
  });
});
