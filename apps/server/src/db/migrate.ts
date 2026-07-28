import type { SqliteDb } from './database.js';

interface Migration {
  version: number;
  name: string;
  up: string;
  /**
   * True when the migration rebuilds a table (CREATE new → copy → DROP old →
   * RENAME). Foreign keys must be disabled around such migrations per the
   * documented SQLite ALTER TABLE procedure; migrate() then verifies
   * referential integrity with `PRAGMA foreign_key_check` INSIDE the
   * transaction, so an inconsistent rebuild rolls back completely.
   */
  rebuildsTables?: boolean;
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
  {
    version: 4,
    name: 'canonical_concept_alignment',
    // Canonical cross-document concept alignment. Source concepts are NEVER
    // rewritten: canonical concepts + memberships form a separate alignment
    // layer, and proposals stay auditable after every decision. Memberships
    // cascade away with their source concept (document deletion); canonical
    // concepts left without members are cleaned up by the repository layer
    // under an explicit documented policy.
    up: `
      CREATE TABLE canonical_concepts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_canonical_concepts_workspace ON canonical_concepts(workspace_id);

      CREATE TABLE canonical_members (
        source_concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
        canonical_concept_id TEXT NOT NULL REFERENCES canonical_concepts(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        material_id TEXT NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('zh', 'en', 'mixed', 'unknown')),
        via_proposal_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_canonical_members_canonical ON canonical_members(canonical_concept_id);

      CREATE TABLE alignment_proposals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        target_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN
          ('equivalent', 'alias', 'broader', 'narrower', 'related_but_distinct')),
        proposed_canonical_name TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('local_rule', 'provider')),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'kept_separate')),
        source_language TEXT NOT NULL,
        target_language TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX idx_alignment_proposals_workspace ON alignment_proposals(workspace_id);
      CREATE UNIQUE INDEX idx_alignment_proposals_pair
        ON alignment_proposals(workspace_id, source_concept_id, target_concept_id, relation);
    `,
  },
  {
    version: 5,
    name: 'workspace_assessments_and_blueprints',
    // Workspace-scoped (cross-document) assessments. The quizzes table is
    // rebuilt so material_id becomes nullable and workspace_id / assessment
    // metadata are added — following the documented SQLite 12-step procedure
    // (new table → copy → drop → rename) with foreign keys disabled around
    // the transaction and an integrity check before commit (see migrate()).
    // Every existing quiz row is copied verbatim; nothing is dropped.
    rebuildsTables: true,
    up: `
      CREATE TABLE quizzes_rebuilt (
        id TEXT PRIMARY KEY,
        material_id TEXT REFERENCES materials(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        assessment_mode TEXT,
        config TEXT NOT NULL,
        target_concept_ids TEXT,
        created_at TEXT NOT NULL,
        CHECK (material_id IS NOT NULL OR workspace_id IS NOT NULL)
      );
      INSERT INTO quizzes_rebuilt (id, material_id, workspace_id, kind, assessment_mode, config, target_concept_ids, created_at)
      SELECT id, material_id, NULL, kind, NULL, config, target_concept_ids, created_at FROM quizzes;
      DROP TABLE quizzes;
      ALTER TABLE quizzes_rebuilt RENAME TO quizzes;
      CREATE INDEX idx_quizzes_material ON quizzes(material_id);
      CREATE INDEX idx_quizzes_workspace ON quizzes(workspace_id);

      CREATE TABLE question_blueprints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        quiz_id TEXT REFERENCES quizzes(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('single_document', 'cross_document')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_question_blueprints_workspace ON question_blueprints(workspace_id);
      CREATE INDEX idx_question_blueprints_quiz ON question_blueprints(quiz_id);
    `,
  },
  {
    version: 6,
    name: 'misconception_hypotheses',
    // Explicit misconception lifecycle. Records keep full audit linkage to
    // the originating question/quiz; deleting a source document cascades away
    // its concepts' hypotheses (the concept itself is gone), while quiz
    // deletion does NOT erase records (no FK on quiz ids by design — the
    // question snapshot lives in the payload for audit).
    up: `
      CREATE TABLE misconceptions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'resolved')),
        category TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_misconceptions_workspace ON misconceptions(workspace_id);
      CREATE INDEX idx_misconceptions_concept ON misconceptions(concept_id);
    `,
  },
  {
    version: 7,
    name: 'review_scheduling',
    // Long-term review state, separate from mastery by design. Items cascade
    // away with their concept; events are the immutable audit trail.
    up: `
      CREATE TABLE review_items (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        concept_name TEXT NOT NULL,
        stability REAL NOT NULL CHECK (stability > 0),
        difficulty REAL NOT NULL CHECK (difficulty >= 1 AND difficulty <= 10),
        due_at TEXT NOT NULL,
        last_reviewed_at TEXT NOT NULL,
        interval_days REAL NOT NULL CHECK (interval_days >= 0),
        review_count INTEGER NOT NULL CHECK (review_count > 0),
        lapse_count INTEGER NOT NULL CHECK (lapse_count >= 0),
        last_rating TEXT NOT NULL CHECK (last_rating IN ('again', 'hard', 'good', 'easy')),
        scheduler_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, concept_id)
      );
      CREATE INDEX idx_review_items_due ON review_items(workspace_id, due_at);

      CREATE TABLE review_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL,
        quiz_id TEXT,
        rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
        score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
        interval_days REAL NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_review_events_workspace ON review_events(workspace_id, concept_id);
    `,
  },
  {
    version: 8,
    name: 'tutor_runs_and_events',
    // Bounded Tutor persistence: runs plus their safe timeline events.
    // Hidden chain-of-thought is never persisted — events store only the
    // locally-composed summaries that were shown to the learner.
    up: `
      CREATE TABLE tutor_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        concept_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed', 'interrupted')),
        iterations INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        accepted_evidence TEXT NOT NULL DEFAULT '[]',
        plan_id TEXT,
        activity TEXT,
        error_message TEXT,
        provider TEXT NOT NULL,
        provider_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tutor_runs_workspace ON tutor_runs(workspace_id);

      CREATE TABLE tutor_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES tutor_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tutor_events_run ON tutor_events(run_id, seq);
    `,
  },
  {
    version: 9,
    name: 'source_block_page_ranges',
    // Layout-aware PDF ingestion can repair a paragraph that visually spans a
    // page break, so a block may end on a later page than it starts. Legacy
    // rows keep page_end NULL (their blocks were page-bounded by
    // construction, so NULL means "single page", never a hidden span) — no
    // provenance is fabricated for existing data.
    up: `
      ALTER TABLE source_blocks ADD COLUMN page_end INTEGER;
    `,
  },
  {
    version: 10,
    name: 'completed_attempt_snapshots',
    // Durable completed-quiz history. Quizzes, submissions and grading
    // results were already persisted immutably; this records the two pieces
    // that used to live only in the HTTP response: which provider graded the
    // attempt ('fake' | 'hy3') and the deterministic learning-state-change
    // summary computed at submission time. Both stay NULL for attempts graded
    // before this upgrade — history rendering shows an honest "not recorded"
    // fallback instead of fabricating data.
    up: `
      ALTER TABLE grading_results ADD COLUMN provider TEXT;
      ALTER TABLE grading_results ADD COLUMN state_changes TEXT;
    `,
  },
  {
    version: 11,
    name: 'workspace_origin',
    // Persisted, immutable workspace origin. New rows record how they were
    // created ('manual' via POST /api/workspaces, 'material_import' for the
    // auto-created per-import compatibility workspace of a 资料库 import);
    // the origin decides the deletion lifecycle (an import workspace is
    // retired together with its final document). Every pre-existing row —
    // including migration-2 legacy compatibility workspaces — keeps the
    // honest default 'unknown': their origin was never recorded, so they are
    // conservatively preserved and never auto-deleted. No existing data is
    // rewritten or reclassified.
    up: `
      ALTER TABLE workspaces ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'
        CHECK (origin IN ('manual', 'material_import', 'unknown'));
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

  const needsFkOff = pending.some((m) => m.rebuildsTables === true);

  const applyAll = db.transaction((migrations: Migration[]) => {
    for (const migration of migrations) {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }
    if (needsFkOff) {
      // Table rebuilds ran with FK enforcement off; verify referential
      // integrity before committing so a bad rebuild rolls back entirely.
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`迁移后外键校验失败:${JSON.stringify(violations.slice(0, 5))}`);
      }
    }
  });

  if (needsFkOff) db.pragma('foreign_keys = OFF');
  try {
    applyAll(pending);
  } finally {
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
}

export const LATEST_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
