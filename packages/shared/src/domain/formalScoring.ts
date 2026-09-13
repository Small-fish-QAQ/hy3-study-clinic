import { z } from 'zod';
import type { TransferTask } from './transferAssessment.js';

export const FormalBlindSolutionSchema = z
  .object({
    answerable: z.boolean(),
    solution: z.string().min(1).max(6000),
    limitations: z.array(z.string().min(1).max(500)).max(12),
  })
  .strict();
export type FormalBlindSolution = z.infer<typeof FormalBlindSolutionSchema>;

export const FormalScoringChallengesSchema = z
  .object({
    challenges: z
      .array(
        z
          .object({
            premiseKey: z.string().min(1).max(100),
            objection: z.string().min(1).max(1200),
            counterexample: z.string().min(1).max(1800),
          })
          .strict(),
      )
      .max(7),
  })
  .strict();
export type FormalScoringChallenges = z.infer<typeof FormalScoringChallengesSchema>;

export const FormalScoringReviewProposalSchema = z
  .object({
    answerable: z.boolean(),
    objectiveAligned: z.boolean(),
    unseenAssessment: z.boolean(),
    keyCorrect: z.boolean(),
    requiredCriteriaAppropriate: z.boolean(),
    premises: z
      .array(
        z
          .object({
            premiseKey: z.string().min(1).max(100),
            supported: z.boolean(),
            claimRefs: z.array(z.string().min(1)).max(12),
            rationale: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .min(1)
      .max(7),
    issues: z.array(z.string().min(1).max(800)).max(12),
    challengeResolutions: z
      .array(
        z
          .object({
            challengeRef: z.string().regex(/^C[1-7]$/u),
            valid: z.boolean(),
            rationale: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .max(7)
      .optional(),
  })
  .strict();
export type FormalScoringReviewProposal = z.infer<typeof FormalScoringReviewProposalSchema>;

/** Private, locally bound receipt. Never projected onto an unanswered learner surface. */
export const FormalScoringReviewSchema = z
  .object({
    policyVersion: z.enum([
      'formal-scoring-independent-review-v1',
      'formal-scoring-independent-review-v2',
    ]),
    provider: z.string().min(1),
    questionFingerprint: z.string().length(64),
    objectiveFingerprint: z.string().length(64),
    sources: z
      .array(
        z
          .object({
            sourceBlockId: z.string().min(1),
            materialRevisionId: z.string().min(1),
            contentFingerprint: z.string().length(64),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    blindSolution: FormalBlindSolutionSchema,
    challenges: FormalScoringChallengesSchema.optional(),
    challengeFingerprint: z.string().length(64).optional(),
    review: FormalScoringReviewProposalSchema,
    claims: z
      .array(
        z
          .object({
            ref: z.string().min(1),
            sourceBlockId: z.string().min(1),
            text: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    reviewedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.policyVersion === 'formal-scoring-independent-review-v2' &&
      (!receipt.challenges || !receipt.challengeFingerprint || !receipt.review.challengeResolutions)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Version 2 requires the challenge inventory, fingerprint and resolutions.',
      });
  });
export type FormalScoringReview = z.infer<typeof FormalScoringReviewSchema>;

export interface FormalScoringReviewInput {
  question: {
    type: string;
    stem: string;
    expectedAnswer?: string;
    rubric?: { keyPoints: Array<{ text: string; required: boolean }> };
    transferTask?: TransferTask;
  };
  objective: { title: string; description: string };
  sources: Array<{ sourceBlockId: string; materialRevisionId: string; content: string }>;
  claims: FormalScoringReview['claims'];
  priorExposure: string[];
  challenges?: FormalScoringChallenges;
}
