import { describe, expect, it } from 'vitest';
import { evaluateDurableMastery, type DurableMasteryEvidenceFact } from './formalProgression.js';

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
