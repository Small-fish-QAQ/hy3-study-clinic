import { describe, expect, it } from 'vitest';
import { pointInRect, quadraticPoint, type Rect } from './edgeGeometry';
import {
  OBSTACLE_MARGIN,
  planEdgeLanes,
  planNodeEdgeOrder,
  routeEdge,
  sideSlotFor,
  type EdgeLike,
  type RouteRequest,
} from './edgeRouting';

/** Obstacle-aware routing regressions (defect: chaotic edge rendering). */

const source: Rect = { x: 0, y: 0, width: 160, height: 60 };
const target: Rect = { x: 600, y: 0, width: 160, height: 60 };

function baseRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { source, target, obstacles: [], lane: 0, mode: 'network', ...overrides };
}

/** Sample a routed path (straight or quadratic) at N interior points. */
function samplePath(routed: ReturnType<typeof routeEdge>, samples = 32) {
  const points = [];
  const match = routed.path.match(/-?[\d.]+/g)!.map(Number);
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    if (routed.kind === 'quadratic') {
      const [sx, sy, cx, cy, tx, ty] = match;
      points.push(quadraticPoint({ x: sx!, y: sy! }, { x: cx!, y: cy! }, { x: tx!, y: ty! }, t));
    } else if (routed.kind === 'straight') {
      const [sx, sy, tx, ty] = match;
      points.push({ x: sx! + (tx! - sx!) * t, y: sy! + (ty! - sy!) * t });
    }
  }
  return points;
}

describe('routeEdge — direct routes', () => {
  it('unobstructed, unlaned edges are straight boundary-to-boundary lines', () => {
    const routed = routeEdge(baseRequest());
    expect(routed.kind).toBe('straight');
    expect(routed.sourceSide).toBe('right');
    expect(routed.targetSide).toBe('left');
    expect(routed.sourcePoint).toEqual({ x: 160, y: 30 });
    expect(routed.targetPoint).toEqual({ x: 600, y: 30 });
  });

  it('the arrow-side path end terminates exactly at the target boundary', () => {
    const routed = routeEdge(baseRequest());
    const numbers = routed.path.match(/-?[\d.]+/g)!.map(Number);
    expect(numbers[numbers.length - 2]).toBe(600);
    expect(numbers[numbers.length - 1]).toBe(30);
  });

  it('never emits NaN in the SVG path', () => {
    const degenerate = routeEdge(baseRequest({ target: { x: 0, y: 0, width: 160, height: 60 } }));
    expect(degenerate.path).not.toMatch(/NaN|Infinity/);
  });
});

describe('routeEdge — obstacle avoidance', () => {
  const blocker: Rect = { x: 330, y: 0, width: 120, height: 60 };

  it('a blocking node forces a curved detour', () => {
    const routed = routeEdge(baseRequest({ obstacles: [blocker] }));
    expect(routed.kind).toBe('quadratic');
  });

  it('the chosen route does not pass through the blocking node', () => {
    const routed = routeEdge(baseRequest({ obstacles: [blocker] }));
    for (const point of samplePath(routed)) {
      expect(pointInRect(point, blocker, OBSTACLE_MARGIN / 2)).toBe(false);
    }
  });

  it('a laned edge escalates its bow to clear an obstacle on the base lane', () => {
    // Blocker sits above the direct line, exactly where lane +0.5 would bow.
    const laneBlocker: Rect = { x: 330, y: 40, width: 120, height: 60 };
    const routed = routeEdge(baseRequest({ obstacles: [laneBlocker], lane: 0.5 }));
    expect(routed.kind).toBe('quadratic');
    for (const point of samplePath(routed)) {
      expect(pointInRect(point, laneBlocker, 2)).toBe(false);
    }
  });

  it('labels never sit on endpoint-card positions', () => {
    for (const obstacles of [[], [blocker]]) {
      const routed = routeEdge(baseRequest({ obstacles }));
      expect(pointInRect({ x: routed.labelX, y: routed.labelY }, source)).toBe(false);
      expect(pointInRect({ x: routed.labelX, y: routed.labelY }, target)).toBe(false);
    }
  });

  it('is deterministic: identical input yields identical paths', () => {
    const a = routeEdge(baseRequest({ obstacles: [blocker] }));
    const b = routeEdge(baseRequest({ obstacles: [blocker] }));
    expect(a.path).toBe(b.path);
    expect(a.labelX).toBe(b.labelX);
  });
});

describe('routeEdge — dependency mode', () => {
  it('vertical flows get restrained vertical-tangent cubics with dynamic sides', () => {
    const below: Rect = { x: 40, y: 300, width: 160, height: 60 };
    const routed = routeEdge(baseRequest({ target: below, mode: 'dependency' }));
    expect(routed.kind).toBe('cubic');
    expect(routed.sourceSide).toBe('bottom');
    expect(routed.targetSide).toBe('top');
  });

  it('upward dependencies leave from the top and enter from the bottom', () => {
    const above: Rect = { x: 40, y: -300, width: 160, height: 60 };
    const routed = routeEdge(baseRequest({ target: above, mode: 'dependency' }));
    expect(routed.kind).toBe('cubic');
    expect(routed.sourceSide).toBe('top');
    expect(routed.targetSide).toBe('bottom');
  });
});

describe('lanes for parallel and reciprocal edges', () => {
  const reciprocal: EdgeLike[] = [
    { id: 'ge_b', sourceConceptId: 'con_1', targetConceptId: 'con_2', relation: 'prerequisite' },
    { id: 'ge_a', sourceConceptId: 'con_2', targetConceptId: 'con_1', relation: 'contrasts_with' },
  ];

  it('assigns symmetric lanes around zero to a concept pair', () => {
    const lanes = planEdgeLanes(reciprocal);
    const values = [...lanes.values()].map((l) => l.lane).sort((a, b) => a - b);
    expect(values).toEqual([-0.5, 0.5]);
    expect([...lanes.values()].every((l) => l.laneCount === 2)).toBe(true);
  });

  it('reciprocal edges bow to opposite geometric sides', () => {
    const lanes = planEdgeLanes(reciprocal);
    const forward = routeEdge(baseRequest({ lane: lanes.get('ge_b')!.lane }));
    const backward = routeEdge(
      baseRequest({ source: target, target: source, lane: lanes.get('ge_a')!.lane }),
    );
    // With the canonical perpendicular, opposite lanes end up on opposite
    // sides of the direct line (labels above vs below y=30).
    const forwardAbove = forward.labelY < 30;
    const backwardAbove = backward.labelY < 30;
    expect(forwardAbove).not.toBe(backwardAbove);
    expect(forward.labelY).not.toBeCloseTo(backward.labelY, 0);
  });

  it('lane order is stable regardless of input edge order', () => {
    const shuffled = [...reciprocal].reverse();
    const a = planEdgeLanes(reciprocal);
    const b = planEdgeLanes(shuffled);
    expect(a.get('ge_a')!.lane).toBe(b.get('ge_a')!.lane);
    expect(a.get('ge_b')!.lane).toBe(b.get('ge_b')!.lane);
  });

  it('three parallel edges stay mutually separated', () => {
    const triple: EdgeLike[] = [
      { id: 'e1', sourceConceptId: 'a', targetConceptId: 'b', relation: 'prerequisite' },
      { id: 'e2', sourceConceptId: 'a', targetConceptId: 'b', relation: 'causes' },
      { id: 'e3', sourceConceptId: 'b', targetConceptId: 'a', relation: 'contrasts_with' },
    ];
    const lanes = planEdgeLanes(triple);
    const values = [...lanes.values()].map((l) => l.lane);
    expect(new Set(values).size).toBe(3);
    const labels = triple.map((e) =>
      Math.round(routeEdge(baseRequest({ lane: lanes.get(e.id)!.lane })).labelY),
    );
    expect(new Set(labels).size).toBe(3);
  });
});

describe('high-degree side slots', () => {
  const star: EdgeLike[] = ['n1', 'n2', 'n3', 'n4'].map((other, i) => ({
    id: `e${i}`,
    sourceConceptId: 'hub',
    targetConceptId: other,
    relation: 'prerequisite',
  }));

  it('incident order is deterministic and rank lookup is stable', () => {
    const orderA = planNodeEdgeOrder(star);
    const orderB = planNodeEdgeOrder([...star].reverse());
    expect(orderA.get('hub')!.map((e) => e.edgeId)).toEqual(
      orderB.get('hub')!.map((e) => e.edgeId),
    );
  });

  it('edges sharing a side receive distinct stable ranks', () => {
    const incident = planNodeEdgeOrder(star).get('hub')!;
    const sides = new Map([
      ['e0', 'right' as const],
      ['e1', 'right' as const],
      ['e2', 'left' as const],
      ['e3', 'right' as const],
    ]);
    const slots = ['e0', 'e1', 'e3'].map((id) => sideSlotFor(incident, sides, id));
    expect(slots.map((s) => s.count)).toEqual([3, 3, 3]);
    expect(new Set(slots.map((s) => s.rank)).size).toBe(3);
    expect(sideSlotFor(incident, sides, 'e2')).toEqual({ rank: 0, count: 1 });
    // Same inputs → same slots (no jitter between renders).
    expect(sideSlotFor(incident, sides, 'e1')).toEqual(sideSlotFor(incident, sides, 'e1'));
  });

  it('slotted anchors land on distinct boundary points', () => {
    const incident = planNodeEdgeOrder(star).get('hub')!;
    const sides = new Map(star.map((e) => [e.id, 'right' as const]));
    const anchors = star.map((e) => {
      const slot = sideSlotFor(incident, sides, e.id);
      return routeEdge(baseRequest({ sourceSlot: slot })).sourcePoint.y;
    });
    expect(new Set(anchors).size).toBe(star.length);
  });
});
