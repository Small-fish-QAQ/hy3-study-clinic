import { memo, useMemo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useStore,
  useStoreApi,
  type Edge as FlowEdge,
  type EdgeProps,
} from '@xyflow/react';
import type { GraphRelation } from '@hy3-clinic/shared';
import { sanitizeRect, type Rect } from './edgeGeometry.js';
import { assignSidePorts, routeEdge, type IncidentEdge, type RouteMode } from './edgeRouting.js';
import { polylineIntersectsRect } from './graphClarity.js';
import type { GraphRoutePlan } from './routePlan.js';
import { markerId, RELATION_COLORS, RELATION_DASH, relationHasDirection } from './relationStyle.js';

/**
 * Floating, obstacle-aware learning edge.
 *
 * At rest, every edge renders its route from the shared crossing-minimized
 * plan (see routePlan.ts) that ConceptGraph recomputes when geometry
 * meaningfully changes. During a drag — detected purely from geometry: the
 * edge's endpoints (or a card overlapping its planned path) have moved away
 * from the plan's snapshot — the edge falls back to fast local routing:
 * boundary endpoints follow the pointer in real time, obstacle avoidance
 * stays live, and no whole-graph optimization runs per pointer event. One
 * fresh plan on drag stop converges everything again.
 *
 * Every visible edge renders as a casing pair: a slightly wider under-stroke
 * in the canvas background color beneath the semantic colored stroke, so
 * unavoidable crossings stay legible (the upper edge visually bridges the
 * lower one). Geometry recomputes only when node positions, dimensions, or
 * the semantic edge set change — hover and selection restyle without
 * rerouting.
 */

export type EdgeEmphasis = 'normal' | 'related' | 'selected' | 'dimmed';

export interface LearningEdgeData extends Record<string, unknown> {
  relation: GraphRelation;
  labelText: string;
  showLabel: boolean;
  emphasis: EdgeEmphasis;
  evidenceCount: number;
  lane: number;
  laneCount: number;
  mode: RouteMode;
  /** Shared static incident-edge lists per concept (see planNodeEdgeOrder). */
  incidentByNode: ReadonlyMap<string, IncidentEdge[]>;
  /** Shared estimated sizes — fallback before React Flow measures a node. */
  fallbackSizes: ReadonlyMap<string, { width: number; height: number }>;
  /** Shared crossing-minimized route plan for the current stable geometry. */
  routePlan: GraphRoutePlan | null;
}

export type LearningFlowEdge = FlowEdge<LearningEdgeData>;

const EMPHASIS_OPACITY: Record<EdgeEmphasis, number> = {
  normal: 0.42,
  related: 0.8,
  selected: 1,
  dimmed: 0.13,
};

/** Casing under-stroke extra width (px) on top of the colored stroke. */
const CASING_EXTRA_WIDTH = 2.1;

const FALLBACK_RECT: Rect = { x: 0, y: 0, width: 160, height: 56 };
const EMPTY_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map();

interface InternalNodeShape {
  id: string;
  internals: { positionAbsolute: { x: number; y: number } };
  measured: { width?: number | null; height?: number | null };
}

type NodeLookupShape = ReadonlyMap<string, InternalNodeShape>;

/**
 * Compact fingerprint of every node's absolute position and measured size.
 * Any change (drag frame, layout, measurement) invalidates routed geometry;
 * hover/selection state is deliberately absent, so restyling can never
 * trigger rerouting.
 */
function geometryFingerprint(state: { nodeLookup: NodeLookupShape }): string {
  let out = '';
  for (const [id, node] of state.nodeLookup) {
    const pos = node.internals.positionAbsolute;
    out += `${id}:${pos.x.toFixed(1)},${pos.y.toFixed(1)},${node.measured.width ?? 0}x${
      node.measured.height ?? 0
    };`;
  }
  return out;
}

function rectOf(
  node: InternalNodeShape | undefined,
  id: string,
  fallbackSizes: ReadonlyMap<string, { width: number; height: number }>,
): Rect {
  const fallback = fallbackSizes.get(id) ?? FALLBACK_RECT;
  if (!node) return { x: 0, y: 0, width: fallback.width, height: fallback.height };
  return sanitizeRect(
    {
      x: node.internals.positionAbsolute.x,
      y: node.internals.positionAbsolute.y,
      width: node.measured.width ?? fallback.width,
      height: node.measured.height ?? fallback.height,
    },
    { x: 0, y: 0, width: fallback.width, height: fallback.height },
  );
}

function rectsAlmostEqual(a: Rect | undefined, b: Rect, epsilon = 0.5): boolean {
  if (!a) return false;
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  );
}

function FloatingLearningEdgeComponent({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<LearningFlowEdge>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const store = useStoreApi();
  const geometryKey = useStore(geometryFingerprint);

  const relation = data?.relation ?? 'prerequisite';
  const lane = data?.lane ?? 0;
  const mode: RouteMode = data?.mode ?? 'network';
  const incidentByNode = data?.incidentByNode;
  const fallbackSizes = data?.fallbackSizes ?? EMPTY_SIZES;
  const routePlan = data?.routePlan ?? null;

  const routed = useMemo(() => {
    const lookup = store.getState().nodeLookup as unknown as NodeLookupShape;
    const sourceRect = rectOf(lookup.get(source), source, fallbackSizes);
    const targetRect = rectOf(lookup.get(target), target, fallbackSizes);

    // Stable geometry → the shared crossing-minimized plan is authoritative.
    const planned = routePlan?.routes.get(id);
    if (
      planned &&
      rectsAlmostEqual(routePlan!.rects.get(source), sourceRect) &&
      rectsAlmostEqual(routePlan!.rects.get(target), targetRect)
    ) {
      // A node being dragged across this edge's planned path forces a live
      // local reroute (dodge); everything else keeps its planned route.
      let blocked = false;
      for (const [nodeId, node] of lookup) {
        if (nodeId === source || nodeId === target) continue;
        const live = rectOf(node, nodeId, fallbackSizes);
        if (rectsAlmostEqual(routePlan!.rects.get(nodeId), live)) continue;
        if (polylineIntersectsRect(planned.polyline, live, 4)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return planned.route;
    }

    // Fast local routing (drag frames, pre-measurement, plan misses):
    // geometry-aware ports and obstacle avoidance, no crossing optimization.
    const slotFor = (nodeId: string, nodeRect: Rect) => {
      const incident = incidentByNode?.get(nodeId);
      if (!incident || incident.length <= 1) return undefined;
      const ports = assignSidePorts(nodeRect, incident, (conceptId) =>
        rectOf(lookup.get(conceptId), conceptId, fallbackSizes),
      );
      return ports.get(id);
    };

    const obstacles: Rect[] = [];
    for (const [nodeId, node] of lookup) {
      if (nodeId === source || nodeId === target) continue;
      obstacles.push(rectOf(node, nodeId, fallbackSizes));
    }

    return routeEdge({
      source: sourceRect,
      target: targetRect,
      obstacles,
      lane,
      mode,
      sourceSlot: slotFor(source, sourceRect),
      targetSlot: slotFor(target, targetRect),
    });
    // geometryKey covers every lookup-derived input (positions + sizes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    geometryKey,
    source,
    target,
    id,
    lane,
    mode,
    incidentByNode,
    fallbackSizes,
    routePlan,
    store,
  ]);

  if (!sourceNode || !targetNode || !data) return null;

  const emphasis: EdgeEmphasis = selected ? 'selected' : data.emphasis;
  const color = RELATION_COLORS[relation];
  const baseWidth = 1.1 + Math.min(data.evidenceCount, 3) * 0.3;
  const strokeWidth = emphasis === 'selected' ? baseWidth + 0.9 : baseWidth;
  const marker = relationHasDirection(relation)
    ? `url(#${markerId(relation, emphasis === 'selected')})`
    : undefined;

  return (
    <>
      <g
        className={`learning-edge-group emphasis-${emphasis}`}
        style={{ opacity: EMPHASIS_OPACITY[emphasis] }}
      >
        <path
          d={routed.path}
          className="learning-edge-casing"
          fill="none"
          strokeWidth={strokeWidth + CASING_EXTRA_WIDTH}
          strokeDasharray={RELATION_DASH[relation]}
          strokeLinecap="round"
          aria-hidden="true"
        />
        <BaseEdge
          id={id}
          path={routed.path}
          markerEnd={marker}
          className={`learning-edge relation-${relation} emphasis-${emphasis}`}
          style={{
            stroke: color,
            strokeWidth,
            strokeDasharray: RELATION_DASH[relation],
          }}
        />
      </g>
      {data.showLabel ? (
        <EdgeLabelRenderer>
          <div
            className={`edge-label-pill relation-${relation} ${
              emphasis === 'dimmed' ? 'dimmed' : ''
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${routed.labelX}px, ${routed.labelY}px)`,
              color,
            }}
          >
            {data.labelText}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const FloatingLearningEdge = memo(FloatingLearningEdgeComponent);

/**
 * Static SVG marker definitions — one restrained arrow per relation plus a
 * slightly larger selected variant. Stable IDs, colors matching the relation
 * palette, tips landing exactly on the routed path end (the target node
 * boundary), narrow bodies that stay outside the card.
 */
export function EdgeMarkerDefs() {
  const relations = Object.keys(RELATION_COLORS) as GraphRelation[];
  return (
    <svg className="edge-marker-defs" aria-hidden="true" focusable="false">
      <defs>
        {relations
          .filter((relation) => relationHasDirection(relation))
          .flatMap((relation) =>
            [false, true].map((strong) => {
              const length = strong ? 9 : 7;
              const halfHeight = strong ? 3.2 : 2.6;
              const notch = strong ? 2 : 1.6;
              return (
                <marker
                  key={markerId(relation, strong)}
                  id={markerId(relation, strong)}
                  viewBox={`0 0 ${length} ${halfHeight * 2}`}
                  markerWidth={length}
                  markerHeight={halfHeight * 2}
                  markerUnits="userSpaceOnUse"
                  refX={length}
                  refY={halfHeight}
                  orient="auto"
                >
                  <path
                    d={`M 0 0 L ${length} ${halfHeight} L 0 ${halfHeight * 2} L ${notch} ${halfHeight} Z`}
                    fill={RELATION_COLORS[relation]}
                  />
                </marker>
              );
            }),
          )}
      </defs>
    </svg>
  );
}
