import { describe, expect, it } from 'vitest';
import type {
  CanonicalConceptView,
  Concept,
  ConceptLearnerState,
  GraphEdge,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import { aggregateOverlay, buildCanonicalDisplayGraph } from './canonicalView';

const T0 = '2026-01-01T00:00:00.000Z';

function grounding(blockId: string): VerifiedGrounding {
  return {
    blockId,
    quote: '引文。',
    startOffset: 0,
    endOffset: 3,
    occurrenceCount: 1,
    reanchored: false,
  };
}

function concept(id: string, name: string, materialId: string): Concept {
  return {
    id,
    materialId,
    name,
    summary: `${name} 的说明。`,
    importance: 'high',
    grounding: grounding(`blk_${id}`),
    createdAt: T0,
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  relation: GraphEdge['relation'],
): GraphEdge {
  return {
    id,
    graphVersionId: 'gv_1',
    sourceConceptId: source,
    targetConceptId: target,
    relation,
    explanation: '关系说明。',
    evidence: [grounding(`blk_${source}`)],
    createdAt: T0,
  };
}

function canonicalGroup(
  id: string,
  displayName: string,
  memberIds: Array<[conceptId: string, name: string, materialId: string]>,
): CanonicalConceptView {
  return {
    id,
    workspaceId: 'ws_1',
    displayName,
    normalizedKey: displayName.toLowerCase(),
    description: null,
    createdAt: T0,
    updatedAt: T0,
    members: memberIds.map(([sourceConceptId, originalName, materialId]) => ({
      sourceConceptId,
      canonicalConceptId: id,
      originalName,
      materialId,
      language: 'zh',
      viaProposalId: null,
      createdAt: T0,
    })),
    aliases: memberIds.map(([, name]) => name).filter((n) => n !== displayName),
    materialIds: [...new Set(memberIds.map(([, , materialId]) => materialId))],
  };
}

function state(
  conceptId: string,
  overrides: Partial<ConceptLearnerState> = {},
): ConceptLearnerState {
  return {
    conceptId,
    conceptName: conceptId,
    materialId: 'm1',
    state: 'developing',
    mastery: 0.75,
    hasEnoughActivity: true,
    attempts: 3,
    correctCount: 2,
    lastScore: 0.8,
    lastActivityAt: T0,
    openMistakes: 0,
    resolvedMistakes: 0,
    treatAsWeak: false,
    prerequisiteConceptIds: [],
    ...overrides,
  };
}

describe('buildCanonicalDisplayGraph', () => {
  const concepts = [
    concept('a', '工作记忆', 'm1'),
    concept('b', 'Working memory', 'm2'),
    concept('c', '长时记忆', 'm1'),
  ];
  const canonical = [
    canonicalGroup('can_1', '工作记忆', [
      ['a', '工作记忆', 'm1'],
      ['b', 'Working memory', 'm2'],
    ]),
    canonicalGroup('can_2', '长时记忆', [['c', '长时记忆', 'm1']]),
  ];

  it('renders one node per canonical group anchored on a stable representative', () => {
    const display = buildCanonicalDisplayGraph(concepts, [], canonical);
    expect(display.concepts.map((c) => c.id).sort()).toEqual(['a', 'c']);
    expect(display.representativeByConcept.get('b')).toBe('a');
    expect(display.canonicalByRepresentative.get('a')!.aliases).toContain('Working memory');
  });

  it('shows the canonical display name (including later renames)', () => {
    const renamed = [{ ...canonical[0]!, displayName: '工作记忆(修复)' }, canonical[1]!];
    const display = buildCanonicalDisplayGraph(concepts, [], renamed);
    expect(display.concepts.find((c) => c.id === 'a')!.name).toBe('工作记忆(修复)');
  });

  it('re-anchors edges to representatives, drops intra-group edges, and merges duplicates', () => {
    const edges = [
      edge('e1', 'b', 'c', 'prerequisite'), // b → representative a
      edge('e2', 'a', 'c', 'prerequisite'), // duplicate after re-anchoring
      edge('e3', 'a', 'b', 'contrasts_with'), // intra-group → dropped
    ];
    const display = buildCanonicalDisplayGraph(concepts, edges, canonical);
    expect(display.edges).toHaveLength(1);
    expect(display.edges[0]!.sourceConceptId).toBe('a');
    expect(display.edges[0]!.targetConceptId).toBe('c');
    expect(display.underlyingEdgesByDisplayEdge.get(display.edges[0]!.id)).toHaveLength(2);
  });

  it('passes through concepts without canonical membership unchanged', () => {
    const display = buildCanonicalDisplayGraph(concepts, [], []);
    expect(display.concepts).toHaveLength(3);
    expect(display.representativeByConcept.get('b')).toBe('b');
  });
});

describe('aggregateOverlay', () => {
  const concepts = [concept('a', '工作记忆', 'm1'), concept('b', 'Working memory', 'm2')];
  const canonical = [
    canonicalGroup('can_1', '工作记忆', [
      ['a', '工作记忆', 'm1'],
      ['b', 'Working memory', 'm2'],
    ]),
  ];
  const display = buildCanonicalDisplayGraph(concepts, [], canonical);

  it('sums attempts/mistakes and computes attempt-weighted mastery', () => {
    const overlay = new Map([
      ['a', state('a', { attempts: 3, mastery: 0.9, openMistakes: 0 })],
      ['b', state('b', { attempts: 1, mastery: 0.5, openMistakes: 2, state: 'weak' })],
    ]);
    const aggregated = aggregateOverlay(overlay, display);
    const merged = aggregated.get('a')!;
    expect(merged.attempts).toBe(4);
    expect(merged.openMistakes).toBe(2);
    expect(merged.mastery).toBeCloseTo((0.9 * 3 + 0.5 * 1) / 4, 4);
    expect(merged.state).toBe('weak'); // open mistakes dominate
    expect(aggregated.has('b')).toBe(false);
  });

  it('keeps unassessed groups unassessed and single states untouched', () => {
    const overlay = new Map([
      ['a', state('a', { attempts: 0, mastery: null, state: 'unassessed', lastScore: null })],
      ['b', state('b', { attempts: 0, mastery: null, state: 'unassessed', lastScore: null })],
    ]);
    const aggregated = aggregateOverlay(overlay, display);
    expect(aggregated.get('a')!.state).toBe('unassessed');
    expect(aggregated.get('a')!.mastery).toBeNull();
  });

  it('marks stable groups stable with the shared thresholds', () => {
    const overlay = new Map([
      ['a', state('a', { attempts: 4, mastery: 0.9, state: 'stable' })],
      ['b', state('b', { attempts: 2, mastery: 0.88 })],
    ]);
    const aggregated = aggregateOverlay(overlay, display);
    expect(aggregated.get('a')!.state).toBe('stable');
  });
});
