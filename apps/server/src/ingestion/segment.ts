import { fnv1a32, type SourceBlock } from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';

/**
 * Deterministic Markdown/plain-text segmentation.
 *
 * The source is split into paragraph blocks along ATX headings (`#`..`######`)
 * and blank-line boundaries. Headings are NOT standalone blocks — they become
 * `heading` / `headingPath` metadata on the paragraph blocks that follow them.
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

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Compute a stable, content-addressed block id. */
export function blockId(materialId: string, index: number, content: string): string {
  const hash = fnv1a32(`${materialId}:${index}:${content}`).toString(16).padStart(8, '0');
  return `blk_${index}_${hash}`;
}

/** Split normalized content into raw segments with exact offsets. */
export function segmentContent(content: string): RawSegment[] {
  const segments: RawSegment[] = [];
  const headingStack: { level: number; text: string }[] = [];

  let paragraphStart = -1;
  let cursor = 0;
  const lines = content.split('\n');

  const flushParagraph = (endOffset: number) => {
    if (paragraphStart < 0) return;
    const text = content.slice(paragraphStart, endOffset);
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      const leading = text.length - text.trimStart().length;
      const start = paragraphStart + leading;
      segments.push({
        heading: headingStack.length > 0 ? headingStack[headingStack.length - 1]!.text : null,
        headingPath: headingStack.map((h) => h.text),
        content: trimmed,
        startOffset: start,
        endOffset: start + trimmed.length,
      });
    }
    paragraphStart = -1;
  };

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    cursor = lineEnd + 1; // account for the '\n' removed by split

    const headingMatch = HEADING_RE.exec(line.trim());
    if (headingMatch) {
      flushParagraph(lineStart);
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(lineStart);
      continue;
    }

    if (paragraphStart < 0) {
      paragraphStart = lineStart;
    }
  }
  flushParagraph(content.length);

  return segments;
}

/** Segment a material's content into persisted SourceBlocks. */
export function segmentMaterial(materialId: string, content: string): SourceBlock[] {
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
  return raw.map((seg, index) => ({
    id: blockId(materialId, index, seg.content),
    materialId,
    index,
    heading: seg.heading,
    headingPath: seg.headingPath,
    content: seg.content,
    startOffset: seg.startOffset,
    endOffset: seg.endOffset,
  }));
}
