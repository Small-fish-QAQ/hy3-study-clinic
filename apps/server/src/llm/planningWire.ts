import type { PlanInput, PlanRevisionInput } from './courseContract.js';
/** Provider transport only: curriculum identities remain the original server values. */
export function planningWire(input: PlanInput | PlanRevisionInput) {
  const ids = new Set(input.knowledge.map((k) => k.id));
  if ('priorPlans' in input)
    input.priorPlans
      ?.flatMap((p) => p.lessons.flatMap((l) => l.knowledgeIds))
      .forEach((id) => ids.add(id));
  const aliases = new Map([...ids].map((id, i) => [id, `K${i}`]));
  const original = new Map([...aliases].map(([id, short]) => [short, id]));
  const transform = (value: unknown, mapping: Map<string, string>, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => transform(v, mapping, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, transform(item, mapping, name)]),
      );
    if (typeof value === 'string' && (key === 'id' || /knowledgeId|KnowledgeId/iu.test(key)))
      return mapping.get(value) ?? value;
    return value;
  };
  return {
    input: transform(input, aliases),
    materialize: <T>(value: T): T => transform(value, original) as T,
  };
}
