import {
  AssessmentAttemptSchema,
  AssessmentDefinitionSchema,
  AssessmentVersionSchema,
  EvidenceRecordSchema,
  GradeRecordSchema,
  ProgressionReconciliationRecordSchema,
  type AssessmentAttempt,
  type AssessmentDefinition,
  type AssessmentVersion,
  type EvidenceRecord,
  type GradeRecord,
  type ProgressionReconciliationRecord,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PayloadRow {
  payload: string;
}
const parse = <T>(row: PayloadRow | undefined, schema: { parse: (v: unknown) => T }) =>
  row ? schema.parse(JSON.parse(row.payload)) : undefined;

export function createFormalAssessmentsRepo(db: SqliteDb) {
  const definition = (id: string) =>
    parse(
      db
        .prepare(
          "SELECT json_object('id', id, 'workspaceId', workspace_id, 'logicalKey', logical_key, 'title', title, 'createdAt', created_at, 'updatedAt', updated_at) AS payload FROM assessment_definitions WHERE id = ?",
        )
        .get(id) as PayloadRow | undefined,
      AssessmentDefinitionSchema,
    );
  const version = (id: string) =>
    parse(
      db.prepare('SELECT payload FROM assessment_versions WHERE id = ?').get(id) as
        PayloadRow | undefined,
      AssessmentVersionSchema,
    );
  const attempt = (id: string) =>
    parse(
      db
        .prepare(
          "SELECT json_object('id', id, 'assessmentVersionId', assessment_version_id, 'workspaceId', workspace_id, 'ordinal', ordinal, 'status', status, 'responses', responses, 'startedAt', started_at, 'submittedAt', submitted_at, 'cancelledAt', cancelled_at) AS payload FROM assessment_attempts WHERE id = ?",
        )
        .get(id) as PayloadRow | undefined,
      {
        parse: (v: unknown) => {
          const x = v as Record<string, unknown>;
          return AssessmentAttemptSchema.parse({
            ...x,
            responses: JSON.parse(String(x.responses)),
          });
        },
      },
    );
  const grade = (id: string) =>
    parse(
      db.prepare('SELECT payload FROM assessment_grade_records WHERE id = ?').get(id) as
        PayloadRow | undefined,
      GradeRecordSchema,
    );
  const evidence = (id: string) => {
    const row = db.prepare('SELECT * FROM assessment_evidence_records WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row
      ? EvidenceRecordSchema.parse({
          id: row.id,
          attemptId: row.attempt_id,
          gradeRecordId: row.grade_record_id,
          assessmentVersionId: row.assessment_version_id,
          itemId: row.item_id,
          targetLearningUnitId: row.target_learning_unit_id,
          conclusion: row.conclusion,
          policyVersion: row.policy_version,
          sourceBindingIds: JSON.parse(String(row.source_binding_ids)),
          createdAt: row.created_at,
        })
      : undefined;
  };
  const reconciliation = (id: string) =>
    parse(
      db
        .prepare(
          "SELECT json_object('id', id, 'evidenceRecordId', evidence_record_id, 'status', status, 'appliedAt', applied_at, 'createdAt', created_at) AS payload FROM assessment_progression_reconciliations WHERE id = ?",
        )
        .get(id) as PayloadRow | undefined,
      ProgressionReconciliationRecordSchema,
    );

  return {
    insertDefinition(input: AssessmentDefinition) {
      const item = AssessmentDefinitionSchema.parse(input);
      db.prepare(
        'INSERT INTO assessment_definitions (id, workspace_id, logical_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(item.id, item.workspaceId, item.logicalKey, item.title, item.createdAt, item.updatedAt);
      return item;
    },
    getDefinition: definition,
    insertVersion(input: AssessmentVersion) {
      const item = AssessmentVersionSchema.parse(input);
      db.prepare(
        'INSERT INTO assessment_versions (id, definition_id, version, predecessor_id, status, payload, source_revision_ids, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.id,
        item.definitionId,
        item.version,
        item.predecessorId,
        item.status,
        JSON.stringify(item),
        JSON.stringify(item.sourceRevisionIds),
        item.createdAt,
        item.acceptedAt,
      );
      return item;
    },
    getVersion: version,
    listVersions(definitionId: string) {
      return (
        db
          .prepare(
            'SELECT payload FROM assessment_versions WHERE definition_id = ? ORDER BY version',
          )
          .all(definitionId) as PayloadRow[]
      ).map((row) => AssessmentVersionSchema.parse(JSON.parse(row.payload)));
    },
    acceptVersion(id: string, acceptedAt: string) {
      const current = version(id);
      if (!current) throw new Error('Assessment version does not exist.');
      if (current.status === 'accepted' || current.status === 'superseded') return current;
      const next = { ...current, status: 'accepted' as const, acceptedAt };
      db.prepare(
        "UPDATE assessment_versions SET status = ?, accepted_at = ?, payload = ? WHERE id = ? AND status = 'draft'",
      ).run(next.status, acceptedAt, JSON.stringify(next), id);
      return version(id)!;
    },
    insertAttempt(input: AssessmentAttempt) {
      const item = AssessmentAttemptSchema.parse(input);
      db.prepare(
        'INSERT INTO assessment_attempts (id, assessment_version_id, workspace_id, ordinal, status, responses, started_at, submitted_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.id,
        item.assessmentVersionId,
        item.workspaceId,
        item.ordinal,
        item.status,
        JSON.stringify(item.responses),
        item.startedAt,
        item.submittedAt,
        item.cancelledAt,
      );
      return item;
    },
    getAttempt: attempt,
    nextAttemptOrdinal(assessmentVersionId: string) {
      return (
        ((
          db
            .prepare(
              'SELECT COALESCE(MAX(ordinal), 0) AS n FROM assessment_attempts WHERE assessment_version_id = ?',
            )
            .get(assessmentVersionId) as { n: number }
        ).n ?? 0) + 1
      );
    },
    submitAttempt(id: string, responses: Record<string, string>, submittedAt: string) {
      const current = attempt(id);
      if (!current) throw new Error('Assessment attempt does not exist.');
      if (current.status === 'submitted') return current;
      if (current.status === 'cancelled')
        throw new Error('Cancelled assessment attempt cannot be submitted.');
      const next = { ...current, status: 'submitted' as const, responses, submittedAt };
      db.prepare(
        "UPDATE assessment_attempts SET status = ?, responses = ?, submitted_at = ? WHERE id = ? AND status = 'started'",
      ).run(next.status, JSON.stringify(responses), submittedAt, id);
      return attempt(id)!;
    },
    cancelAttempt(id: string, cancelledAt: string) {
      const current = attempt(id);
      if (!current || current.status !== 'started') return current;
      db.prepare(
        "UPDATE assessment_attempts SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'started'",
      ).run(cancelledAt, id);
      return attempt(id)!;
    },
    insertGrade(input: GradeRecord) {
      const item = GradeRecordSchema.parse(input);
      db.transaction(() => {
        if (item.supersedesId) {
          const prior = grade(item.supersedesId);
          if (prior) {
            db.prepare(
              "UPDATE assessment_grade_records SET status = 'superseded', payload = ? WHERE id = ?",
            ).run(JSON.stringify({ ...prior, status: 'superseded' }), item.supersedesId);
          }
        }
        db.prepare(
          'INSERT INTO assessment_grade_records (id, attempt_id, assessment_version_id, grader, rubric_version, status, payload, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          item.id,
          item.attemptId,
          item.assessmentVersionId,
          item.grader,
          item.rubricVersion,
          item.status,
          JSON.stringify(item),
          item.supersedesId,
          item.createdAt,
        );
      })();
      return item;
    },
    getGrade: grade,
    listGrades(attemptId: string) {
      return (
        db
          .prepare(
            'SELECT payload FROM assessment_grade_records WHERE attempt_id = ? ORDER BY created_at',
          )
          .all(attemptId) as PayloadRow[]
      ).map((row) => GradeRecordSchema.parse(JSON.parse(row.payload)));
    },
    insertEvidence(input: EvidenceRecord) {
      const item = EvidenceRecordSchema.parse(input);
      db.prepare(
        'INSERT INTO assessment_evidence_records (id, attempt_id, grade_record_id, assessment_version_id, item_id, target_learning_unit_id, conclusion, policy_version, source_binding_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.id,
        item.attemptId,
        item.gradeRecordId,
        item.assessmentVersionId,
        item.itemId,
        item.targetLearningUnitId,
        item.conclusion,
        item.policyVersion,
        JSON.stringify(item.sourceBindingIds),
        item.createdAt,
      );
      return item;
    },
    getEvidence: evidence,
    listEvidenceForGrade(gradeRecordId: string) {
      return (
        db
          .prepare(
            'SELECT * FROM assessment_evidence_records WHERE grade_record_id = ? ORDER BY item_id',
          )
          .all(gradeRecordId) as Array<Record<string, unknown>>
      ).map((row) =>
        EvidenceRecordSchema.parse({
          id: row.id,
          attemptId: row.attempt_id,
          gradeRecordId: row.grade_record_id,
          assessmentVersionId: row.assessment_version_id,
          itemId: row.item_id,
          targetLearningUnitId: row.target_learning_unit_id,
          conclusion: row.conclusion,
          policyVersion: row.policy_version,
          sourceBindingIds: JSON.parse(String(row.source_binding_ids)),
          createdAt: row.created_at,
        }),
      );
    },
    insertReconciliation(input: ProgressionReconciliationRecord) {
      const item = ProgressionReconciliationRecordSchema.parse(input);
      const existing = db
        .prepare(
          'SELECT id FROM assessment_progression_reconciliations WHERE evidence_record_id = ?',
        )
        .get(item.evidenceRecordId) as { id: string } | undefined;
      if (existing) return reconciliation(existing.id)!;
      db.prepare(
        'INSERT INTO assessment_progression_reconciliations (id, evidence_record_id, status, applied_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(item.id, item.evidenceRecordId, item.status, item.appliedAt, item.createdAt);
      return item;
    },
    getReconciliation: reconciliation,
    markReconciled(id: string, appliedAt: string) {
      db.prepare(
        "UPDATE assessment_progression_reconciliations SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'",
      ).run(appliedAt, id);
      return reconciliation(id)!;
    },
  };
}

export type FormalAssessmentsRepo = ReturnType<typeof createFormalAssessmentsRepo>;
