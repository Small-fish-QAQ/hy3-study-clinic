import type { SourceBlock } from '@hy3-clinic/shared';
import {
  assertCourseSourceMapIntegrity,
  CourseSourceMapSchema,
  type CourseSourceMap,
} from './courseSourceMap.js';
import { curriculumSourceBlockFingerprint } from './curriculumValidation.js';

export const CURRICULUM_EVIDENCE_SELECTOR_POLICIES = [
  'b3_baseline_v1',
  'derived_section_reserve_v1',
  'allocated_source_v1',
] as const;
export type CurriculumEvidenceSelectorPolicy =
  (typeof CURRICULUM_EVIDENCE_SELECTOR_POLICIES)[number];

export const CURRICULUM_EVIDENCE_BASELINE_POLICY: CurriculumEvidenceSelectorPolicy =
  'b3_baseline_v1';
export const CURRICULUM_EVIDENCE_SECTION_RESERVE_POLICY: CurriculumEvidenceSelectorPolicy =
  'derived_section_reserve_v1';
export const CURRICULUM_EVIDENCE_PRODUCTION_POLICY: CurriculumEvidenceSelectorPolicy =
  'allocated_source_v1';

export type CurriculumEvidencePolicySelectionReason =
  | 'protected_baseline'
  | 'section_reserve'
  | 'ranked_redistribution'
  | 'source_order_redistribution';

export interface CurriculumEvidencePolicySelection {
  blockIds: string[];
  reasonByBlockId: Map<string, CurriculumEvidencePolicySelectionReason>;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

/**
 * Validate that the navigation projection describes this exact ordered source
 * corpus. The projection organizes selection only; SourceBlocks remain the
 * citable evidence leaves.
 */
export function validateCourseSourceMapSelectionCorpus(input: {
  workspaceId: string;
  sourceMap: CourseSourceMap;
  blocks: readonly SourceBlock[];
}): CourseSourceMap {
  const sourceMap = CourseSourceMapSchema.parse(input.sourceMap);
  if (sourceMap.workspaceId !== input.workspaceId) {
    throw new Error('Curriculum evidence Course Source Map belongs to a foreign Course.');
  }
  const mapBlocks = sourceMap.materials.flatMap((material) => material.blocks);
  assertUnique(
    input.blocks.map((block) => block.id),
    'Curriculum evidence SourceBlock identities',
  );
  if (mapBlocks.length !== input.blocks.length) {
    throw new Error('Curriculum evidence Course Source Map is incomplete for the source corpus.');
  }
  for (const [index, block] of input.blocks.entries()) {
    const mapped = mapBlocks[index];
    if (
      !mapped ||
      mapped.sourceBlockId !== block.id ||
      mapped.materialId !== block.materialId ||
      mapped.materialRevisionId !== block.materialRevisionId ||
      mapped.blockIndex !== block.index ||
      mapped.startOffset !== block.startOffset ||
      mapped.endOffset !== block.endOffset ||
      mapped.heading !== block.heading ||
      JSON.stringify(mapped.headingPath) !== JSON.stringify(block.headingPath) ||
      mapped.pageNumber !== block.pageNumber ||
      mapped.pageEnd !== block.pageEnd ||
      mapped.sourceBlockRevisionFingerprint !==
        curriculumSourceBlockFingerprint(block, mapped.materialRevisionId)
    ) {
      throw new Error(
        'Curriculum evidence Course Source Map is stale, foreign, or out of source order.',
      );
    }
  }
  for (const material of sourceMap.materials) {
    const sectionBlockIds = material.sections.flatMap((section) => section.sourceBlockIds);
    const materialBlockIds = material.blocks.map((block) => block.sourceBlockId);
    if (
      sectionBlockIds.length !== materialBlockIds.length ||
      sectionBlockIds.some((blockId, index) => blockId !== materialBlockIds[index])
    ) {
      throw new Error(
        'Curriculum evidence Course Source Map derived sections are incomplete or out of order.',
      );
    }
    const sectionIdByBlockId = new Map(
      material.sections.flatMap((section) =>
        section.sourceBlockIds.map((blockId) => [blockId, section.id] as const),
      ),
    );
    if (
      material.blocks.some(
        (block) => sectionIdByBlockId.get(block.sourceBlockId) !== block.derivedSectionId,
      )
    ) {
      throw new Error('Curriculum evidence Course Source Map derived-section identity is stale.');
    }
  }
  assertCourseSourceMapIntegrity(sourceMap);
  return sourceMap;
}

/**
 * Reserve one opportunity per deterministic derived section, then redistribute
 * every unused slot through the unchanged baseline/global order. Production
 * passes no section cap; the optional cap exists only for evaluator parity.
 */
export function selectDerivedSectionReserveCandidates(input: {
  sourceMap: CourseSourceMap;
  baselineCandidateBlockIds: readonly string[];
  rankedBlockIds: readonly string[];
  protectedBaselineBlockIds?: readonly string[];
  maxBlocks: number;
  reservePerSection?: number;
  maxBlocksPerSection?: number | null;
}): CurriculumEvidencePolicySelection {
  const maxBlocks = requireNonNegativeSafeInteger(input.maxBlocks, 'maxBlocks');
  const reservePerSection = requireNonNegativeSafeInteger(
    input.reservePerSection ?? 1,
    'reservePerSection',
  );
  const maxBlocksPerSection =
    input.maxBlocksPerSection === undefined || input.maxBlocksPerSection === null
      ? Number.POSITIVE_INFINITY
      : requireNonNegativeSafeInteger(input.maxBlocksPerSection, 'maxBlocksPerSection');
  const sourceBlocks = input.sourceMap.materials.flatMap((material) => material.blocks);
  const sourceBlockIds = sourceBlocks.map((block) => block.sourceBlockId);
  const knownBlockIds = new Set(sourceBlockIds);
  assertUnique(sourceBlockIds, 'Course Source Map SourceBlock identities');
  assertUnique(input.baselineCandidateBlockIds, 'Baseline candidate SourceBlock identities');
  assertUnique(
    input.protectedBaselineBlockIds ?? [],
    'Protected baseline candidate SourceBlock identities',
  );
  for (const blockId of [
    ...input.baselineCandidateBlockIds,
    ...input.rankedBlockIds,
    ...(input.protectedBaselineBlockIds ?? []),
  ]) {
    if (!knownBlockIds.has(blockId)) {
      throw new Error('Curriculum evidence policy references an unknown or foreign SourceBlock.');
    }
  }
  const baselineCandidateSet = new Set(input.baselineCandidateBlockIds);
  if (
    (input.protectedBaselineBlockIds ?? []).some((blockId) => !baselineCandidateSet.has(blockId))
  ) {
    throw new Error('Protected evidence must belong to the frozen baseline candidate set.');
  }

  const rankedWithoutFallback = uniqueInOrder([
    ...input.baselineCandidateBlockIds,
    ...input.rankedBlockIds,
  ]);
  const globalOrder = uniqueInOrder([...rankedWithoutFallback, ...sourceBlockIds]);
  const orderIndex = new Map(globalOrder.map((blockId, index) => [blockId, index]));
  const rankedSet = new Set(rankedWithoutFallback);
  const sections = input.sourceMap.materials.flatMap((material) => material.sections);
  const candidatesBySection = new Map(
    sections.map((section) => [
      section.id,
      [...section.sourceBlockIds].sort(
        (left, right) =>
          orderIndex.get(left)! - orderIndex.get(right)! || left.localeCompare(right),
      ),
    ]),
  );
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const sectionIdByBlockId = new Map(
    sections.flatMap((section) =>
      section.sourceBlockIds.map((blockId) => [blockId, section.id] as const),
    ),
  );
  const selectedCountBySectionId = new Map<string, number>();
  const reasonByBlockId = new Map<string, CurriculumEvidencePolicySelectionReason>();
  const add = (blockId: string, reason: CurriculumEvidencePolicySelectionReason): void => {
    if (selected.length >= maxBlocks || selectedSet.has(blockId)) return;
    const sectionId = sectionIdByBlockId.get(blockId);
    if (!sectionId) {
      throw new Error('Course Source Map derived sections do not cover the source corpus.');
    }
    const sectionCount = selectedCountBySectionId.get(sectionId) ?? 0;
    if (sectionCount >= maxBlocksPerSection) return;
    selected.push(blockId);
    selectedSet.add(blockId);
    selectedCountBySectionId.set(sectionId, sectionCount + 1);
    reasonByBlockId.set(blockId, reason);
  };

  const protectedBaselineBlockIds = new Set(input.protectedBaselineBlockIds ?? []);
  for (let round = 0; round < reservePerSection && selected.length < maxBlocks; round += 1) {
    for (const section of sections) {
      if ((selectedCountBySectionId.get(section.id) ?? 0) > round) continue;
      const next = candidatesBySection
        .get(section.id)!
        .find((blockId) => !selectedSet.has(blockId));
      if (next) add(next, 'section_reserve');
      if (selected.length >= maxBlocks) break;
    }
  }
  for (const blockId of globalOrder) {
    if (selected.length >= maxBlocks) break;
    add(blockId, rankedSet.has(blockId) ? 'ranked_redistribution' : 'source_order_redistribution');
  }

  // A reserve cannot justify evicting baseline Concept/predecessor evidence.
  // Replace only an unprotected selected block, preserving deterministic order.
  for (const blockId of input.baselineCandidateBlockIds) {
    if (!protectedBaselineBlockIds.has(blockId) || selectedSet.has(blockId)) continue;
    const protectedSectionId = sectionIdByBlockId.get(blockId)!;
    const protectedSectionCount = selectedCountBySectionId.get(protectedSectionId) ?? 0;
    const replacementIndex = selected.findIndex(
      (candidate) =>
        !protectedBaselineBlockIds.has(candidate) &&
        (sectionIdByBlockId.get(candidate) === protectedSectionId ||
          protectedSectionCount < maxBlocksPerSection),
    );
    if (replacementIndex < 0) break;
    const replacedBlockId = selected[replacementIndex]!;
    const replacedSectionId = sectionIdByBlockId.get(replacedBlockId)!;
    selectedSet.delete(replacedBlockId);
    reasonByBlockId.delete(replacedBlockId);
    selected[replacementIndex] = blockId;
    selectedSet.add(blockId);
    reasonByBlockId.set(blockId, 'protected_baseline');
    if (replacedSectionId !== protectedSectionId) {
      selectedCountBySectionId.set(
        replacedSectionId,
        selectedCountBySectionId.get(replacedSectionId)! - 1,
      );
      selectedCountBySectionId.set(protectedSectionId, protectedSectionCount + 1);
    }
  }

  return { blockIds: selected, reasonByBlockId };
}
