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
  {
    version: 12,
    name: 'concept_lessons',
    // Teaching-enrichment layer: one current lesson card per concept.
    // `content` is the validated JSON lesson (typed sections of segments;
    // segments carry a server-VERIFIED anchor when — and only when — their
    // proposed quote passed exact-quote verification); `conflicts` records
    // course-vs-common-presentation differences, each with a verified source
    // quote. Lessons are display-layer teaching material: they are never
    // grading truth and never mutate learner state, and they cascade away
    // with their concept (document deletion/reprocess) by design. Purely
    // additive — no existing table or row changes.
    up: `
      CREATE TABLE concept_lessons (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL UNIQUE REFERENCES concepts(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        conflicts TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        provider_model TEXT,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_concept_lessons_workspace ON concept_lessons(workspace_id);
    `,
  },
  {
    version: 13,
    name: 'material_revision_lineage_and_source_authority',
    // Materials remain the stable learner-facing identity. Existing extraction
    // columns stay as an active-revision compatibility projection while every
    // source artifact is assigned to an immutable revision. Legacy rows become
    // revision 1 without inventing parser or content fingerprints.
    up: `
      CREATE TABLE material_revisions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        predecessor_revision_id TEXT REFERENCES material_revisions(id),
        status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'active', 'failed', 'retired')),
        source_type TEXT NOT NULL,
        media_type TEXT,
        original_filename TEXT,
        content TEXT NOT NULL,
        char_count INTEGER NOT NULL CHECK (char_count > 0),
        parse_status TEXT CHECK (parse_status IS NULL OR parse_status IN ('parsed', 'parsed_with_warnings')),
        page_count INTEGER,
        extraction_warnings TEXT NOT NULL DEFAULT '[]',
        parser_version TEXT,
        parser_fingerprint TEXT,
        content_fingerprint TEXT,
        original_data BLOB,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        UNIQUE (material_id, revision_number)
      );
      CREATE INDEX idx_material_revisions_material
        ON material_revisions(material_id, revision_number DESC);
      CREATE INDEX idx_material_revisions_status
        ON material_revisions(material_id, status);

      ALTER TABLE materials ADD COLUMN active_revision_id TEXT REFERENCES material_revisions(id);
      ALTER TABLE materials ADD COLUMN availability TEXT NOT NULL DEFAULT 'active'
        CHECK (availability IN ('active', 'retired'));
      ALTER TABLE materials ADD COLUMN retired_at TEXT;

      INSERT INTO material_revisions (
        id, material_id, revision_number, predecessor_revision_id, status,
        source_type, media_type, original_filename, content, char_count,
        parse_status, page_count, extraction_warnings, parser_version,
        parser_fingerprint, content_fingerprint, original_data, failure_code,
        failure_message, created_at, activated_at
      )
      SELECT
        'rev_legacy_' || id, id, 1, NULL, 'active', source_type, media_type,
        original_filename, content, char_count, parse_status, page_count,
        extraction_warnings, parser_version, NULL, NULL, original_data, NULL,
        NULL, created_at, COALESCE(updated_at, created_at)
      FROM materials;

      UPDATE materials SET active_revision_id = 'rev_legacy_' || id;

      ALTER TABLE source_blocks ADD COLUMN material_revision_id TEXT REFERENCES material_revisions(id);
      UPDATE source_blocks
        SET material_revision_id = 'rev_legacy_' || material_id
        WHERE material_revision_id IS NULL;
      CREATE INDEX idx_source_blocks_revision
        ON source_blocks(material_revision_id, idx);

      ALTER TABLE concepts ADD COLUMN material_revision_id TEXT REFERENCES material_revisions(id);
      UPDATE concepts
        SET material_revision_id = 'rev_legacy_' || material_id
        WHERE material_revision_id IS NULL;
      CREATE INDEX idx_concepts_revision
        ON concepts(material_revision_id, created_at, id);

      CREATE TABLE material_parser_attempts (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES material_revisions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN
          ('running', 'succeeded', 'failed', 'interrupted', 'outcome_unknown')),
        parser_version TEXT,
        parser_fingerprint TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_material_parser_attempts_material
        ON material_parser_attempts(material_id, started_at DESC);

      CREATE TABLE normalized_structural_units (
        id TEXT PRIMARY KEY,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES normalized_structural_units(id) ON DELETE CASCADE,
        unit_type TEXT NOT NULL CHECK (unit_type IN
          ('document', 'chapter', 'section', 'paragraph', 'page', 'table', 'formula', 'figure', 'other')),
        idx INTEGER NOT NULL CHECK (idx >= 0),
        title TEXT,
        start_offset INTEGER,
        end_offset INTEGER,
        page_number INTEGER,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE (material_revision_id, idx, unit_type)
      );
      CREATE INDEX idx_structural_units_revision
        ON normalized_structural_units(material_revision_id, idx);

      CREATE TABLE material_role_versions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES material_role_versions(id),
        role TEXT NOT NULL CHECK (role IN
          ('course_material', 'supplementary_reference', 'past_exam',
           'exercise_sheet', 'question_set', 'excluded', 'unknown')),
        scope_included INTEGER NOT NULL CHECK (scope_included IN (0, 1)),
        learner_confirmed INTEGER NOT NULL CHECK (learner_confirmed IN (0, 1)),
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (material_id, version)
      );
      CREATE INDEX idx_material_role_versions_material
        ON material_role_versions(material_id, version DESC);

      INSERT INTO material_role_versions (
        id, material_id, version, predecessor_id, role, scope_included,
        learner_confirmed, actor, reason, created_at
      )
      SELECT 'role_legacy_' || id, id, 1, NULL, 'unknown', 0, 0,
        'migration', 'Historical role was not recorded.', created_at
      FROM materials;

      CREATE TABLE material_revision_lineage (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        from_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        to_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        method TEXT NOT NULL CHECK (method IN ('exact', 'near_exact', 'semantic', 'manual')),
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'uncertain')),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (from_revision_id, to_revision_id, method)
      );

      CREATE TABLE material_lineage_items (
        id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES material_revision_lineage(id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('source_block', 'concept', 'structural_unit')),
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'near_exact', 'semantic', 'manual')),
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        UNIQUE (lineage_id, entity_kind, from_entity_id, to_entity_id)
      );

      CREATE TABLE truth_authority_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        logical_source_id TEXT NOT NULL,
        material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
        material_revision_id TEXT REFERENCES material_revisions(id) ON DELETE SET NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES truth_authority_records(id),
        premise_scope TEXT NOT NULL,
        policy_basis TEXT NOT NULL,
        validation_state TEXT NOT NULL CHECK (validation_state IN
          ('candidate', 'validated', 'rejected', 'stale')),
        conflict_state TEXT NOT NULL CHECK (conflict_state IN
          ('none', 'unresolved', 'resolved')),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (logical_source_id, version)
      );
      CREATE INDEX idx_truth_authority_workspace
        ON truth_authority_records(workspace_id, validation_state);

      CREATE TABLE truth_authority_claims (
        id TEXT PRIMARY KEY,
        authority_record_id TEXT NOT NULL REFERENCES truth_authority_records(id) ON DELETE CASCADE,
        source_block_id TEXT NOT NULL REFERENCES source_blocks(id),
        claim TEXT NOT NULL,
        quote TEXT NOT NULL,
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_truth_authority_claims_record
        ON truth_authority_claims(authority_record_id);

      CREATE TABLE truth_authority_events (
        id TEXT PRIMARY KEY,
        authority_record_id TEXT NOT NULL REFERENCES truth_authority_records(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (authority_record_id, seq)
      );
    `,
  },
  {
    version: 14,
    name: 'durable_agent_operations_and_cost_telemetry',
    // Lightweight local runtime only: consequential commands, physical model
    // attempts, usage, and cache identity are durable without introducing a
    // second queue or workflow system. A missing cost policy means no cap.
    up: `
      CREATE TABLE agent_operations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        logical_operation_id TEXT NOT NULL UNIQUE,
        operation_type TEXT NOT NULL,
        expected_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, idempotency_key)
      );
      CREATE INDEX idx_agent_operations_workspace_status
        ON agent_operations(workspace_id, status, created_at);
      CREATE INDEX idx_agent_operations_lease
        ON agent_operations(status, lease_expires_at);

      CREATE TABLE agent_operation_events (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES agent_operations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (operation_id, seq)
      );
      CREATE INDEX idx_agent_operation_events_operation
        ON agent_operation_events(operation_id, seq);

      CREATE TABLE agent_operation_results (
        operation_id TEXT PRIMARY KEY REFERENCES agent_operations(id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE model_logical_calls (
        id TEXT PRIMARY KEY,
        operation_id TEXT REFERENCES agent_operations(id) ON DELETE SET NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        study_session_id TEXT,
        learning_unit_id TEXT,
        assessment_id TEXT,
        operation_type TEXT NOT NULL,
        cache_key TEXT,
        cache_status TEXT NOT NULL CHECK (cache_status IN
          ('not_checked', 'hit', 'miss', 'bypassed')),
        prompt_fingerprint TEXT,
        schema_fingerprint TEXT,
        policy_fingerprint TEXT,
        source_fingerprint TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_model_logical_calls_workspace
        ON model_logical_calls(workspace_id, created_at);
      CREATE INDEX idx_model_logical_calls_operation
        ON model_logical_calls(operation_id);

      CREATE TABLE model_call_attempts (
        id TEXT PRIMARY KEY,
        logical_call_id TEXT NOT NULL REFERENCES model_logical_calls(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        attempt_kind TEXT NOT NULL CHECK (attempt_kind IN
          ('original', 'repair', 'retry', 'fallback')),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'sent', 'completed', 'failed', 'cancelled', 'interrupted', 'outcome_unknown')),
        started_at TEXT NOT NULL,
        sent_at TEXT,
        first_token_at TEXT,
        completed_at TEXT,
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        time_to_first_token_ms INTEGER CHECK (time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0),
        error_code TEXT,
        error_message TEXT,
        UNIQUE (logical_call_id, attempt_number)
      );
      CREATE INDEX idx_model_call_attempts_logical
        ON model_call_attempts(logical_call_id, attempt_number);

      CREATE TABLE model_usage_records (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES model_call_attempts(id) ON DELETE CASCADE,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        estimated_cost_microunits INTEGER CHECK
          (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
        currency TEXT,
        pricing_source TEXT,
        pricing_version TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE semantic_cache_entries (
        cache_key TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        result_payload TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        prompt_fingerprint TEXT,
        schema_fingerprint TEXT,
        policy_fingerprint TEXT,
        source_fingerprint TEXT,
        validation_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        invalidated_at TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
        last_hit_at TEXT
      );
      CREATE INDEX idx_semantic_cache_workspace
        ON semantic_cache_entries(workspace_id, operation_type);

      CREATE TABLE cost_policies (
        id TEXT PRIMARY KEY,
        policy_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('operation', 'session', 'day', 'course')),
        scope_key TEXT NOT NULL,
        limit_microunits INTEGER NOT NULL CHECK (limit_microunits >= 0),
        currency TEXT NOT NULL,
        on_exceed TEXT NOT NULL CHECK (on_exceed IN
          ('confirm', 'cache_only', 'lower_cost_or_confirm', 'refuse')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_cost_policies_workspace
        ON cost_policies(workspace_id, scope_type, scope_key);
    `,
  },
  {
    version: 15,
    name: 'accepted_course_execution_route',
    // Aggregate payloads preserve exact versioned contracts while normalized
    // indexes enforce cross-aggregate scope, provenance, launchability, and
    // atomic route-pointer invariants. Existing courses receive no invented
    // Contract, Curriculum, Plan, Agenda, or active execution pointer.
    up: `
      ALTER TABLE material_role_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'learner_confirmed', 'superseded', 'withdrawn'));
      ALTER TABLE material_role_versions ADD COLUMN proposed_by TEXT NOT NULL DEFAULT 'local'
        CHECK (proposed_by IN ('learner', 'local', 'model'));
      ALTER TABLE material_role_versions ADD COLUMN learner_confirmed_at TEXT;

      CREATE TABLE learning_contract_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES learning_contract_versions(id),
        status TEXT NOT NULL CHECK (status IN
          ('draft', 'proposed', 'learner_confirmed', 'active', 'closed', 'superseded', 'withdrawn')),
        payload TEXT NOT NULL,
        learner_confirmed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, version)
      );
      CREATE INDEX idx_learning_contract_workspace_status
        ON learning_contract_versions(workspace_id, status, version DESC);

      CREATE TABLE learning_contract_material_scope (
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES materials(id),
        material_role_assignment_id TEXT NOT NULL REFERENCES material_role_versions(id),
        material_role_assignment_version INTEGER NOT NULL CHECK (material_role_assignment_version > 0),
        role TEXT NOT NULL CHECK (role IN
          ('course_material', 'supplementary_reference', 'past_exam', 'exercise_sheet', 'question_set')),
        disposition TEXT NOT NULL CHECK (disposition IN ('included', 'excluded')),
        PRIMARY KEY (contract_id, material_id)
      );
      CREATE INDEX idx_contract_material_scope_material
        ON learning_contract_material_scope(material_id, contract_id);

      CREATE TABLE learning_contract_events (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (contract_id, seq)
      );

      CREATE TABLE learning_contract_feasibility_snapshots (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id) ON DELETE CASCADE,
        policy_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        UNIQUE (contract_id, policy_version, computed_at)
      );

      CREATE TABLE execution_source_manifests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, fingerprint)
      );

      CREATE TABLE execution_source_manifest_revisions (
        manifest_id TEXT NOT NULL REFERENCES execution_source_manifests(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL REFERENCES materials(id),
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id),
        parser_version TEXT,
        parser_fingerprint TEXT,
        PRIMARY KEY (manifest_id, material_id)
      );

      CREATE TABLE execution_source_manifest_blocks (
        manifest_id TEXT NOT NULL REFERENCES execution_source_manifests(id) ON DELETE CASCADE,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id),
        source_block_id TEXT NOT NULL REFERENCES source_blocks(id),
        PRIMARY KEY (manifest_id, source_block_id)
      );

      CREATE TABLE curriculum_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        manifest_id TEXT NOT NULL REFERENCES execution_source_manifests(id),
        manifest_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES curriculum_versions(id),
        status TEXT NOT NULL CHECK (status IN
          ('candidate', 'proposed', 'accepted', 'rejected', 'failed', 'superseded')),
        validation_valid INTEGER NOT NULL CHECK (validation_valid IN (0, 1)),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE (workspace_id, version)
      );
      CREATE INDEX idx_curriculum_workspace_status
        ON curriculum_versions(workspace_id, status, version DESC);

      CREATE TABLE curriculum_node_index (
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        parent_node_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('course', 'chapter', 'section', 'learning_unit')),
        idx INTEGER NOT NULL CHECK (idx >= 0),
        title TEXT NOT NULL,
        PRIMARY KEY (curriculum_id, node_id)
      );
      CREATE INDEX idx_curriculum_nodes_parent
        ON curriculum_node_index(curriculum_id, parent_node_id, idx);

      CREATE TABLE curriculum_node_source_refs (
        curriculum_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        material_id TEXT NOT NULL REFERENCES materials(id),
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id),
        structural_unit_id TEXT REFERENCES normalized_structural_units(id),
        source_block_id TEXT REFERENCES source_blocks(id),
        source_block_revision_fingerprint TEXT,
        PRIMARY KEY (curriculum_id, node_id, ordinal),
        FOREIGN KEY (curriculum_id, node_id)
          REFERENCES curriculum_node_index(curriculum_id, node_id) ON DELETE CASCADE
      );

      CREATE TABLE curriculum_objective_index (
        curriculum_id TEXT NOT NULL,
        learning_unit_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        truth_premise_status TEXT NOT NULL CHECK (truth_premise_status IN
          ('independently_verified', 'unverified', 'conflicted', 'not_applicable')),
        PRIMARY KEY (curriculum_id, objective_id),
        FOREIGN KEY (curriculum_id, learning_unit_id)
          REFERENCES curriculum_node_index(curriculum_id, node_id) ON DELETE CASCADE
      );

      CREATE TABLE curriculum_objective_authority (
        curriculum_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        authority_record_id TEXT NOT NULL REFERENCES truth_authority_records(id),
        PRIMARY KEY (curriculum_id, objective_id, authority_record_id),
        FOREIGN KEY (curriculum_id, objective_id)
          REFERENCES curriculum_objective_index(curriculum_id, objective_id) ON DELETE CASCADE
      );

      CREATE TABLE curriculum_events (
        id TEXT PRIMARY KEY,
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (curriculum_id, seq)
      );

      CREATE TABLE study_plan_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        manifest_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES study_plan_versions(id),
        status TEXT NOT NULL CHECK (status IN
          ('candidate', 'proposed', 'accepted', 'rejected', 'superseded', 'closed')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        learner_accepted_at TEXT,
        UNIQUE (workspace_id, version)
      );
      CREATE INDEX idx_study_plan_workspace_status
        ON study_plan_versions(workspace_id, status, version DESC);

      CREATE TABLE study_plan_items (
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id) ON DELETE CASCADE,
        plan_item_id TEXT NOT NULL,
        idx INTEGER NOT NULL CHECK (idx >= 0),
        kind TEXT NOT NULL,
        curriculum_learning_unit_id TEXT,
        objective_ids TEXT NOT NULL,
        completion_requirements TEXT NOT NULL,
        PRIMARY KEY (plan_id, plan_item_id),
        UNIQUE (plan_id, idx)
      );

      CREATE TABLE study_plan_deferrals (
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id) ON DELETE CASCADE,
        curriculum_learning_unit_id TEXT NOT NULL,
        objective_ids TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk_ids TEXT NOT NULL,
        PRIMARY KEY (plan_id, curriculum_learning_unit_id)
      );

      CREATE TABLE study_plan_launch_validations (
        plan_id TEXT NOT NULL,
        plan_item_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('launchable', 'revalidation_required', 'blocked')),
        capability TEXT NOT NULL,
        resource_id TEXT,
        reason TEXT,
        source_fingerprint TEXT NOT NULL,
        validated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, plan_item_id),
        FOREIGN KEY (plan_id, plan_item_id)
          REFERENCES study_plan_items(plan_id, plan_item_id) ON DELETE CASCADE
      );

      CREATE TABLE pace_baselines (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE REFERENCES study_plan_versions(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        policy_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE study_plan_progress (
        plan_id TEXT NOT NULL,
        plan_item_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN
          ('not_started', 'started', 'completed', 'repair_needed', 'deferred', 'obsolete')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, plan_item_id),
        FOREIGN KEY (plan_id, plan_item_id)
          REFERENCES study_plan_items(plan_id, plan_item_id) ON DELETE CASCADE
      );

      CREATE TABLE study_plan_progress_events (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        plan_item_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq > 0),
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (plan_id, plan_item_id, seq),
        FOREIGN KEY (plan_id, plan_item_id)
          REFERENCES study_plan_items(plan_id, plan_item_id) ON DELETE CASCADE
      );

      CREATE TABLE study_plan_events (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (plan_id, seq)
      );

      CREATE TABLE session_agendas (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        manifest_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed', 'paused', 'abandoned')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, version)
      );

      CREATE TABLE session_agenda_items (
        agenda_id TEXT NOT NULL REFERENCES session_agendas(id) ON DELETE CASCADE,
        agenda_item_id TEXT NOT NULL,
        idx INTEGER NOT NULL CHECK (idx >= 0),
        linked_plan_item_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        launch_status TEXT NOT NULL CHECK (launch_status IN
          ('launchable', 'revalidation_required', 'blocked')),
        launch_capability TEXT NOT NULL,
        launch_resource_id TEXT,
        launch_reason TEXT,
        PRIMARY KEY (agenda_id, agenda_item_id),
        UNIQUE (agenda_id, idx)
      );

      CREATE TABLE session_agenda_events (
        id TEXT PRIMARY KEY,
        agenda_id TEXT NOT NULL REFERENCES session_agendas(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (agenda_id, seq)
      );

      CREATE TABLE coverage_risk_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        stable_scope_fingerprint TEXT NOT NULL,
        material_id TEXT REFERENCES materials(id),
        objective_id TEXT,
        origin TEXT NOT NULL CHECK (origin IN
          ('deterministic', 'source', 'learner', 'exam_observation', 'model_candidate')),
        status TEXT NOT NULL CHECK (status IN
          ('open', 'acknowledged', 'planned', 'checking', 'resolved', 'rejected', 'deferred', 'stale')),
        truth_premise_status TEXT NOT NULL CHECK (truth_premise_status IN
          ('independently_verified', 'unverified', 'conflicted', 'not_applicable')),
        payload TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_coverage_risk_workspace_status
        ON coverage_risk_entries(workspace_id, status, updated_at DESC);

      CREATE TABLE coverage_risk_observations (
        risk_id TEXT NOT NULL REFERENCES coverage_risk_entries(id) ON DELETE CASCADE,
        observation_id TEXT NOT NULL,
        material_revision_id TEXT REFERENCES material_revisions(id),
        source_block_id TEXT REFERENCES source_blocks(id),
        source_block_revision_fingerprint TEXT,
        manifest_fingerprint TEXT,
        reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN
          ('current', 'pending', 'stale', 'reconciled')),
        payload TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (risk_id, observation_id)
      );

      CREATE TABLE coverage_risk_authority_links (
        risk_id TEXT NOT NULL REFERENCES coverage_risk_entries(id) ON DELETE CASCADE,
        authority_record_id TEXT NOT NULL REFERENCES truth_authority_records(id),
        PRIMARY KEY (risk_id, authority_record_id)
      );

      CREATE TABLE coverage_risk_events (
        id TEXT PRIMARY KEY,
        risk_id TEXT NOT NULL REFERENCES coverage_risk_entries(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (risk_id, seq)
      );

      CREATE TABLE course_execution_state (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        active_contract_id TEXT REFERENCES learning_contract_versions(id),
        active_curriculum_id TEXT REFERENCES curriculum_versions(id),
        accepted_plan_id TEXT REFERENCES study_plan_versions(id),
        active_agenda_id TEXT REFERENCES session_agendas(id),
        execution_status TEXT NOT NULL DEFAULT 'stopped'
          CHECK (execution_status IN ('active', 'paused', 'stopped')),
        route_validation_status TEXT NOT NULL DEFAULT 'unconfigured'
          CHECK (route_validation_status IN ('unconfigured', 'valid', 'revalidation_required', 'blocked')),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        updated_at TEXT NOT NULL,
        CHECK (
          (active_contract_id IS NULL AND active_curriculum_id IS NULL
            AND accepted_plan_id IS NULL AND active_agenda_id IS NULL
            AND execution_status = 'stopped' AND route_validation_status = 'unconfigured')
          OR
          (active_contract_id IS NOT NULL AND active_curriculum_id IS NOT NULL
            AND accepted_plan_id IS NOT NULL AND active_agenda_id IS NOT NULL)
        )
      );

      CREATE TABLE course_execution_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
        resulting_version INTEGER NOT NULL CHECK (resulting_version > expected_version),
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, seq)
      );

      CREATE TRIGGER mark_course_route_stale_after_material_revision_change
      AFTER UPDATE OF active_revision_id ON materials
      WHEN OLD.active_revision_id IS NOT NEW.active_revision_id
      BEGIN
        UPDATE course_execution_state
        SET route_validation_status = 'revalidation_required',
            version = version + 1,
            updated_at = COALESCE(NEW.updated_at, updated_at)
        WHERE workspace_id = NEW.workspace_id
          AND active_contract_id IS NOT NULL;
      END;
    `,
  },
  {
    version: 16,
    name: 'durable_study_sessions',
    // StudySession owns conversational execution state. Conversation and
    // provisional Tutor output remain separate from formal learner state.
    up: `
      CREATE TABLE study_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        agenda_id TEXT NOT NULL REFERENCES session_agendas(id),
        manifest_fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN
          ('active', 'paused', 'completed', 'abandoned', 'interrupted')),
        route_state TEXT NOT NULL CHECK (route_state IN
          ('on_route', 'detour_active', 'return_pending', 'execution_paused')),
        current_agenda_item_id TEXT,
        route_stack TEXT NOT NULL,
        transcript_watermark INTEGER NOT NULL DEFAULT 0 CHECK (transcript_watermark >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_study_sessions_workspace_status
        ON study_sessions(workspace_id, status, updated_at DESC);

      CREATE TABLE study_session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        command_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
        context_manifest TEXT NOT NULL,
        logical_call_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX idx_study_session_turns_session_status
        ON study_session_turns(session_id, status, seq);

      CREATE TABLE study_session_exchanges (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES study_session_turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        role TEXT NOT NULL CHECK (role IN ('learner', 'tutor', 'local_system')),
        content TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN
          ('conversation', 'informal_check', 'operation_notice')),
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX idx_study_session_exchanges_turn
        ON study_session_exchanges(turn_id, seq);

      CREATE TABLE study_turn_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES study_session_turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        kind TEXT NOT NULL CHECK (kind IN
          ('queued', 'started', 'content_delta', 'action_proposed', 'action_rejected',
           'completed', 'failed', 'interrupted', 'cancelled')),
        provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
        content TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (turn_id, seq)
      );
      CREATE INDEX idx_study_turn_events_session_turn
        ON study_turn_events(session_id, turn_id, seq);

      CREATE TABLE study_session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        through_exchange_seq INTEGER NOT NULL CHECK (through_exchange_seq >= 0),
        context_fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, version)
      );
      CREATE INDEX idx_study_session_summaries_latest
        ON study_session_summaries(session_id, version DESC);
    `,
  },
  {
    version: 17,
    name: 'formal_evidence_progression_and_replans',
    // Formal evidence is an immutable assessment contract plus a retryable
    // reconciliation projection. It never replaces the existing grading
    // transaction or treats learner scope confirmation as truth authority.
    up: `
      CREATE TABLE formal_question_contracts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        study_session_id TEXT REFERENCES study_sessions(id),
        agenda_item_id TEXT NOT NULL,
        learning_unit_id TEXT NOT NULL,
        primary_objective_id TEXT NOT NULL,
        admissibility_tier TEXT NOT NULL CHECK (admissibility_tier IN
          ('tier_1_authorized_truth', 'tier_2_validated_representation', 'tier_3_advisory')),
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        manifest_fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (quiz_id, question_id)
      );
      CREATE INDEX idx_formal_question_contracts_workspace
        ON formal_question_contracts(workspace_id, created_at DESC);

      CREATE TABLE formal_evidence_records (
        id TEXT PRIMARY KEY,
        formal_question_contract_id TEXT NOT NULL REFERENCES formal_question_contracts(id) ON DELETE CASCADE,
        grading_result_id TEXT NOT NULL REFERENCES grading_results(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        primary_objective_id TEXT NOT NULL,
        learning_unit_id TEXT NOT NULL,
        admissibility_tier TEXT NOT NULL CHECK (admissibility_tier IN
          ('tier_1_authorized_truth', 'tier_2_validated_representation', 'tier_3_advisory')),
        state_creditable INTEGER NOT NULL CHECK (state_creditable IN (0, 1)),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (formal_question_contract_id, grading_result_id)
      );
      CREATE INDEX idx_formal_evidence_grading
        ON formal_evidence_records(grading_result_id, created_at);
      CREATE INDEX idx_formal_evidence_unit
        ON formal_evidence_records(learning_unit_id, created_at);

      CREATE TABLE completion_policy_versions (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (contract_id, version)
      );

      CREATE TABLE progression_reconciliations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        grading_result_id TEXT NOT NULL REFERENCES grading_results(id) ON DELETE CASCADE,
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        learning_unit_id TEXT NOT NULL,
        completion_policy_id TEXT NOT NULL,
        completion_policy_version INTEGER NOT NULL CHECK (completion_policy_version > 0),
        status TEXT NOT NULL CHECK (status IN
          ('reconciliation_pending', 'applied', 'rejected', 'stale')),
        decision_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (grading_result_id, completion_policy_id, completion_policy_version, learning_unit_id)
      );
      CREATE INDEX idx_progression_reconciliation_workspace
        ON progression_reconciliations(workspace_id, status, updated_at DESC);

       CREATE TABLE progression_decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        learning_unit_id TEXT NOT NULL,
        completion_policy_id TEXT NOT NULL,
        completion_policy_version INTEGER NOT NULL CHECK (completion_policy_version > 0),
        kind TEXT NOT NULL,
        prior_state TEXT NOT NULL,
         next_state TEXT NOT NULL,
         payload TEXT NOT NULL,
         created_at TEXT NOT NULL
       );

      CREATE TABLE learning_unit_progress (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        learning_unit_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN
          ('not_started', 'in_progress', 'complete', 'repair_needed', 'deferred')),
        version INTEGER NOT NULL CHECK (version >= 0),
        last_decision_id TEXT REFERENCES progression_decisions(id),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, curriculum_id, learning_unit_id)
      );

      CREATE TABLE replan_triggers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        accepted_plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('candidate', 'qualified', 'dismissed', 'proposal_created', 'resolved')),
        proposed_plan_id TEXT REFERENCES study_plan_versions(id),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_replan_triggers_workspace
        ON replan_triggers(workspace_id, status, updated_at DESC);

      CREATE TABLE goal_outcomes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL REFERENCES learning_contract_versions(id),
        plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        status TEXT NOT NULL CHECK (status IN
          ('achieved', 'finished_with_gaps', 'expired_unfinished', 'abandoned', 'superseded')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (contract_id, plan_id)
      );
      CREATE INDEX idx_goal_outcomes_workspace
        ON goal_outcomes(workspace_id, created_at DESC);
    `,
  },
  {
    version: 18,
    name: 'complete_provider_inference_telemetry',
    rebuildsTables: true,
    up: `
      CREATE TABLE model_logical_calls_v18 (
        id TEXT PRIMARY KEY,
        operation_id TEXT REFERENCES agent_operations(id) ON DELETE SET NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        study_session_id TEXT,
        learning_unit_id TEXT,
        assessment_id TEXT,
        operation_type TEXT NOT NULL,
        cache_key TEXT,
        cache_status TEXT NOT NULL CHECK (cache_status IN
          ('not_checked', 'hit', 'miss', 'bypassed')),
        prompt_fingerprint TEXT,
        schema_fingerprint TEXT,
        policy_fingerprint TEXT,
        source_fingerprint TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO model_logical_calls_v18 SELECT * FROM model_logical_calls;

      CREATE TABLE model_call_attempts_v18 (
        id TEXT PRIMARY KEY,
        logical_call_id TEXT NOT NULL REFERENCES model_logical_calls_v18(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        attempt_kind TEXT NOT NULL CHECK (attempt_kind IN
          ('original', 'repair', 'retry', 'fallback')),
        fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1),
        provider TEXT NOT NULL,
        model TEXT,
        provider_generation INTEGER CHECK (provider_generation IS NULL OR provider_generation >= 1),
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'sent', 'completed', 'failed', 'cancelled', 'interrupted', 'outcome_unknown')),
        started_at TEXT NOT NULL,
        sent_at TEXT,
        first_token_at TEXT,
        completed_at TEXT,
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        time_to_first_token_ms INTEGER CHECK (time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0),
        error_code TEXT,
        error_message TEXT,
        UNIQUE (logical_call_id, attempt_number)
      );
      INSERT INTO model_call_attempts_v18
        (id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
         provider_generation, status, started_at, sent_at, first_token_at, completed_at,
         latency_ms, time_to_first_token_ms, error_code, error_message)
      SELECT id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
             NULL, status, started_at, sent_at, first_token_at, completed_at,
             latency_ms, time_to_first_token_ms, error_code, error_message
      FROM model_call_attempts;

      CREATE TABLE model_usage_records_v18 (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES model_call_attempts_v18(id) ON DELETE CASCADE,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        estimated_cost_microunits INTEGER CHECK
          (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
        currency TEXT,
        pricing_source TEXT,
        pricing_version TEXT,
        recorded_at TEXT NOT NULL
      );
      INSERT INTO model_usage_records_v18 SELECT * FROM model_usage_records;

      DROP TABLE model_usage_records;
      DROP TABLE model_call_attempts;
      DROP TABLE model_logical_calls;
      ALTER TABLE model_logical_calls_v18 RENAME TO model_logical_calls;
      ALTER TABLE model_call_attempts_v18 RENAME TO model_call_attempts;
      ALTER TABLE model_usage_records_v18 RENAME TO model_usage_records;
      CREATE INDEX idx_model_logical_calls_workspace
        ON model_logical_calls(workspace_id, created_at);
      CREATE INDEX idx_model_logical_calls_operation
        ON model_logical_calls(operation_id);
      CREATE INDEX idx_model_call_attempts_logical
        ON model_call_attempts(logical_call_id, attempt_number);
    `,
  },
  {
    version: 19,
    name: 'canonicalize_provider_generation_nullability',
    rebuildsTables: true,
    up: `
      CREATE TABLE model_call_attempts_v19 (
        id TEXT PRIMARY KEY,
        logical_call_id TEXT NOT NULL REFERENCES model_logical_calls(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        attempt_kind TEXT NOT NULL CHECK (attempt_kind IN
          ('original', 'repair', 'retry', 'fallback')),
        fencing_token INTEGER CHECK (fencing_token IS NULL OR fencing_token >= 1),
        provider TEXT NOT NULL,
        model TEXT,
        provider_generation INTEGER CHECK (provider_generation IS NULL OR provider_generation >= 1),
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'sent', 'completed', 'failed', 'cancelled', 'interrupted', 'outcome_unknown')),
        started_at TEXT NOT NULL,
        sent_at TEXT,
        first_token_at TEXT,
        completed_at TEXT,
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        time_to_first_token_ms INTEGER CHECK (time_to_first_token_ms IS NULL OR time_to_first_token_ms >= 0),
        error_code TEXT,
        error_message TEXT,
        UNIQUE (logical_call_id, attempt_number)
      );
      INSERT INTO model_call_attempts_v19
        (id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
         provider_generation, status, started_at, sent_at, first_token_at, completed_at,
         latency_ms, time_to_first_token_ms, error_code, error_message)
      -- The interim backfill and genuinely observed generation 1 have no
      -- persisted discriminator. Preserve both rather than guessing.
      SELECT id, logical_call_id, attempt_number, attempt_kind, fencing_token, provider, model,
             provider_generation, status, started_at, sent_at, first_token_at, completed_at,
             latency_ms, time_to_first_token_ms, error_code, error_message
      FROM model_call_attempts;

      CREATE TABLE model_usage_records_v19 (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES model_call_attempts_v19(id) ON DELETE CASCADE,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        estimated_cost_microunits INTEGER CHECK
          (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
        currency TEXT,
        pricing_source TEXT,
        pricing_version TEXT,
        recorded_at TEXT NOT NULL
      );
      INSERT INTO model_usage_records_v19 SELECT * FROM model_usage_records;

      DROP TABLE model_usage_records;
      DROP TABLE model_call_attempts;
      ALTER TABLE model_call_attempts_v19 RENAME TO model_call_attempts;
      ALTER TABLE model_usage_records_v19 RENAME TO model_usage_records;
      CREATE INDEX idx_model_call_attempts_logical
        ON model_call_attempts(logical_call_id, attempt_number);
    `,
  },
  {
    version: 20,
    name: 'immutable_learning_unit_teaching_briefs',
    // Route- and source-pinned teaching artifacts. Rows are append-only:
    // source or route changes produce a successor while historical Briefs
    // remain auditable and are never treated as learner-state evidence.
    up: `
      CREATE TABLE teaching_briefs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        study_plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        learning_unit_id TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        source_context_fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_model TEXT,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (
          curriculum_id,
          study_plan_id,
          learning_unit_id,
          manifest_fingerprint,
          source_context_fingerprint
        )
      );
      CREATE INDEX idx_teaching_briefs_workspace_unit
        ON teaching_briefs(workspace_id, learning_unit_id, created_at DESC);
    `,
  },
  {
    version: 21,
    name: 'session_owned_lesson_execution',
    // Presentation progress is a weak child of a StudySession. It is never
    // learner evidence and therefore cannot mutate plan, mastery, mistakes,
    // or formal assessment state.
    up: `
      CREATE TABLE lesson_execution_states (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
        agenda_item_id TEXT NOT NULL,
        curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id),
        study_plan_id TEXT NOT NULL REFERENCES study_plan_versions(id),
        learning_unit_id TEXT NOT NULL,
        teaching_brief_id TEXT REFERENCES teaching_briefs(id),
        manifest_fingerprint TEXT NOT NULL,
        source_context_fingerprint TEXT,
        preparation_status TEXT NOT NULL CHECK (
          preparation_status IN ('preparing', 'ready', 'retryable_failure')
        ),
        preparation_operation_id TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        current_segment_index INTEGER NOT NULL CHECK (current_segment_index >= 0),
        presented_segment_indexes TEXT NOT NULL DEFAULT '[]',
        informal_interactions TEXT NOT NULL DEFAULT '[]',
        presentation_completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, agenda_item_id)
      );
      CREATE INDEX idx_lesson_execution_session
        ON lesson_execution_states(session_id, updated_at DESC);

      CREATE TABLE lesson_execution_events (
        id TEXT PRIMARY KEY,
        lesson_execution_state_id TEXT NOT NULL
          REFERENCES lesson_execution_states(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        command_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'preparation_started', 'preparation_ready', 'preparation_failed',
          'segment_presented', 'segment_revisited',
          'informal_response_recorded', 'presentation_completed'
        )),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (lesson_execution_state_id, seq)
      );
      CREATE INDEX idx_lesson_execution_events_state
        ON lesson_execution_events(lesson_execution_state_id, seq);
    `,
  },
  {
    version: 22,
    name: 'tutor_pedagogy_turn_metadata',
    // The move decision is audit metadata for conversational turns only. It
    // has no foreign-key path to Evidence, Mastery, Mistakes, or progression.
    up: `
      ALTER TABLE study_session_turns ADD COLUMN pedagogy_metadata TEXT;
    `,
  },
  {
    version: 23,
    name: 'structure_aware_material_derivation_metadata',
    // Phase 6A makes parser/chunker identity explicit. Legacy rows remain
    // nullable: historical SourceBlocks are never relabeled as structure-aware.
    // The structural-unit table is rebuilt only to widen its controlled kind
    // enum; all existing rows are copied byte-for-byte.
    rebuildsTables: true,
    up: `
      ALTER TABLE material_revisions ADD COLUMN chunker_version TEXT;
      ALTER TABLE material_revisions ADD COLUMN chunker_fingerprint TEXT;
      ALTER TABLE material_revisions ADD COLUMN source_fingerprint TEXT;

      DROP INDEX idx_material_parser_attempts_material;
      ALTER TABLE material_parser_attempts RENAME TO material_parser_attempts_legacy;
      CREATE TABLE material_parser_attempts_rebuilt (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES material_revisions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'outcome_unknown')),
        parser_version TEXT,
        parser_fingerprint TEXT,
        chunker_version TEXT,
        chunker_fingerprint TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO material_parser_attempts_rebuilt (
        id, material_id, revision_id, status, parser_version,
        parser_fingerprint, error_code, error_message, started_at, finished_at
      )
      SELECT id, material_id, revision_id, status, parser_version,
        parser_fingerprint, error_code, error_message, started_at, finished_at
      FROM material_parser_attempts_legacy;
      DROP TABLE material_parser_attempts_legacy;
      ALTER TABLE material_parser_attempts_rebuilt RENAME TO material_parser_attempts;
      CREATE INDEX idx_material_parser_attempts_material
        ON material_parser_attempts(material_id, started_at DESC);

      CREATE TABLE normalized_structural_units_rebuilt (
        id TEXT PRIMARY KEY,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES normalized_structural_units_rebuilt(id) ON DELETE CASCADE,
        unit_type TEXT NOT NULL CHECK (unit_type IN (
          'document', 'chapter', 'section', 'heading', 'paragraph', 'list', 'list_item',
          'quote', 'code_block', 'page', 'slide', 'text_box', 'speaker_notes', 'table',
          'image', 'formula', 'figure', 'caption', 'html_block', 'source_file',
          'source_code_block', 'function', 'class', 'method', 'other'
        )),
        idx INTEGER NOT NULL CHECK (idx >= 0),
        title TEXT,
        start_offset INTEGER,
        end_offset INTEGER,
        page_number INTEGER,
        metadata TEXT NOT NULL DEFAULT '{}',
        line_start INTEGER,
        line_end INTEGER,
        page_end INTEGER,
        heading_path TEXT NOT NULL DEFAULT '[]',
        content_origin TEXT,
        chunker_version TEXT,
        UNIQUE (material_revision_id, idx, unit_type)
      );
      INSERT INTO normalized_structural_units_rebuilt (
        id, material_revision_id, parent_id, unit_type, idx, title,
        start_offset, end_offset, page_number, metadata
      )
      SELECT id, material_revision_id, parent_id, unit_type, idx, title,
        start_offset, end_offset, page_number, metadata
      FROM normalized_structural_units;
      DROP TABLE normalized_structural_units;
      ALTER TABLE normalized_structural_units_rebuilt RENAME TO normalized_structural_units;
      CREATE INDEX idx_structural_units_revision
        ON normalized_structural_units(material_revision_id, idx);

      ALTER TABLE source_blocks ADD COLUMN structural_unit_id TEXT REFERENCES normalized_structural_units(id) ON DELETE SET NULL;
      ALTER TABLE source_blocks ADD COLUMN chunker_version TEXT;
      ALTER TABLE source_blocks ADD COLUMN content_origin TEXT;
      CREATE INDEX idx_source_blocks_structural_unit ON source_blocks(structural_unit_id);
    `,
  },
  {
    version: 24,
    name: 'rich_document_assets_and_slide_provenance',
    // Original package bytes are hash-addressed once, while immutable
    // revision-local records retain structural ownership and provenance.
    // Asset-only rich documents have zero extracted characters without being
    // empty sources, so the revision constraint is widened losslessly.
    rebuildsTables: true,
    up: `
      CREATE TABLE material_revisions_rebuilt (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        predecessor_revision_id TEXT REFERENCES material_revisions_rebuilt(id),
        status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'active', 'failed', 'retired')),
        source_type TEXT NOT NULL,
        media_type TEXT,
        original_filename TEXT,
        content TEXT NOT NULL,
        char_count INTEGER NOT NULL CHECK (char_count >= 0),
        parse_status TEXT CHECK (parse_status IS NULL OR parse_status IN ('parsed', 'parsed_with_warnings')),
        page_count INTEGER,
        extraction_warnings TEXT NOT NULL DEFAULT '[]',
        parser_version TEXT,
        parser_fingerprint TEXT,
        content_fingerprint TEXT,
        chunker_version TEXT,
        chunker_fingerprint TEXT,
        source_fingerprint TEXT,
        original_data BLOB,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        UNIQUE (material_id, revision_number)
      );
      INSERT INTO material_revisions_rebuilt (
        id, material_id, revision_number, predecessor_revision_id, status,
        source_type, media_type, original_filename, content, char_count,
        parse_status, page_count, extraction_warnings, parser_version,
        parser_fingerprint, content_fingerprint, chunker_version, chunker_fingerprint,
        source_fingerprint, original_data, failure_code, failure_message,
        created_at, activated_at
      )
      SELECT
        id, material_id, revision_number, predecessor_revision_id, status,
        source_type, media_type, original_filename, content, char_count,
        parse_status, page_count, extraction_warnings, parser_version,
        parser_fingerprint, content_fingerprint, chunker_version, chunker_fingerprint,
        source_fingerprint, original_data, failure_code, failure_message,
        created_at, activated_at
      FROM material_revisions;
      DROP INDEX idx_material_revisions_material;
      DROP INDEX idx_material_revisions_status;
      DROP TABLE material_revisions;
      ALTER TABLE material_revisions_rebuilt RENAME TO material_revisions;
      CREATE INDEX idx_material_revisions_material
        ON material_revisions(material_id, revision_number DESC);
      CREATE INDEX idx_material_revisions_status
        ON material_revisions(material_id, status);

      ALTER TABLE normalized_structural_units ADD COLUMN slide_number INTEGER
        CHECK (slide_number IS NULL OR slide_number >= 1);
      ALTER TABLE source_blocks ADD COLUMN slide_number INTEGER
        CHECK (slide_number IS NULL OR slide_number >= 1);

      CREATE TABLE source_asset_blobs (
        byte_hash TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        original_data BLOB NOT NULL,
        CHECK (length(original_data) = byte_length)
      );

      CREATE TABLE material_revision_assets (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL CHECK (idx >= 0),
        parent_structural_unit_id TEXT REFERENCES normalized_structural_units(id) ON DELETE SET NULL,
        source_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_hash TEXT NOT NULL REFERENCES source_asset_blobs(byte_hash),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        width INTEGER CHECK (width IS NULL OR width >= 1),
        height INTEGER CHECK (height IS NULL OR height >= 1),
        location TEXT NOT NULL,
        relationship_kind TEXT NOT NULL CHECK (
          relationship_kind IN ('image', 'media', 'ole_object', 'unknown')
        ),
        content_origin TEXT NOT NULL CHECK (content_origin = 'extracted_original'),
        parser_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (material_revision_id, idx)
      );
      CREATE INDEX idx_material_revision_assets_revision
        ON material_revision_assets(material_revision_id, idx);
      CREATE INDEX idx_material_revision_assets_parent
        ON material_revision_assets(parent_structural_unit_id);

      CREATE TRIGGER cleanup_source_asset_blob_after_occurrence_delete
      AFTER DELETE ON material_revision_assets
      WHEN NOT EXISTS (
        SELECT 1 FROM material_revision_assets WHERE byte_hash = OLD.byte_hash
      )
      BEGIN
        DELETE FROM source_asset_blobs WHERE byte_hash = OLD.byte_hash;
      END;
    `,
  },
  {
    version: 25,
    name: 'immutable_visual_derivations',
    up: `
      CREATE TABLE visual_derivations (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES material_revision_assets(id) ON DELETE CASCADE,
        asset_byte_hash TEXT NOT NULL REFERENCES source_asset_blobs(byte_hash),
        identity_fingerprint TEXT NOT NULL UNIQUE,
        semantic_identity_fingerprint TEXT NOT NULL,
        derivation_kind TEXT NOT NULL CHECK (derivation_kind = 'visual_description'),
        content_origin TEXT NOT NULL CHECK (content_origin = 'derived_visual_description'),
        authority TEXT NOT NULL CHECK (authority = 'derived'),
        evidence_admissibility TEXT NOT NULL CHECK (evidence_admissibility = 'advisory_nonblocking'),
        validation_status TEXT NOT NULL CHECK (validation_status = 'accepted'),
        generator_identity TEXT NOT NULL CHECK (generator_identity = 'provider_visual_description'),
        generator_version TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('fake', 'hy3')),
        provider_model TEXT,
        configuration_fingerprint TEXT NOT NULL,
        context_mode TEXT NOT NULL CHECK (context_mode = 'image_only'),
        context_fingerprint TEXT CHECK (context_fingerprint IS NULL),
        transport_media_type TEXT NOT NULL CHECK (
          transport_media_type IN ('image/png', 'image/jpeg', 'image/webp')
        ),
        transport_width INTEGER NOT NULL CHECK (transport_width BETWEEN 1 AND 4096),
        transport_height INTEGER NOT NULL CHECK (transport_height BETWEEN 1 AND 4096),
        transport_byte_length INTEGER NOT NULL CHECK (
          transport_byte_length BETWEEN 1 AND ${4 * 1024 * 1024}
        ),
        transport_transformation TEXT NOT NULL CHECK (
          transport_transformation IN ('validated_original', 'auto_orient_resize_transcode')
        ),
        transport_preparation_version TEXT NOT NULL,
        transport_fingerprint TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1200),
        visual_type TEXT NOT NULL CHECK (
          visual_type IN ('photo', 'diagram', 'chart', 'screenshot', 'text_heavy', 'illustration', 'other')
        ),
        visible_text TEXT CHECK (visible_text IS NULL OR length(visible_text) BETWEEN 1 AND 2000),
        important_concepts TEXT NOT NULL,
        pedagogical_notes TEXT NOT NULL,
        uncertainty TEXT NOT NULL,
        reused_from_derivation_id TEXT REFERENCES visual_derivations(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_visual_derivations_asset
        ON visual_derivations(asset_id, created_at DESC, id DESC);
      CREATE INDEX idx_visual_derivations_revision
        ON visual_derivations(material_revision_id, created_at DESC, id DESC);
      CREATE INDEX idx_visual_derivations_semantic_identity
        ON visual_derivations(semantic_identity_fingerprint, created_at ASC, id ASC);
      CREATE TRIGGER guard_visual_derivation_source_binding
        BEFORE INSERT ON visual_derivations
        WHEN NOT EXISTS (
          SELECT 1
          FROM material_revision_assets a
          JOIN material_revisions mr ON mr.id = a.material_revision_id
          WHERE a.id = NEW.asset_id
            AND a.material_id = NEW.material_id
            AND a.material_revision_id = NEW.material_revision_id
            AND a.byte_hash = NEW.asset_byte_hash
            AND a.relationship_kind = 'image'
            AND a.content_origin = 'extracted_original'
            AND mr.material_id = NEW.material_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'visual derivation source binding mismatch');
      END;
      CREATE TRIGGER prevent_visual_derivation_update
        BEFORE UPDATE ON visual_derivations
      BEGIN
        SELECT RAISE(ABORT, 'visual derivations are immutable');
      END;
      CREATE TRIGGER prevent_direct_visual_derivation_delete
        BEFORE DELETE ON visual_derivations
        WHEN EXISTS (SELECT 1 FROM materials WHERE id = OLD.material_id)
          AND EXISTS (
            SELECT 1 FROM material_revisions WHERE id = OLD.material_revision_id
          )
          AND EXISTS (SELECT 1 FROM material_revision_assets WHERE id = OLD.asset_id)
      BEGIN
        SELECT RAISE(ABORT, 'visual derivations are immutable');
      END;
      CREATE UNIQUE INDEX idx_active_visual_preparation_identity
        ON agent_operations(workspace_id, operation_type, expected_fingerprint)
        WHERE operation_type = 'prepare_visual_description'
          AND status IN ('queued', 'running');
    `,
  },
  {
    version: 26,
    name: 'visual_provider_runtime_identity',
    rebuildsTables: true,
    up: `
      DROP TRIGGER prevent_direct_visual_derivation_delete;
      DROP TRIGGER prevent_visual_derivation_update;
      DROP TRIGGER guard_visual_derivation_source_binding;
      DROP INDEX idx_visual_derivations_asset;
      DROP INDEX idx_visual_derivations_revision;
      DROP INDEX idx_visual_derivations_semantic_identity;

      CREATE TABLE visual_derivations_rebuilt (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        material_revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES material_revision_assets(id) ON DELETE CASCADE,
        asset_byte_hash TEXT NOT NULL REFERENCES source_asset_blobs(byte_hash),
        identity_fingerprint TEXT NOT NULL UNIQUE,
        semantic_identity_fingerprint TEXT NOT NULL,
        derivation_kind TEXT NOT NULL CHECK (derivation_kind = 'visual_description'),
        content_origin TEXT NOT NULL CHECK (content_origin = 'derived_visual_description'),
        authority TEXT NOT NULL CHECK (authority = 'derived'),
        evidence_admissibility TEXT NOT NULL CHECK (evidence_admissibility = 'advisory_nonblocking'),
        validation_status TEXT NOT NULL CHECK (validation_status = 'accepted'),
        generator_identity TEXT NOT NULL CHECK (generator_identity = 'provider_visual_description'),
        generator_version TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('fake', 'hy3', 'tokenhub')),
        provider_model TEXT,
        provider_endpoint_identity TEXT NOT NULL,
        provider_runtime_identity TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL,
        context_mode TEXT NOT NULL CHECK (context_mode = 'image_only'),
        context_fingerprint TEXT CHECK (context_fingerprint IS NULL),
        transport_media_type TEXT NOT NULL CHECK (
          transport_media_type IN ('image/png', 'image/jpeg', 'image/webp')
        ),
        transport_width INTEGER NOT NULL CHECK (transport_width BETWEEN 1 AND 4096),
        transport_height INTEGER NOT NULL CHECK (transport_height BETWEEN 1 AND 4096),
        transport_byte_length INTEGER NOT NULL CHECK (
          transport_byte_length BETWEEN 1 AND ${4 * 1024 * 1024}
        ),
        transport_transformation TEXT NOT NULL CHECK (
          transport_transformation IN ('validated_original', 'auto_orient_resize_transcode')
        ),
        transport_preparation_version TEXT NOT NULL,
        transport_fingerprint TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1200),
        visual_type TEXT NOT NULL CHECK (
          visual_type IN ('photo', 'diagram', 'chart', 'screenshot', 'text_heavy', 'illustration', 'other')
        ),
        visible_text TEXT CHECK (visible_text IS NULL OR length(visible_text) BETWEEN 1 AND 2000),
        important_concepts TEXT NOT NULL,
        pedagogical_notes TEXT NOT NULL,
        uncertainty TEXT NOT NULL,
        reused_from_derivation_id TEXT REFERENCES visual_derivations_rebuilt(id),
        created_at TEXT NOT NULL
      );

      INSERT INTO visual_derivations_rebuilt (
        id, material_id, material_revision_id, asset_id, asset_byte_hash,
        identity_fingerprint, semantic_identity_fingerprint, derivation_kind,
        content_origin, authority, evidence_admissibility, validation_status,
        generator_identity, generator_version, provider, provider_model,
        provider_endpoint_identity, provider_runtime_identity,
        configuration_fingerprint, context_mode, context_fingerprint,
        transport_media_type, transport_width, transport_height, transport_byte_length,
        transport_transformation, transport_preparation_version, transport_fingerprint,
        description, visual_type, visible_text, important_concepts, pedagogical_notes,
        uncertainty, reused_from_derivation_id, created_at
      )
      SELECT
        id, material_id, material_revision_id, asset_id, asset_byte_hash,
        identity_fingerprint, semantic_identity_fingerprint, derivation_kind,
        content_origin, authority, evidence_admissibility, validation_status,
        generator_identity, generator_version, provider, provider_model,
        'historical:unrecorded', 'historical:unrecorded',
        configuration_fingerprint, context_mode, context_fingerprint,
        transport_media_type, transport_width, transport_height, transport_byte_length,
        transport_transformation, transport_preparation_version, transport_fingerprint,
        description, visual_type, visible_text, important_concepts, pedagogical_notes,
        uncertainty, reused_from_derivation_id, created_at
      FROM visual_derivations;

      DROP TABLE visual_derivations;
      ALTER TABLE visual_derivations_rebuilt RENAME TO visual_derivations;

      CREATE INDEX idx_visual_derivations_asset
        ON visual_derivations(asset_id, created_at DESC, id DESC);
      CREATE INDEX idx_visual_derivations_revision
        ON visual_derivations(material_revision_id, created_at DESC, id DESC);
      CREATE INDEX idx_visual_derivations_semantic_identity
        ON visual_derivations(semantic_identity_fingerprint, created_at ASC, id ASC);
      CREATE TRIGGER guard_visual_derivation_source_binding
        BEFORE INSERT ON visual_derivations
        WHEN NOT EXISTS (
          SELECT 1
          FROM material_revision_assets a
          JOIN material_revisions mr ON mr.id = a.material_revision_id
          WHERE a.id = NEW.asset_id
            AND a.material_id = NEW.material_id
            AND a.material_revision_id = NEW.material_revision_id
            AND a.byte_hash = NEW.asset_byte_hash
            AND a.relationship_kind = 'image'
            AND a.content_origin = 'extracted_original'
            AND mr.material_id = NEW.material_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'visual derivation source binding mismatch');
      END;
      CREATE TRIGGER prevent_visual_derivation_update
        BEFORE UPDATE ON visual_derivations
      BEGIN
        SELECT RAISE(ABORT, 'visual derivations are immutable');
      END;
      CREATE TRIGGER prevent_direct_visual_derivation_delete
        BEFORE DELETE ON visual_derivations
        WHEN EXISTS (SELECT 1 FROM materials WHERE id = OLD.material_id)
          AND EXISTS (
            SELECT 1 FROM material_revisions WHERE id = OLD.material_revision_id
          )
          AND EXISTS (SELECT 1 FROM material_revision_assets WHERE id = OLD.asset_id)
      BEGIN
        SELECT RAISE(ABORT, 'visual derivations are immutable');
      END;
    `,
  },
  {
    version: 27,
    name: 'html_web_snapshot_metadata',
    up: `
      ALTER TABLE material_revisions ADD COLUMN web_snapshot TEXT;
    `,
  },
  {
    version: 28,
    name: 'formal_assessment_evidence_backbone',
    up: `
      CREATE TABLE assessment_definitions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        logical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, logical_key)
      );
      CREATE TABLE assessment_versions (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL REFERENCES assessment_definitions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        predecessor_id TEXT REFERENCES assessment_versions(id),
        status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'superseded')),
        payload TEXT NOT NULL,
        source_revision_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE (definition_id, version)
      );
      CREATE INDEX idx_assessment_versions_definition ON assessment_versions(definition_id, version DESC);
      CREATE TABLE assessment_attempts (
        id TEXT PRIMARY KEY,
        assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        status TEXT NOT NULL CHECK (status IN ('started', 'submitted', 'cancelled')),
        responses TEXT NOT NULL,
        started_at TEXT NOT NULL,
        submitted_at TEXT,
        cancelled_at TEXT,
        UNIQUE (assessment_version_id, ordinal)
      );
      CREATE INDEX idx_assessment_attempts_workspace ON assessment_attempts(workspace_id, started_at DESC);
      CREATE TABLE assessment_grade_records (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id),
        assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id),
        grader TEXT NOT NULL CHECK (grader IN ('deterministic', 'fake', 'hy3')),
        rubric_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'superseded')),
        payload TEXT NOT NULL,
        supersedes_id TEXT REFERENCES assessment_grade_records(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_assessment_grades_attempt ON assessment_grade_records(attempt_id, created_at DESC);
      CREATE TABLE assessment_evidence_records (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id),
        grade_record_id TEXT NOT NULL REFERENCES assessment_grade_records(id),
        assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id),
        item_id TEXT NOT NULL,
        target_learning_unit_id TEXT NOT NULL,
        conclusion TEXT NOT NULL CHECK (conclusion IN ('supported', 'partial', 'unsupported')),
        policy_version TEXT NOT NULL,
        source_binding_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (grade_record_id, item_id)
      );
      CREATE INDEX idx_assessment_evidence_attempt ON assessment_evidence_records(attempt_id, created_at);
      CREATE TABLE assessment_progression_reconciliations (
        id TEXT PRIMARY KEY,
        evidence_record_id TEXT NOT NULL UNIQUE REFERENCES assessment_evidence_records(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
        applied_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER prevent_assessment_version_mutation
        BEFORE UPDATE OF payload, source_revision_ids, predecessor_id, version ON assessment_versions
      WHEN OLD.status IN ('accepted', 'superseded')
      BEGIN SELECT RAISE(ABORT, 'accepted assessment versions are immutable'); END;
      CREATE TRIGGER prevent_assessment_item_mutation
        BEFORE UPDATE ON assessment_versions
      WHEN OLD.status IN ('accepted', 'superseded') AND NEW.payload != OLD.payload
      BEGIN SELECT RAISE(ABORT, 'assessment items are immutable after acceptance'); END;
    `,
  },
  {
    version: 29,
    name: 'diagnostic_repair_orchestration',
    up: `
      CREATE TABLE repair_episodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        trigger_grade_record_id TEXT NOT NULL UNIQUE REFERENCES assessment_grade_records(id) ON DELETE CASCADE,
        trigger_attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
        assessment_version_id TEXT NOT NULL REFERENCES assessment_versions(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        target_learning_unit_id TEXT NOT NULL,
        diagnostic_category TEXT NOT NULL CHECK (diagnostic_category IN
          ('SURFACE_SLIP', 'INCOMPLETE_EXPRESSION', 'LOCAL_MISCONCEPTION',
           'RELATION_REVERSAL', 'PROCEDURAL_GAP', 'PREREQUISITE_GAP',
           'IRRELEVANT_OR_GUESSING', 'UNCERTAIN')),
        affected_criterion_ids TEXT NOT NULL,
        gap_summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('OPEN', 'ACTIVE', 'AWAITING_VERIFICATION', 'RESOLVED', 'DEFERRED', 'CANCELLED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
        verification_attempt_id TEXT REFERENCES assessment_attempts(id) ON DELETE CASCADE,
        resolved_evidence_id TEXT REFERENCES assessment_evidence_records(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_repair_episodes_workspace ON repair_episodes(workspace_id, created_at DESC);
      CREATE INDEX idx_repair_episodes_target ON repair_episodes(target_learning_unit_id, status);

      CREATE TABLE repair_packets (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES repair_episodes(id) ON DELETE CASCADE,
        generation_key TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('fake', 'hy3')),
        provider_model TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_repair_packets_episode ON repair_packets(episode_id, created_at);

      CREATE TABLE repair_practice_events (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES repair_episodes(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        response_summary TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN
          ('CONTINUE', 'READY_FOR_VERIFICATION', 'NEEDS_MORE_SUPPORT')),
        created_at TEXT NOT NULL,
        UNIQUE (episode_id, ordinal)
      );

      CREATE TABLE repair_status_events (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES repair_episodes(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_repair_status_events_episode ON repair_status_events(episode_id, created_at);

      CREATE TRIGGER prevent_repair_packet_update
        BEFORE UPDATE ON repair_packets
        BEGIN SELECT RAISE(ABORT, 'repair packets are immutable'); END;
      CREATE TRIGGER prevent_repair_status_event_update
        BEFORE UPDATE ON repair_status_events
        BEGIN SELECT RAISE(ABORT, 'repair status history is append-only'); END;
    `,
  },
  {
    version: 30,
    name: 'formal_assessment_progression_bridge',
    up: `
      ALTER TABLE assessment_versions ADD COLUMN progression_context TEXT;
      ALTER TABLE assessment_progression_reconciliations ADD COLUMN grading_result_id TEXT;
      ALTER TABLE assessment_progression_reconciliations ADD COLUMN failure_reason TEXT;
      CREATE INDEX idx_assessment_progression_reconciliation_grade
        ON assessment_progression_reconciliations(grading_result_id);
      CREATE TRIGGER prevent_assessment_progression_context_mutation
        BEFORE UPDATE OF progression_context ON assessment_versions
      WHEN OLD.status IN ('accepted', 'superseded') AND NEW.progression_context IS NOT OLD.progression_context
      BEGIN SELECT RAISE(ABORT, 'accepted assessment progression context is immutable'); END;
    `,
  },
  {
    version: 31,
    name: 'objective_review_scheduler_successor',
    up: `
      CREATE TABLE review_scheduler_configurations (
        version TEXT PRIMARY KEY, algorithm_generation TEXT NOT NULL CHECK (algorithm_generation = 'FSRS-6'),
        package_name TEXT NOT NULL CHECK (package_name = 'ts-fsrs'), package_version TEXT NOT NULL CHECK (package_version = '5.4.1'),
        local_adapter_version TEXT NOT NULL, rating_policy_version TEXT NOT NULL, requested_retention REAL NOT NULL CHECK (requested_retention = 0.9),
        config_hash TEXT NOT NULL, fuzz INTEGER NOT NULL CHECK (fuzz = 0), short_term INTEGER NOT NULL CHECK (short_term = 0), maximum_due_horizon_days INTEGER NOT NULL CHECK (maximum_due_horizon_days = 365),
        effective_at TEXT NOT NULL, retired_at TEXT
      );
      CREATE TABLE review_targets (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, course_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind = 'curriculum_objective'), origin_evidence_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending_initial_review','active','suspended','retired')),
        current_binding_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_review_targets_workspace_status ON review_targets(workspace_id, status);
      CREATE TABLE review_target_bindings (
        review_target_id TEXT NOT NULL REFERENCES review_targets(id) ON DELETE CASCADE, binding_version INTEGER NOT NULL,
        contract_version_id TEXT NOT NULL, curriculum_version_id TEXT NOT NULL, learning_unit_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        execution_source_manifest_fingerprint TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (review_target_id, binding_version)
      );
      CREATE INDEX idx_review_target_bindings_current ON review_target_bindings(review_target_id, binding_version DESC);
      CREATE TABLE memory_schedule_states (
        review_target_id TEXT NOT NULL REFERENCES review_targets(id) ON DELETE CASCADE, policy_version TEXT NOT NULL REFERENCES review_scheduler_configurations(version), lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('new','review')),
        due_at TEXT NOT NULL, last_reviewed_at TEXT, stability REAL NOT NULL, difficulty REAL NOT NULL, scheduled_days REAL NOT NULL, repetitions INTEGER NOT NULL, lapses INTEGER NOT NULL,
        last_review_event_id TEXT, row_version INTEGER NOT NULL CHECK (row_version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (review_target_id, policy_version), UNIQUE (review_target_id)
      );
      CREATE INDEX idx_memory_schedule_due ON memory_schedule_states(policy_version, due_at);
      CREATE TABLE successor_review_events (
        id TEXT PRIMARY KEY, review_target_id TEXT NOT NULL REFERENCES review_targets(id) ON DELETE CASCADE, binding_version INTEGER,
        policy_version TEXT NOT NULL REFERENCES review_scheduler_configurations(version), kind TEXT NOT NULL CHECK (kind IN ('activation','retrieval_failure','fresh_verification_success','migration')),
        source_outcome_id TEXT NOT NULL, review_execution_id TEXT, rating TEXT CHECK (rating IN ('Again','Good')), occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
        pre_state TEXT NOT NULL, post_state TEXT NOT NULL, exact_input_time TEXT, due_at TEXT, idempotency_key TEXT NOT NULL UNIQUE,
        UNIQUE (review_target_id, source_outcome_id, policy_version)
      );
      CREATE INDEX idx_successor_review_events_target ON successor_review_events(review_target_id, occurred_at, id);
      CREATE TABLE review_executions (
        id TEXT PRIMARY KEY, review_target_id TEXT NOT NULL REFERENCES review_targets(id) ON DELETE CASCADE, binding_version INTEGER NOT NULL,
        consumed_row_version INTEGER NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, course_id TEXT NOT NULL, agenda_id TEXT,
        assessment_version_id TEXT, attempt_id TEXT, status TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled')), failure_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_review_executions_active ON review_executions(review_target_id) WHERE status = 'active';
      CREATE INDEX idx_review_executions_workspace ON review_executions(workspace_id, status);
      CREATE TRIGGER prevent_successor_review_event_update BEFORE UPDATE ON successor_review_events BEGIN SELECT RAISE(ABORT, 'successor review events are immutable'); END;
      CREATE TRIGGER prevent_successor_review_event_delete BEFORE DELETE ON successor_review_events BEGIN SELECT RAISE(ABORT, 'successor review events are append-only'); END;
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
