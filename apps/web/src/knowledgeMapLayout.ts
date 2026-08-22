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
import type { KnowledgeMapEdge, KnowledgeMapNode } from '@hy3-clinic/shared';
import type { Viewport } from '@xyflow/react';

export interface KnowledgeMapNodeSize {
  width: number;
  height: number;
}

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  size: KnowledgeMapNodeSize;
}

const POSITIONS_KEY = 'hy3-clinic:knowledge-map:positions:';
const VIEWPORT_KEY = 'hy3-clinic:knowledge-map:viewport:';

function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function estimateKnowledgeMapNodeSize(node: KnowledgeMapNode): KnowledgeMapNodeSize {
  const base =
    node.kind === 'curriculum_region'
      ? { min: 194, max: 250, height: 86 }
      : node.kind === 'learning_unit'
        ? { min: 176, max: 224, height: 78 }
        : node.kind === 'synthesis'
          ? { min: 168, max: 214, height: 72 }
          : { min: 144, max: 194, height: 66 };
  return {
    width: Math.min(base.max, Math.max(base.min, 52 + node.label.length * 13)),
    height: base.height,
  };
}

/** Stable one-time topology layout. Learner mode/state never enters the simulation. */
export function computeKnowledgeMapLayout(
  inputNodes: readonly KnowledgeMapNode[],
  inputEdges: readonly KnowledgeMapEdge[],
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (inputNodes.length === 0) return result;
  const ordered = [...inputNodes].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(ordered.map((node) => node.id));
  const nodes: LayoutNode[] = ordered.map((node) => {
    const hash = hashId(node.id);
    const angle = (hash % 3600) * (Math.PI / 1800);
    const radius = 140 + (Math.floor(hash / 3600) % 340);
    return {
      id: node.id,
      size: estimateKnowledgeMapNodeSize(node),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  const links: SimulationLinkDatum<LayoutNode>[] = [...inputEdges]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId))
    .map((edge) => ({ source: edge.sourceNodeId, target: edge.targetNodeId }));
  const simulation = forceSimulation<LayoutNode>(nodes)
    .force(
      'link',
      forceLink<LayoutNode, SimulationLinkDatum<LayoutNode>>(links)
        .id((node) => node.id)
        .distance(205)
        .strength(0.48),
    )
    .force('charge', forceManyBody<LayoutNode>().strength(-520))
    .force(
      'collide',
      forceCollide<LayoutNode>()
        .radius((node) => Math.hypot(node.size.width / 2, node.size.height / 2) + 22)
        .iterations(2),
    )
    .force('x', forceX<LayoutNode>(0).strength(0.055))
    .force('y', forceY<LayoutNode>(0).strength(0.065))
    .stop();
  const ticks = Math.min(280, 100 + ordered.length * 3);
  for (let index = 0; index < ticks; index += 1) simulation.tick();
  for (const node of nodes) {
    result.set(node.id, {
      x: (node.x ?? 0) - node.size.width / 2,
      y: (node.y ?? 0) - node.size.height / 2,
    });
  }
  return result;
}

export function loadKnowledgeMapPositions(
  identity: string,
): Record<string, { x: number; y: number }> {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(POSITIONS_KEY + identity) ?? '{}',
    );
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, { x: number; y: number }] =>
          !!entry[1] &&
          typeof entry[1] === 'object' &&
          typeof (entry[1] as { x?: unknown }).x === 'number' &&
          typeof (entry[1] as { y?: unknown }).y === 'number',
      ),
    );
  } catch {
    return {};
  }
}

export function saveKnowledgeMapPositions(
  identity: string,
  positions: Record<string, { x: number; y: number }>,
): void {
  try {
    if (Object.keys(positions).length === 0)
      window.localStorage.removeItem(POSITIONS_KEY + identity);
    else window.localStorage.setItem(POSITIONS_KEY + identity, JSON.stringify(positions));
  } catch {
    // Camera and node placement preferences are optional.
  }
}

export function loadKnowledgeMapViewport(identity: string): Viewport | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(VIEWPORT_KEY + identity) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as Viewport).x === 'number' &&
      typeof (value as Viewport).y === 'number' &&
      typeof (value as Viewport).zoom === 'number'
    ) {
      return value as Viewport;
    }
  } catch {
    // Ignore unavailable or invalid optional preferences.
  }
  return null;
}

export function saveKnowledgeMapViewport(identity: string, viewport: Viewport): void {
  try {
    window.localStorage.setItem(VIEWPORT_KEY + identity, JSON.stringify(viewport));
  } catch {
    // Camera preferences are optional.
  }
}
