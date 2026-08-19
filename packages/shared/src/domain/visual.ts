import { z } from 'zod';

export const VisualMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type VisualMediaType = z.infer<typeof VisualMediaTypeSchema>;

export const VisualTypeSchema = z.enum([
  'photo',
  'diagram',
  'chart',
  'screenshot',
  'text_heavy',
  'illustration',
  'other',
]);
export type VisualType = z.infer<typeof VisualTypeSchema>;

/** Semantic output only. Persistent source identity is always attached locally. */
export const VisualDescriptionPayloadSchema = z
  .object({
    description: z.string().trim().min(1).max(1200),
    visualType: VisualTypeSchema,
    visibleText: z.string().trim().min(1).max(2000).nullable(),
    importantConcepts: z.array(z.string().trim().min(1).max(120)).max(12),
    pedagogicalNotes: z.array(z.string().trim().min(1).max(400)).max(6),
    uncertainty: z.array(z.string().trim().min(1).max(300)).max(6),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const normalized = payload.importantConcepts.map((value) =>
      value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim(),
    );
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['importantConcepts'],
        message: 'important visual concepts must be unique after normalization',
      });
    }
  });
export type VisualDescriptionPayload = z.infer<typeof VisualDescriptionPayloadSchema>;

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

/** Immutable accepted derivation bound to one exact original asset occurrence. */
export const VisualDerivationSchema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    assetId: z.string().min(1),
    assetByteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    identityFingerprint: z.string().regex(/^visual_derivation_[0-9a-f]{64}$/u),
    semanticIdentityFingerprint: z.string().regex(/^visual_semantic_[0-9a-f]{64}$/u),
    derivationKind: z.literal('visual_description'),
    contentOrigin: z.literal('derived_visual_description'),
    authority: z.literal('derived'),
    evidenceAdmissibility: z.literal('advisory_nonblocking'),
    validationStatus: z.literal('accepted'),
    generatorIdentity: z.literal('provider_visual_description'),
    generatorVersion: z.string().min(1).max(80),
    provider: z.enum(['fake', 'hy3', 'tokenhub']),
    providerModel: z.string().min(1).max(120).nullable(),
    providerEndpointIdentity: z.string().min(1).max(120),
    providerRuntimeIdentity: z.string().min(1).max(160),
    configurationFingerprint: z.string().min(1).max(200),
    contextMode: z.literal('image_only'),
    contextFingerprint: z.null(),
    transport: VisualTransportSchema,
    payload: VisualDescriptionPayloadSchema,
    reusedFromDerivationId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type VisualDerivation = z.infer<typeof VisualDerivationSchema>;

export const VisualPreparationStateSchema = z.enum([
  'missing',
  'preparing',
  'ready',
  'failed',
  'stale',
]);
export type VisualPreparationState = z.infer<typeof VisualPreparationStateSchema>;

/** Learner-safe projection: no database ids, hashes, provider payloads, or diagnostics. */
export const VisualSourceProjectionSchema = z
  .object({
    visualRef: z.string().regex(/^visual_[0-9a-f]{24}$/u),
    sourceKind: z.enum(['standalone', 'embedded']),
    mediaType: VisualMediaTypeSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    location: z
      .object({
        pageNumber: z.number().int().positive().nullable(),
        slideNumber: z.number().int().positive().nullable(),
        contextLabel: z.string().min(1).max(300),
      })
      .strict(),
    sourceAuthority: z.literal('original_visual'),
    preparation: z
      .object({
        state: VisualPreparationStateSchema,
        retryable: z.boolean(),
        descriptionAvailable: z.boolean(),
        ocrTextAvailable: z.literal(false),
      })
      .strict(),
    description: z
      .object({
        text: z.string().min(1).max(1200),
        visualType: VisualTypeSchema,
        importantConcepts: z.array(z.string().min(1).max(120)).max(12),
        pedagogicalNotes: z.array(z.string().min(1).max(400)).max(6),
        uncertainty: z.array(z.string().min(1).max(300)).max(6),
        provenanceCategory: z.literal('generated_visual_explanation'),
        authority: z.literal('advisory'),
        createdAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type VisualSourceProjection = z.infer<typeof VisualSourceProjectionSchema>;

/**
 * Bounded downstream teaching context. The original visual and Hy3's
 * explanation remain separate so the explanation cannot masquerade as
 * quoted course text or formal evidence.
 */
export const VisualAdvisoryContextSchema = z
  .object({
    referenceKey: z.string().regex(/^V[1-9][0-9]*$/u),
    materialTitle: z.string().min(1).max(500),
    source: z
      .object({
        sourceKind: z.enum(['standalone', 'embedded']),
        mediaType: VisualMediaTypeSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        location: z
          .object({
            pageNumber: z.number().int().positive().nullable(),
            slideNumber: z.number().int().positive().nullable(),
            contextLabel: z.string().min(1).max(300),
          })
          .strict(),
        authority: z.literal('original_visual'),
      })
      .strict(),
    explanation: z
      .object({
        text: z.string().min(1).max(1200),
        visualType: VisualTypeSchema,
        importantConcepts: z.array(z.string().min(1).max(120)).max(12),
        pedagogicalNotes: z.array(z.string().min(1).max(400)).max(6),
        uncertainty: z.array(z.string().min(1).max(300)).max(6),
        contentOrigin: z.literal('derived_visual_description'),
        provenanceCategory: z.literal('generated_visual_explanation'),
        authority: z.literal('advisory'),
        evidenceAdmissibility: z.literal('advisory_nonblocking'),
        formalEvidenceEligible: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type VisualAdvisoryContext = z.infer<typeof VisualAdvisoryContextSchema>;

export const VisualPreparationRequestSchema = z
  .object({
    commandId: z.string().min(1).max(120),
    confirmedCostPolicyIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();
export type VisualPreparationRequest = z.infer<typeof VisualPreparationRequestSchema>;

export const VisualPreparationResponseSchema = z
  .object({
    status: z.enum(['prepared', 'reused']),
    visual: VisualSourceProjectionSchema,
  })
  .strict();
export type VisualPreparationResponse = z.infer<typeof VisualPreparationResponseSchema>;
