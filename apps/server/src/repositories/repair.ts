import {
  RepairEpisodeSchema,
  RepairPacketSchema,
  RepairPracticeEventSchema,
  RepairStatusTransitionSchema,
  type RepairEpisode,
  type RepairPacket,
  type RepairPracticeEvent,
  type RepairStatusTransition,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PayloadRow {
  payload: string;
}

export function createRepairRepo(db: SqliteDb) {
  const getEpisode = (id: string): RepairEpisode | undefined => {
    const row = db
      .prepare(
        `SELECT json_object(
      'id', id, 'workspaceId', workspace_id, 'triggerGradeRecordId', trigger_grade_record_id,
      'triggerAttemptId', trigger_attempt_id, 'assessmentVersionId', assessment_version_id,
      'itemId', item_id, 'targetLearningUnitId', target_learning_unit_id,
      'diagnosticCategory', diagnostic_category, 'affectedCriterionIds', affected_criterion_ids,
      'gapSummary', gap_summary, 'status', status, 'attemptCount', attempt_count,
      'verificationAttemptId', verification_attempt_id, 'resolvedEvidenceId', resolved_evidence_id,
      'createdAt', created_at, 'updatedAt', updated_at) AS payload
      FROM repair_episodes WHERE id = ?`,
      )
      .get(id) as PayloadRow | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.payload) as Record<string, unknown>;
    return RepairEpisodeSchema.parse({
      ...value,
      affectedCriterionIds: JSON.parse(String(value.affectedCriterionIds)),
    });
  };
  return {
    getEpisode,
    findByTriggerGrade(gradeId: string): RepairEpisode | undefined {
      const row = db
        .prepare('SELECT id FROM repair_episodes WHERE trigger_grade_record_id = ?')
        .get(gradeId) as { id: string } | undefined;
      return row ? getEpisode(row.id) : undefined;
    },
    listByWorkspace(workspaceId: string): RepairEpisode[] {
      return (
        db
          .prepare(
            'SELECT id FROM repair_episodes WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC',
          )
          .all(workspaceId) as Array<{ id: string }>
      )
        .map((row) => getEpisode(row.id)!)
        .filter(Boolean);
    },
    insertEpisode(input: RepairEpisode): RepairEpisode {
      const item = RepairEpisodeSchema.parse(input);
      db.prepare(
        `INSERT INTO repair_episodes
        (id, workspace_id, trigger_grade_record_id, trigger_attempt_id, assessment_version_id,
         item_id, target_learning_unit_id, diagnostic_category, affected_criterion_ids,
         gap_summary, status, attempt_count, verification_attempt_id, resolved_evidence_id,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceId,
        item.triggerGradeRecordId,
        item.triggerAttemptId,
        item.assessmentVersionId,
        item.itemId,
        item.targetLearningUnitId,
        item.diagnosticCategory,
        JSON.stringify(item.affectedCriterionIds),
        item.gapSummary,
        item.status,
        item.attemptCount,
        item.verificationAttemptId,
        item.resolvedEvidenceId,
        item.createdAt,
        item.updatedAt,
      );
      return item;
    },
    updateEpisode(input: RepairEpisode): RepairEpisode {
      const item = RepairEpisodeSchema.parse(input);
      const changed = db
        .prepare(
          `UPDATE repair_episodes SET status = ?, attempt_count = ?,
        verification_attempt_id = ?, resolved_evidence_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          item.status,
          item.attemptCount,
          item.verificationAttemptId,
          item.resolvedEvidenceId,
          item.updatedAt,
          item.id,
        ).changes;
      if (changed !== 1) throw new Error('Repair episode does not exist.');
      return getEpisode(item.id)!;
    },
    insertPacket(input: RepairPacket): RepairPacket {
      const item = RepairPacketSchema.parse(input);
      const existing = db
        .prepare('SELECT payload FROM repair_packets WHERE generation_key = ?')
        .get(item.generationKey) as PayloadRow | undefined;
      if (existing) return RepairPacketSchema.parse(JSON.parse(existing.payload));
      db.prepare(
        `INSERT INTO repair_packets
        (id, episode_id, generation_key, provider, provider_model, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.episodeId,
        item.generationKey,
        item.provider,
        item.providerModel,
        JSON.stringify(item),
        item.createdAt,
      );
      return item;
    },
    listPackets(episodeId: string): RepairPacket[] {
      return (
        db
          .prepare(
            'SELECT payload FROM repair_packets WHERE episode_id = ? ORDER BY created_at, id',
          )
          .all(episodeId) as PayloadRow[]
      ).map((row) => RepairPacketSchema.parse(JSON.parse(row.payload)));
    },
    insertPractice(input: RepairPracticeEvent): RepairPracticeEvent {
      const item = RepairPracticeEventSchema.parse(input);
      db.prepare(
        `INSERT INTO repair_practice_events
        (id, episode_id, ordinal, response_summary, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.episodeId,
        item.ordinal,
        item.responseSummary,
        item.outcome,
        item.createdAt,
      );
      return item;
    },
    nextPracticeOrdinal(episodeId: string): number {
      const row = db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) AS n FROM repair_practice_events WHERE episode_id = ?',
        )
        .get(episodeId) as { n: number };
      return row.n + 1;
    },
    listPractice(episodeId: string): RepairPracticeEvent[] {
      return (
        db
          .prepare(
            `SELECT json_object('id', id, 'episodeId', episode_id, 'ordinal', ordinal,
        'responseSummary', response_summary, 'outcome', outcome, 'createdAt', created_at) AS payload
        FROM repair_practice_events WHERE episode_id = ? ORDER BY ordinal`,
          )
          .all(episodeId) as PayloadRow[]
      ).map((row) => RepairPracticeEventSchema.parse(JSON.parse(row.payload)));
    },
    insertTransition(input: RepairStatusTransition): RepairStatusTransition {
      const item = RepairStatusTransitionSchema.parse(input);
      db.prepare(
        `INSERT INTO repair_status_events
        (id, episode_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(item.id, item.episodeId, item.from, item.to, item.reason, item.createdAt);
      return item;
    },
    listTransitions(episodeId: string): RepairStatusTransition[] {
      return (
        db
          .prepare(
            `SELECT json_object('id', id, 'episodeId', episode_id, 'from', from_status,
        'to', to_status, 'reason', reason, 'createdAt', created_at) AS payload
        FROM repair_status_events WHERE episode_id = ? ORDER BY created_at, id`,
          )
          .all(episodeId) as PayloadRow[]
      ).map((row) => RepairStatusTransitionSchema.parse(JSON.parse(row.payload)));
    },
  };
}

export type RepairRepo = ReturnType<typeof createRepairRepo>;
