import { describe, expect, it } from 'vitest';
import type { Concept, ConceptLearnerState, GraphEdge, GraphRelation } from '@hy3-clinic/shared';
import { weakPathSubgraph, WEAK_PATH_LIMITS } from './layout';
import { T0 } from '../../test/fixtures';

/**
 * 薄弱路径 minimal-remediation-subgraph regressions (defect: weak-path mode
 * previously expanded to all neighbors of any relation and matched 网络视图).
 */

function concept(id: string): Concept {
  return {
    id,
    materialId: 'mat_1',
    name: `概念${id}`,
    summary: `概念${id}的测试摘要。`,
    importance: 'medium',
    grounding: {
      blockId: 'blk_0',
      quote: '工作记忆的容量十分有限',
      startOffset: 0,
      endOffset: 11,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: T0,
  };
}

function edge(id: string, sourceId: string, targetId: string, relation: GraphRelation): GraphEdge {
  return {
    id,
    graphVersionId: 'gv_1',
    sourceConceptId: sourceId,
    targetConceptId: targetId,
    relation,
    explanation: 'test',
    evidence: [],
    createdAt: T0,
  };
}

function weakOverlay(weakIds: string[], allIds: string[]): Map<string, ConceptLearnerState> {
  return new Map(
    allIds.map((id) => [
      id,
      {
        conceptId: id,
        conceptName: `概念${id}`,
        materialId: 'mat_1',
        state: weakIds.includes(id) ? ('weak' as const) : ('unassessed' as const),
        mastery: weakIds.includes(id) ? 0.3 : null,
        hasEnoughActivity: true,
        attempts: weakIds.includes(id) ? 3 : 0,
        correctCount: 0,
        lastScore: null,
        lastActivityAt: null,
        openMistakes: 0,
        resolvedMistakes: 0,
        treatAsWeak: weakIds.includes(id),
        prerequisiteConceptIds: [],
      },
    ]),
  );
}

describe('weakPathSubgraph', () => {
  it('keeps every weak concept and connected shortest prerequisite paths', () => {
    // root → mid → weak (two-level repair path)
    const ids = ['root', 'mid', 'weak', 'unrelated'];
    const concepts = ids.map(concept);
    const edges = [
      edge('e1', 'root', 'mid', 'prerequisite'),
      edge('e2', 'mid', 'weak', 'prerequisite'),
      edge('e3', 'unrelated', 'root', 'contrasts_with'),
    ];
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], ids));
    expect(sub.conceptIds).toEqual(new Set(['weak', 'mid', 'root']));
    // The discovery edges are included, so the path stays connected.
    expect(sub.edgeIds).toEqual(new Set(['e1', 'e2']));
    expect(sub.truncated).toBe(false);
  });

  it('includes the direct part_of whole as essential context', () => {
    const ids = ['whole', 'weak', 'siblingPart'];
    const concepts = ids.map(concept);
    const edges = [
      edge('e1', 'weak', 'whole', 'part_of'),
      edge('e2', 'siblingPart', 'whole', 'part_of'),
    ];
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], ids));
    expect(sub.conceptIds.has('whole')).toBe(true);
    // A sibling part of the same whole is NOT pulled in.
    expect(sub.conceptIds.has('siblingPart')).toBe(false);
    expect(sub.edgeIds.has('e1')).toBe(true);
    expect(sub.edgeIds.has('e2')).toBe(false);
  });

  it('excludes contrast/example/application/causal relations even between included concepts', () => {
    const ids = ['a', 'b'];
    const concepts = ids.map(concept);
    const edges = [
      edge('p', 'a', 'b', 'prerequisite'),
      edge('c1', 'a', 'b', 'contrasts_with'),
      edge('c2', 'a', 'b', 'example_of'),
      edge('c3', 'a', 'b', 'applies_to'),
      edge('c4', 'a', 'b', 'causes'),
    ];
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(['a', 'b'], ids));
    expect(sub.conceptIds).toEqual(new Set(['a', 'b']));
    expect(sub.edgeIds).toEqual(new Set(['p']));
  });

  it('keeps at most the configured number of direct dependents per weak concept', () => {
    const ids = ['weak', 'd1', 'd2', 'd3'];
    const concepts = ids.map(concept);
    const edges = [
      edge('e1', 'weak', 'd1', 'prerequisite'),
      edge('e2', 'weak', 'd2', 'prerequisite'),
      edge('e3', 'weak', 'd3', 'prerequisite'),
    ];
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], ids));
    const dependents = ['d1', 'd2', 'd3'].filter((d) => sub.conceptIds.has(d));
    expect(dependents.length).toBe(WEAK_PATH_LIMITS.maxDependentsPerWeak);
    // Deterministic pick: first by concept order, then edge id.
    expect(dependents).toEqual(['d1', 'd2']);
  });

  it('bounds prerequisite ancestors per weak concept', () => {
    const chain = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'weak'];
    const concepts = chain.map(concept);
    const edges = chain.slice(0, -1).map((id, i) => {
      const next = chain[i + 1]!;
      return edge(`e${i}`, id, next, 'prerequisite');
    });
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], chain));
    // weak + closest N ancestors (BFS = shortest paths first).
    expect(sub.conceptIds.size).toBe(1 + WEAK_PATH_LIMITS.maxPrereqAncestorsPerWeak);
    expect(sub.conceptIds.has('a6')).toBe(true);
    expect(sub.conceptIds.has('a3')).toBe(true);
    expect(sub.conceptIds.has('a1')).toBe(false);
  });

  it('enforces the total node budget while always keeping weak concepts', () => {
    const weakIds = Array.from({ length: 5 }, (_, i) => `w${i}`);
    const helperIds = Array.from({ length: 60 }, (_, i) => `h${i}`);
    const allIds = [...weakIds, ...helperIds];
    const concepts = allIds.map(concept);
    // Every weak concept has many prerequisite ancestors.
    const edges = weakIds.flatMap((w, wi) =>
      helperIds
        .slice(wi * 12, wi * 12 + 12)
        .map((h, hi) => edge(`e${wi}_${hi}`, h, w, 'prerequisite')),
    );
    const sub = weakPathSubgraph(concepts, edges, weakOverlay(weakIds, allIds), {
      ...WEAK_PATH_LIMITS,
      maxPrereqAncestorsPerWeak: 12,
      maxTotalNodes: 12,
    });
    expect(sub.conceptIds.size).toBeLessThanOrEqual(12);
    for (const w of weakIds) expect(sub.conceptIds.has(w)).toBe(true);
    expect(sub.truncated).toBe(true);
  });

  it('returns an empty subgraph when nothing is weak', () => {
    const ids = ['a', 'b'];
    const sub = weakPathSubgraph(
      ids.map(concept),
      [edge('e', 'a', 'b', 'prerequisite')],
      weakOverlay([], ids),
    );
    expect(sub.conceptIds.size).toBe(0);
    expect(sub.edgeIds.size).toBe(0);
    expect(sub.truncated).toBe(false);
  });

  it('is deterministic for identical input', () => {
    const ids = ['root', 'mid', 'weak', 'd1', 'd2', 'd3'];
    const concepts = ids.map(concept);
    const edges = [
      edge('e1', 'root', 'mid', 'prerequisite'),
      edge('e2', 'mid', 'weak', 'prerequisite'),
      edge('e3', 'weak', 'd1', 'prerequisite'),
      edge('e4', 'weak', 'd2', 'prerequisite'),
      edge('e5', 'weak', 'd3', 'prerequisite'),
    ];
    const a = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], ids));
    const b = weakPathSubgraph(concepts, edges, weakOverlay(['weak'], ids));
    expect([...a.conceptIds].sort()).toEqual([...b.conceptIds].sort());
    expect([...a.edgeIds].sort()).toEqual([...b.edgeIds].sort());
  });
});
