import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Concept, ConceptLearnerState, GraphEdge } from '@hy3-clinic/shared';
import { segmentIntersectsRect, segmentsIntersect, type Point } from './edgeGeometry.js';

/**
 * Deterministic graph layouts for the personal learning graph.
 *
 * 网络视图 uses d3-force integrated with React Flow (per the official React
 * Flow force-layout guidance): the simulation runs a bounded number of
 * synchronous ticks and is then discarded, so it can never consume CPU in
 * the background. Determinism comes from seeding every node's initial
 * position from a hash of its concept ID and from d3-force's own
 * deterministic LCG random source — repeated fake-provider demos produce
 * identical pictures.
 */

export type LayoutMode = 'network' | 'dependency' | 'weak-path';

export interface NodeSize {
  width: number;
  height: number;
}

/** Stable 32-bit FNV-1a hash of a concept ID. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Estimated rendered size of a concept node. React Flow measures real DOM
 * sizes later, but the simulation needs sizes up front; the estimate matches
 * the CSS (two-line clamp, bounded width) closely enough for collision.
 */
export function estimateNodeSize(name: string, degree: number): NodeSize {
  const scale = degreeScale(degree);
  // ~13px per CJK glyph at 0.85rem plus padding, clamped to the CSS bounds.
  const width = Math.min(210, Math.max(132, 46 + name.length * 14)) * scale;
  const twoLines = name.length > 9;
  const height = (twoLines ? 74 : 56) * scale;
  return { width, height };
}

/** Bounded, subtle emphasis for well-connected nodes (never huge). */
export function degreeScale(degree: number): number {
  return 1 + Math.min(degree, 6) * 0.04;
}

export function degreeByConcept(concepts: Concept[], edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>(concepts.map((c) => [c.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.sourceConceptId)) {
      degree.set(edge.sourceConceptId, (degree.get(edge.sourceConceptId) ?? 0) + 1);
    }
    if (degree.has(edge.targetConceptId)) {
      degree.set(edge.targetConceptId, (degree.get(edge.targetConceptId) ?? 0) + 1);
    }
  }
  return degree;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  size: NodeSize;
}

/**
 * Force-directed network layout. Runs synchronously with a bounded tick
 * budget; positions are node centers converted to React Flow's top-left
 * origin before returning.
 */
export function computeForceLayout(
  concepts: Concept[],
  edges: GraphEdge[],
  sizes: Map<string, NodeSize>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (concepts.length === 0) return positions;

  const idSet = new Set(concepts.map((c) => c.id));
  const nodes: SimNode[] = concepts.map((concept) => {
    const hash = hashId(concept.id);
    const angle = (hash % 3600) * (Math.PI / 1800);
    const radius = 120 + (Math.floor(hash / 3600) % 240);
    return {
      id: concept.id,
      size: sizes.get(concept.id) ?? { width: 160, height: 56 },
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => idSet.has(e.sourceConceptId) && idSet.has(e.targetConceptId))
    .map((e) => ({ source: e.sourceConceptId, target: e.targetConceptId }));

  const simulation = forceSimulation<SimNode>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((n) => n.id)
        // Longer links + stronger repulsion than the defaults give edge
        // routing room to work with: readable paths, fewer node-on-edge
        // collisions, still compact enough for one fitView.
        .distance(215)
        .strength(0.5),
    )
    .force('charge', forceManyBody<SimNode>().strength(-560))
    .force(
      // Rectangular nodes: collide on the circumscribed circle so two
      // rectangles can never overlap, plus breathing room for labels and
      // likely edge corridors.
      'collide',
      forceCollide<SimNode>()
        .radius((n) => Math.hypot(n.size.width / 2, n.size.height / 2) + 24)
        .iterations(2),
    )
    .force('x', forceX<SimNode>(0).strength(0.055))
    .force('y', forceY<SimNode>(0).strength(0.07))
    .stop();

  // Bounded synchronous convergence — never a background timer.
  const ticks = Math.min(300, 120 + concepts.length * 4);
  for (let i = 0; i < ticks; i++) simulation.tick();

  // Crossing-aware local refinement of the settled force layout (bounded,
  // deterministic). Runs only here — i.e. only for freshly generated
  // automatic network positions; saved manual positions are layered on top
  // of (and are never fed into) this function.
  const centers = new Map<string, Point>(
    nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
  );
  const refined = refineNetworkLayout(
    centers,
    new Map(nodes.map((node) => [node.id, node.size])),
    edges.filter((e) => idSet.has(e.sourceConceptId) && idSet.has(e.targetConceptId)),
  );

  for (const node of nodes) {
    const center = refined.get(node.id) ?? { x: node.x ?? 0, y: node.y ?? 0 };
    positions.set(node.id, {
      x: center.x - node.size.width / 2,
      y: center.y - node.size.height / 2,
    });
  }
  return positions;
}

interface LayoutEdgeLike {
  sourceConceptId: string;
  targetConceptId: string;
}

/** Straight-line layout score used by the local refinement (proxy for the
 * router: node-edge intersections weigh above crossings, both far above
 * length, so refinement removes structural problems without scattering the
 * layout). */
function layoutScore(
  centers: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
  edges: readonly LayoutEdgeLike[],
): number {
  let score = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i]!;
    const a1 = centers.get(a.sourceConceptId)!;
    const a2 = centers.get(a.targetConceptId)!;
    score += Math.hypot(a2.x - a1.x, a2.y - a1.y) * 0.35;
    for (const [nodeId, center] of centers) {
      if (nodeId === a.sourceConceptId || nodeId === a.targetConceptId) continue;
      const size = sizes.get(nodeId) ?? { width: 160, height: 56 };
      const rect = {
        x: center.x - size.width / 2,
        y: center.y - size.height / 2,
        width: size.width,
        height: size.height,
      };
      if (segmentIntersectsRect(a1, a2, rect, 6)) score += 1400;
    }
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j]!;
      const shared =
        a.sourceConceptId === b.sourceConceptId ||
        a.sourceConceptId === b.targetConceptId ||
        a.targetConceptId === b.sourceConceptId ||
        a.targetConceptId === b.targetConceptId;
      if (shared) continue;
      const b1 = centers.get(b.sourceConceptId)!;
      const b2 = centers.get(b.targetConceptId)!;
      if (segmentsIntersect(a1, a2, b1, b2)) score += 900;
    }
  }
  return score;
}

/** Circumscribed-circle radius used for the no-overlap constraint. */
function circumRadius(size: NodeSize): number {
  return Math.hypot(size.width / 2, size.height / 2);
}

/**
 * Bounded deterministic crossing-aware refinement of a freshly generated
 * network layout (Part of the ELK/Graphviz-inspired cleanup, without
 * replacing the force layout): nodes involved in straight-line edge
 * crossings or node-edge intersections try a small set of nudges and swaps;
 * a move is accepted only when it strictly reduces the global score AND
 * keeps node separation, per-node displacement, and overall compactness.
 *
 * Input and output are node CENTERS. The input map is never mutated.
 */
export function refineNetworkLayout(
  centers: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
  edges: readonly LayoutEdgeLike[],
): Map<string, Point> {
  const result = new Map<string, Point>();
  for (const [id, point] of centers) result.set(id, { x: point.x, y: point.y });
  const valid = edges.filter(
    (e) => centers.has(e.sourceConceptId) && centers.has(e.targetConceptId),
  );
  if (valid.length < 2 || centers.size < 3) return result;

  const original = new Map<string, Point>(
    [...centers].map(([id, point]) => [id, { x: point.x, y: point.y }]),
  );
  const ids = [...centers.keys()];
  const bounds = {
    minX: Math.min(...ids.map((id) => centers.get(id)!.x)) - 60,
    maxX: Math.max(...ids.map((id) => centers.get(id)!.x)) + 60,
    minY: Math.min(...ids.map((id) => centers.get(id)!.y)) - 60,
    maxY: Math.max(...ids.map((id) => centers.get(id)!.y)) + 60,
  };

  const sizeOf = (id: string): NodeSize => sizes.get(id) ?? { width: 160, height: 56 };
  const placementOk = (movedIds: string[]): boolean => {
    for (const id of movedIds) {
      const point = result.get(id)!;
      if (
        point.x < bounds.minX ||
        point.x > bounds.maxX ||
        point.y < bounds.minY ||
        point.y > bounds.maxY
      ) {
        return false;
      }
      const home = original.get(id)!;
      if (Math.hypot(point.x - home.x, point.y - home.y) > 300) return false;
      const radius = circumRadius(sizeOf(id));
      for (const otherId of ids) {
        if (otherId === id) continue;
        const other = result.get(otherId)!;
        if (
          Math.hypot(point.x - other.x, point.y - other.y) <
          radius + circumRadius(sizeOf(otherId)) + 12
        ) {
          return false;
        }
      }
    }
    return true;
  };

  const NUDGES: Point[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 0.707, y: 0.707 },
    { x: -0.707, y: 0.707 },
    { x: 0.707, y: -0.707 },
    { x: -0.707, y: -0.707 },
  ];
  const RADII = [40, 80];
  const MAX_PASSES = 2;
  const MAX_NODES_PER_PASS = 8;

  let score = layoutScore(result, sizes, valid);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Rank nodes by how many crossing/intersection problems involve them.
    const involvement = new Map<string, number>(ids.map((id) => [id, 0]));
    for (let i = 0; i < valid.length; i++) {
      const a = valid[i]!;
      const a1 = result.get(a.sourceConceptId)!;
      const a2 = result.get(a.targetConceptId)!;
      for (const id of ids) {
        if (id === a.sourceConceptId || id === a.targetConceptId) continue;
        const size = sizeOf(id);
        const rect = {
          x: result.get(id)!.x - size.width / 2,
          y: result.get(id)!.y - size.height / 2,
          width: size.width,
          height: size.height,
        };
        if (segmentIntersectsRect(a1, a2, rect, 6)) {
          involvement.set(id, (involvement.get(id) ?? 0) + 1);
        }
      }
      for (let j = i + 1; j < valid.length; j++) {
        const b = valid[j]!;
        const endpoints = [
          a.sourceConceptId,
          a.targetConceptId,
          b.sourceConceptId,
          b.targetConceptId,
        ];
        if (new Set(endpoints).size < 4) continue;
        const b1 = result.get(b.sourceConceptId)!;
        const b2 = result.get(b.targetConceptId)!;
        if (segmentsIntersect(a1, a2, b1, b2)) {
          for (const id of endpoints) involvement.set(id, (involvement.get(id) ?? 0) + 1);
        }
      }
    }
    const involved = ids
      .filter((id) => (involvement.get(id) ?? 0) > 0)
      .sort((a, b) => (involvement.get(b) ?? 0) - (involvement.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, MAX_NODES_PER_PASS);
    if (involved.length === 0) break;

    let improvedInPass = false;
    for (const id of involved) {
      const before = { ...result.get(id)! };
      let best: { score: number; apply: () => void; revert: () => void } | null = null;

      for (const radius of RADII) {
        for (const direction of NUDGES) {
          const candidate = {
            x: before.x + direction.x * radius,
            y: before.y + direction.y * radius,
          };
          result.set(id, candidate);
          if (placementOk([id])) {
            const candidateScore = layoutScore(result, sizes, valid);
            if (candidateScore < score - 1e-6 && (best === null || candidateScore < best.score)) {
              best = {
                score: candidateScore,
                apply: () => result.set(id, candidate),
                revert: () => result.set(id, before),
              };
            }
          }
          result.set(id, before);
        }
      }
      for (const otherId of involved) {
        if (otherId <= id) continue;
        const otherBefore = { ...result.get(otherId)! };
        result.set(id, otherBefore);
        result.set(otherId, before);
        if (placementOk([id, otherId])) {
          const candidateScore = layoutScore(result, sizes, valid);
          if (candidateScore < score - 1e-6 && (best === null || candidateScore < best.score)) {
            best = {
              score: candidateScore,
              apply: () => {
                result.set(id, otherBefore);
                result.set(otherId, before);
              },
              revert: () => {
                result.set(id, before);
                result.set(otherId, otherBefore);
              },
            };
          }
        }
        result.set(id, before);
        result.set(otherId, otherBefore);
      }

      if (best !== null) {
        best.apply();
        score = best.score;
        improvedInPass = true;
      }
    }
    if (!improvedInPass) break;
  }
  return result;
}

/**
 * 依赖视图: deterministic layered layout — prerequisite edges define layers
 * via longest-path from roots; everything else keeps input order. Stable for
 * disconnected nodes and cycle-safe on any persisted data.
 */
export function computeDependencyLayout(
  concepts: Concept[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const ids = concepts.map((c) => c.id);
  const idSet = new Set(ids);
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'prerequisite') continue;
    if (!idSet.has(edge.sourceConceptId) || !idSet.has(edge.targetConceptId)) continue;
    const list = incoming.get(edge.targetConceptId) ?? [];
    list.push(edge.sourceConceptId);
    incoming.set(edge.targetConceptId, list);
  }

  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (id: string): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(layer)) + 1;
    visiting.delete(id);
    layerOf.set(id, value);
    return value;
  };
  ids.forEach(layer);

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layerOf.get(id) ?? 0;
    const list = byLayer.get(l) ?? [];
    list.push(id);
    byLayer.set(l, list);
  }

  // Layered crossing minimization: bounded barycenter sweeps re-order nodes
  // WITHIN their layer (never across layers, so prerequisite direction is
  // untouched). A final guard keeps the original order if the sweeps did
  // not strictly reduce prerequisite-edge crossings.
  const prereqEdges = edges.filter(
    (e) =>
      e.relation === 'prerequisite' && idSet.has(e.sourceConceptId) && idSet.has(e.targetConceptId),
  );
  const ordered = orderLayersByBarycenter(byLayer, prereqEdges, layerOf);

  const positions = new Map<string, { x: number; y: number }>();
  const COL_WIDTH = 250;
  const ROW_HEIGHT = 170;
  const MAX_PER_ROW = 6;
  for (const [l, members] of [...ordered.entries()].sort((a, b) => a[0] - b[0])) {
    members.forEach((id, i) => {
      const row = Math.floor(i / MAX_PER_ROW);
      const col = i % MAX_PER_ROW;
      const rowCount = Math.min(members.length - row * MAX_PER_ROW, MAX_PER_ROW);
      const xOffset = -((rowCount - 1) * COL_WIDTH) / 2;
      positions.set(id, {
        x: xOffset + col * COL_WIDTH,
        y: l * ROW_HEIGHT + row * (ROW_HEIGHT / 2),
      });
    });
  }
  return positions;
}

interface DirectedEdgeLike {
  sourceConceptId: string;
  targetConceptId: string;
}

/**
 * Count crossings between same-span prerequisite edges of a layered order
 * (the standard layered-crossing measure: two edges whose sources share a
 * layer and whose targets share a layer cross when their orders invert).
 */
export function countLayeredCrossings(
  order: ReadonlyMap<number, readonly string[]>,
  edges: readonly DirectedEdgeLike[],
  layerOf: ReadonlyMap<string, number>,
): number {
  const index = new Map<string, number>();
  for (const members of order.values()) {
    members.forEach((id, i) => index.set(id, i));
  }
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      if (
        layerOf.get(a.sourceConceptId) !== layerOf.get(b.sourceConceptId) ||
        layerOf.get(a.targetConceptId) !== layerOf.get(b.targetConceptId)
      ) {
        continue;
      }
      const s = (index.get(a.sourceConceptId) ?? 0) - (index.get(b.sourceConceptId) ?? 0);
      const t = (index.get(a.targetConceptId) ?? 0) - (index.get(b.targetConceptId) ?? 0);
      if (s * t < 0) crossings += 1;
    }
  }
  return crossings;
}

/**
 * Bounded deterministic barycenter ordering (ELK-layered-inspired): four
 * alternating downward/upward sweeps order each layer's members by the mean
 * current index of their prerequisite neighbors in the sweep direction.
 * Nodes without neighbors keep their relative position; ties break by
 * current index, then concept ID. Input arrays are not mutated.
 */
export function orderLayersByBarycenter(
  byLayer: ReadonlyMap<number, readonly string[]>,
  prereqEdges: readonly DirectedEdgeLike[],
  layerOf: ReadonlyMap<string, number>,
): Map<number, string[]> {
  const order = new Map<number, string[]>();
  for (const [layer, members] of byLayer) order.set(layer, [...members]);
  const layers = [...order.keys()].sort((a, b) => a - b);
  if (layers.length < 2 || prereqEdges.length === 0) return order;

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of prereqEdges) {
    const p = parents.get(edge.targetConceptId) ?? [];
    p.push(edge.sourceConceptId);
    parents.set(edge.targetConceptId, p);
    const c = children.get(edge.sourceConceptId) ?? [];
    c.push(edge.targetConceptId);
    children.set(edge.sourceConceptId, c);
  }

  const before = countLayeredCrossings(order, prereqEdges, layerOf);
  const SWEEPS = 4;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const goingDown = sweep % 2 === 0;
    const sequence = goingDown ? layers : [...layers].reverse();
    for (const layer of sequence) {
      const index = new Map<string, number>();
      for (const members of order.values()) members.forEach((id, i) => index.set(id, i));
      const members = order.get(layer)!;
      const keyed = members.map((id, currentIndex) => {
        const neighbors = (goingDown ? parents : children).get(id) ?? [];
        const positions = neighbors
          .map((n) => index.get(n))
          .filter((v): v is number => v !== undefined);
        const barycenter =
          positions.length > 0
            ? positions.reduce((sum, v) => sum + v, 0) / positions.length
            : currentIndex;
        return { id, currentIndex, barycenter };
      });
      keyed.sort(
        (a, b) =>
          a.barycenter - b.barycenter ||
          a.currentIndex - b.currentIndex ||
          a.id.localeCompare(b.id),
      );
      order.set(
        layer,
        keyed.map((k) => k.id),
      );
    }
  }

  // Keep the sweep result only when it strictly reduced crossings.
  if (countLayeredCrossings(order, prereqEdges, layerOf) >= before) {
    const original = new Map<number, string[]>();
    for (const [layer, members] of byLayer) original.set(layer, [...members]);
    return original;
  }
  return order;
}

/** Deterministic budgets for the 薄弱路径 subgraph. */
export interface WeakPathLimits {
  /** Shortest-path prerequisite ancestors kept per weak concept. */
  maxPrereqAncestorsPerWeak: number;
  /** Direct part_of wholes (essential context) kept per weak concept. */
  maxPartOfParentsPerWeak: number;
  /** Direct prerequisite dependents kept per weak concept. */
  maxDependentsPerWeak: number;
  /** Hard cap for the whole subgraph (weak concepts always survive). */
  maxTotalNodes: number;
}

export const WEAK_PATH_LIMITS: WeakPathLimits = {
  maxPrereqAncestorsPerWeak: 4,
  maxPartOfParentsPerWeak: 1,
  maxDependentsPerWeak: 2,
  maxTotalNodes: 40,
};

export interface WeakPathSubgraph {
  conceptIds: Set<string>;
  edgeIds: Set<string>;
  /** True when a node budget cut prerequisite paths or dependents. */
  truncated: boolean;
}

/**
 * 薄弱路径: a minimal remediation-oriented subgraph, not a neighborhood dump.
 *
 * Included, in deterministic priority order:
 *   1. every weak concept;
 *   2. shortest prerequisite paths from each weak concept toward its
 *      foundational ancestors (BFS over incoming prerequisite edges,
 *      bounded per weak concept);
 *   3. the direct part_of whole of each weak concept (bounded) — the
 *      structural context a learner needs to place the weak part;
 *   4. a small bounded number of direct prerequisite dependents, so the
 *      learner sees what unlocks once the weakness is repaired.
 *
 * Only prerequisite and part_of edges between included concepts are kept.
 * contrasts_with / example_of / applies_to / causes never define the path
 * and are excluded even when both endpoints are visible. Ties are broken by
 * the input concept order and edge IDs, so the result is stable.
 */
export function weakPathSubgraph(
  concepts: Concept[],
  edges: GraphEdge[],
  overlay: Map<string, ConceptLearnerState>,
  limits: WeakPathLimits = WEAK_PATH_LIMITS,
): WeakPathSubgraph {
  const conceptOrder = new Map(concepts.map((c, i) => [c.id, i]));
  const valid = edges.filter(
    (e) => conceptOrder.has(e.sourceConceptId) && conceptOrder.has(e.targetConceptId),
  );
  const weak = concepts.filter((c) => overlay.get(c.id)?.treatAsWeak).map((c) => c.id);
  if (weak.length === 0) {
    return { conceptIds: new Set(), edgeIds: new Set(), truncated: false };
  }

  const byIdThenOrder = (aId: string, aEdge: string, bId: string, bEdge: string): number => {
    const orderDiff = (conceptOrder.get(aId) ?? 0) - (conceptOrder.get(bId) ?? 0);
    return orderDiff !== 0 ? orderDiff : aEdge.localeCompare(bEdge);
  };

  // Sorted adjacency for deterministic traversal.
  const prereqParents = new Map<string, Array<{ id: string; edgeId: string }>>();
  const prereqChildren = new Map<string, Array<{ id: string; edgeId: string }>>();
  const partOfWholes = new Map<string, Array<{ id: string; edgeId: string }>>();
  for (const edge of valid) {
    if (edge.relation === 'prerequisite') {
      const parents = prereqParents.get(edge.targetConceptId) ?? [];
      parents.push({ id: edge.sourceConceptId, edgeId: edge.id });
      prereqParents.set(edge.targetConceptId, parents);
      const children = prereqChildren.get(edge.sourceConceptId) ?? [];
      children.push({ id: edge.targetConceptId, edgeId: edge.id });
      prereqChildren.set(edge.sourceConceptId, children);
    } else if (edge.relation === 'part_of') {
      // source is the part; target is the whole that gives it context.
      const wholes = partOfWholes.get(edge.sourceConceptId) ?? [];
      wholes.push({ id: edge.targetConceptId, edgeId: edge.id });
      partOfWholes.set(edge.sourceConceptId, wholes);
    }
  }
  for (const map of [prereqParents, prereqChildren, partOfWholes]) {
    for (const list of map.values()) {
      list.sort((a, b) => byIdThenOrder(a.id, a.edgeId, b.id, b.edgeId));
    }
  }

  const included = new Set(weak);
  let truncated = false;
  const tryInclude = (id: string): boolean => {
    if (included.has(id)) return true;
    if (included.size >= limits.maxTotalNodes) {
      truncated = true;
      return false;
    }
    included.add(id);
    return true;
  };

  // 2. Shortest prerequisite repair paths (BFS up = nearest ancestors first).
  for (const weakId of weak) {
    let added = 0;
    const visited = new Set([weakId]);
    const queue = [weakId];
    while (queue.length > 0 && added < limits.maxPrereqAncestorsPerWeak) {
      const current = queue.shift()!;
      for (const parent of prereqParents.get(current) ?? []) {
        if (visited.has(parent.id)) continue;
        visited.add(parent.id);
        if (added >= limits.maxPrereqAncestorsPerWeak) break;
        if (!tryInclude(parent.id)) break;
        added += 1;
        queue.push(parent.id);
      }
    }
  }

  // 3. Direct part_of wholes for structural context.
  for (const weakId of weak) {
    for (const whole of (partOfWholes.get(weakId) ?? []).slice(0, limits.maxPartOfParentsPerWeak)) {
      tryInclude(whole.id);
    }
  }

  // 4. Bounded direct dependents (what the weak concept unlocks).
  for (const weakId of weak) {
    for (const child of (prereqChildren.get(weakId) ?? []).slice(0, limits.maxDependentsPerWeak)) {
      tryInclude(child.id);
    }
  }

  // Only remediation-relevant relations between included concepts survive.
  const edgeIds = new Set(
    valid
      .filter(
        (e) =>
          (e.relation === 'prerequisite' || e.relation === 'part_of') &&
          included.has(e.sourceConceptId) &&
          included.has(e.targetConceptId),
      )
      .map((e) => e.id),
  );
  return { conceptIds: included, edgeIds, truncated };
}

/** One- or two-hop neighborhood of a focus concept (聚焦邻域). */
export function neighborhoodConceptIds(
  rootId: string,
  edges: GraphEdge[],
  hops: 1 | 2,
): Set<string> {
  const result = new Set([rootId]);
  let frontier = new Set([rootId]);
  for (let hop = 0; hop < hops; hop++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.sourceConceptId) && !result.has(edge.targetConceptId)) {
        next.add(edge.targetConceptId);
      }
      if (frontier.has(edge.targetConceptId) && !result.has(edge.sourceConceptId)) {
        next.add(edge.sourceConceptId);
      }
    }
    next.forEach((id) => result.add(id));
    frontier = next;
  }
  return result;
}

const POSITIONS_KEY_PREFIX = 'hy3-clinic:graph-positions:';

/** Load user-dragged node positions saved for one graph version. */
export function loadSavedPositions(versionId: string): Record<string, { x: number; y: number }> {
  try {
    const raw = window.localStorage.getItem(POSITIONS_KEY_PREFIX + versionId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Record<string, { x: number; y: number }> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { x?: unknown }).x === 'number' &&
        typeof (value as { y?: unknown }).y === 'number'
      ) {
        result[id] = { x: (value as { x: number }).x, y: (value as { y: number }).y };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function savePositions(
  versionId: string,
  positions: Record<string, { x: number; y: number }>,
): void {
  try {
    if (Object.keys(positions).length === 0) {
      window.localStorage.removeItem(POSITIONS_KEY_PREFIX + versionId);
    } else {
      window.localStorage.setItem(POSITIONS_KEY_PREFIX + versionId, JSON.stringify(positions));
    }
  } catch {
    // Storage can be unavailable; dragged positions simply are not restored.
  }
}
