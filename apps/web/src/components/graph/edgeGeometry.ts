/**
 * Pure geometry for floating learning-graph edges.
 *
 * Every helper is deterministic, allocation-light, and NaN-safe: edges read
 * measured node rectangles from React Flow state and turn them into
 * boundary-accurate endpoints. Nothing in this file touches the DOM.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface BoundaryPoint {
  point: Point;
  side: Side;
}

/** Corner radius of `.concept-node` cards; boundary points avoid the arcs. */
export const NODE_CORNER_RADIUS = 12;

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Defensive copy that can never contain NaN/Infinity or negative sizes. */
export function sanitizeRect(rect: Rect, fallback: Rect): Rect {
  return {
    x: finiteOr(rect.x, fallback.x),
    y: finiteOr(rect.y, fallback.y),
    width: Math.max(1, finiteOr(rect.width, fallback.width)),
    height: Math.max(1, finiteOr(rect.height, fallback.height)),
  };
}

/**
 * Where the ray from the rect center toward `toward` exits the rectangle.
 *
 * The returned point always lies on the boundary; when the exact
 * intersection would land on a rounded corner it is clamped onto the
 * nearest straight section of that side. Degenerate input (toward at the
 * center, or non-finite) deterministically exits to the right.
 */
export function boundaryPoint(
  rect: Rect,
  toward: Point,
  cornerRadius: number = NODE_CORNER_RADIUS,
): BoundaryPoint {
  const center = rectCenter(rect);
  let dx = finiteOr(toward.x, center.x) - center.x;
  let dy = finiteOr(toward.y, center.y) - center.y;
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  // Ties (exact corner hits) resolve to the horizontal side for stability.
  const side: Side = scaleX <= scaleY ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  let x = center.x + dx * scale;
  let y = center.y + dy * scale;

  const radius = Math.min(cornerRadius, halfW, halfH);
  if (side === 'left' || side === 'right') {
    x = side === 'left' ? rect.x : rect.x + rect.width;
    y = clamp(y, rect.y + radius, rect.y + rect.height - radius);
  } else {
    y = side === 'top' ? rect.y : rect.y + rect.height;
    x = clamp(x, rect.x + radius, rect.x + rect.width - radius);
  }
  return { point: { x, y }, side };
}

/**
 * Shift a boundary point along its side (used by the side-slot system for
 * high-degree nodes) while keeping it on the straight section.
 */
export function shiftAlongSide(
  boundary: BoundaryPoint,
  offset: number,
  rect: Rect,
  cornerRadius: number = NODE_CORNER_RADIUS,
): Point {
  const radius = Math.min(cornerRadius, rect.width / 2, rect.height / 2);
  if (boundary.side === 'left' || boundary.side === 'right') {
    return {
      x: boundary.point.x,
      y: clamp(boundary.point.y + offset, rect.y + radius, rect.y + rect.height - radius),
    };
  }
  return {
    x: clamp(boundary.point.x + offset, rect.x + radius, rect.x + rect.width - radius),
    y: boundary.point.y,
  };
}

/**
 * Bounded slot offset for the `rank`-th of `count` edges sharing one node
 * side: symmetric around the raw intersection, spacing capped so slots stay
 * inside the straight section of realistic node sizes.
 */
export function slotOffset(rank: number, count: number, sideLength: number): number {
  if (count <= 1) return 0;
  const spacing = clamp(sideLength / (count + 1), 8, 16);
  return (rank - (count - 1) / 2) * spacing;
}

export function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && onSegment(b1, b2, a1)) ||
    (d2 === 0 && onSegment(b1, b2, a2)) ||
    (d3 === 0 && onSegment(a1, a2, b1)) ||
    (d4 === 0 && onSegment(a1, a2, b2))
  );
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

export function pointInRect(point: Point, rect: Rect, margin = 0): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  );
}

/** Does the segment p1→p2 pass through `rect` inflated by `margin`? */
export function segmentIntersectsRect(p1: Point, p2: Point, rect: Rect, margin = 0): boolean {
  const x1 = rect.x - margin;
  const y1 = rect.y - margin;
  const x2 = rect.x + rect.width + margin;
  const y2 = rect.y + rect.height + margin;
  if (pointInRect(p1, rect, margin) || pointInRect(p2, rect, margin)) return true;
  const tl = { x: x1, y: y1 };
  const tr = { x: x2, y: y1 };
  const br = { x: x2, y: y2 };
  const bl = { x: x1, y: y2 };
  return (
    segmentsIntersect(p1, p2, tl, tr) ||
    segmentsIntersect(p1, p2, tr, br) ||
    segmentsIntersect(p1, p2, br, bl) ||
    segmentsIntersect(p1, p2, bl, tl)
  );
}

/** Point on the quadratic Bézier (p0, c, p1) at parameter t. */
export function quadraticPoint(p0: Point, control: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y,
  };
}

/** Point on the cubic Bézier (p0, c1, c2, p1) at parameter t. */
export function cubicPoint(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * p1.x,
    y: mt ** 3 * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * p1.y,
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
