import { z } from 'zod';
import { EvidenceRepresentationSchema, FormalAssessmentKindSchema } from './formalProgression.js';

export const ASSESSMENT_INTENT_POLICY_VERSION = 'assessment-diversity-intent-v1';

/**
 * Shared assessment-design vocabulary. A family records local generation
 * intent only; it never proves that generated prose realized the challenge.
 */
export const MasteryChallengeFamilySchema = z.enum([
  'transfer',
  'boundary_conditions',
  'near_neighbor_confusion',
  'hidden_premise_change',
  'counterexample',
  'error_diagnosis',
  'plausible_alternative_refutation',
  'cross_learning_unit_synthesis',
  'historical_misconception',
  'adversarial_distractor',
  'discriminative_follow_up',
  'representation_shift',
]);
export type MasteryChallengeFamily = z.infer<typeof MasteryChallengeFamilySchema>;

export const AssessmentIntentSelectionReasonSchema = z.enum([
  'ordinary_formal_check',
  'ordinary_due_review',
  'representation_diversity_missing',
  'transfer_context_missing',
  'no_supported_alternative',
]);
export type AssessmentIntentSelectionReason = z.infer<typeof AssessmentIntentSelectionReasonSchema>;

export const AssessmentIntentSelectionSchema = z
  .object({
    policyVersion: z.literal(ASSESSMENT_INTENT_POLICY_VERSION),
    requestedChallengeFamily: MasteryChallengeFamilySchema.nullable(),
    requestedRepresentation: EvidenceRepresentationSchema.nullable(),
    selectionReason: AssessmentIntentSelectionReasonSchema,
  })
  .strict()
  .superRefine((selection, ctx) => {
    const expectedFamily =
      selection.selectionReason === 'representation_diversity_missing'
        ? 'representation_shift'
        : selection.selectionReason === 'transfer_context_missing'
          ? 'transfer'
          : null;
    if (selection.requestedChallengeFamily !== expectedFamily) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedChallengeFamily'],
        message: 'assessment challenge family must match the local selection reason',
      });
    }
    if (expectedFamily !== null && selection.requestedRepresentation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedRepresentation'],
        message: 'selected assessment challenges require a local representation request',
      });
    }
  });
export type AssessmentIntentSelection = z.infer<typeof AssessmentIntentSelectionSchema>;

/** Immutable item-level record of what local policy asked the provider to generate. */
export const AssessmentItemIntentSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    assessmentVersionId: z.string().min(1),
    itemId: z.string().min(1),
    assessmentStage: FormalAssessmentKindSchema,
    policyVersion: z.literal(ASSESSMENT_INTENT_POLICY_VERSION),
    requestedChallengeFamily: MasteryChallengeFamilySchema.nullable(),
    requestedRepresentation: EvidenceRepresentationSchema.nullable(),
    selectionReason: AssessmentIntentSelectionReasonSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const result = AssessmentIntentSelectionSchema.safeParse({
      policyVersion: record.policyVersion,
      requestedChallengeFamily: record.requestedChallengeFamily,
      requestedRepresentation: record.requestedRepresentation,
      selectionReason: record.selectionReason,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: issue.path });
      }
    }
  });
export type AssessmentItemIntent = z.infer<typeof AssessmentItemIntentSchema>;
