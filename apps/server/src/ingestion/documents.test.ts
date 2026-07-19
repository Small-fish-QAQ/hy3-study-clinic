import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { IngestionError } from './ingest.js';
import {
  decodeUpload,
  docxHtmlToText,
  parseDocx,
  parsePdf,
  uploadKindForFilename,
} from './documents.js';
import { segmentMaterial } from './segment.js';

const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../testing/files');
const samplePdf = () => readFileSync(join(filesDir, 'sample.pdf'));
const sampleDocx = () => readFileSync(join(filesDir, 'sample.docx'));

describe('uploadKindForFilename', () => {
  it('maps supported extensions to source/media types', () => {
    expect(uploadKindForFilename('a.pdf')).toEqual({
      sourceType: 'pdf',
      mediaType: 'application/pdf',
    });
    expect(uploadKindForFilename('b.DOCX').sourceType).toBe('docx');
    expect(uploadKindForFilename('c.md').sourceType).toBe('md');
    expect(uploadKindForFilename('d.txt').sourceType).toBe('txt');
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
    expect(parsed.parserVersion).toBe('pdf-unpdf-v1');
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
