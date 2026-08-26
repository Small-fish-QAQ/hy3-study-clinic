import { describe, expect, it } from 'vitest';
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
        objectiveConstruct: 'evaluate',
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
