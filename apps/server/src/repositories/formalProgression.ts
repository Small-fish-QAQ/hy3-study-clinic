import {
  CompletionPolicySchema,
  FormalEvidenceRecordSchema,
  FormalQuestionContractSchema,
  GoalOutcomeSchema,
  ProgressionDecisionSchema,
  ProgressionReconciliationSchema,
  QuestionSchema,
  ReplanTriggerSchema,
  type CompletionPolicy,
  type FormalEvidenceRecord,
  type FormalQuestionContract,
  type GoalOutcome,
  type LearningUnitProgressState,
  type ProgressionDecision,
  type ProgressionReconciliation,
  type ReplanTrigger,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PayloadRow {
  payload: string;
}

export interface LearningUnitProgress {
  workspaceId: string;
  curriculumId: string;
  learningUnitId: string;
  state: LearningUnitProgressState;
  version: number;
  lastDecisionId: string | null;
  updatedAt: string;
}

function parsePayload<T>(row: PayloadRow | undefined, parse: (value: unknown) => T): T | undefined {
  return row ? parse(JSON.parse(row.payload) as unknown) : undefined;
}

/** Formal-evidence linkage and retryable progression persistence. */
export function createFormalProgressionRepo(db: SqliteDb) {
  function questionContract(id: string): FormalQuestionContract | undefined {
    return parsePayload(
      db.prepare('SELECT payload FROM formal_question_contracts WHERE id = ?').get(id) as
        PayloadRow | undefined,
      FormalQuestionContractSchema.parse,
    );
  }

  function evidence(id: string): FormalEvidenceRecord | undefined {
    return parsePayload(
      db.prepare('SELECT payload FROM formal_evidence_records WHERE id = ?').get(id) as
        PayloadRow | undefined,
      FormalEvidenceRecordSchema.parse,
    );
  }

  function reconciliation(id: string): ProgressionReconciliation | undefined {
    return parsePayload(
      db.prepare('SELECT payload FROM progression_reconciliations WHERE id = ?').get(id) as
        PayloadRow | undefined,
      ProgressionReconciliationSchema.parse,
    );
  }

  function decision(id: string): ProgressionDecision | undefined {
    return parsePayload(
      db.prepare('SELECT payload FROM progression_decisions WHERE id = ?').get(id) as
        PayloadRow | undefined,
      ProgressionDecisionSchema.parse,
    );
  }

  function replanTrigger(id: string): ReplanTrigger | undefined {
    return parsePayload(
      db.prepare('SELECT payload FROM replan_triggers WHERE id = ?').get(id) as
        PayloadRow | undefined,
      ReplanTriggerSchema.parse,
    );
  }

  return {
    insertQuestionContracts(inputs: FormalQuestionContract[]): FormalQuestionContract[] {
      const contracts = inputs.map((input) => FormalQuestionContractSchema.parse(input));
      const insert = db.transaction(() => {
        const statement = db.prepare(
          `INSERT INTO formal_question_contracts
             (id, workspace_id, quiz_id, question_id, study_session_id, agenda_item_id,
              learning_unit_id, primary_objective_id, admissibility_tier, contract_id,
              curriculum_id, plan_id, manifest_fingerprint, payload, created_at)
           VALUES (@id, @workspaceId, @quizId, @questionId, @studySessionId, @agendaItemId,
              @curriculumLearningUnitId, @primaryObjectiveId, @admissibilityTier,
              @contractVersionId, @curriculumVersionId, @studyPlanVersionId,
              @executionSourceManifestFingerprint, @payload, @createdAt)`,
        );
        for (const contract of contracts) {
          const questionRow = db
            .prepare('SELECT payload FROM questions WHERE id = ? AND quiz_id = ?')
            .get(contract.questionId, contract.quizId) as PayloadRow | undefined;
          if (!questionRow)
            throw new Error('Formal question contract references an unknown question.');
          const question = QuestionSchema.parse(JSON.parse(questionRow.payload));
          if (
            contract.admissibilityTier !== 'tier_3_advisory' &&
            question.options &&
            question.correctOptionIds
          ) {
            throw new Error(
              'Choice questions remain advisory until the full option set has independently validated classification authority.',
            );
          }
          statement.run({ ...contract, payload: JSON.stringify(contract) });
        }
      });
      insert();
      return contracts;
    },

    getQuestionContract: questionContract,

    listQuestionContractsForQuiz(quizId: string): FormalQuestionContract[] {
      return (
        db
          .prepare(
            `SELECT payload FROM formal_question_contracts
             WHERE quiz_id = ? ORDER BY question_id, id`,
          )
          .all(quizId) as PayloadRow[]
      ).map((row) => FormalQuestionContractSchema.parse(JSON.parse(row.payload)));
    },

    insertEvidence(input: FormalEvidenceRecord): FormalEvidenceRecord {
      const record = FormalEvidenceRecordSchema.parse(input);
      const contract = questionContract(record.formalQuestionContractId);
      if (
        !contract ||
        contract.questionId !== record.questionId ||
        contract.primaryObjectiveId !== record.primaryObjectiveId ||
        contract.curriculumLearningUnitId !== record.curriculumLearningUnitId ||
        contract.admissibilityTier !== record.admissibilityTier ||
        JSON.stringify(
          [...contract.assessmentPremiseBindings.map((binding) => binding.id)].sort(),
        ) !== JSON.stringify([...record.assessmentPremiseBindingIds].sort())
      ) {
        throw new Error('Formal evidence does not match its immutable question contract.');
      }
      db.prepare(
        `INSERT INTO formal_evidence_records
           (id, formal_question_contract_id, grading_result_id, question_id,
            primary_objective_id, learning_unit_id, admissibility_tier,
            state_creditable, payload, created_at)
         VALUES (@id, @formalQuestionContractId, @gradingResultId, @questionId,
            @primaryObjectiveId, @curriculumLearningUnitId, @admissibilityTier,
            @stateCreditable, @payload, @createdAt)`,
      ).run({
        ...record,
        stateCreditable: record.stateCreditable ? 1 : 0,
        payload: JSON.stringify(record),
      });
      return evidence(record.id)!;
    },

    getEvidence: evidence,

    listEvidenceForWorkspace(workspaceId: string): FormalEvidenceRecord[] {
      return (
        db
          .prepare(
            `SELECT e.payload FROM formal_evidence_records e
             JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
             WHERE q.workspace_id = ? ORDER BY e.created_at, e.id`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => FormalEvidenceRecordSchema.parse(JSON.parse(row.payload)));
    },

    listEvidenceForGrading(gradingResultId: string): FormalEvidenceRecord[] {
      return (
        db
          .prepare(
            `SELECT payload FROM formal_evidence_records
             WHERE grading_result_id = ? ORDER BY created_at, id`,
          )
          .all(gradingResultId) as PayloadRow[]
      ).map((row) => FormalEvidenceRecordSchema.parse(JSON.parse(row.payload)));
    },

    listEvidenceForUnit(
      workspaceId: string,
      curriculumId: string,
      learningUnitId: string,
    ): FormalEvidenceRecord[] {
      return (
        db
          .prepare(
            `SELECT e.payload FROM formal_evidence_records e
             JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
             WHERE q.workspace_id = ? AND q.curriculum_id = ? AND e.learning_unit_id = ?
             ORDER BY e.created_at, e.id`,
          )
          .all(workspaceId, curriculumId, learningUnitId) as PayloadRow[]
      ).map((row) => FormalEvidenceRecordSchema.parse(JSON.parse(row.payload)));
    },

    listEvidenceForPlanUnit(
      workspaceId: string,
      curriculumId: string,
      planId: string,
      learningUnitId: string,
    ): FormalEvidenceRecord[] {
      return (
        db
          .prepare(
            `SELECT e.payload FROM formal_evidence_records e
             JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
             WHERE q.workspace_id = ? AND q.curriculum_id = ? AND q.plan_id = ?
               AND e.learning_unit_id = ?
             ORDER BY e.created_at, e.id`,
          )
          .all(workspaceId, curriculumId, planId, learningUnitId) as PayloadRow[]
      ).map((row) => FormalEvidenceRecordSchema.parse(JSON.parse(row.payload)));
    },

    listEvidenceForRoute(contractId: string, planId: string): FormalEvidenceRecord[] {
      return (
        db
          .prepare(
            `SELECT e.payload FROM formal_evidence_records e
             JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
             WHERE q.contract_id = ? AND q.plan_id = ?
             ORDER BY e.created_at, e.id`,
          )
          .all(contractId, planId) as PayloadRow[]
      ).map((row) => FormalEvidenceRecordSchema.parse(JSON.parse(row.payload)));
    },

    insertCompletionPolicy(input: CompletionPolicy): CompletionPolicy {
      const policy = CompletionPolicySchema.parse(input);
      db.prepare(
        `INSERT INTO completion_policy_versions
           (id, contract_id, version, payload, created_at)
         VALUES (@id, @contractVersionId, @version, @payload, @createdAt)`,
      ).run({ ...policy, payload: JSON.stringify(policy) });
      return policy;
    },

    latestCompletionPolicy(contractId: string): CompletionPolicy | undefined {
      return parsePayload(
        db
          .prepare(
            `SELECT payload FROM completion_policy_versions
             WHERE contract_id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(contractId) as PayloadRow | undefined,
        CompletionPolicySchema.parse,
      );
    },

    createReconciliation(input: ProgressionReconciliation): ProgressionReconciliation {
      const record = ProgressionReconciliationSchema.parse(input);
      const existing = db
        .prepare(
          `SELECT payload FROM progression_reconciliations
           WHERE grading_result_id = ? AND completion_policy_id = ?
             AND completion_policy_version = ? AND learning_unit_id = ?`,
        )
        .get(
          record.gradingResultId,
          record.completionPolicyId,
          record.completionPolicyVersion,
          record.curriculumLearningUnitId,
        ) as PayloadRow | undefined;
      if (existing) return ProgressionReconciliationSchema.parse(JSON.parse(existing.payload));
      db.prepare(
        `INSERT INTO progression_reconciliations
           (id, workspace_id, grading_result_id, curriculum_id, plan_id, learning_unit_id, completion_policy_id,
            completion_policy_version, status, decision_id, payload, created_at, updated_at)
         VALUES (@id, @workspaceId, @gradingResultId, @curriculumVersionId, @studyPlanVersionId, @curriculumLearningUnitId,
            @completionPolicyId, @completionPolicyVersion, @status, @decisionId,
            @payload, @createdAt, @updatedAt)`,
      ).run({ ...record, payload: JSON.stringify(record) });
      return reconciliation(record.id)!;
    },

    getReconciliation: reconciliation,

    getDecision: decision,

    updateReconciliation(input: ProgressionReconciliation): ProgressionReconciliation {
      const record = ProgressionReconciliationSchema.parse(input);
      const changed = db
        .prepare(
          `UPDATE progression_reconciliations
           SET status = @status, decision_id = @decisionId, payload = @payload,
               updated_at = @updatedAt WHERE id = @id`,
        )
        .run({ ...record, payload: JSON.stringify(record) }).changes;
      if (changed !== 1) throw new Error('Progression reconciliation does not exist.');
      return record;
    },

    rejectReconciliation(id: string, reason: string, updatedAt: string): ProgressionReconciliation {
      const current = reconciliation(id);
      if (!current) throw new Error('Progression reconciliation does not exist.');
      if (current.status === 'applied') return current;
      const next = ProgressionReconciliationSchema.parse({
        ...current,
        status: 'rejected',
        reason: reason.slice(0, 500),
        updatedAt,
      });
      const changed = db
        .prepare(
          `UPDATE progression_reconciliations
           SET status = @status, payload = @payload, updated_at = @updatedAt
           WHERE id = @id AND status = 'reconciliation_pending'`,
        )
        .run({ ...next, payload: JSON.stringify(next) }).changes;
      if (changed !== 1) {
        const replay = reconciliation(id);
        if (replay) return replay;
        throw new Error('Progression reconciliation changed concurrently.');
      }
      return next;
    },

    listReconciliationsForGrading(gradingResultId: string): ProgressionReconciliation[] {
      return (
        db
          .prepare(
            `SELECT payload FROM progression_reconciliations
             WHERE grading_result_id = ? ORDER BY created_at, id`,
          )
          .all(gradingResultId) as PayloadRow[]
      ).map((row) => ProgressionReconciliationSchema.parse(JSON.parse(row.payload)));
    },

    listReconciliationsForWorkspace(workspaceId: string): ProgressionReconciliation[] {
      return (
        db
          .prepare(
            `SELECT payload FROM progression_reconciliations
             WHERE workspace_id = ? ORDER BY created_at, id`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => ProgressionReconciliationSchema.parse(JSON.parse(row.payload)));
    },

    listDecisionsForWorkspace(workspaceId: string): ProgressionDecision[] {
      return (
        db
          .prepare(
            `SELECT payload FROM progression_decisions
             WHERE workspace_id = ? ORDER BY created_at, id`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => ProgressionDecisionSchema.parse(JSON.parse(row.payload)));
    },

    applyDecision(
      reconciliationId: string,
      input: ProgressionDecision,
      expectedUnitVersion: number,
    ): { reconciliation: ProgressionReconciliation; decision: ProgressionDecision } {
      const parsed = ProgressionDecisionSchema.parse(input);
      const run = db.transaction(() => {
        const currentReconciliation = reconciliation(reconciliationId);
        if (!currentReconciliation) throw new Error('Progression reconciliation does not exist.');
        if (currentReconciliation.status === 'applied') {
          const priorDecision = currentReconciliation.decisionId
            ? decision(currentReconciliation.decisionId)
            : undefined;
          if (!priorDecision) throw new Error('Applied reconciliation is missing its decision.');
          return { reconciliation: currentReconciliation, decision: priorDecision };
        }
        if (currentReconciliation.status !== 'reconciliation_pending') {
          throw new Error('Only a pending progression reconciliation may be applied.');
        }
        if (parsed.evidenceIds.length === 0) {
          throw new Error('A state-changing progression decision requires eligible evidence.');
        }
        const placeholders = parsed.evidenceIds.map(() => '?').join(', ');
        const evidenceScope = db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN e.state_creditable = 1 AND e.admissibility_tier IN
                      ('tier_1_authorized_truth', 'tier_2_validated_representation')
                      THEN 1 ELSE 0 END) AS eligible
             FROM formal_evidence_records e
             JOIN formal_question_contracts q ON q.id = e.formal_question_contract_id
             WHERE e.id IN (${placeholders})
               AND e.learning_unit_id = ?
               AND e.admissibility_tier IN ('tier_1_authorized_truth', 'tier_2_validated_representation')
               AND q.workspace_id = ? AND q.curriculum_id = ? AND q.plan_id = ?`,
          )
          .get(
            ...parsed.evidenceIds,
            parsed.curriculumLearningUnitId,
            parsed.workspaceId,
            currentReconciliation.curriculumVersionId,
            currentReconciliation.studyPlanVersionId,
          ) as {
          total: number;
          eligible: number | null;
        };
        if (
          evidenceScope.total !== parsed.evidenceIds.length ||
          evidenceScope.eligible !== parsed.evidenceIds.length
        ) {
          throw new Error(
            'Progression decisions may cite only admissible state-crediting evidence.',
          );
        }
        const current = db
          .prepare(
            `SELECT state, version FROM learning_unit_progress
             WHERE workspace_id = ? AND curriculum_id = ? AND learning_unit_id = ?`,
          )
          .get(
            parsed.workspaceId,
            currentReconciliation.curriculumVersionId,
            parsed.curriculumLearningUnitId,
          ) as { state: LearningUnitProgressState; version: number } | undefined;
        const version = current?.version ?? 0;
        if (
          version !== expectedUnitVersion ||
          parsed.priorState !== (current?.state ?? 'not_started')
        ) {
          throw new Error('LearningUnit progression projection is stale.');
        }
        db.prepare(
          `INSERT INTO progression_decisions
             (id, workspace_id, learning_unit_id, completion_policy_id,
              completion_policy_version, kind, prior_state, next_state, payload, created_at)
           VALUES (@id, @workspaceId, @curriculumLearningUnitId, @completionPolicyId,
              @completionPolicyVersion, @kind, @priorState, @nextState, @payload, @createdAt)`,
        ).run({ ...parsed, payload: JSON.stringify(parsed) });
        db.prepare(
          `INSERT INTO learning_unit_progress
             (workspace_id, curriculum_id, learning_unit_id, state, version, last_decision_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, curriculum_id, learning_unit_id) DO UPDATE SET
             state = excluded.state, version = excluded.version,
             last_decision_id = excluded.last_decision_id, updated_at = excluded.updated_at`,
        ).run(
          parsed.workspaceId,
          currentReconciliation.curriculumVersionId,
          parsed.curriculumLearningUnitId,
          parsed.nextState,
          version + 1,
          parsed.id,
          parsed.createdAt,
        );
        const applied = ProgressionReconciliationSchema.parse({
          ...currentReconciliation,
          status: 'applied',
          decisionId: parsed.id,
          updatedAt: parsed.createdAt,
        });
        const changed = db
          .prepare(
            `UPDATE progression_reconciliations
           SET status = 'applied', decision_id = ?, payload = ?, updated_at = ?
           WHERE id = ? AND status = 'reconciliation_pending'`,
          )
          .run(parsed.id, JSON.stringify(applied), parsed.createdAt, reconciliationId).changes;
        if (changed !== 1) throw new Error('Progression reconciliation changed concurrently.');
        return { reconciliation: applied, decision: parsed };
      });
      return run();
    },

    getUnitProgress(
      workspaceId: string,
      curriculumId: string,
      learningUnitId: string,
    ): LearningUnitProgress {
      const row = db
        .prepare(
          `SELECT workspace_id, curriculum_id, learning_unit_id, state, version,
                  last_decision_id, updated_at
           FROM learning_unit_progress
           WHERE workspace_id = ? AND curriculum_id = ? AND learning_unit_id = ?`,
        )
        .get(workspaceId, curriculumId, learningUnitId) as
        | {
            workspace_id: string;
            curriculum_id: string;
            learning_unit_id: string;
            state: LearningUnitProgressState;
            version: number;
            last_decision_id: string | null;
            updated_at: string;
          }
        | undefined;
      return row
        ? {
            workspaceId: row.workspace_id,
            curriculumId: row.curriculum_id,
            learningUnitId: row.learning_unit_id,
            state: row.state,
            version: row.version,
            lastDecisionId: row.last_decision_id,
            updatedAt: row.updated_at,
          }
        : {
            workspaceId,
            curriculumId,
            learningUnitId,
            state: 'not_started',
            version: 0,
            lastDecisionId: null,
            updatedAt: new Date(0).toISOString(),
          };
    },

    insertReplanTrigger(input: ReplanTrigger): ReplanTrigger {
      const trigger = ReplanTriggerSchema.parse(input);
      const existing = db
        .prepare(
          `SELECT payload FROM replan_triggers
           WHERE accepted_plan_id = ? AND kind = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .all(trigger.acceptedStudyPlanId, trigger.kind) as PayloadRow[];
      const prior = existing
        .map((row) => ReplanTriggerSchema.parse(JSON.parse(row.payload)))
        .find(
          (candidate) => candidate.reason === trigger.reason && candidate.status !== 'resolved',
        );
      if (prior) return prior;
      db.prepare(
        `INSERT INTO replan_triggers
           (id, workspace_id, accepted_plan_id, kind, status, proposed_plan_id,
            payload, created_at, updated_at)
         VALUES (@id, @workspaceId, @acceptedStudyPlanId, @kind, @status,
            @proposedStudyPlanId, @payload, @createdAt, @updatedAt)`,
      ).run({ ...trigger, payload: JSON.stringify(trigger) });
      return trigger;
    },

    getReplanTrigger: replanTrigger,

    findReplanTriggerByIdentity(
      acceptedStudyPlanId: string,
      kind: ReplanTrigger['kind'],
      reason: string,
    ): ReplanTrigger | undefined {
      const rows = db
        .prepare(
          `SELECT payload FROM replan_triggers
           WHERE accepted_plan_id = ? AND kind = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(acceptedStudyPlanId, kind) as PayloadRow[];
      return rows
        .map((row) => ReplanTriggerSchema.parse(JSON.parse(row.payload)))
        .find((candidate) => candidate.reason === reason);
    },

    findReplanTriggerByProposedPlan(planId: string): ReplanTrigger | undefined {
      return parsePayload(
        db
          .prepare(
            `SELECT payload FROM replan_triggers
             WHERE proposed_plan_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
          )
          .get(planId) as PayloadRow | undefined,
        ReplanTriggerSchema.parse,
      );
    },

    listReplanTriggers(workspaceId: string): ReplanTrigger[] {
      return (
        db
          .prepare(
            `SELECT payload FROM replan_triggers
             WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => ReplanTriggerSchema.parse(JSON.parse(row.payload)));
    },

    updateReplanTrigger(input: ReplanTrigger): ReplanTrigger {
      const trigger = ReplanTriggerSchema.parse(input);
      const changed = db
        .prepare(
          `UPDATE replan_triggers SET status = @status, proposed_plan_id = @proposedStudyPlanId,
             payload = @payload, updated_at = @updatedAt WHERE id = @id`,
        )
        .run({ ...trigger, payload: JSON.stringify(trigger) }).changes;
      if (changed !== 1) throw new Error('Replan trigger does not exist.');
      return trigger;
    },

    insertGoalOutcome(input: GoalOutcome): GoalOutcome {
      const outcome = GoalOutcomeSchema.parse(input);
      const existing = db
        .prepare('SELECT payload FROM goal_outcomes WHERE contract_id = ? AND plan_id = ?')
        .get(outcome.contractVersionId, outcome.studyPlanVersionId) as PayloadRow | undefined;
      if (existing) return GoalOutcomeSchema.parse(JSON.parse(existing.payload));
      db.prepare(
        `INSERT INTO goal_outcomes
           (id, workspace_id, contract_id, plan_id, status, payload, created_at)
         VALUES (@id, @workspaceId, @contractVersionId, @studyPlanVersionId,
            @status, @payload, @createdAt)`,
      ).run({ ...outcome, payload: JSON.stringify(outcome) });
      return outcome;
    },

    getGoalOutcomeForRoute(contractId: string, planId: string): GoalOutcome | undefined {
      return parsePayload(
        db
          .prepare('SELECT payload FROM goal_outcomes WHERE contract_id = ? AND plan_id = ?')
          .get(contractId, planId) as PayloadRow | undefined,
        GoalOutcomeSchema.parse,
      );
    },

    listGoalOutcomes(workspaceId: string): GoalOutcome[] {
      return (
        db
          .prepare(
            `SELECT payload FROM goal_outcomes
             WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`,
          )
          .all(workspaceId) as PayloadRow[]
      ).map((row) => GoalOutcomeSchema.parse(JSON.parse(row.payload)));
    },
  };
}

export type FormalProgressionRepo = ReturnType<typeof createFormalProgressionRepo>;
