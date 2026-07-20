import { describe, expect, it } from 'vitest';
import { pointInRect, quadraticPoint, type Rect } from './edgeGeometry';
import {
  OBSTACLE_MARGIN,
  assignSidePorts,
  planEdgeLanes,
  planNodeEdgeOrder,
  routeEdge,
  type EdgeLike,
  type IncidentEdge,
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

/**
 * Geometry-aware port ordering. Deliberate behavior change from the earlier
 * static (relation, id) slot order: ranks along one node side now follow the
 * angular order of the opposite endpoints, which removes last-mile
 * crossings between edges sharing a node (see the crossing-minimization
 * task); determinism and stability guarantees are preserved.
 */
describe('geometry-aware side ports (assignSidePorts)', () => {
  const node: Rect = { x: 0, y: 0, width: 160, height: 60 };
  const size = { width: 120, height: 50 };
  const rectAt = (x: number, y: number): Rect => ({ x, y, ...size });
  const incidentFor = (entries: Array<[string, string]>): IncidentEdge[] =>
    entries.map(([edgeId, otherId]) => ({ edgeId, otherId, relation: 'prerequisite' }));

  it('bottom-side edges rank left-to-right by the opposite endpoint', () => {
    const rects = new Map<string, Rect>([
      ['right', rectAt(360, 320)],
      ['left', rectAt(-340, 320)],
      ['mid', rectAt(20, 320)],
    ]);
    const ports = assignSidePorts(
      node,
      incidentFor([
        ['e_right', 'right'],
        ['e_left', 'left'],
        ['e_mid', 'mid'],
      ]),
      (id) => rects.get(id)!,
    );
    expect(ports.get('e_left')).toMatchObject({ side: 'bottom', rank: 0, count: 3 });
    expect(ports.get('e_mid')).toMatchObject({ side: 'bottom', rank: 1, count: 3 });
    expect(ports.get('e_right')).toMatchObject({ side: 'bottom', rank: 2, count: 3 });
  });

  it('top-side edges rank left-to-right by the opposite endpoint', () => {
    const rects = new Map<string, Rect>([
      ['a', rectAt(300, -340)],
      ['b', rectAt(-260, -340)],
    ]);
    const ports = assignSidePorts(
      node,
      incidentFor([
        ['e_a', 'a'],
        ['e_b', 'b'],
      ]),
      (id) => rects.get(id)!,
    );
    expect(ports.get('e_b')).toMatchObject({ side: 'top', rank: 0, count: 2 });
    expect(ports.get('e_a')).toMatchObject({ side: 'top', rank: 1, count: 2 });
  });

  it('right-side edges rank top-to-bottom by the opposite endpoint', () => {
    const rects = new Map<string, Rect>([
      ['low', rectAt(420, 110)],
      ['high', rectAt(420, -120)],
      ['level', rectAt(420, 10)],
    ]);
    const ports = assignSidePorts(
      node,
      incidentFor([
        ['e_low', 'low'],
        ['e_high', 'high'],
        ['e_level', 'level'],
      ]),
      (id) => rects.get(id)!,
    );
    expect(ports.get('e_high')).toMatchObject({ side: 'right', rank: 0, count: 3 });
    expect(ports.get('e_level')).toMatchObject({ side: 'right', rank: 1, count: 3 });
    expect(ports.get('e_low')).toMatchObject({ side: 'right', rank: 2, count: 3 });
  });

  it('breaks exact ties deterministically by otherId, relation, then edge id', () => {
    const shared = rectAt(40, 320);
    const rects = new Map<string, Rect>([
      ['x', shared],
      ['y', shared],
    ]);
    const siblings: IncidentEdge[] = [
      { edgeId: 'e_2', otherId: 'y', relation: 'prerequisite' },
      { edgeId: 'e_1', otherId: 'x', relation: 'part_of' },
      { edgeId: 'e_0', otherId: 'x', relation: 'part_of' },
    ];
    const ports = assignSidePorts(node, siblings, (id) => rects.get(id)!);
    // Same angular key for all three → otherId 'x' before 'y'; within 'x',
    // relation equal → edge id order.
    expect(ports.get('e_0')!.rank).toBe(0);
    expect(ports.get('e_1')!.rank).toBe(1);
    expect(ports.get('e_2')!.rank).toBe(2);
    const again = assignSidePorts(node, siblings, (id) => rects.get(id)!);
    expect([...again.entries()]).toEqual([...ports.entries()]);
  });

  it('small opposite-endpoint movement never flips ranks (no slot jitter)', () => {
    const base = new Map<string, Rect>([
      ['a', rectAt(-200, 320)],
      ['b', rectAt(120, 320)],
    ]);
    const incident = incidentFor([
      ['e_a', 'a'],
      ['e_b', 'b'],
    ]);
    const before = assignSidePorts(node, incident, (id) => base.get(id)!);
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ] as const) {
      const jittered = new Map<string, Rect>([
        ['a', rectAt(-200 + dx, 320 + dy)],
        ['b', rectAt(120, 320)],
      ]);
      const after = assignSidePorts(node, incident, (id) => jittered.get(id)!);
      expect(after.get('e_a')).toEqual(before.get('e_a'));
      expect(after.get('e_b')).toEqual(before.get('e_b'));
    }
  });

  it('reassigns ranks after a large geometry change (endpoints swap order)', () => {
    const incident = incidentFor([
      ['e_a', 'a'],
      ['e_b', 'b'],
    ]);
    const before = assignSidePorts(node, incident, (id) =>
      new Map([
        ['a', rectAt(-200, 320)],
        ['b', rectAt(120, 320)],
      ]).get(id)!,
    );
    expect(before.get('e_a')!.rank).toBe(0);
    expect(before.get('e_b')!.rank).toBe(1);
    // `a` dragged far to the right of `b` → ranks must swap.
    const after = assignSidePorts(node, incident, (id) =>
      new Map([
        ['a', rectAt(400, 320)],
        ['b', rectAt(120, 320)],
      ]).get(id)!,
    );
    expect(after.get('e_a')!.rank).toBe(1);
    expect(after.get('e_b')!.rank).toBe(0);
  });

  it('incident order from planNodeEdgeOrder stays deterministic', () => {
    const star: EdgeLike[] = ['n1', 'n2', 'n3', 'n4'].map((other, i) => ({
      id: `e${i}`,
      sourceConceptId: 'hub',
      targetConceptId: other,
      relation: 'prerequisite',
    }));
    const orderA = planNodeEdgeOrder(star);
    const orderB = planNodeEdgeOrder([...star].reverse());
    expect(orderA.get('hub')!.map((e) => e.edgeId)).toEqual(
      orderB.get('hub')!.map((e) => e.edgeId),
    );
    expect(orderA.get('hub')![0]).toMatchObject({ relation: 'prerequisite' });
  });

  it('slotted anchors land on distinct boundary points in rank order', () => {
    const rects = new Map<string, Rect>([
      ['hub', { x: 600, y: 0, width: 160, height: 60 }],
      ['s0', rectAt(0, -260)],
      ['s1', rectAt(0, -60)],
      ['s2', rectAt(0, 160)],
    ]);
    const incident = incidentFor([
      ['e0', 's0'],
      ['e1', 's1'],
      ['e2', 's2'],
    ]);
    const ports = assignSidePorts(rects.get('hub')!, incident, (id) => rects.get(id)!);
    const anchors = ['e0', 'e1', 'e2'].map((edgeId, i) => {
      const routed = routeEdge(
        baseRequest({
          source: rects.get(`s${i}`)!,
          target: rects.get('hub')!,
          targetSlot: ports.get(edgeId),
        }),
      );
      return routed.targetPoint.y;
    });
    expect(new Set(anchors).size).toBe(3);
    // Sources stacked top→bottom must attach top→bottom (monotone order).
    expect(anchors[0]!).toBeLessThan(anchors[1]!);
    expect(anchors[1]!).toBeLessThan(anchors[2]!);
  });
});
