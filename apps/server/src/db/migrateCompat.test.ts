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
    `INSERT INTO submissions (id, quiz_id, answers, created_at)
     VALUES ('sub_old', 'qz_old', ?, ?)`,
  ).run(
    JSON.stringify([{ questionId: 'que_old', type: 'single_choice', selectedOptionIds: ['B'] }]),
    T,
  );
  db.prepare(
    `INSERT INTO grading_results (id, submission_id, quiz_id, payload, created_at)
     VALUES ('grd_old', 'sub_old', 'qz_old', ?, ?)`,
  ).run(
    JSON.stringify({
      id: 'grd_old',
      submissionId: 'sub_old',
      quizId: 'qz_old',
      grades: [
        {
          questionId: 'que_old',
          type: 'single_choice',
          gradedBy: 'deterministic',
          correct: false,
          awardedPoints: 0,
          maxPoints: 1,
          normalizedScore: 0,
          needsReview: false,
        },
      ],
      totalAwarded: 0,
      totalPossible: 1,
      overallScore: 0,
      createdAt: T,
    }),
    T,
  );
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

  it("gives every pre-origin workspace the honest 'unknown' origin (never auto-deleted)", () => {
    // The migration-created legacy compatibility workspace was persisted
    // before origins existed; its true origin is not reconstructed or
    // guessed — it stays 'unknown' and is therefore conservatively
    // preserved when its final document is deleted.
    const workspace = repos.workspaces.list()[0]!;
    expect(workspace.origin).toBe('unknown');

    const outcome = repos.workspaces.purgeDocument('mat_old', workspace.id, T);
    expect(outcome).toEqual({ deleted: true, workspaceDeleted: false });
    expect(repos.workspaces.get(workspace.id)).toBeDefined();
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
    // Pre-page-range rows read back with pageEnd null — no fabricated spans.
    expect(repos.materials.getBlocks('mat_old')[0]!.pageEnd).toBeNull();
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
      ['submissions', 1],
      ['grading_results', 1],
      ['mistakes', 1],
      ['mastery_states', 1],
    ] as const) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, table).toBe(expected);
    }
  });

  it('exposes pre-upgrade graded attempts as history with honest null snapshot fields', () => {
    // The legacy attempt is listable through its compatibility workspace…
    const workspaceId = repos.materials.get('mat_old')!.workspaceId;
    const attempts = repos.submissions.listCompletedByWorkspace(workspaceId, 50);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: 'grd_old',
      quizId: 'qz_old',
      kind: 'standard',
      materialId: 'mat_old',
      materialTitle: '旧版资料',
      questionCount: 1,
      overallScore: 0,
      completedAt: T,
    });
    // …with nothing fabricated: no provider tag, no state-change snapshot.
    expect(attempts[0]!.provider).toBeNull();
    const record = repos.submissions.getAttemptRecord('grd_old')!;
    expect(record.provider).toBeNull();
    expect(record.stateChanges).toBeNull();
    expect(record.grading.grades).toHaveLength(1);
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

describe('migration from a pre-adaptive (schema v3) database', () => {
  let db: SqliteDb;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase(':memory:');
    // Seed the v1 legacy data, upgrade only to v3 (the previous checkpoint),
    // then run the full adaptive-learning upgrade (v4 … latest).
    seedLegacyDatabase(db);
    migrate(db, { toVersion: 3 });
    migrate(db);
    repos = createRepositories(db);
  });

  it('rebuilds the quizzes table without losing rows or FK integrity', () => {
    const quiz = repos.quizzes.get('qz_old');
    expect(quiz).toBeDefined();
    expect(quiz!.materialId).toBe('mat_old');
    expect(quiz!.workspaceId).toBeUndefined();
    expect(quiz!.questions).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps every learning record readable after the adaptive upgrade', () => {
    expect(repos.materials.get('mat_old')).toBeDefined();
    expect(repos.materials.getBlocks('mat_old')).toHaveLength(1);
    expect(repos.materials.getConcepts('mat_old')).toHaveLength(1);
    expect(repos.mistakes.listByMaterial('mat_old')).toHaveLength(1);
    expect(repos.mastery.get('mat_old', 'con_old')!.mastery).toBeCloseTo(0.35);
  });

  it('creates the new adaptive tables empty and usable', () => {
    for (const table of [
      'canonical_concepts',
      'canonical_members',
      'alignment_proposals',
      'question_blueprints',
      'misconceptions',
      'review_items',
      'review_events',
      'tutor_runs',
      'tutor_events',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, table).toBe(0);
    }
    // Baseline canonical creation works over migrated concepts.
    const workspaceId = repos.materials.get('mat_old')!.workspaceId;
    repos.alignment.ensureBaseline(
      workspaceId,
      repos.materials.getConceptsByWorkspace(workspaceId),
      '2026-01-01T00:00:00.000Z',
    );
    expect(repos.alignment.listCanonical(workspaceId)).toHaveLength(1);
  });

  it('rolls back the whole batch when a migration fails mid-way', () => {
    const fresh = openDatabase(':memory:');
    seedLegacyDatabase(fresh);
    migrate(fresh, { toVersion: 3 });
    // Sabotage: pre-create a table migration 4 wants to create.
    fresh.exec('CREATE TABLE canonical_concepts (id TEXT PRIMARY KEY)');
    expect(() => migrate(fresh)).toThrow();
    // Nothing after v3 was applied; data is intact.
    const version = fresh
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(version.v).toBe(3);
    const quizzes = fresh.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number };
    expect(quizzes.n).toBe(1);
    fresh.close();
  });

  it('re-enables foreign key enforcement after the rebuild migration', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO quizzes (id, material_id, workspace_id, kind, config, created_at)
           VALUES ('qz_bad', 'mat_missing', NULL, 'standard', '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
