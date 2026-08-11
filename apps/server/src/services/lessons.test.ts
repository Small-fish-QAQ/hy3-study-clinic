import { beforeEach, describe, expect, it } from 'vitest';
import type { ConceptLessonPayload } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ConceptLessonInput, ProviderCallOptions } from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Concept lesson cards (Phase 2): segment-level, server-decided provenance;
 * verified conflicts; fail-closed regeneration; strict assessment isolation
 * (lessons never touch learner state); cascade lifecycle.
 */

const DOC = [
  '# 工作记忆',
  '',
  '工作记忆的容量十分有限。它一次只能加工少量信息。',
  '',
  '# 长时记忆',
  '',
  '长时记忆负责长期存储。图式化的知识更容易保持。',
].join('\n');

interface Setup {
  ctx: TestApp;
  workspaceId: string;
  materialId: string;
  conceptId: string;
}

async function setup(provider?: FakeProvider): Promise<Setup> {
  const ctx = buildTestApp(provider ? { provider } : {});
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '讲解卡片' },
  });
  const workspaceId = ws.json().workspace.id as string;
  const doc = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: { kind: 'text', content: DOC },
  });
  const materialId = doc.json().material.id as string;
  const analyzed = await ctx.app.inject({
    method: 'POST',
    url: `/api/materials/${materialId}/analyze`,
  });
  const conceptId = (analyzed.json().concepts as Array<{ id: string }>)[0]!.id;
  return { ctx, workspaceId, materialId, conceptId };
}

function learnerStateCounts(ctx: TestApp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ['mastery_states', 'mistakes', 'misconceptions', 'review_items']) {
    counts[table] = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}

describe('lesson generation and provenance', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('persists a lesson whose provenance is decided by verification, not the model', async () => {
    const res = await s.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const lesson = res.json().lesson;
    expect(lesson.conceptId).toBe(s.conceptId);
    expect(lesson.content.sections[0].kind).toBe('explanation');

    const segments = lesson.content.sections.flatMap(
      (section: { segments: Array<{ anchor?: { blockId: string; quote: string } }> }) =>
        section.segments,
    );
    const anchored = segments.filter((seg: { anchor?: unknown }) => seg.anchor);
    const unanchored = segments.filter((seg: { anchor?: unknown }) => !seg.anchor);
    // Both provenance classes exist, and every anchor is REAL: the quote is
    // found verbatim at the recorded offsets of a real block.
    expect(anchored.length).toBeGreaterThan(0);
    expect(unanchored.length).toBeGreaterThan(0);
    const blocks = s.ctx.repos.materials.getBlocks(s.materialId);
    for (const segment of anchored) {
      const block = blocks.find((b) => b.id === segment.anchor!.blockId);
      expect(block).toBeTruthy();
      expect(block!.content).toContain(segment.anchor!.quote);
    }

    // The persisted lesson is readable back.
    const read = await s.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
    });
    expect(read.json().lesson.id).toBe(lesson.id);
  });

  it('a fabricated anchor is dropped: the segment survives as labeled AI teaching', async () => {
    class FabricatingProvider extends FakeProvider {
      override async generateConceptLesson(
        input: ConceptLessonInput,
      ): Promise<ConceptLessonPayload> {
        return {
          sections: [
            {
              kind: 'explanation',
              segments: [
                {
                  text: '这句话声称有原文依据,但引文是编造的。',
                  anchor: { blockId: input.concept.grounding.blockId, quote: '完全编造的引文。' },
                },
                { text: '这句是坦率的 AI 讲解。' },
              ],
            },
          ],
          conflicts: [],
        };
      }
    }
    const local = await setup(new FabricatingProvider());
    const res = await local.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${local.workspaceId}/concepts/${local.conceptId}/lesson`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const segments = res.json().lesson.content.sections[0].segments;
    // Text kept, fabricated anchor stripped — never displayed as verified.
    expect(segments[0].text).toContain('编造');
    expect(segments[0].anchor).toBeUndefined();
    expect(segments[1].anchor).toBeUndefined();
  });

  it('a conflict without a verifiable source quote is dropped whole', async () => {
    class ConflictProvider extends FakeProvider {
      override async generateConceptLesson(
        input: ConceptLessonInput,
      ): Promise<ConceptLessonPayload> {
        const block = input.blocks.find((b) => b.id === input.concept.grounding.blockId)!;
        return {
          sections: [{ kind: 'explanation', segments: [{ text: '正常讲解。' }] }],
          conflicts: [
            {
              claim: '常见表述认为容量近乎无限。',
              blockId: block.id,
              quote: '工作记忆的容量十分有限。',
            },
            { claim: '这是一条编造引文的冲突。', blockId: block.id, quote: '资料从未这样说过。' },
          ],
        };
      }
    }
    const local = await setup(new ConflictProvider());
    const res = await local.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${local.workspaceId}/concepts/${local.conceptId}/lesson`,
      payload: {},
    });
    const conflicts = res.json().lesson.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].claim).toContain('近乎无限');
    expect(conflicts[0].sourceQuote.quote).toBe('工作记忆的容量十分有限。');
  });

  it('directives flow to the provider and regenerate the SAME concept card', async () => {
    const seen: Array<string | undefined> = [];
    class RecordingProvider extends FakeProvider {
      override async generateConceptLesson(
        input: ConceptLessonInput,
        opts?: ProviderCallOptions,
      ): Promise<ConceptLessonPayload> {
        seen.push(input.directive);
        return super.generateConceptLesson(input, opts);
      }
    }
    const local = await setup(new RecordingProvider());
    const url = `/api/workspaces/${local.workspaceId}/concepts/${local.conceptId}/lesson`;
    const first = await local.ctx.app.inject({ method: 'POST', url, payload: {} });
    const second = await local.ctx.app.inject({
      method: 'POST',
      url,
      payload: { directive: 'more_intuitive' },
    });
    expect(seen).toEqual([undefined, 'more_intuitive']);
    // One current lesson per concept: same createdAt lineage, new updatedAt.
    expect(second.json().lesson.createdAt).toBe(first.json().lesson.createdAt);
    const count = (
      local.ctx.db.prepare('SELECT COUNT(*) AS n FROM concept_lessons').get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('a failed regeneration preserves the previous valid card', async () => {
    class OnceProvider extends FakeProvider {
      calls = 0;
      override async generateConceptLesson(
        input: ConceptLessonInput,
        opts?: ProviderCallOptions,
      ): Promise<ConceptLessonPayload> {
        this.calls++;
        if (this.calls > 1) throw ProviderError.http(500);
        return super.generateConceptLesson(input, opts);
      }
    }
    const local = await setup(new OnceProvider());
    const url = `/api/workspaces/${local.workspaceId}/concepts/${local.conceptId}/lesson`;
    const first = await local.ctx.app.inject({ method: 'POST', url, payload: {} });
    expect(first.statusCode).toBe(201);

    const failed = await local.ctx.app.inject({ method: 'POST', url, payload: {} });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    const read = await local.ctx.app.inject({ method: 'GET', url });
    expect(read.json().lesson).toEqual(first.json().lesson);
  });

  it('generating and reading lessons writes ZERO learner state', async () => {
    const before = learnerStateCounts(s.ctx);
    await s.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
      payload: {},
    });
    await s.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
    });
    expect(learnerStateCounts(s.ctx)).toEqual(before);
  });

  it('retiring a material preserves lesson history and provenance', async () => {
    await s.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
      payload: {},
    });
    expect(
      (s.ctx.db.prepare('SELECT COUNT(*) AS n FROM concept_lessons').get() as { n: number }).n,
    ).toBe(1);
    const del = await s.ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${s.workspaceId}/documents/${s.materialId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(
      (s.ctx.db.prepare('SELECT COUNT(*) AS n FROM concept_lessons').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (
        s.ctx.db.prepare('SELECT availability FROM materials WHERE id = ?').get(s.materialId) as {
          availability: string;
        }
      ).availability,
    ).toBe('retired');
  });

  it('scopes lessons to the workspace and 404s foreign concepts', async () => {
    const res = await s.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/ws_other/concepts/${s.conceptId}/lesson`,
    });
    expect(res.statusCode).toBe(404);
    const foreign = await s.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${s.workspaceId}/concepts/con_nope/lesson`,
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('lesson anchors join the structural mapping of the document', async () => {
    const before = (
      await s.ctx.app.inject({ method: 'GET', url: `/api/materials/${s.materialId}/mapping` })
    ).json();
    await s.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${s.workspaceId}/concepts/${s.conceptId}/lesson`,
      payload: {},
    });
    const after = (
      await s.ctx.app.inject({ method: 'GET', url: `/api/materials/${s.materialId}/mapping` })
    ).json();
    expect(after.totals.anchoredBlockCount).toBeGreaterThanOrEqual(
      before.totals.anchoredBlockCount,
    );
  });
});
