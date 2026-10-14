import { it, expect } from 'vitest';
import { accountKnowledgeBlocks } from './knowledgeAccounting.js';
import { knowledgeWire, KnowledgeWireSchema } from './knowledgeWire.js';
const blocks = ['正文命题', '核对提示', '未解释的正文'].map((text, i) => ({
  id: `b${i}`,
  revisionId: 'revision',
  text,
  headingPath: [],
  start: i * 20,
  end: i * 20 + text.length,
}));
const knowledge = {
  localRef: 'fact',
  title: '教材命题',
  statement: '正文命题与核对提示',
  kind: 'concept' as const,
  origin: 'textbook' as const,
  sourceSpans: blocks
    .slice(0, 2)
    .map((b) => ({ revisionId: b.revisionId, blockId: b.id, start: b.start, end: b.end })),
  prerequisiteKnowledgeIds: [],
  relatedKnowledgeIds: [],
  uncertaintyCodes: [],
};
it('实际引文只计算一次来源归属，不需重复普通登记；被引用知识不得被排除标签删除，未引用块仍不能算已处理', () => {
  const value = {
    knowledge: [knowledge],
    dispositions: [
      {
        span: knowledge.sourceSpans[1]!,
        knowledgeIds: ['fact'],
        exclusion: { kind: 'frontmatter' as const, reason: '重复的整理说明' },
      },
    ],
  };
  const output = accountKnowledgeBlocks(value, blocks);
  expect(output.knowledge).toEqual(value.knowledge);
  expect(
    output.dispositions.map((d) => ({
      block: d.span.blockId,
      ids: d.knowledgeIds,
      excluded: d.exclusion,
    })),
  ).toEqual([
    { block: 'b0', ids: ['fact'], excluded: null },
    { block: 'b1', ids: ['fact'], excluded: null },
  ]);
  expect(output.dispositions.some((d) => d.span.blockId === 'b2')).toBe(false);
});
it('传输只列排除项或省略空排除列表，代码仍登记全部有真实来源的知识', () => {
  const wire = knowledgeWire({ blocks: blocks.slice(0, 2) });
  const {
    sourceSpans: _spans,
    prerequisiteKnowledgeIds: _prereqs,
    relatedKnowledgeIds: _related,
    ...rest
  } = knowledge;
  const raw = KnowledgeWireSchema.parse({
    knowledge: [{ ...rest, sourceBlockIds: ['s0', 's1'], prerequisiteRefs: [], relatedRefs: [] }],
  });
  expect(wire.materialize(raw).dispositions).toHaveLength(2);
});
