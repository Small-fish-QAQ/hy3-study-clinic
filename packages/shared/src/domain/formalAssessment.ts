import {
  TransferTaskSchema,
  TransferPerformanceSchema,
  TransferCriterionSchema,
} from './transferAssessment.js';
import { z } from 'zod';
import { EvidenceRepresentationSchema } from './formalProgression.js';

export const FormalAssessmentQuestionTypeSchema = z.enum([
  'short_answer',
  'single_choice',
  'multiple_choice',
]);
export type FormalAssessmentQuestionType = z.infer<typeof FormalAssessmentQuestionTypeSchema>;

export const FormalAssessmentPolicyReasonSchema = z.enum([
  'FORMAL_ELIGIBLE',
  'MISSING_AUTHORITATIVE_SOURCE',
  'DERIVED_ONLY_SOURCE',
  'CHOICE_OPTION_AUTHORITY_INCOMPLETE',
  'STALE_SOURCE_BINDING',
  'UNSUPPORTED_QUESTION_TYPE',
  'INVALID_RUBRIC_AUTHORITY',
  'TARGET_MISSING',
]);
export type FormalAssessmentPolicyReason = z.infer<typeof FormalAssessmentPolicyReasonSchema>;

export const FormalAssessmentSourceBindingSchema = z.object({
  materialId: z.string().min(1),
  materialRevisionId: z.string().min(1),
  sourceBlockId: z.string().min(1),
  quote: z.string().min(1).max(2000),
  contentOrigin: z.enum([
    'extracted_original',
    'derived_ocr',
    'derived_visual_description',
    'derived_layout_label',
    'derived_summary',
  ]),
  authoritative: z.boolean(),
});
export type FormalAssessmentSourceBinding = z.infer<typeof FormalAssessmentSourceBindingSchema>;

export const FormalRubricCriterionSchema = z.object({
  /** Local task performance requirement, never an additional source-truth claim. */
  transferCriterion: TransferCriterionSchema.optional(),
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  required: z.boolean(),
  sourceBindingIds: z.array(z.string().min(1)).min(1),
});
export type FormalRubricCriterion = z.infer<typeof FormalRubricCriterionSchema>;

export const FormalAssessmentItemSchema = z.object({
  transferTask: TransferTaskSchema.optional(),
  id: z.string().min(1),
  /** Original quiz question identity used only by the local progression bridge. */
  sourceQuestionId: z.string().min(1).nullable().optional(),
  index: z.number().int().nonnegative(),
  targetLearningUnitId: z.string().min(1),
  targetObjectiveId: z.string().min(1),
  /** Locally assigned demand/representation contract; legacy items are conservatively recall. */
  representation: EvidenceRepresentationSchema.default('recall'),
  questionType: FormalAssessmentQuestionTypeSchema,
  prompt: z.string().min(1).max(2000),
  options: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1) }))
    .max(8)
    .optional(),
  correctOptionIds: z.array(z.string().min(1)).max(8).optional(),
  rubric: z.array(FormalRubricCriterionSchema).max(12).optional(),
  sourceBindings: z.array(FormalAssessmentSourceBindingSchema).max(10),
  formalEligible: z.boolean(),
  policyReason: FormalAssessmentPolicyReasonSchema,
});
export type FormalAssessmentItem = z.infer<typeof FormalAssessmentItemSchema>;

export const AssessmentItemExposureSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    assessmentVersionId: z.string().min(1),
    attemptId: z.string().min(1),
    itemId: z.string().min(1),
    itemFingerprint: z.string().min(1),
    surface: z.enum(['formal_assessment', 'mastery_red_team_shadow']),
    /** Null means a pre-cutover presentation may exist but cannot be proven. */
    seenBeforeAttempt: z.boolean().nullable(),
    exposedAt: z.string().datetime(),
  })
  .strict();
export type AssessmentItemExposure = z.infer<typeof AssessmentItemExposureSchema>;

export const AssessmentDefinitionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  logicalKey: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AssessmentDefinition = z.infer<typeof AssessmentDefinitionSchema>;

export const AssessmentAuthorityModeSchema = z.enum(['formal', 'mastery_red_team_shadow']);
export type AssessmentAuthorityMode = z.infer<typeof AssessmentAuthorityModeSchema>;

export const AssessmentVersionSchema = z.object({
  id: z.string().min(1),
  definitionId: z.string().min(1),
  version: z.number().int().positive(),
  predecessorId: z.string().min(1).nullable(),
  status: z.enum(['draft', 'accepted', 'superseded']),
  items: z.array(FormalAssessmentItemSchema).min(1),
  sourceRevisionIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  authorityMode: AssessmentAuthorityModeSchema.default('formal'),
  /** Immutable launch context for the separate deterministic progression bridge. */
  progressionContext: z
    .object({
      quizId: z.string().min(1),
      contractVersionId: z.string().min(1),
      curriculumVersionId: z.string().min(1),
      studyPlanVersionId: z.string().min(1),
      agendaId: z.string().min(1),
      agendaItemId: z.string().min(1),
      assessmentKind: z.enum([
        'formal_checkpoint',
        'targeted_repair',
        'synthesis',
        'direct_checkpoint',
        'due_review',
      ]),
      executionSourceManifestFingerprint: z.string().min(1),
    })
    .nullable()
    .default(null),
});
export type AssessmentVersion = z.infer<typeof AssessmentVersionSchema>;

export const AssessmentAttemptStatusSchema = z.enum(['started', 'submitted', 'cancelled']);
export type AssessmentAttemptStatus = z.infer<typeof AssessmentAttemptStatusSchema>;
export const AssessmentAttemptSchema = z.object({
  id: z.string().min(1),
  assessmentVersionId: z.string().min(1),
  workspaceId: z.string().min(1),
  ordinal: z.number().int().positive(),
  status: AssessmentAttemptStatusSchema,
  responses: z.record(z.string(), z.string()),
  startedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
});
export type AssessmentAttempt = z.infer<typeof AssessmentAttemptSchema>;

export const GradeRecordSchema = z.object({
  id: z.string().min(1),
  attemptId: z.string().min(1),
  assessmentVersionId: z.string().min(1),
  grader: z.enum(['deterministic', 'fake', 'hy3']),
  rubricVersion: z.string().min(1),
  status: z.enum(['current', 'superseded']),
  judgment: z.object({
    transferResults: z
      .array(z.object({ itemId: z.string(), performance: TransferPerformanceSchema }))
      .optional(),
    score: z.number().min(0).max(1),
    criterionResults: z.array(
      z.object({ criterionId: z.string().min(1), result: z.enum(['met', 'partial', 'not_met']) }),
    ),
    feedback: z.string().max(1000),
    diagnostic: z
      .object({
        category: z.enum([
          'SURFACE_SLIP',
          'INCOMPLETE_EXPRESSION',
          'LOCAL_MISCONCEPTION',
          'RELATION_REVERSAL',
          'PROCEDURAL_GAP',
          'PREREQUISITE_GAP',
          'IRRELEVANT_OR_GUESSING',
          'UNCERTAIN',
        ]),
        affectedCriterionIds: z.array(z.string().min(1)).max(12),
        summary: z.string().min(1).max(500),
        uncertainty: z.number().min(0).max(1),
      })
      .optional(),
  }),
  supersedesId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
});
export type GradeRecord = z.infer<typeof GradeRecordSchema>;

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  attemptId: z.string().min(1),
  gradeRecordId: z.string().min(1),
  assessmentVersionId: z.string().min(1),
  itemId: z.string().min(1),
  targetLearningUnitId: z.string().min(1),
  conclusion: z.enum(['supported', 'partial', 'unsupported']),
  policyVersion: z.string().min(1),
  sourceBindingIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/**
 * Versioned local policy for converting an immutable rubric judgment into
 * formal evidence. The aggregate model/local score remains durable feedback,
 * but it is never sufficient to grant formal credit by itself.
 */
export const FORMAL_EVIDENCE_POLICY_VERSION = 'formal-assessment-evidence-v2-criterion-gate';

export type FormalCriterionResult = 'met' | 'partial' | 'not_met';

export interface FormalCreditDecision {
  formallyDemonstrated: boolean;
  requiredCriterionIds: string[];
  failedRequiredCriterionIds: string[];
}

/**
 * Deterministically evaluate formal credit from the immutable rubric and its
 * persisted criterion results. Required criteria are the authority boundary;
 * optional criteria never veto credit, and missing/duplicate/unknown results
 * fail closed rather than being inferred from the aggregate score.
 */
export function decideFormalCredit(input: {
  rubric: readonly Pick<FormalRubricCriterion, 'id' | 'required'>[];
  criterionResults: readonly { criterionId: string; result: FormalCriterionResult }[];
}): FormalCreditDecision {
  const requiredCriterionIds = input.rubric
    .filter((criterion) => criterion.required)
    .map((c) => c.id);
  const rubricIds = new Set(input.rubric.map((criterion) => criterion.id));
  const resultById = new Map<string, FormalCriterionResult>();
  let malformed = false;
  for (const result of input.criterionResults) {
    if (!rubricIds.has(result.criterionId) || resultById.has(result.criterionId)) malformed = true;
    resultById.set(result.criterionId, result.result);
  }
  const failedRequiredCriterionIds = requiredCriterionIds.filter(
    (criterionId) => resultById.get(criterionId) !== 'met',
  );
  return {
    formallyDemonstrated:
      !malformed && requiredCriterionIds.length > 0 && failedRequiredCriterionIds.length === 0,
    requiredCriterionIds,
    failedRequiredCriterionIds,
  };
}

export const ProgressionReconciliationRecordSchema = z.object({
  id: z.string().min(1),
  evidenceRecordId: z.string().min(1),
  status: z.enum(['pending', 'applied', 'failed']),
  appliedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** Existing formalProgression reconciliation identity, when projection began. */
  gradingResultId: z.string().min(1).nullable().default(null),
  failureReason: z.string().min(1).max(500).nullable().default(null),
});
export type ProgressionReconciliationRecord = z.infer<typeof ProgressionReconciliationRecordSchema>;

export const LearnerSourceReferenceSchema = z.object({
  materialTitle: z.string().min(1),
  locationLabel: z.string().min(1),
  excerpt: z.string().min(1).max(2000),
  advisory: z.boolean(),
});
export type LearnerSourceReference = z.infer<typeof LearnerSourceReferenceSchema>;

export const LearnerAssessmentItemSchema = z.object({
  itemId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  purpose: z.string().min(1).max(500),
  sourceReferences: z.array(LearnerSourceReferenceSchema).max(10),
});
export type LearnerAssessmentItem = z.infer<typeof LearnerAssessmentItemSchema>;

export const LearnerCriterionFeedbackSchema = z.object({
  criterionId: z.string().min(1),
  label: z.string().min(1).max(500),
  result: z.enum(['met', 'partial', 'not_met']),
  message: z.string().min(1).max(500),
});
export type LearnerCriterionFeedback = z.infer<typeof LearnerCriterionFeedbackSchema>;

export const LearnerAssessmentExecutionSchema = z.object({
  assessmentVersionId: z.string().min(1),
  title: z.string().min(1).max(300),
  attempt: AssessmentAttemptSchema,
  items: z.array(LearnerAssessmentItemSchema).min(1),
  result: z
    .object({
      gradeRecordId: z.string().min(1),
      demonstrated: z.boolean(),
      summary: z.string().min(1).max(1000),
      minorNotice: z.string().max(500).nullable(),
      criteria: z.array(LearnerCriterionFeedbackSchema).max(12),
      sourceReferences: z.array(LearnerSourceReferenceSchema).max(10),
      evidenceStatus: z.enum(['supported', 'partial', 'unavailable']),
      repairEpisodeId: z.string().min(1).nullable(),
      progressionPending: z.boolean().optional(),
      reviewSchedulingPending: z.boolean().optional(),
    })
    .nullable(),
  review: z
    .object({
      reviewTargetId: z.string().min(1),
      objectiveTitle: z.string().min(1).max(300),
      dueReason: z.string().min(1).max(500),
      phase: z.enum([
        'retrieval',
        'repair',
        'practice',
        'fresh_verification',
        'resolved',
        'scheduling_retry',
      ]),
      dueAt: z.string().datetime(),
      nextDueAt: z.string().datetime().nullable(),
      schedulingRetryRequired: z.boolean(),
      resolved: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type LearnerAssessmentExecution = z.infer<typeof LearnerAssessmentExecutionSchema>;

export function classifyFormalAssessmentItem(input: {
  targetLearningUnitId?: string;
  questionType: FormalAssessmentQuestionType | string;
  sourceBindings: FormalAssessmentSourceBinding[];
  rubric?: FormalRubricCriterion[];
  options?: Array<{ id: string; text: string }>;
  correctOptionIds?: string[];
}): { formalEligible: boolean; policyReason: FormalAssessmentPolicyReason } {
  if (!input.targetLearningUnitId) return { formalEligible: false, policyReason: 'TARGET_MISSING' };
  if (input.questionType !== 'short_answer') {
    return {
      formalEligible: false,
      policyReason:
        input.questionType === 'single_choice' || input.questionType === 'multiple_choice'
          ? 'CHOICE_OPTION_AUTHORITY_INCOMPLETE'
          : 'UNSUPPORTED_QUESTION_TYPE',
    };
  }
  if (input.sourceBindings.length === 0)
    return { formalEligible: false, policyReason: 'MISSING_AUTHORITATIVE_SOURCE' };
  if (
    input.sourceBindings.some((b) => b.contentOrigin !== 'extracted_original' || !b.authoritative)
  ) {
    return { formalEligible: false, policyReason: 'DERIVED_ONLY_SOURCE' };
  }
  if (
    !input.rubric?.some((criterion) => criterion.required) ||
    input.rubric.some((criterion) =>
      criterion.sourceBindingIds.some(
        (id) => !input.sourceBindings.some((binding) => binding.sourceBlockId === id),
      ),
    )
  ) {
    return { formalEligible: false, policyReason: 'INVALID_RUBRIC_AUTHORITY' };
  }
  return { formalEligible: true, policyReason: 'FORMAL_ELIGIBLE' };
}
