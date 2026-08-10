import { z } from 'zod';

/** Learner authority over intended study scope, independent of factual truth. */
export const ScopeAuthorityStatusSchema = z.enum(['in_scope', 'out_of_scope', 'pending']);
export type ScopeAuthorityStatus = z.infer<typeof ScopeAuthorityStatusSchema>;

/** Independent truth/assessment-premise state. */
export const TruthPremiseStatusSchema = z.enum([
  'independently_verified',
  'unverified',
  'conflicted',
  'not_applicable',
]);
export type TruthPremiseStatus = z.infer<typeof TruthPremiseStatusSchema>;

export const EvidenceAdmissibilityTierSchema = z.enum([
  'tier_1_authorized_truth',
  'tier_2_validated_representation',
  'tier_3_advisory',
]);
export type EvidenceAdmissibilityTier = z.infer<typeof EvidenceAdmissibilityTierSchema>;

export function isStateCreditingAdmissibility(tier: EvidenceAdmissibilityTier): boolean {
  return tier === 'tier_1_authorized_truth' || tier === 'tier_2_validated_representation';
}

export const AuthorityPremiseKindSchema = z.enum([
  'claim',
  'definition',
  'expected_answer',
  'rubric_point',
  'notation',
  'representation_equivalence',
  'source_stated_boundary',
]);
export type AuthorityPremiseKind = z.infer<typeof AuthorityPremiseKindSchema>;

export const TruthAuthorityValidationStateSchema = z.enum([
  'candidate',
  'validated',
  'rejected',
  'stale',
]);
export type TruthAuthorityValidationState = z.infer<typeof TruthAuthorityValidationStateSchema>;

export const TruthAuthorityConflictStateSchema = z.enum(['none', 'unresolved', 'resolved']);
export type TruthAuthorityConflictState = z.infer<typeof TruthAuthorityConflictStateSchema>;

/** Exact immutable provenance of one admitted factual or assessment premise. */
export const AuthorityPremiseProvenanceSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sourceBlockId: z.string().min(1),
    sourceBlockRevisionFingerprint: z.string().min(1).max(200),
    quote: z.string().min(1).max(2000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    /** The bounded claim this evidence is permitted to support. */
    admittedClaim: z.string().min(1).max(1000),
  })
  .strict()
  .refine((value) => value.endOffset > value.startOffset, {
    path: ['endOffset'],
    message: 'endOffset must be greater than startOffset',
  });
export type AuthorityPremiseProvenance = z.infer<typeof AuthorityPremiseProvenanceSchema>;

/**
 * Versioned authority is created only by an independent validation process.
 * No Contract, Curriculum, or Plan acceptance command creates this record.
 */
export const TruthAuthorityRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    logicalSourceId: z.string().min(1),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    premiseKind: AuthorityPremiseKindSchema,
    premiseScope: z.string().min(1).max(500),
    policyVersion: z.string().min(1).max(100),
    basis: z.string().min(1).max(1000),
    validationState: TruthAuthorityValidationStateSchema,
    conflictState: TruthAuthorityConflictStateSchema,
    provenance: z.array(AuthorityPremiseProvenanceSchema).min(1).max(10),
    actor: z.enum(['local_validator', 'operator', 'learner_source_selection']),
    createdAt: z.string().datetime(),
    validatedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.validationState === 'validated' && !record.validatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validatedAt'],
        message: 'validated authority requires validation time',
      });
    }
    if (record.conflictState === 'unresolved' && record.validationState === 'validated') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conflictState'],
        message: 'an unresolved conflict cannot authorize a blocking premise',
      });
    }
  });
export type TruthAuthorityRecord = z.infer<typeof TruthAuthorityRecordSchema>;
