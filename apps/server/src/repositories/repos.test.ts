import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from './index.js';
import {
  makeBlock,
  makeConcept,
  makeGrounding,
  makeMaterial,
  makeMistake,
  makeQuestion,
  makeQuiz,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import type { GradingResult, Submission } from '@hy3-clinic/shared';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  // Documents now always belong to a workspace; seed the default fixture one.
  repos.workspaces.insert(makeWorkspace());
});

interface PopulatedMaterialIds {
  materialId: string;
  blockIds: string[];
  conceptIds: string[];
  quizIds: string[];
  questionIds: string[];
  submissionIds: string[];
  gradingResultIds: string[];
  mistakeIds: string[];
}

function populateMaterialGraph(suffix: string): PopulatedMaterialIds {
  const materialId = `mat_${suffix}`;
  const blockId = `blk_${suffix}`;
  const conceptId = `con_${suffix}`;
  const quizId = `qz_${suffix}`;
  const questionId = `que_${suffix}`;
  const remediationQuizId = `qz_rem_${suffix}`;
  const remediationQuestionId = `que_rem_${suffix}`;
  const submissionId = `sub_${suffix}`;
  const remediationSubmissionId = `sub_rem_${suffix}`;
  const gradingResultId = `grd_${suffix}`;
  const remediationGradingResultId = `grd_rem_${suffix}`;
  const mistakeId = `mis_${suffix}`;
  const grounding = makeGrounding({ blockId });

  repos.materials.insertWithBlocks(makeMaterial({ id: materialId, title: `资料 ${suffix}` }), [
    makeBlock({ id: blockId, materialId }),
  ]);
  repos.materials.replaceConcepts(materialId, [
    makeConcept({ id: conceptId, materialId, grounding }),
  ]);

  const question = makeQuestion({
    id: questionId,
    quizId,
    conceptId,
    grounding,
  });
  repos.quizzes.insert(makeQuiz({ id: quizId, materialId, questions: [question] }));

  const remediationQuestion = makeQuestion({
    id: remediationQuestionId,
    quizId: remediationQuizId,
    conceptId,
    grounding,
    sourceMistakeIds: [mistakeId],
  });
  repos.quizzes.insert(
    makeQuiz({
      id: remediationQuizId,
      materialId,
      kind: 'remediation',
      questions: [remediationQuestion],
      targetConceptIds: [conceptId],
    }),
  );

  const insertSubmissionAndGrade = (
    id: string,
    currentQuizId: string,
    currentQuestionId: string,
    resultId: string,
  ) => {
    const submission: Submission = {
      id,
      quizId: currentQuizId,
      answers: [{ questionId: currentQuestionId, type: 'single_choice', selectedOptionIds: ['A'] }],
      createdAt: T0,
    };
    repos.submissions.insertSubmission(submission);
    repos.submissions.insertGradingResult({
      id: resultId,
      submissionId: id,
      quizId: currentQuizId,
      grades: [
        {
          questionId: currentQuestionId,
          type: 'single_choice',
          gradedBy: 'deterministic',
          correct: true,
          awardedPoints: 1,
          maxPoints: 1,
          normalizedScore: 1,
          needsReview: false,
        },
      ],
      totalAwarded: 1,
      totalPossible: 1,
      overallScore: 1,
      createdAt: T0,
    });
  };
  insertSubmissionAndGrade(submissionId, quizId, questionId, gradingResultId);
  insertSubmissionAndGrade(
    remediationSubmissionId,
    remediationQuizId,
    remediationQuestionId,
    remediationGradingResultId,
  );

  repos.mistakes.insert(
    makeMistake({
      id: mistakeId,
      materialId,
      quizId,
      questionId,
      conceptId,
      question,
      userAnswer: { questionId, type: 'single_choice', selectedOptionIds: ['B'] },
      remediationCount: 2,
    }),
  );
  repos.mastery.upsert({
    materialId,
    conceptId,
    conceptName: `概念 ${suffix}`,
    mastery: 0.65,
    attempts: 2,
    correctCount: 1,
    lastScore: 1,
    updatedAt: T0,
  });

  return {
    materialId,
    blockIds: [blockId],
    conceptIds: [conceptId],
    quizIds: [quizId, remediationQuizId],
    questionIds: [questionId, remediationQuestionId],
    submissionIds: [submissionId, remediationSubmissionId],
    gradingResultIds: [gradingResultId, remediationGradingResultId],
    mistakeIds: [mistakeId],
  };
}

function countIds(table: string, column: string, ids: string[]): number {
  const placeholders = ids.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders})`)
    .get(...ids) as { count: number };
  return row.count;
}

function relatedCounts(ids: PopulatedMaterialIds) {
  return {
    materials: countIds('materials', 'id', [ids.materialId]),
    sourceBlocks: countIds('source_blocks', 'id', ids.blockIds),
    concepts: countIds('concepts', 'id', ids.conceptIds),
    quizzes: countIds('quizzes', 'id', ids.quizIds),
    questions: countIds('questions', 'id', ids.questionIds),
    submissions: countIds('submissions', 'id', ids.submissionIds),
    gradingResults: countIds('grading_results', 'id', ids.gradingResultIds),
    mistakes: countIds('mistakes', 'id', ids.mistakeIds),
    masteryStates: countIds('mastery_states', 'material_id', [ids.materialId]),
  };
}

const POPULATED_COUNTS = {
  materials: 1,
  sourceBlocks: 1,
  concepts: 1,
  quizzes: 2,
  questions: 2,
  submissions: 2,
  gradingResults: 2,
  mistakes: 1,
  masteryStates: 1,
};

const EMPTY_COUNTS = Object.fromEntries(Object.keys(POPULATED_COUNTS).map((key) => [key, 0]));

describe('materials repository', () => {
  it('persists and reads back a material with blocks', () => {
    const material = makeMaterial();
    const block = makeBlock();
    repos.materials.insertWithBlocks(material, [block]);

    expect(repos.materials.get(material.id)).toEqual(material);
    expect(repos.materials.getBlocks(material.id)).toEqual([block]);
    expect(repos.materials.getBlock(block.id)).toEqual(block);

    const summaries = repos.materials.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: material.id,
      title: material.title,
      blockCount: 1,
    });
  });

  it('returns undefined for a missing material', () => {
    expect(repos.materials.get('nope')).toBeUndefined();
  });

  it('replaces concepts atomically', () => {
    const material = makeMaterial();
    repos.materials.insertWithBlocks(material, [makeBlock()]);

    repos.materials.replaceConcepts(material.id, [makeConcept()]);
    repos.materials.replaceConcepts(material.id, [makeConcept({ id: 'con_2', name: '遗忘曲线' })]);

    const concepts = repos.materials.getConcepts(material.id);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]?.name).toBe('遗忘曲线');
  });

  it('rejects an invalid material via schema validation', () => {
    const bad = makeMaterial({ charCount: -1 });
    expect(() => repos.materials.insertWithBlocks(bad, [])).toThrow();
  });

  it('renames only the material title and allows duplicate titles', () => {
    const first = populateMaterialGraph('rename');
    repos.materials.insertWithBlocks(makeMaterial({ id: 'mat_duplicate', title: '目标标题' }), [
      makeBlock({ id: 'blk_duplicate', materialId: 'mat_duplicate' }),
    ]);
    const before = repos.materials.get(first.materialId)!;
    const dependentRows = relatedCounts(first);

    const updated = repos.materials.updateTitle(first.materialId, '目标标题');

    expect(updated).toEqual({ ...before, title: '目标标题' });
    expect(repos.materials.get(first.materialId)).toEqual(updated);
    expect(relatedCounts(first)).toEqual(dependentRows);
    expect(repos.materials.list().filter((material) => material.title === '目标标题')).toHaveLength(
      2,
    );
    expect(repos.materials.updateTitle('mat_missing', '新标题')).toBeUndefined();
  });

  it('deletes a fully populated material without affecting another material', () => {
    const deleted = populateMaterialGraph('delete');
    const retained = populateMaterialGraph('retain');
    expect(relatedCounts(deleted)).toEqual(POPULATED_COUNTS);
    expect(relatedCounts(retained)).toEqual(POPULATED_COUNTS);

    expect(repos.materials.delete(deleted.materialId)).toBe(true);

    expect(relatedCounts(deleted)).toEqual(EMPTY_COUNTS);
    expect(relatedCounts(retained)).toEqual(POPULATED_COUNTS);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(repos.materials.delete('mat_missing')).toBe(false);
  });

  it('rolls back the entire cascade when deletion fails', () => {
    const material = populateMaterialGraph('rollback');
    db.exec(`
      CREATE TRIGGER reject_material_delete
      AFTER DELETE ON materials
      WHEN OLD.id = 'mat_rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END;
    `);

    expect(() => repos.materials.delete(material.materialId)).toThrow(/forced delete failure/);
    expect(relatedCounts(material)).toEqual(POPULATED_COUNTS);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs with the verified cascade dependency graph enabled', () => {
    interface ForeignKeyRow {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }
    const references = (table: string) =>
      (db.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[])
        .map((row) => `${row.from}->${row.table}.${row.to}:${row.on_delete}`)
        .sort();

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(references('source_blocks')).toEqual(['material_id->materials.id:CASCADE']);
    expect(references('concepts')).toEqual(['material_id->materials.id:CASCADE']);
    // Deliberate schema extension (migration 5): workspace-scoped adaptive
    // assessments made quizzes reference workspaces as well.
    expect(references('quizzes')).toEqual([
      'material_id->materials.id:CASCADE',
      'workspace_id->workspaces.id:CASCADE',
    ]);
    expect(references('questions')).toEqual(['quiz_id->quizzes.id:CASCADE']);
    expect(references('submissions')).toEqual(['quiz_id->quizzes.id:CASCADE']);
    expect(references('grading_results')).toEqual([
      'quiz_id->quizzes.id:CASCADE',
      'submission_id->submissions.id:CASCADE',
    ]);
    expect(references('mistakes')).toEqual(['material_id->materials.id:CASCADE']);
    expect(references('mastery_states')).toEqual(['material_id->materials.id:CASCADE']);
  });
});

describe('quizzes repository', () => {
  it('persists a quiz with questions and reads it back', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    const quiz = makeQuiz();
    repos.quizzes.insert(quiz);

    expect(repos.quizzes.get(quiz.id)).toEqual(quiz);
    expect(repos.quizzes.getQuestion('que_1')?.stem).toContain('工作记忆');
  });

  it('cascades question deletion with the quiz material', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.quizzes.insert(makeQuiz());
    db.prepare('DELETE FROM materials WHERE id = ?').run('mat_1');
    expect(repos.quizzes.get('qz_1')).toBeUndefined();
    expect(repos.quizzes.getQuestion('que_1')).toBeUndefined();
  });
});

describe('submissions repository', () => {
  it('persists submissions and grading results', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.quizzes.insert(makeQuiz());

    const submission: Submission = {
      id: 'sub_1',
      quizId: 'qz_1',
      answers: [{ questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['A'] }],
      createdAt: T0,
    };
    repos.submissions.insertSubmission(submission);
    expect(repos.submissions.getSubmission('sub_1')).toEqual(submission);

    const grading: GradingResult = {
      id: 'grd_1',
      submissionId: 'sub_1',
      quizId: 'qz_1',
      grades: [
        {
          questionId: 'que_1',
          type: 'single_choice',
          gradedBy: 'deterministic',
          correct: true,
          awardedPoints: 1,
          maxPoints: 1,
          normalizedScore: 1,
          needsReview: false,
        },
      ],
      totalAwarded: 1,
      totalPossible: 1,
      overallScore: 1,
      createdAt: T0,
    };
    repos.submissions.insertGradingResult(grading);
    expect(repos.submissions.getGradingResult('grd_1')).toEqual(grading);
    expect(repos.submissions.getGradingResultForSubmission('sub_1')).toEqual(grading);
  });
});

describe('mistakes repository', () => {
  it('persists, lists, and resolves mistakes', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.quizzes.insert(makeQuiz());

    const mistake = makeMistake();
    repos.mistakes.insert(mistake);

    expect(repos.mistakes.listByMaterial('mat_1')).toHaveLength(1);
    expect(repos.mistakes.listOpenByMaterial('mat_1')).toHaveLength(1);
    expect(repos.mistakes.weakConcepts('mat_1')).toEqual([
      { conceptId: 'con_1', conceptName: '工作记忆', openMistakes: 1 },
    ]);

    repos.mistakes.incrementRemediation([mistake.id]);
    expect(repos.mistakes.get(mistake.id)?.remediationCount).toBe(1);

    repos.mistakes.resolve(mistake.id, T0);
    expect(repos.mistakes.get(mistake.id)?.status).toBe('resolved');
    expect(repos.mistakes.listOpenByMaterial('mat_1')).toHaveLength(0);
    expect(repos.mistakes.weakConcepts('mat_1')).toEqual([]);
  });
});

describe('mastery repository', () => {
  it('upserts mastery states and keeps them within bounds', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);

    repos.mastery.upsert({
      materialId: 'mat_1',
      conceptId: 'con_1',
      conceptName: '工作记忆',
      mastery: 0.5,
      attempts: 1,
      correctCount: 0,
      lastScore: 0,
      updatedAt: T0,
    });
    expect(repos.mastery.get('mat_1', 'con_1')?.mastery).toBe(0.5);

    repos.mastery.upsert({
      materialId: 'mat_1',
      conceptId: 'con_1',
      conceptName: '工作记忆',
      mastery: 0.65,
      attempts: 2,
      correctCount: 1,
      lastScore: 1,
      updatedAt: T0,
    });
    const updated = repos.mastery.get('mat_1', 'con_1');
    expect(updated?.mastery).toBe(0.65);
    expect(updated?.attempts).toBe(2);
    expect(repos.mastery.listByMaterial('mat_1')).toHaveLength(1);
  });

  it('rejects out-of-bounds mastery through schema validation', () => {
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    expect(() =>
      repos.mastery.upsert({
        materialId: 'mat_1',
        conceptId: 'con_1',
        conceptName: '工作记忆',
        mastery: 1.2,
        attempts: 1,
        correctCount: 1,
        lastScore: 1,
        updatedAt: T0,
      }),
    ).toThrow();
  });
});
