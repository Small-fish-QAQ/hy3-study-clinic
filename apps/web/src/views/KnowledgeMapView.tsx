import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import {
  Background,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type Edge as FlowEdge,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  GraphRelation,
  KnowledgeMapEdge,
  KnowledgeMapMode,
  KnowledgeMapNode,
  KnowledgeMapProjection,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading, ViewportIcon } from '../components/ui.js';
import {
  EdgeMarkerDefs,
  FloatingLearningEdge,
  type EdgeEmphasis,
} from '../components/graph/FloatingLearningEdge.js';
import { planEdgeLanes, planNodeEdgeOrder } from '../components/graph/edgeRouting.js';
import { planGraphRoutes, type GraphRoutePlan } from '../components/graph/routePlan.js';
import type { Rect } from '../components/graph/edgeGeometry.js';
import {
  computeKnowledgeMapLayout,
  estimateKnowledgeMapNodeSize,
  loadKnowledgeMapPositions,
  loadKnowledgeMapViewport,
  saveKnowledgeMapPositions,
  saveKnowledgeMapViewport,
} from '../knowledgeMapLayout.js';
import {
  EDGE_KIND_LABELS,
  KNOWLEDGE_MAP_MODES,
  NODE_KIND_LABELS,
  PRIMARY_STATE_LABELS,
  ROUTE_POSITION_LABELS,
  STATE_REASON_LABELS,
  WEAKNESS_PRESENTATION,
  knowledgeMapIdentity,
  modePresentation,
  primaryNodeCue,
  visibleKnowledgeMapEdges,
  visibleKnowledgeMapNodeIds,
} from '../knowledgeMapPresentation.js';

export type KnowledgeMapNavigationTarget = KnowledgeMapNode['navigation'][number];

export interface KnowledgeMapIntent {
  requestId: number;
  mode: KnowledgeMapMode;
  nodeId?: string | null;
  learningUnitId?: string | null;
  objectiveId?: string | null;
}

export interface KnowledgeMapViewProps {
  workspaceId: string;
  refreshKey: number;
  intent?: KnowledgeMapIntent | null;
  onNavigate: (target: KnowledgeMapNavigationTarget) => void;
}

interface MapNodeData extends Record<string, unknown> {
  node: KnowledgeMapNode;
  mode: KnowledgeMapMode;
  dense: boolean;
}

function KnowledgeMapNodeCard({ data, selected }: NodeProps<FlowNode<MapNodeData>>) {
  const cue = primaryNodeCue(data.node, data.mode);
  const weaknessCues =
    data.mode === 'weakness_map'
      ? data.node.weaknesses.slice(0, selected ? 4 : 2).map((signal) => ({
          kind: signal.kind,
          label: WEAKNESS_PRESENTATION[signal.kind].label,
          tone: WEAKNESS_PRESENTATION[signal.kind].tone,
        }))
      : [];
  return (
    <div
      className={`knowledge-map-node kind-${data.node.kind.replace('_', '-')} tone-${cue.tone}${
        selected ? ' selected' : ''
      }${data.dense ? ' dense' : ''}`}
      aria-label={`${NODE_KIND_LABELS[data.node.kind]} ${data.node.label}，${cue.label}`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="knowledge-map-node-kind">{NODE_KIND_LABELS[data.node.kind]}</span>
      <strong className="knowledge-map-node-title">{data.node.label}</strong>
      {cue.label !== NODE_KIND_LABELS[data.node.kind] ? (
        <span className="knowledge-map-node-cue">{cue.label}</span>
      ) : null}
      {data.node.route.agendaDiffersFromPlan && data.mode === 'learning_route' ? (
        <span className="knowledge-map-node-note">本次安排临时偏离路线</span>
      ) : null}
      {weaknessCues.length > 0 ? (
        <span className="knowledge-map-node-signals">
          {weaknessCues.map((signal) => (
            <span key={signal.kind} className={`map-signal tone-${signal.tone}`}>
              {signal.label}
            </span>
          ))}
        </span>
      ) : null}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { knowledge: KnowledgeMapNodeCard };
const edgeTypes = { floating: FloatingLearningEdge };
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1.2 };

function motionDuration(value: number): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : value;
}

function InitialFit({ enabled }: { enabled: boolean }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || !initialized || done.current) return;
    done.current = true;
    const frame = requestAnimationFrame(() => {
      void fitView({ ...FIT_OPTIONS, duration: motionDuration(180) });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, fitView, initialized]);
  return null;
}

function routingRelation(kind: KnowledgeMapEdge['kind']): GraphRelation {
  if (kind === 'curriculum_prerequisite') return 'prerequisite';
  if (kind === 'unit_contains_concept' || kind === 'synthesis_includes_unit') return 'part_of';
  if (kind === 'curriculum_contains') return 'part_of';
  return kind;
}

function resolvedIntentNode(
  projection: KnowledgeMapProjection,
  intent: KnowledgeMapIntent | null | undefined,
): string | null {
  if (!intent) return null;
  if (intent.nodeId && projection.nodes.some((node) => node.id === intent.nodeId)) {
    return intent.nodeId;
  }
  if (intent.learningUnitId) {
    const node = projection.nodes.find(
      (candidate) =>
        candidate.kind === 'learning_unit' &&
        candidate.navigation.some((target) => target.learningUnitId === intent.learningUnitId),
    );
    if (node) return node.id;
  }
  if (intent.objectiveId) {
    const node = projection.nodes.find(
      (candidate) =>
        'objectiveIds' in candidate && candidate.objectiveIds.includes(intent.objectiveId!),
    );
    if (node) return node.id;
  }
  return null;
}

interface KnowledgeMapCanvasProps {
  projection: KnowledgeMapProjection;
  mode: KnowledgeMapMode;
  selectedNodeId: string | null;
  expandedNodeIds: ReadonlySet<string>;
  focusRequestId: number | null;
  onSelectNode: (nodeId: string | null, returnTarget?: HTMLElement | null) => void;
}

function KnowledgeMapCanvas({
  projection,
  mode,
  selectedNodeId,
  expandedNodeIds,
  focusRequestId,
  onSelectNode,
}: KnowledgeMapCanvasProps) {
  const identity = knowledgeMapIdentity(projection);
  const initialViewport = useMemo(() => loadKnowledgeMapViewport(identity), [identity]);
  const [viewport, setViewport] = useState<Viewport>(initialViewport ?? DEFAULT_VIEWPORT);
  const [savedPositions, setSavedPositions] = useState(() => loadKnowledgeMapPositions(identity));
  const savedPositionsRef = useRef(savedPositions);
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [measuredSizes, setMeasuredSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [relayoutNonce, setRelayoutNonce] = useState(0);
  const [focusRootId, setFocusRootId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const draggingRef = useRef(false);
  const { fitView, setCenter, zoomIn, zoomOut } = useReactFlow();
  const nodeIds = useMemo(
    () => new Set(projection.nodes.map((node) => node.id)),
    [projection.nodes],
  );
  const modeNodeIds = useMemo(
    () => visibleKnowledgeMapNodeIds(projection, mode, selectedNodeId, expandedNodeIds),
    [expandedNodeIds, mode, projection, selectedNodeId],
  );
  const modeEdges = useMemo(
    () => visibleKnowledgeMapEdges(projection, mode, modeNodeIds),
    [mode, modeNodeIds, projection],
  );
  const displayedNodeIds = useMemo(() => {
    if (!focusRootId || !modeNodeIds.has(focusRootId)) return modeNodeIds;
    const ids = new Set([focusRootId]);
    for (const edge of modeEdges) {
      if (edge.sourceNodeId === focusRootId) ids.add(edge.targetNodeId);
      if (edge.targetNodeId === focusRootId) ids.add(edge.sourceNodeId);
    }
    if (selectedNodeId) ids.add(selectedNodeId);
    return ids;
  }, [focusRootId, modeEdges, modeNodeIds, selectedNodeId]);
  const visibleNodes = useMemo(
    () => projection.nodes.filter((node) => displayedNodeIds.has(node.id)),
    [displayedNodeIds, projection.nodes],
  );
  const visibleEdges = useMemo(
    () =>
      modeEdges.filter(
        (edge) =>
          displayedNodeIds.has(edge.sourceNodeId) && displayedNodeIds.has(edge.targetNodeId),
      ),
    [displayedNodeIds, modeEdges],
  );
  const basePositions = useMemo(
    () => computeKnowledgeMapLayout(projection.nodes, projection.edges),
    // The nonce intentionally reruns the same deterministic topology layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projection.nodes, projection.edges, relayoutNonce],
  );
  const emphasisNodeIds = useMemo(() => {
    if (!selectedNodeId) return null;
    const ids = new Set([selectedNodeId]);
    for (const edge of visibleEdges) {
      if (edge.sourceNodeId === selectedNodeId || edge.targetNodeId === selectedNodeId) {
        ids.add(edge.sourceNodeId);
        ids.add(edge.targetNodeId);
      }
    }
    return ids;
  }, [selectedNodeId, visibleEdges]);
  const dense = visibleNodes.length > 80;
  const flowNodes = useMemo<FlowNode<MapNodeData>[]>(
    () =>
      visibleNodes.map((node) => ({
        id: node.id,
        type: 'knowledge',
        position: dragPositions[node.id] ??
          savedPositions[node.id] ??
          basePositions.get(node.id) ?? { x: 0, y: 0 },
        measured: measuredSizes[node.id],
        selected: selectedNodeId === node.id,
        className:
          emphasisNodeIds && !emphasisNodeIds.has(node.id) ? 'knowledge-map-dimmed' : undefined,
        data: { node, mode, dense },
      })),
    [
      basePositions,
      dense,
      dragPositions,
      emphasisNodeIds,
      measuredSizes,
      mode,
      savedPositions,
      selectedNodeId,
      visibleNodes,
    ],
  );
  const routingEdges = useMemo(
    () =>
      visibleEdges.map((edge) => ({
        id: edge.id,
        sourceConceptId: edge.sourceNodeId,
        targetConceptId: edge.targetNodeId,
        relation: edge.kind,
      })),
    [visibleEdges],
  );
  const estimatedSizes = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, estimateKnowledgeMapNodeSize(node)])),
    [visibleNodes],
  );
  const routingRects = useMemo(() => {
    const rects = new Map<string, Rect>();
    for (const node of visibleNodes) {
      const position = dragPositions[node.id] ??
        savedPositions[node.id] ??
        basePositions.get(node.id) ?? { x: 0, y: 0 };
      const size = measuredSizes[node.id] ?? estimatedSizes.get(node.id)!;
      rects.set(node.id, { ...position, ...size });
    }
    return rects;
  }, [basePositions, dragPositions, estimatedSizes, measuredSizes, savedPositions, visibleNodes]);
  const lanePlans = useMemo(() => planEdgeLanes(routingEdges), [routingEdges]);
  const incidentByNode = useMemo(() => planNodeEdgeOrder(routingEdges), [routingEdges]);
  const routePlan = useMemo<GraphRoutePlan | null>(() => {
    if (routingEdges.length === 0 || routingEdges.length > 48) return null;
    return planGraphRoutes({
      rects: routingRects,
      edges: routingEdges,
      lanePlans,
      mode: 'network',
    });
  }, [lanePlans, routingEdges, routingRects]);
  const fastEdgeRendering = routingEdges.length > 48;
  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      visibleEdges.map((edge) => {
        const related =
          selectedNodeId === edge.sourceNodeId || selectedNodeId === edge.targetNodeId;
        const edgeEmphasis: EdgeEmphasis = selectedNodeId
          ? related
            ? 'related'
            : 'dimmed'
          : mode === 'learning_route' &&
              ['current', 'next'].includes(
                projection.nodes.find((node) => node.id === edge.targetNodeId)?.route.position ??
                  '',
              )
            ? 'related'
            : 'normal';
        const plan = lanePlans.get(edge.id);
        if (fastEdgeRendering) {
          return {
            id: edge.id,
            source: edge.sourceNodeId,
            target: edge.targetNodeId,
            type: 'straight',
            label: related ? EDGE_KIND_LABELS[edge.kind] : undefined,
            className: `knowledge-map-fast-edge emphasis-${edgeEmphasis}`,
            style: {
              opacity: edgeEmphasis === 'dimmed' ? 0.1 : edgeEmphasis === 'related' ? 0.85 : 0.3,
              strokeWidth: edgeEmphasis === 'related' ? 2 : 1,
            },
          };
        }
        return {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          type: 'floating',
          data: {
            relation: routingRelation(edge.kind),
            labelText: EDGE_KIND_LABELS[edge.kind],
            showLabel: related,
            emphasis: edgeEmphasis,
            evidenceCount: edge.provenance.length,
            lane: plan?.lane ?? 0,
            laneCount: plan?.laneCount ?? 1,
            mode: 'network',
            incidentByNode,
            fallbackSizes: estimatedSizes,
            routePlan,
          },
        };
      }),
    [
      estimatedSizes,
      fastEdgeRendering,
      incidentByNode,
      lanePlans,
      mode,
      projection.nodes,
      routePlan,
      selectedNodeId,
      visibleEdges,
    ],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode<MapNodeData>>[]) => {
      setDragPositions((current) => {
        let next: typeof current | null = null;
        for (const change of changes) {
          if (change.type !== 'position' || !change.position || !nodeIds.has(change.id)) continue;
          if (change.dragging && !draggingRef.current) continue;
          next ??= { ...current };
          next[change.id] = { x: change.position.x, y: change.position.y };
        }
        return next ?? current;
      });
      setMeasuredSizes((current) => {
        let next: typeof current | null = null;
        for (const change of changes) {
          if (change.type !== 'dimensions' || !change.dimensions) continue;
          if (
            current[change.id]?.width === change.dimensions.width &&
            current[change.id]?.height === change.dimensions.height
          ) {
            continue;
          }
          next ??= { ...current };
          next[change.id] = { ...change.dimensions };
        }
        return next ?? current;
      });
    },
    [nodeIds],
  );

  useEffect(() => {
    if (!selectedNodeId || focusRequestId === null) return;
    const position = savedPositions[selectedNodeId] ??
      basePositions.get(selectedNodeId) ?? { x: 0, y: 0 };
    const size = estimatedSizes.get(selectedNodeId) ?? { width: 180, height: 72 };
    const timer = window.setTimeout(() => {
      void setCenter(position.x + size.width / 2, position.y + size.height / 2, {
        zoom: Math.max(viewport.zoom, 0.9),
        duration: motionDuration(220),
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // focusRequestId is the explicit trigger; ordinary selection does not move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequestId]);

  const searchMatches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return projection.nodes
      .filter((node) => node.label.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [projection.nodes, search]);

  function chooseSearchResult(node: KnowledgeMapNode): void {
    onSelectNode(node.id);
    setSearch('');
    const position = savedPositions[node.id] ?? basePositions.get(node.id);
    const size = estimateKnowledgeMapNodeSize(node);
    if (position) {
      void setCenter(position.x + size.width / 2, position.y + size.height / 2, {
        zoom: Math.max(viewport.zoom, 0.9),
        duration: motionDuration(220),
      });
    }
  }

  function resetLayout(): void {
    savedPositionsRef.current = {};
    setSavedPositions({});
    setDragPositions({});
    saveKnowledgeMapPositions(identity, {});
    setRelayoutNonce((value) => value + 1);
    requestAnimationFrame(() => void fitView({ ...FIT_OPTIONS, duration: motionDuration(180) }));
  }

  return (
    <div className="knowledge-map-canvas" data-testid="knowledge-map-canvas">
      {visibleNodes.length === 0 ? (
        <div className="knowledge-map-mode-empty" role="status">
          <strong>
            {mode === 'weakness_map' ? '当前没有需要关注的地图节点' : '当前模式没有可显示内容'}
          </strong>
          <span>
            {mode === 'weakness_map'
              ? '复习到期、正式失败或修复出现时会显示在这里。'
              : '可以切换到知识结构查看完整课程。'}
          </span>
        </div>
      ) : (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          viewport={viewport}
          onViewportChange={setViewport}
          onMoveEnd={(_, next) => saveKnowledgeMapViewport(identity, next)}
          onNodesChange={handleNodesChange}
          onNodeClick={(event, node) => onSelectNode(node.id, event.currentTarget as HTMLElement)}
          onNodeDragStart={() => {
            draggingRef.current = true;
          }}
          onNodeDragStop={(_, node, moved) => {
            draggingRef.current = false;
            const changed = moved.length > 0 ? moved : [node];
            const next = { ...savedPositionsRef.current };
            for (const item of changed) next[item.id] = { ...item.position };
            savedPositionsRef.current = next;
            setSavedPositions(next);
            saveKnowledgeMapPositions(identity, next);
            setDragPositions((current) => {
              const cleaned = { ...current };
              for (const item of changed) delete cleaned[item.id];
              return cleaned;
            });
          }}
          onPaneClick={() => onSelectNode(null)}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          panOnDrag
          minZoom={0.18}
          maxZoom={2}
          onlyRenderVisibleElements={visibleNodes.length > 80}
          proOptions={{ hideAttribution: true }}
        >
          <InitialFit enabled={!initialViewport} />
          <EdgeMarkerDefs />
          <Background gap={28} size={1.2} />
          <Panel position="top-left" className="knowledge-map-search graph-overlay">
            <input
              type="search"
              aria-label="搜索知识地图"
              placeholder="搜索概念或学习单元"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchMatches[0]) chooseSearchResult(searchMatches[0]);
                if (event.key === 'Escape') setSearch('');
              }}
            />
            {searchMatches.length > 0 ? (
              <ul aria-label="知识地图搜索结果">
                {searchMatches.map((node) => (
                  <li key={node.id}>
                    <button type="button" onClick={() => chooseSearchResult(node)}>
                      <strong>{node.label}</strong>
                      <span>{NODE_KIND_LABELS[node.kind]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
          <Panel
            position="top-right"
            className="knowledge-map-controls graph-overlay"
            aria-label="地图视图控制"
          >
            <button
              type="button"
              aria-label="放大地图"
              title="放大"
              onClick={() => void zoomIn({ duration: motionDuration(120) })}
            >
              +
            </button>
            <button
              type="button"
              aria-label="缩小地图"
              title="缩小"
              onClick={() => void zoomOut({ duration: motionDuration(120) })}
            >
              −
            </button>
            <button
              type="button"
              aria-label="适配地图视图"
              title="适配视图"
              onClick={() => void fitView({ ...FIT_OPTIONS, duration: motionDuration(180) })}
            >
              <ViewportIcon name="fit" />
            </button>
            <button type="button" aria-label="重置地图布局" title="重置布局" onClick={resetLayout}>
              <ViewportIcon name="reset" />
            </button>
            <button
              type="button"
              aria-label={focusRootId ? '返回完整地图' : '聚焦所选节点邻域'}
              title={focusRootId ? '返回完整地图' : '聚焦邻域'}
              disabled={!selectedNodeId && !focusRootId}
              aria-pressed={Boolean(focusRootId)}
              onClick={() => setFocusRootId((current) => (current ? null : selectedNodeId))}
            >
              <ViewportIcon name="focus" />
            </button>
          </Panel>
          {focusRootId ? (
            <Panel
              position="top-center"
              className="knowledge-map-focus graph-overlay"
              role="status"
            >
              已聚焦所选节点的一跳关系
            </Panel>
          ) : null}
          <Panel
            position="bottom-left"
            className="knowledge-map-count graph-overlay"
            aria-label="地图规模"
          >
            {visibleNodes.length} 个节点 · {visibleEdges.length} 条关系
            {projection.limits.nodesTruncated || projection.limits.edgesTruncated
              ? ' · 已按本地上限截断'
              : ''}
          </Panel>
        </ReactFlow>
      )}
    </div>
  );
}

function projectionStatusMessage(projection: KnowledgeMapProjection): string | null {
  if (projection.status === 'unknown')
    return '当前课程路线或资料版本暂时无法对应，因此暂不显示学习状态。';
  if (projection.route.curriculumVersionId && !projection.route.studyPlanVersionId)
    return '课程结构已经准备好，学习路线将在学习安排生成后可用。';
  if (projection.status === 'partial') return '地图可用，但部分图关系或规模信息不完整。';
  return null;
}

function hasCompatibleLearnerState(projection: KnowledgeMapProjection): boolean {
  const learnerAuthorities = new Set([
    'formal_assessment',
    'formal_progression',
    'repair',
    'review',
    'mistake',
    'legacy_mastery',
  ]);
  return projection.nodes.some(
    (node) =>
      node.learner.progression.length > 0 ||
      node.learner.legacyMastery !== null ||
      node.weaknesses.some((signal) => !signal.advisory) ||
      node.learner.authorityRefs.some((ref) => learnerAuthorities.has(ref.authority)),
  );
}

function modeAvailable(projection: KnowledgeMapProjection, mode: KnowledgeMapMode): boolean {
  const hasPublishedStructure = projection.nodes.some(
    (node) => node.kind === 'curriculum_region' || node.kind === 'learning_unit',
  );
  if (!hasPublishedStructure) return false;
  if (mode === 'knowledge_structure') return true;
  if (mode === 'learning_route') return projection.route.current;
  return projection.route.current && hasCompatibleLearnerState(projection);
}

function navigationLabel(target: KnowledgeMapNavigationTarget): string {
  if (target.destination === 'study') return '前往学习';
  if (target.destination === 'materials') return '查看资料依据';
  if (target.destination === 'curriculum') return '查看课程结构';
  if (target.repairEpisodeId) return '查看修复';
  if (target.reviewTargetId) return '查看复习安排';
  return '查看正式证据';
}

interface KnowledgeMapInspectorProps {
  node: KnowledgeMapNode;
  projection: KnowledgeMapProjection;
  narrow: boolean;
  closeRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onNavigate: (target: KnowledgeMapNavigationTarget) => void;
  expanded: boolean;
  onExpand: () => void;
}

function KnowledgeMapInspector({
  node,
  projection,
  narrow,
  closeRef,
  onClose,
  onNavigate,
  expanded,
  onExpand,
}: KnowledgeMapInspectorProps) {
  const relationships = projection.edges
    .filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id)
    .slice(0, 8)
    .map((edge) => ({
      edge,
      other: projection.nodes.find(
        (candidate) =>
          candidate.id === (edge.sourceNodeId === node.id ? edge.targetNodeId : edge.sourceNodeId),
      ),
    }));
  const provenance = node.provenance.filter((item) => item.current);
  const quote = provenance.find((item) => item.quote)?.quote;
  const actions = node.navigation.filter((target, index, list) => {
    const key = `${target.destination}:${target.materialId ?? ''}:${target.learningUnitId ?? ''}:${
      target.repairEpisodeId ?? ''
    }:${target.reviewTargetId ?? ''}`;
    return (
      list.findIndex(
        (candidate) =>
          `${candidate.destination}:${candidate.materialId ?? ''}:${candidate.learningUnitId ?? ''}:${
            candidate.repairEpisodeId ?? ''
          }:${candidate.reviewTargetId ?? ''}` === key,
      ) === index
    );
  });

  function containFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!narrow || event.key !== 'Tab') return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <aside
      className="knowledge-map-inspector"
      id="knowledge-map-inspector"
      aria-label={`${node.label} 详情`}
      role={narrow ? 'dialog' : 'complementary'}
      aria-modal={narrow || undefined}
      onKeyDown={containFocus}
    >
      <header>
        <div>
          <span className="knowledge-map-inspector-kind">{NODE_KIND_LABELS[node.kind]}</span>
          <h3>{node.label}</h3>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          aria-label="关闭节点详情"
          title="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <section aria-labelledby="map-inspector-state">
        <h4 id="map-inspector-state">当前学习状态</h4>
        <strong>{PRIMARY_STATE_LABELS[node.learner.primaryState]}</strong>
        {node.learner.reasonCodes.map((reason) => (
          <p key={reason} className="small muted">
            {STATE_REASON_LABELS[reason]}
          </p>
        ))}
        <div className="knowledge-map-inspector-facts">
          <span>
            <b>路线位置</b>
            {ROUTE_POSITION_LABELS[node.route.position]}
          </span>
          <span>
            <b>正式验证</b>
            {formalValidationLabel(node.learner.formalValidation)}
          </span>
        </div>
        {node.route.prerequisiteLocked ? (
          <p className="map-inspector-lock">
            需要先完成 {node.route.lockedByNodeIds.length} 项先修内容。
          </p>
        ) : null}
        {node.route.agendaDiffersFromPlan ? (
          <p className="small">本次安排是临时调整；已接受的长期学习路线没有被改写。</p>
        ) : null}
      </section>
      {node.weaknesses.length > 0 ? (
        <section aria-labelledby="map-inspector-attention">
          <h4 id="map-inspector-attention">为什么需要关注</h4>
          <ul className="knowledge-map-signal-list">
            {node.weaknesses.map((signal) => {
              const presentation = WEAKNESS_PRESENTATION[signal.kind];
              return (
                <li
                  key={`${signal.kind}:${signal.recordIds.join(':')}`}
                  className={`tone-${presentation.tone}`}
                >
                  <strong>{presentation.label}</strong>
                  <span>{presentation.detail}</span>
                  {signal.advisory ? <em>仅供提示，不改变正式状态</em> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {relationships.length > 0 ? (
        <section aria-labelledby="map-inspector-relations">
          <h4 id="map-inspector-relations">课程关系</h4>
          <ul className="knowledge-map-relation-list">
            {relationships.map(({ edge, other }) => (
              <li key={edge.id}>
                <span>{EDGE_KIND_LABELS[edge.kind]}</span>
                <strong>{other?.label ?? '课程内容'}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {(() => {
        const detailCount =
          node.kind === 'curriculum_region'
            ? node.childNodeIds.length
            : node.kind === 'learning_unit'
              ? node.conceptNodeIds.length
              : node.kind === 'synthesis'
                ? node.learningUnitNodeIds.length
                : 0;
        return detailCount > 0 ? (
          <section aria-labelledby="map-inspector-detail">
            <h4 id="map-inspector-detail">主题细节</h4>
            <p className="small muted">可查看 {detailCount} 个底层课程对象及其来源依据。</p>
            <button type="button" onClick={onExpand} disabled={expanded}>
              {expanded ? '已展开底层对象' : '展开底层对象'}
            </button>
          </section>
        ) : null;
      })()}
      {provenance.length > 0 ? (
        <section aria-labelledby="map-inspector-source">
          <h4 id="map-inspector-source">来源依据</h4>
          <p>{provenance.length} 处当前课程资料依据</p>
          {quote ? <blockquote>{quote}</blockquote> : null}
          <p className="small muted">逐字核对只说明引文出现在标注位置，不单独证明完整语义蕴含。</p>
        </section>
      ) : null}
      {actions.length > 0 ? (
        <footer aria-label="下一步操作">
          {actions.map((target, index) => (
            <button
              key={`${target.destination}:${target.repairEpisodeId ?? ''}:${target.reviewTargetId ?? ''}:${index}`}
              type="button"
              className={index === 0 ? 'primary' : undefined}
              onClick={() => onNavigate(target)}
            >
              {navigationLabel(target)}
            </button>
          ))}
        </footer>
      ) : (
        <p className="small muted">当前节点没有可直接执行的操作。</p>
      )}
    </aside>
  );
}

function formalValidationLabel(value: KnowledgeMapNode['learner']['formalValidation']): string {
  const labels: Record<typeof value, string> = {
    not_applicable: '暂不需要',
    awaiting: '等待验证',
    supported: '已有支持证据',
    current_failure: '当前未通过',
    unknown: '待确认',
  };
  return labels[value];
}

export function KnowledgeMapView({
  workspaceId,
  refreshKey,
  intent = null,
  onNavigate,
}: KnowledgeMapViewProps) {
  const [projection, setProjection] = useState<KnowledgeMapProjection | null>(null);
  const [mode, setMode] = useState<KnowledgeMapMode>(intent?.mode ?? 'knowledge_structure');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 767px)').matches ?? false,
  );
  const requestSequence = useRef(0);
  const errorWorkspaceRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setExpandedNodeIds(new Set());
  }, [workspaceId]);

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 767px)');
    const update = () => setNarrow(query?.matches ?? false);
    update();
    query?.addEventListener?.('change', update);
    return () => query?.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    const capturedWorkspaceId = workspaceId;
    setError(null);
    errorWorkspaceRef.current = null;
    setProjection((current) => (current?.workspaceId === capturedWorkspaceId ? current : null));
    void api
      .getKnowledgeMap(capturedWorkspaceId, controller.signal)
      .then((response) => {
        if (
          controller.signal.aborted ||
          sequence !== requestSequence.current ||
          response.projection.workspaceId !== capturedWorkspaceId
        ) {
          return;
        }
        setProjection(response.projection);
      })
      .catch((reason) => {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          errorWorkspaceRef.current = capturedWorkspaceId;
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      controller.abort();
      requestSequence.current += 1;
    };
  }, [refreshKey, retryKey, workspaceId]);

  useEffect(() => {
    if (!projection || projection.workspaceId !== workspaceId || !intent) return;
    setMode(intent.mode);
    setSelectedNodeId(resolvedIntentNode(projection, intent));
  }, [intent, projection, workspaceId]);

  const currentProjection = projection?.workspaceId === workspaceId ? projection : null;
  const currentError = errorWorkspaceRef.current === workspaceId ? error : null;

  const selectedNode = useMemo(
    () => currentProjection?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [currentProjection, selectedNodeId],
  );

  const closeInspector = useCallback(() => {
    setSelectedNodeId(null);
    window.setTimeout(() => {
      const selectedElement = selectedNodeId
        ? [...(rootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])].find(
            (element) => element.dataset.id === selectedNodeId,
          )
        : null;
      (returnFocusRef.current?.isConnected ? returnFocusRef.current : selectedElement)?.focus();
    }, 0);
  }, [selectedNodeId]);

  useEffect(() => {
    if (!selectedNode) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeInspector();
      }
    };
    document.addEventListener('keydown', onEscape);
    if (narrow) window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => document.removeEventListener('keydown', onEscape);
  }, [closeInspector, narrow, selectedNode]);

  function selectNode(nodeId: string | null, returnTarget?: HTMLElement | null): void {
    if (nodeId)
      returnFocusRef.current = returnTarget ?? (document.activeElement as HTMLElement | null);
    setSelectedNodeId(nodeId);
  }

  if (!currentProjection && !currentError) return <Loading label="正在读取知识地图…" />;
  if (currentError && !currentProjection) {
    return (
      <section className="knowledge-map-load-state" role="alert">
        <strong>知识地图暂时无法读取</strong>
        <p>课程资料和学习状态没有改变。{currentError}</p>
        <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
          重试
        </button>
      </section>
    );
  }
  if (!currentProjection) return null;
  if (
    !currentProjection.nodes.some(
      (node) => node.kind === 'curriculum_region' || node.kind === 'learning_unit',
    )
  ) {
    return (
      <section className="knowledge-map-load-state" role="status">
        <strong>课程结构还没有准备完成</strong>
        <p>知识地图将在课程结构确认后生成。概念分析等内部准备结果会继续保留。</p>
      </section>
    );
  }
  const availableModes = KNOWLEDGE_MAP_MODES.filter((item) =>
    modeAvailable(currentProjection, item.mode),
  );
  const visibleMode = availableModes.some((item) => item.mode === mode)
    ? mode
    : 'knowledge_structure';
  const presentation = modePresentation(visibleMode);
  const statusMessage = projectionStatusMessage(currentProjection);
  return (
    <div
      ref={rootRef}
      className={`knowledge-map-view${selectedNode ? ' inspector-open' : ''}`}
      aria-label="知识地图"
    >
      <header className="knowledge-map-header">
        <div>
          <p className="eyebrow">知识地图</p>
          <h2>{presentation.question}</h2>
          <p className="muted">{presentation.summary}</p>
        </div>
        <div className="knowledge-map-mode-tabs" role="tablist" aria-label="知识地图模式">
          {availableModes.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="tab"
              aria-selected={mode === item.mode}
              aria-controls="knowledge-map-panel"
              tabIndex={mode === item.mode ? 0 : -1}
              className={mode === item.mode ? 'active' : ''}
              onClick={() => setMode(item.mode)}
              onKeyDown={(event) => {
                const current = availableModes.findIndex(
                  (candidate) => candidate.mode === visibleMode,
                );
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!offset) return;
                event.preventDefault();
                const next =
                  availableModes[
                    (current + offset + availableModes.length) % availableModes.length
                  ]!;
                setMode(next.mode);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`)
                    ?.focus(),
                );
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      {statusMessage ? <Banner kind="info">{statusMessage}</Banner> : null}
      {currentError ? (
        <Banner kind="error">地图刷新未完成，仍显示这门课程上一次有效结果。{currentError}</Banner>
      ) : null}
      <div className="knowledge-map-stage" id="knowledge-map-panel" role="tabpanel">
        <ReactFlowProvider>
          <KnowledgeMapCanvas
            key={knowledgeMapIdentity(currentProjection)}
            projection={currentProjection}
            mode={visibleMode}
            selectedNodeId={selectedNodeId}
            expandedNodeIds={expandedNodeIds}
            focusRequestId={intent?.requestId ?? null}
            onSelectNode={selectNode}
          />
        </ReactFlowProvider>
        {selectedNode ? (
          <>
            {narrow ? (
              <button
                type="button"
                className="knowledge-map-sheet-backdrop"
                aria-label="关闭节点详情"
                onClick={closeInspector}
              />
            ) : null}
            <KnowledgeMapInspector
              node={selectedNode}
              projection={currentProjection}
              narrow={narrow}
              closeRef={closeRef}
              onClose={closeInspector}
              onNavigate={onNavigate}
              expanded={expandedNodeIds.has(selectedNode.id)}
              onExpand={() =>
                setExpandedNodeIds((current) => new Set(current).add(selectedNode.id))
              }
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
