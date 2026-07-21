import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphWorkspaceView } from './GraphWorkspaceView';
import { adaptiveDataRoutes, installFetchMock, type MockRoute } from '../test/mockFetch';
import {
  documentSummary,
  graphConcepts,
  graphEdges,
  graphVersion,
  material,
  overlayStates,
  remediationPlan,
  quiz,
  workspace,
  workspaceSummary,
} from '../test/fixtures';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LAST_WORKSPACE_KEY = 'hy3-clinic:last-workspace-id';

/**
 * Install a fetch mock with the view's routes plus empty adaptive-data
 * defaults (alignment/misconceptions/review/queue) for every workspace id
 * the suite uses. Test-specific routes come first, so they always win.
 */
function installViewMock(routes: MockRoute[]): ReturnType<typeof installFetchMock> {
  return installFetchMock([
    ...routes,
    ...adaptiveDataRoutes('ws_1'),
    ...adaptiveDataRoutes('ws_new'),
    ...adaptiveDataRoutes('ws_2'),
  ]);
}

function baseRoutes(): MockRoute[] {
  return [
    {
      method: 'GET',
      pattern: /\/api\/workspaces$/,
      handler: () => ({ body: { workspaces: [workspaceSummary] } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1$/,
      handler: () => ({ body: { workspace, documents: [documentSummary] } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/graph$/,
      handler: () => ({
        body: { version: graphVersion, edges: graphEdges, concepts: graphConcepts },
      }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/graph\/versions$/,
      handler: () => ({ body: { versions: [graphVersion] } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/overlay$/,
      handler: () => ({ body: { states: overlayStates } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/materials\/mat_1$/,
      handler: () => ({ body: material }),
    },
    {
      method: 'GET',
      pattern: /\/api\/workspaces\/ws_1\/concepts\/[^/]+\/plan$/,
      handler: () => ({ body: { plan: null } }),
    },
  ];
}

function renderView(props: Partial<Parameters<typeof GraphWorkspaceView>[0]> = {}) {
  return render(
    <GraphWorkspaceView refreshKey={0} onLaunchQuiz={props.onLaunchQuiz ?? (() => {})} />,
  );
}

function openSavedWorkspace() {
  window.localStorage.setItem(LAST_WORKSPACE_KEY, 'ws_1');
}

describe('学习图谱工作台 — workspace and document area', () => {
  it('shows the empty state when no workspaces exist', async () => {
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [] } }),
      },
    ]);
    renderView();
    expect(await screen.findByText(/还没有课程空间/)).toBeInTheDocument();
    expect(screen.getByText(/选择或创建一个课程空间/)).toBeInTheDocument();
    expect(screen.getByLabelText('新建课程空间')).toBeInTheDocument();
  });

  it('creates a workspace and opens it', async () => {
    const user = userEvent.setup();
    const created = { ...workspace, id: 'ws_new', name: '新课程', activeGraphVersionId: null };
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [] } }),
      },
      {
        method: 'POST',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ status: 201, body: { workspace: created } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_new$/,
        handler: () => ({ body: { workspace: created, documents: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_new\/graph$/,
        handler: () => ({ body: { version: null, edges: [], concepts: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_new\/graph\/versions$/,
        handler: () => ({ body: { versions: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_new\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
    ]);
    renderView();
    await user.type(await screen.findByLabelText('新建课程空间'), '新课程');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByLabelText('学习图谱引导')).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws_new');
  });

  it('lists documents with type, parse state, and warnings', async () => {
    openSavedWorkspace();
    const warned = {
      ...documentSummary,
      sourceType: 'pdf' as const,
      pageCount: 5,
      parseStatus: 'parsed_with_warnings' as const,
      extractionWarnings: ['第 3 页未提取到文本(可能是扫描图片页;未启用 OCR)。'],
    };
    installViewMock([
      ...baseRoutes().filter((r) => !r.pattern.test('/api/workspaces/ws_1')),
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace, documents: [warned] } }),
      },
    ]);
    renderView();
    expect(await screen.findByText(/PDF · 5 页/)).toBeInTheDocument();
    expect(screen.getByText(/解析有警告/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText(/1 条提取警告/));
    expect(screen.getByText(/第 3 页未提取到文本/)).toBeInTheDocument();
  });

  it('re-clicking the already-active workspace keeps the loaded graph intact', async () => {
    openSavedWorkspace();
    installViewMock(baseRoutes());
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId('concept-graph');
    // Regression: this used to clear `data` without re-triggering the load
    // effect, leaving the graph area permanently blank.
    await user.click(screen.getByRole('button', { name: /认知科学课程/ }));
    expect(screen.getByTestId('concept-graph')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0);
    });
  });

  it('adds a pasted-text document and reloads the workspace', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    const addDocument = vi.fn(() => ({ status: 201, body: material }));
    installViewMock([
      ...baseRoutes(),
      { method: 'POST', pattern: /\/api\/workspaces\/ws_1\/documents$/, handler: addDocument },
    ]);
    renderView();
    await screen.findByText('个人学习图谱');
    await user.type(await screen.findByLabelText('粘贴文本'), '# 新文档\n\n新的段落。');
    await user.click(screen.getByRole('button', { name: '添加文本文档' }));
    await waitFor(() => expect(addDocument).toHaveBeenCalledTimes(1));
  });
});

describe('学习图谱工作台 — graph area', () => {
  it('renders nodes with learner-state overlay, weak emphasis, and a legend', async () => {
    openSavedWorkspace();
    installViewMock(baseRoutes());
    renderView();

    const graph = await screen.findByTestId('concept-graph');
    await waitFor(() => {
      expect(within(graph).getByText('工作记忆')).toBeInTheDocument();
      expect(within(graph).getByText('间隔重复')).toBeInTheDocument();
    });
    // Weak node exposes its state and open-mistake count for screen readers.
    expect(within(graph).getByLabelText('概念 工作记忆(薄弱,1 道未解决错题)')).toBeInTheDocument();
    expect(within(graph).getByLabelText('概念 间隔重复(未评估)')).toBeInTheDocument();
    // Legend + weak summary + partial-success banner.
    expect(screen.getByLabelText('图例')).toBeInTheDocument();
    expect(screen.getByText('薄弱概念 1 个')).toBeInTheDocument();
    expect(screen.getByText(/部分候选关系未通过本地校验/)).toBeInTheDocument();
    expect(screen.getByText(/候选 2 条 · 采纳 1 条 · 拒绝 1 条/)).toBeInTheDocument();
  });

  it('shows the empty graph state before any concepts exist', async () => {
    openSavedWorkspace();
    installViewMock([
      ...baseRoutes().filter((r) => !r.pattern.test('/api/workspaces/ws_1/graph')),
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph$/,
        handler: () => ({ body: { version: null, edges: [], concepts: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph\/versions$/,
        handler: () => ({ body: { versions: [] } }),
      },
    ]);
    renderView();
    const onboarding = await screen.findByLabelText('学习图谱引导');
    expect(within(onboarding).getByText('添加课程资料')).toBeInTheDocument();
    expect(within(onboarding).getByText('生成个人学习图谱')).toBeInTheDocument();
  });

  it('surfaces a failed generation without hiding the previous graph', async () => {
    openSavedWorkspace();
    const failedVersion = {
      ...graphVersion,
      id: 'gv_2',
      status: 'failed' as const,
      errorMessage: '模型提出的概念关系均未通过本地校验,原有图谱保持不变。',
    };
    installViewMock([
      ...baseRoutes().filter((r) => !r.pattern.test('/api/workspaces/ws_1/graph')),
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph$/,
        handler: () => ({
          body: { version: failedVersion, edges: [], concepts: graphConcepts },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph\/versions$/,
        handler: () => ({ body: { versions: [failedVersion, graphVersion] } }),
      },
    ]);
    renderView();
    expect(await screen.findByText(/最近一次图谱生成失败/)).toBeInTheDocument();
  });

  it('regenerates the graph from the primary action', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    const generate = vi.fn(() => ({
      status: 201,
      body: { version: graphVersion, edges: graphEdges },
    }));
    installViewMock([
      ...baseRoutes(),
      { method: 'POST', pattern: /\/api\/workspaces\/ws_1\/graph$/, handler: generate },
    ]);
    renderView();
    const button = await screen.findByRole('button', { name: '重新生成图谱' });
    await user.click(button);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });
});

describe('学习图谱工作台 — detail area and planner', () => {
  /**
   * Canvas node clicks use fireEvent (plain `click`, no mousedown): d3-zoom's
   * native mousedown handler crashes on user-event's synthetic events, whose
   * `view` is pinned to null in jsdom.
   */
  async function selectWorkingMemoryNode() {
    const graph = await screen.findByTestId('concept-graph');
    const node = await within(graph).findByText('工作记忆');
    fireEvent.click(node);
  }

  it('shows concept evidence, learner state, and relationships on node selection', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    installViewMock(baseRoutes());
    renderView();
    await selectWorkingMemoryNode();

    const panel = await screen.findByLabelText('概念详情:工作记忆');
    expect(within(panel).getByText('容量有限的短时加工系统。')).toBeInTheDocument();
    expect(within(panel).getByText(/未解决错题 1 道/)).toBeInTheDocument();
    expect(within(panel).getByText(/本概念 → 间隔重复/)).toBeInTheDocument();
    // Verified quotes live in the 原文证据 inspector tab.
    await user.click(within(panel).getByRole('tab', { name: '原文证据' }));
    expect(within(panel).getAllByText('本地已验证').length).toBeGreaterThanOrEqual(1);
    await user.click(within(panel).getAllByRole('button', { name: '查看原文依据' })[0]!);
    expect(within(panel).getByText('工作记忆的容量十分有限')).toBeInTheDocument();
    expect(within(panel).getByText(/引文校验仅证明文字确实出现在来源位置/)).toBeInTheDocument();
  });

  it('shows edge details with relation, explanation, and verified evidence', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    installViewMock(baseRoutes());
    renderView();
    await screen.findByTestId('concept-graph');

    // The accessible edge list mirrors canvas edge selection for keyboard use.
    await user.click(screen.getByText(/关系列表/));
    await user.click(screen.getByRole('button', { name: /工作记忆 —先修→ 间隔重复/ }));

    const panel = await screen.findByLabelText(/关系详情:工作记忆 与 间隔重复/);
    expect(within(panel).getByText('先修')).toBeInTheDocument();
    expect(
      within(panel).getByText(/先理解工作记忆的限制,才能理解间隔重复为何有效。/),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: '原文证据' }));
    expect(within(panel).getByRole('button', { name: '查看原文依据' })).toBeInTheDocument();
  });

  it('generates, displays, and launches a remediation plan', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    const onLaunchQuiz = vi.fn();
    const generatePlan = vi.fn(() => ({ status: 201, body: { plan: remediationPlan } }));
    const launch = vi.fn(() => ({ status: 201, body: { quiz, mode: 'practice' } }));
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: generatePlan,
      },
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/plans\/plan_1\/launch$/,
        handler: launch,
      },
    ]);
    renderView({ onLaunchQuiz });
    await selectWorkingMemoryNode();
    const panel = await screen.findByLabelText('概念详情:工作记忆');
    await user.click(within(panel).getByRole('tab', { name: '学习计划' }));

    await user.click(await screen.findByRole('button', { name: '生成康复计划' }));
    const planCard = await screen.findByLabelText('已接受的康复计划');
    expect(within(planCard).getAllByText(/检索练习/).length).toBeGreaterThanOrEqual(1);
    expect(within(planCard).getByText(/本地校验通过/)).toBeInTheDocument();
    expect(within(planCard).getByText(/模型假设/)).toBeInTheDocument();
    expect(within(planCard).getByText(/重读「工作记忆」的原文依据。/)).toBeInTheDocument();

    await user.click(within(planCard).getByRole('button', { name: '按计划开始康复练习' }));
    await waitFor(() => expect(onLaunchQuiz).toHaveBeenCalledWith(quiz, 'practice'));
  });

  it('keeps a previously accepted plan visible when regeneration fails', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    let calls = 0;
    installViewMock([
      ...baseRoutes().filter((r) => !(r.method === 'GET' && r.pattern.source.includes('plan'))),
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: () => ({ body: { plan: remediationPlan } }),
      },
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: () => {
          calls += 1;
          return {
            status: 422,
            body: {
              error: {
                code: 'GROUNDING_FAILED',
                message: '康复计划未通过本地校验,已保留原有计划。',
              },
            },
          };
        },
      },
    ]);
    renderView();
    await selectWorkingMemoryNode();
    const panel = await screen.findByLabelText('概念详情:工作记忆');
    await user.click(within(panel).getByRole('tab', { name: '学习计划' }));
    // Accepted plan loads automatically for the selected concept.
    await screen.findByLabelText('已接受的康复计划');

    await user.click(screen.getByRole('button', { name: '重新生成康复计划' }));
    expect(await screen.findByText(/已保留原有计划/)).toBeInTheDocument();
    expect(calls).toBe(1);
    expect(screen.getByLabelText('已接受的康复计划')).toBeInTheDocument();
  });

  it('supports cancelling plan generation and returning to idle', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: () => 'never',
      },
    ]);
    renderView();
    await selectWorkingMemoryNode();
    await user.click(
      within(await screen.findByLabelText('概念详情:工作记忆')).getByRole('tab', {
        name: '学习计划',
      }),
    );
    await user.click(await screen.findByRole('button', { name: '生成康复计划' }));
    expect(screen.getByText(/Hy3 正在生成康复计划/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(await screen.findByRole('button', { name: '生成康复计划' })).toBeInTheDocument();
    expect(screen.queryByLabelText('已接受的康复计划')).not.toBeInTheDocument();
  });

  it('suppresses a late plan response after the selection changed', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    let resolvePlan: (value: { status: number; body: unknown }) => void = () => {};
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: () =>
          new Promise((resolve) => {
            resolvePlan = resolve;
          }),
      },
    ]);
    renderView();
    await selectWorkingMemoryNode();
    await user.click(
      within(await screen.findByLabelText('概念详情:工作记忆')).getByRole('tab', {
        name: '学习计划',
      }),
    );
    await user.click(await screen.findByRole('button', { name: '生成康复计划' }));

    // Switch selection to the other node while the plan request is pending.
    const graph = screen.getByTestId('concept-graph');
    fireEvent.click(within(graph).getByText('间隔重复'));
    await screen.findByLabelText('概念详情:间隔重复');

    resolvePlan({ status: 201, body: { plan: remediationPlan } });
    await waitFor(() => {
      expect(screen.queryByLabelText('已接受的康复计划')).not.toBeInTheDocument();
    });
  });
});

describe('学习图谱工作台 — panel collapse', () => {
  it('collapses and re-expands both side panels while the graph stays mounted', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    installViewMock(baseRoutes());
    renderView();
    await screen.findByTestId('concept-graph');

    await user.click(screen.getByRole('button', { name: '折叠资料面板' }));
    expect(screen.queryByLabelText('课程空间与文档')).not.toBeInTheDocument();
    expect(screen.getByTestId('concept-graph')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开资料面板' }));
    expect(screen.getByLabelText('课程空间与文档')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '折叠详情面板' }));
    expect(screen.queryByLabelText('证据与辅导详情')).not.toBeInTheDocument();
    expect(screen.getByTestId('concept-graph')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开详情面板' }));
    expect(screen.getByLabelText('证据与辅导详情')).toBeInTheDocument();
  });

  it('shows a success summary after graph generation', async () => {
    openSavedWorkspace();
    const user = userEvent.setup();
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/graph$/,
        handler: () => ({ status: 201, body: { version: graphVersion, edges: graphEdges } }),
      },
    ]);
    renderView();
    await user.click(await screen.findByRole('button', { name: '重新生成图谱' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('已构建 2 个概念与 1 条关系;1 条关系已通过本地证据验证。');
    await user.click(screen.getByRole('button', { name: '关闭生成摘要' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('学习图谱工作台 — stale workspace switches', () => {
  it('ignores a slow first workspace when the user has switched to another', async () => {
    const ws2 = { ...workspace, id: 'ws_2', name: '第二课程', activeGraphVersionId: null };
    const summaries = [workspaceSummary, { ...ws2, documentCount: 0, conceptCount: 0 }];
    let resolveFirstDetail: (value: { status: number; body: unknown }) => void = () => {};
    window.localStorage.setItem(LAST_WORKSPACE_KEY, 'ws_1');
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: summaries } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () =>
          new Promise((resolve) => {
            resolveFirstDetail = resolve;
          }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/(graph|overlay)/,
        handler: () => ({ body: { version: null, edges: [], concepts: [], states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph\/versions$/,
        handler: () => ({ body: { versions: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => ({ body: { workspace: ws2, documents: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2\/graph$/,
        handler: () => ({ body: { version: null, edges: [], concepts: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2\/graph\/versions$/,
        handler: () => ({ body: { versions: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
    ]);
    const user = userEvent.setup();
    renderView();

    // While ws_1 detail hangs, the user opens ws_2.
    await user.click(await screen.findByRole('button', { name: /第二课程/ }));
    expect(await screen.findByLabelText('学习图谱引导')).toBeInTheDocument();

    // The stale ws_1 response resolves now — it must not replace ws_2 data.
    resolveFirstDetail({ status: 200, body: { workspace, documents: [documentSummary] } });
    await waitFor(() => {
      expect(screen.queryByText(documentSummary.title)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('学习图谱引导')).toBeInTheDocument();
  });
});

describe('学习图谱工作台 — 自适应学习升级', () => {
  const secondDocument = {
    ...documentSummary,
    id: 'mat_2',
    title: 'English notes',
  };
  const enConcept = {
    ...graphConcepts[0]!,
    id: 'con_en',
    materialId: 'mat_2',
    name: 'Working memory',
  };
  const mergedCanonical = [
    {
      id: 'can_1',
      workspaceId: 'ws_1',
      displayName: '工作记忆',
      normalizedKey: '工作记忆',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      members: [
        {
          sourceConceptId: 'con_0',
          canonicalConceptId: 'can_1',
          originalName: '工作记忆',
          materialId: 'mat_1',
          language: 'zh' as const,
          viaProposalId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          sourceConceptId: 'con_en',
          canonicalConceptId: 'can_1',
          originalName: 'Working memory',
          materialId: 'mat_2',
          language: 'en' as const,
          viaProposalId: 'alp_1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      aliases: ['Working memory'],
      materialIds: ['mat_1', 'mat_2'],
    },
    {
      id: 'can_2',
      workspaceId: 'ws_1',
      displayName: '间隔重复',
      normalizedKey: '间隔重复',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      members: [
        {
          sourceConceptId: 'con_1',
          canonicalConceptId: 'can_2',
          originalName: '间隔重复',
          materialId: 'mat_1',
          language: 'zh' as const,
          viaProposalId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      aliases: [] as string[],
      materialIds: ['mat_1'],
    },
  ];

  function adaptiveRoutes(): MockRoute[] {
    return [
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({
          body: { workspace, documents: [documentSummary, secondDocument] },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph$/,
        handler: () => ({
          body: {
            version: graphVersion,
            edges: graphEdges,
            concepts: [...graphConcepts, enConcept],
          },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_2$/,
        handler: () => ({
          body: { ...material, material: { ...material.material, id: 'mat_2' } },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/alignment$/,
        handler: () => ({
          body: {
            canonical: mergedCanonical,
            pendingProposals: [
              {
                id: 'alp_2',
                workspaceId: 'ws_1',
                sourceConceptId: 'con_1',
                targetConceptId: 'con_en',
                relation: 'related_but_distinct',
                proposedCanonicalName: '间隔重复',
                rationale: '相关但不同。',
                evidence: [],
                origin: 'provider',
                status: 'proposed',
                sourceLanguage: 'zh',
                targetLanguage: 'en',
                provider: 'fake',
                createdAt: '2026-01-01T00:00:00.000Z',
                decidedAt: null,
              },
            ],
            decidedProposals: [],
          },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/queue$/,
        handler: () => ({
          body: {
            items: [
              {
                kind: 'open_mistakes',
                conceptId: 'con_0',
                conceptName: '工作记忆',
                misconceptionId: null,
                reason: '有 1 道未解决错题。',
                overdueDays: 0,
              },
            ],
          },
        }),
      },
      ...baseRoutes().filter((r) => !r.pattern.test('/api/workspaces/ws_1')),
    ];
  }

  it('renders ONE canonical node for aligned concepts and exposes aliases in the inspector', async () => {
    openSavedWorkspace();
    installViewMock(adaptiveRoutes());
    renderView();

    // The merged pair renders once (canonical name), not twice.
    const canvas = await screen.findByLabelText('个人学习图谱');
    await waitFor(() => {
      expect(within(canvas).getAllByText('工作记忆').length).toBeGreaterThan(0);
    });
    expect(within(canvas).queryByText('Working memory')).not.toBeInTheDocument();

    // Selecting the canonical node shows aliases and both documents.
    // Canvas clicks use fireEvent (as elsewhere in this file): user-event
    // constructs events whose own `view` is null, which crashes React
    // Flow's d3-drag mousedown listener in jsdom.
    fireEvent.click(within(canvas).getAllByText('工作记忆')[0]!);
    const inspector = await screen.findByLabelText('概念详情:工作记忆');
    expect(within(inspector).getByText(/别名:Working memory/)).toBeInTheDocument();
    expect(within(inspector).getByText(/来自 2 份文档/)).toBeInTheDocument();
  });

  it('shows the pending-alignment badge and opens the review panel', async () => {
    openSavedWorkspace();
    installViewMock(adaptiveRoutes());
    const user = userEvent.setup();
    renderView();

    const toggle = await screen.findByRole('button', { name: /概念对齐/ });
    expect(toggle).toHaveTextContent('1 待审');
    await user.click(toggle);
    expect(await screen.findByRole('dialog', { name: '概念对齐审核' })).toBeInTheDocument();
    expect(await screen.findByText('相关但不同')).toBeInTheDocument();
  });

  it('launches a workspace assessment from the daily queue', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    const adaptiveQuiz = {
      ...quiz,
      id: 'qz_adaptive',
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive' as const,
      assessmentMode: 'concept_practice',
    };
    const { calls } = installViewMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/assessments$/,
        handler: () => ({
          status: 201,
          body: { quiz: adaptiveQuiz, blueprints: [], rejected: [] },
        }),
      },
      ...adaptiveRoutes(),
    ]);
    const user = userEvent.setup();
    renderView({ onLaunchQuiz });

    const queueArea = await screen.findByLabelText('今日学习队列');
    await user.click(within(queueArea).getByRole('button', { name: '开始' }));
    await waitFor(() => expect(onLaunchQuiz).toHaveBeenCalled());
    expect(onLaunchQuiz.mock.calls[0]![0].kind).toBe('adaptive');
    expect(onLaunchQuiz.mock.calls[0]![1]).toBe('assessment');
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/assessments'));
    expect(post?.body).toEqual({ mode: 'concept_practice', conceptIds: ['con_0'] });
  });

  it('keeps misconception and review info in the inspector overview', async () => {
    openSavedWorkspace();
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/misconceptions$/,
        handler: () => ({
          body: {
            misconceptions: [
              {
                id: 'mc_1',
                workspaceId: 'ws_1',
                conceptId: 'con_0',
                conceptName: '工作记忆',
                originBlueprintId: null,
                originQuestionId: 'que_1',
                originQuizId: 'qz_1',
                learnerAnswer: {
                  questionId: 'que_1',
                  type: 'single_choice',
                  selectedOptionIds: ['B'],
                },
                evidence: [],
                category: 'definition_confusion',
                hypothesis: '学习者可能混淆了容量限制的具体数值。',
                provider: 'fake',
                status: 'proposed',
                decidedByQuizId: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/review$/,
        handler: () => ({
          body: {
            items: [
              {
                workspaceId: 'ws_1',
                conceptId: 'con_0',
                conceptName: '工作记忆',
                stability: 3,
                difficulty: 5,
                dueAt: '2026-01-04T00:00:00.000Z',
                lastReviewedAt: '2026-01-01T00:00:00.000Z',
                intervalDays: 3,
                reviewCount: 1,
                lapseCount: 0,
                lastRating: 'good',
                schedulerVersion: 'local-fsrs-v1',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      },
      ...baseRoutes(),
    ]);
    renderView();

    const canvas = await screen.findByLabelText('个人学习图谱');
    await waitFor(() => {
      expect(within(canvas).getAllByText('工作记忆').length).toBeGreaterThan(0);
    });
    // Canvas clicks use fireEvent — see the canonical-node test above.
    fireEvent.click(within(canvas).getAllByText('工作记忆')[0]!);
    const inspector = await screen.findByLabelText(/概念详情:工作记忆/);
    expect(within(inspector).getByText('待确认')).toBeInTheDocument();
    expect(within(inspector).getByText(/学习者可能混淆了容量限制/)).toBeInTheDocument();
    expect(within(inspector).getByText(/下次复习/)).toBeInTheDocument();
    expect(within(inspector).getByText(/误区仅为假设/)).toBeInTheDocument();
  });
});
