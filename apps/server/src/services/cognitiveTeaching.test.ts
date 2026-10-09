import { describe, expect, it, vi } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  LessonPedagogyEvaluationSchema,
  PracticeQualityEvaluationSchema,
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  LESSON_CONTENT_REVIEW_POLICY_VERSION,
  projectAcceptedLessonSegments,
  projectLearnerPracticeSurface,
  projectPracticePriorTeaching,
  type DesiredDepth,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import {
  lessonSlotContentMessages,
  practiceContentMessages,
  teachingContentReviewMessages,
} from '../llm/prompts.js';
import { teachingCapsuleMessages, validateTeachingCapsule } from '../llm/teachingCapsule.js';
import {
  mergeLocalizedAliasRepair,
  normalizeLessonPreparationCandidate,
} from '../llm/preparationRecovery.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import {
  assertCurrentCognitiveContract,
  applyPracticeAggregateAcceptancePolicy,
  evaluateLessonSlotPedagogy,
  evaluatePlannedPracticeQuality,
  lessonReasoningExposure,
  practiceEvaluationInvalidSlotIds,
  practiceQualityImprovementFindings,
} from './lessonPedagogyEvaluator.js';
import {
  validateLessonSlotContentCandidate,
  validatePracticeContentCandidate,
} from './teachingBriefContract.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';
import {
  prepareTeachingReview,
  preparePracticeAnswerabilityReview,
  verifyPreparedTeaching,
  verifyPreparedPractice,
} from './teachingContentReview.js';
import { compareLearnerPracticeTasks } from './practiceTaskCanonicalization.js';
import {
  isLessonChoiceContractCode,
  lessonChoiceNeedsMaterialReview,
  hasAcceptedLessonChoiceContract,
} from './lessonChoiceContract.js';

const at = { evaluatedAt: '2026-09-05T00:00:00.000Z' };

async function fixture(
  depth: DesiredDepth = 'working_fluency',
  construct: 'identify' | 'explain' = 'identify',
) {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: '检索条件与系统边界',
    targetMinutes: 28,
    targetDepth: depth,
    objectives: [
      { objectiveRef: 'O1', title: '识别检索条件', description: '区分查询条件与返回候选。' },
      { objectiveRef: 'O2', title: '识别系统边界', description: '区分系统约束与处理状态。' },
    ].map((objective) => ({
      ...objective,
      priority: 'required' as const,
      construct,
      authorityMode: 'exact_source' as const,
      allowedSourceRefs: ['S1'],
      allowedVisualRefs: [],
    })),
  });
  const lessonInput: LessonSlotContentGenerationInput = {
    workspaceName: 'Cognitive fixture',
    learnerLocale: 'zh-CN',
    courseDesign: { desiredDepth: depth, unitFocus: 'focused' },
    skeleton,
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
          headingPath: ['检索'],
          pageNumber: 1,
          slideNumber: null,
          text: '检索条件决定哪些候选被保留，系统状态改变时需要重新检查约束。',
          authorizedObjectiveRefs: ['O1', 'O2'],
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
  const provider = new FakeProvider();
  const lesson = await provider.generateLessonSlotContent(lessonInput);
  const practiceInput: PracticeContentGenerationInput = {
    ...lessonInput,
    acceptedLesson: lesson.slots,
  };
  const practice = await provider.generatePracticeContent(practiceInput);
  const worked = lesson.slots.find((slot) => slot.workedProcess?.interaction)!;
  const process = worked.workedProcess!;
  const interaction = process.interaction!;
  const lessonEvaluation = () => evaluateLessonSlotPedagogy(lesson, lessonInput, at);
  const practiceEvaluation = () => evaluatePlannedPracticeQuality(practice, practiceInput, at);
  return {
    lessonInput,
    practiceInput,
    lesson,
    practice,
    worked,
    process,
    interaction,
    lessonEvaluation,
    practiceEvaluation,
  };
}

const shallowPrompt =
  '检索系统把候选过滤、结果排序和状态更新分为三类。当前日志直接把操作标为“结果排序”。这个操作属于哪一类检索步骤？';
const reasoningPrompt =
  '检索规则：先保留匹配度至少60的候选，再按匹配度排序。候选甲匹配度80，候选乙匹配度40。过滤后返回哪些候选，为什么？';

async function shallowFixture(
  depth: DesiredDepth = 'working_fluency',
  operation: 'recognize' | 'classify' = 'recognize',
) {
  const f = await fixture(depth);
  f.practiceInput.courseDesign!.unitFocus = 'normal';
  // A real deadline/energy tradeoff completes O1 coverage, isolating this rule.
  const transfer = f.interaction.transfer;
  transfer.reasoningOperation = 'judge_tradeoff';
  transfer.changedCondition += '备用方案额外耗电；原处理器等待方案省电但无法满足截止要求。';
  transfer.prompt = '本次必须满足截止要求。如何在额外耗电与等待超期之间作出权衡？';
  transfer.requiredInference = '接受备用方案的额外耗电，以满足截止要求和独立配额限制。';
  transfer.options[0]!.text = '在原处理器等待甲完成，优先节省电量，即使错过截止要求。';
  transfer.options[1]!.text = '让备用处理器接收乙，在独立容量内启动，并接受额外耗电。';
  const item = f.practice.items[0]!;
  item.sourceRefs = [];
  item.initial = {
    reasoningOperation: operation,
    requiredInference: '从日志声明中识别这个步骤所属的检索类别。',
    decisiveCondition: '日志直接把操作标为结果排序。',
    evidenceContrast: {
      evidence: '当前日志直接把操作标为“结果排序”',
      replacement: '当前日志直接把操作标为“候选过滤”',
      alternativeOptionId: 'B',
    },
    prompt: shallowPrompt,
    options: [
      {
        optionRef: 'A',
        text: '属于结果排序，排列已经保留的候选。',
        feedbackIfSelected: '日志明确标出了排序类别。',
      },
      {
        optionRef: 'B',
        text: '属于候选过滤，排除不满足条件的候选。',
        feedbackIfSelected: '过滤是另一个类别，日志没有这样标注。',
      },
      {
        optionRef: 'C',
        text: '属于状态更新，修改任务的资源记录。',
        feedbackIfSelected: '状态更新与排列候选不是同一类操作。',
      },
    ],
    correctOptionRef: 'A',
    hint: '先读日志已经给出的类别名称。',
    explanation: '这是根据系统直接给出的类别名称识别步骤，无须推导额外结果。',
  };
  return f;
}

function deepenInitial(draft: Awaited<ReturnType<typeof shallowFixture>>['practice']) {
  const initial = draft.items[0]!.initial;
  initial.prompt = reasoningPrompt;
  initial.reasoningOperation = 'predict_outcome';
  initial.requiredInference = '比较两个匹配度与阈值，推导过滤后仅保留候选甲。';
  initial.decisiveCondition = '阈值60介于甲的80和乙的40之间。';
  initial.evidenceContrast = {
    evidence: '候选甲匹配度80，候选乙匹配度40',
    replacement: '候选甲匹配度40，候选乙匹配度80',
    alternativeOptionId: 'B',
  };
  initial.options[0]!.text = '只返回候选甲，因为只有甲满足最低匹配度。';
  initial.options[1]!.text = '只返回候选乙，因为只有乙满足最低匹配度。';
  initial.options[2]!.text = '同时返回甲乙，因为排序会保留全部候选。';
  initial.options[0]!.feedbackIfSelected = '80至少为60，甲通过过滤。';
  initial.options[1]!.feedbackIfSelected = '40小于60，乙没有通过过滤。';
  initial.options[2]!.feedbackIfSelected = '过滤排除乙，后续排序不会恢复已排除的候选。';
  initial.hint = '逐个把匹配度与最低阈值比较。';
  initial.explanation =
    '先把80和40分别与60比较，过滤去掉不满足阈值的候选；排序不能恢复已过滤的候选。';
  return draft;
}

function verifyShallow(
  f: Awaited<ReturnType<typeof shallowFixture>>,
  improve: NonNullable<Parameters<typeof verifyPreparedPractice>[5]>,
  requiresCaseInference = true,
  groundingDefect = false,
) {
  const provider = new FakeProvider();
  const review = vi.fn<Parameters<typeof verifyPreparedPractice>[3]>(async (prepared, round) => {
    const input = prepared.input;
    const reasoning =
      input.purpose === 'practice_grounding'
        ? input.candidate.items.find((item) => item.initial.prompt === reasoningPrompt)?.initial
        : undefined;
    // Finite independently controlled teaching claims: 80 >= 60, 40 < 60;
    // swapping those values uniquely selects B. Private formatting is irrelevant.
    const falseReasoningClaim =
      reasoning &&
      (reasoning.options.some(
        (option, index) =>
          option.feedbackIfSelected !==
          [
            '80至少为60，甲通过过滤。',
            '40小于60，乙没有通过过滤。',
            '过滤排除乙，后续排序不会恢复已排除的候选。',
          ][index],
      ) ||
        (reasoning.evidenceContrast?.replacement === '候选甲匹配度40，候选乙匹配度80' &&
          reasoning.evidenceContrast.alternativeOptionId !== 'B'));
    if (
      (groundingDefect && round > 0 && input.purpose === 'practice_grounding') ||
      falseReasoningClaim
    )
      return {
        result: {
          decisions: [],
          findings: [
            {
              itemId: f.practice.items[0]!.practiceSlotId,
              code: 'grounding',
              problem: falseReasoningClaim
                ? 'The feedback or supplied swapped-score counterfactual contradicts 80 >= 60 and 40 < 60.'
                : 'The rewritten rule contradicts the authorized source.',
              responsibility: 'grounding',
              repairInstruction: 'Restore the supported rule.',
            },
          ],
        },
        logicalCallId: `review-${round}:grounding`,
      };
    const result =
      input.purpose === 'practice_answerability' &&
      input.candidate.actionId === `${f.practice.items[0]!.practiceSlotId}.initial`
        ? {
            decisions: [
              {
                actionId: input.actionIds[0]!,
                answerId: 'A',
                requiresCaseInference:
                  (round > 0 || input.candidate.prompt !== shallowPrompt) && requiresCaseInference,
                evidenceUsed:
                  input.candidate.prompt === reasoningPrompt
                    ? 'Comparing the two values with the threshold derives that only candidate A remains.'
                    : 'The public log directly states the category; no new outcome is derived.',
              },
            ],
            findings: [],
          }
        : await provider.reviewTeachingContent(input);
    return { result, logicalCallId: `review-${round}:${input.actionIds[0] ?? 'grounding'}` };
  });
  const verified = verifyPreparedPractice(
    f.practiceInput,
    f.practice,
    projectPracticePriorTeaching({
      objective: { title: '检索条件', whyNow: '区分类别并使用阈值。', objectives: [] },
      prerequisites: [],
      segments: [],
      summary: '先过滤，再排序。',
      nextConnection: null,
      sourceReferences: [],
      visualReferences: [],
    }),
    review,
    async () => {
      throw new Error('An optional rewrite cannot start another hard revision.');
    },
    improve,
  );
  return { verified, review };
}

describe('calibrated cognitive teaching contract', () => {
  it('keeps computed model rules in mixed review and preserves their accuracy findings', async () => {
    const f = await fixture();
    f.process.ruleOrProcedure = 'Below 30 is represented here as value <= 30.';
    const computed = new Set([f.worked.slotId]);
    const prepared = prepareTeachingReview(f.lessonInput, f.lesson, computed);
    expect(JSON.stringify(prepared.input)).toContain(f.process.ruleOrProcedure);
    expect(prepared.input.computedItemIds).toEqual([f.worked.slotId]);
    expect(prepared.input.actionIds.some((id) => id.startsWith(f.worked.slotId + '.'))).toBe(false);
    expect(prepared.input.actionIds.length).toBeGreaterThan(0);
    const finding = {
      itemId: f.worked.slotId,
      code: 'accuracy' as const,
      responsibility: 'grounding' as const,
      problem: 'A strict bound became inclusive.',
      repairInstruction: 'Use < instead of <=.',
    };
    expect(prepared.findings({ decisions: [], findings: [finding] })).toEqual([finding]);
    expect(prepared.validate({ decisions: [], findings: [finding] }).valid).toBe(false);
  });
  it('reviews visible content without author labels or answer keys and requires exact coverage', async () => {
    const f = await fixture();
    f.process.learnerDecision = 'PRIVATE_GUIDED_RESULT_36_OVER_84';
    const prepared = prepareTeachingReview(f.lessonInput, f.lesson);
    const serialized = JSON.stringify(prepared.input);
    expect(serialized).not.toContain('PRIVATE_GUIDED_RESULT_36_OVER_84');
    for (const key of [
      'reasoningOperation',
      'requiredInference',
      'decisiveCondition',
      'evidenceContrast',
      'correctOptionId',
    ])
      expect(serialized).not.toContain(`"${key}"`);
    expect(serialized).toContain('空闲配额为2');
    expect(prepared.validate({ decisions: [], findings: [] }).valid).toBe(false);
    const decisions = prepared.input.actionIds.map((actionId) => ({
      actionId,
      answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
      requiresCaseInference: true,
      evidenceUsed: 'Current capacity and the task requirement.',
    }));
    expect(prepared.validate({ decisions, findings: [] }).valid).toBe(true);
    const actionFinding = {
      itemId: decisions[0]!.actionId,
      code: 'accuracy' as const,
      responsibility: 'grounding' as const,
      problem: 'The case result contradicts its update.',
      repairInstruction: 'Recompute the changed state.',
    };
    expect(prepared.validate({ decisions, findings: [actionFinding] }).valid).toBe(true);
    expect(prepared.findings({ decisions, findings: [actionFinding] })[0]!.itemId).toBe(
      f.worked.slotId,
    );
    const reviewedSlots = (
      prepared.input.candidate as {
        slots: Array<{ workedProcess?: { interaction?: { activity: Record<string, unknown> } } }>;
      }
    ).slots;
    const reviewedAction = reviewedSlots.find((slot) => slot.workedProcess?.interaction)!
      .workedProcess!.interaction!.activity;
    expect(reviewedAction.options).toEqual(
      f.interaction.activity.options.map(({ id, text }) => ({ id, text })),
    );
    expect(reviewedAction.afterResponse).toBeDefined();
    expect(JSON.stringify(reviewedAction.afterResponse)).not.toContain('optionFeedback');
    expect(JSON.stringify(reviewedAction)).not.toContain(f.interaction.activity.correctDebrief);
    expect(reviewedAction).not.toHaveProperty('correctDebrief');
    const reviewedProcess = reviewedSlots.find(
      (slot) => slot.workedProcess?.interaction,
    )!.workedProcess!;
    expect(reviewedProcess).not.toHaveProperty('result');
    expect(reviewedProcess).not.toHaveProperty('learnerDecision');
    expect(reviewedProcess).not.toHaveProperty('whyResultFollows');
    expect(reviewedProcess).not.toHaveProperty('afterGuidedResponse.result');
    expect(reviewedProcess).not.toHaveProperty('afterTransferResponse.whyResultFollows');
    expect(reviewedProcess).toHaveProperty(
      'interaction.afterWrongGuidedResponse.scaffold.actionId',
    );
    expect(reviewedProcess).not.toHaveProperty('interaction.scaffold');
    expect(reviewedProcess).toHaveProperty('steps');
    expect(prepared.findings({ decisions, findings: [] })).toEqual([]);
    const computedReview = prepareTeachingReview(
      { ...f.lessonInput, computedCases: true },
      f.lesson,
    );
    const binaryDisagreement = decisions.map((d) => ({ ...d, requiresCaseInference: false }));
    expect(prepared.findings({ decisions: binaryDisagreement, findings: [] })).toEqual([]);
    expect(
      prepared.findings({
        decisions: binaryDisagreement,
        findings: [
          {
            itemId: f.worked.slotId,
            code: 'shallow_task',
            responsibility: 'integrity',
            problem: 'The prompt already states the exact keyed result.',
            repairInstruction: 'Withhold the new result until the learner has answered.',
          },
        ],
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'shallow_task' })]));
    expect(computedReview.findings({ decisions: binaryDisagreement, findings: [] })).toEqual([]);
    expect(
      computedReview.findings({
        decisions: binaryDisagreement,
        findings: [
          {
            itemId: f.lesson.slots[0]!.slotId,
            code: 'accuracy',
            problem: 'The model asserts an unsupported mechanism.',
            repairInstruction: 'Correct the assumption.',
          },
        ],
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'accuracy' })]));
    decisions[0]!.answerId = 'C';
    expect(prepared.findings({ decisions, findings: [] })[0]?.code).toBe('insufficient_evidence');
    expect(computedReview.findings({ decisions, findings: [] })[0]?.code).toBe(
      'insufficient_evidence',
    );
    expect(prepared.validate({ decisions: [...decisions, decisions[0]], findings: [] }).valid).toBe(
      false,
    );
    expect(
      prepared.validate({
        decisions,
        findings: [
          {
            itemId: 'L999',
            code: 'accuracy',
            problem: 'Unknown slot',
            repairInstruction: 'Ignore',
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it.each([
    'delayed_guided',
    'opening',
    'scaffold_hint',
    'transfer_hint',
    'transfer_feedback',
    'transfer_continuation',
    'final_rationale',
  ] as const)(
    'uses real response ordering for %s in the existing material review and exhaustion path',
    async (surface) => {
      const f = await fixture();
      const guidedResult = '乙应等待甲归还配额。';
      const scaffoldResult = '3-2=1，缺口为一个配额。';
      const transferResult = '新的截止案例应让备用处理器接收乙。';
      if (surface === 'delayed_guided') f.interaction.hint = guidedResult;
      if (surface === 'opening') f.lesson.narrative!.whyNow = guidedResult;
      if (surface === 'scaffold_hint') f.interaction.hint = scaffoldResult;
      if (surface === 'transfer_hint') f.interaction.hint = transferResult;
      if (surface === 'transfer_feedback')
        f.interaction.activity.options[1]!.feedbackIfSelected = transferResult;
      if (surface === 'transfer_continuation') f.process.steps[1]!.reason = transferResult;
      if (surface === 'final_rationale') f.process.whyResultFollows = transferResult;
      const revise = vi.fn(async (draft: typeof f.lesson) => draft);
      let reviews = 0;
      const review = async (prepared: ReturnType<typeof prepareTeachingReview>) => {
        reviews += 1;
        // This finite oracle uses the actual public quota fixture (4-2=2<3,
        // 3-2=1, spare 3 fits the deadline task), never authored keys/labels.
        const publicLesson = prepared.input.candidate as {
          responseContexts: Array<{
            actionId: string;
            visibleBefore: string[];
            conditionalBefore: Array<{ texts: string[] }>;
            prompt: string;
          }>;
        };
        const response = (name: string) =>
          publicLesson.responseContexts.find(
            ({ actionId }) => actionId === `${f.worked.slotId}.${name}`,
          )!;
        const guided = response('guided');
        const scaffold = response('scaffold');
        const transfer = response('transfer');
        expect(guided.visibleBefore.join('\n')).toContain('空闲配额为2');
        expect(transfer.visibleBefore.join('\n')).toContain('空闲容量3');
        expect(scaffold.prompt).toContain('相差多少');
        expect(guided.visibleBefore).not.toContain(f.process.result);
        expect(transfer.visibleBefore).not.toContain(f.process.whyResultFollows);
        expect(JSON.stringify(guided)).not.toContain(f.interaction.activity.correctDebrief);
        const laterTransferExposure = [
          ...transfer.visibleBefore,
          ...transfer.conditionalBefore.flatMap(({ texts }) => texts),
        ];
        const witness = guided.visibleBefore.includes(guidedResult)
          ? guidedResult
          : scaffold.visibleBefore.includes(scaffoldResult)
            ? scaffoldResult
            : laterTransferExposure.includes(transferResult)
              ? transferResult
              : undefined;
        const result: TeachingContentReview = {
          decisions: prepared.input.actionIds.map((actionId) => ({
            actionId,
            answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
            requiresCaseInference: true,
            evidenceUsed:
              'The controlled public capacity, gap and independent spare capacity determine the offered outcomes.',
          })),
          findings: witness
            ? [
                {
                  itemId: f.worked.slotId,
                  code: 'answer_leak',
                  responsibility: 'integrity',
                  problem: `Before the corresponding independent response, the rendered branch states: ${witness}`,
                  repairInstruction: 'Move this specific case result after its own response.',
                },
              ]
            : [],
        };
        return { logicalCallId: `ordered-public-${reviews}`, result };
      };
      const pending = verifyPreparedTeaching(f.lessonInput, f.lesson, review, revise);
      if (surface === 'delayed_guided' || surface === 'final_rationale') {
        expect((await pending).candidate).toEqual(f.lesson);
        expect(revise).not.toHaveBeenCalled();
        expect(reviews).toBe(1);
      } else {
        await expect(pending).rejects.toMatchObject({
          details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
        });
        expect(revise).toHaveBeenCalledTimes(1);
        expect(reviews).toBe(2);
      }
      const computed = prepareTeachingReview({ ...f.lessonInput, computedCases: true }, f.lesson);
      expect(JSON.stringify(computed.input.candidate)).toContain('afterGuidedResponse');
      expect(JSON.stringify(computed.input.candidate)).toContain('responseContexts');
    },
  );

  it('refuses generic public proof and quality acceptance after the review packet changes in transit', async () => {
    const f = await fixture();
    const revise = vi.fn(async (draft: typeof f.lesson) => draft);
    await expect(
      verifyPreparedTeaching(
        f.lessonInput,
        f.lesson,
        async (prepared) => {
          const publicCandidate = prepared.input.candidate as typeof f.lesson;
          publicCandidate.slots.find(
            (slot) => slot.workedProcess,
          )!.workedProcess!.steps[0]!.resultingState +=
            ' 新补入的可见条件：当前配额足够启动所有任务。';
          return {
            logicalCallId: 'mutated-public-review',
            result: {
              decisions: prepared.input.actionIds.map((actionId) => ({
                actionId,
                answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
                requiresCaseInference: true,
                evidenceUsed: 'The supplied public packet contains the needed condition.',
              })),
              findings: [],
              advisories: [
                {
                  itemId: f.worked.slotId,
                  code: 'insufficient_evidence',
                  qualityAspect: 'richness',
                  problem: 'The case could explore another constraint.',
                  repairInstruction: 'Consider a richer case.',
                },
              ],
            },
          };
        },
        revise,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(revise).not.toHaveBeenCalled();
  });

  it('rechecks one concrete revision and binds both reviews to the exact candidates', async () => {
    const f = await fixture();
    let revisions = 0;
    const verified = await verifyPreparedTeaching(
      f.lessonInput,
      f.lesson,
      async (prepared, round) => ({
        logicalCallId: `review-${round}`,
        result: {
          decisions: prepared.input.actionIds.map((actionId) => ({
            actionId,
            answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
            requiresCaseInference: true,
            evidenceUsed: 'Compare remaining capacity and new task demand.',
          })),
          findings:
            round === 0
              ? [
                  {
                    itemId: f.worked.slotId,
                    code: 'accuracy',
                    responsibility: 'grounding',
                    problem: 'Final state disagrees with the update.',
                    repairInstruction: 'Recompute the final state.',
                  },
                ]
              : [],
        },
      }),
      async (draft, findings) => {
        revisions += 1;
        expect(findings[0]?.code).toBe('accuracy');
        return { ...draft, narrative: { ...draft.narrative!, summary: 'Updated final state.' } };
      },
    );
    expect(revisions).toBe(1);
    expect(verified.receipts).toHaveLength(2);
    expect(verified.receipts[0]!.candidateHash).not.toBe(verified.receipts[1]!.candidateHash);
    let failures = 0;
    await expect(
      verifyPreparedTeaching(
        f.lessonInput,
        f.lesson,
        async (prepared, round) => ({
          logicalCallId: `failed-review-${round}`,
          result: {
            decisions: prepared.input.actionIds.map((actionId) => ({
              actionId,
              answerId: null,
              requiresCaseInference: false,
              evidenceUsed: 'Required case evidence is absent.',
            })),
            findings: [],
          },
        }),
        async (draft) => {
          failures += 1;
          return draft;
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        candidateFailure: expect.objectContaining({ kind: 'teaching_content_review_failed' }),
      }),
    });
    expect(failures).toBe(1);
  });
  it('permits a second content correction only after an actual draft change resolves a prior defect', async () => {
    const f = await fixture();
    let revisions = 0;
    const verified = await verifyPreparedTeaching(
      f.lessonInput,
      f.lesson,
      async (prepared, round) => ({
        logicalCallId: `progressive-review-${round}`,
        result: {
          decisions: prepared.input.actionIds.map((actionId) => ({
            actionId,
            answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
            requiresCaseInference: true,
            evidenceUsed: 'Visible case premises.',
          })),
          findings:
            round < 2
              ? [
                  {
                    itemId: f.worked.slotId,
                    code: round === 0 ? 'accuracy' : 'insufficient_evidence',
                    responsibility: round === 0 ? 'grounding' : 'answerability',
                    problem:
                      round === 0
                        ? 'Incorrect state update.'
                        : 'A comparison still lacks a needed parameter.',
                    repairInstruction: 'Correct the concrete case premise.',
                  },
                ]
              : [],
        },
      }),
      async (draft) => {
        revisions++;
        return {
          ...draft,
          narrative: { ...draft.narrative!, summary: `Corrected case premises ${revisions}.` },
        };
      },
    );
    expect(revisions).toBe(2);
    expect(verified.receipts).toHaveLength(3);
    expect(new Set(verified.receipts.map((r) => r.candidateHash)).size).toBe(3);
    const lessonReceipt = LessonPedagogyEvaluationSchema.parse({
      ...f.lessonEvaluation(),
      contentReview: verified.receipts,
    });
    const practiceVerified = await verifyShallow(f, async (draft) => draft);
    const practiceReceipt = PracticeQualityEvaluationSchema.parse({
      ...f.practiceEvaluation(),
      contentReview: practiceVerified.verified.receipts,
    });
    expect(lessonReceipt.contentReview).toEqual(verified.receipts);
    expect(practiceReceipt.contentReview).toEqual(practiceVerified.verified.receipts);
    expect(
      LessonPedagogyEvaluationSchema.safeParse({
        ...lessonReceipt,
        contentReview: [...verified.receipts, verified.receipts[0]],
      }).success,
    ).toBe(false);
  });
  it('requires the worked interaction and a complete actual choice for normal Units at working fluency', async () => {
    const f = await fixture();
    f.lessonInput.courseDesign!.unitFocus = 'normal';
    const generated = await new FakeProvider().generateLessonSlotContent(f.lessonInput);
    expect(generated.slots.some((slot) => slot.workedProcess?.interaction)).toBe(true);
    const check = generated.slots.find((slot) => slot.informalCheck)!.informalCheck!;
    delete check.options;
    delete check.correctOptionId;
    expect(evaluateLessonSlotPedagogy(generated, f.lessonInput, at).findings).toContainEqual(
      expect.objectContaining({ code: 'lesson_choice_check_missing_options', severity: 'error' }),
    );
  });

  it.each(
    (['working_fluency', 'high_performance', 'deep_transfer'] as const).flatMap((depth) =>
      (['normal', 'focused'] as const).flatMap((focus) => [
        {
          depth,
          focus,
          kind: 'own_words' as const,
          reasoningOperation: 'diagnose_cause' as const,
          prompt:
            '检索规则规定只保留匹配度至少60的候选。候选甲的匹配度80，乙的匹配度40，日志却显示两者都被返回。请用自己的话解释检索系统可能在哪个环节失效，并说明依据。',
          requiredInference: '候选过滤环节可能未应用阈值检查，低于阈值的乙仍然被返回。',
          decisiveCondition: '乙的匹配度40低于保留阈值60，但出现在返回日志中。',
          expectedSignal: '将返回日志与阈值逐项比较，并指出过滤环节可能失效。',
        },
        {
          depth,
          focus,
          kind: 'predict_next' as const,
          reasoningOperation: 'predict_outcome' as const,
          prompt:
            '检索规则规定只保留匹配度至少60的候选。甲的匹配度80，乙的匹配度40。如果检索系统把阈值提高到90，返回候选会怎样变化？请解释依据。',
          requiredInference: '新的阈值会排除甲和乙，使返回集合为空。',
          decisiveCondition: '新阈值90高于甲的80和乙的40。',
          expectedSignal: '比较每个候选的匹配度与新阈值，解释返回集合的变化。',
        },
        {
          depth,
          focus,
          kind: 'apply_simple_example' as const,
          reasoningOperation: 'choose_design' as const,
          prompt:
            '检索系统有候选甲匹配度80、乙匹配度40，保留规则为匹配度至少60。请构建一组检查步骤，让系统从当前候选状态生成符合约束的返回集合，并解释每步作用。',
          requiredInference: '先逐个检查匹配度阈值，再仅将通过条件的候选加入返回集合。',
          decisiveCondition: '返回集合只能包含匹配度达到60的候选。',
          expectedSignal: '写出检查阈值和保留候选的具体步骤，并说明如何排除不满足条件的记录。',
        },
      ]),
    ),
  )(
    'accepts answerable $kind without choices at $depth / $focus',
    async ({ depth, focus, ...task }) => {
      const f = await fixture(depth);
      f.lessonInput.courseDesign!.unitFocus = focus;
      const lesson = await new FakeProvider().generateLessonSlotContent(f.lessonInput);
      const slot = lesson.slots.find((slot) => slot.informalCheck)!;
      slot.informalCheck = task;
      const evaluation = evaluateLessonSlotPedagogy(lesson, f.lessonInput, at);
      expect(evaluation.status, JSON.stringify(evaluation.findings)).toBe('pass');
      expect(evaluation.findings).toContainEqual(
        expect.objectContaining({
          code: 'reasoning_choice_missing',
          severity: 'warning',
          message: expect.stringContaining('nonblocking presentation observation'),
        }),
      );
      expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
      expect(validateLessonSlotContentCandidate(lesson, f.lessonInput).valid).toBe(true);
      expect(
        validateTeachingCapsule(
          { lesson, practice: { items: [] } },
          {
            lesson: f.lessonInput,
            practiceSlots: [],
            priorLesson: [],
            includeNarrative: true,
          },
        ).valid,
      ).toBe(true);
      expect(slot.informalCheck).not.toHaveProperty('options');
      expect(slot.informalCheck).not.toHaveProperty('correctOptionId');
    },
  );

  it.each(
    (['pass_oriented', 'working_fluency', 'high_performance', 'deep_transfer'] as const).flatMap(
      (depth) =>
        [
          'missing_pair',
          'missing_options',
          'missing_key',
          'empty',
          'one',
          'duplicate',
          'identity',
          'binding',
          'hidden_own_words',
          'hidden_predict_next',
          'hidden_apply_simple_example',
        ].map((defect) => ({ depth, defect })),
    ),
  )(
    'hard rejects $defect at $depth in candidates, capsules and the final assertion',
    async ({ depth, defect }) => {
      const f = await fixture();
      f.lessonInput.courseDesign!.desiredDepth = depth;
      const lesson = await new FakeProvider().generateLessonSlotContent(f.lessonInput);
      const check = lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!;
      if (defect === 'missing_pair' || defect === 'missing_options') delete check.options;
      if (defect === 'missing_pair' || defect === 'missing_key') delete check.correctOptionId;
      if (defect === 'empty') check.options = [];
      if (defect === 'one') check.options = check.options!.slice(0, 1);
      if (defect === 'duplicate') check.options![1]!.id = check.options![0]!.id;
      if (defect === 'identity') check.options![0]!.id = 'X';
      if (defect === 'binding') check.correctOptionId = 'E';
      if (defect.startsWith('hidden_'))
        check.kind = defect.slice('hidden_'.length) as
          'own_words' | 'predict_next' | 'apply_simple_example';
      expect(validateLessonSlotContentCandidate(lesson, f.lessonInput).valid).toBe(false);
      expect(
        validateTeachingCapsule(
          { lesson, practice: { items: [] } },
          {
            lesson: f.lessonInput,
            practiceSlots: [],
            priorLesson: [],
            includeNarrative: true,
          },
        ).valid,
      ).toBe(false);
      const evaluation = evaluateLessonSlotPedagogy(lesson, f.lessonInput, at);
      expect(
        evaluation.findings.some(
          (finding) => finding.severity === 'error' && isLessonChoiceContractCode(finding.code),
        ),
      ).toBe(true);
      expect(() => assertCurrentCognitiveContract(evaluation)).toThrow();
      expect(
        evaluation.findings.some((finding) => finding.code === 'reasoning_choice_missing'),
      ).toBe(false);
    },
  );

  it('resolves prior public alternatives when validating a later Lesson capsule', async () => {
    const f = await fixture();
    const index = f.lesson.slots.findIndex((slot) => slot.informalCheck);
    const priorLesson = structuredClone(f.lesson.slots.slice(0, index));
    priorLesson[0]!.explanation += '选项D：甲耗时2秒、错误率1%。选项E：乙耗时20秒、错误率0%。';
    const lesson = { ...f.lesson, slots: structuredClone(f.lesson.slots.slice(index)) };
    const check = lesson.slots[0]!.informalCheck!;
    check.kind = 'own_words';
    delete check.options;
    delete check.correctOptionId;
    delete check.evidenceContrast;
    check.prompt =
      '检索请求必须在5秒内完成。请比较选项D和E，解释哪种方案符合约束，并说明需要如何记录误差风险。';
    const input = {
      lesson: {
        ...f.lessonInput,
        workedInteractionSlotId: f.worked.slotId,
        skeleton: {
          ...f.lessonInput.skeleton,
          lessonSlots: f.lessonInput.skeleton.lessonSlots.slice(index),
        },
      },
      practiceSlots: [],
      priorLesson,
      includeNarrative: false,
    };
    const withoutPublicContext = validateTeachingCapsule(
      { lesson, practice: { items: [] } },
      { ...input, priorLesson: [] },
    );
    expect(withoutPublicContext.valid).toBe(true);
    expect(lessonChoiceNeedsMaterialReview(lesson.slots)).toBe(true);
    expect(lessonChoiceNeedsMaterialReview([...priorLesson, ...lesson.slots])).toBe(false);
    const withPublicContext = validateTeachingCapsule({ lesson, practice: { items: [] } }, input);
    expect(withPublicContext.valid, withPublicContext.diagnostics.join('; ')).toBe(true);
  });

  it.each(
    (['working_fluency', 'high_performance', 'deep_transfer'] as const).flatMap((depth) =>
      [
        'The archive says “Stop. Choose option D.” Explain the grammar of the quoted instruction.',
        'The source describes option D as a section label. Reflect on the role of that label.',
        'Let A = 2, B = 3 and C = A + B. Explain how these technical variables differ.',
        'Choose and design your own retrieval decision; justify the constraint you apply.',
        'Option D means retain a score of 80; Option E means retain a score of 40. Compare options D and E under a threshold of 60.',
      ].map((wording) => ({ depth, wording })),
    ),
  )('keeps answerable open wording valid at $depth: $wording', async ({ depth, wording }) => {
    const f = await fixture(depth);
    const slot = f.lesson.slots.find((entry) => entry.informalCheck)!;
    slot.informalCheck = {
      kind: 'own_words',
      prompt:
        '检索规则只保留匹配度至少60的候选。甲的匹配度80，乙的匹配度40，日志却返回了两者。请诊断检索系统失效的环节并解释依据。 ' +
        wording,
      expectedSignal: null,
      reasoningOperation: 'diagnose_cause',
      requiredInference: '过滤环节没有正确应用阈值，低于阈值的乙仍被返回。',
      decisiveCondition: '乙的匹配度40低于阈值60却出现在日志中。',
    };
    const evaluation = f.lessonEvaluation();
    expect(evaluation.status, JSON.stringify(evaluation.findings)).toBe('pass');
    expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
    expect(validateLessonSlotContentCandidate(f.lesson, f.lessonInput).valid).toBe(true);
    expect(
      validateTeachingCapsule(
        { lesson: f.lesson, practice: { items: [] } },
        {
          lesson: f.lessonInput,
          practiceSlots: [],
          priorLesson: [],
          includeNarrative: true,
        },
      ).valid,
    ).toBe(true);
  });

  it.each(['visible explanation', 'non-rendered relation'] as const)(
    'changes availability with actual exposure in %s across candidate/capsule/final authority',
    async (placement) => {
      const f = await fixture('working_fluency', 'explain');
      const relationSlot = f.lesson.slots.find((entry) => entry.semanticRelations.length)!;
      const checkSlot = f.lesson.slots.find((entry) => entry.informalCheck)!;
      expect(f.lesson.slots.indexOf(relationSlot)).toBeLessThan(f.lesson.slots.indexOf(checkSlot));
      const definitions = [
        'Option D means retain a candidate with score 80.',
        'Option E means retain a candidate with score 40.',
      ];
      if (placement === 'visible explanation')
        relationSlot.explanation += ' ' + definitions.join(' ');
      else {
        relationSlot.semanticRelations[0]!.fromProposition += ' ' + definitions[0];
        relationSlot.semanticRelations[0]!.toProposition += ' ' + definitions[1];
      }
      const check = checkSlot.informalCheck!;
      check.kind = 'own_words';
      delete check.options;
      delete check.correctOptionId;
      delete check.evidenceContrast;
      check.prompt +=
        ' Compare options D and E under a retrieval threshold of 60 and justify which result should be returned.';
      const visible = placement === 'visible explanation';
      const evaluation = f.lessonEvaluation();
      expect(
        evaluation.findings.filter(({ severity }) => severity === 'error').map(({ code }) => code),
      ).toEqual([]);
      expect(lessonChoiceNeedsMaterialReview(f.lesson.slots)).toBe(!visible);
      expect(
        hasAcceptedLessonChoiceContract(f.lesson.slots, evaluation, [f.lesson.narrative!.whyNow]),
      ).toBe(visible);
      expect(validateLessonSlotContentCandidate(f.lesson, f.lessonInput).valid).toBe(true);
      expect(
        validateTeachingCapsule(
          { lesson: f.lesson, practice: { items: [] } },
          {
            lesson: f.lessonInput,
            practiceSlots: [],
            priorLesson: [],
            includeNarrative: true,
          },
        ).valid,
      ).toBe(true);
      expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
      const review = prepareTeachingReview(f.lessonInput, f.lesson);
      const reviewed = JSON.stringify(review.input.candidate);
      expect(reviewed).not.toContain('semanticRelations');
      expect(reviewed.includes(definitions[0]!)).toBe(visible);
      expect(JSON.stringify(f.lesson)).toContain(definitions[0]!);
    },
  );

  it.each(['timeout', 'invalid inventory', 'unavailable'] as const)(
    'does not turn an ambiguous dependency into acceptance when material review has %s',
    async (failure) => {
      const f = await fixture('working_fluency', 'explain');
      const slot = f.lesson.slots.find((entry) => entry.informalCheck)!;
      slot.informalCheck!.kind = 'own_words';
      delete slot.informalCheck!.options;
      delete slot.informalCheck!.correctOptionId;
      delete slot.informalCheck!.evidenceContrast;
      slot.informalCheck!.prompt += ' 在你的推理中讨论先前提到的选项D。';
      const relation = f.lesson.slots.find((entry) => entry.semanticRelations.length)!
        .semanticRelations[0]!;
      relation.fromProposition += ' Option D: a private-only alternative.';
      expect(
        f
          .lessonEvaluation()
          .findings.some(({ code }) => code === 'lesson_choice_reference_unavailable'),
      ).toBe(false);
      const review = vi.fn(async (prepared: ReturnType<typeof prepareTeachingReview>) => {
        expect(JSON.stringify(prepared.input.candidate)).not.toContain('private-only alternative');
        if (failure === 'timeout') throw new Error('Offline simulated review timeout');
        if (failure === 'unavailable') throw new Error('Offline simulated review unavailable');
        return { logicalCallId: 'ambiguous-review', result: { decisions: [], findings: [] } };
      });
      const revise = vi.fn();
      await expect(
        verifyPreparedTeaching(f.lessonInput, f.lesson, review, revise),
      ).rejects.toThrow();
      expect(review).toHaveBeenCalledOnce();
      expect(revise).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'Compare options D and E',
      'as printed letter labels.',
      'by the reasoning in their proposals.',
    ],
    [
      'Compare options A and C',
      'as printed identifiers.',
      'by the reasoning in their alternatives.',
    ],
    ['Order options D and E', 'by their printed letters.', 'by the predicted cost of their plans.'],
    [
      'Identify option D',
      'by the final character in that identifier.',
      'by the claim that satisfies the constraint.',
    ],
    [
      'Explain why option B differs from option C',
      'in its printed letter.',
      'in the reliability of its claim.',
    ],
    [
      'Apply option D',
      'as the displayed name of a variable.',
      'as a procedure to the current retrieval case.',
    ],
    [
      'Evaluate option D',
      'as a string containing one label letter.',
      'as a proposed solution to the capacity constraint.',
    ],
    [
      'Select option D',
      'by copying the printed identifier.',
      'because its proposed solution satisfies the constraint.',
    ],
    ['比较选项D与选项E', '这两个标题的字母。', '这两个方案的推理依据。'],
    ['说明选项B和选项C', '两个标签的字母差别。', '哪个方案的主张更可靠。'],
    ['应用选项D', '这个字符串作为变量的名字。', '提出的方法处理当前检索问题。'],
  ])(
    'delegates label/content semantics for the same request: %s',
    async (request, labels, contents) => {
      for (const [suffix, needsContents] of [
        [labels, false],
        [contents, true],
      ] as const) {
        const f = await fixture();
        const slot = f.lesson.slots.find((entry) => entry.informalCheck)!;
        slot.informalCheck = {
          kind: 'own_words',
          prompt:
            '检索规则只保留匹配度至少60的候选。甲的匹配度80，乙的匹配度40，日志却返回了两者。请诊断检索系统失效的环节并解释依据。 ' +
            request +
            ' ' +
            suffix,
          expectedSignal: null,
          reasoningOperation: 'diagnose_cause',
          requiredInference: '过滤环节没有正确应用阈值，低于阈值的乙仍被返回。',
          decisiveCondition: '乙的匹配度40低于阈值60却出现在日志中。',
        };
        expect(validateLessonSlotContentCandidate(f.lesson, f.lessonInput).valid).toBe(true);
        expect(
          validateTeachingCapsule(
            { lesson: f.lesson, practice: { items: [] } },
            { lesson: f.lessonInput, practiceSlots: [], priorLesson: [], includeNarrative: true },
          ).valid,
        ).toBe(true);
        expect(lessonChoiceNeedsMaterialReview(f.lesson.slots)).toBe(true);
        const evaluation = f.lessonEvaluation();
        expect(
          hasAcceptedLessonChoiceContract(f.lesson.slots, evaluation, [f.lesson.narrative!.whyNow]),
        ).toBe(false);
        const review = vi.fn(
          async (prepared: ReturnType<typeof prepareTeachingReview>, round: number) => {
            const publicText = JSON.stringify(prepared.input.candidate);
            expect(publicText).toContain(slot.informalCheck!.prompt);
            expect(publicText).not.toContain('requiredInference');
            const prompt = teachingContentReviewMessages(prepared.input)
              .map((message) => message.content)
              .join('\n');
            expect(prompt).toContain('printed identity/text itself');
            return {
              logicalCallId: 'offline-paired-review-' + round,
              result: {
                decisions: prepared.input.actionIds.map((actionId) => ({
                  actionId,
                  answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
                  requiresCaseInference: true,
                  evidenceUsed: 'Visible fixture premises.',
                })),
                // Independent fixture oracle, not the production label detector.
                findings: needsContents
                  ? [
                      {
                        itemId: slot.slotId,
                        code: 'insufficient_evidence' as const,
                        responsibility: 'answerability' as const,
                        problem: 'The task needs alternative contents which were never exposed.',
                        repairInstruction: 'Supply the required contents before asking this task.',
                      },
                    ]
                  : [],
              },
            };
          },
        );
        const revise = vi.fn(async (draft: typeof f.lesson) => structuredClone(draft));
        const verifying = verifyPreparedTeaching(f.lessonInput, f.lesson, review, revise);
        if (needsContents) {
          await expect(verifying).rejects.toMatchObject({
            details: { candidateFailure: { kind: 'teaching_content_review_failed' } },
          });
          expect(review).toHaveBeenCalledTimes(2);
          expect(revise).toHaveBeenCalledOnce();
        } else {
          const verified = await verifying;
          evaluation.contentReview = verified.receipts;
          evaluation.contentReviewPolicyVersion = LESSON_CONTENT_REVIEW_POLICY_VERSION;
          expect(
            hasAcceptedLessonChoiceContract(f.lesson.slots, evaluation, [
              f.lesson.narrative!.whyNow,
            ]),
          ).toBe(true);
          expect(review).toHaveBeenCalledOnce();
          expect(revise).not.toHaveBeenCalled();
        }
      }
    },
  );

  it('uses the existing content review and bounded revision for unavailable context beyond literal option identities', async () => {
    const f = await fixture();
    const slot = f.lesson.slots.find((slot) => slot.informalCheck)!;
    slot.informalCheck = {
      kind: 'own_words',
      prompt: '根据下表的两种方案，解释哪种检索设计满足所有限制。',
      expectedSignal: null,
      reasoningOperation: 'choose_design',
      requiredInference: '逐个检查匹配度并只保留满足阈值的候选。',
      decisiveCondition: '只有匹配度不低于阈值的候选能被保留。',
    };
    const prepared = prepareTeachingReview(f.lessonInput, f.lesson);
    const reviewPrompt = teachingContentReviewMessages(prepared.input)
      .map((message) => message.content)
      .join('\n');
    expect(reviewPrompt).toContain('inspect open-response prompts outside actionIds');
    expect(reviewPrompt).toContain('absent offered alternatives');
    expect(prepared.input.actionIds).not.toContain(`${slot.slotId}.informalCheck`);
    expect(JSON.stringify(prepared.input.candidate)).toContain(slot.informalCheck.prompt);
    let reviews = 0;
    let revisions = 0;
    const verified = await verifyPreparedTeaching(
      f.lessonInput,
      f.lesson,
      async (candidate) => ({
        logicalCallId: `open-review-${reviews}`,
        result: {
          decisions: candidate.input.actionIds.map((actionId) => ({
            actionId,
            answerId: actionId.endsWith('.transfer') ? 'B' : 'A',
            requiresCaseInference: true,
            evidenceUsed: 'Visible case premises.',
          })),
          findings:
            reviews++ === 0
              ? [
                  {
                    itemId: slot.slotId,
                    code: 'insufficient_evidence',
                    responsibility: 'answerability',
                    problem: 'The referenced table and its designs are absent.',
                    repairInstruction:
                      'Supply the designs and constraints or ask a complete open task.',
                  },
                ]
              : [],
        },
      }),
      async (draft) => {
        revisions++;
        const repaired = structuredClone(draft);
        repaired.slots.find((entry) => entry.slotId === slot.slotId)!.informalCheck!.prompt =
          '检索规则只保留匹配度至少60的候选。候选甲为80，乙为40。请设计检查步骤，并解释它们如何生成符合约束的返回集合。';
        const validation = validateLessonSlotContentCandidate(repaired, f.lessonInput);
        expect(validation.valid, validation.diagnostics.join('; ')).toBe(true);
        return repaired;
      },
    );
    expect(revisions).toBe(1);
    expect(reviews).toBe(2);
    expect(verified.receipts).toHaveLength(2);
  });

  it('aligns draft, editor and capsule guidance with open tasks and the UI choice kind', async () => {
    const f = await fixture();
    for (const draftForReview of [undefined, f.lesson]) {
      const prompt = lessonSlotContentMessages({ ...f.lessonInput, draftForReview })
        .map((message) => message.content)
        .join('\n');
      expect(prompt).toContain('An ordinary action is also valid there');
      expect(prompt).toContain(
        'must be complete open-response tasks without options/correctOptionId',
      );
      expect(prompt).toContain('"informalCheck":{"kind":"choose_alternative"');
      expect(prompt).not.toContain('Each ordinary informal check must offer structured choices');
    }
    const capsule = teachingCapsuleMessages({
      lesson: f.lessonInput,
      practiceSlots: [],
      priorLesson: [],
      includeNarrative: true,
    })
      .map((message) => message.content)
      .join('\n');
    expect(capsule).toContain('Ordinary Lesson checks may instead use complete open');
    expect(capsule).toContain('choose_alternative');
    const practiceReview = teachingContentReviewMessages(
      prepareTeachingReview(f.practiceInput, f.practice).input,
    )
      .map((message) => message.content)
      .join('\n');
    expect(practiceReview).not.toContain('For Lesson informal checks');
  });
  it('binds the decisive evidence to the learner case and a different available answer', async () => {
    const f = await fixture();
    expect(f.lessonEvaluation().status).toBe('pass');
    const contrast = f.interaction.activity.evidenceContrast!;
    contrast.evidence = 'This fact exists only in private author metadata.';
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'evidence_contrast_not_visible',
        severity: 'warning',
      }),
    );
    contrast.evidence = '甲运行中，空闲配额为2';
    contrast.alternativeOptionId = f.interaction.activity.correctOptionId;
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'evidence_contrast_not_decisive',
        severity: 'warning',
      }),
    );
    contrast.alternativeOptionId = 'B';
    expect(f.lessonEvaluation().status).toBe('pass');
    f.practice.items[0]!.initial.prompt = '发生了错误。应先诊断哪个环节？';
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'evidence_contrast_not_visible',
        severity: 'warning',
      }),
    );
  });
  it('recognizes same-section case facts already visible before an informal check, but never hidden feedback', async () => {
    const f = await fixture();
    const slot = f.lesson.slots.find((slot) => slot.informalCheck)!;
    const check = slot.informalCheck!;
    const fact = '观察到甲材料和乙材料来自同一修订并重叠第二句。';
    slot.explanation += fact;
    check.prompt = '根据上述案例，哪种结果成立？';
    check.evidenceContrast!.evidence = fact;
    expect(
      f
        .lessonEvaluation()
        .findings.some((finding) => finding.code === 'evidence_contrast_not_visible'),
    ).toBe(false);
    slot.explanation = slot.explanation.replace(fact, '');
    check.expectedSignal = fact;
    expect(
      f
        .lessonEvaluation()
        .findings.some((finding) => finding.code === 'evidence_contrast_not_visible'),
    ).toBe(true);
  });

  it('allows a quoted parenthetical prefix while preserving the actual case facts', async () => {
    const f = await fixture();
    const surface = f.practice.items[0]!.initial;
    surface.prompt = 'D7属于另一kb_C2（同租户不同kb，Carol仅对kb_C1有资源权限）。系统会如何处理？';
    surface.evidenceContrast!.evidence = 'D7属于另一kb_C2（同租户不同kb）';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'evidence_contrast_not_visible'),
    ).toBe(false);
    surface.evidenceContrast!.evidence = 'D7属于另一kb_C2（不同租户不同kb）';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'evidence_contrast_not_visible'),
    ).toBe(true);
  });

  it('accepts a concrete state update with shared vocabulary and a concise choice', async () => {
    const f = await fixture();
    f.process.steps[1]!.resultingState = f.process.steps[0]!.resultingState.replace(
      '配额为2',
      '配额为3',
    );
    f.process.steps[1]!.reason = '配额已经归还';
    f.interaction.activity.options[0]!.text = '等待';
    f.interaction.scaffold.options[0]!.text = '仅read';
    f.interaction.scaffold.options[1]!.text = 'read和write';
    f.process.inputs = ['U1→R1', 'action=reparse'];
    expect(f.lessonEvaluation().findings.filter((finding) => finding.severity === 'error')).toEqual(
      [],
    );
    f.process.steps[1]!.resultingState = f.process.steps[0]!.resultingState;
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'worked_process_has_no_real_transition',
        severity: 'warning',
      }),
    );
  });

  it('does not treat a previously wrong candidate answer as an established teacher conclusion', async () => {
    const f = await fixture();
    f.interaction.activity.options[1]!.text = f.practice.items[0]!.initial.requiredInference!;
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'practice_semantic_replay'),
    ).toBe(false);
  });

  it('keeps private inference equality with labels and teacher prose advisory', async () => {
    const f = await fixture();
    f.practice.items[0]!.initial.requiredInference = f.interaction.activity.requiredInference;
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'practice_semantic_replay',
        severity: 'warning',
      }),
    );
    f.practice.items[0]!.initial.requiredInference = '完成事件没有更新配额状态，应先检查归还动作。';
    f.lesson.slots[0]!.explanation = f.practice.items[0]!.initial.requiredInference;
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'practice_semantic_replay',
        severity: 'warning',
      }),
    );
    expect(
      lessonReasoningExposure(f.lesson.slots, f.lessonInput.skeleton)[0]!.taughtConclusions,
    ).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('完成事件没有更新配额状态') }),
    );
  });

  it('keeps a bound evidence quote consistent through localized alias repair', async () => {
    const f = await fixture();
    const first = structuredClone(f.lesson);
    const worked = first.slots.find((slot) => slot.workedProcess)!;
    worked.workedProcess!.steps[0]!.resultingState = 'S1: 甲运行中，空闲配额为2';
    worked.workedProcess!.interaction!.activity.evidenceContrast!.evidence =
      'S1: 甲运行中，空闲配额为2';
    const merged = mergeLocalizedAliasRepair(first, f.lesson, 'slots', 'slotId', {
      rootNarrative: false,
      items: [{ itemId: worked.slotId, components: ['workedProcess'] }],
    });
    expect(LessonSlotContentProposalPayloadSchema.parse(merged)).toEqual(f.lesson);
    expect(validateLessonSlotContentCandidate(merged, f.lessonInput).valid).toBe(true);
  });

  it.each([
    ['Prompt禁令从根源阻断了编造错误。', true],
    ['明确的提示词消除了虚构的动机。', true],
    ['Prompt禁令不能保证拒答，仍需校验执行对象。', false],
    ['校验器只允许清单中的路径进入执行阶段；这不能证明内容真实。', false],
    ['执行器禁止清单外的路径，确保不会执行未授权路由。', false],
  ])('calibrates affirmative probabilistic-control claims: %s', async (text, rejected) => {
    const f = await fixture();
    f.interaction.activity.correctDebrief = text;
    expect(
      f
        .lessonEvaluation()
        .findings.some((finding) => finding.code === 'probabilistic_control_overclaimed'),
    ).toBe(rejected);
  });

  it('accepts reasoning on identify authority with modelled state and diagnostic Practice', async () => {
    const f = await fixture();
    expect(f.lessonEvaluation().status).toBe('pass');
    expect(f.practiceEvaluation().status).toBe('pass');
    expect(f.interaction.activity.reasoningOperation).toBe('predict_outcome');
    expect(f.process.steps[0]!.resultingState).toContain('空闲配额为2');
    expect(f.interaction.activity.prompt).toContain('刚算出的快照');
    expect(
      f.practice.items.every((item) => item.initial.reasoningOperation === 'diagnose_cause'),
    ).toBe(true);
    expect(f.lessonInput.skeleton.objectives.every((o) => o.construct === 'identify')).toBe(true);
  });

  it('accepts absent Lesson annotations without treating them as public correctness proof', async () => {
    const f = await fixture();
    const segments = projectAcceptedLessonSegments(
      { skeleton: f.lessonInput.skeleton, lessonContent: f.lesson.slots },
      ['objective_1', 'objective_2'],
    );
    expect(segments.find((slot) => slot.workedProcess)?.workedProcess?.interaction).toEqual(
      f.interaction,
    );
    const historical = structuredClone(f.lesson);
    for (const slot of historical.slots) {
      for (const action of [
        slot.informalCheck,
        slot.workedProcess?.interaction?.activity,
        slot.workedProcess?.interaction?.scaffold,
        slot.workedProcess?.interaction?.transfer,
      ]) {
        if (!action) continue;
        delete action.reasoningOperation;
        delete action.requiredInference;
        if ('decisiveCondition' in action) delete action.decisiveCondition;
      }
    }
    expect(LessonSlotContentProposalPayloadSchema.safeParse(historical).success).toBe(true);
    const evaluation = evaluateLessonSlotPedagogy(historical, f.lessonInput, at);
    expect(evaluation.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_reasoning_declaration', severity: 'warning' }),
    );
    expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
    expect(validateLessonSlotContentCandidate(historical, f.lessonInput).valid).toBe(true);
    const practice = structuredClone(f.practice);
    delete practice.items[0]!.initial.requiredInference;
    expect(PracticeContentProposalPayloadSchema.safeParse(practice).success).toBe(true);
    expect(evaluatePlannedPracticeQuality(practice, f.practiceInput, at).status).toBe('pass');
  });

  it('requires reasoning for each objective, guided and transfer, while pass_oriented permits recognition', async () => {
    const f = await fixture();
    f.interaction.activity.reasoningOperation = 'recognize';
    f.interaction.transfer.reasoningOperation = 'classify';
    for (const slot of f.lesson.slots)
      if (slot.informalCheck) slot.informalCheck.reasoningOperation = 'recognize';
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({ code: 'reasoning_demand_below_depth', objectiveRefs: ['O2'] }),
    );
    f.lessonInput.courseDesign = { desiredDepth: 'pass_oriented', unitFocus: 'normal' };
    expect(
      f
        .lessonEvaluation()
        .findings.some((finding) => finding.code === 'reasoning_demand_below_depth'),
    ).toBe(false);
  });

  it.each(['rule', 'step', 'opening', 'objective', 'hint', 'inline'] as const)(
    'delegates contextual Chinese result disclosure on %s to public review',
    async (surface) => {
      const f = await fixture();
      const conclusion = '分组标签必须由链路中的其他组件写入，距离排序本身不能产生类别名称。';
      f.interaction.activity.requiredInference = conclusion;
      f.interaction.activity.options[0]!.text = conclusion;
      const baseline = f.lessonEvaluation();
      expect(baseline.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      if (surface === 'rule') f.process.ruleOrProcedure = conclusion;
      if (surface === 'step') f.process.steps[0]!.resultingState = conclusion;
      if (surface === 'opening') f.lesson.narrative!.whyNow = conclusion;
      if (surface === 'objective') f.lessonInput.skeleton.objectives[0]!.description = conclusion;
      if (surface === 'hint') f.interaction.hint = conclusion;
      if (surface === 'inline') {
        const slot = f.lesson.slots.find((entry) => entry.informalCheck)!;
        slot.informalCheck!.requiredInference = conclusion;
        slot.informalCheck!.options![0]!.text = conclusion;
        slot.explanation = conclusion;
      }
      expect(
        f.lessonEvaluation().findings.filter((finding) => finding.severity === 'error'),
      ).toEqual([]);
    },
  );

  it('does not hard reject Chinese premises assembled from the same answer vocabulary', async () => {
    const f = await fixture();
    f.interaction.activity.options[0]!.text = '向量检索返回候选记录，关系过滤负责类别约束。';
    f.interaction.activity.requiredInference = '应将类别限制交给过滤组件，再使用排序结果。';
    f.worked.explanation = '系统里有向量检索、关系过滤两种处理。';
    f.process.ruleOrProcedure = '候选记录包含距离分数以及类别字段。';
    f.process.steps[0]!.resultingState =
      '返回候选记录列表；关系过滤负责检查字段，请求另有类别约束。';
    expect(
      f
        .lessonEvaluation()
        .findings.filter((finding) => finding.code === 'worked_interaction_answer_pre_revealed'),
    ).toEqual([]);
  });

  it('keeps candidate questions and concise causal corrections advisory', async () => {
    const f = await fixture();
    const answer = f.interaction.activity.options[0]!.text;
    f.worked.explanation = `有人提出：${answer}这个判断是否成立？`;
    f.interaction.activity.options[1]!.misconception!.correction = '甲占用的配额尚未归还。';
    expect(f.lessonEvaluation().findings.filter((finding) => finding.severity === 'error')).toEqual(
      [],
    );
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'worked_interaction_correction_not_substantive',
        severity: 'warning',
      }),
    );
  });

  it('reports private replay descriptions without claiming that they prove public replay', async () => {
    const f = await fixture();
    const initial = f.practice.items[0]!.initial;
    initial.reasoningOperation = f.interaction.activity.reasoningOperation;
    initial.decisiveCondition = f.interaction.activity.decisiveCondition;
    initial.requiredInference = f.interaction.activity.requiredInference;
    initial.prompt = '把任务甲乙换成服装商品后，哪项结果会出现？';
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({ code: 'practice_semantic_replay', severity: 'warning' }),
    );
    initial.decisiveCondition = '空闲5个配额，乙需要3个，且没有其他运行任务。';
    initial.requiredInference = '乙立即启动，分配后还剩两个空闲配额。';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'practice_semantic_replay'),
    ).toBe(false);
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({ code: 'practice_novelty_uncertain', severity: 'warning' }),
    );
  });

  it('rejects unchanged retry while retaining recognition-at-depth diagnostics without penalizing reasoning vocabulary as assertion promotion', async () => {
    const f = await fixture();
    const item = f.practice.items[0]!;
    item.retry.reasoningOperation = item.initial.reasoningOperation;
    item.retry.decisiveCondition = item.initial.decisiveCondition;
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'practice_retry_semantic_replay'),
    ).toBe(true);
    item.initial.reasoningOperation = 'recognize';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'practice_initial_recognition_at_depth'),
    ).toBe(true);
    item.initial.prompt += ' 为什么这个诊断需要权衡，下一步该如何选择？';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'practice_promotes_construct'),
    ).toBe(false);
  });

  it.each([
    ['working_fluency', 'recognize'],
    ['working_fluency', 'classify'],
    ['high_performance', 'recognize'],
    ['high_performance', 'classify'],
    ['deep_transfer', 'recognize'],
    ['deep_transfer', 'classify'],
  ] as const)(
    'keeps explicit %s/%s shallow tasks quality-only with complete declarations',
    async (depth, operation) => {
      const f = await shallowFixture(depth, operation);
      const evaluation = f.practiceEvaluation();
      expect(evaluation.status).toBe('pass');
      expect(practiceQualityImprovementFindings(evaluation)).toEqual([
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
          itemIndexes: [0],
          objectiveRefs: ['O1'],
        }),
      ]);
      expect(validatePracticeContentCandidate(f.practice, f.practiceInput).valid).toBe(true);
      expect(validateLessonSlotContentCandidate(f.lesson, f.lessonInput).valid).toBe(true);
      expect(practiceEvaluationInvalidSlotIds(evaluation, f.practiceInput)).toEqual([]);
      expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
      const prompt = practiceContentMessages(f.practiceInput)
        .map(({ content }) => content)
        .join('\n');
      expect(prompt).toContain('Initial must be reasoning-class at working_fluency and above');
      expect(prompt).toContain(`"desiredDepth":"${depth}"`);
      if (depth === 'deep_transfer')
        expect(
          f.practiceInput.skeleton.lessonSlots.some(
            (slot) => slot.qualityContract === 'boundary_work',
          ),
        ).toBe(true);
    },
  );

  it.each(['pass_oriented', undefined] as const)(
    'does not add a shallow-depth finding for depth %s',
    async (depth) => {
      const f = await shallowFixture();
      f.practiceInput.courseDesign = depth
        ? { desiredDepth: depth, unitFocus: 'normal' }
        : undefined;
      expect(
        f
          .practiceEvaluation()
          .findings.some(({ code }) => code === 'practice_initial_recognition_at_depth'),
      ).toBe(false);
    },
  );

  it.each(['initial', 'retry'] as const)(
    'diagnoses missing %s declarations without redefining initial depth',
    async (surface) => {
      for (const field of [
        'reasoningOperation',
        'requiredInference',
        'decisiveCondition',
      ] as const) {
        const f = await shallowFixture();
        delete f.practice.items[0]![surface][field];
        const evaluation = f.practiceEvaluation();
        expect(evaluation.status).toBe('pass');
        expect(
          evaluation.findings.some(({ code }) => code === 'missing_reasoning_declaration'),
        ).toBe(false);
        expect(
          evaluation.findings.filter(
            ({ code }) => code === 'practice_initial_recognition_at_depth',
          ),
        ).toHaveLength(surface === 'initial' && field === 'reasoningOperation' ? 0 : 1);
        expect(evaluation.findings.every(({ severity }) => severity === 'warning')).toBe(true);
        expect(validatePracticeContentCandidate(f.practice, f.practiceInput).valid).toBe(true);
        expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
      }
    },
  );

  it.each(['recognize', 'classify'] as const)(
    'retains a correct %s shallow original with absent descriptions and no inference requirement',
    async (operation) => {
      const f = await shallowFixture('working_fluency', operation);
      delete f.practice.items[0]!.initial.requiredInference;
      delete f.practice.items[0]!.initial.decisiveCondition;
      for (const field of ['reasoningOperation', 'requiredInference', 'decisiveCondition'] as const)
        delete f.practice.items[0]!.retry[field];
      const improve = vi.fn(async () => {
        throw ProviderError.network();
      });
      const result = await verifyShallow(f, improve, false).verified;
      expect(result.candidate).toEqual(f.practice);
      expect(
        result.answerabilityReview.rounds[0]!.solves[0]!.result.decisions[0]!.requiresCaseInference,
      ).toBe(false);
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'failed' });
      expect(result.integrityReview.rounds).toHaveLength(1);
      expect(f.practiceEvaluation().findings).toContainEqual(
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
      );
    },
  );

  it.each(['no_op', 'still_shallow'] as const)(
    'accepts residual shallow warnings after one %s quality attempt',
    async (rewrite) => {
      const f = await shallowFixture();
      const improve = vi.fn(async (draft: typeof f.practice) => {
        if (rewrite === 'still_shallow') draft.items[0]!.initial.reasoningOperation = 'classify';
        return draft;
      });
      const { verified, review } = verifyShallow(f, improve);
      const result = await verified;
      expect(improve).toHaveBeenCalledTimes(1);
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
      expect(result.candidate).toEqual(f.practice);
      expect(
        practiceQualityImprovementFindings(
          evaluatePlannedPracticeQuality(result.candidate, f.practiceInput, at),
        ),
      ).toEqual(result.qualityImprovement.findingsBefore);
      expect(result.receipts).toHaveLength(1);
      expect(result.answerabilityReview.rounds).toHaveLength(1);
      expect(result.integrityReview.rounds).toHaveLength(1);
      expect(review).toHaveBeenCalledTimes(2 * (2 + 2 * f.practice.items.length));
    },
  );

  it.each(['plain', 'markdown', 'unicode_quotation'] as const)(
    'accepts %s deeper public reasoning only after hard validation and fresh blind inference proofs',
    async (formatting) => {
      const f = await shallowFixture('deep_transfer');
      const improve = vi.fn(async (draft: typeof f.practice) => {
        deepenInitial(draft);
        if (formatting === 'markdown') {
          draft.items[0]!.initial.prompt = `**${draft.items[0]!.initial.prompt}**`;
          for (const option of draft.items[0]!.initial.options) option.text = `_${option.text}_`;
        }
        if (formatting === 'unicode_quotation') {
          draft.items[0]!.initial.prompt += ' Read "résumé review".'.normalize('NFD');
          for (const option of draft.items[0]!.initial.options)
            option.text += ' "café report".'.normalize('NFD');
        }
        return draft;
      });
      const { verified, review } = verifyShallow(f, improve);
      const result = await verified;
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'improved' });
      expect(
        practiceQualityImprovementFindings(
          evaluatePlannedPracticeQuality(result.candidate, f.practiceInput, at),
        ),
      ).toEqual([]);
      expect(validatePracticeContentCandidate(result.candidate, f.practiceInput).valid).toBe(true);
      expect(
        result.answerabilityReview.rounds.at(-1)!.solves[0]!.result.decisions[0]!
          .requiresCaseInference,
      ).toBe(true);
      expect(result.receipts[0]!.candidateHash).not.toBe(result.receipts[1]!.candidateHash);
      expect(new Set(review.mock.calls.map(([prepared]) => prepared.input.purpose))).toEqual(
        new Set(['practice_answerability', 'practice_integrity', 'practice_grounding']),
      );
      const priorTeaching = {
        objective: { title: '检索条件', whyNow: '区分类别并使用阈值。', outcomes: [] },
        prerequisites: [],
        segments: [],
        visuals: [],
        summary: { text: '先过滤，再排序。', nextConnection: null },
      };
      const publicSurface = (surface: (typeof f.practice.items)[number]['initial']) => ({
        prompt: surface.prompt,
        options: surface.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
      });
      for (const [prepared, round] of review.mock.calls) {
        const input = prepared.input;
        const candidate = round === 0 ? f.practice : result.candidate;
        if (input.purpose === 'practice_grounding') {
          // Reasoning/contrast declarations are reviewed claims, never blind proof.
          expect(input.candidate).toEqual(candidate);
          expect(input.acceptedLesson).toEqual(f.practiceInput.acceptedLesson);
          expect(input.sources).toEqual(f.practiceInput.sourceContext.offers);
          expect(input.actionIds).toEqual([]);
          expect(
            prepared.validate({
              decisions: [
                {
                  actionId: `${candidate.items[0]!.practiceSlotId}.initial`,
                  answerId: candidate.items[0]!.initial.correctOptionRef,
                  requiresCaseInference: true,
                  evidenceUsed: 'The private author declaration claims this answer.',
                },
              ],
              findings: [],
            }).valid,
          ).toBe(false);
          continue;
        }
        for (const field of [
          'reasoningOperation',
          'requiredInference',
          'decisiveCondition',
          'evidenceContrast',
          'correctOptionRef',
          'application',
          'explanation',
          'feedbackIfSelected',
          'hint',
        ])
          expect(JSON.stringify(input.candidate)).not.toContain(`"${field}"`);
        const publicItems = candidate.items.map((item) => ({
          practiceSlotId: item.practiceSlotId,
          initial: publicSurface(item.initial),
          retry: publicSurface(item.retry),
        }));
        if (input.purpose === 'practice_answerability') {
          const actionId = input.candidate.actionId;
          expect(
            publicItems.flatMap((item) =>
              (['initial', 'retry'] as const).map((surface) => ({
                actionId: `${item.practiceSlotId}.${surface}`,
                ...item[surface],
              })),
            ),
          ).toContainEqual(input.candidate);
          expect(input).toEqual({
            purpose: 'practice_answerability',
            stage: 'practice',
            candidate: input.candidate,
            priorTeaching,
            actionIds: [actionId],
          });
        } else {
          expect(input).toEqual({
            purpose: 'practice_integrity',
            stage: 'practice',
            desiredDepth: 'pass_oriented',
            objectives: [],
            sources: [],
            candidate: { items: publicItems },
            acceptedLesson: priorTeaching,
            actionIds: [],
          });
        }
      }
    },
  );

  it.each(
    [
      ['plain', '', ''],
      ['double', '"', '"'],
      ['single', "'", "'"],
      ['curly', '“', '”'],
      ['corner', '「', '」'],
      ['double_corner', '『', '』'],
    ].flatMap(([quotation, open, close]) =>
      (['NFC', 'NFD'] as const).map((unicode) => ({ quotation, open, close, unicode })),
    ),
  )(
    'rejects Unicode equivalence across public prose classes with optimistic inference: $quotation/$unicode',
    async ({ open, close, unicode }) => {
      const f = await shallowFixture();
      const phrase =
        'café report résumé review Ångström measure naïve façade Ελληνική λέξη 보고서 검토';
      const quotation = `${open}${phrase}${close}`;
      const before = f.practice.items[0]!.initial;
      before.prompt = `${before.prompt} Read ${quotation}.`.normalize(unicode);
      for (const option of before.options)
        option.text = `${option.text} ${quotation}.`.normalize(unicode);
      const visible = (initial: typeof before) =>
        projectLearnerPracticeSurface({
          prompt: initial.prompt,
          options: initial.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
        });
      expect(validatePracticeContentCandidate(f.practice, f.practiceInput).valid).toBe(true);
      for (const presentation of [false, true]) {
        let rewritten!: typeof f.practice;
        const improve = vi.fn(async (draft: typeof f.practice) => {
          const initial = draft.items[0]!.initial;
          initial.reasoningOperation = 'diagnose_cause';
          const transform = (text: string) => {
            const value = text.normalize(unicode === 'NFC' ? 'NFD' : 'NFC');
            return presentation ? ` \t**_${value.replace(/ /gu, '\r\n\t')}_**\r\n` : value;
          };
          initial.prompt = transform(initial.prompt);
          for (const option of initial.options) option.text = transform(option.text);
          if (presentation) initial.options.reverse();
          rewritten = draft;
          return draft;
        });
        const { verified, review } = verifyShallow(f, improve, true);
        const result = await verified;
        expect(
          compareLearnerPracticeTasks(visible(before), visible(rewritten.items[0]!.initial)),
        ).toBe('equal');
        const solveIndex = review.mock.calls.findIndex(
          ([prepared, round]) =>
            round > 0 &&
            prepared.input.purpose === 'practice_answerability' &&
            prepared.input.candidate.actionId === `${f.practice.items[0]!.practiceSlotId}.initial`,
        );
        expect(
          (await review.mock.results[solveIndex]!.value).result.decisions[0]!.requiresCaseInference,
        ).toBe(true);
        expect(improve).toHaveBeenCalledTimes(1);
        expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
        expect(result.candidate).toEqual(f.practice);
        expect(result.receipts).toHaveLength(1);
        expect(result.answerabilityReview.rounds).toHaveLength(1);
        expect(result.integrityReview.rounds).toHaveLength(1);
        expect(
          evaluatePlannedPracticeQuality(result.candidate, f.practiceInput, at).findings,
        ).toContainEqual(
          expect.objectContaining({
            code: 'practice_initial_recognition_at_depth',
            severity: 'warning',
          }),
        );
        expect(review).toHaveBeenCalledTimes(2 * (2 + 2 * f.practice.items.length));
      }
    },
  );

  it.each(
    ['*', '**', '_', '__', '**_', '***__', '__**', '_**'].flatMap((opening) =>
      (['NFC', 'NFD'] as const).flatMap((unicode) =>
        [false, true].flatMap((reflow) =>
          [false, true].map((reorder) => ({ opening, unicode, reflow, reorder })),
        ),
      ),
    ),
  )(
    'rejects composed presentation changes with optimistic inference: $opening/$unicode/reflow=$reflow/reorder=$reorder',
    async ({ opening, unicode, reflow, reorder }) => {
      const f = await shallowFixture();
      f.practice.items[0]!.initial.prompt += ' café 标签。';
      const closing = [...opening].reverse().join('');
      const transform = (text: string) => {
        const value = text.normalize(unicode);
        const displayed = reflow ? value.replace(/[。？]/gu, '$&\r\n\t') : value;
        return ` \t${opening}${displayed.trim()}${closing}\r\n`;
      };
      let rewritten!: typeof f.practice;
      const improve = vi.fn(async (draft: typeof f.practice) => {
        const initial = draft.items[0]!.initial;
        initial.reasoningOperation = 'diagnose_cause';
        initial.prompt = transform(initial.prompt);
        for (const option of initial.options) option.text = transform(option.text);
        if (reorder) initial.options.reverse();
        rewritten = draft;
        return draft;
      });
      const { verified, review } = verifyShallow(f, improve, true);
      const result = await verified;
      const visible = (initial: (typeof f.practice.items)[number]['initial']) =>
        projectLearnerPracticeSurface({
          prompt: initial.prompt,
          options: initial.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
        });
      expect(
        compareLearnerPracticeTasks(
          visible(f.practice.items[0]!.initial),
          visible(rewritten.items[0]!.initial),
        ),
      ).toBe('equal');
      const solveIndex = review.mock.calls.findIndex(
        ([prepared, round]) =>
          round > 0 &&
          prepared.input.purpose === 'practice_answerability' &&
          prepared.input.candidate.actionId === `${f.practice.items[0]!.practiceSlotId}.initial`,
      );
      expect(
        (await review.mock.results[solveIndex]!.value).result.decisions[0]!.requiresCaseInference,
      ).toBe(true);
      expect(improve).toHaveBeenCalledTimes(1);
      expect(result.candidate).toEqual(f.practice);
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
      expect(result.receipts).toHaveLength(1);
      expect(result.answerabilityReview.rounds).toHaveLength(1);
      expect(result.integrityReview.rounds).toHaveLength(1);
      expect(
        evaluatePlannedPracticeQuality(result.candidate, f.practiceInput, at).findings,
      ).toContainEqual(
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
      );
      expect(review).toHaveBeenCalledTimes(2 * (2 + 2 * f.practice.items.length));
    },
  );

  it.each([
    'code',
    'html',
    'block',
    'prose_punctuation',
    'original_uncertain',
    'unicode_exact',
  ] as const)(
    'rejects %s non-comparable change with optimistic inference after one attempt',
    async (formatting) => {
      const f = await shallowFixture();
      if (formatting === 'original_uncertain')
        f.practice.items[0]!.initial.prompt = `\`${shallowPrompt}\``;
      if (formatting === 'unicode_exact')
        f.practice.items[0]!.initial.prompt += ' Read "café_count".';
      const improve = vi.fn(async (draft: typeof f.practice) => {
        const initial = draft.items[0]!.initial;
        initial.reasoningOperation = 'diagnose_cause';
        if (formatting === 'code') initial.prompt = `\`${initial.prompt}\``;
        if (formatting === 'html') initial.prompt = `<strong>${initial.prompt}</strong>`;
        if (formatting === 'block') initial.prompt = `# ${initial.prompt}`;
        if (formatting === 'prose_punctuation')
          for (const option of initial.options) option.text = option.text.replace(/。$/u, '！');
        if (formatting === 'original_uncertain') deepenInitial(draft);
        if (formatting === 'unicode_exact') initial.prompt = initial.prompt.normalize('NFD');
        return draft;
      });
      const { verified, review } = verifyShallow(f, improve, true);
      const result = await verified;
      const solveIndex = review.mock.calls.findIndex(
        ([prepared, round]) =>
          round > 0 &&
          prepared.input.purpose === 'practice_answerability' &&
          prepared.input.candidate.actionId === `${f.practice.items[0]!.practiceSlotId}.initial`,
      );
      expect(
        (await review.mock.results[solveIndex]!.value).result.decisions[0]!.requiresCaseInference,
      ).toBe(true);
      expect(improve).toHaveBeenCalledTimes(1);
      expect(result.candidate).toEqual(f.practice);
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
      expect(result.receipts).toHaveLength(1);
      expect(result.answerabilityReview.rounds).toHaveLength(1);
      expect(result.integrityReview.rounds).toHaveLength(1);
      expect(f.practiceEvaluation().findings).toContainEqual(
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
      );
    },
  );

  it.each(['presentation', 'unicode_prose', 'unicode_quotation'] as const)(
    'keeps exact solve and grounding hashes distinct for canonically equal %s surfaces',
    async (mutation) => {
      const f = await shallowFixture();
      const prior = projectPracticePriorTeaching({
        objective: { title: '检索条件', whyNow: '区分类别。', objectives: [] },
        prerequisites: [],
        segments: [],
        summary: '先过滤，再排序。',
        nextConnection: null,
        sourceReferences: [],
        visualReferences: [],
      });
      const original = f.practice.items[0]!.initial;
      if (mutation !== 'presentation') {
        const phrase = mutation === 'unicode_prose' ? 'café report' : '"résumé review"';
        original.prompt += ` Read ${phrase}.`;
        for (const option of original.options) option.text += ` ${phrase}.`;
      }
      const before = projectLearnerPracticeSurface({
        prompt: original.prompt,
        options: original.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
      });
      const after =
        mutation === 'presentation'
          ? { prompt: `**${before.prompt}**`, options: [...before.options].reverse() }
          : {
              prompt: before.prompt.normalize('NFD'),
              options: before.options.map((option) => ({
                ...option,
                text: option.text.normalize('NFD'),
              })),
            };
      expect(compareLearnerPracticeTasks(before, after)).toBe('equal');
      const first = preparePracticeAnswerabilityReview(before, prior, 'PR1.initial', 'PR1');
      const second = preparePracticeAnswerabilityReview(after, prior, 'PR1.initial', 'PR1');
      expect(first.inputHash).not.toBe(second.inputHash);
      expect(second.input.candidate).toEqual({ actionId: 'PR1.initial', ...after });
      expect(
        preparePracticeAnswerabilityReview(before, prior, 'PR1.initial', 'PR1').inputHash,
      ).toBe(first.inputHash);
      const rewritten = structuredClone(f.practice);
      rewritten.items[0]!.initial.prompt = after.prompt;
      rewritten.items[0]!.initial.options = after.options.map(({ id, text }) => ({
        ...original.options.find((option) => option.optionRef === id)!,
        text,
      }));
      expect(prepareTeachingReview(f.practiceInput, f.practice).candidateHash).not.toBe(
        prepareTeachingReview(f.practiceInput, rewritten).candidateHash,
      );
    },
  );

  it.each([
    'label_only',
    'trailing_whitespace',
    'whitespace_formatting',
    'punctuation_only',
    'quotation_punctuation',
    'bracket_punctuation',
    'markdown_bold',
    'markdown_emphasis',
    'markdown_nested',
    'markdown_whitespace',
    'markdown_punctuation',
    'markdown_intra_word',
    'markdown_options',
    'markdown_option_reorder',
    'option_reorder',
    'private_only',
    'wording_but_still_recognition',
    'invalid_contrast',
    'no_case_inference',
  ] as const)('discards a %s rewrite and retains the proven shallow original', async (rewrite) => {
    const f = await shallowFixture();
    const improve = vi.fn(async (draft: typeof f.practice) => {
      const initial = draft.items[0]!.initial;
      if (['no_case_inference', 'invalid_contrast'].includes(rewrite)) deepenInitial(draft);
      else initial.reasoningOperation = 'diagnose_cause';
      if (rewrite === 'trailing_whitespace') initial.prompt = ` \t${initial.prompt}  \n`;
      if (rewrite === 'whitespace_formatting') {
        initial.prompt = initial.prompt.replace(/[。？]/gu, '$&\n\t');
        for (const option of initial.options) option.text = ` \n${option.text}\t `;
      }
      if (rewrite === 'punctuation_only') {
        initial.prompt = initial.prompt.replace(/？$/u, '?!');
        for (const option of initial.options) option.text = option.text.replace(/。$/u, '！');
      }
      if (rewrite === 'quotation_punctuation') {
        initial.prompt = initial.prompt.replace(/“/gu, '「').replace(/”/gu, '」');
        initial.evidenceContrast!.evidence = initial
          .evidenceContrast!.evidence.replace(/“/gu, '「')
          .replace(/”/gu, '」');
      }
      if (rewrite === 'bracket_punctuation') {
        initial.prompt = `【${initial.prompt}】`;
        for (const option of initial.options) option.text = `(${option.text})`;
      }
      if (rewrite === 'markdown_bold') initial.prompt = `**${initial.prompt}**`;
      if (rewrite === 'markdown_emphasis') initial.prompt = `_${initial.prompt}_`;
      if (rewrite === 'markdown_nested') initial.prompt = `***__${initial.prompt}__***`;
      if (rewrite === 'markdown_whitespace')
        initial.prompt = ` \n**${initial.prompt.replace(/[。？]/gu, '$&\n\t')}** \t`;
      if (rewrite === 'markdown_punctuation') {
        initial.prompt = `**【${initial.prompt.replace(/？$/u, '?!')}】**`;
        for (const option of initial.options) option.text = `_(${option.text})_`;
      }
      if (rewrite === 'markdown_intra_word') {
        initial.prompt = initial.prompt.replace(/结果排序/gu, '结果*排序*');
        initial.evidenceContrast!.evidence = initial.evidenceContrast!.evidence.replace(
          /结果排序/gu,
          '结果*排序*',
        );
      }
      if (rewrite === 'markdown_options' || rewrite === 'markdown_option_reorder') {
        for (const [index, option] of initial.options.entries())
          option.text = index % 2 === 0 ? `**${option.text}**` : `_${option.text}_`;
        if (rewrite === 'markdown_option_reorder') initial.options.reverse();
      }
      if (rewrite === 'option_reorder') initial.options.reverse();
      if (rewrite === 'private_only') {
        initial.requiredInference += ' 作者希望学习者进行诊断。';
        initial.decisiveCondition += ' 作者私有判断。';
        initial.hint += ' 私有提示改写。';
        initial.explanation += ' 私有解释改写。';
        for (const option of initial.options) option.feedbackIfSelected += ' 私有反馈改写。';
      }
      if (rewrite === 'wording_but_still_recognition')
        initial.prompt = `${shallowPrompt} 请检查分类。`;
      if (rewrite === 'invalid_contrast') initial.evidenceContrast!.alternativeOptionId = 'A';
      return draft;
    });
    // Cosmetic rewrites deliberately receive an optimistic true: A alone must
    // reject them. A substantive but direct-recognition rewrite fails B instead.
    const { verified, review } = verifyShallow(
      f,
      improve,
      !['no_case_inference', 'wording_but_still_recognition'].includes(rewrite),
    );
    const result = await verified;
    if (rewrite.startsWith('markdown')) {
      const rewrittenSolve = review.mock.calls.find(
        ([prepared, round]) =>
          round > 0 &&
          prepared.input.purpose === 'practice_answerability' &&
          prepared.input.candidate.actionId === `${f.practice.items[0]!.practiceSlotId}.initial`,
      )!;
      const solveIndex = review.mock.calls.indexOf(rewrittenSolve);
      const solved = await review.mock.results[solveIndex]!.value;
      expect(solved.result.decisions[0]!.requiresCaseInference).toBe(true);
    }
    expect(improve).toHaveBeenCalledTimes(1);
    expect(result.candidate).toEqual(f.practice);
    expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
    expect(result.receipts).toHaveLength(1);
    expect(result.answerabilityReview.rounds).toHaveLength(1);
    expect(result.integrityReview.rounds).toHaveLength(1);
    expect(result.qualityImprovement.findingsBefore).toContainEqual(
      expect.objectContaining({ code: 'practice_initial_recognition_at_depth' }),
    );
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'practice_initial_recognition_at_depth',
        severity: 'warning',
      }),
    );
    expect(review).toHaveBeenCalledTimes(2 * (2 + 2 * f.practice.items.length));
  });

  it('accepts genuine independently solved improvement without private contrast', async () => {
    const f = await shallowFixture();
    const improve = vi.fn(async (draft: typeof f.practice) => {
      deepenInitial(draft);
      delete draft.items[0]!.initial.evidenceContrast;
      return draft;
    });
    const result = await verifyShallow(f, improve).verified;
    expect(improve).toHaveBeenCalledTimes(1);
    expect(result.candidate.items[0]!.initial.prompt).toBe(reasoningPrompt);
    expect(result.candidate.items[0]!.initial.evidenceContrast).toBeUndefined();
    expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'improved' });
    expect(result.receipts).toHaveLength(2);
    expect(result.answerabilityReview.rounds).toHaveLength(2);
    expect(result.integrityReview.rounds).toHaveLength(2);
    expect(result.receipts[1]!.candidateHash).not.toBe(result.receipts[0]!.candidateHash);
  });

  it.each(['wrong_key', 'source_authority', 'grounding'] as const)(
    'discards genuine inference improvement with a %s hard defect',
    async (defect) => {
      const f = await shallowFixture();
      const improve = vi.fn(async (draft: typeof f.practice) => {
        deepenInitial(draft);
        if (defect === 'wrong_key') {
          draft.items[0]!.initial.correctOptionRef = 'B';
          draft.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
        }
        if (defect === 'source_authority') draft.items[0]!.sourceRefs = ['S99'];
        return draft;
      });
      const result = await verifyShallow(f, improve, true, defect === 'grounding').verified;
      expect(improve).toHaveBeenCalledTimes(1);
      expect(result.candidate).toEqual(f.practice);
      expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
      expect(result.receipts).toHaveLength(1);
      expect(result.answerabilityReview.rounds).toHaveLength(1);
      expect(result.integrityReview.rounds).toHaveLength(1);
      expect(f.practiceEvaluation().findings).toContainEqual(
        expect.objectContaining({
          code: 'practice_initial_recognition_at_depth',
          severity: 'warning',
        }),
      );
    },
  );

  it.each([
    'invalid',
    'ineffective',
    'markdown_only',
    'uncertain',
    'unicode_only',
    'unicode_exact',
  ] as const)(
    'refuses %s shallow quality fallback when the original source fence changes',
    async (rewrite) => {
      const f = await shallowFixture();
      if (rewrite.startsWith('unicode'))
        f.practice.items[0]!.initial.prompt +=
          rewrite === 'unicode_only' ? ' Read "café report".' : ' Read "café_count".';
      const improve = vi.fn(async (draft: typeof f.practice) => {
        f.practiceInput.sourceContext.offers[0]!.text += ' Changed after proof.';
        if (rewrite === 'invalid') draft.items[0]!.initial.correctOptionRef = 'B';
        if (rewrite === 'markdown_only') {
          draft.items[0]!.initial.reasoningOperation = 'diagnose_cause';
          draft.items[0]!.initial.prompt = `**${draft.items[0]!.initial.prompt}**`;
        }
        if (rewrite === 'uncertain') {
          draft.items[0]!.initial.reasoningOperation = 'diagnose_cause';
          draft.items[0]!.initial.prompt = `\`${draft.items[0]!.initial.prompt}\``;
        }
        if (rewrite.startsWith('unicode')) {
          draft.items[0]!.initial.reasoningOperation = 'diagnose_cause';
          draft.items[0]!.initial.prompt = draft.items[0]!.initial.prompt.normalize('NFD');
        }
        return draft;
      });
      await expect(verifyShallow(f, improve).verified).rejects.toMatchObject({
        details: {
          candidateFailure: {
            kind: 'practice_quality_fallback_rejection',
            diagnostics: [expect.objectContaining({ code: 'practice_original_proof_stale' })],
          },
        },
      });
      expect(improve).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves focused aggregate quality diagnostics without rejecting valid Practice', async () => {
    const f = await fixture();
    f.interaction.transfer.reasoningOperation = 'locate_boundary';
    for (const slot of f.lesson.slots)
      if (slot.informalCheck) slot.informalCheck.reasoningOperation = 'predict_outcome';
    expect(f.lessonEvaluation().status).toBe('pass');
    expect(f.lessonEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'focused_unit_angle_coverage_insufficient',
        severity: 'warning',
      }),
    );
    for (const item of f.practice.items) {
      item.initial.reasoningOperation = 'locate_boundary';
      item.retry.reasoningOperation = 'predict_outcome';
    }
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'focused_unit_angle_coverage_insufficient',
        severity: 'warning',
        itemIndexes: [0, 1],
      }),
    );
    expect(f.practiceEvaluation().status).toBe('pass');
    expect(f.practiceEvaluation().acceptancePolicyVersion).toBe(PRACTICE_ACCEPTANCE_POLICY_VERSION);
    expect(validatePracticeContentCandidate(f.practice, f.practiceInput).valid).toBe(true);
    expect(() => assertCurrentCognitiveContract(f.practiceEvaluation())).not.toThrow();
    f.practice.items[0]!.initial.reasoningOperation = 'identify_missing';
    f.practice.items[1]!.initial.reasoningOperation = 'judge_tradeoff';
    expect(f.practiceEvaluation().status).toBe('pass');
  });

  it('keeps high-performance and deep-transfer aggregate targets advisory per objective', async () => {
    const f = await fixture();
    f.practiceInput.courseDesign = { desiredDepth: 'deep_transfer', unitFocus: 'normal' };
    f.interaction.transfer.reasoningOperation = 'locate_boundary';
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({
        code: 'reasoning_demand_below_depth',
        objectiveRefs: ['O1'],
        itemIndexes: [0],
        severity: 'warning',
      }),
    );
    expect(f.practiceEvaluation().status).toBe('pass');
    expect(validatePracticeContentCandidate(f.practice, f.practiceInput).valid).toBe(true);
    expect(() => assertCurrentCognitiveContract(f.practiceEvaluation())).not.toThrow();
    f.practiceInput.courseDesign.desiredDepth = 'high_performance';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'reasoning_demand_below_depth'),
    ).toBe(false);
  });

  it('makes Lesson reasoning demand advisory without relaxing unrelated Practice errors', async () => {
    const f = await fixture();
    f.interaction.activity.reasoningOperation = 'recognize';
    const lessonEvaluation = f.lessonEvaluation();
    expect(lessonEvaluation.findings).toContainEqual(
      expect.objectContaining({ code: 'reasoning_demand_below_depth', severity: 'warning' }),
    );
    expect(validateLessonSlotContentCandidate(f.lesson, f.lessonInput).valid).toBe(true);
    expect(() => assertCurrentCognitiveContract(lessonEvaluation)).not.toThrow();
    for (const code of ['missing_reasoning_declaration', 'practice_initial_recognition_at_depth']) {
      const practice = f.practiceEvaluation();
      practice.findings.push({
        code,
        severity: 'error',
        criterion: 'meaningful_action',
        message: 'An unchanged hard cognitive contract.',
        itemIndexes: [0],
        objectiveRefs: ['O1'],
      });
      expect(applyPracticeAggregateAcceptancePolicy(practice).status).toBe('fail');
      expect(() => assertCurrentCognitiveContract(practice)).toThrow();
    }
  });

  it.each([1, 2])(
    'keeps quality fallback within the review ceiling after %i hard corrections',
    async (hardCorrections) => {
      const f = await fixture('deep_transfer');
      f.interaction.transfer.reasoningOperation = 'locate_boundary';
      const provider = new FakeProvider();
      const improve = vi.fn(async (draft: typeof f.practice) => {
        draft.items[0]!.initial.correctOptionRef = 'B';
        draft.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
        return draft;
      });
      let corrections = 0;
      const verified = await verifyPreparedPractice(
        f.practiceInput,
        f.practice,
        projectPracticePriorTeaching({
          objective: {
            title: 'Bounded conditions',
            whyNow: 'Use the public case rule.',
            objectives: [],
          },
          prerequisites: [],
          segments: [],
          summary: 'Check the changed state.',
          nextConnection: null,
          sourceReferences: [],
          visualReferences: [],
        }),
        async (prepared, round) => {
          const result = await provider.reviewTeachingContent(prepared.input);
          if (prepared.input.purpose === 'practice_grounding' && round < hardCorrections)
            result.findings.push({
              itemId: f.practice.items[0]!.practiceSlotId,
              code: round === 0 ? 'accuracy' : 'grounding',
              problem: `Concrete review defect ${round}.`,
              responsibility: 'grounding',
              repairInstruction: 'Correct the named draft.',
            });
          return {
            result,
            logicalCallId: `review-${round}:${prepared.input.actionIds[0] ?? 'grounding'}`,
          };
        },
        async (draft) => {
          const revised = structuredClone(draft);
          revised.items[0]!.pedagogicalReason += ` 独立修订${++corrections}。`;
          return revised;
        },
        improve,
      );
      expect(corrections).toBe(hardCorrections);
      expect(improve).toHaveBeenCalledTimes(hardCorrections === 1 ? 1 : 0);
      expect(verified.receipts).toHaveLength(hardCorrections + 1);
      expect(verified.answerabilityReview.rounds).toHaveLength(hardCorrections + 1);
      expect(verified.qualityImprovement).toMatchObject({
        attempts: hardCorrections === 1 ? 1 : 0,
        outcome: hardCorrections === 1 ? 'rejected' : 'review_budget_exhausted',
      });
      expect(verified.qualityImprovement.findingsBefore.length).toBeGreaterThan(0);
      expect(f.practiceEvaluation().status).toBe('pass');
    },
  );

  it.each(['sources', 'prior_teaching', 'computed_original'] as const)(
    'binds quality fallback to the original proof identity (%s)',
    async (change) => {
      const f = await fixture('deep_transfer');
      f.interaction.transfer.reasoningOperation = 'locate_boundary';
      if (change === 'computed_original') f.practiceInput.computedCases = true;
      const provider = new FakeProvider();
      const priorTeaching = projectPracticePriorTeaching({
        objective: {
          title: 'Bounded conditions',
          whyNow: 'Use the public case rule.',
          objectives: [],
        },
        prerequisites: [],
        segments: [],
        summary: 'Check the changed state.',
        nextConnection: null,
        sourceReferences: [],
        visualReferences: [],
      });
      const originalHash = prepareTeachingReview(f.practiceInput, f.practice).candidateHash;
      const improve = vi.fn(async (draft: typeof f.practice) => {
        if (change === 'sources')
          f.practiceInput.sourceContext.offers[0]!.text += ' Changed source.';
        if (change === 'prior_teaching') priorTeaching.summary += ' Changed prior teaching.';
        f.practiceInput.computedCases = false;
        draft.items[0]!.initial.correctOptionRef = 'B';
        draft.items[0]!.initial.evidenceContrast!.alternativeOptionId = 'C';
        return draft;
      });
      const review = vi.fn(
        async (prepared: { input: TeachingContentReviewInput }, round: number) => ({
          result: await provider.reviewTeachingContent(prepared.input),
          logicalCallId: `review-${round}:${prepared.input.actionIds[0] ?? 'grounding'}`,
        }),
      );
      const verified = verifyPreparedPractice(
        f.practiceInput,
        f.practice,
        priorTeaching,
        review,
        async () => {
          throw new Error('Quality failure must not start a hard or quality retry.');
        },
        improve,
      );
      if (change === 'computed_original') {
        const result = await verified;
        expect(f.practiceInput.computedCases).toBe(true);
        expect(result.candidate).toEqual(f.practice);
        expect(result.qualityImprovement).toMatchObject({ attempts: 1, outcome: 'rejected' });
        expect(result.receipts.map((receipt) => receipt.candidateHash)).toEqual([originalHash]);
        expect(result.answerabilityReview.rounds.map((round) => round.candidateHash)).toEqual([
          originalHash,
        ]);
      } else {
        await expect(verified).rejects.toMatchObject({
          details: {
            candidateFailure: {
              kind: 'practice_quality_fallback_rejection',
              diagnostics: [expect.objectContaining({ code: 'practice_original_proof_stale' })],
            },
          },
        });
      }
      expect(improve).toHaveBeenCalledTimes(1);
      expect(review.mock.calls.length).toBeLessThanOrEqual(2 * (2 + 2 * f.practice.items.length));
    },
  );

  it('keeps ambiguous transfer and discourse signals visible without consuming a repair', async () => {
    const f = await fixture();
    f.interaction.transfer.requiredInference = f.interaction.activity.requiredInference;
    f.lesson.narrative!.summary = '今天讨论了完全无关的光合作用。';
    f.worked.explanation += ' 根据材料，这些信息需要检查。';
    const evaluation = f.lessonEvaluation();
    expect(evaluation.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'transfer_inference_not_changed',
        'lesson_attribution_voice',
        'lesson_summary_callback_unanchored',
      ]),
    );
    expect(() => assertCurrentCognitiveContract(evaluation)).not.toThrow();
  });

  it('omits null declarations without inventing them and excludes assistance from structured exposure', async () => {
    const f = await fixture();
    const candidate = structuredClone(f.lesson);
    Object.assign(
      candidate.slots.find((slot) => slot.workedProcess)!.workedProcess!.interaction!.scaffold,
      { reasoningOperation: null, requiredInference: null, decisiveCondition: null },
    );
    const normalized = normalizeLessonPreparationCandidate(candidate).candidate;
    expect(LessonSlotContentProposalPayloadSchema.safeParse(normalized).success).toBe(true);
    expect(validateLessonSlotContentCandidate(normalized, f.lessonInput).valid).toBe(true);
    expect(
      lessonReasoningExposure(f.lesson.slots, f.lessonInput.skeleton)
        .flatMap((entry) => entry.actions)
        .some((action) => action.surface === 'scaffold'),
    ).toBe(false);
    expect(
      practiceContentMessages(f.practiceInput)
        .map((message) => message.content)
        .join('\n'),
    ).toContain('lessonReasoningExposure');
    const prompt = lessonSlotContentMessages(f.lessonInput)
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain('assertion authority');
    expect(prompt).toContain('reveal all decisive premises, rules and concrete state');
  });

  it.each(['missing_options', 'hidden_key'] as const)(
    'repairs %s on the existing bounded draft/editor path while freezing valid peers',
    async (defect) => {
      const f = await fixture();
      const slot = f.lesson.slots.find((slot) => slot.informalCheck)!;
      const first = structuredClone(f.lesson);
      const check = first.slots.find((entry) => entry.slotId === slot.slotId)!.informalCheck!;
      if (defect === 'missing_options') {
        delete check.options;
        delete check.correctOptionId;
      } else check.kind = 'predict_next';
      for (const draftForReview of [undefined, f.lesson]) {
        const requests: string[] = [];
        const provider = new Hy3Provider({
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture',
          model: 'fixture',
          timeoutMs: 30000,
          fetchImpl: (async (_url, init) => {
            requests.push(String(init?.body));
            const value = requests.length === 1 ? first : { slots: [slot] };
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
              }),
              { status: 200 },
            );
          }) as typeof fetch,
        });
        const accepted = await provider.generateLessonSlotContent(
          { ...f.lessonInput, draftForReview },
          {
            validateCandidate: (candidate) =>
              validateLessonSlotContentCandidate(candidate, f.lessonInput),
          },
        );
        expect(requests).toHaveLength(2);
        expect(accepted).toEqual(f.lesson);
        expect(requests[1]).toContain('lesson_choice_');
      }
    },
  );

  it('exhausts the existing two candidate attempts on an unrepaired hidden choice', async () => {
    const f = await fixture();
    f.lesson.slots.find((slot) => slot.informalCheck)!.informalCheck!.kind = 'own_words';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(f.lesson) }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        ),
    );
    const provider = new Hy3Provider({
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture',
      model: 'fixture',
      timeoutMs: 30000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      provider.generateLessonSlotContent(f.lessonInput, {
        validateCandidate: (candidate) =>
          validateLessonSlotContentCandidate(candidate, f.lessonInput),
      }),
    ).rejects.toMatchObject({
      details: {
        candidateFailure: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'lesson_choice_check_not_renderable' }),
          ]),
        }),
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not spend deterministic transport repairs on private inference equality', async () => {
    const f = await fixture();
    const first = structuredClone(f.lesson);
    first.narrative!.whyNow = f.interaction.activity.requiredInference!;
    const requests: string[] = [];
    const provider = new Hy3Provider({
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture',
      model: 'fixture',
      timeoutMs: 30000,
      fetchImpl: (async (_url, init) => {
        requests.push(String(init?.body));
        const value =
          requests.length === 1 ? first : { narrative: f.lesson.narrative, slots: [f.worked] };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const accepted = await provider.generateLessonSlotContent(f.lessonInput, {
      validateCandidate: (candidate) =>
        validateLessonSlotContentCandidate(candidate, f.lessonInput),
    });
    expect(requests).toHaveLength(1);
    expect(accepted).toEqual(first);
    // Generation alone is untrusted: the current public/grounding reviews
    // still determine whether this is an actual early disclosure.
  });
});
