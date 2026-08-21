import { describe, expect, it } from 'vitest';
import {
  computeKnowledgeMapLayout,
  loadKnowledgeMapPositions,
  loadKnowledgeMapViewport,
  saveKnowledgeMapPositions,
  saveKnowledgeMapViewport,
} from './knowledgeMapLayout.js';
import { largeKnowledgeMapProjection } from './test/knowledgeMapFixture.js';

describe('Knowledge Map deterministic layout and preferences', () => {
  it('places a realistic larger projection deterministically', () => {
    const projection = largeKnowledgeMapProjection();
    const first = computeKnowledgeMapLayout(projection.nodes, projection.edges);
    const second = computeKnowledgeMapLayout(projection.nodes, projection.edges);
    expect(first.size).toBe(120);
    expect([...first]).toEqual([...second]);
    expect([...first.values()].every((position) => Number.isFinite(position.x + position.y))).toBe(
      true,
    );
  });

  it('round-trips presentation-only positions and viewport', () => {
    saveKnowledgeMapPositions('ws:curriculum', { node: { x: 12, y: 34 } });
    saveKnowledgeMapViewport('ws:curriculum', { x: -20, y: 10, zoom: 0.8 });
    expect(loadKnowledgeMapPositions('ws:curriculum')).toEqual({ node: { x: 12, y: 34 } });
    expect(loadKnowledgeMapViewport('ws:curriculum')).toEqual({ x: -20, y: 10, zoom: 0.8 });
    window.localStorage.setItem('hy3-clinic:knowledge-map:positions:bad', '{bad');
    expect(loadKnowledgeMapPositions('bad')).toEqual({});
  });
});
