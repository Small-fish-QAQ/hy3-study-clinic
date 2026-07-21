import { describe, expect, it } from 'vitest';
import { alignPointToStem, alignRubricToQuestion, charCoverageRatio } from './rubricAlignment.js';

const SOURCE = [
  'Chunk 实现分为五个等级。',
  '固定长度:纯代码,每 N 字符切、重叠 M。快但易切断语义。',
  '递归分隔符:按优先级逐层切。',
].join('\n');

describe('charCoverageRatio', () => {
  it('is 1 when every meaningful character appears in the source', () => {
    expect(charCoverageRatio('每 N 字符切', SOURCE)).toBe(1);
  });

  it('is low for unrelated text', () => {
    expect(charCoverageRatio('量子纠缠与薛定谔方程', SOURCE)).toBeLessThan(0.3);
  });

  it('is 0 for punctuation-only text', () => {
    expect(charCoverageRatio('。,;', SOURCE)).toBe(0);
  });
});

describe('alignPointToStem', () => {
  const drawback = { text: '快但易切断语义', required: true };

  it('demotes an unrequested drawback point (「说明做法」 does not ask for it)', () => {
    expect(alignPointToStem('说明固定长度切分的做法。', drawback)).toBe(false);
  });

  it('keeps a drawback point required when the stem requests 缺点', () => {
    expect(alignPointToStem('说明固定长度切分的做法及缺点。', drawback)).toBe(true);
  });

  it('promotes a drawback point the provider wrongly marked optional', () => {
    expect(
      alignPointToStem('说明固定长度切分的做法及缺点。', { ...drawback, required: false }),
    ).toBe(true);
  });

  it('requires comparison points only when the stem asks to compare', () => {
    const point = { text: '两种切分方式的区别在于粒度', required: true };
    expect(alignPointToStem('说明固定长度切分的做法。', point)).toBe(false);
    expect(alignPointToStem('比较两种切分方式的异同。', point)).toBe(true);
  });

  it('keeps the provider claim for non-evaluative points', () => {
    const method = { text: '每 N 字符切、重叠 M', required: true };
    expect(alignPointToStem('说明固定长度切分的做法。', method)).toBe(true);
    expect(alignPointToStem('说明固定长度切分的做法。', { ...method, required: false })).toBe(
      false,
    );
  });
});

describe('alignRubricToQuestion', () => {
  const methodStem = '说明固定长度切分的做法。';

  it('keeps requested method points required and demotes unrequested drawbacks', () => {
    const result = alignRubricToQuestion(
      methodStem,
      [
        { text: '每 N 字符切', required: true },
        { text: '重叠 M', required: true },
        { text: '快但易切断语义', required: true },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints).toEqual([
      { text: '每 N 字符切', required: true },
      { text: '重叠 M', required: true },
      { text: '快但易切断语义', required: false },
    ]);
    expect(result.adjustments.length).toBe(1);
  });

  it('makes the drawback required when the question asks 「做法及缺点」', () => {
    const result = alignRubricToQuestion(
      '说明固定长度切分的做法及缺点。',
      [
        { text: '每 N 字符切', required: true },
        { text: '快但易切断语义', required: false },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints[1]).toEqual({ text: '快但易切断语义', required: true });
  });

  it('does not make a rich reference answer mandatory: legacy string points stay aligned', () => {
    // Legacy/strict providers may send everything as required (the old
    // string format normalizes that way); alignment still fixes it.
    const result = alignRubricToQuestion(
      methodStem,
      [
        { text: '每 N 字符切、重叠 M', required: true },
        { text: '快但易切断语义', required: true },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints.filter((p) => p.required).map((p) => p.text)).toEqual([
      '每 N 字符切、重叠 M',
    ]);
    expect(result.keyPoints.filter((p) => !p.required).map((p) => p.text)).toEqual([
      '快但易切断语义',
    ]);
  });

  it('demotes required points that lack evidence grounding', () => {
    const result = alignRubricToQuestion(
      methodStem,
      [
        { text: '每 N 字符切', required: true },
        { text: '需要调用量子退火算法完成预处理', required: true },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints).toEqual([
      { text: '每 N 字符切', required: true },
      { text: '需要调用量子退火算法完成预处理', required: false },
    ]);
  });

  it('repairs an all-optional rubric by promoting grounded core points', () => {
    const result = alignRubricToQuestion(
      methodStem,
      [
        { text: '每 N 字符切', required: false },
        { text: '快但易切断语义', required: false },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints[0]).toEqual({ text: '每 N 字符切', required: true });
    expect(result.keyPoints[1]!.required).toBe(false);
  });

  it('rejects a rubric with no groundable required point', () => {
    const result = alignRubricToQuestion(
      methodStem,
      [{ text: '需要调用量子退火算法完成预处理', required: true }],
      [SOURCE],
    );
    expect(result.ok).toBe(false);
  });

  it('deduplicates normalized points', () => {
    const result = alignRubricToQuestion(
      methodStem,
      [
        { text: '每 N 字符切', required: true },
        { text: '每N字符切。', required: true },
      ],
      [SOURCE],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.keyPoints).toHaveLength(1);
  });
});
