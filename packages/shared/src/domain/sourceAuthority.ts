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

/** What kind of truth authority an objective's successful completion requires. */
export const CurriculumSubjectClassSchema = z.enum(['source_specific', 'general']);
export type CurriculumSubjectClass = z.infer<typeof CurriculumSubjectClassSchema>;

/** Why an objective belongs in this learner's Course scope. */
export const CurriculumScopeOriginSchema = z.enum(['anchored', 'supplemental']);
export type CurriculumScopeOrigin = z.infer<typeof CurriculumScopeOriginSchema>;

export function isForbiddenCurriculumObjectiveClassification(classification: {
  subjectClass: CurriculumSubjectClass;
  scopeOrigin: CurriculumScopeOrigin;
}): boolean {
  return (
    classification.subjectClass === 'source_specific' &&
    classification.scopeOrigin === 'supplemental'
  );
}

/**
 * Shared TEACHING construct vocabulary. A Course may legitimately teach or
 * discuss any of these, and accepted history may contain any of them.
 *
 * This is deliberately wider than what Formal assessment can certify: see
 * `FormalSupportedConstructSchema`. Teaching vocabulary is not assessment
 * authority, and this enum must never be read as the latter.
 */
export const FormalAssessmentConstructSchema = z.enum([
  'identify',
  'explain',
  'apply',
  'design',
  'evaluate',
]);
export type FormalAssessmentConstruct = z.infer<typeof FormalAssessmentConstructSchema>;

/**
 * The constructs the deterministic Formal lane can actually support.
 *
 * Membership is not a preference: each of these has a local evidence predicate
 * that can decide it from exact source authority - `identify` from any
 * validated formal claim, `explain` from an explanation-shaped claim or a
 * paired procedure, `apply` from a paired procedure claim. `design` and
 * `evaluate` have no such predicate, so nothing can honestly certify them, and
 * they remain teaching-only until one exists.
 */
export const FORMAL_SUPPORTED_CONSTRUCTS = ['identify', 'explain', 'apply'] as const;
export const FormalSupportedConstructSchema = z.enum(FORMAL_SUPPORTED_CONSTRUCTS);
export type FormalSupportedConstruct = z.infer<typeof FormalSupportedConstructSchema>;

/** Teaching constructs that exist for teaching only and carry no Formal authority. */
export type TeachingOnlyConstruct = Exclude<FormalAssessmentConstruct, FormalSupportedConstruct>;

/** Whether a shared teaching construct crosses into Formal-authority territory. */
export const ConstructAuthorityClassSchema = z.enum(['formal_supported', 'teaching_only']);
export type ConstructAuthorityClass = z.infer<typeof ConstructAuthorityClassSchema>;

export function isFormalSupportedConstruct(
  construct: FormalAssessmentConstruct,
): construct is FormalSupportedConstruct {
  return (FORMAL_SUPPORTED_CONSTRUCTS as readonly FormalAssessmentConstruct[]).includes(construct);
}

/**
 * The single local classification of a shared teaching construct. Every site
 * that crosses the teaching/Formal boundary reads this rather than re-deriving
 * its own list, so widening Formal authority is one edit and one mutation.
 */
export function classifyConstructAuthority(
  construct: FormalAssessmentConstruct,
): ConstructAuthorityClass {
  return isFormalSupportedConstruct(construct) ? 'formal_supported' : 'teaching_only';
}

/**
 * Whether an objective's construct may claim the `application` rung of the
 * evidence-demand ladder for Formal evidence.
 *
 * Two independent conditions, deliberately not collapsed: the construct must be
 * Formal-supported at all, and among the supported constructs only `apply`
 * denotes application-level performance. `design`/`evaluate` name harder
 * teaching ambitions that no local predicate can certify, so evidence produced
 * for one of them must not be recorded as application-level - otherwise
 * teaching vocabulary alone would satisfy the durable-mastery application
 * demand with no Formal authority behind it.
 */
export function supportsFormalApplicationDemand(
  construct: FormalAssessmentConstruct | null,
): boolean {
  if (construct === null || !isFormalSupportedConstruct(construct)) return false;
  return construct === 'apply';
}

/** Bounded description of what the current source can support formally. */
export const CurriculumAuthorityEnvelopeTierSchema = z.enum([
  'formal_sufficient',
  'narrower_formal',
  'teaching_only',
  'unavailable',
]);
export type CurriculumAuthorityEnvelopeTier = z.infer<typeof CurriculumAuthorityEnvelopeTierSchema>;

/**
 * What the current source can support formally.
 *
 * `supportedConstructs` is the Formal-authority carrier, so it is typed to the
 * NARROW vocabulary: no envelope can express `design`/`evaluate` even if a
 * caller tries, which makes widening Formal authority a schema failure rather
 * than a silent behaviour change. The envelope is built fresh per operation and
 * is never persisted, so this narrowing has no historical readability cost.
 */
export const CurriculumAuthorityEnvelopeSchema = z
  .object({
    sourceRegionId: z.string().min(1).max(200),
    sourceBlockIds: z.array(z.string().min(1)).max(10_000),
    formalEvidenceIds: z.array(z.string().min(1)).max(100),
    supportedConstructs: z.array(FormalSupportedConstructSchema).max(3),
    strongestSupportedConstruct: FormalSupportedConstructSchema.nullable(),
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
