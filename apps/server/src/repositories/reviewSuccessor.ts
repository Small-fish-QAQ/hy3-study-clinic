import {
  MemoryScheduleStateSchema,
  ReviewBackfillAuditSchema,
  ReviewEventSchemaV2,
  ReviewExecutionSchema,
  ReviewTargetBindingSchema,
  ReviewTargetSchema,
  SchedulerConfigurationSchema,
  type MemoryScheduleState,
  type ReviewBackfillAudit,
  type ReviewExecution,
  type ReviewTarget,
  type ReviewTargetBinding,
  type SchedulerConfiguration,
  type SuccessorReviewEvent,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

const json = (value: unknown) => JSON.stringify(value);
const parseJson = (value: string) => JSON.parse(value) as Record<string, unknown>;

export function createReviewSuccessorRepo(db: SqliteDb) {
  const target = (id: string) => {
    const row = db.prepare('SELECT * FROM review_targets WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row
      ? ReviewTargetSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          courseId: row.course_id,
          targetKind: row.target_kind,
          originEvidenceId: row.origin_evidence_id,
          currentBindingVersion: row.current_binding_version,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : undefined;
  };

  const binding = (id: string, version: number) => {
    const row = db
      .prepare(
        `SELECT * FROM review_target_bindings
         WHERE review_target_id = ? AND binding_version = ?`,
      )
      .get(id, version) as Record<string, unknown> | undefined;
    return row
      ? ReviewTargetBindingSchema.parse({
          reviewTargetId: row.review_target_id,
          bindingVersion: row.binding_version,
          contractVersionId: row.contract_version_id,
          curriculumVersionId: row.curriculum_version_id,
          learningUnitId: row.learning_unit_id,
          objectiveId: row.objective_id,
          executionSourceManifestFingerprint: row.execution_source_manifest_fingerprint,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          createdAt: row.created_at,
        })
      : undefined;
  };

  const state = (id: string) => {
    const row = db
      .prepare('SELECT * FROM memory_schedule_states WHERE review_target_id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? MemoryScheduleStateSchema.parse({
          reviewTargetId: row.review_target_id,
          policyVersion: row.policy_version,
          lifecycleState: row.lifecycle_state,
          dueAt: row.due_at,
          lastReviewedAt: row.last_reviewed_at,
          stability: row.stability,
          difficulty: row.difficulty,
          scheduledDays: row.scheduled_days,
          repetitions: row.repetitions,
          lapses: row.lapses,
          lastReviewEventId: row.last_review_event_id,
          rowVersion: row.row_version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : undefined;
  };

  const event = (id: string) => {
    const row = db.prepare('SELECT * FROM successor_review_events WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row
      ? ReviewEventSchemaV2.parse({
          id: row.id,
          reviewTargetId: row.review_target_id,
          bindingVersion: row.binding_version,
          policyVersion: row.policy_version,
          kind: row.kind,
          sequence: row.sequence,
          sourceOutcomeId: row.source_outcome_id,
          reviewExecutionId: row.review_execution_id,
          rating: row.rating,
          occurredAt: row.occurred_at,
          recordedAt: row.recorded_at,
          preState: parseJson(String(row.pre_state)),
          postState: parseJson(String(row.post_state)),
          exactInputTime: row.exact_input_time,
          dueAt: row.due_at,
          idempotencyKey: row.idempotency_key,
        })
      : undefined;
  };

  const execution = (id: string) => {
    const row = db.prepare('SELECT * FROM review_executions WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row
      ? ReviewExecutionSchema.parse({
          id: row.id,
          reviewTargetId: row.review_target_id,
          bindingVersion: row.binding_version,
          consumedRowVersion: row.consumed_row_version,
          workspaceId: row.workspace_id,
          courseId: row.course_id,
          agendaId: row.agenda_id,
          assessmentVersionId: row.assessment_version_id,
          attemptId: row.attempt_id,
          status: row.status,
          failureReason: row.failure_reason,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : undefined;
  };

  const audit = (evidenceId: string) => {
    const row = db
      .prepare('SELECT * FROM review_backfill_audits WHERE evidence_id = ?')
      .get(evidenceId) as Record<string, unknown> | undefined;
    return row
      ? ReviewBackfillAuditSchema.parse({
          evidenceId: row.evidence_id,
          cutoverAt: row.cutover_at,
          outcome: row.outcome,
          reason: row.reason,
          reviewTargetId: row.review_target_id,
          createdAt: row.created_at,
        })
      : undefined;
  };

  const insertEventStatement = () =>
    db.prepare(
      `INSERT INTO successor_review_events
       (id, review_target_id, binding_version, policy_version, kind, sequence, source_outcome_id,
        review_execution_id, rating, occurred_at, recorded_at, pre_state, post_state,
        exact_input_time, due_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  const updateStateStatement = () =>
    db.prepare(
      `UPDATE memory_schedule_states
     SET lifecycle_state = ?, due_at = ?, last_reviewed_at = ?, stability = ?, difficulty = ?,
         scheduled_days = ?, repetitions = ?, lapses = ?, last_review_event_id = ?,
         row_version = ?, updated_at = ?
     WHERE review_target_id = ? AND row_version = ?`,
    );

  return {
    ensureConfiguration(config: SchedulerConfiguration) {
      const item = SchedulerConfigurationSchema.parse(config);
      db.prepare(
        `INSERT OR IGNORE INTO review_scheduler_configurations
           (version, algorithm_generation, package_name, package_version, local_adapter_version,
            rating_policy_version, requested_retention, config_hash, fuzz, short_term,
            maximum_due_horizon_days, effective_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.version,
        item.algorithmGeneration,
        item.packageName,
        item.packageVersion,
        item.localAdapterVersion,
        item.ratingPolicyVersion,
        item.requestedRetention,
        item.configHash,
        0,
        0,
        item.maximumDueHorizonDays,
        item.effectiveAt,
        item.retiredAt,
      );
    },
    getTarget: target,
    listTargets(workspaceId: string) {
      return (
        db
          .prepare('SELECT id FROM review_targets WHERE workspace_id = ? ORDER BY id')
          .all(workspaceId) as Array<{ id: string }>
      ).map((row) => target(row.id)!);
    },
    listCurrent(workspaceId: string) {
      return (
        db
          .prepare(
            `SELECT t.id FROM review_targets t
             JOIN memory_schedule_states s ON s.review_target_id = t.id
             WHERE t.workspace_id = ? AND t.status IN ('pending_initial_review', 'active')
             ORDER BY s.due_at, t.id`,
          )
          .all(workspaceId) as Array<{ id: string }>
      ).map((row) => ({ target: target(row.id)!, state: state(row.id)! }));
    },
    insertTarget(input: ReviewTarget) {
      const item = ReviewTargetSchema.parse(input);
      db.prepare(
        `INSERT INTO review_targets
           (id, workspace_id, course_id, target_kind, origin_evidence_id, status,
            current_binding_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceId,
        item.courseId,
        item.targetKind,
        item.originEvidenceId,
        item.status,
        item.currentBindingVersion,
        item.createdAt,
        item.updatedAt,
      );
      return target(item.id)!;
    },
    upsertTarget(input: ReviewTarget) {
      const item = ReviewTargetSchema.parse(input);
      db.prepare(
        `INSERT INTO review_targets
           (id, workspace_id, course_id, target_kind, origin_evidence_id, status,
            current_binding_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           current_binding_version = excluded.current_binding_version,
           updated_at = excluded.updated_at`,
      ).run(
        item.id,
        item.workspaceId,
        item.courseId,
        item.targetKind,
        item.originEvidenceId,
        item.status,
        item.currentBindingVersion,
        item.createdAt,
        item.updatedAt,
      );
      return target(item.id)!;
    },
    getBinding: binding,
    insertBinding(input: ReviewTargetBinding) {
      const item = ReviewTargetBindingSchema.parse(input);
      db.prepare(
        `INSERT INTO review_target_bindings
           (review_target_id, binding_version, contract_version_id, curriculum_version_id,
            learning_unit_id, objective_id, execution_source_manifest_fingerprint,
            valid_from, valid_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.reviewTargetId,
        item.bindingVersion,
        item.contractVersionId,
        item.curriculumVersionId,
        item.learningUnitId,
        item.objectiveId,
        item.executionSourceManifestFingerprint,
        item.validFrom,
        item.validTo,
        item.createdAt,
      );
      return binding(item.reviewTargetId, item.bindingVersion)!;
    },
    getState: state,
    insertPendingState(targetId: string, policyVersion: string, dueAt: string, at: string) {
      db.prepare(
        `INSERT OR IGNORE INTO memory_schedule_states
           (review_target_id, policy_version, lifecycle_state, due_at, last_reviewed_at,
            stability, difficulty, scheduled_days, repetitions, lapses, last_review_event_id,
            row_version, created_at, updated_at)
         VALUES (?, ?, 'pending_initial_review', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           1, ?, ?)`,
      ).run(targetId, policyVersion, dueAt, at, at);
      return state(targetId)!;
    },
    saveState(input: MemoryScheduleState, expectedRowVersion: number) {
      const item = MemoryScheduleStateSchema.parse(input);
      const info = updateStateStatement().run(
        item.lifecycleState,
        item.dueAt,
        item.lastReviewedAt,
        item.stability,
        item.difficulty,
        item.scheduledDays,
        item.repetitions,
        item.lapses,
        item.lastReviewEventId,
        item.rowVersion,
        item.updatedAt,
        item.reviewTargetId,
        expectedRowVersion,
      );
      if (info.changes !== 1) throw new Error('Review schedule state version conflict.');
      return state(item.reviewTargetId)!;
    },
    findEventBySource(targetId: string, sourceOutcomeId: string, policyVersion: string) {
      const row = db
        .prepare(
          `SELECT id FROM successor_review_events
           WHERE review_target_id = ? AND source_outcome_id = ? AND policy_version = ?`,
        )
        .get(targetId, sourceOutcomeId, policyVersion) as { id: string } | undefined;
      return row ? event(row.id) : undefined;
    },
    nextEventSequence(targetId: string) {
      return (
        db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
             FROM successor_review_events WHERE review_target_id = ?`,
          )
          .get(targetId) as { sequence: number }
      ).sequence;
    },
    insertEvent(input: SuccessorReviewEvent) {
      const item = ReviewEventSchemaV2.parse(input);
      insertEventStatement().run(
        item.id,
        item.reviewTargetId,
        item.bindingVersion,
        item.policyVersion,
        item.kind,
        item.sequence,
        item.sourceOutcomeId,
        item.reviewExecutionId,
        item.rating,
        item.occurredAt,
        item.recordedAt,
        json(item.preState),
        json(item.postState),
        item.exactInputTime,
        item.dueAt,
        item.idempotencyKey,
      );
      return event(item.id)!;
    },
    listEvents(targetId: string) {
      return (
        db
          .prepare(
            `SELECT id FROM successor_review_events
             WHERE review_target_id = ? ORDER BY sequence`,
          )
          .all(targetId) as Array<{ id: string }>
      ).map((row) => event(row.id)!);
    },
    getExecution: execution,
    activeExecution(targetId: string) {
      const row = db
        .prepare(
          "SELECT id FROM review_executions WHERE review_target_id = ? AND status = 'active'",
        )
        .get(targetId) as { id: string } | undefined;
      return row ? execution(row.id) : undefined;
    },
    insertExecution(input: ReviewExecution) {
      const item = ReviewExecutionSchema.parse(input);
      db.prepare(
        `INSERT INTO review_executions
           (id, review_target_id, binding_version, consumed_row_version, workspace_id, course_id,
            agenda_id, assessment_version_id, attempt_id, status, failure_reason,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.reviewTargetId,
        item.bindingVersion,
        item.consumedRowVersion,
        item.workspaceId,
        item.courseId,
        item.agendaId,
        item.assessmentVersionId,
        item.attemptId,
        item.status,
        item.failureReason,
        item.createdAt,
        item.updatedAt,
      );
      return execution(item.id)!;
    },
    updateExecution(input: ReviewExecution) {
      const item = ReviewExecutionSchema.parse(input);
      db.prepare(
        `UPDATE review_executions
         SET consumed_row_version = ?, assessment_version_id = ?, attempt_id = ?, status = ?,
             failure_reason = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        item.consumedRowVersion,
        item.assessmentVersionId,
        item.attemptId,
        item.status,
        item.failureReason,
        item.updatedAt,
        item.id,
      );
      return execution(item.id)!;
    },
    commitEventAndState(
      inputEvent: SuccessorReviewEvent,
      inputState: MemoryScheduleState,
      expectedRowVersion: number,
      executionUpdate?: {
        id: string;
        expectedConsumedRowVersion: number;
        nextConsumedRowVersion: number;
        status: 'active' | 'completed';
        updatedAt: string;
      },
    ) {
      const item = ReviewEventSchemaV2.parse(inputEvent);
      const next = MemoryScheduleStateSchema.parse(inputState);
      return db.transaction(() => {
        insertEventStatement().run(
          item.id,
          item.reviewTargetId,
          item.bindingVersion,
          item.policyVersion,
          item.kind,
          item.sequence,
          item.sourceOutcomeId,
          item.reviewExecutionId,
          item.rating,
          item.occurredAt,
          item.recordedAt,
          json(item.preState),
          json(item.postState),
          item.exactInputTime,
          item.dueAt,
          item.idempotencyKey,
        );
        const stateChange = updateStateStatement().run(
          next.lifecycleState,
          next.dueAt,
          next.lastReviewedAt,
          next.stability,
          next.difficulty,
          next.scheduledDays,
          next.repetitions,
          next.lapses,
          next.lastReviewEventId,
          next.rowVersion,
          next.updatedAt,
          next.reviewTargetId,
          expectedRowVersion,
        );
        if (stateChange.changes !== 1) {
          throw new Error('Review schedule state version conflict.');
        }
        if (executionUpdate) {
          const executionChange = db
            .prepare(
              `UPDATE review_executions
               SET consumed_row_version = ?, status = ?, updated_at = ?
               WHERE id = ? AND status = 'active' AND consumed_row_version = ?`,
            )
            .run(
              executionUpdate.nextConsumedRowVersion,
              executionUpdate.status,
              executionUpdate.updatedAt,
              executionUpdate.id,
              executionUpdate.expectedConsumedRowVersion,
            );
          if (executionChange.changes !== 1) {
            throw new Error('Review execution row version is stale.');
          }
        }
        db.prepare("UPDATE review_targets SET status = 'active', updated_at = ? WHERE id = ?").run(
          next.updatedAt,
          next.reviewTargetId,
        );
        return { event: event(item.id)!, state: state(next.reviewTargetId)! };
      })();
    },
    getBackfillAudit: audit,
    insertBackfillAudit(input: ReviewBackfillAudit) {
      const item = ReviewBackfillAuditSchema.parse(input);
      db.prepare(
        `INSERT OR IGNORE INTO review_backfill_audits
           (evidence_id, cutover_at, outcome, reason, review_target_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        item.evidenceId,
        item.cutoverAt,
        item.outcome,
        item.reason,
        item.reviewTargetId,
        item.createdAt,
      );
      return audit(item.evidenceId)!;
    },
    listBackfillAudits() {
      return (
        db
          .prepare('SELECT evidence_id FROM review_backfill_audits ORDER BY evidence_id')
          .all() as Array<{
          evidence_id: string;
        }>
      ).map((row) => audit(row.evidence_id)!);
    },
  };
}

export type ReviewSuccessorRepo = ReturnType<typeof createReviewSuccessorRepo>;
