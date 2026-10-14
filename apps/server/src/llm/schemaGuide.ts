import { z } from 'zod';

/** Closed JSON-schema subset used by the course output contracts. */
export function schemaGuide(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber)
    return {
      type: schema.isInt ? 'integer' : 'number',
      ...(schema.minValue === null ? {} : { minimum: schema.minValue }),
      ...(schema.maxValue === null ? {} : { maximum: schema.maxValue }),
    };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodArray)
    return {
      type: 'array',
      items: schemaGuide(schema.element),
      ...(schema._def.minLength ? { minItems: schema._def.minLength.value } : {}),
    };
  if (schema instanceof z.ZodNullable)
    return { anyOf: [schemaGuide(schema.unwrap()), { type: 'null' }] };
  if (schema instanceof z.ZodOptional) return schemaGuide(schema.unwrap());
  if (schema instanceof z.ZodDefault) return schemaGuide(schema.removeDefault());
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return {
      type: 'object',
      additionalProperties: false,
      required: Object.entries(shape)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k),
      properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, schemaGuide(v)])),
    };
  }
  if (schema instanceof z.ZodUnion) return { anyOf: schema.options.map(schemaGuide) };
  throw new Error('Unsupported course output schema.');
}
