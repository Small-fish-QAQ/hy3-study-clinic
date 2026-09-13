import { beforeEach, describe, expect, it } from 'vitest';
import {
  unitTransferPrompt,
  type AssessmentProposalPayload,
  type FormalScoringReviewInput,
  type FormalScoringReviewProposal,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { AssessmentProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import { createServices } from './index.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from '../testing/fixtures.js';
import { currentScoringReview } from './formalScoringReview.js';

describe('final learner task scoring review', () => {
  it('settles the independent challenger before propagating a blind-solver failure', async () => {
    let challengeSettled = false;
    let reviews = 0;
    class FailedSolverProvider extends FakeProvider {
      async solveFormalAssessment(): Promise<never> {
        throw new Error('BLIND_SOLVER_FAILURE');
      }
      async challengeFormalScoring() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        challengeSettled = true;
        return { challenges: [] };
      }
      async reviewFormalScoring(): Promise<never> {
        reviews++;
        throw new Error('Must not review an incomplete independent pair.');
      }
    }
    const provider = new FailedSolverProvider();
    const { ctx, workspaceId, conceptIds } = await setupAlignedWorkspace(provider);
    try {
      const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
      const concept = ctx.repos.materials.getConcept(conceptIds[0]!)!;
      const block = ctx.repos.materials.getBlock(concept.grounding.blockId)!;
      await expect(
        services.assessment.prepare(
          workspaceId,
          { mode: 'concept_practice', conceptIds: [concept.id], formalOnly: true },
          undefined,
          {
            requiredRepresentation: 'application',
            requestedChallengeFamily: null,
            objectiveCatalogue: [
              { objectiveRef: 'O1', title: '应用容量限制', description: '使用资料容量规则。' },
            ],
            scoringAuthorityCatalogue: [
              {
                objectiveRef: 'O1',
                claims: [
                  {
                    text: block.content,
                    sourceBlockId: block.id,
                    premiseKinds: ['expected_answer', 'rubric_point'],
                  },
                ],
              },
            ],
          },
        ),
      ).rejects.toThrow('BLIND_SOLVER_FAILURE');
      expect(challengeSettled).toBe(true);
      expect(reviews).toBe(0);
      expect(
        ctx.db.prepare('SELECT id FROM quizzes WHERE workspace_id = ?').all(workspaceId),
      ).toHaveLength(0);
    } finally {
      await ctx.app.close();
    }
  });

  it.each([false, true])(
    'revises with the exact private draft and witnesses, then independently checks again (second rejection: %s)',
    async (rejectSecond) => {
      const authorInputs: AssessmentProposalInput[] = [];
      const drafts: AssessmentProposalPayload[] = [];
      const solved: FormalScoringReviewInput[] = [];
      let reviews = 0;
      let challengeCalls = 0;
      class RevisionProvider extends FakeProvider {
        async proposeAssessment(input: AssessmentProposalInput, opts?: ProviderCallOptions) {
          authorInputs.push(structuredClone(input));
          const payload = await super.proposeAssessment(input, opts);
          payload.items[0]!.question.expectedAnswer = input.formalReviewFeedback
            ? 'REVISED_PRIVATE_KEY'
            : 'REJECTED_PRIVATE_KEY';
          drafts.push(structuredClone(payload));
          return payload;
        }
        async solveFormalAssessment(input: FormalScoringReviewInput) {
          solved.push(structuredClone(input));
          return { answerable: true, solution: 'INDEPENDENT_SOLUTION', limitations: [] };
        }
        async challengeFormalScoring() {
          challengeCalls++;
          return {
            challenges: [
              {
                premiseKey: 'expected_answer',
                objection: 'Check the draft calculation.',
                counterexample: 'CONCRETE_AUDIT_WITNESS',
              },
            ],
          };
        }
        async reviewFormalScoring(
          input: FormalScoringReviewInput,
        ): Promise<FormalScoringReviewProposal> {
          const accepted = ++reviews === 2 && !rejectSecond;
          return {
            answerable: true,
            objectiveAligned: true,
            unseenAssessment: true,
            keyCorrect: accepted,
            requiredCriteriaAppropriate: true,
            premises: [
              'expected_answer',
              ...(input.question.rubric?.keyPoints.flatMap((p, i) =>
                p.required ? [`rubric_point:${i}`] : [],
              ) ?? []),
            ].map((premiseKey) => ({
              premiseKey,
              supported: accepted,
              claimRefs: ['P1'],
              rationale: 'Check the actual source rule and current draft.',
            })),
            issues: accepted ? [] : ['Calculation is incorrect.'],
            challengeResolutions: [
              {
                challengeRef: 'C1',
                valid: !accepted,
                rationale: accepted
                  ? 'The revised key now satisfies the source rule.'
                  : 'The witness contradicts the current key.',
              },
            ],
          };
        }
      }
      const provider = new RevisionProvider();
      const { ctx, workspaceId, conceptIds } = await setupAlignedWorkspace(provider);
      try {
        const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
        const concept = ctx.repos.materials.getConcept(conceptIds[0]!)!;
        const block = ctx.repos.materials.getBlock(concept.grounding.blockId)!;
        const operation = services.assessment.prepare(
          workspaceId,
          { mode: 'concept_practice', conceptIds: [concept.id], formalOnly: true },
          undefined,
          {
            requiredRepresentation: 'application',
            requestedChallengeFamily: null,
            objectiveCatalogue: [
              {
                objectiveRef: 'O1',
                title: '应用容量限制',
                description: '在新任务中应用资料的容量规则。',
              },
            ],
            scoringAuthorityCatalogue: [
              {
                objectiveRef: 'O1',
                claims: [
                  {
                    text: block.content,
                    sourceBlockId: block.id,
                    premiseKinds: ['expected_answer', 'rubric_point'],
                  },
                ],
              },
            ],
          },
        );
        if (rejectSecond) {
          await expect(operation).rejects.toMatchObject({ code: 'GROUNDING_FAILED' });
        } else {
          const creation = await operation;
          expect(creation.quiz.questions[0]!.expectedAnswer).toBe('REVISED_PRIVATE_KEY');
          expect(JSON.stringify(creation)).not.toContain('REJECTED_PRIVATE_KEY');
          expect(creation.quiz.questions[0]!.formalScoringReview!.review.keyCorrect).toBe(true);
        }
        expect(authorInputs).toHaveLength(2);
        const feedback = authorInputs[1]!.formalReviewFeedback![0]!;
        expect(feedback.draft).toEqual(drafts[0]!.items[0]);
        expect(feedback.independentReview!.question.expectedAnswer).toBe('REJECTED_PRIVATE_KEY');
        expect(feedback.independentReview!.blindSolution.solution).toBe('INDEPENDENT_SOLUTION');
        expect(feedback.independentReview!.challenges!.challenges[0]!.counterexample).toBe(
          'CONCRETE_AUDIT_WITNESS',
        );
        expect(feedback.independentReview!.review.keyCorrect).toBe(false);
        expect(solved).toHaveLength(2);
        expect(solved[1]!.question.expectedAnswer).toBe('REVISED_PRIVATE_KEY');
        expect(solved[1]).not.toHaveProperty('formalReviewFeedback');
        expect(reviews).toBe(2);
        expect(challengeCalls).toBe(2);
        expect(
          ctx.db.prepare('SELECT id FROM quizzes WHERE workspace_id = ?').all(workspaceId),
        ).toHaveLength(0);
      } finally {
        await ctx.app.close();
      }
    },
  );

  it('reviews the local transfer prompt and binds its exposure contract before persistence', async () => {
    const seen: FormalScoringReviewInput[] = [];
    const challenged: FormalScoringReviewInput[] = [];
    let markChallengerStarted!: () => void;
    const challengerStarted = new Promise<void>((resolve) => {
      markChallengerStarted = resolve;
    });
    class ReviewedProvider extends FakeProvider {
      async solveFormalAssessment(input: FormalScoringReviewInput) {
        seen.push(structuredClone(input));
        // Both independent checks must start before either check's output
        // becomes available; sequential execution would deadlock this test.
        await challengerStarted;
        return {
          answerable: true,
          solution: '构造有限容量的假设任务，说明分组前后判断及资料边界。',
          limitations: [],
        };
      }
      async reviewFormalScoring(
        input: FormalScoringReviewInput,
      ): Promise<FormalScoringReviewProposal> {
        return {
          answerable: true,
          objectiveAligned: true,
          unseenAssessment: true,
          keyCorrect: true,
          requiredCriteriaAppropriate: true,
          premises: [
            {
              premiseKey: 'expected_answer',
              supported: true,
              claimRefs: ['P1'],
              rationale: '使用实际原文容量限制。',
            },
            ...(input.question.rubric?.keyPoints.flatMap((p, i) =>
              p.required
                ? [
                    {
                      premiseKey: `rubric_point:${i}`,
                      supported: true,
                      claimRefs: ['P1'],
                      rationale: '使用实际原文容量限制。',
                    },
                  ]
                : [],
            ) ?? []),
          ],
          issues: [],
          challengeResolutions: (input.challenges?.challenges ?? []).map((_, i) => ({
            challengeRef: `C${i + 1}`,
            valid: false,
            rationale: 'Reusing the old worked example does not complete the new transfer task.',
          })),
        };
      }
      async challengeFormalScoring(input: FormalScoringReviewInput) {
        challenged.push(structuredClone(input));
        markChallengerStarted();
        return {
          challenges: [
            {
              premiseKey: 'expected_answer',
              objection: 'Could a prior solved example suffice?',
              counterexample: 'Repeat the already displayed grouping example.',
            },
          ],
        };
      }
    }
    const provider = new ReviewedProvider();
    const { ctx, workspaceId, conceptIds } = await setupAlignedWorkspace(provider);
    try {
      const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
      const concept = ctx.repos.materials.getConcept(conceptIds[0]!)!;
      const block = ctx.repos.materials.getBlock(concept.grounding.blockId)!;
      const objective = {
        title: '应用容量限制',
        description: '构造新情境，说明容量限制及条件变化的影响。',
      };
      const prompt = unitTransferPrompt(objective.title, 0);
      const task = {
        version: 'unit-transfer-v1' as const,
        presentedExamples: ['已经做过的分组例子'],
        priorResponses: [],
      };
      const creation = await services.assessment.prepare(
        workspaceId,
        { mode: 'concept_practice', conceptIds: [concept.id], formalOnly: true },
        undefined,
        {
          requiredRepresentation: 'application',
          requestedChallengeFamily: null,
          learnerGeneratedTransfer: true,
          learnerTransfer: { prompt, task },
          objectiveCatalogue: [{ objectiveRef: 'O1', ...objective }],
          scoringAuthorityCatalogue: [
            {
              objectiveRef: 'O1',
              claims: [
                {
                  text: block.content,
                  sourceBlockId: block.id,
                  premiseKinds: ['expected_answer', 'rubric_point'],
                },
              ],
            },
          ],
        },
      );
      const question = creation.quiz.questions[0]!;
      expect(seen).toHaveLength(1);
      expect(seen[0]!.question.stem).toBe(prompt);
      expect(challenged).toHaveLength(1);
      expect(challenged[0]!.question.stem).toBe(prompt);
      expect(challenged[0]).not.toHaveProperty('blindSolution');
      expect(question.formalScoringReview!.policyVersion).toBe(
        'formal-scoring-independent-review-v2',
      );
      expect(question.formalScoringReview!.challenges!.challenges).toHaveLength(1);
      expect(question.transferTask).toEqual(task);
      const reviewedBlocks = question.formalScoringReview!.sources.map((source) =>
        ctx.repos.materials.getBlock(source.sourceBlockId)!,
      );
      expect(currentScoringReview(question, objective, reviewedBlocks)).not.toBeNull();
      question.transferTask!.presentedExamples = [];
      expect(currentScoringReview(question, objective, reviewedBlocks)).toBeNull();
    } finally {
      await ctx.app.close();
    }
  });
});

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

  it.each([1, 2])(
    'preserves proposed evidence identity when an earlier quote fails (%i)',
    async (index) => {
      let validBlockId = '';
      hijack = (input) => {
        const target = input.targets[0]!;
        const primary = input.blocks.find((b) => b.id === target.concept.grounding.blockId)!;
        const other = input.blocks.find((b) => b.id !== primary.id)!;
        validBlockId = other.id;
        return {
          items: [
            {
              blueprint: {
                conceptIds: [target.concept.id],
                questionType: 'single_choice',
                difficulty: 'easy',
                learningObjective: '引用指定原文解释容量限制。',
                reasoningSteps: [{ description: '引用第二份真实资料。', evidenceIndexes: [index] }],
              },
              question: {
                type: 'single_choice',
                stem: '工作记忆的容量如何？',
                options: [
                  { id: 'A', text: '有限' },
                  { id: 'B', text: '无限' },
                ],
                correctOptionIds: ['A'],
                conceptId: target.concept.id,
                blockId: primary.id,
                quote: primary.content,
                explanation: '资料说明容量有限。',
              },
              extraEvidence: [
                { blockId: primary.id, quote: '这段证据不存在，不能由下一条真实引用替代。' },
                { blockId: other.id, quote: other.content },
              ],
            },
          ],
        };
      };
      const response = await setup.ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${setup.workspaceId}/assessments`,
        payload: { mode: 'concept_practice', conceptIds: [setup.conceptIds[0]] },
      });
      if (index === 1) {
        expect(response.statusCode).toBe(422);
        expect(response.json().error.details.rejected[0].reason).toContain(
          '引文未能在源材料中找到',
        );
      } else {
        expect(response.statusCode).toBe(201);
        const blueprint = setup.ctx.repos.blueprints.listByQuiz(response.json().quiz.id)[0]!;
        expect(blueprint.expectedReasoningSteps[0]!.evidenceIndexes).toEqual([1]);
        expect(blueprint.evidence[1]!.blockId).toBe(validBlockId);
      }
    },
  );

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
