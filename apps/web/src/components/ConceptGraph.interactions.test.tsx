import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Concept, ConceptLearnerState, GraphEdge } from '@hy3-clinic/shared';
import { ConceptGraph } from './ConceptGraph';
import { loadSavedPositions, savePositions } from './graph/layout';
import { graphConcepts, graphEdges, overlayStates, T0 } from '../test/fixtures';

/**
 * Interaction regressions for the six reported graph defects: hover
 * flicker, non-realtime dragging, disappearing graph, missing initial fit,
 * weak-path filtering, and arrow/marker rendering.
 */

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

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

/** A causes edge between two weak-path members — must vanish in 薄弱路径. */
const causesEdge: GraphEdge = {
  ...graphEdges[0]!,
  id: 'ge_causes',
  relation: 'causes',
  sourceConceptId: 'con_0',
  targetConceptId: 'con_1',
};

function renderGraph(props: Partial<Parameters<typeof ConceptGraph>[0]> = {}) {
  const onSelectNode = vi.fn();
  const onSelectEdge = vi.fn();
  const view = render(
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
      summary={props.summary ?? null}
    />,
  );
  return { onSelectNode, onSelectEdge, view };
}

function nodeWrapper(name: string): HTMLElement {
  for (const label of screen.getAllByText(name)) {
    const wrapper = label.closest('.react-flow__node');
    if (wrapper instanceof HTMLElement) return wrapper;
  }
  throw new Error(`node wrapper for ${name} not found`);
}

function nodeTransforms(): Map<string, string> {
  return new Map(
    [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((el) => [
      el.getAttribute('data-id') ?? '',
      el.style.transform,
    ]),
  );
}

function viewportTransform(): string {
  return document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? 'missing';
}

function parseViewport(transform: string): [number, number, number] | null {
  const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

async function waitForInitialFit(): Promise<string> {
  await screen.findByText('工作记忆');
  await waitFor(
    () => {
      const parsed = parseViewport(viewportTransform());
      expect(parsed).not.toBeNull();
      // Identity (0,0,1) means the automatic fit has not applied yet.
      expect(parsed![0] !== 0 || parsed![1] !== 0 || parsed![2] !== 1).toBe(true);
    },
    { timeout: 4000 },
  );
  return viewportTransform();
}

describe('hover stability (defects 1 & 3)', () => {
  it('the tooltip is purely informational and cannot intercept pointer input', async () => {
    renderGraph();
    await screen.findByText('工作记忆');
    fireEvent.mouseEnter(nodeWrapper('工作记忆'), { clientX: 40, clientY: 40 });
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.style.pointerEvents).toBe('none');
  });

  it('hover changes neither node positions, nor the viewport, nor the visible-node set', async () => {
    renderGraph();
    const fitted = await waitForInitialFit();
    const before = nodeTransforms();
    expect(before.size).toBe(3);

    fireEvent.mouseEnter(nodeWrapper('工作记忆'), { clientX: 30, clientY: 30 });
    await screen.findByRole('tooltip');
    fireEvent.mouseMove(nodeWrapper('工作记忆'), { clientX: 36, clientY: 33 });
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });

    const during = nodeTransforms();
    expect(during).toEqual(before);
    expect(viewportTransform()).toBe(fitted);
    expect(document.querySelectorAll('.react-flow__node').length).toBe(3);
  });

  it('repeated hover across every node never removes graph elements', async () => {
    renderGraph();
    await waitForInitialFit();
    const names = ['工作记忆', '间隔重复', '提取练习'];
    for (let round = 0; round < 3; round++) {
      for (const name of names) {
        fireEvent.mouseEnter(nodeWrapper(name), { clientX: 10, clientY: 10 });
        fireEvent.mouseLeave(nodeWrapper(name));
      }
    }
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
    expect(document.querySelectorAll('.react-flow__node').length).toBe(3);
    expect(document.querySelectorAll('.react-flow__edge').length).toBe(1);
    // No node is left permanently dimmed after hover clears.
    expect(document.querySelectorAll('.react-flow__node.dimmed').length).toBe(0);
  });

  it('sustained hover state keeps every intended element mounted', async () => {
    renderGraph();
    await waitForInitialFit();
    fireEvent.mouseEnter(nodeWrapper('工作记忆'), { clientX: 20, clientY: 20 });
    await screen.findByRole('tooltip');
    // Simulate a long hover: many timer flushes with the pointer parked.
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(document.querySelectorAll('.react-flow__node').length).toBe(3);
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    }
    // Dimmed nodes stay visible (transient emphasis, never opacity 0).
    expect(nodeWrapper('提取练习').className).toContain('dimmed');
    fireEvent.mouseLeave(nodeWrapper('工作记忆'));
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).not.toContain('dimmed');
    });
  });
});

describe('controlled real-time dragging (defect 2)', () => {
  async function dragNode(name: string, dx: number, dy: number, steps = 3) {
    const wrapper = nodeWrapper(name);
    const start = wrapper.style.transform;
    fireEvent.mouseDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
    // Threshold-consuming first movement (gesture initialization).
    fireEvent.mouseMove(window, { clientX: 104, clientY: 103, buttons: 1 });
    const during: string[] = [];
    for (let i = 1; i <= steps; i++) {
      fireEvent.mouseMove(window, {
        clientX: 104 + (dx * i) / steps,
        clientY: 103 + (dy * i) / steps,
        buttons: 1,
      });
      await waitFor(() => {
        // The controlled node must follow BEFORE the pointer is released.
        expect(nodeWrapper(name).style.transform).not.toBe(during[during.length - 1] ?? start);
      });
      during.push(nodeWrapper(name).style.transform);
    }
    fireEvent.mouseUp(window, { clientX: 104 + dx, clientY: 103 + dy });
    return during;
  }

  it('applies position changes continuously and persists only on drag stop', async () => {
    renderGraph();
    await waitForInitialFit();
    const before = nodeWrapper('工作记忆').style.transform;

    const wrapper = nodeWrapper('工作记忆');
    fireEvent.mouseDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
    // React Flow consumes the first movement to pass the drag threshold and
    // initialize the gesture; continuous position changes flow from the
    // second pointer movement on (matching a real pointer stream).
    fireEvent.mouseMove(window, { clientX: 120, clientY: 115, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 140, clientY: 130, buttons: 1 });
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).not.toBe(before);
    });
    // Mid-drag: in-memory position moved, nothing persisted yet.
    const midDrag = nodeWrapper('工作记忆').style.transform;
    expect(loadSavedPositions('gv_1')).toEqual({});

    fireEvent.mouseMove(window, { clientX: 180, clientY: 160, buttons: 1 });
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).not.toBe(midDrag);
    });

    fireEvent.mouseUp(window, { clientX: 180, clientY: 160 });
    await waitFor(() => {
      const saved = loadSavedPositions('gv_1');
      expect(Object.keys(saved)).toContain('con_0');
      // No snap-back on release: the node renders exactly the persisted
      // position (retry-tolerant against trailing drag-stop change events).
      expect(nodeWrapper('工作记忆').style.transform).toBe(
        `translate(${saved.con_0!.x}px,${saved.con_0!.y}px)`,
      );
    });
  });

  it('updates attached edge geometry during the same drag', async () => {
    renderGraph();
    await waitForInitialFit();
    const path = () =>
      document.querySelector<SVGPathElement>('.learning-edge')?.getAttribute('d') ?? '';
    await waitFor(() => {
      expect(path()).not.toBe('');
    });
    const beforePath = path();
    await dragNode('工作记忆', 90, 50);
    expect(path()).not.toBe(beforePath);
  });

  it('a semantic-data refresh mid-drag cannot snap the node back', async () => {
    const { view } = renderGraph();
    await waitForInitialFit();
    const start = nodeWrapper('工作记忆').style.transform;
    const wrapper = nodeWrapper('工作记忆');
    fireEvent.mouseDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 118, clientY: 112, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 150, buttons: 1 });
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
    });
    const midDrag = nodeWrapper('工作记忆').style.transform;

    // Simulate a stale-layout hazard: the overlay refetch produces a new
    // Map identity (as after grading refresh) while the drag is active.
    view.rerender(
      <ConceptGraph
        concepts={concepts}
        edges={graphEdges}
        overlay={new Map(overlay)}
        selectedNodeId={null}
        selectedEdgeId={null}
        onSelectNode={vi.fn()}
        onSelectEdge={vi.fn()}
        versionId="gv_1"
        summary={null}
      />,
    );
    expect(nodeWrapper('工作记忆').style.transform).toBe(midDrag);
    fireEvent.mouseUp(window, { clientX: 160, clientY: 150 });
  });

  it('restores saved positions on mount and 重新布局 clears them', async () => {
    savePositions('gv_1', { con_0: { x: 333, y: 222 } });
    const user = userEvent.setup();
    renderGraph();
    await screen.findByText('工作记忆');
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).toContain('translate(333px,222px)');
    });
    await user.click(screen.getByRole('button', { name: '重新布局' }));
    expect(loadSavedPositions('gv_1')).toEqual({});
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).not.toContain('translate(333px,222px)');
    });
  });
});

describe('initial fit (defect 4)', () => {
  it('fits automatically once nodes measure — without any interaction', async () => {
    renderGraph();
    const fitted = await waitForInitialFit();
    expect(parseViewport(fitted)).not.toBeNull();
  });

  it('selection and hover never re-fit the viewport', async () => {
    const { view } = renderGraph();
    const fitted = await waitForInitialFit();

    fireEvent.mouseEnter(nodeWrapper('间隔重复'), { clientX: 15, clientY: 15 });
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });
    expect(viewportTransform()).toBe(fitted);
    fireEvent.mouseLeave(nodeWrapper('间隔重复'));

    view.rerender(
      <ConceptGraph
        concepts={concepts}
        edges={graphEdges}
        overlay={overlay}
        selectedNodeId="con_0"
        selectedEdgeId={null}
        onSelectNode={vi.fn()}
        onSelectEdge={vi.fn()}
        versionId="gv_1"
        summary={null}
      />,
    );
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });
    expect(viewportTransform()).toBe(fitted);
  });

  it('ordinary dragging does not re-fit the viewport', async () => {
    renderGraph();
    const fitted = await waitForInitialFit();
    const wrapper = nodeWrapper('工作记忆');
    fireEvent.mouseDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 140, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 150, clientY: 140 });
    await waitFor(() => {
      expect(Object.keys(loadSavedPositions('gv_1')).length).toBeGreaterThan(0);
    });
    expect(viewportTransform()).toBe(fitted);
  });
});

describe('薄弱路径 mode (defect 5)', () => {
  it('shows fewer nodes and drops non-remediation relations', async () => {
    const user = userEvent.setup();
    renderGraph({ edges: [...graphEdges, causesEdge] });
    await screen.findByText('工作记忆');
    expect(document.querySelectorAll('.react-flow__edge').length).toBe(2);

    await user.selectOptions(screen.getByLabelText('布局模式'), 'weak-path');
    // Weak concept + its prerequisite dependent stay; unrelated concept and
    // the causes edge disappear even though its endpoints remain visible.
    expect(screen.getByText('工作记忆')).toBeInTheDocument();
    expect(screen.getByText('间隔重复')).toBeInTheDocument();
    expect(screen.queryByText('提取练习')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge').length).toBe(1);
    });
    expect(screen.getByLabelText('薄弱路径说明')).toHaveTextContent('薄弱路径:显示 2/3 个概念');
  });

  it('explains when the minimal path covers the whole graph', async () => {
    const user = userEvent.setup();
    renderGraph({ concepts: graphConcepts });
    await screen.findByText('工作记忆');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'weak-path');
    expect(screen.getByLabelText('薄弱路径说明')).toHaveTextContent(
      '当前最小补救路径恰好覆盖整个图谱',
    );
  });

  it('switching modes never mutates persisted graph data or saved positions', async () => {
    savePositions('gv_1', { con_0: { x: 50, y: 60 } });
    const user = userEvent.setup();
    const edgesProp = [...graphEdges, causesEdge];
    const snapshot = JSON.stringify(edgesProp);
    renderGraph({ edges: edgesProp });
    await screen.findByText('工作记忆');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'weak-path');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'dependency');
    await user.selectOptions(screen.getByLabelText('布局模式'), 'network');
    expect(JSON.stringify(edgesProp)).toBe(snapshot);
    expect(loadSavedPositions('gv_1')).toEqual({ con_0: { x: 50, y: 60 } });
  });
});

describe('arrowheads and edge markers (defect 6)', () => {
  it('defines one small stable marker per directional relation', async () => {
    renderGraph();
    await screen.findByText('工作记忆');
    const prerequisite = document.getElementById('hy3-arrow-prerequisite');
    const strong = document.getElementById('hy3-arrow-prerequisite-strong');
    expect(prerequisite).not.toBeNull();
    expect(strong).not.toBeNull();
    expect(Number(prerequisite!.getAttribute('markerWidth'))).toBeLessThanOrEqual(8);
    expect(Number(strong!.getAttribute('markerWidth'))).toBeLessThanOrEqual(10);
    // The tip (refX = markerWidth) lands exactly on the path end, which the
    // router terminates at the target node boundary.
    expect(prerequisite!.getAttribute('refX')).toBe(prerequisite!.getAttribute('markerWidth'));
    // contrasts_with is non-directional: no marker may exist for it.
    expect(document.getElementById('hy3-arrow-contrasts_with')).toBeNull();
  });

  it('normal edges use the small marker; selected edges the strong one', async () => {
    const { view } = renderGraph();
    await screen.findByText('工作记忆');
    const edgePath = () => document.querySelector<SVGPathElement>('.learning-edge');
    await waitFor(() => {
      expect(edgePath()).not.toBeNull();
    });
    expect(edgePath()!.getAttribute('marker-end')).toBe('url(#hy3-arrow-prerequisite)');

    view.rerender(
      <ConceptGraph
        concepts={concepts}
        edges={graphEdges}
        overlay={overlay}
        selectedNodeId={null}
        selectedEdgeId="ge_1"
        onSelectNode={vi.fn()}
        onSelectEdge={vi.fn()}
        versionId="gv_1"
        summary={null}
      />,
    );
    await waitFor(() => {
      expect(edgePath()!.getAttribute('marker-end')).toBe('url(#hy3-arrow-prerequisite-strong)');
    });
  });

  it('renders contrasts_with without any arrow direction', async () => {
    const contrastOnly: GraphEdge = { ...graphEdges[0]!, id: 'ge_c', relation: 'contrasts_with' };
    renderGraph({ edges: [contrastOnly] });
    await screen.findByText('工作记忆');
    await waitFor(() => {
      expect(document.querySelector('.learning-edge')).not.toBeNull();
    });
    const path = document.querySelector<SVGPathElement>('.learning-edge')!;
    expect(path.getAttribute('marker-end')).toBeNull();
    expect(path.getAttribute('marker-start')).toBeNull();
  });
});
