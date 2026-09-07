import { z } from 'zod';
import { ReasoningOperationSchema } from './reasoningOperation.js';

/** Preparation-only case specification, never learner exposure or evidence. */
export const TeachingDesignSchema = z
  .object({
    mentalModel: z.string().min(1).max(1800),
    sourceClaims: z
      .array(
        z
          .object({
            sourceRef: z.string().regex(/^S[1-9][0-9]*$/u),
            claim: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(16),
    supplementaryTeaching: z.string().min(1).max(2400),
    actions: z
      .array(
        z
          .object({
            actionId: z
              .string()
              .regex(/^(L[1-9][0-9]*\.(guided|transfer|check)|PR[1-9][0-9]*\.(initial|retry))$/u),
            reasoningOperation: ReasoningOperationSchema,
            givens: z.string().min(1).max(1600),
            question: z.string().min(1).max(500),
            answer: z.string().min(1).max(700),
            competingExplanation: z.string().min(1).max(700),
            discriminatingEvidence: z.string().min(1).max(500),
            reasoningChange: z.string().min(1).max(600),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type TeachingDesign = z.infer<typeof TeachingDesignSchema>;
