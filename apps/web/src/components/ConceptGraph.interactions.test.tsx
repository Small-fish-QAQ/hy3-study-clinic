import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** One canonical element builder, so rerenders exercise real prop refreshes. */
function graphElement(overrides: Partial<Parameters<typeof ConceptGraph>[0]> = {}) {
  return (
    <ConceptGraph
      concepts={overrides.concepts ?? concepts}
      edges={overrides.edges ?? graphEdges}
      overlay={overrides.overlay ?? overlay}
      selectedNodeId={overrides.selectedNodeId ?? null}
      selectedEdgeId={overrides.selectedEdgeId ?? null}
      onSelectNode={overrides.onSelectNode ?? vi.fn()}
      onSelectEdge={overrides.onSelectEdge ?? vi.fn()}
      versionId={overrides.versionId ?? 'gv_1'}
      planTargetIds={overrides.planTargetIds}
      summary={overrides.summary ?? null}
    />
  );
}

function renderGraph(props: Partial<Parameters<typeof ConceptGraph>[0]> = {}) {
  const onSelectNode = vi.fn();
  const onSelectEdge = vi.fn();
  const view = render(graphElement({ onSelectNode, onSelectEdge, ...props }));
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

/**
 * Starts a real pointer drag on a node and GUARANTEES the gesture ends: the
 * terminating mouseUp fires even when an assertion inside `body` throws. An
 * un-terminated d3-drag gesture leaves its mousemove/mouseup listeners on
 * the window; the next test's mouseup (user-event constructs events whose
 * `view` is null) then crashes inside d3-drag's nodrag.js and pollutes an
 * unrelated test. mouseDown lands on the node wrapper; moves target the
 * window, mirroring React Flow's real listener setup. React Flow consumes
 * the first movement to pass the drag threshold and initialize the gesture,
 * so continuous position changes flow from the second move on.
 */
async function withNodeDrag(
  name: string,
  body: (drag: {
    moveTo: (clientX: number, clientY: number) => void;
    start: string;
  }) => Promise<void> | void,
): Promise<void> {
  const wrapper = nodeWrapper(name);
  const start = wrapper.style.transform;
  let last = { x: 100, y: 100 };
  fireEvent.mouseDown(wrapper, { button: 0, clientX: last.x, clientY: last.y });
  try {
    await body({
      start,
      moveTo: (clientX: number, clientY: number) => {
        last = { x: clientX, y: clientY };
        fireEvent.mouseMove(window, { clientX, clientY, buttons: 1 });
      },
    });
  } finally {
    fireEvent.mouseUp(window, { clientX: last.x, clientY: last.y });
  }
}

/** Multi-step drag that waits for each streamed position to render. */
async function dragNode(name: string, dx: number, dy: number, steps = 3): Promise<string[]> {
  const during: string[] = [];
  await withNodeDrag(name, async ({ moveTo, start }) => {
    // Threshold-consuming first movement (gesture initialization).
    moveTo(104, 103);
    for (let i = 1; i <= steps; i++) {
      moveTo(104 + (dx * i) / steps, 103 + (dy * i) / steps);
      await waitFor(() => {
        // The controlled node must follow BEFORE the pointer is released.
        expect(nodeWrapper(name).style.transform).not.toBe(during[during.length - 1] ?? start);
      });
      during.push(nodeWrapper(name).style.transform);
    }
  });
  return during;
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
  it('applies position changes continuously and persists only on drag stop', async () => {
    renderGraph();
    await waitForInitialFit();
    await withNodeDrag('工作记忆', async ({ moveTo, start }) => {
      // React Flow consumes the first movement to pass the drag threshold
      // and initialize the gesture; continuous position changes flow from
      // the second pointer movement on (matching a real pointer stream).
      moveTo(120, 115);
      moveTo(140, 130);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
      });
      // Mid-drag: in-memory position moved, nothing persisted yet.
      const midDrag = nodeWrapper('工作记忆').style.transform;
      expect(loadSavedPositions('gv_1')).toEqual({});

      moveTo(180, 160);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(midDrag);
      });
    });
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
    await withNodeDrag('工作记忆', async ({ moveTo, start }) => {
      moveTo(118, 112);
      moveTo(160, 150);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
      });
      const midDrag = nodeWrapper('工作记忆').style.transform;

      // Simulate a stale-layout hazard: the overlay refetch produces a new
      // Map identity (as after grading refresh) while the drag is active.
      view.rerender(graphElement({ overlay: new Map(overlay) }));
      expect(nodeWrapper('工作记忆').style.transform).toBe(midDrag);
    });
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

describe('semantic-only refresh during active drag', () => {
  /** Overlay rebuilt with fresh identities and one concept's state patched. */
  function overlayWith(
    conceptId: string,
    patch: Partial<ConceptLearnerState>,
  ): Map<string, ConceptLearnerState> {
    return new Map(
      [...overlay.entries()].map(([id, state]) =>
        id === conceptId ? [id, { ...state, ...patch }] : [id, { ...state }],
      ),
    );
  }

  interface RefreshCase {
    label: string;
    overrides: () => Partial<Parameters<typeof ConceptGraph>[0]>;
    /** Node label after the refresh (alias promotion renames the card). */
    labelAfter?: string;
    /** Proves the semantic payload applied while the geometry held still. */
    check?: (node: () => HTMLElement) => void;
  }

  const cases: RefreshCase[] = [
    {
      label: 'mastery change after grading',
      overrides: () => ({ overlay: overlayWith('con_0', { mastery: 0.87 }) }),
      check: (node) => expect(node().textContent).toContain('87%'),
    },
    {
      label: 'open-mistake count change',
      overrides: () => ({ overlay: overlayWith('con_0', { openMistakes: 5 }) }),
      check: (node) => expect(node().querySelector('.mistake-badge')?.textContent).toBe('5'),
    },
    {
      label: 'review metadata change (activity becomes sufficient)',
      overrides: () => ({
        overlay: overlayWith('con_0', { hasEnoughActivity: true, lastScore: 0.9 }),
      }),
      check: (node) => expect(node().textContent).not.toContain('证据不足'),
    },
    {
      label: 'learner-state transition 薄弱 → 进步中',
      overrides: () => ({
        overlay: overlayWith('con_0', { state: 'developing', treatAsWeak: false }),
      }),
      check: (node) => expect(node().textContent).toContain('进步中'),
    },
    {
      // Misconception counts render outside the graph canvas: after a
      // misconception refresh the graph itself receives value-identical
      // props with fresh identities — which must be geometry-inert too.
      label: 'misconception metadata refresh (identity-only props)',
      overrides: () => ({
        concepts: concepts.map((c) => ({ ...c })),
        edges: graphEdges.map((e) => ({ ...e })),
        overlay: new Map(overlay),
      }),
    },
    {
      label: 'Tutor-path highlight change',
      overrides: () => ({ planTargetIds: new Set(['con_0']) }),
      // The plan-target emphasis renders on the inner concept card.
      check: (node) =>
        expect(node().querySelector('.concept-node')?.className).toContain('plan-target'),
    },
    {
      label: 'alias metadata change with unchanged canonical membership',
      overrides: () => ({
        concepts: concepts.map((c) =>
          c.id === 'con_0' ? { ...c, name: '工作记忆(短时记忆)' } : { ...c },
        ),
      }),
      labelAfter: '工作记忆(短时记忆)',
      check: (node) => expect(node().textContent).toContain('工作记忆(短时记忆)'),
    },
  ];

  it.each(cases)('$label keeps the dragged node exactly in place', async (refresh) => {
    const { view } = renderGraph();
    await waitForInitialFit();
    const labelNow = () => refresh.labelAfter ?? '工作记忆';
    await withNodeDrag('工作记忆', async ({ moveTo, start }) => {
      moveTo(118, 112);
      moveTo(160, 150);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
      });
      const midDrag = nodeWrapper('工作记忆').style.transform;
      view.rerender(graphElement(refresh.overrides()));
      // The refresh may update node data but never coordinates.
      expect(nodeWrapper(labelNow()).style.transform).toBe(midDrag);
      refresh.check?.(() => nodeWrapper(labelNow()));
    });
    // Exactly one persistence write on drag stop, at the rendered position.
    await waitFor(() => {
      const saved = loadSavedPositions('gv_1');
      expect(Object.keys(saved)).toEqual(['con_0']);
      expect(nodeWrapper(labelNow()).style.transform).toBe(
        `translate(${saved.con_0!.x}px,${saved.con_0!.y}px)`,
      );
    });
  });
});

describe('canonical-membership change during active drag', () => {
  /**
   * Explicit policy (mirrored in ConceptGraph): when the dragged concept's
   * id leaves the concept set mid-gesture (canonical merge or deletion),
   * the drag aborts safely — transient drag state is released, nothing is
   * persisted for removed ids, and the abandoned in-gesture position is
   * dropped so a re-created id renders from the deterministic layout again.
   */
  const conceptsWithoutDragged = () => concepts.filter((c) => c.id !== 'con_0');

  it('aborts cleanly when the dragged concept is merged away and movement continues', async () => {
    const { view } = renderGraph();
    await waitForInitialFit();
    let base = '';
    await withNodeDrag('工作记忆', async ({ moveTo, start }) => {
      base = start;
      moveTo(118, 112);
      moveTo(160, 150);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
      });
      // Canonical merge removes the dragged concept; the edge referencing
      // it is filtered out with it.
      view.rerender(graphElement({ concepts: conceptsWithoutDragged() }));
      expect(screen.queryByText('工作记忆')).not.toBeInTheDocument();
      // Movement after the removal must be inert and crash-free.
      moveTo(220, 200);
      expect(screen.queryByText('工作记忆')).not.toBeInTheDocument();
    });
    // Nothing was persisted for the removed concept.
    expect(loadSavedPositions('gv_1')).toEqual({});
    // Transient drag state is fully released: hover responds again.
    fireEvent.mouseEnter(nodeWrapper('间隔重复'), { clientX: 20, clientY: 20 });
    await screen.findByRole('tooltip');
    fireEvent.mouseLeave(nodeWrapper('间隔重复'));
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
    // A re-created id renders from the deterministic base layout again,
    // never from the abandoned mid-drag position.
    view.rerender(graphElement());
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).toBe(base);
    });
  });

  it('releasing the pointer right after the merge persists nothing and keeps the graph alive', async () => {
    const { view } = renderGraph();
    await waitForInitialFit();
    let base = '';
    await withNodeDrag('工作记忆', async ({ moveTo, start }) => {
      base = start;
      moveTo(118, 112);
      moveTo(160, 150);
      await waitFor(() => {
        expect(nodeWrapper('工作记忆').style.transform).not.toBe(start);
      });
      view.rerender(graphElement({ concepts: conceptsWithoutDragged() }));
      // The helper's finally releases the pointer with no further movement:
      // React Flow ends the gesture with no surviving dragged node.
    });
    expect(loadSavedPositions('gv_1')).toEqual({});
    expect(nodeWrapper('间隔重复')).toBeInTheDocument();
    // Restoring the concept renders the deterministic layout position and
    // the next gesture works normally after the aborted one.
    view.rerender(graphElement());
    await waitFor(() => {
      expect(nodeWrapper('工作记忆').style.transform).toBe(base);
    });
    await dragNode('工作记忆', 60, 40);
    await waitFor(() => {
      expect(Object.keys(loadSavedPositions('gv_1'))).toContain('con_0');
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

describe('edge casing and crossing legibility', () => {
  it('renders a casing under-stroke beneath each colored stroke on the same path', async () => {
    renderGraph();
    await waitForInitialFit();
    await waitFor(() => {
      expect(document.querySelector('.learning-edge')).not.toBeNull();
      expect(document.querySelector('.learning-edge-casing')).not.toBeNull();
    });
    const casing = document.querySelector<SVGPathElement>('.learning-edge-casing')!;
    const main = document.querySelector<SVGPathElement>('.learning-edge')!;
    // Identical geometry: the casing is the same routed path, only wider.
    expect(casing.getAttribute('d')).toBe(main.getAttribute('d'));
    // The casing paints first (beneath the colored stroke and its marker).
    expect(casing.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Number(casing.getAttribute('stroke-width'))).toBeGreaterThan(
      Number.parseFloat(main.style.strokeWidth),
    );
  });

  it('takes its color from the theme token, not a hardcoded background', async () => {
    renderGraph();
    await waitForInitialFit();
    await waitFor(() => {
      expect(document.querySelector('.learning-edge-casing')).not.toBeNull();
    });
    const casing = document.querySelector<SVGPathElement>('.learning-edge-casing')!;
    // No inline stroke: the color comes from the stylesheet token so themes
    // can restyle the canvas without touching the component.
    expect(casing.getAttribute('stroke')).toBeNull();
    expect(casing.style.stroke).toBe('');
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).toContain('--graph-edge-casing');
    expect(css).toMatch(/\.learning-edge-casing\s*\{[^}]*var\(--graph-edge-casing\)/);
    // Casing transitions are declared with a reduced-motion override.
    expect(css).toMatch(/prefers-reduced-motion[^}]*\{[^{]*\.learning-edge-group/s);
  });

  it('keeps nodes above all edge strokes and the selected edge painted last', async () => {
    renderGraph({ edges: [...graphEdges, causesEdge], selectedEdgeId: 'ge_1' });
    await waitForInitialFit();
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge').length).toBe(2);
    });
    // React Flow paints the edge SVG layer before the node layer; none of
    // our edges may opt into an elevated z-index layer above the cards.
    const edgesLayer = document.querySelector('.react-flow__edges')!;
    const nodesLayer = document.querySelector('.react-flow__nodes')!;
    expect(
      edgesLayer.compareDocumentPosition(nodesLayer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const edge of document.querySelectorAll<HTMLElement>('.react-flow__edge')) {
      expect(edge.style.zIndex === '' || edge.style.zIndex === '0').toBe(true);
    }
    // Paint order within the edge layer: the selected edge renders last.
    const rendered = [...document.querySelectorAll('.react-flow__edge')];
    expect(rendered[rendered.length - 1]!.getAttribute('data-id')).toBe('ge_1');
  });

  it('hover restyles edges without rerouting them', async () => {
    renderGraph();
    await waitForInitialFit();
    const pathD = () =>
      document.querySelector<SVGPathElement>('.learning-edge')?.getAttribute('d') ?? '';
    await waitFor(() => {
      expect(pathD()).not.toBe('');
    });
    const before = pathD();
    fireEvent.mouseEnter(nodeWrapper('工作记忆'), { clientX: 30, clientY: 30 });
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).toContain('dimmed');
    });
    expect(pathD()).toBe(before);
    fireEvent.mouseLeave(nodeWrapper('工作记忆'));
    await waitFor(() => {
      expect(nodeWrapper('提取练习').className).not.toContain('dimmed');
    });
    expect(pathD()).toBe(before);
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
