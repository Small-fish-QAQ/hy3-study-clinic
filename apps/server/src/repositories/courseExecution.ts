import {
  CurriculumSchema,
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
    if (contract.workspaceId !== input.workspaceId || contract.status !== 'learner_confirmed') {
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
    if (current.acceptedPlanId && plan.predecessorId !== current.acceptedPlanId) {
      throw new Error(
        'Successor StudyPlan must identify the currently accepted Plan as predecessor.',
      );
    }
    if (current.activeContractId && contract.predecessorId !== current.activeContractId) {
      throw new Error('Successor Contract must identify the active Contract as predecessor.');
    }
    if (current.activeCurriculumId && curriculum.predecessorId !== current.activeCurriculumId) {
      throw new Error('Successor Curriculum must identify the active Curriculum as predecessor.');
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

  function addEvent(input: ActivateCourseRouteInput, resultingVersion: number): void {
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

      if (current.activeContractId) {
        const oldContract = readContract(current.activeContractId);
        db.prepare(
          `UPDATE learning_contract_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...oldContract, status: 'superseded' }), oldContract.id);
      }
      if (current.activeCurriculumId) {
        const oldCurriculum = readCurriculum(current.activeCurriculumId);
        db.prepare(
          `UPDATE curriculum_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...oldCurriculum, status: 'superseded' }), oldCurriculum.id);
      }
      if (current.acceptedPlanId) {
        const oldPlan = readPlan(current.acceptedPlanId);
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
      addEvent(input, resultingVersion);
      return get(input.workspaceId);
    },
  );

  return {
    get,
    activateRoute: activateRouteTx,
  };
}

export type CourseExecutionRepo = ReturnType<typeof createCourseExecutionRepo>;
