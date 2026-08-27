import { describe, expect, it } from 'vitest';
import {
  evaluateDurableMastery,
  FormalQuestionContractSchema,
  type DurableMasteryEvidenceFact,
} from './formalProgression.js';

const policy = {
  minimumRepresentationCount: 2,
  minimumDemand: 'application' as const,
  requireDelayedUnseenEvidence: true,
};

function evidence(
  evidenceId: string,
  overrides: Partial<DurableMasteryEvidenceFact> = {},
): DurableMasteryEvidenceFact {
  return {
    evidenceId,
    representation: 'recall',
    supported: true,
    reconciled: true,
    delayedReview: false,
    unseenBeforeAttempt: true,
    ...overrides,
  };
}

describe('durable mastery policy', () => {
  it('keeps immediate route-completing evidence provisional', () => {
    const result = evaluateDurableMastery({
      routeProgressComplete: true,
      currentReviewFailure: false,
      policy,
      evidence: [evidence('immediate')],
    });

    expect(result.status).toBe('evidence_backed');
    expect(result.reasonCodes).toEqual([
      'representation_diversity_missing',
      'application_demand_missing',
      'delayed_unseen_evidence_missing',
    ]);
  });

  it('requires route completion independently of the strong evidence set', () => {
    const result = evaluateDurableMastery({
      routeProgressComplete: false,
      currentReviewFailure: false,
      policy,
      evidence: [
        evidence('immediate'),
        evidence('delayed', { representation: 'application', delayedReview: true }),
      ],
    });

    expect(result.status).toBe('evidence_backed');
    expect(result.reasonCodes).toEqual(['route_progress_incomplete']);
  });

  it('recognizes representation diversity but still requires application demand', () => {
    const result = evaluateDurableMastery({
      routeProgressComplete: true,
      currentReviewFailure: false,
      policy,
      evidence: [
        evidence('recall'),
        evidence('explanation', { representation: 'explanation', delayedReview: true }),
      ],
    });

    expect(result.representations).toEqual(['recall', 'explanation']);
    expect(result.reasonCodes).toEqual([
      'application_demand_missing',
      'delayed_unseen_evidence_missing',
    ]);
  });

  it.each([
    ['already exposed', false],
    ['historically unknown', null],
  ] as const)('does not treat %s delayed evidence as unseen', (_label, unseenBeforeAttempt) => {
    const result = evaluateDurableMastery({
      routeProgressComplete: true,
      currentReviewFailure: false,
      policy,
      evidence: [
        evidence('immediate'),
        evidence('delayed', {
          representation: 'application',
          delayedReview: true,
          unseenBeforeAttempt,
        }),
      ],
    });

    expect(result.status).toBe('evidence_backed');
    expect(result.reasonCodes).toEqual(['delayed_unseen_evidence_missing']);
  });

  it('promotes only a completed route with diverse, applied, delayed unseen evidence', () => {
    const result = evaluateDurableMastery({
      routeProgressComplete: true,
      currentReviewFailure: false,
      policy,
      evidence: [
        evidence('immediate'),
        evidence('delayed', { representation: 'application', delayedReview: true }),
      ],
    });

    expect(result).toEqual({
      status: 'mastered',
      evidenceIds: ['immediate', 'delayed'],
      representations: ['recall', 'application'],
      reasonCodes: ['durable_mastery_demonstrated'],
    });
  });

  it('keeps a latest unresolved retrieval failure stronger than historical success', () => {
    const result = evaluateDurableMastery({
      routeProgressComplete: true,
      currentReviewFailure: true,
      policy,
      evidence: [
        evidence('immediate'),
        evidence('delayed', { representation: 'application', delayedReview: true }),
      ],
    });

    expect(result.status).toBe('evidence_backed');
    expect(result.reasonCodes).toEqual(['current_review_failure']);
  });
});

describe('formal question S1 authority contract', () => {
  it('cannot represent state credit without satisfied taught-premise visibility', () => {
    const result = FormalQuestionContractSchema.safeParse({
      id: 'formal_1',
      workspaceId: 'workspace_1',
      quizId: 'quiz_1',
      questionId: 'question_1',
      studySessionId: null,
      agendaItemId: 'agenda_item_1',
      assessmentKind: 'formal_checkpoint',
      primaryObjectiveId: 'objective_1',
      scoredSecondaryObjectiveIds: [],
      curriculumLearningUnitId: 'unit_1',
      difficulty: 'medium',
      targetDepth: 'working_fluency',
      representation: 'recall',
      admissibilityTier: 'tier_1_authorized_truth',
      stableScopeFingerprint: 'scope-fingerprint',
      contractVersionId: 'contract_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      executionSourceManifestFingerprint: 'manifest-fingerprint',
      provenance: [
        {
          materialId: 'material_1',
          materialRevisionId: 'revision_1',
          sourceBlockId: 'block_1',
          sourceBlockRevisionFingerprint: 'block-fingerprint',
          truthAuthorityClaimIds: ['claim_1'],
        },
      ],
      assessmentPremiseBindings: [
        {
          id: 'binding_1',
          premiseKey: 'expected_answer',
          premiseKind: 'expected_answer',
          premiseFingerprint: 'premise-fingerprint',
          truthAuthorityRecordId: 'authority_1',
          truthAuthorityClaimIds: ['claim_1'],
        },
      ],
      limitations: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected S1 contract refinement failure.');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['premiseVisibilityVerdict'],
          message: expect.stringContaining('current taught exposure'),
        }),
      ]),
    );
  });
});
