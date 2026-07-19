import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
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
  loadSavedPositions,
  neighborhoodConceptIds,
  savePositions,
  weakPathConceptIds,
  type LayoutMode,
} from './graph/layout.js';

/**
 * Interactive personal learning graph (Obsidian-style exploration).
 *
 * Rendering stays on @xyflow/react (React Flow 12); the default 网络视图
 * layout is computed by d3-force in a bounded synchronous pass (see
 * graph/layout.ts). Nodes are draggable; dragged positions are kept per
 * graph version in localStorage and never snap back. 重新布局 clears them
 * and re-runs the deterministic simulation.
 */

export const RELATION_LABELS: Record<GraphRelation, string> = {
  prerequisite: '先修',
  part_of: '组成',
  contrasts_with: '对比',
  causes: '因果',
  applies_to: '应用',
  example_of: '示例',
};

const RELATION_COLORS: Record<GraphRelation, string> = {
  prerequisite: '#2f5fe0',
  part_of: '#7c3aed',
  contrasts_with: '#d97706',
  causes: '#c2504d',
  applies_to: '#0d9488',
  example_of: '#64748b',
};

/** Dash patterns keep relation types distinguishable without color alone. */
const RELATION_DASH: Partial<Record<GraphRelation, string>> = {
  contrasts_with: '7 5',
  example_of: '2 4',
};

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
      title={data.name}
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

/** Fits the viewport once per trigger change, only after nodes are measured. */
function AutoFit({ trigger }: { trigger: string }) {
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!nodesInitialized) return;
    if (appliedRef.current === trigger) return;
    appliedRef.current = trigger;
    void fitView({ padding: 0.18, maxZoom: 1.35, duration: motionDuration(220) });
  }, [nodesInitialized, trigger, fitView]);

  useEffect(() => {
    const onResize = () => {
      void fitView({ padding: 0.18, maxZoom: 1.35, duration: motionDuration(120) });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [flashNodeId, setFlashNodeId] = useState<string | null>(null);
  const [relayoutNonce, setRelayoutNonce] = useState(0);
  const [savedPositions, setSavedPositions] = useState<Record<string, { x: number; y: number }>>(
    () => (versionId ? loadSavedPositions(versionId) : {}),
  );

  // Version switches load that version's saved positions and drop focus state.
  const versionRef = useRef(versionId);
  useEffect(() => {
    if (versionRef.current === versionId) return;
    versionRef.current = versionId;
    setSavedPositions(versionId ? loadSavedPositions(versionId) : {});
    setFocus(null);
    setHoveredNodeId(null);
    setTooltip(null);
  }, [versionId]);

  const conceptIds = useMemo(() => new Set(concepts.map((c) => c.id)), [concepts]);
  const validEdges = useMemo(
    () =>
      edges.filter((e) => conceptIds.has(e.sourceConceptId) && conceptIds.has(e.targetConceptId)),
    [edges, conceptIds],
  );
  const degree = useMemo(() => degreeByConcept(concepts, validEdges), [concepts, validEdges]);

  /** Which concepts are visible under the current mode/focus/toggles. */
  const visibleIds = useMemo(() => {
    let ids: Set<string>;
    if (focus) {
      ids = neighborhoodConceptIds(focus.rootId, validEdges, focus.hops);
    } else if (layoutMode === 'weak-path') {
      const weakSet = weakPathConceptIds(concepts, validEdges, overlay);
      ids = weakSet.size > 0 ? weakSet : new Set(concepts.map((c) => c.id));
    } else {
      ids = new Set(concepts.map((c) => c.id));
    }
    if (!showUnassessed) {
      for (const concept of concepts) {
        const state = overlay.get(concept.id)?.state ?? 'unassessed';
        // Never hide the selected or focused concept out from under the user.
        if (
          state === 'unassessed' &&
          concept.id !== selectedNodeId &&
          concept.id !== focus?.rootId
        ) {
          ids.delete(concept.id);
        }
      }
    }
    return ids;
  }, [concepts, validEdges, overlay, layoutMode, focus, showUnassessed, selectedNodeId]);

  const visibleConcepts = useMemo(
    () => concepts.filter((c) => visibleIds.has(c.id)),
    [concepts, visibleIds],
  );
  const visibleEdges = useMemo(
    () =>
      validEdges.filter(
        (e) => visibleIds.has(e.sourceConceptId) && visibleIds.has(e.targetConceptId),
      ),
    [validEdges, visibleIds],
  );

  /** Deterministic base layout for the visible subgraph. */
  const basePositions = useMemo(() => {
    if (layoutMode === 'dependency' && !focus) {
      return computeDependencyLayout(visibleConcepts, visibleEdges);
    }
    const sizes = new Map(
      visibleConcepts.map((c) => [c.id, estimateNodeSize(c.name, degree.get(c.id) ?? 0)]),
    );
    return computeForceLayout(visibleConcepts, visibleEdges, sizes);
    // relayoutNonce forces a fresh simulation on 重新布局.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleConcepts, visibleEdges, layoutMode, focus, degree, relayoutNonce]);

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
          position: savedPositions[concept.id] ?? basePositions.get(concept.id) ?? { x: 0, y: 0 },
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
      selectedNodeId,
      emphasis,
      degree,
      planTargetIds,
      flashNodeId,
    ],
  );

  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      visibleEdges.map((edge) => {
        const color = RELATION_COLORS[edge.relation];
        const isSelected = selectedEdgeId === edge.id;
        const related = emphasis.active && emphasis.edges.has(edge.id);
        const dimmed = emphasis.active && !related && !isSelected;
        const showLabel = showEdgeLabels || isSelected || related;
        // Thickness reflects the number of locally verified evidence quotes.
        const evidenceWidth = 1.4 + Math.min(edge.evidence.length, 3) * 0.4;
        return {
          id: edge.id,
          source: edge.sourceConceptId,
          target: edge.targetConceptId,
          selected: isSelected,
          label: showLabel ? RELATION_LABELS[edge.relation] : undefined,
          // Straight lines read best in the force-directed network (Obsidian
          // style); the layered dependency view keeps smooth curves.
          type: layoutMode === 'dependency' && !focus ? 'default' : 'straight',
          className: [
            'graph-edge',
            `relation-${edge.relation}`,
            dimmed ? 'dimmed' : '',
            related ? 'related' : '',
          ]
            .filter(Boolean)
            .join(' '),
          style: {
            stroke: color,
            strokeWidth: isSelected ? evidenceWidth + 1.6 : evidenceWidth,
            strokeDasharray: RELATION_DASH[edge.relation],
            opacity: dimmed ? 0.16 : 1,
          },
          labelStyle: { fill: color, fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: 'var(--surface, #fff)', fillOpacity: 0.9 },
          ...(edge.relation === 'contrasts_with'
            ? {}
            : {
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color,
                  width: 16,
                  height: 16,
                },
              }),
        };
      }),
    [visibleEdges, selectedEdgeId, emphasis, showEdgeLabels, layoutMode, focus],
  );

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return concepts.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8);
  }, [concepts, searchQuery]);

  const centerOnConcept = useCallback(
    (conceptId: string) => {
      const pos = savedPositions[conceptId] ?? basePositions.get(conceptId);
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
    [savedPositions, basePositions, concepts, degree, setCenter, getZoom],
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
    if (versionId) savePositions(versionId, {});
    setRelayoutNonce((n) => n + 1);
  }, [versionId]);

  const { fitView } = useReactFlow();
  const handleFit = useCallback(() => {
    void fitView({ padding: 0.18, maxZoom: 1.35, duration: motionDuration(220) });
  }, [fitView]);

  const fitTrigger = [
    versionId ?? 'none',
    layoutMode,
    focus ? `${focus.rootId}:${focus.hops}` : 'all',
    showUnassessed ? 'u1' : 'u0',
    relayoutNonce,
    refitKey ?? '',
    visibleConcepts.length,
  ].join('|');

  const focusName = focus ? concepts.find((c) => c.id === focus.rootId)?.name : null;
  const weakAvailable = useMemo(
    () => concepts.some((c) => overlay.get(c.id)?.treatAsWeak),
    [concepts, overlay],
  );

  return (
    <div className="graph-canvas" data-testid="concept-graph" ref={canvasRef}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
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
        onNodeDragStop={(_, node) => {
          setSavedPositions((current) => {
            const next = { ...current, [node.id]: { x: node.position.x, y: node.position.y } };
            if (versionId) savePositions(versionId, next);
            return next;
          });
        }}
        onNodeMouseEnter={(event, node) => {
          setHoveredNodeId(node.id);
          const rect = canvasRef.current?.getBoundingClientRect();
          setTooltip({
            conceptId: node.id,
            x: event.clientX - (rect?.left ?? 0) + 14,
            y: event.clientY - (rect?.top ?? 0) + 14,
          });
        }}
        onNodeMouseMove={(event, node) => {
          const rect = canvasRef.current?.getBoundingClientRect();
          setTooltip({
            conceptId: node.id,
            x: event.clientX - (rect?.left ?? 0) + 14,
            y: event.clientY - (rect?.top ?? 0) + 14,
          });
        }}
        onNodeMouseLeave={() => {
          setHoveredNodeId(null);
          setTooltip(null);
        }}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
      >
        <AutoFit trigger={fitTrigger} />
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
    <div className="graph-tooltip" role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
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
