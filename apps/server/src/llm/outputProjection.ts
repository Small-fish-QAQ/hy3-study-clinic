import type { z } from 'zod';

/** Ignore unsupported annotations only; missing/invalid contract values remain failures. */
export function projectModelOutput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  candidate: unknown,
) {
  let parsed = schema.safeParse(candidate);
  const discardedPaths: string[] = [];
  if (!parsed.success && parsed.error.issues.every((issue) => issue.code === 'unrecognized_keys')) {
    const projected = structuredClone(candidate);
    for (const issue of parsed.error.issues) {
      if (issue.code !== 'unrecognized_keys') continue;
      let object = projected as Record<string | number, unknown>;
      for (const part of issue.path) object = object[part] as Record<string | number, unknown>;
      for (const key of issue.keys) {
        delete object[key];
        discardedPaths.push([...issue.path, key].join('.'));
      }
    }
    parsed = schema.safeParse(projected);
  }
  return { parsed, discardedPaths };
}
