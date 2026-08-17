import { describe, expect, it } from 'vitest';
import type { Curriculum, CurriculumNode, LearningContract, SourceBlock } from '@hy3-clinic/shared';
import {
  evaluateCurriculumQuality,
  type CurriculumQualityEvaluationInput,
} from './curriculumQuality.js';
import { curriculumSourceBlockFingerprint } from '../services/curriculumValidation.js';

const NOW = '2026-08-17T00:00:00.000Z';

function block(
  id: string,
  materialId: string,
  materialRevisionId: string,
  index: number,
  heading: string,
  content: string,
): SourceBlock {
  return {
    id,
    materialId,
    materialRevisionId,
    index,
    heading,
    headingPath: [heading],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

function objective(id: string, title: string, description = title) {
  return {
    id,
    title,
    description,
    truthPremiseStatus: 'unverified' as const,
    truthAuthorityRecordIds: [],
  };
}

function sourceReference(source: SourceBlock) {
  return {
    materialId: source.materialId,
    materialRevisionId: source.materialRevisionId,
    structuralUnitId: null,
    sourceBlockId: source.id,
    sourceBlockRevisionFingerprint: curriculumSourceBlockFingerprint(
      source,
      source.materialRevisionId,
    ),
  };
}

function unit(input: {
  id: string;
  parentId: string;
  index: number;
  title: string;
  refs?: ReturnType<typeof sourceReference>[];
  objectives?: ReturnType<typeof objective>[];
  prerequisites?: string[];
  concepts?: string[];
  canonicals?: string[];
}): CurriculumNode {
  return {
    id: input.id,
    parentId: input.parentId,
    kind: 'learning_unit',
    index: input.index,
    title: input.title,
    sourceReferences: input.refs ?? [],
    learningUnit: {
      conceptIds: input.concepts ?? [],
      canonicalConceptIds: input.canonicals ?? [],
      objectives: input.objectives ?? [objective(`obj_${input.id}`, `Explain ${input.title}`)],
      prerequisiteUnitIds: input.prerequisites ?? [],
      graphRelationIds: [],
      riskIds: [],
    },
  };
}

function contract(materialIds: string[]): LearningContract {
  return {
    id: 'contract_1',
    workspaceId: 'course_1',
    version: 1,
    predecessorId: null,
    intent: 'Understand retrieval and evidence coverage',
    targetOutcome: {
      description: 'Explain retrieval evaluation and prerequisite design',
      targetScore: 90,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Retrieval evaluation'],
      materials: materialIds.map((materialId, index) => ({
        materialId,
        materialRoleAssignmentId: `role_${index + 1}`,
        materialRoleAssignmentVersion: 1,
        role: 'course_material',
        disposition: 'included',
      })),
      includedTopics: ['Evidence coverage'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: null,
    status: 'learner_confirmed',
    proposedBy: 'learner',
    learnerConfirmedAt: NOW,
    createdAt: NOW,
  };
}

function baseInput(): CurriculumQualityEvaluationInput {
  const repeated = (text: string) => `${text} `.repeat(90);
  const blocks = [
    block('block_a1', 'material_a', 'revision_a', 0, 'Retrieval', repeated('retrieval evidence')),
    block('block_a2', 'material_a', 'revision_a', 1, 'Coverage', repeated('source coverage')),
    block(
      'block_b1',
      'material_b',
      'revision_b',
      0,
      'Prerequisites',
      repeated('prerequisite design'),
    ),
  ];
  const nodes: CurriculumNode[] = [
    {
      id: 'course_root',
      parentId: null,
      kind: 'course',
      index: 0,
      title: 'Retrieval Evaluation',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'chapter_a',
      parentId: 'course_root',
      kind: 'chapter',
      index: 0,
      title: 'Retrieval',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'section_a',
      parentId: 'chapter_a',
      kind: 'section',
      index: 0,
      title: 'Evidence',
      sourceReferences: [],
      learningUnit: null,
    },
    unit({
      id: 'unit_a1',
      parentId: 'section_a',
      index: 0,
      title: 'Retrieval evaluation',
      refs: [sourceReference(blocks[0]!)],
      objectives: [objective('objective_a1', 'Explain retrieval evaluation')],
      concepts: ['concept_a'],
      canonicals: ['canonical_a'],
    }),
    unit({
      id: 'unit_a2',
      parentId: 'section_a',
      index: 1,
      title: 'Evidence coverage',
      refs: [sourceReference(blocks[1]!), sourceReference(blocks[2]!)],
      objectives: [
        objective('objective_a2', 'Compare source coverage'),
        objective('objective_a2_duplicate', '  COMPARE-source coverage  '),
      ],
      prerequisites: ['unit_a1'],
    }),
    {
      id: 'chapter_b',
      parentId: 'course_root',
      kind: 'chapter',
      index: 1,
      title: 'Course Design',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'section_b',
      parentId: 'chapter_b',
      kind: 'section',
      index: 0,
      title: 'Prerequisites',
      sourceReferences: [],
      learningUnit: null,
    },
    unit({
      id: 'unit_b1',
      parentId: 'section_b',
      index: 0,
      title: 'Prerequisite design',
      refs: [sourceReference(blocks[2]!)],
      objectives: [objective('objective_b1', 'Design useful prerequisites')],
    }),
  ];
  const curriculum: Curriculum = {
    id: 'curriculum_1',
    workspaceId: 'course_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'manifest_1',
      revisions: [
        {
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          parserVersion: 'parser-1',
          parserFingerprint: 'parser-a',
          sourceBlockRevisionIds: ['block_a1', 'block_a2'],
        },
        {
          materialId: 'material_b',
          materialRevisionId: 'revision_b',
          parserVersion: 'parser-1',
          parserFingerprint: 'parser-b',
          sourceBlockRevisionIds: ['block_b1'],
        },
      ],
    },
    nodes,
    synthesisGroups: [
      {
        id: 'synthesis_1',
        title: 'Integrate retrieval and coverage',
        level: 'course',
        learningUnitIds: ['unit_a1', 'unit_a2'],
        objectiveIds: ['objective_a1', 'objective_a2'],
      },
    ],
    validation: {
      valid: true,
      errors: [],
      warnings: [],
      unmappedStructuralUnitIds: [],
    },
    provider: 'fake',
    providerModel: null,
    createdAt: NOW,
    acceptedAt: null,
  };
  return {
    workspaceId: 'course_1',
    contract: contract(['material_a', 'material_b']),
    curriculum,
    sourceCorpus: [
      {
        materialId: 'material_a',
        materialRevisionId: 'revision_a',
        title: 'Retrieval Notes',
        blocks: blocks.slice(0, 2),
      },
      {
        materialId: 'material_b',
        materialRevisionId: 'revision_b',
        title: 'Course Design Notes',
        blocks: blocks.slice(2),
      },
    ],
    bindingAuthority: {
      concepts: [
        {
          id: 'concept_a',
          materialId: 'material_a',
          materialRevisionId: 'revision_a',
          name: 'Retrieval evaluation',
          summary: 'Evaluate retrieval evidence.',
          importance: 'high',
          grounding: {
            blockId: 'block_a1',
            quote: 'retrieval evidence',
            startOffset: 0,
            endOffset: 'retrieval evidence'.length,
            occurrenceCount: 90,
            reanchored: false,
          },
          createdAt: NOW,
        },
      ],
      canonicalConcepts: [
        {
          id: 'canonical_a',
          workspaceId: 'course_1',
          displayName: 'Retrieval evaluation',
          normalizedKey: 'retrieval evaluation',
          description: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      canonicalMemberships: [
        {
          sourceConceptId: 'concept_a',
          canonicalConceptId: 'canonical_a',
          originalName: 'Retrieval evaluation',
          materialId: 'material_a',
          language: 'en',
          viaProposalId: null,
          createdAt: NOW,
        },
      ],
    },
    execution: [
      {
        learningUnitId: 'unit_a1',
        executable: true,
        frontierEligible: true,
        reasonCodes: ['concept_practice'],
      },
      {
        learningUnitId: 'unit_a2',
        executable: false,
        frontierEligible: false,
        reasonCodes: ['missing_binding'],
      },
      {
        learningUnitId: 'unit_b1',
        executable: true,
        frontierEligible: true,
        reasonCodes: ['source_assessment'],
      },
    ],
  };
}

function minimalInput(): CurriculumQualityEvaluationInput {
  const source = block('block_1', 'material_1', 'revision_1', 0, 'Only', 'Only source block.');
  return {
    workspaceId: 'course_1',
    contract: contract(['material_1']),
    curriculum: {
      id: 'curriculum_minimal',
      workspaceId: 'course_1',
      contractVersionId: 'contract_1',
      version: 1,
      predecessorId: null,
      status: 'proposed',
      executionSourceManifest: {
        fingerprint: 'manifest_minimal',
        revisions: [
          {
            materialId: 'material_1',
            materialRevisionId: 'revision_1',
            parserVersion: null,
            parserFingerprint: null,
            sourceBlockRevisionIds: ['block_1'],
          },
        ],
      },
      nodes: [
        {
          id: 'root',
          parentId: null,
          kind: 'course',
          index: 0,
          title: 'Minimal',
          sourceReferences: [],
          learningUnit: null,
        },
      ],
      synthesisGroups: [],
      validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
      provider: 'historical',
      providerModel: null,
      createdAt: NOW,
      acceptedAt: null,
    },
    sourceCorpus: [
      {
        materialId: 'material_1',
        materialRevisionId: 'revision_1',
        title: 'Minimal Source',
        blocks: [source],
      },
    ],
    bindingAuthority: { concepts: [], canonicalConcepts: [], canonicalMemberships: [] },
  };
}

describe('Curriculum quality evaluation', () => {
  it('is deterministic and honestly handles a root-only Curriculum', () => {
    const input = minimalInput();
    const first = evaluateCurriculumQuality(input);
    const second = evaluateCurriculumQuality(structuredClone(input));

    expect(second).toEqual(first);
    expect(first.hierarchy.nodeCountsByKind.learningUnit).toBe(0);
    expect(first.sourceCoverage).toMatchObject({
      eligibleBlockCount: 1,
      mappedBlockCount: 0,
      unmappedBlockCount: 1,
      mappedBlockRatio: 0,
    });
    expect(first.granularity.objectivesPerLearningUnit).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
    });
    expect(first.execution.status).toBe('unavailable');
  });

  it('profiles multi-module structure, coverage, diversity, prerequisites, and bindings', () => {
    const profile = evaluateCurriculumQuality(baseInput());

    expect(profile.hierarchy).toMatchObject({
      nodeCountsByKind: { course: 1, chapter: 2, section: 2, learningUnit: 3 },
      maxDepth: 3,
      moduleCount: 2,
      learningUnitsWithoutModuleCount: 0,
      learningUnitsPerModule: { count: 2, min: 1, max: 2, mean: 1.5, median: 1.5 },
    });
    expect(profile.sourceCoverage).toMatchObject({
      eligibleBlockCount: 3,
      mappedBlockCount: 3,
      unmappedBlockCount: 0,
      materialCount: 2,
      mappedMaterialCount: 2,
      sectionCount: 3,
      mappedSectionCount: 3,
    });
    expect(profile.prerequisites).toMatchObject({
      edgeCount: 1,
      learningUnitsWithPrerequisites: 1,
      rootLearningUnitCount: 2,
      isolatedLearningUnitCount: 1,
      invalidReferenceCount: 0,
      cycleDetected: false,
      forwardOrderedEdgeCount: 1,
    });
    expect(profile.redundancy.exactDuplicateGroups).toEqual([
      {
        normalizedText: 'comparesourcecoveragecomparesourcecoverage',
        objectiveIds: ['objective_a2', 'objective_a2_duplicate'],
      },
    ]);
    expect(profile.synthesis).toMatchObject({ groupCount: 1, targetLearningUnitCount: 2 });
    expect(profile.bindings).toMatchObject({
      learningUnitCount: 3,
      sourceMappedLearningUnitCount: 3,
      conceptBoundLearningUnitCount: 1,
      canonicalBoundLearningUnitCount: 1,
    });
    expect(profile.evidenceDiversity).toMatchObject({
      uniqueSourceBlockCount: 3,
      multiMaterialLearningUnitCount: 1,
      multiSectionLearningUnitCount: 1,
    });
    expect(profile.execution).toMatchObject({
      status: 'measured',
      executableLearningUnitCount: 2,
      nonExecutableLearningUnitCount: 1,
      executableRatio: 0.666667,
      executableFrontierCount: 2,
    });
  });

  it('counts invalid and duplicate synthesis references without inflating valid targets', () => {
    const input = baseInput();
    input.curriculum.synthesisGroups[0]!.learningUnitIds = ['unit_a1', 'missing_unit', 'unit_a1'];
    input.curriculum.synthesisGroups[0]!.objectiveIds = [
      'objective_a1',
      'missing_objective',
      'objective_a1',
    ];

    expect(evaluateCurriculumQuality(input).synthesis).toMatchObject({
      targetLearningUnitCount: 1,
      invalidLearningUnitReferenceCount: 1,
      duplicateLearningUnitReferenceCount: 1,
      invalidObjectiveReferenceCount: 1,
      duplicateObjectiveReferenceCount: 1,
    });
  });

  it('counts invalid hierarchy parents by node rather than failed descendant traversal', () => {
    const input = baseInput();
    input.curriculum.nodes.find((node) => node.id === 'chapter_a')!.parentId = 'missing_parent';

    expect(evaluateCurriculumQuality(input).hierarchy).toMatchObject({
      invalidParentCount: 1,
      cycleDetected: false,
    });
  });

  it('detects prerequisite cycles and invalid references without unsafe traversal', () => {
    const input = baseInput();
    const unitA1 = input.curriculum.nodes.find((node) => node.id === 'unit_a1')!;
    const unitB1 = input.curriculum.nodes.find((node) => node.id === 'unit_b1')!;
    unitA1.learningUnit!.prerequisiteUnitIds = ['unit_a2'];
    unitB1.learningUnit!.prerequisiteUnitIds = ['missing_unit', 'unit_b1', 'missing_unit'];

    const profile = evaluateCurriculumQuality(input);
    expect(profile.prerequisites).toMatchObject({
      cycleDetected: true,
      invalidReferenceCount: 1,
      selfReferenceCount: 1,
      duplicateReferenceCount: 1,
    });
  });

  it('reports lexical matching as a heuristic rather than a quality score', () => {
    const profile = evaluateCurriculumQuality(baseInput());
    expect(profile.learnerGoalCoverage.method).toBe('heuristic_lexical');
    expect(profile.learnerGoalCoverage.matchedStatementCount).toBeGreaterThan(0);
    expect(profile.methodology.modelJudgedDimensions).toContain(
      'prerequisite pedagogical meaningfulness',
    );
    expect(profile.methodology.nonclaims).toContain(
      'No composite pedagogical-quality score is calculated.',
    );
  });

  it('keeps capped near-duplicate comparisons stable when node order changes', () => {
    const input = minimalInput();
    function distinctTitle(seed: number): string {
      let state = seed + 1;
      let result = '';
      for (let index = 0; index < 20; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result += String.fromCharCode(97 + (state % 26));
      }
      return result;
    }
    const units = Array.from({ length: 24 }, (_, unitIndex) =>
      unit({
        id: `unit_${unitIndex.toString().padStart(2, '0')}`,
        parentId: 'root',
        index: unitIndex,
        title: `Unit ${unitIndex}`,
        objectives: Array.from({ length: 30 }, (_, objectiveIndex) => {
          const ordinal = unitIndex * 30 + objectiveIndex;
          return objective(
            `objective_${ordinal.toString().padStart(3, '0')}`,
            distinctTitle(ordinal),
          );
        }),
      }),
    );
    input.curriculum.nodes.push(...units);
    const reordered = structuredClone(input);
    reordered.curriculum.nodes = [
      reordered.curriculum.nodes[0]!,
      ...reordered.curriculum.nodes.slice(1).reverse(),
    ];

    const firstProfile = evaluateCurriculumQuality(input);
    const secondProfile = evaluateCurriculumQuality(reordered);

    expect(firstProfile.hierarchy.learningUnitsWithoutModuleCount).toBe(24);
    expect(firstProfile.redundancy.nearDuplicateComparisonTruncated).toBe(true);
    expect(secondProfile.redundancy).toEqual(firstProfile.redundancy);
  });

  it.each([
    {
      name: 'foreign Course',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.workspaceId = 'course_foreign';
      },
      message: 'requested Course',
    },
    {
      name: 'wrong Contract revision',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.curriculum.contractVersionId = 'contract_foreign';
      },
      message: 'Learning Contract revision',
    },
    {
      name: 'stale MaterialRevision',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.sourceCorpus[0]!.materialRevisionId = 'revision_stale';
        input.sourceCorpus[0]!.blocks.forEach((item) => {
          item.materialRevisionId = 'revision_stale';
        });
      },
      message: 'foreign or stale MaterialRevision',
    },
    {
      name: 'foreign SourceBlock',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.sourceCorpus[0]!.blocks[0]!.id = 'block_foreign';
      },
      message: 'exactly match the Curriculum manifest',
    },
    {
      name: 'stale SourceBlock fingerprint',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.curriculum.nodes.find(
          (node) => node.id === 'unit_a1',
        )!.sourceReferences[0]!.sourceBlockRevisionFingerprint = 'block_stale';
      },
      message: 'stale SourceBlock fingerprint',
    },
    {
      name: 'foreign Concept binding',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.curriculum.nodes.find((node) => node.id === 'unit_a1')!.learningUnit!.conceptIds = [
          'concept_foreign',
        ];
      },
      message: 'outside the supplied binding authority',
    },
    {
      name: 'stale Concept revision',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.bindingAuthority.concepts[0]!.materialRevisionId = 'revision_stale';
      },
      message: 'foreign or stale Concept',
    },
    {
      name: 'foreign canonical Concept',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.bindingAuthority.canonicalConcepts[0]!.workspaceId = 'course_foreign';
      },
      message: 'foreign canonical Concept',
    },
    {
      name: 'canonical binding without an authoritative member',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.bindingAuthority.canonicalMemberships = [];
      },
      message: 'no authoritative member in its LearningUnit',
    },
    {
      name: 'foreign execution unit',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.execution![0]!.learningUnitId = 'unit_foreign';
      },
      message: 'exactly this Curriculum',
    },
    {
      name: 'non-executable frontier entry',
      mutate: (input: CurriculumQualityEvaluationInput) => {
        input.execution![1]!.frontierEligible = true;
      },
      message: 'frontier eligibility requires executable capability',
    },
  ])('rejects $name data before calculating metrics', ({ mutate, message }) => {
    const input = baseInput();
    mutate(input);
    expect(() => evaluateCurriculumQuality(input)).toThrow(message);
  });
});
