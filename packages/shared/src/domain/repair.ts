import { z } from 'zod';
import { MasteryChallengeFamilySchema, type MasteryChallengeFamily } from './assessmentIntent.js';

export const RepairDiagnosticCategorySchema = z
  .enum([
    'SURFACE_SLIP',
    'INCOMPLETE_EXPRESSION',
    'LOCAL_MISCONCEPTION',
    'RELATION_REVERSAL',
    'PROCEDURAL_GAP',
    'PREREQUISITE_GAP',
    'IRRELEVANT_OR_GUESSING',
    'UNCERTAIN',
  ])
  .describe(
    'Local diagnostic category selected by deterministic grading policy; provider output cannot change it.',
  );
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

export const RepairInterventionModeSchema = z
  .enum([
    'NOTICE',
    'TARGETED_PROMPT',
    'CONTRAST',
    'SCAFFOLD',
    'PREREQUISITE_REVIEW',
    'RETEACH_RETRIEVAL',
    'CLARIFY',
  ])
  .describe(
    'Locally selected pedagogical contract: TARGETED_PROMPT elicits a missing part; CONTRAST compares an error with the grounded relation; SCAFFOLD decomposes a procedure; RETEACH_RETRIEVAL reteaches then checks retrieval. Provider output must preserve the supplied mode.',
  );
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
  affectedCriterionIds: z.array(z.string().min(1)).max(12),
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
  /**
   * Assessment intent locally requested for this packet's check, drawn from the
   * shared assessment-design vocabulary. Null only for packets written before
   * differentiation existed; those contribute no intent history.
   */
  checkIntent: MasteryChallengeFamilySchema.nullable().default(null),
  /**
   * The episode `attemptCount` this packet was generated for. Differentiation
   * reads only STRICTLY EARLIER rounds, which is what keeps repeated generation
   * within one round idempotent instead of laddering on its own output.
   */
  attemptOrdinal: z.number().int().nonnegative().max(3).default(0),
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

export const LearnerRepairProjectionSchema = z.object({
  episodeId: z.string().min(1),
  status: RepairStatusSchema,
  diagnosis: z.string().min(1).max(500),
  target: z.string().min(1).max(500),
  attemptCount: z.number().int().nonnegative().max(3),
  packet: z
    .object({
      interventionLabel: z.string().min(1).max(100),
      explanation: z.string().min(1).max(1500),
      practicePrompt: z.string().min(1).max(1000),
      hints: z.array(z.string().min(1).max(500)).max(4),
    })
    .nullable(),
  practice: z.array(
    z.object({
      ordinal: z.number().int().positive(),
      response: z.string().max(500),
      outcome: z.enum(['CONTINUE', 'READY_FOR_VERIFICATION', 'NEEDS_MORE_SUPPORT']),
      createdAt: z.string().datetime(),
    }),
  ),
  sourceReferences: z.array(
    z.object({
      materialTitle: z.string().min(1),
      locationLabel: z.string().min(1),
      excerpt: z.string().min(1).max(2000),
      advisory: z.boolean(),
    }),
  ),
  verificationAssessmentVersionId: z.string().min(1).nullable(),
  resolved: z.boolean(),
  deeperSupportRecommended: z.boolean(),
});
export type LearnerRepairProjection = z.infer<typeof LearnerRepairProjectionSchema>;

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

export const REPAIR_DIFFERENTIATION_POLICY_VERSION = 'repair-differentiation-v1';

/**
 * Ordered pedagogically permitted intervention modes per diagnosis. Position 0
 * is exactly `repairInterventionFor`, so a learner's first Repair for a
 * diagnosis is unchanged; later positions exist only so a repeated failure of
 * the same diagnosis is not met with the same teaching move again.
 */
const interventionLadder: Record<RepairDiagnosticCategory, readonly RepairInterventionMode[]> = {
  INCOMPLETE_EXPRESSION: ['TARGETED_PROMPT', 'SCAFFOLD', 'RETEACH_RETRIEVAL'],
  LOCAL_MISCONCEPTION: ['CONTRAST', 'RETEACH_RETRIEVAL', 'SCAFFOLD'],
  RELATION_REVERSAL: ['CONTRAST', 'SCAFFOLD', 'RETEACH_RETRIEVAL'],
  PROCEDURAL_GAP: ['SCAFFOLD', 'TARGETED_PROMPT', 'RETEACH_RETRIEVAL'],
  PREREQUISITE_GAP: ['PREREQUISITE_REVIEW', 'SCAFFOLD', 'RETEACH_RETRIEVAL'],
  IRRELEVANT_OR_GUESSING: ['RETEACH_RETRIEVAL', 'SCAFFOLD', 'CONTRAST'],
  SURFACE_SLIP: ['NOTICE', 'TARGETED_PROMPT'],
  UNCERTAIN: ['CLARIFY', 'TARGETED_PROMPT', 'CONTRAST'],
};

/**
 * Assessment intents this diagnosis may legitimately ask for, drawn from the
 * shared 12-family vocabulary. Position 0 is the ordinary first request; the
 * rest are the alternatives a repeated failure may be re-checked with.
 */
const checkIntentLadder: Record<RepairDiagnosticCategory, readonly MasteryChallengeFamily[]> = {
  INCOMPLETE_EXPRESSION: ['discriminative_follow_up', 'boundary_conditions'],
  LOCAL_MISCONCEPTION: ['historical_misconception', 'counterexample', 'near_neighbor_confusion'],
  RELATION_REVERSAL: ['near_neighbor_confusion', 'counterexample', 'boundary_conditions'],
  PROCEDURAL_GAP: ['error_diagnosis', 'boundary_conditions'],
  PREREQUISITE_GAP: ['discriminative_follow_up', 'error_diagnosis'],
  IRRELEVANT_OR_GUESSING: ['discriminative_follow_up', 'representation_shift'],
  SURFACE_SLIP: ['discriminative_follow_up'],
  UNCERTAIN: ['discriminative_follow_up', 'boundary_conditions'],
};

export function repairInterventionLadderFor(
  category: RepairDiagnosticCategory,
): readonly RepairInterventionMode[] {
  return interventionLadder[category];
}

export function repairCheckIntentLadderFor(
  category: RepairDiagnosticCategory,
): readonly MasteryChallengeFamily[] {
  return checkIntentLadder[category];
}

export interface RepairDifferentiationRequirement {
  policyVersion: typeof REPAIR_DIFFERENTIATION_POLICY_VERSION;
  requiredInterventionMode: RepairInterventionMode;
  requiredCheckIntent: MasteryChallengeFamily;
  permittedInterventionModes: readonly RepairInterventionMode[];
  permittedCheckIntents: readonly MasteryChallengeFamily[];
  /** True when every laddered mode for this diagnosis has already been used. */
  interventionLadderExhausted: boolean;
  /** True when every laddered intent for this diagnosis has already been used. */
  checkIntentLadderExhausted: boolean;
  /**
   * True only when neither typed axis can still change, so differentiation must
   * rest on the concrete check being materially different. Never a licence to
   * repeat a check: the structural fence still applies.
   */
  structuralDifferentiationOnly: boolean;
}

/**
 * Choose the intervention mode and check intent for the next Repair packet.
 *
 * Pure function of the diagnosis plus what this learner has already been shown
 * for it. With no history it returns exactly the pre-differentiation choice.
 */
export function selectRepairDifferentiation(input: {
  category: RepairDiagnosticCategory;
  priorInterventionModes: readonly RepairInterventionMode[];
  priorCheckIntents: readonly MasteryChallengeFamily[];
}): RepairDifferentiationRequirement {
  const modes = interventionLadder[input.category];
  const intents = checkIntentLadder[input.category];
  const usedModes = new Set(input.priorInterventionModes);
  const usedIntents = new Set(input.priorCheckIntents);

  const unusedMode = modes.find((mode) => !usedModes.has(mode));
  const unusedIntent = intents.find((intent) => !usedIntents.has(intent));

  // Exhaustion reuses the most escalated mode rather than cycling back to the
  // lightest one, and the ordinary intent rather than an arbitrary later one.
  const requiredInterventionMode = unusedMode ?? modes[modes.length - 1]!;
  const requiredCheckIntent = unusedIntent ?? intents[0]!;

  const interventionLadderExhausted = unusedMode === undefined;
  const checkIntentLadderExhausted = unusedIntent === undefined;

  return {
    policyVersion: REPAIR_DIFFERENTIATION_POLICY_VERSION,
    requiredInterventionMode,
    requiredCheckIntent,
    permittedInterventionModes: modes,
    permittedCheckIntents: intents,
    interventionLadderExhausted,
    checkIntentLadderExhausted,
    structuralDifferentiationOnly: interventionLadderExhausted && checkIntentLadderExhausted,
  };
}
