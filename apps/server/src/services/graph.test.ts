import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphProposalPayload } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Graph generation lifecycle: generate → activate → regenerate → failure
 * preserving the previously active version. Uses the deterministic fake
 * provider through the real service wiring (no network).
 */

async function importTwoDocuments(ctx: TestApp): Promise<string> {
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '认知科学课程' },
  });
  const workspaceId = ws.json().workspace.id as string;

  const doc1 = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: {
      kind: 'text',
      content:
        '# 工作记忆\n\n工作记忆的容量十分有限。它一次只能保持大约四个组块。\n\n# 长时记忆\n\n长时记忆通过巩固过程形成,睡眠对巩固十分重要。',
      title: '记忆基础',
    },
  });
  expect(doc1.statusCode).toBe(201);
  const doc2 = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    payload: {
      kind: 'text',
      content:
        '# 间隔重复\n\n间隔重复通过在遗忘边缘复习来提升长期保持率。\n\n# 提取练习\n\n提取练习要求主动回忆而非重读,效果更好。',
      title: '学习方法',
    },
  });
  expect(doc2.statusCode).toBe(201);

  for (const doc of [doc1, doc2]) {
    const materialId = doc.json().material.id as string;
    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(analyzed.statusCode).toBe(200);
  }
  return workspaceId;
}

describe('graph service lifecycle', () => {
  let ctx: TestApp;
  let workspaceId: string;

  beforeEach(async () => {
    ctx = buildTestApp();
    workspaceId = await importTwoDocuments(ctx);
  });

  it('refuses to generate before concepts exist', async () => {
    const ws = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '空课程' },
    });
    const emptyId = ws.json().workspace.id as string;
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${emptyId}/graph`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('generates, validates, persists and auto-activates a graph version', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(response.statusCode).toBe(201);
    const { version, edges } = response.json();
    expect(version.status).toBe('ready');
    expect(version.provider).toBe('fake');
    expect(version.validationSummary.acceptedCount).toBe(edges.length);
    expect(edges.length).toBeGreaterThanOrEqual(3);
    for (const edge of edges) {
      expect(edge.evidence.length).toBeGreaterThanOrEqual(1);
      expect(edge.evidence[0].startOffset).toBeGreaterThanOrEqual(0);
    }

    const active = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(active.json().version.id).toBe(version.id);
    expect(active.json().concepts.length).toBeGreaterThanOrEqual(4);
    // Cross-document edges exist: concepts span both documents.
    const conceptMaterials = new Set(
      active.json().concepts.map((c: { materialId: string }) => c.materialId),
    );
    expect(conceptMaterials.size).toBe(2);
  });

  it('regenerates into a new version and can re-activate the previous one', async () => {
    const first = (
      await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    const second = (
      await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    expect(second.version.id).not.toBe(first.version.id);

    const versions = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph/versions` })
    ).json().versions;
    expect(versions).toHaveLength(2);

    const activate = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph/versions/${first.version.id}/activate`,
    });
    expect(activate.statusCode).toBe(200);
    const active = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    expect(active.version.id).toBe(first.version.id);
  });

  it('marks a failed generation without touching the active version', async () => {
    const first = (
      await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();

    // All-invalid proposal: unknown concepts → every candidate rejected.
    const badPayload: GraphProposalPayload = {
      edges: [
        {
          sourceConceptId: 'con_nope_1',
          targetConceptId: 'con_nope_2',
          relation: 'prerequisite',
          explanation: '无效概念。',
          evidence: [{ blockId: 'blk_nope', quote: '无效引文。' }],
        },
      ],
    };
    const spy = vi.spyOn(ctx.provider, 'proposeGraphEdges').mockResolvedValue(badPayload);

    const failed = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error.code).toBe('GROUNDING_FAILED');
    spy.mockRestore();

    // Active graph unchanged; failed version recorded with its summary.
    const active = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    expect(active.version.id).toBe(first.version.id);
    expect(active.edges.length).toBe(first.edges.length);

    const versions = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph/versions` })
    ).json().versions;
    const failedVersion = versions.find((v: { status: string }) => v.status === 'failed');
    expect(failedVersion).toBeDefined();
    expect(failedVersion.validationSummary.rejectedCount).toBe(1);
  });

  it('marks the version failed when the provider itself errors', async () => {
    const spy = vi
      .spyOn(ctx.provider, 'proposeGraphEdges')
      .mockRejectedValue(new Error('provider boom'));
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(response.statusCode).toBe(500);
    spy.mockRestore();

    const versions = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph/versions` })
    ).json().versions;
    expect(versions[0].status).toBe('failed');
  });

  it('rejects activating a failed version and unknown versions', async () => {
    const spy = vi
      .spyOn(ctx.provider, 'proposeGraphEdges')
      .mockRejectedValue(new Error('provider boom'));
    await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` });
    spy.mockRestore();
    const versions = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph/versions` })
    ).json().versions;
    const failedId = versions[0].id;

    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph/versions/${failedId}/activate`,
    });
    expect(bad.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph/versions/gv_missing/activate`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('reports deterministic learner overlay states', async () => {
    await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` });
    const overlay = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/overlay` })
    ).json().states;
    expect(overlay.length).toBeGreaterThanOrEqual(4);
    for (const state of overlay) {
      expect(state.state).toBe('unassessed');
      expect(state.mastery).toBeNull();
      expect(state.attempts).toBe(0);
      expect(state.hasEnoughActivity).toBe(false);
      expect(state.treatAsWeak).toBe(false);
    }
    // Prerequisite chain from the fake provider is reflected.
    const withPrereq = overlay.filter(
      (s: { prerequisiteConceptIds: string[] }) => s.prerequisiteConceptIds.length > 0,
    );
    expect(withPrereq.length).toBeGreaterThanOrEqual(1);
  });
});

describe('graph proposal context bounding (Phase 1)', () => {
  it('large workspaces send evidence-centred blocks to the provider, not the whole corpus', async () => {
    // Heading-less paragraphs: the outline falls back to synthetic windows
    // and the fake provider derives distinct concept names per paragraph.
    const paragraphs: string[] = [];
    for (let i = 0; i < 140; i++) {
      paragraphs.push(`第${i}段:这一段包含一个足够长的说明,用来把文档撑到超过上下文预算的规模。`);
      paragraphs.push('');
    }
    const ctx = buildTestApp();
    const ws = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '大文档图谱' },
    });
    const workspaceId = ws.json().workspace.id as string;
    const doc = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content: paragraphs.join('\n') },
    });
    const materialId = doc.json().material.id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${materialId}/analyze` });
    expect(ctx.repos.materials.getConcepts(materialId).length).toBeGreaterThanOrEqual(2);

    let promptBlockCount = 0;
    const original = ctx.provider.proposeGraphEdges.bind(ctx.provider);
    ctx.provider.proposeGraphEdges = async (input, opts) => {
      promptBlockCount = input.blocks.length;
      return original(input, opts);
    };
    const generated = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(generated.statusCode).toBe(201);
    const totalBlocks = ctx.repos.materials.getBlocks(materialId).length;
    expect(totalBlocks).toBeGreaterThan(120);
    expect(promptBlockCount).toBeGreaterThan(0);
    expect(promptBlockCount).toBeLessThan(totalBlocks);
    // Accepted edges still verified against the FULL corpus.
    expect(generated.json().edges.length).toBeGreaterThan(0);
  });
});
