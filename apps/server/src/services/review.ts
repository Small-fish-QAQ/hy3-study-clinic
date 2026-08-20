import { type ReviewEvent, type ReviewItem, type Quiz } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';

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
export function createReviewService({ repos }: ReviewServiceDeps) {
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
      // Deliberately disabled after the Phase 8B cutover. Legacy tables are
      // retained as immutable audit history and are never active writers.
      void quiz;
      void conceptScores;
      void at;
      return [];
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
