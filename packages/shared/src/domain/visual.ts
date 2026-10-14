import { z } from 'zod';
/** Bounded image transport is a resource contract, never teaching authority. */
export const VisualMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type VisualMediaType = z.infer<typeof VisualMediaTypeSchema>;
export const VisualTransportSchema = z
  .object({
    mediaType: VisualMediaTypeSchema,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    transformation: z.enum(['validated_original', 'auto_orient_resize_transcode']),
    preparationVersion: z.string().min(1).max(80),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();
export type VisualTransport = z.infer<typeof VisualTransportSchema>;
