import { describe, expect, it } from 'vitest';
import type { SourceBlock } from '@hy3-clinic/shared';
import {
  computeSections,
  conceptBudgetFor,
  findSection,
  MAX_SECTION_CHARS,
  MIN_SECTION_CHARS,
} from './sections.js';

/**
 * Deterministic section outline: heading-based grouping, merge/split
 * boundaries, and the synthetic-window fallback for weak heading structure
 * (Amendment D). Sections are derived, so identical blocks must always
 * produce identical outlines — keys included.
 */

function block(index: number, content: string, topHeading: string | null): SourceBlock {
  return {
    id: `blk_${index}`,
    materialId: 'mat_1',
    index,
    heading: topHeading,
    headingPath: topHeading ? [topHeading] : [],
    pageNumber: null,
    pageEnd: null,
    content,
    startOffset: index * 1000,
    endOffset: index * 1000 + content.length,
  };
}

const PARA = '这一段讨论了学习材料中的一个具体话题,内容足够长以便参与切分预算的计算。'; // 36 chars

function paragraphs(count: number, heading: string | null, startIndex = 0): SourceBlock[] {
  return Array.from({ length: count }, (_, i) =>
    block(startIndex + i, `${PARA}(${startIndex + i})`, heading),
  );
}

describe('computeSections', () => {
  it('is deterministic: identical blocks yield identical outlines and keys', () => {
    const blocks = [
      ...paragraphs(20, '第一章', 0),
      ...paragraphs(20, '第二章', 20),
      ...paragraphs(20, '第三章', 40),
    ];
    const a = computeSections(blocks);
    const b = computeSections(blocks.map((x) => ({ ...x })));
    expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
    expect(a.map((s) => s.title)).toEqual(b.map((s) => s.title));
  });

  it('groups by top-level heading and keeps every block exactly once', () => {
    const blocks = [
      ...paragraphs(20, '第一章', 0),
      ...paragraphs(20, '第二章', 20),
      ...paragraphs(20, '第三章', 40),
    ];
    const sections = computeSections(blocks);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.every((s) => s.fromHeading)).toBe(true);
    const covered = sections.flatMap((s) => s.blocks.map((b) => b.id));
    expect(covered).toEqual(blocks.map((b) => b.id));
  });

  it('a small document is one single section', () => {
    const sections = computeSections(paragraphs(3, '短文'));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.blocks).toHaveLength(3);
  });

  it('splits an oversized heading group at block boundaries within the budget', () => {
    // One giant chapter: 200 paragraphs ≈ 8000 chars → must split.
    const blocks = [...paragraphs(120, '巨长章节', 0), ...paragraphs(30, '尾章', 120)];
    const sections = computeSections(blocks);
    expect(sections.length).toBeGreaterThan(2);
    for (const section of sections) {
      expect(section.charCount).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    }
    // Split parts stay attributable to their heading.
    expect(sections[0]!.title).toContain('巨长章节');
    const covered = sections.flatMap((s) => s.blocks.map((b) => b.id));
    expect(covered).toEqual(blocks.map((b) => b.id));
  });

  it('merges undersized heading groups instead of emitting sliver sections', () => {
    const blocks = [
      ...paragraphs(1, '小节甲', 0),
      ...paragraphs(1, '小节乙', 1),
      ...paragraphs(30, '正文', 2),
      ...paragraphs(30, '结尾', 32),
    ];
    const sections = computeSections(blocks);
    for (const section of sections.slice(0, -1)) {
      expect(section.charCount).toBeGreaterThanOrEqual(MIN_SECTION_CHARS);
    }
    const covered = sections.flatMap((s) => s.blocks.map((b) => b.id));
    expect(covered).toEqual(blocks.map((b) => b.id));
  });

  it('falls back to deterministic synthetic windows when headings are absent', () => {
    const blocks = paragraphs(120, null);
    const sections = computeSections(blocks);
    expect(sections.length).toBeGreaterThan(1); // never whole-document one-shot
    expect(sections.every((s) => !s.fromHeading)).toBe(true);
    for (const section of sections) {
      expect(section.charCount).toBeLessThanOrEqual(MAX_SECTION_CHARS + 200);
    }
    expect(sections[0]!.title).toContain('段');
    const again = computeSections(blocks);
    expect(again.map((s) => s.key)).toEqual(sections.map((s) => s.key));
  });

  it('falls back to synthetic windows when ONE heading spans a large document', () => {
    const blocks = paragraphs(120, '唯一章节');
    const sections = computeSections(blocks);
    expect(sections.length).toBeGreaterThan(1);
  });
});

describe('findSection', () => {
  it('resolves a stable key back to its section', () => {
    const blocks = [...paragraphs(20, '第一章', 0), ...paragraphs(20, '第二章', 20)];
    const sections = computeSections(blocks);
    const found = findSection(blocks, sections[1]!.key);
    expect(found?.title).toBe(sections[1]!.title);
    expect(findSection(blocks, 'sec_nope')).toBeUndefined();
  });
});

describe('conceptBudgetFor', () => {
  it('scales the UPPER bound with section size (never a minimum)', () => {
    const tiny = computeSections(paragraphs(2, '微'))[0]!;
    const large = computeSections([...paragraphs(30, '大', 0)])[0]!;
    expect(conceptBudgetFor(tiny)).toBeLessThanOrEqual(2);
    expect(conceptBudgetFor(large)).toBeGreaterThan(conceptBudgetFor(tiny));
    expect(conceptBudgetFor(large)).toBeLessThanOrEqual(8);
  });
});
