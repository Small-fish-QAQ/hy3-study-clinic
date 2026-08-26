import { z } from 'zod';
import {
  AuthorityPremiseKindSchema,
  CurriculumScopeOriginSchema,
  CurriculumSubjectClassSchema,
  FormalAssessmentConstructSchema,
  isForbiddenCurriculumObjectiveClassification,
} from './sourceAuthority.js';

function requireUniqueIdentityValues(
  values: readonly string[],
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message,
    });
  }
}

export const ObjectiveAuthoritySupportTypeSchema = z.enum([
  'recognition',
  'discrimination',
  'definition',
  'relationship',
  'mechanism',
  'reason',
  'consequence',
  'comparison',
  'positioning',
  'procedure',
  'decision_rule',
  'condition',
  'state_transition',
  'qualification',
]);
export type ObjectiveAuthoritySupportType = z.infer<typeof ObjectiveAuthoritySupportTypeSchema>;

export const ObjectiveAuthorityFragmentStatusSchema = z.enum([
  'supported',
  'unsupported',
  'conflicted',
]);
export type ObjectiveAuthorityFragmentStatus = z.infer<
  typeof ObjectiveAuthorityFragmentStatusSchema
>;

export const ObjectiveAuthoritySemanticConflictKindSchema = z.enum([
  'contradiction',
  'scope_mismatch',
  'construct_mismatch',
]);
export type ObjectiveAuthoritySemanticConflictKind = z.infer<
  typeof ObjectiveAuthoritySemanticConflictKindSchema
>;

export const ObjectiveAuthoritySemanticOverreachKindSchema = z.enum([
  'unsupported_generalization',
  'unsupported_causality',
  'unsupported_transfer',
  'unsupported_capability',
]);
export type ObjectiveAuthoritySemanticOverreachKind = z.infer<
  typeof ObjectiveAuthoritySemanticOverreachKindSchema
>;

export const ObjectiveAuthoritySemanticEvidenceOfferSchema = z
  .object({
    evidenceRef: z.string().min(1).max(100),
    text: z.string().min(1).max(20_000),
    claimKinds: z.array(AuthorityPremiseKindSchema).min(1).max(20),
    headingPath: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
export type ObjectiveAuthoritySemanticEvidenceOffer = z.infer<
  typeof ObjectiveAuthoritySemanticEvidenceOfferSchema
>;

export const ObjectiveAuthorityRequiredCapabilityFragmentSchema = z
  .object({
    fragmentId: z.string().min(1).max(100),
    text: z.string().min(1).max(1_500),
  })
  .strict();
export type ObjectiveAuthorityRequiredCapabilityFragment = z.infer<
  typeof ObjectiveAuthorityRequiredCapabilityFragmentSchema
>;

/**
 * Original failed-objective meaning that a fresh post-repair evaluator must
 * preserve. This is local input, not a repair-provider assertion.
 */
export const ObjectiveAuthorityRequiredCapabilityPreservationSchema = z
  .object({
    originalProposition: z.string().min(1).max(1_500),
    originalFragments: z.array(ObjectiveAuthorityRequiredCapabilityFragmentSchema).min(1).max(64),
  })
  .strict()
  .superRefine((requirement, ctx) => {
    const fragmentIds = requirement.originalFragments.map((fragment) => fragment.fragmentId);
    if (new Set(fragmentIds).size !== fragmentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originalFragments'],
        message: 'required original capability fragment identities must be unique',
      });
    }
    if (
      requirement.originalFragments.map((fragment) => fragment.text).join('') !==
      requirement.originalProposition
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originalFragments'],
        message:
          'required original capability fragments must exactly partition the original proposition',
      });
    }
  });
export type ObjectiveAuthorityRequiredCapabilityPreservation = z.infer<
  typeof ObjectiveAuthorityRequiredCapabilityPreservationSchema
>;

export const ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema = z
  .object({
    objectiveRef: z.string().min(1).max(100),
    proposition: z.string().min(1).max(1_500),
    construct: FormalAssessmentConstructSchema,
    evidence: z.array(ObjectiveAuthoritySemanticEvidenceOfferSchema).max(32),
    requiredCapabilityPreservation:
      ObjectiveAuthorityRequiredCapabilityPreservationSchema.optional(),
  })
  .strict()
  .superRefine((objective, ctx) => {
    const evidenceRefs = objective.evidence.map((offer) => offer.evidenceRef);
    if (new Set(evidenceRefs).size !== evidenceRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'semantic evaluation evidence references must be unique per objective',
      });
    }
  });
export type ObjectiveAuthoritySemanticEvaluationObjectiveInput = z.infer<
  typeof ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema
>;

export const ObjectiveAuthoritySemanticEvaluationInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    objectives: z.array(ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema).min(1).max(24),
  })
  .strict()
  .superRefine((input, ctx) => {
    const objectiveRefs = input.objectives.map((objective) => objective.objectiveRef);
    if (new Set(objectiveRefs).size !== objectiveRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectives'],
        message: 'semantic evaluation objective references must be unique',
      });
    }
  });
export type ObjectiveAuthoritySemanticEvaluationInput = z.infer<
  typeof ObjectiveAuthoritySemanticEvaluationInputSchema
>;

export const ObjectiveAuthoritySemanticFragmentProposalSchema = z
  .object({
    fragmentId: z.string().min(1).max(100),
    text: z.string().min(1).max(1_500),
    status: ObjectiveAuthorityFragmentStatusSchema,
    supportType: ObjectiveAuthoritySupportTypeSchema.nullable(),
    evidenceRefs: z.array(z.string().min(1).max(100)).max(32),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((fragment, ctx) => {
    if (new Set(fragment.evidenceRefs).size !== fragment.evidenceRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceRefs'],
        message: 'semantic support evidence references must be unique',
      });
    }
    if (
      fragment.status === 'supported' &&
      (fragment.supportType === null || fragment.evidenceRefs.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'supported fragments require a support type and at least one evidence reference',
      });
    }
  });
export type ObjectiveAuthoritySemanticFragmentProposal = z.infer<
  typeof ObjectiveAuthoritySemanticFragmentProposalSchema
>;

export const ObjectiveAuthoritySemanticConflictProposalSchema = z
  .object({
    kind: ObjectiveAuthoritySemanticConflictKindSchema,
    fragmentIds: z.array(z.string().min(1).max(100)).min(1).max(24),
    evidenceRefs: z.array(z.string().min(1).max(100)).max(32),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((conflict, ctx) => {
    requireUniqueIdentityValues(
      conflict.fragmentIds,
      ctx,
      ['fragmentIds'],
      'semantic conflict fragment identities must be unique',
    );
    requireUniqueIdentityValues(
      conflict.evidenceRefs,
      ctx,
      ['evidenceRefs'],
      'semantic conflict evidence references must be unique',
    );
  });
export type ObjectiveAuthoritySemanticConflictProposal = z.infer<
  typeof ObjectiveAuthoritySemanticConflictProposalSchema
>;

export const ObjectiveAuthoritySemanticOverreachProposalSchema = z
  .object({
    kind: ObjectiveAuthoritySemanticOverreachKindSchema,
    fragmentIds: z.array(z.string().min(1).max(100)).min(1).max(24),
    evidenceRefs: z.array(z.string().min(1).max(100)).max(32),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((overreach, ctx) => {
    requireUniqueIdentityValues(
      overreach.fragmentIds,
      ctx,
      ['fragmentIds'],
      'semantic overreach fragment identities must be unique',
    );
    requireUniqueIdentityValues(
      overreach.evidenceRefs,
      ctx,
      ['evidenceRefs'],
      'semantic overreach evidence references must be unique',
    );
  });
export type ObjectiveAuthoritySemanticOverreachProposal = z.infer<
  typeof ObjectiveAuthoritySemanticOverreachProposalSchema
>;

export const ObjectiveAuthorityCapabilityPreservationMappingSchema = z
  .object({
    originalFragmentId: z.string().min(1).max(100),
    originalText: z.string().min(1).max(1_500),
    repairedFragmentIds: z.array(z.string().min(1).max(100)).min(1).max(64),
    status: z.enum(['preserved', 'lost']),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((mapping, ctx) => {
    if (new Set(mapping.repairedFragmentIds).size !== mapping.repairedFragmentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repairedFragmentIds'],
        message: 'capability-preservation repaired fragment identities must be unique',
      });
    }
  });
export type ObjectiveAuthorityCapabilityPreservationMapping = z.infer<
  typeof ObjectiveAuthorityCapabilityPreservationMappingSchema
>;

const ObjectiveAuthorityCapabilityPreservationBaseSchema = z
  .object({
    originalProposition: z.string().min(1).max(1_500),
    mappings: z.array(ObjectiveAuthorityCapabilityPreservationMappingSchema).min(1).max(64),
    lostOriginalFragmentIds: z.array(z.string().min(1).max(100)).max(64),
    verdict: z.enum(['pass', 'fail']),
    rationale: z.string().min(1).max(1_000),
  })
  .strict();

function validateCapabilityPreservationConsistency(
  preservation: z.infer<typeof ObjectiveAuthorityCapabilityPreservationBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const mappingIds = preservation.mappings.map((mapping) => mapping.originalFragmentId);
  if (new Set(mappingIds).size !== mappingIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mappings'],
      message: 'capability-preservation original fragment identities must be unique',
    });
  }
  const actualLost = preservation.mappings
    .filter((mapping) => mapping.status === 'lost')
    .map((mapping) => mapping.originalFragmentId);
  if (
    new Set(preservation.lostOriginalFragmentIds).size !==
      preservation.lostOriginalFragmentIds.length ||
    actualLost.length !== preservation.lostOriginalFragmentIds.length ||
    actualLost.some(
      (fragmentId, index) => fragmentId !== preservation.lostOriginalFragmentIds[index],
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lostOriginalFragmentIds'],
      message: 'lost original fragment identities must exactly match lost capability mappings',
    });
  }
  if ((preservation.verdict === 'pass') === actualLost.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'capability-preservation verdict is inconsistent with its mappings',
    });
  }
}

export const ObjectiveAuthorityCapabilityPreservationProposalSchema =
  ObjectiveAuthorityCapabilityPreservationBaseSchema.superRefine(
    validateCapabilityPreservationConsistency,
  );
export type ObjectiveAuthorityCapabilityPreservationProposal = z.infer<
  typeof ObjectiveAuthorityCapabilityPreservationProposalSchema
>;

export const ObjectiveAuthoritySemanticObjectiveProposalSchema = z
  .object({
    objectiveRef: z.string().min(1).max(100),
    proposition: z.string().min(1).max(1_500),
    construct: FormalAssessmentConstructSchema,
    fragments: z.array(ObjectiveAuthoritySemanticFragmentProposalSchema).min(1).max(64),
    unsupportedFragmentIds: z.array(z.string().min(1).max(100)).max(64),
    conflicts: z.array(ObjectiveAuthoritySemanticConflictProposalSchema).max(32),
    overreach: z.array(ObjectiveAuthoritySemanticOverreachProposalSchema).max(32),
    capabilityPreservation: ObjectiveAuthorityCapabilityPreservationProposalSchema.optional(),
    verdict: z.enum(['pass', 'fail']),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((evaluation, ctx) => {
    const fragmentIds = evaluation.fragments.map((fragment) => fragment.fragmentId);
    const knownFragmentIds = new Set(fragmentIds);
    if (knownFragmentIds.size !== fragmentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fragments'],
        message: 'semantic support fragment identities must be unique',
      });
    }
    const unsupportedIds = new Set(evaluation.unsupportedFragmentIds);
    if (unsupportedIds.size !== evaluation.unsupportedFragmentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unsupportedFragmentIds'],
        message: 'unsupported fragment identities must be unique',
      });
    }
    const actualUnsupportedIds = new Set(
      evaluation.fragments
        .filter((fragment) => fragment.status === 'unsupported')
        .map((fragment) => fragment.fragmentId),
    );
    if (
      evaluation.unsupportedFragmentIds.some(
        (fragmentId) => !actualUnsupportedIds.has(fragmentId),
      ) ||
      [...actualUnsupportedIds].some((fragmentId) => !unsupportedIds.has(fragmentId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unsupportedFragmentIds'],
        message: 'unsupported fragment identities must exactly match unsupported fragments',
      });
    }
    for (const [field, rows] of [
      ['conflicts', evaluation.conflicts],
      ['overreach', evaluation.overreach],
    ] as const) {
      if (
        rows.some((row) => row.fragmentIds.some((fragmentId) => !knownFragmentIds.has(fragmentId)))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} may reference only declared semantic fragments`,
        });
      }
    }
    const hasFailure =
      evaluation.fragments.some((fragment) => fragment.status !== 'supported') ||
      evaluation.conflicts.length > 0 ||
      evaluation.overreach.length > 0 ||
      evaluation.capabilityPreservation?.verdict === 'fail';
    if ((evaluation.verdict === 'pass') === hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'semantic support verdict is inconsistent with its structured findings',
      });
    }
  });
export type ObjectiveAuthoritySemanticObjectiveProposal = z.infer<
  typeof ObjectiveAuthoritySemanticObjectiveProposalSchema
>;

export const ObjectiveAuthoritySemanticEvaluationProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluations: z.array(ObjectiveAuthoritySemanticObjectiveProposalSchema).min(1).max(24),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const objectiveRefs = proposal.evaluations.map((evaluation) => evaluation.objectiveRef);
    if (new Set(objectiveRefs).size !== objectiveRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluations'],
        message: 'semantic evaluation proposal objective references must be unique',
      });
    }
  });
export type ObjectiveAuthoritySemanticEvaluationProposal = z.infer<
  typeof ObjectiveAuthoritySemanticEvaluationProposalSchema
>;

export const ObjectiveAuthoritySemanticSupportFragmentSchema = z
  .object({
    fragmentId: z.string().min(1).max(100),
    text: z.string().min(1).max(1_500),
    status: ObjectiveAuthorityFragmentStatusSchema,
    supportType: ObjectiveAuthoritySupportTypeSchema.nullable(),
    sourceBlockIds: z.array(z.string().min(1)).max(100),
    authorityRecordIds: z.array(z.string().min(1)).max(20),
    authorityClaimIds: z.array(z.string().min(1)).max(200),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((fragment, ctx) => {
    if (new Set(fragment.sourceBlockIds).size !== fragment.sourceBlockIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceBlockIds'],
        message: 'semantic support source-block identities must be unique',
      });
    }
    if (new Set(fragment.authorityRecordIds).size !== fragment.authorityRecordIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorityRecordIds'],
        message: 'semantic support authority-record identities must be unique',
      });
    }
    if (new Set(fragment.authorityClaimIds).size !== fragment.authorityClaimIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorityClaimIds'],
        message: 'semantic support authority-claim identities must be unique',
      });
    }
    if (
      fragment.status === 'supported' &&
      (fragment.supportType === null ||
        fragment.sourceBlockIds.length === 0 ||
        fragment.authorityRecordIds.length === 0 ||
        fragment.authorityClaimIds.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'supported persisted fragments require a support type, source blocks, and authority records',
      });
    }
    if (
      fragment.status === 'unsupported' &&
      (fragment.supportType !== null ||
        fragment.sourceBlockIds.length > 0 ||
        fragment.authorityRecordIds.length > 0 ||
        fragment.authorityClaimIds.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unsupported persisted fragments must not claim support mappings',
      });
    }
    if (fragment.status === 'conflicted' && fragment.supportType !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportType'],
        message: 'conflicted persisted fragments must not claim a support type',
      });
    }
  });
export type ObjectiveAuthoritySemanticSupportFragment = z.infer<
  typeof ObjectiveAuthoritySemanticSupportFragmentSchema
>;

export const ObjectiveAuthoritySemanticSupportConflictSchema = z
  .object({
    kind: ObjectiveAuthoritySemanticConflictKindSchema,
    fragmentIds: z.array(z.string().min(1).max(100)).min(1).max(24),
    sourceBlockIds: z.array(z.string().min(1)).max(100),
    authorityRecordIds: z.array(z.string().min(1)).max(20),
    authorityClaimIds: z.array(z.string().min(1)).max(200),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((conflict, ctx) => {
    requireUniqueIdentityValues(
      conflict.fragmentIds,
      ctx,
      ['fragmentIds'],
      'persisted semantic conflict fragment identities must be unique',
    );
    requireUniqueIdentityValues(
      conflict.sourceBlockIds,
      ctx,
      ['sourceBlockIds'],
      'persisted semantic conflict source-block identities must be unique',
    );
    requireUniqueIdentityValues(
      conflict.authorityRecordIds,
      ctx,
      ['authorityRecordIds'],
      'persisted semantic conflict authority-record identities must be unique',
    );
    requireUniqueIdentityValues(
      conflict.authorityClaimIds,
      ctx,
      ['authorityClaimIds'],
      'persisted semantic conflict authority-claim identities must be unique',
    );
  });
export type ObjectiveAuthoritySemanticSupportConflict = z.infer<
  typeof ObjectiveAuthoritySemanticSupportConflictSchema
>;

export const ObjectiveAuthoritySemanticSupportOverreachSchema = z
  .object({
    kind: ObjectiveAuthoritySemanticOverreachKindSchema,
    fragmentIds: z.array(z.string().min(1).max(100)).min(1).max(24),
    sourceBlockIds: z.array(z.string().min(1)).max(100),
    authorityRecordIds: z.array(z.string().min(1)).max(20),
    authorityClaimIds: z.array(z.string().min(1)).max(200),
    rationale: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((overreach, ctx) => {
    requireUniqueIdentityValues(
      overreach.fragmentIds,
      ctx,
      ['fragmentIds'],
      'persisted semantic overreach fragment identities must be unique',
    );
    requireUniqueIdentityValues(
      overreach.sourceBlockIds,
      ctx,
      ['sourceBlockIds'],
      'persisted semantic overreach source-block identities must be unique',
    );
    requireUniqueIdentityValues(
      overreach.authorityRecordIds,
      ctx,
      ['authorityRecordIds'],
      'persisted semantic overreach authority-record identities must be unique',
    );
    requireUniqueIdentityValues(
      overreach.authorityClaimIds,
      ctx,
      ['authorityClaimIds'],
      'persisted semantic overreach authority-claim identities must be unique',
    );
  });
export type ObjectiveAuthoritySemanticSupportOverreach = z.infer<
  typeof ObjectiveAuthoritySemanticSupportOverreachSchema
>;

export const ObjectiveAuthorityCapabilityRecoveryOriginSchema = z
  .object({
    predecessorCurriculumId: z.string().min(1),
    predecessorCurriculumVersion: z.number().int().positive(),
    predecessorLearningUnitId: z.string().min(1),
    predecessorObjectiveId: z.string().min(1),
    predecessorPriority: z.enum(['required', 'high', 'normal']),
    contractVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1).max(200),
    sourceEnvelopeFingerprint: z.string().min(1).max(200),
  })
  .strict();
export type ObjectiveAuthorityCapabilityRecoveryOrigin = z.infer<
  typeof ObjectiveAuthorityCapabilityRecoveryOriginSchema
>;

export const ObjectiveAuthorityCapabilityPreservationSupportSchema =
  ObjectiveAuthorityCapabilityPreservationBaseSchema.extend({
    originalPropositionFingerprint: z.string().min(1).max(200),
    /**
     * Local immutable lineage for same-contract versioned recovery. This is
     * attached after provider evaluation and is never provider-authored.
     */
    recoveryOrigin: ObjectiveAuthorityCapabilityRecoveryOriginSchema.optional(),
  })
    .strict()
    .superRefine(validateCapabilityPreservationConsistency);
export type ObjectiveAuthorityCapabilityPreservationSupport = z.infer<
  typeof ObjectiveAuthorityCapabilityPreservationSupportSchema
>;

export const ObjectiveAuthoritySemanticSupportSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    evaluator: z.string().min(1).max(120),
    provider: z.string().min(1).max(40),
    providerModel: z.string().min(1).max(120).nullable(),
    independent: z.literal(true),
    objectiveId: z.string().min(1),
    proposition: z.string().min(1).max(1_500),
    propositionFingerprint: z.string().min(1).max(200),
    construct: FormalAssessmentConstructSchema,
    boundAuthorityRecordIds: z.array(z.string().min(1)).max(20),
    boundSourceBlockIds: z.array(z.string().min(1)).max(100),
    boundAuthorityClaimIds: z.array(z.string().min(1)).max(200),
    bindingFingerprint: z.string().min(1).max(200),
    fragments: z.array(ObjectiveAuthoritySemanticSupportFragmentSchema).min(1).max(64),
    unsupportedFragmentIds: z.array(z.string().min(1).max(100)).max(64),
    conflicts: z.array(ObjectiveAuthoritySemanticSupportConflictSchema).max(32),
    overreach: z.array(ObjectiveAuthoritySemanticSupportOverreachSchema).max(32),
    capabilityPreservation: ObjectiveAuthorityCapabilityPreservationSupportSchema.optional(),
    verdict: z.enum(['pass', 'fail']),
    rationale: z.string().min(1).max(1_000),
    evaluatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((evaluation, ctx) => {
    if (evaluation.fragments.map((fragment) => fragment.text).join('') !== evaluation.proposition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fragments'],
        message: 'persisted semantic fragments must exactly partition the proposition',
      });
    }
    const boundSourceBlockIds = new Set(evaluation.boundSourceBlockIds);
    const boundAuthorityRecordIds = new Set(evaluation.boundAuthorityRecordIds);
    const boundAuthorityClaimIds = new Set(evaluation.boundAuthorityClaimIds);
    if (boundSourceBlockIds.size !== evaluation.boundSourceBlockIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundSourceBlockIds'],
        message: 'bound source-block identities must be unique',
      });
    }
    if (boundAuthorityRecordIds.size !== evaluation.boundAuthorityRecordIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundAuthorityRecordIds'],
        message: 'bound authority-record identities must be unique',
      });
    }
    if (boundAuthorityClaimIds.size !== evaluation.boundAuthorityClaimIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundAuthorityClaimIds'],
        message: 'bound authority-claim identities must be unique',
      });
    }
    const fragmentIds = evaluation.fragments.map((fragment) => fragment.fragmentId);
    const knownFragmentIds = new Set(fragmentIds);
    if (knownFragmentIds.size !== fragmentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fragments'],
        message: 'persisted semantic fragment identities must be unique',
      });
    }
    const unsupportedIds = new Set(evaluation.unsupportedFragmentIds);
    const actualUnsupportedIds = new Set(
      evaluation.fragments
        .filter((fragment) => fragment.status === 'unsupported')
        .map((fragment) => fragment.fragmentId),
    );
    if (
      unsupportedIds.size !== evaluation.unsupportedFragmentIds.length ||
      evaluation.unsupportedFragmentIds.some(
        (fragmentId) => !actualUnsupportedIds.has(fragmentId),
      ) ||
      [...actualUnsupportedIds].some((fragmentId) => !unsupportedIds.has(fragmentId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unsupportedFragmentIds'],
        message: 'unsupported fragment identities must exactly match unsupported fragments',
      });
    }
    for (const [field, rows] of [
      ['fragments', evaluation.fragments],
      ['conflicts', evaluation.conflicts],
      ['overreach', evaluation.overreach],
    ] as const) {
      if (
        rows.some(
          (row) =>
            row.sourceBlockIds.some((id) => !boundSourceBlockIds.has(id)) ||
            row.authorityRecordIds.some((id) => !boundAuthorityRecordIds.has(id)) ||
            row.authorityClaimIds.some((id) => !boundAuthorityClaimIds.has(id)),
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} may map only to the objective's bound authority`,
        });
      }
    }
    for (const [field, rows] of [
      ['conflicts', evaluation.conflicts],
      ['overreach', evaluation.overreach],
    ] as const) {
      if (
        rows.some((row) => row.fragmentIds.some((fragmentId) => !knownFragmentIds.has(fragmentId)))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} may reference only declared semantic fragments`,
        });
      }
    }
    const hasFailure =
      evaluation.fragments.some((fragment) => fragment.status !== 'supported') ||
      evaluation.conflicts.length > 0 ||
      evaluation.overreach.length > 0 ||
      evaluation.capabilityPreservation?.verdict === 'fail';
    if ((evaluation.verdict === 'pass') === hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'persisted semantic support verdict is inconsistent with its findings',
      });
    }
  });
export type ObjectiveAuthoritySemanticSupport = z.infer<
  typeof ObjectiveAuthoritySemanticSupportSchema
>;

export const ObjectiveAuthoritySemanticRepairEvidenceOfferSchema =
  ObjectiveAuthoritySemanticEvidenceOfferSchema.extend({
    selected: z.boolean(),
  }).strict();
export type ObjectiveAuthoritySemanticRepairEvidenceOffer = z.infer<
  typeof ObjectiveAuthoritySemanticRepairEvidenceOfferSchema
>;

export const ObjectiveAuthoritySemanticRepairObjectiveInputSchema = z
  .object({
    objectiveRef: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1_000),
    subjectClass: CurriculumSubjectClassSchema,
    scopeOrigin: CurriculumScopeOriginSchema,
    construct: FormalAssessmentConstructSchema,
    priority: z.enum(['required', 'high', 'normal', 'optional']),
    currentEvidenceRefs: z.array(z.string().min(1).max(100)).max(5),
    allowedEvidence: z.array(ObjectiveAuthoritySemanticRepairEvidenceOfferSchema).max(32),
    fragments: z.array(ObjectiveAuthoritySemanticFragmentProposalSchema).min(1).max(64),
    unsupportedFragmentIds: z.array(z.string().min(1).max(100)).max(64),
    conflicts: z.array(ObjectiveAuthoritySemanticConflictProposalSchema).max(32),
    overreach: z.array(ObjectiveAuthoritySemanticOverreachProposalSchema).max(32),
    verdict: z.literal('fail'),
    rationale: z.string().min(1).max(1_000),
    /** Original predecessor capability when this is a versioned recovery. */
    requiredCapabilityPreservation:
      ObjectiveAuthorityRequiredCapabilityPreservationSchema.optional(),
  })
  .strict()
  .superRefine((objective, ctx) => {
    if (isForbiddenCurriculumObjectiveClassification(objective)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeOrigin'],
        message: 'source-specific objectives cannot have supplemental scope origin',
      });
    }
    const allowedRefs = new Set(objective.allowedEvidence.map((offer) => offer.evidenceRef));
    if (allowedRefs.size !== objective.allowedEvidence.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedEvidence'],
        message: 'semantic repair evidence references must be unique',
      });
    }
    if (objective.currentEvidenceRefs.some((evidenceRef) => !allowedRefs.has(evidenceRef))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentEvidenceRefs'],
        message: 'current evidence must remain within the allowed repair evidence',
      });
    }
    const selectedRefs = new Set(
      objective.allowedEvidence.filter((offer) => offer.selected).map((offer) => offer.evidenceRef),
    );
    if (
      selectedRefs.size !== objective.currentEvidenceRefs.length ||
      objective.currentEvidenceRefs.some((evidenceRef) => !selectedRefs.has(evidenceRef))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedEvidence'],
        message: 'selected repair evidence must exactly match the current evidence references',
      });
    }
  });
export type ObjectiveAuthoritySemanticRepairObjectiveInput = z.infer<
  typeof ObjectiveAuthoritySemanticRepairObjectiveInputSchema
>;

export const ObjectiveAuthoritySemanticRepairInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1).max(80),
    objectives: z.array(ObjectiveAuthoritySemanticRepairObjectiveInputSchema).min(1).max(24),
  })
  .strict()
  .superRefine((input, ctx) => {
    const objectiveRefs = input.objectives.map((objective) => objective.objectiveRef);
    if (new Set(objectiveRefs).size !== objectiveRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectives'],
        message: 'semantic repair objective references must be unique',
      });
    }
  });
export type ObjectiveAuthoritySemanticRepairInput = z.infer<
  typeof ObjectiveAuthoritySemanticRepairInputSchema
>;

export const ObjectiveAuthoritySemanticRepairReplacementSchema = z
  .object({
    objectiveRef: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(1_000),
    subjectClass: CurriculumSubjectClassSchema,
    scopeOrigin: CurriculumScopeOriginSchema,
    construct: FormalAssessmentConstructSchema,
    evidenceRefs: z.array(z.string().min(1).max(100)).max(5),
  })
  .strict()
  .superRefine((replacement, ctx) => {
    if (isForbiddenCurriculumObjectiveClassification(replacement)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeOrigin'],
        message: 'source-specific objectives cannot have supplemental scope origin',
      });
    }
    if (new Set(replacement.evidenceRefs).size !== replacement.evidenceRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceRefs'],
        message: 'semantic repair replacement evidence references must be unique',
      });
    }
  });
export type ObjectiveAuthoritySemanticRepairReplacement = z.infer<
  typeof ObjectiveAuthoritySemanticRepairReplacementSchema
>;

export const ObjectiveAuthoritySemanticRepairProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    replacements: z.array(ObjectiveAuthoritySemanticRepairReplacementSchema).min(1).max(24),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const objectiveRefs = proposal.replacements.map((replacement) => replacement.objectiveRef);
    if (new Set(objectiveRefs).size !== objectiveRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replacements'],
        message: 'semantic repair replacement objective references must be unique',
      });
    }
  });
export type ObjectiveAuthoritySemanticRepairProposal = z.infer<
  typeof ObjectiveAuthoritySemanticRepairProposalSchema
>;
