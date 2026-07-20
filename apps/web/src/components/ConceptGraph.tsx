import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Concept, ConceptLearnerState, GraphEdge, GraphRelation } from '@hy3-clinic/shared';
import {
  computeDependencyLayout,
  computeForceLayout,
  degreeByConcept,
  degreeScale,
  estimateNodeSize,
  hashId,
  loadSavedPositions,
  neighborhoodConceptIds,
  savePositions,
  weakPathSubgraph,
  type LayoutMode,
} from './graph/layout.js';
import {
  EdgeMarkerDefs,
  FloatingLearningEdge,
  type EdgeEmphasis,
  type LearningFlowEdge,
} from './graph/FloatingLearningEdge.js';
import { planEdgeLanes, planNodeEdgeOrder } from './graph/edgeRouting.js';
import { planGraphRoutes, type GraphRoutePlan } from './graph/routePlan.js';
import type { Rect } from './graph/edgeGeometry.js';
import { RELATION_COLORS, RELATION_DASH, RELATION_LABELS } from './graph/relationStyle.js';

/**
 * Interactive personal learning graph (Obsidian-style exploration).
 *
 * Rendering stays on @xyflow/react (React Flow 12); the default 网络视图
 * layout is computed by d3-force in a bounded synchronous pass (see
 * graph/layout.ts). Node dragging is fully controlled: position changes are
 * applied continuously during the gesture (applyNodeChanges-equivalent for
 * position changes) and persisted to localStorage once on drag stop.
 * Edges are floating, obstacle-aware paths (see graph/FloatingLearningEdge).
 *
 * State layers are kept strictly separate: semantic data → visibility →
 * deterministic layout → saved positions → active drag positions → edge
 * geometry → hover → selection → viewport. Hover and selection only restyle;
 * they can never re-run layout, refit the viewport, or move nodes.
 */

export { RELATION_LABELS } from './graph/relationStyle.js';

const STATE_LABELS: Record<ConceptLearnerState['state'], string> = {
  unassessed: '未评估',
  weak: '薄弱',
  developing: '进步中',
  stable: '稳固',
};

const LAYOUT_MODE_LABELS: Record<LayoutMode, string> = {
  network: '网络视图',
  dependency: '依赖视图',
  'weak-path': '薄弱路径',
};

export interface GraphSummaryInfo {
  documentCount: number;
  weakCount: number;
  acceptedCount: number | null;
  rejectedCount: number | null;
}

export interface ConceptGraphProps {
  concepts: Concept[];
  edges: GraphEdge[];
  /** Learner overlay keyed by conceptId (may be empty while loading). */
  overlay: Map<string, ConceptLearnerState>;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (conceptId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  /** Active graph version — keys saved node positions and layout resets. */
  versionId: string | null;
  /** Concept IDs targeted by the currently displayed remediation plan. */
  planTargetIds?: ReadonlySet<string>;
  /** Bump to re-fit the viewport (panel collapse/expand, shell resize). */
  refitKey?: string | number;
  /** Compact 图谱概要 numbers rendered inside the canvas. */
  summary?: GraphSummaryInfo | null;
}

interface ConceptNodeData extends Record<string, unknown> {
  name: string;
  state: ConceptLearnerState['state'] | 'unknown';
  masteryPct: number | null;
  openMistakes: number;
  degree: number;
  insufficientEvidence: boolean;
  planTarget: boolean;
  flash: boolean;
}

function motionDuration(base: number): number {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  } catch {
    // Fall through to the default duration.
  }
  return base;
}

function ConceptNode({ data, selected }: NodeProps<FlowNode<ConceptNodeData>>) {
  const stateClass = data.state === 'unknown' ? 'unassessed' : data.state;
  const scale = degreeScale(data.degree);
  return (
    <div
      className={[
        'concept-node',
        stateClass,
        selected ? 'selected' : '',
        data.state === 'weak' ? 'weak-emphasis' : '',
        data.planTarget ? 'plan-target' : '',
        data.flash ? 'search-flash' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--node-scale': scale } as CSSProperties}
      aria-label={`概念 ${data.name}(${
        data.state === 'unknown' ? '学习状态未加载' : STATE_LABELS[data.state]
      }${data.openMistakes > 0 ? `,${data.openMistakes} 道未解决错题` : ''})`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="concept-node-name">{data.name}</span>
      <span className="concept-node-meta">
        <span className={`state-dot ${stateClass}`} aria-hidden="true" />
        {data.state === 'unknown' ? '未评估' : STATE_LABELS[data.state]}
        {data.masteryPct !== null ? ` · ${data.masteryPct}%` : ''}
        {data.insufficientEvidence ? (
          <span className="evidence-hint" title="作答次数还不足以稳定评估">
            证据不足
          </span>
        ) : null}
        {data.openMistakes > 0 ? (
          <span className="mistake-badge" title={`${data.openMistakes} 道未解决错题`}>
            {data.openMistakes}
          </span>
        ) : null}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { concept: ConceptNode };
const edgeTypes = { floating: FloatingLearningEdge };

interface TooltipState {
  conceptId: string;
  x: number;
  y: number;
}

export function ConceptGraph(props: ConceptGraphProps) {
  return (
    <ReactFlowProvider>
      <ConceptGraphInner {...props} />
    </ReactFlowProvider>
  );
}

const FIT_VIEW_OPTIONS = { padding: 0.18, maxZoom: 1.35 };
const FIT_MAX_ATTEMPTS = 5;

/**
 * Fits the viewport exactly once per graph-state key (`trigger`).
 *
 * The fit only runs after React Flow reports initialized (measured) nodes
 * AND a non-zero canvas, is deferred through two animation frames so pan/zoom
 * and dimensions are committed, verifies that React Flow actually applied it
 * (bounded retries otherwise), and ignores stale callbacks once a newer
 * trigger takes over. Hover, selection, and dragging never change `trigger`,
 * so they can never cause a fit.
 */
function AutoFit({ trigger }: { trigger: string }) {
  const nodesInitialized = useNodesInitialized();
  const canvasReady = useStore((state) => state.width > 0 && state.height > 0);
  const { fitView } = useReactFlow();
  const doneRef = useRef<string | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    if (!nodesInitialized || !canvasReady) return;
    if (doneRef.current === trigger) return;
    const epoch = ++epochRef.current;
    const frames: number[] = [];
    let attempts = 0;
    const attempt = () => {
      if (epochRef.current !== epoch) return;
      attempts += 1;
      void fitView({ ...FIT_VIEW_OPTIONS, duration: motionDuration(220) }).then((applied) => {
        if (epochRef.current !== epoch) return;
        if (applied || attempts >= FIT_MAX_ATTEMPTS) {
          doneRef.current = trigger;
        } else {
          frames.push(requestAnimationFrame(attempt));
        }
      });
    };
    frames.push(
      requestAnimationFrame(() => {
        frames.push(requestAnimationFrame(attempt));
      }),
    );
    return () => {
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [nodesInitialized, canvasReady, trigger, fitView]);

  // Window resizes re-fit; panel collapse/expand arrives via `trigger`.
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        void fitView({ ...FIT_VIEW_OPTIONS, duration: motionDuration(120) });
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [fitView]);

  return null;
}

function ConceptGraphInner({
  concepts,
  edges,
  overlay,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  versionId,
  planTargetIds,
  refitKey,
  summary,
}: ConceptGraphProps) {
  const { setCenter, getZoom } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('network');
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [showUnassessed, setShowUnassessed] = useState(true);
  const [focus, setFocus] = useState<{ rootId: string; hops: 1 | 2 } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [flashNodeId, setFlashNodeId] = useState<string | null>(null);
  const [relayoutNonce, setRelayoutNonce] = useState(0);
  const [savedPositions, setSavedPositions] = useState<Record<string, { x: number; y: number }>>(
    () => (versionId ? loadSavedPositions(versionId) : {}),
  );
  /** Live positions of nodes while (and after) a drag gesture, pre-save. */
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  /**
   * Measured node dimensions fed back from React Flow. Applying dimension
   * changes onto our controlled node objects is required for React Flow to
   * consider the flow initialized (useNodesInitialized → initial fit) —
   * position and dimension changes together are the applyNodeChanges
   * contract for this derived-node design.
   */
  const [measuredSizes, setMeasuredSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const draggingRef = useRef(false);
  /**
   * Drag-gesture flag as STATE (draggingRef stays for event handlers): while
   * true, the global route plan is frozen — per-frame routing happens
   * locally in each connected edge, and one bounded cleanup plan runs on
   * drag stop.
   */
  const [dragActive, setDragActive] = useState(false);

  // Tooltip positions stream through one rAF so pointer movement costs at
  // most one state update per frame; the frame is cancelled on unmount and
  // whenever the graph version changes (no stale delayed work).
  const tooltipFrameRef = useRef(0);
  const pendingTooltipRef = useRef<TooltipState | null>(null);
  const scheduleTooltip = useCallback((next: TooltipState | null) => {
    pendingTooltipRef.current = next;
    if (tooltipFrameRef.current) return;
    tooltipFrameRef.current = requestAnimationFrame(() => {
      tooltipFrameRef.current = 0;
      setTooltip(pendingTooltipRef.current);
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(tooltipFrameRef.current);
    },
    [],
  );

  // The search flash is transient; the timer is cleaned up on re-trigger,
  // version switch, and unmount.
  useEffect(() => {
    if (!flashNodeId) return;
    const timer = window.setTimeout(() => setFlashNodeId(null), 1300);
    return () => window.clearTimeout(timer);
  }, [flashNodeId]);

  // Version switches load that version's saved positions and drop all
  // transient interaction state (focus, hover, tooltip, live drags).
  const versionRef = useRef(versionId);
  useEffect(() => {
    if (versionRef.current === versionId) return;
    versionRef.current = versionId;
    setSavedPositions(versionId ? loadSavedPositions(versionId) : {});
    setDragPositions({});
    setFocus(null);
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
    setFlashNodeId(null);
    setDragActive(false);
    draggingRef.current = false;
    scheduleTooltip(null);
  }, [versionId, scheduleTooltip]);

  const conceptIds = useMemo(() => new Set(concepts.map((c) => c.id)), [concepts]);
  const validEdges = useMemo(
    () =>
      edges.filter((e) => conceptIds.has(e.sourceConceptId) && conceptIds.has(e.targetConceptId)),
    [edges, conceptIds],
  );
  const degree = useMemo(() => degreeByConcept(concepts, validEdges), [concepts, validEdges]);

  /** 薄弱路径 minimal remediation subgraph (nodes + allowed edges). */
  const weakSubgraph = useMemo(
    () => weakPathSubgraph(concepts, validEdges, overlay),
    [concepts, validEdges, overlay],
  );

  /**
   * Which concepts are visible under the current mode/focus/toggles —
   * WITHOUT the selection carve-out, so selecting a node can never change
   * this set (and therefore can never re-fit or re-layout the graph).
   */
  const coreVisibleIds = useMemo(() => {
    let ids: Set<string>;
    if (focus) {
      ids = neighborhoodConceptIds(focus.rootId, validEdges, focus.hops);
    } else if (layoutMode === 'weak-path') {
      ids =
        weakSubgraph.conceptIds.size > 0
          ? new Set(weakSubgraph.conceptIds)
          : new Set(concepts.map((c) => c.id));
    } else {
      ids = new Set(concepts.map((c) => c.id));
    }
    if (!showUnassessed) {
      for (const concept of concepts) {
        const state = overlay.get(concept.id)?.state ?? 'unassessed';
        if (state === 'unassessed' && concept.id !== focus?.rootId) {
          ids.delete(concept.id);
        }
      }
    }
    return ids;
  }, [concepts, validEdges, overlay, layoutMode, focus, showUnassessed, weakSubgraph]);

  /** Never hide the selected concept out from under the user. */
  const visibleIds = useMemo(() => {
    if (!selectedNodeId || coreVisibleIds.has(selectedNodeId) || !conceptIds.has(selectedNodeId)) {
      return coreVisibleIds;
    }
    const ids = new Set(coreVisibleIds);
    ids.add(selectedNodeId);
    return ids;
  }, [coreVisibleIds, selectedNodeId, conceptIds]);

  const visibleConcepts = useMemo(
    () => concepts.filter((c) => visibleIds.has(c.id)),
    [concepts, visibleIds],
  );
  const visibleEdges = useMemo(() => {
    const base = validEdges.filter(
      (e) => visibleIds.has(e.sourceConceptId) && visibleIds.has(e.targetConceptId),
    );
    // 薄弱路径 additionally drops relations that are not part of the
    // remediation path (contrast/example/application/causal edges).
    if (layoutMode === 'weak-path' && !focus && weakSubgraph.conceptIds.size > 0) {
      return base.filter((e) => weakSubgraph.edgeIds.has(e.id));
    }
    return base;
  }, [validEdges, visibleIds, layoutMode, focus, weakSubgraph]);

  /** Estimated node sizes: layout collision + pre-measurement edge fallback. */
  const estimatedSizes = useMemo(
    () =>
      new Map(visibleConcepts.map((c) => [c.id, estimateNodeSize(c.name, degree.get(c.id) ?? 0)])),
    [visibleConcepts, degree],
  );

  /** Deterministic base layout for the visible subgraph. */
  const basePositions = useMemo(() => {
    if (layoutMode === 'dependency' && !focus) {
      return computeDependencyLayout(visibleConcepts, visibleEdges);
    }
    return computeForceLayout(visibleConcepts, visibleEdges, estimatedSizes);
    // relayoutNonce forces a fresh simulation on 重新布局.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleConcepts, visibleEdges, layoutMode, focus, estimatedSizes, relayoutNonce]);

  /** Neighborhood emphasis: hovered node wins, then selected node/edge. */
  const emphasis = useMemo(() => {
    const anchor = hoveredNodeId ?? selectedNodeId;
    if (anchor && conceptIds.has(anchor)) {
      const related = new Set([anchor]);
      const relatedEdges = new Set<string>();
      for (const edge of visibleEdges) {
        if (edge.sourceConceptId === anchor || edge.targetConceptId === anchor) {
          related.add(edge.sourceConceptId);
          related.add(edge.targetConceptId);
          relatedEdges.add(edge.id);
        }
      }
      return { nodes: related, edges: relatedEdges, active: true };
    }
    const selEdge = selectedEdgeId ? visibleEdges.find((e) => e.id === selectedEdgeId) : undefined;
    if (selEdge) {
      return {
        nodes: new Set([selEdge.sourceConceptId, selEdge.targetConceptId]),
        edges: new Set([selEdge.id]),
        active: true,
      };
    }
    return { nodes: new Set<string>(), edges: new Set<string>(), active: false };
  }, [hoveredNodeId, selectedNodeId, selectedEdgeId, visibleEdges, conceptIds]);

  const flowNodes = useMemo<FlowNode<ConceptNodeData>[]>(
    () =>
      visibleConcepts.map((concept) => {
        const state = overlay.get(concept.id);
        const dimmed = emphasis.active && !emphasis.nodes.has(concept.id);
        return {
          id: concept.id,
          type: 'concept' as const,
          position: dragPositions[concept.id] ??
            savedPositions[concept.id] ??
            basePositions.get(concept.id) ?? { x: 0, y: 0 },
          // Measured dimensions round-trip through onNodesChange; without
          // them React Flow never reports the flow as initialized.
          measured: measuredSizes[concept.id],
          selected: selectedNodeId === concept.id,
          className: dimmed ? 'dimmed' : emphasis.active ? 'emphasized' : '',
          data: {
            name: concept.name,
            state: state?.state ?? 'unknown',
            masteryPct: state?.mastery != null ? Math.round(state.mastery * 100) : null,
            openMistakes: state?.openMistakes ?? 0,
            degree: degree.get(concept.id) ?? 0,
            insufficientEvidence: state ? !state.hasEnoughActivity && state.attempts > 0 : false,
            planTarget: planTargetIds?.has(concept.id) ?? false,
            flash: flashNodeId === concept.id,
          },
        };
      }),
    [
      visibleConcepts,
      overlay,
      basePositions,
      savedPositions,
      dragPositions,
      measuredSizes,
      selectedNodeId,
      emphasis,
      degree,
      planTargetIds,
      flashNodeId,
    ],
  );

  /**
   * Controlled-node change handler — the applyNodeChanges equivalent for
   * this derived-node design. Position changes stream into the dragPositions
   * layer (continuously during a gesture); dimension changes stream into
   * measuredSizes so React Flow sees an initialized flow. Selection stays
   * driven by the explicit selection props.
   */
  const handleNodesChange = useCallback((changes: NodeChange<FlowNode<ConceptNodeData>>[]) => {
    setDragPositions((current) => {
      let next: Record<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next ??= { ...current };
          next[change.id] = { x: change.position.x, y: change.position.y };
        }
      }
      return next ?? current;
    });
    setMeasuredSizes((current) => {
      let next: Record<string, { width: number; height: number }> | null = null;
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions) {
          const existing = current[change.id];
          if (
            existing &&
            existing.width === change.dimensions.width &&
            existing.height === change.dimensions.height
          ) {
            continue;
          }
          next ??= { ...current };
          next[change.id] = { ...change.dimensions };
        }
      }
      return next ?? current;
    });
  }, []);

  const handleNodeDragStart = useCallback(() => {
    draggingRef.current = true;
    setDragActive(true);
    setHoveredNodeId(null);
    scheduleTooltip(null);
  }, [scheduleTooltip]);

  /** Persist final positions once per gesture; live values hand over. */
  const handleNodeDragStop = useCallback(
    (
      _event: unknown,
      _node: FlowNode<ConceptNodeData>,
      draggedNodes: FlowNode<ConceptNodeData>[],
    ) => {
      draggingRef.current = false;
      setDragActive(false);
      const moved = draggedNodes.length > 0 ? draggedNodes : [_node];
      setSavedPositions((current) => {
        const next = { ...current };
        for (const dragged of moved) {
          next[dragged.id] = { x: dragged.position.x, y: dragged.position.y };
        }
        if (versionId) savePositions(versionId, next);
        return next;
      });
      setDragPositions((current) => {
        const next = { ...current };
        for (const dragged of moved) delete next[dragged.id];
        return next;
      });
    },
    [versionId],
  );

  const lanePlans = useMemo(() => planEdgeLanes(visibleEdges), [visibleEdges]);
  const incidentByNode = useMemo(() => planNodeEdgeOrder(visibleEdges), [visibleEdges]);
  const routeMode =
    layoutMode === 'dependency' && !focus ? ('dependency' as const) : ('network' as const);

  /** Node rects the route planner sees — same resolution as flowNodes. */
  const routingRects = useMemo(() => {
    const rects = new Map<string, Rect>();
    for (const concept of visibleConcepts) {
      const position = dragPositions[concept.id] ??
        savedPositions[concept.id] ??
        basePositions.get(concept.id) ?? { x: 0, y: 0 };
      const size = measuredSizes[concept.id] ??
        estimatedSizes.get(concept.id) ?? { width: 160, height: 56 };
      rects.set(concept.id, {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      });
    }
    return rects;
  }, [
    visibleConcepts,
    dragPositions,
    savedPositions,
    basePositions,
    measuredSizes,
    estimatedSizes,
  ]);

  /**
   * Plan trigger: a stable fingerprint of node geometry that freezes to a
   * constant during drag gestures, so the global planner reruns only when
   * geometry meaningfully changes (layout, relayout, visible-set or mode
   * change, measurement, completed drag) — never per pointer frame, never
   * on hover or selection.
   */
  const routeGeometryKey = useMemo(() => {
    if (dragActive) return 'drag';
    let key = '';
    for (const [id, rect] of routingRects) {
      key += `${id}:${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.width.toFixed(1)}x${rect.height.toFixed(1)};`;
    }
    return key;
  }, [dragActive, routingRects]);

  /** Shared crossing-minimized route plan (bounded, deterministic). */
  const routePlan = useMemo<GraphRoutePlan | null>(() => {
    if (visibleEdges.length === 0) return null;
    return planGraphRoutes({
      rects: routingRects,
      edges: visibleEdges,
      lanePlans,
      mode: routeMode,
    });
    // routingRects is deliberately represented by routeGeometryKey, which
    // freezes while a drag is active (edges route locally per frame; one
    // cleanup plan runs on drag stop with the final geometry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeGeometryKey, visibleEdges, lanePlans, routeMode]);

  const flowEdges = useMemo<LearningFlowEdge[]>(() => {
    const list = visibleEdges.map((edge) => {
      const isSelected = selectedEdgeId === edge.id;
      const related = (emphasis.active && emphasis.edges.has(edge.id)) || hoveredEdgeId === edge.id;
      const dimmed = emphasis.active && !related && !isSelected;
      const endpointSelected =
        selectedNodeId === edge.sourceConceptId || selectedNodeId === edge.targetConceptId;
      const edgeEmphasis: EdgeEmphasis = isSelected
        ? 'selected'
        : related
          ? 'related'
          : dimmed
            ? 'dimmed'
            : 'normal';
      const plan = lanePlans.get(edge.id);
      return {
        id: edge.id,
        source: edge.sourceConceptId,
        target: edge.targetConceptId,
        type: 'floating' as const,
        selected: isSelected,
        className: [
          'graph-edge',
          `relation-${edge.relation}`,
          dimmed ? 'dimmed' : '',
          related ? 'related' : '',
        ]
          .filter(Boolean)
          .join(' '),
        data: {
          relation: edge.relation,
          labelText: RELATION_LABELS[edge.relation],
          // Labels stay hidden by default; they appear for the selected
          // edge, the hovered edge, edges of the selected concept, or the
          // explicit 显示关系标签 toggle — never on plain node hover.
          showLabel: showEdgeLabels || isSelected || hoveredEdgeId === edge.id || endpointSelected,
          emphasis: edgeEmphasis,
          evidenceCount: edge.evidence.length,
          lane: plan?.lane ?? 0,
          laneCount: plan?.laneCount ?? 1,
          mode: routeMode,
          incidentByNode,
          fallbackSizes: estimatedSizes,
          routePlan,
        },
      };
    });
    // Paint quiet edges first, related ones above them, the selected edge
    // last — still beneath every node card (edges live in the lower SVG).
    const paintRank = (edge: LearningFlowEdge) =>
      edge.selected ? 2 : edge.data?.emphasis === 'related' ? 1 : 0;
    return list.sort((a, b) => paintRank(a) - paintRank(b));
  }, [
    visibleEdges,
    selectedEdgeId,
    selectedNodeId,
    emphasis,
    hoveredEdgeId,
    showEdgeLabels,
    lanePlans,
    incidentByNode,
    estimatedSizes,
    routeMode,
    routePlan,
  ]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return concepts.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8);
  }, [concepts, searchQuery]);

  const centerOnConcept = useCallback(
    (conceptId: string) => {
      const pos =
        dragPositions[conceptId] ?? savedPositions[conceptId] ?? basePositions.get(conceptId);
      if (!pos) return;
      const size = estimateNodeSize(
        concepts.find((c) => c.id === conceptId)?.name ?? '',
        degree.get(conceptId) ?? 0,
      );
      void setCenter(pos.x + size.width / 2, pos.y + size.height / 2, {
        zoom: Math.max(getZoom(), 0.9),
        duration: motionDuration(300),
      });
    },
    [dragPositions, savedPositions, basePositions, concepts, degree, setCenter, getZoom],
  );

  const handleSearchPick = useCallback(
    (conceptId: string) => {
      onSelectNode(conceptId);
      setFlashNodeId(conceptId);
      setSearchQuery('');
      centerOnConcept(conceptId);
    },
    [onSelectNode, centerOnConcept],
  );

  const handleRelayout = useCallback(() => {
    setSavedPositions({});
    setDragPositions({});
    if (versionId) savePositions(versionId, {});
    setRelayoutNonce((n) => n + 1);
  }, [versionId]);

  const { fitView } = useReactFlow();
  const handleFit = useCallback(() => {
    void fitView({ ...FIT_VIEW_OPTIONS, duration: motionDuration(220) });
  }, [fitView]);

  /**
   * One automatic fit per meaningful graph state. Built from the CORE
   * visible set (mode, focus, toggles, data) — hover, selection, and drags
   * are structurally unable to change this key.
   */
  const visibleSetKey = useMemo(() => {
    const ids = [...coreVisibleIds].sort().join('§');
    return `${coreVisibleIds.size}:${hashId(ids).toString(36)}`;
  }, [coreVisibleIds]);
  const fitTrigger = [
    versionId ?? 'none',
    layoutMode,
    focus ? `${focus.rootId}:${focus.hops}` : 'all',
    showUnassessed ? 'u1' : 'u0',
    relayoutNonce,
    refitKey ?? '',
    visibleSetKey,
  ].join('|');

  const focusName = focus ? concepts.find((c) => c.id === focus.rootId)?.name : null;
  const weakAvailable = useMemo(
    () => concepts.some((c) => overlay.get(c.id)?.treatAsWeak),
    [concepts, overlay],
  );

  /** 薄弱路径 caption info (and the "identical to full graph" explanation). */
  const weakPathInfo =
    layoutMode === 'weak-path' && !focus && weakSubgraph.conceptIds.size > 0
      ? {
          nodeCount: visibleConcepts.length,
          totalCount: concepts.length,
          coversAll:
            visibleConcepts.length === concepts.length && visibleEdges.length === validEdges.length,
          truncated: weakSubgraph.truncated,
        }
      : null;

  return (
    <div className="graph-canvas" data-testid="concept-graph" ref={canvasRef}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        minZoom={0.15}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDoubleClick={(_, node) => {
          setFocus({ rootId: node.id, hops: 1 });
          onSelectNode(node.id);
        }}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodeMouseEnter={(event, node) => {
          if (draggingRef.current) return;
          setHoveredNodeId(node.id);
          const rect = canvasRef.current?.getBoundingClientRect();
          scheduleTooltip({
            conceptId: node.id,
            x: event.clientX - (rect?.left ?? 0) + 14,
            y: event.clientY - (rect?.top ?? 0) + 14,
          });
        }}
        onNodeMouseMove={(event, node) => {
          if (draggingRef.current) return;
          const rect = canvasRef.current?.getBoundingClientRect();
          scheduleTooltip({
            conceptId: node.id,
            x: event.clientX - (rect?.left ?? 0) + 14,
            y: event.clientY - (rect?.top ?? 0) + 14,
          });
        }}
        onNodeMouseLeave={() => {
          setHoveredNodeId(null);
          scheduleTooltip(null);
        }}
        onEdgeMouseEnter={(_, edge) => {
          if (!draggingRef.current) setHoveredEdgeId(edge.id);
        }}
        onEdgeMouseLeave={() => setHoveredEdgeId(null)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
      >
        <AutoFit trigger={fitTrigger} />
        <EdgeMarkerDefs />
        <Background gap={26} size={1.4} />
        <Controls showInteractive={false} position="bottom-right" />

        <Panel position="top-left" className="graph-overlay graph-search-panel">
          <input
            type="search"
            className="graph-search-input"
            aria-label="搜索概念"
            placeholder="搜索概念…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchMatches.length > 0) {
                handleSearchPick(searchMatches[0]!.id);
              }
              if (e.key === 'Escape') setSearchQuery('');
            }}
          />
          {searchMatches.length > 0 ? (
            <ul className="graph-search-results" aria-label="搜索结果">
              {searchMatches.map((concept) => (
                <li key={concept.id}>
                  <button type="button" onClick={() => handleSearchPick(concept.id)}>
                    {concept.name}
                    <span className="small muted">
                      {' '}
                      {STATE_LABELS[overlay.get(concept.id)?.state ?? 'unassessed']}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {searchQuery.trim() && searchMatches.length === 0 ? (
            <p className="graph-search-empty small muted">没有匹配的概念。</p>
          ) : null}
        </Panel>

        <Panel position="top-right" className="graph-overlay graph-toolbar">
          <label className="graph-toolbar-field">
            <span className="visually-hidden">布局模式</span>
            <select
              aria-label="布局模式"
              value={layoutMode}
              onChange={(e) => {
                setLayoutMode(e.target.value as LayoutMode);
                setFocus(null);
              }}
            >
              {(Object.keys(LAYOUT_MODE_LABELS) as LayoutMode[]).map((mode) => (
                <option key={mode} value={mode} disabled={mode === 'weak-path' && !weakAvailable}>
                  {LAYOUT_MODE_LABELS[mode]}
                  {mode === 'weak-path' && !weakAvailable ? '(暂无薄弱概念)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost small" onClick={handleFit}>
            适配视图
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={handleRelayout}
            title="重新运行自动布局并清除手动拖拽的位置"
          >
            重新布局
          </button>
          <button
            type="button"
            className="ghost small"
            aria-pressed={showEdgeLabels}
            onClick={() => setShowEdgeLabels((v) => !v)}
          >
            {showEdgeLabels ? '隐藏关系标签' : '显示关系标签'}
          </button>
          <button
            type="button"
            className="ghost small"
            aria-pressed={!showUnassessed}
            onClick={() => setShowUnassessed((v) => !v)}
          >
            {showUnassessed ? '隐藏未评估' : '显示未评估'}
          </button>
        </Panel>

        {focus ? (
          <Panel position="top-center" className="graph-overlay graph-focus-banner">
            <span>
              聚焦邻域:<strong>{focusName ?? focus.rootId}</strong>({focus.hops} 跳)
            </span>
            {focus.hops === 1 ? (
              <button
                type="button"
                className="ghost small"
                onClick={() => setFocus({ ...focus, hops: 2 })}
              >
                扩展到二跳
              </button>
            ) : (
              <button
                type="button"
                className="ghost small"
                onClick={() => setFocus({ ...focus, hops: 1 })}
              >
                收缩到一跳
              </button>
            )}
            <button type="button" className="ghost small" onClick={() => setFocus(null)}>
              返回全图
            </button>
          </Panel>
        ) : null}

        {weakPathInfo ? (
          <Panel
            position="top-center"
            className="graph-overlay graph-weak-path-banner"
            aria-label="薄弱路径说明"
          >
            {weakPathInfo.coversAll
              ? '当前最小补救路径恰好覆盖整个图谱:每个概念都是薄弱概念或位于其先修路径上。'
              : `薄弱路径:显示 ${weakPathInfo.nodeCount}/${weakPathInfo.totalCount} 个概念(薄弱概念 + 最短先修路径 + 有限上下文)。`}
            {weakPathInfo.truncated ? ' 已按节点预算截断。' : ''}
          </Panel>
        ) : null}

        <Panel position="bottom-left" className="graph-overlay graph-legend-panel">
          <GraphLegend />
        </Panel>

        {summary ? (
          <Panel
            position="bottom-center"
            className="graph-overlay graph-summary"
            aria-label="图谱概要"
          >
            文档 {summary.documentCount} · 概念 {concepts.length} · 关系 {validEdges.length} · 薄弱{' '}
            {summary.weakCount}
            {summary.acceptedCount !== null ? ` · 采纳 ${summary.acceptedCount}` : ''}
            {summary.rejectedCount !== null && summary.rejectedCount > 0
              ? ` · 拒绝 ${summary.rejectedCount}`
              : ''}
          </Panel>
        ) : null}
      </ReactFlow>

      {tooltip ? (
        <GraphTooltip tooltip={tooltip} concepts={concepts} overlay={overlay} degree={degree} />
      ) : null}
    </div>
  );
}

function GraphTooltip({
  tooltip,
  concepts,
  overlay,
  degree,
}: {
  tooltip: TooltipState;
  concepts: Concept[];
  overlay: Map<string, ConceptLearnerState>;
  degree: Map<string, number>;
}) {
  const concept = concepts.find((c) => c.id === tooltip.conceptId);
  if (!concept) return null;
  const state = overlay.get(concept.id);
  return (
    <div
      className="graph-tooltip"
      role="tooltip"
      // pointer-events none also lives in CSS; inline here so the purely
      // informational tooltip can never intercept hover/drag input even if
      // stylesheets fail to load (this was a flicker class of bug).
      style={{ left: tooltip.x, top: tooltip.y, pointerEvents: 'none' }}
    >
      <strong>{concept.name}</strong>
      <span>
        {STATE_LABELS[state?.state ?? 'unassessed']}
        {state?.mastery != null ? ` · 掌握 ${Math.round(state.mastery * 100)}%` : ''}
      </span>
      <span>
        关系 {degree.get(concept.id) ?? 0} 条 · 未解决错题 {state?.openMistakes ?? 0} 道
      </span>
    </div>
  );
}

/** Compact in-canvas legend for node states and relation styles. */
export function GraphLegend() {
  return (
    <details className="graph-legend" aria-label="图例">
      <summary>图例</summary>
      <div className="legend-body">
        <span className="legend-group">
          <span className="legend-chip unassessed">未评估</span>
          <span className="legend-chip weak">薄弱</span>
          <span className="legend-chip developing">进步中</span>
          <span className="legend-chip stable">稳固</span>
        </span>
        <span className="legend-group">
          {(Object.keys(RELATION_LABELS) as GraphRelation[]).map((relation) => (
            <span key={relation} className="legend-relation">
              <span
                className="legend-line"
                style={{
                  backgroundColor: RELATION_DASH[relation]
                    ? 'transparent'
                    : RELATION_COLORS[relation],
                  backgroundImage: RELATION_DASH[relation]
                    ? `linear-gradient(90deg, ${RELATION_COLORS[relation]} 60%, transparent 40%)`
                    : undefined,
                  backgroundSize: RELATION_DASH[relation] ? '6px 3px' : undefined,
                }}
              />
              {RELATION_LABELS[relation]}
            </span>
          ))}
        </span>
      </div>
    </details>
  );
}
