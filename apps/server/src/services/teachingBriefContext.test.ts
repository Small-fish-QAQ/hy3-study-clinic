import { describe, expect, it } from 'vitest';
import type { Concept, Curriculum, Material, SourceBlockRevision } from '@hy3-clinic/shared';
import { makeMaterial, T0 } from '../testing/fixtures.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import {
  buildTeachingBriefSourceContext,
  TEACHING_BRIEF_MAX_BLOCKS,
  TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
} from './teachingBriefContext.js';

function block(input: {
  id: string;
  materialId: string;
  revisionId: string;
  index: number;
  content: string;
  heading?: string;
}): SourceBlockRevision {
  const base = {
    id: input.id,
    materialId: input.materialId,
    materialRevisionId: input.revisionId,
    structuralUnitId: null,
    index: input.index,
    heading: input.heading ?? `Section ${input.index}`,
    headingPath: [input.heading ?? `Section ${input.index}`],
    pageNumber: input.index + 1,
    pageEnd: input.index + 1,
    content: input.content,
    startOffset: input.index * 100,
    endOffset: input.index * 100 + input.content.length,
  };
  return {
    ...base,
    revisionFingerprint: curriculumSourceBlockFingerprint(base, input.revisionId),
  };
}

function fixture(blocksOverride?: SourceBlockRevision[]) {
  const blocks = blocksOverride ?? [
    block({
      id: 'block_a0',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 0,
      content: 'Neighbor before.',
    }),
    block({
      id: 'block_a1',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 1,
      content: 'Mapped exact evidence for mechanism.',
    }),
    block({
      id: 'block_a2',
      materialId: 'material_a',
      revisionId: 'revision_a',
      index: 2,
      content: 'Neighbor after.',
    }),
    block({
      id: 'block_b1',
      materialId: 'material_b',
      revisionId: 'revision_b',
      index: 0,
      content: 'Second material evidence.',
    }),
  ];
  const materials: Material[] = [
    makeMaterial({
      id: 'material_a',
      workspaceId: 'ws_1',
      activeRevisionId: 'revision_a',
      title: 'Material A',
      availability: 'active',
    }),
    makeMaterial({
      id: 'material_b',
      workspaceId: 'ws_1',
      activeRevisionId: 'revision_b',
      title: 'Material B',
      availability: 'active',
    }),
  ];
  const refs = blocks
    .filter((candidate) => candidate.id === 'block_a1' || candidate.id === 'block_b1')
    .map((candidate) => ({
      materialId: candidate.materialId,
      materialRevisionId: candidate.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: candidate.id,
      sourceBlockRevisionFingerprint: candidate.revisionFingerprint,
    }));
  const curriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'accepted',
    executionSourceManifest: {
      fingerprint: 'manifest_1',
      revisions: [
        {
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: blocks
            .filter((candidate) => candidate.materialId === 'material_a')
            .map((candidate) => candidate.id),
        },
        {
          materialId: 'material_b',
          materialRevisionId: 'revision_b',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: blocks
            .filter((candidate) => candidate.materialId === 'material_b')
            .map((candidate) => candidate.id),
        },
      ],
    },
    nodes: [
      {
        id: 'course',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_1',
        parentId: 'course',
        kind: 'learning_unit',
        index: 1,
        title: 'Mechanism',
        sourceReferences: refs,
        learningUnit: {
          conceptIds: ['concept_1'],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_1',
              title: 'Explain mechanism',
              description: 'Explain it.',
              truthPremiseStatus: 'unverified',
              truthAuthorityRecordIds: [],
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: T0,
  };
  const groundingBlock = blocks.find((candidate) => candidate.id === 'block_a1');
  const concepts: Concept[] = groundingBlock
    ? [
        {
          id: 'concept_1',
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          name: 'Mechanism',
          summary: 'A mechanism.',
          importance: 'high',
          createdAt: T0,
          grounding: {
            blockId: groundingBlock.id,
            quote: 'exact evidence',
            startOffset: 7,
            endOffset: 21,
            occurrenceCount: 1,
            reanchored: false,
          },
        },
      ]
    : [];
  return { workspaceId: 'ws_1', curriculum, learningUnitId: 'unit_1', materials, blocks, concepts };
}

describe('Teaching Brief source context', () => {
  it('prioritizes mapped evidence, retains Concept grounding and supports multiple Materials', () => {
    const context = buildTeachingBriefSourceContext(fixture());
    expect(context.references.slice(0, 2).map((reference) => reference.sourceBlockId)).toEqual([
      'block_a1',
      'block_b1',
    ]);
    expect(context.references[0]!.quote).toContain('Mapped exact evidence');
    expect(context.materialCount).toBe(2);
    expect(context.references.map((reference) => reference.sourceBlockId)).toContain('block_a0');
  });

  it('is deterministic and enforces exact block and byte budgets independently of corpus size', () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      block({
        id: `block_${index}`,
        materialId: index % 2 === 0 ? 'material_a' : 'material_b',
        revisionId: index % 2 === 0 ? 'revision_a' : 'revision_b',
        index: Math.floor(index / 2),
        content: `${index} ${'bounded source text '.repeat(90)}`,
      }),
    );
    const input = fixture(many);
    input.curriculum.nodes[1]!.sourceReferences = many.map((candidate) => ({
      materialId: candidate.materialId,
      materialRevisionId: candidate.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: candidate.id,
      sourceBlockRevisionFingerprint: candidate.revisionFingerprint,
    }));
    input.curriculum.nodes[1]!.learningUnit!.conceptIds = [];
    input.concepts = [];
    const first = buildTeachingBriefSourceContext(input);
    const second = buildTeachingBriefSourceContext(input);
    expect(second).toEqual(first);
    expect(first.blockCount).toBeLessThanOrEqual(TEACHING_BRIEF_MAX_BLOCKS);
    expect(first.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(first.offers), 'utf8'));
    expect(first.serializedBytes).toBeLessThanOrEqual(TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES);
  });

  it('rejects stale revisions and foreign Course ownership', () => {
    const stale = fixture();
    stale.materials[0] = { ...stale.materials[0]!, activeRevisionId: 'revision_new' };
    expect(() => buildTeachingBriefSourceContext(stale)).toThrow(/stale/);

    const foreign = fixture();
    foreign.materials[1] = { ...foreign.materials[1]!, workspaceId: 'ws_other' };
    expect(() => buildTeachingBriefSourceContext(foreign)).toThrow(/outside this Course/);
  });
});
