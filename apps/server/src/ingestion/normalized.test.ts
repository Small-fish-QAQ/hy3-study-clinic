import { describe, expect, it } from 'vitest';
import {
  chunkNormalizedDocument,
  normalizeMarkdown,
  normalizePdf,
  normalizeSourceCode,
  normalizeTxt,
  normalizedDocumentToSourceBlocks,
  PARSER_REGISTRY,
} from './normalized.js';

const base = {
  revisionId: 'rev_test',
  sourceType: 'md' as const,
  mediaType: 'text/markdown' as const,
};

describe('normalized structure and chunking', () => {
  it('declares and enforces bounded parser limits', () => {
    expect(PARSER_REGISTRY.every((adapter) => adapter.limits.maxContentChars === 100_000)).toBe(
      true,
    );
    expect(() => normalizeMarkdown({ ...base, content: 'x'.repeat(100_001) })).toThrow(/100000/u);
  });

  it('keeps fenced headings as code and preserves heading context', () => {
    const content =
      '# Real heading\n\n```ts\n# not a heading\nconst value = 1;\n```\n\nA paragraph.';
    const document = normalizeMarkdown({ ...base, content });
    const headings = document.units.filter((unit) => unit.kind === 'heading');
    const code = document.units.find((unit) => unit.kind === 'code_block');
    expect(headings).toHaveLength(1);
    expect(code?.content).toContain('# not a heading');
    expect(code?.headingPath).toEqual(['Real heading']);

    const blocks = normalizedDocumentToSourceBlocks('mat_test', document);
    expect(blocks.map((block) => block.content).join('')).toContain('# not a heading');
    for (const block of blocks) {
      expect(content.slice(block.startOffset, block.endOffset)).toBe(block.content);
    }
  });

  it('keeps lists, quotes, and tables as complete structural units', () => {
    const content =
      '- first\n- second\n\n> quoted\n> continuation\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- - -';
    const document = normalizeMarkdown({ ...base, content });
    expect(document.units.filter((unit) => unit.kind === 'list')).toHaveLength(1);
    expect(document.units.filter((unit) => unit.kind === 'quote')).toHaveLength(1);
    expect(document.units.filter((unit) => unit.kind === 'table')).toHaveLength(1);
    expect(document.units.filter((unit) => unit.kind === 'other')).toHaveLength(1);
    expect(chunkNormalizedDocument(document)).toHaveLength(4);
  });

  it('adds PDF page parents while chunking only page-owned structural content', () => {
    const firstPage = '# Topic\n\nFirst paragraph.\n\nA | B\n1 | 2';
    const secondPage = 'Second paragraph.';
    const content = `${firstPage}\n\n${secondPage}`;
    const document = normalizePdf({
      revisionId: 'rev_pdf',
      sourceType: 'pdf',
      mediaType: 'application/pdf',
      content,
      pageSpans: [
        { pageNumber: 1, startOffset: 0, endOffset: firstPage.length },
        {
          pageNumber: 2,
          startOffset: content.indexOf(secondPage),
          endOffset: content.length,
        },
      ],
    });

    const pages = document.units.filter((unit) => unit.kind === 'page');
    expect(pages).toHaveLength(2);
    expect(pages.map((unit) => unit.location.pageNumber)).toEqual([1, 2]);
    expect(document.units.find((unit) => unit.kind === 'table')?.parentUnitId).toBe(pages[0]!.id);
    expect(
      document.units.find((unit) => unit.kind === 'paragraph' && unit.content === secondPage)
        ?.parentUnitId,
    ).toBe(pages[1]!.id);

    const chunks = chunkNormalizedDocument(document);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 1, 2]);
    expect(chunks.map((chunk) => chunk.content)).not.toContain(firstPage);
    expect(document.capabilities).toEqual(
      expect.arrayContaining(['page_awareness', 'table_structure']),
    );
  });

  it('keeps an empty PDF page as an honest zero-width structural location', () => {
    const content = 'Only page one has text.';
    const document = normalizePdf({
      revisionId: 'rev_pdf_empty_page',
      sourceType: 'pdf',
      mediaType: 'application/pdf',
      content,
      pageSpans: [
        { pageNumber: 1, startOffset: 0, endOffset: content.length },
        { pageNumber: 2, startOffset: content.length, endOffset: content.length },
      ],
      warnings: ['Page 2 has no extractable text.'],
    });
    expect(document.units.find((unit) => unit.location.pageNumber === 2)).toMatchObject({
      kind: 'page',
      content: '',
      startOffset: content.length,
      endOffset: content.length,
    });
    expect(normalizedDocumentToSourceBlocks('mat_pdf_empty_page', document)).toHaveLength(1);
  });

  it('never carries a trailing PDF heading into the next page', () => {
    const firstPage = '# Page one heading';
    const secondPage = 'Page two paragraph.';
    const content = `${firstPage}\n\n${secondPage}`;
    const document = normalizePdf({
      revisionId: 'rev_pdf_page_boundary',
      sourceType: 'pdf',
      mediaType: 'application/pdf',
      content,
      pageSpans: [
        { pageNumber: 1, startOffset: 0, endOffset: firstPage.length },
        {
          pageNumber: 2,
          startOffset: content.indexOf(secondPage),
          endOffset: content.length,
        },
      ],
    });

    expect(chunkNormalizedDocument(document)).toMatchObject([
      { content: firstPage, pageNumber: 1, pageEnd: 1 },
      { content: secondPage, pageNumber: 2, pageEnd: 2 },
    ]);
  });

  it('splits oversized paragraphs only at hard boundaries and stays deterministic', () => {
    const content = `${'word '.repeat(800)}\n${'next '.repeat(800)}`;
    const document = normalizeTxt({
      revisionId: 'rev_txt',
      sourceType: 'txt',
      mediaType: 'text/plain',
      content,
    });
    const first = chunkNormalizedDocument(document);
    const second = chunkNormalizedDocument(document);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.content.length <= 3000)).toBe(true);
    expect(first.every((chunk) => chunk.content.length > 0)).toBe(true);
  });

  it('counts heading context toward the hard chunk bound', () => {
    const content = `# ${'h'.repeat(120)}\n\n${'word '.repeat(600)}`;
    const document = normalizeMarkdown({ ...base, content });
    const chunks = chunkNormalizedDocument(document);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 3000)).toBe(true);
  });

  it('covers source-code preamble and preserves function line ranges', () => {
    const content = '// imports\nimport x from "x";\n\nfunction add(a, b) {\n  return a + b;\n}\n';
    const document = normalizeSourceCode({
      revisionId: 'rev_code',
      sourceType: 'source_code',
      mediaType: 'text/x-source-code',
      filename: 'sample.ts',
      content,
    });
    const blocks = normalizedDocumentToSourceBlocks('mat_code', document);
    expect(blocks.some((block) => block.content.includes('import x'))).toBe(true);
    expect(blocks.some((block) => block.content.includes('return a + b'))).toBe(true);
    const functionUnit = document.units.find((unit) => unit.kind === 'function');
    expect(functionUnit?.location.lineStart).toBe(4);
    expect(functionUnit?.location.lineEnd).toBe(6);
    const covered = blocks
      .map((block) => content.slice(block.startOffset, block.endOffset))
      .join('\n');
    expect(covered).toContain('import x');
    expect(covered).toContain('return a + b');
  });
});
