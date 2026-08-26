import { z } from 'zod';
import { MasteryChallengeFamilySchema, type MasteryChallengeFamily } from './assessmentIntent.js';

export { MasteryChallengeFamilySchema, type MasteryChallengeFamily };

export const MASTERY_RED_TEAM_SNAPSHOT_POLICY = 'mastery-red-team-snapshot-v1';
export const MASTERY_RED_TEAM_HYPOTHESIS_POLICY = 'mastery-red-team-hypothesis-v1';
export const MASTERY_RED_TEAM_FAMILY_POLICY = 'mastery-red-team-family-selection-v1';
export const MASTERY_RED_TEAM_CHALLENGE_CONTRACT = 'mastery-red-team-challenge-v1';
export const MASTERY_RED_TEAM_VALIDATION_POLICY = 'mastery-red-team-validation-v1';
export const MASTERY_RED_TEAM_NOVELTY_POLICY = 'mastery-red-team-novelty-v1';
export const MASTERY_RED_TEAM_OUTCOME_POLICY = 'mastery-red-team-shadow-outcome-v1';
export const MASTERY_RED_TEAM_MAX_CANDIDATES = 3;
export const MASTERY_RED_TEAM_MAX_OBJECTIVES = 8;
export const MASTERY_RED_TEAM_MAX_FOLLOW_UP_DEPTH = 1;
export const MASTERY_RED_TEAM_MAX_OVERLAP = 0.82;

export const MasteryFragilityBasisSchema = z.enum([
  'direct_recall_only',
  'single_representation',
  'prerequisite_structure',
  'related_concepts',
  'historical_misconception',
  'historical_relation_error',
  'historical_application_error',
  'synthesis_group',
  'prior_shadow_possible_gap',
  'prior_shadow_inconclusive',
  'counterexample_not_observed',
  'alternative_refutation_not_observed',
]);
export type MasteryFragilityBasis = z.infer<typeof MasteryFragilityBasisSchema>;

export const MasteryFragilityHypothesisSchema = z
  .object({
    id: z.string().min(1),
    family: MasteryChallengeFamilySchema,
    basisCodes: z.array(MasteryFragilityBasisSchema).min(1).max(8),
    relatedRecordIds: z.array(z.string().min(1)).max(20),
    summary: z.string().min(1).max(500),
  })
  .strict();
export type MasteryFragilityHypothesis = z.infer<typeof MasteryFragilityHypothesisSchema>;

export const MasterySnapshotSourceSchema = z
  .object({
    ref: z.string().regex(/^S[1-9][0-9]*$/),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sourceBlockId: z.string().min(1),
    sourceBlockRevisionFingerprint: z.string().min(1),
    learningUnitIds: z.array(z.string().min(1)).min(1).max(8),
    objectiveIds: z.array(z.string().min(1)).min(1).max(20),
    quote: z.string().min(1).max(2000),
    contentOrigin: z.literal('extracted_original'),
    authoritative: z.literal(true),
  })
  .strict();
export type MasterySnapshotSource = z.infer<typeof MasterySnapshotSourceSchema>;

const MasterySnapshotEvidenceSchema = z
  .object({
    evidenceRecordId: z.string().min(1),
    gradeRecordId: z.string().min(1),
    attemptId: z.string().min(1),
    assessmentVersionId: z.string().min(1),
    itemId: z.string().min(1),
    conclusion: z.literal('supported'),
    policyVersion: z.string().min(1),
    reconciliationId: z.string().min(1),
    reconciliationStatus: z.literal('applied'),
    criterionResults: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            result: z.enum(['met', 'partial', 'not_met']),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    createdAt: z.string().datetime(),
  })
  .strict();

export const MasterySnapshotSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    courseId: z.string().min(1),
    reviewTargetId: z.string().min(1),
    parentRunId: z.string().min(1).nullable(),
    followUpDepth: z.number().int().min(0).max(MASTERY_RED_TEAM_MAX_FOLLOW_UP_DEPTH),
    route: z
      .object({
        courseExecutionVersion: z.number().int().nonnegative(),
        contractVersionId: z.string().min(1),
        curriculumVersionId: z.string().min(1),
        studyPlanVersionId: z.string().min(1),
        agendaId: z.string().min(1),
        executionSourceManifestFingerprint: z.string().min(1),
      })
      .strict(),
    target: z
      .object({
        learningUnitId: z.string().min(1),
        learningUnitTitle: z.string().min(1).max(300),
        objectiveId: z.string().min(1),
        objectiveTitle: z.string().min(1).max(300),
        objectiveDescription: z.string().min(1).max(1000),
        relatedObjectives: z
          .array(
            z
              .object({
                id: z.string().min(1),
                learningUnitId: z.string().min(1),
                title: z.string().min(1).max(300),
                description: z.string().min(1).max(1000),
              })
              .strict(),
          )
          .max(30),
        conceptIds: z.array(z.string().min(1)).max(30),
        prerequisiteUnitIds: z.array(z.string().min(1)).max(30),
        synthesisGroupIds: z.array(z.string().min(1)).max(20),
      })
      .strict(),
    progression: z
      .object({
        state: z.literal('completed'),
        reconciliationIds: z.array(z.string().min(1)).min(1).max(50),
      })
      .strict(),
    evidence: z.array(MasterySnapshotEvidenceSchema).min(1).max(30),
    masteryObservations: z
      .array(
        z
          .object({
            materialId: z.string().min(1),
            conceptId: z.string().min(1),
            mastery: z.number().min(0).max(1),
            attempts: z.number().int().nonnegative(),
            lastScore: z.number().min(0).max(1).nullable(),
            authority: z.literal('legacy_observation_only'),
          })
          .strict(),
      )
      .max(60),
    mistakeObservations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            conceptId: z.string().min(1),
            status: z.enum(['open', 'resolved']),
            score: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(60),
    misconceptionObservations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            conceptId: z.string().min(1),
            status: z.enum(['proposed', 'confirmed', 'rejected', 'resolved']),
            category: z.enum([
              'definition_confusion',
              'prerequisite_gap',
              'reversed_causality',
              'category_confusion',
              'sequence_error',
              'overgeneralization',
              'undergeneralization',
              'application_error',
              'unknown',
            ]),
            hypothesis: z.string().min(1).max(400),
          })
          .strict(),
      )
      .max(60),
    repairObservations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            status: z.enum([
              'OPEN',
              'ACTIVE',
              'AWAITING_VERIFICATION',
              'RESOLVED',
              'DEFERRED',
              'CANCELLED',
            ]),
            diagnosticCategory: z.string().min(1).max(80),
            gapSummary: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(60),
    review: z
      .object({
        dueAt: z.string().datetime(),
        lifecycleState: z.enum(['pending_initial_review', 'new', 'review']),
        rowVersion: z.number().int().positive(),
        authority: z.literal('scheduling_only'),
        events: z
          .array(
            z
              .object({
                id: z.string().min(1),
                kind: z.enum([
                  'activation',
                  'retrieval_failure',
                  'fresh_verification_success',
                  'migration',
                ]),
                sourceOutcomeId: z.string().min(1),
                rating: z.enum(['Again', 'Good']).nullable(),
                occurredAt: z.string().datetime(),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    priorQuestions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            prompt: z.string().min(1).max(2000),
            source: z.enum(['formal_assessment', 'mastery_red_team']),
          })
          .strict(),
      )
      .max(100),
    sources: z.array(MasterySnapshotSourceSchema).min(1).max(8),
    hypotheses: z.array(MasteryFragilityHypothesisSchema).min(1).max(20),
    policies: z
      .object({
        snapshot: z.literal(MASTERY_RED_TEAM_SNAPSHOT_POLICY),
        hypothesis: z.literal(MASTERY_RED_TEAM_HYPOTHESIS_POLICY),
        familySelection: z.literal(MASTERY_RED_TEAM_FAMILY_POLICY),
        challengeContract: z.literal(MASTERY_RED_TEAM_CHALLENGE_CONTRACT),
        validation: z.literal(MASTERY_RED_TEAM_VALIDATION_POLICY),
        novelty: z.literal(MASTERY_RED_TEAM_NOVELTY_POLICY),
        outcome: z.literal(MASTERY_RED_TEAM_OUTCOME_POLICY),
      })
      .strict(),
    snapshotHash: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MasterySnapshot = z.infer<typeof MasterySnapshotSchema>;

export const MasteryChallengePremiseSchema = z
  .object({
    text: z.string().min(1).max(500),
    sourceRefs: z
      .array(z.string().regex(/^S[1-9][0-9]*$/))
      .min(1)
      .max(4),
    learnerVisible: z.boolean(),
  })
  .strict();

export const MasteryChallengeCandidateSchema = z
  .object({
    candidateKey: z.string().min(1).max(80),
    family: MasteryChallengeFamilySchema,
    prompt: z.string().min(1).max(2000),
    expectedAnswer: z.string().min(1).max(1500),
    targetObjectiveRefs: z
      .array(z.string().regex(/^O[1-9][0-9]*$/))
      .min(1)
      .max(8),
    sourceRefs: z
      .array(z.string().regex(/^S[1-9][0-9]*$/))
      .min(1)
      .max(8),
    expectedAnswerSourceRefs: z
      .array(z.string().regex(/^S[1-9][0-9]*$/))
      .min(1)
      .max(8),
    premises: z.array(MasteryChallengePremiseSchema).max(8),
    rubric: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            text: z.string().min(1).max(500),
            required: z.boolean(),
            sourceRefs: z
              .array(z.string().regex(/^S[1-9][0-9]*$/))
              .min(1)
              .max(6),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    requiresExternalKnowledge: z.boolean(),
    ambiguity: z.enum(['none', 'resolved_in_prompt', 'unresolved']),
    undefinedTerms: z.array(z.string().min(1).max(100)).max(12),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type MasteryChallengeCandidate = z.infer<typeof MasteryChallengeCandidateSchema>;

export const MasteryChallengeProposalPayloadSchema = z
  .object({
    candidates: z.array(MasteryChallengeCandidateSchema).length(MASTERY_RED_TEAM_MAX_CANDIDATES),
  })
  .strict();
export type MasteryChallengeProposalPayload = z.infer<typeof MasteryChallengeProposalPayloadSchema>;

export const MasteryCandidateRejectionCodeSchema = z.enum([
  'STALE_SNAPSHOT',
  'STALE_ROUTE_BINDING',
  'STALE_SOURCE_REVISION',
  'NON_AUTHORITATIVE_SOURCE',
  'EXACT_QUOTE_FAILURE',
  'FAMILY_MISMATCH',
  'UNKNOWN_OBJECTIVE_REF',
  'TARGET_OBJECTIVE_MISSING',
  'UNKNOWN_SOURCE_REF',
  'SOURCE_SCOPE_MISMATCH',
  'MISSING_REQUIRED_RUBRIC',
  'UNBOUND_REQUIRED_RUBRIC',
  'UNBOUND_EXPECTED_ANSWER',
  'EXTERNAL_KNOWLEDGE_REQUIRED',
  'HIDDEN_PREMISE',
  'UNRESOLVED_AMBIGUITY',
  'UNDEFINED_TERM',
  'DUPLICATE_CANDIDATE',
  'PRIOR_QUESTION_OVERLAP',
  'TRIVIAL_CANDIDATE',
  'ANSWER_LEAKAGE',
  'PROVIDER_BUDGET_VIOLATION',
]);
export type MasteryCandidateRejectionCode = z.infer<typeof MasteryCandidateRejectionCodeSchema>;

export const MasteryCandidateValidationSchema = z
  .object({
    policyVersion: z.literal(MASTERY_RED_TEAM_VALIDATION_POLICY),
    valid: z.boolean(),
    rejectionCodes: z.array(MasteryCandidateRejectionCodeSchema).max(20),
    maxPriorOverlap: z.number().min(0).max(1),
    maxPriorOverlapId: z.string().min(1).nullable(),
    normalizedPromptFingerprint: z.string().min(1),
    exactQuoteValidated: z.boolean(),
    semanticEntailmentClaimed: z.literal(false),
  })
  .strict();
export type MasteryCandidateValidation = z.infer<typeof MasteryCandidateValidationSchema>;

export const MasteryRedTeamRunStatusSchema = z.enum([
  'generating',
  'selected',
  'evaluating',
  'evaluated',
  'generation_failed',
  'evaluation_failed',
]);
export type MasteryRedTeamRunStatus = z.infer<typeof MasteryRedTeamRunStatusSchema>;

export const MasteryRedTeamCandidateRecordSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .max(MASTERY_RED_TEAM_MAX_CANDIDATES - 1),
    providerCandidateKey: z.string().min(1),
    candidate: MasteryChallengeCandidateSchema,
    validation: MasteryCandidateValidationSchema,
    selected: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MasteryRedTeamCandidateRecord = z.infer<typeof MasteryRedTeamCandidateRecordSchema>;

export const MasteryRedTeamRunSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    snapshotId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
    parentRunId: z.string().min(1).nullable(),
    followUpDepth: z.number().int().min(0).max(MASTERY_RED_TEAM_MAX_FOLLOW_UP_DEPTH),
    selectedHypothesisId: z.string().min(1),
    selectedFamily: MasteryChallengeFamilySchema,
    familySelection: z
      .object({
        policyVersion: z.literal(MASTERY_RED_TEAM_FAMILY_POLICY),
        consideredFamilies: z.array(MasteryChallengeFamilySchema).min(1).max(20),
        priorExposure: z.record(z.string(), z.number().int().nonnegative()),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    status: MasteryRedTeamRunStatusSchema,
    selectedCandidateId: z.string().min(1).nullable(),
    assessmentVersionId: z.string().min(1).nullable(),
    submissionKey: z.string().min(1).max(200).nullable(),
    submissionAnswerHash: z.string().min(1).max(100).nullable(),
    failureCode: z.string().min(1).max(120).nullable(),
    provider: z.enum(['fake', 'hy3']),
    providerModel: z.string().max(120).nullable(),
    repairAttempted: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MasteryRedTeamRun = z.infer<typeof MasteryRedTeamRunSchema>;

export const MasteryRedTeamShadowOutcomeSchema = z.enum([
  'robust_signal',
  'possible_gap',
  'inconclusive',
]);
export type MasteryRedTeamShadowOutcome = z.infer<typeof MasteryRedTeamShadowOutcomeSchema>;

export const MasteryRedTeamEvaluationSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    gradeRecordId: z.string().min(1),
    outcome: MasteryRedTeamShadowOutcomeSchema,
    advisoryConfidence: z.enum(['low', 'medium']),
    advisoryRisk: z.enum(['none_observed', 'possible_hidden_gap', 'indeterminate']),
    proposedNextAction: z.enum([
      'none',
      'inspect_shadow_result',
      'propose_fresh_formal_inspection',
    ]),
    validationLimits: z.array(z.string().min(1).max(300)).min(1).max(10),
    evidenceCreated: z.literal(false),
    masteryMutated: z.literal(false),
    progressionMutated: z.literal(false),
    reviewMutated: z.literal(false),
    repairMutated: z.literal(false),
    policyVersion: z.literal(MASTERY_RED_TEAM_OUTCOME_POLICY),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MasteryRedTeamEvaluation = z.infer<typeof MasteryRedTeamEvaluationSchema>;

export const StartMasteryRedTeamRunRequestSchema = z
  .object({
    reviewTargetId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
    parentRunId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type StartMasteryRedTeamRunRequest = z.infer<typeof StartMasteryRedTeamRunRequestSchema>;

export const SubmitMasteryRedTeamRunRequestSchema = z
  .object({
    answer: z.string().min(1).max(10_000),
    submissionKey: z.string().min(1).max(200),
  })
  .strict();
export type SubmitMasteryRedTeamRunRequest = z.infer<typeof SubmitMasteryRedTeamRunRequestSchema>;

export const MasteryRedTeamRunDetailSchema = z
  .object({
    run: MasteryRedTeamRunSchema,
    snapshot: MasterySnapshotSchema,
    candidates: z.array(MasteryRedTeamCandidateRecordSchema).max(MASTERY_RED_TEAM_MAX_CANDIDATES),
    evaluation: MasteryRedTeamEvaluationSchema.nullable(),
  })
  .strict();
export type MasteryRedTeamRunDetail = z.infer<typeof MasteryRedTeamRunDetailSchema>;
