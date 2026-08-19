import { Buffer } from 'node:buffer';
import {
  ApiErrorCode,
  MAX_DOCUMENT_FILE_BYTES,
  type MediaType,
  type SourceType,
} from '@hy3-clinic/shared';
import { IngestionError, looksBinary, normalizeText, sanitizeParsedText } from './ingest.js';
import { analyzePdfLayout, type PdfPageInput, type PageSpan } from './pdfLayout.js';
import { parseRichOoxml, type ExtractedEmbeddedAsset } from './richDocuments.js';
import type { NormalizedDocument } from '@hy3-clinic/shared';
import { parseStandaloneImage } from './images.js';
import { HTML_PARSER_VERSION, parseHtmlBytes } from './html.js';

export type { PageSpan } from './pdfLayout.js';

/**
 * File upload extraction (Markdown / TXT / PDF / DOCX) with provenance.
 *
 * Design rules (see docs/ARCHITECTURE.md):
 * - all file uploads are validated by supported extension and decoded size;
 *   PDF/DOCX also require matching magic bytes, while text files are
 *   binary-sniffed;
 * - extraction never executes document code: unpdf (PDF.js) is used for text
 *   extraction, while Mammoth's HTML output is converted to text and embedded
 *   image output is discarded;
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
  normalizedDocument?: NormalizedDocument;
  embeddedAssets?: ExtractedEmbeddedAsset[];
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
  pptx: {
    sourceType: 'pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  png: { sourceType: 'image', mediaType: 'image/png' },
  jpg: { sourceType: 'image', mediaType: 'image/jpeg' },
  jpeg: { sourceType: 'image', mediaType: 'image/jpeg' },
  webp: { sourceType: 'image', mediaType: 'image/webp' },
  html: { sourceType: 'html', mediaType: 'text/html' },
  htm: { sourceType: 'html', mediaType: 'text/html' },
};

for (const extension of [
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'bash',
  'zsh',
  'sql',
  'json',
  'yaml',
  'yml',
]) {
  UPLOAD_EXTENSIONS[extension] = { sourceType: 'source_code', mediaType: 'text/x-source-code' };
}

/** Resolve an uploaded filename to its source/media type, or throw 415. */
export function uploadKindForFilename(filename: string): UploadKind {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = match?.[1]?.toLowerCase();
  const kind = ext ? UPLOAD_EXTENSIONS[ext] : undefined;
  if (!kind) {
    throw new IngestionError(
      ApiErrorCode.UnsupportedFile,
      '不支持的文件类型:仅接受 .md、.txt、.pdf、.docx、.pptx 与常见源代码文件。',
    );
  }
  return kind;
}

/** Validate an optional declared MIME against the filename-resolved contract. */
export function validateUploadDeclaration(kind: UploadKind, declaredMediaType?: MediaType): void {
  if (declaredMediaType && declaredMediaType !== kind.mediaType) {
    throw new IngestionError(
      ApiErrorCode.TypeMismatch,
      `文件扩展名与声明的 MIME 类型不匹配:${kind.mediaType} != ${declaredMediaType}。`,
    );
  }
}

/** Decode + bound a base64 upload. Throws 413 when the decoded size exceeds the limit. */
export function decodeUpload(dataBase64: string): Buffer {
  const compact = dataBase64.trim();
  const firstPadding = compact.indexOf('=');
  const paddingLength = firstPadding < 0 ? 0 : compact.length - firstPadding;
  let alphabetValid = compact.length > 0 && compact.length % 4 !== 1;
  for (let index = 0; index < compact.length && alphabetValid; index += 1) {
    const code = compact.charCodeAt(index);
    const isAlphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (index < (firstPadding < 0 ? compact.length : firstPadding)) {
      if (!isAlphabet) alphabetValid = false;
    } else if (code !== 0x3d) {
      alphabetValid = false;
    }
  }
  if (
    firstPadding >= 0 &&
    (paddingLength < 1 || paddingLength > 2 || firstPadding < compact.length - 2)
  ) {
    alphabetValid = false;
  }
  if (!alphabetValid) {
    throw new IngestionError(ApiErrorCode.UnsupportedFile, '文件内容不是合法的 base64 编码。');
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(compact, 'base64');
  } catch {
    throw new IngestionError(ApiErrorCode.UnsupportedFile, '文件内容不是合法的 base64 编码。');
  }
  if (buffer.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')) {
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

function hasDocxPackageStructure(buffer: Buffer): boolean {
  if (!hasZipMagic(buffer)) return false;
  const ascii = buffer.toString('latin1');
  return (
    ascii.includes('[Content_Types].xml') &&
    ascii.includes('word/document.xml') &&
    !ascii.includes('../') &&
    !ascii.includes('..\\')
  );
}

function hasPptxPackageStructure(buffer: Buffer): boolean {
  if (!hasZipMagic(buffer)) return false;
  const ascii = buffer.toString('latin1');
  return ascii.includes('[Content_Types].xml') && ascii.includes('ppt/presentation.xml');
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
        const [a, b, c, d, e, f] = item.transform as number[];
        const axisScale = Math.max(Math.abs(a ?? 0), Math.abs(d ?? 0), 1);
        const crossAxisScale = Math.max(Math.abs(b ?? 0), Math.abs(c ?? 0));
        items.push({
          str: item.str,
          x: e ?? 0,
          y: f ?? 0,
          width: item.width,
          height: item.height,
          fontSize: Math.hypot(c ?? 0, d ?? 0),
          rotated: crossAxisScale > axisScale * 0.1,
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
  if (!hasDocxPackageStructure(buffer)) {
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

/** Parse a PPTX or rich DOCX through the bounded OOXML adapter. */
export async function parseRichOffice(
  sourceType: 'docx' | 'pptx',
  buffer: Buffer,
  materialId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<ParsedBinaryDocument> {
  const result = await parseRichOoxml(sourceType, buffer, materialId, revisionId, signal);
  return {
    content: result.document.content,
    pageCount: result.pageCount,
    pageSpans: null,
    warnings: result.warnings,
    parserVersion: result.parserVersion,
    normalizedDocument: result.document,
    embeddedAssets: result.assets,
  };
}

/** Parse an uploaded binary file according to its resolved kind. */
export async function parseBinaryUpload(
  sourceType: SourceType,
  buffer: Buffer,
  materialId?: string,
  revisionId?: string,
  signal?: AbortSignal,
  expectedMediaType?: MediaType | null,
  baseUrl?: string,
): Promise<ParsedBinaryDocument> {
  if (sourceType === 'html') {
    const preview = buffer.subarray(0, 8192).toString('latin1');
    if (
      !/<(?:!doctype\s+html|html\b|head\b|body\b|article\b|main\b|p\b|h[1-6]\b)/iu.test(preview)
    ) {
      throw new IngestionError(ApiErrorCode.TypeMismatch, 'HTML 文件内容不像 HTML 文档。');
    }
    if (looksBinary(buffer.toString('latin1'))) {
      throw new IngestionError(ApiErrorCode.BinaryInput, '检测到二进制或非 HTML 内容,已拒绝导入。');
    }
    const parsed = parseHtmlBytes(buffer, {
      revisionId: revisionId ?? 'html:parse',
      materialId,
      baseUrl,
    });
    return {
      content: parsed.content,
      pageCount: null,
      pageSpans: null,
      warnings: parsed.warnings,
      parserVersion: HTML_PARSER_VERSION,
      normalizedDocument: parsed.normalizedDocument,
    };
  }
  if (sourceType === 'pdf') {
    if (hasDocxPackageStructure(buffer) || hasPptxPackageStructure(buffer)) {
      throw new IngestionError(
        ApiErrorCode.TypeMismatch,
        'PDF 扩展名对应的内容是 ZIP/OOXML 文件。',
      );
    }
    return parsePdf(buffer);
  }
  if (sourceType === 'docx') {
    if (hasPdfMagic(buffer)) {
      throw new IngestionError(ApiErrorCode.TypeMismatch, 'DOCX 扩展名对应的内容是 PDF 文件。');
    }
    return materialId && revisionId
      ? parseRichOffice('docx', buffer, materialId, revisionId, signal)
      : parseDocx(buffer);
  }
  if (sourceType === 'pptx') {
    if (hasPdfMagic(buffer)) {
      throw new IngestionError(ApiErrorCode.TypeMismatch, 'PPTX 扩展名与文件内容不匹配。');
    }
    if (!materialId || !revisionId) {
      throw new IngestionError(ApiErrorCode.ParseFailed, 'PPTX 解析缺少修订身份。');
    }
    return parseRichOffice('pptx', buffer, materialId, revisionId, signal);
  }
  if (sourceType === 'image') {
    if (!materialId || !revisionId || !expectedMediaType) {
      throw new IngestionError(ApiErrorCode.ParseFailed, '图像解析缺少修订或媒体身份。');
    }
    const parsed = await parseStandaloneImage(
      buffer,
      materialId,
      revisionId,
      expectedMediaType,
      signal,
    );
    return {
      content: '',
      pageCount: null,
      pageSpans: null,
      warnings: [],
      parserVersion: parsed.document.parserVersion,
      normalizedDocument: parsed.document,
      embeddedAssets: parsed.assets,
    };
  }
  if (hasPdfMagic(buffer) || hasDocxPackageStructure(buffer) || hasPptxPackageStructure(buffer)) {
    throw new IngestionError(ApiErrorCode.TypeMismatch, '文件签名与文本/源代码扩展名不匹配。');
  }
  // md / txt / source-code uploads arrive as decoded text files.
  const text = buffer.toString('utf8');
  if (looksBinary(text)) {
    throw new IngestionError(ApiErrorCode.BinaryInput, '检测到二进制或非文本内容,已拒绝导入。');
  }
  return {
    content: normalizeText(text),
    pageCount: null,
    pageSpans: null,
    warnings: [],
    parserVersion: sourceType === 'source_code' ? 'source-code-structure-v1' : TEXT_PARSER_VERSION,
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
