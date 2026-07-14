import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_MATERIAL_TITLE } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

let ctx: TestApp;

beforeEach(() => {
  ctx = buildTestApp();
});

afterEach(async () => {
  await ctx.app.close();
});

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

describe('GET /api/sample-material', () => {
  it('serves the self-authored sample document', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/sample-material' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe(SAMPLE_MATERIAL_TITLE);
    expect(body.content).toContain('工作记忆');
  });
});
