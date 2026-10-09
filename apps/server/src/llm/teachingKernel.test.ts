import { describe, it, expect } from 'vitest';
import {
  TeachingKernelSchema,
  validateKernel,
  evaluateKernel,
  kernelOutcomes,
  diagnosisSignatures,
  interventionWinner,
  buildTeachingCases,
  type TeachingKernel,
} from './teachingKernel.js';
import {
  TeachingCapsulePayloadSchema,
  projectAcceptedLessonSegments,
  projectPracticePriorTeaching,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';
import { compileTeachingKernel } from '../services/compileTeachingKernel.js';
import { validateTeachingCapsule } from './teachingCapsule.js';
import { deriveTeachingKernel } from './teachingBlueprint.js';
import { verifyPreparedPractice } from '../services/teachingContentReview.js';
import {
  thresholdBlueprint,
  verificationKernel,
  kernelCapsuleInput,
  valueDisplayBlueprint,
  transferReplayBlueprint,
  noDistinctRetryBlueprint,
} from '../testing/teachingKernelFixture.js';

export function kernelFixture(): TeachingKernel {
  const base = { role: ['read'], second: ['write'], read: 'read', write: 'write' };
  return TeachingKernelSchema.parse({
    explanation:
      '角色把权限集合提供给用户；多个角色可以共同提供权限。变更一个角色时，要重新计算所有来源的并集，再判断具体操作是否仍被授权。这个模型假定变更立即生效，不考虑缓存或额外拒绝策略。',
    whyUseful: '撤销一个角色后是否还可以写入，取决于哪些权限来源仍然存在。',
    boundary:
      '当前模型假定权限按并集合并且立即生效；如果会话另有权限上限，还需要在并集之后应用该限制。',
    inputs: [
      { key: 'role', label: '角色甲权限' },
      { key: 'second', label: '角色乙权限' },
      { key: 'read', label: '读取操作' },
      { key: 'write', label: '写入操作' },
    ],
    rules: [
      { key: 'combined', label: '合并权限', op: 'union', args: ['role', 'second'] },
      { key: 'can_read', label: '允许读取', op: 'includes', args: ['combined', 'read'] },
      { key: 'can_write', label: '允许写入', op: 'includes', args: ['combined', 'write'] },
    ],
    goals: ['can_read', 'can_write'],
    guided: {
      context: '两个角色共同向同一用户提供权限；管理员准备修改角色乙。',
      base,
      changes: { second: [] },
    },
    transfer: {
      context: '现在用户还受到独立的会话权限上限约束，所有方案只修改所列输入。',
      base: { ...base, ceiling: ['read'] },
      extraInputs: [{ key: 'ceiling', label: '会话权限上限' }],
      extraRules: [
        {
          key: 'bounded',
          label: '会话有效权限',
          op: 'intersection',
          args: ['combined', 'ceiling'],
        },
        { key: 'session_read', label: '会话允许读取', op: 'includes', args: ['bounded', 'read'] },
        { key: 'session_write', label: '会话允许写入', op: 'includes', args: ['bounded', 'write'] },
      ],
      goals: ['session_read', 'session_write'],
      boundaryRule: '实际操作权限是角色权限并集与会话上限的交集。',
      choices: [
        { label: '保留当前配置', changes: {} },
        { label: '上限改为仅允许写入', changes: { ceiling: ['write'] } },
        { label: '上限同时允许读写', changes: { ceiling: ['read', 'write'] } },
      ],
      desired: [true, true],
    },
    diagnosis: {
      context: '配置记录缺失，运维人员提出三个候选角色配置，并进行两次独立实验。',
      base,
      hypotheses: [
        { label: '角色甲仅有读取', changes: { role: ['read'] } },
        { label: '角色甲仅有写入', changes: { role: ['write'] } },
        { label: '角色甲同时有读写', changes: { role: ['read', 'write'] } },
      ],
      actual: 2,
      probes: [
        { label: '角色乙只提供读取', changes: { second: ['read'] } },
        { label: '角色乙只提供写入', changes: { second: ['write'] } },
      ],
    },
    retry: {
      context: '维护窗口要求允许读取同时禁止写入；只实施一个列出的方案。',
      base: { ...base, role: ['read', 'write'], second: ['read'] },
      choices: [
        { label: '角色甲只保留读取', changes: { role: ['read'] } },
        { label: '两个角色都仅提供写入', changes: { role: ['write'], second: ['write'] } },
        { label: '保留两个角色', changes: {} },
      ],
      desired: [true, false],
    },
  });
}
describe('executable teaching cases', () => {
  it.each(['number_string', 'singleton_empty'] as const)(
    'keeps Astra %s scaffold answers distinct in the compiled public capsule',
    (kind) => {
      const k = deriveTeachingKernel(valueDisplayBlueprint(kind));
      expect(validateKernel(k).valid).toBe(true);
      const capsule = TeachingCapsulePayloadSchema.parse(
        compileTeachingKernel(k, kernelCapsuleInput()),
      );
      expect(validateTeachingCapsule(capsule, kernelCapsuleInput()).valid).toBe(true);
      const process = capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!;
      const choices = process.interaction!.scaffold.options.map(({ text }) =>
        text.normalize('NFC').replace(/\s+/gu, ' ').trim(),
      );
      expect(choices).toHaveLength(2);
      expect(new Set(choices).size).toBe(2);
      expect(choices).toEqual(
        kind === 'number_string'
          ? ['本步结果：1', '本步结果："1"']
          : ['本步结果：{"空集"}', '本步结果：{}'],
      );
      expect(process.interaction!.scaffold.correctOptionId).toBe('A');
      expect(process.steps[0]!.resultingState).toContain(
        kind === 'number_string' ? '数值常量=1；文字常量="1"' : '单成员集合={"空集"}；空集合={}',
      );
      expect(process.steps[1]!.resultingState).toContain(
        kind === 'number_string' ? '选取值=1' : '选取值={"空集"}',
      );
      expect(process.interaction!.scaffold.options[1]!.feedbackIfSelected).toContain(
        choices[0]!.slice('本步结果：'.length),
      );
    },
  );
  it.each(['number_string', 'singleton_empty'] as const)(
    'preserves truthful Astra %s no-op guidance with one displayed scaffold answer',
    (kind) => {
      const k = deriveTeachingKernel(valueDisplayBlueprint(kind));
      k.guided.base = { ...k.guided.base, ...k.guided.changes };
      k.guided.changes = {};
      const capsule = TeachingCapsulePayloadSchema.parse(
        compileTeachingKernel(k, kernelCapsuleInput()),
      );
      const interaction = capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!
        .interaction!;
      expect(new Set(interaction.scaffold.options.map(({ text }) => text)).size).toBe(2);
      expect(interaction.activity.evidenceContrast).toBeUndefined();
      expect(interaction.activity.options[0]!.misconception).toBeNull();
      expect(interaction.activity.options[1]!.feedbackIfSelected).not.toContain('沿用了变更前');
    },
  );
  it('keeps a singleton containing an element delimiter distinct from two separate set members', () => {
    const b = valueDisplayBlueprint('singleton_empty');
    b.inputs[1]!.values = [['甲、乙']];
    b.inputs[2]!.values = [['甲', '乙']];
    const capsule = compileTeachingKernel(deriveTeachingKernel(b), kernelCapsuleInput());
    expect(
      capsule.lesson.slots
        .find((s) => s.workedProcess)!
        .workedProcess!.interaction!.scaffold.options.map(({ text }) => text),
    ).toEqual(['本步结果：{"甲、乙"}', '本步结果：{"甲", "乙"}']);
  });
  it.each(['Unicode normalization', 'collapsed whitespace'] as const)(
    'retains material failure if distinct values collide after %s on the public scaffold',
    (kind) => {
      const b = valueDisplayBlueprint('number_string');
      b.inputs[1]!.values = [kind === 'Unicode normalization' ? 'é' : 'a  b'];
      b.inputs[2]!.values = [kind === 'Unicode normalization' ? 'e\u0301' : 'a b'];
      const k = deriveTeachingKernel(b);
      expect(validateKernel(k).valid).toBe(true);
      expect(() => compileTeachingKernel(k, kernelCapsuleInput())).toThrow(
        'visibly distinct scaffold',
      );
    },
  );
  it('constructs a genuinely different same-base retry for the Astra fixed-target mechanism', () => {
    const k = deriveTeachingKernel(transferReplayBlueprint());
    expect(validateKernel(k).valid).toBe(true);
    expect(k.retry.base).toEqual(k.transfer.base);
    const publicConfigurations = (scene: typeof k.retry) =>
      scene.choices
        .map(({ changes }) => ({ ...scene.base, ...changes }))
        .map(({ a, b }) => JSON.stringify([a, b]))
        .sort();
    expect(k.retry.desired).toEqual(k.transfer.desired);
    expect(publicConfigurations(k.retry)).not.toEqual(publicConfigurations(k.transfer));
    for (const scene of [k.transfer, k.retry]) {
      const results = scene.choices.map(({ changes }) => {
        const state = { ...scene.base, ...changes };
        return [Boolean(state.a && state.b), !state.constant];
      });
      expect(
        results.filter((r) => JSON.stringify(r) === JSON.stringify(scene.desired)),
      ).toHaveLength(1);
    }
    const capsule = compileTeachingKernel(k, kernelCapsuleInput());
    const transfer = capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!.interaction!
      .transfer;
    expect(capsule.practice.items[0]!.retry.options.map(({ text }) => text).sort()).not.toEqual(
      transfer.options.map(({ text }) => text).sort(),
    );
  });
  it('fails honestly when the finite decision configurations cannot supply a non-replaying retry', () => {
    expect(() => deriveTeachingKernel(noDistinctRetryBlueprint())).toThrow('distinct retry');
  });
  it('compiles verification into three distinct judgments with truthful keys, feedback and probe guidance', () => {
    const input = kernelCapsuleInput();
    const capsule = compileTeachingKernel(verificationKernel(), input);
    expect(validateTeachingCapsule(capsule, input).valid).toBe(true);
    const process = capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!;
    const guided = process.interaction!.activity;
    // Independently: 1 >= 1 and !false are true, before and after a no-op.
    expect(guided.options).toHaveLength(3);
    expect(new Set(guided.options.map((o) => o.text)).size).toBe(3);
    expect(guided.options.filter((o) => o.text === '允许读取：是；尚未启用：是')).toHaveLength(1);
    expect(guided.correctOptionId).toBe('A');
    expect(guided.options[0]!.misconception).toBeNull();
    expect(guided.evidenceContrast).toBeUndefined();
    expect(process.steps[0]!.resultingState).toContain('无，保持初始输入');
    expect(process.steps[1]!.resultingState).toBe('允许读取=是 → 尚未启用=是');
    expect(process.result).toBe('允许读取：是；尚未启用：是');
    const item = capsule.practice.items[0]!;
    expect(item.initial.correctOptionRef).toBe('A');
    expect(item.retry.correctOptionRef).toBe('C');
    expect(item.initial.explanation).toContain('单独已能确定');
    expect(item.initial.hint).not.toContain('能解释一次并不足够');
    expect(process.whyResultFollows).toContain('结合其实际依赖核对');
    expect(process.interaction!.transfer.debrief).toContain('只有保留当前配置符合全部目标');
    expect(process.interaction!.scaffold.options[0]!.text).toBe('本步结果：是');
    expect(process.interaction!.scaffold.options[1]!.text).toBe('本步结果：否');
  });
  it('omits an intervention counterfactual whose changed target would have two correct alternatives', () => {
    const k = verificationKernel();
    k.retry.choices[1]!.changes = { x: 0, active: false };
    k.retry.choices[2]!.changes = { x: 0, active: true };
    k.retry.desired = [true, true];
    // Use a coupled pair of goals: both losing configurations now yield false,false.
    k.rules[1] = { key: 'also_read', label: '另一许可判断', op: 'and', args: ['read_ok'] };
    k.goals = ['read_ok', 'also_read'];
    k.transfer.goals = k.goals;
    k.transfer.choices = structuredClone(k.retry.choices);
    k.diagnosis.hypotheses = [
      { label: '值为零阈值为一', changes: { x: 0 } },
      { label: '值为一阈值为一', changes: {} },
      { label: '值为二阈值为一', changes: { x: 2 } },
    ];
    k.diagnosis.probes = [
      { label: '阈值设为一', changes: { threshold: 1 } },
      { label: '阈值设为二', changes: { threshold: 2 } },
    ];
    const capsule = compileTeachingKernel(k, kernelCapsuleInput());
    expect(capsule.practice.items[0]!.retry.evidenceContrast).toBeUndefined();
    expect(
      capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!.interaction!.transfer
        .evidenceContrast,
    ).toBeUndefined();
    expect(capsule.practice.items[0]!.retry.options[1]!.feedbackIfSelected).toContain(
      '允许读取：否；另一许可判断：否',
    );
    expect(capsule.practice.items[0]!.retry.options[2]!.feedbackIfSelected).toContain(
      '允许读取：否；另一许可判断：否',
    );
  });
  it.each(['cycle', 'ambiguous'] as const)('refuses to compile %s executable content', (defect) => {
    const k = verificationKernel();
    if (defect === 'cycle') k.rules[0]!.args[0] = 'read_ok';
    else k.diagnosis.hypotheses[1] = structuredClone(k.diagnosis.hypotheses[0]!);
    expect(() => compileTeachingKernel(k, kernelCapsuleInput())).toThrow();
  });
  it('derives three distinct configurations with two reachable outcomes and one target winner', () => {
    const b = thresholdBlueprint();
    // Independently specified truth table for the shared threshold rule.
    for (const [x, threshold, expected] of [
      [0, 1, false],
      [1, 1, true],
      [1, 2, false],
      [2, 2, true],
    ] as const)
      expect(kernelOutcomes(b.rules, { x, threshold, active: true }, b.goals)).toEqual([
        expected,
        expected,
      ]);
    const k = deriveTeachingKernel(b);
    expect(validateKernel(k).valid).toBe(true);
    for (const scene of [k.transfer, k.retry]) {
      const outcomes = scene.choices.map((c) => {
        const state = { ...scene.base, ...c.changes };
        return [
          Number(state.x) >= Number(state.threshold),
          Number(state.x) >= Number(state.threshold),
        ];
      });
      expect(new Set(outcomes.map((v) => JSON.stringify(v))).size).toBe(2);
      expect(
        outcomes.filter((o) => JSON.stringify(o) === JSON.stringify(scene.desired)),
      ).toHaveLength(1);
      expect(
        new Set(scene.choices.map((c) => JSON.stringify({ ...scene.base, ...c.changes }))).size,
      ).toBe(3);
    }
    expect(new Set(diagnosisSignatures(k).map((v) => JSON.stringify(v))).size).toBe(3);
  });
  it('accepts no-op guided work, single-input and dependent goals, same-base tasks and one sufficient probe', () => {
    const k = verificationKernel();
    expect(validateKernel(k)).toMatchObject({ valid: true });
    expect(kernelOutcomes(k.rules, k.guided.base, k.goals)).toEqual([true, true]);
    expect(interventionWinner(k.rules, k.goals, k.retry)).toBe(2);
    expect(diagnosisSignatures(k)).toEqual([
      [
        [true, true],
        [true, true],
      ],
      [
        [false, true],
        [false, true],
      ],
      [
        [true, false],
        [true, false],
      ],
    ]);
    k.rules.push({
      key: 'both',
      label: '两个判断均成立',
      op: 'and',
      args: ['read_ok', 'inactive'],
    });
    k.goals = ['read_ok', 'both'];
    k.transfer.goals = k.goals;
    // Dependent goal values are computed in rule order, never copied from inputs.
    expect(validateKernel(k).valid).toBe(true);
  });
  it.each(['zero', 'multiple'] as const)(
    'rejects %s target winners with repeated outcome vectors',
    (kind) => {
      const k = verificationKernel();
      if (kind === 'zero') k.retry.desired = [false, false];
      else k.retry.choices[1]!.changes = { x: 2, active: true };
      expect(validateKernel(k)).toMatchObject({
        valid: false,
        diagnosticCodes: ['teaching_kernel_case_inconsistent'],
      });
      expect(() => interventionWinner(k.rules, k.goals, k.retry)).toThrow('Exactly one');
    },
  );
  it.each(['missing', 'cycle', 'raw_input', 'non_boolean', 'mutation', 'ambiguous'] as const)(
    'retains material rejection for %s computation defects',
    (kind) => {
      const k = verificationKernel();
      if (kind === 'missing') k.rules[0]!.args[0] = 'undeclared';
      if (kind === 'cycle') k.rules[0]!.args[0] = k.rules[0]!.key;
      if (kind === 'raw_input') k.goals[1] = 'active';
      if (kind === 'non_boolean') k.rules[0]!.op = 'add';
      if (kind === 'mutation') k.guided.changes.undeclared = true;
      if (kind === 'ambiguous')
        k.diagnosis.hypotheses[1] = structuredClone(k.diagnosis.hypotheses[0]!);
      expect(validateKernel(k).valid).toBe(false);
    },
  );
  it('preserves finite computations, the enumeration cap and honest impossibility failure', () => {
    const b = thresholdBlueprint();
    b.inputs[0]!.values = [0];
    b.inputs[1]!.values = [1];
    expect(() => deriveTeachingKernel(b)).toThrow('three distinct input configurations');
    const large = thresholdBlueprint();
    large.inputs = Array.from({ length: 7 }, (_, i) => ({
      key: `input${i}`,
      label: `输入${i}`,
      values: [0, 1, 2, 3],
    }));
    expect(() => deriveTeachingKernel(large)).toThrow('4096');
    expect(() =>
      evaluateKernel([{ key: 'sum', label: '求和', op: 'add', args: ['a', 'b'] }], {
        a: 1e308,
        b: 1e308,
      }),
    ).toThrow('finite');
  });
  it('preserves strict and inclusive numeric boundaries at and around equality', () => {
    const comparisons = TeachingKernelSchema.shape.rules.parse(
      ['lt', 'lte', 'gt', 'gte'].map((op) => ({
        key: op,
        label: op + ' comparison',
        op,
        args: ['value', 'limit'],
      })),
    );
    for (const [value, expected] of [
      [29, [true, true, false, false]],
      [30, [false, true, false, true]],
      [31, [false, false, true, true]],
    ] as const) {
      const result = evaluateKernel(comparisons, { value, limit: 30 });
      expect(comparisons.map((rule) => result[rule.key])).toEqual(expected);
    }
    expect(() => evaluateKernel(comparisons, { value: '30', limit: 30 })).toThrow('numeric inputs');
  });
  it('constructs complete teaching cases from a small mechanism and input ranges without model-authored puzzles', () => {
    const k = kernelFixture();
    const values: Record<string, (string | string[])[]> = {
      role: [['read'], ['write'], ['read', 'write']],
      second: [[], ['read'], ['write']],
      read: ['read'],
      write: ['write'],
      ceiling: [['read'], ['write'], ['read', 'write']],
    };
    const derived = deriveTeachingKernel({
      explanation: k.explanation,
      whyUseful: k.whyUseful,
      boundary: k.boundary,
      context: k.guided.context,
      inputs: k.inputs.map((i) => ({ ...i, values: values[i.key]! })),
      rules: k.rules,
      goals: k.goals,
      extension: {
        inputs: k.transfer.extraInputs.map((i) => ({ ...i, values: values[i.key]! })),
        rules: k.transfer.extraRules,
        goals: k.transfer.goals,
        description: k.transfer.boundaryRule,
      },
    });
    expect(validateKernel(derived).valid, JSON.stringify(validateKernel(derived))).toBe(true);
    expect(derived.retry.useTransferRules).toBe(true);
    expect(derived.diagnosis.probes.every((p) => p.observe?.length)).toBe(true);
  });
  it.each(['complete', 'omitted', 'paraphrased', 'false_feedback'] as const)(
    'compiles and reviews computed Practice with %s annotations/claims',
    async (variant) => {
      const skeleton = planTeachingSkeleton({
        learningUnitTitle: '角色权限',
        targetMinutes: 22,
        targetDepth: 'working_fluency',
        objectives: [
          {
            objectiveRef: 'O1',
            title: '解释角色权限',
            description: '解释用户通过角色获得权限，并判断角色变更后的操作范围。',
            priority: 'required',
            construct: 'explain',
            authorityMode: 'exact_source',
            allowedSourceRefs: ['S1'],
            allowedVisualRefs: [],
          },
        ],
      });
      const input = {
        lesson: {
          workspaceName: 'Course',
          learnerLocale: 'zh-CN' as const,
          courseDesign: { desiredDepth: 'working_fluency' as const, unitFocus: 'normal' as const },
          skeleton,
          workedInteractionSlotId: skeleton.lessonSlots.find((s) => s.learnerActionRequired)!
            .slotId,
          sourceContext: {
            offers: [
              {
                sourceRef: 'S1',
                materialTitle: 'Source',
                headingPath: [],
                pageNumber: null,
                slideNumber: null,
                text: '角色将权限赋予用户。',
                authorizedObjectiveRefs: ['O1'],
              },
            ],
            blockCount: 1,
            offerCount: 1,
            serializedBytes: 1,
            materialCount: 1,
            sectionCount: 1,
          },
          learningContext: {
            concepts: [],
            canonicalConcepts: [],
            prerequisites: [],
            nextConnection: null,
          },
        },
        practiceSlots: skeleton.practicePlan.slots,
        priorLesson: [],
        includeNarrative: true,
      };
      const capsule = compileTeachingKernel(kernelFixture(), input);
      const shape = TeachingCapsulePayloadSchema.safeParse(capsule);
      expect(shape.success, JSON.stringify(shape.success ? null : shape.error.issues)).toBe(true);
      const validation = validateTeachingCapsule(capsule, input);
      expect(validation.valid, JSON.stringify(validation.diagnostics)).toBe(true);
      expect(capsule.practice.items[0]!.initial.prompt).not.toContain('角色甲同时有读写');
      expect(capsule.practice.items[0]!.initial.options[2]!.text).toContain('角色甲同时有读写');
      expect(capsule.lesson.slots.every((s) => s.sourceRefs.length === 0)).toBe(true);
      const worked = capsule.lesson.slots.find((s) => s.workedProcess)!.workedProcess!;
      expect(worked.interaction!.activity.options[1]!.feedbackIfSelected).not.toContain(
        worked.steps[1]!.resultingState,
      );
      expect(worked.interaction!.scaffold.prompt).toContain('先只做一小步');
      const priorTeaching = projectPracticePriorTeaching({
        objective: { title: '角色权限', whyNow: capsule.lesson.narrative!.whyNow, objectives: [] },
        prerequisites: [],
        segments: projectAcceptedLessonSegments({ skeleton, lessonContent: capsule.lesson.slots }, [
          'objective_1',
        ]),
        sourceReferences: [],
        visualReferences: [],
        summary: capsule.lesson.narrative!.summary,
        nextConnection: capsule.lesson.narrative!.forwardBridge,
      });
      const purposes: string[] = [];
      const expected = compileTeachingKernel(kernelFixture(), input).practice;
      if (variant === 'omitted') {
        for (const item of capsule.practice.items) {
          delete item.capabilityTested;
          delete item.pedagogicalReason;
          delete item.application;
          for (const surface of [item.initial, item.retry]) {
            delete surface.evidenceContrast;
            delete surface.reasoningOperation;
            delete surface.requiredInference;
            delete surface.decisiveCondition;
          }
        }
      }
      if (variant === 'paraphrased')
        capsule.practice.items[0]!.initial.evidenceContrast!.evidence = '两次独立实验都允许读写。';
      if (variant === 'false_feedback')
        capsule.practice.items[0]!.retry.options[0]!.feedbackIfSelected += ' 2 + 2 = 5.';
      const pending = verifyPreparedPractice(
        {
          ...input.lesson,
          skeleton,
          computedCases: true,
          acceptedLesson: capsule.lesson.slots,
        },
        capsule.practice,
        priorTeaching,
        async (prepared, round) => {
          const result: TeachingContentReview = { decisions: [], findings: [] };
          purposes.push(prepared.input.purpose!);
          if (prepared.input.purpose === 'practice_grounding') {
            for (const [index, item] of prepared.input.candidate.items.entries())
              for (const name of ['initial', 'retry'] as const)
                if (
                  item[name].explanation !== expected.items[index]![name].explanation ||
                  JSON.stringify(item[name].options) !==
                    JSON.stringify(expected.items[index]![name].options)
                )
                  result.findings.push({
                    itemId: item.practiceSlotId,
                    code: 'accuracy',
                    responsibility: 'grounding',
                    problem:
                      'Computed teaching feedback differs from the independently calculated fixture.',
                    repairInstruction: 'Restore truthful computed feedback.',
                  });
          }
          if (prepared.input.purpose === 'practice_answerability') {
            const visible = prepared.input;
            expect(JSON.stringify(visible.priorTeaching)).toContain(
              '合并权限 = 角色甲权限 ∪ 角色乙权限',
            );
            expect(JSON.stringify(visible)).not.toContain('correctOption');
            expect(JSON.stringify(visible)).not.toContain('feedbackIfSelected');
            expect(visible.candidate.options).toHaveLength(3);
            const initial = visible.actionIds[0]!.endsWith('.initial');
            expect(visible.candidate.prompt).toContain(initial ? '实验记录' : '目标要求');
            // Fixed finite-case answers: both observations identify the third
            // hypothesis; retaining read and removing write requires the first
            // intervention. The stub never reads private application or keys.
            result.decisions.push({
              actionId: visible.actionIds[0]!,
              answerId: initial ? 'C' : 'A',
              requiresCaseInference: true,
              evidenceUsed:
                'The public permission-union rule and observations determine this option.',
            });
          }
          return { result, logicalCallId: `computed-public:${round}:${purposes.length}` };
        },
        async () => {
          throw new Error('A complete computed case must not require revision.');
        },
      );
      if (variant === 'false_feedback') {
        await expect(pending).rejects.toThrow('A complete computed case must not require revision');
        return;
      }
      const verified = await pending;
      expect(purposes).toEqual([
        'practice_grounding',
        'practice_integrity',
        'practice_answerability',
        'practice_answerability',
      ]);
      expect(
        verified.answerabilityReview.rounds[0]!.solves.map(
          (solve) => solve.result.decisions[0]!.answerId,
        ),
      ).toEqual(['C', 'A']);
    },
  );
  it('selects partial observations whose combination is necessary for the actual diagnosis', () => {
    const proposed = kernelFixture();
    proposed.diagnosis.probes = [
      { label: '不干预一', changes: {} },
      { label: '不干预二', changes: {} },
    ];
    const prepared = buildTeachingCases(proposed);
    expect(validateKernel(prepared).valid, JSON.stringify(validateKernel(prepared))).toBe(true);
    const signatures = diagnosisSignatures(prepared).map((v) => v.map((x) => JSON.stringify(x)));
    expect(new Set(signatures.map((v) => v.join('|'))).size).toBe(3);
    for (const index of [0, 1])
      expect(
        signatures.filter((v) => v[index] === signatures[prepared.diagnosis.actual]![index]).length,
      ).toBeGreaterThan(1);
    expect(proposed.diagnosis.probes[0]!.label).toBe('不干预一');
  });
  it('treats set equality as order-independent and evaluates numeric and conditional mechanisms', () => {
    const result = evaluateKernel(
      [
        { key: 'same', label: '集合相同', op: 'eq', args: ['a', 'b'] },
        { key: 'load', label: '总负载', op: 'add', args: ['x', 'y'] },
        { key: 'fits', label: '容量足够', op: 'lte', args: ['load', 'capacity'] },
        { key: 'grants', label: '已分配权限', op: 'if', args: ['assigned', 'a', 'empty'] },
      ],
      {
        a: ['read', 'write'],
        b: ['write', 'read'],
        x: 3,
        y: 4,
        capacity: 6,
        assigned: false,
        empty: [],
      },
    );
    expect(result).toMatchObject({ same: true, load: 7, fits: false, grants: [] });
  });
  it('computes set propagation, new governing constraints and discriminating intervention evidence', () => {
    const k = kernelFixture();
    expect(validateKernel(k).valid).toBe(true);
    expect(kernelOutcomes(k.rules, k.guided.base, k.goals)).toEqual([true, true]);
    expect(
      interventionWinner([...k.rules, ...k.transfer.extraRules], k.transfer.goals, k.transfer),
    ).toBe(2);
    expect(diagnosisSignatures(k)).toEqual([
      [
        [true, false],
        [true, true],
      ],
      [
        [true, true],
        [false, true],
      ],
      [
        [true, true],
        [true, true],
      ],
    ]);
    expect(interventionWinner(k.rules, k.goals, k.retry)).toBe(0);
  });
  it('rejects ambiguous diagnosis, missing inputs, noncausal goals and invalid operand types', () => {
    const k = kernelFixture();
    k.diagnosis.hypotheses[1] = structuredClone(k.diagnosis.hypotheses[0]!);
    expect(validateKernel(k).valid).toBe(false);
    const missing = kernelFixture();
    delete missing.guided.base.read;
    expect(validateKernel(missing).valid).toBe(false);
    const lookup = kernelFixture();
    lookup.goals = ['read', 'write'];
    expect(validateKernel(lookup).valid).toBe(false);
    expect(() =>
      evaluateKernel([{ key: 'n', label: '数值加法', op: 'add', args: ['a', 'b'] }], {
        a: true,
        b: 2,
      }),
    ).toThrow('Numeric');
  });
});
