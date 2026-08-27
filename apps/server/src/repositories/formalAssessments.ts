import {
  AssessmentItemIntentSchema,
  AssessmentItemExposureSchema,
  AssessmentAttemptSchema,
  AssessmentDefinitionSchema,
  AssessmentVersionSchema,
  EvidenceRecordSchema,
  GradeRecordSchema,
  ProgressionReconciliationRecordSchema,
  type AssessmentAttempt,
  type AssessmentItemIntent,
  type AssessmentItemExposure,
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

interface AssessmentIntentRow {
  id: string;
  workspace_id: string;
  assessment_version_id: string;
  item_id: string;
  assessment_stage: string;
  policy_version: string;
  requested_challenge_family: string | null;
  requested_representation: string | null;
  selection_reason: string;
  created_at: string;
}
const parse = <T>(row: PayloadRow | undefined, schema: { parse: (v: unknown) => T }) =>
  row ? schema.parse(JSON.parse(row.payload)) : undefined;

export function createFormalAssessmentsRepo(db: SqliteDb) {
  const parseIntent = (row: AssessmentIntentRow | undefined) =>
    row
      ? AssessmentItemIntentSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          assessmentVersionId: row.assessment_version_id,
          itemId: row.item_id,
          assessmentStage: row.assessment_stage,
          policyVersion: row.policy_version,
          requestedChallengeFamily: row.requested_challenge_family,
          requestedRepresentation: row.requested_representation,
          selectionReason: row.selection_reason,
          createdAt: row.created_at,
        })
      : undefined;
  const intent = (assessmentVersionId: string, itemId: string) =>
    parseIntent(
      db
        .prepare(
          `SELECT id, workspace_id, assessment_version_id, item_id, assessment_stage,
                  policy_version, requested_challenge_family, requested_representation,
                  selection_reason, created_at
           FROM assessment_item_intents
           WHERE assessment_version_id = ? AND item_id = ?`,
        )
        .get(assessmentVersionId, itemId) as AssessmentIntentRow | undefined,
    );
  const exposure = (attemptId: string, itemId: string) => {
    const row = db
      .prepare(
        `SELECT id, workspace_id, assessment_version_id, attempt_id, item_id,
                item_fingerprint, surface, seen_before_attempt, exposed_at
         FROM assessment_item_exposures WHERE attempt_id = ? AND item_id = ?`,
      )
      .get(attemptId, itemId) as Record<string, unknown> | undefined;
    return row
      ? AssessmentItemExposureSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          assessmentVersionId: row.assessment_version_id,
          attemptId: row.attempt_id,
          itemId: row.item_id,
          itemFingerprint: row.item_fingerprint,
          surface: row.surface,
          seenBeforeAttempt:
            row.seen_before_attempt === null ? null : row.seen_before_attempt === 1,
          exposedAt: row.exposed_at,
        })
      : undefined;
  };
  const listExposuresForWorkspace = (workspaceId: string) => {
    const rows = db
      .prepare(
        `SELECT id, workspace_id, assessment_version_id, attempt_id, item_id,
                item_fingerprint, surface, seen_before_attempt, exposed_at
         FROM assessment_item_exposures
         WHERE workspace_id = ? ORDER BY exposed_at, id`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      AssessmentItemExposureSchema.parse({
        id: row.id,
        workspaceId: row.workspace_id,
        assessmentVersionId: row.assessment_version_id,
        attemptId: row.attempt_id,
        itemId: row.item_id,
        itemFingerprint: row.item_fingerprint,
        surface: row.surface,
        seenBeforeAttempt: row.seen_before_attempt === null ? null : row.seen_before_attempt === 1,
        exposedAt: row.exposed_at,
      }),
    );
  };

  function listAttemptsForWorkspace(workspaceId: string) {
    return (
      db
        .prepare(
          "SELECT json_object('id', id, 'assessmentVersionId', assessment_version_id, 'workspaceId', workspace_id, 'ordinal', ordinal, 'status', status, 'responses', responses, 'startedAt', started_at, 'submittedAt', submitted_at, 'cancelledAt', cancelled_at) AS payload FROM assessment_attempts WHERE workspace_id = ? ORDER BY started_at DESC, id DESC",
        )
        .all(workspaceId) as PayloadRow[]
    ).map((row) => {
      const value = JSON.parse(row.payload) as Record<string, unknown>;
      return AssessmentAttemptSchema.parse({
        ...value,
        responses: JSON.parse(String(value.responses)),
      });
    });
  }

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
          "SELECT json_object('id', id, 'evidenceRecordId', evidence_record_id, 'status', status, 'appliedAt', applied_at, 'createdAt', created_at, 'gradingResultId', grading_result_id, 'failureReason', failure_reason) AS payload FROM assessment_progression_reconciliations WHERE id = ?",
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
    findDefinitionByLogicalKey(workspaceId: string, logicalKey: string) {
      const row = db
        .prepare(
          'SELECT id FROM assessment_definitions WHERE workspace_id = ? AND logical_key = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(workspaceId, logicalKey) as { id: string } | undefined;
      return row ? definition(row.id) : undefined;
    },
    insertVersion(input: AssessmentVersion) {
      const item = AssessmentVersionSchema.parse(input);
      db.prepare(
        'INSERT INTO assessment_versions (id, definition_id, version, predecessor_id, status, payload, source_revision_ids, progression_context, authority_mode, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.id,
        item.definitionId,
        item.version,
        item.predecessorId,
        item.status,
        JSON.stringify(item),
        JSON.stringify(item.sourceRevisionIds),
        item.progressionContext ? JSON.stringify(item.progressionContext) : null,
        item.authorityMode,
        item.createdAt,
        item.acceptedAt,
      );
      return item;
    },
    insertItemIntents(inputs: AssessmentItemIntent[]): AssessmentItemIntent[] {
      const items = inputs.map((input) => AssessmentItemIntentSchema.parse(input));
      const insert = db.prepare(
        `INSERT INTO assessment_item_intents
           (id, workspace_id, assessment_version_id, item_id, assessment_stage,
            policy_version, requested_challenge_family, requested_representation,
            selection_reason, created_at)
         VALUES (@id, @workspaceId, @assessmentVersionId, @itemId, @assessmentStage,
            @policyVersion, @requestedChallengeFamily, @requestedRepresentation,
            @selectionReason, @createdAt)`,
      );
      db.transaction(() => {
        for (const item of items) {
          const assessmentVersion = version(item.assessmentVersionId);
          const definition = assessmentVersion
            ? db
                .prepare('SELECT workspace_id FROM assessment_definitions WHERE id = ?')
                .get(assessmentVersion.definitionId)
            : undefined;
          if (
            !assessmentVersion ||
            !assessmentVersion.items.some((candidate) => candidate.id === item.itemId) ||
            assessmentVersion.progressionContext?.assessmentKind !== item.assessmentStage ||
            (definition as { workspace_id: string } | undefined)?.workspace_id !== item.workspaceId
          ) {
            throw new Error('Assessment item intent does not match its local version context.');
          }
          insert.run(item);
        }
      })();
      return items;
    },
    getItemIntent: intent,
    listItemIntentsForWorkspace(workspaceId: string): AssessmentItemIntent[] {
      return (
        db
          .prepare(
            `SELECT id, workspace_id, assessment_version_id, item_id, assessment_stage,
                    policy_version, requested_challenge_family, requested_representation,
                    selection_reason, created_at
             FROM assessment_item_intents
             WHERE workspace_id = ? ORDER BY created_at, id`,
          )
          .all(workspaceId) as AssessmentIntentRow[]
      ).map((row) => parseIntent(row)!);
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
        'INSERT INTO assessment_attempts (id, assessment_version_id, workspace_id, ordinal, status, responses, started_at, submitted_at, cancelled_at, exposure_tracking_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
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
    insertExposure(input: AssessmentItemExposure) {
      const item = AssessmentItemExposureSchema.parse(input);
      const existing = exposure(item.attemptId, item.itemId);
      if (existing) return existing;
      db.prepare(
        `INSERT INTO assessment_item_exposures
           (id, workspace_id, assessment_version_id, attempt_id, item_id,
            item_fingerprint, surface, seen_before_attempt, exposed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceId,
        item.assessmentVersionId,
        item.attemptId,
        item.itemId,
        item.itemFingerprint,
        item.surface,
        item.seenBeforeAttempt === null ? null : item.seenBeforeAttempt ? 1 : 0,
        item.exposedAt,
      );
      return exposure(item.attemptId, item.itemId)!;
    },
    getExposure: exposure,
    listExposuresForWorkspace,
    listExposureTrackedAttemptIds(workspaceId: string) {
      return (
        db
          .prepare(
            `SELECT id FROM assessment_attempts
             WHERE workspace_id = ? AND exposure_tracking_version >= 1
             ORDER BY started_at, id`,
          )
          .all(workspaceId) as Array<{ id: string }>
      ).map((row) => row.id);
    },
    getAttempt: attempt,
    listAttemptsForWorkspace,
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
      try {
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
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        const message = error instanceof Error ? error.message : String(error);
        if (
          item.status === 'current' &&
          code === 'SQLITE_CONSTRAINT_UNIQUE' &&
          message.includes('assessment_grade_records.attempt_id')
        ) {
          const existing = db
            .prepare(
              "SELECT payload FROM assessment_grade_records WHERE attempt_id = ? AND status = 'current' ORDER BY created_at, id LIMIT 1",
            )
            .get(item.attemptId) as PayloadRow | undefined;
          if (existing) return GradeRecordSchema.parse(JSON.parse(existing.payload));
        }
        throw error;
      }
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
    listEvidenceCreatedBefore(cutoverAt: string) {
      return (
        db
          .prepare(
            `SELECT * FROM assessment_evidence_records
             WHERE created_at < ? ORDER BY created_at, id`,
          )
          .all(cutoverAt) as Array<Record<string, unknown>>
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
    listProjectionRecords(workspaceId: string) {
      const versions = (
        db
          .prepare(
            `SELECT v.payload FROM assessment_versions v
             JOIN assessment_definitions d ON d.id = v.definition_id
             WHERE d.workspace_id = ? ORDER BY v.created_at, v.id`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => AssessmentVersionSchema.parse(JSON.parse(row.payload)));
      const attempts = listAttemptsForWorkspace(workspaceId);
      const grades = (
        db
          .prepare(
            `SELECT g.payload FROM assessment_grade_records g
             JOIN assessment_attempts a ON a.id = g.attempt_id
             WHERE a.workspace_id = ? ORDER BY g.created_at, g.id`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => GradeRecordSchema.parse(JSON.parse(row.payload)));
      const evidenceRecords = (
        db
          .prepare(
            `SELECT e.* FROM assessment_evidence_records e
             JOIN assessment_attempts a ON a.id = e.attempt_id
             WHERE a.workspace_id = ? ORDER BY e.created_at, e.id`,
          )
          .all(workspaceId) as Array<Record<string, unknown>>
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
      const reconciliations = (
        db
          .prepare(
            `SELECT r.id FROM assessment_progression_reconciliations r
             JOIN assessment_evidence_records e ON e.id = r.evidence_record_id
             JOIN assessment_attempts a ON a.id = e.attempt_id
             WHERE a.workspace_id = ? ORDER BY r.created_at, r.id`,
          )
          .all(workspaceId) as Array<{ id: string }>
      ).map((row) => reconciliation(row.id)!);
      return {
        versions,
        attempts,
        grades,
        evidence: evidenceRecords,
        reconciliations,
        exposures: listExposuresForWorkspace(workspaceId),
      };
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
        'INSERT INTO assessment_progression_reconciliations (id, evidence_record_id, status, applied_at, created_at, grading_result_id, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.id,
        item.evidenceRecordId,
        item.status,
        item.appliedAt,
        item.createdAt,
        item.gradingResultId,
        item.failureReason,
      );
      return item;
    },
    getReconciliation: reconciliation,
    getReconciliationForEvidence(evidenceRecordId: string) {
      const row = db
        .prepare(
          'SELECT id FROM assessment_progression_reconciliations WHERE evidence_record_id = ?',
        )
        .get(evidenceRecordId) as { id: string } | undefined;
      return row ? reconciliation(row.id) : undefined;
    },
    getReconciliationForGrade(gradeRecordId: string) {
      const row = db
        .prepare(
          `SELECT apr.id FROM assessment_progression_reconciliations apr
           JOIN assessment_evidence_records aer ON aer.id = apr.evidence_record_id
           WHERE aer.grade_record_id = ? ORDER BY apr.created_at, apr.id LIMIT 1`,
        )
        .get(gradeRecordId) as { id: string } | undefined;
      return row ? reconciliation(row.id) : undefined;
    },
    linkReconciliation(id: string, gradingResultId: string) {
      const current = reconciliation(id);
      if (!current) throw new Error('Assessment reconciliation does not exist.');
      if (current.gradingResultId && current.gradingResultId !== gradingResultId) {
        throw new Error('Assessment reconciliation is linked to a different grading result.');
      }
      db.prepare(
        'UPDATE assessment_progression_reconciliations SET grading_result_id = ? WHERE id = ? AND (grading_result_id IS NULL OR grading_result_id = ?)',
      ).run(gradingResultId, id, gradingResultId);
      return reconciliation(id)!;
    },
    markReconciled(id: string, appliedAt: string) {
      db.prepare(
        "UPDATE assessment_progression_reconciliations SET status = 'applied', applied_at = ?, failure_reason = NULL WHERE id = ? AND status IN ('pending', 'failed')",
      ).run(appliedAt, id);
      return reconciliation(id)!;
    },
    markFailed(id: string, reason: string) {
      db.prepare(
        "UPDATE assessment_progression_reconciliations SET status = 'failed', failure_reason = ? WHERE id = ? AND status IN ('pending', 'failed')",
      ).run(reason.slice(0, 500), id);
      return reconciliation(id)!;
    },
  };
}

export type FormalAssessmentsRepo = ReturnType<typeof createFormalAssessmentsRepo>;
