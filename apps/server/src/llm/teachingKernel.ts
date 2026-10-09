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
      'gt',
      'lt',
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

/** Compiled dependencies, unlike accepted Lessons, must follow the current compiler. */
export const COMPUTED_TEACHING_GENERATION_VERSION = 'teaching-kernel-v3-public-choices';

export const kernelValueKey = (value: KernelValue) =>
  JSON.stringify(Array.isArray(value) ? [...new Set(value)].sort() : value);
export const kernelStateKey = (state: KernelState) =>
  JSON.stringify(
    Object.keys(state)
      .sort()
      .map((key) => [key, kernelValueKey(state[key]!)]),
  );

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
      case 'gt':
      case 'lt':
      case 'lte': {
        if (a.length !== 2) throw Error('comparison needs two inputs.');
        const n = numbers(a);
        values[rule.key] =
          rule.op === 'gte'
            ? n[0]! >= n[1]!
            : rule.op === 'lte'
              ? n[0]! <= n[1]!
              : rule.op === 'gt'
                ? n[0]! > n[1]!
                : n[0]! < n[1]!;
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
    if (typeof values[rule.key] === 'number' && !Number.isFinite(values[rule.key]))
      throw Error(`Rule ${rule.key} must produce a finite number.`);
  }
  return values;
}
export function kernelOutcomes(
  rules: KernelRule[],
  state: KernelState,
  goals: string[],
): boolean[] {
  const values = evaluateKernel(rules, state);
  if (new Set(goals).size !== goals.length) throw Error('Computed goals must be unique.');
  return goals.map((key) => {
    if (!rules.some((rule) => rule.key === key) || typeof values[key] !== 'boolean')
      throw Error(`Goal ${key} must be a computed boolean.`);
    return values[key] as boolean;
  });
}
export function kernelPatch(state: KernelState, changes: KernelState): KernelState {
  if (Object.keys(changes).some((key) => !Object.hasOwn(state, key)))
    throw Error('An intervention may change only declared inputs.');
  return { ...state, ...changes };
}
export const outcomeKey = (v: boolean[]) => v.map((x) => (x ? '1' : '0')).join('');
/** Prefer varied cases within the existing bounded pool; answer uniqueness is mandatory. */
export function buildTeachingCases(
  proposal: TeachingKernel,
  diagnosisStates?: KernelState[],
): TeachingKernel {
  if (diagnosisStates && diagnosisStates.length > 4096)
    throw Error('Use at most 4096 enumerated input configurations.');
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
    ...(diagnosisStates ?? []),
  ])
    for (const [key, value] of Object.entries(state)) {
      const values = offeredValues.get(key) ?? new Map<string, KernelValue>();
      values.set(kernelValueKey(value), value);
      offeredValues.set(key, values);
    }
  const selectChoices = (scene: TeachingKernel['retry'], rules: KernelRule[], goals: string[]) => {
    const result = (choice: TeachingKernel['retry']['choices'][number]) =>
      outcomeKey(kernelOutcomes(rules, kernelPatch(scene.base, choice.changes), goals));
    // A valid proposal already owns its requested target and concrete choices.
    if (scene.choices.filter((c) => result(c) === outcomeKey(scene.desired)).length === 1) return;
    const choices = [
      ...scene.choices,
      { label: '保持当前配置', changes: {} },
      ...Object.keys(scene.base).flatMap((key) =>
        [...(offeredValues.get(key)?.values() ?? [])]
          .filter((value) => kernelValueKey(value) !== kernelValueKey(scene.base[key]!))
          .map((value) => ({
            label: `调整${kernel.inputs.find((i) => i.key === key)?.label ?? kernel.transfer.extraInputs.find((i) => i.key === key)?.label}`,
            changes: { [key]: value },
          })),
      ),
    ];
    const atomic = choices.filter((c) => Object.keys(c.changes).length === 1).slice(0, 48);
    for (let i = 0; i < atomic.length; i++)
      for (let j = i + 1; j < atomic.length; j++)
        if (Object.keys(atomic[i]!.changes)[0] !== Object.keys(atomic[j]!.changes)[0])
          choices.push({
            label: '同时调整两个输入',
            changes: { ...atomic[i]!.changes, ...atomic[j]!.changes },
          });
    const configs = new Map<string, (typeof choices)[number]>();
    for (const choice of choices)
      configs.set(kernelStateKey(kernelPatch(scene.base, choice.changes)), choice);
    const winner = [...configs.values()].find((c) => result(c) === outcomeKey(scene.desired));
    const losers = [...configs.values()].filter((c) => result(c) !== outcomeKey(scene.desired));
    if (!winner || losers.length < 2) return; // Final validation reports the material failure.
    const different = losers.find((c) => result(c) !== result(losers[0]!));
    scene.choices = [winner, losers[0]!, different ?? losers[1]!];
  };
  selectChoices(
    kernel.transfer,
    [...kernel.rules, ...kernel.transfer.extraRules],
    kernel.transfer.goals,
  );
  selectChoices(
    kernel.retry,
    kernel.retry.useTransferRules ? [...kernel.rules, ...kernel.transfer.extraRules] : kernel.rules,
    kernel.retry.useTransferRules ? kernel.transfer.goals : kernel.goals,
  );
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
  // Blueprint derivation may choose from its already enumerated configurations.
  // Direct proposals keep their three named hypotheses.
  const candidates =
    diagnosisStates ??
    kernel.diagnosis.hypotheses.map((h) => kernelPatch(kernel.diagnosis.base, h.changes));
  const tested = probes.flatMap((changes) =>
    [kernel.goals, ...kernel.goals.map((goal) => [goal])].map((observe) => ({
      changes,
      observe,
      results: candidates.map((state) =>
        outcomeKey(kernelOutcomes(kernel.rules, kernelPatch(state, changes), observe)),
      ),
    })),
  );
  const usable = [
    ...new Map(
      tested
        .filter((probe) => new Set(probe.results).size >= 2)
        .map((probe) => [JSON.stringify(probe.results), probe]),
    ).values(),
  ];
  type Selection = {
    first: (typeof usable)[number];
    second: (typeof usable)[number];
    indexes: number[];
    actual: number;
  };
  let fallback: Selection | undefined;
  let preferred: Selection | undefined;
  outer: for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++) {
      const first = usable[i]!,
        second = usable[j]!;
      const signatures = new Map<string, number>();
      for (let h = 0; h < candidates.length && signatures.size < 3; h++)
        signatures.set(`${first.results[h]}|${second.results[h]}`, h);
      if (signatures.size !== 3) continue;
      const indexes = [...signatures.values()];
      const actual = indexes.findIndex((h) =>
        [first, second].every(
          (probe) => indexes.filter((n) => probe.results[n] === probe.results[h]).length >= 2,
        ),
      );
      const selection = { first, second, indexes, actual: actual < 0 ? 0 : actual };
      fallback ??= selection;
      if (actual >= 0) {
        preferred = selection;
        break outer;
      }
    }
  const selected = preferred ?? fallback;
  if (selected) {
    if (diagnosisStates)
      kernel.diagnosis.hypotheses = selected.indexes.map((h, i) => ({
        label: `候选配置${['甲', '乙', '丙'][i]}`,
        changes: Object.fromEntries(
          Object.entries(candidates[h]!).filter(
            ([key, value]) => kernelValueKey(value) !== kernelValueKey(kernel.diagnosis.base[key]!),
          ),
        ),
      }));
    kernel.diagnosis.probes = [
      { label: '独立实验一', changes: selected.first.changes, observe: selected.first.observe },
      { label: '独立实验二', changes: selected.second.changes, observe: selected.second.observe },
    ];
    kernel.diagnosis.actual = selected.actual;
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
  if (scene.desired.length !== goals.length)
    throw Error('Desired outcomes must cover exactly the computed goals.');
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
    const extendedInputs = [...inputs, ...k.transfer.extraInputs.map((i) => i.key)];
    if (
      new Set(extendedInputs).size !== extendedInputs.length ||
      new Set(k.inputs.map((i) => i.label)).size !== inputs.length
    )
      throw Error('Input keys and labels must be unique.');
    const checkState = (state: KernelState, keys = inputs) => {
      if (
        Object.keys(state).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(state, key))
      )
        throw Error('Every case base must have exactly all declared inputs.');
    };
    checkState(k.guided.base);
    checkState(k.diagnosis.base);
    checkState(k.retry.base, k.retry.useTransferRules ? extendedInputs : inputs);
    checkState(k.transfer.base, extendedInputs);
    kernelOutcomes(k.rules, k.guided.base, k.goals);
    kernelOutcomes(k.rules, kernelPatch(k.guided.base, k.guided.changes), k.goals);
    interventionWinner(
      k.retry.useTransferRules ? [...k.rules, ...k.transfer.extraRules] : k.rules,
      k.retry.useTransferRules ? k.transfer.goals : k.goals,
      k.retry,
    );
    const extended = [...k.rules, ...k.transfer.extraRules];
    kernelOutcomes(extended, k.transfer.base, k.transfer.goals);
    interventionWinner(extended, k.transfer.goals, k.transfer);
    for (const hypothesis of k.diagnosis.hypotheses)
      kernelOutcomes(k.rules, kernelPatch(k.diagnosis.base, hypothesis.changes), k.goals);
    const signatures = diagnosisSignatures(k).map((v) => v.map(outcomeKey).join('|'));
    if (new Set(signatures).size !== 3)
      throw Error(
        'The two probes must distinguish all three hypotheses; change the data/probes rather than claiming an unsupported unique cause.',
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
