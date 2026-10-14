import { it, expect } from 'vitest';
import { attachTableSourceContext, proofSourceContext } from './knowledgeSourceStructure.js';
const blocks = ['| 条件 | 结论 |', '|---|---|', '| P | Q |', '普通正文并未被知识引用。'].map(
  (text, i) => ({
    id: `b${i}`,
    revisionId: 'r',
    headingPath: ['表格'],
    text,
    start: i * 20,
    end: (i + 1) * 20,
  }),
);
it('表头随已引用数据行归属同一知识，实际正文缺口不被补造，不修改作者原候选', () => {
  const packet = {
    knowledge: [
      {
        id: 'k',
        origin: 'textbook' as const,
        sourceSpans: [{ revisionId: 'r', blockId: 'b2', start: 40, end: 60 }],
      },
    ],
    dispositions: blocks.map((b) => ({
      span: { revisionId: b.revisionId, blockId: b.id, start: b.start, end: b.end },
      knowledgeIds: b.id === 'b2' ? ['k'] : [],
      exclusion: null,
    })),
  };
  const next = attachTableSourceContext(
    packet as Parameters<typeof attachTableSourceContext>[0],
    blocks,
  );
  expect(next.knowledge[0]!.sourceSpans.map((s) => s.blockId)).toEqual(['b2', 'b0', 'b1']);
  expect(next.dispositions.slice(0, 3).map((d) => d.knowledgeIds)).toEqual([['k'], ['k'], ['k']]);
  expect(next.dispositions[3]!.knowledgeIds).toEqual([]);
  expect(packet.knowledge[0]!.sourceSpans).toHaveLength(1);
  const foreign = blocks.map((b, i) => ({
    ...b,
    headingPath: i === 2 ? ['另一张表'] : b.headingPath,
  }));
  expect(
    attachTableSourceContext(packet as Parameters<typeof attachTableSourceContext>[0], foreign)
      .knowledge[0]!.sourceSpans,
  ).toHaveLength(1);
});
it('显式T步骤引用递归补齐同一证明的真实前提，不给无关表格或正文增加归属', () => {
  const proof = [
    '| 步骤 | 公式 | 理由 |',
    '|---|---|---|',
    '| 1 | P→Q | P |',
    '| 2 | Q→R | P |',
    '| 3 | P→R | T(1),(2)，I |',
    '| 4 | ¬R→¬P | T(3)，E |\n\n## 下一节',
    '未引用正文',
    '| 步骤 | 公式 | 理由 |',
    '|---|---|---|',
    '| 1 | S | P |',
  ].map((text, i) => ({
    id: `p${i}`,
    revisionId: 'r',
    headingPath: ['证明'],
    text,
    start: i * 20,
    end: (i + 1) * 20,
  }));
  expect(proofSourceContext([proof[5]!], proof).map((b) => b.id)).toEqual([
    'p0',
    'p1',
    'p2',
    'p3',
    'p4',
    'p5',
  ]);
  expect(proofSourceContext([proof[9]!], proof).map((b) => b.id)).toEqual(['p7', 'p8', 'p9']);
});
