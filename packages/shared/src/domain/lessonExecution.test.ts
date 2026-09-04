import { describe, expect, it } from 'vitest';
import {
  LessonExecutionCommandRequestSchema,
  LessonExecutionProjectionSchema,
  LessonExecutionStateSchema,
  LessonTutorContextSchema,
  groupLessonSegmentsForLearner,
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

  it('persists bounded worked-interaction progress and accepts only explicit response phases', () => {
    const base = LessonExecutionStateSchema.parse({
      id: 'lesson_worked_1',
      sessionId: 'session_1',
      agendaItemId: 'agenda_item_1',
      curriculumVersionId: 'curriculum_1',
      studyPlanVersionId: 'plan_1',
      learningUnitId: 'unit_1',
      teachingBriefId: 'brief_1',
      acceptedLessonCheckpointId: 'checkpoint_1',
      executionSourceManifestFingerprint: 'manifest',
      sourceContextFingerprint: 'source',
      preparationStatus: 'ready',
      preparationOperationId: null,
      version: 4,
      currentSegmentIndex: 1,
      presentedSegmentIndexes: [0, 1],
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
      presentationCompletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    });
    expect(base.informalInteractions[0]?.workedInteraction).toMatchObject({
      guidedResponse: 'B',
      scaffoldResponse: 'A',
      transferResponse: null,
    });

    const command = LessonExecutionCommandRequestSchema.parse({
      command: {
        commandId: 'cmd_worked_1',
        idempotencyKey: 'key_worked_1',
        workspaceId: 'ws_1',
        actor: 'learner',
      },
      expectedSessionVersion: 1,
      expectedAgendaVersion: 1,
      expectedAgendaItemId: 'agenda_item_1',
      expectedLessonStateVersion: 4,
      action: {
        kind: 'respond_to_worked_interaction',
        segmentIndex: 1,
        phase: 'transfer',
        response: 'B',
      },
    });
    expect(command.action).toMatchObject({ phase: 'transfer', response: 'B' });

    const impossible = structuredClone(base);
    impossible.informalInteractions[0]!.workedInteraction!.guidedResponse = null;
    impossible.informalInteractions[0]!.workedInteraction!.guidedRespondedAt = null;
    expect(LessonExecutionStateSchema.safeParse(impossible).success).toBe(false);
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

  it('groups short granular segments continuously through the next inline check', () => {
    const sourceA = { referenceKey: 'S1' };
    const sourceB = { referenceKey: 'S2' };
    const segments = [
      {
        index: 0,
        purpose: 'orientation',
        explanation: '建立问题背景。',
        sources: [sourceA],
        informalCheck: null,
      },
      {
        index: 1,
        purpose: 'mechanism',
        explanation: '追踪条件如何改变中间状态。',
        sources: [sourceB],
        informalCheck: null,
      },
      {
        index: 2,
        purpose: 'guided_practice',
        explanation: '把机制用于一个具体判断。',
        sources: [],
        informalCheck: { prompt: '条件改变后会怎样？' },
      },
      {
        index: 3,
        purpose: 'comparison',
        explanation: '最后澄清相邻概念的边界。',
        sources: [sourceA],
        informalCheck: null,
      },
    ];

    const sections = groupLessonSegmentsForLearner(segments);

    expect(sections.map((section) => section.segments.map((segment) => segment.index))).toEqual([
      [0, 1, 2],
      [3],
    ]);
    expect(sections.map((section) => section.boundary)).toEqual(['inline_check', 'lesson_end']);
    expect(sections[0]!.segments[0]).toBe(segments[0]);
    expect(sections[0]!.segments[0]!.sources).toBe(segments[0]!.sources);
    expect(sections[0]!.segments[1]!.sources).toBe(segments[1]!.sources);
  });

  it('uses a worked interaction as a meaningful pacing boundary', () => {
    const sections = groupLessonSegmentsForLearner([
      {
        index: 0,
        purpose: 'orientation',
        explanation: '先建立问题。',
        informalCheck: null,
      },
      {
        index: 1,
        purpose: 'worked_example',
        explanation: '教师先演示一个关键步骤。',
        informalCheck: null,
        workedProcess: {
          startingState: '起点。',
          ruleOrProcedure: '规则。',
          steps: [{ action: '演示。', reason: '原因。', resultingState: '中间状态。' }],
          learnerDecision: '判断下一步。',
          result: null,
          whyResultFollows: null,
          interaction: {},
        },
      },
      {
        index: 2,
        purpose: 'comparison',
        explanation: '完成互动后再继续抽象。',
        informalCheck: null,
      },
    ]);
    expect(sections.map((section) => section.boundary)).toEqual(['inline_check', 'lesson_end']);
    expect(sections[0]?.endSegmentIndex).toBe(1);
  });

  it('uses a non-check boundary only after long teaching before a meaningful transition', () => {
    const short = [
      { index: 0, purpose: 'explanation', explanation: '短讲解一。', informalCheck: null },
      { index: 1, purpose: 'mechanism', explanation: '短讲解二。', informalCheck: null },
      { index: 2, purpose: 'worked_example', explanation: '短案例。', informalCheck: null },
    ];
    expect(groupLessonSegmentsForLearner(short)).toHaveLength(1);

    const long = [
      {
        index: 0,
        purpose: 'explanation',
        explanation: '实'.repeat(2400),
        informalCheck: null,
      },
      {
        index: 1,
        purpose: 'worked_example',
        explanation: '进入一个有意义的案例转换。',
        example: { text: '具体案例' },
        informalCheck: null,
      },
    ];
    const sections = groupLessonSegmentsForLearner(long);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      startSegmentIndex: 0,
      endSegmentIndex: 0,
      boundary: 'conceptual_transition',
    });
  });
});
