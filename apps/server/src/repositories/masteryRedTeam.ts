import {
  MasteryRedTeamCandidateRecordSchema,
  MasteryRedTeamEvaluationSchema,
  MasteryRedTeamRunSchema,
  MasterySnapshotSchema,
  type MasteryChallengeFamily,
  type MasteryRedTeamCandidateRecord,
  type MasteryRedTeamEvaluation,
  type MasteryRedTeamRun,
  type MasterySnapshot,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PayloadRow {
  payload: string;
}

const parse = <T>(row: PayloadRow | undefined, schema: { parse(value: unknown): T }) =>
  row ? schema.parse(JSON.parse(row.payload)) : undefined;

export function createMasteryRedTeamRepo(db: SqliteDb) {
  const snapshot = (id: string) =>
    parse(
      db.prepare('SELECT payload FROM mastery_red_team_snapshots WHERE id = ?').get(id) as
        PayloadRow | undefined,
      MasterySnapshotSchema,
    );
  const run = (id: string) =>
    parse(
      db.prepare('SELECT payload FROM mastery_red_team_runs WHERE id = ?').get(id) as
        PayloadRow | undefined,
      MasteryRedTeamRunSchema,
    );
  const evaluation = (id: string) =>
    parse(
      db.prepare('SELECT payload FROM mastery_red_team_evaluations WHERE id = ?').get(id) as
        PayloadRow | undefined,
      MasteryRedTeamEvaluationSchema,
    );

  return {
    insertSnapshot(input: MasterySnapshot): MasterySnapshot {
      const item = MasterySnapshotSchema.parse(input);
      db.prepare(
        `INSERT INTO mastery_red_team_snapshots
           (id, workspace_id, course_id, review_target_id, parent_run_id,
            follow_up_depth, snapshot_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceId,
        item.courseId,
        item.reviewTargetId,
        item.parentRunId,
        item.followUpDepth,
        item.snapshotHash,
        JSON.stringify(item),
        item.createdAt,
      );
      return item;
    },
    getSnapshot: snapshot,
    insertRun(input: MasteryRedTeamRun): MasteryRedTeamRun {
      const item = MasteryRedTeamRunSchema.parse(input);
      db.prepare(
        `INSERT INTO mastery_red_team_runs
           (id, workspace_id, snapshot_id, idempotency_key, parent_run_id, follow_up_depth,
            selected_family, status, selected_candidate_id, assessment_version_id,
            submission_key, submission_answer_hash, failure_code, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceId,
        item.snapshotId,
        item.idempotencyKey,
        item.parentRunId,
        item.followUpDepth,
        item.selectedFamily,
        item.status,
        item.selectedCandidateId,
        item.assessmentVersionId,
        item.submissionKey,
        item.submissionAnswerHash,
        item.failureCode,
        JSON.stringify(item),
        item.createdAt,
        item.updatedAt,
      );
      return item;
    },
    getRun: run,
    findRunByIdempotencyKey(workspaceId: string, idempotencyKey: string) {
      const row = db
        .prepare(
          `SELECT payload FROM mastery_red_team_runs
           WHERE workspace_id = ? AND idempotency_key = ?`,
        )
        .get(workspaceId, idempotencyKey) as PayloadRow | undefined;
      return parse(row, MasteryRedTeamRunSchema);
    },
    updateRun(input: MasteryRedTeamRun): MasteryRedTeamRun {
      const item = MasteryRedTeamRunSchema.parse(input);
      const changed = db
        .prepare(
          `UPDATE mastery_red_team_runs
           SET status = ?, selected_candidate_id = ?, assessment_version_id = ?,
               submission_key = ?, submission_answer_hash = ?, failure_code = ?, payload = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          item.status,
          item.selectedCandidateId,
          item.assessmentVersionId,
          item.submissionKey,
          item.submissionAnswerHash,
          item.failureCode,
          JSON.stringify(item),
          item.updatedAt,
          item.id,
        ).changes;
      if (changed !== 1) throw new Error('Mastery Red Team run does not exist.');
      return run(item.id)!;
    },
    listRunsForTarget(reviewTargetId: string): MasteryRedTeamRun[] {
      return (
        db
          .prepare(
            `SELECT r.payload FROM mastery_red_team_runs r
             JOIN mastery_red_team_snapshots s ON s.id = r.snapshot_id
             WHERE s.review_target_id = ? ORDER BY r.created_at, r.id`,
          )
          .all(reviewTargetId) as PayloadRow[]
      ).map((row) => MasteryRedTeamRunSchema.parse(JSON.parse(row.payload)));
    },
    familyExposure(reviewTargetId: string): Partial<Record<MasteryChallengeFamily, number>> {
      const rows = db
        .prepare(
          `SELECT r.selected_family AS family, COUNT(*) AS count
           FROM mastery_red_team_runs r
           JOIN mastery_red_team_snapshots s ON s.id = r.snapshot_id
           WHERE s.review_target_id = ? AND r.selected_candidate_id IS NOT NULL
           GROUP BY r.selected_family`,
        )
        .all(reviewTargetId) as Array<{ family: MasteryChallengeFamily; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.family, row.count]));
    },
    insertCandidates(inputs: MasteryRedTeamCandidateRecord[]): MasteryRedTeamCandidateRecord[] {
      const items = inputs.map((input) => MasteryRedTeamCandidateRecordSchema.parse(input));
      const statement = db.prepare(
        `INSERT INTO mastery_red_team_candidates
           (id, run_id, ordinal, provider_candidate_key, selected, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (const item of items) {
          statement.run(
            item.id,
            item.runId,
            item.ordinal,
            item.providerCandidateKey,
            item.selected ? 1 : 0,
            JSON.stringify(item),
            item.createdAt,
          );
        }
      })();
      return items;
    },
    listCandidates(runId: string): MasteryRedTeamCandidateRecord[] {
      return (
        db
          .prepare(
            'SELECT payload FROM mastery_red_team_candidates WHERE run_id = ? ORDER BY ordinal',
          )
          .all(runId) as PayloadRow[]
      ).map((row) => MasteryRedTeamCandidateRecordSchema.parse(JSON.parse(row.payload)));
    },
    selectedPromptsForTarget(reviewTargetId: string): Array<{ id: string; prompt: string }> {
      return (
        db
          .prepare(
            `SELECT c.payload FROM mastery_red_team_candidates c
             JOIN mastery_red_team_runs r ON r.id = c.run_id
             JOIN mastery_red_team_snapshots s ON s.id = r.snapshot_id
             WHERE s.review_target_id = ? AND c.selected = 1
             ORDER BY c.created_at DESC, c.id DESC`,
          )
          .all(reviewTargetId) as PayloadRow[]
      ).map((row) => {
        const item = MasteryRedTeamCandidateRecordSchema.parse(JSON.parse(row.payload));
        return { id: item.id, prompt: item.candidate.prompt };
      });
    },
    completeEvaluation(
      runInput: MasteryRedTeamRun,
      evaluationInput: MasteryRedTeamEvaluation,
    ): MasteryRedTeamEvaluation {
      const completedRun = MasteryRedTeamRunSchema.parse(runInput);
      const item = MasteryRedTeamEvaluationSchema.parse(evaluationInput);
      if (
        completedRun.status !== 'evaluated' ||
        item.runId !== completedRun.id ||
        completedRun.submissionKey === null
      ) {
        throw new Error('Mastery Red Team evaluation completion is inconsistent.');
      }
      return db.transaction(() => {
        const existing = db
          .prepare('SELECT id FROM mastery_red_team_evaluations WHERE run_id = ?')
          .get(item.runId) as { id: string } | undefined;
        if (existing) return evaluation(existing.id)!;
        const current = run(completedRun.id);
        if (!current || current.status !== 'evaluating') {
          throw new Error('Mastery Red Team run is not awaiting evaluation completion.');
        }
        db.prepare(
          `INSERT INTO mastery_red_team_evaluations
             (id, run_id, attempt_id, grade_record_id, outcome, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          item.id,
          item.runId,
          item.attemptId,
          item.gradeRecordId,
          item.outcome,
          JSON.stringify(item),
          item.createdAt,
        );
        db.prepare(
          `UPDATE mastery_red_team_runs
           SET status = ?, selected_candidate_id = ?, assessment_version_id = ?,
               submission_key = ?, submission_answer_hash = ?, failure_code = ?, payload = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          completedRun.status,
          completedRun.selectedCandidateId,
          completedRun.assessmentVersionId,
          completedRun.submissionKey,
          completedRun.submissionAnswerHash,
          completedRun.failureCode,
          JSON.stringify(completedRun),
          completedRun.updatedAt,
          completedRun.id,
        );
        return item;
      })();
    },
    getEvaluation: evaluation,
    getEvaluationForRun(runId: string) {
      const row = db
        .prepare('SELECT id FROM mastery_red_team_evaluations WHERE run_id = ?')
        .get(runId) as { id: string } | undefined;
      return row ? evaluation(row.id) : undefined;
    },
    listProjectionRecords(workspaceId: string) {
      const rows = db
        .prepare(
          `SELECT e.payload AS evaluation_payload, r.payload AS run_payload,
                  s.payload AS snapshot_payload
           FROM mastery_red_team_evaluations e
           JOIN mastery_red_team_runs r ON r.id = e.run_id
           JOIN mastery_red_team_snapshots s ON s.id = r.snapshot_id
           WHERE r.workspace_id = ? ORDER BY e.created_at, e.id`,
        )
        .all(workspaceId) as Array<{
        evaluation_payload: string;
        run_payload: string;
        snapshot_payload: string;
      }>;
      return rows.map((row) => ({
        evaluation: MasteryRedTeamEvaluationSchema.parse(JSON.parse(row.evaluation_payload)),
        run: MasteryRedTeamRunSchema.parse(JSON.parse(row.run_payload)),
        snapshot: MasterySnapshotSchema.parse(JSON.parse(row.snapshot_payload)),
      }));
    },
  };
}

export type MasteryRedTeamRepo = ReturnType<typeof createMasteryRedTeamRepo>;
