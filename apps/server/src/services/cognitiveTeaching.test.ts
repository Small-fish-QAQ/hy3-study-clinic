import { describe, expect, it } from 'vitest';
import {
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  projectAcceptedLessonSegments,
  type DesiredDepth,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import { lessonSlotContentMessages, practiceContentMessages } from '../llm/prompts.js';
import { normalizeLessonPreparationCandidate } from '../llm/preparationRecovery.js';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
} from '../llm/provider.js';
import {
  assertCurrentCognitiveContract,
  evaluateLessonSlotPedagogy,
  evaluatePlannedPracticeQuality,
  lessonReasoningExposure,
} from './lessonPedagogyEvaluator.js';
import { validateLessonSlotContentCandidate } from './teachingBriefContract.js';
import { planTeachingSkeleton } from './teachingSkeletonPlanner.js';

const at = { evaluatedAt: '2026-09-05T00:00:00.000Z' };

async function fixture(depth: DesiredDepth = 'working_fluency') {
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
      construct: 'identify' as const,
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

describe('calibrated cognitive teaching contract', () => {
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

  it('keeps historical parsing and private projection round trips without granting current acceptance', async () => {
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
      expect.objectContaining({ code: 'missing_reasoning_declaration', severity: 'error' }),
    );
    expect(() => assertCurrentCognitiveContract(evaluation)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          candidateFailure: expect.objectContaining({ kind: 'cognitive_teaching_rejection' }),
        }),
      }),
    );
    const practice = structuredClone(f.practice);
    delete practice.items[0]!.initial.requiredInference;
    expect(PracticeContentProposalPayloadSchema.safeParse(practice).success).toBe(true);
    expect(evaluatePlannedPracticeQuality(practice, f.practiceInput, at).status).toBe('fail');
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
    'rejects a substantial exact Chinese conclusion on the %s surface, with a removal control',
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
      expect(f.lessonEvaluation().findings).toContainEqual(
        expect.objectContaining({
          code:
            surface === 'hint'
              ? 'worked_interaction_hint_reveals_answer'
              : surface === 'inline'
                ? 'informal_check_answer_pre_revealed'
                : 'worked_interaction_answer_pre_revealed',
          severity: 'error',
        }),
      );
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
    ).toEqual([expect.objectContaining({ severity: 'warning' })]);
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

  it('rejects noun-swapped replay but permits a reused operation with changed decisive quantities and inference', async () => {
    const f = await fixture();
    const initial = f.practice.items[0]!.initial;
    initial.reasoningOperation = f.interaction.activity.reasoningOperation;
    initial.decisiveCondition = f.interaction.activity.decisiveCondition;
    initial.requiredInference = f.interaction.activity.requiredInference;
    initial.prompt = '把任务甲乙换成服装商品后，哪项结果会出现？';
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({ code: 'practice_semantic_replay', severity: 'error' }),
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

  it('rejects unchanged retry and recognition at depth without penalizing reasoning vocabulary as assertion promotion', async () => {
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

  it('defers focused coverage to Practice and names repairable Practice indexes on final insufficiency', async () => {
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
        severity: 'error',
        itemIndexes: [0, 1],
      }),
    );
    f.practice.items[0]!.initial.reasoningOperation = 'identify_missing';
    f.practice.items[1]!.initial.reasoningOperation = 'judge_tradeoff';
    expect(f.practiceEvaluation().status).toBe('pass');
  });

  it('requires high-performance diagnosis and deep-transfer design per objective', async () => {
    const f = await fixture();
    f.practiceInput.courseDesign = { desiredDepth: 'deep_transfer', unitFocus: 'normal' };
    f.interaction.transfer.reasoningOperation = 'locate_boundary';
    expect(f.practiceEvaluation().findings).toContainEqual(
      expect.objectContaining({ code: 'reasoning_demand_below_depth', objectiveRefs: ['O1'] }),
    );
    f.practiceInput.courseDesign.desiredDepth = 'high_performance';
    expect(
      f
        .practiceEvaluation()
        .findings.some((finding) => finding.code === 'reasoning_demand_below_depth'),
    ).toBe(false);
  });

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
    expect(validateLessonSlotContentCandidate(normalized, f.lessonInput).valid).toBe(false);
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
    expect(prompt).toContain('must consume the modelled resultingState');
  });

  it('repairs an opening leak in one real transport simulation while freezing valid peers', async () => {
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
    expect(requests).toHaveLength(2);
    expect(accepted).toEqual(f.lesson);
    expect(requests[1]).toContain('corrected narrative');
  });
});
