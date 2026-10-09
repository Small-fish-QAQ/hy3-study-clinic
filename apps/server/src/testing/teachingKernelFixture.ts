import { TeachingKernelSchema } from '../llm/teachingKernel.js';
import { TeachingBlueprintSchema } from '../llm/teachingBlueprint.js';
import type { TeachingCapsuleGenerationInput } from '../llm/provider.js';
import { planTeachingSkeleton } from '../services/teachingSkeletonPlanner.js';

/** Explicit shared policy: both operations use x >= threshold. No third outcome exists. */
export function thresholdBlueprint() {
  return TeachingBlueprintSchema.parse({
    explanation:
      '本假设策略按一个明确阈值同时控制读取和写入：当前值达到阈值时两项操作都获准，未达到时两项都不获准。两项结果共同变化；核对时应使用当前给出的值和阈值，而不是记忆之前的结论。',
    whyUseful: '判断当前值与门槛的关系，才能确定读取和写入是否均被许可。',
    boundary: '本教学模型使用显式的共同阈值策略，不推广为所有实际权限系统的行为。',
    context: '系统公开了当前值和许可阈值，两项操作使用同一判断规则。',
    inputs: [
      { key: 'x', label: '当前值', values: [0, 1, 2] },
      { key: 'threshold', label: '许可阈值', values: [1, 2] },
      { key: 'active', label: '启用状态', values: [true] },
    ],
    rules: [
      { key: 'read_ok', label: '允许读取', op: 'gte', args: ['x', 'threshold'] },
      { key: 'write_ok', label: '允许写入', op: 'gte', args: ['x', 'threshold'] },
    ],
    goals: ['read_ok', 'write_ok'],
    extension: {
      inputs: [{ key: 'extra', label: '核对数值', values: [1, 2] }],
      rules: [{ key: 'total', label: '核对总数', op: 'add', args: ['threshold', 'extra'] }],
      goals: ['read_ok', 'write_ok'],
      description: '补充核对总数是许可阈值与核对数值之和；操作许可仍按当前值与许可阈值比较。',
    },
  });
}

/** Independent oracle: (x >= threshold, !active). The second goal has one input. */
export function verificationKernel() {
  const b = thresholdBlueprint();
  const base = { x: 1, threshold: 1, active: false };
  const choices = [
    { label: '保留当前配置', changes: {} },
    { label: '当前值改为零', changes: { x: 0 } },
    { label: '启用当前配置', changes: { active: true } },
  ];
  return TeachingKernelSchema.parse({
    explanation:
      '本假设系统根据当前值是否达到许可阈值判断允许读取；另一个判断独立核对启用状态是否为否。所有方案按列出的输入重算，保持配置也是可比较的方案。补充核对总数不参与这两个判断。',
    whyUseful: '许可与启用状态依赖不同输入，需要分别核对才能选择满足当前目标的配置。',
    boundary: '本教学模型假定读取许可仅由明确阈值决定，启用状态独立；不推广为所有实际权限系统。',
    inputs: b.inputs.map(({ key, label }) => ({ key, label })),
    rules: [b.rules[0], { key: 'inactive', label: '尚未启用', op: 'not', args: ['active'] }],
    goals: ['read_ok', 'inactive'],
    guided: {
      context: '系统公开了当前值、许可阈值和启用状态。分别核对读取许可与是否尚未启用。',
      base,
      changes: {},
    },
    transfer: {
      context: '补充核对总数不改变原许可规则。比较各方案能否得到指定结果。',
      base: { ...base, extra: 1 },
      extraInputs: [{ key: 'extra', label: '核对数值' }],
      extraRules: b.extension.rules,
      goals: ['read_ok', 'inactive'],
      boundaryRule: b.extension.description,
      choices,
      desired: [true, true],
    },
    diagnosis: {
      context: '当前配置可能是下面三个候选之一。依据独立实验的记录核对候选。',
      base,
      hypotheses: choices,
      actual: 0,
      probes: [
        { label: '记录原始判断', changes: {} },
        { label: '重新核对判断', changes: {} },
      ],
    },
    retry: {
      context: '初始配置相同，但当前目标要求允许读取且已经启用。只选择一个方案。',
      base,
      choices,
      desired: [true, false],
    },
  });
}

/** The selected value's type/set members affect equality, not just its spelling. */
export function valueDisplayBlueprint(kind: 'number_string' | 'singleton_empty') {
  const scalar = kind === 'number_string';
  return TeachingBlueprintSchema.parse({
    explanation:
      '本假设系统按开关选择一个值，再与给定常量比较。数值与文字即使拼写相同也不是相等的值；集合按成员判断相等。另一个判断要求比较成立且配置启用。所有方案都按当前输入独立核对。',
    whyUseful: '先确认选取值的类型和内容，才能正确比较并判断是否同时满足启用要求。',
    boundary: '本模型的相等比较不把文字自动转换为数值；空集合也不包含任何文字成员。',
    context: '系统公开选择开关、两个常量与启用状态，按规则选取并比较当前值。',
    inputs: [
      { key: 'flag', label: '选择数值开关', values: [false, true] },
      { key: 'num', label: scalar ? '数值常量' : '单成员集合', values: [scalar ? 1 : ['空集']] },
      { key: 'txt', label: scalar ? '文字常量' : '空集合', values: [scalar ? '1' : []] },
      { key: 'enabled', label: '启用状态', values: [false, true] },
    ],
    rules: [
      { key: 'picked', label: '选取值', op: 'if', args: ['flag', 'num', 'txt'] },
      { key: 'same', label: '等于给定常量', op: 'eq', args: ['picked', 'num'] },
      { key: 'both', label: '比较成立且启用', op: 'and', args: ['same', 'enabled'] },
    ],
    goals: ['same', 'both'],
    extension: {
      inputs: [{ key: 'extra', label: '补充记录', values: [true] }],
      rules: [{ key: 'recorded', label: '已补充记录', op: 'and', args: ['extra'] }],
      goals: ['same', 'both'],
      description: '补充记录按给定状态单独核对；选取值和原来的两个判断仍按原规则计算。',
    },
  });
}

/** Only (true,false) has enough losers; a fourth configuration allows a new task. */
export function transferReplayBlueprint() {
  const b = valueDisplayBlueprint('number_string');
  return TeachingBlueprintSchema.parse({
    ...b,
    explanation:
      '本假设系统只有在甲条件与乙条件同时成立时才允许执行。另一个判断是固定常量的否定；常量为真，所以这一判断始终为否。不同配置必须按当前给出的条件与目标独立核对。',
    whyUseful: '对每个配置核对两个条件的合取，才能选出唯一满足执行目标的方案。',
    boundary: '本模型明确把第二个判断设为固定常量的否定，不为增加结果种类虚构其他策略。',
    context: '系统列出甲条件、乙条件和固定常量。按合取与否定规则判断各配置。',
    inputs: [
      { key: 'a', label: '甲条件', values: [false, true] },
      { key: 'b', label: '乙条件', values: [false, true] },
      { key: 'constant', label: '固定常量', values: [true] },
    ],
    rules: [
      { key: 'allowed', label: '允许执行', op: 'and', args: ['a', 'b'] },
      { key: 'denied_constant', label: '常量的否定', op: 'not', args: ['constant'] },
    ],
    goals: ['allowed', 'denied_constant'],
    extension: { ...b.extension, goals: ['allowed', 'denied_constant'] },
  });
}

/** Exactly one possible three-configuration decision; supplementary values are irrelevant. */
export function noDistinctRetryBlueprint() {
  const b = thresholdBlueprint();
  return TeachingBlueprintSchema.parse({
    ...b,
    inputs: [
      { key: 'x', label: '当前值', values: [0, 1, 2] },
      { key: 'zero', label: '零常量', values: [0] },
      { key: 'one', label: '一常量', values: [1] },
    ],
    rules: [
      { key: 'is_zero', label: '值为零', op: 'eq', args: ['x', 'zero'] },
      { key: 'is_one', label: '值为一', op: 'eq', args: ['x', 'one'] },
    ],
    goals: ['is_zero', 'is_one'],
    extension: {
      inputs: [{ key: 'extra', label: '无关记录', values: [1, 2] }],
      rules: [
        { key: 'read_ok', label: '允许读取', op: 'gte', args: ['x', 'one'] },
        { key: 'write_ok', label: '允许写入', op: 'gte', args: ['x', 'one'] },
      ],
      goals: ['read_ok', 'write_ok'],
      description: '补充操作许可按当前值是否达到一判断。无关记录不参与许可计算，也不改变目标。',
    },
  });
}

export function kernelCapsuleInput(): TeachingCapsuleGenerationInput {
  const skeleton = planTeachingSkeleton({
    learningUnitTitle: '显式许可规则',
    targetMinutes: 22,
    targetDepth: 'working_fluency',
    objectives: [
      {
        objectiveRef: 'O1',
        title: '解释许可判断',
        description: '解释当前值、阈值与启用状态如何决定给定判断。',
        priority: 'required',
        construct: 'explain',
        authorityMode: 'exact_source',
        allowedSourceRefs: ['S1'],
        allowedVisualRefs: [],
      },
    ],
  });
  return {
    lesson: {
      workspaceName: 'Kernel fixture',
      learnerLocale: 'zh-CN',
      visualContext: { offers: [], offerCount: 0, serializedBytes: 0 },
      courseDesign: { desiredDepth: 'working_fluency', unitFocus: 'normal' },
      skeleton,
      workedInteractionSlotId: skeleton.lessonSlots.find((s) => s.learnerActionRequired)!.slotId,
      sourceContext: {
        offers: [
          {
            sourceRef: 'S1',
            materialTitle: '显式假设规则',
            headingPath: [],
            pageNumber: null,
            slideNumber: null,
            text: verificationKernel().explanation,
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
}
