import { z } from 'zod';
import { ScopeAuthorityStatusSchema, TruthPremiseStatusSchema } from './sourceAuthority.js';

export const CoverageRiskFacetSchema = z.enum([
  'present_in_course_material',
  'structurally_mapped',
  'included_in_curriculum',
  'observed_in_supplied_exam',
  'formally_taught',
  'formally_assessed',
  'ai_suggested_supplement',
  'prerequisite_risk',
  'representation_variant_risk',
  'transfer_integration_risk',
  'adversarial_blind_spot_candidate',
  'unresolved_unverified_risk',
  'intentionally_deferred',
]);
export type CoverageRiskFacet = z.infer<typeof CoverageRiskFacetSchema>;

export const CoverageRiskStatusSchema = z.enum([
  'open',
  'acknowledged',
  'planned',
  'checking',
  'resolved',
  'rejected',
  'deferred',
  'stale',
]);
export type CoverageRiskStatus = z.infer<typeof CoverageRiskStatusSchema>;

export const CoverageRiskOriginSchema = z.enum([
  'deterministic',
  'source',
  'learner',
  'exam_observation',
  'model_candidate',
]);
export type CoverageRiskOrigin = z.infer<typeof CoverageRiskOriginSchema>;

export const CoverageRiskObservationSchema = z
  .object({
    id: z.string().min(1),
    materialRevisionId: z.string().min(1).nullable(),
    sourceBlockId: z.string().min(1).nullable(),
    sourceBlockRevisionFingerprint: z.string().min(1).max(200).nullable(),
    executionSourceManifestFingerprint: z.string().min(1).max(200).nullable(),
    reconciliationStatus: z.enum(['current', 'pending', 'stale', 'reconciled']),
    observedAt: z.string().datetime(),
    lastVerifiedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CoverageRiskObservation = z.infer<typeof CoverageRiskObservationSchema>;

/** Stable concern plus append-only revision-bound observations. */
export const CoverageRiskEntrySchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    stableScopeFingerprint: z.string().min(1).max(200),
    materialId: z.string().min(1).nullable(),
    topicId: z.string().min(1).nullable(),
    objectiveId: z.string().min(1).nullable(),
    facets: z.array(CoverageRiskFacetSchema).min(1).max(20),
    scopeAuthorityStatus: ScopeAuthorityStatusSchema,
    truthPremiseStatus: TruthPremiseStatusSchema,
    truthAuthorityRecordIds: z.array(z.string().min(1)).max(20),
    referencedCurriculumNodeIds: z.array(z.string().min(1)).max(50),
    referencedConceptIds: z.array(z.string().min(1)).max(50),
    referencedEvidenceIds: z.array(z.string().min(1)).max(50),
    origin: CoverageRiskOriginSchema,
    status: CoverageRiskStatusSchema,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    priority: z.number().int().min(0).max(100),
    contractSensitive: z.boolean(),
    claim: z.string().min(1).max(1000),
    uncertainty: z.string().min(1).max(1000),
    observations: z.array(CoverageRiskObservationSchema).max(1000),
    resolutionEvidenceIds: z.array(z.string().min(1)).max(100),
    learnerDecisionId: z.string().min(1).nullable(),
    provider: z.string().max(40).nullable(),
    providerModel: z.string().max(120).nullable(),
    promptVersion: z.string().max(100).nullable(),
    firstObservedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((risk, ctx) => {
    if (
      risk.truthPremiseStatus === 'independently_verified' &&
      risk.truthAuthorityRecordIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truthAuthorityRecordIds'],
        message: 'verified risk premises require independent authority records',
      });
    }
  });
export type CoverageRiskEntry = z.infer<typeof CoverageRiskEntrySchema>;

/** Bounded learner-visible projection used on Course Home. */
export const CoverageRiskHighlightSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1).max(1000),
    uncertainty: z.string().min(1).max(1000),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    status: CoverageRiskStatusSchema,
    facets: z.array(CoverageRiskFacetSchema).min(1).max(20),
    scopeAuthorityStatus: ScopeAuthorityStatusSchema,
    truthPremiseStatus: TruthPremiseStatusSchema,
    materialId: z.string().min(1).nullable(),
    curriculumNodeId: z.string().min(1).nullable(),
    isCurrent: z.boolean(),
  })
  .strict();
export type CoverageRiskHighlight = z.infer<typeof CoverageRiskHighlightSchema>;

export const CoverageRiskSummarySchema = z
  .object({
    openCount: z.number().int().nonnegative(),
    deferredCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
    highestOpenSeverity: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
    deterministicMappingGapCount: z.number().int().nonnegative(),
    explicitDeferralCount: z.number().int().nonnegative(),
    highlights: z.array(CoverageRiskHighlightSchema).max(20),
    analysisState: z.enum(['available', 'stale', 'unavailable']),
    computedAt: z.string().datetime(),
  })
  .strict();
export type CoverageRiskSummary = z.infer<typeof CoverageRiskSummarySchema>;

export const CoverageRiskHistoryViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200).nullable(),
    entries: z.array(CoverageRiskEntrySchema).max(2000),
    summary: CoverageRiskSummarySchema,
  })
  .strict();
export type CoverageRiskHistoryView = z.infer<typeof CoverageRiskHistoryViewSchema>;
