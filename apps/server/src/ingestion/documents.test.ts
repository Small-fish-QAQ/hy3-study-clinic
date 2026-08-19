import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import {
  decodeUpload,
  docxHtmlToText,
  parseBinaryUpload,
  parseDocx,
  parsePdf,
  uploadKindForFilename,
  validateUploadDeclaration,
} from './documents.js';
import { segmentMaterial } from './segment.js';

const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../testing/files');
const samplePdf = () => readFileSync(join(filesDir, 'sample.pdf'));
const sampleDocx = () => readFileSync(join(filesDir, 'sample.docx'));
const artifactsPdf = () => readFileSync(join(filesDir, 'artifacts.pdf'));
const layoutPdf = () => readFileSync(join(filesDir, 'layout.pdf'));

describe('uploadKindForFilename', () => {
  it('maps supported extensions to source/media types', () => {
    expect(uploadKindForFilename('a.pdf')).toEqual({
      sourceType: 'pdf',
      mediaType: 'application/pdf',
    });
    expect(uploadKindForFilename('b.DOCX').sourceType).toBe('docx');
    expect(uploadKindForFilename('c.md').sourceType).toBe('md');
    expect(uploadKindForFilename('d.txt').sourceType).toBe('txt');
    expect(uploadKindForFilename('e.ts')).toEqual({
      sourceType: 'source_code',
      mediaType: 'text/x-source-code',
    });
  });

  it('rejects unsupported extensions with a 415 error code', () => {
    for (const name of ['e.doc', 'f.exe', 'g', 'h.pptx']) {
      try {
        uploadKindForFilename(name);
        expect.unreachable(`${name} should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(IngestionError);
        expect((error as IngestionError).code).toBe(ApiErrorCode.UnsupportedFile);
      }
    }
  });
});

describe('decodeUpload', () => {
  it('decodes base64 and rejects empty payloads', () => {
    expect(decodeUpload(Buffer.from('hello').toString('base64')).toString()).toBe('hello');
    expect(() => decodeUpload('')).toThrowError(IngestionError);
  });

  it('rejects oversized decoded payloads with SOURCE_TOO_LARGE', () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    try {
      decodeUpload(big);
      expect.unreachable();
    } catch (error) {
      expect((error as IngestionError).code).toBe(ApiErrorCode.SourceTooLarge);
    }
  });

  it('rejects malformed base64 instead of silently discarding bytes', () => {
    for (const value of ['not base64!', 'ab=c', 'abcde', 'abcd===', 'abcd$']) {
      expect(() => decodeUpload(value)).toThrowError(IngestionError);
    }
  });

  it('rejects a declared MIME that disagrees with the filename', () => {
    expect(() =>
      validateUploadDeclaration(uploadKindForFilename('notes.md'), 'text/plain'),
    ).toThrow(/MIME/);
  });
});

describe('parsePdf', () => {
  it('extracts per-page text with page provenance', async () => {
    const parsed = await parsePdf(samplePdf());
    expect(parsed.pageCount).toBe(2);
    expect(parsed.content).toContain('Working memory has a very limited capacity.');
    expect(parsed.content).toContain('Spaced repetition improves long-term retention.');
    expect(parsed.pageSpans).toHaveLength(2);
    // Page spans must slice back to the page text exactly.
    for (const span of parsed.pageSpans!) {
      const text = parsed.content.slice(span.startOffset, span.endOffset);
      expect(text.length).toBeGreaterThan(0);
      expect(parsed.content).toContain(text);
    }
    // Version bumped with the layout-aware PDF pipeline (v2) so reprocessing
    // can distinguish documents extracted by the old flattening parser.
    expect(parsed.parserVersion).toBe('pdf-layout-v2');
  });

  it('assigns page numbers to segmented blocks', async () => {
    const parsed = await parsePdf(samplePdf());
    const blocks = segmentMaterial('mat_pdf', parsed.content, {
      pageSpans: parsed.pageSpans!,
    });
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0]!.pageNumber).toBe(1);
    expect(blocks[blocks.length - 1]!.pageNumber).toBe(2);
    // Offset invariant is preserved for paginated sources too.
    for (const block of blocks) {
      expect(parsed.content.slice(block.startOffset, block.endOffset)).toBe(block.content);
    }
  });

  it('rejects a file without a PDF header', async () => {
    await expect(parsePdf(Buffer.from('not a pdf at all'))).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects a malformed PDF instead of storing an empty document', async () => {
    const malformed = readFileSync(join(filesDir, 'malformed.pdf'));
    await expect(parsePdf(malformed)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('sanitizes Chrome/Skia extraction artifacts (ToUnicode → U+0000) with exact provenance', async () => {
    // artifacts.pdf is a self-authored fixture replicating the structure of
    // the real-world failure (Weknora学习(2).pdf): a Type0/Identity-H
    // composite font whose ToUnicode CMap maps bullet glyph CIDs to <0000>,
    // so unpdf emits NUL characters inside valid Chinese text.
    const parsed = await parsePdf(artifactsPdf());
    expect(parsed.pageCount).toBe(2);
    expect(parsed.warnings).toEqual([]);

    // Useful text survives: CJK, latin and emoji.
    expect(parsed.content).toContain('知识');
    expect(parsed.content).toContain('memory retrieval');
    expect(parsed.content).toContain('😀');
    expect(parsed.content).toContain('过时');
    expect(parsed.content).toContain('example');

    // Extractor artifacts never reach parsed content.
    expect(parsed.content).not.toContain(String.fromCharCode(0));
    expect(parsed.content).not.toContain(String.fromCharCode(0xad));

    // Page spans are computed over the SANITIZED text and stay exact.
    expect(parsed.pageSpans).toHaveLength(2);
    const [span1, span2] = parsed.pageSpans!;
    const page1 = parsed.content.slice(span1!.startOffset, span1!.endOffset);
    const page2 = parsed.content.slice(span2!.startOffset, span2!.endOffset);
    expect(page1).toContain('知识');
    expect(page1).not.toContain('过时');
    expect(page2).toContain('example');

    const blocks = segmentMaterial('mat_artifacts', parsed.content, {
      pageSpans: parsed.pageSpans!,
    });
    expect(blocks[0]!.pageNumber).toBe(1);
    expect(blocks[blocks.length - 1]!.pageNumber).toBe(2);
    for (const block of blocks) {
      expect(parsed.content.slice(block.startOffset, block.endOffset)).toBe(block.content);
      expect(block.content).not.toContain(String.fromCharCode(0));
    }
  });
});

describe('parsePdf: layout reconstruction (layout.pdf fixture)', () => {
  // layout.pdf (regenerated by scripts/generate-test-fixtures.mjs) carries
  // font-size-tiered headings, repeated page-counter footers, wrapped
  // paragraphs (one hyphenated, one crossing a page break), and an aligned
  // two-column table — the regression class behind flattened PDF imports.
  it('removes repeated footers and recognizes heading tiers', async () => {
    const parsed = await parsePdf(layoutPdf());
    expect(parsed.pageCount).toBe(3);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.content).not.toContain('Study Notes');
    expect(parsed.content).toContain('# Chapter One');
    expect(parsed.content).toContain('## Detail Section');
  });

  it('repairs visual wraps including hyphenation', async () => {
    const parsed = await parsePdf(layoutPdf());
    expect(parsed.content).toContain('this basic limit shapes how people study.');
    expect(parsed.content).toContain('would truly forget the studied material.');
    // The authored single-line paragraph stays its own paragraph.
    expect(parsed.content).toContain('\n\nReviews should therefore come in short spaced sessions.');
  });

  it('renders aligned table rows conservatively', async () => {
    const parsed = await parsePdf(layoutPdf());
    expect(parsed.content).toContain('Method | Speed\nFlat | slow\nGraph | fast');
  });

  it('joins a paragraph across the page break with exact page-range provenance', async () => {
    const parsed = await parsePdf(layoutPdf());
    expect(parsed.content).toContain('passive review because the act of recall');

    const blocks = segmentMaterial('mat_layout', parsed.content, {
      pageSpans: parsed.pageSpans!,
    });
    for (const block of blocks) {
      expect(parsed.content.slice(block.startOffset, block.endOffset)).toBe(block.content);
    }
    const spanning = blocks.find((b) => b.content.includes('passive review'))!;
    expect(spanning.pageNumber).toBe(2);
    expect(spanning.pageEnd).toBe(3);

    // Multiple sections on one page keep distinct heading provenance.
    const page1Headings = new Set(blocks.filter((b) => b.pageNumber === 1).map((b) => b.heading));
    expect(page1Headings.has('Chapter One')).toBe(true);
    expect(page1Headings.has('Detail Section')).toBe(true);
    // No block is left without a heading path in this structured document.
    expect(blocks.every((b) => b.headingPath.length > 0)).toBe(true);
  });

  it('emits text that survives ingestion normalization unchanged (offset safety)', async () => {
    const parsed = await parsePdf(layoutPdf());
    const { ingestSource } = await import('./ingest.js');
    expect(ingestSource(parsed.content, { sourceType: 'pdf' }).content).toBe(parsed.content);
  });
});

describe('parseBinaryUpload (text branch)', () => {
  it('keeps raw binary detection strict for .md/.txt uploads', async () => {
    const junk = Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04, 0x00, 0x01, 0x02]);
    for (const sourceType of ['md', 'txt'] as const) {
      await expect(parseBinaryUpload(sourceType, junk)).rejects.toMatchObject({
        code: ApiErrorCode.BinaryInput,
      });
    }
  });

  it('rejects a rich-document signature under a source-code extension', async () => {
    await expect(parseBinaryUpload('source_code', Buffer.from('%PDF-1.7'))).rejects.toMatchObject({
      code: ApiErrorCode.TypeMismatch,
    });
  });
});

describe('parseDocx', () => {
  it('extracts text with Markdown-style headings for section provenance', async () => {
    const parsed = await parseDocx(sampleDocx());
    expect(parsed.content).toContain('# 记忆的科学');
    expect(parsed.content).toContain('## 间隔重复');
    expect(parsed.content).toContain('工作记忆的容量十分有限');
    expect(parsed.pageCount).toBeNull();
    expect(parsed.parserVersion).toBe('docx-mammoth-v1');

    const blocks = segmentMaterial('mat_docx', parsed.content);
    const headed = blocks.find((b) => b.heading === '间隔重复');
    expect(headed).toBeDefined();
    expect(headed!.headingPath).toEqual(['记忆的科学', '间隔重复']);
  });

  it('rejects a non-zip payload', async () => {
    await expect(parseDocx(Buffer.from('plain text file'))).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });

  it('rejects a corrupt zip container', async () => {
    const malformed = readFileSync(join(filesDir, 'malformed.docx'));
    await expect(parseDocx(malformed)).rejects.toMatchObject({
      code: ApiErrorCode.ParseFailed,
    });
  });
});

describe('docxHtmlToText', () => {
  it('converts headings, paragraphs, lists and entities deterministically', () => {
    const html =
      '<h1>标题一</h1><p>第一段包含 <strong>加粗</strong> 与 &amp; 符号。</p>' +
      '<h2>标题二</h2><ul><li>要点甲</li><li>要点乙</li></ul><p>A &lt; B &#x4e14; C &#22823;。</p>';
    const text = docxHtmlToText(html);
    expect(text).toContain('# 标题一');
    expect(text).toContain('## 标题二');
    expect(text).toContain('第一段包含 加粗 与 & 符号。');
    expect(text).toContain('- 要点甲');
    expect(text).toContain('A < B 且 C 大。');
    expect(docxHtmlToText(html)).toBe(text);
  });
});
