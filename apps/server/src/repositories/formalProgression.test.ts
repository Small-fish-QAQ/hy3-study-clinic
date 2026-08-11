import { beforeEach, describe, expect, it } from 'vitest';
import {
  FormalEvidenceRecordSchema,
  FormalQuestionContractSchema,
  type EvidenceAdmissibilityTier,
  type ProgressionDecision,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { makeQuestion, makeQuiz, makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.quizzes.insert(
    makeQuiz({
      id: 'quiz_formal',
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive',
      assessmentMode: 'formal_checkpoint',
      questions: [
        makeQuestion({
          id: 'question_formal',
          quizId: 'quiz_formal',
          type: 'short_answer',
          options: undefined,
          correctOptionIds: undefined,
          expectedAnswer: 'The admitted answer.',
          rubric: { keyPoints: [{ text: 'The admitted rubric point.', required: true }] },
        }),
      ],
    }),
  );
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, predecessor_id, status, payload,
        learner_confirmed_at, created_at)
     VALUES ('contract_1', 'ws_1', 1, NULL, 'active', '{}', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO execution_source_manifests
       (id, workspace_id, fingerprint, payload, created_at)
     VALUES ('manifest_1', 'ws_1', 'manifest-fp', '{}', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO curriculum_versions
       (id, workspace_id, contract_id, manifest_id, manifest_fingerprint,
        version, predecessor_id, status, validation_valid, payload, created_at, accepted_at)
     VALUES ('curriculum_1', 'ws_1', 'contract_1', 'manifest_1', 'manifest-fp',
        1, NULL, 'accepted', 1, '{}', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO study_plan_versions
       (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint,
        version, predecessor_id, status, payload, created_at, learner_accepted_at)
     VALUES ('plan_1', 'ws_1', 'contract_1', 'curriculum_1', 'manifest-fp',
        1, NULL, 'accepted', '{}', ?, ?)`,
  ).run(T0, T0);
  repos.submissions.insertSubmission({
    id: 'submission_1',
    quizId: 'quiz_formal',
    answers: [
      { questionId: 'question_formal', type: 'short_answer', text: 'The admitted answer.' },
    ],
    createdAt: T0,
  });
  repos.submissions.insertGradingResult({
    id: 'grading_1',
    submissionId: 'submission_1',
    quizId: 'quiz_formal',
    grades: [
      {
        questionId: 'question_formal',
        type: 'short_answer',
        gradedBy: 'model',
        correct: true,
        awardedPoints: 1,
        maxPoints: 1,
        normalizedScore: 1,
        needsReview: false,
      },
    ],
    totalAwarded: 1,
    totalPossible: 1,
    overallScore: 1,
    createdAt: T0,
  });
});

function insertContract(tier: EvidenceAdmissibilityTier) {
  const provenance =
    tier === 'tier_3_advisory'
      ? []
      : [
          {
            materialId: 'material_1',
            materialRevisionId: 'revision_1',
            sourceBlockId: 'block_1',
            sourceBlockRevisionFingerprint: 'block-fp',
            truthAuthorityClaimIds: ['claim_1', 'claim_2'],
          },
        ];
  return repos.formalProgression.insertQuestionContracts([
    FormalQuestionContractSchema.parse({
      id: `formal_${tier}`,
      workspaceId: 'ws_1',
      quizId: 'quiz_formal',
      questionId: 'question_formal',
      studySessionId: null,
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      primaryObjectiveId: 'objective_1',
      scoredSecondaryObjectiveIds: [],
      curriculumLearningUnitId: 'unit_1',
      difficulty: 'medium',
      targetDepth: 'working_fluency',
      representation: 'recognition',
      admissibilityTier: tier,
      stableScopeFingerprint: 'scope-fp',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
      provenance,
      assessmentPremiseBindings:
        tier === 'tier_3_advisory'
          ? []
          : [
              {
                id: 'premise_binding_expected',
                premiseKey: 'expected_answer',
                premiseKind: 'expected_answer',
                premiseFingerprint: 'expected-answer-fingerprint',
                truthAuthorityRecordId: 'authority_1',
                truthAuthorityClaimIds: ['claim_1'],
              },
              {
                id: 'premise_binding_rubric',
                premiseKey: 'rubric_point:0',
                premiseKind: 'rubric_point',
                premiseFingerprint: 'rubric-fingerprint',
                truthAuthorityRecordId: 'authority_2',
                truthAuthorityClaimIds: ['claim_2'],
              },
            ],
      limitations: tier === 'tier_3_advisory' ? ['Advisory only.'] : [],
      createdAt: T0,
    }),
  ])[0]!;
}

function evidenceFor(
  contractId: string,
  tier: EvidenceAdmissibilityTier,
  stateCreditable: boolean,
) {
  return repos.formalProgression.insertEvidence(
    FormalEvidenceRecordSchema.parse({
      id: `evidence_${tier}`,
      formalQuestionContractId: contractId,
      gradingResultId: 'grading_1',
      questionId: 'question_formal',
      primaryObjectiveId: 'objective_1',
      curriculumLearningUnitId: 'unit_1',
      admissibilityTier: tier,
      normalizedScore: 1,
      correct: true,
      needsReview: false,
      stateCreditable,
      assessmentPremiseBindingIds:
        tier === 'tier_3_advisory' ? [] : ['premise_binding_expected', 'premise_binding_rubric'],
      limitations: stateCreditable ? [] : ['Advisory only.'],
      createdAt: T0,
    }),
  );
}

function createPendingReconciliation() {
  return repos.formalProgression.createReconciliation({
    id: 'reconciliation_1',
    workspaceId: 'ws_1',
    gradingResultId: 'grading_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    curriculumLearningUnitId: 'unit_1',
    completionPolicyId: 'policy_1',
    completionPolicyVersion: 1,
    status: 'reconciliation_pending',
    decisionId: null,
    reason: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

describe('formal progression repository', () => {
  it('rejects state-crediting choice contracts without full option classification authority', () => {
    repos.quizzes.insert(
      makeQuiz({
        id: 'quiz_choice',
        materialId: null,
        workspaceId: 'ws_1',
        kind: 'adaptive',
        assessmentMode: 'formal_checkpoint',
        questions: [makeQuestion({ id: 'question_choice', quizId: 'quiz_choice' })],
      }),
    );
    const contract = FormalQuestionContractSchema.parse({
      id: 'formal_choice_unsafe',
      workspaceId: 'ws_1',
      quizId: 'quiz_choice',
      questionId: 'question_choice',
      studySessionId: null,
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      primaryObjectiveId: 'objective_1',
      scoredSecondaryObjectiveIds: [],
      curriculumLearningUnitId: 'unit_1',
      difficulty: 'medium',
      targetDepth: 'working_fluency',
      representation: 'recognition',
      admissibilityTier: 'tier_1_authorized_truth',
      stableScopeFingerprint: 'scope-fp',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fp',
      provenance: [
        {
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          sourceBlockId: 'block_1',
          sourceBlockRevisionFingerprint: 'block-fp',
          truthAuthorityClaimIds: ['claim_correct_option'],
        },
      ],
      assessmentPremiseBindings: [
        {
          id: 'premise_binding_correct_option',
          premiseKey: 'choice_answer:A',
          premiseKind: 'choice_answer',
          premiseFingerprint: 'full-options-and-answer-key-fingerprint',
          truthAuthorityRecordId: 'authority_correct_option',
          truthAuthorityClaimIds: ['claim_correct_option'],
        },
      ],
      limitations: [],
      createdAt: T0,
    });

    expect(() => repos.formalProgression.insertQuestionContracts([contract])).toThrow(
      'full option set',
    );
  });

  it('keeps tier-3 evidence advisory and rejects it as progression input', () => {
    const contract = insertContract('tier_3_advisory');
    const evidence = evidenceFor(contract.id, 'tier_3_advisory', false);
    const reconciliation = createPendingReconciliation();
    const decision: ProgressionDecision = {
      id: 'decision_1',
      workspaceId: 'ws_1',
      curriculumLearningUnitId: 'unit_1',
      completionPolicyId: 'policy_1',
      completionPolicyVersion: 1,
      kind: 'complete',
      priorState: 'not_started',
      nextState: 'complete',
      evidenceIds: [evidence.id],
      reasonCodes: ['test'],
      createdAt: T0,
    };

    expect(() => repos.formalProgression.applyDecision(reconciliation.id, decision, 0)).toThrow(
      'admissible state-crediting evidence',
    );
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1').state).toBe(
      'not_started',
    );
  });

  it('applies eligible evidence once and replays without incrementing progress twice', () => {
    const contract = insertContract('tier_1_authorized_truth');
    const evidence = evidenceFor(contract.id, 'tier_1_authorized_truth', true);
    const reconciliation = createPendingReconciliation();
    const decision: ProgressionDecision = {
      id: 'decision_1',
      workspaceId: 'ws_1',
      curriculumLearningUnitId: 'unit_1',
      completionPolicyId: 'policy_1',
      completionPolicyVersion: 1,
      kind: 'complete',
      priorState: 'not_started',
      nextState: 'complete',
      evidenceIds: [evidence.id],
      reasonCodes: ['eligible_evidence_satisfied'],
      createdAt: T0,
    };

    const first = repos.formalProgression.applyDecision(reconciliation.id, decision, 0);
    const replay = repos.formalProgression.applyDecision(reconciliation.id, decision, 0);
    expect(replay).toEqual(first);
    expect(repos.formalProgression.getUnitProgress('ws_1', 'curriculum_1', 'unit_1')).toMatchObject(
      {
        state: 'complete',
        version: 1,
        lastDecisionId: 'decision_1',
      },
    );
  });
});
