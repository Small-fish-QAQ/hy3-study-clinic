import {
  AgendaLaunchCapabilitySchema,
  PaceBaselineSchema,
  StudyPlanProgressStateSchema,
  StudyPlanSchema,
  type AgendaLaunchCapability,
  type StudyPlan,
  type StudyPlanProgressState,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PlanRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  curriculum_id: string;
  manifest_fingerprint: string;
  version: number;
  predecessor_id: string | null;
  status: StudyPlan['status'];
  payload: string;
  created_at: string;
  learner_accepted_at: string | null;
}

interface ProgressRow {
  plan_item_id: string;
  state: StudyPlanProgressState;
  version: number;
  updated_at: string;
}

export interface PlanLaunchValidation {
  planItemId: string;
  launch: AgendaLaunchCapability;
  sourceFingerprint: string;
  validatedAt: string;
}

export interface StudyPlanEventInput {
  id: string;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface StudyPlanProgressRecord {
  planId: string;
  planItemId: string;
  state: StudyPlanProgressState;
  version: number;
  updatedAt: string;
}

function hydrate(row: PlanRow): StudyPlan {
  return StudyPlanSchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    workspaceId: row.workspace_id,
    contractVersionId: row.contract_id,
    curriculumVersionId: row.curriculum_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    version: row.version,
    predecessorId: row.predecessor_id,
    status: row.status,
    learnerAcceptedAt: row.learner_accepted_at,
    createdAt: row.created_at,
  });
}

export function createStudyPlansRepo(db: SqliteDb) {
  function get(id: string): StudyPlan | undefined {
    const row = db.prepare('SELECT * FROM study_plan_versions WHERE id = ?').get(id) as
      PlanRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function appendEvent(planId: string, event: StudyPlanEventInput): void {
    const seq = (
      db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS n
           FROM study_plan_events WHERE plan_id = ?`,
        )
        .get(planId) as { n: number }
    ).n;
    db.prepare(
      `INSERT INTO study_plan_events
         (id, plan_id, seq, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      planId,
      seq,
      event.eventType,
      event.actor,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  function validateReferences(plan: StudyPlan): void {
    const contract = db
      .prepare('SELECT workspace_id FROM learning_contract_versions WHERE id = ?')
      .get(plan.contractVersionId) as { workspace_id: string } | undefined;
    const curriculum = db
      .prepare(
        `SELECT workspace_id, contract_id, manifest_fingerprint
         FROM curriculum_versions WHERE id = ?`,
      )
      .get(plan.curriculumVersionId) as
      { workspace_id: string; contract_id: string; manifest_fingerprint: string } | undefined;
    if (!contract || contract.workspace_id !== plan.workspaceId) {
      throw new Error('StudyPlan Contract does not belong to this Course.');
    }
    if (
      !curriculum ||
      curriculum.workspace_id !== plan.workspaceId ||
      curriculum.contract_id !== plan.contractVersionId ||
      curriculum.manifest_fingerprint !== plan.executionSourceManifestFingerprint
    ) {
      throw new Error('StudyPlan is incompatible with its Curriculum or source manifest.');
    }

    const itemIds = new Set(plan.items.map((item) => item.id));
    if (itemIds.size !== plan.items.length) throw new Error('StudyPlan item IDs must be unique.');
    if (new Set(plan.items.map((item) => item.index)).size !== plan.items.length) {
      throw new Error('StudyPlan item indexes must be unique.');
    }
    for (const item of plan.items) {
      for (const prerequisiteId of item.prerequisitePlanItemIds) {
        if (!itemIds.has(prerequisiteId))
          throw new Error('StudyPlan prerequisite item is unknown.');
      }
      if (item.curriculumLearningUnitId) {
        const unit = db
          .prepare(
            `SELECT 1 FROM curriculum_node_index
             WHERE curriculum_id = ? AND node_id = ? AND kind = 'learning_unit'`,
          )
          .get(plan.curriculumVersionId, item.curriculumLearningUnitId);
        if (!unit) throw new Error('StudyPlan references an unknown LearningUnit.');
      }
      const objectiveIds = new Set(item.objectiveIds);
      for (const objectiveId of item.objectiveIds) {
        const objective = db
          .prepare(
            `SELECT truth_premise_status FROM curriculum_objective_index
             WHERE curriculum_id = ? AND objective_id = ?`,
          )
          .get(plan.curriculumVersionId, objectiveId) as
          { truth_premise_status: string } | undefined;
        if (!objective) throw new Error('StudyPlan references an unknown objective.');
      }
      for (const requirement of item.completionRequirements) {
        for (const objectiveId of requirement.objectiveIds) {
          if (!objectiveIds.has(objectiveId)) {
            throw new Error('Completion requirement escapes its Plan item objective scope.');
          }
          const objective = db
            .prepare(
              `SELECT truth_premise_status FROM curriculum_objective_index
               WHERE curriculum_id = ? AND objective_id = ?`,
            )
            .get(plan.curriculumVersionId, objectiveId) as {
            truth_premise_status: string;
          };
          if (requirement.blocking && objective.truth_premise_status !== 'independently_verified') {
            throw new Error('Truth-unverified objectives cannot have blocking Plan requirements.');
          }
        }
      }
    }
    for (const deferral of plan.deferrals) {
      const unit = db
        .prepare(
          `SELECT 1 FROM curriculum_node_index
           WHERE curriculum_id = ? AND node_id = ? AND kind = 'learning_unit'`,
        )
        .get(plan.curriculumVersionId, deferral.curriculumLearningUnitId);
      if (!unit) throw new Error('StudyPlan defers an unknown LearningUnit.');
      for (const riskId of deferral.riskIds) {
        const risk = db
          .prepare(
            `SELECT payload FROM coverage_risk_entries
             WHERE id = ? AND contract_id = ?`,
          )
          .get(riskId, plan.contractVersionId) as { payload: string } | undefined;
        const riskPayload = risk
          ? (JSON.parse(risk.payload) as {
              facets?: string[];
              origin?: string;
              status?: string;
              referencedCurriculumNodeIds?: string[];
            })
          : undefined;
        const acceptedDeferral =
          riskPayload?.facets?.includes('intentionally_deferred') &&
          riskPayload.status === 'deferred';
        const pendingRecommendation =
          riskPayload?.facets?.includes('planning_recommendation') &&
          riskPayload.status === 'planned';
        if (
          (!acceptedDeferral && !pendingRecommendation) ||
          riskPayload?.origin !== 'deterministic' ||
          !riskPayload.referencedCurriculumNodeIds?.includes(deferral.curriculumLearningUnitId)
        ) {
          throw new Error('A Plan deferral requires a visible deterministic deferral risk.');
        }
      }
    }
    if (plan.paceBaseline) {
      const baseline = PaceBaselineSchema.parse(plan.paceBaseline);
      if (
        baseline.contractVersionId !== plan.contractVersionId ||
        baseline.studyPlanVersionId !== plan.id
      ) {
        throw new Error('PaceBaseline identity does not match its StudyPlan.');
      }
    }
  }

  const createVersionTx = db.transaction(
    (
      planInput: StudyPlan,
      launchInput: PlanLaunchValidation[],
      event: StudyPlanEventInput,
    ): StudyPlan => {
      const plan = StudyPlanSchema.parse(planInput);
      if (plan.status === 'accepted') {
        throw new Error('StudyPlan acceptance belongs to atomic Course route activation.');
      }
      validateReferences(plan);
      const latest = db
        .prepare(
          `SELECT id, version FROM study_plan_versions
           WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(plan.workspaceId) as { id: string; version: number } | undefined;
      if (plan.version !== (latest?.version ?? 0) + 1) {
        throw new Error('StudyPlan version is stale.');
      }
      if (plan.predecessorId !== null) {
        const predecessor = get(plan.predecessorId);
        if (
          !predecessor ||
          predecessor.workspaceId !== plan.workspaceId ||
          predecessor.version >= plan.version
        ) {
          throw new Error('StudyPlan predecessor is invalid.');
        }
      } else if (latest) {
        throw new Error('A successor StudyPlan requires an explicit predecessor.');
      }
      const launchByItem = new Map(
        launchInput.map((entry) => [
          entry.planItemId,
          { ...entry, launch: AgendaLaunchCapabilitySchema.parse(entry.launch) },
        ]),
      );
      if (
        launchByItem.size !== plan.items.length ||
        plan.items.some((item) => !launchByItem.has(item.id))
      ) {
        throw new Error('Every StudyPlan item requires exactly one launchability validation.');
      }
      db.prepare(
        `INSERT INTO study_plan_versions
           (id, workspace_id, contract_id, curriculum_id, manifest_fingerprint,
            version, predecessor_id, status, payload, created_at, learner_accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        plan.id,
        plan.workspaceId,
        plan.contractVersionId,
        plan.curriculumVersionId,
        plan.executionSourceManifestFingerprint,
        plan.version,
        plan.predecessorId,
        plan.status,
        JSON.stringify(plan),
        plan.createdAt,
        plan.learnerAcceptedAt,
      );
      const insertItem = db.prepare(
        `INSERT INTO study_plan_items
           (plan_id, plan_item_id, idx, kind, curriculum_learning_unit_id,
            objective_ids, completion_requirements)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertLaunch = db.prepare(
        `INSERT INTO study_plan_launch_validations
           (plan_id, plan_item_id, status, capability, resource_id, reason,
            source_fingerprint, validated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertProgress = db.prepare(
        `INSERT INTO study_plan_progress
           (plan_id, plan_item_id, state, version, updated_at)
         VALUES (?, ?, 'not_started', 1, ?)`,
      );
      for (const item of plan.items) {
        insertItem.run(
          plan.id,
          item.id,
          item.index,
          item.kind,
          item.curriculumLearningUnitId,
          JSON.stringify(item.objectiveIds),
          JSON.stringify(item.completionRequirements),
        );
        const validation = launchByItem.get(item.id)!;
        insertLaunch.run(
          plan.id,
          item.id,
          validation.launch.status,
          validation.launch.capability,
          validation.launch.resourceId,
          validation.launch.reason,
          validation.sourceFingerprint,
          validation.validatedAt,
        );
        insertProgress.run(plan.id, item.id, plan.createdAt);
      }
      const insertDeferral = db.prepare(
        `INSERT INTO study_plan_deferrals
           (plan_id, curriculum_learning_unit_id, objective_ids, reason, risk_ids)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const deferral of plan.deferrals) {
        insertDeferral.run(
          plan.id,
          deferral.curriculumLearningUnitId,
          JSON.stringify(deferral.objectiveIds),
          deferral.reason,
          JSON.stringify(deferral.riskIds),
        );
      }
      if (plan.paceBaseline) {
        db.prepare(
          `INSERT INTO pace_baselines
             (id, plan_id, contract_id, policy_version, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          plan.paceBaseline.id,
          plan.id,
          plan.contractVersionId,
          plan.paceBaseline.policyVersion,
          JSON.stringify(plan.paceBaseline),
          plan.createdAt,
        );
      }
      appendEvent(plan.id, event);
      return get(plan.id)!;
    },
  );

  const rejectTx = db.transaction((id: string, event: StudyPlanEventInput) => {
    const current = get(id);
    if (!current || (current.status !== 'candidate' && current.status !== 'proposed')) {
      throw new Error('Only an unaccepted StudyPlan may be rejected.');
    }
    const rejected = StudyPlanSchema.parse({ ...current, status: 'rejected' });
    const changed = db
      .prepare(
        `UPDATE study_plan_versions SET status = 'rejected', payload = ?
         WHERE id = ? AND status IN ('candidate', 'proposed')`,
      )
      .run(JSON.stringify(rejected), id).changes;
    if (changed !== 1) throw new Error('StudyPlan changed concurrently.');
    appendEvent(id, event);
    return get(id)!;
  });

  const updateProgressTx = db.transaction(
    (
      planId: string,
      planItemId: string,
      expectedVersion: number,
      state: StudyPlanProgressState,
      eventId: string,
      reason: string,
      at: string,
    ): StudyPlanProgressRecord => {
      const nextState = StudyPlanProgressStateSchema.parse(state);
      const current = db
        .prepare(`SELECT * FROM study_plan_progress WHERE plan_id = ? AND plan_item_id = ?`)
        .get(planId, planItemId) as ProgressRow | undefined;
      if (!current || current.version !== expectedVersion) {
        throw new Error('StudyPlan progress version is stale.');
      }
      const nextVersion = current.version + 1;
      const changed = db
        .prepare(
          `UPDATE study_plan_progress
           SET state = ?, version = ?, updated_at = ?
           WHERE plan_id = ? AND plan_item_id = ? AND version = ?`,
        )
        .run(nextState, nextVersion, at, planId, planItemId, expectedVersion).changes;
      if (changed !== 1) throw new Error('StudyPlan progress changed concurrently.');
      const seq = (
        db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM study_plan_progress_events
             WHERE plan_id = ? AND plan_item_id = ?`,
          )
          .get(planId, planItemId) as { n: number }
      ).n;
      db.prepare(
        `INSERT INTO study_plan_progress_events
           (id, plan_id, plan_item_id, seq, from_state, to_state, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId, planId, planItemId, seq, current.state, nextState, reason, at);
      return { planId, planItemId, state: nextState, version: nextVersion, updatedAt: at };
    },
  );

  return {
    get,

    listLaunchValidations(planId: string): PlanLaunchValidation[] {
      return (
        db
          .prepare(
            `SELECT plan_item_id, status, capability, resource_id, reason,
                    source_fingerprint, validated_at
             FROM study_plan_launch_validations
             WHERE plan_id = ? ORDER BY plan_item_id`,
          )
          .all(planId) as Array<{
          plan_item_id: string;
          status: AgendaLaunchCapability['status'];
          capability: string;
          resource_id: string | null;
          reason: string | null;
          source_fingerprint: string;
          validated_at: string;
        }>
      ).map((row) => ({
        planItemId: row.plan_item_id,
        launch: AgendaLaunchCapabilitySchema.parse({
          status: row.status,
          capability: row.capability,
          resourceId: row.resource_id,
          reason: row.reason,
        }),
        sourceFingerprint: row.source_fingerprint,
        validatedAt: row.validated_at,
      }));
    },
    createVersion: createVersionTx,
    reject: rejectTx,
    updateProgress: updateProgressTx,

    list(workspaceId: string): StudyPlan[] {
      return (
        db
          .prepare(`SELECT * FROM study_plan_versions WHERE workspace_id = ? ORDER BY version ASC`)
          .all(workspaceId) as PlanRow[]
      ).map(hydrate);
    },

    listProgress(planId: string): StudyPlanProgressRecord[] {
      return (
        db
          .prepare(`SELECT * FROM study_plan_progress WHERE plan_id = ? ORDER BY plan_item_id`)
          .all(planId) as ProgressRow[]
      ).map((row) => ({
        planId,
        planItemId: row.plan_item_id,
        state: row.state,
        version: row.version,
        updatedAt: row.updated_at,
      }));
    },
  };
}

export type StudyPlansRepo = ReturnType<typeof createStudyPlansRepo>;
