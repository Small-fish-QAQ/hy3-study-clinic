import { Buffer } from 'node:buffer';
import {
  ApiErrorCode,
  MAX_DOCUMENT_FILE_BYTES,
  type MediaType,
  type SourceType,
} from '@hy3-clinic/shared';
import { IngestionError, looksBinary, normalizeText, sanitizeParsedText } from './ingest.js';
import { analyzePdfLayout, type PdfPageInput, type PageSpan } from './pdfLayout.js';

export type { PageSpan } from './pdfLayout.js';

/**
 * Binary document extraction (PDF / DOCX) with provenance.
 *
 * Design rules (see docs/ARCHITECTURE.md):
 * - files are validated by extension AND magic bytes AND decoded size;
 * - extraction NEVER executes embedded content: unpdf (PDF.js) is used with
 *   scripting disabled semantics (text extraction only) and mammoth only
 *   reads document.xml — macros/scripts/media are ignored entirely;
 * - a parse that yields no usable text is a structured PARSE_FAILED error,
 *   never a silently-empty document;
 * - PDFs are NOT flattened to plain page text: positioned text items flow
 *   through the layout-aware reconstruction in pdfLayout.ts (line rebuild,
 *   repeated header/footer removal, heading recognition, visual-wrap repair,
 *   conservative table rows), which emits Markdown-style text plus exact
 *   per-page character spans;
 * - extracted text is conservatively sanitized (sanitizeParsedText) BEFORE
 *   page spans are computed, so extractor artifacts (e.g. U+0000 emitted for
 *   unmapped Chrome/Skia glyphs) never reach stored text; the raw-byte
 *   binary sniffer (looksBinary) applies to .md/.txt uploads only;
 * - per-page provenance is preserved for PDFs (page spans over the emitted
 *   text); PDF headings and DOCX headings survive as Markdown-style headings
 *   so the existing segmenter records heading paths;
 * - extraction warnings are collected and persisted, shown in the UI.
 */

export const PDF_PARSER_VERSION = 'pdf-layout-v2';
export const DOCX_PARSER_VERSION = 'docx-mammoth-v1';
export const TEXT_PARSER_VERSION = 'text-v1';

export interface ParsedBinaryDocument {
  /** Normalized text (LF endings) ready for segmentation. */
  content: string;
  pageCount: number | null;
  pageSpans: PageSpan[] | null;
  warnings: string[];
  parserVersion: string;
}

interface UploadKind {
  sourceType: SourceType;
  mediaType: MediaType;
}

const UPLOAD_EXTENSIONS: Record<string, UploadKind> = {
  md: { sourceType: 'md', mediaType: 'text/markdown' },
  markdown: { sourceType: 'md', mediaType: 'text/markdown' },
  txt: { sourceType: 'txt', mediaType: 'text/plain' },
  text: { sourceType: 'txt', mediaType: 'text/plain' },
  pdf: { sourceType: 'pdf', mediaType: 'application/pdf' },
  docx: {
    sourceType: 'docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
};

/** Resolve an uploaded filename to its source/media type, or throw 415. */
export function uploadKindForFilename(filename: string): UploadKind {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = match?.[1]?.toLowerCase();
  const kind = ext ? UPLOAD_EXTENSIONS[ext] : undefined;
  if (!kind) {
    throw new IngestionError(
      ApiErrorCode.UnsupportedFile,
      '不支持的文件类型:仅接受 .md、.txt、.pdf 与 .docx 文件。',
    );
  }
  return kind;
}

/** Decode + bound a base64 upload. Throws 413 when the decoded size exceeds the limit. */
export function decodeUpload(dataBase64: string): Buffer {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new IngestionError(ApiErrorCode.UnsupportedFile, '文件内容不是合法的 base64 编码。');
  }
  if (buffer.length === 0) {
    throw new IngestionError(ApiErrorCode.EmptySource, '上传的文件为空。');
  }
  if (buffer.length > MAX_DOCUMENT_FILE_BYTES) {
    throw new IngestionError(
      ApiErrorCode.SourceTooLarge,
      `文件过大(${buffer.length} 字节),上限为 ${MAX_DOCUMENT_FILE_BYTES} 字节。`,
    );
  }
  return buffer;
}

function hasPdfMagic(buffer: Buffer): boolean {
  // The PDF header must appear near the start (spec allows a small preamble).
  return buffer.subarray(0, 1024).includes('%PDF-');
}

function hasZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/** Parse a PDF into layout-reconstructed text with per-page spans. */
export async function parsePdf(buffer: Buffer): Promise<ParsedBinaryDocument> {
  if (!hasPdfMagic(buffer)) {
    throw new IngestionError(ApiErrorCode.ParseFailed, '文件不是有效的 PDF(缺少 PDF 文件头)。');
  }

  let totalPages: number;
  const pages: PdfPageInput[] = [];
  try {
    const { getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    totalPages = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string') continue;
        // transform = [a, b, c, d, e, f]; (e, f) is the baseline origin and
        // hypot(c, d) the effective font size in device space.
        const [, , c, d, e, f] = item.transform as number[];
        items.push({
          str: item.str,
          x: e ?? 0,
          y: f ?? 0,
          width: item.width,
          height: item.height,
          fontSize: Math.hypot(c ?? 0, d ?? 0),
        });
      }
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        items,
      });
    }
  } catch {
    throw new IngestionError(
      ApiErrorCode.ParseFailed,
      'PDF 解析失败:文件可能已损坏或使用了不支持的加密方式。',
    );
  }

  // Layout analysis sanitizes per reconstructed line (artifact glyphs never
  // reach emitted text), so spans index the exact stored text.
  const layout = analyzePdfLayout(pages);

  if (layout.text.trim().length === 0) {
    throw new IngestionError(
      ApiErrorCode.ParseFailed,
      'PDF 中没有可提取的文本(可能是纯扫描件;本产品未启用 OCR),已拒绝导入。',
    );
  }

  return {
    content: layout.text,
    pageCount: totalPages,
    pageSpans: layout.pageSpans,
    warnings: layout.warnings,
    parserVersion: PDF_PARSER_VERSION,
  };
}

/** Parse a DOCX into normalized Markdown-style text (headings preserved). */
export async function parseDocx(buffer: Buffer): Promise<ParsedBinaryDocument> {
  if (!hasZipMagic(buffer)) {
    throw new IngestionError(ApiErrorCode.ParseFailed, '文件不是有效的 DOCX(缺少 ZIP 文件头)。');
  }

  let html: string;
  const warnings: string[] = [];
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
    for (const message of result.messages.slice(0, 20)) {
      warnings.push(`DOCX 转换提示:${message.message}`.slice(0, 500));
    }
  } catch {
    throw new IngestionError(
      ApiErrorCode.ParseFailed,
      'DOCX 解析失败:文件可能已损坏或不是有效的 Word 文档。',
    );
  }

  const content = normalizeText(sanitizeParsedText(docxHtmlToText(html)));
  if (content.trim().length === 0) {
    throw new IngestionError(ApiErrorCode.ParseFailed, 'DOCX 中没有可提取的文本,已拒绝导入。');
  }

  return {
    content,
    pageCount: null, // DOCX has no fixed pagination before rendering.
    pageSpans: null,
    warnings,
    parserVersion: DOCX_PARSER_VERSION,
  };
}

/** Parse an uploaded binary file according to its resolved kind. */
export async function parseBinaryUpload(
  sourceType: SourceType,
  buffer: Buffer,
): Promise<ParsedBinaryDocument> {
  if (sourceType === 'pdf') return parsePdf(buffer);
  if (sourceType === 'docx') return parseDocx(buffer);
  // md / txt uploads arrive as decoded text files.
  const text = buffer.toString('utf8');
  if (looksBinary(text)) {
    throw new IngestionError(ApiErrorCode.BinaryInput, '检测到二进制或非文本内容,已拒绝导入。');
  }
  return {
    content: normalizeText(text),
    pageCount: null,
    pageSpans: null,
    warnings: [],
    parserVersion: TEXT_PARSER_VERSION,
  };
}

/**
 * Convert mammoth's constrained HTML output to Markdown-style plain text.
 *
 * Mammoth emits a small, machine-generated tag set (headings, paragraphs,
 * lists, tables, inline formatting) with entity-escaped text. This converter
 * maps headings to ATX Markdown headings (so heading provenance survives
 * segmentation), keeps paragraph boundaries, and strips inline tags. It is
 * deterministic and never interprets scripts or styles (mammoth emits none).
 */
export function docxHtmlToText(html: string): string {
  let text = html;
  // Headings → ATX markdown headings.
  for (let level = 1; level <= 6; level++) {
    const open = new RegExp(`<h${level}(?:\\s[^>]*)?>`, 'gi');
    text = text.replace(open, `\n\n${'#'.repeat(level)} `);
    text = text.replace(new RegExp(`</h${level}>`, 'gi'), '\n\n');
  }
  text = text
    .replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(?:p|ul|ol|table)>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remaining tags (p/ul/ol/table/tr/td/th opens, strong/em/a/…): drop.
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
