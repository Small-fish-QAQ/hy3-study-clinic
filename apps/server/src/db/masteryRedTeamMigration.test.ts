import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { migrate } from './migrate.js';

describe('Mastery Red Team shadow migration', () => {
  it('creates immutable snapshot/candidate/evaluation ledgers and formal authority default', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(
      db.prepare('SELECT authority_mode FROM assessment_versions LIMIT 1').get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mastery_red_team_snapshots'",
        )
        .get(),
    ).toEqual({ name: 'mastery_red_team_snapshots' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mastery_red_team_candidates'",
        )
        .get(),
    ).toEqual({ name: 'mastery_red_team_candidates' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mastery_red_team_evaluations'",
        )
        .get(),
    ).toEqual({ name: 'mastery_red_team_evaluations' });
    db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'ws_rt',
      'RT',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO review_targets (id, workspace_id, course_id, target_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'target_rt',
      'ws_rt',
      'course_rt',
      'curriculum_objective',
      'active',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_snapshots (id, workspace_id, course_id, review_target_id, follow_up_depth, snapshot_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'snapshot_rt',
      'ws_rt',
      'course_rt',
      'target_rt',
      0,
      'hash_rt',
      '{}',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_runs (id, workspace_id, snapshot_id, idempotency_key, follow_up_depth, selected_family, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'run_rt',
      'ws_rt',
      'snapshot_rt',
      'key_rt',
      0,
      'transfer',
      'generating',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_candidates (id, run_id, ordinal, provider_candidate_key, selected, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('candidate_rt', 'run_rt', 0, 'candidate_rt', 0, '{}', '2026-01-01T00:00:00.000Z');
    expect(() =>
      db
        .prepare('UPDATE mastery_red_team_snapshots SET payload = ? WHERE id = ?')
        .run('{"changed":true}', 'snapshot_rt'),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare('DELETE FROM mastery_red_team_candidates WHERE id = ?').run('candidate_rt'),
    ).toThrow(/immutable/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_red_team_candidates').get()).toEqual({
      n: 1,
    });
    expect(() => db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws_rt')).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_red_team_snapshots').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_red_team_runs').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mastery_red_team_candidates').get()).toEqual({
      n: 0,
    });

    db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'ws_eval',
      'Evaluation audit',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO assessment_definitions (id, workspace_id, logical_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'definition_eval',
      'ws_eval',
      'evaluation-audit',
      'Evaluation audit',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO assessment_versions (id, definition_id, version, status, payload, source_revision_ids, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'version_eval',
      'definition_eval',
      1,
      'accepted',
      '{}',
      '[]',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    expect(
      db.prepare('SELECT authority_mode FROM assessment_versions WHERE id = ?').get('version_eval'),
    ).toEqual({ authority_mode: 'formal' });
    expect(() =>
      db
        .prepare('UPDATE assessment_versions SET authority_mode = ? WHERE id = ?')
        .run('mastery_red_team_shadow', 'version_eval'),
    ).toThrow(/immutable/);
    db.prepare(
      'INSERT INTO assessment_attempts (id, assessment_version_id, workspace_id, ordinal, status, responses, started_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'attempt_eval',
      'version_eval',
      'ws_eval',
      1,
      'submitted',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO assessment_grade_records (id, attempt_id, assessment_version_id, grader, rubric_version, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'grade_eval',
      'attempt_eval',
      'version_eval',
      'fake',
      'formal-grade-v1-shadow',
      'current',
      '{}',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO review_targets (id, workspace_id, course_id, target_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'target_eval',
      'ws_eval',
      'course_eval',
      'curriculum_objective',
      'active',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_snapshots (id, workspace_id, course_id, review_target_id, follow_up_depth, snapshot_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'snapshot_eval',
      'ws_eval',
      'course_eval',
      'target_eval',
      0,
      'hash_eval',
      '{}',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_runs (id, workspace_id, snapshot_id, idempotency_key, follow_up_depth, selected_family, status, assessment_version_id, submission_key, submission_answer_hash, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'run_eval',
      'ws_eval',
      'snapshot_eval',
      'key_eval',
      0,
      'transfer',
      'evaluated',
      'version_eval',
      'submission_eval',
      'answer_hash_eval',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO mastery_red_team_evaluations (id, run_id, attempt_id, grade_record_id, outcome, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'evaluation_eval',
      'run_eval',
      'attempt_eval',
      'grade_eval',
      'robust_signal',
      '{}',
      '2026-01-01T00:00:00.000Z',
    );
    expect(() =>
      db
        .prepare('UPDATE mastery_red_team_evaluations SET payload = ? WHERE id = ?')
        .run('{"changed":true}', 'evaluation_eval'),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare('DELETE FROM mastery_red_team_evaluations WHERE id = ?').run('evaluation_eval'),
    ).toThrow(/append-only/);
    db.close();
  });
});
