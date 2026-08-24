import { describe, expect, it } from 'vitest';
import type {
  Concept,
  Curriculum,
  CurriculumProposalPayload,
  SourceAuthorityBundle,
  SourceBlock,
} from '@hy3-clinic/shared';
import {
  materializeCurriculumProposal,
  normalizeDuplicateLearningUnitTitles,
} from './curriculumValidation.js';

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

describe('Curriculum objective authority materialization', () => {
  it('aligns Formal semantic authority exactly while preserving non-Formal teaching authority', () => {
    const selectedFormalQuote = 'A bounded source statement identifies working memory.';
    const convenientUnselectedQuote =
      'The same block also explains an integrated document, search, LLM, permission, and tool system.';
    const formalBlock = block('block_1', `${selectedFormalQuote} ${convenientUnselectedQuote}`);
    const teachingBlock = block(
      'block_2',
      'A second exact statement remains teaching-only under the current authority policy.',
    );
    const excludedBlock = block(
      'block_3',
      'An ineligible exact statement must not widen the retained authority envelope.',
    );
    const authorityBundle = (id: string, source: SourceBlock): SourceAuthorityBundle => ({
      record: {
        id,
        workspaceId: 'workspace_1',
        logicalSourceId: `logical_${id}`,
        materialId: source.materialId,
        materialRevisionId: source.materialRevisionId!,
        version: 1,
        predecessorId: null,
        premiseScope: 'Exact source statement',
        policyBasis: {
          policyVersion: 'local-verbatim-source-v1',
          premiseKind: 'claim',
          basis: 'Exact source occurrence only; semantic support is evaluated separately.',
        },
        validationState: 'validated',
        conflictState: 'none',
        actor: 'local_validator',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      claims: [
        {
          id: `claim_${id}`,
          authorityRecordId: id,
          sourceBlockId: source.id,
          claim: source.content,
          quote: source.content,
          startOffset: 0,
          endOffset: source.content.length,
          occurrenceCount: 1,
          createdAt: '2026-08-24T00:00:00.000Z',
        },
      ],
      events: [],
    });
    const evidenceCatalog = [formalBlock, teachingBlock, excludedBlock].map((source, index) => {
      const quote = source === formalBlock ? selectedFormalQuote : source.content;
      return {
        id: `evidence_${index + 1}`,
        materialId: source.materialId,
        materialRevisionId: source.materialRevisionId!,
        blockId: source.id,
        startOffset: 0,
        endOffset: quote.length,
        quote,
        headingPath: source.headingPath,
        pageNumber: source.pageNumber,
      };
    });
    const formalAuthority = authorityBundle('authority_formal', formalBlock);
    formalAuthority.claims = [
      {
        ...formalAuthority.claims[0]!,
        id: 'claim_authority_formal_selected',
        claim: selectedFormalQuote,
        quote: selectedFormalQuote,
        endOffset: selectedFormalQuote.length,
      },
      {
        ...formalAuthority.claims[0]!,
        id: 'claim_authority_formal_unselected',
        claim: convenientUnselectedQuote,
        quote: convenientUnselectedQuote,
        startOffset: selectedFormalQuote.length + 1,
        endOffset: selectedFormalQuote.length + 1 + convenientUnselectedQuote.length,
      },
    ];
    const payload: CurriculumProposalPayload = {
      nodes: [
        {
          key: 'chapter',
          parentKey: null,
          kind: 'chapter',
          index: 0,
          title: 'Authority',
          structuralUnitIds: [],
          sourceEvidence: [],
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [],
          prerequisiteUnitKeys: [],
          graphRelationIds: [],
        },
        {
          key: 'section',
          parentKey: 'chapter',
          kind: 'section',
          index: 0,
          title: 'Exact envelopes',
          structuralUnitIds: [],
          sourceEvidence: [],
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [],
          prerequisiteUnitKeys: [],
          graphRelationIds: [],
        },
        {
          key: 'unit',
          parentKey: 'section',
          kind: 'learning_unit',
          index: 0,
          title: 'Working-memory authority',
          structuralUnitIds: [],
          sourceEvidence: evidenceCatalog.map((offer) => ({ evidenceId: offer.id })),
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              key: 'objective-formal',
              title: 'Identify working memory',
              description: 'Identify the exact source-supported working-memory statement.',
              construct: 'identify',
              priority: 'required',
              evidence: [{ evidenceId: evidenceCatalog[0]!.id }],
            },
            {
              key: 'objective-teaching',
              title: 'Explain the teaching-only statement',
              description: 'Explain only what the second exact teaching statement means.',
              construct: 'explain',
              priority: 'normal',
              evidence: [
                { evidenceId: evidenceCatalog[1]!.id },
                { evidenceId: evidenceCatalog[2]!.id },
              ],
            },
          ],
          prerequisiteUnitKeys: [],
          graphRelationIds: [],
        },
      ],
      synthesisGroups: [],
    };

    const materialized = materializeCurriculumProposal(payload, {
      workspaceId: 'workspace_1',
      courseTitle: 'Authority course',
      executionSourceManifest: {
        fingerprint: 'manifest_1',
        revisions: [
          {
            materialId: 'material_1',
            materialRevisionId: 'revision_1',
            parserVersion: null,
            parserFingerprint: null,
            sourceBlockRevisionIds: [formalBlock.id, teachingBlock.id, excludedBlock.id],
          },
        ],
      },
      blocks: [formalBlock, teachingBlock, excludedBlock],
      concepts: [],
      graphEdges: [],
      structuralUnitOwners: new Map(),
      canonicalConceptIds: new Set(),
      canonicalConceptMembers: new Map(),
      canonicalConceptIdsBySourceConcept: new Map(),
      evidenceCatalog,
      limits: { maxNodes: 10, maxObjectives: 10, maxSynthesisGroups: 2 },
      authorityBundles: [
        formalAuthority,
        authorityBundle('authority_teaching', teachingBlock),
        authorityBundle('authority_excluded', excludedBlock),
      ],
      isAuthorityBlockingEligible: (authorityRecordId) =>
        authorityRecordId === 'authority_formal' || authorityRecordId === 'authority_teaching',
    });
    const objectives = materialized.nodes.find((node) => node.learningUnit)!.learningUnit!
      .objectives;

    expect(objectives[0]).toMatchObject({
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: ['authority_formal'],
      authorityClaimIds: ['claim_authority_formal_selected'],
      formalAssessmentReady: true,
      authoritySourceBlockIds: ['block_1'],
      formalEvidenceSourceBlockIds: ['block_1'],
    });
    expect(objectives[1]).toMatchObject({
      truthPremiseStatus: 'unverified',
      truthAuthorityRecordIds: ['authority_teaching'],
      authorityClaimIds: ['claim_authority_teaching'],
      authorityEnvelopeTier: 'narrower_formal',
      authoritySourceBlockIds: ['block_2'],
      formalEvidenceSourceBlockIds: [],
    });
    expect(JSON.stringify(objectives[0])).not.toContain('claim_authority_formal_unselected');
  });
});
