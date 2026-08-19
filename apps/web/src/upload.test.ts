import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_FILE_BYTES } from '@hy3-clinic/shared';
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS_TEXT,
  UPLOAD_KIND_LABELS,
  arrayBufferToBase64,
  fileToBase64,
  isBinaryUploadKind,
  uploadKindOf,
  uploadValidationError,
} from './upload';

describe('uploadKindOf', () => {
  it('maps every accepted extension case-insensitively', () => {
    expect(uploadKindOf('notes.md')).toBe('md');
    expect(uploadKindOf('notes.MARKDOWN')).toBe('md');
    expect(uploadKindOf('notes.txt')).toBe('txt');
    expect(uploadKindOf('讲义.PDF')).toBe('pdf');
    expect(uploadKindOf('课件.PPTX')).toBe('pptx');
    expect(uploadKindOf('讲义.docx')).toBe('docx');
  });

  it('returns null for unsupported or missing extensions', () => {
    expect(uploadKindOf('workbook.xlsx')).toBeNull();
    expect(uploadKindOf('archive.docx.zip')).toBeNull();
    expect(uploadKindOf('no-extension')).toBeNull();
  });

  it('covers exactly the kinds advertised by UPLOAD_ACCEPT', () => {
    for (const ext of UPLOAD_ACCEPT.split(',')) {
      expect(uploadKindOf(`file${ext}`)).not.toBeNull();
    }
  });

  it('classifies pdf/pptx/docx as binary and md/txt as text', () => {
    expect(isBinaryUploadKind('pdf')).toBe(true);
    expect(isBinaryUploadKind('pptx')).toBe(true);
    expect(isBinaryUploadKind('docx')).toBe(true);
    expect(isBinaryUploadKind('md')).toBe(false);
    expect(isBinaryUploadKind('txt')).toBe(false);
  });

  it('advertises PPTX with a learner-facing presentation label', () => {
    expect(UPLOAD_FORMATS_TEXT).toContain('PPTX');
    expect(UPLOAD_KIND_LABELS.pptx).toBe('PowerPoint 演示文稿');
  });
});

describe('uploadValidationError', () => {
  it('accepts a normal supported file', () => {
    expect(uploadValidationError(new File(['内容'], 'a.md'))).toBeNull();
    expect(uploadValidationError(new File(['%PDF-'], 'a.pdf'))).toBeNull();
    expect(uploadValidationError(new File(['PK'], 'a.pptx'))).toBeNull();
  });

  it('rejects unsupported types, empty files, and oversized files', () => {
    expect(uploadValidationError(new File(['x'], 'a.xlsx'))).toBe(
      '不支持的文件类型:仅接受 .md、.txt、.pdf、.pptx 与 .docx 文件。',
    );
    expect(uploadValidationError(new File([], 'a.pdf'))).toBe('上传的文件为空。');
    expect(
      uploadValidationError(new File([new ArrayBuffer(MAX_DOCUMENT_FILE_BYTES + 1)], 'a.pdf')),
    ).toMatch(/文件过大/);
  });
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes, including multi-chunk buffers', async () => {
    const bytes = new Uint8Array(0x8000 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const encoded = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);

    const viaFile = await fileToBase64(new File([bytes], 'bin.pdf'));
    expect(viaFile).toBe(encoded);
  });
});
