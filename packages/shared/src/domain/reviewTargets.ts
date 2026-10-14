import { z } from 'zod';
export const KnowledgeReviewTargetSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    knowledgeId: z.string().min(1),
    title: z.string().min(1),
    sourceScopeHash: z.string().min(1),
  })
  .strict();
export const GradedStudyOutcomeSchema = z
  .object({
    id: z.string().min(1),
    knowledgeId: z.string().min(1),
    sourceKind: z.enum(['practice', 'retest', 'explicit_review', 'formal']),
    sourceRecordId: z.string().min(1),
    questionIds: z.array(z.string().min(1)).min(1),
    result: z.enum(['independent_success', 'weak']),
    assistance: z.enum(['none', 'hint']),
    occurredAt: z.string().datetime(),
    policyVersion: z.string().min(1),
    stateSnapshot: z.unknown().nullable(),
    predecessorSourceRecordId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type GradedStudyOutcome = z.infer<typeof GradedStudyOutcomeSchema>;
