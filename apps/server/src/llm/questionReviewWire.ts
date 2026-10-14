import type { SolveInput, RubricReviewInput } from './courseContract.js';

/** Exact transport aliases only; never guess a misspelled identity or infer coverage. */
export function questionReviewWire(input: SolveInput | RubricReviewInput) {
  const aliases = new Map<string, string>();
  input.requestedKnowledge.forEach((k, i) => aliases.set(k.id, `K${i}`));
  input.expectedObjectives?.forEach((o, i) => aliases.set(o.id, `O${i}`));
  const original = new Map([...aliases].map(([id, short]) => [short, id]));
  const transform = (value: unknown, mapping: Map<string, string>, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => transform(v, mapping, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, transform(item, mapping, name)]),
      );
    if (typeof value === 'string' && (key === 'id' || /knowledgeId|objectiveId/iu.test(key)))
      return mapping.get(value) ?? value;
    return value;
  };
  return {
    input: transform(input, aliases),
    materialize: <T>(value: T): T => transform(value, original) as T,
  };
}
