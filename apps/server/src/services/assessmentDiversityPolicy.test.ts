import { describe, expect, it } from 'vitest';
import {
  classifyConstructAuthority,
  evaluateDurableMastery,
  supportsFormalApplicationDemand,
  type FormalAssessmentConstruct,
} from '@hy3-clinic/shared';
import { selectAssessmentDiversityIntent } from './assessmentDiversityPolicy.js';

const prior = (
  representation: 'recall' | 'application',
  requestedChallengeFamily: 'transfer' | 'representation_shift' | null = null,
) => ({
  evidenceId: `evidence_${representation}_${requestedChallengeFamily ?? 'ordinary'}`,
  representation,
  requestedChallengeFamily,
  createdAt: '2026-08-26T00:00:00.000Z',
});

describe('assessment diversity policy', () => {
  it('keeps an immediate Formal check on the existing path', () => {
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'formal_checkpoint',
        objectiveConstruct: 'apply',
        priorEvidence: [],
      }),
    ).toEqual({
      selection: {
        policyVersion: 'assessment-diversity-intent-v1',
        requestedChallengeFamily: null,
        requestedRepresentation: null,
        selectionReason: 'ordinary_formal_check',
      },
      evidenceRepresentation: 'recall',
    });
  });

  it('selects representation_shift with a genuinely different supported representation', () => {
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'due_review',
        objectiveConstruct: 'apply',
        priorEvidence: [prior('recall')],
      }),
    ).toMatchObject({
      selection: {
        requestedChallengeFamily: 'representation_shift',
        requestedRepresentation: 'application',
        selectionReason: 'representation_diversity_missing',
      },
      evidenceRepresentation: 'application',
    });
  });

  it('falls back instead of inventing a representation for an incompatible objective', () => {
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'due_review',
        objectiveConstruct: 'identify',
        priorEvidence: [prior('recall')],
      }),
    ).toMatchObject({
      selection: {
        requestedChallengeFamily: null,
        requestedRepresentation: null,
        selectionReason: 'no_supported_alternative',
      },
      evidenceRepresentation: 'recall',
    });
  });

  it('requests transfer through the same application-capable Review after diversity exists', () => {
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'due_review',
        objectiveConstruct: 'apply',
        priorEvidence: [prior('recall'), prior('application', 'representation_shift')],
      }),
    ).toMatchObject({
      selection: {
        requestedChallengeFamily: 'transfer',
        requestedRepresentation: 'application',
        selectionReason: 'transfer_context_missing',
      },
      evidenceRepresentation: 'application',
    });
  });

  it('does not rotate challenges once a qualifying transfer request was demonstrated', () => {
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'due_review',
        objectiveConstruct: 'apply',
        priorEvidence: [prior('recall'), prior('application', 'transfer')],
      }),
    ).toMatchObject({
      selection: {
        requestedChallengeFamily: null,
        requestedRepresentation: 'application',
        selectionReason: 'ordinary_due_review',
      },
      evidenceRepresentation: 'application',
    });
  });

  it('does not force boundary, counterexample, near-neighbor, or synthesis intent from construct alone', () => {
    for (const objectiveConstruct of ['identify', 'explain'] as const) {
      expect(
        selectAssessmentDiversityIntent({
          assessmentKind: 'due_review',
          objectiveConstruct,
          priorEvidence: [prior('recall')],
        }).selection.requestedChallengeFamily,
      ).toBeNull();
    }
    expect(
      selectAssessmentDiversityIntent({
        assessmentKind: 'synthesis',
        objectiveConstruct: 'evaluate',
        priorEvidence: [prior('application')],
      }).selection.requestedChallengeFamily,
    ).toBeNull();
  });
});

/** Application demand describes accepted, supported evidence. The admission
 * and progression services independently check its source and scoring receipt. */
describe('Formal application demand follows construct authority, not ambition', () => {
  const dueReview = (objectiveConstruct: FormalAssessmentConstruct) =>
    selectAssessmentDiversityIntent({
      assessmentKind: 'due_review',
      objectiveConstruct,
      priorEvidence: [prior('recall')],
    });

  it('grants the application rung to the supported apply construct', () => {
    expect(supportsFormalApplicationDemand('apply')).toBe(true);
    expect(dueReview('apply').evidenceRepresentation).toBe('application');
  });

  it.each(['design', 'evaluate'] as const)(
    'can request application demand for a supported bounded %s assessment',
    (objectiveConstruct) => {
      expect(classifyConstructAuthority(objectiveConstruct)).toBe('formal_supported');
      expect(supportsFormalApplicationDemand(objectiveConstruct)).toBe(true);
      expect(dueReview(objectiveConstruct)).toMatchObject({
        selection: { requestedRepresentation: 'application' },
        evidenceRepresentation: 'application',
      });
    },
  );

  it('refuses the application rung to the weaker supported constructs', () => {
    for (const objectiveConstruct of ['identify', 'explain'] as const) {
      expect(classifyConstructAuthority(objectiveConstruct)).toBe('formal_supported');
      expect(supportsFormalApplicationDemand(objectiveConstruct)).toBe(false);
      expect(dueReview(objectiveConstruct).evidenceRepresentation).toBe('recall');
    }
  });

  it('counts supported reconciled higher-construct evidence toward application demand', () => {
    const policy = {
      minimumRepresentationCount: 1,
      minimumDemand: 'application' as const,
      requireDelayedUnseenEvidence: false,
    };
    const masteryFor = (objectiveConstruct: FormalAssessmentConstruct) =>
      evaluateDurableMastery({
        routeProgressComplete: true,
        currentReviewFailure: false,
        policy,
        evidence: [
          {
            evidenceId: 'evidence_1',
            representation: dueReview(objectiveConstruct).evidenceRepresentation,
            supported: true,
            reconciled: true,
            delayedReview: false,
            unseenBeforeAttempt: null,
          },
        ],
      });

    expect(masteryFor('apply').reasonCodes).not.toContain('application_demand_missing');
    for (const objectiveConstruct of ['design', 'evaluate'] as const) {
      expect(masteryFor(objectiveConstruct).reasonCodes).not.toContain(
        'application_demand_missing',
      );
      expect(masteryFor(objectiveConstruct).status).toBe('mastered');
    }
  });

  it('keeps depth and difficulty out of the decision entirely', () => {
    // The policy input has no depth field, so a "harder" request cannot enter.
    // Guard the property that the only construct-derived answer is authority.
    for (const objectiveConstruct of ['design', 'evaluate'] as const) {
      for (const priorEvidence of [
        [],
        [prior('recall')],
        [prior('recall'), prior('application', 'representation_shift')],
        [prior('recall'), prior('application', 'transfer')],
      ]) {
        expect(
          selectAssessmentDiversityIntent({
            assessmentKind: 'due_review',
            objectiveConstruct,
            priorEvidence,
          }).evidenceRepresentation,
        ).toBe('application');
      }
    }
  });
});
