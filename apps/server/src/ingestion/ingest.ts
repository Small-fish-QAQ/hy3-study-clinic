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

/**
 * Validate and normalize an incoming source document.
 * Throws IngestionError for empty, oversized, or binary input.
 */
export function ingestSource(raw: string, options: IngestOptions): NormalizedSource {
  if (looksBinary(raw)) {
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
