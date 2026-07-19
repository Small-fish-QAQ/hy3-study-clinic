import { useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Concept, ConceptLearnerState, GraphEdge, GraphRelation } from '@hy3-clinic/shared';

/**
 * Interactive personal learning graph.
 *
 * Rendering uses @xyflow/react (React Flow 12) — a small, actively
 * maintained, React-18-compatible graph renderer with built-in pan/zoom,
 * node/edge selection, and keyboard focus. Layout is computed LOCALLY and
 * deterministically (longest-path layering over prerequisite edges), so no
 * layout dependency and no randomness is introduced.
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
  prerequisite: '#2563eb',
  part_of: '#7c3aed',
  contrasts_with: '#d97706',
  causes: '#dc2626',
  applies_to: '#0d9488',
  example_of: '#64748b',
};

const STATE_LABELS: Record<ConceptLearnerState['state'], string> = {
  unassessed: '未评估',
  weak: '薄弱',
  developing: '进步中',
  stable: '稳固',
};

export interface ConceptGraphProps {
  concepts: Concept[];
  edges: GraphEdge[];
  /** Learner overlay keyed by conceptId (may be empty while loading). */
  overlay: Map<string, ConceptLearnerState>;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (conceptId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
}

interface ConceptNodeData extends Record<string, unknown> {
  name: string;
  state: ConceptLearnerState['state'] | 'unknown';
  masteryPct: number | null;
  openMistakes: number;
}

/**
 * Deterministic layered layout: prerequisite edges define layers via
 * longest-path from roots; everything else keeps input order. Stable for
 * small graphs, disconnected nodes, and dozens of concepts.
 */
export function layoutConcepts(
  concepts: Concept[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const ids = concepts.map((c) => c.id);
  const idSet = new Set(ids);
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'prerequisite') continue;
    if (!idSet.has(edge.sourceConceptId) || !idSet.has(edge.targetConceptId)) continue;
    const list = incoming.get(edge.targetConceptId) ?? [];
    list.push(edge.sourceConceptId);
    incoming.set(edge.targetConceptId, list);
  }

  // Longest-path layering with cycle guard (validation forbids cycles, but
  // layout must terminate on any persisted data).
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (id: string): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(layer)) + 1;
    visiting.delete(id);
    layerOf.set(id, value);
    return value;
  };
  ids.forEach(layer);

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layerOf.get(id) ?? 0;
    const list = byLayer.get(l) ?? [];
    list.push(id);
    byLayer.set(l, list);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const COL_WIDTH = 240;
  const ROW_HEIGHT = 150;
  const MAX_PER_ROW = 5;
  for (const [l, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    members.forEach((id, i) => {
      const row = Math.floor(i / MAX_PER_ROW);
      const col = i % MAX_PER_ROW;
      const rowCount = Math.min(members.length - row * MAX_PER_ROW, MAX_PER_ROW);
      const xOffset = -((rowCount - 1) * COL_WIDTH) / 2;
      positions.set(id, {
        x: xOffset + col * COL_WIDTH,
        y: l * ROW_HEIGHT + row * (ROW_HEIGHT / 2),
      });
    });
  }
  return positions;
}

function ConceptNode({ data, selected }: NodeProps<FlowNode<ConceptNodeData>>) {
  const stateClass = data.state === 'unknown' ? 'unassessed' : data.state;
  return (
    <div
      className={`concept-node ${stateClass} ${selected ? 'selected' : ''} ${
        data.state === 'weak' ? 'weak-emphasis' : ''
      }`}
      aria-label={`概念 ${data.name}(${
        data.state === 'unknown' ? '学习状态未加载' : STATE_LABELS[data.state]
      }${data.openMistakes > 0 ? `,${data.openMistakes} 道未解决错题` : ''})`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="concept-node-name">{data.name}</span>
      <span className="concept-node-meta">
        {data.masteryPct !== null ? `${data.masteryPct}%` : '未评估'}
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

export function ConceptGraph({
  concepts,
  edges,
  overlay,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
}: ConceptGraphProps) {
  const flowNodes = useMemo<FlowNode<ConceptNodeData>[]>(() => {
    const positions = layoutConcepts(concepts, edges);
    return concepts.map((concept) => {
      const state = overlay.get(concept.id);
      return {
        id: concept.id,
        type: 'concept' as const,
        position: positions.get(concept.id) ?? { x: 0, y: 0 },
        selected: selectedNodeId === concept.id,
        data: {
          name: concept.name,
          state: state?.state ?? 'unknown',
          masteryPct: state?.mastery != null ? Math.round(state.mastery * 100) : null,
          openMistakes: state?.openMistakes ?? 0,
        },
      };
    });
  }, [concepts, edges, overlay, selectedNodeId]);

  const conceptIds = useMemo(() => new Set(concepts.map((c) => c.id)), [concepts]);
  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      edges
        .filter((e) => conceptIds.has(e.sourceConceptId) && conceptIds.has(e.targetConceptId))
        .map((edge) => ({
          id: edge.id,
          source: edge.sourceConceptId,
          target: edge.targetConceptId,
          selected: selectedEdgeId === edge.id,
          label: RELATION_LABELS[edge.relation],
          className: `graph-edge relation-${edge.relation}`,
          style: { stroke: RELATION_COLORS[edge.relation], strokeWidth: 2 },
          labelStyle: { fill: RELATION_COLORS[edge.relation], fontSize: 11 },
          animated: edge.relation === 'prerequisite',
        })),
    [edges, conceptIds, selectedEdgeId],
  );

  return (
    <div className="graph-canvas" data-testid="concept-graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        nodesConnectable={false}
        // Layout is deterministic and recomputed from data; dragging nodes is
        // intentionally off (positions are not persisted, and d3-drag breaks
        // under jsdom's null event.view). Pan/zoom/selection remain active.
        nodesDraggable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** Legend explaining node states and relation colors. */
export function GraphLegend() {
  return (
    <div className="graph-legend" aria-label="图例">
      <span className="legend-group">
        节点:
        <span className="legend-chip unassessed">未评估</span>
        <span className="legend-chip weak">薄弱</span>
        <span className="legend-chip developing">进步中</span>
        <span className="legend-chip stable">稳固</span>
      </span>
      <span className="legend-group">
        关系:
        {(Object.keys(RELATION_LABELS) as GraphRelation[]).map((relation) => (
          <span key={relation} className="legend-relation">
            <span className="legend-line" style={{ backgroundColor: RELATION_COLORS[relation] }} />
            {RELATION_LABELS[relation]}
          </span>
        ))}
      </span>
    </div>
  );
}
