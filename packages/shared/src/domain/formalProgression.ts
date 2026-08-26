import { z } from 'zod';
import { CourseExecutionCommandEnvelopeSchema, DesiredDepthSchema } from './learningContract.js';
import { EvidenceAdmissibilityTierSchema } from './sourceAuthority.js';

export const FormalAssessmentKindSchema = z.enum([
  'formal_checkpoint',
  'due_review',
  'targeted_repair',
  'synthesis',
  'direct_checkpoint',
]);
export type FormalAssessmentKind = z.infer<typeof FormalAssessmentKindSchema>;

export const EvidenceRepresentationSchema = z.enum([
  'recognition',
  'recall',
  'explanation',
  'application',
  'comparison',
  'transfer',
  'synthesis',
]);
export type EvidenceRepresentation = z.infer<typeof EvidenceRepresentationSchema>;

export const EVIDENCE_DEMAND_ORDER: Readonly<Record<EvidenceRepresentation, number>> = {
  recognition: 0,
  recall: 1,
  explanation: 2,
  application: 3,
  comparison: 4,
  transfer: 5,
  synthesis: 6,
};

export function evidenceDemandAtLeast(
  representation: EvidenceRepresentation,
  minimum: EvidenceRepresentation,
): boolean {
  return EVIDENCE_DEMAND_ORDER[representation] >= EVIDENCE_DEMAND_ORDER[minimum];
}

export const EvidenceProvenanceSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sourceBlockId: z.string().min(1),
    sourceBlockRevisionFingerprint: z.string().min(1).nullable(),
    truthAuthorityClaimIds: z.array(z.string().min(1)).max(20),
  })
  .strict();
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;

export const FormalAssessmentPremiseKindSchema = z.enum([
  'choice_answer',
  'expected_answer',
  'rubric_point',
]);
export type FormalAssessmentPremiseKind = z.infer<typeof FormalAssessmentPremiseKindSchema>;

/**
 * Immutable binding between one hidden scoring premise and the separately
 * admitted source-authority claim that permits it to affect learner state.
 * The fingerprint binds the complete answer/options or rubric representation
 * without exposing those assessment secrets through progression APIs.
 */
export const FormalAssessmentPremiseBindingSchema = z
  .object({
    id: z.string().min(1),
    premiseKey: z.string().min(1).max(100),
    premiseKind: FormalAssessmentPremiseKindSchema,
    premiseFingerprint: z.string().min(1),
    truthAuthorityRecordId: z.string().min(1),
    truthAuthorityClaimIds: z.array(z.string().min(1)).min(1).max(10),
  })
  .strict();
export type FormalAssessmentPremiseBinding = z.infer<typeof FormalAssessmentPremiseBindingSchema>;

/** Immutable contract installed when an Agent-launched formal question is created. */
export const FormalQuestionContractSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    quizId: z.string().min(1),
    questionId: z.string().min(1),
    studySessionId: z.string().min(1).nullable(),
    agendaItemId: z.string().min(1),
    assessmentKind: FormalAssessmentKindSchema,
    primaryObjectiveId: z.string().min(1),
    scoredSecondaryObjectiveIds: z.array(z.string().min(1)).max(10),
    curriculumLearningUnitId: z.string().min(1),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    targetDepth: DesiredDepthSchema,
    representation: EvidenceRepresentationSchema,
    admissibilityTier: EvidenceAdmissibilityTierSchema,
    stableScopeFingerprint: z.string().min(1),
    contractVersionId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    executionSourceManifestFingerprint: z.string().min(1),
    provenance: z.array(EvidenceProvenanceSchema).max(20),
    assessmentPremiseBindings: z.array(FormalAssessmentPremiseBindingSchema).max(20).default([]),
    limitations: z.array(z.string().min(1).max(500)).max(20),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (
      contract.admissibilityTier !== 'tier_3_advisory' &&
      (contract.provenance.length === 0 ||
        contract.provenance.some((item) => item.truthAuthorityClaimIds.length === 0) ||
        contract.assessmentPremiseBindings.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance'],
        message:
          'state-crediting question contracts require explicit independently authorized scoring-premise bindings',
      });
    }

    const premiseKeys = contract.assessmentPremiseBindings.map((binding) => binding.premiseKey);
    const bindingIds = contract.assessmentPremiseBindings.map((binding) => binding.id);
    if (
      new Set(premiseKeys).size !== premiseKeys.length ||
      new Set(bindingIds).size !== bindingIds.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assessmentPremiseBindings'],
        message: 'assessment premise binding IDs and keys must be unique',
      });
    }
  });
export type FormalQuestionContract = z.infer<typeof FormalQuestionContractSchema>;

export const FormalEvidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    formalQuestionContractId: z.string().min(1),
    gradingResultId: z.string().min(1),
    questionId: z.string().min(1),
    primaryObjectiveId: z.string().min(1),
    curriculumLearningUnitId: z.string().min(1),
    admissibilityTier: EvidenceAdmissibilityTierSchema,
    normalizedScore: z.number().min(0).max(1),
    correct: z.boolean(),
    needsReview: z.boolean(),
    stateCreditable: z.boolean(),
    assessmentPremiseBindingIds: z.array(z.string().min(1)).max(20).default([]),
    limitations: z.array(z.string().min(1).max(500)).max(20),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.admissibilityTier === 'tier_3_advisory' && evidence.stateCreditable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateCreditable'],
        message: 'tier-3 evidence is advisory and cannot mutate formal progression',
      });
    }
    if (evidence.stateCreditable && evidence.assessmentPremiseBindingIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assessmentPremiseBindingIds'],
        message: 'state-crediting evidence requires explicit scoring-premise bindings',
      });
    }
    if (
      new Set(evidence.assessmentPremiseBindingIds).size !==
      evidence.assessmentPremiseBindingIds.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assessmentPremiseBindingIds'],
        message: 'assessment premise binding IDs must be unique',
      });
    }
  });
export type FormalEvidenceRecord = z.infer<typeof FormalEvidenceRecordSchema>;

export const LearningUnitProgressStateSchema = z.enum([
  'not_started',
  'in_progress',
  'complete',
  'repair_needed',
  'deferred',
]);
export type LearningUnitProgressState = z.infer<typeof LearningUnitProgressStateSchema>;

export const CompletionPolicySchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    contractVersionId: z.string().min(1),
    desiredDepth: DesiredDepthSchema,
    minimumEligibleEvidenceCount: z.number().int().positive().max(20),
    minimumScore: z.number().min(0).max(1),
    requireSynthesis: z.boolean(),
    durableMastery: z
      .object({
        minimumRepresentationCount: z.number().int().min(2).max(7),
        minimumDemand: EvidenceRepresentationSchema,
        requireDelayedUnseenEvidence: z.boolean(),
      })
      .strict()
      .default({
        minimumRepresentationCount: 2,
        minimumDemand: 'application',
        requireDelayedUnseenEvidence: true,
      }),
    permittedTiers: z
      .array(z.enum(['tier_1_authorized_truth', 'tier_2_validated_representation']))
      .min(1)
      .max(2),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CompletionPolicy = z.infer<typeof CompletionPolicySchema>;

export const DurableMasteryEvidenceFactSchema = z
  .object({
    evidenceId: z.string().min(1),
    representation: EvidenceRepresentationSchema,
    supported: z.boolean(),
    reconciled: z.boolean(),
    delayedReview: z.boolean(),
    /** Null means historical or otherwise unproven exposure history. */
    unseenBeforeAttempt: z.boolean().nullable(),
  })
  .strict();
export type DurableMasteryEvidenceFact = z.infer<typeof DurableMasteryEvidenceFactSchema>;

export const DurableMasteryReasonSchema = z.enum([
  'route_progress_incomplete',
  'supported_evidence_missing',
  'representation_diversity_missing',
  'application_demand_missing',
  'delayed_unseen_evidence_missing',
  'current_review_failure',
  'durable_mastery_demonstrated',
]);
export type DurableMasteryReason = z.infer<typeof DurableMasteryReasonSchema>;

export const DurableMasteryEvaluationSchema = z
  .object({
    status: z.enum(['evidence_backed', 'mastered']),
    evidenceIds: z.array(z.string().min(1)).max(100),
    representations: z.array(EvidenceRepresentationSchema).max(7),
    reasonCodes: z.array(DurableMasteryReasonSchema).min(1).max(10),
  })
  .strict();
export type DurableMasteryEvaluation = z.infer<typeof DurableMasteryEvaluationSchema>;

/** Deterministic strong-state policy; ordinary route completion is an independent input. */
export function evaluateDurableMastery(input: {
  routeProgressComplete: boolean;
  currentReviewFailure: boolean;
  policy: CompletionPolicy['durableMastery'];
  evidence: readonly DurableMasteryEvidenceFact[];
}): DurableMasteryEvaluation {
  const qualifying = input.evidence.filter((item) => item.supported && item.reconciled);
  const representations = [...new Set(qualifying.map((item) => item.representation))].sort(
    (left, right) => EVIDENCE_DEMAND_ORDER[left] - EVIDENCE_DEMAND_ORDER[right],
  );
  const demandSatisfied = qualifying.some((item) =>
    evidenceDemandAtLeast(item.representation, input.policy.minimumDemand),
  );
  const delayedUnseenSatisfied = qualifying.some(
    (item) =>
      item.delayedReview &&
      item.unseenBeforeAttempt === true &&
      evidenceDemandAtLeast(item.representation, input.policy.minimumDemand),
  );
  const reasons: DurableMasteryReason[] = [];
  if (!input.routeProgressComplete) reasons.push('route_progress_incomplete');
  if (qualifying.length === 0) reasons.push('supported_evidence_missing');
  if (representations.length < input.policy.minimumRepresentationCount) {
    reasons.push('representation_diversity_missing');
  }
  if (!demandSatisfied) reasons.push('application_demand_missing');
  if (input.policy.requireDelayedUnseenEvidence && !delayedUnseenSatisfied) {
    reasons.push('delayed_unseen_evidence_missing');
  }
  if (input.currentReviewFailure) reasons.push('current_review_failure');
  if (reasons.length === 0) reasons.push('durable_mastery_demonstrated');
  return DurableMasteryEvaluationSchema.parse({
    status: reasons[0] === 'durable_mastery_demonstrated' ? 'mastered' : 'evidence_backed',
    evidenceIds: qualifying.map((item) => item.evidenceId).slice(0, 100),
    representations,
    reasonCodes: reasons,
  });
}

export const ProgressionDecisionKindSchema = z.enum([
  'complete',
  'continue',
  'targeted_repair',
  'deferred',
  'replan_candidate',
]);
export type ProgressionDecisionKind = z.infer<typeof ProgressionDecisionKindSchema>;

export const ProgressionDecisionSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    curriculumLearningUnitId: z.string().min(1),
    completionPolicyId: z.string().min(1),
    completionPolicyVersion: z.number().int().positive(),
    kind: ProgressionDecisionKindSchema,
    priorState: LearningUnitProgressStateSchema,
    nextState: LearningUnitProgressStateSchema,
    evidenceIds: z.array(z.string().min(1)).max(100),
    reasonCodes: z.array(z.string().min(1).max(100)).min(1).max(20),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ProgressionDecision = z.infer<typeof ProgressionDecisionSchema>;

export const ProgressionReconciliationSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    gradingResultId: z.string().min(1),
    curriculumVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    curriculumLearningUnitId: z.string().min(1),
    completionPolicyId: z.string().min(1),
    completionPolicyVersion: z.number().int().positive(),
    status: z.enum(['reconciliation_pending', 'applied', 'rejected', 'stale']),
    decisionId: z.string().min(1).nullable(),
    reason: z.string().min(1).max(500).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProgressionReconciliation = z.infer<typeof ProgressionReconciliationSchema>;

export const ReplanTriggerKindSchema = z.enum([
  'deadline_or_target_change',
  'sustained_study_time_change',
  'persistent_pace_risk',
  'learner_scope_change',
  'repeated_formal_evidence',
  'synthesis_failure',
  'strong_prerequisite_failure',
  'source_manifest_change',
  'promoted_detour',
]);
export type ReplanTriggerKind = z.infer<typeof ReplanTriggerKindSchema>;

export const ReplanQualificationFactsSchema = z
  .object({
    qualifyingOccurrences: z.number().int().nonnegative().max(1000),
    affectedLearningUnitIds: z.array(z.string().min(1)).max(100),
    affectedPlanItemIds: z.array(z.string().min(1)).max(100),
    observedMinutesPerWeek: z.number().int().nonnegative().nullable(),
    sourceManifestFingerprint: z.string().min(1).max(200).nullable(),
    learnerConfirmedChange: z.boolean(),
  })
  .strict();
export type ReplanQualificationFacts = z.infer<typeof ReplanQualificationFactsSchema>;

export const ReplanTriggerSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    acceptedStudyPlanId: z.string().min(1),
    kind: ReplanTriggerKindSchema,
    status: z.enum(['candidate', 'qualified', 'dismissed', 'proposal_created', 'resolved']),
    evidenceIds: z.array(z.string().min(1)).max(100),
    reason: z.string().min(1).max(1000),
    facts: ReplanQualificationFactsSchema,
    proposedStudyPlanId: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ReplanTrigger = z.infer<typeof ReplanTriggerSchema>;

export const QualifyReplanTriggerRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    expectedAcceptedStudyPlanId: z.string().min(1),
    kind: ReplanTriggerKindSchema,
    evidenceIds: z.array(z.string().min(1)).max(100),
    reason: z.string().min(1).max(1000),
    facts: ReplanQualificationFactsSchema,
  })
  .strict();
export type QualifyReplanTriggerRequest = z.infer<typeof QualifyReplanTriggerRequestSchema>;

export const ProposeQualifiedReplanRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    triggerId: z.string().min(1),
    expectedAcceptedStudyPlanId: z.string().min(1),
  })
  .strict();
export type ProposeQualifiedReplanRequest = z.infer<typeof ProposeQualifiedReplanRequestSchema>;

export const GoalOutcomeSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contractVersionId: z.string().min(1),
    studyPlanVersionId: z.string().min(1),
    status: z.enum([
      'achieved',
      'finished_with_gaps',
      'expired_unfinished',
      'abandoned',
      'superseded',
    ]),
    formalEvidenceIds: z.array(z.string().min(1)).max(1000),
    unresolvedRiskIds: z.array(z.string().min(1)).max(1000),
    reason: z.string().min(1).max(1000),
    actor: z.enum(['learner', 'local']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GoalOutcome = z.infer<typeof GoalOutcomeSchema>;

export const RecordGoalOutcomeRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    expectedCourseExecutionVersion: z.number().int().positive(),
    expectedContractVersionId: z.string().min(1),
    expectedCurriculumVersionId: z.string().min(1),
    expectedStudyPlanVersionId: z.string().min(1),
    expectedAgendaVersionId: z.string().min(1),
    status: z.enum(['achieved', 'finished_with_gaps', 'expired_unfinished', 'abandoned']),
    unresolvedRiskIds: z.array(z.string().min(1)).max(1000),
    reason: z.string().min(1).max(1000),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      (request.status === 'finished_with_gaps' || request.status === 'abandoned') &&
      request.command.actor !== 'learner'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'only the learner may explicitly finish with gaps or abandon a goal',
      });
    }
    if (request.status === 'finished_with_gaps' && request.unresolvedRiskIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedRiskIds'],
        message: 'finished_with_gaps requires at least one named unresolved risk',
      });
    }
  });
export type RecordGoalOutcomeRequest = z.infer<typeof RecordGoalOutcomeRequestSchema>;

export const FormalProgressionOverviewSchema = z
  .object({
    evidence: z.array(FormalEvidenceRecordSchema).max(5000),
    reconciliations: z.array(ProgressionReconciliationSchema).max(5000),
    decisions: z.array(ProgressionDecisionSchema).max(5000),
    replanTriggers: z.array(ReplanTriggerSchema).max(500),
    goalOutcomes: z.array(GoalOutcomeSchema).max(500),
  })
  .strict();
export type FormalProgressionOverview = z.infer<typeof FormalProgressionOverviewSchema>;

export const ReconcileProgressionRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    gradingResultId: z.string().min(1),
    expectedStudyPlanId: z.string().min(1),
    expectedExecutionSourceManifestFingerprint: z.string().min(1),
  })
  .strict();
export type ReconcileProgressionRequest = z.infer<typeof ReconcileProgressionRequestSchema>;

export const ProgressionReconciliationResponseSchema = z
  .object({
    reconciliations: z.array(ProgressionReconciliationSchema).max(100),
    decisions: z.array(ProgressionDecisionSchema).max(100),
    evidence: z.array(FormalEvidenceRecordSchema).max(500),
    replanTriggers: z.array(ReplanTriggerSchema).max(50),
  })
  .strict();
export type ProgressionReconciliationResponse = z.infer<
  typeof ProgressionReconciliationResponseSchema
>;
