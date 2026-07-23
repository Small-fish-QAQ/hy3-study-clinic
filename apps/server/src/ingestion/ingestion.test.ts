import { describe, expect, it } from 'vitest';
import { SAMPLE_MATERIAL_CONTENT } from '@hy3-clinic/shared';
import {
  deriveTitle,
  ingestSource,
  IngestionError,
  looksBinary,
  MAX_SOURCE_CHARS,
  normalizeText,
  sanitizeParsedText,
  sourceTypeForFilename,
} from './ingest.js';
import { segmentContent, segmentMaterial } from './segment.js';

describe('normalizeText', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc');
  });

  it('strips a leading BOM', () => {
    expect(normalizeText('\ufeff# 标题')).toBe('# 标题');
  });

  it('trims trailing whitespace of the document', () => {
    expect(normalizeText('内容  \n\n')).toBe('内容');
  });
});

describe('looksBinary', () => {
  it('flags NUL bytes', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
  });

  it('flags dense control characters', () => {
    expect(looksBinary('a\u0001\u0002\u0003b')).toBe(true);
  });

  it('accepts normal Chinese markdown', () => {
    expect(looksBinary(SAMPLE_MATERIAL_CONTENT)).toBe(false);
  });
});

describe('sanitizeParsedText', () => {
  // Escape-free artifact constants (mirrors what extractors actually emit).
  const NUL = String.fromCharCode(0);

  it('removes NUL bullet artifacts while preserving the surrounding CJK text', () => {
    // Chrome/Skia PDFs map unmapped list-bullet glyphs to U+0000 (three per
    // bullet in the reported document) — exactly what unpdf then emits.
    expect(sanitizeParsedText(`${NUL}${NUL}${NUL} 知识过时(训练截止后的事不知)`)).toBe(
      ' 知识过时(训练截止后的事不知)',
    );
  });

  it('removes controls, DEL, C1, soft hyphens, stray BOMs and noncharacters', () => {
    const input = [
      'exam',
      String.fromCharCode(0xad), // soft hyphen inside a word
      'ple ',
      String.fromCharCode(0x01), // C0 control
      String.fromCharCode(0x7f), // DEL
      String.fromCharCode(0x92), // C1 control
      String.fromCharCode(0xfeff), // stray BOM
      String.fromCharCode(0xfdd0), // noncharacter
      String.fromCharCode(0xfffe), // U+FFFE
      String.fromCharCode(0xffff), // U+FFFF
      String.fromCodePoint(0x1fffe), // supplementary-plane noncharacter
      '终点',
    ].join('');
    expect(sanitizeParsedText(input)).toBe('example 终点');
  });

  it('normalizes line-break artifacts (FF, VT, NEL, LS, PS) to newlines', () => {
    const input = [
      '第一行',
      String.fromCharCode(0x0c),
      '第二行',
      String.fromCharCode(0x0b),
      '第三行',
      String.fromCharCode(0x85),
      '第四行',
      String.fromCharCode(0x2028),
      '第五行',
      String.fromCharCode(0x2029),
      '第六行',
    ].join('');
    expect(sanitizeParsedText(input)).toBe('第一行\n第二行\n第三行\n第四行\n第五行\n第六行');
  });

  it('drops unpaired surrogate halves but keeps valid emoji and ZWJ sequences', () => {
    const loneHigh = String.fromCharCode(0xd83d);
    const loneLow = String.fromCharCode(0xde00);
    expect(sanitizeParsedText(`前${loneHigh}后${loneLow}续 😀 👨‍👩‍👧`)).toBe('前后续 😀 👨‍👩‍👧');
  });

  it('keeps tabs, newlines, CR, NBSP and punctuation unchanged', () => {
    const text = `甲\t乙\n丙\r丁${String.fromCharCode(0xa0)}— "引号",句号。`;
    expect(sanitizeParsedText(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = sanitizeParsedText(`a${String.fromCharCode(0)}b${String.fromCharCode(0x0c)}c`);
    expect(once).toBe('ab\nc');
    expect(sanitizeParsedText(once)).toBe(once);
  });
});

describe('sourceTypeForFilename', () => {
  it('accepts .md and .txt (case-insensitive)', () => {
    expect(sourceTypeForFilename('notes.md')).toBe('md');
    expect(sourceTypeForFilename('NOTES.TXT')).toBe('txt');
    expect(sourceTypeForFilename('a.markdown')).toBe('md');
  });

  it('rejects unsupported extensions', () => {
    for (const name of ['file.pdf', 'file.docx', 'file.png', 'file', 'file.md.exe']) {
      expect(() => sourceTypeForFilename(name)).toThrowError(IngestionError);
    }
  });
});

describe('ingestSource', () => {
  it('rejects empty input', () => {
    expect(() => ingestSource('', { sourceType: 'paste' })).toThrowError(/为空/);
    expect(() => ingestSource('   \n\n  ', { sourceType: 'paste' })).toThrowError(/为空/);
  });

  it('rejects oversized input', () => {
    const big = '学'.repeat(MAX_SOURCE_CHARS + 1);
    expect(() => ingestSource(big, { sourceType: 'paste' })).toThrowError(/过长/);
  });

  it('rejects binary input', () => {
    expect(() => ingestSource('PK\u0000\u0003\u0004', { sourceType: 'txt' })).toThrowError(
      /二进制/,
    );
  });

  it('returns normalized content and char count', () => {
    const result = ingestSource('第一行\r\n第二行\r\n', { sourceType: 'paste' });
    expect(result.content).toBe('第一行\n第二行');
    expect(result.charCount).toBe(7);
  });

  it('keeps raw binary detection strict for every raw text source type', () => {
    const junk = `PK${String.fromCharCode(0)}${String.fromCharCode(3)}${String.fromCharCode(4)}`;
    for (const sourceType of ['paste', 'md', 'txt'] as const) {
      expect(() => ingestSource(junk, { sourceType })).toThrowError(/二进制/);
    }
  });

  it('does not run the raw-bytes binary sniffer on parsed PDF/DOCX content', () => {
    // PDF/DOCX content reaches ingestSource as parser output that was already
    // cleaned by sanitizeParsedText; the shared size/emptiness limits still
    // apply, but the raw-byte sniff must not reject valid parsed documents.
    const parsed = '知识过时 memory retrieval 😀';
    expect(ingestSource(parsed, { sourceType: 'pdf' }).content).toBe(parsed);
    expect(ingestSource(parsed, { sourceType: 'docx' }).content).toBe(parsed);
    expect(() => ingestSource('', { sourceType: 'pdf' })).toThrowError(/为空/);
    expect(() =>
      ingestSource('学'.repeat(MAX_SOURCE_CHARS + 1), { sourceType: 'pdf' }),
    ).toThrowError(/过长/);
  });
});

describe('deriveTitle', () => {
  it('uses the first heading when present', () => {
    expect(deriveTitle('# 认知科学入门\n\n正文')).toBe('认知科学入门');
  });

  it('falls back to the first non-empty line', () => {
    expect(deriveTitle('\n\n这是第一段。\n后续')).toBe('这是第一段。');
  });
});

describe('segmentContent', () => {
  it('segments markdown into paragraph blocks with heading paths', () => {
    const doc = '# 甲\n\n第一段。\n\n## 乙\n\n第二段。\n第二段续行。\n\n第三段。';
    const segments = segmentContent(doc);
    expect(segments).toHaveLength(3);

    expect(segments[0]).toMatchObject({
      heading: '甲',
      headingPath: ['甲'],
      content: '第一段。',
    });
    expect(segments[1]).toMatchObject({
      heading: '乙',
      headingPath: ['甲', '乙'],
      content: '第二段。\n第二段续行。',
    });
    expect(segments[2]).toMatchObject({ heading: '乙', content: '第三段。' });
  });

  it('treats text before the first heading as preamble with no heading', () => {
    const doc = '开场白段落。\n\n# 标题\n\n正文。';
    const segments = segmentContent(doc);
    expect(segments[0]).toMatchObject({ heading: null, headingPath: [], content: '开场白段落。' });
    expect(segments[1]).toMatchObject({ heading: '标题', content: '正文。' });
  });

  it('handles plain text without headings', () => {
    const doc = '第一段。\n\n第二段。';
    const segments = segmentContent(doc);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.heading === null)).toBe(true);
  });

  it('pops the heading stack when a sibling heading appears', () => {
    const doc = '## 一\n\nA\n\n### 一点一\n\nB\n\n## 二\n\nC';
    const segments = segmentContent(doc);
    expect(segments[0]?.headingPath).toEqual(['一']);
    expect(segments[1]?.headingPath).toEqual(['一', '一点一']);
    expect(segments[2]?.headingPath).toEqual(['二']);
  });

  it('satisfies the slice invariant, including with astral characters', () => {
    const doc = '前言 𝐀𝐁 emoji 🎓 测试。\n\n# 标题\n\n正文包含 😀 表情。\n下一行。';
    for (const seg of segmentContent(doc)) {
      expect(doc.slice(seg.startOffset, seg.endOffset)).toBe(seg.content);
    }
  });

  it('satisfies the slice invariant on the whole sample material', () => {
    const content = SAMPLE_MATERIAL_CONTENT.replace(/\r\n?/g, '\n');
    const segments = segmentContent(content);
    expect(segments.length).toBeGreaterThan(5);
    for (const seg of segments) {
      expect(content.slice(seg.startOffset, seg.endOffset)).toBe(seg.content);
    }
  });
});

describe('segmentMaterial', () => {
  it('is deterministic: identical input produces identical blocks and ids', () => {
    const a = segmentMaterial('mat_x', SAMPLE_MATERIAL_CONTENT);
    const b = segmentMaterial('mat_x', SAMPLE_MATERIAL_CONTENT);
    expect(a).toEqual(b);
  });

  it('assigns consecutive indexes and unique ids', () => {
    const blocks = segmentMaterial('mat_x', SAMPLE_MATERIAL_CONTENT);
    blocks.forEach((block, i) => expect(block.index).toBe(i));
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  it('rejects documents with no body paragraphs', () => {
    expect(() => segmentMaterial('mat_x', '# 只有标题\n\n## 另一个标题')).toThrowError(/正文/);
  });
});
