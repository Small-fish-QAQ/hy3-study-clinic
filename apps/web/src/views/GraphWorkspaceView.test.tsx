import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  tutorRun,
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
  it('keeps the graph primary in embedded Explore and removes Course management controls', async () => {
    const user = userEvent.setup();
    installViewMock(baseRoutes());
    render(
      <GraphWorkspaceView
        refreshKey={0}
        selectedWorkspaceId="ws_1"
        onWorkspaceSelected={vi.fn()}
        onLaunchQuiz={vi.fn()}
        courseLocked
      />,
    );

    expect(await screen.findByRole('heading', { name: '概念图谱' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('个人学习图谱').length).toBeGreaterThan(0);
    expect(screen.queryByText('每日学习队列')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('新建课程')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('证据与辅导详情')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开详情面板' })).toBeDisabled();

    const materialsTrigger = screen.getByRole('button', { name: '资料与版本' });
    await user.click(materialsTrigger);
    const materialsPanel = await screen.findByRole('dialog', { name: '课程空间与文档' });
    expect(within(materialsPanel).getByText(documentSummary.title)).toBeInTheDocument();
    expect(within(materialsPanel).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(within(materialsPanel).queryByText('添加课程资料')).not.toBeInTheDocument();
    expect(screen.getByTestId('concept-graph')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '课程空间与文档' })).not.toBeInTheDocument();
    expect(materialsTrigger).toHaveFocus();

    const graph = screen.getByTestId('concept-graph');
    fireEvent.click(within(graph).getByText('工作记忆'));
    expect(await screen.findByRole('dialog', { name: '证据与辅导详情' })).toBeInTheDocument();
    expect(screen.getByTestId('concept-graph')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '证据与辅导详情' })).not.toBeInTheDocument();
  });

  it('routes an empty embedded Explore back to Course Materials', async () => {
    const user = userEvent.setup();
    const onOpenMaterials = vi.fn();
    const emptyWorkspace = { ...workspace, activeGraphVersionId: null };
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [workspaceSummary] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace: emptyWorkspace, documents: [] } }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        selectedWorkspaceId="ws_1"
        onOpenMaterials={onOpenMaterials}
        onLaunchQuiz={vi.fn()}
        courseLocked
      />,
    );

    expect(await screen.findByText(/请先从主页添加课程资料/)).toBeInTheDocument();
    expect(screen.queryByText(/左侧「资料库」/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '前往课程资料' }));
    expect(onOpenMaterials).toHaveBeenCalledOnce();
  });

  it('does not make a hidden provider call when navigation opens Concept recovery', async () => {
    const emptyWorkspace = { ...workspace, activeGraphVersionId: null };
    const emptyDocument = { ...documentSummary, conceptCount: 0 };
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [{ ...workspaceSummary, conceptCount: 0 }] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace: emptyWorkspace, documents: [emptyDocument] } }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1$/,
        handler: () => ({ body: material }),
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        selectedWorkspaceId="ws_1"
        onLaunchQuiz={vi.fn()}
        courseLocked
      />,
    );

    expect(await screen.findByRole('button', { name: '提取核心概念' })).toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('notifies Course readiness only after learner-triggered Concept extraction completes', async () => {
    const emptyWorkspace = { ...workspace, activeGraphVersionId: null };
    const emptyDocument = { ...documentSummary, conceptCount: 0 };
    const onConceptGroundingChanged = vi.fn();
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [{ ...workspaceSummary, conceptCount: 0 }] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace: emptyWorkspace, documents: [emptyDocument] } }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1$/,
        handler: () => ({ body: material }),
      },
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/analyze$/,
        handler: () => ({
          body: {
            concepts: [graphConcepts[0]],
            extraction: {
              sections: [],
              conceptsAdded: 1,
              conceptTotal: 1,
              capReached: false,
            },
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(
      <GraphWorkspaceView
        refreshKey={0}
        selectedWorkspaceId="ws_1"
        onLaunchQuiz={vi.fn()}
        onConceptGroundingChanged={onConceptGroundingChanged}
        courseLocked
      />,
    );

    expect(onConceptGroundingChanged).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: '提取核心概念' }));
    await waitFor(() => expect(onConceptGroundingChanged).toHaveBeenCalledWith('ws_1'));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('shows the empty state when no workspaces exist', async () => {
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [] } }),
      },
    ]);
    renderView();
    expect(await screen.findByText(/还没有课程。先创建一门课程/)).toBeInTheDocument();
    expect(screen.getByText(/选择或创建一个课程空间/)).toBeInTheDocument();
    expect(screen.getByLabelText('新建课程')).toBeInTheDocument();
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
    await user.type(await screen.findByLabelText('新建课程'), '新课程');
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
    await user.click(screen.getByRole('button', { name: /^认知科学课程/ }));
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

  it('uploads a PDF file as a base64 file document', async () => {
    openSavedWorkspace();
    const pdfBody = '%PDF-1.4 workspace upload';
    let received: unknown;
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/documents$/,
        handler: (body) => {
          received = body;
          return { status: 201, body: material };
        },
      },
    ]);
    renderView();
    await screen.findByText('个人学习图谱');

    expect(screen.getByText(/暂不支持纯扫描图片型 PDF/)).toBeInTheDocument();
    const input = screen.getByLabelText('上传文档文件(.md / .txt / .pdf / .pptx / .docx)');
    expect(input).toHaveAttribute('accept', '.md,.markdown,.txt,.pdf,.pptx,.docx');
    fireEvent.change(input, {
      target: { files: [new File([pdfBody], '讲义.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(received).toBeDefined());
    expect(received).toMatchObject({ kind: 'file', filename: '讲义.pdf' });
    expect(atob((received as { dataBase64: string }).dataBase64)).toBe(pdfBody);
  });

  it('uploads a PPTX file as a base64 file document', async () => {
    openSavedWorkspace();
    const pptxBody = 'PK\u0003\u0004 workspace presentation upload';
    let received: unknown;
    installViewMock([
      ...baseRoutes(),
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/documents$/,
        handler: (body) => {
          received = body;
          return { status: 201, body: material };
        },
      },
    ]);
    renderView();
    await screen.findByText('个人学习图谱');

    fireEvent.change(screen.getByLabelText('上传文档文件(.md / .txt / .pdf / .pptx / .docx)'), {
      target: {
        files: [
          new File([pptxBody], '讲义.pptx', {
            type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          }),
        ],
      },
    });

    await waitFor(() => expect(received).toBeDefined());
    expect(received).toMatchObject({ kind: 'file', filename: '讲义.pptx' });
    expect(atob((received as { dataBase64: string }).dataBase64)).toBe(pptxBody);
  });

  it('rejects an unsupported upload locally with the shared message and no request', async () => {
    openSavedWorkspace();
    const addDocument = vi.fn(() => ({ status: 201, body: material }));
    installViewMock([
      ...baseRoutes(),
      { method: 'POST', pattern: /\/api\/workspaces\/ws_1\/documents$/, handler: addDocument },
    ]);
    renderView();
    await screen.findByText('个人学习图谱');

    fireEvent.change(screen.getByLabelText('上传文档文件(.md / .txt / .pdf / .pptx / .docx)'), {
      target: { files: [new File(['nope'], 'workbook.xlsx')] },
    });

    expect(
      await screen.findByText('不支持的文件类型:仅接受 .md、.txt、.pdf、.pptx 与 .docx 文件。'),
    ).toBeInTheDocument();
    expect(addDocument).not.toHaveBeenCalled();
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
    within(panel).getByRole('tab', { name: '概览' }).focus();
    await user.keyboard('{End}');
    await vi.waitFor(() =>
      expect(within(panel).getByRole('tab', { name: '学习计划' })).toHaveFocus(),
    );
    await user.keyboard('{ArrowLeft}');
    await vi.waitFor(() =>
      expect(within(panel).getByRole('tab', { name: '原文证据' })).toHaveFocus(),
    );
    expect(within(panel).getByRole('tab', { name: '原文证据' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
    await user.click(await screen.findByRole('button', { name: /^第二课程/ }));
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
                launch: { mode: 'concept_practice', conceptIds: ['con_0'] },
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

  it('shows an immediate launch state and creates exactly one activity for rapid clicks', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    const adaptiveQuiz = {
      ...quiz,
      id: 'qz_adaptive',
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive' as const,
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = installViewMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/assessments$/,
        handler: async () => {
          await gate;
          return { status: 201, body: { quiz: adaptiveQuiz, blueprints: [], rejected: [] } };
        },
      },
      ...adaptiveRoutes(),
    ]);
    renderView({ onLaunchQuiz });

    const queueArea = await screen.findByLabelText('今日学习队列');
    const start = within(queueArea).getByRole('button', { name: '开始' });
    // Two rapid clicks in the same tick: the ref guard admits only one.
    fireEvent.click(start);
    fireEvent.click(start);

    const busy = await within(queueArea).findByRole('button', { name: '启动中…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(busy);

    release();
    await waitFor(() => expect(onLaunchQuiz).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/assessments'))).toHaveLength(
      1,
    );
    // The button returns to its idle label after completion.
    expect(await within(queueArea).findByRole('button', { name: '开始' })).toBeEnabled();
  });

  it('restores the launch button and surfaces an actionable error when creation fails', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    installViewMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/assessments$/,
        handler: () => ({
          status: 502,
          body: { error: { code: 'PROVIDER_ERROR', message: '生成评估失败,请稍后重试。' } },
        }),
      },
      ...adaptiveRoutes(),
    ]);
    const user = userEvent.setup();
    renderView({ onLaunchQuiz });

    const queueArea = await screen.findByLabelText('今日学习队列');
    await user.click(within(queueArea).getByRole('button', { name: '开始' }));
    expect(await within(queueArea).findByText(/生成评估失败/)).toBeInTheDocument();
    expect(onLaunchQuiz).not.toHaveBeenCalled();
    expect(within(queueArea).getByRole('button', { name: '开始' })).toBeEnabled();
  });

  it('ignores a stale assessment completion after switching workspaces', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    const otherSummary = { ...workspaceSummary, id: 'ws_2', name: '第二课程' };
    const otherWorkspace = { ...workspace, id: 'ws_2', name: '第二课程' };
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [workspaceSummary, otherSummary] } }),
      },
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/assessments$/,
        handler: () => 'never',
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => ({ body: { workspace: otherWorkspace, documents: [] } }),
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
      ...adaptiveRoutes(),
    ]);
    const user = userEvent.setup();
    renderView({ onLaunchQuiz });

    const queueArea = await screen.findByLabelText('今日学习队列');
    await user.click(within(queueArea).getByRole('button', { name: '开始' }));
    await within(queueArea).findByRole('button', { name: '启动中…' });

    // Switching workspaces aborts the launch; no late navigation happens.
    await user.click(screen.getByRole('button', { name: /^第二课程/ }));
    await screen.findByText('文档(0)');
    expect(onLaunchQuiz).not.toHaveBeenCalled();
  });

  it('offers the real diagnostic assessment from the empty queue and prevents duplicates', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    const adaptiveQuiz = {
      ...quiz,
      id: 'qz_diag',
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive' as const,
      assessmentMode: 'diagnostic',
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = installViewMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/assessments$/,
        handler: async () => {
          await gate;
          return { status: 201, body: { quiz: adaptiveQuiz, blueprints: [], rejected: [] } };
        },
      },
      ...baseRoutes(),
    ]);
    renderView({ onLaunchQuiz });

    const queueArea = await screen.findByLabelText('今日学习队列');
    expect(await within(queueArea).findByText(/今天暂无待办/)).toBeInTheDocument();
    const diagnose = within(queueArea).getByRole('button', { name: '开始诊断评估' });
    fireEvent.click(diagnose);
    fireEvent.click(diagnose);

    const busy = await within(queueArea).findByRole('button', { name: '正在生成诊断评估…' });
    expect(busy).toBeDisabled();

    release();
    await waitFor(() => expect(onLaunchQuiz).toHaveBeenCalledTimes(1));
    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/assessments'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ mode: 'diagnostic' });
    expect(onLaunchQuiz.mock.calls[0]![1]).toBe('assessment');
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

/**
 * 删除课程空间 — the explicit way to retire a course space (including the
 * empty historical ones left behind after their documents were deleted in
 * 资料库). The UI must only update after server-confirmed success, clean up
 * the active selection, and stay immune to stale list responses.
 */
describe('学习图谱工作台 — course-space deletion', () => {
  const ghost = {
    ...workspaceSummary,
    id: 'ws_2',
    name: '历史课程',
    activeGraphVersionId: null,
    documentCount: 0,
    conceptCount: 0,
  };

  it('declining the confirmation sends no request and keeps the entry', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [workspaceSummary, ghost] } }),
      },
    ]);
    renderView();

    await user.click(await screen.findByRole('button', { name: '删除课程空间:历史课程' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('删除课程空间「历史课程」');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(screen.getByText('历史课程')).toBeInTheDocument();
  });

  it('extracting concepts refreshes the sidebar concept count immediately', async () => {
    const user = userEvent.setup();
    openSavedWorkspace();
    let analyzed = false;
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({
          body: { workspaces: [{ ...workspaceSummary, conceptCount: analyzed ? 2 : 0 }] },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({
          body: {
            workspace,
            documents: [{ ...documentSummary, conceptCount: analyzed ? 2 : 0 }],
          },
        }),
      },
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/analyze$/,
        handler: () => {
          analyzed = true;
          return { body: { concepts: graphConcepts } };
        },
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph$/,
        handler: () => ({
          body: { version: null, edges: [], concepts: analyzed ? graphConcepts : [] },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/graph\/versions$/,
        handler: () => ({ body: { versions: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1$/,
        handler: () => ({ body: material }),
      },
    ]);
    renderView();

    expect(await screen.findByText(/1 份资料 · 0 个概念/)).toBeInTheDocument();
    await user.click((await screen.findAllByRole('button', { name: '提取概念' }))[0]!);
    expect(await screen.findByText(/1 份资料 · 2 个概念/)).toBeInTheDocument();
  });

  it('deletes an empty historical course space and refreshes the list (the ghost-entry scenario)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    let live = [workspaceSummary, ghost];
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: live } }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => {
          live = live.filter((w) => w.id !== 'ws_2');
          return { status: 204 };
        },
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    expect(await screen.findByText('历史课程')).toBeInTheDocument();
    expect(screen.getByText(/0 份资料 · 0 个概念/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除课程空间:历史课程' }));

    await waitFor(() => {
      expect(screen.queryByText('历史课程')).not.toBeInTheDocument();
    });
    expect(screen.getByText('认知科学课程')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && /\/api\/workspaces\/ws_2$/.test(c.url))).toBe(
      true,
    );
    expect(onWorkspaceDeleted).toHaveBeenCalledWith('ws_2');
  });

  it('deleting the active course space clears it and falls back to the remaining one', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    openSavedWorkspace();
    let live = [workspaceSummary, ghost];
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: live } }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => {
          live = live.filter((w) => w.id !== 'ws_1');
          return { status: 204 };
        },
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => ({
          body: { workspace: { ...workspace, id: 'ws_2', name: '历史课程' }, documents: [] },
        }),
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
      ...baseRoutes(),
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    // The active workspace loaded its graph before deletion.
    expect(await screen.findByLabelText('个人学习图谱')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重新生成图谱' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '删除课程空间:认知科学课程' }));

    // Falls back to the remaining course space and shows its (empty) state.
    await waitFor(() => {
      expect(screen.queryByText('认知科学课程')).not.toBeInTheDocument();
    });
    expect(await screen.findByLabelText('学习图谱引导')).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws_2');
    expect(onWorkspaceDeleted).toHaveBeenCalledWith('ws_1');
  });

  it('deleting the only course space clears the saved id and shows the empty state', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    openSavedWorkspace();
    let live = [{ ...workspaceSummary, documentCount: 0, conceptCount: 0 }];
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: live } }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => {
          live = [];
          return { status: 204 };
        },
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace, documents: [] } }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
    ]);
    renderView();

    expect(await screen.findByText(/0 份资料 · 0 个概念/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除课程空间:认知科学课程' }));

    expect(await screen.findByText(/还没有课程。先创建一门课程/)).toBeInTheDocument();
    expect(screen.getByText(/选择或创建一个课程空间/)).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
  });

  it('a failed deletion keeps the entry and reports the error honestly', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: [workspaceSummary, ghost] } }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => ({
          status: 500,
          body: { error: { code: 'INTERNAL', message: '数据库繁忙' } },
        }),
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '删除课程空间:历史课程' }));

    expect(await screen.findByText(/删除课程失败:数据库繁忙/)).toBeInTheDocument();
    expect(screen.getByText('历史课程')).toBeInTheDocument();
    expect(onWorkspaceDeleted).not.toHaveBeenCalled();
    // No refresh happened after the failure — one initial list load only.
    expect(
      calls.filter((c) => c.method === 'GET' && /\/api\/workspaces$/.test(c.url)),
    ).toHaveLength(1);
  });

  it('treats a 404 as already deleted and still cleans up', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    let listCalls = 0;
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => {
          listCalls += 1;
          return {
            body: { workspaces: listCalls === 1 ? [workspaceSummary, ghost] : [workspaceSummary] },
          };
        },
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_2$/,
        handler: () => ({
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: '课程空间不存在:ws_2' } },
        }),
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '删除课程空间:历史课程' }));

    await waitFor(() => {
      expect(screen.queryByText('历史课程')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/删除课程失败/)).not.toBeInTheDocument();
    expect(onWorkspaceDeleted).toHaveBeenCalledWith('ws_2');
  });

  it('a slow earlier list response can never resurrect deleted course spaces', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ghostB = { ...ghost, id: 'ws_3', name: '历史课程B' };
    let live = [workspaceSummary, ghost, ghostB];
    let listCalls = 0;
    let releaseStaleList: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStaleList = resolve;
    });
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: async () => {
          listCalls += 1;
          if (listCalls === 2) {
            // The refresh triggered by the FIRST deletion stalls and returns
            // a stale snapshot that still contains both ghosts.
            const staleSnapshot = [workspaceSummary, ghost, ghostB];
            await staleGate;
            return { body: { workspaces: staleSnapshot } };
          }
          return { body: { workspaces: live } };
        },
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/(ws_2|ws_3)$/,
        handler: (_body, url) => {
          const id = url.endsWith('ws_2') ? 'ws_2' : 'ws_3';
          live = live.filter((w) => w.id !== id);
          return { status: 204 };
        },
      },
    ]);
    renderView();

    await screen.findByText('历史课程');
    await user.click(screen.getByRole('button', { name: '删除课程空间:历史课程' }));
    // Second deletion while the first refresh is still in flight.
    await user.click(await screen.findByRole('button', { name: '删除课程空间:历史课程B' }));
    await waitFor(() => {
      expect(screen.queryByText('历史课程B')).not.toBeInTheDocument();
    });

    // Now the stale response (still listing both ghosts) finally arrives.
    releaseStaleList!();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('历史课程')).not.toBeInTheDocument();
    expect(screen.queryByText('历史课程B')).not.toBeInTheDocument();
    expect(screen.getByText('认知科学课程')).toBeInTheDocument();
  });
});

/**
 * Document deletion inside 学习图谱, per workspace origin: an import-created
 * course space retires together with its FINAL document (server-confirmed
 * via the structured deletion result) and the view reconciles exactly like
 * an explicit course-space deletion; a manual course space is preserved
 * with honest zero counts.
 */
describe('学习图谱工作台 — document deletion lifecycle', () => {
  it('retires an import course space with its final document and cleans up the selection', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    openSavedWorkspace();
    const importWs = {
      ...workspace,
      activeGraphVersionId: null,
      origin: 'material_import' as const,
    };
    let live = [{ ...workspaceSummary, ...importWs, conceptCount: 0 }];
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({ body: { workspaces: live } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({ body: { workspace: importWs, documents: [documentSummary] } }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1$/,
        handler: () => ({ body: material }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_1\/documents\/mat_1$/,
        handler: () => {
          live = [];
          return { body: { workspaceId: 'ws_1', workspaceDeleted: true } };
        },
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    await screen.findByText('文档(1)');
    await user.click(screen.getByRole('button', { name: '删除' }));
    // The confirmation says the auto-created course space goes with the
    // final document — including its remaining history.
    expect(confirm.mock.calls[0]![0]).toContain('课程空间将随文档一并删除');

    // Server-confirmed retirement: the entry disappears, the view falls
    // back to the empty state, and nothing keeps referencing ws_1.
    expect(await screen.findByText(/还没有课程。先创建一门课程/)).toBeInTheDocument();
    expect(screen.queryByText('认知科学课程')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
    expect(onWorkspaceDeleted).toHaveBeenCalledWith('ws_1');
  });

  it('keeps a manual course space (zero counts) after its final document is deleted', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onWorkspaceDeleted = vi.fn();
    openSavedWorkspace();
    const manualWs = { ...workspace, activeGraphVersionId: null };
    let deleted = false;
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces$/,
        handler: () => ({
          body: {
            workspaces: [
              {
                ...workspaceSummary,
                activeGraphVersionId: null,
                documentCount: deleted ? 0 : 1,
                conceptCount: 0,
              },
            ],
          },
        }),
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1$/,
        handler: () => ({
          body: { workspace: manualWs, documents: deleted ? [] : [documentSummary] },
        }),
      },
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
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/overlay$/,
        handler: () => ({ body: { states: [] } }),
      },
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1$/,
        handler: () => ({ body: material }),
      },
      {
        method: 'DELETE',
        pattern: /\/api\/workspaces\/ws_1\/documents\/mat_1$/,
        handler: () => {
          deleted = true;
          return { body: { workspaceId: 'ws_1', workspaceDeleted: false } };
        },
      },
    ]);
    render(
      <GraphWorkspaceView
        refreshKey={0}
        onLaunchQuiz={() => {}}
        onWorkspaceDeleted={onWorkspaceDeleted}
      />,
    );

    await screen.findByText('文档(1)');
    await user.click(screen.getByRole('button', { name: '删除' }));
    // Manual workspace: the confirmation promises the space survives.
    expect(confirm.mock.calls[0]![0]).toContain('课程空间本身会保留');

    // The workspace stays selected and listed with corrected counts.
    expect(await screen.findByText('文档(0)')).toBeInTheDocument();
    expect(screen.getByText('认知科学课程')).toBeInTheDocument();
    expect(screen.getByText(/0 份资料 · 0 个概念/)).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws_1');
    expect(onWorkspaceDeleted).not.toHaveBeenCalled();
  });
});

describe('学习图谱工作台 — Tutor activity launch (server-owned)', () => {
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

  it('launches through POST /tutor/runs/:id/activity and surfaces an honest adjustment', async () => {
    openSavedWorkspace();
    const onLaunchQuiz = vi.fn();
    const adaptiveQuiz = {
      ...quiz,
      id: 'qz_tutor',
      materialId: null,
      workspaceId: 'ws_1',
      kind: 'adaptive' as const,
    };
    const { calls } = installViewMock([
      {
        method: 'POST',
        pattern: /\/api\/workspaces\/ws_1\/tutor\/runs\/tut_1\/activity$/,
        handler: () => ({
          status: 201,
          body: {
            quiz: adaptiveQuiz,
            blueprints: [],
            rejected: [],
            launchedMode: 'concept_practice',
            adjusted: {
              originalMode: 'cross_document',
              reason: '目标概念还没有已确认的跨文档对齐,无法构造真正的多文档证据。',
            },
          },
        }),
      },
      ...baseRoutes(),
    ]);
    // Wrap the route-table mock: NDJSON stream for the tutor session POST,
    // everything else delegates to the table (which keeps recording calls).
    const tableFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/workspaces\/ws_1\/tutor$/.test(url) && (init?.method ?? 'GET') === 'POST') {
        return Promise.resolve(
          ndjsonResponse([
            {
              kind: 'run',
              run: {
                ...tutorRun,
                // A legacy-style recommendation that is stale at launch time.
                activity: { mode: 'cross_document' as const, conceptIds: ['con_0'] },
              },
            },
          ]),
        );
      }
      return tableFetch(input, init);
    });

    renderView({ onLaunchQuiz });
    const canvas = await screen.findByLabelText('个人学习图谱');
    await waitFor(() => {
      expect(within(canvas).getAllByText('工作记忆').length).toBeGreaterThan(0);
    });
    fireEvent.click(within(canvas).getAllByText('工作记忆')[0]!);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /启动辅导/ }));
    await user.click(await screen.findByRole('button', { name: /开始推荐活动/ }));
    await waitFor(() => expect(onLaunchQuiz).toHaveBeenCalled());
    expect(onLaunchQuiz.mock.calls[0]![0].kind).toBe('adaptive');

    // The launch went through the server-owned route with NO client-assembled
    // mode parameters (the old misconception/state bridge is gone).
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/tutor/runs/tut_1/activity'),
    );
    expect(post).toBeTruthy();
    expect(post!.body).toBeUndefined();

    // The deterministic adjustment is surfaced honestly.
    expect(await screen.findByText(/推荐活动已按当前状态调整.*已改为概念练习/)).toBeInTheDocument();
  });
});

describe('学习图谱工作台 — stale plan responses', () => {
  it('a late plan response for a previously selected concept never lands on the new selection', async () => {
    openSavedWorkspace();
    let releasePlanA: () => void = () => {};
    const planAGate = new Promise<void>((resolve) => {
      releasePlanA = resolve;
    });
    installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_0\/plan$/,
        handler: async () => {
          await planAGate;
          return { body: { plan: remediationPlan } };
        },
      },
      {
        method: 'GET',
        pattern: /\/api\/workspaces\/ws_1\/concepts\/con_1\/plan$/,
        handler: () => ({ body: { plan: null } }),
      },
      ...baseRoutes(),
    ]);
    renderView();

    const canvas = await screen.findByLabelText('个人学习图谱');
    await waitFor(() => {
      expect(within(canvas).getAllByText('工作记忆').length).toBeGreaterThan(0);
    });
    // Select A (plan request parks on the gate), then quickly select B.
    fireEvent.click(within(canvas).getAllByText('工作记忆')[0]!);
    fireEvent.click(within(canvas).getAllByText('间隔重复')[0]!);
    const inspector = await screen.findByLabelText('概念详情:间隔重复');

    // A's late response arrives AFTER the selection moved to B.
    releasePlanA();
    await act(async () => {
      await Promise.resolve();
    });
    // B's panel must never display A's accepted plan: the plan tab still
    // offers fresh generation and does not show A's summary.
    const user = userEvent.setup();
    await user.click(within(inspector).getByRole('tab', { name: '学习计划' }));
    expect(
      await within(inspector).findByRole('button', { name: '生成康复计划' }),
    ).toBeInTheDocument();
    expect(within(inspector).queryByText(/围绕「工作记忆」的定向巩固计划/)).not.toBeInTheDocument();
  });
});

describe('学习图谱工作台 — 资料映射 (Phase 1)', () => {
  const mappingFixture = {
    materialId: 'mat_1',
    title: '认知科学入门:记忆与学习',
    totals: {
      blockCount: 10,
      charCount: 4200,
      conceptCount: 2,
      mappedSectionCount: 1,
      sectionCount: 2,
      anchoredBlockCount: 2,
      anchoredCharCount: 700,
    },
    sections: [
      {
        key: 'sec_0_abc',
        title: '记忆的类型',
        fromHeading: true,
        blockCount: 5,
        charCount: 2100,
        conceptCount: 2,
        anchoredBlockCount: 2,
        anchoredCharCount: 700,
        mapped: true,
      },
      {
        key: 'sec_1_def',
        title: '睡眠与巩固',
        fromHeading: true,
        blockCount: 5,
        charCount: 2100,
        conceptCount: 0,
        anchoredBlockCount: 0,
        anchoredCharCount: 0,
        mapped: false,
      },
    ],
  };

  it('shows honest mapping facts and deepens an unmapped section additively', async () => {
    openSavedWorkspace();
    const analyzeCalls: unknown[] = [];
    const { calls } = installViewMock([
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1\/mapping$/,
        handler: () => ({ body: mappingFixture }),
      },
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/analyze$/,
        handler: (body) => {
          analyzeCalls.push(body);
          return {
            body: {
              concepts: graphConcepts,
              extraction: {
                sections: [
                  {
                    key: 'sec_1_def',
                    title: '睡眠与巩固',
                    charCount: 2100,
                    status: 'extracted',
                    conceptsAdded: 2,
                  },
                ],
                conceptsAdded: 2,
                conceptTotal: 4,
                capReached: false,
              },
            },
          };
        },
      },
      ...baseRoutes(),
    ]);
    const user = userEvent.setup();
    renderView();

    await screen.findByText('个人学习图谱');
    await user.click(screen.getByText('资料映射'));

    // Honest wording: mapping/anchoring facts plus the explicit caveat.
    expect(await screen.findByText(/已映射 1\/2 小节/)).toBeInTheDocument();
    expect(screen.getByText(/引用锚点覆盖 2\/10 段/)).toBeInTheDocument();
    expect(screen.getByText(/不代表小节内容已被完整覆盖/)).toBeInTheDocument();
    expect(screen.getByText('未映射')).toBeInTheDocument();

    // Deepening the unmapped section sends the SECTION-targeted analyze.
    await user.click(screen.getByRole('button', { name: '继续提取' }));
    await waitFor(() => expect(analyzeCalls.length).toBe(1));
    expect(analyzeCalls[0]).toEqual({ section: 'sec_1_def' });
    // The run summary is surfaced.
    expect(await screen.findByText(/新增 2 个概念/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/analyze'));
    expect(post).toBeTruthy();
  });
});
