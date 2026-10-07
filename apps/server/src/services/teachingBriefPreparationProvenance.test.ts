import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  projectPracticePriorTeaching,
  type AcceptedLessonCheckpoint,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import { preparePracticeAnswerabilityReview } from './teachingContentReview.js';
import {
  COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
  COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
} from './lessonPedagogyEvaluator.js';
import {
  compositionFingerprint,
  isCurrentAcceptedLessonCheckpoint,
  isCurrentCompositionalBrief,
  LESSON_CONTENT_PROMPT_VERSION,
  PRACTICE_CONTENT_PROMPT_VERSION,
  selectCurrentAcceptedLessonCheckpoint,
  TEACHING_BRIEF_PROMPT_VERSION,
} from './teachingBriefPreparation.js';

const SKELETON_FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function acceptedCheckpoint(
  overrides: {
    lessonLogicalCallId?: string | null;
    policyVersion?: string;
    promptVersion?: string;
    status?: 'pass' | 'fail';
  } = {},
): AcceptedLessonCheckpoint {
  return {
    promptVersion: overrides.promptVersion ?? LESSON_CONTENT_PROMPT_VERSION,
    lessonLogicalCallId:
      overrides.lessonLogicalCallId === undefined
        ? 'lesson_logical_1'
        : overrides.lessonLogicalCallId,
    lessonEvaluation: {
      policyVersion: overrides.policyVersion ?? COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
      status: overrides.status ?? 'pass',
    },
    lessonContent: [
      {
        lessonNarrative: {
          whyNow: 'Why this matters now.',
          summary: 'A coherent Lesson summary.',
          forwardBridge: null,
        },
      },
    ],
  } as AcceptedLessonCheckpoint;
}

function compositionalBrief(
  overrides: {
    lessonLogicalCallId?: string;
    practiceLogicalCallId?: string;
    lessonPolicyVersion?: string;
    practicePolicyVersion?: string;
    answerabilityPolicyVersion?: string;
    acceptancePolicyVersion?: string;
  } = {},
): TeachingBrief {
  const brief = {
    promptVersion: TEACHING_BRIEF_PROMPT_VERSION,
    composition: {
      skeletonFingerprint: SKELETON_FINGERPRINT,
      lessonPromptVersion: LESSON_CONTENT_PROMPT_VERSION,
      practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
      lessonLogicalCallId: overrides.lessonLogicalCallId ?? 'lesson_logical_1',
      practiceLogicalCallId: overrides.practiceLogicalCallId ?? 'practice_logical_1',
    },
    pedagogyEvaluation: {
      policyVersion: overrides.lessonPolicyVersion ?? COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
      status: 'pass',
    },
    objective: { title: 'Public Lesson', whyNow: 'A prior taught rule.', objectives: [] },
    prerequisites: [],
    segments: [],
    sourceReferences: [],
    visualReferences: [],
    summary: 'Apply the taught rule to the new facts.',
    nextConnection: null,
    practice: {
      items: [
        {
          initial: {
            prompt: 'Which answer follows from these public facts?',
            options: ['A', 'B', 'C'].map((id) => ({
              id: `practice_1_initial_${id}`,
              text: `Answer ${id}`,
            })),
            correctOptionId: 'practice_1_initial_A',
          },
          retry: {
            prompt: 'Which answer follows from these changed public facts?',
            options: ['A', 'B', 'C'].map((id) => ({
              id: `practice_1_retry_${id}`,
              text: `Answer ${id}`,
            })),
            correctOptionId: 'practice_1_retry_B',
          },
        },
      ],
      qualityEvaluation: {
        policyVersion:
          overrides.practicePolicyVersion ?? COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
        status: 'pass',
        findings: [],
        acceptancePolicyVersion:
          overrides.acceptancePolicyVersion ?? PRACTICE_ACCEPTANCE_POLICY_VERSION,
        contentReview: [
          {
            candidateHash: SKELETON_FINGERPRINT,
            logicalCallId: 'grounding-0',
            result: { decisions: [], findings: [] },
          },
        ],
      },
    },
  } as TeachingBrief;
  const priorTeaching = projectPracticePriorTeaching(brief);
  brief.practice!.qualityEvaluation.answerabilityReview = {
    policyVersion: overrides.answerabilityPolicyVersion ?? PRACTICE_ANSWERABILITY_POLICY_VERSION,
    rounds: [
      {
        candidateHash: SKELETON_FINGERPRINT,
        solves: (['initial', 'retry'] as const).map((surface) => {
          const item = brief.practice!.items[0]![surface];
          const actionId = `PR1.${surface}`;
          const prepared = preparePracticeAnswerabilityReview(
            {
              prompt: item.prompt,
              options: item.options.map(({ id, text }) => ({ id: id.slice(-1), text })),
            },
            priorTeaching,
            actionId,
            'PR1',
          );
          return {
            actionId,
            itemIndex: 0,
            surface,
            logicalCallId: `solve-${surface}`,
            inputHash: prepared.inputHash,
            result: {
              decisions: [
                {
                  actionId,
                  answerId: item.correctOptionId.slice(-1),
                  requiresCaseInference: true,
                  evidenceUsed: 'Public case facts.',
                },
              ],
              findings: [],
            },
          };
        }),
      },
    ],
  };
  return brief;
}

describe('Teaching Brief preparation provenance selection', () => {
  it('invalidates incompatible R1.3 and reverted R1.4 policies without mutating historical artifacts', () => {
    for (const promptVersion of [
      'teaching-lesson-content-v5-source-guided-worked-interaction',
      'teaching-lesson-content-v6-cognitive-demand',
    ]) {
      const historical = acceptedCheckpoint({ promptVersion });
      const bytes = JSON.stringify(historical);
      expect(isCurrentAcceptedLessonCheckpoint(historical)).toBe(false);
      expect(JSON.stringify(historical)).toBe(bytes);
    }
    const historical = compositionalBrief({
      practicePolicyVersion: 'lesson-practice-v4-worked-interaction-exposure',
    });
    expect(isCurrentCompositionalBrief(historical, { fingerprint: SKELETON_FINGERPRINT })).toBe(
      false,
    );
  });
  it('returns only an accepted Lesson checkpoint with current evaluation and call provenance', () => {
    const current = acceptedCheckpoint();

    expect(isCurrentAcceptedLessonCheckpoint(current)).toBe(true);
    expect(selectCurrentAcceptedLessonCheckpoint(current)).toBe(current);
    expect(selectCurrentAcceptedLessonCheckpoint(undefined)).toBeUndefined();
  });

  it('rejects an exact legacy checkpoint before either paid phase can continue', () => {
    const legacy = acceptedCheckpoint({ lessonLogicalCallId: null });

    expect(isCurrentAcceptedLessonCheckpoint(legacy)).toBe(false);
    expect(() => selectCurrentAcceptedLessonCheckpoint(legacy)).toThrowError(
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    );
  });

  it('rejects a checkpoint accepted under a stale Lesson evaluation policy', () => {
    const stale = acceptedCheckpoint({ policyVersion: 'lesson-pedagogy-stale' });

    expect(isCurrentAcceptedLessonCheckpoint(stale)).toBe(false);
    expect(() => selectCurrentAcceptedLessonCheckpoint(stale)).toThrowError(
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    );
  });

  it('retains the R1.2 checkpoint payload but refuses to reuse it under the R1.3 contract', () => {
    const previous = acceptedCheckpoint({
      promptVersion: 'teaching-lesson-content-v4-teacher-arc-deep-pedagogy',
    });

    expect(previous.lessonContent[0]?.lessonNarrative?.whyNow).toBe('Why this matters now.');
    expect(isCurrentAcceptedLessonCheckpoint(previous)).toBe(false);
    expect(() => selectCurrentAcceptedLessonCheckpoint(previous)).toThrowError(
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    );
  });

  it('requires both logical-call identities and both current evaluator policies for Brief reuse', () => {
    const skeleton = { fingerprint: SKELETON_FINGERPRINT };
    const current = compositionalBrief();
    const legacy = compositionalBrief();
    delete legacy.composition!.lessonLogicalCallId;
    delete legacy.composition!.practiceLogicalCallId;
    const missingPractice = compositionalBrief();
    delete missingPractice.composition!.practiceLogicalCallId;

    expect(isCurrentCompositionalBrief(current, skeleton)).toBe(true);
    expect(isCurrentCompositionalBrief(legacy, skeleton)).toBe(false);
    expect(isCurrentCompositionalBrief(missingPractice, skeleton)).toBe(false);
    expect(
      isCurrentCompositionalBrief(
        compositionalBrief({ lessonPolicyVersion: 'lesson-pedagogy-stale' }),
        skeleton,
      ),
    ).toBe(false);
    expect(
      isCurrentCompositionalBrief(
        compositionalBrief({ practicePolicyVersion: 'lesson-practice-stale' }),
        skeleton,
      ),
    ).toBe(false);
  });

  it('changes the composition fingerprint when either evaluator policy changes independently', () => {
    const skeleton = { fingerprint: SKELETON_FINGERPRINT };
    const current = compositionFingerprint('source-context-1', skeleton);

    expect(
      compositionFingerprint('source-context-1', skeleton, {
        lessonPedagogy: 'lesson-pedagogy-stale',
        practiceQuality: COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
      }),
    ).not.toBe(current);
    expect(
      compositionFingerprint('source-context-1', skeleton, {
        lessonPedagogy: COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
        practiceQuality: 'lesson-practice-stale',
      }),
    ).not.toBe(current);
  });

  it('requires the independent Practice gate without changing accepted Lesson or composition identity', () => {
    const skeleton = { fingerprint: SKELETON_FINGERPRINT };
    const checkpoint = acceptedCheckpoint();
    const checkpointBytes = JSON.stringify(checkpoint);
    const identity = compositionFingerprint('source-context-1', skeleton);
    const current = compositionalBrief();
    const obsolete = compositionalBrief({
      answerabilityPolicyVersion: 'practice-answerability-old',
    });
    const missing = compositionalBrief();
    delete missing.practice!.qualityEvaluation.answerabilityReview;
    expect(isCurrentCompositionalBrief(current, skeleton)).toBe(true);
    expect(isCurrentCompositionalBrief(obsolete, skeleton)).toBe(false);
    expect(isCurrentCompositionalBrief(missing, skeleton)).toBe(false);
    expect(current.composition).toEqual(obsolete.composition);
    expect(compositionFingerprint('source-context-1', skeleton)).toBe(identity);
    expect(selectCurrentAcceptedLessonCheckpoint(checkpoint)).toBe(checkpoint);
    expect(JSON.stringify(checkpoint)).toBe(checkpointBytes);
  });

  it.each([
    'practice-acceptance-v1-aggregate-quality',
    'practice-acceptance-v2-explicit-recognition-quality',
  ])('fences %s without changing the Lesson checkpoint or composition fingerprint', (oldPolicy) => {
    const skeleton = { fingerprint: SKELETON_FINGERPRINT };
    const checkpoint = acceptedCheckpoint();
    const checkpointBytes = JSON.stringify(checkpoint);
    const identity = compositionFingerprint('source-context-1', skeleton);
    const current = compositionalBrief();
    const obsolete = compositionalBrief({
      acceptancePolicyVersion: oldPolicy,
    });
    const missing = compositionalBrief();
    delete missing.practice!.qualityEvaluation.acceptancePolicyVersion;

    expect(isCurrentCompositionalBrief(current, skeleton)).toBe(true);
    expect(isCurrentCompositionalBrief(obsolete, skeleton)).toBe(false);
    expect(isCurrentCompositionalBrief(missing, skeleton)).toBe(false);
    expect(current.composition).toEqual(obsolete.composition);
    expect(compositionFingerprint('source-context-1', skeleton)).toBe(identity);
    expect(selectCurrentAcceptedLessonCheckpoint(checkpoint)).toBe(checkpoint);
    expect(JSON.stringify(checkpoint)).toBe(checkpointBytes);
  });

  it.each(['unversioned', 'previous_policy'] as const)(
    'does not let a current acceptance marker certify an %s inference proof',
    (oldProof) => {
      const brief = compositionalBrief();
      const checkpoint = acceptedCheckpoint();
      const checkpointBytes = JSON.stringify(checkpoint);
      const identity = compositionFingerprint('source-context-1', {
        fingerprint: SKELETON_FINGERPRINT,
      });
      const priorTeaching = projectPracticePriorTeaching(brief);
      for (const solve of brief.practice!.qualityEvaluation.answerabilityReview!.rounds[0]!
        .solves) {
        const surface = brief.practice!.items[solve.itemIndex]![solve.surface];
        const prepared = preparePracticeAnswerabilityReview(
          {
            prompt: surface.prompt,
            options: surface.options.map(({ id, text }) => ({ id: id.slice(-1), text })),
          },
          priorTeaching,
          solve.actionId,
          'PR1',
        );
        solve.inputHash = `sha256:${createHash('sha256')
          .update(
            JSON.stringify(
              oldProof === 'unversioned'
                ? prepared.input
                : {
                    acceptancePolicyVersion: 'practice-acceptance-v2-explicit-recognition-quality',
                    input: prepared.input,
                  },
            ),
          )
          .digest('hex')}`;
      }
      expect(isCurrentCompositionalBrief(brief, { fingerprint: SKELETON_FINGERPRINT })).toBe(false);
      expect(selectCurrentAcceptedLessonCheckpoint(checkpoint)).toBe(checkpoint);
      expect(JSON.stringify(checkpoint)).toBe(checkpointBytes);
      expect(
        compositionFingerprint('source-context-1', { fingerprint: SKELETON_FINGERPRINT }),
      ).toBe(identity);
    },
  );
});
