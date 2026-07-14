import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_MATERIAL_CONTENT } from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Regression tests over a REAL HTTP socket (not fastify.inject): request
 * streams close as soon as their body is parsed, and an earlier
 * implementation of requestSignal treated that as a client disconnect —
 * cancelling every provider call on body-carrying routes.
 */

let ctx: TestApp;
let baseUrl: string;

beforeEach(async () => {
  ctx = buildTestApp();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.server.address();
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error('no listen address');
  }
});

afterEach(async () => {
  await ctx.app.close();
});

describe('provider-backed routes over real HTTP', () => {
  it('does not self-cancel requests that carry a JSON body', async () => {
    const importRes = await fetch(`${baseUrl}/api/materials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: SAMPLE_MATERIAL_CONTENT, filename: 'sample.md' }),
    });
    expect(importRes.status).toBe(201);
    const { material } = (await importRes.json()) as { material: { id: string } };

    const quizRes = await fetch(`${baseUrl}/api/quizzes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        materialId: material.id,
        config: { difficulty: 'easy', types: ['single_choice'], countPerType: 1 },
      }),
    });
    const body = (await quizRes.json()) as { quiz?: { id: string }; error?: { code: string } };
    expect(body.error?.code).not.toBe('REQUEST_CANCELLED');
    expect(quizRes.status).toBe(201);
    expect(body.quiz?.id).toBeTruthy();
  });
});
