import { describe, expect, it, vi } from 'vitest';
import {
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_GROUNDING_POLICY_VERSION,
  LessonPracticeSurfaceSchema,
  PracticeContentProposalPayloadSchema,
  projectPracticePriorTeaching,
  type DesiredDepth,
  type TeachingBrief,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { teachingContentReviewMessages } from '../llm/prompts.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
} from '../llm/provider.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';
import { validatePracticeContentCandidate } from './teachingBriefContract.js';
import { disclosesPracticeAnswer } from './teachingText.js';
import {
  practiceQualityVariant,
  reviewPracticeQualityVariant,
  type PracticeQualityVariant,
} from '../testing/practiceQualityFixture.js';
import { evaluatePlannedPracticeQuality } from './lessonPedagogyEvaluator.js';
import { verifyPreparedPractice, practiceReviewQualityFindings } from './teachingContentReview.js';
import {
  assertPracticeCandidate,
  assertReviewedPracticeAcceptance,
  bindPracticeGroundingToBrief,
  hasCurrentPracticeAnswerabilityReview,
  hasCurrentPreparedPractice,
  practiceProofItems,
  preparePracticeIntegrityReview,
  preparePracticeAnswerabilityReview,
  preparePracticeGroundingReview,
} from './practiceAcceptance.js';

const fields = ['reasoningOperation', 'requiredInference', 'decisiveCondition'] as const;
const at = { evaluatedAt: '2026-10-07T12:00:00.000Z' };
const omissions = Array.from({ length: 7 }, (_, index) =>
  fields.filter((_field, bit) => ((index + 1) & (1 << bit)) !== 0),
);
const depths: DesiredDepth[] = [
  'pass_oriented',
  'working_fluency',
  'high_performance',
  'deep_transfer',
];

async function fixture(depth: DesiredDepth = 'working_fluency') {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: '检索条件与系统边界',
    targetMinutes: 28,
    targetDepth: depth,
    objectives: [
      {
        objectiveRef: 'O1',
        title: '识别检索条件',
        description: '区分查询条件与返回候选。',
        priority: 'required',
        construct: 'identify',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  const lessonInput: LessonSlotContentGenerationInput = {
    workspaceName: 'Practice acceptance',
    learnerLocale: 'zh-CN',
    skeleton,
    courseDesign: { desiredDepth: depth, unitFocus: 'normal' },
    sourceContext: {
      blockCount: 1,
      offerCount: 1,
      serializedBytes: 180,
      materialCount: 1,
      sectionCount: 1,
      offers: [
        {
          sourceRef: 'S1',
          materialTitle: '检索笔记',
          headingPath: [],
          pageNumber: null,
          slideNumber: null,
          text: '检索条件决定哪些候选被保留，系统状态改变时需要重新检查约束。',
          authorizedObjectiveRefs: ['O1'],
        },
      ],
    },
    learningContext: {
      concepts: [],
      canonicalConcepts: [],
      prerequisites: [],
      nextConnection: null,
    },
  };
  const provider = new FakeProvider();
  const lesson = await provider.generateLessonSlotContent(lessonInput);
  const context: PracticeContentGenerationInput = { ...lessonInput, acceptedLesson: lesson.slots };
  const candidate = await provider.generatePracticeContent(context);
  const publicLesson = {
    objective: { title: '检索条件', whyNow: '检查系统状态与资源约束。', objectives: [] },
    prerequisites: [],
    segments: [],
    sourceReferences: lessonInput.sourceContext.offers.map((offer) => ({
      refId: offer.sourceRef,
      materialId: 'material1',
      sourceBlockId: 'block1',
      quote: offer.text,
      headingPath: [],
      pageNumber: null,
      slideNumber: null,
    })),
    visualReferences: [],
    summary: '系统状态变化后重新检查约束。',
    nextConnection: null,
  } as Pick<
    TeachingBrief,
    | 'objective'
    | 'prerequisites'
    | 'segments'
    | 'sourceReferences'
    | 'visualReferences'
    | 'summary'
    | 'nextConnection'
  >;
  const priorTeaching = projectPracticePriorTeaching(publicLesson);
  const review = vi.fn<Parameters<typeof verifyPreparedPractice>[3]>(async (prepared, round) => ({
    result: await provider.reviewTeachingContent(prepared.input),
    logicalCallId: `${prepared.input.purpose}:${round}:${prepared.input.actionIds[0] ?? 'comparison'}`,
  }));
  const revise = vi.fn(async (draft: typeof candidate) => draft);
  const verify = () => verifyPreparedPractice(context, candidate, priorTeaching, review, revise);
  const saved = (result: Awaited<ReturnType<typeof verify>>): TeachingBrief => {
    const brief = {
      ...publicLesson,
      practice: {
        schemaVersion: 1,
        credit: 'none',
        items: result.candidate.items.map((item, index) => {
          const id = `practice_${index + 1}`;
          const surface = (value: typeof item.initial, name: 'initial' | 'retry') => {
            const { correctOptionRef, ...authored } = value;
            return {
              ...authored,
              options: value.options.map(({ optionRef, ...option }) => ({
                ...option,
                id: `${id}_${name}_${optionRef}`,
              })),
              correctOptionId: `${id}_${name}_${correctOptionRef}`,
            };
          };
          return {
            id,
            objectiveId: 'obj1',
            objectiveTitle: '检索条件',
            construct: 'identify',
            capabilityTested: item.capabilityTested,
            pedagogicalReason: item.pedagogicalReason,
            authority: item.sourceRefs.length ? 'exact_source' : 'ai_teaching_synthesis',
            sourceRefIds: item.sourceRefs,
            visualRefIds: item.visualRefs,
            application: item.application,
            initial: surface(item.initial, 'initial'),
            retry: surface(item.retry, 'retry'),
          };
        }),
        qualityEvaluation: {
          ...evaluatePlannedPracticeQuality(result.candidate, context, at),
          contentReview: result.receipts,
          answerabilityReview: result.answerabilityReview,
          integrityReview: result.integrityReview,
          groundingReview: result.groundingReview,
          qualityImprovement: result.qualityImprovement,
          findings: [
            ...evaluatePlannedPracticeQuality(result.candidate, context, at).findings,
            ...practiceReviewQualityFindings(result.candidate, context, {
              contentReview: result.receipts,
              answerabilityReview: result.answerabilityReview,
              integrityReview: result.integrityReview,
            }),
          ],
        },
      },
    } as TeachingBrief;
    bindPracticeGroundingToBrief(brief, result.candidate, context);
    return brief;
  };
  return { candidate, context, publicLesson, priorTeaching, review, revise, verify, saved };
}

const shallowCases = [
  { label: '结果排序', answerId: 'A', alternativeId: 'B' },
  { label: '候选过滤', answerId: 'B', alternativeId: 'A' },
] as const;
const contrastRepresentations = ['missing', 'paraphrased', 'unoffered'] as const;

function damageContrast(
  value: Pick<
    Awaited<ReturnType<typeof fixture>>['candidate']['items'][number]['initial'],
    'evidenceContrast'
  >,
  representation: (typeof contrastRepresentations)[number],
) {
  if (representation === 'missing') delete value.evidenceContrast;
  else if (representation === 'paraphrased')
    value.evidenceContrast!.evidence = value.evidenceContrast!.evidence.includes('旧任务')
      ? '完成记录确认旧任务已经结束。'
      : '本次占用计数已经清零，但任务仍在等待。';
  else value.evidenceContrast!.alternativeOptionId = 'E';
}

function makeShallow(
  f: Awaited<ReturnType<typeof fixture>>,
  surface: 'initial' | 'retry',
  task: (typeof shallowCases)[number],
  operation: 'recognize' | 'classify',
) {
  const prompt = `检索系统把候选过滤、结果排序和状态更新分为三类。当前日志直接把操作标为“${task.label}”。这个操作属于哪一类检索步骤？`;
  f.candidate.items[0]!.sourceRefs = [];
  f.candidate.items[0]![surface] = {
    reasoningOperation: operation,
    requiredInference: '从日志声明中识别这个步骤所属的检索类别。',
    decisiveCondition: `日志直接把操作标为${task.label}。`,
    prompt,
    options: [
      {
        optionRef: 'A',
        text: '属于结果排序，排列已经保留的候选。',
        feedbackIfSelected: '结果排序用于排列已保留的候选；与日志标注的类别比较。',
      },
      {
        optionRef: 'B',
        text: '属于候选过滤，排除不满足条件的候选。',
        feedbackIfSelected: '候选过滤会排除不符合条件的候选；检查日志是否如此标注。',
      },
      {
        optionRef: 'C',
        text: '属于状态更新，修改任务的资源记录。',
        feedbackIfSelected: '状态更新修改资源记录；不能把所有检索步骤都归为状态更新。',
      },
    ],
    correctOptionRef: task.answerId,
    hint: '先读日志已经给出的类别名称。',
    explanation: '根据系统直接给出的类别名称识别步骤，无须推导额外结果。',
    evidenceContrast: {
      evidence: `当前日志直接把操作标为“${task.label}”`,
      replacement: `当前日志直接把操作标为“${task.label === '结果排序' ? '候选过滤' : '结果排序'}”`,
      alternativeOptionId: task.alternativeId,
    },
  };
  const review = f.review.getMockImplementation()!;
  f.review.mockImplementation(async (prepared, round) => {
    const input = prepared.input;
    if (input.purpose !== 'practice_answerability' || input.candidate.prompt !== prompt)
      return review(prepared, round);
    // This finite public lookup fixture decides from the stated category and
    // offered texts, never from authored keys, labels or contrast metadata.
    const answerId = input.candidate.options.find((option) =>
      option.text.startsWith(`属于${task.label}，`),
    )!.id;
    return {
      logicalCallId: `${input.purpose}:${round}:${input.candidate.actionId}`,
      result: {
        decisions: [
          {
            actionId: input.candidate.actionId,
            answerId,
            requiresCaseInference: false,
            evidenceUsed:
              'The public log directly states the category matched by the offered text.',
          },
        ],
        findings: [],
      },
    };
  });
  expect(
    evaluatePlannedPracticeQuality(f.candidate, f.context, at).findings.filter(
      (finding) => finding.severity === 'error',
    ),
  ).toEqual([]);
}

describe('Practice declaration responsibilities and public acceptance', () => {
  it.each<PracticeQualityVariant>([
    'omitted',
    'compact',
    'paraphrased',
    'repeated_feedback',
    'source_quotation',
    'option_cases',
    'label_mentions',
    'conditional_rule',
    'symbolic_contrast',
  ])('accepts and seals the independently controlled %s representation', async (variant) => {
    const f = await fixture('pass_oriented');
    practiceQualityVariant(f.candidate, variant, f.context);
    f.review.mockImplementation(async (request, round) => ({
      result: await reviewPracticeQualityVariant(request.input, variant, f.context),
      logicalCallId:
        'quality:' + round + ':' + request.input.purpose + ':' + request.input.actionIds.join(','),
    }));
    expect(validatePracticeContentCandidate(f.candidate, f.context).valid).toBe(true);
    expect(() => assertPracticeCandidate(f.candidate, f.context, f.priorTeaching)).not.toThrow();
    const result = await f.verify();
    expect(f.revise).not.toHaveBeenCalled();
    const brief = f.saved(result);
    expect(hasCurrentPreparedPractice(brief)).toBe(true);
    expect(
      result.answerabilityReview.rounds[0]!.solves.map((s) => s.result.decisions[0]!.answerId),
    ).toEqual(
      ['option_cases', 'conditional_rule', 'symbolic_contrast'].includes(variant)
        ? ['A', 'C']
        : ['A', 'B'],
    );
    if (variant === 'conditional_rule' || variant === 'symbolic_contrast') {
      expect(result.candidate.items[0]!.initial.prompt).toBe(
        '对任意有符号数 n：若 n > 0，正确答案是正数；若 n = 0，正确答案是零；若 n < 0，正确答案是负数。本题 n = 7 - 4，应选哪个标签？',
      );
      expect(result.candidate.items[0]!.retry.prompt).toBe(
        '对任意有符号数 n：若 n > 0，正确答案是正数；若 n = 0，正确答案是零；若 n < 0，正确答案是负数。本题 n = 2 - 6，应选哪个标签？',
      );
      expect(f.review.mock.calls.map(([request]) => request.input.purpose)).toEqual([
        'practice_grounding',
        'practice_integrity',
        'practice_answerability',
        'practice_answerability',
      ]);
      const missingIntegrity = structuredClone(brief.practice!.qualityEvaluation);
      delete missingIntegrity.integrityReview;
      expect(() =>
        assertReviewedPracticeAcceptance(
          result.candidate,
          f.context,
          f.priorTeaching,
          missingIntegrity,
        ),
      ).toThrow();
      const withoutIntegrity = structuredClone(brief);
      delete withoutIntegrity.practice!.qualityEvaluation.integrityReview;
      expect(hasCurrentPreparedPractice(withoutIntegrity)).toBe(false);
    }
    brief.practice!.items[0]!.initial.explanation += ' 2 + 2 = 5.';
    expect(hasCurrentPreparedPractice(brief)).toBe(false);
  });

  it.each([
    'announcement',
    'semantic_disclosure',
    'wrong_key',
    'nonunique_answers',
    'missing_givens',
    'reordered_replay',
  ] as const)(
    'rejects conditional-rule %s through current production admission',
    async (defect) => {
      const f = await fixture('pass_oriented');
      practiceQualityVariant(f.candidate, 'conditional_rule', f.context);
      const item = f.candidate.items[0]!;
      if (defect === 'announcement') item.initial.prompt += '本题的正确答案是正数。';
      if (defect === 'semantic_disclosure') item.initial.prompt += ' 本题计算后的数位于零的右侧。';
      if (defect === 'wrong_key') item.initial.correctOptionRef = 'B';
      if (defect === 'nonunique_answers') item.initial.options[1]!.text = '大于零';
      if (defect === 'missing_givens')
        item.initial.prompt = item.initial.prompt.replace('7 - 4', '未知');
      if (defect === 'reordered_replay') {
        item.retry = structuredClone(item.initial);
        item.retry.options.reverse();
        item.retry.requiredInference = 'Different private metadata cannot establish a new task.';
      }
      const results: TeachingContentReview[] = [];
      f.review.mockImplementation(async (request, round) => {
        const result = await reviewPracticeQualityVariant(
          request.input,
          'conditional_rule',
          f.context,
        );
        results.push(result);
        return {
          result,
          logicalCallId:
            'conditional:' +
            round +
            ':' +
            request.input.purpose +
            ':' +
            request.input.actionIds.join(','),
        };
      });
      if (defect === 'announcement') {
        expect(validatePracticeContentCandidate(f.candidate, f.context).diagnosticCodes).toContain(
          'practice_prompt_leaks_answer',
        );
        await expect(f.verify()).rejects.toBeDefined();
        expect(f.review).not.toHaveBeenCalled();
      } else if (defect === 'semantic_disclosure') {
        expect(disclosesPracticeAnswer(item.initial.prompt, '正数')).toBe(false);
        expect(validatePracticeContentCandidate(f.candidate, f.context).valid).toBe(true);
        await expect(f.verify()).rejects.toMatchObject({
          details: {
            candidateFailure: { diagnostics: [expect.objectContaining({ code: 'answer_leak' })] },
          },
        });
        expect(
          results
            .flatMap((result) => result.findings)
            .every((finding) => finding.code === 'answer_leak'),
        ).toBe(true);
      } else {
        await expect(f.verify()).rejects.toBeDefined();
        if (defect === 'reordered_replay') expect(f.review).not.toHaveBeenCalled();
        else
          expect(results.flatMap((result) => result.decisions)).toContainEqual(
            expect.objectContaining({
              actionId: 'PR1.initial',
              answerId: defect === 'wrong_key' ? 'A' : null,
            }),
          );
      }
    },
  );

  it('rejects a supplied unchanged-fact counterfactual through controlled grounding', async () => {
    const f = await fixture('pass_oriented');
    practiceQualityVariant(f.candidate, 'paraphrased', f.context);
    const contrast = f.candidate.items[0]!.initial.evidenceContrast!;
    contrast.replacement = contrast.evidence;
    expect(validatePracticeContentCandidate(f.candidate, f.context).valid).toBe(true);
    f.review.mockImplementation(async (request, round) => ({
      result: await reviewPracticeQualityVariant(request.input, 'paraphrased', f.context),
      logicalCallId:
        'counterfactual:' +
        round +
        ':' +
        request.input.purpose +
        ':' +
        request.input.actionIds.join(','),
    }));
    await expect(f.verify()).rejects.toMatchObject({
      details: {
        candidateFailure: {
          diagnostics: [
            expect.objectContaining({
              code: 'accuracy',
              message: expect.stringContaining('still says the old task has completed'),
            }),
          ],
        },
      },
    });
    expect(f.revise).toHaveBeenCalledTimes(1);
  });

  it.each([
    'wrong_key',
    'nonunique_cases',
    'missing_givens',
    'false_feedback',
    'replay',
    'announcement',
  ] as const)(
    'never admits the controlled public %s defect through advisory allowance',
    async (defect) => {
      const f = await fixture('pass_oriented');
      practiceQualityVariant(f.candidate, 'option_cases', f.context);
      const surface = f.candidate.items[0]!.initial;
      if (defect === 'wrong_key') surface.correctOptionRef = 'B';
      if (defect === 'nonunique_cases') surface.options[1]!.text = 'Queue Q needs 2 slots';
      if (defect === 'missing_givens') surface.prompt = 'Which offered queue can start?';
      if (defect === 'false_feedback')
        surface.options[1]!.feedbackIfSelected = '7 <= 5, so Q fits.';
      if (defect === 'replay') f.candidate.items[0]!.retry = structuredClone(surface);
      if (defect === 'announcement') surface.prompt += ' The answer is Queue P needs 4 slots.';
      f.review.mockImplementation(async (request, round) => ({
        result: await reviewPracticeQualityVariant(request.input, 'option_cases', f.context),
        logicalCallId:
          'negative:' +
          round +
          ':' +
          request.input.purpose +
          ':' +
          request.input.actionIds.join(','),
      }));
      await expect(f.verify()).rejects.toBeDefined();
      expect(f.revise.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it.each(
    (['practice_grounding', 'practice_integrity', 'practice_answerability'] as const).flatMap(
      (purpose) =>
        (['insufficient_evidence', 'revealing_hint', 'weak_transfer'] as const).map((code) => ({
          purpose,
          code,
        })),
    ),
  )(
    'accepts explicit $purpose quality $code with current saved proofs',
    async ({ purpose, code }) => {
      const f = await fixture('pass_oriented');
      const review = f.review.getMockImplementation()!;
      f.review.mockImplementation(async (request, round) => {
        const reviewed = await review(request, round);
        if (request.input.purpose === purpose)
          reviewed.result.advisories = [
            {
              itemId: 'PR1',
              code,
              qualityAspect: 'transfer',
              problem: 'The correct new capacity case could explore a richer changed constraint.',
              repairInstruction:
                'Consider a second constraint while preserving the correct rule and public givens.',
            },
          ];
        return reviewed;
      });
      const result = await f.verify();
      expect(result.qualityImprovement).toMatchObject({ attempts: 0, outcome: 'retained' });
      expect(f.revise).not.toHaveBeenCalled();
      const brief = f.saved(result);
      expect(hasCurrentPreparedPractice(brief)).toBe(true);
      expect(brief.practice!.qualityEvaluation.findings).toContainEqual(
        expect.objectContaining({ severity: 'warning', code: `practice_review_${code}` }),
      );
      // The exact same source rule and delayed feedback remain legitimate teaching.
      expect(result.candidate).toEqual(f.candidate);
      expect(result.groundingReview.rounds).toHaveLength(1);
      expect(result.answerabilityReview.rounds).toHaveLength(1);
    },
  );

  it.each(['shallow_task', 'weak_transfer'] as const)(
    'rejects a false explanation reported as material %s, without an optional escape',
    async (code) => {
      const f = await fixture('pass_oriented');
      f.candidate.items[0]!.retry.explanation += ' 补充运算：2 + 2 = 5。';
      const review = f.review.getMockImplementation()!;
      f.review.mockImplementation(async (request, round) => {
        const reviewed = await review(request, round);
        if (
          request.input.purpose === 'practice_grounding' &&
          request.input.candidate.items[0]!.retry.explanation.includes('2 + 2 = 5')
        )
          reviewed.result.findings = [
            {
              itemId: 'PR1.retry',
              code,
              responsibility: 'grounding',
              problem: 'The delayed explanation says 2 + 2 = 5, contradicting the correct sum 4.',
              repairInstruction: 'Correct the false calculation.',
            },
          ];
        return reviewed;
      });
      const improve = vi.fn(async () => f.candidate);
      await expect(
        verifyPreparedPractice(
          f.context,
          f.candidate,
          f.priorTeaching,
          f.review,
          f.revise,
          improve,
        ),
      ).rejects.toMatchObject({
        details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
      });
      expect(f.revise).toHaveBeenCalledOnce();
      expect(improve).not.toHaveBeenCalled();
    },
  );

  it.each([
    'missing_responsibility',
    'wrong_purpose',
    'material_as_advisory',
    'solver_finding',
    'unknown_item',
  ] as const)('cannot fabricate acceptance with %s review output', async (defect) => {
    const f = await fixture('pass_oriented');
    const review = f.review.getMockImplementation()!;
    f.review.mockImplementation(async (request, round) => {
      const reviewed = await review(request, round);
      const finding = {
        itemId: 'PR1',
        code: 'weak_transfer' as const,
        problem: 'The exact rule is contradicted by a false assertion.',
        repairInstruction: 'Correct the assertion.',
      };
      if (request.input.purpose === 'practice_grounding') {
        if (defect === 'missing_responsibility') reviewed.result.findings = [finding];
        if (defect === 'wrong_purpose')
          reviewed.result.findings = [{ ...finding, responsibility: 'integrity' }];
        if (defect === 'material_as_advisory')
          reviewed.result.advisories = [
            { ...finding, responsibility: 'grounding', qualityAspect: 'transfer' },
          ];
        if (defect === 'unknown_item')
          reviewed.result.advisories = [{ ...finding, itemId: 'PR999', qualityAspect: 'style' }];
      }
      if (request.input.purpose === 'practice_answerability' && defect === 'solver_finding')
        reviewed.result.findings = [finding];
      return reviewed;
    });
    await expect(f.verify()).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(f.revise).not.toHaveBeenCalled();
  });

  it('grounds the complete authored artifact while blind and integrity packets remain purpose-specific', async () => {
    const f = await fixture();
    const prepared = preparePracticeGroundingReview(f.context, f.candidate);
    expect(prepared.input.candidate).toEqual(f.candidate);
    expect(prepared.input.acceptedLesson).toEqual(f.context.acceptedLesson);
    expect(prepared.input.sources).toEqual(f.context.sourceContext.offers);
    expect(prepared.input.actionIds).toEqual([]);
    const messages = JSON.stringify(teachingContentReviewMessages(prepared.input));
    for (const item of f.candidate.items)
      for (const name of ['initial', 'retry'] as const) {
        expect(messages).toContain(item[name].explanation);
        for (const option of item[name].options)
          expect(messages).toContain(option.feedbackIfSelected);
      }
    expect(messages).toContain('correctOptionRef');
    expect(messages).toContain(
      'Concise, repetitive, stylistically weak or generic but correct feedback is acceptable',
    );
    const result = await f.verify();
    expect(result.groundingReview.policyVersion).toBe(PRACTICE_GROUNDING_POLICY_VERSION);
    expect(result.groundingReview.rounds[0]).toMatchObject({
      inputHash: prepared.inputHash,
      claimsHash: prepared.claimsHash,
      candidateHash: prepared.candidateHash,
    });
    const ground = f.review.mock.calls.find(
      ([request]) => request.input.purpose === 'practice_grounding',
    )![0];
    expect(ground.input).toEqual(prepared.input);
    for (const [request] of f.review.mock.calls)
      if (request.input.purpose !== 'practice_grounding')
        expect(JSON.stringify(request.input)).not.toMatch(
          /feedbackIfSelected|correctOptionRef|explanation|application/u,
        );
    // Projection copies cannot mutate the candidate or its context.
    prepared.input.candidate.items[0]!.initial.explanation = 'Changed review copy.';
    expect(f.candidate.items[0]!.initial.explanation).not.toBe('Changed review copy.');
  });

  it.each(['missing', 'version', 'input', 'claims', 'result', 'context_binding'] as const)(
    'rejects %s grounding proof at the current saved acceptance gate',
    async (mutation) => {
      const f = await fixture();
      const result = await f.verify();
      const brief = f.saved(result);
      expect(hasCurrentPreparedPractice(brief)).toBe(true);
      const evidence = brief.practice!.qualityEvaluation;
      if (mutation === 'missing') delete evidence.groundingReview;
      else if (mutation === 'version')
        evidence.groundingReview!.policyVersion = 'grounding-obsolete';
      else if (mutation === 'input')
        evidence.groundingReview!.rounds.at(-1)!.inputHash = `sha256:${'0'.repeat(64)}`;
      else if (mutation === 'claims')
        evidence.groundingReview!.rounds.at(-1)!.claimsHash = `sha256:${'0'.repeat(64)}`;
      else if (mutation === 'context_binding') delete evidence.groundingReview!.savedContextHash;
      else
        evidence.groundingReview!.rounds.at(-1)!.result = {
          decisions: [],
          findings: [
            {
              itemId: 'PR1',
              code: 'accuracy',
              responsibility: 'grounding',
              problem: 'False explanation.',
              repairInstruction: 'Correct it.',
            },
          ],
        };
      expect(hasCurrentPreparedPractice(brief)).toBe(false);
      if (mutation !== 'context_binding')
        expect(() =>
          assertReviewedPracticeAcceptance(result.candidate, f.context, f.priorTeaching, evidence),
        ).toThrow();
    },
  );

  it.each(['explanation', 'feedback', 'rule', 'source', 'context'] as const)(
    'cannot certify changed %s with unchanged public solves and stale grounding',
    async (mutation) => {
      const f = await fixture();
      const result = await f.verify();
      const brief = f.saved(result);
      if (mutation === 'explanation') {
        result.candidate.items[0]!.initial.explanation += ' 另一个解释。';
        brief.practice!.items[0]!.initial.explanation += ' 另一个解释。';
      } else if (mutation === 'feedback') {
        result.candidate.items[0]!.retry.options[0]!.feedbackIfSelected += ' 另一条反馈。';
        brief.practice!.items[0]!.retry.options[0]!.feedbackIfSelected += ' 另一条反馈。';
      } else if (mutation === 'rule') {
        result.candidate.items[0]!.initial.requiredInference += ' 规则要求按可见条件重新检查约束。';
        brief.practice!.items[0]!.initial.requiredInference += ' 规则要求按可见条件重新检查约束。';
      } else if (mutation === 'source') {
        f.context.sourceContext.offers[0]!.text += ' 新的来源条件。';
        brief.sourceReferences[0]!.quote += ' 新的来源条件。';
      } else {
        f.context.skeleton.fingerprint = `sha256:${'0'.repeat(64)}`;
        brief.sourceContextFingerprint = 'Changed current context';
      }
      expect(hasCurrentPracticeAnswerabilityReview(brief)).toBe(true);
      expect(hasCurrentPreparedPractice(brief)).toBe(false);
      expect(() =>
        assertPracticeCandidate(result.candidate, f.context, f.priorTeaching),
      ).not.toThrow();
      expect(() =>
        assertReviewedPracticeAcceptance(
          result.candidate,
          f.context,
          f.priorTeaching,
          brief.practice!.qualityEvaluation,
        ),
      ).toThrow();
    },
  );

  it('refuses failed optional improvement fallback after the original grounding context changes', async () => {
    const f = await fixture('deep_transfer');
    f.candidate.items[0]!.initial.reasoningOperation = 'recognize';
    const improve = vi.fn(async () => {
      f.context.sourceContext.offers[0]!.text += ' 来源现已增加一个决定性条件。';
      throw new Error('Optional improvement failed.');
    });
    await expect(
      verifyPreparedPractice(f.context, f.candidate, f.priorTeaching, f.review, f.revise, improve),
    ).rejects.toMatchObject({
      details: { candidateFailure: { kind: 'practice_quality_fallback_rejection' } },
    });
    expect(improve).toHaveBeenCalledTimes(1);
  });

  it('rejects a grounding packet mutated in transit even when the provider returns a clean verdict', async () => {
    const f = await fixture();
    const review = f.review.getMockImplementation()!;
    f.review.mockImplementation(async (request, round) => {
      if (request.input.purpose === 'practice_grounding')
        request.input.candidate.items[0]!.initial.explanation = 'An unreviewed replacement.';
      return review(request, round);
    });
    await expect(f.verify()).rejects.toBeDefined();
    expect(f.revise).not.toHaveBeenCalled();
  });

  it.each(
    depths.flatMap((depth) =>
      (['initial', 'retry'] as const).flatMap((surface) =>
        (['recognize', 'classify'] as const).flatMap((operation) =>
          shallowCases.map((task) => ({ depth, surface, operation, task })),
        ),
      ),
    ),
  )(
    'preserves shallow $surface acceptance after deleting $operation at $depth ($task.label)',
    async ({ depth, surface, operation, task }) => {
      for (const contrast of ['missing', 'valid', 'invalid'] as const) {
        const f = await fixture(depth);
        makeShallow(f, surface, task, operation);
        const value = f.candidate.items[0]![surface];
        if (contrast === 'missing') delete value.evidenceContrast;
        if (contrast === 'invalid') value.evidenceContrast!.alternativeOptionId = task.answerId;
        const originalCandidate = structuredClone(f.candidate);
        const before = await f.verify();
        const saved = f.saved(before);
        expect(hasCurrentPreparedPractice(saved)).toBe(true);
        const proofs = structuredClone(saved.practice!.qualityEvaluation);
        const savedWithoutOperation = structuredClone(saved);
        delete savedWithoutOperation.practice!.items[0]![surface].reasoningOperation;
        expect(savedWithoutOperation.practice!.qualityEvaluation).toEqual(proofs);
        expect(hasCurrentPreparedPractice(savedWithoutOperation)).toBe(true);

        const publicProof = (candidate: typeof f.candidate) =>
          preparePracticeAnswerabilityReview(
            practiceProofItems(candidate)[0]![surface],
            f.priorTeaching,
            `PR1.${surface}`,
            'PR1',
          );
        delete value.reasoningOperation;
        const expected = structuredClone(originalCandidate);
        delete expected.items[0]![surface].reasoningOperation;
        expect(f.candidate).toEqual(expected);
        expect(publicProof(f.candidate)).toMatchObject({
          input: publicProof(originalCandidate).input,
          inputHash: publicProof(originalCandidate).inputHash,
        });
        expect(evaluatePlannedPracticeQuality(f.candidate, f.context, at).status).toBe(
          evaluatePlannedPracticeQuality(originalCandidate, f.context, at).status,
        );
        const after = await f.verify();
        expect(after.candidate.items[0]![surface].reasoningOperation).toBeUndefined();
        const solve = (result: typeof before) =>
          result.answerabilityReview.rounds[0]!.solves.find(
            (proof) => proof.itemIndex === 0 && proof.surface === surface,
          )!;
        expect(solve(before).result.decisions[0]!.requiresCaseInference).toBe(false);
        expect(solve(after)).toEqual(solve(before));
        expect(after.integrityReview.rounds[0]!.inputHash).toBe(
          before.integrityReview.rounds[0]!.inputHash,
        );
        expect(hasCurrentPreparedPractice(f.saved(after))).toBe(true);
        expect(f.review).toHaveBeenCalledTimes(2 * (2 + 2 * f.candidate.items.length));
      }
    },
  );

  it.each(
    depths.flatMap((depth) =>
      (['initial', 'retry'] as const).flatMap((surface) =>
        omissions.map((missing) => ({ depth, surface, missing })),
      ),
    ),
  )(
    'accepts $surface omissions $missing at $depth with applicable contrast and public proofs',
    async ({ depth, surface, missing }) => {
      const f = await fixture(depth);
      const authored = f.candidate.items[0]![surface];
      for (const field of missing) delete authored[field];
      expect(PracticeContentProposalPayloadSchema.safeParse(f.candidate).success).toBe(true);
      const evaluated = evaluatePlannedPracticeQuality(f.candidate, f.context, at);
      expect(evaluated.status).toBe('pass');
      expect(evaluated.findings.some(({ code }) => code === 'missing_reasoning_declaration')).toBe(
        false,
      );
      const result = await f.verify();
      for (const field of missing)
        expect(result.candidate.items[0]![surface][field]).toBeUndefined();
      expect(hasCurrentPreparedPractice(f.saved(result))).toBe(true);
      expect(f.review).toHaveBeenCalledTimes(2 + 2 * f.candidate.items.length);
    },
  );

  it.each(
    depths.flatMap((depth) =>
      (['initial', 'retry'] as const).flatMap((surface) =>
        (['predict_outcome', 'recognize', 'classify'] as const).map((operation) => ({
          depth,
          surface,
          operation,
        })),
      ),
    ),
  )(
    'accepts private contrast preferences on $surface at $depth with $operation or unknown',
    async ({ depth, surface, operation }) => {
      for (const representation of contrastRepresentations) {
        const f = await fixture(depth);
        const value = f.candidate.items[0]![surface];
        value.reasoningOperation = operation;
        const accepted = await f.verify();
        const proof = accepted.answerabilityReview.rounds[0]!.solves.find(
          (solve) => solve.itemIndex === 0 && solve.surface === surface,
        )!;
        expect(proof.result.decisions[0]!.requiresCaseInference).toBe(true);
        const saved = f.saved(accepted);
        expect(hasCurrentPreparedPractice(saved)).toBe(true);
        const proofs = structuredClone(saved.practice!.qualityEvaluation);
        // Contrast is outside the blind solve input. Keep the exact valid
        // public receipts while testing both declared and unknown operations.
        const broken = f.saved({ ...accepted, candidate: structuredClone(accepted.candidate) });
        damageContrast(broken.practice!.items[0]![surface], representation);
        expect(broken.practice!.qualityEvaluation).toEqual(proofs);
        expect(hasCurrentPreparedPractice(broken)).toBe(false);
        delete broken.practice!.items[0]![surface].reasoningOperation;
        expect(hasCurrentPreparedPractice(broken)).toBe(false);

        damageContrast(value, representation);
        for (const unknown of [false, true]) {
          if (unknown) delete value.reasoningOperation;
          f.review.mockClear();
          if (representation === 'unoffered') {
            await expect(f.verify()).rejects.toMatchObject({
              details: { candidateFailure: { kind: 'practice_content_rejection' } },
            });
          } else {
            const renewed = await f.verify();
            expect(hasCurrentPreparedPractice(f.saved(renewed))).toBe(true);
            expect(f.revise).not.toHaveBeenCalled();
            expect(f.review).toHaveBeenCalledTimes(2 + 2 * f.candidate.items.length);
          }
        }
      }
    },
  );

  it.each(['initial', 'retry'] as const)(
    'never treats missing or stale shallow %s proofs as a contrast exemption',
    async (surface) => {
      const f = await fixture();
      makeShallow(f, surface, shallowCases[0], 'recognize');
      delete f.candidate.items[0]![surface].reasoningOperation;
      delete f.candidate.items[0]![surface].evidenceContrast;
      const saved = f.saved(await f.verify());
      expect(hasCurrentPreparedPractice(saved)).toBe(true);
      for (const mutation of [
        'missing',
        'version',
        'input',
        'inventory',
        'public',
        'prior',
        'key',
        'finding',
      ] as const) {
        const changed = structuredClone(saved);
        const evidence = changed.practice!.qualityEvaluation;
        const value = changed.practice!.items[0]![surface];
        const proof = evidence
          .answerabilityReview!.rounds.at(-1)!
          .solves.find((solve) => solve.itemIndex === 0 && solve.surface === surface)!;
        if (mutation === 'missing') delete evidence.answerabilityReview;
        else if (mutation === 'version') evidence.answerabilityReview!.policyVersion = 'obsolete';
        else if (mutation === 'input') proof.inputHash = `sha256:${'0'.repeat(64)}`;
        else if (mutation === 'inventory') proof.result.decisions = [];
        else if (mutation === 'public') value.prompt += ' Changed public case.';
        else if (mutation === 'prior') changed.summary += ' Changed taught rule.';
        else if (mutation === 'key') value.correctOptionId = value.options[1]!.id;
        else
          proof.result.findings.push({
            itemId: `PR1.${surface}`,
            code: 'grounding',
            problem: 'The public claim contradicts the taught rule.',
            repairInstruction: 'Correct the claim.',
          });
        expect(hasCurrentPreparedPractice(changed), mutation).toBe(false);
      }
    },
  );

  it('never counts unknown as reasoning coverage or reclassifies initial from retry omissions', async () => {
    const f = await fixture('deep_transfer');
    f.context.acceptedLesson = [];
    f.context.courseDesign!.unitFocus = 'focused';
    f.candidate.items[0]!.initial.reasoningOperation = 'recognize';
    for (const field of fields) delete f.candidate.items[0]!.retry[field];
    const evaluation = evaluatePlannedPracticeQuality(f.candidate, f.context, at);
    expect(evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
        expect.objectContaining({ code: 'reasoning_demand_below_depth', severity: 'warning' }),
        expect.objectContaining({
          code: 'focused_unit_angle_coverage_insufficient',
          severity: 'warning',
        }),
      ]),
    );
    delete f.candidate.items[0]!.initial.reasoningOperation;
    const unknown = evaluatePlannedPracticeQuality(f.candidate, f.context, at);
    expect(unknown.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'reasoning_demand_below_depth', severity: 'warning' }),
        expect.objectContaining({
          code: 'focused_unit_angle_coverage_insufficient',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'practice_reasoning_operation_missing',
          severity: 'warning',
        }),
      ]),
    );
    expect(
      unknown.findings.some(({ code }) => code === 'practice_initial_recognition_at_depth'),
    ).toBe(false);
  });

  it('accepts genuinely different public cases with identical private descriptions', async () => {
    const f = await fixture();
    Object.assign(
      f.candidate.items[0]!.retry,
      Object.fromEntries(fields.map((field) => [field, f.candidate.items[0]!.initial[field]])),
    );
    const result = await f.verify();
    expect(evaluatePlannedPracticeQuality(result.candidate, f.context, at).findings).toContainEqual(
      expect.objectContaining({ code: 'practice_retry_semantic_replay', severity: 'warning' }),
    );
    expect(hasCurrentPreparedPractice(f.saved(result))).toBe(true);
  });

  it.each(['equal', 'changed', 'absent'] as const)(
    'rejects public retry replay with %s private descriptions',
    async (metadata) => {
      const f = await fixture();
      const item = f.candidate.items[0]!;
      item.retry = structuredClone(item.initial);
      // Presentation changes evade the old raw-prompt equality proxy.
      item.retry.prompt = `**${item.retry.prompt}**`;
      item.retry.options.reverse();
      if (metadata === 'absent') for (const field of fields) delete item.retry[field];
      if (metadata === 'changed') {
        item.retry.reasoningOperation = 'choose_design';
        item.retry.requiredInference = 'A different private description.';
        item.retry.decisiveCondition = 'Changed private text.';
      }
      await expect(f.verify()).rejects.toMatchObject({
        details: {
          candidateFailure: {
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: 'practice_public_retry_replay' }),
            ]),
          },
        },
      });
      expect(f.review).not.toHaveBeenCalled();
    },
  );

  it.each(['changed', 'absent'] as const)(
    'rejects a public Lesson task replay with %s declarations',
    async (metadata) => {
      const f = await fixture();
      const initial = f.candidate.items[0]!.initial;
      f.priorTeaching.segments.push({
        explanation: 'A completed earlier public case.',
        sources: [],
        semanticRelations: [],
        example: null,
        contrast: null,
        possibleMisconception: null,
        workedProcess: null,
        informalCheck: {
          prompt: `**${initial.prompt}**`,
          options: initial.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
        },
      });
      if (metadata === 'absent') for (const field of fields) delete initial[field];
      else {
        initial.requiredInference = 'A different private description.';
        initial.decisiveCondition = 'Another private condition.';
      }
      await expect(f.verify()).rejects.toMatchObject({
        details: {
          candidateFailure: {
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: 'practice_public_lesson_replay' }),
            ]),
          },
        },
      });
      expect(f.review).not.toHaveBeenCalled();
    },
  );

  it.each(['changed', 'absent'] as const)(
    'requires independent public replay/leakage evidence with %s descriptions',
    async (metadata) => {
      for (const defect of ['practice_replay', 'answer_leak'] as const) {
        const f = await fixture();
        if (metadata === 'absent')
          for (const field of fields) delete f.candidate.items[0]!.initial[field];
        else {
          f.candidate.items[0]!.initial.requiredInference = 'Unrelated private conclusion.';
          f.candidate.items[0]!.initial.decisiveCondition = 'Unrelated private condition.';
        }
        const review = f.review.getMockImplementation()!;
        f.review.mockImplementation(async (prepared, round) => {
          const response = await review(prepared, round);
          if (prepared.input.purpose === 'practice_integrity')
            response.result.findings.push({
              itemId: 'PR1.initial',
              code: defect,
              problem: `The public taught case already supplies this same completion/unchanged-capacity result: ${f.candidate.items[0]!.initial.prompt}`,
              repairInstruction: 'Use a materially new visible case and withhold its result.',
            });
          return response;
        });
        await expect(f.verify()).rejects.toMatchObject({
          details: {
            candidateFailure: {
              diagnostics: expect.arrayContaining([expect.objectContaining({ code: defect })]),
            },
          },
        });
        expect(f.revise).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('keeps comparison and solves free of private declarations, keys and delayed help', async () => {
    const f = await fixture();
    f.candidate.items[0]!.initial.requiredInference = 'PRIVATE_INFERENCE';
    f.candidate.items[0]!.initial.decisiveCondition = 'PRIVATE_CONDITION';
    f.candidate.items[0]!.initial.hint = 'PRIVATE_HINT';
    f.candidate.items[0]!.initial.options[0]!.feedbackIfSelected = 'PRIVATE_FEEDBACK';
    const comparison = preparePracticeIntegrityReview(
      practiceProofItems(f.candidate),
      f.priorTeaching,
    );
    expect(JSON.stringify(comparison.input)).not.toMatch(
      /PRIVATE_|reasoningOperation|requiredInference|decisiveCondition|evidenceContrast|correctOption/,
    );
    await f.verify();
    for (const [prepared] of f.review.mock.calls)
      if (prepared.input.purpose !== 'practice_grounding') {
        expect(JSON.stringify(prepared.input)).not.toMatch(
          /PRIVATE_|reasoningOperation|requiredInference|decisiveCondition|evidenceContrast|correctOption/,
        );
        if (prepared.input.purpose === 'practice_answerability')
          expect(prepared.input).not.toHaveProperty('acceptedLesson');
      }
    const prompt = teachingContentReviewMessages(comparison.input)[0]!.content;
    expect(prompt).toContain('comparison review does not establish correctness');
    expect(prompt).toContain(
      'shared rule, mechanism, topic, vocabulary or answer alone is not replay',
    );
  });

  it.each(['missing', 'version', 'input', 'candidate', 'finding', 'inventory'] as const)(
    'refuses %s integrity receipts through the common draft and saved gates',
    async (mutation) => {
      const f = await fixture();
      const result = await f.verify();
      const brief = f.saved(result);
      expect(hasCurrentPreparedPractice(brief)).toBe(true);
      const evidence = brief.practice!.qualityEvaluation;
      if (mutation === 'missing') delete evidence.integrityReview;
      else if (mutation === 'version')
        evidence.integrityReview!.policyVersion = 'practice-acceptance-v3-inference-quality';
      else if (mutation === 'input')
        evidence.integrityReview!.rounds[0]!.inputHash = `sha256:${'0'.repeat(64)}`;
      else if (mutation === 'candidate')
        evidence.integrityReview!.rounds[0]!.candidateHash = `sha256:${'0'.repeat(64)}`;
      else if (mutation === 'inventory')
        evidence.integrityReview!.rounds[0]!.result.decisions =
          result.answerabilityReview.rounds[0]!.solves[0]!.result.decisions;
      else
        evidence.integrityReview!.rounds[0]!.result.findings.push({
          itemId: 'PR1',
          code: 'practice_replay',
          problem: 'Same public case.',
          repairInstruction: 'Replace the case.',
        });
      expect(hasCurrentPreparedPractice(brief)).toBe(false);
      expect(() =>
        assertReviewedPracticeAcceptance(result.candidate, f.context, f.priorTeaching, evidence),
      ).toThrow();
    },
  );

  it('rechecks inference-required contrast on saved reuse despite previously valid public receipts', async () => {
    const f = await fixture();
    const brief = f.saved(await f.verify());
    delete brief.practice!.items[0]!.initial.reasoningOperation;
    expect(hasCurrentPreparedPractice(brief)).toBe(true);
    delete brief.practice!.items[0]!.initial.evidenceContrast;
    expect(hasCurrentPreparedPractice(brief)).toBe(false);
  });

  it('rejects authority escapes before review even with all declarations absent', async () => {
    const f = await fixture();
    for (const field of fields) delete f.candidate.items[0]!.initial[field];
    f.candidate.items[0]!.sourceRefs = ['S999'];
    expect(() => assertPracticeCandidate(f.candidate, f.context, f.priorTeaching)).toThrow();
    await expect(f.verify()).rejects.toBeDefined();
    expect(f.review).not.toHaveBeenCalled();
  });

  it('retains historical optional surface parsing without upgrading its acceptance authority', async () => {
    const f = await fixture();
    const brief = f.saved(await f.verify());
    for (const field of fields) delete brief.practice!.items[0]!.initial[field];
    expect(LessonPracticeSurfaceSchema.safeParse(brief.practice!.items[0]!.initial).success).toBe(
      true,
    );
    delete brief.practice!.qualityEvaluation.integrityReview;
    brief.practice!.qualityEvaluation.acceptancePolicyVersion = PRACTICE_ACCEPTANCE_POLICY_VERSION;
    expect(hasCurrentPreparedPractice(brief)).toBe(false);
  });
});
