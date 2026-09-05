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

/** Optional for historical JSON; current generation policy requires declarations. */
export const PrivateReasoningFields = {
  reasoningOperation: ReasoningOperationSchema.optional(),
  requiredInference: z.string().trim().min(1).max(300).optional(),
  decisiveCondition: z.string().trim().min(1).max(300).optional(),
};

export function isReasoningOperation(operation: ReasoningOperation | undefined): boolean {
  return operation !== undefined && operation !== 'recognize' && operation !== 'classify';
}
