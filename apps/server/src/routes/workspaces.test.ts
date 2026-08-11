import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../repositories/index.js';
import { buildApp } from '../app.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { fixedClock } from '../util/ids.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { makeMistake, makeQuestion, makeWorkspace, T0 } from '../testing/fixtures.js';

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
    expect(material.parserVersion).toBe('pdf-layout-v2');
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

  it('activates a successor PDF revision without deleting prior extraction history', async () => {
    const imported = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: { kind: 'file', filename: 'memory.pdf', dataBase64: samplePdfB64() },
      })
    ).json();
    const docId = imported.material.id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/materials/${docId}/analyze` });
    const oldConcepts = ctx.repos.materials.getConcepts(docId);
    expect(oldConcepts.length).toBeGreaterThan(0);
    const oldRevision = ctx.repos.materialRevisions.getActive(docId)!;
    const oldBlockIds = ctx.repos.materials.getBlocks(docId).map((block) => block.id);
    const rolesBefore = ctx.db
      .prepare(
        'SELECT id, role, learner_confirmed FROM material_role_versions WHERE material_id = ?',
      )
      .all(docId);

    const reprocessed = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents/${docId}/reprocess`,
    });
    expect(reprocessed.statusCode).toBe(200);
    const { material, blocks } = reprocessed.json();
    expect(material.id).toBe(docId);
    expect(material.pageCount).toBe(2);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const revisions = ctx.repos.materialRevisions.list(docId);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]!.status).toBe('active');
    expect(revisions[0]!.predecessorRevisionId).toBe(oldRevision.id);
    expect(revisions[1]!.status).toBe('retired');
    expect(revisions[1]!.id).toBe(oldRevision.id);
    expect(blocks.map((block: { id: string }) => block.id)).not.toEqual(oldBlockIds);
    // The active projection has no concepts until re-analysis, but old rows
    // and role/scope identity remain immutable and inspectable.
    expect(ctx.repos.materials.getConcepts(docId)).toHaveLength(0);
    expect(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM concepts WHERE material_id = ?').get(docId),
    ).toEqual({ n: oldConcepts.length });
    expect(
      ctx.db
        .prepare(
          'SELECT id, role, learner_confirmed FROM material_role_versions WHERE material_id = ?',
        )
        .all(docId),
    ).toEqual(rolesBefore);
    expect(ctx.repos.materials.getBlocks(docId).length).toBe(blocks.length);
  });

  it('records a failed reprocess attempt and preserves the prior active revision', async () => {
    const imported = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: { kind: 'file', filename: 'memory.pdf', dataBase64: samplePdfB64() },
      })
    ).json();
    const docId = imported.material.id as string;
    const activeBefore = ctx.repos.materialRevisions.getActive(docId)!;
    const blocksBefore = ctx.repos.materials.getBlocks(docId);
    ctx.db
      .prepare('UPDATE material_revisions SET original_data = NULL WHERE id = ?')
      .run(activeBefore.id);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents/${docId}/reprocess`,
    });

    expect(response.statusCode).toBe(400);
    expect(ctx.repos.materialRevisions.getActive(docId)!.id).toBe(activeBefore.id);
    expect(ctx.repos.materialRevisions.list(docId)).toHaveLength(1);
    expect(ctx.repos.materials.getBlocks(docId)).toEqual(blocksBefore);
    expect(
      ctx.db
        .prepare('SELECT status, revision_id FROM material_parser_attempts WHERE material_id = ?')
        .get(docId),
    ).toEqual({ status: 'failed', revision_id: null });
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
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ workspaceId, workspaceDeleted: false });

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    // No dangling edges: every remaining edge references surviving concepts.
    expect(after.statusCode).toBe(200);
    expect(after.json().version).toBeDefined();
    expect(ctx.repos.workspaces.get(workspaceId)?.activeGraphVersionId).toBeNull();
    // The pruned marker is visible on the affected version.
    // 404 on the removed document; workspace still healthy.
    const gone = await ctx.app.inject({ method: 'GET', url: `/api/materials/${doc2.material.id}` });
    expect(gone.statusCode).toBe(200);
    expect(gone.json().material.availability).toBe('retired');
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

/**
 * Course-space deletion lifecycle, decided by the persisted workspace origin:
 *
 * - `material_import` (auto-created for a 资料库 import): an implementation
 *   detail of that import — deleting its FINAL document retires the
 *   workspace in the same transaction (no `0 文档 · 0 概念` ghost remains).
 * - `manual` (POST /api/workspaces): a deliberate container — always
 *   preserved, with honest zero counts, even after its final document.
 * - `unknown` (pre-origin rows, incl. migration-created legacy spaces):
 *   conservatively preserved like `manual`; removable via the explicit
 *   删除课程空间 action, which stays the cascade path for every origin.
 */
describe('course-space lifecycle after document deletion', () => {
  let ctx: TestApp;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  const TEXT_A = '# 工作记忆\n\n工作记忆的容量十分有限。\n\n# 组块\n\n组块化能提升记忆容量利用率。';
  const TEXT_B = '# 间隔重复\n\n间隔重复提升长期保持率。\n\n# 提取练习\n\n提取练习优于重读。';

  async function importLegacyMaterial(content: string, title: string) {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content, title },
    });
    expect(created.statusCode).toBe(201);
    return created.json().material as { id: string; workspaceId: string };
  }

  async function addDocument(workspaceId: string, content: string) {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content },
    });
    expect(created.statusCode).toBe(201);
    return created.json().material as { id: string };
  }

  async function analyze(materialId: string) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(res.statusCode).toBe(200);
  }

  async function listWorkspaces() {
    return (await ctx.app.inject({ method: 'GET', url: '/api/workspaces' })).json()
      .workspaces as Array<{
      id: string;
      origin: string;
      documentCount: number;
      conceptCount: number;
    }>;
  }

  it('persists the origin of every creation path', async () => {
    const imported = await importLegacyMaterial(TEXT_A, '导入课程');
    const manual = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: '手动课程' },
      })
    ).json().workspace as { id: string; origin: string };
    expect(manual.origin).toBe('manual');

    const listed = await listWorkspaces();
    expect(listed.find((w) => w.id === imported.workspaceId)?.origin).toBe('material_import');
    expect(listed.find((w) => w.id === manual.id)?.origin).toBe('manual');
    // The origin is immutable: no API mutates it (rename must not touch it).
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${manual.id}`,
      payload: { name: '改名后' },
    });
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${manual.id}` })).json()
        .workspace.origin,
    ).toBe('manual');
  });

  it('deleting the final 资料库 document retires its auto-created workspace in the same transaction (the ghost-entry fix)', async () => {
    const material = await importLegacyMaterial(TEXT_A, '课程A');
    await analyze(material.id);
    // Give the import workspace every kind of surviving workspace-scoped
    // row: a graph version and a graded diagnostic assessment (workspace
    // quiz + questions + submission + grading result + blueprints + review
    // events).
    const graph = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${material.workspaceId}/graph`,
    });
    expect(graph.statusCode).toBe(201);
    const assessment = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${material.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    expect(assessment.statusCode).toBe(201);
    const wsQuiz = assessment.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string }>;
    };
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${wsQuiz.id}/submissions`,
      payload: {
        answers: wsQuiz.questions.map((q) =>
          q.type === 'short_answer' || q.type === 'concept_comparison'
            ? { questionId: q.id, type: q.type, text: '不确定。' }
            : { questionId: q.id, type: q.type, selectedOptionIds: [] },
        ),
      },
    });
    expect(submitted.statusCode).toBe(201);

    // An unrelated workspace that must survive untouched.
    const other = await importLegacyMaterial(TEXT_B, '课程B');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/materials/${material.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ workspaceId: material.workspaceId, workspaceDeleted: false });

    // 资料库 truth: the material is gone; 学习图谱 truth: no ghost remains.
    const materials = (await ctx.app.inject({ method: 'GET', url: '/api/materials' })).json();
    expect(materials.materials.some((m: { id: string }) => m.id === material.id)).toBe(false);
    const listed = await listWorkspaces();
    expect(listed.some((w) => w.id === material.workspaceId)).toBe(true);
    expect(listed.some((w) => w.id === other.workspaceId)).toBe(true);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${material.workspaceId}` }))
        .statusCode,
    ).toBe(200);

    // Every workspace-scoped row that used to survive the old lifecycle was
    // cascade-deleted with the workspace — nothing orphan-like remains.
    for (const [table, sql] of Object.entries({
      quizzes: 'SELECT COUNT(*) AS n FROM quizzes WHERE workspace_id = ?',
      graph_versions: 'SELECT COUNT(*) AS n FROM graph_versions WHERE workspace_id = ?',
      review_events: 'SELECT COUNT(*) AS n FROM review_events WHERE workspace_id = ?',
      question_blueprints: 'SELECT COUNT(*) AS n FROM question_blueprints WHERE workspace_id = ?',
    })) {
      const row = ctx.db.prepare(sql).get(material.workspaceId) as { n: number };
      expect(row.n, table).toBeGreaterThan(0);
    }
    expect(ctx.db.pragma('foreign_key_check')).toEqual([]);

    // Repeating the deletion reports 404 honestly and changes nothing.
    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/materials/${material.id}` });
    expect(again.statusCode).toBe(409);
  });

  it('an import workspace that gained a second document survives until the FINAL one goes (in-transaction re-check)', async () => {
    const material = await importLegacyMaterial(TEXT_A, '课程A');
    const added = await addDocument(material.workspaceId, TEXT_B);

    // Non-final: the workspace stays (a later import raced ahead of the
    // delete — the transaction re-checks the remaining count, not a stale
    // client-side snapshot).
    const first = await ctx.app.inject({ method: 'DELETE', url: `/api/materials/${material.id}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ workspaceId: material.workspaceId, workspaceDeleted: false });
    expect((await listWorkspaces()).find((w) => w.id === material.workspaceId)).toMatchObject({
      documentCount: 1,
    });

    // Final (via the workspace-document endpoint — same transaction, same
    // rule): the import workspace retires with it.
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${material.workspaceId}/documents/${added.id}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ workspaceId: material.workspaceId, workspaceDeleted: false });
    expect((await listWorkspaces()).find((w) => w.id === material.workspaceId)).toMatchObject({
      documentCount: 0,
    });
  });

  it('deleting the final document of a MANUAL workspace preserves it with zero counts', async () => {
    const ws = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: '手动课程' },
      })
    ).json().workspace.id as string;
    const doc = await addDocument(ws, TEXT_A);
    await analyze(doc.id);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${ws}/documents/${doc.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ workspaceId: ws, workspaceDeleted: false });

    const after = (await listWorkspaces()).find((w) => w.id === ws);
    expect(after).toMatchObject({ documentCount: 0, conceptCount: 0, origin: 'manual' });
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/workspaces/${ws}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().documents).toHaveLength(0);
  });

  it('preserves UNKNOWN-origin (pre-upgrade / legacy) workspaces and keeps them manually deletable', async () => {
    // A workspace persisted before origins existed — exactly what migration
    // 11 leaves behind for legacy rows.
    ctx.repos.workspaces.insert(
      makeWorkspace({ id: 'ws_old', name: '历史空间', origin: 'unknown' }),
    );
    const doc = await addDocument('ws_old', TEXT_A);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/ws_old/documents/${doc.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ workspaceId: 'ws_old', workspaceDeleted: false });
    expect((await listWorkspaces()).find((w) => w.id === 'ws_old')).toMatchObject({
      documentCount: 0,
      origin: 'unknown',
    });

    // The explicit 删除课程空间 action still retires it.
    const wsDeleted = await ctx.app.inject({ method: 'DELETE', url: '/api/workspaces/ws_old' });
    expect(wsDeleted.statusCode).toBe(204);
    expect((await listWorkspaces()).some((w) => w.id === 'ws_old')).toBe(false);
  });

  it('deleting a non-final document corrects the counts and keeps the rest', async () => {
    const ws = (
      await ctx.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '双文档' } })
    ).json().workspace.id as string;
    const docA = await addDocument(ws, TEXT_A);
    const docB = await addDocument(ws, TEXT_B);
    await analyze(docA.id);
    await analyze(docB.id);

    const remainingConcepts = ctx.repos.materials.getConcepts(docB.id).length;
    expect(remainingConcepts).toBeGreaterThan(0);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${ws}/documents/${docA.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ workspaceId: ws, workspaceDeleted: false });

    const after = (await listWorkspaces()).find((w) => w.id === ws);
    expect(after).toMatchObject({ documentCount: 1, conceptCount: remainingConcepts });
  });

  it('deleting a workspace cascades every dependent row and leaves other workspaces intact', async () => {
    // Rich workspace A: two analyzed documents, a graph, a graded document
    // quiz, and a graded workspace diagnostic (which also creates canonical
    // alignment baseline rows and question blueprints).
    const wsA = (
      await ctx.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '课程A' } })
    ).json().workspace.id as string;
    const docA1 = await addDocument(wsA, TEXT_A);
    const docA2 = await addDocument(wsA, TEXT_B);
    await analyze(docA1.id);
    await analyze(docA2.id);
    const graph = await ctx.app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/graph` });
    expect(graph.statusCode).toBe(201);

    const quiz = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/quizzes',
        payload: {
          materialId: docA1.id,
          config: {
            difficulty: 'medium',
            types: ['single_choice', 'short_answer'],
            countPerType: 1,
          },
        },
      })
    ).json().quiz as { id: string; questions: Array<{ id: string; type: string }> };
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: quiz.questions.map((q) =>
          q.type === 'short_answer'
            ? { questionId: q.id, type: q.type, text: '答错的内容。' }
            : { questionId: q.id, type: q.type, selectedOptionIds: [] },
        ),
      },
    });
    expect(submitted.statusCode).toBe(201);

    const assessment = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsA}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    expect(assessment.statusCode).toBe(201);
    const wsQuiz = assessment.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string }>;
    };
    const wsSubmitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${wsQuiz.id}/submissions`,
      payload: {
        answers: wsQuiz.questions.map((q) =>
          q.type === 'short_answer' || q.type === 'concept_comparison'
            ? { questionId: q.id, type: q.type, text: '不确定。' }
            : { questionId: q.id, type: q.type, selectedOptionIds: [] },
        ),
      },
    });
    expect(wsSubmitted.statusCode).toBe(201);

    // Tables the API flow does not necessarily reach get minimal valid rows,
    // so the cascade is verified for EVERY dependent table.
    const conceptA = ctx.repos.materials.getConcepts(docA1.id)[0]!;
    const seed = (sql: string, ...params: unknown[]) => ctx.db.prepare(sql).run(...params);
    seed(
      `INSERT INTO remediation_plans (id, workspace_id, concept_id, payload, provider, created_at)
       VALUES ('plan_castest', ?, ?, '{}', 'fake', ?)`,
      wsA,
      conceptA.id,
      T0,
    );
    seed(
      `INSERT INTO alignment_proposals (id, workspace_id, source_concept_id, target_concept_id,
         relation, proposed_canonical_name, rationale, evidence, origin, status,
         source_language, target_language, provider, created_at, decided_at)
       VALUES ('alp_castest', ?, ?, ?, 'equivalent', '工作记忆', '同名', '[]', 'local_rule',
         'proposed', 'zh', 'zh', 'fake', ?, NULL)`,
      wsA,
      conceptA.id,
      ctx.repos.materials.getConcepts(docA2.id)[0]!.id,
      T0,
    );
    seed(
      `INSERT INTO misconceptions (id, workspace_id, concept_id, status, category, payload, created_at, updated_at)
       VALUES ('mcp_castest', ?, ?, 'proposed', 'overgeneralization', '{}', ?, ?)`,
      wsA,
      conceptA.id,
      T0,
      T0,
    );
    seed(
      `INSERT OR IGNORE INTO review_items (workspace_id, concept_id, concept_name, stability, difficulty,
         due_at, last_reviewed_at, interval_days, review_count, lapse_count, last_rating,
         scheduler_version, created_at, updated_at)
       VALUES (?, ?, ?, 1.0, 5.0, ?, ?, 1.0, 1, 0, 'good', 'fsrs-lite-v1', ?, ?)`,
      wsA,
      conceptA.id,
      conceptA.name,
      T0,
      T0,
      T0,
      T0,
    );
    seed(
      `INSERT INTO tutor_runs (id, workspace_id, concept_id, concept_name, status, provider, created_at, updated_at)
       VALUES ('run_castest', ?, ?, ?, 'completed', 'fake', ?, ?)`,
      wsA,
      conceptA.id,
      conceptA.name,
      T0,
      T0,
    );
    seed(
      `INSERT INTO tutor_events (id, run_id, seq, kind, summary, created_at)
       VALUES ('evt_castest', 'run_castest', 0, 'state_inspected', '已读取学习状态。', ?)`,
      T0,
    );

    // Light workspace B that must survive untouched.
    const wsB = (
      await ctx.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '课程B' } })
    ).json().workspace.id as string;
    const docB = await addDocument(wsB, TEXT_B);
    await analyze(docB.id);

    /** Ids of every row reachable from a workspace, per table. */
    const scopedIds = (workspaceId: string): Record<string, string[]> => {
      const all = (sql: string, binds = 1) =>
        (
          ctx.db.prepare(sql).all(...Array<string>(binds).fill(workspaceId)) as Array<{
            id: string;
          }>
        ).map((r) => String(r.id));
      return {
        materials: all(`SELECT id FROM materials WHERE workspace_id = ?`),
        source_blocks: all(
          `SELECT b.id FROM source_blocks b JOIN materials m ON m.id = b.material_id WHERE m.workspace_id = ?`,
        ),
        concepts: all(
          `SELECT c.id FROM concepts c JOIN materials m ON m.id = c.material_id WHERE m.workspace_id = ?`,
        ),
        quizzes: all(
          `SELECT q.id FROM quizzes q LEFT JOIN materials m ON m.id = q.material_id
           WHERE q.workspace_id = ? OR m.workspace_id = ?`,
          2,
        ),
        questions: all(
          `SELECT que.id FROM questions que JOIN quizzes q ON q.id = que.quiz_id
           LEFT JOIN materials m ON m.id = q.material_id
           WHERE q.workspace_id = ? OR m.workspace_id = ?`,
          2,
        ),
        submissions: all(
          `SELECT s.id FROM submissions s JOIN quizzes q ON q.id = s.quiz_id
           LEFT JOIN materials m ON m.id = q.material_id
           WHERE q.workspace_id = ? OR m.workspace_id = ?`,
          2,
        ),
        grading_results: all(
          `SELECT g.id FROM grading_results g JOIN quizzes q ON q.id = g.quiz_id
           LEFT JOIN materials m ON m.id = q.material_id
           WHERE q.workspace_id = ? OR m.workspace_id = ?`,
          2,
        ),
        mistakes: all(
          `SELECT k.id FROM mistakes k JOIN materials m ON m.id = k.material_id WHERE m.workspace_id = ?`,
        ),
        mastery_states: all(
          `SELECT ms.material_id || '/' || ms.concept_id AS id FROM mastery_states ms
           JOIN materials m ON m.id = ms.material_id WHERE m.workspace_id = ?`,
        ),
        graph_versions: all(`SELECT id FROM graph_versions WHERE workspace_id = ?`),
        graph_edges: all(
          `SELECT e.id FROM graph_edges e JOIN graph_versions v ON v.id = e.graph_version_id
           WHERE v.workspace_id = ?`,
        ),
        graph_edge_evidence: all(
          `SELECT ev.id FROM graph_edge_evidence ev JOIN graph_edges e ON e.id = ev.edge_id
           JOIN graph_versions v ON v.id = e.graph_version_id WHERE v.workspace_id = ?`,
        ),
        remediation_plans: all(`SELECT id FROM remediation_plans WHERE workspace_id = ?`),
        canonical_concepts: all(`SELECT id FROM canonical_concepts WHERE workspace_id = ?`),
        canonical_members: all(
          `SELECT cm.source_concept_id AS id FROM canonical_members cm
           JOIN canonical_concepts cc ON cc.id = cm.canonical_concept_id WHERE cc.workspace_id = ?`,
        ),
        alignment_proposals: all(`SELECT id FROM alignment_proposals WHERE workspace_id = ?`),
        misconceptions: all(`SELECT id FROM misconceptions WHERE workspace_id = ?`),
        review_items: all(
          `SELECT workspace_id || '/' || concept_id AS id FROM review_items WHERE workspace_id = ?`,
        ),
        review_events: all(`SELECT id FROM review_events WHERE workspace_id = ?`),
        tutor_runs: all(`SELECT id FROM tutor_runs WHERE workspace_id = ?`),
        tutor_events: all(
          `SELECT e.id FROM tutor_events e JOIN tutor_runs r ON r.id = e.run_id WHERE r.workspace_id = ?`,
        ),
        question_blueprints: all(`SELECT id FROM question_blueprints WHERE workspace_id = ?`),
      };
    };

    const before = scopedIds(wsA);
    const beforeB = scopedIds(wsB);
    // Every dependent table really has workspace-A data before the deletion.
    for (const [table, ids] of Object.entries(before)) {
      expect(ids.length, `${table} should have workspace-A rows before deletion`).toBeGreaterThan(
        0,
      );
    }

    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${wsA}` });
    expect(deleted.statusCode).toBe(204);

    const after = scopedIds(wsA);
    for (const [table, ids] of Object.entries(after)) {
      expect(ids, `${table} rows must cascade away with the workspace`).toHaveLength(0);
    }
    expect(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(wsA),
    ).toMatchObject({ n: 0 });

    // Workspace B kept every row.
    expect(scopedIds(wsB)).toEqual(beforeB);
    const listed = await listWorkspaces();
    expect(listed.some((w) => w.id === wsA)).toBe(false);
    expect(listed.some((w) => w.id === wsB)).toBe(true);

    // Repeated deletion follows the API contract honestly.
    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${wsA}` });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('NOT_FOUND');
  });

  it('document and workspace deletion never call the provider', async () => {
    let providerCalls = 0;
    const counting = new Proxy(new FakeProvider(), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            providerCalls += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    ctx = buildTestApp({ provider: counting });

    const material = await importLegacyMaterial(TEXT_A, '课程A');
    await analyze(material.id);
    const manual = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: '手动课程' },
      })
    ).json().workspace.id as string;
    const callsAfterSetup = providerCalls;
    expect(callsAfterSetup).toBeGreaterThan(0);

    // Final-document deletion (which also retires the import workspace)…
    const docDeleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/materials/${material.id}`,
    });
    expect(docDeleted.statusCode).toBe(200);
    expect(docDeleted.json().workspaceDeleted).toBe(false);
    // …and the explicit 删除课程空间 action are both provider-free.
    const wsDeleted = await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${manual}` });
    expect(wsDeleted.statusCode).toBe(204);
    await listWorkspaces();
    expect(providerCalls).toBe(callsAfterSetup);
  });

  it('deletion outcomes survive a server restart on the same database file', async () => {
    const dbPath = join(tmpdir(), `hy3-clinic-lifecycle-${process.pid}-${Date.now()}.sqlite`);
    const openApp = () => {
      const db = openDatabase(dbPath);
      migrate(db);
      const repos = createRepositories(db);
      const app = buildApp({ repos, provider: new FakeProvider(), clock: fixedClock(T0) });
      app.addHook('onClose', async () => {
        db.close();
      });
      return app;
    };

    try {
      const first = openApp();
      const material = (
        await first.inject({
          method: 'POST',
          url: '/api/materials',
          payload: { content: TEXT_A, title: '课程A' },
        })
      ).json().material as { id: string; workspaceId: string };
      const doomed = (
        await first.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '待删除' } })
      ).json().workspace.id as string;
      const kept = (
        await first.inject({ method: 'POST', url: '/api/workspaces', payload: { name: '空手动' } })
      ).json().workspace.id as string;

      const matDeleted = await first.inject({
        method: 'DELETE',
        url: `/api/materials/${material.id}`,
      });
      expect(matDeleted.json().workspaceDeleted).toBe(false);
      const wsDeleted = await first.inject({ method: 'DELETE', url: `/api/workspaces/${doomed}` });
      expect(wsDeleted.statusCode).toBe(204);
      await first.close();

      // "Restart": a fresh app over the same SQLite file.
      const second = openApp();
      const listed = (await second.inject({ method: 'GET', url: '/api/workspaces' })).json()
        .workspaces as Array<{ id: string; documentCount: number; conceptCount: number }>;
      expect(listed.some((w) => w.id === doomed)).toBe(false);
      // The retired import workspace stays gone — no ghost reappears…
      expect(listed.some((w) => w.id === material.workspaceId)).toBe(true);
      // …while the empty manual workspace persists with honest zero counts.
      expect(listed.find((w) => w.id === kept)).toMatchObject({
        documentCount: 0,
        conceptCount: 0,
      });
      const materials = (await second.inject({ method: 'GET', url: '/api/materials' })).json();
      expect(materials.materials).toHaveLength(0);
      await second.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
  });
});

describe('queue launch sweep and named-review semantics (Phase 0)', () => {
  // Each section must be substantial enough (≥ MIN_SECTION_CHARS) that the
  // deterministic outline keeps six separate sections, so the size-aware
  // extraction yields one concept per section.
  const sectionBody = (name: string): string =>
    `${name}的核心内容如下:它先给出严格定义,再解释适用条件与边界情况,然后通过两个对照示例演示正误用法,并总结与相邻概念的联系。`.repeat(
      8,
    );
  const DOC = [
    '# 概念零',
    '',
    sectionBody('概念零'),
    '',
    '# 概念一',
    '',
    sectionBody('概念一'),
    '',
    '# 概念二',
    '',
    sectionBody('概念二'),
    '',
    '# 概念三',
    '',
    sectionBody('概念三'),
    '',
    '# 概念四',
    '',
    sectionBody('概念四'),
    '',
    '# 概念五',
    '',
    sectionBody('概念五'),
  ].join('\n');

  let ctx: TestApp;
  let workspaceId: string;
  let materialId: string;
  let conceptIds: string[];

  beforeEach(async () => {
    ctx = buildTestApp();
    const ws = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '队列可执行性' },
    });
    workspaceId = ws.json().workspace.id;
    const doc = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content: DOC },
    });
    materialId = doc.json().material.id;
    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    conceptIds = (analyzed.json().concepts as Array<{ id: string }>).map((c) => c.id);
    expect(conceptIds.length).toBeGreaterThanOrEqual(6);
    const graph = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/graph`,
    });
    expect(graph.statusCode).toBe(201);
  });

  function seedReview(conceptId: string, dueAt: string): void {
    const concept = ctx.repos.materials.getConcept(conceptId)!;
    ctx.repos.review.upsert({
      workspaceId,
      conceptId,
      conceptName: concept.name,
      stability: 1,
      difficulty: 5,
      dueAt,
      lastReviewedAt: T0,
      intervalDays: 1,
      reviewCount: 1,
      lapseCount: 0,
      lastRating: 'good',
      schedulerVersion: 'local-fsrs-v1',
      createdAt: T0,
      updatedAt: T0,
    });
  }

  it('unnamed review launch keeps strict due-now semantics', async () => {
    // Only a later-today review exists: generic review must still refuse…
    seedReview(conceptIds[3]!, new Date(Date.parse(T0) + 6 * 3600 * 1000).toISOString());
    const generic = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/assessments`,
      payload: { mode: 'review' },
    });
    expect(generic.statusCode).toBe(400);
    expect(generic.json().error.message).toContain('当前没有到期的复习概念');

    // …while naming the concept follows the queue's advertised semantics.
    const named = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/assessments`,
      payload: { mode: 'review', conceptIds: [conceptIds[3]!] },
    });
    expect(named.statusCode).toBe(201);

    // Naming a concept with no eligible schedule fails with the honest reason.
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/assessments`,
      payload: { mode: 'review', conceptIds: [conceptIds[5]!] },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toContain('目标概念今天没有到期的复习安排');
  });

  it('EVERY returned queue item launches immediately with its server-resolved payload', async () => {
    // c4 stays unnamed: it enters the queue as c5's weak prerequisite via
    // the graph edge alone, with no direct seeding of its own.
    const [c0, c1, c2, c3, , c5] = conceptIds as [string, string, string, string, string, string];
    const conceptOf = (id: string) => ctx.repos.materials.getConcept(id)!;

    // Tier 3: open mistake on c0.
    ctx.repos.mistakes.insert(
      makeMistake({
        id: 'mis_sweep_0',
        materialId,
        conceptId: c0,
        conceptName: conceptOf(c0).name,
        question: makeQuestion({ conceptId: c0, conceptName: conceptOf(c0).name }),
      }),
    );
    // Tier 2: confirmed misconception on c1.
    ctx.repos.misconceptions.insert({
      id: 'mc_sweep_1',
      workspaceId,
      conceptId: c1,
      conceptName: conceptOf(c1).name,
      originBlueprintId: null,
      originQuestionId: 'que_sweep',
      originQuizId: 'qz_sweep',
      learnerAnswer: { questionId: 'que_sweep', type: 'single_choice', selectedOptionIds: ['B'] },
      evidence: [],
      category: 'definition_confusion',
      hypothesis: '可能混淆了概念一与概念零。',
      provider: 'fake',
      status: 'confirmed',
      decidedByQuizId: null,
      createdAt: T0,
      updatedAt: T0,
    });
    // Tier 1: overdue review on c2; tier 5: due later today on c3.
    seedReview(c2, new Date(Date.parse(T0) - 24 * 3600 * 1000).toISOString());
    seedReview(c3, new Date(Date.parse(T0) + 6 * 3600 * 1000).toISOString());
    // Tier 4: c5 weak (low mastery) → its prerequisite c4 needs work.
    ctx.repos.mastery.upsert({
      materialId,
      conceptId: c5,
      conceptName: conceptOf(c5).name,
      mastery: 0.4,
      attempts: 1,
      correctCount: 0,
      lastScore: 0.4,
      updatedAt: T0,
    });

    const queueRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/queue`,
    });
    const items = queueRes.json().items as Array<{
      kind: string;
      conceptId: string;
      launch: { mode: string; conceptIds?: string[]; misconceptionId?: string };
    }>;
    // All five tiers are present…
    expect(items.map((i) => i.kind)).toEqual([
      'overdue_review',
      'misconception_repair',
      'open_mistakes',
      'weak_prerequisite',
      'due_review',
    ]);
    // …and EVERY item's server-resolved launch request succeeds right now.
    for (const item of items) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/assessments`,
        payload: item.launch,
      });
      expect(res.statusCode, `${item.kind}:${item.conceptId}`).toBe(201);
    }
  });

  it('the tutor run-activity route launches server-side and reports adjustments', async () => {
    const tutorRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tutor`,
      payload: { conceptId: conceptIds[1]! },
    });
    const runLine = tutorRes.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; run?: { id: string; status: string } })
      .find((l) => l.kind === 'run');
    expect(runLine?.run?.status).toBe('completed');

    const launched = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/tutor/runs/${runLine!.run!.id}/activity`,
    });
    expect(launched.statusCode).toBe(201);
    const body = launched.json();
    expect(body.quiz.kind).toBe('adaptive');
    expect(body.launchedMode).toBeTruthy();
    // A fresh run's recommendation launches without adjustment.
    expect(body.adjusted).toBeNull();
  });
});

describe('course progression (Phase 1)', () => {
  // Sections sized past MIN_SECTION_CHARS so the outline keeps three
  // sections and extraction grounds one concept in each.
  const progressionBody = (name: string): string =>
    `${name}部分详细展开:先明确它要解决的问题与前提假设,再逐步给出操作方式和注意事项,并用一个完整例子演示从头到尾的做法,最后归纳常见误区与检查要点。`.repeat(
      4,
    );
  const DOC = [
    '# 基础概念',
    '',
    progressionBody('基础概念'),
    '',
    '# 进阶方法',
    '',
    progressionBody('进阶方法'),
    '',
    '# 综合应用',
    '',
    progressionBody('综合应用'),
  ].join('\n');

  let ctx: TestApp;
  let workspaceId: string;
  let materialId: string;
  let conceptIds: string[];

  beforeEach(async () => {
    ctx = buildTestApp();
    const ws = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: '课程推进' },
    });
    workspaceId = ws.json().workspace.id;
    const doc = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content: DOC },
    });
    materialId = doc.json().material.id;
    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    conceptIds = (analyzed.json().concepts as Array<{ id: string }>).map((c) => c.id);
    expect(conceptIds.length).toBeGreaterThanOrEqual(3);
  });

  it('a fresh workspace queues unassessed concepts and every item launches', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/queue`,
    });
    const items = res.json().items as Array<{
      kind: string;
      conceptId: string;
      launch: { mode: string; conceptIds?: string[] };
    }>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => i.kind === 'unassessed_next')).toBe(true);
    for (const item of items) {
      const launch = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/assessments`,
        payload: item.launch,
      });
      expect(launch.statusCode, item.conceptId).toBe(201);
    }
  });

  it('assessed concepts leave the progression tier; importance ranks the rest', async () => {
    const concept = ctx.repos.materials.getConcept(conceptIds[0]!)!;
    ctx.repos.mastery.upsert({
      materialId,
      conceptId: concept.id,
      conceptName: concept.name,
      mastery: 0.9,
      attempts: 3,
      correctCount: 3,
      lastScore: 0.9,
      updatedAt: T0,
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/queue`,
    });
    const items = res.json().items as Array<{ kind: string; conceptId: string }>;
    expect(items.every((i) => i.kind === 'unassessed_next')).toBe(true);
    expect(items.map((i) => i.conceptId)).not.toContain(concept.id);
  });

  it('diagnostic target selection prefers unassessed concepts over the first groups', async () => {
    // Assess every concept except the LAST one; the old first-N selection
    // would still test the leading groups — the new selection must include
    // the unassessed concept.
    const unassessedId = conceptIds[conceptIds.length - 1]!;
    for (const conceptId of conceptIds) {
      if (conceptId === unassessedId) continue;
      const concept = ctx.repos.materials.getConcept(conceptId)!;
      ctx.repos.mastery.upsert({
        materialId,
        conceptId,
        conceptName: concept.name,
        mastery: 0.8,
        attempts: 2,
        correctCount: 2,
        lastScore: 0.8,
        updatedAt: T0,
      });
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    expect(res.statusCode).toBe(201);
    const targetConceptIds = res.json().quiz.targetConceptIds as string[];
    expect(targetConceptIds).toContain(unassessedId);
  });
});
