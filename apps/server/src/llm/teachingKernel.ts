import { z } from 'zod';

const ValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(100),
  z.array(z.string().max(60)).max(12),
]);
const StateSchema = z.record(ValueSchema);
const KeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,35}$/u);
const RuleSchema = z
  .object({
    key: KeySchema,
    label: z.string().min(2).max(80),
    op: z.enum([
      'and',
      'or',
      'not',
      'eq',
      'gte',
      'lte',
      'add',
      'subtract',
      'union',
      'intersection',
      'difference',
      'includes',
      'if',
    ]),
    args: z.array(KeySchema).min(1).max(8),
  })
  .strict();
const ChoiceSchema = z.object({ label: z.string().min(2).max(160), changes: StateSchema }).strict();
const InterventionSchema = z
  .object({
    useTransferRules: z.boolean().optional(),
    context: z.string().min(10).max(500),
    base: StateSchema,
    choices: z.array(ChoiceSchema).length(3),
    desired: z.array(z.boolean()).min(2).max(3),
  })
  .strict();
export const TeachingKernelSchema = z
  .object({
    explanation: z.string().min(40).max(1500),
    whyUseful: z.string().min(15).max(400),
    boundary: z.string().min(20).max(650),
    inputs: z
      .array(z.object({ key: KeySchema, label: z.string().min(2).max(80) }).strict())
      .min(3)
      .max(12),
    rules: z.array(RuleSchema).min(2).max(10),
    goals: z.array(KeySchema).min(2).max(3),
    guided: z
      .object({ context: z.string().min(10).max(500), base: StateSchema, changes: StateSchema })
      .strict(),
    transfer: InterventionSchema.extend({
      extraInputs: z
        .array(z.object({ key: KeySchema, label: z.string().min(2).max(80) }).strict())
        .min(1)
        .max(6),
      extraRules: z.array(RuleSchema).min(1).max(8),
      goals: z.array(KeySchema).min(2).max(3),
      boundaryRule: z.string().min(15).max(400),
    }).strict(),
    diagnosis: z
      .object({
        context: z.string().min(10).max(500),
        base: StateSchema,
        hypotheses: z.array(ChoiceSchema).length(3),
        actual: z.number().int().min(0).max(2),
        probes: z
          .array(ChoiceSchema.extend({ observe: z.array(KeySchema).min(1).max(3).optional() }))
          .length(2),
      })
      .strict(),
    retry: InterventionSchema,
  })
  .strict();
export type TeachingKernel = z.infer<typeof TeachingKernelSchema>;
export type KernelValue = z.infer<typeof ValueSchema>;
export type KernelState = Record<string, KernelValue>;
export type KernelRule = z.infer<typeof RuleSchema>;

function numbers(args: KernelValue[]) {
  if (!args.every((v) => typeof v === 'number')) throw Error('Numeric rule needs numeric inputs.');
  return args as number[];
}
function booleans(args: KernelValue[]) {
  if (!args.every((v) => typeof v === 'boolean')) throw Error('Boolean rule needs boolean inputs.');
  return args as boolean[];
}
function sets(args: KernelValue[]) {
  if (!args.every(Array.isArray)) throw Error('Set rule needs string arrays.');
  return args as string[][];
}
export function evaluateKernel(rules: KernelRule[], state: KernelState): KernelState {
  const values = structuredClone(state);
  for (const rule of rules) {
    if (Object.hasOwn(values, rule.key) || rule.args.some((key) => !Object.hasOwn(values, key)))
      throw Error(`Rule ${rule.key} must reference earlier inputs/rules and have a unique key.`);
    const a = rule.args.map((key) => values[key]!);
    switch (rule.op) {
      case 'and':
        values[rule.key] = booleans(a).every(Boolean);
        break;
      case 'or':
        values[rule.key] = booleans(a).some(Boolean);
        break;
      case 'not':
        if (a.length !== 1) throw Error('not needs one input.');
        values[rule.key] = !booleans(a)[0];
        break;
      case 'eq':
        if (a.length !== 2) throw Error('eq needs two inputs.');
        values[rule.key] =
          JSON.stringify(Array.isArray(a[0]) ? [...new Set(a[0])].sort() : a[0]) ===
          JSON.stringify(Array.isArray(a[1]) ? [...new Set(a[1])].sort() : a[1]);
        break;
      case 'gte':
      case 'lte': {
        if (a.length !== 2) throw Error('comparison needs two inputs.');
        const n = numbers(a);
        values[rule.key] = rule.op === 'gte' ? n[0]! >= n[1]! : n[0]! <= n[1]!;
        break;
      }
      case 'add':
        values[rule.key] = numbers(a).reduce((x, y) => x + y, 0);
        break;
      case 'subtract': {
        if (a.length !== 2) throw Error('subtract needs two inputs.');
        const n = numbers(a);
        values[rule.key] = n[0]! - n[1]!;
        break;
      }
      case 'union':
        values[rule.key] = [...new Set(sets(a).flat())];
        break;
      case 'intersection': {
        const s = sets(a);
        values[rule.key] = s[0]!.filter((v) => s.every((set) => set.includes(v)));
        break;
      }
      case 'difference': {
        if (a.length !== 2) throw Error('difference needs two inputs.');
        const s = sets(a);
        values[rule.key] = s[0]!.filter((v) => !s[1]!.includes(v));
        break;
      }
      case 'includes':
        if (a.length !== 2 || !Array.isArray(a[0]) || typeof a[1] !== 'string')
          throw Error('includes needs a set and one string.');
        values[rule.key] = a[0].includes(a[1]);
        break;
      case 'if':
        if (a.length !== 3 || typeof a[0] !== 'boolean')
          throw Error('if needs a boolean condition and two branch values.');
        values[rule.key] = a[0] ? a[1]! : a[2]!;
        break;
    }
  }
  return values;
}
export function kernelOutcomes(
  rules: KernelRule[],
  state: KernelState,
  goals: string[],
): boolean[] {
  const values = evaluateKernel(rules, state);
  return goals.map((key) => {
    if (typeof values[key] !== 'boolean') throw Error(`Goal ${key} must be a computed boolean.`);
    return values[key] as boolean;
  });
}
export function kernelPatch(state: KernelState, changes: KernelState): KernelState {
  if (Object.keys(changes).some((key) => !(key in state)))
    throw Error('An intervention may change only declared inputs.');
  return { ...state, ...changes };
}
export const outcomeKey = (v: boolean[]) => v.map((x) => (x ? '1' : '0')).join('');
/** Author proposals supply scenarios; local authoring chooses distinct observable interventions. */
export function buildTeachingCases(proposal: TeachingKernel): TeachingKernel {
  const kernel = structuredClone(proposal);
  const offeredValues = new Map<string, Map<string, KernelValue>>();
  for (const state of [
    kernel.guided.base,
    kernel.guided.changes,
    kernel.transfer.base,
    kernel.retry.base,
    kernel.diagnosis.base,
    ...kernel.transfer.choices.map((c) => c.changes),
    ...kernel.retry.choices.map((c) => c.changes),
    ...kernel.diagnosis.hypotheses.map((c) => c.changes),
    ...kernel.diagnosis.probes.map((c) => c.changes),
  ])
    for (const [key, value] of Object.entries(state)) {
      const values = offeredValues.get(key) ?? new Map<string, KernelValue>();
      values.set(JSON.stringify(value), value);
      offeredValues.set(key, values);
    }
  const distinctChoices = (
    scene: TeachingKernel['retry'],
    rules: KernelRule[],
    goals: string[],
  ) => {
    const choices = [
      ...scene.choices,
      { label: '保持当前配置', changes: {} },
      ...Object.keys(scene.base).flatMap((key) =>
        [...(offeredValues.get(key)?.values() ?? [])]
          .filter((value) => JSON.stringify(value) !== JSON.stringify(scene.base[key]))
          .map((value) => ({
            label: `调整${kernel.inputs.find((i) => i.key === key)?.label ?? kernel.transfer.extraInputs.find((i) => i.key === key)?.label}`,
            changes: { [key]: value },
          })),
      ),
    ];
    const atomic = choices.filter((c) => Object.keys(c.changes).length === 1).slice(0, 48);
    for (let i = 0; i < atomic.length; i++)
      for (let j = i + 1; j < atomic.length; j++) {
        const a = atomic[i]!,
          b = atomic[j]!;
        if (Object.keys(a.changes)[0] !== Object.keys(b.changes)[0])
          choices.push({ label: '同时调整两个输入', changes: { ...a.changes, ...b.changes } });
      }
    const seen = new Map<string, (typeof choices)[number]>();
    const isNewBoundary =
      rules.length > kernel.rules.length && goals.length === kernel.goals.length;
    const differs = (choice: (typeof choices)[number], result: string) =>
      isNewBoundary &&
      outcomeKey(
        kernelOutcomes(kernel.rules, kernelPatch(scene.base, choice.changes), kernel.goals),
      ) !== result;
    for (const choice of choices) {
      const key = outcomeKey(kernelOutcomes(rules, kernelPatch(scene.base, choice.changes), goals));
      const current = seen.get(key);
      if (!current || (!differs(current, key) && differs(choice, key))) seen.set(key, choice);
    }
    const distinct = [...seen.values()];
    if (distinct.length >= 3) scene.choices = distinct.slice(0, 3);
  };
  distinctChoices(
    kernel.transfer,
    [...kernel.rules, ...kernel.transfer.extraRules],
    kernel.transfer.goals,
  );
  if (kernel.goals.length === kernel.transfer.goals.length) {
    const original = kernel.transfer.choices.map((c) =>
      outcomeKey(
        kernelOutcomes(kernel.rules, kernelPatch(kernel.transfer.base, c.changes), kernel.goals),
      ),
    );
    const extended = kernel.transfer.choices.map((c) =>
      kernelOutcomes(
        [...kernel.rules, ...kernel.transfer.extraRules],
        kernelPatch(kernel.transfer.base, c.changes),
        kernel.transfer.goals,
      ),
    );
    const strong = extended.find((v, index) => {
      const matching = original.flatMap((o, i) => (o === outcomeKey(v) ? [i] : []));
      return matching.length !== 1 || matching[0] !== index;
    });
    const oldMatches = original.flatMap((o, i) =>
      o === outcomeKey(kernel.transfer.desired) ? [i] : [],
    );
    const winner = extended.findIndex((v) => outcomeKey(v) === outcomeKey(kernel.transfer.desired));
    if (strong && (winner < 0 || (oldMatches.length === 1 && oldMatches[0] === winner))) {
      kernel.transfer.desired = strong;
      kernel.transfer.context =
        '在原机制上叠加一个明确的额外约束。比较备选配置，判断原有条件与新增限制如何共同决定结果。';
    }
  }
  distinctChoices(kernel.retry, kernel.rules, kernel.goals);
  const retryBase = {
    ...kernel.retry.base,
    ...Object.fromEntries(
      kernel.transfer.extraInputs.map((i) => [i.key, kernel.transfer.base[i.key]!]),
    ),
  };
  const extendedRetry: TeachingKernel['retry'] = {
    ...kernel.retry,
    base: retryBase,
    useTransferRules: true,
    context:
      '现在比较另一组配置。沿用下列额外约束，预测各项改动后哪些操作仍可执行；原有规则与新增限制都必须满足。',
  };
  const retryRules = [...kernel.rules, ...kernel.transfer.extraRules];
  distinctChoices(extendedRetry, retryRules, kernel.transfer.goals);
  const retryOutcomes = extendedRetry.choices.map((c) =>
    kernelOutcomes(retryRules, kernelPatch(extendedRetry.base, c.changes), kernel.transfer.goals),
  );
  const retryOld = extendedRetry.choices.map((c) =>
    outcomeKey(
      kernelOutcomes(kernel.rules, kernelPatch(extendedRetry.base, c.changes), kernel.goals),
    ),
  );
  const newTarget = retryOutcomes.find((v, i) => {
    const oldMatches = retryOld.flatMap((o, j) => (o === outcomeKey(v) ? [j] : []));
    return (
      (oldMatches.length !== 1 || oldMatches[0] !== i) &&
      outcomeKey(v) !== outcomeKey(kernel.transfer.desired)
    );
  });
  if (
    newTarget &&
    new Set(retryOutcomes.map(outcomeKey)).size === 3 &&
    JSON.stringify(extendedRetry.base) !== JSON.stringify(kernel.transfer.base)
  ) {
    extendedRetry.desired = newTarget;
    kernel.retry = extendedRetry;
  }
  const probes = [
    ...kernel.diagnosis.probes.map((p) => p.changes),
    {},
    ...kernel.diagnosis.hypotheses.map((h) => h.changes),
    ...Object.entries(kernel.diagnosis.base).map(([key, value]) => ({ [key]: value })),
    ...Object.keys(kernel.diagnosis.base)
      .flatMap((key) =>
        [...(offeredValues.get(key)?.values() ?? [])].map((value) => ({ [key]: value })),
      )
      .slice(0, 64),
  ];
  const usable = probes
    .flatMap((changes) =>
      [kernel.goals, ...kernel.goals.map((goal) => [goal])].map((observe) => ({
        changes,
        observe,
        results: kernel.diagnosis.hypotheses.map((h) =>
          outcomeKey(
            kernelOutcomes(
              kernel.rules,
              kernelPatch(kernelPatch(kernel.diagnosis.base, h.changes), changes),
              observe,
            ),
          ),
        ),
      })),
    )
    .filter((p) => new Set(p.results).size === 2);
  outer: for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++) {
      if (
        new Set(
          kernel.diagnosis.hypotheses.map(
            (_, h) => `${usable[i]!.results[h]}|${usable[j]!.results[h]}`,
          ),
        ).size === 3
      ) {
        kernel.diagnosis.probes = [
          { label: '独立实验一', changes: usable[i]!.changes, observe: usable[i]!.observe },
          { label: '独立实验二', changes: usable[j]!.changes, observe: usable[j]!.observe },
        ];
        const demandingCase = kernel.diagnosis.hypotheses.findIndex((_, h) =>
          [usable[i]!, usable[j]!].every(
            (probe) => probe.results.filter((result) => result === probe.results[h]).length >= 2,
          ),
        );
        if (demandingCase < 0) continue;
        kernel.diagnosis.actual = demandingCase;
        break outer;
      }
    }
  return kernel;
}
export function interventionWinner(
  rules: KernelRule[],
  goals: string[],
  scene: TeachingKernel['retry'],
): number {
  const outcomes = scene.choices.map((choice) =>
    outcomeKey(kernelOutcomes(rules, kernelPatch(scene.base, choice.changes), goals)),
  );
  if (new Set(outcomes).size !== 3)
    throw Error('The three interventions must produce distinct outcome vectors.');
  const matches = outcomes.flatMap((outcome, i) =>
    outcome === outcomeKey(scene.desired) ? [i] : [],
  );
  if (matches.length !== 1)
    throw Error('Exactly one intervention must produce all desired outcomes.');
  return matches[0]!;
}
export function diagnosisSignatures(kernel: TeachingKernel): boolean[][][] {
  return kernel.diagnosis.hypotheses.map((h) =>
    kernel.diagnosis.probes.map((p) =>
      kernelOutcomes(
        kernel.rules,
        kernelPatch(kernelPatch(kernel.diagnosis.base, h.changes), p.changes),
        p.observe ?? kernel.goals,
      ),
    ),
  );
}
export function validateKernel(raw: unknown) {
  const parsed = TeachingKernelSchema.safeParse(raw);
  if (!parsed.success)
    return {
      valid: false,
      diagnostics: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
      diagnosticCodes: ['teaching_kernel_shape'],
    };
  try {
    const k = parsed.data;
    const inputs = k.inputs.map((i) => i.key);
    if (
      new Set(inputs).size !== inputs.length ||
      new Set(k.inputs.map((i) => i.label)).size !== inputs.length
    )
      throw Error('Input keys and labels must be unique.');
    const checkState = (state: KernelState, keys = inputs) => {
      if (Object.keys(state).length !== keys.length || keys.some((key) => !(key in state)))
        throw Error('Every case base must have exactly all declared inputs.');
    };
    checkState(k.guided.base);
    checkState(k.diagnosis.base);
    checkState(
      k.retry.base,
      k.retry.useTransferRules ? [...inputs, ...k.transfer.extraInputs.map((i) => i.key)] : inputs,
    );
    checkState(k.transfer.base, [...inputs, ...k.transfer.extraInputs.map((i) => i.key)]);
    const leaves = new Map(inputs.map((key) => [key, new Set([key])]));
    const ancestors = new Map<string, Set<string>>();
    for (const rule of k.rules) {
      ancestors.set(
        rule.key,
        new Set(rule.args.flatMap((key) => [key, ...(ancestors.get(key) ?? [])])),
      );
      leaves.set(rule.key, new Set(rule.args.flatMap((key) => [...(leaves.get(key) ?? [])])));
    }
    if (k.goals.some((key) => (leaves.get(key)?.size ?? 0) < 2))
      throw Error(
        'Each goal must compare/combine at least two inputs, not copy a supplied boolean.',
      );
    if (
      k.goals.some((goal) =>
        k.goals.some((other) => other !== goal && ancestors.get(other)?.has(goal)),
      )
    )
      throw Error(
        'Goals must be independent final consequences, not an intermediate condition alongside its own resulting outcome. Use two concrete operations or task subgoals.',
      );
    const before = kernelOutcomes(k.rules, k.guided.base, k.goals);
    const after = kernelOutcomes(k.rules, kernelPatch(k.guided.base, k.guided.changes), k.goals);
    if (outcomeKey(before) === outcomeKey(after))
      throw Error('Guided changes must change at least one outcome.');
    interventionWinner(
      k.retry.useTransferRules ? [...k.rules, ...k.transfer.extraRules] : k.rules,
      k.retry.useTransferRules ? k.transfer.goals : k.goals,
      k.retry,
    );
    if (JSON.stringify(k.retry.base) === JSON.stringify(k.guided.base))
      throw Error(
        'Retry must use a new input configuration, not the guided starting state with the same old conclusion.',
      );
    const extended = [...k.rules, ...k.transfer.extraRules];
    if (!k.transfer.goals.some((key) => k.transfer.extraRules.some((r) => r.key === key)))
      throw Error('Transfer must use a new governing rule.');
    const transferWinner = interventionWinner(extended, k.transfer.goals, k.transfer);
    if (k.transfer.goals.length === k.goals.length) {
      const oldWinners = k.transfer.choices.flatMap((choice, i) =>
        outcomeKey(
          kernelOutcomes(k.rules, kernelPatch(k.transfer.base, choice.changes), k.goals),
        ) === outcomeKey(k.transfer.desired)
          ? [i]
          : [],
      );
      if (oldWinners.length === 1 && oldWinners[0] === transferWinner)
        throw Error(
          'Transfer must defeat mechanical reuse: ignoring the new rule currently yields the same unique winning choice. Change the boundary case.',
        );
    }
    const signatures = diagnosisSignatures(k).map((v) => v.map(outcomeKey).join('|'));
    if (new Set(signatures).size !== 3)
      throw Error(
        'The two probes must distinguish all three hypotheses; change the data/probes rather than claiming an unsupported unique cause.',
      );
    const observations = diagnosisSignatures(k);
    if ([0, 1].some((i) => new Set(observations.map((v) => outcomeKey(v[i]!))).size === 3))
      throw Error(
        'Each experiment alone must leave at least two hypotheses possible; only their combined observations should distinguish all three. Do not directly report the hidden input as a goal.',
      );
    if (
      [0, 1].some(
        (i) =>
          observations.filter(
            (v) => outcomeKey(v[i]!) === outcomeKey(observations[k.diagnosis.actual]![i]!),
          ).length < 2,
      )
    )
      throw Error(
        'The actual hidden case must remain ambiguous after either experiment alone, so the learner needs both records.',
      );
    return { valid: true, diagnostics: [], diagnosticCodes: [] };
  } catch (error) {
    return {
      valid: false,
      diagnostics: [error instanceof Error ? error.message : 'Invalid executable teaching model.'],
      diagnosticCodes: ['teaching_kernel_case_inconsistent'],
    };
  }
}
