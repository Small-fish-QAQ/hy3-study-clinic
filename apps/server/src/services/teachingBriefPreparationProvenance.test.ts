import { describe, expect, it } from 'vitest';
import type { AcceptedLessonCheckpoint, TeachingBrief } from '@hy3-clinic/shared';
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
  } = {},
): TeachingBrief {
  return {
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
    practice: {
      qualityEvaluation: {
        policyVersion:
          overrides.practicePolicyVersion ?? COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
        status: 'pass',
      },
    },
  } as TeachingBrief;
}

describe('Teaching Brief preparation provenance selection', () => {
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
});
