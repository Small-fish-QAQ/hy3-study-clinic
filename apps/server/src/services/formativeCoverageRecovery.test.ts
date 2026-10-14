import { describe, it, expect, vi } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { QuestionsInput } from '../llm/courseContract.js';
import { CourseValidationError } from './courseValidation.js';
import { INVALID_FORMAL_COVERAGE } from './questionAdmission.js';

class AnnotatedQuestions extends CourseFakeProvider {
  override async generateQuestions(input: QuestionsInput) {
    const value = await super.generateQuestions(input);
    return {
      questions: value.questions.map((q) => ({
        ...q,
        coverage: [
          {
            cellId: 'invented_formal_cell',
            assessedKnowledgeIds: q.knowledgeIds,
            representativeSetIds: [],
            criterionIds: ['answer'],
            demand: q.demand,
          },
        ],
      })),
    };
  }
}

describe('Formative and Formal coverage boundaries', () => {
  it('Practice drops unused Formal annotations but still solves; Formal rejects them', async () => {
    const provider = new AnnotatedQuestions();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      const quiz = await f.practice(plan, content);
      expect(quiz.items[0]!.coverage).toEqual([]);
      expect(quiz.items[0]!.admission.coverage).toEqual([]);
      expect(provider.calls.generateQuestions).toBe(1);
      expect(provider.calls.solveQuestion).toBe(1);
      const formal = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'prepareFormal',
        'formal',
        'quiz',
        {
          curriculumId: plan.id,
          blueprintId: plan.assessmentBlueprint.id,
          paperRequestId: 'formal',
        },
      );
      await f.c.operations.idle(formal.id);
      expect(f.c.operations.get(f.workspace.id, formal.id).status).toBe('failed');
      const paper = f.c.repo
        .payloads<{ purpose: string; discarded: { reasons: string[] }[] }>(
          'SELECT payload FROM quizzes',
        )
        .find((q) => q.purpose === 'formal')!;
      expect(paper.discarded.some((d) => d.reasons.includes(INVALID_FORMAL_COVERAGE))).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('explicit recovery retains exhausted formative authors and runs missing correctness checks', async () => {
    const provider = new AnnotatedQuestions();
    const f = fixture(provider);
    try {
      const plan = f.accept(await f.prepare());
      const { content, session } = await f.open(plan);
      f.complete(content, session);
      // Reproduce the old mechanical rejection, not a failed answer check.
      const legacy = vi
        .spyOn(f.c.questions.admission, 'admit')
        .mockRejectedValue(new CourseValidationError([INVALID_FORMAL_COVERAGE]));
      const op = f.c.operations.start(
        f.workspace.id,
        cmd(),
        'preparePractice',
        'practice:legacy',
        'quiz',
        {
          curriculumId: plan.id,
          lessonVersionId: content.id,
          requestId: 'legacy',
        },
      );
      await f.c.operations.idle(op.id);
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.calls.solveQuestion ?? 0).toBe(0);
      const before = f.c.repo.payloads<{ id: string }>('SELECT payload FROM quizzes')[0]!;
      const candidate = f.c.questions.get(f.workspace.id, before.id).candidateStates[0]!
        .candidates[1];
      legacy.mockRestore();
      const retry = f.c.operations.retry(f.workspace.id, op.id, cmd(), failed.version);
      await f.settle(retry);
      const ready = f.c.questions.get(f.workspace.id, before.id);
      expect(ready.status).toBe('ready');
      expect(ready.discarded[0]!.reasons).toEqual([INVALID_FORMAL_COVERAGE]);
      expect(ready.candidateStates[0]!.candidates[1]).toEqual(candidate);
      expect(ready.candidateStates[0]!.rejectedCount).toBe(2);
      expect(provider.calls.generateQuestions).toBe(2);
      expect(provider.calls.solveQuestion).toBe(1);
      expect(ready.items[0]!.coverage).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
