import { describe, expect, it } from 'vitest';
import { MAX_CONCEPTS_PER_DOCUMENT, type ConceptAnalysisPayload } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ConceptAnalysisInput, ProviderCallOptions } from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { createAnalysisService } from './analysis.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from '../testing/fixtures.js';

/**
 * Section-aware additive extraction (Phase 1):
 * - the initial run walks every section with a size-aware budget and appends
 *   verified concepts per section (partial failure keeps other sections);
 * - zero-concept sections are legal (no padding to a minimum);
 * - deepen runs append only — existing concept rows stay byte-identical;
 * - dedup uses normalized-key semantics;
 * - the document-level ceiling stops acceptance, visibly.
 */

function sectionedDoc(sections: number, paragraphsPer = 20): string {
  const parts: string[] = [];
  for (let s = 0; s < sections; s++) {
    parts.push(`# 章节${s}`);
    parts.push('');
    for (let p = 0; p < paragraphsPer; p++) {
      parts.push(`章节${s}的第${p}个要点:这里描述一个具体的知识点,内容足够长以形成正文段落。`);
      parts.push('');
    }
  }
  return parts.join('\n');
}

async function importDoc(ctx: TestApp, content: string): Promise<string> {
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '分节提取' },
  });
  const doc = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.json().workspace.id}/documents`,
    payload: { kind: 'text', content },
  });
  return doc.json().material.id as string;
}

describe('sectioned initial extraction', () => {
  it('recovers only an ungrounded section and reports real saved progress without replacing peers', async () => {
    const inputs: ConceptAnalysisInput[] = [];
    class MissingSectionProvider extends FakeProvider {
      override async analyzeConcepts(input: ConceptAnalysisInput, opts?: ProviderCallOptions) {
        inputs.push(input);
        if (inputs.length === 2) return { concepts: [] };
        return super.analyzeConcepts(input, opts);
      }
    }
    const provider = new MissingSectionProvider();
    const ctx = buildTestApp({ provider });
    const materialId = await importDoc(ctx, sectionedDoc(3));
    const service = createAnalysisService({ repos: ctx.repos, provider, clock: fixedClock(T0) });
    const initial = await service.analyze(materialId);
    const before = structuredClone(initial.concepts);
    const calls = inputs.length;
    const updates: Array<{ title: string; completed: number; total: number }> = [];
    const recovered = await service.analyze(materialId, undefined, {
      recoverUncoveredSections: true,
      onSectionProgress: (progress) => updates.push(progress),
    });
    expect(inputs).toHaveLength(calls + 1);
    expect(inputs.at(-1)?.sectionTitle).toBe(inputs[1]?.sectionTitle);
    expect(
      recovered.concepts.filter((concept) => before.some((old) => old.id === concept.id)),
    ).toEqual(before);
    expect(recovered.concepts.length).toBeGreaterThan(before.length);
    expect(updates.map(({ completed, total }) => [completed, total])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    await service.analyze(materialId, undefined, { recoverUncoveredSections: true });
    expect(inputs).toHaveLength(calls + 1);
    await ctx.app.close();
  });
  it('extracts across every section with per-call inputs bounded to that section', async () => {
    const seenInputs: ConceptAnalysisInput[] = [];
    class RecordingProvider extends FakeProvider {
      override async analyzeConcepts(input: ConceptAnalysisInput, opts?: ProviderCallOptions) {
        seenInputs.push(input);
        return super.analyzeConcepts(input, opts);
      }
    }
    const ctx = buildTestApp({ provider: new RecordingProvider() });
    const materialId = await importDoc(ctx, sectionedDoc(4));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(seenInputs.length).toBeGreaterThan(1); // no whole-document one-shot
    const totalBlocks = ctx.repos.materials.getBlocks(materialId).length;
    for (const input of seenInputs) {
      expect(input.blocks.length).toBeLessThan(totalBlocks);
      expect(input.maxConcepts).toBeGreaterThanOrEqual(1);
      expect(input.maxConcepts).toBeLessThanOrEqual(8);
      expect(input.sectionTitle).toBeTruthy();
    }
    expect(body.extraction.sections.length).toBe(seenInputs.length);
    expect(body.concepts.length).toBe(body.extraction.conceptTotal);
    // Concepts came from more than one section of the document.
    const groundedBlockIds = new Set(
      (body.concepts as Array<{ grounding: { blockId: string } }>).map((c) => c.grounding.blockId),
    );
    expect(groundedBlockIds.size).toBeGreaterThan(1);
  });

  it('repeated analysis returns the existing set unchanged (ids stable)', async () => {
    const ctx = buildTestApp();
    const materialId = await importDoc(ctx, sectionedDoc(3));
    const first = (
      await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` })
    ).json();
    const second = (
      await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` })
    ).json();
    expect(second.concepts).toEqual(first.concepts);
    expect(second.extraction).toBeNull();
  });

  it('a failing section is partial, retryable state — other sections persist', async () => {
    let calls = 0;
    class FlakyProvider extends FakeProvider {
      override async analyzeConcepts(input: ConceptAnalysisInput, opts?: ProviderCallOptions) {
        calls++;
        if (calls === 2) throw ProviderError.http(500);
        return super.analyzeConcepts(input, opts);
      }
    }
    const ctx = buildTestApp({ provider: new FlakyProvider() });
    const materialId = await importDoc(ctx, sectionedDoc(3));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const statuses = (body.extraction.sections as Array<{ status: string }>).map((s) => s.status);
    expect(statuses).toContain('failed');
    expect(statuses).toContain('extracted');
    expect(body.concepts.length).toBeGreaterThan(0);
  });

  it('an all-sections failure fails closed with zero persisted concepts', async () => {
    class DeadProvider extends FakeProvider {
      override async analyzeConcepts(): Promise<ConceptAnalysisPayload> {
        throw ProviderError.http(500);
      }
    }
    const ctx = buildTestApp({ provider: new DeadProvider() });
    const materialId = await importDoc(ctx, sectionedDoc(2));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(res.statusCode).toBe(422);
    expect(ctx.repos.materials.getConcepts(materialId)).toHaveLength(0);
  });

  it('zero-concept sections are honest: no padding to satisfy a minimum', async () => {
    class SilentProvider extends FakeProvider {
      override async analyzeConcepts(
        input: ConceptAnalysisInput,
        opts?: ProviderCallOptions,
      ): Promise<ConceptAnalysisPayload> {
        // The model finds nothing in later sections.
        const payload = await super.analyzeConcepts(input, opts);
        return input.sectionTitle?.includes('章节0') ? payload : { concepts: [] };
      }
    }
    const ctx = buildTestApp({ provider: new SilentProvider() });
    const materialId = await importDoc(ctx, sectionedDoc(3));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    const body = res.json();
    const statuses = (body.extraction.sections as Array<{ status: string }>).map((s) => s.status);
    expect(statuses.filter((s) => s === 'empty').length).toBeGreaterThan(0);
    expect(body.concepts.length).toBe(
      (body.extraction.sections as Array<{ conceptsAdded: number }>).reduce(
        (n, s) => n + s.conceptsAdded,
        0,
      ),
    );
  });

  it('stops ACCEPTING at the document ceiling and reports skipped sections', async () => {
    let counter = 0;
    class ProlificProvider extends FakeProvider {
      override async analyzeConcepts(input: ConceptAnalysisInput): Promise<ConceptAnalysisPayload> {
        const first = input.blocks[0]!;
        return {
          concepts: Array.from({ length: 12 }, (_, i) => ({
            name: `高产概念${counter}_${i++}`,
            summary: '为上限测试生成的概念。',
            importance: 'medium' as const,
            blockId: first.id,
            quote: first.content.slice(0, 20),
          })).map((c, i) => ({ ...c, name: `高产概念${counter++}_${i}` })),
        };
      }
    }
    const ctx = buildTestApp({ provider: new ProlificProvider() });
    const materialId = await importDoc(ctx, sectionedDoc(6));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    const body = res.json();
    expect(body.concepts.length).toBeLessThanOrEqual(MAX_CONCEPTS_PER_DOCUMENT);
    expect(body.extraction.capReached).toBe(true);
    const statuses = (body.extraction.sections as Array<{ status: string }>).map((s) => s.status);
    expect(statuses).toContain('skipped_cap');
  });
});

describe('additive deepen', () => {
  it('appends new concepts for one section without touching existing rows', async () => {
    class OneSectionProvider extends FakeProvider {
      override async analyzeConcepts(
        input: ConceptAnalysisInput,
        opts?: ProviderCallOptions,
      ): Promise<ConceptAnalysisPayload> {
        // Initial run: only 章节0 yields anything; deepen finds more later.
        if (input.sectionTitle?.includes('章节0') || input.sectionTitle === undefined) {
          return super.analyzeConcepts(input, opts);
        }
        return { concepts: [] };
      }
    }
    const provider = new OneSectionProvider();
    const ctx = buildTestApp({ provider });
    const materialId = await importDoc(ctx, sectionedDoc(3));
    const initial = (
      await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` })
    ).json();
    const before = ctx.repos.materials.getConcepts(materialId);
    expect(before.length).toBeGreaterThan(0);
    const unmapped = (initial.extraction.sections as Array<{ key: string; status: string }>).find(
      (s) => s.status === 'empty',
    );
    expect(unmapped).toBeTruthy();

    // The model now "finds" content in the second section.
    provider.analyzeConcepts = FakeProvider.prototype.analyzeConcepts.bind(provider);
    const deepen = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
      payload: { section: unmapped!.key },
    });
    expect(deepen.statusCode).toBe(200);
    const after = ctx.repos.materials.getConcepts(materialId);
    expect(after.length).toBeGreaterThan(before.length);
    // Existing rows byte-identical (ids, content, groundings untouched).
    // Ordering may interleave (created_at ties break by random id), so
    // compare row-by-row via id.
    const afterById = new Map(after.map((c) => [c.id, c]));
    for (const concept of before) {
      expect(afterById.get(concept.id)).toEqual(concept);
    }
    // Dedup: repeating the same deepen adds nothing.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
      payload: { section: unmapped!.key },
    });
    expect(again.json().extraction.conceptsAdded).toBe(0);
    expect(ctx.repos.materials.getConcepts(materialId)).toEqual(after);
  });

  it('rejects an unknown section key honestly', async () => {
    const ctx = buildTestApp();
    const materialId = await importDoc(ctx, sectionedDoc(2));
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
      payload: { section: 'sec_nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('小节不存在');
  });
});

describe('structural mapping endpoint', () => {
  it('reports honest per-section mapping that reconciles with the document', async () => {
    const ctx = buildTestApp();
    const materialId = await importDoc(ctx, sectionedDoc(3));
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${materialId}/mapping`,
    });
    expect(res.statusCode).toBe(200);
    const mapping = res.json();

    const blocks = ctx.repos.materials.getBlocks(materialId);
    expect(mapping.totals.blockCount).toBe(blocks.length);
    expect(mapping.totals.charCount).toBe(blocks.reduce((n, b) => n + b.content.length, 0));
    expect(mapping.totals.sectionCount).toBe(mapping.sections.length);
    // Section stats reconcile with totals.
    expect(
      mapping.sections.reduce((n: number, s: { blockCount: number }) => n + s.blockCount, 0),
    ).toBe(mapping.totals.blockCount);
    expect(
      mapping.sections.reduce((n: number, s: { conceptCount: number }) => n + s.conceptCount, 0),
    ).toBe(mapping.totals.conceptCount);
    // `mapped` means "has a grounded concept", nothing stronger.
    for (const section of mapping.sections) {
      expect(section.mapped).toBe(section.conceptCount > 0);
    }
  });
});
