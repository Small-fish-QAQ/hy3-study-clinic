import type { SqliteDb } from './database.js';

interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Schema migrations. Each runs exactly once, tracked in `schema_migrations`.
 * Running `migrate()` repeatedly is a no-op after the first application
 * (verified by tests), so it is safe to call on every server start.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE materials (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        content TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE source_blocks (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        heading TEXT,
        heading_path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL
      );
      CREATE INDEX idx_source_blocks_material ON source_blocks(material_id);

      CREATE TABLE concepts (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        importance TEXT NOT NULL,
        grounding TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_concepts_material ON concepts(material_id);

      CREATE TABLE quizzes (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        config TEXT NOT NULL,
        target_concept_ids TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_quizzes_material ON quizzes(material_id);

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_questions_quiz ON questions(quiz_id);

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        answers TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE grading_results (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE mistakes (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        concept_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        remediation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX idx_mistakes_material ON mistakes(material_id);
      CREATE INDEX idx_mistakes_concept ON mistakes(concept_id);

      CREATE TABLE mastery_states (
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL,
        concept_name TEXT NOT NULL,
        mastery REAL NOT NULL CHECK (mastery >= 0 AND mastery <= 1),
        attempts INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        last_score REAL CHECK (last_score IS NULL OR (last_score >= 0 AND last_score <= 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (material_id, concept_id)
      );
    `,
  },
];

export function migrate(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  const currentVersion = appliedRow.v;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const applyAll = db.transaction((migrations: Migration[]) => {
    for (const migration of migrations) {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  applyAll(pending);
}

export const LATEST_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
