import { beforeEach, describe, expect, it } from 'vitest';
import type { AlignmentProposalPayload } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { AlignmentProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Canonical cross-document alignment: candidates → auto-accept rule →
 * provider proposals → local validation → accept/reject/keep-separate →
 * canonical rename → deletion policy. Runs through the real HTTP app with
 * the deterministic fake provider (no network).
 */

const DOC_A = [
  '# 工作记忆',
  '',
  '工作记忆是容量有限的短时信息加工系统。它一次只能保持大约四个组块。',
  '',
  '# Spaced repetition',
  '',
  '间隔重复通过在遗忘边缘复习来提升长期保持率。间隔安排比集中复习更有效。',
].join('\n');

const DOC_B = [
  '# Working memory',
  '',
  '工作记忆的容量有限,一次只能保持大约四个组块的信息。',
  '',
  '# Spacedrepetition',
  '',
  '间隔重复要求把复习分散到多天进行。分散复习优于集中复习。',
].join('\n');

interface AlignmentSetup {
  ctx: TestApp;
  workspaceId: string;
  docAId: string;
  docBId: string;
}

async function setupWorkspace(provider?: FakeProvider): Promise<AlignmentSetup> {
  const ctx = buildTestApp(provider ? { provider } : {});
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '认知科学(双语)' },
  });
  const workspaceId = ws.json().workspace.id as string;
  const docIds: string[] = [];
  for (const [title, content] of [
    ['中文讲义', DOC_A],
    ['English notes', DOC_B],
  ] as const) {
    const doc = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', title, content },
    });
    expect(doc.statusCode).toBe(201);
    const materialId = doc.json().material.id as string;
    docIds.push(materialId);
    const analyzed = await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${materialId}/analyze`,
    });
    expect(analyzed.statusCode).toBe(200);
  }
  return { ctx, workspaceId, docAId: docIds[0]!, docBId: docIds[1]! };
}

describe('alignment proposal round', () => {
  let setup: AlignmentSetup;

  beforeEach(async () => {
    setup = await setupWorkspace();
  });

  it('starts with singleton canonical baselines and no pending proposals', async () => {
    const overview = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/alignment`,
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.canonical).toHaveLength(4);
    expect(body.pendingProposals).toHaveLength(0);
    for (const canonical of body.canonical) {
      expect(canonical.members).toHaveLength(1);
      expect(canonical.aliases).toHaveLength(0);
    }
  });

  it('auto-accepts exact normalized aliases and routes the rest to review', async () => {
    const run = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();

    // "Spaced repetition" + "Spacedrepetition" collide after normalization.
    expect(body.autoAccepted).toHaveLength(1);
    expect(body.autoAccepted[0]!.origin).toBe('local_rule');
    expect(body.autoAccepted[0]!.status).toBe('accepted');

    // The bilingual pair requires review.
    expect(body.created.length).toBeGreaterThanOrEqual(1);
    expect(body.created.every((p: { status: string }) => p.status === 'proposed')).toBe(true);

    const overview = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/alignment`,
    });
    const canonical = overview.json().canonical as Array<{
      displayName: string;
      members: unknown[];
      aliases: string[];
      materialIds: string[];
    }>;
    expect(canonical).toHaveLength(3); // 4 singletons − 1 auto-merge
    const merged = canonical.find((c) => c.members.length === 2)!;
    expect(merged.materialIds).toHaveLength(2);
    expect(merged.aliases.length).toBeGreaterThanOrEqual(1);
    // The well-formed spaced spelling wins over the malformed concatenation.
    expect(merged.displayName).toBe('Spaced repetition');
    expect(merged.aliases).toContain('Spacedrepetition');
  });

  it('is idempotent: a second round proposes nothing new', async () => {
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    const second = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    expect(second.json().autoAccepted).toHaveLength(0);
    expect(second.json().created).toHaveLength(0);
  });
});

describe('alignment decisions', () => {
  let setup: AlignmentSetup;
  let proposalId: string;

  beforeEach(async () => {
    setup = await setupWorkspace();
    const run = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    proposalId = run.json().created[0]!.id as string;
  });

  it('accept merges the bilingual pair into one canonical with a repaired name', async () => {
    const accepted = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/proposals/${proposalId}/accept`,
      payload: { canonicalName: '工作记忆' },
    });
    expect(accepted.statusCode).toBe(200);
    const canonical = accepted.json().canonical as Array<{
      displayName: string;
      members: Array<{ originalName: string }>;
      aliases: string[];
    }>;
    expect(canonical).toHaveLength(2);
    const merged = canonical.find((c) => c.displayName === '工作记忆')!;
    expect(merged.members.map((m) => m.originalName).sort()).toEqual([
      'Working memory',
      '工作记忆',
    ]);
    expect(merged.aliases).toContain('Working memory');

    // Original source concepts are untouched.
    const graph = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/graph`,
    });
    expect(graph.json().concepts).toHaveLength(4);
  });

  it('reject and keep-separate leave groups unchanged and stay auditable', async () => {
    const rejected = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/proposals/${proposalId}/reject`,
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().canonical).toHaveLength(3);
    const decided = rejected.json().decidedProposals as Array<{ id: string; status: string }>;
    expect(decided.find((p) => p.id === proposalId)!.status).toBe('rejected');

    // A decided proposal cannot be decided again.
    const again = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/proposals/${proposalId}/accept`,
      payload: {},
    });
    expect(again.statusCode).toBe(400);
  });

  it('supports renaming a canonical concept (malformed-name repair)', async () => {
    const overview = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/alignment`,
    });
    const merged = (
      overview.json().canonical as Array<{ id: string; members: unknown[]; displayName: string }>
    ).find((c) => c.members.length === 2)!;

    const renamed = await setup.ctx.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${setup.workspaceId}/canonical/${merged.id}`,
      payload: { displayName: '间隔重复' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().canonical.displayName).toBe('间隔重复');
  });

  it('preserves learning-history attribution across a merge', async () => {
    // Create a mistake on the doc-A 工作记忆 concept, then merge.
    const quiz = await setup.ctx.app.inject({
      method: 'POST',
      url: '/api/quizzes',
      payload: {
        materialId: setup.docAId,
        config: { difficulty: 'medium', types: ['single_choice'], countPerType: 1 },
      },
    });
    const quizBody = quiz.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string; conceptId: string }>;
    };
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quizBody.id}/submissions`,
      payload: {
        answers: quizBody.questions.map((q) => ({
          questionId: q.id,
          type: q.type,
          selectedOptionIds: [],
        })),
      },
    });

    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/proposals/${proposalId}/accept`,
      payload: {},
    });

    const mistakes = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/materials/${setup.docAId}/mistakes?status=open`,
    });
    expect(mistakes.json().mistakes.length).toBeGreaterThan(0);
    const overlay = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/overlay`,
    });
    // Overlay still reports per source concept — no duplicated mastery rows.
    expect(overlay.json().states).toHaveLength(4);
  });

  it('keeps a merged canonical while another document still backs it, then removes it with the last one', async () => {
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/proposals/${proposalId}/accept`,
      payload: { canonicalName: '工作记忆' },
    });

    const deleteB = await setup.ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${setup.workspaceId}/documents/${setup.docBId}`,
    });
    expect(deleteB.statusCode).toBe(200);
    expect(deleteB.json()).toEqual({ workspaceId: setup.workspaceId, workspaceDeleted: false });

    let overview = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/alignment`,
    });
    let canonical = overview.json().canonical as Array<{ displayName: string; members: unknown[] }>;
    // Both doc-B members vanished with their concepts; the merged canonical
    // survives on its doc-A member. Doc-B singleton canonicals are pruned.
    expect(canonical).toHaveLength(2);
    const survivor = canonical.find((c) => c.displayName === '工作记忆')!;
    expect(survivor.members).toHaveLength(1);

    const deleteA = await setup.ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${setup.workspaceId}/documents/${setup.docAId}`,
    });
    // The workspace was created manually, so even the final document leaves
    // it in place (only import-created workspaces retire with their last
    // document).
    expect(deleteA.statusCode).toBe(200);
    expect(deleteA.json()).toEqual({ workspaceId: setup.workspaceId, workspaceDeleted: false });
    overview = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/alignment`,
    });
    canonical = overview.json().canonical as [];
    expect(canonical).toHaveLength(0);
  });
});

describe('alignment local validation of provider output', () => {
  /**
   * Fake provider whose alignment proposal is hijacked per test. The hijack
   * receives the REAL provider input (locally-offered candidates + blocks),
   * so tests can construct precisely-invalid proposals against real ids.
   */
  let hijack: ((input: AlignmentProposalInput) => AlignmentProposalPayload) | null = null;

  class HijackedProvider extends FakeProvider {
    override async proposeConceptAlignment(
      input: AlignmentProposalInput,
      _opts?: ProviderCallOptions,
    ): Promise<AlignmentProposalPayload> {
      return hijack ? hijack(input) : { proposals: [] };
    }
  }

  let setup: AlignmentSetup;
  let conceptIdByName: Map<string, string>;

  beforeEach(async () => {
    hijack = null;
    setup = await setupWorkspace(new HijackedProvider());
    const graph = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/graph`,
    });
    conceptIdByName = new Map(
      (graph.json().concepts as Array<{ id: string; name: string }>).map((c) => [c.name, c.id]),
    );
  });

  it('rejects proposals for pairs the local candidate stage never offered', async () => {
    hijack = (input) => ({
      proposals: [
        {
          // Real workspace concepts — but this pair was never offered.
          sourceConceptId: input.candidates[0]!.source.id,
          targetConceptId: conceptIdByName.get('Spaced repetition')!,
          relation: 'equivalent',
          canonicalName: '未经候选的合并',
          rationale: '不在候选列表中的提议',
          evidence: [
            {
              blockId: input.candidates[0]!.source.grounding.blockId,
              quote: input.candidates[0]!.source.grounding.quote,
            },
          ],
        },
      ],
    });
    const run = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().created).toHaveLength(0);
    const reasons = (run.json().rejected as Array<{ reason: string }>).map((r) => r.reason);
    expect(reasons.some((r) => r.includes('候选'))).toBe(true);
  });

  it('rejects unknown/cross-workspace concepts and self-alignment', async () => {
    hijack = (input) => ({
      proposals: [
        {
          sourceConceptId: 'con_from_another_workspace',
          targetConceptId: input.candidates[0]!.target.id,
          relation: 'alias',
          canonicalName: 'x',
          rationale: '未知概念',
          evidence: [],
        },
        {
          sourceConceptId: input.candidates[0]!.source.id,
          targetConceptId: input.candidates[0]!.source.id,
          relation: 'alias',
          canonicalName: 'x',
          rationale: '自我合并',
          evidence: [],
        },
      ],
    });
    const run = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    expect(run.json().created).toHaveLength(0);
    const reasons = (run.json().rejected as Array<{ reason: string }>).map((r) => r.reason);
    expect(reasons.some((r) => r.includes('不属于该课程空间') || r.includes('不存在'))).toBe(true);
    expect(reasons.some((r) => r.includes('自身'))).toBe(true);
  });

  it('rejects proposals whose evidence fails exact-quote verification', async () => {
    hijack = (input) => ({
      proposals: [
        {
          sourceConceptId: input.candidates[0]!.source.id,
          targetConceptId: input.candidates[0]!.target.id,
          relation: 'equivalent',
          canonicalName: '工作记忆',
          rationale: '同一概念,但证据是编造的',
          evidence: [
            {
              blockId: input.candidates[0]!.source.grounding.blockId,
              quote: '这句话在原文中根本不存在。',
            },
          ],
        },
      ],
    });
    const run = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/alignment/propose`,
    });
    expect(run.json().created).toHaveLength(0);
    const reasons = (run.json().rejected as Array<{ reason: string }>).map((r) => r.reason);
    expect(reasons.some((r) => r.includes('校验'))).toBe(true);
  });
});

describe('auto-accept display name across pairwise merge orders', () => {
  it('keeps the well-formed spelling even when concatenated variants merge first', async () => {
    // Concept ids are chosen so the candidate sort merges the two
    // concatenated variants BEFORE the well-formed one joins the group.
    const ctx = buildTestApp();
    const { makeMaterial, makeBlock, makeConcept, makeGrounding } =
      await import('../testing/fixtures.js');
    ctx.repos.materials.insertWithBlocks(makeMaterial(), [
      makeBlock({ content: 'Spaced repetition improves retention. 间隔重复能提升保持率。' }),
    ]);
    ctx.repos.materials.replaceConcepts('mat_1', [
      makeConcept({
        id: 'con_a',
        name: 'Spacedrepetition',
        grounding: makeGrounding({ quote: '间隔重复能提升保持率。', endOffset: 11 }),
      }),
      makeConcept({
        id: 'con_b',
        name: 'Spacedrepetition',
        grounding: makeGrounding({ quote: '间隔重复能提升保持率。', endOffset: 11 }),
      }),
      makeConcept({
        id: 'con_z',
        name: 'Spaced repetition',
        grounding: makeGrounding({ quote: '间隔重复能提升保持率。', endOffset: 11 }),
      }),
    ]);
    const { createServices } = await import('./index.js');
    const { fixedClock } = await import('../util/ids.js');
    const services = createServices({
      repos: ctx.repos,
      provider: ctx.provider,
      clock: fixedClock('2026-01-01T00:00:00.000Z'),
    });

    const run = await services.alignment.propose('ws_1');
    expect(run.autoAccepted.length).toBeGreaterThanOrEqual(2);
    const overview = services.alignment.overview('ws_1');
    const merged = overview.canonical.find((c) => c.members.length === 3)!;
    expect(merged).toBeDefined();
    expect(merged.displayName).toBe('Spaced repetition');
    await ctx.app.close();
  });
});
