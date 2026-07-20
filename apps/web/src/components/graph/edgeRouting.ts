/**
 * Deterministic, bounded edge routing for the learning graph.
 *
 * Scope: graphs with dozens of nodes. Every route is chosen from a small
 * candidate set (direct line, gentle clockwise/counter-clockwise quadratic
 * offsets) scored against non-endpoint node rectangles. There is no global
 * solver and no randomness — identical input always yields identical paths.
 */
import {
  boundaryPoint,
  clamp,
  cubicPoint,
  distance,
  pointInRect,
  quadraticPoint,
  rectCenter,
  segmentIntersectsRect,
  shiftAlongSide,
  slotOffset,
  type BoundaryPoint,
  type Point,
  type Rect,
  type Side,
} from './edgeGeometry.js';

export type RouteMode = 'network' | 'dependency';

export interface RouteRequest {
  source: Rect;
  target: Rect;
  /** Non-endpoint node rects the path should avoid. */
  obstacles: Rect[];
  /**
   * Lane for parallel/reciprocal edges over the same concept pair, centered
   * on 0 (e.g. one edge → [0], two edges → [-0.5, +0.5]).
   */
  lane: number;
  /** Slot offsets along the chosen sides for high-degree endpoints. */
  sourceSlot?: { rank: number; count: number };
  targetSlot?: { rank: number; count: number };
  mode: RouteMode;
}

export interface RoutedEdge {
  /** SVG path from the source boundary to the target boundary. */
  path: string;
  sourcePoint: Point;
  targetPoint: Point;
  sourceSide: Side;
  targetSide: Side;
  /** Anchor for the relation label, on the actual routed path. */
  labelX: number;
  labelY: number;
  kind: 'straight' | 'quadratic' | 'cubic';
}

/** Safety margin (px) kept between a routed path and non-endpoint cards. */
export const OBSTACLE_MARGIN = 10;
/**
 * Curve hit-testing samples. Dense enough that a card corner cannot slip
 * between consecutive samples of a long cross-graph curve, still bounded:
 * candidates × obstacles × samples stays in the low thousands per edge.
 */
const SAMPLES = 28;
const LANE_SPACING = 46;
const DETOUR_OFFSETS = [44, -44, 84, -84, 132, -132];

interface Candidate {
  control: Point | null;
  score: number;
}

function perpendicular(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function curveHits(
  p0: Point,
  control: Point,
  p1: Point,
  obstacles: Rect[],
  margin: number,
): number {
  let hits = 0;
  for (const rect of obstacles) {
    for (let i = 1; i < SAMPLES; i++) {
      if (pointInRect(quadraticPoint(p0, control, p1, i / SAMPLES), rect, margin)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

function straightHits(p0: Point, p1: Point, obstacles: Rect[], margin: number): number {
  let hits = 0;
  for (const rect of obstacles) {
    if (segmentIntersectsRect(p0, p1, rect, margin)) hits += 1;
  }
  return hits;
}

function labelPenalty(labelPoint: Point, obstacles: Rect[]): number {
  for (const rect of obstacles) {
    if (pointInRect(labelPoint, rect, 4)) return 300;
  }
  return 0;
}

function anchorsFor(
  source: Rect,
  target: Rect,
  towardSource: Point,
  towardTarget: Point,
  request: RouteRequest,
): { from: BoundaryPoint; to: BoundaryPoint; fromPoint: Point; toPoint: Point } {
  const from = boundaryPoint(source, towardTarget);
  const to = boundaryPoint(target, towardSource);
  const sideLength = (side: Side, rect: Rect) =>
    side === 'left' || side === 'right' ? rect.height : rect.width;
  const fromPoint = request.sourceSlot
    ? shiftAlongSide(
        from,
        slotOffset(
          request.sourceSlot.rank,
          request.sourceSlot.count,
          sideLength(from.side, source),
        ),
        source,
      )
    : from.point;
  const toPoint = request.targetSlot
    ? shiftAlongSide(
        to,
        slotOffset(request.targetSlot.rank, request.targetSlot.count, sideLength(to.side, target)),
        target,
      )
    : to.point;
  return { from, to, fromPoint, toPoint };
}

/**
 * Route one edge. Straight when unobstructed and unlaned; otherwise the
 * least-disruptive gentle quadratic (or, in dependency mode, a restrained
 * vertical-tangent cubic). Bounded work: O(candidates × obstacles × samples).
 */
export function routeEdge(request: RouteRequest): RoutedEdge {
  const { source, target, obstacles, lane, mode } = request;
  const sourceCenter = rectCenter(source);
  const targetCenter = rectCenter(target);

  // Dependency mode: layered top-to-bottom flow gets vertical-tangent
  // cubics whenever the target sits clearly below/above the source.
  if (mode === 'dependency' && Math.abs(targetCenter.y - sourceCenter.y) > 40) {
    const routed = routeDependency(request, sourceCenter, targetCenter);
    if (routed) return routed;
  }

  const { from, to, fromPoint, toPoint } = anchorsFor(
    source,
    target,
    sourceCenter,
    targetCenter,
    request,
  );

  const laneOffset = lane * LANE_SPACING;
  const candidates: Candidate[] = [];
  const direct = straightHits(fromPoint, toPoint, obstacles, OBSTACLE_MARGIN);
  const directLength = distance(fromPoint, toPoint);
  if (laneOffset === 0) {
    candidates.push({ control: null, score: direct * 1000 + directLength });
  }

  // Canonical perpendicular (sorted by position, not edge direction) keeps
  // reciprocal edges of one pair on opposite geometric sides.
  const canonicalFirst =
    sourceCenter.x < targetCenter.x ||
    (sourceCenter.x === targetCenter.x && sourceCenter.y <= targetCenter.y);
  const perp = canonicalFirst
    ? perpendicular(sourceCenter, targetCenter)
    : perpendicular(targetCenter, sourceCenter);
  const mid = { x: (fromPoint.x + toPoint.x) / 2, y: (fromPoint.y + toPoint.y) / 2 };

  // Laned (parallel/reciprocal) edges keep their side of the pair when they
  // can: same-sign escalations come first, and opposite-side fallbacks pay a
  // deterministic penalty so a lane only flips when its whole side is
  // blocked by a card (crossing a card would be worse than sharing a side).
  const laneCandidates: Array<{ offset: number; penalty: number }> =
    laneOffset !== 0
      ? [
          { offset: laneOffset, penalty: 0 },
          { offset: laneOffset * 1.8, penalty: 0 },
          { offset: laneOffset * 2.6, penalty: 0 },
          { offset: -laneOffset * 1.4, penalty: 140 },
          { offset: -laneOffset * 2.2, penalty: 140 },
        ]
      : DETOUR_OFFSETS.map((offset) => ({ offset, penalty: 0 }));
  for (const { offset, penalty } of laneCandidates) {
    const control = { x: mid.x + perp.x * offset, y: mid.y + perp.y * offset };
    const hits = curveHits(fromPoint, control, toPoint, obstacles, OBSTACLE_MARGIN);
    const labelPoint = quadraticPoint(fromPoint, control, toPoint, 0.5);
    candidates.push({
      control,
      score:
        hits * 1000 +
        directLength +
        Math.abs(offset) * 0.8 +
        penalty +
        labelPenalty(labelPoint, obstacles) +
        // Deterministic tiny bias keeps candidate order stable on ties.
        (offset < 0 ? 0.01 : 0),
    });
  }

  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.score < best.score) best = candidate;
  }

  if (best.control === null) {
    return {
      path: `M ${round(fromPoint.x)},${round(fromPoint.y)} L ${round(toPoint.x)},${round(toPoint.y)}`,
      sourcePoint: fromPoint,
      targetPoint: toPoint,
      sourceSide: from.side,
      targetSide: to.side,
      labelX: round(mid.x),
      labelY: round(mid.y),
      kind: 'straight',
    };
  }

  // Re-aim the endpoints at the control point so the curve enters the
  // boundary along its own tangent instead of the center-to-center line.
  const aimed = anchorsFor(source, target, best.control, best.control, request);
  const label = quadraticPoint(aimed.fromPoint, best.control, aimed.toPoint, 0.5);
  return {
    path:
      `M ${round(aimed.fromPoint.x)},${round(aimed.fromPoint.y)} ` +
      `Q ${round(best.control.x)},${round(best.control.y)} ` +
      `${round(aimed.toPoint.x)},${round(aimed.toPoint.y)}`,
    sourcePoint: aimed.fromPoint,
    targetPoint: aimed.toPoint,
    sourceSide: aimed.from.side,
    targetSide: aimed.to.side,
    labelX: round(label.x),
    labelY: round(label.y),
    kind: 'quadratic',
  };
}

/** Restrained vertical-tangent cubic for the layered dependency view. */
function routeDependency(
  request: RouteRequest,
  sourceCenter: Point,
  targetCenter: Point,
): RoutedEdge | null {
  const { source, target, obstacles, lane } = request;
  const goingDown = targetCenter.y > sourceCenter.y;
  // Leave from the facing horizontal edge, enter the facing horizontal edge.
  const fromRaw: BoundaryPoint = {
    point: {
      x: clamp(sourceCenter.x, source.x + 12, source.x + source.width - 12),
      y: goingDown ? source.y + source.height : source.y,
    },
    side: goingDown ? 'bottom' : 'top',
  };
  const toRaw: BoundaryPoint = {
    point: {
      x: clamp(targetCenter.x, target.x + 12, target.x + target.width - 12),
      y: goingDown ? target.y : target.y + target.height,
    },
    side: goingDown ? 'top' : 'bottom',
  };
  const sideLength = (rect: Rect) => rect.width;
  const fromPoint = request.sourceSlot
    ? shiftAlongSide(
        fromRaw,
        slotOffset(request.sourceSlot.rank, request.sourceSlot.count, sideLength(source)),
        source,
      )
    : fromRaw.point;
  const toPoint = request.targetSlot
    ? shiftAlongSide(
        toRaw,
        slotOffset(request.targetSlot.rank, request.targetSlot.count, sideLength(target)),
        target,
      )
    : toRaw.point;

  const stem = clamp(Math.abs(toPoint.y - fromPoint.y) / 2, 24, 90);
  const laneShift = lane * LANE_SPACING;
  const c1 = { x: fromPoint.x + laneShift, y: fromPoint.y + (goingDown ? stem : -stem) };
  const c2 = { x: toPoint.x + laneShift, y: toPoint.y + (goingDown ? -stem : stem) };

  let hits = 0;
  for (const rect of obstacles) {
    for (let i = 1; i < SAMPLES; i++) {
      if (pointInRect(cubicPoint(fromPoint, c1, c2, toPoint, i / SAMPLES), rect, OBSTACLE_MARGIN)) {
        hits += 1;
        break;
      }
    }
  }
  // A blocked layered path falls back to the network router's detours.
  if (hits > 0 && lane === 0) return null;

  const label = cubicPoint(fromPoint, c1, c2, toPoint, 0.5);
  return {
    path:
      `M ${round(fromPoint.x)},${round(fromPoint.y)} ` +
      `C ${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ` +
      `${round(toPoint.x)},${round(toPoint.y)}`,
    sourcePoint: fromPoint,
    targetPoint: toPoint,
    sourceSide: fromRaw.side,
    targetSide: toRaw.side,
    labelX: round(label.x),
    labelY: round(label.y),
    kind: 'cubic',
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Lane + slot planning (static, from the semantic edge list)
// ---------------------------------------------------------------------------

export interface EdgeLike {
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
  relation: string;
}

export interface LanePlan {
  lane: number;
  laneCount: number;
}

/**
 * Assign deterministic lanes to parallel and reciprocal edges of the same
 * concept pair. Edges are ordered by (relation, id); lanes are symmetric
 * around zero so a single edge stays straight and reciprocal pairs bow to
 * opposite sides.
 */
export function planEdgeLanes(edges: readonly EdgeLike[]): Map<string, LanePlan> {
  const byPair = new Map<string, EdgeLike[]>();
  for (const edge of edges) {
    const [a, b] = [edge.sourceConceptId, edge.targetConceptId].sort();
    const key = `${a} ${b}`;
    const list = byPair.get(key) ?? [];
    list.push(edge);
    byPair.set(key, list);
  }
  const plan = new Map<string, LanePlan>();
  for (const list of byPair.values()) {
    list.sort((x, y) => x.relation.localeCompare(y.relation) || x.id.localeCompare(y.id));
    list.forEach((edge, index) => {
      plan.set(edge.id, { lane: index - (list.length - 1) / 2, laneCount: list.length });
    });
  }
  return plan;
}

export interface IncidentEdge {
  edgeId: string;
  /** The concept at the other end of this incident edge. */
  otherId: string;
}

/**
 * Static per-node incident-edge order: for every concept, its edges sorted
 * by (relation, id). Slot ranks derived from this order never change while
 * the semantic edge set is stable, so attachment points cannot jitter
 * between renders. The live side grouping (which of these edges currently
 * share one node side) is a pure function of node geometry on top of this
 * fixed order.
 */
export function planNodeEdgeOrder(edges: readonly EdgeLike[]): Map<string, IncidentEdge[]> {
  const byNode = new Map<string, EdgeLike[]>();
  for (const edge of edges) {
    for (const nodeId of [edge.sourceConceptId, edge.targetConceptId]) {
      const list = byNode.get(nodeId) ?? [];
      list.push(edge);
      byNode.set(nodeId, list);
    }
  }
  const order = new Map<string, IncidentEdge[]>();
  for (const [nodeId, list] of byNode) {
    list.sort((x, y) => x.relation.localeCompare(y.relation) || x.id.localeCompare(y.id));
    order.set(
      nodeId,
      list.map((e) => ({
        edgeId: e.id,
        otherId: e.sourceConceptId === nodeId ? e.targetConceptId : e.sourceConceptId,
      })),
    );
  }
  return order;
}

/**
 * Rank of `edgeId` among the incident edges of one node that currently
 * attach to the same side, given each sibling's current side. Order comes
 * from the static incident list, so ranks are deterministic and stable.
 */
export function sideSlotFor(
  incident: readonly IncidentEdge[],
  sideByEdgeId: ReadonlyMap<string, Side>,
  edgeId: string,
): { rank: number; count: number } {
  const mySide = sideByEdgeId.get(edgeId);
  if (mySide === undefined) return { rank: 0, count: 1 };
  let rank = 0;
  let count = 0;
  for (const entry of incident) {
    if (sideByEdgeId.get(entry.edgeId) !== mySide) continue;
    if (entry.edgeId === edgeId) rank = count;
    count += 1;
  }
  return { rank, count: Math.max(count, 1) };
}
