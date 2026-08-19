import { createHash } from 'node:crypto';
import {
  ConceptSchema,
  CurriculumSchema,
  ExecutionSourceManifestSchema,
  fnv1a32,
  SourceBlockRevisionSchema,
  type Concept,
  type Curriculum,
  type SourceBlockRevision,
} from '@hy3-clinic/shared';
import { z } from 'zod';
import { verifyGrounding } from '../grounding/verify.js';
import { computeSections } from '../ingestion/sections.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';

const CourseSourceMapMaterialInputSchema = z
  .object({
    materialId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().min(1).max(300),
    availability: z.literal('active'),
    activeRevisionId: z.string().min(1),
    revision: z
      .object({
        id: z.string().min(1),
        materialId: z.string().min(1),
        status: z.literal('active'),
        parserVersion: z.string().max(80).nullable(),
        parserFingerprint: z.string().min(1).max(200).nullable(),
        chunkerVersion: z.string().max(80).nullable().optional(),
        chunkerFingerprint: z.string().min(1).max(200).nullable().optional(),
      })
      .strict(),
    blocks: z.array(SourceBlockRevisionSchema).min(1).max(10_000),
  })
  .strict();

export const CourseSourceMapInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    manifest: ExecutionSourceManifestSchema,
    materials: z.array(CourseSourceMapMaterialInputSchema).min(1).max(100),
    concepts: z.array(ConceptSchema).max(10_000).default([]),
    predecessor: CurriculumSchema.nullable().default(null),
  })
  .strict();
export type CourseSourceMapInput = z.input<typeof CourseSourceMapInputSchema>;

const CourseSourceMapPredecessorUsageSchema = z
  .object({
    curriculumId: z.string().min(1),
    nodeIds: z.array(z.string().min(1)),
    referenceCount: z.number().int().positive(),
  })
  .strict();

const CourseSourceMapBlockSchema = z
  .object({
    sourceBlockId: z.string().min(1),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    structuralUnitId: z.string().min(1).nullable(),
    sourceIndex: z.number().int().nonnegative(),
    courseSourceIndex: z.number().int().nonnegative(),
    blockIndex: z.number().int().nonnegative(),
    sourceBlockRevisionFingerprint: z.string().min(1),
    heading: z.string().nullable(),
    headingPath: z.array(z.string()),
    pageNumber: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    parserPathNodeIds: z.array(z.string().min(1)),
    derivedSectionId: z.string().min(1),
    conceptIds: z.array(z.string().min(1)),
    predecessorUsage: CourseSourceMapPredecessorUsageSchema.nullable(),
  })
  .strict();

const CourseSourceMapParserPathSchema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    depth: z.number().int().positive(),
    title: z.string(),
    headingPath: z.array(z.string()).min(1),
    provenance: z.literal('parser_heading_path'),
    authority: z.literal('navigation_only'),
    sourceBlockIds: z.array(z.string().min(1)).min(1),
    blockCount: z.number().int().positive(),
    firstSourceIndex: z.number().int().nonnegative(),
    lastSourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const CourseSourceMapSectionSchema = z
  .object({
    id: z.string().min(1),
    sectionKey: z.string().min(1),
    materialId: z.string().min(1),
    materialRevisionId: z.string().min(1),
    sectionIndex: z.number().int().nonnegative(),
    title: z.string().min(1),
    boundaryProvenance: z.literal('deterministic_compute_sections'),
    titleProvenance: z.enum(['parser_heading_derived', 'deterministic_synthetic']),
    authority: z.literal('navigation_only'),
    headingPaths: z.array(z.array(z.string())),
    sourceBlockIds: z.array(z.string().min(1)).min(1),
    blockCount: z.number().int().positive(),
    charCount: z.number().int().nonnegative(),
    firstSourceIndex: z.number().int().nonnegative(),
    lastSourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const CourseSourceMapMaterialSchema = z
  .object({
    materialId: z.string().min(1),
    title: z.string().min(1),
    sourceIndex: z.number().int().nonnegative(),
    activeMaterialRevisionId: z.string().min(1),
    parserVersion: z.string().max(80).nullable(),
    parserFingerprint: z.string().min(1).max(200).nullable(),
    chunkerVersion: z.string().max(80).nullable().optional(),
    chunkerFingerprint: z.string().min(1).max(200).nullable().optional(),
    blockCount: z.number().int().positive(),
    sectionCount: z.number().int().positive(),
    parserPathNodes: z.array(CourseSourceMapParserPathSchema),
    sections: z.array(CourseSourceMapSectionSchema).min(1),
    blocks: z.array(CourseSourceMapBlockSchema).min(1),
  })
  .strict();

export const CourseSourceMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    manifestFingerprint: z.string().min(1),
    fingerprint: z.string().regex(/^course_source_map_[0-9a-f]{40}$/u),
    authority: z.literal('organization_only'),
    materialCount: z.number().int().positive(),
    blockCount: z.number().int().positive(),
    sectionCount: z.number().int().positive(),
    conceptAssociationCount: z.number().int().nonnegative(),
    predecessorUsedBlockCount: z.number().int().nonnegative(),
    materials: z.array(CourseSourceMapMaterialSchema).min(1),
  })
  .strict();
export type CourseSourceMap = z.infer<typeof CourseSourceMapSchema>;

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function sourceMapFingerprint(value: unknown): string {
  return `course_source_map_${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 40)}`;
}

function canonicalSourceMapFingerprintInput(
  sourceMap: Omit<CourseSourceMap, 'fingerprint'>,
): Omit<CourseSourceMap, 'fingerprint'> {
  return {
    schemaVersion: sourceMap.schemaVersion,
    workspaceId: sourceMap.workspaceId,
    manifestFingerprint: sourceMap.manifestFingerprint,
    authority: sourceMap.authority,
    materialCount: sourceMap.materialCount,
    blockCount: sourceMap.blockCount,
    sectionCount: sourceMap.sectionCount,
    conceptAssociationCount: sourceMap.conceptAssociationCount,
    predecessorUsedBlockCount: sourceMap.predecessorUsedBlockCount,
    materials: sourceMap.materials.map((material) => ({
      materialId: material.materialId,
      title: material.title,
      sourceIndex: material.sourceIndex,
      activeMaterialRevisionId: material.activeMaterialRevisionId,
      parserVersion: material.parserVersion,
      parserFingerprint: material.parserFingerprint,
      chunkerVersion: material.chunkerVersion,
      chunkerFingerprint: material.chunkerFingerprint,
      blockCount: material.blockCount,
      sectionCount: material.sectionCount,
      parserPathNodes: material.parserPathNodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        materialId: node.materialId,
        materialRevisionId: node.materialRevisionId,
        depth: node.depth,
        title: node.title,
        headingPath: node.headingPath,
        provenance: node.provenance,
        authority: node.authority,
        sourceBlockIds: node.sourceBlockIds,
        firstSourceIndex: node.firstSourceIndex,
        lastSourceIndex: node.lastSourceIndex,
        blockCount: node.blockCount,
      })),
      sections: material.sections.map((section) => ({
        id: section.id,
        sectionKey: section.sectionKey,
        materialId: section.materialId,
        materialRevisionId: section.materialRevisionId,
        sectionIndex: section.sectionIndex,
        title: section.title,
        boundaryProvenance: section.boundaryProvenance,
        titleProvenance: section.titleProvenance,
        authority: section.authority,
        headingPaths: section.headingPaths,
        sourceBlockIds: section.sourceBlockIds,
        blockCount: section.blockCount,
        charCount: section.charCount,
        firstSourceIndex: section.firstSourceIndex,
        lastSourceIndex: section.lastSourceIndex,
      })),
      blocks: material.blocks.map((block) => ({
        sourceBlockId: block.sourceBlockId,
        materialId: block.materialId,
        materialRevisionId: block.materialRevisionId,
        structuralUnitId: block.structuralUnitId,
        sourceIndex: block.sourceIndex,
        courseSourceIndex: block.courseSourceIndex,
        blockIndex: block.blockIndex,
        sourceBlockRevisionFingerprint: block.sourceBlockRevisionFingerprint,
        heading: block.heading,
        headingPath: block.headingPath,
        pageNumber: block.pageNumber,
        pageEnd: block.pageEnd,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        parserPathNodeIds: block.parserPathNodeIds,
        derivedSectionId: block.derivedSectionId,
        conceptIds: block.conceptIds,
        predecessorUsage: block.predecessorUsage,
      })),
    })),
  };
}

/** Verify that persisted navigation metadata has not been changed after construction. */
export function assertCourseSourceMapIntegrity(sourceMap: CourseSourceMap): void {
  const { fingerprint: claimedFingerprint, ...withoutFingerprint } = sourceMap;
  const expectedFingerprint = sourceMapFingerprint(
    canonicalSourceMapFingerprintInput(withoutFingerprint),
  );
  if (claimedFingerprint !== expectedFingerprint) {
    throw new Error('Course Source Map fingerprint is stale or mismatched.');
  }
}

function executionSourceManifestFingerprint(
  revisions: z.infer<typeof ExecutionSourceManifestSchema>['revisions'],
): string {
  return `manifest_${fnv1a32(JSON.stringify(revisions)).toString(16).padStart(8, '0')}`;
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function exactConceptBlock(
  concept: Concept,
  blocksById: ReadonlyMap<string, SourceBlockRevision>,
): SourceBlockRevision {
  const block = blocksById.get(concept.grounding.blockId);
  if (
    !block ||
    block.materialId !== concept.materialId ||
    block.materialRevisionId !== concept.materialRevisionId
  ) {
    throw new Error('Course Source Map Concept has a foreign or stale source owner.');
  }
  const verified = verifyGrounding([block], concept.grounding);
  if (
    !verified.ok ||
    verified.grounding.blockId !== block.id ||
    verified.grounding.quote !== concept.grounding.quote ||
    verified.grounding.startOffset !== concept.grounding.startOffset ||
    verified.grounding.endOffset !== concept.grounding.endOffset ||
    verified.grounding.occurrenceCount !== concept.grounding.occurrenceCount
  ) {
    throw new Error('Course Source Map Concept grounding is not exact current evidence.');
  }
  return block;
}

interface MutablePredecessorUsage {
  curriculumId: string;
  nodeIds: Set<string>;
  referenceCount: number;
}

function currentPredecessorUsage(
  predecessor: Curriculum | null,
  workspaceId: string,
  blocksById: ReadonlyMap<string, SourceBlockRevision>,
): Map<string, MutablePredecessorUsage> {
  if (!predecessor) return new Map();
  if (predecessor.workspaceId !== workspaceId) {
    throw new Error('Course Source Map predecessor belongs to a foreign Course.');
  }
  const result = new Map<string, MutablePredecessorUsage>();
  for (const node of predecessor.nodes) {
    for (const reference of node.sourceReferences) {
      if (!reference.sourceBlockId) continue;
      const block = blocksById.get(reference.sourceBlockId);
      if (
        !block ||
        reference.materialId !== block.materialId ||
        reference.materialRevisionId !== block.materialRevisionId ||
        reference.sourceBlockRevisionFingerprint !== block.revisionFingerprint
      ) {
        continue;
      }
      const usage = result.get(block.id) ?? {
        curriculumId: predecessor.id,
        nodeIds: new Set<string>(),
        referenceCount: 0,
      };
      usage.nodeIds.add(node.id);
      usage.referenceCount += 1;
      result.set(block.id, usage);
    }
  }
  return result;
}

/**
 * Build a deterministic navigation map over one exact current Course corpus.
 * SourceBlocks remain the only evidence leaves; headings and derived sections
 * are organization metadata and never become independently citable truth.
 */
export function buildCourseSourceMap(raw: CourseSourceMapInput): CourseSourceMap {
  const input = CourseSourceMapInputSchema.parse(raw);
  const { manifest, workspaceId } = input;

  assertUnique(
    manifest.revisions.map((revision) => revision.materialId),
    'Manifest Material identities',
  );
  assertUnique(
    manifest.revisions.map((revision) => revision.materialRevisionId),
    'Manifest MaterialRevision identities',
  );
  assertUnique(
    manifest.revisions.flatMap((revision) => revision.sourceBlockRevisionIds),
    'Manifest SourceBlock identities',
  );
  assertUnique(
    input.materials.map((material) => material.materialId),
    'Course Source Map Material identities',
  );
  assertUnique(
    input.materials.map((material) => material.revision.id),
    'Course Source Map MaterialRevision identities',
  );
  if (input.materials.length !== manifest.revisions.length) {
    throw new Error('Course Source Map materials must exactly match the manifest.');
  }

  const materialById = new Map(input.materials.map((material) => [material.materialId, material]));
  const allInputBlocks = input.materials.flatMap((material) => material.blocks);
  assertUnique(
    allInputBlocks.map((block) => block.id),
    'Course Source Map SourceBlock identities',
  );

  const blocksById = new Map<string, SourceBlockRevision>();
  const orderedMaterials = manifest.revisions.map((manifestRevision) => {
    const material = materialById.get(manifestRevision.materialId);
    if (!material) throw new Error('Course Source Map is missing a manifest Material.');
    if (material.workspaceId !== workspaceId) {
      throw new Error('Course Source Map contains a Material from a foreign Course.');
    }
    if (
      material.activeRevisionId !== material.revision.id ||
      material.revision.status !== 'active' ||
      manifestRevision.materialRevisionId !== material.revision.id
    ) {
      throw new Error('Course Source Map contains a stale active MaterialRevision.');
    }
    if (material.revision.materialId !== material.materialId) {
      throw new Error('Course Source Map MaterialRevision has a foreign Material owner.');
    }
    if (
      manifestRevision.parserVersion !== material.revision.parserVersion ||
      manifestRevision.parserFingerprint !== material.revision.parserFingerprint ||
      (manifestRevision.chunkerVersion ?? null) !== (material.revision.chunkerVersion ?? null) ||
      (manifestRevision.chunkerFingerprint ?? null) !==
        (material.revision.chunkerFingerprint ?? null)
    ) {
      throw new Error('Course Source Map parser identity does not match the manifest.');
    }

    assertUnique(
      material.blocks.map((block) => String(block.index)),
      `SourceBlock indexes for Material ${material.materialId}`,
    );
    const inputBlockById = new Map(material.blocks.map((block) => [block.id, block]));
    if (
      material.blocks.length !== manifestRevision.sourceBlockRevisionIds.length ||
      material.blocks.some((block) => !manifestRevision.sourceBlockRevisionIds.includes(block.id))
    ) {
      throw new Error('Course Source Map SourceBlocks must exactly match the manifest corpus.');
    }
    const orderedBlocks = manifestRevision.sourceBlockRevisionIds.map((blockId) => {
      const block = inputBlockById.get(blockId);
      if (!block) throw new Error('Course Source Map is missing a manifest SourceBlock.');
      if (
        block.materialId !== material.materialId ||
        block.materialRevisionId !== material.revision.id
      ) {
        throw new Error('Course Source Map SourceBlock has a foreign Material or revision owner.');
      }
      const expectedFingerprint = curriculumSourceBlockFingerprint(block, material.revision.id);
      if (block.revisionFingerprint !== expectedFingerprint) {
        throw new Error('Course Source Map SourceBlock fingerprint is stale or mismatched.');
      }
      blocksById.set(block.id, block);
      return block;
    });
    const expectedOrder = [...orderedBlocks].sort(
      (left, right) => left.index - right.index || left.id.localeCompare(right.id),
    );
    if (orderedBlocks.some((block, index) => block.id !== expectedOrder[index]?.id)) {
      throw new Error('Course Source Map manifest does not preserve exact SourceBlock order.');
    }
    return { manifestRevision, material, orderedBlocks };
  });

  if (blocksById.size !== allInputBlocks.length) {
    throw new Error('Course Source Map contains a SourceBlock outside the manifest.');
  }
  if (manifest.fingerprint !== executionSourceManifestFingerprint(manifest.revisions)) {
    throw new Error('Course Source Map execution-source manifest fingerprint is stale.');
  }
  assertUnique(
    input.concepts.map((concept) => concept.id),
    'Course Source Map Concept identities',
  );
  const conceptIdsByBlock = new Map<string, string[]>();
  for (const concept of input.concepts) {
    const block = exactConceptBlock(concept, blocksById);
    const ids = conceptIdsByBlock.get(block.id) ?? [];
    ids.push(concept.id);
    conceptIdsByBlock.set(block.id, ids);
  }
  conceptIdsByBlock.forEach((ids) => ids.sort((left, right) => left.localeCompare(right)));
  const predecessorUsageByBlock = currentPredecessorUsage(
    input.predecessor,
    workspaceId,
    blocksById,
  );

  let courseSourceIndex = 0;
  const materials: CourseSourceMap['materials'] = orderedMaterials.map(
    ({ manifestRevision, material, orderedBlocks }, materialSourceIndex) => {
      const pathNodes = new Map<
        string,
        {
          id: string;
          parentId: string | null;
          materialId: string;
          materialRevisionId: string;
          depth: number;
          title: string;
          headingPath: string[];
          provenance: 'parser_heading_path';
          authority: 'navigation_only';
          sourceBlockIds: string[];
          firstSourceIndex: number;
          lastSourceIndex: number;
        }
      >();
      const parserPathNodeIdsByBlock = new Map<string, string[]>();
      for (const [sourceIndex, block] of orderedBlocks.entries()) {
        const ids: string[] = [];
        for (let depth = 1; depth <= block.headingPath.length; depth += 1) {
          const headingPath = block.headingPath.slice(0, depth);
          const key = pathKey(headingPath);
          let node = pathNodes.get(key);
          if (!node) {
            const parentPath = headingPath.slice(0, -1);
            node = {
              id: stableId('source_path', {
                workspaceId,
                materialRevisionId: material.revision.id,
                headingPath,
              }),
              parentId:
                parentPath.length > 0 ? (pathNodes.get(pathKey(parentPath))?.id ?? null) : null,
              materialId: material.materialId,
              materialRevisionId: material.revision.id,
              depth,
              title: headingPath.at(-1)!,
              headingPath,
              provenance: 'parser_heading_path',
              authority: 'navigation_only',
              sourceBlockIds: [],
              firstSourceIndex: sourceIndex,
              lastSourceIndex: sourceIndex,
            };
            pathNodes.set(key, node);
          }
          node.sourceBlockIds.push(block.id);
          node.lastSourceIndex = sourceIndex;
          ids.push(node.id);
        }
        parserPathNodeIdsByBlock.set(block.id, ids);
      }

      const sourceIndexByBlockId = new Map(
        orderedBlocks.map((block, sourceIndex) => [block.id, sourceIndex] as const),
      );
      const sections = computeSections(orderedBlocks).map((section, sectionIndex) => {
        const sourceIndexes = section.blocks.map((block) => sourceIndexByBlockId.get(block.id)!);
        const headingPaths = [
          ...new Map(
            section.blocks.map((block) => [pathKey(block.headingPath), block.headingPath]),
          ).values(),
        ];
        return {
          id: stableId('source_section', {
            workspaceId,
            materialRevisionId: material.revision.id,
            sectionKey: section.key,
            sourceBlockIds: section.blocks.map((block) => block.id),
          }),
          sectionKey: section.key,
          materialId: material.materialId,
          materialRevisionId: material.revision.id,
          sectionIndex,
          title: section.title,
          boundaryProvenance: 'deterministic_compute_sections' as const,
          titleProvenance: section.fromHeading
            ? ('parser_heading_derived' as const)
            : ('deterministic_synthetic' as const),
          authority: 'navigation_only' as const,
          headingPaths,
          sourceBlockIds: section.blocks.map((block) => block.id),
          blockCount: section.blocks.length,
          charCount: section.charCount,
          firstSourceIndex: Math.min(...sourceIndexes),
          lastSourceIndex: Math.max(...sourceIndexes),
        };
      });
      const coveredSectionBlockIds = sections.flatMap((section) => section.sourceBlockIds);
      if (
        coveredSectionBlockIds.length !== orderedBlocks.length ||
        coveredSectionBlockIds.some((blockId, index) => blockId !== orderedBlocks[index]?.id)
      ) {
        throw new Error('Course Source Map derived sections are not exact contiguous boundaries.');
      }
      const sectionIdByBlock = new Map(
        sections.flatMap((section) =>
          section.sourceBlockIds.map((blockId) => [blockId, section.id] as const),
        ),
      );
      const blocks = orderedBlocks.map((block, sourceIndex) => {
        const usage = predecessorUsageByBlock.get(block.id);
        const result: z.infer<typeof CourseSourceMapBlockSchema> = {
          sourceBlockId: block.id,
          materialId: material.materialId,
          materialRevisionId: manifestRevision.materialRevisionId,
          structuralUnitId: block.structuralUnitId,
          sourceIndex,
          courseSourceIndex,
          blockIndex: block.index,
          sourceBlockRevisionFingerprint: block.revisionFingerprint,
          heading: block.heading,
          headingPath: [...block.headingPath],
          pageNumber: block.pageNumber,
          pageEnd: block.pageEnd,
          startOffset: block.startOffset,
          endOffset: block.endOffset,
          parserPathNodeIds: parserPathNodeIdsByBlock.get(block.id) ?? [],
          derivedSectionId: sectionIdByBlock.get(block.id)!,
          conceptIds: conceptIdsByBlock.get(block.id) ?? [],
          predecessorUsage: usage
            ? {
                curriculumId: usage.curriculumId,
                nodeIds: [...usage.nodeIds].sort((left, right) => left.localeCompare(right)),
                referenceCount: usage.referenceCount,
              }
            : null,
        };
        courseSourceIndex += 1;
        return result;
      });
      return {
        materialId: material.materialId,
        title: material.title,
        sourceIndex: materialSourceIndex,
        activeMaterialRevisionId: material.revision.id,
        parserVersion: material.revision.parserVersion,
        parserFingerprint: material.revision.parserFingerprint,
        chunkerVersion: material.revision.chunkerVersion,
        chunkerFingerprint: material.revision.chunkerFingerprint,
        blockCount: blocks.length,
        sectionCount: sections.length,
        parserPathNodes: [...pathNodes.values()].map((node) => ({
          ...node,
          blockCount: node.sourceBlockIds.length,
        })),
        sections,
        blocks,
      };
    },
  );

  const mapWithoutFingerprint = {
    schemaVersion: 1 as const,
    workspaceId,
    manifestFingerprint: manifest.fingerprint,
    authority: 'organization_only' as const,
    materialCount: materials.length,
    blockCount: materials.reduce((count, material) => count + material.blockCount, 0),
    sectionCount: materials.reduce((count, material) => count + material.sectionCount, 0),
    conceptAssociationCount: [...conceptIdsByBlock.values()].reduce(
      (count, ids) => count + ids.length,
      0,
    ),
    predecessorUsedBlockCount: predecessorUsageByBlock.size,
    materials,
  };
  return CourseSourceMapSchema.parse({
    ...mapWithoutFingerprint,
    fingerprint: sourceMapFingerprint(canonicalSourceMapFingerprintInput(mapWithoutFingerprint)),
  });
}
