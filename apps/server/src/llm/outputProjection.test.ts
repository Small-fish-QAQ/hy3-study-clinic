import { it, expect } from 'vitest';
import { z } from 'zod';
import { projectModelOutput } from './outputProjection.js';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { HttpCourseProvider } from './courseProvider.js';
import { CourseTutorOutputSchema } from './courseContract.js';
import type { KnowledgeInput } from './courseContract.js';
import { CourseFakeProvider } from './courseFakeProvider.js';
import { ProviderError } from './errors.js';
import type { ProviderCallOptions } from './provider.js';
it('只去除闭合合同外的注释字段，保留嵌套必需值和实际错误', () => {
  const schema = z
    .object({ objects: z.array(z.object({ value: z.number().positive() }).strict()) })
    .strict();
  const original = { objects: [{ value: 3, note: 'unused annotation' }], reasoningLabel: 'unused' };
  expect(projectModelOutput(schema, original)).toMatchObject({
    parsed: { success: true, data: { objects: [{ value: 3 }] } },
    discardedPaths: ['objects.0.note', 'reasoningLabel'],
  });
  expect(original.objects[0]!.note).toBe('unused annotation');
  expect(
    projectModelOutput(schema, { objects: [{ value: -1, note: 'unused' }] }).parsed.success,
  ).toBe(false);
  expect(projectModelOutput(schema, { objects: [{ note: 'missing value' }] }).parsed.success).toBe(
    false,
  );
});
it('完整坏结构保留公开JSON候选与物理用量，不缓存或发布，不自动购买新请求', async () => {
  let sends = 0;
  const provider = new HttpCourseProvider({
    provider: 'moma',
    model: 'glm-5.3',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'offline-secret',
    timeoutMs: 1000,
    fetchImpl: async () => {
      sends++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ text: '完整但缺少必要字段的候选' }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    },
  });
  const f = fixture(provider);
  try {
    f.c.operations.register('preparePlan', async (ctx) => {
      const input = {
        lesson: { title: '课', segments: [], teachingCoverage: [] },
        question: '问题',
        sources: [],
        recentTurns: [],
      };
      await f.c.generation.stage(
        ctx,
        'respondToTutorTurn',
        input,
        'scope',
        CourseTutorOutputSchema,
        (opts) => provider.respondToTutorTurn(input, opts),
      );
      return { resourceId: 'never' };
    });
    const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {});
    await f.c.operations.idle(op.id);
    expect(f.c.operations.get(f.workspace.id, op.id).status).toBe('failed');
    const call = f.c.repo.row<{ status: string; payload: string }>(
      'SELECT status,payload FROM llm_calls',
    )!;
    expect(call.status).toBe('failed');
    expect(JSON.parse(call.payload)).toMatchObject({
      candidate: { text: '完整但缺少必要字段的候选' },
      candidateHash: expect.any(String),
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(f.c.repo.rows('SELECT * FROM semantic_cache')).toHaveLength(0);
    expect(sends).toBe(1);
  } finally {
    await f.close();
  }
});
it('完整知识引用错误进入现有一次修订额度，技术未知失败不进入内容自动重发', async () => {
  class Indexed extends CourseFakeProvider {
    revisions: unknown[] = [];
    override async extractCourseKnowledge(input: KnowledgeInput, opts?: ProviderCallOptions) {
      const value = await super.extractCourseKnowledge(input, opts);
      if (!input.revision) {
        opts?.onCandidate?.(value);
        throw ProviderError.completeCandidate(value, [
          'dispositions[0].knowledgeIndices: index out of range',
        ]);
      }
      this.revisions.push(input.revision);
      return value;
    }
  }
  const provider = new Indexed();
  const f = fixture(provider);
  try {
    await f.prepare();
    expect(provider.calls.extractCourseKnowledge).toBe(2);
    expect(provider.revisions).toHaveLength(1);
    expect(provider.revisions[0]).toMatchObject({
      findings: ['dispositions[0].knowledgeIndices: index out of range'],
    });
    expect(f.c.planning.get(f.workspace.id)?.status).toBe('draft');
  } finally {
    await f.close();
  }
});
