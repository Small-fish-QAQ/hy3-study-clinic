import type { DailyQueueItem } from '@hy3-clinic/shared';
import { WEAK_MASTERY_THRESHOLD } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import { overdueDays } from '../review/scheduler.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';

export interface QueueServiceDeps {
  repos: Repositories;
  clock: Clock;
}

/** Maximum entries in the daily learning queue. */
export const MAX_QUEUE_ITEMS = 8;

/**
 * The deterministic daily learning queue.
 *
 * Priority rules (explicit, in order, each tier internally deterministic):
 * 1. overdue review items          — most overdue first;
 * 2. confirmed misconception repair — oldest confirmed first;
 * 3. concepts with open mistakes    — most open mistakes first;
 * 4. weak prerequisites             — prerequisites (in the active graph) of
 *                                     weak concepts that are themselves weak
 *                                     or unassessed;
 * 5. reviews due today              — soonest due first.
 *
 * One concept appears at most once (highest tier wins). No time estimates
 * are invented — the queue reports facts (counts, overdue days) only.
 */
export function createQueueService({ repos, clock }: QueueServiceDeps) {
  return {
    dailyQueue(workspaceId: string): DailyQueueItem[] {
      if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
      const now = clock.now();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const items: DailyQueueItem[] = [];
      const usedConcepts = new Set<string>();
      const push = (item: DailyQueueItem) => {
        if (items.length >= MAX_QUEUE_ITEMS || usedConcepts.has(item.conceptId)) return;
        usedConcepts.add(item.conceptId);
        items.push(item);
      };

      // 1. Overdue reviews, most overdue first.
      const reviewItems = repos.review.listByWorkspace(workspaceId);
      const overdue = reviewItems
        .map((item) => ({ item, days: overdueDays(item.dueAt, now) }))
        .filter(({ item, days }) => days > 0 || new Date(item.dueAt).getTime() <= now.getTime())
        .sort((a, b) => b.days - a.days || a.item.conceptId.localeCompare(b.item.conceptId));
      for (const { item, days } of overdue) {
        push({
          kind: 'overdue_review',
          conceptId: item.conceptId,
          conceptName: item.conceptName,
          misconceptionId: null,
          reason:
            days >= 1
              ? `复习已过期 ${Math.floor(days)} 天(上次评级:${item.lastRating})。`
              : '复习已到期,建议今天完成一次检索练习。',
          overdueDays: days,
        });
      }

      // 2. Confirmed misconception repair, oldest first.
      const confirmed = repos.misconceptions
        .listByWorkspace(workspaceId, 'confirmed')
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      for (const record of confirmed) {
        push({
          kind: 'misconception_repair',
          conceptId: record.conceptId,
          conceptName: record.conceptName,
          misconceptionId: record.id,
          reason: `已确认的误区待修复:${record.hypothesis.slice(0, 80)}`,
          overdueDays: 0,
        });
      }

      // 3. Open mistakes, most first.
      const mistakeCounts = [...repos.mistakes.countsByConceptForWorkspace(workspaceId).entries()]
        .filter(([, counts]) => counts.open > 0)
        .sort((a, b) => b[1].open - a[1].open || a[0].localeCompare(b[0]));
      for (const [conceptId, counts] of mistakeCounts) {
        const concept = repos.materials.getConcept(conceptId);
        if (!concept) continue;
        push({
          kind: 'open_mistakes',
          conceptId,
          conceptName: concept.name,
          misconceptionId: null,
          reason: `有 ${counts.open} 道未解决错题。`,
          overdueDays: 0,
        });
      }

      // 4. Weak prerequisites of weak concepts (active graph only).
      const workspace = repos.workspaces.get(workspaceId)!;
      if (workspace.activeGraphVersionId) {
        const masteryByConcept = new Map(
          repos.mastery.listByWorkspace(workspaceId).map((m) => [m.conceptId, m]),
        );
        const openByConcept = repos.mistakes.countsByConceptForWorkspace(workspaceId);
        const isWeak = (conceptId: string) => {
          const mastery = masteryByConcept.get(conceptId);
          const open = openByConcept.get(conceptId)?.open ?? 0;
          return open > 0 || (mastery !== undefined && mastery.mastery < WEAK_MASTERY_THRESHOLD);
        };
        const prereqCandidates: Array<{ id: string; name: string; dependent: string }> = [];
        for (const edge of repos.graph.getEdges(workspace.activeGraphVersionId)) {
          if (edge.relation !== 'prerequisite') continue;
          if (!isWeak(edge.targetConceptId)) continue;
          const prereq = repos.materials.getConcept(edge.sourceConceptId);
          const dependent = repos.materials.getConcept(edge.targetConceptId);
          if (!prereq || !dependent) continue;
          const prereqMastery = masteryByConcept.get(prereq.id);
          const prereqWeak = isWeak(prereq.id) || prereqMastery === undefined;
          if (prereqWeak) {
            prereqCandidates.push({ id: prereq.id, name: prereq.name, dependent: dependent.name });
          }
        }
        prereqCandidates.sort((a, b) => a.id.localeCompare(b.id));
        for (const candidate of prereqCandidates) {
          push({
            kind: 'weak_prerequisite',
            conceptId: candidate.id,
            conceptName: candidate.name,
            misconceptionId: null,
            reason: `「${candidate.dependent}」薄弱,其前置概念「${candidate.name}」也需要巩固。`,
            overdueDays: 0,
          });
        }
      }

      // 5. Reviews due later today, soonest first.
      const dueToday = reviewItems
        .filter((item) => {
          const due = new Date(item.dueAt).getTime();
          return due > now.getTime() && due <= endOfDay.getTime();
        })
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.conceptId.localeCompare(b.conceptId));
      for (const item of dueToday) {
        push({
          kind: 'due_review',
          conceptId: item.conceptId,
          conceptName: item.conceptName,
          misconceptionId: null,
          reason: '今天晚些时候到期,可提前完成复习。',
          overdueDays: 0,
        });
      }

      return items;
    },
  };
}

export type QueueService = ReturnType<typeof createQueueService>;
