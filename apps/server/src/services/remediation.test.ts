import { beforeEach, describe, expect, it } from 'vitest';
import type { QuizGenerationPayload } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ProviderCallOptions, RemediationInput } from '../llm/provider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Remediation targeted bounded repair (Amendment B): missing required
 * question pieces are re-requested ONCE for exactly the incomplete targets;
 * valid pieces are kept; grounding validation is never weakened; a still-
 * incomplete round fails honestly with structured details.
 */

const DOC = [
  '# 工作记忆',
  '',
  '工作记忆的容量十分有限。它一次只能加工少量信息。',
  '',
  '# 长时记忆',
  '',
  '长时记忆负责长期存储。图式化的知识更容易保持。',
  '',
  '# 检索练习',
  '',
  '检索练习通过主动回忆强化记忆。它比重读更有效。',
].join('\n');

/** Drops every short_answer for the victim concept on the FIRST call only. */
class FlakyRemediationProvider extends FakeProvider {
  calls: RemediationInput[] = [];
  failForever = false;

  override async generateRemediation(
    input: RemediationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    this.calls.push(input);
    const payload = await super.generateRemediation(input, opts);
    const victim = this.victimConceptId;
    if (victim && (this.failForever || this.calls.length === 1)) {
      return {
        questions: payload.questions.filter(
          (q) => !(q.conceptId === victim && q.type === 'short_answer'),
        ),
      };
    }
    return payload;
  }

  victimConceptId: string | null = null;
}

interface Setup {
  ctx: TestApp;
  materialId: string;
  conceptIds: string[];
}

async function setupWithMistakes(provider: FlakyRemediationProvider): Promise<Setup> {
  const ctx = buildTestApp({ provider });
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '康复补生测试' },
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
  const conceptIds = (analyzed.json().concepts as Array<{ id: string }>).map((c) => c.id);

  // Open mistakes on two concepts via a deliberately wrong submission.
  const quizRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/quizzes',
    payload: {
      materialId,
      config: { difficulty: 'easy', types: ['single_choice'], countPerType: 3 },
    },
  });
  const quiz = quizRes.json().quiz as {
    id: string;
    questions: Array<{ id: string; type: string }>;
  };
  const wrong = quiz.questions.map((q) => ({
    questionId: q.id,
    type: q.type,
    selectedOptionIds: [] as string[],
  }));
  const graded = await ctx.app.inject({
    method: 'POST',
    url: `/api/quizzes/${quiz.id}/submissions`,
    payload: { answers: wrong },
  });
  expect(graded.statusCode).toBe(201);
  return { ctx, materialId, conceptIds };
}

describe('remediation targeted bounded repair', () => {
  let provider: FlakyRemediationProvider;
  let setup: Setup;

  beforeEach(async () => {
    provider = new FlakyRemediationProvider();
    setup = await setupWithMistakes(provider);
  });

  it('re-requests ONLY the incomplete targets once and completes the round', async () => {
    // Victim = the concept the fake provider will drop the short answer for.
    const openMistakes = setup.ctx.repos.mistakes.listOpenByMaterial(setup.materialId);
    expect(openMistakes.length).toBeGreaterThan(0);
    provider.victimConceptId = openMistakes[0]!.conceptId;

    const res = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${setup.materialId}/remediation`,
    });
    expect(res.statusCode).toBe(201);
    const quiz = res.json().quiz as {
      questions: Array<{ conceptId: string; type: string }>;
      targetConceptIds: string[];
    };

    // The contract is intact: every target kept its full required pair.
    for (const conceptId of quiz.targetConceptIds) {
      const types = quiz.questions.filter((q) => q.conceptId === conceptId).map((q) => q.type);
      expect(types.sort()).toEqual(['short_answer', 'single_choice']);
    }
    // Exactly one bounded retry, restricted to the incomplete target only.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.targets.map((t) => t.concept.id)).toEqual([provider.victimConceptId]);
    expect(
      setup.ctx.db
        .prepare(
          `SELECT COUNT(DISTINCT c.id) AS logicalCalls,
                  COUNT(DISTINCT CASE WHEN a.sent_at IS NOT NULL THEN a.id END) AS physicalAttempts
           FROM model_logical_calls c
           LEFT JOIN model_call_attempts a ON a.logical_call_id = c.id
           WHERE c.operation_type IN ('generate_remediation', 'generate_remediation_repair')`,
        )
        .get(),
    ).toEqual({ logicalCalls: 2, physicalAttempts: 2 });
  });

  it('fails honestly with structured details when the retry is still incomplete', async () => {
    const openMistakes = setup.ctx.repos.mistakes.listOpenByMaterial(setup.materialId);
    provider.victimConceptId = openMistakes[0]!.conceptId;
    provider.failForever = true;

    const res = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${setup.materialId}/remediation`,
    });
    expect(res.statusCode).toBe(422);
    const error = res.json().error as {
      code: string;
      message: string;
      details: { missing: Array<{ conceptId: string; type: string }> };
    };
    expect(error.code).toBe('GROUNDING_FAILED');
    expect(error.message).toContain('定向补生');
    expect(error.details.missing).toEqual([
      { conceptId: provider.victimConceptId, type: 'short_answer' },
    ]);
    // Two provider calls total: the original round plus ONE bounded retry.
    expect(provider.calls).toHaveLength(2);
    expect(
      setup.ctx.db
        .prepare(
          `SELECT COUNT(DISTINCT c.id) AS logicalCalls,
                  COUNT(DISTINCT CASE WHEN a.sent_at IS NOT NULL THEN a.id END) AS physicalAttempts
           FROM model_logical_calls c
           LEFT JOIN model_call_attempts a ON a.logical_call_id = c.id
           WHERE c.operation_type IN ('generate_remediation', 'generate_remediation_repair')`,
        )
        .get(),
    ).toEqual({ logicalCalls: 2, physicalAttempts: 2 });
  });
});
