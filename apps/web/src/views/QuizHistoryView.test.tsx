import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletedAttemptDetail, CompletedAttemptSummary } from '@hy3-clinic/shared';
import { QuizHistoryView } from './QuizHistoryView';
import { installFetchMock, type MockRoute } from '../test/mockFetch';
import { blocks, fullQuestions, grading, material, quiz, stateChanges, T0 } from '../test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const attemptSummary: CompletedAttemptSummary = {
  id: 'grd_1',
  quizId: 'qz_1',
  workspaceId: 'ws_1',
  kind: 'standard',
  materialId: 'mat_1',
  materialTitle: material.material.title,
  questionCount: 2,
  totalAwarded: 1.8,
  totalPossible: 3,
  overallScore: 0.6,
  provider: 'fake',
  completedAt: T0,
};

const attemptDetail: CompletedAttemptDetail = {
  summary: attemptSummary,
  quiz,
  questions: fullQuestions,
  answers: [
    { questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['A'] },
    { questionId: 'que_2', type: 'short_answer', text: '容量有限,大概几个组块。' },
  ],
  grading,
  stateChanges,
  blocks,
};

function historyRoutes(
  attempts: CompletedAttemptSummary[],
  detail?: CompletedAttemptDetail | { status: number; message: string },
): MockRoute[] {
  return [
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/attempts$/,
      handler: () => ({ body: { attempts } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/attempts\/[^/]+$/,
      handler: () => {
        if (detail && 'status' in detail) {
          return {
            status: detail.status,
            body: { error: { code: 'INTERNAL', message: detail.message } },
          };
        }
        return { body: detail ?? attemptDetail };
      },
    },
  ];
}

describe('QuizHistoryView — 列表', () => {
  it('shows the empty state when no quiz has been completed yet', async () => {
    const { calls } = installFetchMock(historyRoutes([]));
    render(<QuizHistoryView workspaceId="ws_1" />);

    expect(
      await screen.findByText(/还没有已完成的测验。提交一次判分后,这里会保留可回看的历史结果。/),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/workspaces/ws_1/attempts' });
  });

  it('lists completed attempts with identifying metadata and no raw ids', async () => {
    installFetchMock(historyRoutes([attemptSummary]));
    render(<QuizHistoryView workspaceId="ws_1" />);

    expect(await screen.findByText(`文档测验 · ${material.material.title}`)).toBeInTheDocument();
    expect(screen.getByText(/共 2 题/)).toBeInTheDocument();
    expect(screen.getByText(/得分 60 分/)).toBeInTheDocument();
    expect(screen.getByText(/1\.8\/\s*3/)).toBeInTheDocument();
    expect(screen.getByText('离线判分(Fake)')).toBeInTheDocument();
    expect(screen.getByText(/完成于/)).toBeInTheDocument();
    // Internal record ids stay internal.
    expect(screen.queryByText(/grd_1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/qz_1/)).not.toBeInTheDocument();
  });

  it('surfaces list-loading errors honestly', async () => {
    installFetchMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/attempts$/,
        handler: () => ({
          status: 500,
          body: { error: { code: 'INTERNAL', message: '数据库暂时不可用' } },
        }),
      },
    ]);
    render(<QuizHistoryView workspaceId="ws_1" />);
    expect(await screen.findByText(/无法加载测验历史:数据库暂时不可用/)).toBeInTheDocument();
  });
});

describe('QuizHistoryView — 只读详情', () => {
  async function openDetail(
    detail: CompletedAttemptDetail = attemptDetail,
    summary: CompletedAttemptSummary = attemptSummary,
  ) {
    const mock = installFetchMock(historyRoutes([summary], detail));
    render(<QuizHistoryView workspaceId="ws_1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /查看历史结果:/ }));
    await screen.findByText('历史结果(只读)');
    return { user, calls: mock.calls };
  }

  it('renders the persisted result faithfully and read-only', async () => {
    const { calls } = await openDetail();

    // Original questions, learner answers, reference answers.
    expect(screen.getByText(fullQuestions[0]!.stem)).toBeInTheDocument();
    expect(screen.getByText('你的回答')).toBeInTheDocument();
    expect(screen.getByText('容量有限,大概几个组块。')).toBeInTheDocument();
    expect(screen.getByText('参考答案')).toBeInTheDocument();
    expect(screen.getByText(fullQuestions[1]!.expectedAnswer!)).toBeInTheDocument();

    // Grading labels, feedback, confidence, rubric points, state changes.
    expect(screen.getByText('确定性判分')).toBeInTheDocument();
    expect(screen.getByText('模型评分')).toBeInTheDocument();
    expect(screen.getByText(/已覆盖部分要点,仍需补充:约四个组块。/)).toBeInTheDocument();
    expect(screen.getByText('置信度 72%')).toBeInTheDocument();
    expect(screen.getByText(/要点 1:/)).toBeInTheDocument();
    expect(screen.getByLabelText('本次判分引起的状态变化')).toBeInTheDocument();

    // Verified evidence renders with live source context.
    expect(screen.getAllByText(/原文依据/).length).toBeGreaterThan(0);

    // Read-only: no answering controls, no submission, no remediation launch.
    expect(screen.queryByRole('button', { name: '提交并判分' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /针对错题生成康复练习/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // Opening history is pure reading: every request was a GET.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[1]!.url).toBe('/api/workspaces/ws_1/attempts/grd_1');
  });

  it('returns to the list without re-fetching grading', async () => {
    const { user, calls } = await openDetail();
    await user.click(screen.getByRole('button', { name: '返回历史列表' }));
    expect(await screen.findByText('测验历史')).toBeInTheDocument();
    expect(screen.queryByText('历史结果(只读)')).not.toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('renders honest fallbacks for legacy attempts without snapshot fields', async () => {
    await openDetail(
      { ...attemptDetail, stateChanges: null, summary: { ...attemptSummary, provider: null } },
      { ...attemptSummary, provider: null },
    );

    expect(screen.getAllByText('判分模式未记录').length).toBeGreaterThan(0);
    expect(screen.getByText(/该记录完成于历史版本,未保存「学习状态变化」明细/)).toBeInTheDocument();
    expect(screen.queryByLabelText('本次判分引起的状态变化')).not.toBeInTheDocument();
  });

  it('labels unavailable sources instead of pretending blocks still exist', async () => {
    await openDetail({ ...attemptDetail, blocks: [] });

    expect(screen.getByText(/部分原文源块已不可用/)).toBeInTheDocument();
    // The persisted quotes are still shown (quote-only evidence fallback).
    expect(screen.getAllByText(/未加载所在源块,仅显示引文/).length).toBeGreaterThan(0);
  });

  it('surfaces detail-loading errors and keeps the list usable', async () => {
    installFetchMock(historyRoutes([attemptSummary], { status: 500, message: '记录读取失败' }));
    render(<QuizHistoryView workspaceId="ws_1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /查看历史结果:/ }));

    expect(await screen.findByText(/无法打开历史结果:记录读取失败/)).toBeInTheDocument();
    const row = screen.getByText(`文档测验 · ${material.material.title}`).closest('div');
    expect(row).not.toBeNull();
    expect(
      within(row!.parentElement!).getByRole('button', { name: /查看历史结果:/ }),
    ).toBeEnabled();
  });
});

describe('QuizHistoryView — 评估与上下文', () => {
  it('labels workspace assessments by their mode', async () => {
    installFetchMock(
      historyRoutes([
        {
          ...attemptSummary,
          id: 'grd_2',
          kind: 'adaptive',
          assessmentMode: 'diagnostic',
          materialId: null,
          materialTitle: null,
          provider: 'hy3',
        },
      ]),
    );
    render(<QuizHistoryView workspaceId="ws_1" />);

    expect(await screen.findByText('课程空间评估 · 诊断评估')).toBeInTheDocument();
    expect(screen.getByText('Hy3 在线判分')).toBeInTheDocument();
  });

  it('renders the empty state without fetching when no workspace context exists', async () => {
    const { calls } = installFetchMock([]);
    render(<QuizHistoryView workspaceId={null} />);
    await waitFor(() => expect(screen.getByText(/还没有已完成的测验/)).toBeInTheDocument());
    expect(calls).toHaveLength(0);
  });
});
