import { describe, expect, it } from 'vitest';
import {
  chunkNormalizedDocument,
  normalizeMarkdown,
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
