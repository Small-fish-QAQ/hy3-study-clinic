import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../testing/files');
const samplePdfB64 = () => readFileSync(join(filesDir, 'sample.pdf')).toString('base64');
const sampleDocxB64 = () => readFileSync(join(filesDir, 'sample.docx')).toString('base64');
const artifactsPdfB64 = () => readFileSync(join(filesDir, 'artifacts.pdf')).toString('base64');

describe('workspace CRUD', () => {
  let ctx: TestApp;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it('creates, lists, renames, and deletes workspaces', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '认知科学', description: '记忆与学习' },
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json().workspace;
    expect(workspace.name).toBe('认知科学');
    expect(workspace.activeGraphVersionId).toBeNull();

    // testApp seeds a fixture workspace; ours is at the top (latest update).
    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/workspaces' })).json();
    expect(listed.workspaces.map((w: { id: string }) => w.id)).toContain(workspace.id);

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspace.id}`,
      payload: { name: '认知科学(修订)' },
    });
    expect(renamed.json().workspace.name).toBe('认知科学(修订)');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspace.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    const after = await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}` });
    expect(after.statusCode).toBe(404);
  });

  it('validates workspace names and unknown ids', async () => {
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '  ' },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/workspaces/ws_missing' });
    expect(missing.statusCode).toBe(404);
    const del = await ctx.app.inject({ method: 'DELETE', url: '/api/workspaces/ws_missing' });
    expect(del.statusCode).toBe(404);
  });

  it('legacy POST /api/materials still works and auto-creates a compat workspace', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '# 旧入口\n\n通过旧接口导入的资料。' },
    });
    expect(created.statusCode).toBe(201);
    const material = created.json().material;
    expect(material.workspaceId).toMatch(/^ws_/);
    const ws = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${material.workspaceId}`,
    });
    expect(ws.statusCode).toBe(200);
    expect(ws.json().documents).toHaveLength(1);
  });
});

describe('document ingestion routes', () => {
  let ctx: TestApp;
  let workspaceId: string;

  beforeEach(async () => {
    ctx = buildTestApp();
    const ws = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '多文档课程' },
    });
    workspaceId = ws.json().workspace.id as string;
  });

  it('adds a pasted-text document (legacy behavior preserved)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content: '# 标题\n\n正文段落。' },
    });
    expect(response.statusCode).toBe(201);
    const { material, blocks } = response.json();
    expect(material.sourceType).toBe('paste');
    expect(material.parseStatus).toBe('parsed');
    expect(material.workspaceId).toBe(workspaceId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].pageNumber).toBeNull();
  });

  it('imports a PDF with page provenance and metadata', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: 'memory.pdf', dataBase64: samplePdfB64() },
    });
    expect(response.statusCode).toBe(201);
    const { material, blocks } = response.json();
    expect(material.sourceType).toBe('pdf');
    expect(material.mediaType).toBe('application/pdf');
    expect(material.originalFilename).toBe('memory.pdf');
    expect(material.pageCount).toBe(2);
    expect(material.parserVersion).toBe('pdf-unpdf-v1');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0].pageNumber).toBe(1);
    expect(blocks[blocks.length - 1].pageNumber).toBe(2);
  });

  it('imports a Chrome/Skia-style PDF with NUL extraction artifacts (regression)', async () => {
    // The workspace surface (学习图谱) must accept the same real-world PDFs
    // as the material library: extractor artifacts are sanitized, not
    // mistaken for binary input.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: 'Weknora学习(2).pdf', dataBase64: artifactsPdfB64() },
    });
    expect(response.statusCode).toBe(201);
    const { material, blocks } = response.json();
    expect(material.sourceType).toBe('pdf');
    expect(material.pageCount).toBe(2);
    expect(material.content).toContain('知识');
    expect(material.content).not.toContain(String.fromCharCode(0));
    expect(blocks[0].pageNumber).toBe(1);
    expect(blocks[blocks.length - 1].pageNumber).toBe(2);
  });

  it('imports a DOCX with heading provenance', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: '讲义.docx', dataBase64: sampleDocxB64() },
    });
    expect(response.statusCode).toBe(201);
    const { material, blocks } = response.json();
    expect(material.sourceType).toBe('docx');
    expect(material.pageCount).toBeNull();
    const headings = blocks.map((b: { heading: string | null }) => b.heading);
    expect(headings).toContain('记忆的科学');
    expect(headings).toContain('间隔重复');
  });

  it('rejects unsupported extensions with 415', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: 'slides.pptx', dataBase64: samplePdfB64() },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_FILE');
  });

  it('rejects malformed PDF/DOCX with 422 and persists nothing', async () => {
    for (const [filename, fixture] of [
      ['broken.pdf', 'malformed.pdf'],
      ['broken.docx', 'malformed.docx'],
    ] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: {
          kind: 'file',
          filename,
          dataBase64: readFileSync(join(filesDir, fixture)).toString('base64'),
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('PARSE_FAILED');
    }
    const docs = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/documents` })
    ).json().documents;
    expect(docs).toHaveLength(0);
  });

  it('rejects an oversized decoded upload with 413', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 16, 0x25).toString('base64');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: 'big.pdf', dataBase64: big },
    });
    expect(response.statusCode).toBe(413);
  });

  it('rejects a mismatched magic number (docx bytes named .pdf)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'file', filename: 'fake.pdf', dataBase64: sampleDocxB64() },
    });
    expect(response.statusCode).toBe(422);
  });

  it('reprocesses a PDF document destructively and reports it', async () => {
    const imported = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: { kind: 'file', filename: 'memory.pdf', dataBase64: samplePdfB64() },
      })
    ).json();
    const docId = imported.material.id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${docId}/analyze` });
    expect(ctx.repos.materials.getConcepts(docId).length).toBeGreaterThan(0);

    const reprocessed = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents/${docId}/reprocess`,
    });
    expect(reprocessed.statusCode).toBe(200);
    const { material, blocks } = reprocessed.json();
    expect(material.id).toBe(docId);
    expect(material.pageCount).toBe(2);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // Dependent extraction data was explicitly reset.
    expect(ctx.repos.materials.getConcepts(docId)).toHaveLength(0);
    expect(ctx.repos.materials.getBlocks(docId).length).toBe(blocks.length);
  });

  it('deleting a document prunes graph edges that referenced its concepts', async () => {
    // Two documents, concepts on both, then a cross-document graph.
    const doc1 = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: {
          kind: 'text',
          content:
            '# 工作记忆\n\n工作记忆的容量十分有限。\n\n# 组块\n\n组块化能提升记忆容量利用率。',
        },
      })
    ).json();
    const doc2 = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: {
          kind: 'text',
          content: '# 间隔重复\n\n间隔重复提升长期保持率。\n\n# 提取练习\n\n提取练习优于重读。',
        },
      })
    ).json();
    for (const doc of [doc1, doc2]) {
      await ctx.app.inject({ method: 'POST', url: `/api/materials/${doc.material.id}/analyze` });
    }
    const generated = (
      await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    expect(generated.version.status).toBe('ready');
    const beforeEdges = generated.edges.length;
    expect(beforeEdges).toBeGreaterThanOrEqual(3);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}/documents/${doc2.material.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const after = (
      await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/graph` })
    ).json();
    // No dangling edges: every remaining edge references surviving concepts.
    const survivingConceptIds = new Set(after.concepts.map((c: { id: string }) => c.id));
    expect(after.edges.length).toBeLessThan(beforeEdges);
    for (const edge of after.edges) {
      expect(survivingConceptIds.has(edge.sourceConceptId)).toBe(true);
      expect(survivingConceptIds.has(edge.targetConceptId)).toBe(true);
      expect(edge.evidence.length).toBeGreaterThanOrEqual(1);
    }
    // The pruned marker is visible on the affected version.
    expect(after.version.validationSummary.pruned).toBeDefined();
    // 404 on the removed document; workspace still healthy.
    const gone = await ctx.app.inject({ method: 'GET', url: `/api/materials/${doc2.material.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('404s for documents outside the workspace', async () => {
    const otherWs = (
      await ctx.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '别的课' } })
    ).json().workspace.id;
    const doc = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: { kind: 'text', content: '内容段落。' },
      })
    ).json();
    const wrong = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${otherWs}/documents/${doc.material.id}`,
    });
    expect(wrong.statusCode).toBe(404);
  });
});
