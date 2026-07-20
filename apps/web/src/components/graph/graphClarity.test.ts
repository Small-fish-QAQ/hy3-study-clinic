import { describe, expect, it } from 'vitest';
import type { Point, Rect } from './edgeGeometry';
import {
  comparePathPair,
  evaluateRoutedGraph,
  polylineIntersectsRect,
  routedPolyline,
  type RoutedGraphEdge,
} from './graphClarity';

/** Edge-edge crossing detection and clarity metrics (crossing-minimization task). */

const line = (from: Point, to: Point): Point[] =>
  routedPolyline({ sourcePoint: from, targetPoint: to, controlPoints: [] }, 8);

describe('comparePathPair — proper crossings', () => {
  it('detects a straight/straight transversal crossing once', () => {
    const a = line({ x: 0, y: 0 }, { x: 100, y: 100 });
    const b = line({ x: 0, y: 100 }, { x: 100, y: 0 });
    const report = comparePathPair(a, b);
    expect(report.crossings).toHaveLength(1);
    expect(report.crossings[0]!.x).toBeCloseTo(50, 0);
    expect(report.crossings[0]!.y).toBeCloseTo(50, 0);
  });

  it('reports nothing for clearly separated segments', () => {
    const a = line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const b = line({ x: 0, y: 40 }, { x: 100, y: 40 });
    expect(comparePathPair(a, b).crossings).toHaveLength(0);
  });

  it('excludes contact inside the permitted shared-node fan region', () => {
    const sharedNode: Rect = { x: 40, y: 40, width: 40, height: 20 };
    // Both paths converge on the shared node and cross right next to it.
    const a = line({ x: 0, y: 0 }, { x: 60, y: 50 });
    const b = line({ x: 0, y: 90 }, { x: 55, y: 45 });
    const excluded = comparePathPair(a, b, { sharedNodeRects: [sharedNode] });
    const counted = comparePathPair(a, b);
    expect(counted.crossings.length).toBeGreaterThan(0);
    expect(excluded.crossings).toHaveLength(0);
  });

  it('detects quadratic/straight crossings', () => {
    const curve = routedPolyline({
      sourcePoint: { x: 0, y: 50 },
      targetPoint: { x: 200, y: 50 },
      controlPoints: [{ x: 100, y: -60 }],
    });
    const straight = line({ x: 100, y: -100 }, { x: 100, y: 200 });
    expect(comparePathPair(curve, straight).crossings).toHaveLength(1);
  });

  it('detects quadratic/quadratic crossings', () => {
    const up = routedPolyline({
      sourcePoint: { x: 0, y: 0 },
      targetPoint: { x: 200, y: 0 },
      controlPoints: [{ x: 100, y: 80 }],
    });
    const down = routedPolyline({
      sourcePoint: { x: 0, y: 60 },
      targetPoint: { x: 200, y: 60 },
      controlPoints: [{ x: 100, y: -80 }],
    });
    expect(comparePathPair(up, down).crossings).toHaveLength(2);
  });

  it('measures near-parallel close runs as overlap, not crossings', () => {
    const a = line({ x: 0, y: 0 }, { x: 200, y: 0 });
    const b = line({ x: 0, y: 3 }, { x: 200, y: 3 });
    const report = comparePathPair(a, b);
    expect(report.crossings).toHaveLength(0);
    expect(report.overlapLength).toBeGreaterThan(100);
  });

  it('never produces NaN or unstable results', () => {
    const degenerate = line({ x: 10, y: 10 }, { x: 10, y: 10 });
    const normal = line({ x: 0, y: 0 }, { x: 20, y: 20 });
    const report = comparePathPair(degenerate, normal);
    expect(Number.isFinite(report.overlapLength)).toBe(true);
    for (const point of report.crossings) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    const repeat = comparePathPair(degenerate, normal);
    expect(repeat).toEqual(report);
  });
});

describe('polylineIntersectsRect', () => {
  it('detects a path passing through an inflated rect', () => {
    const path = line({ x: 0, y: 50 }, { x: 200, y: 50 });
    expect(polylineIntersectsRect(path, { x: 80, y: 30, width: 40, height: 40 })).toBe(true);
    expect(polylineIntersectsRect(path, { x: 80, y: 100, width: 40, height: 40 })).toBe(false);
    expect(polylineIntersectsRect(path, { x: 80, y: 56, width: 40, height: 40 }, 8)).toBe(true);
  });
});

describe('evaluateRoutedGraph', () => {
  const nodeRects = new Map<string, Rect>([
    ['a', { x: 0, y: 0, width: 40, height: 20 }],
    ['b', { x: 200, y: 0, width: 40, height: 20 }],
    ['c', { x: 0, y: 200, width: 40, height: 20 }],
    ['d', { x: 200, y: 200, width: 40, height: 20 }],
  ]);

  it('counts proper crossings and per-edge maxima', () => {
    const edges: RoutedGraphEdge[] = [
      {
        id: 'e1',
        sourceId: 'a',
        targetId: 'd',
        polyline: line({ x: 40, y: 20 }, { x: 200, y: 200 }),
      },
      {
        id: 'e2',
        sourceId: 'c',
        targetId: 'b',
        polyline: line({ x: 40, y: 200 }, { x: 200, y: 20 }),
      },
    ];
    const metrics = evaluateRoutedGraph(edges, nodeRects);
    expect(metrics.properCrossings).toBe(1);
    expect(metrics.maxCrossingsOneEdge).toBe(1);
    expect(metrics.totalLength).toBeGreaterThan(0);
  });

  it('excludes deliberate parallel-lane pairs over the same concept pair', () => {
    const edges: RoutedGraphEdge[] = [
      {
        id: 'lane1',
        sourceId: 'a',
        targetId: 'b',
        polyline: routedPolyline({
          sourcePoint: { x: 40, y: 10 },
          targetPoint: { x: 200, y: 10 },
          controlPoints: [{ x: 120, y: 60 }],
        }),
      },
      {
        id: 'lane2',
        sourceId: 'b',
        targetId: 'a',
        polyline: routedPolyline({
          sourcePoint: { x: 200, y: 10 },
          targetPoint: { x: 40, y: 10 },
          controlPoints: [{ x: 120, y: -60 }],
        }),
      },
    ];
    const metrics = evaluateRoutedGraph(edges, nodeRects);
    expect(metrics.properCrossings).toBe(0);
    expect(metrics.nearOverlapPairs).toBe(0);
  });

  it('classifies shared-endpoint crossings outside the fan region as last-mile', () => {
    // Both edges declare node b as their target; their approach paths cross
    // at (100, 100) — well outside b's permitted fan region (rect + 12px)
    // but inside the last-mile radius around b.
    const edges: RoutedGraphEdge[] = [
      {
        id: 'in1',
        sourceId: 'a',
        targetId: 'b',
        polyline: line({ x: 40, y: 60 }, { x: 160, y: 140 }),
      },
      {
        id: 'in2',
        sourceId: 'c',
        targetId: 'b',
        polyline: line({ x: 40, y: 140 }, { x: 160, y: 60 }),
      },
    ];
    const metrics = evaluateRoutedGraph(edges, nodeRects);
    expect(metrics.properCrossings).toBe(1);
    expect(metrics.lastMileSharedNodeCrossings).toBe(1);
  });

  it('counts node-edge intersections for non-endpoint cards only', () => {
    const edges: RoutedGraphEdge[] = [
      // Passes straight through node b's row.
      {
        id: 'through',
        sourceId: 'a',
        targetId: 'd',
        polyline: line({ x: 20, y: 10 }, { x: 240, y: 10 }),
      },
    ];
    const withHit = evaluateRoutedGraph(edges, nodeRects);
    expect(withHit.nodeEdgeIntersections).toBe(1);
    const cleared = evaluateRoutedGraph(
      [
        {
          id: 'clear',
          sourceId: 'a',
          targetId: 'd',
          polyline: line({ x: 20, y: 60 }, { x: 240, y: 180 }),
        },
      ],
      nodeRects,
    );
    expect(cleared.nodeEdgeIntersections).toBe(0);
  });
});
