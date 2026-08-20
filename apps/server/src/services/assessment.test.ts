import { beforeEach, describe, expect, it } from 'vitest';
import type { AssessmentProposalPayload } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { AssessmentProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';

/**
 * Workspace (cross-document) assessments: blueprint validation, honest
 * cross-document scoping, answer secrecy, deterministic grading with
 * per-concept document attribution, and downstream state changes.
 */

const DOC_A = [
  '# 工作记忆',
  '',
  '工作记忆是容量有限的短时信息加工系统。它一次只能保持大约四个组块。',
].join('\n');

const DOC_B = [
  '# Working memory',
  '',
  '工作记忆的容量有限,一次只能保持大约四个组块的信息。补充:复述可以延长保持时间。',
].join('\n');

interface Setup {
  ctx: TestApp;
  workspaceId: string;
  conceptIds: string[];
}

async function setupAlignedWorkspace(provider?: FakeProvider): Promise<Setup> {
  const ctx = buildTestApp(provider ? { provider } : {});
  const ws = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    payload: { name: '跨文档评估' },
  });
  const workspaceId = ws.json().workspace.id as string;
  for (const content of [DOC_A, DOC_B]) {
    const doc = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: { kind: 'text', content },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/materials/${doc.json().material.id}/analyze`,
    });
  }
  // Align the bilingual pair so cross-document siblings exist.
  const run = await ctx.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/alignment/propose`,
  });
  for (const proposal of run.json().created as Array<{ id: string }>) {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/alignment/proposals/${proposal.id}/accept`,
      payload: {},
    });
  }
  const graph = await ctx.app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/graph`,
  });
  const conceptIds = (graph.json().concepts as Array<{ id: string }>).map((c) => c.id);
  return { ctx, workspaceId, conceptIds };
}

describe('cross-document assessment generation', () => {
  let setup: Setup;

  beforeEach(async () => {
    setup = await setupAlignedWorkspace();
  });

  it('creates a valid cross-document assessment with verified multi-document evidence', async () => {
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'cross_document', conceptIds: [setup.conceptIds[0]] },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.quiz.kind).toBe('adaptive');
    expect(body.quiz.materialId).toBeNull();
    expect(body.quiz.workspaceId).toBe(setup.workspaceId);
    expect(body.quiz.assessmentMode).toBe('cross_document');

    const crossBlueprints = (
      body.blueprints as Array<{ scope: string; sourceDocumentIds: string[] }>
    ).filter((b) => b.scope === 'cross_document');
    expect(crossBlueprints.length).toBeGreaterThan(0);
    expect(crossBlueprints[0]!.sourceDocumentIds.length).toBeGreaterThanOrEqual(2);
  });

  it('never leaks answers, rubrics, or reasoning steps in the client payload', async () => {
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    expect(response.statusCode).toBe(201);
    const raw = response.body;
    expect(raw).not.toContain('"correctOptionIds":');
    expect(raw).not.toContain('"expectedAnswer":');
    expect(raw).not.toContain('"rubric":');
    expect(raw).not.toContain('"expectedReasoningSteps":');
  });

  it('rejects assessments whose modes need concepts when none are given', async () => {
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'concept_practice' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects unknown workspaces and out-of-workspace concepts', async () => {
    const missing = await setup.ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws_unknown/assessments',
      payload: { mode: 'diagnostic' },
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'concept_practice', conceptIds: ['con_of_other_workspace'] },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('grades deterministically and attributes each concept to its OWN document', async () => {
    const creation = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    const quiz = creation.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string; conceptId: string }>;
    };

    const submit = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: quiz.questions.map((q) =>
          q.type === 'single_choice' || q.type === 'multiple_choice'
            ? { questionId: q.id, type: q.type, selectedOptionIds: [] }
            : { questionId: q.id, type: q.type, text: '' },
        ),
      },
    });
    expect(submit.statusCode).toBe(201);
    const body = submit.json();
    expect(body.grading.overallScore).toBe(0);
    expect(body.stateChanges.mistakesCreated).toBeGreaterThan(0);
    expect(body.stateChanges.assessedConceptIds.length).toBeGreaterThan(0);
    expect(body.stateChanges.recommendedNextStep.length).toBeGreaterThan(0);

    // Mastery rows must live on each concept's own material.
    const overlay = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/overlay`,
    });
    const assessed = (
      overlay.json().states as Array<{ conceptId: string; attempts: number; materialId: string }>
    ).filter((s) => s.attempts > 0);
    expect(assessed.length).toBeGreaterThan(0);
    const graph = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/graph`,
    });
    const materialByConcept = new Map(
      (graph.json().concepts as Array<{ id: string; materialId: string }>).map((c) => [
        c.id,
        c.materialId,
      ]),
    );
    for (const state of assessed) {
      expect(state.materialId).toBe(materialByConcept.get(state.conceptId));
    }
  });

  it('correct adaptive practice answers resolve the open mistakes they re-test', async () => {
    // Seed open mistakes with a failed diagnostic.
    const failed = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    const failedQuiz = failed.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string }>;
    };
    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${failedQuiz.id}/submissions`,
      payload: {
        answers: failedQuiz.questions.map((q) =>
          q.type === 'single_choice' || q.type === 'multiple_choice'
            ? { questionId: q.id, type: q.type, selectedOptionIds: [] }
            : { questionId: q.id, type: q.type, text: '' },
        ),
      },
    });
    const withMistakes = (
      await setup.ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${setup.workspaceId}/overlay`,
      })
    ).json().states as Array<{ conceptId: string; openMistakes: number }>;
    const weak = withMistakes.find((s) => s.openMistakes > 0)!;
    expect(weak).toBeDefined();

    // Targeted practice on the weak concept, answered from the server key.
    const practice = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'concept_practice', conceptIds: [weak.conceptId] },
    });
    const practiceQuiz = practice.json().quiz as { id: string };
    const full = setup.ctx.repos.quizzes.get(practiceQuiz.id)!;
    expect(full.questions.some((q) => (q.sourceMistakeIds?.length ?? 0) > 0)).toBe(true);
    const graded = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${practiceQuiz.id}/submissions`,
      payload: {
        answers: full.questions.map((q) =>
          q.correctOptionIds
            ? { questionId: q.id, type: q.type, selectedOptionIds: q.correctOptionIds }
            : { questionId: q.id, type: q.type, text: q.expectedAnswer! },
        ),
      },
    });
    expect(graded.json().stateChanges.mistakesResolved).toBeGreaterThan(0);
    const after = (
      await setup.ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${setup.workspaceId}/overlay`,
      })
    ).json().states as Array<{ conceptId: string; openMistakes: number }>;
    expect(after.find((s) => s.conceptId === weak.conceptId)!.openMistakes).toBeLessThan(
      weak.openMistakes,
    );
  });

  it('ordinary diagnostic grading does not create legacy or successor Review scheduling', async () => {
    const reviewCounts = () => ({
      legacyItems: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }
      ).n,
      legacyEvents: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }
      ).n,
      targets: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_targets').get() as { n: number }
      ).n,
      bindings: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_target_bindings').get() as {
          n: number;
        }
      ).n,
      states: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM memory_schedule_states').get() as {
          n: number;
        }
      ).n,
      events: (
        setup.ctx.db.prepare('SELECT COUNT(*) AS n FROM successor_review_events').get() as {
          n: number;
        }
      ).n,
    });
    const persistedBefore = reviewCounts();
    const before = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/review`,
    });
    expect(before.json().items).toHaveLength(0);

    const creation = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'diagnostic' },
    });
    const quiz = creation.json().quiz as {
      id: string;
      questions: Array<{ id: string; type: string }>;
    };
    // Creating (but not grading) the assessment schedules nothing.
    const between = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/review`,
    });
    expect(between.json().items).toHaveLength(0);

    await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/quizzes/${quiz.id}/submissions`,
      payload: {
        answers: quiz.questions.map((q) =>
          q.type === 'single_choice' || q.type === 'multiple_choice'
            ? { questionId: q.id, type: q.type, selectedOptionIds: [] }
            : { questionId: q.id, type: q.type, text: '' },
        ),
      },
    });
    const after = await setup.ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${setup.workspaceId}/review`,
    });
    expect(after.json().items).toHaveLength(0);
    expect(reviewCounts()).toEqual(persistedBefore);
  });
});

describe('assessment local validation of provider output', () => {
  let hijack: ((input: AssessmentProposalInput) => AssessmentProposalPayload) | null = null;

  class HijackedProvider extends FakeProvider {
    override async proposeAssessment(
      input: AssessmentProposalInput,
      _opts?: ProviderCallOptions,
    ): Promise<AssessmentProposalPayload> {
      return hijack ? hijack(input) : super.proposeAssessment(input);
    }
  }

  let setup: Setup;

  beforeEach(async () => {
    hijack = null;
    setup = await setupAlignedWorkspace(new HijackedProvider());
  });

  it('rejects a false multi-document claim: comparison item with single-document evidence', async () => {
    hijack = (input) => {
      const target = input.targets[0]!;
      const block = input.blocks.find((b) => b.id === target.concept.grounding.blockId)!;
      return {
        items: [
          {
            blueprint: {
              conceptIds: [target.concept.id],
              questionType: 'concept_comparison',
              difficulty: 'medium',
              learningObjective: '声称跨文档,实际只有一份文档的证据。',
              reasoningSteps: [{ description: '对比', evidenceIndexes: [0] }],
            },
            question: {
              type: 'concept_comparison',
              stem: '请对比两份资料。',
              expectedAnswer: '并不存在第二份资料。',
              rubricKeyPoints: ['要点'],
              conceptId: target.concept.id,
              blockId: block.id,
              quote: block.content.split('。')[0]! + '。',
              explanation: '解析',
            },
            extraEvidence: [], // no second document → the claim is false
          },
        ],
      };
    };
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'cross_document', conceptIds: [setup.conceptIds[0]] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('GROUNDING_FAILED');
  });

  it('rejects unsupported question types for the mode', async () => {
    hijack = (input) => {
      const target = input.targets[0]!;
      const block = input.blocks.find((b) => b.id === target.concept.grounding.blockId)!;
      const quote = block.content.split('。')[0]! + '。';
      return {
        items: [
          {
            blueprint: {
              conceptIds: [target.concept.id],
              questionType: 'short_answer',
              difficulty: 'medium',
              learningObjective: 'cross_document 模式不允许 short_answer。',
              reasoningSteps: [{ description: 'x', evidenceIndexes: [0] }],
            },
            question: {
              type: 'short_answer',
              stem: '简述。',
              expectedAnswer: quote,
              rubricKeyPoints: [quote.slice(0, 20)],
              conceptId: target.concept.id,
              blockId: block.id,
              quote,
              explanation: '解析',
            },
            extraEvidence: [],
          },
        ],
      };
    };
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'cross_document', conceptIds: [setup.conceptIds[0]] },
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects items with fabricated evidence or unknown concepts', async () => {
    hijack = (input) => {
      const target = input.targets[0]!;
      const block = input.blocks[0]!;
      const quote = block.content.split('。')[0]! + '。';
      return {
        items: [
          {
            blueprint: {
              conceptIds: [target.concept.id],
              questionType: 'single_choice',
              difficulty: 'easy',
              learningObjective: '引文是编造的。',
              reasoningSteps: [{ description: 'x', evidenceIndexes: [0] }],
            },
            question: {
              type: 'single_choice',
              stem: '选择。',
              options: [
                { id: 'A', text: 'a' },
                { id: 'B', text: 'b' },
              ],
              correctOptionIds: ['A'],
              conceptId: target.concept.id,
              blockId: block.id,
              quote: '这句引文是编造的。',
              explanation: 'x',
            },
            extraEvidence: [],
          },
          {
            blueprint: {
              conceptIds: ['con_unknown'],
              questionType: 'single_choice',
              difficulty: 'easy',
              learningObjective: '概念不存在。',
              reasoningSteps: [{ description: 'x', evidenceIndexes: [0] }],
            },
            question: {
              type: 'single_choice',
              stem: '选择。',
              options: [
                { id: 'A', text: 'a' },
                { id: 'B', text: 'b' },
              ],
              correctOptionIds: ['A'],
              conceptId: 'con_unknown',
              blockId: block.id,
              quote,
              explanation: 'x',
            },
            extraEvidence: [],
          },
        ],
      };
    };
    const response = await setup.ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${setup.workspaceId}/assessments`,
      payload: { mode: 'concept_practice', conceptIds: [setup.conceptIds[0]] },
    });
    expect(response.statusCode).toBe(422);
    const details = response.json().error.details as { rejected: Array<{ reason: string }> };
    expect(details.rejected.length).toBe(2);
  });
});
