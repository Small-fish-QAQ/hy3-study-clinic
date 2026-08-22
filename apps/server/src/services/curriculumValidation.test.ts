import { describe, expect, it } from 'vitest';
import type { Concept, Curriculum, SourceBlock } from '@hy3-clinic/shared';
import { normalizeDuplicateLearningUnitTitles } from './curriculumValidation.js';

const concept = (id: string, name: string, blockId: string): Concept => ({
  id,
  materialId: 'material_1',
  materialRevisionId: 'revision_1',
  name,
  summary: name,
  importance: 'medium',
  grounding: {
    blockId,
    quote: `${name} source.`,
    startOffset: 0,
    endOffset: `${name} source.`.length,
    occurrenceCount: 1,
    reanchored: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const block = (id: string, content: string): SourceBlock => ({
  id,
  materialId: 'material_1',
  materialRevisionId: 'revision_1',
  index: Number(id.slice(-1)),
  heading: '2. LLM',
  headingPath: ['2. LLM'],
  pageNumber: null,
  pageEnd: null,
  content,
  startOffset: 0,
  endOffset: content.length,
});

function unit(id: string, blockId: string, conceptId: string, description: string) {
  return {
    id,
    parentId: 'section_1',
    kind: 'learning_unit' as const,
    index: Number(id.slice(-1)),
    title: '2. LLM',
    sourceReferences: [
      {
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        structuralUnitId: null,
        sourceBlockId: blockId,
        sourceBlockRevisionFingerprint: null,
      },
    ],
    learningUnit: {
      conceptIds: [conceptId],
      canonicalConceptIds: [],
      objectives: [
        {
          id: `objective_${id}`,
          title: 'Understand 2. LLM',
          description,
          truthPremiseStatus: 'unverified' as const,
          truthAuthorityRecordIds: [],
        },
      ],
      prerequisiteUnitIds: [],
      graphRelationIds: [],
      riskIds: [],
    },
  } satisfies Curriculum['nodes'][number];
}

describe('Curriculum learner-visible title quality', () => {
  it('disambiguates repeated headings using source and concept meaning', () => {
    const nodes = [
      unit('unit_1', 'block_1', 'concept_1', 'Explain role and boundary.'),
      unit('unit_2', 'block_2', 'concept_2', 'Organize prompt and context.'),
    ];
    const errors: string[] = [];
    normalizeDuplicateLearningUnitTitles(
      nodes,
      [
        concept('concept_1', 'LLM 的角色与边界', 'block_1'),
        concept('concept_2', 'Prompt 与上下文组织', 'block_2'),
      ],
      [
        block('block_1', 'LLM provides bounded role.'),
        block('block_2', 'Prompt organizes context.'),
      ],
      errors,
    );
    expect(errors).toEqual([]);
    expect(nodes.map((node) => node.title)).toEqual([
      '2. LLM - LLM 的角色与边界',
      '2. LLM - Prompt 与上下文组织',
    ]);
  });

  it('rejects accidental duplicates with identical source and objective meaning', () => {
    const nodes = [
      unit('unit_1', 'block_1', 'concept_1', 'Explain the same topic.'),
      unit('unit_2', 'block_1', 'concept_1', 'Explain the same topic.'),
    ];
    const errors: string[] = [];
    normalizeDuplicateLearningUnitTitles(
      nodes,
      [concept('concept_1', 'LLM', 'block_1')],
      [block('block_1', 'The same source.')],
      errors,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('has no distinct source/objective meaning');
  });

  it('keeps an 80-unit realistic repeated-heading fixture learner-distinct', () => {
    const nodes = Array.from({ length: 80 }, (_, index) =>
      unit(`unit_${index + 1}`, `block_${index + 1}`, `concept_${index + 1}`, `Topic ${index + 1}`),
    );
    const concepts = nodes.map((node, index) =>
      concept(`concept_${index + 1}`, `Topic ${index + 1}`, `block_${index + 1}`),
    );
    const blocks = nodes.map((_node, index) =>
      block(`block_${index + 1}`, `Distinct source meaning ${index + 1}.`),
    );
    const errors: string[] = [];
    normalizeDuplicateLearningUnitTitles(nodes, concepts, blocks, errors);
    expect(errors).toEqual([]);
    expect(new Set(nodes.map((node) => node.title))).toHaveLength(80);
    expect(nodes.every((node) => node.title.startsWith('2. LLM - Topic '))).toBe(true);
  });
});
