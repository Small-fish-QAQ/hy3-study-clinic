import { describe, expect, it } from 'vitest';
import type { SourceBlock } from '@hy3-clinic/shared';
import { verifyGrounding } from './verify.js';

function block(id: string, content: string): SourceBlock {
  return {
    id,
    materialId: 'mat_1',
    index: 0,
    heading: null,
    headingPath: [],
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

const blocks: SourceBlock[] = [
  block('blk_0', '工作记忆的容量十分有限,一般约为四个组块。'),
  block('blk_1', '长时记忆的容量近乎无限,可以保存很久。'),
  block('blk_2', '遗忘曲线说明遗忘先快后慢。遗忘曲线由艾宾浩斯提出。'),
];

describe('verifyGrounding', () => {
  it('verifies an exact quote and computes offsets itself', () => {
    const result = verifyGrounding(blocks, { blockId: 'blk_0', quote: '容量十分有限' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounding.blockId).toBe('blk_0');
      expect(result.grounding.startOffset).toBe(5);
      expect(result.grounding.endOffset).toBe(11);
      expect(result.grounding.occurrenceCount).toBe(1);
      expect(result.grounding.reanchored).toBe(false);
      // The computed offsets must slice back to the quote.
      expect(blocks[0]!.content.slice(5, 11)).toBe('容量十分有限');
    }
  });

  it('trims surrounding whitespace but does no fuzzy matching', () => {
    const result = verifyGrounding(blocks, { blockId: 'blk_0', quote: '  容量十分有限  ' });
    expect(result.ok).toBe(true);
  });

  it('rejects a quote that is not present anywhere', () => {
    const result = verifyGrounding(blocks, { blockId: 'blk_0', quote: '这句话不存在' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quote_not_found');
  });

  it('rejects an unknown block id when the quote is nowhere', () => {
    const result = verifyGrounding(blocks, { blockId: 'nope', quote: '不存在的引文' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_block');
  });

  it('re-anchors to a unique other block when the model names the wrong block', () => {
    // Quote lives in blk_1, model wrongly cited blk_0.
    const result = verifyGrounding(blocks, { blockId: 'blk_0', quote: '长时记忆的容量近乎无限' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounding.blockId).toBe('blk_1');
      expect(result.grounding.reanchored).toBe(true);
    }
  });

  it('anchors to the first occurrence and reports occurrenceCount for repeats in-block', () => {
    const result = verifyGrounding(blocks, { blockId: 'blk_2', quote: '遗忘曲线' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grounding.occurrenceCount).toBe(2);
      expect(result.grounding.startOffset).toBe(0);
    }
  });

  it('rejects a quote that appears in multiple blocks when the named block lacks it', () => {
    const ambiguous: SourceBlock[] = [
      block('blk_a', '重复的句子。其他内容。'),
      block('blk_b', '不同的开头。重复的句子。'),
      block('blk_c', '模型指向这里,但这里没有那句话。'),
    ];
    const result = verifyGrounding(ambiguous, { blockId: 'blk_c', quote: '重复的句子。' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous_across_blocks');
  });

  it('rejects when the quote repeats in a single re-anchor candidate block', () => {
    const repeated: SourceBlock[] = [
      block('blk_x', '模型指向这里,但没有目标句。'),
      block('blk_y', '重复词。重复词。'),
    ];
    const result = verifyGrounding(repeated, { blockId: 'blk_x', quote: '重复词。' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous_in_candidate_block');
  });

  it('rejects an empty quote', () => {
    const result = verifyGrounding(blocks, { blockId: 'blk_0', quote: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty_quote');
  });
});
