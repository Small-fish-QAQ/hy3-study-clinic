/**
 * Deterministic whole-graph route planning.
 *
 * The per-edge router (edgeRouting.ts) picks the best candidate for one edge
 * given a context; this module owns the context: it routes every visible
 * edge in a stable order, scores candidates against already-planned routes,
 * and then runs a small bounded improvement phase that revisits crossing
 * edge pairs and re-routes them against the full current plan.
 *
 * Everything here is a pure function of its input. The plan is recomputed
 * only when geometry meaningfully changes (initial layout, relayout, visible
 * subgraph change, layout-mode change, completed node drag) — never on
 * hover, selection, or per-frame drag movement (drag uses the fast per-edge
 * path in FloatingLearningEdge and converges to a fresh plan on drag stop).
 */
import { cubicPoint, quadraticPoint, type Point, type Rect } from './edgeGeometry.js';
import {
  assignSidePorts,
  planNodeEdgeOrder,
  routeEdge,
  type EdgeLike,
  type LanePlan,
  type PortAssignment,
  type RouteContextEdge,
  type RouteMode,
  type RoutedEdge,
} from './edgeRouting.js';
import {
  comparePathPair,
  evaluateRoutedGraph,
  polylineIntersectsRect,
  routedPolyline,
  NEAR_OVERLAP_RUN,
  type PlanClarityMetrics,
  type RoutedGraphEdge,
} from './graphClarity.js';

export interface GraphRouteInput {
  /** Rect (position + size) of every visible node. */
  rects: ReadonlyMap<string, Rect>;
  edges: readonly EdgeLike[];
  lanePlans: ReadonlyMap<string, LanePlan>;
  mode: RouteMode;
}

export interface PlanOptions {
  /** Score candidates against other routes (off = legacy greedy baseline). */
  crossingAware?: boolean;
  /** Improvement passes over crossing pairs (0 = greedy only). */
  maxImprovementPasses?: number;
}

export interface PlannedEdgeRoute {
  route: RoutedEdge;
  polyline: readonly Point[];
}

export interface GraphRoutePlan {
  routes: ReadonlyMap<string, PlannedEdgeRoute>;
  /** Geometry snapshot the plan was computed from. */
  rects: ReadonlyMap<string, Rect>;
  metrics: PlanClarityMetrics;
  /** Improvement passes actually run (bounded by maxImprovementPasses). */
  improvementPasses: number;
}

const FALLBACK_RECT: Rect = { x: 0, y: 0, width: 160, height: 56 };
/** Mirrors the router's cost tiers for metric-based acceptance. */
const NODE_HIT_PENALTY = 10000;
const CROSSING_PENALTY = 700;
const OVERLAP_PENALTY_PER_PX = 2.2;
const OVERLAP_FREE_RUN = 24;
const MAX_IMPROVEMENT_PASSES = 3;
const LABEL_CLEAR_RADIUS = 16;
const LABEL_SEPARATION = 18;

function pairKeyOf(edge: EdgeLike): string {
  return [edge.sourceConceptId, edge.targetConceptId].sort().join(' ');
}

function polylineLength(polyline: readonly Point[]): number {
  let length = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    length += Math.hypot(polyline[i + 1]!.x - polyline[i]!.x, polyline[i + 1]!.y - polyline[i]!.y);
  }
  return length;
}

/** Point at fraction t of a routed path (exact curve evaluation). */
export function routePointAt(route: RoutedEdge, t: number): Point {
  const { sourcePoint: p0, targetPoint: p1, controlPoints } = route;
  if (controlPoints.length === 0) {
    return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  }
  if (controlPoints.length === 1) return quadraticPoint(p0, controlPoints[0]!, p1, t);
  return cubicPoint(p0, controlPoints[0]!, controlPoints[1]!, p1, t);
}

/**
 * Plan routes for every edge of the visible graph. Deterministic: stable
 * edge order (by id), stable candidate order, bounded improvement passes
 * with strict-improvement acceptance, early stop when nothing improves.
 */
export function planGraphRoutes(input: GraphRouteInput, options: PlanOptions = {}): GraphRoutePlan {
  const crossingAware = options.crossingAware ?? true;
  const maxPasses = options.maxImprovementPasses ?? MAX_IMPROVEMENT_PASSES;
  const { rects, lanePlans, mode } = input;
  const edges = [...input.edges].sort((a, b) => a.id.localeCompare(b.id));
  const rectOf = (id: string): Rect => rects.get(id) ?? FALLBACK_RECT;

  // Geometry-aware ports, computed once per node from the plan's snapshot.
  const incidentByNode = planNodeEdgeOrder(edges);
  const portsByNode = new Map<string, Map<string, PortAssignment>>();
  for (const [nodeId, incident] of incidentByNode) {
    portsByNode.set(nodeId, assignSidePorts(rectOf(nodeId), incident, rectOf));
  }

  const obstaclesFor = (edge: EdgeLike): Rect[] => {
    const list: Rect[] = [];
    for (const [nodeId, rect] of rects) {
      if (nodeId === edge.sourceConceptId || nodeId === edge.targetConceptId) continue;
      list.push(rect);
    }
    return list;
  };

  const routes = new Map<string, PlannedEdgeRoute>();

  /** Context for one edge: every OTHER planned route except same-pair lanes. */
  const contextFor = (edge: EdgeLike): RouteContextEdge[] => {
    const myPair = pairKeyOf(edge);
    const context: RouteContextEdge[] = [];
    for (const other of edges) {
      if (other.id === edge.id) continue;
      const planned = routes.get(other.id);
      if (!planned) continue;
      if (pairKeyOf(other) === myPair) continue;
      const sharedRects = [other.sourceConceptId, other.targetConceptId]
        .filter((id) => id === edge.sourceConceptId || id === edge.targetConceptId)
        .map(rectOf);
      context.push({ polyline: planned.polyline, sharedRects });
    }
    return context;
  };

  const routeOne = (edge: EdgeLike, context: RouteContextEdge[] | undefined): PlannedEdgeRoute => {
    const route = routeEdge({
      source: rectOf(edge.sourceConceptId),
      target: rectOf(edge.targetConceptId),
      obstacles: obstaclesFor(edge),
      lane: lanePlans.get(edge.id)?.lane ?? 0,
      sourceSlot: portsByNode.get(edge.sourceConceptId)?.get(edge.id),
      targetSlot: portsByNode.get(edge.targetConceptId)?.get(edge.id),
      mode,
      context,
    });
    return { route, polyline: routedPolyline(route) };
  };

  // ---- Greedy pass: stable order, each edge scored against prior routes.
  for (const edge of edges) {
    routes.set(edge.id, routeOne(edge, crossingAware ? contextFor(edge) : undefined));
  }

  /**
   * Metric score of one edge's route against the current plan. Crossing and
   * overlap penalties are symmetric per pair, so a strict per-edge
   * improvement is exactly a strict global-score improvement.
   */
  const metricEdgeScore = (
    edge: EdgeLike,
    polyline: readonly Point[],
    context: readonly RouteContextEdge[],
  ): number => {
    let score = polylineLength(polyline);
    for (const rect of obstaclesFor(edge)) {
      if (polylineIntersectsRect(polyline, rect, 2)) score += NODE_HIT_PENALTY;
    }
    for (const other of context) {
      const report = comparePathPair(polyline, other.polyline, {
        sharedNodeRects: other.sharedRects,
      });
      score += report.crossings.length * CROSSING_PENALTY;
      const excess = report.overlapLength - OVERLAP_FREE_RUN;
      if (excess > NEAR_OVERLAP_RUN - OVERLAP_FREE_RUN) score += excess * OVERLAP_PENALTY_PER_PX;
    }
    return score;
  };

  // ---- Bounded improvement phase over crossing pairs.
  let passesRun = 0;
  if (crossingAware) {
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    for (let pass = 0; pass < maxPasses; pass++) {
      // Crossing pairs in stable (idA, idB) order.
      const crossingPairs: Array<[string, string]> = [];
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const a = edges[i]!;
          const b = edges[j]!;
          if (pairKeyOf(a) === pairKeyOf(b)) continue;
          const sharedRects = [a.sourceConceptId, a.targetConceptId]
            .filter((id) => id === b.sourceConceptId || id === b.targetConceptId)
            .map(rectOf);
          const report = comparePathPair(routes.get(a.id)!.polyline, routes.get(b.id)!.polyline, {
            sharedNodeRects: sharedRects,
          });
          if (report.crossings.length > 0) crossingPairs.push([a.id, b.id]);
        }
      }
      // Revisit set: every edge of a crossing pair, plus any edge whose
      // final path sits on a non-endpoint card (the greedy order can lock
      // either defect in). Deterministic: pair order first, then edge order.
      const revisitIds: string[] = [];
      for (const pair of crossingPairs) {
        for (const edgeId of pair) {
          if (!revisitIds.includes(edgeId)) revisitIds.push(edgeId);
        }
      }
      for (const edge of edges) {
        if (revisitIds.includes(edge.id)) continue;
        const polyline = routes.get(edge.id)!.polyline;
        if (obstaclesFor(edge).some((rect) => polylineIntersectsRect(polyline, rect, 2))) {
          revisitIds.push(edge.id);
        }
      }
      if (revisitIds.length === 0) break;
      passesRun += 1;
      let improved = false;
      for (const edgeId of revisitIds) {
        const edge = edgeById.get(edgeId)!;
        const context = contextFor(edge);
        const current = routes.get(edgeId)!;
        const candidate = routeOne(edge, context);
        if (candidate.route.path === current.route.path) continue;
        const currentScore = metricEdgeScore(edge, current.polyline, context);
        const candidateScore = metricEdgeScore(edge, candidate.polyline, context);
        if (candidateScore < currentScore - 1e-6) {
          routes.set(edgeId, candidate);
          improved = true;
        }
      }
      if (!improved) break;
    }
  }

  // ---- Metrics on the final plan.
  const routedForMetrics: RoutedGraphEdge[] = edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceConceptId,
    targetId: edge.targetConceptId,
    polyline: routes.get(edge.id)!.polyline,
  }));
  const metrics = evaluateRoutedGraph(routedForMetrics, rects);

  // ---- Label placement: keep labels off crossings and off each other.
  // Bounded deterministic nudges along the path; routes are not changed.
  const placedLabels: Point[] = [];
  for (const edge of edges) {
    const planned = routes.get(edge.id)!;
    const route = planned.route;
    const fractions = [route.labelT, route.labelT + 0.12, route.labelT - 0.12, route.labelT + 0.24];
    let chosen = { x: route.labelX, y: route.labelY };
    let chosenT = route.labelT;
    for (const fraction of fractions) {
      const t = Math.min(0.75, Math.max(0.25, fraction));
      const point = routePointAt(route, t);
      const clearOfCrossings = metrics.crossingPoints.every(
        (cross) => Math.hypot(cross.x - point.x, cross.y - point.y) >= LABEL_CLEAR_RADIUS,
      );
      const clearOfLabels = placedLabels.every(
        (label) => Math.hypot(label.x - point.x, label.y - point.y) >= LABEL_SEPARATION,
      );
      if (clearOfCrossings && clearOfLabels) {
        chosen = point;
        chosenT = t;
        break;
      }
    }
    placedLabels.push(chosen);
    routes.set(edge.id, {
      ...planned,
      route: {
        ...route,
        labelX: Math.round(chosen.x * 100) / 100,
        labelY: Math.round(chosen.y * 100) / 100,
        labelT: chosenT,
      },
    });
  }

  return { routes, rects, metrics, improvementPasses: passesRun };
}
