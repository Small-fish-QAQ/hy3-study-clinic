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

/** Controlled assessment constructs exposed to Curriculum objective design. */
export const FormalAssessmentConstructSchema = z.enum([
  'identify',
  'explain',
  'apply',
  'design',
  'evaluate',
]);
export type FormalAssessmentConstruct = z.infer<typeof FormalAssessmentConstructSchema>;

/** Bounded description of what the current source can support formally. */
export const CurriculumAuthorityEnvelopeTierSchema = z.enum([
  'formal_sufficient',
  'narrower_formal',
  'teaching_only',
  'unavailable',
]);
export type CurriculumAuthorityEnvelopeTier = z.infer<typeof CurriculumAuthorityEnvelopeTierSchema>;

export const CurriculumAuthorityEnvelopeSchema = z
  .object({
    sourceRegionId: z.string().min(1).max(200),
    sourceBlockIds: z.array(z.string().min(1)).max(10_000),
    formalEvidenceIds: z.array(z.string().min(1)).max(100),
    supportedConstructs: z.array(FormalAssessmentConstructSchema).max(5),
    strongestSupportedConstruct: FormalAssessmentConstructSchema.nullable(),
    narrowerClaim: z.string().min(1).max(500).nullable(),
    tier: CurriculumAuthorityEnvelopeTierSchema,
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type CurriculumAuthorityEnvelope = z.infer<typeof CurriculumAuthorityEnvelopeSchema>;

/** Actionable critique used by the one bounded Curriculum authority repair. */
export const CurriculumAuthorityCritiqueSchema = z
  .object({
    objectiveId: z.string().min(1).max(200).nullable(),
    objectiveKey: z.string().min(1).max(100).nullable(),
    currentClaim: z.string().min(1).max(1000),
    affectedSourceRegionIds: z.array(z.string().min(1).max(200)).max(100),
    affectedSourceBlockIds: z.array(z.string().min(1)).max(100),
    authorityTier: CurriculumAuthorityEnvelopeTierSchema,
    supportedConstructs: z.array(FormalAssessmentConstructSchema).max(5),
    narrowerClaim: z.string().min(1).max(500).nullable(),
    reason: z.string().min(1).max(800),
    protectedPriority: z.enum(['required', 'high', 'normal', 'optional']),
  })
  .strict();
export type CurriculumAuthorityCritique = z.infer<typeof CurriculumAuthorityCritiqueSchema>;

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

/** Only an independent validator/operator can create a truth-authority version. */
export const SourceAuthorityValidationActorSchema = z.enum(['local_validator', 'operator']);
export type SourceAuthorityValidationActor = z.infer<typeof SourceAuthorityValidationActorSchema>;

/** System is event-only; it can stale authority but cannot author a record. */
export const SourceAuthorityEventActorSchema = z.enum(['local_validator', 'operator', 'system']);
export type SourceAuthorityEventActor = z.infer<typeof SourceAuthorityEventActorSchema>;

export const SourceAuthorityPolicyBasisSchema = z
  .object({
    policyVersion: z.string().min(1).max(100),
    premiseKind: AuthorityPremiseKindSchema,
    basis: z.string().min(1).max(1000),
  })
  .strict();
export type SourceAuthorityPolicyBasis = z.infer<typeof SourceAuthorityPolicyBasisSchema>;

/**
 * Versioned authority metadata. Exact evidence remains in separate claims so
 * every claim keeps its revision-owned SourceBlock identity and offsets.
 */
export const SourceAuthorityRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    logicalSourceId: z.string().min(1),
    /** Null only after destructive source removal preserved historical audit. */
    materialId: z.string().min(1).nullable(),
    materialRevisionId: z.string().min(1).nullable(),
    version: z.number().int().positive(),
    predecessorId: z.string().min(1).nullable(),
    premiseScope: z.string().min(1).max(500),
    policyBasis: SourceAuthorityPolicyBasisSchema,
    validationState: TruthAuthorityValidationStateSchema,
    conflictState: TruthAuthorityConflictStateSchema,
    actor: SourceAuthorityValidationActorSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if ((record.materialId === null) !== (record.materialRevisionId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materialRevisionId'],
        message: 'material and revision provenance must be present or absent together',
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
export type SourceAuthorityRecord = z.infer<typeof SourceAuthorityRecordSchema>;

export const SourceAuthorityClaimSchema = z
  .object({
    id: z.string().min(1),
    authorityRecordId: z.string().min(1),
    sourceBlockId: z.string().min(1),
    claim: z.string().min(1).max(1000),
    quote: z.string().min(1).max(2000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    occurrenceCount: z.number().int().positive(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((claim) => claim.endOffset > claim.startOffset, {
    path: ['endOffset'],
    message: 'endOffset must be greater than startOffset',
  });
export type SourceAuthorityClaim = z.infer<typeof SourceAuthorityClaimSchema>;

export const SourceAuthorityEventSchema = z
  .object({
    id: z.string().min(1),
    authorityRecordId: z.string().min(1),
    seq: z.number().int().positive(),
    eventType: z.string().min(1).max(100),
    actor: SourceAuthorityEventActorSchema,
    payload: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type SourceAuthorityEvent = z.infer<typeof SourceAuthorityEventSchema>;

export const SourceAuthorityBundleSchema = z
  .object({
    record: SourceAuthorityRecordSchema,
    claims: z.array(SourceAuthorityClaimSchema).max(10),
    events: z.array(SourceAuthorityEventSchema).max(1000),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    bundle.claims.forEach((claim, index) => {
      if (claim.authorityRecordId !== bundle.record.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['claims', index, 'authorityRecordId'],
          message: 'claim belongs to a different authority record',
        });
      }
    });
    bundle.events.forEach((event, index) => {
      if (event.authorityRecordId !== bundle.record.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'authorityRecordId'],
          message: 'event belongs to a different authority record',
        });
      }
    });
  });
export type SourceAuthorityBundle = z.infer<typeof SourceAuthorityBundleSchema>;
