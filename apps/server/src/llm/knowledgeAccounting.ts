import type { KnowledgeOutput, SourcePacketBlock } from './courseContract.js';

/** Source ownership is already explicit in each K; do not ask for a second copy of that fact. */
export function accountKnowledgeBlocks(
  value: KnowledgeOutput,
  blocks: SourcePacketBlock[],
): KnowledgeOutput {
  return {
    ...value,
    dispositions: blocks.flatMap((block) => {
      const owned = value.knowledge.filter((k) =>
        k.sourceSpans.some(
          (s) =>
            s.blockId === block.id &&
            s.revisionId === block.revisionId &&
            s.start === block.start &&
            s.end === block.end,
        ),
      );
      // Cited content is retained as teaching/support. An unused exclusion label
      // cannot remove it. Semantic truth still uses the existing source checks.
      if (owned.length)
        return [
          {
            span: {
              revisionId: block.revisionId,
              blockId: block.id,
              start: block.start,
              end: block.end,
            },
            knowledgeIds: owned.map((k) => k.localRef),
            exclusion: null,
          },
        ];
      // An uncited block needs the author's real exclusion or its original
      // span accounting. Do not invent exclusion or bridge a missing span.
      return value.dispositions.filter((d) => d.span.blockId === block.id);
    }),
  };
}
