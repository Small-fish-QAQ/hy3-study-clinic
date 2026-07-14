import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from './index.js';
import {
  makeBlock,
  makeConcept,
  makeMaterial,
  makeMistake,
  makeQuiz,
  T0,
} from '../testing/fixtures.js';
import type { GradingResult, Submission } from '@hy3-clinic/shared';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

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
