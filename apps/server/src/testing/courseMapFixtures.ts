import {
  fnv1a32,
  type Concept,
  type CourseMapProposalPayload,
  type SourceBlock,
} from '@hy3-clinic/shared';
import type {
  CourseMapProposalInput,
  CurriculumContractContext,
  CurriculumEvidenceOffer,
} from '../llm/provider.js';
import {
  analyzeCourseMapProposal,
  buildCourseMapProposalInput,
  buildCourseMapSourceAllocation,
} from '../services/courseMap.js';
import { buildCourseSourceMap, type CourseSourceMap } from '../services/courseSourceMap.js';
import { curriculumSourceBlockFingerprint } from '../services/curriculumValidation.js';

export interface CourseMapFixture {
  workspaceId: string;
  blocks: SourceBlock[];
  concepts: Concept[];
  canonicalConcepts: CurriculumCanonicalConceptOffer[];
  sourceMap: CourseSourceMap;
  evidenceCatalog: CurriculumEvidenceOffer[];
  sourceAllocation: ReturnType<typeof buildCourseMapSourceAllocation>;
  providerInput: CourseMapProposalInput;
  good: CourseMapProposalPayload;
  flat: CourseMapProposalPayload;
  cycle: CourseMapProposalPayload;
  unknownSource: CourseMapProposalPayload;
  duplicateIntent: CourseMapProposalPayload;
  sparse: CourseMapProposalPayload;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createCourseMapFixture(): CourseMapFixture {
  const workspaceId = 'course_map_workspace';
  const materials = [
    { id: 'material_alpha', revisionId: 'revision_alpha', title: 'Alpha material' },
    { id: 'material_beta', revisionId: 'revision_beta', title: 'Beta material' },
  ];
  const blocks: SourceBlock[] = [];
  for (const [materialIndex, material] of materials.entries()) {
    let offset = 0;
    for (let blockIndex = 0; blockIndex < 6; blockIndex += 1) {
      const topicIndex = Math.floor(blockIndex / 2) + 1;
      const content = `${material.title} topic ${topicIndex} fragment ${blockIndex + 1} contains exact source content. ${'Stable fixture evidence for this instructional region. '
        .repeat(5)
        .trimEnd()}`;
      blocks.push({
        id: `block_${materialIndex + 1}_${blockIndex + 1}`,
        materialId: material.id,
        materialRevisionId: material.revisionId,
        index: blockIndex,
        heading: `Topic ${materialIndex + 1}.${topicIndex}`,
        headingPath: [material.title, `Topic ${materialIndex + 1}.${topicIndex}`],
        pageNumber: null,
        pageEnd: null,
        content,
        startOffset: offset,
        endOffset: offset + content.length,
      });
      offset += content.length + 1;
    }
  }
  const revisions = materials.map((material) => ({
    materialId: material.id,
    materialRevisionId: material.revisionId,
    parserVersion: 'course-map-fixture-parser',
    parserFingerprint: `parser_${material.id}`,
    sourceBlockRevisionIds: blocks
      .filter((block) => block.materialId === material.id)
      .map((block) => block.id),
  }));
  const manifest = {
    fingerprint: `manifest_${fnv1a32(JSON.stringify(revisions)).toString(16).padStart(8, '0')}`,
    revisions,
  };
  const concepts: Concept[] = materials.map((material, index) => {
    const block = blocks.find((candidate) => candidate.materialId === material.id)!;
    return {
      id: `concept_${index + 1}`,
      materialId: material.id,
      materialRevisionId: material.revisionId,
      name: `Concept ${index + 1}`,
      summary: `Grounded concept for ${material.title}.`,
      importance: 'high',
      grounding: {
        blockId: block.id,
        quote: block.content,
        startOffset: 0,
        endOffset: block.content.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  });
  const sourceMap = buildCourseSourceMap({
    workspaceId,
    manifest,
    materials: materials.map((material) => ({
      materialId: material.id,
      workspaceId,
      title: material.title,
      availability: 'active' as const,
      activeRevisionId: material.revisionId,
      revision: {
        id: material.revisionId,
        materialId: material.id,
        status: 'active' as const,
        parserVersion: 'course-map-fixture-parser',
        parserFingerprint: `parser_${material.id}`,
      },
      blocks: blocks
        .filter((block) => block.materialId === material.id)
        .map((block) => ({
          ...block,
          materialRevisionId: material.revisionId,
          structuralUnitId: null,
          revisionFingerprint: curriculumSourceBlockFingerprint(block, material.revisionId),
        })),
    })),
    concepts,
    predecessor: null,
  });
  const evidenceCatalog: CurriculumEvidenceOffer[] = blocks.map((block, index) => {
    const quote = block.content.slice(0, 300);
    return {
      id: `E${index + 1}`,
      bindingId: `course_map_fixture_binding_${index + 1}`,
      materialId: block.materialId,
      materialRevisionId: block.materialRevisionId!,
      blockId: block.id,
      startOffset: 0,
      endOffset: quote.length,
      quote,
      headingPath: block.headingPath,
      pageNumber: block.pageNumber,
    };
  });
  const sourceAllocation = buildCourseMapSourceAllocation({
    workspaceId,
    sourceMap,
    blocks,
    evidenceCatalog,
    maxRegions: 6,
    maxEvidenceOffers: 6,
    maxEvidenceOffersPerRegion: 1,
  });
  const contract: CurriculumContractContext = {
    contractVersionId: 'contract_course_map_fixture',
    intent: 'Build a coherent course from both materials.',
    targetOutcome: { description: 'Connect all six topics.', targetScore: null },
    desiredDepth: 'working_fluency',
    subjectBoundaries: [],
    materials: materials.map((material, index) => ({
      materialId: material.id,
      title: material.title,
      materialRoleAssignmentId: `role_${index + 1}`,
      materialRoleAssignmentVersion: 1,
      role: 'course_material',
      disposition: 'included',
    })),
    includedTopics: [],
    excludedTopics: [],
  };
  const canonicalConcepts: CurriculumCanonicalConceptOffer[] = [
    {
      id: 'canonical_alpha',
      displayName: 'Canonical alpha',
      sourceConceptIds: ['concept_1'],
    },
  ];
  const providerInput = buildCourseMapProposalInput({
    workspaceName: 'Course Map fixture',
    contract,
    sourceAllocation,
    concepts,
    canonicalConcepts,
  });
  const region = (index: number) => ({
    sourceRegionRef: `R${index + 1}`,
    title: `Instructional region ${index + 1}`,
    learningIntent: `Understand and apply the distinct ideas in source region ${index + 1}.`,
    approximateScope: 'standard' as const,
    anchorOptionRefs: providerInput.sourceRegions[index]!.anchorOptions.map(
      (option) => option.anchorOptionId,
    ),
  });
  const good: CourseMapProposalPayload = {
    modules: [
      {
        title: 'Foundations',
        learningIntent: 'Build the first material into a connected foundation.',
        regions: [region(0), region(1), region(2)],
      },
      {
        title: 'Applications',
        learningIntent: 'Use the second material to extend and apply the foundation.',
        regions: [region(3), region(4), region(5)],
      },
    ],
    prerequisites: Array.from({ length: 5 }, (_, index) => ({
      prerequisiteRegionRef: `R${index + 1}`,
      dependentRegionRef: `R${index + 2}`,
    })),
    synthesisGroups: [
      {
        title: 'Synthesize foundations',
        level: 'module',
        regionRefs: ['R1', 'R2', 'R3'],
      },
      {
        title: 'Synthesize applications',
        level: 'module',
        regionRefs: ['R4', 'R5', 'R6'],
      },
      {
        title: 'Connect both modules',
        level: 'course',
        regionRefs: ['R3', 'R6'],
      },
    ],
  };
  const flat = clone(good);
  flat.modules = [
    {
      title: 'Flat outline',
      learningIntent: 'Keep every topic at one undifferentiated hierarchy level.',
      regions: Array.from({ length: 6 }, (_, index) => region(index)),
    },
  ];
  flat.synthesisGroups = [];
  const cycle = clone(good);
  cycle.prerequisites.push({
    prerequisiteRegionRef: 'R6',
    dependentRegionRef: 'R1',
  });
  const unknownSource = clone(good);
  unknownSource.modules[0]!.regions[0]!.sourceRegionRef = 'R999';
  unknownSource.modules[0]!.regions[0]!.anchorOptionRefs = [];
  const duplicateIntent = clone(good);
  duplicateIntent.modules[0]!.regions[1]!.learningIntent =
    duplicateIntent.modules[0]!.regions[0]!.learningIntent;
  const sparse = clone(good);
  sparse.modules = sparse.modules.map((module) => ({ ...module, regions: [module.regions[0]!] }));
  sparse.prerequisites = [];
  sparse.synthesisGroups = [];

  const valid = analyzeCourseMapProposal(good, { sourceAllocation, providerInput });
  if (!valid.validation.valid) throw new Error('Course Map fixture is invalid.');
  return {
    workspaceId,
    blocks,
    concepts,
    canonicalConcepts,
    sourceMap,
    evidenceCatalog,
    sourceAllocation,
    providerInput,
    good,
    flat,
    cycle,
    unknownSource,
    duplicateIntent,
    sparse,
  };
}
