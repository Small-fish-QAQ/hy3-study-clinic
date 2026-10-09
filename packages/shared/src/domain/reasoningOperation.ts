import { z } from 'zod';

/** Learner cognition is independent of an objective's assertion authority. */
export const ReasoningOperationSchema = z.enum([
  'recognize',
  'classify',
  'predict_outcome',
  'diagnose_cause',
  'locate_boundary',
  'identify_missing',
  'choose_design',
  'judge_tradeoff',
]);
export type ReasoningOperation = z.infer<typeof ReasoningOperationSchema>;

/** A case fact and a replacement that would make another offered answer correct. */
export const EvidenceContrastSchema = z
  .object({
    evidence: z.string().trim().min(6).max(250),
    replacement: z.string().trim().min(6).max(250),
    alternativeOptionId: z.string().regex(/^[A-E]$/u),
  })
  .strict();

/** Practice declarations; their descriptions do not establish public correctness. */
export const PrivateReasoningFields = {
  reasoningOperation: ReasoningOperationSchema.optional(),
  requiredInference: z.string().trim().min(1).max(300).optional(),
  decisiveCondition: z.string().trim().min(1).max(300).optional(),
  evidenceContrast: EvidenceContrastSchema.optional(),
};

/** Ordinary Practice annotations carry no answerability or depth authority.
 * Keep the existing Lesson/Retest contracts separate. */
export const PracticePrivateReasoningFields = {
  ...PrivateReasoningFields,
  requiredInference: z.string().trim().max(300).optional(),
  decisiveCondition: z.string().trim().max(300).optional(),
  evidenceContrast: EvidenceContrastSchema.extend({
    evidence: z.string().trim().max(250),
    replacement: z.string().trim().max(250),
  }).optional(),
};

/** Lesson authoring annotations are optional. Compact facts need no prose quota. */
export const LessonPrivateReasoningFields = {
  ...PrivateReasoningFields,
  evidenceContrast: EvidenceContrastSchema.extend({
    evidence: z.string().trim().min(1).max(250),
    replacement: z.string().trim().min(1).max(250),
  }).optional(),
};

export function isReasoningOperation(operation: ReasoningOperation | undefined): boolean {
  return operation !== undefined && operation !== 'recognize' && operation !== 'classify';
}
