import { describe, expect, it } from 'vitest';
import { projectTaughtExposure } from './taughtExposure.js';

const brief = {
  id: 'brief_1',
  workspaceId: 'ws_1',
  curriculumVersionId: 'curriculum_1',
  studyPlanVersionId: 'plan_1',
  learningUnitId: 'unit_1',
  executionSourceManifestFingerprint: 'manifest_1',
  sourceContextFingerprint: 'source_context_1',
  composition: {
    acceptedLessonCheckpointId: 'checkpoint_1',
    skeletonFingerprint: 'skeleton_1',
  },
  segments: [
    {
      index: 0,
      objectiveIds: ['objective_1'],
      explanation: 'First explanation.',
      explanationAuthority: 'source_backed_teaching',
      sourceRefIds: ['S1'],
      informalCheck: { prompt: 'Excluded informal prompt.' },
    },
    {
      index: 1,
      objectiveIds: ['objective_2'],
      explanation: 'Second explanation.',
      explanationAuthority: 'ai_teaching_synthesis',
      sourceRefIds: [],
      semanticRelations: [
        {
          fromProposition: 'A',
          toProposition: 'B',
          relevanceToObjective: 'A leads to B.',
          sourceRefIds: [],
        },
      ],
      workedProcess: {
        startingState: 'Start',
        ruleOrProcedure: 'Apply the rule',
        steps: [{ action: 'Act', reason: 'Reason', resultingState: 'Next' }],
        learnerDecision: 'Choose',
        result: 'Result',
        whyResultFollows: 'Because the rule applies',
        sourceRefIds: [],
      },
      example: {
        text: 'Example surface.',
        authority: 'ai_teaching_synthesis',
        sourceRefIds: [],
      },
      contrast: {
        text: 'Contrast surface.',
        authority: 'ai_teaching_synthesis',
        sourceRefIds: [],
      },
      misconception: {
        hypothesis: 'Incorrect hypothesis.',
        correction: 'Corrected account.',
        authority: 'pedagogical_risk_candidate',
        sourceRefIds: [],
      },
      informalCheck: { prompt: 'Another excluded informal prompt.' },
    },
  ],
} as unknown as Parameters<typeof projectTaughtExposure>[0]['brief'];

const checkpoint = {
  id: 'checkpoint_1',
  workspaceId: 'ws_1',
  curriculumVersionId: 'curriculum_1',
  studyPlanVersionId: 'plan_1',
  learningUnitId: 'unit_1',
  executionSourceManifestFingerprint: 'manifest_1',
  sourceContextFingerprint: 'source_context_1',
  skeleton: { fingerprint: 'skeleton_1' },
} as unknown as Parameters<typeof projectTaughtExposure>[0]['checkpoint'];

function state(
  overrides: Partial<Parameters<typeof projectTaughtExposure>[0]['state']> = {},
): Parameters<typeof projectTaughtExposure>[0]['state'] {
  return {
    preparationStatus: 'ready',
    teachingBriefId: 'brief_1',
    acceptedLessonCheckpointId: 'checkpoint_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    learningUnitId: 'unit_1',
    executionSourceManifestFingerprint: 'manifest_1',
    sourceContextFingerprint: 'source_context_1',
    presentedSegmentIndexes: [1],
    ...overrides,
  };
}

describe('projectTaughtExposure', () => {
  it('projects exactly the presented segment without requiring whole-Lesson completion', () => {
    const projection = projectTaughtExposure({ brief, checkpoint, state: state() });

    expect(projection).toMatchObject({
      objectiveIds: ['objective_2'],
      presentedSegmentIndexes: [1],
      exposureClass: 'ai_teaching',
    });
    expect(projection?.surfaces.map((surface) => surface.surfaceKind)).toEqual([
      'explanation',
      'semantic_relation',
      'worked_process',
      'example',
      'contrast',
      'misconception',
    ]);
    expect(projection?.surfaces.some((surface) => surface.text.includes('informal'))).toBe(false);
  });

  it('does not treat an accepted but unpresented Lesson as taught', () => {
    expect(
      projectTaughtExposure({
        brief,
        checkpoint,
        state: state({ presentedSegmentIndexes: [] }),
      }),
    ).toEqual({
      objectiveIds: [],
      presentedSegmentIndexes: [],
      exposureClass: 'source_backed',
      surfaces: [],
    });
  });

  it('fails closed for failed preparation and checkpoint identity drift', () => {
    expect(
      projectTaughtExposure({
        brief,
        checkpoint,
        state: state({ preparationStatus: 'retryable_failure' }),
      }),
    ).toBeNull();
    expect(
      projectTaughtExposure({
        brief,
        checkpoint,
        state: state({ acceptedLessonCheckpointId: 'checkpoint_other' }),
      }),
    ).toBeNull();
  });

  it('rejects stale route versions and exposes only the presented objective', () => {
    expect(
      projectTaughtExposure({
        brief,
        checkpoint,
        state: state(),
        currentRoute: {
          curriculumVersionId: 'curriculum_stale',
          studyPlanVersionId: 'plan_1',
          learningUnitId: 'unit_1',
          executionSourceManifestFingerprint: 'manifest_1',
        },
      }),
    ).toBeNull();
    expect(
      projectTaughtExposure({
        brief,
        checkpoint,
        state: state(),
        currentRoute: {
          curriculumVersionId: 'curriculum_1',
          studyPlanVersionId: 'plan_1',
          learningUnitId: 'unit_1',
          executionSourceManifestFingerprint: 'manifest_stale',
        },
      }),
    ).toBeNull();
    expect(
      projectTaughtExposure({ brief, checkpoint, state: state() })?.objectiveIds,
    ).not.toContain('objective_1');
  });
});
