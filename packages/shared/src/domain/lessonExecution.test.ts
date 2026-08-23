import { describe, expect, it } from 'vitest';
import {
  LessonExecutionCommandRequestSchema,
  LessonExecutionProjectionSchema,
  LessonExecutionStateSchema,
  LessonTutorContextSchema,
} from './lessonExecution.js';

describe('lesson execution contracts', () => {
  it('keeps informal responses non-credit and validates preparation bindings', () => {
    const state = LessonExecutionStateSchema.parse({
      id: 'lesson_1',
      sessionId: 'session_1',
      agendaItemId: 'agenda_item_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      teachingBriefId: 'brief_1',
      acceptedLessonCheckpointId: null,
      executionSourceManifestFingerprint: 'manifest',
      sourceContextFingerprint: 'source',
      preparationStatus: 'ready',
      preparationOperationId: null,
      version: 2,
      currentSegmentIndex: 0,
      presentedSegmentIndexes: [0],
      informalInteractions: [
        {
          segmentIndex: 0,
          presentedAt: '2026-01-01T00:00:00.000Z',
          response: 'answer',
          respondedAt: '2026-01-01T00:01:00.000Z',
        },
      ],
      presentationCompletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    expect(state.informalInteractions[0]?.response).toBe('answer');
    expect(() =>
      LessonExecutionStateSchema.parse({
        ...state,
        preparationStatus: 'ready',
        teachingBriefId: null,
      }),
    ).toThrow();
  });

  it('accepts explicit segment commands and rejects unknown action fields', () => {
    const command = LessonExecutionCommandRequestSchema.parse({
      command: {
        commandId: 'cmd_1',
        idempotencyKey: 'key_1',
        workspaceId: 'ws_1',
        actor: 'learner',
      },
      expectedSessionVersion: 1,
      expectedAgendaVersion: 1,
      expectedAgendaItemId: 'agenda_item_1',
      expectedLessonStateVersion: 2,
      action: { kind: 'respond_to_informal_check', segmentIndex: 0, response: 'answer' },
    });
    expect(command.action.kind).toBe('respond_to_informal_check');
    expect(() =>
      LessonExecutionCommandRequestSchema.parse({
        ...command,
        action: { kind: 'start_lesson', extra: true },
      }),
    ).toThrow();
  });

  it('keeps tutor context bounded and credit-free', () => {
    const context = LessonTutorContextSchema.parse({
      objective: { title: 'Working memory', whyNow: 'It is next.' },
      currentSegment: {
        index: 0,
        purpose: 'explanation',
        explanation: 'Bounded explanation.',
        explanationOrigin: 'source_grounded',
        example: null,
        contrast: null,
        possibleMisconception: null,
        informalCheck: {
          prompt: 'Explain it.',
          guidance: null,
          learnerResponse: 'answer',
          credit: 'none',
        },
      },
      nearbySegments: [],
      sources: [],
      summary: 'Summary',
      nextConnection: null,
    });
    expect(context.currentSegment.informalCheck?.credit).toBe('none');
    expect(JSON.stringify(context).length).toBeLessThan(12000);
  });

  it('keeps an accepted Lesson available while only Practice preparation is retryable', () => {
    const recovery = {
      status: 'practice_retry_available',
      message: 'The accepted Lesson is preserved; retry Practice preparation.',
      course: { title: 'Course' },
      session: { status: 'active', version: 3 },
      agenda: { version: 2, itemState: 'active' },
      lesson: {
        objective: {
          title: 'Explain retrieval',
          whyNow: 'It supports the next application.',
          outcomes: [{ title: 'Explain', description: 'Explain the mechanism.' }],
        },
        prerequisites: [],
        segments: [
          {
            index: 0,
            purpose: 'mechanism',
            explanation: 'The query is embedded before similar chunks are retrieved.',
            explanationOrigin: 'source_grounded',
            sources: [],
            example: null,
            contrast: null,
            possibleMisconception: null,
            informalCheck: null,
          },
        ],
        sourceReferencesAvailable: true,
        visuals: [],
        summary: {
          available: true,
          text: 'Retrieval uses the embedded query.',
          nextConnection: null,
          formalOpportunities: [],
        },
      },
      progress: {
        stateVersion: 2,
        currentSegmentIndex: 0,
        segmentCount: 1,
        presentedSegmentIndexes: [],
        presentationStatus: 'not_started',
        presentationCompletedAt: null,
      },
      currentInformalCheck: null,
      practice: null,
      allowedActions: ['retry_preparation'],
    } as const;

    expect(LessonExecutionProjectionSchema.parse(recovery).lesson?.objective.title).toBe(
      'Explain retrieval',
    );
    expect(() => LessonExecutionProjectionSchema.parse({ ...recovery, lesson: null })).toThrow(
      /accepted Lesson projection/,
    );
    expect(() =>
      LessonExecutionProjectionSchema.parse({
        ...recovery,
        allowedActions: ['retry_preparation', 'start_lesson'],
      }),
    ).toThrow(/may only retry preparation/);
  });
});
