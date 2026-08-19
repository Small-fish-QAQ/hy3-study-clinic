import { fnv1a32, type SourceBlock } from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import { normalizeMarkdown } from './normalized.js';

/**
 * Deterministic Markdown/plain-text segmentation.
 *
 * The source is split into normalized structural blocks. ATX headings become
 * context metadata, while lists, quotes, tables, and fenced code remain intact
 * units instead of being flattened by blank-line paragraph splitting.
 *
 * Invariants (verified by tests):
 * - `material.content.slice(block.startOffset, block.endOffset) === block.content`
 *   (offsets are UTF-16 code unit indices into the normalized content);
 * - identical input always produces identical blocks, ids included;
 * - block indexes are consecutive starting at 0.
 */

/** Upper bound on blocks per material to keep the app responsive. */
export const MAX_BLOCKS = 2000;

interface RawSegment {
  heading: string | null;
  headingPath: string[];
  content: string;
  startOffset: number;
  endOffset: number;
}

/** Compute a stable, content-addressed block id. */
export function blockId(materialId: string, index: number, content: string): string {
  const hash = fnv1a32(`${materialId}:${index}:${content}`).toString(16).padStart(8, '0');
  return `blk_${index}_${hash}`;
}

/** Split normalized content into raw segments with exact offsets. */
export function segmentContent(content: string): RawSegment[] {
  const normalized = normalizeMarkdown({
    revisionId: 'segment-preview',
    sourceType: 'md',
    mediaType: 'text/markdown',
    content,
  });
  return normalized.units
    .filter((unit) => !['heading', 'list_item'].includes(unit.kind))
    .map((unit) => ({
      heading: unit.headingPath.length ? unit.headingPath[unit.headingPath.length - 1]! : null,
      headingPath: unit.headingPath,
      content: unit.content.trim(),
      startOffset: unit.startOffset + (unit.content.length - unit.content.trimStart().length),
      endOffset: unit.endOffset - (unit.content.length - unit.content.trimEnd().length),
    }))
    .filter((segment) => segment.content.length > 0);
}

/** Segment a material's content into persisted SourceBlocks. */
export function segmentMaterial(
  materialId: string,
  content: string,
  options: {
    /** Page spans over `content` (PDF sources); blocks receive the page range they overlap. */
    pageSpans?: Array<{ pageNumber: number; startOffset: number; endOffset: number }>;
    /**
     * Revision-specific identity seed. The block still belongs to materialId,
     * but identical content in a successor revision must receive a distinct ID.
     */
    idSeed?: string;
  } = {},
): SourceBlock[] {
  const raw = segmentContent(content);
  if (raw.length === 0) {
    throw new IngestionError(
      ApiErrorCode.EmptySource,
      '未在源材料中找到可用的正文段落(仅有标题或空白)。',
    );
  }
  if (raw.length > MAX_BLOCKS) {
    throw new IngestionError(
      ApiErrorCode.SourceTooLarge,
      `源材料切分出 ${raw.length} 个段落,超过上限 ${MAX_BLOCKS}。`,
    );
  }
  const spans = options.pageSpans ?? [];
  const pageFor = (offset: number): number | null => {
    for (const span of spans) {
      if (offset >= span.startOffset && offset < span.endOffset) return span.pageNumber;
    }
    return null;
  };
  return raw.map((seg, index) => {
    const pageNumber = pageFor(seg.startOffset);
    // End page from the block's LAST content character; a block whose text
    // continues onto later pages (repaired cross-page paragraph) records its
    // full page range instead of silently claiming a single page.
    const pageEnd = pageNumber !== null ? pageFor(seg.endOffset - 1) : null;
    return {
      id: blockId(options.idSeed ?? materialId, index, seg.content),
      materialId,
      index,
      heading: seg.heading,
      headingPath: seg.headingPath,
      pageNumber,
      pageEnd: pageEnd ?? pageNumber,
      content: seg.content,
      startOffset: seg.startOffset,
      endOffset: seg.endOffset,
    };
  });
}
