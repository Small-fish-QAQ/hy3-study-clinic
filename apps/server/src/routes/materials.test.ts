import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_MATERIAL_TITLE } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import {
  makeConcept,
  makeGrounding,
  makeMistake,
  makeQuestion,
  makeQuiz,
  T0,
} from '../testing/fixtures.js';
import type { Submission } from '@hy3-clinic/shared';

let ctx: TestApp;

beforeEach(() => {
  ctx = buildTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

const filesDir = join(dirname(fileURLToPath(import.meta.url)), '../testing/files');
const fixtureB64 = (name: string) => readFileSync(join(filesDir, name)).toString('base64');

interface SeededLearningRecords {
  conceptId: string;
  quizId: string;
  remediationQuizId: string;
  questionId: string;
  remediationQuestionId: string;
  submissionId: string;
  gradingResultId: string;
  mistakeId: string;
}

function seedLearningRecords(
  materialId: string,
  blockId: string,
  suffix: string,
): SeededLearningRecords {
  const conceptId = `con_${suffix}`;
  const quizId = `qz_${suffix}`;
  const remediationQuizId = `qz_rem_${suffix}`;
  const questionId = `que_${suffix}`;
  const remediationQuestionId = `que_rem_${suffix}`;
  const submissionId = `sub_${suffix}`;
  const gradingResultId = `grd_${suffix}`;
  const mistakeId = `mis_${suffix}`;
  const grounding = makeGrounding({ blockId });
  const question = makeQuestion({ id: questionId, quizId, conceptId, grounding });
  const remediationQuestion = makeQuestion({
    id: remediationQuestionId,
    quizId: remediationQuizId,
    conceptId,
    grounding,
    sourceMistakeIds: [mistakeId],
  });

  ctx.repos.materials.replaceConcepts(materialId, [
    makeConcept({ id: conceptId, materialId, grounding }),
  ]);
  ctx.repos.quizzes.insert(makeQuiz({ id: quizId, materialId, questions: [question] }));
  ctx.repos.quizzes.insert(
    makeQuiz({
      id: remediationQuizId,
      materialId,
      kind: 'remediation',
      questions: [remediationQuestion],
      targetConceptIds: [conceptId],
    }),
  );

  const submission: Submission = {
    id: submissionId,
    quizId,
    answers: [{ questionId, type: 'single_choice', selectedOptionIds: ['B'] }],
    createdAt: T0,
  };
  ctx.repos.submissions.insertSubmission(submission);
  ctx.repos.submissions.insertGradingResult({
    id: gradingResultId,
    submissionId,
    quizId,
    grades: [
      {
        questionId,
        type: 'single_choice',
        gradedBy: 'deterministic',
        correct: false,
        awardedPoints: 0,
        maxPoints: 1,
        normalizedScore: 0,
        needsReview: false,
      },
    ],
    totalAwarded: 0,
    totalPossible: 1,
    overallScore: 0,
    createdAt: T0,
  });
  ctx.repos.mistakes.insert(
    makeMistake({
      id: mistakeId,
      materialId,
      quizId,
      questionId,
      conceptId,
      question,
      userAnswer: submission.answers[0]!,
      remediationCount: 1,
    }),
  );
  ctx.repos.mastery.upsert({
    materialId,
    conceptId,
    conceptName: `概念 ${suffix}`,
    mastery: 0.35,
    attempts: 1,
    correctCount: 0,
    lastScore: 0,
    updatedAt: T0,
  });

  return {
    conceptId,
    quizId,
    remediationQuizId,
    questionId,
    remediationQuestionId,
    submissionId,
    gradingResultId,
    mistakeId,
  };
}

describe('POST /api/materials', () => {
  it('imports pasted Chinese markdown and returns blocks', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: {
        content: '# 学习方法\n\n间隔重复优于集中复习。\n\n主动回忆强化记忆通路。',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.material.title).toBe('学习方法');
    expect(body.material.sourceType).toBe('paste');
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0].heading).toBe('学习方法');
    // Slice invariant is preserved through the API.
    expect(body.material.content.slice(body.blocks[0].startOffset, body.blocks[0].endOffset)).toBe(
      body.blocks[0].content,
    );
  });

  it('accepts .md and .txt filenames and records source type', async () => {
    const md = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '# 标题\n\n内容段落。', filename: 'notes.md' },
    });
    expect(md.json().material.sourceType).toBe('md');

    const txt = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '纯文本内容。', filename: 'notes.txt' },
    });
    expect(txt.json().material.sourceType).toBe('txt');
  });

  it('rejects unsupported file extensions with a structured error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '内容', filename: 'slides.pdf' },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_FILE');
  });

  it('rejects empty input', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '   \n  ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EMPTY_SOURCE');
  });

  it('rejects binary input', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: 'PK\u0000\u0003\u0004binary', filename: 'evil.txt' },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('BINARY_INPUT');
  });

  it('rejects oversized input', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '学'.repeat(100_001) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('SOURCE_TOO_LARGE');
  });

  it('rejects a missing content field via validation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '没有内容' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/materials (file imports)', () => {
  it('imports a text PDF with page provenance, a compat workspace, and stored original bytes', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'memory.pdf', dataBase64: fixtureB64('sample.pdf') },
    });
    expect(res.statusCode).toBe(201);
    const { material, blocks } = res.json();
    expect(material.sourceType).toBe('pdf');
    expect(material.mediaType).toBe('application/pdf');
    expect(material.originalFilename).toBe('memory.pdf');
    expect(material.parseStatus).toBe('parsed');
    expect(material.pageCount).toBe(2);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // Page provenance survives the material-library path.
    expect(blocks[0].pageNumber).toBe(1);
    expect(blocks.at(-1).pageNumber).toBe(2);
    // Slice invariant is preserved through the API.
    expect(material.content.slice(blocks[0].startOffset, blocks[0].endOffset)).toBe(
      blocks[0].content,
    );
    // Every material belongs to a workspace: the legacy surface auto-creates one.
    expect(ctx.repos.workspaces.get(material.workspaceId)).toBeDefined();
    // Original bytes are stored so 重新解析 (reprocess) keeps working.
    expect(ctx.repos.materials.getOriginalData(material.id)?.length).toBeGreaterThan(0);
  });

  it('lists and reopens an imported PDF like any other history material', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'memory.pdf', dataBase64: fixtureB64('sample.pdf') },
    });
    const id = created.json().material.id;

    const list = await ctx.app.inject({ method: 'GET', url: '/api/materials' });
    expect(list.json().materials).toHaveLength(1);
    expect(list.json().materials[0]).toMatchObject({ id, sourceType: 'pdf' });

    const reopened = await ctx.app.inject({ method: 'GET', url: `/api/materials/${id}` });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().blocks).toEqual(created.json().blocks);
  });

  it('feeds an imported PDF straight into concept analysis with verified grounding', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'memory.pdf', dataBase64: fixtureB64('sample.pdf') },
    });
    const { material, blocks } = created.json();

    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${material.id}/analyze`,
    });
    expect(analyzed.statusCode).toBe(200);
    const { concepts } = analyzed.json();
    expect(concepts.length).toBeGreaterThanOrEqual(1);
    for (const concept of concepts) {
      const block = (blocks as Array<{ id: string; content: string }>).find(
        (b) => b.id === concept.grounding.blockId,
      );
      expect(block).toBeDefined();
      expect(block!.content.slice(concept.grounding.startOffset, concept.grounding.endOffset)).toBe(
        concept.grounding.quote,
      );
    }
  });

  it('imports a DOCX with heading provenance', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: '讲义.docx', dataBase64: fixtureB64('sample.docx') },
    });
    expect(res.statusCode).toBe(201);
    const { material, blocks } = res.json();
    expect(material.sourceType).toBe('docx');
    expect(material.pageCount).toBeNull();
    const headingPaths = (blocks as Array<{ headingPath: string[] }>).map((b) => b.headingPath);
    expect(headingPaths).toContainEqual(['记忆的科学']);
    expect(headingPaths).toContainEqual(['记忆的科学', '间隔重复']);
  });

  it('accepts .md and .txt files sent base64 through the file payload', async () => {
    const md = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: {
        filename: 'notes.md',
        dataBase64: Buffer.from('# 标题\n\n正文段落。', 'utf8').toString('base64'),
      },
    });
    expect(md.statusCode).toBe(201);
    expect(md.json().material.sourceType).toBe('md');
    expect(md.json().material.parserVersion).toBe('text-v1');

    const txt = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: {
        filename: 'notes.txt',
        dataBase64: Buffer.from('纯文本内容。', 'utf8').toString('base64'),
      },
    });
    expect(txt.statusCode).toBe(201);
    expect(txt.json().material.sourceType).toBe('txt');
  });

  it('honours an explicit title override for file imports', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: {
        filename: 'memory.pdf',
        dataBase64: fixtureB64('sample.pdf'),
        title: '  认知科学讲义  ',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().material.title).toBe('认知科学讲义');
  });

  it('rejects malformed PDF/DOCX with 422 and persists nothing at all', async () => {
    const workspacesBefore = ctx.repos.workspaces.list();
    for (const [filename, fixture] of [
      ['broken.pdf', 'malformed.pdf'],
      ['broken.docx', 'malformed.docx'],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/materials',
        payload: { filename, dataBase64: fixtureB64(fixture) },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('PARSE_FAILED');
    }
    // Transactional failure: no material, no blocks, and no orphan
    // auto-created compatibility workspace.
    expect(ctx.repos.materials.list()).toEqual([]);
    expect(ctx.repos.workspaces.list()).toEqual(workspacesBefore);
  });

  it('rejects a text-free (scanned-style) PDF with an actionable OCR message', async () => {
    const workspacesBefore = ctx.repos.workspaces.list();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'scanned.pdf', dataBase64: fixtureB64('empty.pdf') },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PARSE_FAILED');
    expect(res.json().error.message).toContain('OCR');
    expect(res.json().error.message).toContain('扫描');
    expect(ctx.repos.materials.list()).toEqual([]);
    expect(ctx.repos.workspaces.list()).toEqual(workspacesBefore);
  });

  it('rejects unsupported upload extensions with 415', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'slides.pptx', dataBase64: fixtureB64('sample.pdf') },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_FILE');
  });

  it('rejects oversized uploads with 413 before parsing', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 16, 0x25).toString('base64');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'big.pdf', dataBase64: big },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('SOURCE_TOO_LARGE');
    expect(ctx.repos.materials.list()).toEqual([]);
  });

  it('rejects a mismatched extension/content pair via magic bytes', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { filename: 'fake.pdf', dataBase64: fixtureB64('sample.docx') },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PARSE_FAILED');
    expect(ctx.repos.materials.list()).toEqual([]);
  });

  it('leaves no orphan workspace behind when segmentation rejects a text import', async () => {
    const workspacesBefore = ctx.repos.workspaces.list();
    // ≤100k chars but more than MAX_BLOCKS (2000) paragraphs.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: Array.from({ length: 2001 }, (_, i) => `段${i}`).join('\n\n') },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('SOURCE_TOO_LARGE');
    expect(ctx.repos.materials.list()).toEqual([]);
    expect(ctx.repos.workspaces.list()).toEqual(workspacesBefore);
  });
});

describe('GET /api/materials', () => {
  it('lists imported materials with block counts', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '# 甲\n\n第一段。' },
    });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/materials' });
    expect(res.statusCode).toBe(200);
    const { materials } = res.json();
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ title: '甲', blockCount: 1 });
  });
});

describe('GET /api/materials/:id', () => {
  it('returns the material with its blocks', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '# 甲\n\n第一段。' },
    });
    const id = created.json().material.id;
    const res = await ctx.app.inject({ method: 'GET', url: `/api/materials/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().blocks).toHaveLength(1);
  });

  it('returns structured 404 for a missing material', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/materials/mat_missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/materials/:id', () => {
  it('trims and persists a renamed title while preserving the material and learning records', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '原标题', content: '# 记忆\n\n工作记忆容量有限。' },
    });
    const { material, blocks } = created.json();
    const records = seedLearningRecords(material.id, blocks[0].id, 'rename_route');

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/materials/${material.id}`,
      payload: { title: '  新标题  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().material).toEqual({ ...material, title: '新标题' });
    expect(ctx.repos.materials.getBlocks(material.id)).toHaveLength(blocks.length);
    expect(ctx.repos.materials.getConcept(records.conceptId)).toBeDefined();
    expect(ctx.repos.quizzes.get(records.quizId)).toBeDefined();
    expect(ctx.repos.quizzes.get(records.remediationQuizId)).toBeDefined();
    expect(ctx.repos.submissions.getSubmission(records.submissionId)).toBeDefined();
    expect(ctx.repos.submissions.getGradingResult(records.gradingResultId)).toBeDefined();
    expect(ctx.repos.mistakes.get(records.mistakeId)).toBeDefined();
    expect(ctx.repos.mastery.get(material.id, records.conceptId)).toBeDefined();
  });

  it('allows duplicate titles', async () => {
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '相同标题', content: '第一份资料' },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '原标题', content: '第二份资料' },
    });

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/materials/${second.json().material.id}`,
      payload: { title: '相同标题' },
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/materials' });

    expect(response.statusCode).toBe(200);
    expect(first.json().material.title).toBe('相同标题');
    expect(
      list.json().materials.filter((item: { title: string }) => item.title === '相同标题'),
    ).toHaveLength(2);
  });

  it('rejects blank, overlong, and structurally invalid rename requests', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { content: '可重命名的资料' },
    });
    const id = created.json().material.id;

    for (const payload of [
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { title: '新标题', content: '不应允许' },
    ]) {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/materials/${id}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.repos.materials.get(id)?.title).toBe(created.json().material.title);
  });

  it('returns 404 for a missing material', async () => {
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/materials/mat_missing',
      payload: { title: '新标题' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/materials/:id', () => {
  it('returns 204 and removes a fully populated material without affecting another', async () => {
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '待删除', content: '# 待删除\n\n学习内容。' },
    });
    const retained = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials',
      payload: { title: '保留', content: '# 保留\n\n另一份学习内容。' },
    });
    const firstBody = first.json();
    const retainedBody = retained.json();
    const deletedRecords = seedLearningRecords(
      firstBody.material.id,
      firstBody.blocks[0].id,
      'delete_route',
    );
    const retainedRecords = seedLearningRecords(
      retainedBody.material.id,
      retainedBody.blocks[0].id,
      'retain_route',
    );

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/materials/${firstBody.material.id}`,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(ctx.repos.materials.get(firstBody.material.id)).toBeUndefined();
    expect(ctx.repos.materials.getBlocks(firstBody.material.id)).toEqual([]);
    expect(ctx.repos.materials.getConcept(deletedRecords.conceptId)).toBeUndefined();
    expect(ctx.repos.quizzes.get(deletedRecords.quizId)).toBeUndefined();
    expect(ctx.repos.quizzes.get(deletedRecords.remediationQuizId)).toBeUndefined();
    expect(ctx.repos.quizzes.getQuestion(deletedRecords.questionId)).toBeUndefined();
    expect(ctx.repos.quizzes.getQuestion(deletedRecords.remediationQuestionId)).toBeUndefined();
    expect(ctx.repos.submissions.getSubmission(deletedRecords.submissionId)).toBeUndefined();
    expect(ctx.repos.submissions.getGradingResult(deletedRecords.gradingResultId)).toBeUndefined();
    expect(ctx.repos.mistakes.get(deletedRecords.mistakeId)).toBeUndefined();
    expect(ctx.repos.mastery.get(firstBody.material.id, deletedRecords.conceptId)).toBeUndefined();
    expect(ctx.db.pragma('foreign_key_check')).toEqual([]);

    expect(ctx.repos.materials.get(retainedBody.material.id)).toBeDefined();
    expect(ctx.repos.materials.getBlocks(retainedBody.material.id)).toHaveLength(1);
    expect(ctx.repos.materials.getConcept(retainedRecords.conceptId)).toBeDefined();
    expect(ctx.repos.quizzes.get(retainedRecords.quizId)).toBeDefined();
    expect(ctx.repos.quizzes.get(retainedRecords.remediationQuizId)).toBeDefined();
    expect(ctx.repos.submissions.getSubmission(retainedRecords.submissionId)).toBeDefined();
    expect(ctx.repos.mistakes.get(retainedRecords.mistakeId)).toBeDefined();
    expect(
      ctx.repos.mastery.get(retainedBody.material.id, retainedRecords.conceptId),
    ).toBeDefined();
  });

  it('returns 404 for a missing material', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/materials/mat_missing',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/sample-material', () => {
  it('serves the self-authored sample document', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/sample-material' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe(SAMPLE_MATERIAL_TITLE);
    expect(body.content).toContain('工作记忆');
  });
});
