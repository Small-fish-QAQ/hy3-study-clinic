import type { TeachingCapsulePayload } from '@hy3-clinic/shared';
import type { TeachingCapsuleGenerationInput } from '../llm/provider.js';
import {
  evaluateKernel,
  kernelOutcomes,
  kernelPatch,
  outcomeKey,
  interventionWinner,
  diagnosisSignatures,
  type TeachingKernel,
  type KernelRule,
  type KernelState,
  type KernelValue,
} from '../llm/teachingKernel.js';

export function compileTeachingKernel(
  k: TeachingKernel,
  input: TeachingCapsuleGenerationInput,
): TeachingCapsulePayload {
  const labels = new Map(
    [...k.inputs, ...k.rules, ...k.transfer.extraInputs, ...k.transfer.extraRules].map((i) => [
      i.key,
      i.label,
    ]),
  );
  const value = (v: KernelValue): string =>
    Array.isArray(v)
      ? `{${v.join('、') || '空集'}}`
      : typeof v === 'boolean'
        ? v
          ? '是'
          : '否'
        : String(v);
  const state = (s: KernelState) =>
    Object.entries(s)
      .map(([key, v]) => `${labels.get(key)}=${value(v)}`)
      .join('；');
  const vector = (goals: string[], v: boolean[]) =>
    goals.map((key, i) => `${labels.get(key)}：${v[i] ? '是' : '否'}`).join('；');
  const equation = (r: KernelRule) => {
    const a = r.args.map((key) => labels.get(key));
    const expr =
      r.op === 'if'
        ? `若${a[0]}则取${a[1]}，否则取${a[2]}`
        : r.op === 'not'
          ? `非（${a[0]}）`
          : r.op === 'includes'
            ? `${a[0]}包含${a[1]}`
            : a.join(
                {
                  and: ' 且 ',
                  or: ' 或 ',
                  eq: ' 等于 ',
                  gte: ' ≥ ',
                  lte: ' ≤ ',
                  add: ' + ',
                  subtract: ' − ',
                  union: ' ∪ ',
                  intersection: ' ∩ ',
                  difference: ' 去除 ',
                  not: '',
                  includes: '',
                  if: '',
                }[r.op],
              );
    return `${r.label} = ${expr}`;
  };
  const rules = (rs: KernelRule[]) => rs.map(equation).join('；');
  const relationRule =
    k.rules.find((rule) => k.rules.some((next) => next.args.includes(rule.key))) ?? k.rules[0]!;
  const descendants = new Set([relationRule.key]);
  for (const rule of k.rules)
    if (rule.args.some((key) => descendants.has(key))) descendants.add(rule.key);
  const dependentLabels = k.rules
    .filter((rule) => rule.key !== relationRule.key && descendants.has(rule.key))
    .map((rule) => rule.label);
  const trace = (rs: KernelRule[], s: KernelState) => {
    const evaluated = evaluateKernel(rs, s);
    return rs.map((r) => `${r.label}=${value(evaluated[r.key]!)}`).join(' → ');
  };
  const ids = ['A', 'B', 'C', 'D'];
  const final = kernelPatch(k.guided.base, k.guided.changes);
  const expected = kernelOutcomes(k.rules, final, k.goals);
  const before = kernelOutcomes(k.rules, k.guided.base, k.goals);
  const vectors = [expected, before];
  for (let n = 0; vectors.length < 3 && n < 2 ** k.goals.length; n++) {
    const v = k.goals.map((_, i) => Boolean(n & (1 << i)));
    if (!vectors.some((old) => outcomeKey(old) === outcomeKey(v))) vectors.push(v);
  }
  const caseFact = `初始输入：${state(k.guided.base)}。变更：${state(k.guided.changes)}。`;
  const alternativeFact = `初始输入：${state(k.guided.base)}。变更：无，保持初始输入。`;
  const calculation = trace(k.rules, final);
  const guided = {
    reasoningOperation: 'predict_outcome' as const,
    requiredInference: `完成变更后推导：${vector(k.goals, expected)}`,
    decisiveCondition: `${state(k.guided.changes)}`,
    evidenceContrast: {
      evidence: caseFact,
      replacement: alternativeFact,
      alternativeOptionId: 'B',
    },
    prompt: '执行这组变更后，下面哪组判断同时成立？请先沿规则推演，再选择。',
    options: vectors.map((v, i) => ({
      id: ids[i]!,
      text: vector(k.goals, v),
      feedbackIfSelected:
        i === 0
          ? `这些判断与完整推演一致。${calculation}`
          : i === 1
            ? '这组选项沿用了变更前的结果。先核对本次改动影响了哪条规则，再决定最终判断是否需要变化。'
            : '这组选项把部分条件的变化直接当作全部判断的变化。先分开核对每条依赖，下一小步会帮助你定位。',
      misconception:
        i === 0
          ? null
          : {
              hypothesis:
                i === 1 ? '沿用变更前的结果。' : '只更新部分条件，没有把影响传到最终判断。',
              whyTempting:
                i === 1
                  ? `初始状态确实得到${vector(k.goals, before)}，容易在更新后仍沿用。`
                  : '个别输入保持不变，容易误以为所有判断也不变。',
              correction: `先应用${state(k.guided.changes)}，再逐层重算受影响的规则。保留未受影响的数据，但不要因此沿用整个旧结论。`,
            },
    })),
    correctOptionId: 'A',
    correctDebrief: `从输入到中间结果，再到最终判断：${calculation}`,
  };
  const intervention = (scene: TeachingKernel['retry'], rs: KernelRule[], goals: string[]) => {
    const win = interventionWinner(rs, goals, scene);
    const other = (win + 1) % 3;
    const target = `目标要求：${vector(goals, scene.desired)}`;
    const actual = scene.choices.map((c) =>
      kernelOutcomes(rs, kernelPatch(scene.base, c.changes), goals),
    );
    const options = scene.choices.map((c, i) => ({
      id: ids[i]!,
      text: `${c.label}（${state(c.changes) || '保持输入不变'}）`,
      feedbackIfSelected: `采用此方案后：${vector(goals, actual[i]!)}。${i === win ? '同时满足全部目标。' : '未同时满足全部目标。'}${trace(rs, kernelPatch(scene.base, c.changes))}`,
    }));
    return {
      reasoningOperation: 'choose_design' as const,
      requiredInference: `比较干预结果，选择${scene.choices[win]!.label}以满足${vector(goals, scene.desired)}`,
      decisiveCondition: target,
      evidenceContrast: {
        evidence: target,
        replacement: `目标要求：${vector(goals, actual[other]!)}`,
        alternativeOptionId: ids[other]!,
      },
      prompt: `${scene.context}\n初始输入：${state(scene.base)}。${target}。比较下列三种假设改动，哪一种会得到这组结果？`,
      options,
      correctOptionId: ids[win]!,
      debrief: `逐个方案重算后，只有${scene.choices[win]!.label}符合全部目标。${trace(rs, kernelPatch(scene.base, scene.choices[win]!.changes))}`,
    };
  };
  const tr = intervention(k.transfer, [...k.rules, ...k.transfer.extraRules], k.transfer.goals);
  const first =
    k.rules.find(
      (rule) =>
        !k.goals.includes(rule.key) &&
        rule.args.some((key) => Object.hasOwn(k.guided.changes, key)),
    ) ?? k.rules[0]!;
  const intermediate = evaluateKernel(k.rules, final)[first.key]!;
  const previous = evaluateKernel(k.rules, k.guided.base)[first.key]!;
  const wrong =
    JSON.stringify(intermediate) !== JSON.stringify(previous)
      ? previous
      : typeof intermediate === 'boolean'
        ? !intermediate
        : typeof intermediate === 'number'
          ? intermediate + 1
          : Array.isArray(intermediate)
            ? ['未沿依赖计算']
            : '尚未计算';
  const scaffold = {
    reasoningOperation: 'predict_outcome' as const,
    requiredInference: `计算${first.label}作为下一层规则的输入。`,
    decisiveCondition: state(k.guided.changes),
    prompt: `先只做一小步：应用变更后，按“${equation(first)}”计算，中间结果是什么？`,
    options: [
      {
        id: 'A',
        text: `中间结果：${value(intermediate)}`,
        feedbackIfSelected: `这一步把输入转换成${first.label}，后续判断仍要继续推导。`,
      },
      {
        id: 'B',
        text: `中间结果：${value(wrong)}`,
        feedbackIfSelected: `按${equation(first)}重算，结果为${value(intermediate)}。`,
      },
    ],
    correctOptionId: 'A',
    debrief: `中间结果：${value(intermediate)}。这还不是整题结论，需要带入后续规则。`,
  };
  const wp = {
    startingState: k.guided.context,
    inputs: k.inputs.reduce<string[]>((groups, item, index) => {
      const group = Math.floor(index / Math.ceil(k.inputs.length / 6));
      groups[group] = groups[group] ? `${groups[group]}；${item.label}` : item.label;
      return groups;
    }, []),
    ruleOrProcedure: `本教学模型采用以下规则：${rules(k.rules)}。所有变更先应用于输入，再依次计算。`,
    steps: [
      {
        action: '把初始输入和待执行变更分开列出',
        reason: '先确定哪些数据发生变化，再把变化沿依赖传递。',
        resultingState: caseFact,
      },
      {
        action: '执行变更并重算全部依赖',
        reason: '最终判断取决于更新后的中间结果，不能直接沿用旧结论。',
        resultingState: calculation,
      },
    ],
    learnerDecision: guided.prompt,
    result: vector(k.goals, expected),
    whyResultFollows: `这些判断都沿同一机制从输入推到结果。先更新输入，再按依赖逐层计算，才能区分“原来的规则已足够”和“还受到新增条件约束”。如果直接记住上一个答案，就会错过边界变化。`,
    sourceRefs: [],
    interaction: {
      pauseAfterStepIndex: 0,
      sourceRefs: [],
      activity: guided,
      hint: '先标出变更影响的输入，沿规则追到两个最终判断；分别核对，避免只算其中一条。',
      scaffold,
      transfer: {
        changedCondition: `${k.transfer.boundaryRule}\n新增规则：${rules(k.transfer.extraRules)}`,
        prompt: tr.prompt,
        options: tr.options,
        correctOptionId: tr.correctOptionId,
        debrief: tr.debrief,
        reasoningOperation: tr.reasoningOperation,
        requiredInference: tr.requiredInference,
        evidenceContrast: tr.evidenceContrast,
      },
    },
  };
  const signatures = diagnosisSignatures(k);
  const observations = (n: number) =>
    k.diagnosis.probes
      .map(
        (p, i) =>
          `${p.label}（${state(p.changes) || '不改变输入'}）→${vector(p.observe ?? k.goals, signatures[n]![i]!)}`,
      )
      .join('；');
  const evidence = `实验记录：${observations(k.diagnosis.actual)}`;
  const diag = {
    prompt: `${k.diagnosis.context}\n已存档的基准配置：${state(k.diagnosis.base)}。下列三个候选配置中恰有一个与实际一致；按各候选列出的改动更新基准，未列出的输入保持基准值。每次实验都从同一实际配置重新开始。${evidence}。哪个候选能同时解释两次实验？`,
    options: k.diagnosis.hypotheses.map((h, i) => ({
      optionRef: ids[i]!,
      text: `${h.label}（${state(h.changes) || '保持基准配置不变'}）`,
      feedbackIfSelected: `若采用该假设，两次实验应为：${observations(i)}。${i === k.diagnosis.actual ? '与两次记录均一致。' : '至少一次记录不符，故可排除此假设。'}`,
    })),
    correctOptionRef: ids[k.diagnosis.actual]!,
    hint: '把每个假设分别代入两次实验。能解释一次并不足够，两次都相符才保留。',
    explanation: `三种假设的观测组合各不相同；${k.diagnosis.hypotheses[k.diagnosis.actual]!.label}与两次记录都一致。在限定的三个假设内可确定它，不能据此排除模型外所有可能。`,
    reasoningOperation: 'diagnose_cause' as const,
    requiredInference: `用两次实验区分假设，确定${k.diagnosis.hypotheses[k.diagnosis.actual]!.label}。`,
    decisiveCondition: '两个实验的联合结果区分所有给定假设。',
    evidenceContrast: {
      evidence,
      replacement: `实验记录：${observations((k.diagnosis.actual + 1) % 3)}`,
      alternativeOptionId: ids[(k.diagnosis.actual + 1) % 3]!,
    },
  };
  const retry = intervention(
    k.retry,
    k.retry.useTransferRules ? [...k.rules, ...k.transfer.extraRules] : k.rules,
    k.retry.useTransferRules ? k.transfer.goals : k.goals,
  );
  if (k.retry.useTransferRules)
    retry.prompt = `${k.transfer.boundaryRule}\n新增规则：${rules(k.transfer.extraRules)}。\n${retry.prompt}`;
  const { correctOptionId: retryCorrect, debrief: retryDebrief, ...retrySurface } = retry;
  return {
    practice: {
      items: input.practiceSlots.map((slot) => ({
        practiceSlotId: slot.practiceSlotId,
        capabilityTested: slot.capabilityToObserve,
        pedagogicalReason:
          '先从实验结果反推原因，再比较干预方案，检验能否把同一机制用于不同推理方向。',
        sourceRefs: [],
        visualRefs: [],
        application:
          slot.construct === 'apply'
            ? {
                startingState: k.guided.context,
                sourceRuleOrProcedure: k.explanation,
                decisionRequired: '依据给定规则比较可执行的干预方案。',
                expectedAction: retry.options.find((o) => o.id === retry.correctOptionId)!.text,
              }
            : null,
        initial: diag,
        retry: {
          ...retrySurface,
          options: retry.options.map(({ id, ...o }) => ({ ...o, optionRef: id })),
          correctOptionRef: retryCorrect,
          hint: '分别应用每个方案，再按规则计算两个目标；不要凭方案名称猜测。',
          explanation: retryDebrief,
        },
      })),
    },
    lesson: {
      ...(input.includeNarrative
        ? {
            narrative: {
              whyNow: k.whyUseful,
              summary: `${k.explanation}\n${k.boundary}`,
              forwardBridge: null,
            },
          }
        : {}),
      slots: input.lesson.skeleton.lessonSlots.map((slot, index) => ({
        slotId: slot.slotId,
        explanation:
          slot.qualityContract === 'orientation'
            ? k.whyUseful
            : slot.qualityContract === 'boundary_work'
              ? '把规则用于新场景之前，还要确认哪些前提仍然成立。下面这条适用范围会决定能否直接迁移刚才的推理。'
              : index ===
                  (input.lesson.skeleton.lessonSlots[0]?.qualityContract === 'orientation' ? 1 : 0)
                ? k.explanation
                : '现在把这个机制用于一组尚未求解的数据；先追踪中间变化，再判断最终结果。',
        sourceRefs: [],
        visualRefs: [],
        semanticRelations:
          slot.qualityContract === 'semantic_relation'
            ? [
                {
                  kind: slot.allowedRelations[0]!,
                  fromProposition: equation(relationRule),
                  toProposition: dependentLabels.length
                    ? `这一结果是${dependentLabels.join('、')}的依赖条件，相关输入的变化会沿这条链路影响判断。`
                    : `该规则把给定输入转换成“${relationRule.label}”这一具体判断，不能由此替代其他目标的独立检查。`,
                  relevanceToObjective: slot.objectiveRefs[0]!,
                  sourceRefs: [],
                },
              ]
            : [],
        workedProcess: slot.slotId === input.lesson.workedInteractionSlotId ? wp : null,
        ...(slot.learnerActionRequired && slot.slotId !== input.lesson.workedInteractionSlotId
          ? {
              informalCheck: {
                kind: 'choose_alternative' as const,
                prompt: `${k.guided.context}\n规则：${rules(k.rules)}。${caseFact}\n${guided.prompt}`,
                expectedSignal: calculation,
                options: guided.options.map(({ id, text, feedbackIfSelected }) => ({
                  id,
                  text,
                  feedbackIfSelected,
                })),
                correctOptionId: 'A',
                reasoningOperation: guided.reasoningOperation,
                requiredInference: guided.requiredInference,
                decisiveCondition: guided.decisiveCondition,
                evidenceContrast: guided.evidenceContrast,
              },
            }
          : {}),
        ...(slot.qualityContract === 'boundary_work'
          ? { contrast: { text: k.boundary, sourceRefs: [], visualRefs: [] } }
          : {}),
      })),
    },
  } as TeachingCapsulePayload;
}
