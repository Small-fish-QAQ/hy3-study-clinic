import type { LessonInput } from './courseContract.js';

/** Exact transport aliases only. Unknown identities and all prose remain unchanged. */
export function lessonWire(input: LessonInput) {
  const aliases = new Map<string, string>();
  const add = (values: string[], prefix: string) =>
    [...new Set(values)].forEach((id, i) => aliases.set(id, `${prefix}${i}`));
  add(
    input.knowledge.map((k) => k.id),
    'K',
  );
  add(
    input.lesson.objectives.map((o) => o.id),
    'O',
  );
  add(
    input.sources.map((s) => s.id),
    'S',
  );
  add(
    input.sources.map((s) => s.revisionId),
    'R',
  );
  const original = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const transform = (value: unknown, mapping: Map<string, string>, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => transform(v, mapping, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, transform(item, mapping, name)]),
      );
    if (
      typeof value === 'string' &&
      (key === 'id' || /^(?:knowledgeId|objectiveId|blockId|revisionId)s?$/u.test(key))
    )
      return mapping.get(value) ?? value;
    return value;
  };
  return {
    input: transform(input, aliases),
    materialize: <T>(value: T): T => transform(value, original) as T,
  };
}
