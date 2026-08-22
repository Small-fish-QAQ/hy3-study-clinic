import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LessonExecutionProjection } from '@hy3-clinic/shared';
import { api } from '../api.js';
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

afterEach(() => vi.restoreAllMocks());

describe('LessonExecutionPanel', () => {
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
    expect((await screen.findAllByText('Hy3 讲解补充')).length).toBeGreaterThan(0);
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

  it('keeps presentation completion separate and offers the existing formal handoff only after completion', async () => {
    const user = userEvent.setup();
    const completed = readyLesson({
      stateVersion: 5,
      currentSegmentIndex: 1,
      segmentCount: 2,
      presentedSegmentIndexes: [0, 1],
      presentationStatus: 'presentation_completed',
      presentationCompletedAt: '2026-08-19T01:00:00.000Z',
    });
    completed.allowedActions = ['review_lesson'];
    vi.spyOn(api, 'getLessonExecution').mockResolvedValue(completed);
    const handoff = vi.fn();
    render(
      <LessonExecutionPanel
        workspaceId="ws_1"
        sessionId="session_1"
        agendaItemId="item_1"
        active
        directCheckpointItemId="checkpoint_1"
        onStartFormalAssessment={handoff}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: '接下来可以进行正式检验' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/不代表已经掌握/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始正式检验' }));
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});
