import { PaceObservationSchema, type PaceObservation } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface PaceObservationRow {
  id: string;
  payload: string;
}

export function createPaceObservationsRepo(db: SqliteDb) {
  function hydrate(row: PaceObservationRow): PaceObservation {
    return PaceObservationSchema.parse(JSON.parse(row.payload) as unknown);
  }
  return {
    create(
      observation: PaceObservation,
      workspaceId: string,
      studyPlanId: string,
    ): PaceObservation {
      const parsed = PaceObservationSchema.parse(observation);
      db.prepare(
        `INSERT INTO pace_observations
           (id, workspace_id, study_plan_id, plan_item_id, planned_minutes, actual_minutes,
            source, measured_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.id,
        workspaceId,
        studyPlanId,
        parsed.planItemId,
        parsed.plannedMinutes,
        parsed.actualMinutes,
        parsed.source,
        parsed.measuredAt,
        JSON.stringify(parsed),
      );
      return parsed;
    },

    listForPlan(studyPlanId: string): PaceObservation[] {
      return (
        db
          .prepare(
            'SELECT id, payload FROM pace_observations WHERE study_plan_id = ? ORDER BY measured_at, id',
          )
          .all(studyPlanId) as PaceObservationRow[]
      ).map(hydrate);
    },

    listForWorkspace(workspaceId: string): PaceObservation[] {
      return (
        db
          .prepare(
            'SELECT id, payload FROM pace_observations WHERE workspace_id = ? ORDER BY measured_at, id',
          )
          .all(workspaceId) as PaceObservationRow[]
      ).map(hydrate);
    },
  };
}

export type PaceObservationsRepo = ReturnType<typeof createPaceObservationsRepo>;
