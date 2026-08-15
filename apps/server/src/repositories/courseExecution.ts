import {
  CurriculumSchema,
  GoalOutcomeSchema,
  LearningContractSchema,
  SessionAgendaSchema,
  StudyPlanSchema,
  type CourseExecutionStatus,
  type Curriculum,
  type LearningContract,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

export type RouteValidationStatus = 'unconfigured' | 'valid' | 'revalidation_required' | 'blocked';

export interface CourseExecutionState {
  workspaceId: string;
  activeContractId: string | null;
  activeCurriculumId: string | null;
  acceptedPlanId: string | null;
  activeAgendaId: string | null;
  executionStatus: CourseExecutionStatus;
  routeValidationStatus: RouteValidationStatus;
  version: number;
  updatedAt: string | null;
}

export interface ActivateCourseRouteInput {
  workspaceId: string;
  contractId: string;
  curriculumId: string;
  planId: string;
  agendaId: string;
  expectedStateVersion: number;
  expectedActiveContractId: string | null;
  expectedActiveCurriculumId: string | null;
  expectedAcceptedPlanId: string | null;
  expectedActiveAgendaId: string | null;
  eventId: string;
  actor: 'learner';
  acceptedAt: string;
  /** Test-only transaction probe; production callers leave this undefined. */
  beforePointerSwap?: () => void;
}

export interface TransitionCourseExecutionInput {
  workspaceId: string;
  expectedVersion: number;
  expectedAcceptedPlanId: string;
  expectedAgendaId: string;
  transition: 'pause' | 'resume' | 'stop';
  eventId: string;
  reason: string | null;
  actor: 'learner';
  at: string;
}

export interface TerminateCourseRouteInput {
  workspaceId: string;
  expectedStateVersion: number;
  expectedContractId: string;
  expectedCurriculumId: string;
  expectedPlanId: string;
  expectedAgendaId: string;
  eventId: string;
  actor: 'learner' | 'local';
  outcomeId: string;
  outcomeStatus: 'achieved' | 'finished_with_gaps' | 'expired_unfinished' | 'abandoned';
  reason: string;
  terminatedAt: string;
}

interface StateRow {
  workspace_id: string;
  active_contract_id: string | null;
  active_curriculum_id: string | null;
  accepted_plan_id: string | null;
  active_agenda_id: string | null;
  execution_status: CourseExecutionStatus;
  route_validation_status: RouteValidationStatus;
  version: number;
  updated_at: string;
}

interface PayloadRow {
  payload: string;
  status: string;
}

function toState(row: StateRow): CourseExecutionState {
  return {
    workspaceId: row.workspace_id,
    activeContractId: row.active_contract_id,
    activeCurriculumId: row.active_curriculum_id,
    acceptedPlanId: row.accepted_plan_id,
    activeAgendaId: row.active_agenda_id,
    executionStatus: row.execution_status,
    routeValidationStatus: row.route_validation_status,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export function createCourseExecutionRepo(db: SqliteDb) {
  function get(workspaceId: string): CourseExecutionState {
    const row = db
      .prepare('SELECT * FROM course_execution_state WHERE workspace_id = ?')
      .get(workspaceId) as StateRow | undefined;
    return row
      ? toState(row)
      : {
          workspaceId,
          activeContractId: null,
          activeCurriculumId: null,
          acceptedPlanId: null,
          activeAgendaId: null,
          executionStatus: 'stopped',
          routeValidationStatus: 'unconfigured',
          version: 0,
          updatedAt: null,
        };
  }

  function readContract(id: string): LearningContract {
    const row = db
      .prepare('SELECT payload, status FROM learning_contract_versions WHERE id = ?')
      .get(id) as PayloadRow | undefined;
    if (!row) throw new Error('Learning Contract does not exist.');
    return LearningContractSchema.parse({
      ...(JSON.parse(row.payload) as object),
      status: row.status,
    });
  }

  function readCurriculum(id: string): Curriculum {
    const row = db
      .prepare('SELECT payload, status FROM curriculum_versions WHERE id = ?')
      .get(id) as PayloadRow | undefined;
    if (!row) throw new Error('Curriculum does not exist.');
    return CurriculumSchema.parse({ ...(JSON.parse(row.payload) as object), status: row.status });
  }

  function readPlan(id: string): StudyPlan {
    const row = db
      .prepare('SELECT payload, status FROM study_plan_versions WHERE id = ?')
      .get(id) as PayloadRow | undefined;
    if (!row) throw new Error('StudyPlan does not exist.');
    return StudyPlanSchema.parse({ ...(JSON.parse(row.payload) as object), status: row.status });
  }

  function readAgenda(id: string): SessionAgenda {
    const row = db.prepare('SELECT payload, status FROM session_agendas WHERE id = ?').get(id) as
      PayloadRow | undefined;
    if (!row) throw new Error('SessionAgenda does not exist.');
    return SessionAgendaSchema.parse({
      ...(JSON.parse(row.payload) as object),
      status: row.status,
    });
  }

  function planDescendsFrom(plan: StudyPlan, ancestorId: string): boolean {
    const visited = new Set([plan.id]);
    let predecessorId = plan.predecessorId;
    while (predecessorId) {
      if (predecessorId === ancestorId) return true;
      if (visited.has(predecessorId)) {
        throw new Error('StudyPlan predecessor history contains a cycle.');
      }
      visited.add(predecessorId);
      const predecessor = readPlan(predecessorId);
      if (predecessor.workspaceId !== plan.workspaceId || predecessor.version >= plan.version) {
        throw new Error('StudyPlan predecessor history is incompatible.');
      }
      predecessorId = predecessor.predecessorId;
    }
    return false;
  }

  function curriculumDescendsFrom(curriculum: Curriculum, ancestorId: string): boolean {
    const visited = new Set([curriculum.id]);
    let predecessorId = curriculum.predecessorId;
    while (predecessorId) {
      if (predecessorId === ancestorId) return true;
      if (visited.has(predecessorId)) {
        throw new Error('Curriculum predecessor history contains a cycle.');
      }
      visited.add(predecessorId);
      const predecessor = readCurriculum(predecessorId);
      if (
        predecessor.workspaceId !== curriculum.workspaceId ||
        predecessor.version >= curriculum.version
      ) {
        throw new Error('Curriculum predecessor history is incompatible.');
      }
      predecessorId = predecessor.predecessorId;
    }
    return false;
  }

  function verifyExpectedState(
    input: ActivateCourseRouteInput,
    current: CourseExecutionState,
  ): void {
    if (
      current.version !== input.expectedStateVersion ||
      current.activeContractId !== input.expectedActiveContractId ||
      current.activeCurriculumId !== input.expectedActiveCurriculumId ||
      current.acceptedPlanId !== input.expectedAcceptedPlanId ||
      current.activeAgendaId !== input.expectedActiveAgendaId
    ) {
      throw new Error('Course execution route is stale.');
    }
  }

  function verifyRoute(
    input: ActivateCourseRouteInput,
    current: CourseExecutionState,
  ): {
    contract: LearningContract;
    curriculum: Curriculum;
    plan: StudyPlan;
    agenda: SessionAgenda;
  } {
    const contract = readContract(input.contractId);
    const curriculum = readCurriculum(input.curriculumId);
    const plan = readPlan(input.planId);
    const agenda = readAgenda(input.agendaId);
    const reusesActiveContract = current.activeContractId === contract.id;
    const reusesActiveCurriculum = current.activeCurriculumId === curriculum.id;
    if (
      contract.workspaceId !== input.workspaceId ||
      (contract.status !== 'learner_confirmed' &&
        !(reusesActiveContract && contract.status === 'active'))
    ) {
      throw new Error('Route activation requires a learner-confirmed Contract in this Course.');
    }
    if (
      curriculum.workspaceId !== input.workspaceId ||
      curriculum.contractVersionId !== contract.id ||
      curriculum.status !== 'accepted' ||
      !curriculum.validation.valid
    ) {
      throw new Error('Route activation requires a valid accepted compatible Curriculum.');
    }
    if (
      plan.workspaceId !== input.workspaceId ||
      plan.contractVersionId !== contract.id ||
      plan.curriculumVersionId !== curriculum.id ||
      plan.executionSourceManifestFingerprint !== curriculum.executionSourceManifest.fingerprint ||
      plan.status !== 'proposed' ||
      !plan.paceBaseline
    ) {
      throw new Error(
        'Route activation requires a proposed compatible StudyPlan and PaceBaseline.',
      );
    }
    const baseline = db
      .prepare(
        `SELECT 1 FROM pace_baselines
         WHERE id = ? AND plan_id = ? AND contract_id = ?`,
      )
      .get(plan.paceBaseline.id, plan.id, contract.id);
    if (!baseline) throw new Error('Route activation requires a durable matching PaceBaseline.');
    if (
      agenda.workspaceId !== input.workspaceId ||
      agenda.contractVersionId !== contract.id ||
      agenda.curriculumVersionId !== curriculum.id ||
      agenda.studyPlanVersionId !== plan.id ||
      agenda.executionSourceManifestFingerprint !== plan.executionSourceManifestFingerprint ||
      agenda.status !== 'draft'
    ) {
      throw new Error('Route activation requires a compatible draft SessionAgenda.');
    }
    if (current.acceptedPlanId && !planDescendsFrom(plan, current.acceptedPlanId)) {
      throw new Error('Successor StudyPlan must descend from the currently accepted Plan.');
    }
    if (
      current.activeContractId &&
      !reusesActiveContract &&
      contract.predecessorId !== current.activeContractId
    ) {
      throw new Error('Successor Contract must identify the active Contract as predecessor.');
    }
    if (
      current.activeCurriculumId &&
      !reusesActiveCurriculum &&
      !curriculumDescendsFrom(curriculum, current.activeCurriculumId)
    ) {
      throw new Error('Successor Curriculum must descend from the active Curriculum.');
    }

    const currentManifest = db
      .prepare(
        `SELECT COUNT(*) AS missing
         FROM execution_source_manifest_revisions r
         JOIN materials m ON m.id = r.material_id
         WHERE r.manifest_id = (
           SELECT manifest_id FROM curriculum_versions WHERE id = ?
         ) AND m.active_revision_id <> r.material_revision_id`,
      )
      .get(curriculum.id) as { missing: number };
    if (currentManifest.missing > 0) {
      throw new Error('Execution-source manifest is stale and must be regenerated.');
    }

    const launch = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN l.plan_item_id IS NULL THEN 1 ELSE 0 END) AS missing,
                SUM(CASE WHEN l.source_fingerprint <> ? THEN 1 ELSE 0 END) AS stale
         FROM study_plan_items i
         LEFT JOIN study_plan_launch_validations l
           ON l.plan_id = i.plan_id AND l.plan_item_id = i.plan_item_id
         WHERE i.plan_id = ?`,
      )
      .get(plan.executionSourceManifestFingerprint, plan.id) as {
      total: number;
      missing: number | null;
      stale: number | null;
    };
    if (launch.total !== plan.items.length || launch.missing || launch.stale) {
      throw new Error('Every StudyPlan item requires current launchability validation.');
    }

    const routed = new Map<string, Set<string>>();
    for (const item of plan.items) {
      if (!item.curriculumLearningUnitId) continue;
      const objectives = routed.get(item.curriculumLearningUnitId) ?? new Set<string>();
      item.objectiveIds.forEach((id) => objectives.add(id));
      routed.set(item.curriculumLearningUnitId, objectives);
    }
    const deferred = new Map<string, Set<string>>();
    for (const entry of plan.deferrals) {
      deferred.set(entry.curriculumLearningUnitId, new Set(entry.objectiveIds));
    }
    for (const node of curriculum.nodes) {
      if (!node.learningUnit) continue;
      const routedObjectives = routed.get(node.id) ?? new Set<string>();
      const deferredObjectives = deferred.get(node.id) ?? new Set<string>();
      for (const objective of node.learningUnit.objectives) {
        if (!routedObjectives.has(objective.id) && !deferredObjectives.has(objective.id)) {
          throw new Error(
            `Known Curriculum objective disappeared from the proposed route: ${objective.id}`,
          );
        }
      }
    }
    const blockingRows = db
      .prepare(
        `SELECT i.completion_requirements, i.objective_ids
         FROM study_plan_items i WHERE i.plan_id = ?`,
      )
      .all(plan.id) as Array<{ completion_requirements: string; objective_ids: string }>;
    for (const row of blockingRows) {
      const requirements = JSON.parse(row.completion_requirements) as Array<{
        blocking: boolean;
        admissibilityTier: string;
        objectiveIds: string[];
      }>;
      for (const requirement of requirements) {
        if (requirement.blocking && requirement.admissibilityTier === 'tier_3_advisory') {
          throw new Error('Tier-3 evidence cannot block Plan completion.');
        }
        for (const objectiveId of requirement.blocking ? requirement.objectiveIds : []) {
          const objective = db
            .prepare(
              `SELECT truth_premise_status FROM curriculum_objective_index
               WHERE curriculum_id = ? AND objective_id = ?`,
            )
            .get(curriculum.id, objectiveId) as { truth_premise_status: string } | undefined;
          if (!objective || objective.truth_premise_status !== 'independently_verified') {
            throw new Error('Blocking completion requires independently authorized truth.');
          }
          const eligible = db
            .prepare(
              `SELECT EXISTS(
                 SELECT 1 FROM curriculum_objective_authority coa
                 JOIN truth_authority_records a ON a.id = coa.authority_record_id
                 JOIN material_revisions mr ON mr.id = a.material_revision_id
                 JOIN materials m ON m.id = a.material_id
                 WHERE coa.curriculum_id = ? AND coa.objective_id = ?
                   AND a.validation_state = 'validated'
                   AND a.conflict_state IN ('none', 'resolved')
                   AND mr.status = 'active' AND m.active_revision_id = mr.id
               ) AS eligible`,
            )
            .get(curriculum.id, objectiveId) as { eligible: number };
          if (eligible.eligible !== 1) {
            throw new Error('Blocking completion authority is stale or ineligible.');
          }
        }
      }
    }
    return { contract, curriculum, plan, agenda };
  }

  function addEvent(
    input: ActivateCourseRouteInput,
    resultingVersion: number,
    supersededSessionIds: string[],
  ): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM course_execution_events WHERE workspace_id = ?`,
        )
        .get(input.workspaceId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO course_execution_events
         (id, workspace_id, seq, event_type, actor, expected_version,
          resulting_version, payload, created_at)
       VALUES (?, ?, ?, 'route_activated', ?, ?, ?, ?, ?)`,
    ).run(
      input.eventId,
      input.workspaceId,
      seq,
      input.actor,
      input.expectedStateVersion,
      resultingVersion,
      JSON.stringify({
        contractId: input.contractId,
        curriculumId: input.curriculumId,
        planId: input.planId,
        agendaId: input.agendaId,
        supersededSessionIds,
      }),
      input.acceptedAt,
    );
  }

  const activateRouteTx = db.transaction(
    (input: ActivateCourseRouteInput): CourseExecutionState => {
      const current = get(input.workspaceId);
      verifyExpectedState(input, current);
      const { contract, plan, agenda } = verifyRoute(input, current);
      const acceptedPlan = StudyPlanSchema.parse({
        ...plan,
        status: 'accepted',
        learnerAcceptedAt: input.acceptedAt,
      });
      const activeContract = LearningContractSchema.parse({ ...contract, status: 'active' });
      const activeAgenda = SessionAgendaSchema.parse({
        ...agenda,
        status: 'active',
        updatedAt: input.acceptedAt,
      });
      const supersededSessionIds: string[] = [];

      if (current.activeContractId && current.activeContractId !== contract.id) {
        const oldContract = readContract(current.activeContractId);
        db.prepare(
          `UPDATE learning_contract_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...oldContract, status: 'superseded' }), oldContract.id);
      }
      if (current.activeCurriculumId && current.activeCurriculumId !== input.curriculumId) {
        const oldCurriculum = readCurriculum(current.activeCurriculumId);
        db.prepare(
          `UPDATE curriculum_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...oldCurriculum, status: 'superseded' }), oldCurriculum.id);
      }
      if (current.acceptedPlanId) {
        const oldPlan = readPlan(current.acceptedPlanId);
        const evidenceIds = (
          db
            .prepare(
              `SELECT e.id FROM formal_evidence_records e
               JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
               WHERE q.contract_id = ? AND q.plan_id = ? ORDER BY e.created_at, e.id`,
            )
            .all(oldPlan.contractVersionId, oldPlan.id) as Array<{ id: string }>
        ).map((row) => row.id);
        const unresolvedRiskIds = (
          db
            .prepare(
              `SELECT id FROM coverage_risk_entries
               WHERE contract_id = ? AND status NOT IN ('resolved', 'rejected', 'stale')
               ORDER BY first_observed_at, id`,
            )
            .all(oldPlan.contractVersionId) as Array<{ id: string }>
        ).map((row) => row.id);
        const supersededOutcome = GoalOutcomeSchema.parse({
          id: `goal_outcome_${input.eventId}`,
          workspaceId: input.workspaceId,
          contractVersionId: oldPlan.contractVersionId,
          studyPlanVersionId: oldPlan.id,
          status: 'superseded',
          formalEvidenceIds: evidenceIds,
          unresolvedRiskIds,
          reason: `Superseded by learner-accepted StudyPlan ${plan.id}.`,
          actor: 'learner',
          createdAt: input.acceptedAt,
        });
        db.prepare(
          `INSERT OR IGNORE INTO goal_outcomes
             (id, workspace_id, contract_id, plan_id, status, payload, created_at)
           VALUES (@id, @workspaceId, @contractVersionId, @studyPlanVersionId,
             @status, @payload, @createdAt)`,
        ).run({ ...supersededOutcome, payload: JSON.stringify(supersededOutcome) });
        db.prepare(
          `UPDATE study_plan_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...oldPlan, status: 'superseded' }), oldPlan.id);
      }
      if (current.activeAgendaId) {
        const oldAgenda = readAgenda(current.activeAgendaId);
        db.prepare(
          `UPDATE session_agendas SET status = 'abandoned', payload = ?, updated_at = ? WHERE id = ?`,
        ).run(
          JSON.stringify({ ...oldAgenda, status: 'abandoned', updatedAt: input.acceptedAt }),
          input.acceptedAt,
          oldAgenda.id,
        );
      }

      if (
        current.activeContractId &&
        current.activeCurriculumId &&
        current.acceptedPlanId &&
        current.activeAgendaId
      ) {
        const openSessions = db
          .prepare(
            `SELECT id, version FROM study_sessions
             WHERE workspace_id = ? AND contract_id = ? AND curriculum_id = ?
               AND plan_id = ? AND agenda_id = ?
               AND status IN ('active', 'paused', 'interrupted')
             ORDER BY created_at, id`,
          )
          .all(
            input.workspaceId,
            current.activeContractId,
            current.activeCurriculumId,
            current.acceptedPlanId,
            current.activeAgendaId,
          ) as Array<{ id: string; version: number }>;
        for (const session of openSessions) {
          supersededSessionIds.push(session.id);
          const openTurns = db
            .prepare(
              `SELECT id FROM study_session_turns
               WHERE session_id = ? AND status IN ('queued', 'running', 'interrupted') ORDER BY seq`,
            )
            .all(session.id) as Array<{ id: string }>;
          for (const turn of openTurns) {
            const nextTurnEventSeq = (
              db
                .prepare(
                  `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
                   FROM study_turn_events WHERE turn_id = ?`,
                )
                .get(turn.id) as { seq: number }
            ).seq;
            db.prepare(
              `UPDATE study_session_turns SET status = 'cancelled',
                 error_message = 'route_superseded: learner accepted a successor StudyPlan.',
                 completed_at = ?
               WHERE id = ? AND status IN ('queued', 'running', 'interrupted')`,
            ).run(input.acceptedAt, turn.id);
            db.prepare(
              `INSERT INTO study_turn_events
                 (id, session_id, turn_id, seq, kind, provisional, content, created_at)
               VALUES (?, ?, ?, ?, 'cancelled', 0, 'route_superseded', ?)`,
            ).run(
              `${turn.id}:${input.eventId}:route_superseded`,
              session.id,
              turn.id,
              nextTurnEventSeq,
              input.acceptedAt,
            );
          }

          const runningOperations = db
            .prepare(
              `SELECT DISTINCT o.id, o.fencing_token, o.status
               FROM agent_operations o
               LEFT JOIN model_logical_calls lc ON lc.operation_id = o.id
               WHERE o.status IN ('running', 'interrupted')
                 AND (lc.study_session_id = ? OR
                   (o.operation_type = 'study_session_turn' AND
                    substr(o.command_id, 1, length(?)) = ?))
               ORDER BY o.created_at, o.id`,
            )
            .all(session.id, `study-turn:${session.id}:`, `study-turn:${session.id}:`) as Array<{
            id: string;
            fencing_token: number;
            status: 'running' | 'interrupted';
          }>;
          for (const operation of runningOperations) {
            db.prepare(
              `UPDATE model_call_attempts
               SET status = CASE WHEN status = 'sent' THEN 'outcome_unknown' ELSE 'interrupted' END,
                   completed_at = COALESCE(completed_at, ?),
                   error_code = COALESCE(error_code, 'ROUTE_SUPERSEDED'),
                   error_message = COALESCE(error_message, 'Successor route fenced this attempt.')
               WHERE logical_call_id IN
                 (SELECT id FROM model_logical_calls WHERE operation_id = ?)
                 AND status IN ('queued', 'sent')`,
            ).run(input.acceptedAt, operation.id);
            db.prepare(
              `UPDATE model_logical_calls SET status = 'cancelled', completed_at = ?
               WHERE operation_id = ? AND status = 'open'`,
            ).run(input.acceptedAt, operation.id);
            const nextOperationEventSeq = (
              db
                .prepare(
                  `SELECT COALESCE(MAX(seq), -1) + 1 AS seq
                   FROM agent_operation_events WHERE operation_id = ?`,
                )
                .get(operation.id) as { seq: number }
            ).seq;
            db.prepare(
              `INSERT INTO agent_operation_events
                 (id, operation_id, seq, fencing_token, kind, payload, created_at)
               VALUES (?, ?, ?, ?, 'operation_interrupted', ?, ?)`,
            ).run(
              `${operation.id}:${input.eventId}:route_superseded`,
              operation.id,
              nextOperationEventSeq,
              operation.fencing_token,
              JSON.stringify({ reason: 'route_superseded', successorPlanId: input.planId }),
              input.acceptedAt,
            );
            db.prepare(
              `INSERT INTO agent_operation_results
                 (operation_id, fencing_token, status, payload, created_at)
               VALUES (?, ?, 'cancelled', ?, ?)`,
            ).run(
              operation.id,
              operation.fencing_token,
              JSON.stringify({ reason: 'route_superseded', successorPlanId: input.planId }),
              input.acceptedAt,
            );
            const fenced = db
              .prepare(
                `UPDATE agent_operations
                 SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                 WHERE id = ? AND status = ? AND fencing_token = ?`,
              )
              .run(
                input.acceptedAt,
                operation.id,
                operation.status,
                operation.fencing_token,
              ).changes;
            if (fenced !== 1) throw new Error('Predecessor Tutor operation changed concurrently.');
          }

          const sessionClosed = db
            .prepare(
              `UPDATE study_sessions
             SET status = 'abandoned', route_state = 'on_route', current_agenda_item_id = NULL,
                 version = ?, updated_at = ? WHERE id = ? AND version = ?`,
            )
            .run(session.version + 1, input.acceptedAt, session.id, session.version).changes;
          if (sessionClosed !== 1)
            throw new Error('Predecessor StudySession changed concurrently.');
        }
      }

      db.prepare(
        `UPDATE learning_contract_versions SET status = 'active', payload = ? WHERE id = ?`,
      ).run(JSON.stringify(activeContract), activeContract.id);
      db.prepare(
        `UPDATE study_plan_versions
       SET status = 'accepted', learner_accepted_at = ?, payload = ? WHERE id = ?`,
      ).run(input.acceptedAt, JSON.stringify(acceptedPlan), acceptedPlan.id);
      db.prepare(
        `UPDATE session_agendas SET status = 'active', payload = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(activeAgenda), input.acceptedAt, activeAgenda.id);

      input.beforePointerSwap?.();
      const resultingVersion = current.version + 1;
      if (current.version === 0) {
        db.prepare(
          `INSERT INTO course_execution_state
           (workspace_id, active_contract_id, active_curriculum_id, accepted_plan_id,
            active_agenda_id, execution_status, route_validation_status, version, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 'valid', ?, ?)`,
        ).run(
          input.workspaceId,
          input.contractId,
          input.curriculumId,
          input.planId,
          input.agendaId,
          resultingVersion,
          input.acceptedAt,
        );
      } else {
        const changed = db
          .prepare(
            `UPDATE course_execution_state
           SET active_contract_id = ?, active_curriculum_id = ?, accepted_plan_id = ?,
               active_agenda_id = ?, execution_status = 'active',
               route_validation_status = 'valid', version = ?, updated_at = ?
           WHERE workspace_id = ? AND version = ?`,
          )
          .run(
            input.contractId,
            input.curriculumId,
            input.planId,
            input.agendaId,
            resultingVersion,
            input.acceptedAt,
            input.workspaceId,
            current.version,
          ).changes;
        if (changed !== 1) throw new Error('Course execution state changed concurrently.');
      }
      addEvent(input, resultingVersion, supersededSessionIds);
      return get(input.workspaceId);
    },
  );

  const terminateRouteTx = db.transaction(
    (input: TerminateCourseRouteInput): CourseExecutionState => {
      const current = get(input.workspaceId);
      if (
        current.version !== input.expectedStateVersion ||
        current.activeContractId !== input.expectedContractId ||
        current.activeCurriculumId !== input.expectedCurriculumId ||
        current.acceptedPlanId !== input.expectedPlanId ||
        current.activeAgendaId !== input.expectedAgendaId
      ) {
        throw new Error('Course execution route is stale.');
      }
      const contract = readContract(input.expectedContractId);
      const plan = readPlan(input.expectedPlanId);
      const agenda = readAgenda(input.expectedAgendaId);
      if (
        contract.status !== 'active' ||
        plan.status !== 'accepted' ||
        agenda.status === 'abandoned'
      ) {
        throw new Error('Only the current active route may be terminated.');
      }

      const closedContract = LearningContractSchema.parse({ ...contract, status: 'closed' });
      const closedPlan = StudyPlanSchema.parse({ ...plan, status: 'closed' });
      const closedAgenda = SessionAgendaSchema.parse({
        ...agenda,
        status: 'abandoned',
        currentItemId: null,
        items: agenda.items.map((item) =>
          item.state === 'queued' || item.state === 'active'
            ? { ...item, state: 'cancelled' as const }
            : item,
        ),
        updatedAt: input.terminatedAt,
      });
      db.prepare(
        `UPDATE learning_contract_versions SET status = 'closed', payload = ?
         WHERE id = ? AND status = 'active'`,
      ).run(JSON.stringify(closedContract), contract.id);
      db.prepare(
        `UPDATE study_plan_versions SET status = 'closed', payload = ?
         WHERE id = ? AND status = 'accepted'`,
      ).run(JSON.stringify(closedPlan), plan.id);
      db.prepare(
        `UPDATE session_agendas SET status = 'abandoned', payload = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(closedAgenda), input.terminatedAt, agenda.id);
      db.prepare(
        `UPDATE session_agenda_items SET state = 'cancelled'
         WHERE agenda_id = ? AND state IN ('queued', 'active')`,
      ).run(agenda.id);

      const openSessions = db
        .prepare(
          `SELECT id FROM study_sessions
           WHERE workspace_id = ? AND plan_id = ? AND status IN ('active', 'paused', 'interrupted')`,
        )
        .all(input.workspaceId, plan.id) as Array<{ id: string }>;
      for (const sessionRow of openSessions) {
        const row = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(sessionRow.id) as {
          version: number;
        };
        db.prepare(
          `UPDATE study_sessions
           SET status = 'abandoned', route_state = 'on_route', current_agenda_item_id = NULL,
               version = ?, updated_at = ? WHERE id = ?`,
        ).run(row.version + 1, input.terminatedAt, sessionRow.id);
        db.prepare(
          `UPDATE study_session_turns SET status = 'interrupted',
             error_message = 'Course goal terminated before this turn completed.',
             completed_at = ?
           WHERE session_id = ? AND status IN ('queued', 'running')`,
        ).run(input.terminatedAt, sessionRow.id);
      }

      const resultingVersion = current.version + 1;
      const changed = db
        .prepare(
          `UPDATE course_execution_state
           SET active_contract_id = NULL, active_curriculum_id = NULL,
               accepted_plan_id = NULL, active_agenda_id = NULL,
               execution_status = 'stopped', route_validation_status = 'unconfigured',
               version = ?, updated_at = ?
           WHERE workspace_id = ? AND version = ?`,
        )
        .run(resultingVersion, input.terminatedAt, input.workspaceId, current.version).changes;
      if (changed !== 1) throw new Error('Course execution state changed concurrently.');
      const seq = (
        db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS n
             FROM course_execution_events WHERE workspace_id = ?`,
          )
          .get(input.workspaceId) as { n: number }
      ).n;
      db.prepare(
        `INSERT INTO course_execution_events
           (id, workspace_id, seq, event_type, actor, expected_version,
            resulting_version, payload, created_at)
         VALUES (?, ?, ?, 'goal_terminal', ?, ?, ?, ?, ?)`,
      ).run(
        input.eventId,
        input.workspaceId,
        seq,
        input.actor,
        input.expectedStateVersion,
        resultingVersion,
        JSON.stringify({
          outcomeId: input.outcomeId,
          status: input.outcomeStatus,
          reason: input.reason,
          contractId: contract.id,
          planId: plan.id,
        }),
        input.terminatedAt,
      );
      return get(input.workspaceId);
    },
  );

  const transitionExecutionTx = db.transaction(
    (input: TransitionCourseExecutionInput): CourseExecutionState => {
      const current = get(input.workspaceId);
      if (
        current.version !== input.expectedVersion ||
        current.acceptedPlanId !== input.expectedAcceptedPlanId ||
        current.activeAgendaId !== input.expectedAgendaId
      ) {
        throw new Error('Course execution transition is stale.');
      }
      if (input.transition === 'pause' && current.executionStatus !== 'active') {
        throw new Error('Only active Course execution can pause.');
      }
      if (input.transition === 'resume' && current.executionStatus !== 'paused') {
        throw new Error('Only paused Course execution can resume.');
      }
      if (input.transition === 'stop' && current.executionStatus === 'stopped') {
        throw new Error('Course execution is already stopped.');
      }
      if (input.transition === 'resume' && current.routeValidationStatus !== 'valid') {
        throw new Error('A stale Course route must be revalidated before resume.');
      }
      const plan = readPlan(input.expectedAcceptedPlanId);
      if (plan.status !== 'accepted') {
        throw new Error('Execution transitions require the same accepted StudyPlan.');
      }
      const nextStatus: CourseExecutionStatus =
        input.transition === 'pause'
          ? 'paused'
          : input.transition === 'resume'
            ? 'active'
            : 'stopped';
      const resultingVersion = current.version + 1;
      const changed = db
        .prepare(
          `UPDATE course_execution_state
           SET execution_status = ?, version = ?, updated_at = ?
           WHERE workspace_id = ? AND version = ? AND accepted_plan_id = ? AND active_agenda_id = ?`,
        )
        .run(
          nextStatus,
          resultingVersion,
          input.at,
          input.workspaceId,
          current.version,
          input.expectedAcceptedPlanId,
          input.expectedAgendaId,
        ).changes;
      if (changed !== 1) throw new Error('Course execution changed concurrently.');
      const seq = (
        db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS n
             FROM course_execution_events WHERE workspace_id = ?`,
          )
          .get(input.workspaceId) as { n: number }
      ).n;
      db.prepare(
        `INSERT INTO course_execution_events
           (id, workspace_id, seq, event_type, actor, expected_version,
            resulting_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.eventId,
        input.workspaceId,
        seq,
        input.transition === 'pause'
          ? 'execution_paused'
          : input.transition === 'resume'
            ? 'execution_resumed'
            : 'execution_stopped',
        input.actor,
        current.version,
        resultingVersion,
        JSON.stringify({
          acceptedPlanId: input.expectedAcceptedPlanId,
          agendaId: input.expectedAgendaId,
          reason: input.reason,
        }),
        input.at,
      );
      return get(input.workspaceId);
    },
  );

  return {
    get,
    activateRoute: activateRouteTx,
    terminateRoute: terminateRouteTx,
    transitionExecution: transitionExecutionTx,
  };
}

export type CourseExecutionRepo = ReturnType<typeof createCourseExecutionRepo>;
