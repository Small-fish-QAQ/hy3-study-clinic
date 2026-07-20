import {
  ReviewEventSchema,
  ReviewItemSchema,
  type ReviewEvent,
  type ReviewItem,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface ItemRow {
  workspace_id: string;
  concept_id: string;
  concept_name: string;
  stability: number;
  difficulty: number;
  due_at: string;
  last_reviewed_at: string;
  interval_days: number;
  review_count: number;
  lapse_count: number;
  last_rating: string;
  scheduler_version: string;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: ItemRow): ReviewItem {
  return ReviewItemSchema.parse({
    workspaceId: row.workspace_id,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    stability: row.stability,
    difficulty: row.difficulty,
    dueAt: row.due_at,
    lastReviewedAt: row.last_reviewed_at,
    intervalDays: row.interval_days,
    reviewCount: row.review_count,
    lapseCount: row.lapse_count,
    lastRating: row.last_rating,
    schedulerVersion: row.scheduler_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createReviewRepo(db: SqliteDb) {
  return {
    get(workspaceId: string, conceptId: string): ReviewItem | undefined {
      const row = db
        .prepare('SELECT * FROM review_items WHERE workspace_id = ? AND concept_id = ?')
        .get(workspaceId, conceptId) as ItemRow | undefined;
      return row ? rowToItem(row) : undefined;
    },

    listByWorkspace(workspaceId: string): ReviewItem[] {
      const rows = db
        .prepare(
          'SELECT * FROM review_items WHERE workspace_id = ? ORDER BY due_at ASC, concept_id ASC',
        )
        .all(workspaceId) as ItemRow[];
      return rows.map(rowToItem);
    },

    upsert(item: ReviewItem): void {
      ReviewItemSchema.parse(item);
      db.prepare(
        `INSERT INTO review_items
           (workspace_id, concept_id, concept_name, stability, difficulty, due_at,
            last_reviewed_at, interval_days, review_count, lapse_count, last_rating,
            scheduler_version, created_at, updated_at)
         VALUES
           (@workspaceId, @conceptId, @conceptName, @stability, @difficulty, @dueAt,
            @lastReviewedAt, @intervalDays, @reviewCount, @lapseCount, @lastRating,
            @schedulerVersion, @createdAt, @updatedAt)
         ON CONFLICT (workspace_id, concept_id) DO UPDATE SET
           concept_name = excluded.concept_name,
           stability = excluded.stability,
           difficulty = excluded.difficulty,
           due_at = excluded.due_at,
           last_reviewed_at = excluded.last_reviewed_at,
           interval_days = excluded.interval_days,
           review_count = excluded.review_count,
           lapse_count = excluded.lapse_count,
           last_rating = excluded.last_rating,
           scheduler_version = excluded.scheduler_version,
           updated_at = excluded.updated_at`,
      ).run({
        workspaceId: item.workspaceId,
        conceptId: item.conceptId,
        conceptName: item.conceptName,
        stability: item.stability,
        difficulty: item.difficulty,
        dueAt: item.dueAt,
        lastReviewedAt: item.lastReviewedAt,
        intervalDays: item.intervalDays,
        reviewCount: item.reviewCount,
        lapseCount: item.lapseCount,
        lastRating: item.lastRating,
        schedulerVersion: item.schedulerVersion,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    },

    insertEvent(event: ReviewEvent): void {
      ReviewEventSchema.parse(event);
      db.prepare(
        `INSERT INTO review_events (id, workspace_id, concept_id, quiz_id, rating, score, interval_days, due_at, created_at)
         VALUES (@id, @workspaceId, @conceptId, @quizId, @rating, @score, @intervalDays, @dueAt, @createdAt)`,
      ).run({
        id: event.id,
        workspaceId: event.workspaceId,
        conceptId: event.conceptId,
        quizId: event.quizId,
        rating: event.rating,
        score: event.score,
        intervalDays: event.intervalDays,
        dueAt: event.dueAt,
        createdAt: event.createdAt,
      });
    },

    listEvents(workspaceId: string, conceptId: string): ReviewEvent[] {
      const rows = db
        .prepare(
          `SELECT * FROM review_events WHERE workspace_id = ? AND concept_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId, conceptId) as Array<{
        id: string;
        workspace_id: string;
        concept_id: string;
        quiz_id: string | null;
        rating: string;
        score: number;
        interval_days: number;
        due_at: string;
        created_at: string;
      }>;
      return rows.map((row) =>
        ReviewEventSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          conceptId: row.concept_id,
          quizId: row.quiz_id,
          rating: row.rating,
          score: row.score,
          intervalDays: row.interval_days,
          dueAt: row.due_at,
          createdAt: row.created_at,
        }),
      );
    },
  };
}

export type ReviewRepo = ReturnType<typeof createReviewRepo>;
