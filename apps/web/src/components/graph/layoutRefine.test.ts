import { describe, expect, it } from 'vitest';
import type { Concept, GraphEdge } from '@hy3-clinic/shared';
import { segmentsIntersect } from './edgeGeometry';
import {
  computeDependencyLayout,
  countLayeredCrossings,
  estimateNodeSize,
  orderLayersByBarycenter,
  refineNetworkLayout,
  type NodeSize,
} from './layout';

/** Crossing-aware layout refinement + layered ordering (crossing-minimization task). */

const SIZE: NodeSize = { width: 120, height: 50 };

function xLayout(): {
  centers: Map<string, { x: number; y: number }>;
  sizes: Map<string, NodeSize>;
  edges: Array<{ sourceConceptId: string; targetConceptId: string }>;
} {
  // a→d and c→b cross in an X; swapping b and d untangles it.
  return {
    centers: new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 400, y: 0 }],
      ['c', { x: 0, y: 300 }],
      ['d', { x: 400, y: 300 }],
    ]),
    sizes: new Map([
      ['a', SIZE],
      ['b', SIZE],
      ['c', SIZE],
      ['d', SIZE],
    ]),
    edges: [
      { sourceConceptId: 'a', targetConceptId: 'd' },
      { sourceConceptId: 'c', targetConceptId: 'b' },
    ],
  };
}

function countStraightCrossings(
  centers: ReadonlyMap<string, { x: number; y: number }>,
  edges: Array<{ sourceConceptId: string; targetConceptId: string }>,
): number {
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      const ids = new Set([
        a.sourceConceptId,
        a.targetConceptId,
        b.sourceConceptId,
        b.targetConceptId,
      ]);
      if (ids.size < 4) continue;
      if (
        segmentsIntersect(
          centers.get(a.sourceConceptId)!,
          centers.get(a.targetConceptId)!,
          centers.get(b.sourceConceptId)!,
          centers.get(b.targetConceptId)!,
        )
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

describe('refineNetworkLayout', () => {
  it('improves a crossing-heavy synthetic layout', () => {
    const { centers, sizes, edges } = xLayout();
    expect(countStraightCrossings(centers, edges)).toBe(1);
    const refined = refineNetworkLayout(centers, sizes, edges);
    expect(countStraightCrossings(refined, edges)).toBe(0);
  });

  it('never introduces node overlap and never mutates its input', () => {
    const { centers, sizes, edges } = xLayout();
    const snapshot = JSON.stringify([...centers]);
    const refined = refineNetworkLayout(centers, sizes, edges);
    expect(JSON.stringify([...centers])).toBe(snapshot);
    const ids = [...refined.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = refined.get(ids[i]!)!;
        const b = refined.get(ids[j]!)!;
        const minGap = Math.hypot(SIZE.width / 2, SIZE.height / 2) * 2; // both circumradii
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(minGap);
      }
    }
  });

  it('is deterministic and stays compact', () => {
    const { centers, sizes, edges } = xLayout();
    const first = refineNetworkLayout(centers, sizes, edges);
    const second = refineNetworkLayout(centers, sizes, edges);
    expect([...first.entries()]).toEqual([...second.entries()]);
    const xs = [...first.values()].map((p) => p.x);
    const ys = [...first.values()].map((p) => p.y);
    // Compactness: refinement may not spread the layout beyond the original
    // bounding box plus its bounded slack.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-60);
    expect(Math.max(...xs)).toBeLessThanOrEqual(460);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-60);
    expect(Math.max(...ys)).toBeLessThanOrEqual(360);
  });

  it('leaves layouts without crossing problems untouched', () => {
    const centers = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 400, y: 0 }],
      ['c', { x: 0, y: 300 }],
      ['d', { x: 400, y: 300 }],
    ]);
    const sizes = xLayout().sizes;
    const edges = [
      { sourceConceptId: 'a', targetConceptId: 'b' },
      { sourceConceptId: 'c', targetConceptId: 'd' },
    ];
    const refined = refineNetworkLayout(centers, sizes, edges);
    expect([...refined.entries()]).toEqual([...centers.entries()]);
  });
});

const T0 = '2026-01-01T00:00:00.000Z';

function concept(id: string, name = id): Concept {
  return {
    id,
    materialId: 'mat_1',
    name,
    summary: '',
    importance: 'medium',
    grounding: {
      blockId: 'blk_0',
      quote: 'q',
      startOffset: 0,
      endOffset: 1,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: T0,
  } as Concept;
}

function prereq(id: string, source: string, target: string): GraphEdge {
  return {
    id,
    workspaceId: 'ws_1',
    graphVersionId: 'gv_1',
    sourceConceptId: source,
    targetConceptId: target,
    relation: 'prerequisite',
    explanation: '',
    evidence: [],
    createdAt: T0,
  } as unknown as GraphEdge;
}

describe('dependency-view layered ordering', () => {
  it('barycenter sweeps reduce a layered crossing', () => {
    const byLayer = new Map<number, string[]>([
      [0, ['a', 'b']],
      [1, ['c', 'd']],
    ]);
    const layerOf = new Map([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', 1],
    ]);
    const edges = [
      { sourceConceptId: 'a', targetConceptId: 'd' },
      { sourceConceptId: 'b', targetConceptId: 'c' },
    ];
    expect(countLayeredCrossings(byLayer, edges, layerOf)).toBe(1);
    const ordered = orderLayersByBarycenter(byLayer, edges, layerOf);
    expect(countLayeredCrossings(ordered, edges, layerOf)).toBe(0);
    expect(ordered.get(1)).toEqual(['d', 'c']);
    // Input arrays are untouched.
    expect(byLayer.get(1)).toEqual(['c', 'd']);
  });

  it('keeps prerequisite direction intact in the computed layout', () => {
    const concepts = ['a', 'b', 'c', 'd'].map((id) => concept(id));
    const edges = [prereq('e1', 'a', 'd'), prereq('e2', 'b', 'c')];
    const layout = computeDependencyLayout(concepts, edges);
    // Sources stay strictly above their prerequisite targets.
    expect(layout.get('a')!.y).toBeLessThan(layout.get('d')!.y);
    expect(layout.get('b')!.y).toBeLessThan(layout.get('c')!.y);
    // The crossing is resolved by within-layer reordering: a→d and b→c no
    // longer intersect as straight segments.
    expect(
      segmentsIntersect(layout.get('a')!, layout.get('d')!, layout.get('b')!, layout.get('c')!),
    ).toBe(false);
  });

  it('ties break deterministically and keep stable order', () => {
    const byLayer = new Map<number, string[]>([
      [0, ['a']],
      [1, ['c', 'd']],
    ]);
    const layerOf = new Map([
      ['a', 0],
      ['c', 1],
      ['d', 1],
    ]);
    // Both children hang off the same parent: equal barycenters, order kept.
    const edges = [
      { sourceConceptId: 'a', targetConceptId: 'c' },
      { sourceConceptId: 'a', targetConceptId: 'd' },
    ];
    const first = orderLayersByBarycenter(byLayer, edges, layerOf);
    const second = orderLayersByBarycenter(byLayer, edges, layerOf);
    expect(first.get(1)).toEqual(['c', 'd']);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('keeps the estimateNodeSize contract used by the layout pipeline', () => {
    const small = estimateNodeSize('短', 0);
    const large = estimateNodeSize('一个非常非常长的概念名称示例', 6);
    expect(small.width).toBeLessThan(large.width);
    expect(small.height).toBeLessThanOrEqual(large.height);
  });
});
