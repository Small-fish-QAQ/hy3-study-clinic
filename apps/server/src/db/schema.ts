import type { SqliteDb } from './database.js';

export const SCHEMA_VERSION = 7;
export const APPLICATION_ID = 0x53435632;
export function initializeClinic(db: SqliteDb): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const application = db.pragma('application_id', { simple: true });
  if (tables.length && application !== APPLICATION_ID)
    throw new Error('该路径是旧版或其他数据库。请使用独立的 clinic-v2.sqlite；原数据库未转换。');
  let version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) throw new Error('数据库版本高于当前应用，无法安全打开。');
  if (application === APPLICATION_ID && version === SCHEMA_VERSION) return;
  if (application === APPLICATION_ID && version === 1) {
    db.transaction(() => {
      db.exec(
        `CREATE TABLE quiz_answer_drafts(quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,payload TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE quiz_exposures(quiz_id TEXT NOT NULL REFERENCES quizzes(id),item_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='hint'),occurred_at TEXT NOT NULL,PRIMARY KEY(quiz_id,item_id,kind));`,
      );
      db.pragma('user_version=2');
    })();
    version = 2;
  }
  if (application === APPLICATION_ID && version === 2) {
    db.transaction(() => {
      db.exec(
        'ALTER TABLE materials ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))',
      );
      db.pragma('user_version=3');
    })();
    version = 3;
  }
  const freezeSql = `CREATE TRIGGER immutable_ready_quiz BEFORE UPDATE OF payload ON quizzes WHEN OLD.status='ready' BEGIN SELECT RAISE(ABORT,'ready quiz is immutable'); END;CREATE TRIGGER immutable_completed_session BEFORE UPDATE ON study_sessions WHEN OLD.status='completed' BEGIN SELECT RAISE(ABORT,'completed classroom is immutable'); END;`;
  if (application === APPLICATION_ID && version === 3) {
    db.transaction(() => {
      db.exec(freezeSql);
      db.pragma('user_version=4');
    })();
    version = 4;
  }
  const reflectionsSql = `CREATE TABLE lesson_reflections(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,lesson_version_id TEXT NOT NULL REFERENCES course_lesson_versions(id),segment_id TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(lesson_version_id,segment_id));`;
  const candidatesSql = `CREATE TABLE course_plan_candidates(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,inventory_id TEXT NOT NULL REFERENCES course_knowledge_inventories(id),request_key TEXT NOT NULL,parent_id TEXT REFERENCES course_plan_candidates(id),candidate_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX plan_candidate_request ON course_plan_candidates(workspace_id,inventory_id,request_key,created_at);CREATE TRIGGER immutable_plan_candidate BEFORE UPDATE ON course_plan_candidates BEGIN SELECT RAISE(ABORT,'immutable candidate'); END;`;
  if (application === APPLICATION_ID && version === 4) {
    db.transaction(() => {
      db.exec(reflectionsSql);
      db.pragma('user_version=5');
    })();
    version = 5;
  }
  if (application === APPLICATION_ID && version === 5) {
    db.transaction(() => {
      db.exec(candidatesSql);
      db.pragma('user_version=6');
    })();
    version = 6;
  }
  if (application === APPLICATION_ID && version === 6) {
    // A validated correction is another immutable inventory, not an overwrite.
    // SQLite cannot drop an inline UNIQUE constraint; preserve all rows and FK identities.
    db.pragma('foreign_keys=OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE inventory_versions_new(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, source_scope_hash TEXT NOT NULL, policy_version TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
          INSERT INTO inventory_versions_new SELECT * FROM course_knowledge_inventories;
          DROP TABLE course_knowledge_inventories;
          ALTER TABLE inventory_versions_new RENAME TO course_knowledge_inventories;
          CREATE INDEX inventory_scope_versions ON course_knowledge_inventories(workspace_id,source_scope_hash,policy_version,created_at);
          CREATE TRIGGER immutable_course_knowledge_inventories BEFORE UPDATE ON course_knowledge_inventories BEGIN SELECT RAISE(ABORT,'immutable record'); END;
        `);
        if ((db.pragma('foreign_key_check') as unknown[]).length)
          throw new Error('知识版本迁移的引用校验失败。');
        db.pragma(`user_version=${SCHEMA_VERSION}`);
      })();
    } finally {
      db.pragma('foreign_keys=ON');
    }
    return;
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE workspaces(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE materials(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT NOT NULL, current_revision_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
      CREATE TABLE material_revisions(id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, content_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE source_blocks(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES material_revisions(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, position INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(revision_id,position));
      CREATE TABLE course_knowledge_inventories(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, source_scope_hash TEXT NOT NULL, policy_version TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX inventory_scope_versions ON course_knowledge_inventories(workspace_id,source_scope_hash,policy_version,created_at);
      CREATE TABLE curriculum_versions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, knowledge_inventory_id TEXT NOT NULL REFERENCES course_knowledge_inventories(id), version INTEGER NOT NULL CHECK(version>0), status TEXT NOT NULL CHECK(status IN ('draft','accepted','superseded')), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE course_lesson_versions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id), lesson_id TEXT NOT NULL, semantic_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), source_scope_hash TEXT NOT NULL, policy_version TEXT NOT NULL, origin_logical_call_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,semantic_key,version));
      CREATE TABLE study_sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id), lesson_version_id TEXT NOT NULL REFERENCES course_lesson_versions(id), purpose TEXT NOT NULL CHECK(purpose IN ('learning','revisit')), origin_session_id TEXT REFERENCES study_sessions(id), status TEXT NOT NULL CHECK(status IN ('active','paused','completed')), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE study_turns(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES study_sessions(id), sequence INTEGER NOT NULL, question TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id,sequence));
      CREATE TABLE lesson_execution_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id), lesson_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES study_sessions(id), kind TEXT NOT NULL CHECK(kind='complete_lesson'), payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(curriculum_id,lesson_id,kind));
      CREATE TABLE quizzes(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, curriculum_id TEXT NOT NULL REFERENCES curriculum_versions(id), purpose TEXT NOT NULL CHECK(purpose IN ('practice','retest','explicit_review','formal')), request_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','ready')), payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,purpose,request_id));
      CREATE TABLE submissions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, quiz_id TEXT NOT NULL UNIQUE REFERENCES quizzes(id), status TEXT NOT NULL CHECK(status IN ('submitted','pending','graded')), answers_hash TEXT NOT NULL, responses TEXT NOT NULL, submitted_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE quiz_answer_drafts(quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE quiz_exposures(quiz_id TEXT NOT NULL REFERENCES quizzes(id),item_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='hint'),occurred_at TEXT NOT NULL,PRIMARY KEY(quiz_id,item_id,kind));
      CREATE TABLE assessment_versions(id TEXT PRIMARY KEY REFERENCES quizzes(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, blueprint_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE assessment_attempts(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, assessment_version_id TEXT NOT NULL UNIQUE REFERENCES assessment_versions(id), submission_id TEXT UNIQUE REFERENCES submissions(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE agent_operations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, scope_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_payload TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('preparePlan','prepareLesson','preparePractice','prepareRepair','prepareFormal','gradeAssessment')), status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')), version INTEGER NOT NULL CHECK(version>0), fence INTEGER NOT NULL CHECK(fence>0), owner TEXT, lease_until TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX active_operation_scope ON agent_operations(workspace_id,scope_key) WHERE status IN ('queued','running');
      CREATE TABLE assessment_item_grades(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id), item_id TEXT NOT NULL, answer_hash TEXT NOT NULL, question_hash TEXT NOT NULL, rubric_hash TEXT NOT NULL, grading_policy TEXT NOT NULL, issuer TEXT NOT NULL CHECK(issuer='server'), logical_call_ids TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES agent_operations(id), payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(attempt_id,item_id,answer_hash,grading_policy));
      CREATE TABLE assessment_grade_records(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, attempt_id TEXT NOT NULL UNIQUE REFERENCES assessment_attempts(id), issuer_policy TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES agent_operations(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE evidence(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, grade_id TEXT NOT NULL REFERENCES assessment_grade_records(id), knowledge_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(grade_id,knowledge_id));
      CREATE TABLE repair_rounds(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, origin_kind TEXT NOT NULL CHECK(origin_kind IN ('submission','grade')), origin_submission_id TEXT REFERENCES submissions(id), origin_grade_id TEXT REFERENCES assessment_grade_records(id), target_scope TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>0), status TEXT NOT NULL CHECK(status IN ('preparing','ready','submitted','completed','failed','cancelled')), learner_outcome TEXT CHECK(learner_outcome IN ('passed','not_yet')), retest_quiz_id TEXT REFERENCES quizzes(id), retest_submission_id TEXT UNIQUE REFERENCES submissions(id), operation_id TEXT NOT NULL REFERENCES agent_operations(id), version INTEGER NOT NULL CHECK(version>0), payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK((origin_kind='submission' AND origin_submission_id IS NOT NULL AND origin_grade_id IS NULL) OR (origin_kind='grade' AND origin_grade_id IS NOT NULL AND origin_submission_id IS NULL)));
      CREATE UNIQUE INDEX repair_submission_ordinal ON repair_rounds(origin_submission_id,ordinal) WHERE origin_submission_id IS NOT NULL;
      CREATE UNIQUE INDEX repair_grade_ordinal ON repair_rounds(origin_grade_id,ordinal) WHERE origin_grade_id IS NOT NULL;
      CREATE UNIQUE INDEX active_repair_submission ON repair_rounds(origin_submission_id) WHERE status IN ('preparing','ready','submitted');
      CREATE UNIQUE INDEX active_repair_grade ON repair_rounds(origin_grade_id) WHERE status IN ('preparing','ready','submitted');
      CREATE TABLE course_commands(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,idempotency_key));
      CREATE TABLE semantic_cache(generation_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind='retained_candidate_v2'), candidate_hash TEXT NOT NULL, physical_attempt_id TEXT NOT NULL, source_scope_hash TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness='complete'), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE llm_calls(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, operation_id TEXT REFERENCES agent_operations(id), generation_key TEXT NOT NULL, method TEXT NOT NULL, provider_snapshot TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','outcome_unknown')), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE llm_physical_attempts(id TEXT PRIMARY KEY, logical_call_id TEXT NOT NULL REFERENCES llm_calls(id), status TEXT NOT NULL CHECK(status IN ('prepared','sent','completed','failed','outcome_unknown')), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE review_scheduler_configurations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE review_targets(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, target_kind TEXT NOT NULL CHECK(target_kind='course_knowledge'), knowledge_id TEXT NOT NULL, source_scope_hash TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(workspace_id,knowledge_id,source_scope_hash));
      CREATE TABLE review_target_bindings(target_id TEXT PRIMARY KEY REFERENCES review_targets(id) ON DELETE CASCADE, knowledge_id TEXT NOT NULL, source_scope_hash TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), payload TEXT NOT NULL);
      CREATE TABLE successor_review_events(id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES review_targets(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('graded_retrieval','diagnostic_observation')), source_kind TEXT NOT NULL CHECK(source_kind IN ('practice','retest','explicit_review','formal')), source_record_id TEXT NOT NULL REFERENCES submissions(id), source_outcome_id TEXT NOT NULL, rating TEXT CHECK(rating IN ('Again','Good')), occurred_at TEXT NOT NULL, policy_version TEXT NOT NULL, configuration_id TEXT NOT NULL REFERENCES review_scheduler_configurations(id), payload TEXT NOT NULL, UNIQUE(target_id,seq), UNIQUE(target_id,source_outcome_id,policy_version), CHECK((kind='diagnostic_observation' AND rating IS NULL) OR (kind='graded_retrieval' AND rating IS NOT NULL)));
      CREATE TABLE memory_schedule_states(target_id TEXT PRIMARY KEY REFERENCES review_targets(id) ON DELETE CASCADE, row_version INTEGER NOT NULL CHECK(row_version>0), payload TEXT NOT NULL);
      CREATE INDEX source_workspace ON source_blocks(workspace_id,revision_id,position);
      CREATE INDEX operation_workspace ON agent_operations(workspace_id,created_at);
      CREATE INDEX event_time ON successor_review_events(target_id,occurred_at,source_record_id);
      CREATE TRIGGER immutable_curriculum BEFORE UPDATE OF payload ON curriculum_versions WHEN OLD.status IN ('accepted','superseded') AND NEW.payload<>OLD.payload BEGIN SELECT RAISE(ABORT,'accepted curriculum is immutable'); END;
      CREATE TRIGGER immutable_responses BEFORE UPDATE OF responses,answers_hash,submitted_at ON submissions BEGIN SELECT RAISE(ABORT,'responses are immutable'); END;
      CREATE TRIGGER immutable_grade_result BEFORE UPDATE OF payload ON submissions WHEN OLD.status='graded' BEGIN SELECT RAISE(ABORT,'grade is immutable'); END;
      CREATE TRIGGER immutable_repair_outcome BEFORE UPDATE ON repair_rounds WHEN OLD.status IN ('completed','cancelled') BEGIN SELECT RAISE(ABORT,'ended repair round is immutable'); END;
    `);
    db.exec(freezeSql);
    db.exec(reflectionsSql);
    db.exec(candidatesSql);
    for (const table of [
      'material_revisions',
      'source_blocks',
      'course_knowledge_inventories',
      'course_lesson_versions',
      'study_turns',
      'lesson_execution_events',
      'assessment_item_grades',
      'assessment_grade_records',
      'evidence',
      'successor_review_events',
      'assessment_versions',
    ]) {
      db.exec(
        `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable record'); END;`,
      );
    }
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
