import { describe, expect, it } from 'vitest';
import {
  MasteryChallengeFamilySchema,
  MasteryChallengeProposalPayloadSchema,
  MasteryRedTeamEvaluationSchema,
  MasteryRedTeamRunSchema,
  MasterySnapshotSchema,
  StartMasteryRedTeamRunRequestSchema,
  SubmitMasteryRedTeamRunRequestSchema,
} from './masteryRedTeam.js';

it('retains the Mastery challenge-family export after shared extraction', () => {
  expect(MasteryChallengeFamilySchema.options).toContain('representation_shift');
});

const hypothesis = {
  id: 'hypothesis_1',
  family: 'transfer' as const,
  basisCodes: ['direct_recall_only' as const],
  relatedRecordIds: ['item_1'],
  summary: 'Direct prior evidence may not establish transfer.',
};

const snapshot = {
  id: 'snapshot_1',
  workspaceId: 'workspace_1',
  courseId: 'course_1',
  reviewTargetId: 'review_target_1',
  parentRunId: null,
  followUpDepth: 0,
  route: {
    courseExecutionVersion: 3,
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'study_plan_1',
    agendaId: 'agenda_1',
    executionSourceManifestFingerprint: 'manifest_1',
  },
  target: {
    learningUnitId: 'unit_1',
    learningUnitTitle: 'Bounded claims',
    objectiveId: 'objective_1',
    objectiveTitle: 'Explain the bounded claim',
    objectiveDescription: 'Explain the claim and its condition.',
    relatedObjectives: [],
    conceptIds: ['concept_1'],
    prerequisiteUnitIds: [],
    synthesisGroupIds: [],
  },
  progression: { state: 'completed' as const, reconciliationIds: ['reconciliation_1'] },
  evidence: [
    {
      evidenceRecordId: 'evidence_1',
      gradeRecordId: 'grade_1',
      attemptId: 'attempt_1',
      assessmentVersionId: 'assessment_version_1',
      itemId: 'item_1',
      conclusion: 'supported' as const,
      policyVersion: 'formal-policy-1',
      reconciliationId: 'reconciliation_1',
      reconciliationStatus: 'applied' as const,
      criterionResults: [{ criterionId: 'criterion_1', result: 'met' as const }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  masteryObservations: [],
  mistakeObservations: [],
  misconceptionObservations: [],
  repairObservations: [],
  review: {
    dueAt: '2026-02-01T00:00:00.000Z',
    lifecycleState: 'review' as const,
    rowVersion: 2,
    authority: 'scheduling_only' as const,
    events: [],
  },
  priorQuestions: [],
  sources: [
    {
      ref: 'S1',
      materialId: 'material_1',
      materialRevisionId: 'revision_1',
      sourceBlockId: 'block_1',
      sourceBlockRevisionFingerprint: 'block_fingerprint_1',
      learningUnitIds: ['unit_1'],
      objectiveIds: ['objective_1'],
      quote: 'The claim holds only under the supplied condition.',
      contentOrigin: 'extracted_original' as const,
      authoritative: true as const,
    },
  ],
  hypotheses: [hypothesis],
  policies: {
    snapshot: 'mastery-red-team-snapshot-v1' as const,
    hypothesis: 'mastery-red-team-hypothesis-v1' as const,
    familySelection: 'mastery-red-team-family-selection-v1' as const,
    challengeContract: 'mastery-red-team-challenge-v1' as const,
    validation: 'mastery-red-team-validation-v1' as const,
    novelty: 'mastery-red-team-novelty-v1' as const,
    outcome: 'mastery-red-team-shadow-outcome-v1' as const,
  },
  snapshotHash: 'snapshot_hash_1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const candidate = {
  candidateKey: 'candidate_1',
  family: 'transfer' as const,
  prompt: 'Apply the supplied claim to the changed condition and explain the boundary.',
  expectedAnswer: 'The claim holds only under the supplied condition.',
  targetObjectiveRefs: ['O1'],
  sourceRefs: ['S1'],
  expectedAnswerSourceRefs: ['S1'],
  premises: [{ text: 'Use the supplied condition.', sourceRefs: ['S1'], learnerVisible: true }],
  rubric: [
    {
      key: 'criterion_1',
      text: 'States the source-grounded condition.',
      required: true,
      sourceRefs: ['S1'],
    },
  ],
  requiresExternalKnowledge: false,
  ambiguity: 'none' as const,
  undefinedTerms: [],
  rationale: 'Tests a bounded transfer without adding outside facts.',
};

describe('Mastery Red Team shared contracts', () => {
  it('accepts one complete immutable snapshot and rejects empty authority inputs', () => {
    expect(MasterySnapshotSchema.parse(snapshot).progression.state).toBe('completed');
    expect(() => MasterySnapshotSchema.parse({ ...snapshot, evidence: [] })).toThrow();
    expect(() => MasterySnapshotSchema.parse({ ...snapshot, hypotheses: [] })).toThrow();
    expect(() => MasterySnapshotSchema.parse({ ...snapshot, sources: [] })).toThrow();
  });

  it('requires exactly three structured candidates', () => {
    expect(
      MasteryChallengeProposalPayloadSchema.parse({
        candidates: [
          candidate,
          { ...candidate, candidateKey: 'candidate_2' },
          { ...candidate, candidateKey: 'candidate_3' },
        ],
      }).candidates,
    ).toHaveLength(3);
    expect(() =>
      MasteryChallengeProposalPayloadSchema.parse({ candidates: [candidate] }),
    ).toThrow();
  });

  it('keeps run selection and provider-repair audit fields mandatory', () => {
    const run = {
      id: 'run_1',
      workspaceId: 'workspace_1',
      snapshotId: 'snapshot_1',
      idempotencyKey: 'start_1',
      parentRunId: null,
      followUpDepth: 0,
      selectedHypothesisId: hypothesis.id,
      selectedFamily: hypothesis.family,
      familySelection: {
        policyVersion: 'mastery-red-team-family-selection-v1' as const,
        consideredFamilies: ['transfer' as const],
        priorExposure: { transfer: 0 },
        reason: 'Least-used locally supported family.',
      },
      status: 'selected' as const,
      selectedCandidateId: 'candidate_record_1',
      assessmentVersionId: 'assessment_shadow_1',
      submissionKey: null,
      submissionAnswerHash: null,
      failureCode: null,
      provider: 'fake' as const,
      providerModel: null,
      repairAttempted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(MasteryRedTeamRunSchema.parse(run).repairAttempted).toBe(false);
    const { familySelection: _selection, ...withoutSelection } = run;
    expect(() => MasteryRedTeamRunSchema.parse(withoutSelection)).toThrow();
  });

  it('requires explicit no-mutation assertions on every shadow evaluation', () => {
    const evaluation = {
      id: 'evaluation_1',
      runId: 'run_1',
      attemptId: 'attempt_shadow_1',
      gradeRecordId: 'grade_shadow_1',
      outcome: 'possible_gap' as const,
      advisoryConfidence: 'medium' as const,
      advisoryRisk: 'possible_hidden_gap' as const,
      proposedNextAction: 'propose_fresh_formal_inspection' as const,
      validationLimits: ['Exact quotation is not complete semantic entailment.'],
      evidenceCreated: false as const,
      masteryMutated: false as const,
      progressionMutated: false as const,
      reviewMutated: false as const,
      repairMutated: false as const,
      policyVersion: 'mastery-red-team-shadow-outcome-v1' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(MasteryRedTeamEvaluationSchema.parse(evaluation).outcome).toBe('possible_gap');
    expect(() =>
      MasteryRedTeamEvaluationSchema.parse({ ...evaluation, evidenceCreated: true }),
    ).toThrow();
  });

  it('keeps developer start and submit inputs strict and idempotency-bound', () => {
    expect(
      StartMasteryRedTeamRunRequestSchema.parse({
        reviewTargetId: 'review_target_1',
        idempotencyKey: 'start_1',
      }),
    ).toMatchObject({ reviewTargetId: 'review_target_1', idempotencyKey: 'start_1' });
    expect(
      SubmitMasteryRedTeamRunRequestSchema.parse({
        answer: 'Bounded answer.',
        submissionKey: 'submit_1',
      }),
    ).toMatchObject({ submissionKey: 'submit_1' });
    expect(() =>
      SubmitMasteryRedTeamRunRequestSchema.parse({
        answer: 'Bounded answer.',
        submissionKey: 'submit_1',
        mutateMastery: true,
      }),
    ).toThrow();
  });
});
