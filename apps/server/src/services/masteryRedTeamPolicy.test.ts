import { describe, expect, it } from 'vitest';
import { MasterySnapshotSchema } from '@hy3-clinic/shared';
import {
  analyzeMasteryChallengeProposal,
  classifyShadowOutcome,
  deriveFragilityHypotheses,
  lexicalChallengeOverlap,
  selectChallengeFamily,
} from './masteryRedTeamPolicy.js';

const snapshot = MasterySnapshotSchema.parse({
  id: 'snapshot_1',
  workspaceId: 'ws_1',
  courseId: 'course_1',
  reviewTargetId: 'target_1',
  parentRunId: null,
  followUpDepth: 0,
  route: {
    courseExecutionVersion: 1,
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    agendaId: 'agenda_1',
    executionSourceManifestFingerprint: 'manifest_1',
  },
  target: {
    learningUnitId: 'unit_1',
    learningUnitTitle: 'Unit',
    objectiveId: 'objective_1',
    objectiveTitle: 'Explain the claim',
    objectiveDescription: 'Explain the claim from the source.',
    relatedObjectives: [
      {
        id: 'objective_2',
        learningUnitId: 'unit_1',
        title: 'Apply the claim',
        description: 'Apply the claim within its source-grounded boundary.',
      },
    ],
    conceptIds: ['concept_1', 'concept_2'],
    prerequisiteUnitIds: ['unit_0'],
    synthesisGroupIds: ['synthesis_1'],
  },
  progression: { state: 'completed', reconciliationIds: ['reconciliation_1'] },
  evidence: [
    {
      evidenceRecordId: 'evidence_1',
      gradeRecordId: 'grade_1',
      attemptId: 'attempt_1',
      assessmentVersionId: 'version_1',
      itemId: 'item_1',
      conclusion: 'supported',
      policyVersion: 'formal-assessment-evidence-v2-criterion-gate',
      reconciliationId: 'reconciliation_1',
      reconciliationStatus: 'applied',
      criterionResults: [{ criterionId: 'criterion_1', result: 'met' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  masteryObservations: [],
  mistakeObservations: [],
  misconceptionObservations: [],
  repairObservations: [],
  review: {
    dueAt: '2027-01-01T00:00:00.000Z',
    lifecycleState: 'review',
    rowVersion: 2,
    authority: 'scheduling_only',
    events: [],
  },
  priorQuestions: [
    { id: 'prior_1', prompt: 'Explain the claim directly.', source: 'formal_assessment' },
  ],
  sources: [
    {
      ref: 'S1',
      materialId: 'material_1',
      materialRevisionId: 'revision_1',
      sourceBlockId: 'block_1',
      sourceBlockRevisionFingerprint: 'block_fingerprint_1',
      learningUnitIds: ['unit_1'],
      objectiveIds: ['objective_1'],
      quote: 'The claim holds under the supplied condition.',
      contentOrigin: 'extracted_original',
      authoritative: true,
    },
  ],
  hypotheses: [
    {
      id: 'hypothesis_1',
      family: 'transfer',
      basisCodes: ['direct_recall_only'],
      relatedRecordIds: ['item_1'],
      summary: 'Prior evidence may not establish transfer.',
    },
  ],
  policies: {
    snapshot: 'mastery-red-team-snapshot-v1',
    hypothesis: 'mastery-red-team-hypothesis-v1',
    familySelection: 'mastery-red-team-family-selection-v1',
    challengeContract: 'mastery-red-team-challenge-v1',
    validation: 'mastery-red-team-validation-v1',
    novelty: 'mastery-red-team-novelty-v1',
    outcome: 'mastery-red-team-shadow-outcome-v1',
  },
  snapshotHash: 'snapshot_hash_1',
  createdAt: '2026-01-01T00:00:00.000Z',
});

const candidate = {
  candidateKey: 'candidate_1',
  family: 'transfer' as const,
  prompt:
    'Apply the supplied claim to a changed but source-grounded condition and explain why it holds.',
  expectedAnswer: 'The claim holds under the supplied condition.',
  targetObjectiveRefs: ['O1'],
  sourceRefs: ['S1'],
  expectedAnswerSourceRefs: ['S1'],
  premises: [{ text: 'Use the supplied condition.', sourceRefs: ['S1'], learnerVisible: true }],
  rubric: [
    {
      key: 'criterion_1',
      text: 'States the source-grounded claim.',
      required: true,
      sourceRefs: ['S1'],
    },
  ],
  requiresExternalKnowledge: false,
  ambiguity: 'none' as const,
  undefinedTerms: [],
  rationale: 'Tests transfer while retaining source authority.',
};

describe('Mastery Red Team shadow policy', () => {
  it('derives adversarial families only from named observable fixture bases', () => {
    const hypotheses = deriveFragilityHypotheses({
      reviewTargetId: 'target_mastered_looking',
      evidencePrompts: [{ id: 'evidence_direct', prompt: 'State the claim directly.' }],
      conceptIds: ['concept_primary', 'concept_near_neighbor'],
      relatedObjectiveIds: ['objective_near_neighbor'],
      prerequisiteUnitIds: ['unit_prerequisite'],
      synthesisGroupIds: ['synthesis_cross_unit'],
      misconceptions: [
        {
          id: 'historical_hidden_misconception',
          status: 'resolved',
          category: 'definition_confusion',
        },
      ],
      repairs: [],
      parentOutcome: null,
    });

    expect(hypotheses.map((item) => item.family)).toEqual(
      expect.arrayContaining([
        'historical_misconception',
        'near_neighbor_confusion',
        'transfer',
        'boundary_conditions',
        'cross_learning_unit_synthesis',
      ]),
    );
    expect(hypotheses.find((item) => item.family === 'historical_misconception')).toMatchObject({
      basisCodes: ['historical_misconception'],
      relatedRecordIds: ['historical_hidden_misconception'],
    });
  });

  it('derives named fragility hypotheses without calibrated mastery probabilities', () => {
    const hypotheses = deriveFragilityHypotheses({
      reviewTargetId: 'target_1',
      evidencePrompts: [{ id: 'item_1', prompt: 'Explain the claim directly.' }],
      conceptIds: ['concept_1', 'concept_2'],
      relatedObjectiveIds: ['objective_2'],
      prerequisiteUnitIds: ['unit_0'],
      synthesisGroupIds: ['synthesis_1'],
      misconceptions: [{ id: 'mis_1', status: 'resolved', category: 'definition_confusion' }],
      repairs: [],
      parentOutcome: null,
    });
    expect(hypotheses.map((item) => item.family)).toEqual(
      expect.arrayContaining([
        'transfer',
        'boundary_conditions',
        'historical_misconception',
        'cross_learning_unit_synthesis',
      ]),
    );
    expect(JSON.stringify(hypotheses)).not.toMatch(/theta|probability|posterior|irt|bkt/i);
  });

  it('rotates least-used supported families deterministically', () => {
    const hypotheses = deriveFragilityHypotheses({
      reviewTargetId: 'target_1',
      evidencePrompts: [{ id: 'item_1', prompt: 'Explain the claim directly.' }],
      conceptIds: ['concept_1'],
      relatedObjectiveIds: [],
      prerequisiteUnitIds: [],
      synthesisGroupIds: [],
      misconceptions: [],
      repairs: [],
      parentOutcome: null,
    });
    const selected = selectChallengeFamily(hypotheses, { transfer: 2, boundary_conditions: 0 });
    expect(selected.hypothesis.family).toBe('boundary_conditions');
    expect(selected.selection.consideredFamilies.length).toBeGreaterThan(1);
  });

  it('rejects unsupported, hidden, external, duplicate, trivial, and leaked candidates', () => {
    const invalid = {
      ...candidate,
      sourceRefs: ['S99'],
      expectedAnswerSourceRefs: ['S99'],
      premises: [{ text: 'Hidden fact', sourceRefs: ['S1'], learnerVisible: false }],
      requiresExternalKnowledge: true,
      ambiguity: 'unresolved' as const,
      undefinedTerms: ['x'],
      prompt: 'The claim holds under the supplied condition.',
    };
    const result = analyzeMasteryChallengeProposal(
      { candidates: [invalid, invalid, invalid] },
      snapshot,
      'transfer',
    );
    expect(result.selectedIndex).toBeNull();
    expect(result.validations[0]?.rejectionCodes).toEqual(
      expect.arrayContaining([
        'UNKNOWN_SOURCE_REF',
        'EXTERNAL_KNOWLEDGE_REQUIRED',
        'HIDDEN_PREMISE',
        'UNRESOLVED_AMBIGUITY',
        'UNDEFINED_TERM',
        'ANSWER_LEAKAGE',
      ]),
    );
    expect(result.validations[1]?.rejectionCodes).toContain('DUPLICATE_CANDIDATE');
  });

  it('rejects objective aliases that were not included in the bounded provider offer', () => {
    const boundedSnapshot = MasterySnapshotSchema.parse({
      ...snapshot,
      target: {
        ...snapshot.target,
        relatedObjectives: Array.from({ length: 8 }, (_, index) => ({
          id: `objective_${index + 2}`,
          learningUnitId: 'unit_1',
          title: `Related objective ${index + 2}`,
          description: `Bounded related objective ${index + 2}.`,
        })),
      },
    });
    const result = analyzeMasteryChallengeProposal(
      {
        candidates: Array.from({ length: 3 }, (_, index) => ({
          ...candidate,
          candidateKey: `candidate_unoffered_${index + 1}`,
          prompt: `${candidate.prompt} Variant ${index + 1}.`,
          targetObjectiveRefs: ['O1', 'O9'],
        })),
      },
      boundedSnapshot,
      'transfer',
    );

    expect(result.selectedIndex).toBeNull();
    expect(
      result.validations.every((item) => item.rejectionCodes.includes('UNKNOWN_OBJECTIVE_REF')),
    ).toBe(true);
  });

  it('selects one admissible candidate and classifies shadow outcomes', () => {
    const result = analyzeMasteryChallengeProposal(
      {
        candidates: [
          candidate,
          {
            ...candidate,
            candidateKey: 'candidate_2',
            prompt: `${candidate.prompt} Include the boundary.`,
          },
          {
            ...candidate,
            candidateKey: 'candidate_3',
            prompt: `${candidate.prompt} Compare the alternative.`,
          },
        ],
      },
      snapshot,
      'transfer',
    );
    expect(result.selectedIndex).not.toBeNull();
    expect(result.providerValidation.valid).toBe(true);
    expect(
      classifyShadowOutcome({
        requiredCriterionIds: ['criterion_1'],
        criterionResults: [{ criterionId: 'criterion_1', result: 'met' }],
      }),
    ).toBe('robust_signal');
    expect(
      classifyShadowOutcome({
        requiredCriterionIds: ['criterion_1'],
        criterionResults: [{ criterionId: 'criterion_1', result: 'not_met' }],
      }),
    ).toBe('possible_gap');
    expect(
      classifyShadowOutcome({ requiredCriterionIds: ['criterion_1'], criterionResults: [] }),
    ).toBe('inconclusive');
    expect(lexicalChallengeOverlap(candidate.prompt, candidate.prompt)).toBe(1);
  });
});
