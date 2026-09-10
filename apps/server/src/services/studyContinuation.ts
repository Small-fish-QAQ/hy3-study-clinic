import {
  isExecutableTeachingAgendaItem,
  isPlannedFormalAgendaItemKind,
  type CourseFormalReadiness,
  type SessionAgenda,
  type SessionAgendaItem,
  type StudyPlan,
  type StudyPlanProgressState,
} from '@hy3-clinic/shared';

export interface StudyContinuationProgress {
  planItemId: string;
  state: StudyPlanProgressState;
}

const FORMAL_READINESS_REASON =
  'Formal readiness is not ready; keep this synthesis obligation for a later verified route.';

/**
 * Keep a pending synthesis obligation visible and durable without presenting it
 * as a launchable learner action. StudyPlan progress and objective IDs are not
 * changed; a later Agenda may schedule the same Plan item after readiness.
 */
export function blockUnreadySynthesisItems(
  agenda: SessionAgenda,
  formalReadiness: CourseFormalReadiness,
  plan?: StudyPlan,
): SessionAgenda {
  if (formalReadiness.status === 'ready') return agenda;
  return {
    ...agenda,
    items: agenda.items.map((item) =>
      item.kind === 'synthesis' &&
      item.state === 'queued' &&
      !plan?.items.some(
        (candidate) =>
          candidate.id === item.linkedPlanItemId && candidate.synthesisMode === 'unit_transfer',
      )
        ? {
            ...item,
            state: 'blocked' as const,
            launch: {
              status: 'blocked' as const,
              capability: item.launch.capability,
              resourceId: null,
              reason: FORMAL_READINESS_REASON,
            },
          }
        : item,
    ),
  };
}

function planItemFor(plan: StudyPlan, item: SessionAgendaItem): StudyPlan['items'][number] | null {
  if (!item.linkedPlanItemId) return null;
  return plan.items.find((candidate) => candidate.id === item.linkedPlanItemId) ?? null;
}

function teachingItemIsPlanSafe(
  item: SessionAgendaItem,
  plan: StudyPlan,
  progress: ReadonlyMap<string, StudyPlanProgressState>,
): boolean {
  if (!isExecutableTeachingAgendaItem(item)) return false;
  const planItem = planItemFor(plan, item);
  if (
    !planItem ||
    planItem.kind !== 'teach_unit' ||
    planItem.curriculumLearningUnitId !== item.learningUnitId ||
    progress.get(planItem.id) === 'completed' ||
    progress.get(planItem.id) === 'deferred' ||
    progress.get(planItem.id) === 'obsolete'
  ) {
    return false;
  }
  return planItem.prerequisitePlanItemIds.every(
    (prerequisiteId) => progress.get(prerequisiteId) === 'completed',
  );
}

/**
 * Whether the selected Agenda item has a learner surface now. A queued
 * synthesis gate is auto-routable only after the exact Course Formal-readiness
 * projection is ready. Ordinary formal checkpoints keep their existing
 * explicit assessment launch; an already-active Formal item is also left in
 * place for its in-flight operation/retry.
 */
export function isSelectedStudyItemExecutable(
  item: SessionAgendaItem,
  plan: StudyPlan,
  progress: readonly StudyContinuationProgress[],
  formalReadiness: CourseFormalReadiness,
): boolean {
  const progressByItem = new Map(progress.map((entry) => [entry.planItemId, entry.state]));
  if (teachingItemIsPlanSafe(item, plan, progressByItem)) return true;
  if ((item.state !== 'queued' && item.state !== 'active') || item.launch.status !== 'launchable') {
    return false;
  }
  if (isPlannedFormalAgendaItemKind(item.kind)) {
    const planItem = planItemFor(plan, item);
    return Boolean(
      item.launch.capability === 'assessment' &&
      planItem &&
      planItem.kind === item.kind &&
      planItem.objectiveIds.length > 0 &&
      planItem.prerequisitePlanItemIds.every((id) => progressByItem.get(id) === 'completed') &&
      (item.kind === 'formal_checkpoint' ||
        planItem.synthesisMode === 'unit_transfer' ||
        item.state === 'active' ||
        formalReadiness.status === 'ready'),
    );
  }
  if (
    item.kind === 'due_review' ||
    item.kind === 'targeted_repair' ||
    item.kind === 'prerequisite_repair'
  ) {
    return item.launch.capability === 'assessment';
  }
  if (
    item.kind === 'learner_detour' ||
    item.kind === 'stretch_challenge' ||
    item.kind === 'informal_check'
  ) {
    return item.launch.capability === 'conversation' || item.launch.capability === 'study_session';
  }
  return false;
}

/**
 * Resolve the one current learner action without changing Agenda items or Plan
 * progress. If an automatically selected queued synthesis gate is not ready,
 * only prerequisite-satisfied teaching in the same Agenda may replace its
 * pointer. The synthesis item remains queued, so no objective or verification
 * obligation is discarded.
 */
export function resolveStudyContinuationItem(input: {
  agenda: SessionAgenda;
  plan: StudyPlan;
  progress: readonly StudyContinuationProgress[];
  formalReadiness: CourseFormalReadiness;
}): SessionAgendaItem | null {
  const current = input.agenda.items.find((item) => item.id === input.agenda.currentItemId) ?? null;
  if (
    current &&
    isSelectedStudyItemExecutable(current, input.plan, input.progress, input.formalReadiness)
  ) {
    return current;
  }
  const mayRouteToTeaching =
    current === null ||
    (current.state === 'queued' &&
      current.kind === 'synthesis' &&
      input.formalReadiness.status !== 'ready');
  if (!mayRouteToTeaching) return null;

  const progressByItem = new Map(
    input.progress.map((entry) => [entry.planItemId, entry.state] as const),
  );
  return (
    [...input.agenda.items]
      .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
      .find(
        (item) =>
          teachingItemIsPlanSafe(item, input.plan, progressByItem) ||
          (item.kind === 'formal_checkpoint' &&
            isSelectedStudyItemExecutable(item, input.plan, input.progress, input.formalReadiness)),
      ) ?? null
  );
}
