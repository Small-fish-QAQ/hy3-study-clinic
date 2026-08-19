import { describe, expect, it } from 'vitest';
import {
  analyzePdfLayout,
  normalizeExtractedGlyphs,
  reconstructLines,
  type PdfPageInput,
  type PdfTextItem,
} from './pdfLayout.js';
import { segmentMaterial } from './segment.js';

/**
 * Layout-engine tests built on synthetic positioned items (no PDF bytes, no
 * private content). Geometry mirrors the real-world document class the
 * pipeline targets: y-up coordinates, ~18pt wrap pitch and ~26pt paragraph
 * spacing at 12pt body text, headers/footers inside the 10% margin bands.
 */

const NUL = String.fromCharCode(0);
const PAGE_W = 600;
const PAGE_H = 800;

/** Rough glyph-width model: CJK ≈ 1em, Latin ≈ 0.5em. */
function textWidth(str: string, size: number): number {
  let width = 0;
  for (const char of str) {
    width += (char.codePointAt(0) ?? 0) > 0x2e7f ? size : size * 0.5;
  }
  return width;
}

function item(
  str: string,
  x: number,
  y: number,
  size = 12,
  width = textWidth(str, size),
): PdfTextItem {
  return { str, x, y, width, height: size, fontSize: size };
}

/** One full-line item; `full` pads the width so x1 reaches the right margin. */
function line(str: string, y: number, opts: { x?: number; size?: number; full?: boolean } = {}) {
  const x = opts.x ?? 50;
  const size = opts.size ?? 12;
  const width = opts.full ? 550 - x : textWidth(str, size);
  return item(str, x, y, size, width);
}

function page(pageNumber: number, items: PdfTextItem[]): PdfPageInput {
  return { pageNumber, width: PAGE_W, height: PAGE_H, items };
}

/** Three-page document exercising every classification stage at once. */
function buildSyntheticDoc(): PdfPageInput[] {
  return [
    page(1, [
      line('课程讲义', 790, { size: 9 }), // repeated header (margin band)
      line('第一章 总论', 740, { size: 24 }), // h1 (top band, size-protected)
      line('深度学习模型的训练需要大量的标注数据与计算资', 700, { full: true }),
      line('源这一事实早已成为共识还需要更多语料来', 682, { full: true }),
      line('支撑模型能力。', 664),
      line('这是第二个独立的段落。', 638),
      line('细节小节', 600, { size: 16 }), // h2
      line('Neural networks require large amounts of la-', 560, { full: true }),
      line('beled data for supervised training.', 542),
      // NUL bullet list (Chrome/Skia ToUnicode <0000> markers)
      item(NUL, 50, 500, 12, 8),
      item('第一个要点内容', 66, 500),
      item(NUL, 50, 474, 12, 8),
      item('第二个要点内容', 66, 474),
      line('课程讲义 1', 30, { size: 9 }), // footer with page counter
    ]),
    page(2, [
      line('课程讲义', 790, { size: 9 }),
      // Conservative table: aligned two-column rows
      item('方法', 50, 700),
      item('特点', 300, 700),
      item('暴力扫描', 50, 674),
      item('结果精确', 300, 674),
      item('近似索引', 50, 648),
      item('速度更快', 300, 648),
      // Paragraph that must continue on page 3
      line('跨页的段落在这一页已经放不下了需要延续到下页', 110, { full: true }),
      line('课程讲义 2', 30, { size: 9 }),
    ]),
    page(3, [
      line('课程讲义', 790, { size: 9 }),
      line('下一页的开头行完成了这个句子。', 740),
      line('课程讲义 3', 30, { size: 9 }),
    ]),
  ];
}

describe('normalizeExtractedGlyphs', () => {
  it('maps Kangxi radicals and supplement radicals to unified ideographs', () => {
    expect(normalizeExtractedGlyphs('⼀个⼈的⽂本')).toBe('一个人的文本');
    expect(normalizeExtractedGlyphs('⻚⾯与⻛格')).toBe('页面与风格');
  });

  it('leaves ordinary CJK, Latin, and emoji untouched', () => {
    const text = '普通中文 English 😀 一二三';
    expect(normalizeExtractedGlyphs(text)).toBe(text);
  });
});

describe('reconstructLines', () => {
  it('groups items into baseline lines in top-to-bottom order', () => {
    const lines = reconstructLines(
      page(1, [
        item('下面一行', 50, 100),
        item('上面', 50, 200),
        item('一行', 74, 200.5), // sub-tolerance baseline jitter joins the line
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(['上面一行', '下面一行']);
  });

  it('restores reading order when the content stream is shuffled', () => {
    const items = [item('前半', 50, 100), item('后半', 74, 100)];
    const shuffled = [...items].reverse();
    expect(reconstructLines(page(1, shuffled))[0]!.text).toBe('前半后半');
  });

  it('inserts spaces at Latin word gaps but not inside CJK runs', () => {
    const lines = reconstructLines(
      page(1, [
        item('word', 50, 100, 12, 24),
        item('next', 80, 100, 12, 24), // 6pt gap at size 12 → space
        item('中文', 110, 100, 12, 24),
        item('接排', 136, 100, 12, 24), // 2pt gap between CJK → no space
      ]),
    );
    expect(lines[0]!.text).toBe('word next 中文接排');
  });

  it('captures NUL marker glyphs as list evidence instead of text', () => {
    const lines = reconstructLines(page(1, [item(NUL, 50, 100, 12, 8), item('要点', 66, 100)]));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.hasListMarker).toBe(true);
    expect(lines[0]!.text).toBe('要点');
  });

  it('splits large horizontal gaps into cell fragments', () => {
    const lines = reconstructLines(page(1, [item('甲', 50, 100), item('乙', 300, 100)]));
    expect(lines[0]!.cells).toHaveLength(2);
    expect(lines[0]!.text).toBe('甲 乙');
  });

  it('removes control characters and radical substitutions from line text', () => {
    const raw = `排${NUL}除⼲扰项${String.fromCharCode(0x7f)}`;
    const lines = reconstructLines(page(1, [item(raw, 50, 100)]));
    expect(lines[0]!.text).toBe('排除干扰项');
  });
});

describe('analyzePdfLayout: structure', () => {
  const result = analyzePdfLayout(buildSyntheticDoc());

  it('removes repeated headers and page-counter footers on every page', () => {
    expect(result.text).not.toContain('课程讲义');
    expect(result.warnings).toEqual([]);
  });

  it('emits font-size-ranked ATX headings', () => {
    expect(result.text).toContain('# 第一章 总论');
    expect(result.text).toContain('## 细节小节');
  });

  it('repairs CJK visual wraps without inserting spaces', () => {
    expect(result.text).toContain('计算资源这一事实');
    expect(result.text).toContain('语料来支撑模型能力。');
  });

  it('keeps authored paragraph boundaries', () => {
    expect(result.text).toContain('\n\n这是第二个独立的段落。\n\n');
  });

  it('dehyphenates Latin wraps and joins with the following word', () => {
    expect(result.text).toContain('amounts of labeled data');
  });

  it('recovers NUL-marker bullets as one contiguous list block', () => {
    expect(result.text).toContain('- 第一个要点内容\n- 第二个要点内容');
  });

  it('renders aligned table rows with cell separators, one block per table', () => {
    expect(result.text).toContain('方法 | 特点\n暴力扫描 | 结果精确\n近似索引 | 速度更快');
  });

  it('joins a paragraph across the page break over the removed footer', () => {
    expect(result.text).toContain('需要延续到下页下一页的开头行完成了这个句子。');
  });

  it('is deterministic', () => {
    expect(analyzePdfLayout(buildSyntheticDoc())).toEqual(result);
  });
});

describe('analyzePdfLayout: provenance', () => {
  const result = analyzePdfLayout(buildSyntheticDoc());

  it('produces one exact span per contributing page', () => {
    expect(result.pageSpans.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
    for (const span of result.pageSpans) {
      expect(span.startOffset).toBeLessThan(span.endOffset);
      expect(result.text.slice(span.startOffset, span.endOffset).trim().length).toBeGreaterThan(0);
    }
    // Spans are ordered and non-overlapping.
    for (let i = 1; i < result.pageSpans.length; i++) {
      expect(result.pageSpans[i]!.startOffset).toBeGreaterThanOrEqual(
        result.pageSpans[i - 1]!.endOffset,
      );
    }
  });

  it('gives blocks heading paths, exact offsets, and page ranges', () => {
    const blocks = segmentMaterial('mat_layout', result.text, { pageSpans: result.pageSpans });
    for (const block of blocks) {
      expect(result.text.slice(block.startOffset, block.endOffset)).toBe(block.content);
    }

    // Multiple sections on one page.
    const page1Headings = new Set(blocks.filter((b) => b.pageNumber === 1).map((b) => b.heading));
    expect(page1Headings.has('第一章 总论')).toBe(true);
    expect(page1Headings.has('细节小节')).toBe(true);

    // Single-page block: pageEnd equals pageNumber.
    const single = blocks.find((b) => b.content.includes('第二个独立的段落'))!;
    expect(single.pageNumber).toBe(1);
    expect(single.pageEnd).toBe(1);

    // The repaired cross-page paragraph records its full page range.
    const spanning = blocks.find((b) => b.content.includes('需要延续到下页'))!;
    expect(spanning.pageNumber).toBe(2);
    expect(spanning.pageEnd).toBe(3);
  });
});

describe('analyzePdfLayout: conservatism', () => {
  it('does not join short authored lines even at wrap pitch', () => {
    const result = analyzePdfLayout([
      page(1, [
        line('工程流程：', 700),
        line('第一步是准备数据', 682),
        line('第二步是训练模型', 664),
      ]),
    ]);
    expect(result.text).toBe('工程流程：\n\n第一步是准备数据\n\n第二步是训练模型');
  });

  it('joins a short line when the successor could not have fit (kinsoku)', () => {
    const pages = [
      page(1, [
        // Ends ~25pt short of the margin, but the closer run 维）。 (3 ems)
        // could not fit — renderer break, so it must be repaired.
        line('常见的向量维度包括这样一些不同的数值规格如某', 700, { full: true }),
        item('接近五百一十二维的和其他更高维度可选值的这维', 50, 682, 12, 475),
        line('维）。', 664),
        line('后续独立段落。', 638),
        // Extra body pairs so pitch detection has enough evidence.
        line('第二段落的第一行内容足够长可以到达页面边界处', 600, { full: true }),
        line('并在此处换行以便测量。', 582),
        line('第三段落的第一行内容足够长可以到达页面边界处', 556, { full: true }),
        line('并在此处继续换行测量。', 538),
      ]),
    ];
    const result = analyzePdfLayout(pages);
    expect(result.text).toContain('这维维）。');
    expect(result.text).toContain('\n\n后续独立段落。');
  });

  it('does not remove content that repeats mid-page (outside margin bands)', () => {
    const pages = [1, 2, 3, 4].map((n) =>
      page(n, [
        line(`第 ${n} 节标题内容`, 700, { size: 16 }),
        line('重要提示:本节内容需要结合练习理解。', 400),
        line('每一页中部都有这句重复的免责声明文字。', 382),
      ]),
    );
    const result = analyzePdfLayout(pages);
    expect(result.text).toContain('每一页中部都有这句重复的免责声明文字。');
  });

  it('removes bare page-number lines in the margin band across pages', () => {
    const pages = [1, 2, 3].map((n) =>
      page(n, [line(`第 ${n} 页的正文内容各不相同。`, 400), line(`${n}`, 30, { size: 9 })]),
    );
    const result = analyzePdfLayout(pages);
    expect(result.text).not.toMatch(/^\d$/m);
    expect(result.text).toContain('第 2 页的正文内容各不相同。');
  });

  it('keeps two-page documents intact (repetition threshold not met)', () => {
    const pages = [1, 2].map((n) =>
      page(n, [line('页脚一样的文字', 30, { size: 9 }), line(`第 ${n} 页正文。`, 400)]),
    );
    const result = analyzePdfLayout(pages);
    expect(result.text).toContain('页脚一样的文字');
  });

  it('falls back to readable lines when table gaps do not align', () => {
    const result = analyzePdfLayout([
      page(1, [
        item('甲列', 50, 700),
        item('乙列', 300, 700),
        item('丙内容', 50, 674),
        item('丁内容', 420, 674), // misaligned boundary → no stable column
      ]),
    ]);
    expect(result.text).not.toContain('|');
    expect(result.text).toContain('甲列 乙列');
    expect(result.text).toContain('丙内容 丁内容');
  });

  it('warns for pages without extractable text', () => {
    const result = analyzePdfLayout([page(1, [line('唯一有内容的页面。', 400)]), page(2, [])]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('第 2 页');
    expect(result.pageSpans.map((s) => s.pageNumber)).toEqual([1, 2]);
    expect(result.pageSpans[1]!.startOffset).toBe(result.pageSpans[1]!.endOffset);
  });

  it('warns without inventing order for rotated and likely multi-column text', () => {
    const result = analyzePdfLayout([
      page(1, [
        { ...item('Rotated note', 40, 760), rotated: true },
        item('A long sentence in the left column', 40, 700),
        item('A long sentence in the right column', 330, 700),
        item('Another substantial left-column line', 40, 670),
        item('Another substantial right-column line', 330, 670),
        item('A third substantial left-column line', 40, 640),
        item('A third substantial right-column line', 330, 640),
      ]),
    ]);

    expect(result.warnings.some((warning) => warning.includes('旋转'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('多栏'))).toBe(true);
  });
});
