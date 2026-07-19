import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Concept, ConceptLearnerState, GraphEdge } from '@hy3-clinic/shared';
import { ConceptGraph } from './ConceptGraph';
import {
  computeForceLayout,
  estimateNodeSize,
  loadSavedPositions,
  neighborhoodConceptIds,
  savePositions,
  weakPathConceptIds,
} from './graph/layout';
import { graphConcepts, graphEdges, overlayStates, T0 } from '../test/fixtures';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** Third, disconnected concept lets tests observe dimming and focus modes. */
const extraConcept: Concept = {
  id: 'con_2',
  materialId: 'mat_1',
  name: '提取练习',
  summary: '主动回忆信息的练习方式。',
  importance: 'medium',
  grounding: {
    blockId: 'blk_1',
    quote: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
    startOffset: 0,
    endOffset: 28,
    occurrenceCount: 1,
    reanchored: false,
  },
  createdAt: T0,
};

const concepts: Concept[] = [...graphConcepts, extraConcept];
const overlay = new Map<string, ConceptLearnerState>(overlayStates.map((s) => [s.conceptId, s]));

function renderGraph(props: Partial<Parameters<typeof ConceptGraph>[0]> = {}) {
  const onSelectNode = vi.fn();
  const onSelectEdge = vi.fn();
  render(
    <ConceptGraph
      concepts={props.concepts ?? concepts}
      edges={props.edges ?? graphEdges}
      overlay={props.overlay ?? overlay}
      selectedNodeId={props.selectedNodeId ?? null}
      selectedEdgeId={props.selectedEdgeId ?? null}
      onSelectNode={props.onSelectNode ?? onSelectNode}
      onSelectEdge={props.onSelectEdge ?? onSelectEdge}
      versionId={props.versionId ?? 'gv_1'}
      planTargetIds={props.planTargetIds}
      summary={
        props.summary ?? { documentCount: 1, weakCount: 1, acceptedCount: 1, rejectedCount: 1 }
      }
    />,
  );
  return { onSelectNode, onSelectEdge };
}

function nodeWrapper(name: string): HTMLElement {
  // The hover tooltip repeats the concept name, so scan all matches for the
  // one inside a React Flow node wrapper.
  for (const label of screen.getAllByText(name)) {
    const wrapper = label.closest('.react-flow__node');
    if (wrapper instanceof HTMLElement) return wrapper;
  }
  throw new Error(`node wrapper for ${name} not found`);
}

describe('graph layout (deterministic)', () => {
  const sizes = new Map(concepts.map((c) => [c.id, estimateNodeSize(c.name, 2)]));

  it('produces identical positions for identical input', () => {
    const a = computeForceLayout(concepts, graphEdges, sizes);
    const b = computeForceLayout(concepts, graphEdges, sizes);
    expect(a.size).toBe(concepts.length);
    for (const [id, pos] of a) {
      expect(b.get(id)).toEqual(pos);
    }
  });

  it('keeps rectangular nodes from overlapping and disconnected nodes placed', () => {
    const many: Concept[] = Array.from({ length: 10 }, (_, i) => ({
      ...extraConcept,
      id: `con_layout_${i}`,
      name: `布局压力概念${i}`,
    }));
    const manySizes = new Map(many.map((c) => [c.id, estimateNodeSize(c.name, 0)]));
    const positions = computeForceLayout(many, [], manySizes);
    expect(positions.size).toBe(10);
    const entries = [...positions.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i]!;
        const [idB, b] = entries[j]!;
        const sa = manySizes.get(idA)!;
        const sb = manySizes.get(idB)!;
        const dx = a.x + sa.width / 2 - (b.x + sb.width / 2);
        const dy = a.y + sa.height / 2 - (b.y + sb.height / 2);
        const minGap =
          Math.hypot(sa.width / 2, sa.height / 2) + Math.hypot(sb.width / 2, sb.height / 2);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(minGap * 0.9);
      }
    }
  });

  it('selects weak concepts, prerequisite ancestors, and neighbors for 薄弱路径', () => {
    // con_0 is weak; con_1 is its direct neighbor; con_2 is unrelated.
    const ids = weakPathConceptIds(concepts, graphEdges, overlay);
    expect(ids.has('con_0')).toBe(true);
    expect(ids.has('con_1')).toBe(true);
    expect(ids.has('con_2')).toBe(false);
  });

  it('computes one- and two-hop neighborhoods', () => {
    const chain: GraphEdge[] = [
      graphEdges[0]!,
      { ...graphEdges[0]!, id: 'ge_2', sourceConceptId: 'con_1', targetConceptId: 'con_2' },
    ];
    expect(neighborhoodConceptIds('con_0', chain, 1)).toEqual(new Set(['con_0', 'con_1']));
    expect(neighborhoodConceptIds('con_0', chain, 2)).toEqual(new Set(['con_0', 'con_1', 'con_2']));
  });

  it('round-trips saved positions and tolerates corrupt storage', () => {
    savePositions('gv_x', { con_0: { x: 12, y: -3 } });
    expect(loadSavedPositions('gv_x')).toEqual({ con_0: { x: 12, y: -3 } });
    window.localStorage.setItem('hy3-clinic:graph-positions:gv_bad', '{not json');
    expect(loadSavedPositions('gv_bad')).toEqual({});
    savePositions('gv_x', {});
    expect(loadSavedPositions('gv_x')).toEqual({});
  });
});

describe('ConceptGraph toolbar and layout modes', () => {
  it('renders toolbar controls, summary, and hides edge labels by default', async () => {
    renderGraph();
    expect(await screen.findByLabelText('布局模式')).toHaveValue('network');
    expect(screen.getByRole('button', { name: '适配视图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新布局' })).toBeInTheDocument();
    expect(screen.getByLabelText('搜索概念')).toBeInTheDocument();
    expect(screen.getByLabelText('图谱概要')).toHaveTextContent(
      '文档 1 · 概念 3 · 关系 1 · 薄弱 1',
    );
    // Edge labels are opt-in.
    expect(document.querySelector('.react-flow__edge-text')).toBeNull();
  });

  it('shows edge labels after the explicit toggle', async () => {
    const user = userEvent.setup();
    renderGraph();
    await user.click(await screen.findByRole('button', { name: '显示关系标签' }));
    await waitFor(() => {
      expect(document.querySelector('.react-flow__edge-text')).not.toBeNull();
    });
    expect(screen.getByRole('button', { name: '隐藏关系标签' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches between 网络视图 and 依赖视图 while keeping all nodes', async () => {
    const user = userEvent.setup();
    renderGraph();
    await screen.findByText('工作记忆');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'dependency');
    expect(screen.getByText('工作记忆')).toBeInTheDocument();
    expect(screen.getByText('间隔重复')).toBeInTheDocument();
    expect(screen.getByText('提取练习')).toBeInTheDocument();
  });

  it('薄弱路径 shows only weak concepts, their path, and neighbors', async () => {
    const user = userEvent.setup();
    renderGraph();
    await screen.findByText('提取练习');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'weak-path');
    expect(screen.getByText('工作记忆')).toBeInTheDocument();
    expect(screen.getByText('间隔重复')).toBeInTheDocument();
    expect(screen.queryByText('提取练习')).not.toBeInTheDocument();
  });

  it('hides unassessed concepts on toggle but keeps assessed ones', async () => {
    const user = userEvent.setup();
    renderGraph();
    await screen.findByText('间隔重复');
    await user.click(screen.getByRole('button', { name: '隐藏未评估' }));
    expect(screen.getByText('工作记忆')).toBeInTheDocument();
    expect(screen.queryByText('间隔重复')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '显示未评估' }));
    expect(screen.getByText('间隔重复')).toBeInTheDocument();
  });
});

describe('ConceptGraph search', () => {
  it('suggests matches and selects + reveals the picked concept', async () => {
    const user = userEvent.setup();
    const { onSelectNode } = renderGraph();
    await user.type(await screen.findByLabelText('搜索概念'), '工作');
    const results = screen.getByLabelText('搜索结果');
    await user.click(within(results).getByRole('button', { name: /工作记忆/ }));
    expect(onSelectNode).toHaveBeenCalledWith('con_0');
    // The query resets after picking.
    expect(screen.getByLabelText('搜索概念')).toHaveValue('');
  });

  it('reports when nothing matches', async () => {
    const user = userEvent.setup();
    renderGraph();
    await user.type(await screen.findByLabelText('搜索概念'), '不存在的概念');
    expect(screen.getByText('没有匹配的概念。')).toBeInTheDocument();
  });
});

describe('ConceptGraph hover, selection, and focus', () => {
  it('dims unrelated nodes and shows a tooltip while hovering', async () => {
    renderGraph();
    await screen.findByText('工作记忆');
    fireEvent.mouseEnter(nodeWrapper('工作记忆'));
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });
    expect(nodeWrapper('间隔重复').className).not.toContain('dimmed');
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('工作记忆');
    expect(tooltip).toHaveTextContent('薄弱 · 掌握 47%');
    expect(tooltip).toHaveTextContent('关系 1 条 · 未解决错题 1 道');

    fireEvent.mouseLeave(nodeWrapper('工作记忆'));
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
    expect(nodeWrapper('提取练习').className).not.toContain('dimmed');
  });

  it('selects nodes on click and keeps the neighborhood highlighted', async () => {
    const { onSelectNode } = renderGraph({ selectedNodeId: 'con_0' });
    await screen.findByText('工作记忆');
    expect(nodeWrapper('提取练习').className).toContain('dimmed');
    fireEvent.click(screen.getByText('间隔重复'));
    expect(onSelectNode).toHaveBeenCalledWith('con_1');
  });

  it('highlights a selected edge and dims unrelated concepts', async () => {
    renderGraph({ selectedEdgeId: 'ge_1' });
    await screen.findByText('工作记忆');
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });
    expect(nodeWrapper('工作记忆').className).not.toContain('dimmed');
    expect(nodeWrapper('间隔重复').className).not.toContain('dimmed');
  });

  it('enters and leaves 聚焦邻域 via double-click and 返回全图', async () => {
    const user = userEvent.setup();
    const { onSelectNode } = renderGraph();
    await screen.findByText('工作记忆');
    fireEvent.doubleClick(nodeWrapper('工作记忆'));
    expect(onSelectNode).toHaveBeenCalledWith('con_0');
    expect(await screen.findByText(/聚焦邻域:/)).toBeInTheDocument();
    // One hop keeps the neighbor, drops the unrelated concept.
    expect(screen.getByText('间隔重复')).toBeInTheDocument();
    expect(screen.queryByText('提取练习')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回全图' }));
    expect(screen.getByText('提取练习')).toBeInTheDocument();
    expect(screen.queryByText(/聚焦邻域:/)).not.toBeInTheDocument();
  });
});

describe('ConceptGraph saved positions', () => {
  it('restores saved node positions for the active graph version', async () => {
    savePositions('gv_1', { con_0: { x: 333, y: 222 } });
    renderGraph();
    await screen.findByText('工作记忆');
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).toContain('translate(333px,222px)');
    });
  });

  it('重新布局 clears saved positions and re-runs the deterministic layout', async () => {
    savePositions('gv_1', { con_0: { x: 333, y: 222 } });
    const user = userEvent.setup();
    renderGraph();
    await screen.findByText('工作记忆');
    await user.click(screen.getByRole('button', { name: '重新布局' }));
    expect(loadSavedPositions('gv_1')).toEqual({});
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).not.toContain('translate(333px,222px)');
    });
  });
});
