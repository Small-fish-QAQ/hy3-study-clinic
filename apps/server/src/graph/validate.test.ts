import { describe, expect, it } from 'vitest';
import type { Concept, ProposedGraphEdge, SourceBlock } from '@hy3-clinic/shared';
import { makeBlock, makeConcept } from '../testing/fixtures.js';
import { validateProposedEdges } from './validate.js';

const blockA: SourceBlock = makeBlock({
  id: 'blk_a',
  materialId: 'mat_1',
  content: '工作记忆的容量十分有限。它一次只能保持大约四个组块。',
  startOffset: 0,
  endOffset: 26,
});
const blockB: SourceBlock = makeBlock({
  id: 'blk_b',
  materialId: 'mat_1',
  index: 1,
  content: '长时记忆通过巩固过程形成,睡眠对巩固十分重要。',
  startOffset: 30,
  endOffset: 52,
});

const conceptA: Concept = makeConcept({
  id: 'con_a',
  grounding: { ...makeConcept().grounding, blockId: 'blk_a', quote: '工作记忆的容量十分有限。' },
});
const conceptB: Concept = makeConcept({ id: 'con_b', name: '长时记忆' });
const conceptC: Concept = makeConcept({ id: 'con_c', name: '睡眠巩固' });

const ctx = {
  workspaceConcepts: [conceptA, conceptB, conceptC],
  blocks: [blockA, blockB],
};

function edge(overrides: Partial<ProposedGraphEdge> = {}): ProposedGraphEdge {
  return {
    sourceConceptId: 'con_a',
    targetConceptId: 'con_b',
    relation: 'prerequisite',
    explanation: '先理解工作记忆才能理解长时记忆。',
    evidence: [{ blockId: 'blk_a', quote: '工作记忆的容量十分有限。' }],
    ...overrides,
  };
}

describe('validateProposedEdges', () => {
  it('accepts a valid edge and computes verified offsets server-side', () => {
    const { accepted, summary } = validateProposedEdges([edge()], ctx);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.evidence[0]).toMatchObject({
      blockId: 'blk_a',
      startOffset: 0,
      endOffset: 12,
      occurrenceCount: 1,
      reanchored: false,
    });
    expect(summary).toMatchObject({
      candidateCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      duplicateCount: 0,
      droppedEvidenceCount: 0,
    });
  });

  it('rejects unknown concepts', () => {
    const { accepted, summary } = validateProposedEdges(
      [edge({ targetConceptId: 'con_missing' })],
      ctx,
    );
    expect(accepted).toHaveLength(0);
    expect(summary.rejected[0]!.reason).toContain('未知概念');
  });

  it('labels cross-workspace concept references distinctly', () => {
    const { summary } = validateProposedEdges([edge({ targetConceptId: 'con_other_ws' })], {
      ...ctx,
      conceptExistsElsewhere: (id) => id === 'con_other_ws',
    });
    expect(summary.rejected[0]!.reason).toContain('其他课程空间');
  });

  it('rejects self-links', () => {
    const { summary } = validateProposedEdges([edge({ targetConceptId: 'con_a' })], ctx);
    expect(summary.rejected[0]!.reason).toContain('自环');
  });

  it('removes duplicate normalized edges but keeps distinct relations', () => {
    const { accepted, summary } = validateProposedEdges(
      [edge(), edge(), edge({ relation: 'causes' })],
      ctx,
    );
    expect(accepted).toHaveLength(2);
    expect(summary.duplicateCount).toBe(1);
  });

  it('rejects an edge whose every evidence quote fails grounding', () => {
    const { accepted, summary } = validateProposedEdges(
      [edge({ evidence: [{ blockId: 'blk_a', quote: '这句话不在资料里。' }] })],
      ctx,
    );
    expect(accepted).toHaveLength(0);
    expect(summary.rejected[0]!.reason).toContain('原文校验');
    expect(summary.droppedEvidenceCount).toBe(1);
  });

  it('keeps an edge when at least one evidence record verifies, dropping the rest', () => {
    const { accepted, summary } = validateProposedEdges(
      [
        edge({
          evidence: [
            { blockId: 'blk_a', quote: '不存在的引文。' },
            { blockId: 'blk_a', quote: '它一次只能保持大约四个组块。' },
          ],
        }),
      ],
      ctx,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.evidence).toHaveLength(1);
    expect(summary.droppedEvidenceCount).toBe(1);
  });

  it('rejects prerequisite cycles while keeping the acyclic siblings', () => {
    const { accepted, summary } = validateProposedEdges(
      [
        edge({ sourceConceptId: 'con_a', targetConceptId: 'con_b' }),
        edge({ sourceConceptId: 'con_b', targetConceptId: 'con_c' }),
        // Closing edge c → a would form a cycle.
        edge({ sourceConceptId: 'con_c', targetConceptId: 'con_a' }),
      ],
      ctx,
    );
    expect(accepted).toHaveLength(2);
    expect(summary.rejected[0]!.reason).toContain('形成环');
  });

  it('checks cycles per relation: a part_of edge may reverse a prerequisite edge', () => {
    const { accepted } = validateProposedEdges(
      [
        edge({ sourceConceptId: 'con_a', targetConceptId: 'con_b', relation: 'prerequisite' }),
        edge({ sourceConceptId: 'con_b', targetConceptId: 'con_a', relation: 'part_of' }),
      ],
      ctx,
    );
    expect(accepted).toHaveLength(2);
  });

  it('does not cycle-check non-hierarchical relations', () => {
    const { accepted } = validateProposedEdges(
      [
        edge({ relation: 'contrasts_with' }),
        edge({ sourceConceptId: 'con_b', targetConceptId: 'con_a', relation: 'contrasts_with' }),
      ],
      ctx,
    );
    expect(accepted).toHaveLength(2);
  });

  it('accepts valid siblings when other candidates are invalid (partial acceptance)', () => {
    const { accepted, summary } = validateProposedEdges(
      [
        edge({ targetConceptId: 'con_missing' }),
        edge({ sourceConceptId: 'con_b', targetConceptId: 'con_c' }),
      ],
      ctx,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.sourceConceptId).toBe('con_b');
    expect(summary.rejectedCount).toBe(1);
  });

  it('enforces the local edge budget deterministically', () => {
    const candidates = [
      edge({ sourceConceptId: 'con_a', targetConceptId: 'con_b' }),
      edge({ sourceConceptId: 'con_b', targetConceptId: 'con_c' }),
      edge({ sourceConceptId: 'con_a', targetConceptId: 'con_c' }),
    ];
    const { accepted, summary } = validateProposedEdges(candidates, { ...ctx, maxEdges: 2 });
    expect(accepted).toHaveLength(2);
    expect(summary.rejected[0]!.reason).toContain('上限');
  });
});
