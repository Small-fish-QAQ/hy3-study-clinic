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
  {
    version: 2,
    name: 'course_workspaces_and_documents',
    // Adds course workspaces and multi-document metadata. Every legacy
    // material receives its own compatibility workspace (name = its title),
    // so old single-material data stays fully readable. No learning data is
    // deleted or rewritten.
    up: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        active_graph_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE materials ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      ALTER TABLE materials ADD COLUMN media_type TEXT;
      ALTER TABLE materials ADD COLUMN original_filename TEXT;
      ALTER TABLE materials ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'parsed'
        CHECK (parse_status IN ('parsed', 'parsed_with_warnings'));
      ALTER TABLE materials ADD COLUMN page_count INTEGER;
      ALTER TABLE materials ADD COLUMN extraction_warnings TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE materials ADD COLUMN parser_version TEXT;
      ALTER TABLE materials ADD COLUMN original_data BLOB;
      ALTER TABLE materials ADD COLUMN updated_at TEXT;

      ALTER TABLE source_blocks ADD COLUMN page_number INTEGER;

      INSERT INTO workspaces (id, name, description, active_graph_version_id, created_at, updated_at)
      SELECT 'ws_legacy_' || m.id, m.title, NULL, NULL, m.created_at, m.created_at
      FROM materials m
      WHERE m.workspace_id IS NULL;

      UPDATE materials SET workspace_id = 'ws_legacy_' || id WHERE workspace_id IS NULL;
      UPDATE materials SET updated_at = created_at WHERE updated_at IS NULL;
      UPDATE materials SET parser_version = 'text-v1' WHERE parser_version IS NULL;
      UPDATE materials
      SET media_type = CASE source_type
        WHEN 'md' THEN 'text/markdown'
        ELSE 'text/plain'
      END
      WHERE media_type IS NULL;

      CREATE INDEX idx_materials_workspace ON materials(workspace_id);
    `,
  },
  {
    version: 3,
    name: 'concept_graph_and_remediation_plans',
    // Adds versioned evidence-grounded concept-graph storage and accepted
    // remediation plans. Edges cascade away with their concepts; edge
    // evidence cascades away with its source blocks. The active-version
    // pointer lives on workspaces (kept consistent transactionally in the
    // repository layer; no circular FK).
    up: `
      CREATE TABLE graph_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
        provider TEXT NOT NULL,
        provider_model TEXT,
        validation_summary TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_graph_versions_workspace ON graph_versions(workspace_id);

      CREATE TABLE graph_edges (
        id TEXT PRIMARY KEY,
        graph_version_id TEXT NOT NULL REFERENCES graph_versions(id) ON DELETE CASCADE,
        source_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        target_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN
          ('prerequisite', 'part_of', 'contrasts_with', 'causes', 'applies_to', 'example_of')),
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_graph_edges_version ON graph_edges(graph_version_id);
      CREATE INDEX idx_graph_edges_source ON graph_edges(source_concept_id);
      CREATE INDEX idx_graph_edges_target ON graph_edges(target_concept_id);

      CREATE TABLE graph_edge_evidence (
        id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL REFERENCES graph_edges(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL REFERENCES source_blocks(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        quote TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL,
        reanchored INTEGER NOT NULL CHECK (reanchored IN (0, 1))
      );
      CREATE INDEX idx_graph_edge_evidence_edge ON graph_edge_evidence(edge_id);
      CREATE INDEX idx_graph_edge_evidence_block ON graph_edge_evidence(block_id);

      CREATE TABLE remediation_plans (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_remediation_plans_concept
        ON remediation_plans(workspace_id, concept_id);
    `,
  },
];

export function migrate(db: SqliteDb, options: { toVersion?: number } = {}): void {
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

  const ceiling = options.toVersion ?? Number.POSITIVE_INFINITY;
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion && m.version <= ceiling).sort(
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
