import { ratingForScore, type ReviewEvent, type ReviewItem, type Quiz } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { SCHEDULER_VERSION, scheduleFirst, scheduleNext } from '../review/scheduler.js';

export interface ReviewServiceDeps {
  repos: Repositories;
  clock: Clock;
}

export interface ScheduledConcept {
  conceptId: string;
  conceptName: string;
  rating: string;
  dueAt: string;
}

/**
 * Deterministic review scheduling service.
 *
 * The ONLY entry point that advances scheduler state is
 * `recordGradedOutcomes`, called by the grading service after a submission
 * has been fully graded and persisted — a completed graded learning event.
 * Nothing else (and never the model or the Tutor) may set review dates.
 * Review state is intentionally independent from mastery: neither value is
 * derived from or written into the other.
 */
export function createReviewService({ repos, clock }: ReviewServiceDeps) {
  return {
    /**
     * Advance (or create) the review item of every assessed concept using
     * the deterministic score → rating mapping. Returns what was scheduled
     * so the grading result can explain it.
     */
    recordGradedOutcomes(
      quiz: Quiz,
      conceptScores: Map<string, { name: string; materialId: string; scores: number[] }>,
      at: string,
    ): ScheduledConcept[] {
      const now = clock.now();
      const scheduled: ScheduledConcept[] = [];

      for (const [conceptId, { name, materialId, scores }] of conceptScores) {
        if (scores.length === 0) continue;
        // review_items enforces a real concept FK — a question whose concept
        // row disappeared mid-flight has no long-term memory state to update.
        if (!repos.materials.getConcept(conceptId)) continue;
        const workspaceId = quiz.workspaceId ?? repos.materials.get(materialId)?.workspaceId;
        if (!workspaceId) continue;

        const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
        const rating = ratingForScore(avgScore);
        const existing = repos.review.get(workspaceId, conceptId);
        const next = existing
          ? scheduleNext(
              { stability: existing.stability, difficulty: existing.difficulty },
              rating,
              now,
            )
          : scheduleFirst(rating, now);

        const item: ReviewItem = {
          workspaceId,
          conceptId,
          conceptName: name,
          stability: next.stability,
          difficulty: next.difficulty,
          dueAt: next.dueAt,
          lastReviewedAt: at,
          intervalDays: next.intervalDays,
          reviewCount: (existing?.reviewCount ?? 0) + 1,
          lapseCount: (existing?.lapseCount ?? 0) + (next.isLapse && existing ? 1 : 0),
          lastRating: rating,
          schedulerVersion: SCHEDULER_VERSION,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        repos.review.upsert(item);

        const event: ReviewEvent = {
          id: newId('rev'),
          workspaceId,
          conceptId,
          quizId: quiz.id,
          rating,
          score: Math.round(avgScore * 10_000) / 10_000,
          intervalDays: next.intervalDays,
          dueAt: next.dueAt,
          createdAt: at,
        };
        repos.review.insertEvent(event);

        scheduled.push({ conceptId, conceptName: name, rating, dueAt: next.dueAt });
      }
      return scheduled;
    },

    listByWorkspace(workspaceId: string): ReviewItem[] {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      return repos.review.listByWorkspace(workspaceId);
    },

    listEvents(workspaceId: string, conceptId: string): ReviewEvent[] {
      return repos.review.listEvents(workspaceId, conceptId);
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
