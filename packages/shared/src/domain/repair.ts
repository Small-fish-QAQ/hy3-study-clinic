import { z } from 'zod';

export const RepairDiagnosticCategorySchema = z.enum([
  'SURFACE_SLIP',
  'INCOMPLETE_EXPRESSION',
  'LOCAL_MISCONCEPTION',
  'RELATION_REVERSAL',
  'PROCEDURAL_GAP',
  'PREREQUISITE_GAP',
  'IRRELEVANT_OR_GUESSING',
  'UNCERTAIN',
]);
export type RepairDiagnosticCategory = z.infer<typeof RepairDiagnosticCategorySchema>;

export const RepairStatusSchema = z.enum([
  'OPEN',
  'ACTIVE',
  'AWAITING_VERIFICATION',
  'RESOLVED',
  'DEFERRED',
  'CANCELLED',
]);
export type RepairStatus = z.infer<typeof RepairStatusSchema>;

export const RepairInterventionModeSchema = z.enum([
  'NOTICE',
  'TARGETED_PROMPT',
  'CONTRAST',
  'SCAFFOLD',
  'PREREQUISITE_REVIEW',
  'RETEACH_RETRIEVAL',
  'CLARIFY',
]);
export type RepairInterventionMode = z.infer<typeof RepairInterventionModeSchema>;

export const RepairEpisodeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  triggerGradeRecordId: z.string().min(1),
  triggerAttemptId: z.string().min(1),
  assessmentVersionId: z.string().min(1),
  itemId: z.string().min(1),
  targetLearningUnitId: z.string().min(1),
  diagnosticCategory: RepairDiagnosticCategorySchema,
  affectedCriterionIds: z.array(z.string().min(1)).max(8),
  gapSummary: z.string().min(1).max(500),
  status: RepairStatusSchema,
  attemptCount: z.number().int().nonnegative().max(3),
  verificationAttemptId: z.string().min(1).nullable(),
  resolvedEvidenceId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RepairEpisode = z.infer<typeof RepairEpisodeSchema>;

export const RepairPracticeEventSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  ordinal: z.number().int().positive(),
  responseSummary: z.string().max(500),
  outcome: z.enum(['CONTINUE', 'READY_FOR_VERIFICATION', 'NEEDS_MORE_SUPPORT']),
  createdAt: z.string().datetime(),
});
export type RepairPracticeEvent = z.infer<typeof RepairPracticeEventSchema>;

export const RepairPacketSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  generationKey: z.string().min(1),
  provider: z.enum(['fake', 'hy3']),
  providerModel: z.string().nullable(),
  interventionMode: RepairInterventionModeSchema,
  explanation: z.string().min(1).max(1500),
  practicePrompt: z.string().min(1).max(1000),
  hints: z.array(z.string().min(1).max(500)).max(4),
  sourceBlockIds: z.array(z.string().min(1)).max(10),
  targetLearningUnitId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type RepairPacket = z.infer<typeof RepairPacketSchema>;

export const RepairStatusTransitionSchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  from: RepairStatusSchema.nullable(),
  to: RepairStatusSchema,
  reason: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
});
export type RepairStatusTransition = z.infer<typeof RepairStatusTransitionSchema>;

const transitionMap: Record<RepairStatus, readonly RepairStatus[]> = {
  OPEN: ['ACTIVE', 'DEFERRED', 'CANCELLED'],
  ACTIVE: ['AWAITING_VERIFICATION', 'DEFERRED', 'CANCELLED'],
  AWAITING_VERIFICATION: ['ACTIVE', 'RESOLVED', 'DEFERRED', 'CANCELLED'],
  RESOLVED: [],
  DEFERRED: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
};
export function isRepairTransitionAllowed(from: RepairStatus, to: RepairStatus): boolean {
  return transitionMap[from].includes(to);
}

export function repairInterventionFor(category: RepairDiagnosticCategory): RepairInterventionMode {
  switch (category) {
    case 'INCOMPLETE_EXPRESSION':
      return 'TARGETED_PROMPT';
    case 'LOCAL_MISCONCEPTION':
      return 'CONTRAST';
    case 'RELATION_REVERSAL':
      return 'CONTRAST';
    case 'PROCEDURAL_GAP':
      return 'SCAFFOLD';
    case 'PREREQUISITE_GAP':
      return 'PREREQUISITE_REVIEW';
    case 'IRRELEVANT_OR_GUESSING':
      return 'RETEACH_RETRIEVAL';
    case 'SURFACE_SLIP':
      return 'NOTICE';
    default:
      return 'CLARIFY';
  }
}
