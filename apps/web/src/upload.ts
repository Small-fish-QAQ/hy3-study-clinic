import { MAX_DOCUMENT_FILE_BYTES } from '@hy3-clinic/shared';

/**
 * Shared client-side upload rules for both import surfaces (资料库 and
 * 学习图谱). Everything here is a fast pre-check for immediate feedback —
 * the server independently re-validates extension, magic bytes, decoded
 * size, and extracted text.
 */

/** File extensions accepted by every import surface (must match the server). */
export const UPLOAD_ACCEPT = '.md,.markdown,.txt,.pdf,.docx';

/** Consistent supported-format wording shown next to upload controls. */
export const UPLOAD_FORMATS_TEXT = '支持粘贴文本及 Markdown、TXT、PDF、DOCX 文件。';

/** Consistent OCR-limitation wording shown next to upload controls. */
export const UPLOAD_OCR_LIMIT_TEXT = '暂不支持纯扫描图片型 PDF;PDF 中需要包含可提取文本。';

export type UploadKind = 'md' | 'txt' | 'pdf' | 'docx';

const EXTENSION_KINDS: Record<string, UploadKind> = {
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  text: 'txt',
  pdf: 'pdf',
  docx: 'docx',
};

/** Human-readable type label shown next to a selected filename. */
export const UPLOAD_KIND_LABELS: Record<UploadKind, string> = {
  md: 'Markdown',
  txt: '文本',
  pdf: 'PDF',
  docx: 'Word 文档',
};

/** Resolve a filename to its upload kind, or null when unsupported. */
export function uploadKindOf(filename: string): UploadKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  return ext ? (EXTENSION_KINDS[ext] ?? null) : null;
}

/** True when the file must be sent base64-encoded instead of as text. */
export function isBinaryUploadKind(kind: UploadKind): kind is 'pdf' | 'docx' {
  return kind === 'pdf' || kind === 'docx';
}

/**
 * Pre-flight validation mirroring the server's rejection messages.
 * Returns a user-facing error message, or null when the file may be sent.
 */
export function uploadValidationError(file: File): string | null {
  if (uploadKindOf(file.name) === null) {
    return '不支持的文件类型:仅接受 .md、.txt、.pdf 与 .docx 文件。';
  }
  if (file.size === 0) {
    return '上传的文件为空。';
  }
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    return `文件过大(${file.size} 字节),上限为 ${MAX_DOCUMENT_FILE_BYTES} 字节。`;
  }
  return null;
}

/** Read a browser File into the base64 payload the upload APIs expect. */
export async function fileToBase64(file: File): Promise<string> {
  return arrayBufferToBase64(await file.arrayBuffer());
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
