import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CourseFormalReadiness,
  LessonExecutionProjection,
  PublicQuiz,
  StudySession,
  StudySessionDetailResponse,
} from '@hy3-clinic/shared';
import { StudySessionView } from './StudySessionView.js';
import { api, ApiClientError } from '../api.js';

vi.mock('../api.js', async (importOriginal) => ({
  ApiClientError: (await importOriginal<{ ApiClientError: typeof ApiClientError }>())
    .ApiClientError,
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
    getAgendaFormalAssessment: vi.fn(),
    getFormalExecution: vi.fn(),
    startFormalExecution: vi.fn(),
    submitFormalExecution: vi.fn(),
    getLearnerRepair: vi.fn(),
    startLearnerRepair: vi.fn(),
    learnerRepairPractice: vi.fn(),
    createRepairVerification: vi.fn(),
    learnerRepairAction: vi.fn(),
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
    stateId: 'lesson_state_1',
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

function needsSupportLesson(): LessonExecutionProjection {
  const lesson = structuredClone(lessonReady);
  lesson.session.version = 7;
  lesson.agenda!.version = 3;
  lesson.progress!.stateVersion = 11;
  lesson.progress!.presentationStatus = 'presentation_completed';
  lesson.progress!.presentationCompletedAt = session.updatedAt;
  lesson.allowedActions = ['prepare_practice_repair'];
  lesson.practice = {
    status: 'in_progress',
    currentItemIndex: 0,
    itemCount: 1,
    item: null,
    attempts: [],
    completedAt: null,
    credit: 'none',
    recovery: {
      phase: 'needs_support',
      round: 3,
      selectedAnswer: '忽略条件',
      feedback: '还需要检查条件。',
      learnerNote: '',
      diagnosis: null,
      teaching: null,
      retest: null,
    },
  };
  return lesson;
}

function deferResponse(withSuccessor = false) {
  const agenda = structuredClone(detail.agenda);
  agenda.version = 4;
  agenda.items = [
    { ...agenda.items[0]!, state: 'completed' },
    {
      ...agenda.items[0]!,
      id: 'agenda_item_2',
      index: 1,
      learningUnitId: 'unit_2',
      linkedPlanItemId: 'plan_item_2',
      state: 'deferred',
    },
    ...(withSuccessor
      ? [
          {
            ...agenda.items[0]!,
            id: 'agenda_item_3',
            index: 2,
            learningUnitId: 'unit_3',
            linkedPlanItemId: 'plan_item_3',
          },
        ]
      : []),
  ];
  agenda.currentItemId = withSuccessor ? 'agenda_item_3' : null;
  return {
    session: { ...session, version: 8, currentAgendaItemId: agenda.currentItemId },
    agenda,
    effect: {
      kind: 'defer' as const,
      affectedAgendaItemId: agenda.currentItemId,
      planChangeRequest: null,
    },
  };
}

function activeDeferDetail(withSuccessor = false): StudySessionDetailResponse {
  const response = deferResponse(withSuccessor);
  return {
    ...detail,
    session: { ...response.session, version: 7, currentAgendaItemId: 'agenda_item_2' },
    agenda: {
      ...response.agenda,
      version: 3,
      currentItemId: 'agenda_item_2',
      items: response.agenda.items.map((item) =>
        item.id === 'agenda_item_2'
          ? { ...item, state: 'active' }
          : item.id === 'agenda_item_3'
            ? { ...item, state: 'queued' }
            : item,
      ),
    },
  };
}

function advancedDeferDetail(): StudySessionDetailResponse {
  const receipt = deferResponse(true);
  const next = structuredClone({ ...detail, session: receipt.session, agenda: receipt.agenda });
  next.session.version = 9;
  next.session.currentAgendaItemId = 'agenda_item_4';
  next.agenda.version = 5;
  next.agenda.currentItemId = 'agenda_item_4';
  next.agenda.items[2]!.state = 'deferred';
  next.agenda.items.push({
    ...next.agenda.items[2]!,
    id: 'agenda_item_4',
    index: 3,
    learningUnitId: 'unit_4',
    linkedPlanItemId: 'plan_item_4',
    state: 'active',
  });
  return next;
}

const currentRoute = {
  contractVersionId: session.contractVersionId,
  curriculumVersionId: session.curriculumVersionId,
  studyPlanVersionId: session.studyPlanVersionId,
  sessionAgendaId: session.sessionAgendaId,
  executionVersion: 4,
};

const pendingFormalReadiness: CourseFormalReadiness = {
  status: 'pending',
  requiredObjectiveCount: 14,
  readyObjectiveCount: 0,
  unresolvedObjectiveIds: Array.from({ length: 14 }, (_, index) => `objective_${index + 1}`),
  teachingOnlyObjectiveIds: Array.from({ length: 14 }, (_, index) => `objective_${index + 1}`),
};

const readyFormalReadiness: CourseFormalReadiness = {
  status: 'ready',
  requiredObjectiveCount: 1,
  readyObjectiveCount: 1,
  unresolvedObjectiveIds: [],
  teachingOnlyObjectiveIds: [],
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
  sessionStorage.clear();
  vi.mocked(api.getAgendaFormalAssessment).mockResolvedValue(null);
  vi.mocked(api.getFormalExecution).mockResolvedValue(null);
  vi.mocked(api.getLessonExecution).mockResolvedValue(lessonUnavailable);
  vi.mocked(api.prepareLessonExecution).mockResolvedValue(lessonUnavailable);
  vi.mocked(api.lessonExecutionCommand).mockResolvedValue(lessonUnavailable);
});

async function openTutor(): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: '问 Tutor' });
  await userEvent.setup().click(buttons[0]!);
}

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
  it.each([false, true])(
    'defers the exact current teaching item using the refreshed Session version and shows remaining work (successor=%s)',
    async (withSuccessor) => {
      const user = userEvent.setup();
      const initial = structuredClone(detail);
      const response = deferResponse(withSuccessor);
      initial.session.currentAgendaItemId = 'agenda_item_2';
      initial.agenda.currentItemId = 'agenda_item_2';
      initial.agenda.items = response.agenda.items.map((item) =>
        item.id === 'agenda_item_2' ? { ...item, state: 'active' } : item,
      );
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      vi.mocked(api.getStudySession)
        .mockResolvedValueOnce(initial)
        .mockResolvedValue({
          ...initial,
          session: { ...initial.session, version: 7 },
          agenda: { ...initial.agenda, version: 3 },
        });
      const successor = structuredClone(lessonReady);
      successor.session.version = 8;
      successor.agenda!.version = 4;
      successor.lesson!.objective.title = '后续合法学习内容';
      vi.mocked(api.getLessonExecution)
        .mockResolvedValueOnce(needsSupportLesson())
        .mockResolvedValue(successor);
      vi.mocked(api.studySessionCommand).mockResolvedValue(response);
      vi.spyOn(window, 'prompt').mockReturnValue('这次延期，稍后补上');
      const changed = vi.fn();
      render(
        <StudySessionView
          workspaceId="ws_1"
          route={currentRoute}
          onSessionChanged={changed}
          curriculumUnits={[
            { id: 'unit_2', title: '当前未完成单元' },
            { id: 'unit_3', title: '后续单元' },
          ]}
        />,
      );
      const defer = await screen.findByRole('button', { name: '延期本节内容，保留缺口' });
      expect(api.studySessionCommand).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '根据新思路继续修补' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: '关闭学习上下文' })).not.toBeInTheDocument();
      await user.click(defer);
      expect(api.studySessionCommand).toHaveBeenCalledExactlyOnceWith(
        'ws_1',
        'session_1',
        expect.objectContaining({
          expectedSessionVersion: 7,
          kind: 'defer',
          targetAgendaItemId: 'agenda_item_2',
          targetLearningUnitId: null,
          reason: '这次延期，稍后补上',
        }),
        expect.any(AbortSignal),
      );
      if (withSuccessor) {
        expect(
          await screen.findByRole('heading', { name: '后续合法学习内容' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('status', { name: '保留的学习缺口' })).toHaveTextContent(
          '1 项内容已延期，仍未完成',
        );
      } else {
        expect(
          await screen.findByRole('heading', { name: '本轮暂无可继续的学习内容' }),
        ).toBeInTheDocument();
        expect(
          screen.getByText('仍有 1 项安排未完成；延期保留缺口，不记为通过。'),
        ).toBeInTheDocument();
        expect(api.getLessonExecution).toHaveBeenCalledOnce();
      }
      expect(screen.getByText('当前未完成单元 · 已延期，保留缺口')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '返回课程查看待完成工作' })).toHaveAttribute(
        'href',
        '#/course/ws_1/home',
      );
      expect(screen.queryByRole('heading', { name: '本节学习已完成' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '延期本节内容，保留缺口' }),
      ).not.toBeInTheDocument();
      expect(api.lessonExecutionCommand).not.toHaveBeenCalled();
      expect(api.launchAgendaItem).not.toHaveBeenCalled();
      expect(api.startFormalExecution).not.toHaveBeenCalled();
      expect(api.startLearnerRepair).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'reconciles a committed defer after its response is lost without sending another command (successor=%s)',
    async (withSuccessor) => {
      const user = userEvent.setup();
      const initial = activeDeferDetail(withSuccessor);
      const response = deferResponse(withSuccessor);
      let committed = false;
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      vi.mocked(api.getStudySession).mockImplementation(async () =>
        committed ? { ...detail, session: response.session, agenda: response.agenda } : initial,
      );
      const successor = structuredClone(lessonReady);
      successor.progress!.stateId = 'lesson_state_successor';
      successor.lesson!.objective.title = '延期后当前讲解';
      successor.session.version = 8;
      successor.agenda!.version = 4;
      vi.mocked(api.getLessonExecution).mockImplementation(async () =>
        committed ? successor : needsSupportLesson(),
      );
      vi.mocked(api.studySessionCommand).mockImplementation(async () => {
        committed = true;
        throw new ApiClientError('NETWORK_ERROR', 'response lost after commit');
      });
      vi.spyOn(window, 'prompt').mockReturnValue('稍后补上');
      const changed = vi.fn();
      render(
        <StudySessionView workspaceId="ws_1" route={currentRoute} onSessionChanged={changed} />,
      );
      await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
      expect(
        await screen.findByRole('heading', {
          name: withSuccessor ? '延期后当前讲解' : '本轮暂无可继续的学习内容',
        }),
      ).toBeInTheDocument();
      expect(api.getStudySession).toHaveBeenCalledTimes(2);
      expect(api.studySessionCommand).toHaveBeenCalledOnce();
      expect(api.studySessionCommand).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({ targetAgendaItemId: 'agenda_item_2', expectedSessionVersion: 7 }),
        expect.any(AbortSignal),
      );
      expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
      expect(screen.queryByText('response lost after commit')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(changed).toHaveBeenCalledOnce();
      expect(api.lessonExecutionCommand).not.toHaveBeenCalled();
      expect(api.startFormalExecution).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'unavailable', 'pending_lease'] as const)(
    'keeps an unresolved defer visible and reuses its immutable command on retry (reread=%s)',
    async (reread) => {
      const user = userEvent.setup();
      const initial = activeDeferDetail();
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      const get = vi.mocked(api.getStudySession).mockResolvedValueOnce(initial);
      if (reread === 'unavailable')
        get.mockRejectedValue(new ApiClientError('NETWORK_ERROR', 'reread unavailable'));
      else get.mockResolvedValue(initial);
      vi.mocked(api.getLessonExecution).mockResolvedValue(needsSupportLesson());
      const command = vi
        .mocked(api.studySessionCommand)
        .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'unknown defer response'));
      if (reread === 'pending_lease')
        command.mockRejectedValueOnce(
          new ApiClientError('VERSION_CONFLICT', 'command is already in progress', 409, {
            operationId: 'pending-defer-operation',
            operationPending: true,
          }),
        );
      command.mockImplementation(async () => {
        const response = deferResponse();
        get.mockResolvedValue({ ...detail, session: response.session, agenda: response.agenda });
        return response;
      });
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('保留原来的延期原因');
      render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
      expect(await screen.findByRole('status', { name: '延期结果待确认' })).toHaveTextContent(
        '延期结果尚未确认',
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '重试同一延期请求' })).toBeEnabled(),
      );
      expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '延期本节内容，保留缺口' })).toBeDisabled();
      expect(screen.queryByRole('status', { name: '保留的学习缺口' })).not.toBeInTheDocument();
      expect(command).toHaveBeenCalledOnce();
      const originalInput = command.mock.calls[0]![2];
      await user.click(screen.getByRole('button', { name: '重试同一延期请求' }));
      if (reread === 'pending_lease') {
        await waitFor(() =>
          expect(screen.getByRole('button', { name: '重试同一延期请求' })).toBeEnabled(),
        );
        expect(screen.getByRole('status', { name: '延期结果待确认' })).toBeInTheDocument();
        expect(command.mock.calls[1]![2]).toBe(originalInput);
        await user.click(screen.getByRole('button', { name: '重试同一延期请求' }));
        expect(command.mock.calls[2]![2]).toBe(originalInput);
      }
      expect(
        await screen.findByRole('heading', { name: '本轮暂无可继续的学习内容' }),
      ).toBeInTheDocument();
      expect(command).toHaveBeenCalledTimes(reread === 'pending_lease' ? 3 : 2);
      expect(command.mock.calls[1]![2]).toBe(originalInput);
      expect(prompt).toHaveBeenCalledOnce();
      expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
    },
  );

  it('reconciles an unresolved defer through an explicit authoritative reread without retrying', async () => {
    const user = userEvent.setup();
    const initial = activeDeferDetail();
    const response = deferResponse();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
    vi.mocked(api.getStudySession)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...detail, session: response.session, agenda: response.agenda });
    vi.mocked(api.getLessonExecution).mockResolvedValue(needsSupportLesson());
    vi.mocked(api.studySessionCommand).mockRejectedValue(
      new ApiClientError('NETWORK_ERROR', 'lost'),
    );
    vi.spyOn(window, 'prompt').mockReturnValue('稍后补上');
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重新读取延期状态' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: '重新读取延期状态' }));
    expect(
      await screen.findByRole('heading', { name: '本轮暂无可继续的学习内容' }),
    ).toBeInTheDocument();
    expect(api.studySessionCommand).toHaveBeenCalledOnce();
    expect(api.getStudySession).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([1, 12])(
    'rereads the live route after a historical defer replay before adopting Lesson B v%s after A v11',
    async (successorVersion) => {
      const user = userEvent.setup();
      const initial = activeDeferDetail(true);
      const receipt = deferResponse(true);
      const live = advancedDeferDetail();
      let resolveLive!: (value: StudySessionDetailResponse) => void;
      const liveRead = new Promise<StudySessionDetailResponse>((resolve) => {
        resolveLive = resolve;
      });
      const get = vi
        .mocked(api.getStudySession)
        .mockResolvedValueOnce(initial)
        .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'immediate reread lost'))
        .mockReturnValueOnce(liveRead)
        .mockResolvedValue(live);
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      const oldLesson = needsSupportLesson();
      oldLesson.progress!.stateId = 'lesson_state_A';
      const successor = needsSupportLesson();
      successor.progress!.stateId = 'lesson_state_B';
      successor.progress!.stateVersion = successorVersion;
      successor.session.version = 9;
      successor.agenda!.version = 5;
      successor.lesson!.objective.title = '当前 item 4 的讲解';
      const lessons = vi
        .mocked(api.getLessonExecution)
        .mockResolvedValueOnce(oldLesson)
        .mockResolvedValue(successor);
      const final = structuredClone(live);
      final.session.version = 10;
      final.session.currentAgendaItemId = null;
      final.agenda.version = 6;
      final.agenda.currentItemId = null;
      final.agenda.items[3]!.state = 'deferred';
      const command = vi
        .mocked(api.studySessionCommand)
        .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'committed response lost'))
        .mockResolvedValueOnce(receipt)
        .mockResolvedValue({
          session: final.session,
          agenda: final.agenda,
          effect: { ...receipt.effect, affectedAgendaItemId: null },
        });
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('保留当前教学缺口');
      render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '重试同一延期请求' })).toBeEnabled(),
      );
      const original = command.mock.calls[0]![2];
      await user.click(screen.getByRole('button', { name: '重试同一延期请求' }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
      expect(command).toHaveBeenCalledTimes(2);
      expect(command.mock.calls[1]![2]).toBe(original);
      expect(prompt).toHaveBeenCalledOnce();
      expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '当前 item 4 的讲解' })).not.toBeInTheDocument();
      expect(screen.getByRole('status', { name: '延期结果待确认' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '延期本节内容，保留缺口' })).toBeDisabled();
      await act(async () => resolveLive(live));
      expect(
        await screen.findByRole('heading', { name: '当前 item 4 的讲解' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('status', { name: '保留的学习缺口' })).toHaveTextContent(
        '2 项内容已延期，仍未完成',
      );
      expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
      await act(async () => {});
      expect(get).toHaveBeenCalledTimes(3);
      expect(lessons).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole('button', { name: '延期本节内容，保留缺口' }));
      expect(command.mock.calls[2]![2]).toMatchObject({
        targetAgendaItemId: 'agenda_item_4',
        expectedSessionVersion: 9,
      });
      expect(api.lessonExecutionCommand).not.toHaveBeenCalled();
      expect(api.startFormalExecution).not.toHaveBeenCalled();
      expect(api.startLearnerRepair).not.toHaveBeenCalled();
    },
  );

  it.each([1, 12])(
    'validates the first Lesson B v%s after route reset against the live Session binding',
    async (successorVersion) => {
      const user = userEvent.setup();
      const initial = activeDeferDetail(true);
      const receipt = deferResponse(true);
      const live = advancedDeferDetail();
      let resolveBinding!: (value: StudySessionDetailResponse) => void;
      const binding = new Promise<StudySessionDetailResponse>((resolve) => {
        resolveBinding = resolve;
      });
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      const get = vi
        .mocked(api.getStudySession)
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(binding)
        .mockResolvedValue(live);
      const oldLesson = needsSupportLesson();
      oldLesson.progress!.stateId = 'lesson_state_A';
      const successor = needsSupportLesson();
      successor.progress!.stateId = 'lesson_state_B';
      successor.progress!.stateVersion = successorVersion;
      successor.session.version = 9;
      successor.agenda!.version = 5;
      successor.lesson!.objective.title = '经过绑定确认的 item 4';
      const lessons = vi
        .mocked(api.getLessonExecution)
        .mockResolvedValueOnce(oldLesson)
        .mockResolvedValue(successor);
      const final = structuredClone(live);
      final.session.version = 10;
      final.session.currentAgendaItemId = null;
      final.agenda.version = 6;
      final.agenda.currentItemId = null;
      final.agenda.items[3]!.state = 'deferred';
      const command = vi
        .mocked(api.studySessionCommand)
        .mockResolvedValueOnce(receipt)
        .mockResolvedValue({
          session: final.session,
          agenda: final.agenda,
          effect: { ...receipt.effect, affectedAgendaItemId: null },
        });
      vi.spyOn(window, 'prompt').mockReturnValue('延期当前安排');
      render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      expect(
        screen.queryByRole('heading', { name: '经过绑定确认的 item 4' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '延期本节内容，保留缺口' }),
      ).not.toBeInTheDocument();
      await act(async () => resolveBinding(live));
      expect(
        await screen.findByRole('heading', { name: '经过绑定确认的 item 4' }),
      ).toBeInTheDocument();
      await act(async () => {});
      expect(get).toHaveBeenCalledTimes(2);
      expect(lessons).toHaveBeenCalledTimes(3);
      expect(screen.getByRole('status', { name: '保留的学习缺口' })).toHaveTextContent(
        '2 项内容已延期，仍未完成',
      );
      await user.click(screen.getByRole('button', { name: '延期本节内容，保留缺口' }));
      expect(command.mock.calls[1]![2]).toMatchObject({
        targetAgendaItemId: 'agenda_item_4',
        expectedSessionVersion: 9,
      });
    },
  );

  it('keeps the original defer unresolved when its replay succeeds but the live reread is unavailable', async () => {
    const user = userEvent.setup();
    const initial = activeDeferDetail(true);
    const receipt = deferResponse(true);
    const live = advancedDeferDetail();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
    const get = vi
      .mocked(api.getStudySession)
      .mockResolvedValueOnce(initial)
      .mockRejectedValue(new ApiClientError('NETWORK_ERROR', 'live route unavailable'));
    const successor = needsSupportLesson();
    successor.progress!.stateId = 'lesson_state_B';
    successor.progress!.stateVersion = 1;
    successor.session.version = 9;
    successor.agenda!.version = 5;
    successor.lesson!.objective.title = '读取成功后的 item 4';
    const lessons = vi
      .mocked(api.getLessonExecution)
      .mockResolvedValueOnce(needsSupportLesson())
      .mockResolvedValue(successor);
    const command = vi
      .mocked(api.studySessionCommand)
      .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'committed response lost'))
      .mockResolvedValue(receipt);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('保留原请求');
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await user.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重试同一延期请求' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: '重试同一延期请求' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重新读取延期状态' })).toBeEnabled(),
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[1]![2]).toBe(command.mock.calls[0]![2]);
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: '延期结果待确认' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '延期本节内容，保留缺口' })).toBeDisabled();
    expect(screen.queryByRole('status', { name: '保留的学习缺口' })).not.toBeInTheDocument();
    expect(lessons).toHaveBeenCalledOnce();
    get.mockResolvedValue(live);
    await user.click(screen.getByRole('button', { name: '重新读取延期状态' }));
    expect(await screen.findByRole('heading', { name: '读取成功后的 item 4' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(4);
    expect(lessons).toHaveBeenCalledTimes(2);
  });

  it('reconciles an unprepared successor before its version counters can change the parent binding', async () => {
    const user = userEvent.setup();
    const initial = activeDeferDetail(true);
    const live = advancedDeferDetail();
    let resolveBinding!: (value: StudySessionDetailResponse) => void;
    const binding = new Promise<StudySessionDetailResponse>((resolve) => {
      resolveBinding = resolve;
    });
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
    const get = vi
      .mocked(api.getStudySession)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(binding)
      .mockResolvedValue(live);
    const oldLesson = needsSupportLesson();
    oldLesson.progress!.stateId = 'lesson_state_A';
    const unprepared: LessonExecutionProjection = {
      ...lessonReady,
      status: 'preparation_needed',
      session: { status: 'active', version: 9 },
      agenda: { version: 5, itemState: 'active' },
      lesson: null,
      progress: null,
      allowedActions: ['prepare_lesson'],
    };
    const successor = needsSupportLesson();
    successor.progress!.stateId = 'lesson_state_B';
    successor.progress!.stateVersion = 1;
    successor.session.version = 9;
    successor.agenda!.version = 5;
    successor.lesson!.objective.title = '从当前 item 4 读取的讲解';
    const lessons = vi
      .mocked(api.getLessonExecution)
      .mockResolvedValueOnce(oldLesson)
      .mockResolvedValueOnce(unprepared)
      .mockResolvedValue(successor);
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await user.click(await screen.findByRole('button', { name: '重新读取修补状态' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '准备本节讲解' })).not.toBeInTheDocument();
    await act(async () => resolveBinding(live));
    expect(
      await screen.findByRole('heading', { name: '从当前 item 4 读取的讲解' }),
    ).toBeInTheDocument();
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);
    expect(lessons).toHaveBeenCalledTimes(3);
    expect(api.studySessionCommand).not.toHaveBeenCalled();
    expect(api.lessonExecutionCommand).not.toHaveBeenCalled();
  });

  it('discards a late uncertain-defer reread after the accepted route changes', async () => {
    const initial = activeDeferDetail();
    let resolveReread!: (value: StudySessionDetailResponse) => void;
    const reread = new Promise<StudySessionDetailResponse>((resolve) => {
      resolveReread = resolve;
    });
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
    vi.mocked(api.getStudySession).mockResolvedValueOnce(initial).mockReturnValueOnce(reread);
    vi.mocked(api.getLessonExecution).mockResolvedValue(needsSupportLesson());
    vi.mocked(api.studySessionCommand).mockRejectedValue(
      new ApiClientError('NETWORK_ERROR', 'lost'),
    );
    vi.spyOn(window, 'prompt').mockReturnValue('稍后补上');
    const changed = vi.fn();
    const view = render(
      <StudySessionView workspaceId="ws_1" route={currentRoute} onSessionChanged={changed} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
    await waitFor(() => expect(api.getStudySession).toHaveBeenCalledTimes(2));
    const next = structuredClone(detail);
    next.session = {
      ...session,
      id: 'session_2',
      sessionAgendaId: 'agenda_2',
      studyPlanVersionId: 'plan_2',
    };
    next.agenda.id = 'agenda_2';
    next.agenda.studyPlanVersionId = 'plan_2';
    const nextLesson = structuredClone(lessonReady);
    nextLesson.progress!.stateId = 'lesson_state_next_route';
    nextLesson.lesson!.objective.title = '新路线当前讲解';
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [next.session] });
    vi.mocked(api.getStudySession).mockResolvedValue(next);
    vi.mocked(api.getLessonExecution).mockResolvedValue(nextLesson);
    view.rerender(
      <StudySessionView
        workspaceId="ws_1"
        route={{
          ...currentRoute,
          sessionAgendaId: 'agenda_2',
          studyPlanVersionId: 'plan_2',
          executionVersion: 5,
        }}
        onSessionChanged={changed}
      />,
    );
    expect(await screen.findByRole('heading', { name: '新路线当前讲解' })).toBeInTheDocument();
    const response = deferResponse();
    await act(async () => {
      resolveReread({ ...detail, session: response.session, agenda: response.agenda });
    });
    expect(screen.getByRole('heading', { name: '新路线当前讲解' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '延期结果待确认' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '本轮暂无可继续的学习内容' }),
    ).not.toBeInTheDocument();
    expect(api.studySessionCommand).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([1, 12])(
    'reconciles the Session binding before displaying successor Lesson B v%s after Lesson A v11',
    async (successorVersion) => {
      const user = userEvent.setup();
      const initial = activeDeferDetail(true);
      const response = deferResponse(true);
      let resolveBinding!: (value: StudySessionDetailResponse) => void;
      const binding = new Promise<StudySessionDetailResponse>((resolve) => {
        resolveBinding = resolve;
      });
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      vi.mocked(api.getStudySession).mockResolvedValueOnce(initial).mockReturnValue(binding);
      const oldLesson = needsSupportLesson();
      oldLesson.progress!.stateId = 'lesson_state_A';
      const successor = needsSupportLesson();
      successor.progress!.stateId = 'lesson_state_B';
      successor.progress!.stateVersion = successorVersion;
      successor.lesson!.objective.title = '当前路线的后续讲解';
      successor.session.version = 8;
      successor.agenda!.version = 4;
      vi.mocked(api.getLessonExecution)
        .mockResolvedValueOnce(oldLesson)
        .mockResolvedValue(successor);
      const finalAgenda = structuredClone(response.agenda);
      finalAgenda.version = 5;
      finalAgenda.currentItemId = null;
      finalAgenda.items[2]!.state = 'deferred';
      vi.mocked(api.studySessionCommand).mockResolvedValue({
        ...response,
        session: { ...response.session, version: 9, currentAgendaItemId: null },
        agenda: finalAgenda,
      });
      vi.spyOn(window, 'prompt').mockReturnValue('延期当前后续单元');
      render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      await user.click(await screen.findByRole('button', { name: '重新读取修补状态' }));
      await waitFor(() => expect(api.getStudySession).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '当前路线的后续讲解' })).not.toBeInTheDocument();
      await act(async () => {
        resolveBinding({ ...detail, session: response.session, agenda: response.agenda });
      });
      expect(
        await screen.findByRole('heading', { name: '当前路线的后续讲解' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '理解条件概率' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '延期本节内容，保留缺口' }));
      expect(api.studySessionCommand).toHaveBeenCalledExactlyOnceWith(
        'ws_1',
        'session_1',
        expect.objectContaining({ targetAgendaItemId: 'agenda_item_3', expectedSessionVersion: 8 }),
        expect.any(AbortSignal),
      );
    },
  );

  it('restores a deferred incomplete unit after reload without requesting a nonexistent Lesson', async () => {
    const response = deferResponse();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [response.session] });
    vi.mocked(api.getStudySession).mockResolvedValue({
      ...detail,
      session: response.session,
      agenda: response.agenda,
    });
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    expect(
      await screen.findByRole('heading', { name: '本轮暂无可继续的学习内容' }),
    ).toBeInTheDocument();
    expect(screen.getByText('仍有 1 项安排未完成；延期保留缺口，不记为通过。')).toBeInTheDocument();
    expect(api.getLessonExecution).not.toHaveBeenCalled();
    expect(api.studySessionCommand).not.toHaveBeenCalled();
  });

  it('does not defer when the learner dismisses the reason prompt', async () => {
    const initial = activeDeferDetail();
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
    vi.mocked(api.getStudySession).mockResolvedValue(initial);
    vi.mocked(api.getLessonExecution).mockResolvedValue(needsSupportLesson());
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await userEvent.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
    expect(api.studySessionCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)(
    'discards a late defer %s after the accepted route changes',
    async (outcome) => {
      let resolve!: (value: ReturnType<typeof deferResponse>) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<ReturnType<typeof deferResponse>>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const initial = activeDeferDetail();
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [initial.session] });
      vi.mocked(api.getStudySession).mockResolvedValue(initial);
      vi.mocked(api.getLessonExecution).mockResolvedValue(needsSupportLesson());
      vi.mocked(api.studySessionCommand).mockReturnValue(pending);
      vi.spyOn(window, 'prompt').mockReturnValue('稍后补上');
      const changed = vi.fn();
      const view = render(
        <StudySessionView workspaceId="ws_1" route={currentRoute} onSessionChanged={changed} />,
      );
      await userEvent.click(await screen.findByRole('button', { name: '延期本节内容，保留缺口' }));
      const next = structuredClone(detail);
      next.session = {
        ...session,
        id: 'session_2',
        sessionAgendaId: 'agenda_2',
        studyPlanVersionId: 'plan_2',
      };
      next.agenda.id = 'agenda_2';
      next.agenda.studyPlanVersionId = 'plan_2';
      const nextLesson = structuredClone(lessonReady);
      nextLesson.lesson!.objective.title = '切换后的课程讲解';
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [next.session] });
      vi.mocked(api.getStudySession).mockResolvedValue(next);
      vi.mocked(api.getLessonExecution).mockResolvedValue(nextLesson);
      view.rerender(
        <StudySessionView
          workspaceId="ws_1"
          route={{
            ...currentRoute,
            sessionAgendaId: 'agenda_2',
            studyPlanVersionId: 'plan_2',
            executionVersion: 5,
          }}
          onSessionChanged={changed}
        />,
      );
      expect(await screen.findByRole('heading', { name: '切换后的课程讲解' })).toBeInTheDocument();
      await act(async () => {
        if (outcome === 'success') resolve(deferResponse());
        else reject(new ApiClientError('NETWORK_ERROR', '过期的延期错误'));
      });
      expect(screen.getByRole('heading', { name: '切换后的课程讲解' })).toBeInTheDocument();
      expect(
        screen.queryByText('仍有 1 项安排未完成；延期保留缺口，不记为通过。'),
      ).not.toBeInTheDocument();
      expect(changed).not.toHaveBeenCalled();
      expect(screen.queryByText('过期的延期错误')).not.toBeInTheDocument();
    },
  );

  it('synchronizes a running turn after reload before permitting a new question', async () => {
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession)
      .mockResolvedValueOnce({
        ...detail,
        turns: [{ ...completedTutorResponse.turn, status: 'running' }],
        exchanges: [completedTutorResponse.exchanges[0]!],
      })
      .mockResolvedValue({
        ...detail,
        session: { ...session, version: 2 },
        turns: [{ ...completedTutorResponse.turn, status: 'cancelled' }],
        exchanges: [completedTutorResponse.exchanges[0]!],
      });
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openTutor();
    expect(screen.getByLabelText('向 Tutor 提问')).toBeDisabled();
    expect(screen.getByText('正在同步上一条提问的结果…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('向 Tutor 提问')).toBeEnabled(), {
      timeout: 2500,
    });
    expect(screen.getByRole('button', { name: '重新编辑提问' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: '你，对话' })).toContainElement(
      screen.getByRole('button', { name: '重新编辑提问' }),
    );
    expect(api.streamTutorTurn).not.toHaveBeenCalled();
  });
  it('opens a selected passage in Tutor without sending, preserves the draft on reload, and submits its exact anchor', async () => {
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    vi.mocked(api.getLessonExecution).mockResolvedValue({
      ...lessonReady,
      progress: { ...lessonReady.progress!, stateId: 'lesson_state_1' },
    });
    vi.mocked(api.streamTutorTurn).mockResolvedValue(completedTutorResponse);
    const user = userEvent.setup();
    const first = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    const text = await screen.findByText('条件概率会把观察范围收窄到已知条件。');
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    const range = document.createRange();
    range.selectNodeContents(text);
    range.getBoundingClientRect = () => ({ left: 20, bottom: 100 }) as DOMRect;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    await user.click(await screen.findByRole('button', { name: '就这段问 Tutor' }));
    expect(api.streamTutorTurn).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('向 Tutor 提问'), '为什么要缩小范围？');
    await waitFor(() =>
      expect(sessionStorage.getItem('study-tutor-draft:ws_1:session_1')).toContain(
        '为什么要缩小范围',
      ),
    );
    first.unmount();
    render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
    await openTutor();
    const composer = screen.getByLabelText('向 Tutor 提问');
    expect(composer).toHaveValue('为什么要缩小范围？');
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(api.streamTutorTurn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(api.streamTutorTurn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.streamTutorTurn).mock.calls[0]?.[2]).toMatchObject({
      content: '为什么要缩小范围？',
      studyAnchor: {
        lessonExecutionStateId: 'lesson_state_1',
        lessonExecutionVersion: 1,
        segmentIndex: 0,
        selectedText: text.textContent,
      },
    });
    await user.click(screen.getByRole('button', { name: '回到讲解' }));
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    await openTutor();
    expect(screen.getByRole('article', { name: 'Hy3 Tutor，对话' })).toBeInTheDocument();
  });
  it('shows the end of an exhausted Agenda without requesting a nonexistent current Lesson', async () => {
    const finished = structuredClone(detail);
    finished.session.currentAgendaItemId = null;
    finished.agenda.currentItemId = null;
    finished.agenda.items = finished.agenda.items.map((item) => ({ ...item, state: 'completed' }));
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [finished.session] });
    vi.mocked(api.getStudySession).mockResolvedValue(finished);
    render(
      <StudySessionView
        workspaceId="ws_1"
        route={{
          contractVersionId: 'contract_1',
          curriculumVersionId: 'curriculum_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaId: 'agenda_1',
          executionVersion: 1,
        }}
      />,
    );
    expect(await screen.findByRole('heading', { name: '本轮学习安排已结束' })).toBeInTheDocument();
    expect(api.getLessonExecution).not.toHaveBeenCalled();
    expect(api.prepareLessonExecution).not.toHaveBeenCalled();
    expect(api.lessonExecutionCommand).not.toHaveBeenCalled();
  });
  it('does not offer session operations until a course workspace is selected', () => {
    render(<StudySessionView workspaceId={null} route={null} />);

    expect(screen.getByText('请先选择课程，再进入学习。')).toBeInTheDocument();
  });

  it('opens the current LearningUnit in the Knowledge Map', async () => {
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
    vi.mocked(api.getStudySession).mockResolvedValue(detail);
    const onOpenKnowledgeMap = vi.fn();
    const user = userEvent.setup();

    render(
      <StudySessionView
        workspaceId="ws_1"
        route={{
          contractVersionId: 'contract_1',
          curriculumVersionId: 'curriculum_1',
          studyPlanVersionId: 'plan_1',
          sessionAgendaId: 'agenda_1',
          executionVersion: 1,
        }}
        curriculumUnits={[{ id: 'unit_1', title: 'Bayes foundations' }]}
        onOpenKnowledgeMap={onOpenKnowledgeMap}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '在知识地图中定位' }));
    expect(onOpenKnowledgeMap).toHaveBeenCalledWith('unit_1');
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
    await openTutor();

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
    await openTutor();

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
        citations: [
          {
            referenceKey: 'S1',
            title: '概率论讲义',
            location: '第 12 页 · 条件概率',
            excerpt: '在已知事件 B 发生时，计算事件 A 的概率。',
          },
        ],
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
    await openTutor();

    expect(await screen.findByText('正在围绕：理解条件概率 · 核心解释')).toBeInTheDocument();
    expect(screen.getAllByText('举个例子')).toHaveLength(2);
    expect(screen.getByText(/这是一个补充问题，回答完可以回到：理解条件概率/)).toBeInTheDocument();
    expect(screen.queryByText('GIVE_EXAMPLE')).not.toBeInTheDocument();
    expect(screen.queryByText('S1')).not.toBeInTheDocument();

    const disclosure = screen.getByText('参考资料（1）');
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
    await openTutor();

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
    await openTutor();
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

  it.each([
    ['summary', 'opening'],
    ['menu action', 'opening'],
    ['summary', 'closing'],
  ])(
    'handles immediate Escape from the %s while the toolbar menu is %s',
    async (focusTarget, transition) => {
      const user = userEvent.setup();
      vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [session] });
      vi.mocked(api.getStudySession).mockResolvedValue(detail);

      const { container } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);
      const trigger = await screen.findByRole('button', { name: /学习上下文/ });
      await user.click(trigger);
      const closeInspector = await screen.findByRole('button', { name: '关闭学习上下文' });
      expect(closeInspector).toHaveFocus();
      const menu = container.querySelector<HTMLDetailsElement>('.study-session-more')!;
      const summary = menu.querySelector('summary')!;
      summary.focus();
      // Native details opens before its queued toggle event synchronizes React state.
      menu.open = true;
      if (transition === 'closing') {
        fireEvent(menu, new Event('toggle'));
        // Preserve the existing Escape order while a native close is still queued.
        menu.open = false;
      }
      const target = focusTarget === 'summary' ? summary : menu.querySelector('button')!;
      target.focus();
      fireEvent.keyDown(target, { key: 'Escape' });

      expect(menu).not.toHaveAttribute('open');
      expect(closeInspector).toBeInTheDocument();
      expect(summary).toHaveFocus();

      // Delivery of the queued toggle must not reopen the menu or close the inspector.
      fireEvent(menu, new Event('toggle'));
      expect(menu).not.toHaveAttribute('open');
      expect(closeInspector).toBeInTheDocument();
      expect(summary).toHaveFocus();

      await user.keyboard('{Escape}');
      await waitFor(() => expect(closeInspector).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(menu).toHaveAttribute('open');
    },
  );

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
      <StudySessionView
        workspaceId="ws_1"
        route={currentRoute}
        formalReadiness={readyFormalReadiness}
        onLaunchQuiz={onLaunchQuiz}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '正式评估可用' }));
    await user.click(await screen.findByRole('button', { name: '发起正式评估' }));

    await waitFor(() => expect(api.launchAgendaItem).toHaveBeenCalled());
    expect(onLaunchQuiz).toHaveBeenCalledWith(expect.objectContaining({ id: 'quiz_1' }));
  });

  it('hides Formal availability and reloads the same Session onto teaching while readiness is pending', async () => {
    const onSessionChanged = vi.fn();
    const synthesisItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_synthesis',
      kind: 'synthesis' as const,
      state: 'queued' as const,
      reason: 'Integrate objectives from a chapter-level synthesis group.',
      launch: {
        status: 'launchable' as const,
        capability: 'assessment',
        resourceId: '{"mode":"concept_practice"}',
        reason: null,
      },
    };
    const teachingItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_teaching_next',
      index: 1,
      state: 'queued' as const,
      reason: 'Teach the next prerequisite-safe unit.',
      learningUnitId: 'unit_2',
      launch: {
        status: 'launchable' as const,
        capability: 'lesson',
        resourceId: '{"learningUnitId":"unit_2","conceptId":"concept_2"}',
        reason: null,
      },
    };
    const pendingCheckpointItem = {
      ...synthesisItem,
      id: 'agenda_formal_pending',
      index: 2,
      kind: 'formal_checkpoint' as const,
      reason: 'Formally verify a pending objective.',
    };
    const blockedSession = { ...session, currentAgendaItemId: synthesisItem.id };
    const blockedAgenda = {
      ...detail.agenda,
      items: [synthesisItem, teachingItem, pendingCheckpointItem],
      currentItemId: synthesisItem.id,
    };
    const routedSession = {
      ...blockedSession,
      version: blockedSession.version + 1,
      currentAgendaItemId: teachingItem.id,
    };
    const routedAgenda = {
      ...blockedAgenda,
      version: blockedAgenda.version + 1,
      currentItemId: teachingItem.id,
    };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [blockedSession] });
    vi.mocked(api.getStudySession)
      .mockResolvedValueOnce({ ...detail, session: blockedSession, agenda: blockedAgenda })
      .mockResolvedValue({ ...detail, session: routedSession, agenda: routedAgenda });
    vi.mocked(api.startStudySession).mockResolvedValue({ session: routedSession });
    vi.mocked(api.getLessonExecution).mockResolvedValue({
      ...lessonReady,
      session: { status: routedSession.status, version: routedSession.version },
      agenda: { version: routedAgenda.version, itemState: teachingItem.state },
    });

    render(
      <StudySessionView
        workspaceId="ws_1"
        route={currentRoute}
        formalReadiness={pendingFormalReadiness}
        curriculumUnits={[{ id: 'unit_2', title: 'Next executable teaching' }]}
        onSessionChanged={onSessionChanged}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Next executable teaching' })).toBeVisible();
    expect(api.startStudySession).toHaveBeenCalledWith(
      'ws_1',
      expect.objectContaining({ sessionAgendaId: currentRoute.sessionAgendaId }),
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole('button', { name: '正式评估可用' })).not.toBeInTheDocument();
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });

  it('launches the current due Review and clears its formal version when Agenda changes', async () => {
    const user = userEvent.setup();
    const dueItem = {
      ...detail.agenda.items[0]!,
      id: 'agenda_due_review',
      index: 1,
      kind: 'due_review' as const,
      origin: 'due_review' as const,
      reason: 'This objective is due for an independent recall.',
      state: 'queued' as const,
      launch: {
        status: 'launchable' as const,
        capability: 'assessment' as const,
        resourceId: JSON.stringify({
          mode: 'review',
          conceptIds: ['review-target:ws_1:objective_1'],
        }),
        reason: null,
      },
    };
    const unrelatedCheckpoint = {
      ...dueItem,
      id: 'agenda_unrelated_checkpoint',
      index: 0,
      kind: 'formal_checkpoint' as const,
      origin: 'accepted_plan' as const,
      reason: 'An unrelated earlier checkpoint.',
    };
    const dueSession = { ...session, currentAgendaItemId: dueItem.id };
    const dueAgenda = {
      ...detail.agenda,
      items: [unrelatedCheckpoint, dueItem],
      currentItemId: dueItem.id,
    };
    const dueDetail = { ...detail, session: dueSession, agenda: dueAgenda };
    vi.mocked(api.listStudySessions).mockResolvedValue({ sessions: [dueSession] });
    vi.mocked(api.getStudySession).mockResolvedValueOnce(dueDetail).mockResolvedValue(detail);
    vi.mocked(api.studySessionCommand).mockResolvedValue({
      session: { ...dueSession, version: 2 },
      agenda: dueAgenda,
      effect: {
        kind: 'direct_checkpoint',
        affectedAgendaItemId: dueItem.id,
        planChangeRequest: null,
      },
    });
    vi.mocked(api.launchAgendaItem).mockResolvedValue({
      kind: 'assessment',
      agendaItemId: dueItem.id,
      assessmentKind: 'due_review',
      quiz: { id: 'quiz_due_review' } as PublicQuiz,
      formalAssessmentVersionId: 'formal_due_review_1',
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Begin the due Review.');

    const { rerender } = render(<StudySessionView workspaceId="ws_1" route={currentRoute} />);

    await user.click(await screen.findByRole('button', { name: '开始到期复习' }));
    await waitFor(() =>
      expect(api.studySessionCommand).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({
          kind: 'direct_checkpoint',
          targetAgendaItemId: dueItem.id,
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(api.launchAgendaItem).toHaveBeenCalledWith(
      'ws_1',
      'agenda_1',
      dueItem.id,
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole('heading', { name: '先独立回忆这项目标' })).toBeInTheDocument();

    rerender(
      <StudySessionView
        workspaceId="ws_1"
        route={{ ...currentRoute, executionVersion: currentRoute.executionVersion + 1 }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: '先独立回忆这项目标' })).not.toBeInTheDocument(),
    );
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
      <StudySessionView
        workspaceId="ws_1"
        route={currentRoute}
        formalReadiness={readyFormalReadiness}
        onLaunchQuiz={onLaunchQuiz}
      />,
    );
    await openTutor();

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
    await openTutor();
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
    await openTutor();
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
    await openTutor();
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
    await openTutor();
    const composer = await screen.findByPlaceholderText('输入你的问题或想法…');
    await user.type(composer, 'Why?');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('Hy3 Tutor is temporarily unavailable.')).toBeInTheDocument();
    await waitFor(() => expect(api.getStudySession).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: '重试此条提问' })).not.toBeInTheDocument();
    expect(composer).toBeEnabled();

    expect(composer).toHaveValue('Why?');
    await user.clear(composer);
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
    await openTutor();
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
    await openTutor();
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
