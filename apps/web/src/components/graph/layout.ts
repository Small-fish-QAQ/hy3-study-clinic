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
        .distance(190)
        .strength(0.55),
    )
    .force('charge', forceManyBody<SimNode>().strength(-460))
    .force(
      // Rectangular nodes: collide on the circumscribed circle so two
      // rectangles can never overlap, plus breathing room for labels.
      'collide',
      forceCollide<SimNode>()
        .radius((n) => Math.hypot(n.size.width / 2, n.size.height / 2) + 14)
        .iterations(2),
    )
    .force('x', forceX<SimNode>(0).strength(0.06))
    .force('y', forceY<SimNode>(0).strength(0.08))
    .stop();

  // Bounded synchronous convergence — never a background timer.
  const ticks = Math.min(300, 120 + concepts.length * 4);
  for (let i = 0; i < ticks; i++) simulation.tick();

  for (const node of nodes) {
    positions.set(node.id, {
      x: (node.x ?? 0) - node.size.width / 2,
      y: (node.y ?? 0) - node.size.height / 2,
    });
  }
  return positions;
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

  const positions = new Map<string, { x: number; y: number }>();
  const COL_WIDTH = 250;
  const ROW_HEIGHT = 170;
  const MAX_PER_ROW = 6;
  for (const [l, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
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

/**
 * 薄弱路径 subset: weak concepts, their transitive prerequisite ancestors
 * (the repair path), and their direct neighbors for context.
 */
export function weakPathConceptIds(
  concepts: Concept[],
  edges: GraphEdge[],
  overlay: Map<string, ConceptLearnerState>,
): Set<string> {
  const idSet = new Set(concepts.map((c) => c.id));
  const weak = new Set(concepts.filter((c) => overlay.get(c.id)?.treatAsWeak).map((c) => c.id));
  const result = new Set(weak);

  // Transitive prerequisite ancestors of weak concepts.
  const prereqParents = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'prerequisite') continue;
    if (!idSet.has(edge.sourceConceptId) || !idSet.has(edge.targetConceptId)) continue;
    const list = prereqParents.get(edge.targetConceptId) ?? [];
    list.push(edge.sourceConceptId);
    prereqParents.set(edge.targetConceptId, list);
  }
  const queue = [...weak];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const parent of prereqParents.get(id) ?? []) {
      if (!result.has(parent)) {
        result.add(parent);
        queue.push(parent);
      }
    }
  }

  // Direct neighbors (any relation) for context.
  for (const edge of edges) {
    if (weak.has(edge.sourceConceptId) && idSet.has(edge.targetConceptId)) {
      result.add(edge.targetConceptId);
    }
    if (weak.has(edge.targetConceptId) && idSet.has(edge.sourceConceptId)) {
      result.add(edge.sourceConceptId);
    }
  }
  return result;
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
