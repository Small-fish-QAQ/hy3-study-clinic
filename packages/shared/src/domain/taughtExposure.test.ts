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
        inputs: ['Input state'],
        ruleOrProcedure: 'Apply the rule',
        steps: [
          { action: 'Act', reason: 'Reason', resultingState: 'Next' },
          { action: 'Continue', reason: 'Reason again', resultingState: 'Final' },
        ],
        learnerDecision: 'Choose',
        result: 'Result',
        whyResultFollows: 'Because the rule applies',
        sourceRefIds: [],
        interaction: {
          pauseAfterStepIndex: 0,
          sourceRefs: [],
          activity: {
            prompt: 'Choose the next action.',
            options: [
              { id: 'A', text: 'Continue.', feedbackIfSelected: 'Correct.', misconception: null },
              {
                id: 'B',
                text: 'Stop.',
                feedbackIfSelected: 'The process is incomplete.',
                misconception: {
                  hypothesis: 'The first step completes the process.',
                  whyTempting: 'The intermediate state looks stable.',
                  correction: 'Check whether the required result exists yet.',
                },
              },
              {
                id: 'C',
                text: 'Restart.',
                feedbackIfSelected: 'No failure requires a restart.',
                misconception: {
                  hypothesis: 'Every intermediate pause implies failure.',
                  whyTempting: 'The final result is not visible yet.',
                  correction: 'Continue from the valid intermediate state.',
                },
              },
            ],
            correctOptionId: 'A',
            correctDebrief: 'The next action follows from the intermediate state.',
          },
          hint: 'Inspect the intermediate state.',
          scaffold: {
            prompt: 'Is the required result present yet?',
            options: [
              { id: 'A', text: 'No.', feedbackIfSelected: 'Correct.' },
              { id: 'B', text: 'Yes.', feedbackIfSelected: 'The process is incomplete.' },
            ],
            correctOptionId: 'A',
            debrief: 'The missing result means another action is required.',
          },
          transfer: {
            changedCondition: 'The intermediate state changes.',
            prompt: 'Which action now follows?',
            options: [
              { id: 'A', text: 'Old action.', feedbackIfSelected: 'Condition changed.' },
              { id: 'B', text: 'Re-evaluate.', feedbackIfSelected: 'Correct.' },
              { id: 'C', text: 'Ignore it.', feedbackIfSelected: 'Condition matters.' },
            ],
            correctOptionId: 'B',
            debrief: 'Changed conditions require a new decision.',
          },
        },
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
    informalInteractions: [],
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
      'worked_interaction',
      'example',
      'contrast',
      'misconception',
    ]);
    expect(projection?.surfaces.some((surface) => surface.text.includes('informal'))).toBe(false);
    expect(
      projection?.surfaces.find((surface) => surface.surfaceKind === 'worked_interaction')?.text,
    ).toContain('Choose the next action.');
    expect(
      projection?.surfaces.find((surface) => surface.surfaceKind === 'worked_interaction'),
    ).toMatchObject({ authority: 'ai_teaching_synthesis', sourceRefIds: [] });
    expect(
      projection?.surfaces.some((surface) =>
        surface.text.includes('Inspect the intermediate state.'),
      ),
    ).toBe(false);
  });

  it('records only the worked-interaction surfaces actually revealed at each response stage', () => {
    const wrong = projectTaughtExposure({
      brief,
      checkpoint,
      state: state({
        informalInteractions: [
          {
            segmentIndex: 1,
            presentedAt: '2026-01-01T00:00:00.000Z',
            response: null,
            respondedAt: null,
            workedInteraction: {
              guidedResponse: 'B',
              guidedRespondedAt: '2026-01-01T00:01:00.000Z',
              scaffoldResponse: null,
              scaffoldRespondedAt: null,
              transferResponse: null,
              transferRespondedAt: null,
            },
          },
        ],
      }),
    })!;
    const wrongInteraction = wrong.surfaces.find(
      (surface) => surface.surfaceKind === 'worked_interaction',
    )!.text;
    const wrongProcess = wrong.surfaces.find(
      (surface) => surface.surfaceKind === 'worked_process',
    )!.text;
    expect(wrongInteraction).toContain('Inspect the intermediate state.');
    expect(wrongInteraction).toContain('The first step completes the process.');
    expect(wrongInteraction).toContain('Is the required result present yet?');
    expect(wrongInteraction).not.toContain('The intermediate state changes.');
    expect(wrongProcess).not.toContain('Continue');
    expect(wrongProcess).not.toContain('Because the rule applies');

    const scaffoldState = state({
      informalInteractions: [
        {
          segmentIndex: 1,
          presentedAt: '2026-01-01T00:00:00.000Z',
          response: null,
          respondedAt: null,
          workedInteraction: {
            guidedResponse: 'B',
            guidedRespondedAt: '2026-01-01T00:01:00.000Z',
            scaffoldResponse: 'A',
            scaffoldRespondedAt: '2026-01-01T00:02:00.000Z',
            transferResponse: null,
            transferRespondedAt: null,
          },
        },
      ],
    });
    const afterScaffold = projectTaughtExposure({ brief, checkpoint, state: scaffoldState })!;
    expect(
      afterScaffold.surfaces.find((surface) => surface.surfaceKind === 'worked_process')?.text,
    ).toContain('Continue');
    expect(
      afterScaffold.surfaces.find((surface) => surface.surfaceKind === 'worked_process')?.text,
    ).not.toContain('Because the rule applies');
    expect(
      afterScaffold.surfaces.find((surface) => surface.surfaceKind === 'worked_interaction')?.text,
    ).toContain('The intermediate state changes.');

    const completed = projectTaughtExposure({
      brief,
      checkpoint,
      state: state({
        informalInteractions: [
          {
            ...scaffoldState.informalInteractions[0]!,
            workedInteraction: {
              ...scaffoldState.informalInteractions[0]!.workedInteraction!,
              transferResponse: 'B',
              transferRespondedAt: '2026-01-01T00:03:00.000Z',
            },
          },
        ],
      }),
    })!;
    expect(
      completed.surfaces.find((surface) => surface.surfaceKind === 'worked_process')?.text,
    ).toContain('Because the rule applies');
    expect(
      completed.surfaces.find((surface) => surface.surfaceKind === 'worked_interaction')?.text,
    ).toContain('Changed conditions require a new decision.');
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
