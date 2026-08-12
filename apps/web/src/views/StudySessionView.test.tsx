import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicQuiz, StudySession, StudySessionDetailResponse } from '@hy3-clinic/shared';
import { StudySessionView } from './StudySessionView.js';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    listStudySessions: vi.fn(),
    startStudySession: vi.fn(),
    getStudySession: vi.fn(),
    submitTutorTurn: vi.fn(),
    streamTutorTurn: vi.fn(),
    studySessionCommand: vi.fn(),
    pauseStudySession: vi.fn(),
    resumeStudySession: vi.fn(),
    stopStudySession: vi.fn(),
    launchAgendaItem: vi.fn(),
  },
}));

const session: StudySession = {
  id: 'session_1',
  workspaceId: 'ws_1',
  contractVersionId: 'contract_1',
  curriculumVersionId: 'curriculum_1',
  studyPlanVersionId: 'plan_1',
  sessionAgendaId: 'agenda_1',
  executionSourceManifestFingerprint: 'manifest_1',
  version: 1,
  status: 'active',
  routeState: 'on_route',
  currentAgendaItemId: 'agenda_item_1',
  routeStack: [],
  transcriptWatermark: 0,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
};

const detail: StudySessionDetailResponse = {
  session,
  agenda: {
    id: 'agenda_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    curriculumVersionId: 'curriculum_1',
    studyPlanVersionId: 'plan_1',
    executionSourceManifestFingerprint: 'manifest_1',
    version: 1,
    status: 'active',
    availableMinutes: 30,
    items: [
      {
        id: 'agenda_item_1',
        index: 0,
        kind: 'learning_unit_teaching',
        origin: 'accepted_plan',
        reason: 'Learn the current unit.',
        estimatedMinutes: 20,
        linkedPlanItemId: 'plan_item_1',
        learningUnitId: 'unit_1',
        priority: 'high',
        state: 'active',
        launch: {
          status: 'launchable',
          capability: 'conversation',
          resourceId: null,
          reason: null,
        },
        displacedAgendaItemIds: [],
        timeImpactMinutes: 0,
      },
    ],
    currentItemId: 'agenda_item_1',
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z',
  },
  turns: [],
  exchanges: [],
  turnEvents: [],
  latestSummary: null,
};

const currentRoute = {
  contractVersionId: session.contractVersionId,
  curriculumVersionId: session.curriculumVersionId,
  studyPlanVersionId: session.studyPlanVersionId,
  sessionAgendaId: session.sessionAgendaId,
  executionVersion: 4,
};

const completedTutorResponse = {
  session: { ...session, version: 2, transcriptWatermark: 2 },
  turn: {
    id: 'turn_1',
    sessionId: session.id,
    seq: 0,
    commandId: 'tutor_turn_original',
    status: 'completed' as const,
    contextManifest: {
      fingerprint: 'context-1',
      contractScopeFingerprint: 'scope-1',
      contractVersionId: session.contractVersionId,
      curriculumVersionId: session.curriculumVersionId,
      studyPlanVersionId: session.studyPlanVersionId,
      sessionAgendaVersionId: `${session.sessionAgendaId}:v1`,
      studySessionVersion: session.version,
      executionSourceManifestFingerprint: session.executionSourceManifestFingerprint,
      transcriptWatermark: 0,
      sourceBlockRevisionIds: [],
      formalEvidenceIds: [],
      riskIds: [],
    },
    logicalCallId: 'call_1',
    errorMessage: null,
    createdAt: session.createdAt,
    completedAt: session.updatedAt,
  },
  exchanges: [
    {
      id: 'exchange_learner_1',
      sessionId: session.id,
      turnId: 'turn_1',
      seq: 0,
      role: 'learner' as const,
      content: 'Why?',
      channel: 'conversation' as const,
      createdAt: session.createdAt,
    },
    {
      id: 'exchange_tutor_1',
      sessionId: session.id,
      turnId: 'turn_1',
      seq: 1,
      role: 'tutor' as const,
      content: 'Because the current unit depends on this prerequisite.',
      channel: 'conversation' as const,
      createdAt: session.updatedAt,
    },
  ],
  events: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

async function openStudyControls(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByText('调整本次学习'));
}

async function openAgenda(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByText(/^本次安排/));
}

describe('StudySessionView', () => {
  it('does not offer session operations until a course workspace is selected', () => {
    render(<StudySessionView workspaceId={null} route={null} />);

    expect(screen.getByText('请先选择课程，再进入学习。')).toBeInTheDocument();
  });

  it('starts only against the accepted route and persisted execution version', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [] });
    vi.mocked(api.startStudySession).mockResolvedValue({ session });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);

    render(
      <StudySessionView
        workspaceId="ws_1"
        route={{
          contractVersionId: 'contract_1',
          curriculumVersionId: 'curriculum_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaId: 'agenda_1',
          executionVersion: 4,
        }}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '开始学习' }));

    await waitFor(() =>
      expect(api.startStudySession).toHaveBeenCalledWith(
        'ws_1',
        {
          contractVersionId: 'contract_1',
          curriculumVersionId: 'curriculum_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaId: 'agenda_1',
          expectedCourseExecutionVersion: 4,
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('selects only an open session on the current route and reloads after route changes', async () => {
    const successorSession: StudySession = {
      ...session,
      id: 'session_2',
      contractVersionId: 'contract_2',
      curriculumVersionId: 'curriculum_2',
      studyPlanVersionId: 'plan_2',
      sessionAgendaId: 'agenda_2',
    };
    const successorRoute = {
      contractVersionId: successorSession.contractVersionId,
      curriculumVersionId: successorSession.curriculumVersionId,
      studyPlanVersionId: successorSession.studyPlanVersionId,
      sessionAgendaId: successorSession.sessionAgendaId,
      executionVersion: 5,
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({
      sessions: [session, successorSession],
    });
    vi.mocked(api.getStudySession).mockImplementation(async (_workspaceId, sessionId) => ({
      ...detail,
      session: sessionId === successorSession.id ? successorSession : session,
    }));

    const { rerender } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await waitFor(() =>
      expect(api.getStudySession).toHaveBeenCalledWith('ws_1', session.id, expect.any(AbortSignal)),
    );

    rerender(<StudySessionView workspaceId="ws_1" route={successorRoute} />);
    await waitFor(() =>
      expect(api.getStudySession).toHaveBeenCalledWith(
        'ws_1',
        successorSession.id,
        expect.any(AbortSignal),
      ),
    );
  });

  it('launches a direct checkpoint through the normal agenda assessment callback', async () => {
    const user = userEvent.setup();
    const onLaunchQuiz = vi.fn();
    const checkpointAgenda = {
      ...detail.agenda,
      items: [
        ...detail.agenda.items,
        {
          ...detail.agenda.items[0]!,
          id: 'agenda_item_checkpoint',
          kind: 'formal_checkpoint' as const,
          reason: 'Check current unit formally.',
          state: 'queued' as const,
          launch: {
            status: 'launchable' as const,
            capability: 'assessment',
            resourceId: 'quiz_seed_1',
            reason: null,
          },
        },
      ],
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({ ...detail, agenda: checkpointAgenda });
    vi.mocked(api.studySessionCommand).mockResolvedValue({
      session: { ...session, version: 2 },
      agenda: checkpointAgenda,
      effect: {
        kind: 'direct_checkpoint',
        affectedAgendaItemId: 'agenda_item_checkpoint',
        planChangeRequest: null,
      },
    });
    vi.mocked(api.launchAgendaItem).mockResolvedValue({
      kind: 'assessment',
      agendaItemId: 'agenda_item_checkpoint',
      assessmentKind: 'formal_checkpoint',
      quiz: { id: 'quiz_1' } as PublicQuiz,
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Check my understanding');

    render(
      <StudySessionView workspaceId="ws_1" route={currentRoute} onLaunchQuiz={onLaunchQuiz} />,
    );
    await openStudyControls(user);
    await user.click(await screen.findByRole('button', { name: '发起正式评估' }));

    await waitFor(() => expect(api.launchAgendaItem).toHaveBeenCalled());
    expect(onLaunchQuiz).toHaveBeenCalledWith(expect.objectContaining({ id: 'quiz_1' }));
  });

  it('sends a learner-selected Curriculum unit as a detour target', async () => {
    const user = userEvent.setup();
    const detourItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_item_detour',
      index: 1,
      kind: 'learner_detour' as const,
      origin: 'learner_detour' as const,
      reason: 'Explore Bayes.',
      linkedPlanItemId: null,
      learningUnitId: 'unit_2',
      state: 'active' as const,
    };
    const detourAgenda = {
      ...detail.agenda,
      version: 2,
      items: [...detail.agenda.items, detourItem],
      currentItemId: detourItem.id,
    };
    const detourSession: StudySession = {
      ...session,
      version: 2,
      routeState: 'detour_active',
      currentAgendaItemId: detourItem.id,
      routeStack: [
        {
          id: 'frame_detour_unit_2',
          parentFrameId: null,
          originAgendaItemId: 'agenda_item_1',
          originPlanItemId: 'plan_item_1',
          contractVersionId: 'contract_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaVersionId: 'agenda_1:v1',
          reason: detourItem.reason,
          resumePolicy: 'recompose_if_stale',
          state: 'active',
        },
      ],
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.studySessionCommand).mockResolvedValue({
      session: detourSession,
      agenda: detourAgenda,
      effect: { kind: 'detour', affectedAgendaItemId: detourItem.id, planChangeRequest: null },
    });
    vi.spyOn(window, 'prompt').mockReturnValue(detourItem.reason);

    render(
      <StudySessionView
        workspaceId="ws_1"
        route={currentRoute}
        curriculumUnits={[
          { id: 'unit_1', title: 'Current unit' },
          { id: 'unit_2', title: 'Bayes review' },
        ]}
      />,
    );
    await openStudyControls(user);
    await user.selectOptions(await screen.findByLabelText('想探索的学习单元'), 'unit_2');
    await user.click(screen.getByRole('button', { name: '临时探索' }));

    await waitFor(() =>
      expect(api.studySessionCommand).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({
          kind: 'detour',
          targetAgendaItemId: 'agenda_item_1',
          targetLearningUnitId: 'unit_2',
        }),
        expect.any(AbortSignal),
      ),
    );
    await openAgenda(user);
    expect(screen.getByRole('listitem', { name: 'Explore Bayes.，当前，进行中' })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('enables Plan promotion only for the active current learner detour LearningUnit', async () => {
    const detourItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_item_detour',
      kind: 'learner_detour' as const,
      origin: 'learner_detour' as const,
      linkedPlanItemId: null,
      learningUnitId: 'unit_2',
      state: 'active' as const,
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({
      sessions: [{ ...session, currentAgendaItemId: detourItem.id, routeState: 'detour_active' }],
    });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      session: { ...session, currentAgendaItemId: detourItem.id, routeState: 'detour_active' },
      agenda: {
        ...detail.agenda,
        currentItemId: detourItem.id,
        items: [detail.agenda.items[0]!, detourItem],
      },
    });

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openStudyControls(userEvent.setup());

    expect(await screen.findByRole('button', { name: '纳入长期路线' })).toBeEnabled();
  });

  it('disables Plan promotion outside a concrete active learner detour', async () => {
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);

    const { unmount } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openStudyControls(userEvent.setup());
    expect(await screen.findByRole('button', { name: '纳入长期路线' })).toBeDisabled();
    unmount();

    const detourWithoutUnit = {
      ...detail.agenda.items[0]!,
      origin: 'learner_detour' as const,
      learningUnitId: null,
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      agenda: { ...detail.agenda, items: [detourWithoutUnit] },
    });

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openStudyControls(userEvent.setup());
    expect(await screen.findByRole('button', { name: '纳入长期路线' })).toBeDisabled();
  });

  it('shows an inserted activity as current and restores the prior Agenda route', async () => {
    const user = userEvent.setup();
    const insertedItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_item_inserted',
      index: 1,
      kind: 'learner_detour' as const,
      origin: 'learner_insert' as const,
      reason: 'Review the confusing example.',
      estimatedMinutes: 10,
      linkedPlanItemId: null,
      state: 'active' as const,
      displacedAgendaItemIds: ['agenda_item_1'],
      timeImpactMinutes: 10,
    };
    const insertedAgenda = {
      ...detail.agenda,
      version: 2,
      items: [detail.agenda.items[0]!, insertedItem],
      currentItemId: insertedItem.id,
    };
    const insertedSession: StudySession = {
      ...session,
      version: 2,
      routeState: 'detour_active',
      currentAgendaItemId: insertedItem.id,
      routeStack: [
        {
          id: 'route_frame_inserted',
          parentFrameId: null,
          originAgendaItemId: 'agenda_item_1',
          originPlanItemId: 'plan_item_1',
          contractVersionId: 'contract_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaVersionId: 'agenda_1:v1',
          reason: insertedItem.reason,
          resumePolicy: 'recompose_if_stale',
          state: 'active',
        },
      ],
    };
    const returnedAgenda = {
      ...insertedAgenda,
      version: 3,
      items: [detail.agenda.items[0]!, { ...insertedItem, state: 'completed' as const }],
      currentItemId: 'agenda_item_1',
    };
    const returnedSession: StudySession = {
      ...insertedSession,
      version: 3,
      routeState: 'on_route',
      currentAgendaItemId: 'agenda_item_1',
      routeStack: [],
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.studySessionCommand)
      .mockResolvedValueOnce({
        session: insertedSession,
        agenda: insertedAgenda,
        effect: {
          kind: 'agenda_insert',
          affectedAgendaItemId: insertedItem.id,
          planChangeRequest: null,
        },
      })
      .mockResolvedValueOnce({
        session: returnedSession,
        agenda: returnedAgenda,
        effect: {
          kind: 'return',
          affectedAgendaItemId: 'agenda_item_1',
          planChangeRequest: null,
        },
      });
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce(insertedItem.reason)
      .mockReturnValueOnce('Return after the inserted review.');

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openStudyControls(user);
    await user.click(await screen.findByRole('button', { name: '插入短活动' }));
    await openAgenda(user);

    const insertedRow = await screen.findByRole('listitem', {
      name: 'Review the confusing example.，当前，进行中',
    });
    expect(insertedRow).toHaveAttribute('aria-current', 'step');
    expect(api.studySessionCommand).toHaveBeenNthCalledWith(
      1,
      'ws_1',
      'session_1',
      expect.objectContaining({
        kind: 'agenda_insert',
        targetAgendaItemId: 'agenda_item_1',
        expectedSessionVersion: 1,
      }),
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole('button', { name: '返回原学习路线' }));
    await waitFor(() =>
      expect(
        screen.getByRole('listitem', { name: 'Learn the current unit.，当前，进行中' }),
      ).toHaveAttribute('aria-current', 'step'),
    );
    expect(
      screen.getByRole('listitem', { name: 'Review the confusing example.，已完成' }),
    ).not.toHaveAttribute('aria-current');
    expect(api.studySessionCommand).toHaveBeenNthCalledWith(
      2,
      'ws_1',
      'session_1',
      expect.objectContaining({
        kind: 'return',
        targetAgendaItemId: insertedItem.id,
        expectedSessionVersion: 2,
      }),
      expect.any(AbortSignal),
    );
  });

  it('renders validated Tutor prose without inferring formal completion from it', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.streamTutorTurn).mockImplementation(async (_w, _s, _input, onLine) => {
      const event = {
        id: 'event_1',
        sessionId: session.id,
        turnId: 'turn_1',
        seq: 0,
        kind: 'started' as const,
        provisional: true,
        content: null,
        createdAt: session.updatedAt,
      };
      onLine({ kind: 'event', event });
      return {
        session: { ...session, version: 3, transcriptWatermark: 2 },
        turn: {
          id: 'turn_1',
          sessionId: session.id,
          seq: 0,
          commandId: 'turn_command_1',
          status: 'completed',
          contextManifest: {
            fingerprint: 'context-1',
            contractScopeFingerprint: 'scope-1',
            contractVersionId: 'contract_1',
            curriculumVersionId: 'curriculum_1',
            studyPlanVersionId: 'plan_1',
            sessionAgendaVersionId: 'agenda_1:v1',
            studySessionVersion: 1,
            executionSourceManifestFingerprint: 'manifest_1',
            transcriptWatermark: 0,
            sourceBlockRevisionIds: [],
            formalEvidenceIds: [],
            riskIds: [],
          },
          logicalCallId: 'call_1',
          errorMessage: null,
          createdAt: session.createdAt,
          completedAt: session.updatedAt,
        },
        exchanges: [
          {
            id: 'exchange_learner',
            sessionId: session.id,
            turnId: 'turn_1',
            seq: 0,
            role: 'learner',
            content: 'Why?',
            channel: 'conversation',
            createdAt: session.createdAt,
          },
          {
            id: 'exchange_tutor',
            sessionId: session.id,
            turnId: 'turn_1',
            seq: 1,
            role: 'tutor',
            content: 'You have completed this unit.',
            channel: 'conversation',
            createdAt: session.updatedAt,
          },
        ],
        events: [event],
      };
    });

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('You have completed this unit.')).toBeInTheDocument();
    expect(screen.getByText('Why?')).toBeInTheDocument();
    expect(screen.queryByText('started')).not.toBeInTheDocument();
    await openAgenda(user);
    expect(
      screen.getByRole('listitem', { name: 'Learn the current unit.，当前，进行中' }),
    ).toHaveAttribute('aria-current', 'step');
  });

  it('retries an indeterminate Tutor turn with the exact original identity and one transcript submission', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    const firstAttempt = vi.fn().mockRejectedValue(
      Object.assign(new Error('StudySession stream was interrupted.'), {
        code: 'NETWORK_ERROR',
      }),
    );
    let resolveRetry: ((response: typeof completedTutorResponse) => void) | undefined;
    const retryInFlight = new Promise<typeof completedTutorResponse>((resolve) => {
      resolveRetry = resolve;
    });
    vi.mocked(api.streamTutorTurn)
      .mockImplementationOnce(firstAttempt)
      .mockReturnValueOnce(retryInFlight);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, ' Why? ');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const interruptedCall = await waitFor(() => {
      expect(firstAttempt).toHaveBeenCalledTimes(1);
      return vi.mocked(api.streamTutorTurn).mock.calls[0];
    });
    expect(interruptedCall?.[0]).toBe('ws_1');
    expect(interruptedCall?.[1]).toBe(session.id);
    const originalInput = interruptedCall?.[2];
    expect(originalInput).toEqual({
      commandId: expect.stringMatching(/^tutor_turn_/),
      expectedSessionVersion: 1,
      content: 'Why?',
    });
    expect(await screen.findByText(/Tutor 请求尚未确认完成，原提问已保留：/)).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, 'changed after interruption');
    await user.click(screen.getByRole('button', { name: '重试此条提问' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(2));
    const retryButton = screen.getByRole('button', { name: '重试此条提问' });
    expect(retryButton).toBeDisabled();
    await user.click(retryButton);
    expect(api.streamTutorTurn).toHaveBeenCalledTimes(2);
    resolveRetry?.({
      ...completedTutorResponse,
      turn: { ...completedTutorResponse.turn, commandId: originalInput!.commandId },
    });

    const retryCall = vi.mocked(api.streamTutorTurn).mock.calls[1];
    expect(retryCall?.[0]).toBe(interruptedCall?.[0]);
    expect(retryCall?.[1]).toBe(interruptedCall?.[1]);
    const retryInput = retryCall?.[2];
    expect(retryInput).toEqual(originalInput);
    expect(screen.getByText('Why?')).toBeInTheDocument();
    expect(
      await screen.findByText('Because the current unit depends on this prerequisite.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Tutor 请求尚未确认完成，原提问已保留：/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('changed after interruption')).toBeInTheDocument();
    expect(screen.getAllByText('Why?')).toHaveLength(1);

    vi.mocked(api.streamTutorTurn).mockImplementationOnce(
      async (_workspaceId, _sessionId, input) => ({
        ...completedTutorResponse,
        session: { ...session, version: 3, transcriptWatermark: 4 },
        turn: {
          ...completedTutorResponse.turn,
          id: 'turn_2',
          commandId: input.commandId,
        },
        exchanges: completedTutorResponse.exchanges.map((exchange) => ({
          ...exchange,
          id: `${exchange.id}_next`,
          turnId: 'turn_2',
          content: exchange.role === 'learner' ? 'changed after interruption' : 'Next answer',
        })),
      }),
    );
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(3));
    const newTurnInput = vi.mocked(api.streamTutorTurn).mock.calls[2]?.[2];
    expect(newTurnInput).toEqual({
      commandId: expect.stringMatching(/^tutor_turn_/),
      expectedSessionVersion: 2,
      content: 'changed after interruption',
    });
    expect(newTurnInput?.commandId).not.toBe(originalInput?.commandId);
  });

  it('generates one command for a normal successful turn and leaves no retry handle', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    const firstAttempt = vi.fn().mockResolvedValue(completedTutorResponse);
    vi.mocked(api.streamTutorTurn).mockImplementation(firstAttempt);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument();

    const nextResponse = {
      ...completedTutorResponse,
      session: { ...session, version: 3, transcriptWatermark: 4 },
      turn: { ...completedTutorResponse.turn, id: 'turn_2', commandId: 'tutor_turn_next' },
      exchanges: completedTutorResponse.exchanges.map((exchange) => ({
        ...exchange,
        id: `${exchange.id}_next`,
        turnId: 'turn_2',
        content: exchange.role === 'learner' ? 'Next question' : 'Next answer',
      })),
    };
    vi.mocked(api.streamTutorTurn).mockResolvedValueOnce(nextResponse);
    await user.type(composer, 'Next question');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.streamTutorTurn).mock.calls;
    expect(calls[1]?.[2]).toEqual({
      commandId: expect.stringMatching(/^tutor_turn_/),
      expectedSessionVersion: 2,
      content: 'Next question',
    });
    expect(calls[1]?.[2]).not.toEqual(calls[0]?.[2]);
  });

  it('clears a definitive Tutor rejection instead of offering a blind replay', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.streamTutorTurn).mockRejectedValue(
      Object.assign(new Error('StudySession version conflict.'), { code: 'VERSION_CONFLICT' }),
    );

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() =>
      expect(screen.getByText('StudySession version conflict.')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument();
  });

  it('drops an interrupted retry when the accepted route changes', async () => {
    const user = userEvent.setup();
    const successorRoute = {
      ...currentRoute,
      contractVersionId: 'contract_2',
      executionVersion: 5,
    };
    const successorSession = { ...session, id: 'session_2', contractVersionId: 'contract_2' };
    vi.mocked(api.listStudySessions).mockImplementation(async () => ({
      sessions: [session, successorSession],
    }));
    vi.mocked(api.getStudySession).mockImplementation(async (_workspaceId, sessionId) =>
      sessionId === successorSession.id ? { ...detail, session: successorSession } : detail,
    );
    vi.mocked(api.streamTutorTurn).mockRejectedValue(
      Object.assign(new Error('StudySession stream was interrupted.'), {
        code: 'NETWORK_ERROR',
      }),
    );

    const { rerender } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('button', { name: '重试此条提问' })).toBeInTheDocument();

    rerender(<StudySessionView workspaceId="ws_1" route={successorRoute} />);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument(),
    );
    expect(api.streamTutorTurn).toHaveBeenCalledTimes(1);
  });
});
