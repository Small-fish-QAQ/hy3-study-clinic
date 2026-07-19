import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';

/**
 * Migration compatibility: a representative PRE-UPGRADE (schema v1) database
 * with real learning data must migrate cleanly, keep every record readable,
 * and expose legacy single-material records through per-material
 * compatibility workspaces.
 */

const T = '2025-12-01T00:00:00.000Z';

function seedLegacyDatabase(db: SqliteDb): void {
  migrate(db, { toVersion: 1 });

  db.prepare(
    `INSERT INTO materials (id, title, source_type, content, char_count, created_at)
     VALUES ('mat_old', '旧版资料', 'paste', '# 标题\n\n工作记忆的容量十分有限。', 18, ?)`,
  ).run(T);
  db.prepare(
    `INSERT INTO source_blocks (id, material_id, idx, heading, heading_path, content, start_offset, end_offset)
     VALUES ('blk_old', 'mat_old', 0, '标题', '["标题"]', '工作记忆的容量十分有限。', 6, 18)`,
  ).run();
  db.prepare(
    `INSERT INTO concepts (id, material_id, name, summary, importance, grounding, created_at)
     VALUES ('con_old', 'mat_old', '工作记忆', '容量有限的加工系统。', 'high', ?, ?)`,
  ).run(
    JSON.stringify({
      blockId: 'blk_old',
      quote: '工作记忆的容量十分有限。',
      startOffset: 0,
      endOffset: 12,
      occurrenceCount: 1,
      reanchored: false,
    }),
    T,
  );
  db.prepare(
    `INSERT INTO quizzes (id, material_id, kind, config, target_concept_ids, created_at)
     VALUES ('qz_old', 'mat_old', 'standard', ?, NULL, ?)`,
  ).run(JSON.stringify({ difficulty: 'medium', types: ['single_choice'], countPerType: 1 }), T);
  const question = {
    id: 'que_old',
    quizId: 'qz_old',
    index: 0,
    type: 'single_choice',
    stem: '工作记忆的容量?',
    options: [
      { id: 'A', text: '有限' },
      { id: 'B', text: '无限' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_old',
    conceptName: '工作记忆',
    grounding: {
      blockId: 'blk_old',
      quote: '工作记忆的容量十分有限。',
      startOffset: 0,
      endOffset: 12,
      occurrenceCount: 1,
      reanchored: false,
    },
    explanation: '原文明确说明。',
    points: 1,
  };
  db.prepare(
    `INSERT INTO questions (id, quiz_id, idx, payload) VALUES ('que_old', 'qz_old', 0, ?)`,
  ).run(JSON.stringify(question));
  db.prepare(
    `INSERT INTO mistakes (id, material_id, quiz_id, question_id, concept_id, concept_name,
        payload, score, status, remediation_count, created_at, resolved_at)
     VALUES ('mis_old', 'mat_old', 'qz_old', 'que_old', 'con_old', '工作记忆', ?, 0, 'open', 0, ?, NULL)`,
  ).run(
    JSON.stringify({
      id: 'mis_old',
      materialId: 'mat_old',
      quizId: 'qz_old',
      questionId: 'que_old',
      conceptId: 'con_old',
      conceptName: '工作记忆',
      question,
      userAnswer: { questionId: 'que_old', type: 'single_choice', selectedOptionIds: ['B'] },
      score: 0,
      status: 'open',
      remediationCount: 0,
      createdAt: T,
      resolvedAt: null,
    }),
    T,
  );
  db.prepare(
    `INSERT INTO mastery_states (material_id, concept_id, concept_name, mastery, attempts, correct_count, last_score, updated_at)
     VALUES ('mat_old', 'con_old', '工作记忆', 0.35, 2, 0, 0, ?)`,
  ).run(T);
}

describe('migration from a representative pre-upgrade database', () => {
  let db: SqliteDb;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase(':memory:');
    seedLegacyDatabase(db);
    migrate(db); // upgrade v1 → latest
    repos = createRepositories(db);
  });

  it('creates a compatibility workspace per legacy material', () => {
    const workspaces = repos.workspaces.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe('旧版资料');
    expect(workspaces[0]!.documentCount).toBe(1);
    expect(workspaces[0]!.conceptCount).toBe(1);
    expect(workspaces[0]!.activeGraphVersionId).toBeNull();
  });

  it('keeps the legacy material readable with backfilled document metadata', () => {
    const material = repos.materials.get('mat_old');
    expect(material).toBeDefined();
    expect(material!.workspaceId).toMatch(/^ws_legacy_/);
    expect(material!.parseStatus).toBe('parsed');
    expect(material!.extractionWarnings).toEqual([]);
    expect(material!.parserVersion).toBe('text-v1');
    expect(material!.mediaType).toBe('text/plain');
    expect(material!.updatedAt).toBe(T);
    expect(material!.content).toContain('工作记忆的容量十分有限。');
  });

  it('keeps legacy blocks, concepts, quizzes, mistakes and mastery readable', () => {
    expect(repos.materials.getBlocks('mat_old')).toHaveLength(1);
    expect(repos.materials.getBlocks('mat_old')[0]!.pageNumber).toBeNull();
    expect(repos.materials.getConcepts('mat_old')).toHaveLength(1);
    expect(repos.quizzes.get('qz_old')!.questions).toHaveLength(1);
    expect(repos.mistakes.listByMaterial('mat_old')).toHaveLength(1);
    expect(repos.mastery.get('mat_old', 'con_old')!.mastery).toBeCloseTo(0.35);
  });

  it('deletes no learning data during the upgrade', () => {
    for (const [table, expected] of [
      ['materials', 1],
      ['source_blocks', 1],
      ['concepts', 1],
      ['quizzes', 1],
      ['questions', 1],
      ['mistakes', 1],
      ['mastery_states', 1],
    ] as const) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, table).toBe(expected);
    }
  });

  it('exposes workspace-scoped queries over migrated data', () => {
    const workspaceId = repos.materials.get('mat_old')!.workspaceId;
    expect(repos.materials.getConceptsByWorkspace(workspaceId)).toHaveLength(1);
    expect(repos.materials.getBlocksByWorkspace(workspaceId)).toHaveLength(1);
    expect(repos.mistakes.countsByConceptForWorkspace(workspaceId).get('con_old')).toEqual({
      open: 1,
      resolved: 0,
    });
    expect(repos.mastery.listByWorkspace(workspaceId)).toHaveLength(1);
  });

  it('is idempotent when run again on the upgraded database', () => {
    expect(() => migrate(db)).not.toThrow();
    expect(repos.workspaces.list()).toHaveLength(1);
  });
});
