import { ApiErrorCode, type SourceType } from '@hy3-clinic/shared';

/** Hard limit on accepted source size (characters of normalized text). */
export const MAX_SOURCE_CHARS = 100_000;
/** Minimum meaningful source size. */
export const MIN_SOURCE_CHARS = 1;

export class IngestionError extends Error {
  constructor(
    readonly code: (typeof ApiErrorCode)[keyof typeof ApiErrorCode],
    message: string,
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

const SUPPORTED_EXTENSIONS: Record<string, SourceType> = {
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  text: 'txt',
};

/**
 * Normalize raw text: strip a UTF-8 BOM, convert CRLF/CR to LF, and trim
 * trailing whitespace on the whole document. Line-internal content is left
 * untouched so offsets remain meaningful.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\n]+$/, '');
}

/**
 * Heuristic binary detection: presence of NUL bytes, or an unusually high
 * ratio of C0 control characters (excluding tab/newline/carriage return),
 * marks the input as binary/untrusted and is rejected.
 *
 * This is a check on RAW user-supplied text bytes (pasted text, .md/.txt
 * files). Never run it on PDF/DOCX extraction output — see
 * sanitizeParsedText for why parser output can legitimately contain isolated
 * control characters without being binary.
 */
export function looksBinary(raw: string): boolean {
  if (raw.includes('\u0000')) return true;
  let control = 0;
  const sampleLength = Math.min(raw.length, 4096);
  if (sampleLength === 0) return false;
  for (let i = 0; i < sampleLength; i++) {
    const code = raw.charCodeAt(i);
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if (code < 32 && !isAllowedControl) control++;
  }
  return control / sampleLength > 0.1;
}

/** Line-break artifacts in extracted text: form feed, vertical tab, NEL,
 * LINE SEPARATOR, PARAGRAPH SEPARATOR — normalized to '\n'. */
const LINE_SEPARATOR_ARTIFACTS = new Set([0x0b, 0x0c, 0x85, 0x2028, 0x2029]);

/** True for code points removed from parsed text (see sanitizeParsedText). */
function isParserArtifact(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false; // tab / LF / CR
  if (code < 0x20 || code === 0x7f) return true; // C0 controls (incl. NUL) + DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls
  if (code === 0xad) return true; // soft hyphen (hyphenation leftover)
  if (code === 0xfeff) return true; // stray BOM / zero-width no-break space
  if (code >= 0xd800 && code <= 0xdfff) return true; // unpaired surrogate half
  if (code >= 0xfdd0 && code <= 0xfdef) return true; // Unicode noncharacters
  if ((code & 0xfffe) === 0xfffe) return true; // U+nFFFE / U+nFFFF on every plane
  return false;
}

/**
 * Conservative cleanup for PARSER OUTPUT (PDF / DOCX extraction).
 *
 * Real-world documents produce extraction artifacts that say nothing about
 * the file being binary: Chrome/Skia PDFs, for example, embed subset fonts
 * whose list-bullet glyphs carry a ToUnicode mapping to U+0000, so PDF.js
 * emits NUL characters inside perfectly valid, text-rich pages. Rejecting
 * such content with the raw-bytes binary sniffer (looksBinary) rejects valid
 * documents, and storing the artifacts would corrupt quotes and search.
 *
 * Removed: NUL and all other C0/C1 controls (except tab/LF/CR), DEL, soft
 * hyphens, stray BOMs, Unicode noncharacters (U+FDD0–U+FDEF, U+nFFFE/U+nFFFF)
 * and unpaired surrogate halves. Converted to '\n': form feed, vertical tab,
 * NEL, LINE/PARAGRAPH SEPARATOR. Everything else — CJK, emoji (including ZWJ
 * sequences), punctuation, tabs, newlines — is retained unchanged.
 *
 * Callers must sanitize BEFORE computing page spans / block offsets so that
 * provenance offsets refer to the stored (sanitized) text.
 */
export function sanitizeParsedText(raw: string): string {
  const parts: string[] = [];
  let clean = true;
  for (const char of raw) {
    const code = char.codePointAt(0)!;
    if (LINE_SEPARATOR_ARTIFACTS.has(code)) {
      parts.push('\n');
      clean = false;
    } else if (isParserArtifact(code)) {
      clean = false;
    } else {
      parts.push(char);
    }
  }
  return clean ? raw : parts.join('');
}

/** Resolve a filename's extension to a supported text SourceType, or throw. */
export function sourceTypeForFilename(filename: string): SourceType {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = match?.[1]?.toLowerCase();
  if (!ext || !(ext in SUPPORTED_EXTENSIONS)) {
    throw new IngestionError(
      ApiErrorCode.UnsupportedFile,
      '不支持的文件类型:文本内容仅接受 .md 与 .txt 文件;PDF 与 DOCX 请以文件形式上传。',
    );
  }
  return SUPPORTED_EXTENSIONS[ext]!;
}

export interface NormalizedSource {
  content: string;
  charCount: number;
  sourceType: SourceType;
}

export interface IngestOptions {
  sourceType: SourceType;
  /** Optional title; when absent a title is derived from the content. */
  title?: string;
}

/** Source types whose content reaches ingestion as raw user-supplied text bytes. */
const RAW_TEXT_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(['paste', 'md', 'txt']);

/**
 * Validate and normalize an incoming source document.
 * Throws IngestionError for empty, oversized, or (for raw text) binary input.
 */
export function ingestSource(raw: string, options: IngestOptions): NormalizedSource {
  // Binary sniffing applies to raw pasted/.md/.txt bytes only. PDF/DOCX
  // content arrives here as parser OUTPUT, already conservatively cleaned by
  // sanitizeParsedText — isolated extractor artifacts (e.g. Chrome/Skia
  // bullet glyphs extracting as U+0000) must not reject a valid document.
  if (RAW_TEXT_SOURCE_TYPES.has(options.sourceType) && looksBinary(raw)) {
    throw new IngestionError(ApiErrorCode.BinaryInput, '检测到二进制或非文本内容,已拒绝导入。');
  }

  const content = normalizeText(raw);
  const charCount = content.length;

  if (charCount < MIN_SOURCE_CHARS) {
    throw new IngestionError(ApiErrorCode.EmptySource, '源材料为空,请粘贴或上传文本内容。');
  }
  if (charCount > MAX_SOURCE_CHARS) {
    throw new IngestionError(
      ApiErrorCode.SourceTooLarge,
      `源材料过长(${charCount} 字),上限为 ${MAX_SOURCE_CHARS} 字。`,
    );
  }

  return { content, charCount, sourceType: options.sourceType };
}

/** Derive a human title from content: first heading, else first line. */
export function deriveTitle(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const text = heading ? heading[1]!.trim() : trimmed;
    return text.slice(0, 80);
  }
  return '未命名资料';
}
