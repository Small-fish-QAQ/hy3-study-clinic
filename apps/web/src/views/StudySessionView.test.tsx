import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LessonExecutionProjection,
  PublicQuiz,
  StudySession,
  StudySessionDetailResponse,
} from '@hy3-clinic/shared';
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
    getLessonExecution: vi.fn(),
    prepareLessonExecution: vi.fn(),
    lessonExecutionCommand: vi.fn(),
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

const lessonUnavailable: LessonExecutionProjection = {
  status: 'lesson_unavailable',
  message: '当前安排暂时没有可展示的讲解。',
  course: { title: 'Probability' },
  session: { status: session.status, version: session.version },
  agenda: { version: detail.agenda.version, itemState: detail.agenda.items[0]!.state },
  lesson: null,
  progress: null,
  currentInformalCheck: null,
  allowedActions: [],
};

const lessonReady: LessonExecutionProjection = {
  status: 'ready',
  message: 'Lesson is ready.',
  course: { title: 'Probability' },
  session: { status: session.status, version: session.version },
  agenda: { version: detail.agenda.version, itemState: detail.agenda.items[0]!.state },
  lesson: {
    objective: {
      title: '理解条件概率',
      whyNow: '它是后续推理的基础。',
      outcomes: [{ title: '解释定义', description: '能用自己的话解释。' }],
    },
    prerequisites: [],
    segments: [
      {
        index: 0,
        purpose: 'explanation',
        explanation: '条件概率会把观察范围收窄到已知条件。',
        explanationOrigin: 'source_grounded',
        sources: [
          {
            referenceKey: 'S1',
            materialTitle: '概率论讲义',
            headingPath: ['第二章', '条件概率'],
            pageNumber: 12,
            slideNumber: null,
            locationLabel: '第 12 页 · 条件概率',
            exactExcerpt: '在已知事件 B 发生时，事件 A 的条件概率记作 P(A|B)。',
            classification: 'exact_source_excerpt',
          },
        ],
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
      text: '条件概率聚焦已知条件下的可能性。',
      nextConnection: null,
      formalOpportunities: [],
    },
  },
  progress: {
    stateVersion: 1,
    currentSegmentIndex: 0,
    segmentCount: 1,
    presentedSegmentIndexes: [0],
    presentationStatus: 'in_progress',
    presentationCompletedAt: null,
  },
  currentInformalCheck: null,
  allowedActions: ['move_to_next_segment'],
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
  vi.mocked(api.getLessonExecution).mockResolvedValue(lessonUnavailable);
  vi.mocked(api.prepareLessonExecution).mockResolvedValue(lessonUnavailable);
  vi.mocked(api.lessonExecutionCommand).mockResolvedValue(lessonUnavailable);
});

async function openStudyControls(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openInspector(user, '安排');
  await user.click(await screen.findByText('调整本次学习'));
}

async function openAgenda(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openInspector(user, '安排');
}

async function openInspector(
  user: ReturnType<typeof userEvent.setup>,
  tabName: '安排' | '上下文' | '来源' | '证据' | '活动' | '产物',
): Promise<void> {
  if (!screen.queryByRole('button', { name: '关闭学习上下文' })) {
    await user.click(await screen.findByRole('button', { name: /学习上下文/ }));
  }
  const tab = await screen.findByRole('tab', { name: tabName });
  if (tab.getAttribute('aria-selected') !== 'true') await user.click(tab);
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

  it('moves focus to the surviving Study target when a route change removes the inspector', async () => {
    const user = userEvent.setup();
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
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session, successorSession] });
    vi.mocked(api.getStudySession).mockImplementation(async (_workspaceId, sessionId) => ({
      ...detail,
      session: sessionId === successorSession.id ? successorSession : session,
    }));

    const { rerender } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const trigger = await screen.findByRole('button', { name: /学习上下文/ });
    await user.click(trigger);
    expect(await screen.findByRole('button', { name: '关闭学习上下文' })).toHaveFocus();

    const studyTarget = screen.getByLabelText('学习');
    rerender(<StudySessionView workspaceId="ws_1" route={successorRoute} />);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '关闭学习上下文' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(studyTarget).toHaveFocus());
    expect(studyTarget).toBe(screen.getByLabelText('学习'));
    await waitFor(() =>
      expect(api.getStudySession).toHaveBeenCalledWith(
        'ws_1',
        successorSession.id,
        expect.any(AbortSignal),
      ),
    );
    expect(studyTarget).toHaveFocus();
  });

  it('keeps dialogue in the transcript and separates the formal evidence boundary', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      exchanges: completedTutorResponse.exchanges,
    });

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);

    const transcript = await screen.findByRole('log', { name: '学习对话记录' });
    expect(transcript).toContainElement(screen.getByRole('article', { name: '你，对话' }));
    expect(transcript).toContainElement(screen.getByRole('article', { name: 'Hy3 Tutor，对话' }));
    await openInspector(user, '证据');
    expect(screen.getByRole('region', { name: '正式证据边界' })).toHaveTextContent(
      '普通 Tutor 对话和非正式检查不会改变掌握状态',
    );
  });

  it('sends contextual quick help as ordinary learner text without selecting a move', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.streamTutorTurn).mockResolvedValue(completedTutorResponse);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);

    await user.click(await screen.findByRole('button', { name: '举个例子' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(1));
    const input = vi.mocked(api.streamTutorTurn).mock.calls[0]?.[2];
    expect(input).toEqual({
      commandId: expect.stringMatching(/^tutor_turn_/),
      expectedSessionVersion: 1,
      content: '举个例子说明一下。',
    });
    expect(input).not.toHaveProperty('move');
  });

  it('renders accepted Tutor metadata in learner language with keyboard-reachable sources', async () => {
    const user = userEvent.setup();
    const sourceTurn = {
      ...completedTutorResponse.turn,
      tutorMetadata: {
        move: 'GIVE_EXAMPLE' as const,
        sourceRefs: ['S1'],
        routeSignal: 'detour_started' as const,
        lessonSegmentIndex: 0,
        policyVersion: 'lesson-aware-tutor-v1',
      },
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      turns: [sourceTurn],
      exchanges: completedTutorResponse.exchanges,
    });
    vi.mocked(api.getLessonExecution).mockResolvedValue(lessonReady);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);

    expect(await screen.findByText('正在围绕：理解条件概率 · 核心解释')).toBeInTheDocument();
    expect(screen.getAllByText('举个例子')).toHaveLength(2);
    expect(screen.getByText(/这是一个补充问题，回答完可以回到：理解条件概率/)).toBeInTheDocument();
    expect(screen.queryByText('GIVE_EXAMPLE')).not.toBeInTheDocument();
    expect(screen.queryByText('S1')).not.toBeInTheDocument();

    const disclosure = screen.getByText('查看来源（1）');
    disclosure.focus();
    await user.keyboard('{Enter}');
    expect(screen.getAllByText('概率论讲义').length).toBeGreaterThan(0);
    expect(screen.getAllByText('第 12 页 · 条件概率').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/在已知事件 B 发生时/).length).toBeGreaterThan(0);
  });

  it('labels synthesis without fabricating a citation and sends Enter while preserving Shift+Enter', async () => {
    const user = userEvent.setup();
    const synthesisTurn = {
      ...completedTutorResponse.turn,
      tutorMetadata: {
        move: 'GIVE_ANALOGY' as const,
        sourceRefs: [],
        routeSignal: 'stay_on_route' as const,
        lessonSegmentIndex: 0,
        policyVersion: 'lesson-aware-tutor-v1',
      },
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      turns: [synthesisTurn],
      exchanges: completedTutorResponse.exchanges,
    });
    vi.mocked(api.streamTutorTurn).mockResolvedValue(completedTutorResponse);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);

    expect(await screen.findByText('Hy3 补充解释')).toBeInTheDocument();
    expect(screen.queryByText(/查看来源/)).not.toBeInTheDocument();
    const composer = screen.getByLabelText('向 Tutor 提问');
    await user.type(composer, '第一行{Shift>}{Enter}{/Shift}第二行');
    expect(composer).toHaveValue('第一行\n第二行');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.streamTutorTurn).mock.calls[0]?.[2]).toMatchObject({
      content: '第一行\n第二行',
    });
  });

  it('uses one Send or Stop locus and aborts the active Tutor stream', async () => {
    const user = userEvent.setup();
    let streamSignal: AbortSignal | undefined;
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.streamTutorTurn).mockImplementation(
      async (_workspaceId, _sessionId, _input, _onLine, signal) => {
        streamSignal = signal;
        return await new Promise<never>(() => undefined);
      },
    );

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByLabelText('向 Tutor 提问');
    await user.type(composer, 'Explain this step.');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const stop = await screen.findByRole('button', { name: '停止生成' });
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
    expect(composer).toBeDisabled();
    await user.click(stop);

    expect(streamSignal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('opens the contextual inspector and presents only available session data across tabs', async () => {
    const user = userEvent.setup();
    const startedEvent = {
      id: 'event_started_1',
      sessionId: session.id,
      turnId: completedTutorResponse.turn.id,
      seq: 0,
      kind: 'started' as const,
      provisional: true,
      content: null,
      createdAt: session.updatedAt,
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      turns: [
        {
          ...completedTutorResponse.turn,
          contextManifest: {
            ...completedTutorResponse.turn.contextManifest,
            sourceBlockRevisionIds: ['source_revision_1', 'source_revision_2'],
            formalEvidenceIds: ['formal_evidence_1'],
          },
        },
      ],
      turnEvents: [startedEvent],
    });

    render(<StudySessionView workspaceId="ws_1" courseName="Probability" route={currentRoute} />);
    await openInspector(user, '安排');

    expect(screen.getByRole('complementary', { name: '学习上下文' })).toBeInTheDocument();
    expect(
      screen.getByRole('listitem', { name: 'Learn the current unit.，当前，进行中' }),
    ).toHaveAttribute('aria-current', 'step');

    await user.click(screen.getByRole('tab', { name: '上下文' }));
    expect(screen.getByText('Probability')).toBeInTheDocument();
    expect(screen.getByText('当前已接受且版本化的路线')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '来源' }));
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/进入上下文不代表内容为真/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '证据' }));
    expect(screen.getByText(/1 条既有正式证据记录/)).toBeInTheDocument();
    expect(screen.getByText(/评分耐久性与进展对账保持分离/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '活动' }));
    expect(screen.getByText('Tutor 开始回应')).toBeInTheDocument();
    expect(screen.getByText('临时事件，不具状态权限')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '产物' }));
    expect(screen.getByText(/没有暴露独立的学习产物/)).toBeInTheDocument();
  });

  it('supports inspector tab keys, Escape, and focus restoration', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const trigger = await screen.findByRole('button', { name: /学习上下文/ });
    await user.click(trigger);
    expect(await screen.findByRole('button', { name: '关闭学习上下文' })).toHaveFocus();

    const agendaTab = screen.getByRole('tab', { name: '安排' });
    await user.click(agendaTab);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '上下文' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('tab', { name: '上下文' })).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '关闭学习上下文' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('uses modal inspector semantics and an inert Study surface below the desktop threshold', async () => {
    const user = userEvent.setup();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(max-width: 1279px)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    try {
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
      vi.mocked(api.getStudySession).mockResolvedValue(detail);

      const { container } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      const trigger = await screen.findByRole('button', { name: /学习上下文/ });
      await user.click(trigger);

      expect(await screen.findByRole('dialog', { name: '学习上下文' })).toHaveAttribute(
        'aria-modal',
        'true',
      );
      await waitFor(() =>
        expect(container.querySelector('.study-session-primary')).toHaveAttribute('inert'),
      );
      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(container.querySelector('.study-session-primary')).not.toHaveAttribute('inert'),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      matchMedia.mockRestore();
    }
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
    await user.click(await screen.findByRole('button', { name: '正式评估可用' }));
    await user.click(await screen.findByRole('button', { name: '发起正式评估' }));

    await waitFor(() => expect(api.launchAgendaItem).toHaveBeenCalled());
    expect(onLaunchQuiz).toHaveBeenCalledWith(expect.objectContaining({ id: 'quiz_1' }));
  });

  it('offers the formal-ready Tutor CTA only when an accepted turn and launchable checkpoint agree', async () => {
    const user = userEvent.setup();
    const onLaunchQuiz = vi.fn();
    const formalReadyTurn = {
      ...completedTutorResponse.turn,
      tutorMetadata: {
        move: 'FORMAL_CHECK_READY' as const,
        sourceRefs: [],
        routeSignal: 'stay_on_route' as const,
        lessonSegmentIndex: 0,
        policyVersion: 'lesson-aware-tutor-v1',
      },
    };
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
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      agenda: checkpointAgenda,
      turns: [formalReadyTurn],
      exchanges: completedTutorResponse.exchanges,
    });
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
    vi.spyOn(window, 'prompt').mockReturnValue('Tutor says ready');

    const { rerender } = render(
      <StudySessionView workspaceId="ws_1" route={currentRoute} onLaunchQuiz={onLaunchQuiz} />,
    );

    expect(await screen.findByText('这部分已经讲到可以检验的程度')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始正式检验' })).toBeInTheDocument();
    expect(screen.queryByText('FORMAL_CHECK_READY')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始正式检验' }));
    await waitFor(() => expect(api.launchAgendaItem).toHaveBeenCalled());
    expect(api.studySessionCommand).toHaveBeenCalledWith(
      'ws_1',
      'session_1',
      expect.objectContaining({
        kind: 'direct_checkpoint',
        targetAgendaItemId: 'agenda_item_checkpoint',
        reason: 'Tutor says ready',
      }),
      expect.any(AbortSignal),
    );
    expect(onLaunchQuiz).toHaveBeenCalledWith(expect.objectContaining({ id: 'quiz_1' }));

    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      turns: [formalReadyTurn],
      exchanges: completedTutorResponse.exchanges,
    });
    rerender(
      <StudySessionView workspaceId="ws_1" route={{ ...currentRoute, executionVersion: 5 }} />,
    );
    await waitFor(() =>
      expect(screen.queryByText('这部分已经讲到可以检验的程度')).not.toBeInTheDocument(),
    );
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

  it('reconciles a definitive Tutor failure before sending the next new turn without a remount', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    const failedTurn = {
      ...completedTutorResponse.turn,
      status: 'failed' as const,
      errorMessage: 'Hy3 Tutor is temporarily unavailable.',
      completedAt: session.updatedAt,
    };
    const reconciledDetail: StudySessionDetailResponse = {
      ...detail,
      session: { ...session, version: 2 },
      turns: [failedTurn],
    };
    vi.mocked(api.getStudySession)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(reconciledDetail);
    const nextResponse = {
      ...completedTutorResponse,
      session: { ...session, version: 3, transcriptWatermark: 2 },
      turn: { ...completedTutorResponse.turn, id: 'turn_2', commandId: 'tutor_turn_next' },
      exchanges: completedTutorResponse.exchanges.map((exchange) => ({
        ...exchange,
        id: `${exchange.id}_next`,
        turnId: 'turn_2',
        content: exchange.role === 'learner' ? 'What should I try next?' : 'Try the next example.',
      })),
    };
    vi.mocked(api.streamTutorTurn)
      .mockRejectedValueOnce(
        Object.assign(new Error('Hy3 Tutor is temporarily unavailable.'), {
          code: 'PROVIDER_ERROR',
        }),
      )
      .mockResolvedValueOnce(nextResponse);

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Hy3 Tutor is temporarily unavailable.')).toBeInTheDocument();
    await waitFor(() => expect(api.getStudySession).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument();
    expect(composer).toBeEnabled();

    await user.type(composer, 'What should I try next?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.streamTutorTurn).mock.calls[1]?.[2]).toEqual({
      commandId: expect.stringMatching(/^tutor_turn_/),
      expectedSessionVersion: 2,
      content: 'What should I try next?',
    });
    expect(await screen.findByText('Try the next example.')).toBeInTheDocument();
    expect(screen.queryByText('Hy3 Tutor is temporarily unavailable.')).not.toBeInTheDocument();
    expect(screen.getAllByText('What should I try next?')).toHaveLength(1);
  });

  it('keeps the composer fenced when failure reconciliation fails and enables it after sync retry', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession)
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new Error('Session detail unavailable.'))
      .mockResolvedValueOnce({
        ...detail,
        session: { ...session, version: 2 },
      });
    vi.mocked(api.streamTutorTurn).mockRejectedValueOnce(
      Object.assign(new Error('Hy3 Tutor is temporarily unavailable.'), {
        code: 'PROVIDER_ERROR',
      }),
    );

    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const sync = await screen.findByRole('button', { name: '重新同步学习记录' });
    expect(screen.getByText(/当前学习记录尚未同步/)).toBeInTheDocument();
    expect(composer).toBeDisabled();

    await user.click(sync);

    await waitFor(() => expect(api.getStudySession).toHaveBeenCalledTimes(3));
    expect(composer).toBeEnabled();
    expect(screen.queryByRole('button', { name: '重新同步学习记录' })).not.toBeInTheDocument();
    expect(screen.getByText('Hy3 Tutor is temporarily unavailable.')).toBeInTheDocument();
    expect(api.streamTutorTurn).toHaveBeenCalledTimes(1);
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
