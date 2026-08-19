import { z } from 'zod';

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
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  required: z.boolean(),
  sourceBindingIds: z.array(z.string().min(1)).min(1),
});
export type FormalRubricCriterion = z.infer<typeof FormalRubricCriterionSchema>;

export const FormalAssessmentItemSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  targetLearningUnitId: z.string().min(1),
  targetObjectiveId: z.string().min(1),
  questionType: FormalAssessmentQuestionTypeSchema,
  prompt: z.string().min(1).max(2000),
  options: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1) }))
    .max(8)
    .optional(),
  correctOptionIds: z.array(z.string().min(1)).max(8).optional(),
  rubric: z.array(FormalRubricCriterionSchema).max(8).optional(),
  sourceBindings: z.array(FormalAssessmentSourceBindingSchema).max(10),
  formalEligible: z.boolean(),
  policyReason: FormalAssessmentPolicyReasonSchema,
});
export type FormalAssessmentItem = z.infer<typeof FormalAssessmentItemSchema>;

export const AssessmentDefinitionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  logicalKey: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AssessmentDefinition = z.infer<typeof AssessmentDefinitionSchema>;

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
    score: z.number().min(0).max(1),
    criterionResults: z.array(
      z.object({ criterionId: z.string().min(1), result: z.enum(['met', 'partial', 'not_met']) }),
    ),
    feedback: z.string().max(1000),
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

export const ProgressionReconciliationRecordSchema = z.object({
  id: z.string().min(1),
  evidenceRecordId: z.string().min(1),
  status: z.enum(['pending', 'applied', 'failed']),
  appliedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ProgressionReconciliationRecord = z.infer<typeof ProgressionReconciliationRecordSchema>;

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
