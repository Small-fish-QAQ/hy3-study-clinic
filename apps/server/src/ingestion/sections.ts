import type { SourceBlock } from '@hy3-clinic/shared';
import { fnv1a32 } from '@hy3-clinic/shared';

/**
 * Deterministic document sections for section-aware extraction.
 *
 * Sections are DERIVED from the persisted SourceBlocks on demand — there is
 * no section table. For unchanged source content the outline (keys included)
 * is identical between calls, so section-targeted deepen requests stay
 * stable without persistence.
 *
 * Strategy:
 * 1. group consecutive blocks by their TOP-LEVEL heading (headingPath[0]);
 *    blocks before any heading form a leading group;
 * 2. if the heading structure is absent or degenerate (fewer than two
 *    distinct groups for a document large enough to need splitting), fall
 *    back to deterministic synthetic windows over the block sequence with a
 *    character budget (Amendment D) — never the whole-document one-shot;
 * 3. merge undersized adjacent groups and split oversized groups at block
 *    boundaries so every section lands inside a bounded character budget.
 */

export interface DocumentSection {
  /** Stable content-derived key (safe to use in deepen requests). */
  key: string;
  /** Display title: the heading, or a deterministic window label. */
  title: string;
  /** Ordered blocks of this section (contiguous by block index). */
  blocks: SourceBlock[];
  charCount: number;
  /** True when the title came from a real heading (not synthetic). */
  fromHeading: boolean;
}

/** Sections smaller than this merge into their neighbour. */
export const MIN_SECTION_CHARS = 500;
/** Sections larger than this split at block boundaries. */
export const MAX_SECTION_CHARS = 4000;
/** A document below this size is a single section (no splitting value). */
const SINGLE_SECTION_LIMIT = 1500;

interface RawGroup {
  title: string | null;
  blocks: SourceBlock[];
}

function charsOf(blocks: SourceBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.content.length, 0);
}

function groupByTopHeading(blocks: SourceBlock[]): RawGroup[] {
  const groups: RawGroup[] = [];
  for (const block of blocks) {
    const top = block.headingPath[0] ?? null;
    const last = groups[groups.length - 1];
    if (last && last.title === top) {
      last.blocks.push(block);
    } else {
      groups.push({ title: top, blocks: [block] });
    }
  }
  return groups;
}

/** Split one oversized group at block boundaries into ≤MAX-char parts. */
function splitGroup(group: RawGroup): RawGroup[] {
  if (charsOf(group.blocks) <= MAX_SECTION_CHARS) return [group];
  const parts: RawGroup[] = [];
  let current: SourceBlock[] = [];
  let currentChars = 0;
  for (const block of group.blocks) {
    if (current.length > 0 && currentChars + block.content.length > MAX_SECTION_CHARS) {
      parts.push({ title: group.title, blocks: current });
      current = [];
      currentChars = 0;
    }
    current.push(block);
    currentChars += block.content.length;
  }
  if (current.length > 0) parts.push({ title: group.title, blocks: current });
  return parts.map((part, index) =>
    parts.length > 1
      ? { title: part.title === null ? null : `${part.title}(${index + 1})`, blocks: part.blocks }
      : part,
  );
}

/** Merge heading groups forward until each section reaches the minimum. */
function mergeSmallGroups(groups: RawGroup[]): RawGroup[] {
  const merged: RawGroup[] = [];
  for (const group of groups) {
    const last = merged[merged.length - 1];
    if (last && charsOf(last.blocks) < MIN_SECTION_CHARS) {
      // The running section is still undersized: absorb the next group,
      // keeping the first real heading as the title.
      last.blocks.push(...group.blocks);
      if (last.title === null) last.title = group.title;
    } else {
      merged.push({ title: group.title, blocks: [...group.blocks] });
    }
  }
  // A trailing sliver merges backward instead of standing alone.
  if (merged.length > 1 && charsOf(merged[merged.length - 1]!.blocks) < MIN_SECTION_CHARS) {
    const tail = merged.pop()!;
    merged[merged.length - 1]!.blocks.push(...tail.blocks);
  }
  return merged;
}

/** Deterministic synthetic windows for heading-less documents. */
function syntheticWindows(blocks: SourceBlock[]): RawGroup[] {
  const groups: RawGroup[] = [];
  let current: SourceBlock[] = [];
  let currentChars = 0;
  for (const block of blocks) {
    if (current.length > 0 && currentChars + block.content.length > MAX_SECTION_CHARS) {
      groups.push({ title: null, blocks: current });
      current = [];
      currentChars = 0;
    }
    current.push(block);
    currentChars += block.content.length;
  }
  if (current.length > 0) groups.push({ title: null, blocks: current });
  // A trailing sliver merges backward.
  if (groups.length > 1 && charsOf(groups[groups.length - 1]!.blocks) < MIN_SECTION_CHARS) {
    const tail = groups.pop()!;
    groups[groups.length - 1]!.blocks.push(...tail.blocks);
  }
  return groups;
}

function toSection(group: RawGroup, index: number): DocumentSection {
  const blockIds = group.blocks.map((b) => b.id).join(',');
  const key = `sec_${index}_${fnv1a32(blockIds).toString(16).padStart(8, '0')}`;
  const first = group.blocks[0]!;
  const last = group.blocks[group.blocks.length - 1]!;
  const title =
    group.title ??
    (index === 0 && first.index === 0
      ? `开头部分(第 ${first.index + 1}-${last.index + 1} 段)`
      : `第 ${first.index + 1}-${last.index + 1} 段`);
  return {
    key,
    title,
    blocks: group.blocks,
    charCount: charsOf(group.blocks),
    fromHeading: group.title !== null,
  };
}

/**
 * Compute the deterministic section outline of a document's blocks.
 * Never returns an empty array for a non-empty block list.
 */
export function computeSections(blocks: SourceBlock[]): DocumentSection[] {
  if (blocks.length === 0) return [];
  const total = charsOf(blocks);
  if (total <= SINGLE_SECTION_LIMIT) {
    return [toSection({ title: blocks[0]!.headingPath[0] ?? null, blocks: [...blocks] }, 0)];
  }

  const headingGroups = groupByTopHeading(blocks);
  const distinctTitles = new Set(
    headingGroups.map((g) => g.title).filter((t): t is string => t !== null),
  );
  // Degenerate structure (Amendment D): no or a single top-level heading over
  // a document that needs splitting → deterministic synthetic windows.
  const useSynthetic = distinctTitles.size < 2;
  const groups = useSynthetic
    ? syntheticWindows(blocks)
    : mergeSmallGroups(headingGroups).flatMap((group) => splitGroup(group));

  return groups.map((group, index) => toSection(group, index));
}

/** Find one section of the current outline by its stable key. */
export function findSection(blocks: SourceBlock[], key: string): DocumentSection | undefined {
  return computeSections(blocks).find((section) => section.key === key);
}

/**
 * Size-aware concept budget for one section (Amendment E): the model is asked
 * for AT MOST this many concepts and explicitly told that zero is acceptable.
 * Never a minimum — thin sections must not invent near-duplicates.
 */
export function conceptBudgetFor(section: DocumentSection): number {
  if (section.charCount < 600) return 2;
  if (section.charCount < 1500) return 4;
  if (section.charCount < 3000) return 6;
  return 8;
}
