import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_INTENT_POLICY_VERSION,
  AssessmentIntentSelectionSchema,
  AssessmentItemIntentSchema,
  MasteryChallengeFamilySchema,
} from './assessmentIntent.js';

describe('assessment intent contracts', () => {
  it('shares the complete existing Mastery Red Team family vocabulary', () => {
    expect(MasteryChallengeFamilySchema.options).toEqual([
      'transfer',
      'boundary_conditions',
      'near_neighbor_confusion',
      'hidden_premise_change',
      'counterexample',
      'error_diagnosis',
      'plausible_alternative_refutation',
      'cross_learning_unit_synthesis',
      'historical_misconception',
      'adversarial_distractor',
      'discriminative_follow_up',
      'representation_shift',
    ]);
  });

  it('binds special reasons to locally selected families and representations', () => {
    expect(
      AssessmentIntentSelectionSchema.parse({
        policyVersion: ASSESSMENT_INTENT_POLICY_VERSION,
        requestedChallengeFamily: 'representation_shift',
        requestedRepresentation: 'application',
        selectionReason: 'representation_diversity_missing',
      }),
    ).toMatchObject({ requestedChallengeFamily: 'representation_shift' });
    expect(() =>
      AssessmentIntentSelectionSchema.parse({
        policyVersion: ASSESSMENT_INTENT_POLICY_VERSION,
        requestedChallengeFamily: 'transfer',
        requestedRepresentation: null,
        selectionReason: 'transfer_context_missing',
      }),
    ).toThrow();
    expect(() =>
      AssessmentIntentSelectionSchema.parse({
        policyVersion: ASSESSMENT_INTENT_POLICY_VERSION,
        requestedChallengeFamily: 'counterexample',
        requestedRepresentation: 'application',
        selectionReason: 'ordinary_due_review',
      }),
    ).toThrow();
  });

  it('records the local request against one exact assessment item and stage', () => {
    expect(
      AssessmentItemIntentSchema.parse({
        id: 'assessment_intent_1',
        workspaceId: 'workspace_1',
        assessmentVersionId: 'assessment_version_1',
        itemId: 'assessment_item_1',
        assessmentStage: 'due_review',
        policyVersion: ASSESSMENT_INTENT_POLICY_VERSION,
        requestedChallengeFamily: 'transfer',
        requestedRepresentation: 'application',
        selectionReason: 'transfer_context_missing',
        createdAt: '2026-08-26T00:00:00.000Z',
      }),
    ).toMatchObject({
      assessmentStage: 'due_review',
      requestedChallengeFamily: 'transfer',
    });
  });
});
