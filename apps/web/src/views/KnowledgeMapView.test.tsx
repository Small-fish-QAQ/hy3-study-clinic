import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeMapProjectionResponse } from '@hy3-clinic/shared';
import { api } from '../api.js';
import {
  knowledgeMapProjection,
  largeKnowledgeMapProjection,
} from '../test/knowledgeMapFixture.js';
import { KnowledgeMapView } from './KnowledgeMapView.js';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function mockProjection(workspaceId = 'ws_1') {
  const projection = knowledgeMapProjection(workspaceId);
  const get = vi.spyOn(api, 'getKnowledgeMap').mockResolvedValue({ projection });
  return { projection, get };
}

function renderMap(props: Partial<Parameters<typeof KnowledgeMapView>[0]> = {}) {
  const onNavigate = vi.fn();
  const result = render(
    <KnowledgeMapView
      workspaceId={props.workspaceId ?? 'ws_1'}
      refreshKey={props.refreshKey ?? 0}
      intent={props.intent}
      onNavigate={props.onNavigate ?? onNavigate}
    />,
  );
  return { ...result, onNavigate };
}

function nodeWrapper(label: string): HTMLElement {
  for (const match of screen.getAllByText(label)) {
    const wrapper = match.closest('.react-flow__node');
    if (wrapper instanceof HTMLElement) return wrapper;
  }
  throw new Error(`Knowledge Map node not found: ${label}`);
}

function expectNodeToHaveText(label: string, text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const wrapper = nodeWrapper(label);
    expect(wrapper).toHaveTextContent(text);
    return wrapper;
  });
}

describe('learner-facing Knowledge Map', () => {
  it('renders four distinct modes from one local projection read', async () => {
    const user = userEvent.setup();
    const { get } = mockProjection();
    renderMap();

    expect(
      await screen.findByRole('heading', {
        name: '这门课程包含什么，彼此如何连接？',
      }),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    await expectNodeToHaveText('工作记忆基础', '学习单元');

    await user.click(screen.getByRole('tab', { name: '学习进展' }));
    expect(
      screen.getByRole('heading', { name: '我学到了什么，还有哪些内容需要验证？' }),
    ).toBeInTheDocument();
    const progressNode = await expectNodeToHaveText('工作记忆基础', '有证据支持（尚未稳固）');
    expect(progressNode).not.toHaveTextContent('当前薄弱');

    await user.click(screen.getByRole('tab', { name: '学习路线' }));
    expect(
      screen.getByRole('heading', { name: '我在哪里，下一步是什么，为什么？' }),
    ).toBeInTheDocument();
    await expectNodeToHaveText('认知负荷应用', '当前位置');
    await expectNodeToHaveText('提取练习', '下一步');
    await expectNodeToHaveText('迁移练习', '先修未完成');

    await user.click(screen.getByRole('tab', { name: '关注地图' }));
    expect(
      screen.getByRole('heading', { name: '哪里需要关注，属于哪一种问题？' }),
    ).toBeInTheDocument();
    await expectNodeToHaveText('认知负荷应用', '修复进行中');
    await expectNodeToHaveText('工作记忆基础', '复习到期');
    await expectNodeToHaveText('间隔效应', '可能缺口（提示）');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps learner-state modes unavailable when the projection has no learner authority', async () => {
    const projection = knowledgeMapProjection();
    projection.nodes = projection.nodes.map((node) => ({
      ...node,
      learner: {
        ...node.learner,
        primaryState: 'not_started',
        milestones: [],
        progression: [],
        legacyMastery: null,
        reasonCodes: ['no_current_learning_activity'],
        authorityRefs: [],
      },
      weaknesses: [],
    }));
    vi.spyOn(api, 'getKnowledgeMap').mockResolvedValue({ projection });
    renderMap();

    await screen.findByRole('tab', { name: '知识结构' });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByRole('tab', { name: '学习进展' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '关注地图' })).not.toBeInTheDocument();
  });

  it('drops a stale projection when the learner switches Course', async () => {
    let resolveFirst!: (value: KnowledgeMapProjectionResponse) => void;
    let resolveSecond!: (value: KnowledgeMapProjectionResponse) => void;
    const first = new Promise<KnowledgeMapProjectionResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<KnowledgeMapProjectionResponse>((resolve) => {
      resolveSecond = resolve;
    });
    const get = vi
      .spyOn(api, 'getKnowledgeMap')
      .mockImplementation((workspaceId) => (workspaceId === 'ws_1' ? first : second));
    const view = renderMap({ workspaceId: 'ws_1' });

    await waitFor(() => expect(get).toHaveBeenCalledWith('ws_1', expect.any(AbortSignal)));
    view.rerender(<KnowledgeMapView workspaceId="ws_2" refreshKey={0} onNavigate={vi.fn()} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('ws_2', expect.any(AbortSignal)));

    resolveFirst({ projection: knowledgeMapProjection('ws_1') });
    const secondProjection = knowledgeMapProjection('ws_2');
    secondProjection.nodes = [];
    secondProjection.status = 'unconfigured';
    resolveSecond({ projection: secondProjection });

    expect(await screen.findByText('课程结构还没有准备完成')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '这门课程包含什么，彼此如何连接？' }),
    ).not.toBeInTheDocument();
  });

  it('keeps Formal failure, Repair, due Review, retrievability, and advisory explanations distinct', async () => {
    const user = userEvent.setup();
    mockProjection();
    const { onNavigate } = renderMap({
      intent: { requestId: 1, mode: 'weakness_map', learningUnitId: 'current' },
    });

    const inspector = await screen.findByRole('complementary', { name: '认知负荷应用 详情' });
    expect(within(inspector).getByText('正式检验未通过')).toBeInTheDocument();
    expect(within(inspector).getAllByText('修复进行中').length).toBeGreaterThan(0);
    expect(within(inspector).getByText('复习到期')).toBeInTheDocument();
    expect(within(inspector).getByText('回忆稳定性需关注')).toBeInTheDocument();
    expect(within(inspector).getByText('可能缺口（提示）')).toBeInTheDocument();
    expect(within(inspector).getByText('仅供提示，不改变正式状态')).toBeInTheDocument();
    expect(within(inspector).getByText(/逐字核对只说明引文出现在标注位置/)).toBeInTheDocument();

    await user.click(within(inspector).getByRole('button', { name: '查看修复' }));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'progress', repairEpisodeId: 'repair_current' }),
    );
  });

  it('retains a selected node through mode filtering and explains prerequisite locks', async () => {
    const user = userEvent.setup();
    mockProjection();
    renderMap();
    await screen.findByText('间隔效应');
    fireEvent.click(nodeWrapper('间隔效应'));
    expect(screen.getByRole('complementary', { name: '间隔效应 详情' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '学习路线' }));
    expect(nodeWrapper('间隔效应')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '间隔效应 详情' })).toBeInTheDocument();

    fireEvent.click(nodeWrapper('迁移练习'));
    expect(screen.getByText('需要先完成 1 项先修内容。')).toBeInTheDocument();
    expect(screen.getByText('当前节点没有可直接执行的操作。')).toBeInTheDocument();
  });

  it('supports keyboard mode changes and accessible camera controls', async () => {
    mockProjection();
    renderMap();
    const firstTab = await screen.findByRole('tab', { name: '知识结构' });
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '学习进展' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '放大地图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '缩小地图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '适配地图视图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重置地图布局' })).toBeInTheDocument();
  });

  it('uses a narrow dialog sheet, closes on Escape, and restores node focus', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-width') || query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const user = userEvent.setup();
    mockProjection();
    renderMap();
    const node = await waitFor(() => nodeWrapper('工作记忆基础'));
    fireEvent.click(node);
    const dialog = screen.getByRole('dialog', { name: '工作记忆基础 详情' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '关闭节点详情' })).toHaveFocus(),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(node).toHaveFocus();
  });

  it('renders unconfigured, load failure/retry, and larger-map states', async () => {
    const user = userEvent.setup();
    const empty = knowledgeMapProjection();
    empty.status = 'unconfigured';
    empty.route = {
      ...empty.route,
      current: false,
      validationStatus: 'unconfigured',
      contractVersionId: null,
      curriculumVersionId: null,
      studyPlanVersionId: null,
      agendaId: null,
      executionSourceManifestFingerprint: null,
    };
    empty.nodes = [];
    empty.edges = [];
    vi.spyOn(api, 'getKnowledgeMap').mockResolvedValueOnce({ projection: empty });
    const first = renderMap();
    expect(await screen.findByText('课程结构还没有准备完成')).toBeInTheDocument();
    first.unmount();

    const get = vi
      .spyOn(api, 'getKnowledgeMap')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ projection: largeKnowledgeMapProjection() });
    renderMap();
    expect(await screen.findByText('知识地图暂时无法读取')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByLabelText('地图规模')).toHaveTextContent('120 个节点');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fences a late response from the previous Course', async () => {
    let resolveFirst!: (value: KnowledgeMapProjectionResponse) => void;
    let resolveSecond!: (value: KnowledgeMapProjectionResponse) => void;
    const first = new Promise<KnowledgeMapProjectionResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<KnowledgeMapProjectionResponse>((resolve) => {
      resolveSecond = resolve;
    });
    vi.spyOn(api, 'getKnowledgeMap').mockImplementation((workspaceId) =>
      workspaceId === 'ws_1' ? first : second,
    );
    const rendered = renderMap({ workspaceId: 'ws_1' });
    rendered.rerender(<KnowledgeMapView workspaceId="ws_2" refreshKey={0} onNavigate={vi.fn()} />);
    const current = knowledgeMapProjection('ws_2');
    current.nodes[0] = { ...current.nodes[0]!, label: '新课程知识节点' };
    resolveSecond({ projection: current });
    expect(await screen.findByText('新课程知识节点')).toBeInTheDocument();
    const stale = knowledgeMapProjection('ws_1');
    stale.nodes[0] = { ...stale.nodes[0]!, label: '旧课程迟到节点' };
    resolveFirst({ projection: stale });
    await waitFor(() => expect(screen.queryByText('旧课程迟到节点')).not.toBeInTheDocument());
  });

  it('removes an already-rendered projection immediately when the Course changes', async () => {
    const first = knowledgeMapProjection('ws_1');
    first.nodes[0] = { ...first.nodes[0]!, label: '旧课程现有节点' };
    let resolveSecond!: (value: KnowledgeMapProjectionResponse) => void;
    const second = new Promise<KnowledgeMapProjectionResponse>((resolve) => {
      resolveSecond = resolve;
    });
    vi.spyOn(api, 'getKnowledgeMap').mockImplementation((workspaceId) =>
      workspaceId === 'ws_1' ? Promise.resolve({ projection: first }) : second,
    );
    const rendered = renderMap({ workspaceId: 'ws_1' });
    expect(await screen.findByText('旧课程现有节点')).toBeInTheDocument();

    rendered.rerender(<KnowledgeMapView workspaceId="ws_2" refreshKey={0} onNavigate={vi.fn()} />);
    expect(screen.queryByText('旧课程现有节点')).not.toBeInTheDocument();
    expect(screen.getByText('正在读取知识地图…')).toBeInTheDocument();

    resolveSecond({ projection: knowledgeMapProjection('ws_2') });
    expect(await screen.findByText('工作记忆基础')).toBeInTheDocument();
  });
});
