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
import { TeachingCapsulePayloadSchema } from '@hy3-clinic/shared';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';
import { compileTeachingKernel } from '../services/compileTeachingKernel.js';
import { validateTeachingCapsule } from './teachingCapsule.js';
import { deriveTeachingKernel } from './teachingBlueprint.js';

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
  it('compiles sufficient visible cases, feedback and counterfactuals into the existing teaching contract', () => {
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
        workedInteractionSlotId: skeleton.lessonSlots.find((s) => s.learnerActionRequired)!.slotId,
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
  });
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
