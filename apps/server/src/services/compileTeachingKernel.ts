import type { TeachingCapsulePayload } from '@hy3-clinic/shared';
import type { TeachingCapsuleGenerationInput } from '../llm/provider.js';
import { literalTeachingText } from './teachingText.js';
import {
  evaluateKernel,
  kernelOutcomes,
  kernelPatch,
  outcomeKey,
  interventionWinner,
  diagnosisSignatures,
  validateKernel,
  kernelValueKey,
  type TeachingKernel,
  type KernelRule,
  type KernelState,
  type KernelValue,
} from '../llm/teachingKernel.js';

export function compileTeachingKernel(
  k: TeachingKernel,
  input: TeachingCapsuleGenerationInput,
): TeachingCapsulePayload {
  const validity = validateKernel(k);
  if (!validity.valid) throw Error(validity.diagnostics.join(' '));
  const labels = new Map(
    [...k.inputs, ...k.rules, ...k.transfer.extraInputs, ...k.transfer.extraRules].map((i) => [
      i.key,
      i.label,
    ]),
  );
  const value = (v: KernelValue): string =>
    Array.isArray(v)
      ? `{${[...new Set(v)].map((element) => JSON.stringify(element)).join(', ')}}`
      : typeof v === 'boolean'
        ? v
          ? '是'
          : '否'
        : typeof v === 'string'
          ? JSON.stringify(v)
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
                  gt: ' > ',
                  lt: ' < ',
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
  const changedOutcome = outcomeKey(expected) !== outcomeKey(before);
  const vectors = changedOutcome ? [expected, before] : [expected];
  for (let n = 0; vectors.length < 3 && n < 2 ** k.goals.length; n++) {
    const v = k.goals.map((_, i) => Boolean(n & (1 << i)));
    if (!vectors.some((old) => outcomeKey(old) === outcomeKey(v))) vectors.push(v);
  }
  const changeText = state(k.guided.changes) || '无，保持初始输入';
  const caseFact = `初始输入：${state(k.guided.base)}。变更：${changeText}。`;
  const alternativeFact = `初始输入：${state(k.guided.base)}。变更：无，保持初始输入。`;
  const calculation = trace(k.rules, final);
  const guided = {
    reasoningOperation: 'predict_outcome' as const,
    requiredInference: `完成变更后推导：${vector(k.goals, expected)}`,
    decisiveCondition: changeText,
    ...(changedOutcome
      ? {
          evidenceContrast: {
            evidence: caseFact,
            replacement: alternativeFact,
            alternativeOptionId: 'B',
          },
        }
      : {}),
    prompt: '按给定输入完成本次核对后，下面哪组判断同时成立？请先沿规则推演，再选择。',
    options: vectors.map((v, i) => ({
      id: ids[i]!,
      text: vector(k.goals, v),
      feedbackIfSelected:
        i === 0
          ? `这些判断与完整推演一致。${calculation}`
          : i === 1 && changedOutcome
            ? '这组选项沿用了变更前的结果。先核对本次改动影响了哪条规则，再决定最终判断是否需要变化。'
            : '这组判断与给定规则的推演不一致。分别核对每个目标；输入改变时，最终结果也可能保持不变。',
      misconception:
        i === 0
          ? null
          : {
              hypothesis:
                i === 1 && changedOutcome ? '沿用变更前的结果。' : '没有按给定规则核对每个目标。',
              whyTempting:
                i === 1 && changedOutcome
                  ? `初始状态确实得到${vector(k.goals, before)}，容易在更新后仍沿用。`
                  : '只检查一个条件或凭印象判断，容易漏掉其他规则。',
              correction: `先核对本次输入（${changeText}），再按顺序计算每个目标。结果是否改变，要由规则的计算确定。`,
            },
    })),
    correctOptionId: 'A',
    correctDebrief: `按给定输入依次核对规则：${calculation}`,
  };
  const intervention = (scene: TeachingKernel['retry'], rs: KernelRule[], goals: string[]) => {
    const win = interventionWinner(rs, goals, scene);
    const other = (win + 1) % 3;
    const target = `目标要求：${vector(goals, scene.desired)}`;
    const actual = scene.choices.map((c) =>
      kernelOutcomes(rs, kernelPatch(scene.base, c.changes), goals),
    );
    // A changed target is a valid counterfactual only if its alternative is
    // uniquely supported. Two losing configurations may share that outcome.
    const contrast =
      actual.filter((v) => outcomeKey(v) === outcomeKey(actual[other]!)).length === 1
        ? {
            evidenceContrast: {
              evidence: target,
              replacement: `目标要求：${vector(goals, actual[other]!)}`,
              alternativeOptionId: ids[other]!,
            },
          }
        : {};
    const options = scene.choices.map((c, i) => ({
      id: ids[i]!,
      text: `${c.label}（${state(c.changes) || '保持输入不变'}）`,
      feedbackIfSelected: `采用此方案后：${vector(goals, actual[i]!)}。${i === win ? '同时满足全部目标。' : '未同时满足全部目标。'}${trace(rs, kernelPatch(scene.base, c.changes))}`,
    }));
    return {
      reasoningOperation: 'choose_design' as const,
      requiredInference: `比较干预结果，选择${scene.choices[win]!.label}以满足${vector(goals, scene.desired)}`,
      decisiveCondition: target,
      ...contrast,
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
    kernelValueKey(intermediate) !== kernelValueKey(previous)
      ? previous
      : typeof intermediate === 'boolean'
        ? !intermediate
        : typeof intermediate === 'number'
          ? intermediate === 0
            ? 1
            : -intermediate
          : Array.isArray(intermediate)
            ? [...intermediate, `${intermediate.join('')}（模型外元素）`]
            : `${intermediate}（未按规则核对）`;
  const scaffoldAnswers = [intermediate, wrong].map((v) => `本步结果：${value(v)}`);
  // The schema trims text and the public buttons render plain text with collapsed
  // whitespace. Internal type inequality alone cannot prove a usable choice pair.
  if (
    kernelValueKey(intermediate) === kernelValueKey(wrong) ||
    new Set(scaffoldAnswers.map(literalTeachingText)).size !== 2
  )
    throw Error('Cannot construct semantically and visibly distinct scaffold answers.');
  const scaffold = {
    reasoningOperation: 'predict_outcome' as const,
    requiredInference: `计算${first.label}，核对本题的一步。`,
    decisiveCondition: changeText,
    prompt: `先只做一小步：应用变更后，按“${equation(first)}”计算，本步结果是什么？`,
    options: [
      {
        id: 'A',
        text: scaffoldAnswers[0]!,
        feedbackIfSelected: `这一步按给定规则得到${first.label}；全题还需核对其他规则。`,
      },
      {
        id: 'B',
        text: scaffoldAnswers[1]!,
        feedbackIfSelected: `按${equation(first)}重算，结果为${value(intermediate)}。`,
      },
    ],
    correctOptionId: 'A',
    debrief: `本步结果：${value(intermediate)}。全题的判断按列出的全部规则核对。`,
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
        reason: '按当前输入核对全部依赖；输入改变也可能保持最终判断不变。',
        resultingState: calculation,
      },
    ],
    learnerDecision: guided.prompt,
    result: vector(k.goals, expected),
    whyResultFollows:
      '每个判断均按列出的规则从当前输入逐层计算。补充规则是否影响本题判断，需要结合其实际依赖核对，不能仅凭新增条件就断言结果必然改变。',
    sourceRefs: [],
    interaction: {
      pauseAfterStepIndex: 0,
      sourceRefs: [],
      activity: guided,
      hint: '先标出当前输入，按规则核对每个目标；输入变化是否改变结果，需要分别计算。',
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
  const sufficientProbe = k.diagnosis.probes.findIndex(
    (_, i) =>
      signatures.filter(
        (v) => outcomeKey(v[i]!) === outcomeKey(signatures[k.diagnosis.actual]![i]!),
      ).length === 1,
  );
  const diag = {
    prompt: `${k.diagnosis.context}\n已存档的基准配置：${state(k.diagnosis.base)}。下列三个候选配置中恰有一个与实际一致；按各候选列出的改动更新基准，未列出的输入保持基准值。每次实验都从同一实际配置重新开始。${evidence}。哪个候选能同时解释两次实验？`,
    options: k.diagnosis.hypotheses.map((h, i) => ({
      optionRef: ids[i]!,
      text: `${h.label}（${state(h.changes) || '保持基准配置不变'}）`,
      feedbackIfSelected: `若采用该假设，两次实验应为：${observations(i)}。${i === k.diagnosis.actual ? '与两次记录均一致。' : '至少一次记录不符，故可排除此假设。'}`,
    })),
    correctOptionRef: ids[k.diagnosis.actual]!,
    hint: '把候选的预测与实验记录逐项核对；保留与给出的全部记录一致的候选。',
    explanation: `三种假设的观测组合各不相同；${k.diagnosis.hypotheses[k.diagnosis.actual]!.label}与两次记录都一致。${sufficientProbe >= 0 ? `${k.diagnosis.probes[sufficientProbe]!.label}的记录单独已能确定本题候选，另一记录也与它一致。` : '任一记录单独仍有多个候选，合并两次记录才可确定本题候选。'}在限定的三个假设内可确定它，不能据此排除模型外所有可能。`,
    reasoningOperation: 'diagnose_cause' as const,
    requiredInference: `核对实验记录，确定${k.diagnosis.hypotheses[k.diagnosis.actual]!.label}。`,
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
          hint: '分别应用每个方案，再按规则计算所有目标；不要凭方案名称猜测。',
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
        workedProcess:
          slot.qualityContract === 'worked_process' ||
          slot.slotId === input.lesson.workedInteractionSlotId
            ? wp
            : null,
        ...(slot.learnerActionRequired &&
        slot.qualityContract !== 'worked_process' &&
        slot.slotId !== input.lesson.workedInteractionSlotId
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
