import {
  CanonicalConceptSchema,
  CanonicalMemberSchema,
  ConceptSchema,
  CurriculumSchema,
  LearningContractSchema,
  SourceBlockSchema,
  type Curriculum,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import { verifyGrounding } from '../grounding/verify.js';
import { computeSections } from '../ingestion/sections.js';
import { curriculumSourceBlockFingerprint } from '../services/curriculumValidation.js';

const EvaluationSourceMaterialSchema = z
  .object({
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    title: z.string().min(1).max(300),
    blocks: z.array(SourceBlockSchema).min(1).max(10_000),
  })
  .strict();

const LearningUnitExecutionSchema = z
  .object({
    learningUnitId: z.string().min(1),
    executable: z.boolean(),
    frontierEligible: z.boolean(),
    reasonCodes: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();

const EvaluationBindingAuthoritySchema = z
  .object({
    concepts: z.array(ConceptSchema).max(10_000),
    canonicalConcepts: z.array(CanonicalConceptSchema).max(10_000),
    canonicalMemberships: z.array(CanonicalMemberSchema).max(20_000),
  })
  .strict();

export const CurriculumQualityEvaluationInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    contract: LearningContractSchema,
    curriculum: CurriculumSchema,
    sourceCorpus: z.array(EvaluationSourceMaterialSchema).min(1).max(100),
    bindingAuthority: EvaluationBindingAuthoritySchema,
    execution: z.array(LearningUnitExecutionSchema).max(2_000).optional(),
  })
  .strict();
export type CurriculumQualityEvaluationInput = z.infer<
  typeof CurriculumQualityEvaluationInputSchema
>;

const DistributionSchema = z
  .object({
    count: z.number().int().nonnegative(),
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    mean: z.number().nonnegative().nullable(),
    median: z.number().nonnegative().nullable(),
  })
  .strict();

const RatioSchema = z.number().min(0).max(1).nullable();

export const CurriculumQualityProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifact: z
      .object({
        workspaceId: z.string(),
        contractId: z.string(),
        curriculumId: z.string(),
        curriculumVersion: z.number().int().positive(),
        manifestFingerprint: z.string(),
      })
      .strict(),
    methodology: z
      .object({
        deterministicDimensions: z.array(z.string()),
        heuristicDimensions: z.array(z.string()),
        modelJudgedDimensions: z.array(z.string()),
        humanPreferenceDimensions: z.array(z.string()),
        nonclaims: z.array(z.string()),
      })
      .strict(),
    learnerGoalCoverage: z
      .object({
        method: z.literal('heuristic_lexical'),
        statementCount: z.number().int().nonnegative(),
        matchedStatementCount: z.number().int().nonnegative(),
        matchedRatio: RatioSchema,
        statements: z.array(
          z
            .object({
              kind: z.enum(['intent', 'target_outcome', 'subject_boundary', 'included_topic']),
              text: z.string(),
              lexicalFeatureCount: z.number().int().nonnegative(),
              matchedFeatureRatio: RatioSchema,
              matched: z.boolean(),
              matchingLearningUnitIds: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict(),
    sourceCoverage: z
      .object({
        method: z.literal('deterministic_identity'),
        eligibleBlockCount: z.number().int().nonnegative(),
        mappedBlockCount: z.number().int().nonnegative(),
        unmappedBlockCount: z.number().int().nonnegative(),
        mappedBlockRatio: RatioSchema,
        materialCount: z.number().int().nonnegative(),
        mappedMaterialCount: z.number().int().nonnegative(),
        materialDiversityRatio: RatioSchema,
        sectionCount: z.number().int().nonnegative(),
        mappedSectionCount: z.number().int().nonnegative(),
        sectionDiversityRatio: RatioSchema,
        byMaterial: z.array(
          z
            .object({
              materialId: z.string(),
              materialRevisionId: z.string(),
              title: z.string(),
              eligibleBlockCount: z.number().int().nonnegative(),
              mappedBlockCount: z.number().int().nonnegative(),
              mappedBlockRatio: RatioSchema,
              sectionCount: z.number().int().nonnegative(),
              mappedSectionCount: z.number().int().nonnegative(),
              sectionDiversityRatio: RatioSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    hierarchy: z
      .object({
        method: z.literal('deterministic_structure'),
        nodeCount: z.number().int().nonnegative(),
        nodeCountsByKind: z
          .object({
            course: z.number().int().nonnegative(),
            chapter: z.number().int().nonnegative(),
            section: z.number().int().nonnegative(),
            learningUnit: z.number().int().nonnegative(),
          })
          .strict(),
        rootCount: z.number().int().nonnegative(),
        invalidParentCount: z.number().int().nonnegative(),
        cycleDetected: z.boolean(),
        maxDepth: z.number().int().nonnegative().nullable(),
        moduleCount: z.number().int().nonnegative(),
        learningUnitsWithoutModuleCount: z.number().int().nonnegative(),
        learningUnitsPerModule: DistributionSchema,
      })
      .strict(),
    granularity: z
      .object({
        method: z.literal('deterministic_distribution'),
        objectivesPerLearningUnit: DistributionSchema,
        mappedBlocksPerLearningUnit: DistributionSchema,
        conceptsPerLearningUnit: DistributionSchema,
        canonicalConceptsPerLearningUnit: DistributionSchema,
      })
      .strict(),
    prerequisites: z
      .object({
        method: z.literal('deterministic_structure'),
        edgeCount: z.number().int().nonnegative(),
        edgesPerLearningUnit: z.number().nonnegative().nullable(),
        learningUnitsWithPrerequisites: z.number().int().nonnegative(),
        rootLearningUnitCount: z.number().int().nonnegative(),
        isolatedLearningUnitCount: z.number().int().nonnegative(),
        invalidReferenceCount: z.number().int().nonnegative(),
        selfReferenceCount: z.number().int().nonnegative(),
        duplicateReferenceCount: z.number().int().nonnegative(),
        cycleDetected: z.boolean(),
        forwardOrderedEdgeCount: z.number().int().nonnegative(),
        reverseOrderedEdgeCount: z.number().int().nonnegative(),
      })
      .strict(),
    redundancy: z
      .object({
        method: z.literal('deterministic_normalization_and_heuristic_similarity'),
        objectiveCount: z.number().int().nonnegative(),
        exactDuplicateGroups: z.array(
          z.object({ normalizedText: z.string(), objectiveIds: z.array(z.string()) }).strict(),
        ),
        nearDuplicatePairs: z.array(
          z
            .object({
              leftObjectiveId: z.string(),
              rightObjectiveId: z.string(),
              similarity: z.number().min(0).max(1),
            })
            .strict(),
        ),
        nearDuplicateComparisonTruncated: z.boolean(),
      })
      .strict(),
    synthesis: z
      .object({
        method: z.literal('deterministic_declared_structure'),
        groupCount: z.number().int().nonnegative(),
        targetLearningUnitCount: z.number().int().nonnegative(),
        invalidLearningUnitReferenceCount: z.number().int().nonnegative(),
        duplicateLearningUnitReferenceCount: z.number().int().nonnegative(),
        invalidObjectiveReferenceCount: z.number().int().nonnegative(),
        duplicateObjectiveReferenceCount: z.number().int().nonnegative(),
        levelCounts: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    bindings: z
      .object({
        method: z.literal('deterministic_identity'),
        learningUnitCount: z.number().int().nonnegative(),
        sourceMappedLearningUnitCount: z.number().int().nonnegative(),
        conceptBoundLearningUnitCount: z.number().int().nonnegative(),
        canonicalBoundLearningUnitCount: z.number().int().nonnegative(),
        sourceMappedRatio: RatioSchema,
        conceptBoundRatio: RatioSchema,
        canonicalBoundRatio: RatioSchema,
      })
      .strict(),
    evidenceDiversity: z
      .object({
        method: z.literal('deterministic_identity'),
        sourceReferenceCount: z.number().int().nonnegative(),
        uniqueSourceBlockCount: z.number().int().nonnegative(),
        multiMaterialLearningUnitCount: z.number().int().nonnegative(),
        multiSectionLearningUnitCount: z.number().int().nonnegative(),
        materialsPerLearningUnit: DistributionSchema,
        sectionsPerLearningUnit: DistributionSchema,
      })
      .strict(),
    execution: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('unavailable'),
          method: z.literal('not_measured'),
          executableLearningUnitCount: z.null(),
          nonExecutableLearningUnitCount: z.null(),
          executableRatio: z.null(),
          executableFrontierCount: z.null(),
        })
        .strict(),
      z
        .object({
          status: z.literal('measured'),
          method: z.literal('deterministic_supplied_capability'),
          executableLearningUnitCount: z.number().int().nonnegative(),
          nonExecutableLearningUnitCount: z.number().int().nonnegative(),
          executableRatio: RatioSchema,
          executableFrontierCount: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();
export type CurriculumQualityProfile = z.infer<typeof CurriculumQualityProfileSchema>;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function distribution(values: number[]): z.infer<typeof DistributionSchema> {
  if (values.length === 0) return { count: 0, min: null, max: null, mean: null, median: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(6)),
    median: Number(median.toFixed(6)),
  };
}

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function lexicalFeatures(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const features = new Set<string>();
  for (const token of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (token.length >= 2) features.add(token);
  }
  const han = [...normalized.matchAll(/\p{Script=Han}+/gu)].flatMap((match) => [...match[0]]);
  if (han.length === 1) features.add(han[0]!);
  for (let index = 0; index + 1 < han.length; index += 1) {
    features.add(`${han[index]}${han[index + 1]}`);
  }
  return features;
}

function featureMatchRatio(needle: Set<string>, haystack: Set<string>): number | null {
  if (needle.size === 0) return null;
  let found = 0;
  for (const feature of needle) if (haystack.has(feature)) found += 1;
  return ratio(found, needle.size);
}

function charBigrams(value: string): Set<string> {
  const normalized = normalizedText(value);
  const result = new Set<string>();
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function validateOwnership(input: CurriculumQualityEvaluationInput): void {
  const { workspaceId, contract, curriculum, sourceCorpus, bindingAuthority } = input;
  if (contract.workspaceId !== workspaceId || curriculum.workspaceId !== workspaceId) {
    throw new Error('Evaluation artifacts must belong to the requested Course.');
  }
  if (curriculum.contractVersionId !== contract.id) {
    throw new Error('Curriculum does not belong to the supplied Learning Contract revision.');
  }

  const includedMaterialIds = contract.courseScope.materials
    .filter((scope) => scope.disposition === 'included')
    .map((scope) => scope.materialId);
  assertUnique(includedMaterialIds, 'Included Contract Material IDs');
  const manifestRevisions = curriculum.executionSourceManifest.revisions;
  assertUnique(
    manifestRevisions.map((revision) => revision.materialId),
    'Manifest Material IDs',
  );
  assertUnique(
    manifestRevisions.map((revision) => revision.materialRevisionId),
    'Manifest MaterialRevision IDs',
  );
  const manifestMaterialIds = new Set(manifestRevisions.map((revision) => revision.materialId));
  if (
    includedMaterialIds.length !== manifestMaterialIds.size ||
    includedMaterialIds.some((materialId) => !manifestMaterialIds.has(materialId))
  ) {
    throw new Error('Evaluation manifest does not exactly match included Contract Materials.');
  }

  assertUnique(
    sourceCorpus.map((material) => material.materialId),
    'Evaluation source Material IDs',
  );
  assertUnique(
    sourceCorpus.map((material) => material.materialRevisionId),
    'Evaluation source MaterialRevision IDs',
  );
  if (sourceCorpus.length !== manifestRevisions.length) {
    throw new Error('Evaluation source corpus must exactly match the Curriculum manifest.');
  }

  const manifestByMaterial = new Map(
    manifestRevisions.map((revision) => [revision.materialId, revision]),
  );
  const allBlockIds: string[] = [];
  for (const material of sourceCorpus) {
    const revision = manifestByMaterial.get(material.materialId);
    if (!revision || revision.materialRevisionId !== material.materialRevisionId) {
      throw new Error('Evaluation source corpus contains a foreign or stale MaterialRevision.');
    }
    const expectedBlockIds = new Set(revision.sourceBlockRevisionIds);
    assertUnique(revision.sourceBlockRevisionIds, 'Manifest SourceBlock IDs');
    assertUnique(
      material.blocks.map((block) => block.id),
      'Material SourceBlock IDs',
    );
    if (
      material.blocks.length !== expectedBlockIds.size ||
      material.blocks.some((block) => !expectedBlockIds.has(block.id))
    ) {
      throw new Error('Evaluation SourceBlocks do not exactly match the Curriculum manifest.');
    }
    for (const block of material.blocks) {
      allBlockIds.push(block.id);
      if (
        block.materialId !== material.materialId ||
        block.materialRevisionId !== material.materialRevisionId
      ) {
        throw new Error('Evaluation SourceBlock has a foreign Material or revision owner.');
      }
    }
  }
  assertUnique(allBlockIds, 'Evaluation SourceBlock IDs');

  const blockById = new Map(
    sourceCorpus.flatMap((material) => material.blocks.map((block) => [block.id, block] as const)),
  );
  for (const node of curriculum.nodes) {
    for (const reference of node.sourceReferences) {
      const revision = manifestByMaterial.get(reference.materialId);
      if (!revision || revision.materialRevisionId !== reference.materialRevisionId) {
        throw new Error('Curriculum source reference is foreign to the evaluation manifest.');
      }
      if (reference.sourceBlockId) {
        const block = blockById.get(reference.sourceBlockId);
        if (
          !block ||
          block.materialId !== reference.materialId ||
          block.materialRevisionId !== reference.materialRevisionId
        ) {
          throw new Error('Curriculum source reference has a foreign SourceBlock owner.');
        }
        if (
          reference.sourceBlockRevisionFingerprint !==
          curriculumSourceBlockFingerprint(block, reference.materialRevisionId)
        ) {
          throw new Error('Curriculum source reference has a stale SourceBlock fingerprint.');
        }
      } else if (reference.sourceBlockRevisionFingerprint !== null) {
        throw new Error(
          'Structural Curriculum source references cannot carry a block fingerprint.',
        );
      }
    }
  }

  assertUnique(
    bindingAuthority.concepts.map((concept) => concept.id),
    'Evaluation Concept IDs',
  );
  assertUnique(
    bindingAuthority.canonicalConcepts.map((concept) => concept.id),
    'Evaluation canonical Concept IDs',
  );
  assertUnique(
    bindingAuthority.canonicalMemberships.map((member) => member.sourceConceptId),
    'Evaluation canonical membership source Concept IDs',
  );
  for (const concept of bindingAuthority.concepts) {
    const revision = manifestByMaterial.get(concept.materialId);
    if (!revision || concept.materialRevisionId !== revision.materialRevisionId) {
      throw new Error('Evaluation binding authority contains a foreign or stale Concept.');
    }
    const block = blockById.get(concept.grounding.blockId);
    const verified = block ? verifyGrounding([block], concept.grounding) : null;
    if (
      !block ||
      block.materialId !== concept.materialId ||
      block.materialRevisionId !== concept.materialRevisionId ||
      !verified?.ok ||
      verified.grounding.blockId !== block.id ||
      verified.grounding.quote !== concept.grounding.quote ||
      verified.grounding.startOffset !== concept.grounding.startOffset ||
      verified.grounding.endOffset !== concept.grounding.endOffset ||
      verified.grounding.occurrenceCount !== concept.grounding.occurrenceCount
    ) {
      throw new Error('Evaluation binding authority contains an invalid grounded Concept.');
    }
  }
  for (const canonical of bindingAuthority.canonicalConcepts) {
    if (canonical.workspaceId !== workspaceId) {
      throw new Error('Evaluation binding authority contains a foreign canonical Concept.');
    }
  }
  const conceptIds = new Set(bindingAuthority.concepts.map((concept) => concept.id));
  const canonicalIds = new Set(bindingAuthority.canonicalConcepts.map((concept) => concept.id));
  for (const member of bindingAuthority.canonicalMemberships) {
    const concept = bindingAuthority.concepts.find(
      (candidate) => candidate.id === member.sourceConceptId,
    );
    if (
      !concept ||
      !canonicalIds.has(member.canonicalConceptId) ||
      member.materialId !== concept.materialId
    ) {
      throw new Error('Evaluation binding authority contains a foreign canonical membership.');
    }
  }
  const canonicalMembers = new Map<string, Set<string>>();
  for (const member of bindingAuthority.canonicalMemberships) {
    const members = canonicalMembers.get(member.canonicalConceptId) ?? new Set<string>();
    members.add(member.sourceConceptId);
    canonicalMembers.set(member.canonicalConceptId, members);
  }
  for (const node of curriculum.nodes) {
    const nodeConceptIds = node.learningUnit?.conceptIds ?? [];
    for (const conceptId of nodeConceptIds) {
      if (!conceptIds.has(conceptId)) {
        throw new Error('Curriculum references a Concept outside the supplied binding authority.');
      }
    }
    for (const canonicalId of node.learningUnit?.canonicalConceptIds ?? []) {
      if (!canonicalIds.has(canonicalId)) {
        throw new Error(
          'Curriculum references a canonical Concept outside the supplied binding authority.',
        );
      }
      if (!nodeConceptIds.some((conceptId) => canonicalMembers.get(canonicalId)?.has(conceptId))) {
        throw new Error(
          'Curriculum canonical Concept has no authoritative member in its LearningUnit.',
        );
      }
    }
  }
}

function unitText(node: Curriculum['nodes'][number]): string {
  return [
    node.title,
    ...(node.learningUnit?.objectives.flatMap((objective) => [
      objective.title,
      objective.description,
    ]) ?? []),
  ].join(' ');
}

/**
 * Produce a quality profile, not a composite score. Identity/structure metrics
 * are deterministic; lexical and near-duplicate findings remain explicit heuristics.
 */
export function evaluateCurriculumQuality(raw: CurriculumQualityEvaluationInput) {
  const input = CurriculumQualityEvaluationInputSchema.parse(raw);
  validateOwnership(input);
  const { workspaceId, contract, curriculum } = input;
  const sourceCorpus = curriculum.executionSourceManifest.revisions.map((revision) =>
    input.sourceCorpus.find((material) => material.materialId === revision.materialId)!,
  );
  const learningUnits = curriculum.nodes.filter((node) => node.kind === 'learning_unit');
  const learningUnitIds = new Set(learningUnits.map((node) => node.id));
  assertUnique(
    curriculum.nodes.map((node) => node.id),
    'Curriculum node IDs',
  );

  const blockById = new Map<string, SourceBlock>();
  const sectionKeyByBlockId = new Map<string, string>();
  const sectionKeysByMaterial = new Map<string, string[]>();
  for (const material of sourceCorpus) {
    for (const block of material.blocks) blockById.set(block.id, block);
    const sectionKeys: string[] = [];
    for (const section of computeSections(
      [...material.blocks].sort(
        (left, right) => left.index - right.index || left.id.localeCompare(right.id),
      ),
    )) {
      const key = `${material.materialId}\u0000${section.key}`;
      sectionKeys.push(key);
      for (const block of section.blocks) sectionKeyByBlockId.set(block.id, key);
    }
    sectionKeysByMaterial.set(material.materialId, sectionKeys);
  }

  const mappedBlockIds = new Set<string>();
  let sourceReferenceCount = 0;
  for (const node of curriculum.nodes) {
    sourceReferenceCount += node.sourceReferences.length;
    for (const reference of node.sourceReferences) {
      if (reference.sourceBlockId) mappedBlockIds.add(reference.sourceBlockId);
    }
  }
  const mappedSectionKeys = new Set(
    [...mappedBlockIds].flatMap((blockId) => {
      const key = sectionKeyByBlockId.get(blockId);
      return key ? [key] : [];
    }),
  );

  const byMaterial = sourceCorpus.map((material) => {
    const mappedBlocks = material.blocks.filter((block) => mappedBlockIds.has(block.id)).length;
    const sectionKeys = sectionKeysByMaterial.get(material.materialId) ?? [];
    const mappedSections = sectionKeys.filter((key) => mappedSectionKeys.has(key)).length;
    return {
      materialId: material.materialId,
      materialRevisionId: material.materialRevisionId,
      title: material.title,
      eligibleBlockCount: material.blocks.length,
      mappedBlockCount: mappedBlocks,
      mappedBlockRatio: ratio(mappedBlocks, material.blocks.length),
      sectionCount: sectionKeys.length,
      mappedSectionCount: mappedSections,
      sectionDiversityRatio: ratio(mappedSections, sectionKeys.length),
    };
  });

  const byId = new Map(curriculum.nodes.map((node) => [node.id, node]));
  let hierarchyCycleDetected = false;
  const invalidParentCount = curriculum.nodes.filter(
    (node) => node.parentId !== null && !byId.has(node.parentId),
  ).length;
  const depthMemo = new Map<string, number | null>();
  function depthOf(nodeId: string, visiting = new Set<string>()): number | null {
    const memo = depthMemo.get(nodeId);
    if (memo !== undefined) return memo;
    const node = byId.get(nodeId);
    if (!node) return null;
    if (visiting.has(nodeId)) {
      hierarchyCycleDetected = true;
      depthMemo.set(nodeId, null);
      return null;
    }
    if (node.parentId === null) {
      depthMemo.set(nodeId, 0);
      return 0;
    }
    if (!byId.has(node.parentId)) {
      depthMemo.set(nodeId, null);
      return null;
    }
    const next = new Set(visiting);
    next.add(nodeId);
    const parentDepth = depthOf(node.parentId, next);
    if (parentDepth === null) {
      depthMemo.set(nodeId, null);
      return null;
    }
    depthMemo.set(nodeId, parentDepth + 1);
    return parentDepth + 1;
  }
  const depths = curriculum.nodes.flatMap((node) => {
    const depth = depthOf(node.id);
    return depth === null ? [] : [depth];
  });

  function hierarchyPath(nodeId: string): number[] {
    const result: number[] = [];
    const seen = new Set<string>();
    let node = byId.get(nodeId);
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      result.unshift(node.index);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return result;
  }
  const orderedUnits = [...learningUnits].sort((left, right) => {
    const leftPath = hierarchyPath(left.id);
    const rightPath = hierarchyPath(right.id);
    for (let index = 0; index < Math.max(leftPath.length, rightPath.length); index += 1) {
      const difference = (leftPath[index] ?? -1) - (rightPath[index] ?? -1);
      if (difference !== 0) return difference;
    }
    return left.id.localeCompare(right.id);
  });
  const unitOrder = new Map(orderedUnits.map((unit, index) => [unit.id, index]));

  const chapters = curriculum.nodes.filter((node) => node.kind === 'chapter');
  const unitsByChapter = new Map(chapters.map((chapter) => [chapter.id, 0]));
  let learningUnitsWithoutModuleCount = 0;
  for (const unit of learningUnits) {
    const seen = new Set<string>();
    let parentId = unit.parentId;
    let assignedToModule = false;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.kind === 'chapter') {
        unitsByChapter.set(parent.id, (unitsByChapter.get(parent.id) ?? 0) + 1);
        assignedToModule = true;
        break;
      }
      parentId = parent.parentId;
    }
    if (!assignedToModule) learningUnitsWithoutModuleCount += 1;
  }

  let prerequisiteEdgeCount = 0;
  let invalidReferenceCount = 0;
  let selfReferenceCount = 0;
  let duplicateReferenceCount = 0;
  let forwardOrderedEdgeCount = 0;
  let reverseOrderedEdgeCount = 0;
  const incoming = new Map(learningUnits.map((unit) => [unit.id, 0]));
  const outgoing = new Map(learningUnits.map((unit) => [unit.id, 0]));
  const validPrerequisites = new Map<string, string[]>();
  for (const unit of learningUnits) {
    const prereqs = unit.learningUnit?.prerequisiteUnitIds ?? [];
    duplicateReferenceCount += prereqs.length - new Set(prereqs).size;
    const valid: string[] = [];
    for (const prerequisiteId of new Set(prereqs)) {
      if (prerequisiteId === unit.id) {
        selfReferenceCount += 1;
        continue;
      }
      if (!learningUnitIds.has(prerequisiteId)) {
        invalidReferenceCount += 1;
        continue;
      }
      valid.push(prerequisiteId);
      prerequisiteEdgeCount += 1;
      incoming.set(unit.id, (incoming.get(unit.id) ?? 0) + 1);
      outgoing.set(prerequisiteId, (outgoing.get(prerequisiteId) ?? 0) + 1);
      if ((unitOrder.get(prerequisiteId) ?? 0) < (unitOrder.get(unit.id) ?? 0)) {
        forwardOrderedEdgeCount += 1;
      } else {
        reverseOrderedEdgeCount += 1;
      }
    }
    validPrerequisites.set(unit.id, valid);
  }
  let prerequisiteCycleDetected = false;
  const visitedUnits = new Set<string>();
  const visitingUnits = new Set<string>();
  function visitPrerequisites(unitId: string): void {
    if (visitingUnits.has(unitId)) {
      prerequisiteCycleDetected = true;
      return;
    }
    if (visitedUnits.has(unitId)) return;
    visitingUnits.add(unitId);
    for (const prerequisiteId of validPrerequisites.get(unitId) ?? []) {
      visitPrerequisites(prerequisiteId);
    }
    visitingUnits.delete(unitId);
    visitedUnits.add(unitId);
  }
  for (const unit of learningUnits) visitPrerequisites(unit.id);

  const unitMappedBlockCounts: number[] = [];
  const unitMaterialCounts: number[] = [];
  const unitSectionCounts: number[] = [];
  let sourceMappedLearningUnitCount = 0;
  let conceptBoundLearningUnitCount = 0;
  let canonicalBoundLearningUnitCount = 0;
  let multiMaterialLearningUnitCount = 0;
  let multiSectionLearningUnitCount = 0;
  for (const unit of learningUnits) {
    const blockIds = new Set(
      unit.sourceReferences.flatMap((reference) =>
        reference.sourceBlockId ? [reference.sourceBlockId] : [],
      ),
    );
    const materials = new Set(
      [...blockIds].flatMap((blockId) => {
        const block = blockById.get(blockId);
        return block ? [block.materialId] : [];
      }),
    );
    const sections = new Set(
      [...blockIds].flatMap((blockId) => {
        const section = sectionKeyByBlockId.get(blockId);
        return section ? [section] : [];
      }),
    );
    unitMappedBlockCounts.push(blockIds.size);
    unitMaterialCounts.push(materials.size);
    unitSectionCounts.push(sections.size);
    if (blockIds.size > 0) sourceMappedLearningUnitCount += 1;
    if ((unit.learningUnit?.conceptIds.length ?? 0) > 0) conceptBoundLearningUnitCount += 1;
    if ((unit.learningUnit?.canonicalConceptIds.length ?? 0) > 0) {
      canonicalBoundLearningUnitCount += 1;
    }
    if (materials.size > 1) multiMaterialLearningUnitCount += 1;
    if (sections.size > 1) multiSectionLearningUnitCount += 1;
  }

  const objectiveRows = learningUnits
    .flatMap((unit) =>
      (unit.learningUnit?.objectives ?? []).map((objective) => ({
        id: objective.id,
        unitId: unit.id,
        normalized: normalizedText(`${objective.title} ${objective.description}`),
        bigrams: charBigrams(`${objective.title} ${objective.description}`),
      })),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(
    objectiveRows.map((objective) => objective.id),
    'Curriculum objective IDs',
  );
  const duplicateGroups = new Map<string, string[]>();
  for (const objective of objectiveRows) {
    if (!objective.normalized) continue;
    const ids = duplicateGroups.get(objective.normalized) ?? [];
    ids.push(objective.id);
    duplicateGroups.set(objective.normalized, ids);
  }
  const exactDuplicateGroups = [...duplicateGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([normalizedTextValue, objectiveIds]) => ({
      normalizedText: normalizedTextValue,
      objectiveIds: [...objectiveIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.normalizedText.localeCompare(right.normalizedText));
  const nearDuplicatePairs: Array<{
    leftObjectiveId: string;
    rightObjectiveId: string;
    similarity: number;
  }> = [];
  const MAX_NEAR_DUPLICATE_COMPARISONS = 250_000;
  let comparisons = 0;
  let nearDuplicateComparisonTruncated = false;
  outer: for (let leftIndex = 0; leftIndex < objectiveRows.length; leftIndex += 1) {
    const left = objectiveRows[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < objectiveRows.length; rightIndex += 1) {
      if (comparisons >= MAX_NEAR_DUPLICATE_COMPARISONS) {
        nearDuplicateComparisonTruncated = true;
        break outer;
      }
      comparisons += 1;
      const right = objectiveRows[rightIndex]!;
      if (
        left.normalized === right.normalized ||
        left.normalized.length < 8 ||
        right.normalized.length < 8
      ) {
        continue;
      }
      const lengthRatio =
        Math.min(left.normalized.length, right.normalized.length) /
        Math.max(left.normalized.length, right.normalized.length);
      if (lengthRatio < 0.7) continue;
      const similarity = diceSimilarity(left.bigrams, right.bigrams);
      if (similarity >= 0.86) {
        nearDuplicatePairs.push({
          leftObjectiveId: left.id,
          rightObjectiveId: right.id,
          similarity: Number(similarity.toFixed(6)),
        });
      }
    }
  }

  const goalStatements = [
    { kind: 'intent' as const, text: contract.intent },
    { kind: 'target_outcome' as const, text: contract.targetOutcome.description },
    ...contract.courseScope.subjectBoundaries.map((text) => ({
      kind: 'subject_boundary' as const,
      text,
    })),
    ...contract.courseScope.includedTopics.map((text) => ({
      kind: 'included_topic' as const,
      text,
    })),
  ];
  const unitFeatures = new Map(
    learningUnits.map((unit) => [unit.id, lexicalFeatures(unitText(unit))]),
  );
  const allCurriculumFeatures = new Set<string>();
  for (const features of unitFeatures.values())
    for (const feature of features) allCurriculumFeatures.add(feature);
  const statementProfiles = goalStatements.map((statement) => {
    const features = lexicalFeatures(statement.text);
    const matchedFeatureRatio = featureMatchRatio(features, allCurriculumFeatures);
    const matchingLearningUnitIds = learningUnits
      .filter(
        (unit) => (featureMatchRatio(features, unitFeatures.get(unit.id) ?? new Set()) ?? 0) >= 0.6,
      )
      .map((unit) => unit.id)
      .sort((left, right) => left.localeCompare(right));
    return {
      ...statement,
      lexicalFeatureCount: features.size,
      matchedFeatureRatio,
      matched: matchedFeatureRatio !== null && matchedFeatureRatio >= 0.6,
      matchingLearningUnitIds,
    };
  });
  const matchedStatementCount = statementProfiles.filter((statement) => statement.matched).length;

  const objectiveIds = new Set(objectiveRows.map((objective) => objective.id));
  const synthesisTargetIds = new Set<string>();
  let invalidSynthesisUnitReferences = 0;
  let duplicateSynthesisUnitReferences = 0;
  let invalidSynthesisObjectiveReferences = 0;
  let duplicateSynthesisObjectiveReferences = 0;
  const synthesisLevelCounts: Record<string, number> = {};
  for (const group of curriculum.synthesisGroups) {
    synthesisLevelCounts[group.level] = (synthesisLevelCounts[group.level] ?? 0) + 1;
    duplicateSynthesisUnitReferences +=
      group.learningUnitIds.length - new Set(group.learningUnitIds).size;
    duplicateSynthesisObjectiveReferences +=
      group.objectiveIds.length - new Set(group.objectiveIds).size;
    for (const unitId of new Set(group.learningUnitIds)) {
      if (learningUnitIds.has(unitId)) synthesisTargetIds.add(unitId);
      else invalidSynthesisUnitReferences += 1;
    }
    for (const objectiveId of new Set(group.objectiveIds)) {
      if (!objectiveIds.has(objectiveId)) invalidSynthesisObjectiveReferences += 1;
    }
  }

  let execution: CurriculumQualityProfile['execution'];
  if (!input.execution) {
    execution = {
      status: 'unavailable',
      method: 'not_measured',
      executableLearningUnitCount: null,
      nonExecutableLearningUnitCount: null,
      executableRatio: null,
      executableFrontierCount: null,
    };
  } else {
    assertUnique(
      input.execution.map((item) => item.learningUnitId),
      'Execution-profile LearningUnit IDs',
    );
    if (
      input.execution.length !== learningUnits.length ||
      input.execution.some((item) => !learningUnitIds.has(item.learningUnitId))
    ) {
      throw new Error(
        "Execution profile must account for exactly this Curriculum's LearningUnits.",
      );
    }
    if (input.execution.some((item) => item.frontierEligible && !item.executable)) {
      throw new Error('Execution frontier eligibility requires executable capability.');
    }
    const executableLearningUnitCount = input.execution.filter((item) => item.executable).length;
    const executableFrontierCount = input.execution.filter((item) => item.frontierEligible).length;
    execution = {
      status: 'measured',
      method: 'deterministic_supplied_capability',
      executableLearningUnitCount,
      nonExecutableLearningUnitCount: learningUnits.length - executableLearningUnitCount,
      executableRatio: ratio(executableLearningUnitCount, learningUnits.length),
      executableFrontierCount,
    };
  }

  const profile: CurriculumQualityProfile = {
    schemaVersion: 1,
    artifact: {
      workspaceId,
      contractId: contract.id,
      curriculumId: curriculum.id,
      curriculumVersion: curriculum.version,
      manifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    },
    methodology: {
      deterministicDimensions: [
        'source and material mapping',
        'section identity diversity',
        'hierarchy and module distribution',
        'LearningUnit and objective distributions',
        'prerequisite graph validity and density',
        'declared synthesis groups',
        'Concept, canonical, evidence, and execution bindings',
      ],
      heuristicDimensions: ['learner-goal lexical coverage', 'near-duplicate objective similarity'],
      modelJudgedDimensions: [
        'prerequisite pedagogical meaningfulness',
        'objective correctness and depth',
        'synthesis usefulness',
      ],
      humanPreferenceDimensions: [
        'perceived richness',
        'useful granularity',
        'coherence and study usefulness',
      ],
      nonclaims: [
        'Mapped source identity does not prove semantic coverage or entailment.',
        'Lexical goal matching does not prove that a goal is taught adequately.',
        'Structural prerequisite validity does not prove pedagogical meaningfulness.',
        'Supplied execution capability and frontier eligibility do not prove learner completion.',
        'No composite pedagogical-quality score is calculated.',
      ],
    },
    learnerGoalCoverage: {
      method: 'heuristic_lexical',
      statementCount: statementProfiles.length,
      matchedStatementCount,
      matchedRatio: ratio(matchedStatementCount, statementProfiles.length),
      statements: statementProfiles,
    },
    sourceCoverage: {
      method: 'deterministic_identity',
      eligibleBlockCount: blockById.size,
      mappedBlockCount: mappedBlockIds.size,
      unmappedBlockCount: blockById.size - mappedBlockIds.size,
      mappedBlockRatio: ratio(mappedBlockIds.size, blockById.size),
      materialCount: sourceCorpus.length,
      mappedMaterialCount: byMaterial.filter((material) => material.mappedBlockCount > 0).length,
      materialDiversityRatio: ratio(
        byMaterial.filter((material) => material.mappedBlockCount > 0).length,
        sourceCorpus.length,
      ),
      sectionCount: [...sectionKeysByMaterial.values()].reduce((sum, keys) => sum + keys.length, 0),
      mappedSectionCount: mappedSectionKeys.size,
      sectionDiversityRatio: ratio(
        mappedSectionKeys.size,
        [...sectionKeysByMaterial.values()].reduce((sum, keys) => sum + keys.length, 0),
      ),
      byMaterial,
    },
    hierarchy: {
      method: 'deterministic_structure',
      nodeCount: curriculum.nodes.length,
      nodeCountsByKind: {
        course: curriculum.nodes.filter((node) => node.kind === 'course').length,
        chapter: chapters.length,
        section: curriculum.nodes.filter((node) => node.kind === 'section').length,
        learningUnit: learningUnits.length,
      },
      rootCount: curriculum.nodes.filter((node) => node.parentId === null).length,
      invalidParentCount,
      cycleDetected: hierarchyCycleDetected,
      maxDepth: depths.length === 0 ? null : Math.max(...depths),
      moduleCount: chapters.length,
      learningUnitsWithoutModuleCount,
      learningUnitsPerModule: distribution([...unitsByChapter.values()]),
    },
    granularity: {
      method: 'deterministic_distribution',
      objectivesPerLearningUnit: distribution(
        learningUnits.map((unit) => unit.learningUnit?.objectives.length ?? 0),
      ),
      mappedBlocksPerLearningUnit: distribution(unitMappedBlockCounts),
      conceptsPerLearningUnit: distribution(
        learningUnits.map((unit) => unit.learningUnit?.conceptIds.length ?? 0),
      ),
      canonicalConceptsPerLearningUnit: distribution(
        learningUnits.map((unit) => unit.learningUnit?.canonicalConceptIds.length ?? 0),
      ),
    },
    prerequisites: {
      method: 'deterministic_structure',
      edgeCount: prerequisiteEdgeCount,
      edgesPerLearningUnit: ratio(prerequisiteEdgeCount, learningUnits.length),
      learningUnitsWithPrerequisites: [...incoming.values()].filter((count) => count > 0).length,
      rootLearningUnitCount: [...incoming.values()].filter((count) => count === 0).length,
      isolatedLearningUnitCount: learningUnits.filter(
        (unit) => (incoming.get(unit.id) ?? 0) === 0 && (outgoing.get(unit.id) ?? 0) === 0,
      ).length,
      invalidReferenceCount,
      selfReferenceCount,
      duplicateReferenceCount,
      cycleDetected: prerequisiteCycleDetected,
      forwardOrderedEdgeCount,
      reverseOrderedEdgeCount,
    },
    redundancy: {
      method: 'deterministic_normalization_and_heuristic_similarity',
      objectiveCount: objectiveRows.length,
      exactDuplicateGroups,
      nearDuplicatePairs,
      nearDuplicateComparisonTruncated,
    },
    synthesis: {
      method: 'deterministic_declared_structure',
      groupCount: curriculum.synthesisGroups.length,
      targetLearningUnitCount: synthesisTargetIds.size,
      invalidLearningUnitReferenceCount: invalidSynthesisUnitReferences,
      duplicateLearningUnitReferenceCount: duplicateSynthesisUnitReferences,
      invalidObjectiveReferenceCount: invalidSynthesisObjectiveReferences,
      duplicateObjectiveReferenceCount: duplicateSynthesisObjectiveReferences,
      levelCounts: synthesisLevelCounts,
    },
    bindings: {
      method: 'deterministic_identity',
      learningUnitCount: learningUnits.length,
      sourceMappedLearningUnitCount,
      conceptBoundLearningUnitCount,
      canonicalBoundLearningUnitCount,
      sourceMappedRatio: ratio(sourceMappedLearningUnitCount, learningUnits.length),
      conceptBoundRatio: ratio(conceptBoundLearningUnitCount, learningUnits.length),
      canonicalBoundRatio: ratio(canonicalBoundLearningUnitCount, learningUnits.length),
    },
    evidenceDiversity: {
      method: 'deterministic_identity',
      sourceReferenceCount,
      uniqueSourceBlockCount: mappedBlockIds.size,
      multiMaterialLearningUnitCount,
      multiSectionLearningUnitCount,
      materialsPerLearningUnit: distribution(unitMaterialCounts),
      sectionsPerLearningUnit: distribution(unitSectionCounts),
    },
    execution,
  };
  return CurriculumQualityProfileSchema.parse(profile);
}
