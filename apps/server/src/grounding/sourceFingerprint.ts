import { fnv1a32, type SourceBlock } from '@hy3-clinic/shared';

/** Stable extraction identity for one SourceBlock inside one immutable revision. */
export function curriculumSourceBlockFingerprint(block: SourceBlock, revisionId: string): string {
  return `block_${fnv1a32(
    JSON.stringify({
      materialRevisionId: revisionId,
      blockId: block.id,
      index: block.index,
      content: block.content,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      chunkerVersion: block.chunkerVersion ?? null,
    }),
  )
    .toString(16)
    .padStart(8, '0')}`;
}
