import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LessonExecutionProjection } from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { LessonExecutionPanel, LessonSourceReference } from './LessonExecutionPanel.js';

const source = {
  referenceKey: 'S1',
  materialTitle: '概率论讲义',
  headingPath: ['第二章', '条件概率'],
  pageNumber: 12,
  slideNumber: null,
  locationLabel: '第 12 页',
  exactExcerpt: '条件概率描述了在已知另一个事件发生时，某事件发生的可能性。',
  classification: 'exact_source_excerpt' as const,
};

function readyLesson(
  progress: NonNullable<LessonExecutionProjection['progress']>,
  status: 'ready' = 'ready',
): LessonExecutionProjection {
  return {
    status,
    message: 'Lesson is ready.',
    course: { title: '概率课程' },
    session: { status: 'active', version: 2 },
    agenda: { version: 3, itemState: 'active' },
    lesson: {
      objective: {
        title: '理解条件概率',
        whyNow: '它是后续贝叶斯推理的基础。',
        outcomes: [{ title: '能解释定义', description: '用自己的话说明条件概率。' }],
      },
      prerequisites: [],
      segments: [
        {
          index: 0,
          purpose: 'orientation',
          explanation: '先把条件概率放回事件与信息的关系中。',
          explanationOrigin: 'source_grounded',
          sources: [source],
          example: null,
          contrast: null,
          possibleMisconception: null,
          informalCheck: {
            kind: 'explain_in_your_words',
            prompt: '请用自己的话说说它描述了什么。',
            guidance: '关注“已知”条件。',
            presented: progress.presentedSegmentIndexes.includes(0),
            response: progress.presentedSegmentIndexes.includes(0) ? '我的练习回应' : null,
            respondedAt: progress.presentedSegmentIndexes.includes(0)
              ? '2026-08-19T01:00:00.000Z'
              : null,
            credit: 'none',
          },
        },
        {
          index: 1,
          purpose: 'worked_example',
          explanation: '再通过一个简单例子观察分母为何来自已知条件。',
          explanationOrigin: 'hy3_synthesis',
          sources: [],
          example: {
            text: '抽取红球的例子帮助我们区分整体与条件集合。',
            origin: 'hy3_synthesis',
            sources: [],
          },
          contrast: null,
          possibleMisconception: null,
          informalCheck: null,
        },
      ],
      sourceReferencesAvailable: true,
      visuals: [],
      summary: {
        available: true,
        text: '条件概率把观察范围收窄到已知条件。',
        nextConnection: '下一节将把它用于贝叶斯公式。',
        formalOpportunities: [],
      },
    },
    progress,
    currentInformalCheck: null,
    allowedActions:
      progress.presentationStatus === 'not_started' ? ['start_lesson'] : ['move_to_next_segment'],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function practiceRetryLesson(): LessonExecutionProjection {
  const recovery = readyLesson({
    stateVersion: 2,
    currentSegmentIndex: 0,
    segmentCount: 2,
    presentedSegmentIndexes: [],
    presentationStatus: 'not_started',
    presentationCompletedAt: null,
  });
  recovery.status = 'practice_retry_available';
  recovery.message = '讲解内容已经安全保存；这次非正式练习准备没有完成。';
  recovery.practice = null;
  recovery.allowedActions = ['retry_preparation'];
  return recovery;
}

function lessonTitled(title: string): LessonExecutionProjection {
  const lesson = structuredClone(prepared);
  lesson.lesson!.objective.title = title;
  return lesson;
}

const needed: LessonExecutionProjection = {
  status: 'preparation_needed',
  message: 'Prepare this lesson to begin.',
  course: { title: '概率课程' },
  session: { status: 'active', version: 1 },
  agenda: { version: 2, itemState: 'active' },
  lesson: null,
  progress: null,
  currentInformalCheck: null,
  allowedActions: ['prepare_lesson'],
};

const prepared = readyLesson({
  stateVersion: 1,
  currentSegmentIndex: 0,
  segmentCount: 2,
  presentedSegmentIndexes: [],
  presentationStatus: 'not_started',
  presentationCompletedAt: null,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LessonExecutionPanel', () => {
  it('uses the same Session version advanced by Tutor while preserving the Lesson and Agenda fences', async () => {
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(prepared);
    const command = vi.spyOn(api, 'lessonExecutionCommand').mockResolvedValue(prepared);
    const props = {
      workspaceId: 'ws_1',
      sessionId: 'session_1',
      agendaItemId: 'agenda_item_1',
      active: true,
      busy: false,
    };
    const view = render(<LessonExecutionPanel {...props} sessionVersion={2} />);
    await screen.findByRole('button', { name: '开始本节讲解' });
    view.rerender(<LessonExecutionPanel {...props} sessionVersion={4} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '开始本节讲解' }));
    expect(command).toHaveBeenCalledWith(
      'ws_1',
      'session_1',
      expect.objectContaining({
        expectedSessionVersion: 4,
        expectedAgendaVersion: 3,
        expectedLessonStateVersion: 1,
        expectedAgendaItemId: 'agenda_item_1',
      }),
      expect.any(AbortSignal),
    );
  });
  it('renders a due Review entry instead of the generic unavailable lesson state', async () => {
    const user = userEvent.setup();
    const startReview = vi.fn();
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue({
      ...needed,
      status: 'lesson_unavailable',
      message: 'No lesson is required for this Review.',
      allowedActions: [],
    });

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="due_review_1"
        active
        reviewMode
        directCheckpointItemId="due_review_1"
        onStartFormalAssessment={startReview}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: '先用一次独立回忆确认这项目标' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('当前安排暂时没有可展示的讲解。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始到期复习' }));
    expect(startReview).toHaveBeenCalledOnce();
  });

  it('shows source-binding recovery guidance without offering a repeated retry', async () => {
    const get = vi.spyOn(api, 'getLessonExecution').mockResolvedValue({
      ...needed,
      status: 'lesson_unavailable',
      message:
        '当前课程路线的来源绑定无法安全准备本节讲解。已有学习记录保持不变，请回到课程主页重新准备当前课程路线。',
      allowedActions: [],
    });
    const prepare = vi.spyOn(api, 'prepareLessonExecution');

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );

    expect(
      await screen.findByRole('heading', { name: '当前讲解无法安全准备' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/已有学习记录保持不变/)).toBeInTheDocument();
    expect(screen.getByText(/回到课程主页重新准备当前课程路线/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新准备本节讲解' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新读取安排' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('shows slide provenance ahead of a fallback heading path', () => {
    render(
      <LessonSourceReference
        source={{ ...source, pageNumber: null, slideNumber: 4, locationLabel: 'Slide 4' }}
      />,
    );
    expect(screen.getByText('第 4 张幻灯片')).toBeInTheDocument();
  });

  it('prepares a missing lesson once and renders the ready lesson hierarchy', async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(api, 'getLessonExecution').mockResolvedValue(needed);
    const prepare = vi.spyOn(api, 'prepareLessonExecution').mockResolvedValue(prepared);
    vi.spyOn(api, 'lessonExecutionCommand').mockResolvedValue({
      ...readyLesson({
        stateVersion: 2,
        currentSegmentIndex: 0,
        segmentCount: 2,
        presentedSegmentIndexes: [0],
        presentationStatus: 'in_progress',
        presentationCompletedAt: null,
      }),
      allowedActions: ['respond_to_informal_check', 'move_to_next_segment'],
    });

    const { rerender } = render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument(),
    );
    expect(screen.getByText('本节目标')).toBeInTheDocument();
    expect(screen.getByText('为什么现在学')).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledTimes(1);
    rerender(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '开始本节讲解' }));
    await waitFor(() =>
      expect(api.lessonExecutionCommand).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({ action: { kind: 'start_lesson' } }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('keeps polling authoritative preparation state until it becomes ready', async () => {
    vi.useFakeTimers();
    const preparingProjection: LessonExecutionProjection = {
      ...needed,
      status: 'preparing',
      message: 'Your lesson is being prepared.',
      allowedActions: ['wait_for_preparation'],
    };
    const get = vi
      .spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(preparingProjection)
      .mockResolvedValueOnce(preparingProjection)
      .mockResolvedValueOnce(prepared);
    const prepare = vi.spyOn(api, 'prepareLessonExecution');

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: '正在准备一节有顺序的讲解' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('stops preparation polling after one route conflict while the parent refreshes', async () => {
    vi.useFakeTimers();
    const preparingProjection: LessonExecutionProjection = {
      ...needed,
      status: 'preparing',
      message: 'Your lesson is being prepared.',
      allowedActions: ['wait_for_preparation'],
    };
    const get = vi
      .spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(preparingProjection)
      .mockRejectedValueOnce(new ApiClientError('VERSION_CONFLICT', 'route changed', 409));
    const refreshSession = vi.fn();

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
        onRefreshSession={refreshSession}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledOnce();
  });

  it('keeps provenance compact, distinguishes synthesis, and records informal checks without formal language', async () => {
    const user = userEvent.setup();
    const inProgress = readyLesson({
      stateVersion: 2,
      currentSegmentIndex: 0,
      segmentCount: 2,
      presentedSegmentIndexes: [0],
      presentationStatus: 'in_progress',
      presentationCompletedAt: null,
    });
    inProgress.lesson!.segments[0]!.informalCheck = {
      ...inProgress.lesson!.segments[0]!.informalCheck!,
      response: null,
      respondedAt: null,
    };
    inProgress.lesson!.segments[0]!.example = {
      text: '这个补充例子帮助学习者观察条件改变后的结果。',
      origin: 'hy3_synthesis',
      sources: [],
    };
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(inProgress);
    const command = vi.spyOn(api, 'lessonExecutionCommand').mockResolvedValue({
      ...inProgress,
      progress: { ...inProgress.progress!, stateVersion: 3 },
      lesson: {
        ...inProgress.lesson!,
        segments: inProgress.lesson!.segments.map((segment) =>
          segment.index === 0 && segment.informalCheck
            ? {
                ...segment,
                informalCheck: {
                  ...segment.informalCheck,
                  response: '我的练习回应',
                  respondedAt: '2026-08-19T01:00:00.000Z',
                },
              }
            : segment,
        ),
      },
      currentInformalCheck: null,
      allowedActions: ['move_to_next_segment'],
    });

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    expect((await screen.findAllByText('概率论讲义')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Hy3 补充讲解')).length).toBeGreaterThan(0);
    expect(screen.queryByText('S1')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('查看来源：概率论讲义，第 12 页'));
    expect(screen.getByText(source.exactExcerpt)).toBeInTheDocument();

    await user.type(screen.getByLabelText('练习回应'), '我的练习回应');
    await user.click(screen.getByRole('button', { name: '提交练习回应' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({
          action: { kind: 'respond_to_informal_check', segmentIndex: 0, response: '我的练习回应' },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.getByText(/不计入正式进展/)).toBeInTheDocument();
  });

  it('presents multiple short teaching segments continuously before one check', async () => {
    const continuous = readyLesson({
      stateVersion: 2,
      currentSegmentIndex: 2,
      segmentCount: 3,
      presentedSegmentIndexes: [0, 1, 2],
      presentationStatus: 'summary_ready',
      presentationCompletedAt: null,
    });
    const check = {
      ...continuous.lesson!.segments[0]!.informalCheck!,
      guidance: null,
      presented: true,
      response: null,
      respondedAt: null,
    };
    continuous.lesson!.segments[0]!.informalCheck = null;
    continuous.lesson!.segments.push({
      ...continuous.lesson!.segments[1]!,
      index: 2,
      purpose: 'guided_practice',
      explanation: '最后把前面的机制用于一个变化后的判断。',
      informalCheck: check,
    });
    continuous.allowedActions = ['respond_to_informal_check'];
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(continuous);

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );

    expect(await screen.findByText('先把条件概率放回事件与信息的关系中。')).toBeInTheDocument();
    expect(screen.getByText('再通过一个简单例子观察分母为何来自已知条件。')).toBeInTheDocument();
    expect(screen.getByText('最后把前面的机制用于一个变化后的判断。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已呈现 1/1 段连续讲解');
    expect(screen.queryByRole('button', { name: '继续讲解' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '练习回应' })).toBeEnabled();
  });

  it('renders a supported choose check as real choices with deterministic feedback', async () => {
    const user = userEvent.setup();
    const choice = readyLesson({
      stateVersion: 2,
      currentSegmentIndex: 0,
      segmentCount: 2,
      presentedSegmentIndexes: [0],
      presentationStatus: 'in_progress',
      presentationCompletedAt: null,
    });
    choice.allowedActions = ['respond_to_informal_check'];
    choice.lesson!.segments[0]!.informalCheck = {
      kind: 'choose',
      prompt: '条件改变后，哪一个判断仍然成立？',
      guidance: null,
      options: [
        { id: 'A', text: '忽略新条件' },
        { id: 'B', text: '按新条件重新判断' },
      ],
      presented: true,
      response: null,
      respondedAt: null,
      correct: null,
      feedback: null,
      credit: 'none',
    };
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(choice);
    const answered = structuredClone(choice);
    answered.progress!.stateVersion = 3;
    answered.lesson!.segments[0]!.informalCheck = {
      ...answered.lesson!.segments[0]!.informalCheck!,
      guidance: '变化后的条件决定新的结论。',
      response: 'B',
      respondedAt: '2026-08-19T01:00:00.000Z',
      correct: true,
      feedback: '正确：先更新条件，再判断结果。',
    };
    answered.allowedActions = ['move_to_next_segment'];
    const command = vi.spyOn(api, 'lessonExecutionCommand').mockResolvedValue(answered);

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );

    await user.click(await screen.findByRole('radio', { name: '按新条件重新判断' }));
    expect(screen.queryByRole('textbox', { name: '练习回应' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交选择' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        'ws_1',
        'session_1',
        expect.objectContaining({
          action: { kind: 'respond_to_informal_check', segmentIndex: 0, response: 'B' },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText('回答正确')).toBeInTheDocument();
    expect(screen.getByText('正确：先更新条件，再判断结果。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续讲解' })).toBeEnabled();
  });

  it('shows contingent wrong-answer feedback and a changed retry before Practice completion', async () => {
    const user = userEvent.setup();
    const initial = readyLesson({
      stateVersion: 6,
      currentSegmentIndex: 1,
      segmentCount: 2,
      presentedSegmentIndexes: [0, 1],
      presentationStatus: 'presentation_completed',
      presentationCompletedAt: '2026-08-19T01:00:00.000Z',
    });
    initial.allowedActions = ['submit_practice_response'];
    initial.practice = {
      status: 'available',
      currentItemIndex: 0,
      itemCount: 1,
      item: {
        index: 0,
        objectiveTitle: '解释条件概率',
        construct: 'explain',
        surface: 'initial',
        prompt: '哪种解释说明了条件如何改变结果？',
        options: [
          { id: 'initial_A', text: '条件改变了候选范围' },
          { id: 'initial_B', text: '只重复标题中的词' },
          { id: 'initial_C', text: '忽略已知条件' },
        ],
      },
      attempts: [],
      completedAt: null,
      credit: 'none',
    };
    const retry = structuredClone(initial);
    retry.session.version = 3;
    retry.progress!.stateVersion = 7;
    retry.practice = {
      ...initial.practice,
      status: 'in_progress',
      item: {
        ...initial.practice.item!,
        surface: 'retry',
        prompt: '换一个候选集合后，哪种解释仍然成立？',
        options: [
          { id: 'retry_A', text: '标题位置变了' },
          { id: 'retry_B', text: '满足条件的候选变了' },
          { id: 'retry_C', text: '所有候选都保留' },
        ],
      },
      attempts: [
        {
          itemIndex: 0,
          attemptNumber: 1,
          surface: 'initial',
          selectedOptionId: 'initial_B',
          correct: false,
          feedback: '这只是表面复述，没有让条件参与推理。',
          hint: '找出条件如何改变候选范围。',
          respondedAt: '2026-08-19T01:01:00.000Z',
          credit: 'none',
        },
      ],
    };
    const completed = structuredClone(retry);
    completed.session.version = 4;
    completed.progress!.stateVersion = 8;
    completed.allowedActions = ['review_lesson'];
    completed.practice = {
      ...retry.practice,
      status: 'completed',
      item: null,
      attempts: [
        ...retry.practice.attempts,
        {
          itemIndex: 0,
          attemptNumber: 2,
          surface: 'retry',
          selectedOptionId: 'retry_B',
          correct: true,
          feedback: '正确：候选资格改变，所以结果改变。',
          hint: null,
          respondedAt: '2026-08-19T01:02:00.000Z',
          credit: 'none',
        },
      ],
      completedAt: '2026-08-19T01:02:00.000Z',
    };
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(initial);
    const command = vi
      .spyOn(api, 'lessonExecutionCommand')
      .mockResolvedValueOnce(retry)
      .mockResolvedValueOnce(completed);

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await user.click(await screen.findByRole('button', { name: '只重复标题中的词' }));
    expect(screen.queryByText(/检验能力/)).not.toBeInTheDocument();
    expect(screen.queryByText(/为什么练/)).not.toBeInTheDocument();
    expect(await screen.findByText('这只是表面复述，没有让条件参与推理。')).toBeInTheDocument();
    expect(screen.getByText(/找出条件如何改变候选范围/)).toBeInTheDocument();
    expect(screen.getByText('换一个候选集合后，哪种解释仍然成立？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '满足条件的候选变了' }));
    expect(await screen.findByRole('heading', { name: '练习完成' })).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('preserves an accepted Lesson as a read-only preview while retrying only Practice', async () => {
    const user = userEvent.setup();
    const recovery = practiceRetryLesson();
    recovery.lesson!.segments[1]!.workedProcess = {
      startingState: '等待重新准备练习时仍可阅读已接受案例。',
      inputs: ['已接受的条件'],
      ruleOrProcedure: '按条件决定动作。',
      steps: [
        {
          action: '先检查条件。',
          reason: '条件限制动作。',
          resultingState: '允许范围已经明确。',
        },
      ],
      learnerDecision: '选择下一步。',
      result: null,
      whyResultFollows: null,
      origin: 'hy3_synthesis',
      sources: [],
      interaction: {
        stage: 'guided',
        modelledStepCount: 1,
        origin: 'hy3_synthesis',
        sources: [],
        activity: {
          prompt: '哪项动作符合当前条件？',
          options: [
            { id: 'A', text: '只读预览选项 A' },
            { id: 'B', text: '只读预览选项 B' },
            { id: 'C', text: '只读预览选项 C' },
          ],
          response: null,
          respondedAt: null,
          correct: null,
          feedback: null,
          debrief: null,
          misconception: null,
          credit: 'none',
        },
        hint: null,
        scaffold: null,
        transfer: null,
      },
    };
    const retry = deferred<LessonExecutionProjection>();
    const authoritativeRecovery = structuredClone(recovery);
    authoritativeRecovery.session.version = 4;
    authoritativeRecovery.agenda!.version = 5;
    const get = vi
      .spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(recovery)
      .mockResolvedValueOnce(authoritativeRecovery);
    const prepare = vi.spyOn(api, 'prepareLessonExecution').mockReturnValue(retry.promise);
    const command = vi.spyOn(api, 'lessonExecutionCommand');

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );

    expect(
      await screen.findByRole('heading', { name: '讲解已安全保存，练习还需要重试' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
    expect(screen.getByText('条件概率把观察范围收窄到已知条件。')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '请用自己的话说说它描述了什么。' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始本节讲解' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('练习回应')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '只读预览选项 A' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '重新准备非正式练习' }));
    expect(await screen.findByText('正在根据已接受的讲解准备非正式练习…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '理解条件概率' })).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledWith(
      'ws_1',
      'session_1',
      expect.objectContaining({
        expectedSessionVersion: 4,
        expectedAgendaVersion: 5,
        expectedAgendaItemId: 'item_1',
      }),
      expect.any(AbortSignal),
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();

    await act(async () => retry.resolve(prepared));
    expect(await screen.findByRole('button', { name: '开始本节讲解' })).toBeInTheDocument();
  });

  it('adopts an authoritative ready result instead of starting duplicate retry work', async () => {
    const user = userEvent.setup();
    const get = vi
      .spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(practiceRetryLesson())
      .mockResolvedValueOnce(prepared);
    const prepare = vi.spyOn(api, 'prepareLessonExecution');

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await user.click(await screen.findByRole('button', { name: '重新准备非正式练习' }));

    expect(await screen.findByRole('button', { name: '开始本节讲解' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('drops a stale Lesson refresh after the Agenda item identity changes', async () => {
    const firstRefresh = deferred<LessonExecutionProjection>();
    let firstSignal: AbortSignal | undefined;
    const successor = lessonTitled('后继讲解');
    vi.spyOn(api, 'getLessonExecution')
      .mockImplementationOnce((_workspaceId, _sessionId, signal) => {
        firstSignal = signal;
        return firstRefresh.promise;
      })
      .mockResolvedValueOnce(successor);

    const rendered = render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await waitFor(() => expect(firstSignal).toBeDefined());

    rendered.rerender(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_2"
        active
      />,
    );
    expect(await screen.findByRole('heading', { name: '后继讲解' })).toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => firstRefresh.resolve(lessonTitled('过期讲解')));
    expect(screen.getByRole('heading', { name: '后继讲解' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '过期讲解' })).not.toBeInTheDocument();
  });

  it('aborts a pending Practice retry and ignores its late response after an Agenda switch', async () => {
    const user = userEvent.setup();
    const retry = deferred<LessonExecutionProjection>();
    let retrySignal: AbortSignal | undefined;
    const successor = lessonTitled('新的安排');
    vi.spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(practiceRetryLesson())
      .mockResolvedValueOnce(practiceRetryLesson())
      .mockResolvedValueOnce(successor);
    vi.spyOn(api, 'prepareLessonExecution').mockImplementation(
      (_workspaceId, _sessionId, _input, signal) => {
        retrySignal = signal;
        return retry.promise;
      },
    );

    const rendered = render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await user.click(await screen.findByRole('button', { name: '重新准备非正式练习' }));
    await waitFor(() => expect(retrySignal).toBeDefined());

    rendered.rerender(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_2"
        active
      />,
    );
    expect(await screen.findByRole('heading', { name: '新的安排' })).toBeInTheDocument();
    expect(retrySignal?.aborted).toBe(true);

    await act(async () => retry.resolve(lessonTitled('过期的练习结果')));
    expect(screen.getByRole('heading', { name: '新的安排' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '过期的练习结果' })).not.toBeInTheDocument();
    expect(screen.queryByText('正在重新准备非正式练习')).not.toBeInTheDocument();
  });

  it('aborts a learner command and clears command loading after an Agenda switch', async () => {
    const user = userEvent.setup();
    const commandResult = deferred<LessonExecutionProjection>();
    let commandSignal: AbortSignal | undefined;
    const inProgress = readyLesson({
      stateVersion: 4,
      currentSegmentIndex: 0,
      segmentCount: 2,
      presentedSegmentIndexes: [0],
      presentationStatus: 'in_progress',
      presentationCompletedAt: null,
    });
    inProgress.lesson!.segments[0]!.informalCheck = null;
    inProgress.allowedActions = ['move_to_next_segment'];
    const successor = lessonTitled('命令后的新安排');
    vi.spyOn(api, 'getLessonExecution')
      .mockResolvedValueOnce(inProgress)
      .mockResolvedValueOnce(successor);
    vi.spyOn(api, 'lessonExecutionCommand').mockImplementation(
      (_workspaceId, _sessionId, _input, signal) => {
        commandSignal = signal;
        return commandResult.promise;
      },
    );

    const rendered = render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    await user.click(await screen.findByRole('button', { name: '继续讲解' }));
    await waitFor(() => expect(commandSignal).toBeDefined());

    rendered.rerender(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_2"
        active
      />,
    );
    expect(await screen.findByRole('heading', { name: '命令后的新安排' })).toBeInTheDocument();
    expect(commandSignal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: '开始本节讲解' })).toBeEnabled();

    await act(async () => commandResult.resolve(lessonTitled('过期命令结果')));
    expect(screen.getByRole('heading', { name: '命令后的新安排' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '过期命令结果' })).not.toBeInTheDocument();
  });

  it('renders a worked interaction as targeted feedback, bounded scaffold, and faded transfer', async () => {
    const user = userEvent.setup();
    const initial = readyLesson({
      stateVersion: 4,
      currentSegmentIndex: 1,
      segmentCount: 2,
      presentedSegmentIndexes: [0, 1],
      presentationStatus: 'in_progress',
      presentationCompletedAt: null,
    });
    initial.allowedActions = ['respond_to_worked_interaction', 'revisit_segment'];
    initial.lesson!.segments[1]!.workedProcess = {
      startingState: '三个候选等待处理。',
      inputs: ['当前条件', '三个候选状态'],
      ruleOrProcedure: '先检查条件，再执行被允许的动作。',
      steps: [
        {
          action: '教师先检查三个候选。',
          reason: '条件决定候选资格。',
          resultingState: '候选已分为符合与不符合两类。',
        },
      ],
      learnerDecision: '判断下一步。',
      result: null,
      whyResultFollows: null,
      origin: 'source_grounded',
      sources: [source],
      interaction: {
        stage: 'guided',
        modelledStepCount: 1,
        origin: 'hy3_synthesis',
        sources: [],
        activity: {
          prompt: '检查条件以后，下一步应该怎样做？',
          options: [
            { id: 'A', text: '执行条件允许的动作' },
            { id: 'B', text: '选择最熟悉的动作' },
            { id: 'C', text: '直接跳到最终答案' },
          ],
          response: null,
          respondedAt: null,
          correct: null,
          feedback: null,
          debrief: null,
          misconception: null,
          credit: 'none',
        },
        hint: null,
        scaffold: null,
        transfer: null,
      },
    };
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(initial);

    const wrong = structuredClone(initial);
    wrong.progress!.stateVersion = 5;
    const wrongProcess = wrong.lesson!.segments[1]!.workedProcess!;
    wrongProcess.interaction = {
      ...wrongProcess.interaction!,
      stage: 'scaffold',
      activity: {
        ...wrongProcess.interaction!.activity,
        response: 'B',
        respondedAt: '2026-08-19T01:01:00.000Z',
        correct: false,
        feedback: '熟悉并不能证明动作适用于当前条件。',
        misconception: {
          hypothesis: '熟悉的动作总是适用。',
          whyTempting: '它刚刚出现在典型案例中。',
          correction: '先检查当前条件允许哪些动作。',
        },
      },
      hint: '先找出真正限制下一步的条件。',
      scaffold: {
        prompt: '哪项信息决定动作能否执行？',
        options: [
          { id: 'A', text: '当前条件' },
          { id: 'B', text: '动作名称' },
        ],
        response: null,
        respondedAt: null,
        correct: null,
        feedback: null,
        debrief: null,
        credit: 'none',
      },
    };
    const transfer = structuredClone(wrong);
    transfer.progress!.stateVersion = 6;
    const transferProcess = transfer.lesson!.segments[1]!.workedProcess!;
    transferProcess.steps.push({
      action: '执行条件允许的动作。',
      reason: '该动作有当前条件作为依据。',
      resultingState: '留下一个符合条件的结果。',
    });
    transferProcess.result = '得到符合条件的结果。';
    transferProcess.interaction = {
      ...transferProcess.interaction!,
      stage: 'transfer',
      activity: {
        ...transferProcess.interaction!.activity,
        debrief: '条件先限定动作范围，因此这一步有依据。',
      },
      scaffold: {
        ...transferProcess.interaction!.scaffold!,
        response: 'A',
        respondedAt: '2026-08-19T01:02:00.000Z',
        correct: true,
        feedback: '对，当前条件决定允许范围。',
        debrief: '条件决定范围，名称不能替代适用性。',
      },
      transfer: {
        changedCondition: '原先允许该动作的条件被移除了。',
        prompt: '现在应该怎样处理？',
        options: [
          { id: 'A', text: '照旧执行' },
          { id: 'B', text: '重新判断并调整动作' },
          { id: 'C', text: '忽略规则' },
        ],
        response: null,
        respondedAt: null,
        correct: null,
        feedback: null,
        debrief: null,
        credit: 'none',
      },
    };
    const completed = structuredClone(transfer);
    completed.progress!.stateVersion = 7;
    completed.allowedActions = ['complete_presentation', 'revisit_segment'];
    completed.lesson!.segments[1]!.workedProcess!.whyResultFollows =
      '一般模型是：条件变化必须传导到动作与结果。';
    completed.lesson!.segments[1]!.workedProcess!.interaction = {
      ...completed.lesson!.segments[1]!.workedProcess!.interaction!,
      stage: 'completed',
      transfer: {
        ...completed.lesson!.segments[1]!.workedProcess!.interaction!.transfer!,
        response: 'B',
        respondedAt: '2026-08-19T01:03:00.000Z',
        correct: true,
        feedback: '正确，条件变化后要重新限定动作。',
        debrief: '支持减少后仍使用同一心智模型，而不是照搬旧答案。',
      },
    };
    const command = vi
      .spyOn(api, 'lessonExecutionCommand')
      .mockResolvedValueOnce(wrong)
      .mockResolvedValueOnce(transfer)
      .mockResolvedValueOnce(completed);

    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
      />,
    );
    expect(await screen.findByText('教师先检查三个候选。')).toBeInTheDocument();
    expect(screen.queryByText('执行条件允许的动作。')).not.toBeInTheDocument();
    expect(screen.queryByText('得到符合条件的结果。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择最熟悉的动作' }));
    expect(await screen.findByText('这个想法为什么容易出现')).toBeInTheDocument();
    expect(screen.getByText('先找出真正限制下一步的条件。')).toBeInTheDocument();
    expect(screen.getByText('哪项信息决定动作能否执行？')).toBeInTheDocument();
    expect(screen.queryByText('现在应该怎样处理？')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '当前条件' }));
    expect(await screen.findByText('执行条件允许的动作。')).toBeInTheDocument();
    expect(screen.getByText('得到符合条件的结果。')).toBeInTheDocument();
    expect(screen.getByText('原先允许该动作的条件被移除了。')).toBeInTheDocument();
    expect(screen.getByText('现在应该怎样处理？')).toBeInTheDocument();
    expect(
      screen.queryByText('一般模型是：条件变化必须传导到动作与结果。'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新判断并调整动作' }));
    expect(
      await screen.findByText('一般模型是：条件变化必须传导到动作与结果。'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('支持减少后仍使用同一心智模型，而不是照搬旧答案。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('worked_interaction')).not.toBeInTheDocument();
    expect(command.mock.calls.map((call) => call[2].action)).toEqual([
      {
        kind: 'respond_to_worked_interaction',
        segmentIndex: 1,
        phase: 'guided',
        response: 'B',
      },
      {
        kind: 'respond_to_worked_interaction',
        segmentIndex: 1,
        phase: 'scaffold',
        response: 'A',
      },
      {
        kind: 'respond_to_worked_interaction',
        segmentIndex: 1,
        phase: 'transfer',
        response: 'B',
      },
    ]);
  });

  it('offers the existing formal handoff only after Lesson and informal Practice completion', async () => {
    const user = userEvent.setup();
    const completed = readyLesson({
      stateVersion: 5,
      currentSegmentIndex: 1,
      segmentCount: 2,
      presentedSegmentIndexes: [0, 1],
      presentationStatus: 'presentation_completed',
      presentationCompletedAt: '2026-08-19T01:00:00.000Z',
    });
    completed.practice = {
      status: 'completed',
      currentItemIndex: 0,
      itemCount: 1,
      item: null,
      attempts: [
        {
          itemIndex: 0,
          attemptNumber: 1,
          surface: 'initial',
          selectedOptionId: 'practice_A',
          correct: true,
          feedback: '你根据条件解释了结果。',
          hint: null,
          respondedAt: '2026-08-19T01:02:00.000Z',
          credit: 'none',
        },
      ],
      completedAt: '2026-08-19T01:02:00.000Z',
      credit: 'none',
    };
    completed.allowedActions = ['review_lesson'];
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(completed);
    const handoff = vi.fn();
    const refreshRoute = vi.fn();
    const lessonCommand = vi.spyOn(api, 'lessonExecutionCommand');
    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
        directCheckpointItemId="checkpoint_1"
        onStartFormalAssessment={handoff}
        onRefreshSession={refreshRoute}
      />,
    );
    expect(await screen.findByRole('heading', { name: '本节学习已完成' })).toBeInTheDocument();
    expect(screen.getByText(/掌握程度仍需独立的正式证据检验/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续课程' }));
    expect(refreshRoute).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
    expect(lessonCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '开始正式检验' }));
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});
