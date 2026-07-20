/**
 * Deterministic, bounded edge routing for the learning graph.
 *
 * Scope: graphs with dozens of nodes. Every route is chosen from a small
 * candidate set (direct line, gentle clockwise/counter-clockwise quadratic
 * offsets, vertical-tangent cubics in dependency mode) scored against
 * non-endpoint node rectangles and — when a route context is provided —
 * against the already-planned routes of other edges. There is no unbounded
 * solver and no randomness: identical input always yields identical paths.
 *
 * Cost model, in strict priority order (each tier dominates realistic sums
 * of the tiers below it at this graph scale):
 *   1. crossing a non-endpoint card (NODE_HIT_PENALTY) — effectively
 *      forbidden; terminating inside a card cannot happen at all because
 *      endpoints are boundary anchors clamped outside rounded corners by
 *      construction (see edgeGeometry.boundaryPoint / shiftAlongSide);
 *   2. a proper edge-edge crossing (CROSSING_PENALTY) — very high, but a
 *      dozen crossings still cost less than one card intersection;
 *   3. long near-parallel congestion (OVERLAP_PENALTY_PER_PX beyond a free
 *      run) — high for long shared corridors;
 *   4. a relation label landing on a card (LABEL_PENALTY) — high;
 *   5. excessive bend (|offset| × BEND_PENALTY_PER_PX) — moderate;
 *   6. path length (direct distance) — low;
 *   7. a 0.01 side bias — deterministic candidate order on exact ties.
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
import { comparePathPair, polylineIntersectsRect, routedPolyline, CLARITY_SAMPLES } from './graphClarity.js';

export type RouteMode = 'network' | 'dependency';

/** Already-planned sibling routes a candidate is scored against. */
export interface RouteContextEdge {
  polyline: readonly Point[];
  /** Rects of endpoint nodes shared with the edge being routed (fan region). */
  sharedRects: readonly Rect[];
}

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
  /**
   * Other edges' current routes (same-pair lanes excluded by the caller).
   * Absent during drag: the fast per-edge path skips crossing penalties.
   */
  context?: readonly RouteContextEdge[];
}

export interface RoutedEdge {
  /** SVG path from the source boundary to the target boundary. */
  path: string;
  sourcePoint: Point;
  targetPoint: Point;
  /** [] → straight, [c] → quadratic, [c1, c2] → cubic. */
  controlPoints: Point[];
  sourceSide: Side;
  targetSide: Side;
  /** Anchor for the relation label, on the actual routed path. */
  labelX: number;
  labelY: number;
  /** Path fraction the label sits at (parallel edges use distinct fractions). */
  labelT: number;
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
/**
 * Escalating detour bows. The far offsets exist for corridor cases — a
 * single-column dependency layout, or a diagonal whose both gentle-bow
 * corridors are walled off by measured cards — where only a wide swing
 * clears every card; the bend penalty keeps them a last resort.
 */
const DETOUR_OFFSETS = [44, -44, 84, -84, 132, -132, 200, -200, 280, -280, 380, -380];

const NODE_HIT_PENALTY = 10000;
const CROSSING_PENALTY = 700;
const OVERLAP_PENALTY_PER_PX = 2.2;
const OVERLAP_FREE_RUN = 24;
const LABEL_PENALTY = 300;
const BEND_PENALTY_PER_PX = 0.8;
/** Falling back to the geometric off-side of a lane pair costs this much. */
const LANE_FLIP_PENALTY = 140;

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

/**
 * Card-hit count for a quadratic candidate. The curve is reduced to a
 * bounded polyline and tested SEGMENT-wise against each rect: point
 * sampling alone lets a shallow corner graze slip between samples of a long
 * curve, while the chord-vs-curve error at this curvature is far below a
 * pixel — so segment testing is effectively exact.
 */
function curveHits(
  p0: Point,
  control: Point,
  p1: Point,
  obstacles: Rect[],
  margin: number,
): number {
  const points: Point[] = [p0];
  for (let i = 1; i < SAMPLES; i++) points.push(quadraticPoint(p0, control, p1, i / SAMPLES));
  points.push(p1);
  let hits = 0;
  for (const rect of obstacles) {
    if (polylineIntersectsRect(points, rect, margin)) hits += 1;
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
    if (pointInRect(labelPoint, rect, 4)) return LABEL_PENALTY;
  }
  return 0;
}

/**
 * Crossing/congestion cost of a candidate polyline against the routes that
 * are already planned. Same sampling as the clarity evaluator so improvement
 * passes and metrics can never disagree about a crossing.
 */
function contextPenalty(
  polyline: readonly Point[],
  context: readonly RouteContextEdge[] | undefined,
): number {
  if (!context || context.length === 0) return 0;
  let penalty = 0;
  for (const other of context) {
    const report = comparePathPair(polyline, other.polyline, {
      sharedNodeRects: other.sharedRects,
    });
    penalty += report.crossings.length * CROSSING_PENALTY;
    const excess = report.overlapLength - OVERLAP_FREE_RUN;
    if (excess > 0) penalty += excess * OVERLAP_PENALTY_PER_PX;
  }
  return penalty;
}

/** Parallel edges place labels at distinct path fractions (lane-spread). */
function labelFraction(lane: number): number {
  return clamp(0.5 + lane * 0.14, 0.3, 0.7);
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
 * vertical-tangent cubic). Bounded work: O(candidates × (obstacles × samples
 * + context edges × samples²)).
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
  const labelT = labelFraction(lane);
  interface AimedCandidate extends Candidate {
    aimed: ReturnType<typeof anchorsFor> | null;
  }
  const candidates: AimedCandidate[] = [];
  const direct = straightHits(fromPoint, toPoint, obstacles, OBSTACLE_MARGIN);
  const directLength = distance(fromPoint, toPoint);
  if (laneOffset === 0) {
    candidates.push({
      control: null,
      aimed: null,
      score:
        direct * NODE_HIT_PENALTY +
        directLength +
        contextPenalty([fromPoint, toPoint], request.context),
    });
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
          { offset: -laneOffset * 1.4, penalty: LANE_FLIP_PENALTY },
          { offset: -laneOffset * 2.2, penalty: LANE_FLIP_PENALTY },
        ]
      : DETOUR_OFFSETS.map((offset) => ({ offset, penalty: 0 }));
  // Each curved candidate is scored on its FINAL geometry: the endpoints are
  // re-aimed at the candidate's own control point first, so the curve that
  // is hit-tested and crossing-scored is exactly the curve that would be
  // rendered (a center-aimed approximation can clear a card corner that the
  // re-aimed final curve clips).
  for (const { offset, penalty } of laneCandidates) {
    const control = { x: mid.x + perp.x * offset, y: mid.y + perp.y * offset };
    const aimed = anchorsFor(source, target, control, control, request);
    const hits = curveHits(aimed.fromPoint, control, aimed.toPoint, obstacles, OBSTACLE_MARGIN);
    const labelPoint = quadraticPoint(aimed.fromPoint, control, aimed.toPoint, labelT);
    const polyline = request.context
      ? routedPolyline(
          { sourcePoint: aimed.fromPoint, targetPoint: aimed.toPoint, controlPoints: [control] },
          CLARITY_SAMPLES,
        )
      : [];
    candidates.push({
      control,
      aimed,
      score:
        hits * NODE_HIT_PENALTY +
        distance(aimed.fromPoint, aimed.toPoint) +
        Math.abs(offset) * BEND_PENALTY_PER_PX +
        penalty +
        labelPenalty(labelPoint, obstacles) +
        contextPenalty(polyline, request.context) +
        // Deterministic tiny bias keeps candidate order stable on ties.
        (offset < 0 ? 0.01 : 0),
    });
  }

  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.score < best.score) best = candidate;
  }

  if (best.control === null) {
    const label = {
      x: fromPoint.x + (toPoint.x - fromPoint.x) * labelT,
      y: fromPoint.y + (toPoint.y - fromPoint.y) * labelT,
    };
    return {
      path: `M ${round(fromPoint.x)},${round(fromPoint.y)} L ${round(toPoint.x)},${round(toPoint.y)}`,
      sourcePoint: fromPoint,
      targetPoint: toPoint,
      controlPoints: [],
      sourceSide: from.side,
      targetSide: to.side,
      labelX: round(label.x),
      labelY: round(label.y),
      labelT,
      kind: 'straight',
    };
  }

  const aimed = best.aimed!;
  const label = quadraticPoint(aimed.fromPoint, best.control, aimed.toPoint, labelT);
  return {
    path:
      `M ${round(aimed.fromPoint.x)},${round(aimed.fromPoint.y)} ` +
      `Q ${round(best.control.x)},${round(best.control.y)} ` +
      `${round(aimed.toPoint.x)},${round(aimed.toPoint.y)}`,
    sourcePoint: aimed.fromPoint,
    targetPoint: aimed.toPoint,
    controlPoints: [best.control],
    sourceSide: aimed.from.side,
    targetSide: aimed.to.side,
    labelX: round(label.x),
    labelY: round(label.y),
    labelT,
    kind: 'quadratic',
  };
}

/**
 * Restrained vertical-tangent cubic for the layered dependency view, with
 * escalating sideways bows so long spanning edges swing around card columns
 * instead of threading through them. Returns null (network-router fallback)
 * only when every bounded cubic candidate still hits a card.
 */
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
  // Same-side escalations first; opposite-side shifts pay the flip penalty.
  const shiftCandidates: Array<{ shift: number; penalty: number }> =
    laneShift !== 0
      ? [
          { shift: laneShift, penalty: 0 },
          { shift: laneShift * 1.8, penalty: 0 },
          { shift: laneShift * 2.6, penalty: 0 },
          { shift: laneShift * 3.6, penalty: 0 },
          { shift: -laneShift * 1.4, penalty: LANE_FLIP_PENALTY },
          { shift: -laneShift * 2.2, penalty: LANE_FLIP_PENALTY },
        ]
      : [0, 70, -70, 130, -130, 190, -190, 250, -250].map((shift) => ({ shift, penalty: 0 }));

  const labelT = labelFraction(lane);
  let best: { c1: Point; c2: Point; score: number; hits: number } | null = null;
  for (const { shift, penalty } of shiftCandidates) {
    const c1 = { x: fromPoint.x + shift, y: fromPoint.y + (goingDown ? stem : -stem) };
    const c2 = { x: toPoint.x + shift, y: toPoint.y + (goingDown ? -stem : stem) };
    // Segment-wise card testing, same rationale as curveHits.
    const samplePoints: Point[] = [fromPoint];
    for (let i = 1; i < SAMPLES; i++) {
      samplePoints.push(cubicPoint(fromPoint, c1, c2, toPoint, i / SAMPLES));
    }
    samplePoints.push(toPoint);
    let hits = 0;
    for (const rect of obstacles) {
      if (polylineIntersectsRect(samplePoints, rect, OBSTACLE_MARGIN)) hits += 1;
    }
    const polyline = request.context
      ? routedPolyline(
          { sourcePoint: fromPoint, targetPoint: toPoint, controlPoints: [c1, c2] },
          CLARITY_SAMPLES,
        )
      : [];
    const labelPoint = cubicPoint(fromPoint, c1, c2, toPoint, labelT);
    const score =
      hits * NODE_HIT_PENALTY +
      Math.abs(shift) * BEND_PENALTY_PER_PX +
      penalty +
      labelPenalty(labelPoint, obstacles) +
      contextPenalty(polyline, request.context) +
      (shift < 0 ? 0.01 : 0);
    if (best === null || score < best.score) best = { c1, c2, score, hits };
  }

  // Every bounded cubic still crosses a card → let the network router try
  // its quadratic detours instead of threading a column.
  if (best === null || best.hits > 0) return null;

  const label = cubicPoint(fromPoint, best.c1, best.c2, toPoint, labelT);
  return {
    path:
      `M ${round(fromPoint.x)},${round(fromPoint.y)} ` +
      `C ${round(best.c1.x)},${round(best.c1.y)} ${round(best.c2.x)},${round(best.c2.y)} ` +
      `${round(toPoint.x)},${round(toPoint.y)}`,
    sourcePoint: fromPoint,
    targetPoint: toPoint,
    controlPoints: [best.c1, best.c2],
    sourceSide: fromRaw.side,
    targetSide: toRaw.side,
    labelX: round(label.x),
    labelY: round(label.y),
    labelT,
    kind: 'cubic',
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Lane + port planning
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
    const key = `${a} ${b}`;
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
  relation: string;
}

/**
 * Incident edges per concept in a deterministic base order. Which edges
 * touch a node is static; their per-side order is geometric and computed by
 * assignSidePorts from current node positions.
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
        relation: e.relation,
      })),
    );
  }
  return order;
}

export interface PortAssignment {
  side: Side;
  rank: number;
  count: number;
}

/**
 * Geometry-aware port ordering for one node (crossing-free last mile).
 *
 * Every incident edge is grouped by the side its opposite endpoint currently
 * faces, then ordered within the side by the ANGULAR order of that opposite
 * endpoint — left→right on top/bottom sides, top→bottom on left/right sides.
 * The angular key (tangent from the side's normal) matches the raw
 * boundary-anchor order exactly, so slot shifts can never invert the
 * approach order of neighboring edges: two incoming edges keep their
 * geometric left/right order into the final segment.
 *
 * Deterministic tie-breaking: angular key → opposite concept ID → relation →
 * edge ID. The assignment is a pure function of current geometry: ranks only
 * change when two opposite endpoints actually swap angular order (at which
 * moment their slots are adjacent), so small pointer movement cannot make an
 * edge oscillate between slots.
 */
export function assignSidePorts(
  nodeRect: Rect,
  siblings: readonly IncidentEdge[],
  rectFor: (conceptId: string) => Rect,
): Map<string, PortAssignment> {
  const center = rectCenter(nodeRect);
  interface Entry extends IncidentEdge {
    side: Side;
    key: number;
  }
  const entries: Entry[] = siblings.map((sibling) => {
    const other = rectCenter(rectFor(sibling.otherId));
    const bp = boundaryPoint(nodeRect, other);
    const dx = Number.isFinite(other.x) ? other.x - center.x : 0;
    const dy = Number.isFinite(other.y) ? other.y - center.y : 0;
    const key =
      bp.side === 'top' || bp.side === 'bottom'
        ? dx / Math.max(Math.abs(dy), 1e-6)
        : dy / Math.max(Math.abs(dx), 1e-6);
    return { ...sibling, side: bp.side, key };
  });
  const bySide = new Map<Side, Entry[]>();
  for (const entry of entries) {
    const list = bySide.get(entry.side) ?? [];
    list.push(entry);
    bySide.set(entry.side, list);
  }
  const result = new Map<string, PortAssignment>();
  for (const [side, list] of bySide) {
    list.sort(
      (a, b) =>
        a.key - b.key ||
        a.otherId.localeCompare(b.otherId) ||
        a.relation.localeCompare(b.relation) ||
        a.edgeId.localeCompare(b.edgeId),
    );
    list.forEach((entry, rank) => {
      result.set(entry.edgeId, { side, rank, count: list.length });
    });
  }
  return result;
}
