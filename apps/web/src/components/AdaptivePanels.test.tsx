import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TutorRun } from '@hy3-clinic/shared';
import { AlignmentPanel } from './AlignmentPanel';
import { DailyQueue } from './DailyQueue';
import { TutorPanel } from './TutorPanel';
import { installFetchMock } from '../test/mockFetch';
import {
  alignmentProposal,
  blocks,
  canonicalViews,
  documentSummary,
  graphConcepts,
  queueItems,
  tutorEvents,
  tutorRun,
} from '../test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AlignmentPanel', () => {
  function renderPanel(overrides: { onChanged?: () => void } = {}) {
    return render(
      <AlignmentPanel
        workspaceId="ws_1"
        concepts={graphConcepts}
        blocks={blocks}
        documents={[documentSummary]}
        onClose={() => {}}
        onChanged={overrides.onChanged ?? (() => {})}
      />,
    );
  }

  it('shows pending proposals with names, languages, rationale and evidence', async () => {
    installFetchMock([
      {
        method: 'GET',
        pattern: /\/alignment$/,
        handler: () => ({
          body: {
            canonical: canonicalViews,
            pendingProposals: [alignmentProposal],
            decidedProposals: [],
          },
        }),
      },
    ]);
    renderPanel();
    expect(await screen.findByText('同一概念')).toBeInTheDocument();
    expect(screen.getByText(/两个概念是同一事物的中英文表述/)).toBeInTheDocument();
    expect(screen.getByText(/「工作记忆的容量十分有限」/)).toBeInTheDocument();
    expect(screen.getByLabelText('合并后的规范名称')).toHaveValue('工作记忆');
    expect(screen.getByRole('button', { name: '接受' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保持独立' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('accepts a proposal with a repaired canonical name and notifies the parent', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = installFetchMock([
      {
        method: 'GET',
        pattern: /\/alignment$/,
        handler: () => ({
          body: {
            canonical: canonicalViews,
            pendingProposals: [alignmentProposal],
            decidedProposals: [],
          },
        }),
      },
      {
        method: 'POST',
        pattern: /\/alignment\/proposals\/alp_1\/accept$/,
        handler: () => ({
          body: { canonical: canonicalViews, pendingProposals: [], decidedProposals: [] },
        }),
      },
    ]);
    renderPanel({ onChanged });
    const nameInput = await screen.findByLabelText('合并后的规范名称');
    await user.clear(nameInput);
    await user.type(nameInput, '工作记忆(修复)');
    await user.click(screen.getByRole('button', { name: '接受' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const accept = calls.find((c) => c.url.includes('/accept'));
    expect(accept?.body).toEqual({ canonicalName: '工作记忆(修复)' });
    expect(await screen.findByText(/没有待审核的对齐提议/)).toBeInTheDocument();
  });

  it('keep-separate decides without touching the graph', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = installFetchMock([
      {
        method: 'GET',
        pattern: /\/alignment$/,
        handler: () => ({
          body: {
            canonical: canonicalViews,
            pendingProposals: [alignmentProposal],
            decidedProposals: [],
          },
        }),
      },
      {
        method: 'POST',
        pattern: /\/alignment\/proposals\/alp_1\/keep-separate$/,
        handler: () => ({
          body: { canonical: canonicalViews, pendingProposals: [], decidedProposals: [] },
        }),
      },
    ]);
    renderPanel({ onChanged });
    await user.click(await screen.findByRole('button', { name: '保持独立' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/keep-separate'))).toBe(true));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('DailyQueue', () => {
  interface QueueOverrides {
    items?: typeof queueItems | [];
    launchBusy?: boolean;
    startingConceptId?: string | null;
    diagnosticStarting?: boolean;
    canDiagnose?: boolean;
    onStartItem?: ReturnType<typeof vi.fn>;
    onStartDiagnostic?: ReturnType<typeof vi.fn>;
  }

  function queueProps(overrides: QueueOverrides = {}) {
    return {
      items: overrides.items ?? queueItems,
      loading: false,
      error: null,
      launchBusy: overrides.launchBusy ?? false,
      startingConceptId: overrides.startingConceptId ?? null,
      diagnosticStarting: overrides.diagnosticStarting ?? false,
      canDiagnose: overrides.canDiagnose ?? true,
      onStartItem: overrides.onStartItem ?? vi.fn(),
      onStartDiagnostic: overrides.onStartDiagnostic ?? vi.fn(),
    };
  }

  it('renders deterministic queue items with kinds, reasons and start actions', () => {
    render(<DailyQueue {...queueProps()} />);
    expect(screen.getByText('到期复习')).toBeInTheDocument();
    expect(screen.getByText('误区修复')).toBeInTheDocument();
    expect(screen.getByText(/复习已过期 2 天/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: '开始' });
    expect(buttons).toHaveLength(2);
  });

  it('starts the clicked item and shows the empty state when done for today', async () => {
    const user = userEvent.setup();
    const onStartItem = vi.fn();
    const { rerender } = render(<DailyQueue {...queueProps({ onStartItem })} />);
    await user.click(screen.getAllByRole('button', { name: '开始' })[1]!);
    expect(onStartItem).toHaveBeenCalledWith(queueItems[1]);

    rerender(<DailyQueue {...queueProps({ items: [], onStartItem })} />);
    expect(screen.getByText(/今天暂无待办/)).toBeInTheDocument();
    expect(screen.getByText(/完成一次练习、诊断评估或辅导活动后/)).toBeInTheDocument();
  });

  it('disables every start button and shows 启动中 while a launch is pending', () => {
    render(<DailyQueue {...queueProps({ launchBusy: true, startingConceptId: 'con_1' })} />);
    const starting = screen.getByRole('button', { name: '启动中…' });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute('aria-busy', 'true');
    for (const button of screen.getAllByRole('button', { name: '开始' })) {
      expect(button).toBeDisabled();
    }
  });

  it('offers the real diagnostic assessment from the empty state', async () => {
    const user = userEvent.setup();
    const onStartDiagnostic = vi.fn();
    render(<DailyQueue {...queueProps({ items: [], onStartDiagnostic })} />);
    await user.click(screen.getByRole('button', { name: '开始诊断评估' }));
    expect(onStartDiagnostic).toHaveBeenCalledTimes(1);
    expect(screen.getByText('任务从哪里来?')).toBeInTheDocument();
  });

  it('shows a loading diagnostic button that cannot be double-clicked', () => {
    render(
      <DailyQueue {...queueProps({ items: [], launchBusy: true, diagnosticStarting: true })} />,
    );
    const button = screen.getByRole('button', { name: '正在生成诊断评估…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('hides the diagnostic action when the workspace has no concepts yet', () => {
    render(<DailyQueue {...queueProps({ items: [], canDiagnose: false })} />);
    expect(screen.queryByRole('button', { name: /诊断评估/ })).not.toBeInTheDocument();
    expect(screen.getByText(/先在下方添加文档并提取概念/)).toBeInTheDocument();
  });
});

describe('TutorPanel', () => {
  function ndjsonResponse(lines: unknown[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream } as unknown as Response;
  }

  function renderPanel(handlers: {
    activityLaunching?: boolean;
    onPathChange?: (ids: ReadonlySet<string>) => void;
    onStartActivity?: (run: TutorRun) => void;
    onPlanAccepted?: () => void;
  }) {
    return render(
      <TutorPanel
        workspaceId="ws_1"
        conceptId="con_0"
        conceptName="工作记忆"
        activityLaunching={handlers.activityLaunching ?? false}
        onPathChange={handlers.onPathChange ?? (() => {})}
        onStartActivity={handlers.onStartActivity ?? (() => {})}
        onPlanAccepted={handlers.onPlanAccepted ?? (() => {})}
      />,
    );
  }

  it('streams the timeline, highlights the plan path, and offers the activity', async () => {
    const user = userEvent.setup();
    const onPathChange = vi.fn();
    const onStartActivity = vi.fn();
    const lines = [
      ...tutorEvents.map((event) => ({ kind: 'event', event })),
      { kind: 'run', run: tutorRun },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse(lines)),
    );
    renderPanel({ onPathChange, onStartActivity });
    await user.click(screen.getByRole('button', { name: /启动辅导/ }));

    expect(await screen.findByText(/辅导会话完成/)).toBeInTheDocument();
    expect(screen.getByText(/已检查「工作记忆」的学习状态/)).toBeInTheDocument();
    expect(screen.getByText('inspect_learning_state')).toBeInTheDocument();
    expect(screen.getByText(/3 轮规划 · 2 次工具调用/)).toBeInTheDocument();
    expect(onPathChange).toHaveBeenLastCalledWith(new Set(['con_0']));

    await user.click(screen.getByRole('button', { name: /开始推荐活动/ }));
    // The panel hands the full run to the parent — the launch itself is
    // server-owned (POST …/tutor/runs/:runId/activity), so the client never
    // assembles mode-specific parameters from the activity.
    expect(onStartActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: tutorRun.id, activity: tutorRun.activity }),
    );
  });

  it('supports cancelling a running session', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /启动辅导/ }));
    expect(await screen.findByText(/正在有界规划中/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByText(/正在有界规划中/)).not.toBeInTheDocument());
    // Cancellation is quiet: no error banner.
    expect(screen.queryByText(/失败/)).not.toBeInTheDocument();
  });

  it('drops late stream lines after the concept selection changed', async () => {
    const user = userEvent.setup();
    // Holder object: TS control flow cannot track assignments made inside
    // the stream callback, so the release hook lives on a stable object.
    const streamControl = { release: () => {} };
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamControl.release = () => {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ kind: 'event', event: tutorEvents[0] })}\n`),
              );
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ kind: 'run', run: tutorRun })}\n`),
              );
              controller.close();
            };
          },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
      }),
    );
    const { rerender } = renderPanel({});
    await user.click(screen.getByRole('button', { name: /启动辅导/ }));

    // Concept switch invalidates the session view before any line arrives.
    rerender(
      <TutorPanel
        workspaceId="ws_1"
        conceptId="con_1"
        conceptName="间隔重复"
        activityLaunching={false}
        onPathChange={() => {}}
        onStartActivity={() => {}}
        onPlanAccepted={() => {}}
      />,
    );
    streamControl.release();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /启动辅导/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/辅导会话完成/)).not.toBeInTheDocument();
    expect(screen.queryByText(/会话状态/)).not.toBeInTheDocument();
  });

  it('surfaces stream errors as a banner', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse([{ kind: 'error', message: '辅导会话失败:测试错误。' }])),
    );
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /启动辅导/ }));
    expect(await screen.findByText(/辅导会话失败:测试错误/)).toBeInTheDocument();
  });

  it('shows an immediate, non-clickable loading state while the activity launches', async () => {
    const user = userEvent.setup();
    const lines = [
      ...tutorEvents.map((event) => ({ kind: 'event', event })),
      { kind: 'run', run: tutorRun },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse(lines)),
    );
    const { rerender } = renderPanel({});
    await user.click(screen.getByRole('button', { name: /启动辅导/ }));
    await screen.findByText(/辅导会话完成/);
    expect(
      screen.getByRole('button', { name: /开始推荐活动:前置修复练习|开始推荐活动/ }),
    ).toBeEnabled();

    // Parent enters the pending launch state → the button flips to a stable
    // loading label, is disabled and marked busy; restart is blocked too.
    rerender(
      <TutorPanel
        workspaceId="ws_1"
        conceptId="con_0"
        conceptName="工作记忆"
        activityLaunching={true}
        onPathChange={() => {}}
        onStartActivity={() => {}}
        onPlanAccepted={() => {}}
      />,
    );
    const launching = screen.getByRole('button', { name: '正在创建练习…' });
    expect(launching).toBeDisabled();
    expect(launching).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '重新启动辅导' })).toBeDisabled();

    // Failure/completion returns the button to its idle label.
    rerender(
      <TutorPanel
        workspaceId="ws_1"
        conceptId="con_0"
        conceptName="工作记忆"
        activityLaunching={false}
        onPathChange={() => {}}
        onStartActivity={() => {}}
        onPlanAccepted={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /开始推荐活动/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重新启动辅导' })).toBeEnabled();
  });
});
