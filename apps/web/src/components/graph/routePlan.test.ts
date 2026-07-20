import { describe, expect, it } from 'vitest';
import type { Concept, GraphEdge } from '@hy3-clinic/shared';
import type { Rect } from './edgeGeometry';
import { comparePathPair, routedPolyline } from './graphClarity';
import { planEdgeLanes, routeEdge, type EdgeLike, type RouteContextEdge } from './edgeRouting';
import { planGraphRoutes, type GraphRouteInput } from './routePlan';
import { computeForceLayout, degreeByConcept, estimateNodeSize } from './layout';
import { smokeGraphConcepts, smokeGraphEdges } from '../../test/smokeGraphFixture';

/** Crossing-aware global route planning (crossing-minimization task). */

const nodeRect = (x: number, y: number, width = 120, height = 50): Rect => ({
  x,
  y,
  width,
  height,
});

describe('routeEdge with a route context', () => {
  const source = nodeRect(0, 0);
  const target = nodeRect(600, 0);
  const crossingContext = (): RouteContextEdge[] => [
    {
      polyline: routedPolyline({
        sourcePoint: { x: 350, y: 10 },
        targetPoint: { x: 350, y: 40 },
        controlPoints: [],
      }),
      sharedRects: [],
    },
  ];

  it('a candidate with fewer edge crossings wins over the direct route', () => {
    const withoutContext = routeEdge({ source, target, obstacles: [], lane: 0, mode: 'network' });
    expect(withoutContext.kind).toBe('straight');

    const routed = routeEdge({
      source,
      target,
      obstacles: [],
      lane: 0,
      mode: 'network',
      context: crossingContext(),
    });
    expect(routed.kind).toBe('quadratic');
    const polyline = routedPolyline(routed);
    expect(comparePathPair(polyline, crossingContext()[0]!.polyline).crossings).toHaveLength(0);
  });

  it('crossing another node stays more costly than crossing an edge', () => {
    // Cards blanket both bow corridors; the only card-free route is the
    // direct line, which crosses the context edge. The router must accept
    // the edge crossing rather than enter a card.
    const obstacles = [nodeRect(240, -210, 240, 220), nodeRect(240, 40, 240, 220)];
    const routed = routeEdge({
      source,
      target,
      obstacles,
      lane: 0,
      mode: 'network',
      context: crossingContext(),
    });
    expect(routed.kind).toBe('straight');
  });
});

/**
 * Order-dependence scenario: greedy routing (stable id order) routes e_a
 * first as a straight line; e_b then has no card-free alternative and must
 * cross it. Only the global improvement pass — revisiting the crossing pair
 * and re-routing e_a against e_b's committed route — removes the crossing.
 */
function orderDependentInput(): GraphRouteInput {
  const rects = new Map<string, Rect>([
    ['s1', nodeRect(0, -100)],
    ['t1', nodeRect(600, -100)],
    ['s2', nodeRect(250, -140)],
    ['t2', nodeRect(250, 60)],
    ['cardL', nodeRect(165, -45, 130, 60)],
    ['cardR', nodeRect(325, -45, 130, 60)],
  ]);
  const edges: EdgeLike[] = [
    { id: 'e_a', sourceConceptId: 's1', targetConceptId: 't1', relation: 'prerequisite' },
    { id: 'e_b', sourceConceptId: 's2', targetConceptId: 't2', relation: 'prerequisite' },
  ];
  return { rects, edges, lanePlans: planEdgeLanes(edges), mode: 'network' };
}

describe('planGraphRoutes — bounded global improvement', () => {
  it('a global second pass removes a crossing that greedy routing keeps', () => {
    const greedyOnly = planGraphRoutes(orderDependentInput(), { maxImprovementPasses: 0 });
    expect(greedyOnly.metrics.properCrossings).toBe(1);
    expect(greedyOnly.improvementPasses).toBe(0);

    const improved = planGraphRoutes(orderDependentInput());
    expect(improved.metrics.properCrossings).toBe(0);
    expect(improved.metrics.nodeEdgeIntersections).toBe(0);
    expect(improved.improvementPasses).toBeGreaterThanOrEqual(1);
  });

  it('stops improving as soon as a pass finds no crossings', () => {
    const rects = new Map<string, Rect>([
      ['a', nodeRect(0, 0)],
      ['b', nodeRect(400, 0)],
      ['c', nodeRect(0, 300)],
      ['d', nodeRect(400, 300)],
    ]);
    const edges: EdgeLike[] = [
      { id: 'e1', sourceConceptId: 'a', targetConceptId: 'b', relation: 'prerequisite' },
      { id: 'e2', sourceConceptId: 'c', targetConceptId: 'd', relation: 'prerequisite' },
    ];
    const plan = planGraphRoutes({
      rects,
      edges,
      lanePlans: planEdgeLanes(edges),
      mode: 'network',
    });
    expect(plan.metrics.properCrossings).toBe(0);
    expect(plan.improvementPasses).toBe(0);
  });

  it('is deterministic and bounded across repeated runs', () => {
    const runs = [planGraphRoutes(orderDependentInput()), planGraphRoutes(orderDependentInput())];
    const paths = runs.map((plan) =>
      [...plan.routes.entries()].map(([id, planned]) => `${id}:${planned.route.path}`).join('|'),
    );
    expect(paths[0]).toBe(paths[1]);
    for (const plan of runs) {
      expect(plan.improvementPasses).toBeLessThanOrEqual(3);
    }
  });
});

function smokeInput(): GraphRouteInput {
  const concepts = smokeGraphConcepts as unknown as Concept[];
  const edges = smokeGraphEdges as unknown as GraphEdge[];
  const degree = degreeByConcept(concepts, edges);
  const sizes = new Map(
    concepts.map((c) => [c.id, estimateNodeSize(c.name, degree.get(c.id) ?? 0)]),
  );
  const positions = computeForceLayout(concepts, edges, sizes);
  const rects = new Map<string, Rect>();
  for (const concept of concepts) {
    const position = positions.get(concept.id)!;
    const size = sizes.get(concept.id)!;
    rects.set(concept.id, {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    });
  }
  return {
    rects,
    edges: smokeGraphEdges as EdgeLike[],
    lanePlans: planEdgeLanes(smokeGraphEdges as EdgeLike[]),
    mode: 'network',
  };
}

describe('planGraphRoutes on the persisted smoke graph (7 concepts, 11 edges)', () => {
  it('keeps the deterministic pipeline free of structural defects', () => {
    const plan = planGraphRoutes(smokeInput());
    // The pre-optimization browser measurement of this workspace showed 12
    // proper crossings including 1 last-mile shared-node crossing; the
    // refined layout + geometry-aware ports + crossing-aware routing keep
    // the deterministic fixture pipeline at ≤6 with no structural defects.
    expect(plan.metrics.nodeEdgeIntersections).toBe(0);
    expect(plan.metrics.lastMileSharedNodeCrossings).toBe(0);
    expect(plan.metrics.properCrossings).toBeLessThanOrEqual(6);
    expect(plan.metrics.nearOverlapPairs).toBe(0);
    expect(plan.improvementPasses).toBeLessThanOrEqual(3);
  });

  it('crossing-aware planning never does worse than the naive baseline', () => {
    const aware = planGraphRoutes(smokeInput());
    const naive = planGraphRoutes(smokeInput(), { crossingAware: false });
    expect(aware.metrics.properCrossings).toBeLessThanOrEqual(naive.metrics.properCrossings);
    expect(aware.metrics.nodeEdgeIntersections).toBeLessThanOrEqual(
      naive.metrics.nodeEdgeIntersections,
    );
  });

  it('is deterministic: identical input produces identical routes and labels', () => {
    const a = planGraphRoutes(smokeInput());
    const b = planGraphRoutes(smokeInput());
    for (const [id, planned] of a.routes) {
      expect(b.routes.get(id)!.route.path).toBe(planned.route.path);
      expect(b.routes.get(id)!.route.labelX).toBe(planned.route.labelX);
      expect(b.routes.get(id)!.route.labelY).toBe(planned.route.labelY);
    }
    expect(b.metrics).toEqual(a.metrics);
  });

  it('spreads parallel-pair labels along distinct path fractions', () => {
    const plan = planGraphRoutes(smokeInput());
    // 工作记忆 ↔ 检索练习 carries a prerequisite + contrasts_with lane pair.
    const pair = smokeGraphEdges.filter((edge) => {
      const key = [edge.sourceConceptId, edge.targetConceptId].sort().join(' ');
      return (
        smokeGraphEdges.filter(
          (other) => [other.sourceConceptId, other.targetConceptId].sort().join(' ') === key,
        ).length > 1
      );
    });
    expect(pair.length).toBeGreaterThanOrEqual(2);
    const fractions = pair.map((edge) => plan.routes.get(edge.id)!.route.labelT);
    expect(new Set(fractions).size).toBe(pair.length);
  });
});
