import type {
  SessionAgenda,
  SessionAgendaItem,
  StudyPlan,
  StudyPlanProgressState,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { assessCourseFormalReadiness } from './formalReadiness.js';
import type { SessionAgendaAgentService } from './sessionAgendasAgent.js';
import { blockUnreadySynthesisItems, resolveStudyContinuationItem } from './studyContinuation.js';

interface AgendaWindowRolloverDeps {
  repos: Repositories;
  clock: Clock;
  agendas: SessionAgendaAgentService;
}

/**
 * Outcome of evaluating whether the current SessionAgenda window has drained
 * and, if so, whether the SAME accepted StudyPlan continues into a successor
 * window. Every branch is deterministic and writes no Formal Evidence,
 * mastery, progression decision or GoalOutcome.
 */
export type AgendaWindowContinuation =
  | { status: 'not_drained' }
  | { status: 'no_remaining_work' }
  | { status: 'blocked_successor'; remainingPlanItemIds: string[] }
  | { status: 'refused'; reason: string }
  | { status: 'rolled_over'; successorAgendaId: string; successorPlanItemIds: string[] };

/** Plan-progress states that no longer need scheduling, per `selectSessionItems`. */
const SETTLED_PROGRESS: ReadonlySet<StudyPlanProgressState> = new Set<StudyPlanProgressState>([
  'completed',
  'deferred',
  'obsolete',
]);

export interface CompleteTeachingExecutionInput {
  workspaceId: string;
  sessionId: string;
  agenda: SessionAgenda;
  item: SessionAgendaItem;
  plan: StudyPlan;
  planItem: StudyPlan['items'][number];
  commandId: string;
  at: string;
}

export interface CompleteTeachingExecutionResult {
  agendaItemCompleted: boolean;
  planProgressCompleted: boolean;
  continuation: AgendaWindowContinuation;
}

export function createAgendaWindowRolloverService({
  repos,
  clock,
  agendas,
}: AgendaWindowRolloverDeps) {
  function remainingPlanItemIds(plan: StudyPlan): string[] {
    const progress = new Map(
      repos.studyPlans.listProgress(plan.id).map((entry) => [entry.planItemId, entry.state]),
    );
    return plan.items
      .filter((item) => !SETTLED_PROGRESS.has(progress.get(item.id) ?? 'not_started'))
      .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
      .map((item) => item.id);
  }

  function install(
    workspaceId: string,
    plan: StudyPlan,
    outgoing: SessionAgenda,
    successorDraft: SessionAgenda,
    expectedStateVersion: number,
    commandId: string,
    at: string,
  ): string {
    return repos.transaction(() => {
      const stored = repos.sessionAgendas.create(successorDraft, {
        id: newId('agenda_evt'),
        eventType: 'composed_for_agenda_window_rollover',
        actor: 'local',
        payload: {
          studyPlanId: plan.id,
          retiredAgendaId: outgoing.id,
          commandId,
          planItemIds: successorDraft.items.map((item) => item.linkedPlanItemId),
        },
        createdAt: successorDraft.createdAt,
      });
      repos.sessionAgendas.appendEvent(outgoing.id, {
        id: newId('agenda_evt'),
        eventType: 'agenda_window_completed',
        actor: 'local',
        payload: { studyPlanId: plan.id, successorAgendaId: stored.id, commandId },
        createdAt: at,
      });
      repos.courseExecution.rolloverAgendaWindow({
        workspaceId,
        contractId: plan.contractVersionId,
        curriculumId: plan.curriculumVersionId,
        planId: plan.id,
        outgoingAgendaId: outgoing.id,
        successorAgendaId: stored.id,
        expectedStateVersion,
        expectedOutgoingAgendaVersion: outgoing.version,
        eventId: newId('course_evt'),
        actor: 'local',
        at,
      });
      return stored.id;
    });
  }

  /**
   * Evaluates the current window and continues the SAME accepted StudyPlan into
   * a successor Agenda when it has drained and executable work remains. Never
   * accepts a plan, never writes a GoalOutcome, never re-runs the
   * `route_activation` authority boundary: an unchanged route is required, and
   * a changed one is refused so the existing replan lane stays authoritative.
   */
  function continueIfDrained(workspaceId: string, commandId: string): AgendaWindowContinuation {
    const state = repos.courseExecution.get(workspaceId);
    if (
      !state.activeContractId ||
      !state.activeCurriculumId ||
      !state.acceptedPlanId ||
      !state.activeAgendaId
    ) {
      return { status: 'refused', reason: 'course_route_not_installed' };
    }
    if (state.executionStatus !== 'active') {
      return { status: 'refused', reason: 'course_execution_not_active' };
    }
    if (state.routeValidationStatus !== 'valid') {
      return { status: 'refused', reason: 'route_revalidation_required' };
    }
    const plan = repos.studyPlans.get(state.acceptedPlanId);
    if (!plan || plan.status !== 'accepted') {
      return { status: 'refused', reason: 'accepted_plan_unavailable' };
    }
    const outgoing = repos.sessionAgendas.get(state.activeAgendaId);
    if (!outgoing || outgoing.status !== 'active' || outgoing.studyPlanVersionId !== plan.id) {
      return { status: 'refused', reason: 'active_agenda_unavailable' };
    }
    if (outgoing.items.some((item) => item.state === 'queued' || item.state === 'active')) {
      return { status: 'not_drained' };
    }
    const remaining = remainingPlanItemIds(plan);
    if (remaining.length === 0) return { status: 'no_remaining_work' };

    const contract = repos.learningContracts.get(state.activeContractId);
    const curriculum = repos.curricula.get(state.activeCurriculumId);
    const currentAcceptedCurriculum = repos.curricula
      .list(workspaceId)
      .filter((candidate) => candidate.status === 'accepted')
      .at(-1);
    if (!contract || contract.status !== 'active') {
      return { status: 'refused', reason: 'contract_not_active' };
    }
    if (
      !curriculum ||
      curriculum.status !== 'accepted' ||
      currentAcceptedCurriculum?.id !== curriculum.id ||
      curriculum.contractVersionId !== contract.id
    ) {
      return { status: 'refused', reason: 'curriculum_superseded' };
    }
    if (
      plan.contractVersionId !== contract.id ||
      plan.curriculumVersionId !== curriculum.id ||
      plan.executionSourceManifestFingerprint !== curriculum.executionSourceManifest.fingerprint
    ) {
      return { status: 'refused', reason: 'execution_source_manifest_changed' };
    }

    let successorDraft: SessionAgenda;
    try {
      successorDraft = agendas.composeDraft(contract, curriculum, plan);
    } catch (error) {
      return {
        status: 'refused',
        reason: `successor_composition_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      !successorDraft.items.some(
        (item) => item.state === 'queued' && item.launch.status === 'launchable',
      )
    ) {
      return { status: 'blocked_successor', remainingPlanItemIds: remaining };
    }

    const at = clock.now().toISOString();
    try {
      const successorAgendaId = install(
        workspaceId,
        plan,
        outgoing,
        successorDraft,
        state.version,
        commandId,
        at,
      );
      return {
        status: 'rolled_over',
        successorAgendaId,
        successorPlanItemIds: successorDraft.items
          .map((item) => item.linkedPlanItemId)
          .filter((id): id is string => id !== null),
      };
    } catch (error) {
      // The failed installation rolled back to its savepoint: the retired
      // window, the active pointer and the accepted Plan are all unchanged.
      // Teaching completion that preceded this stays committed and the window
      // remains retryable.
      repos.sessionAgendas.appendEvent(outgoing.id, {
        id: newId('agenda_evt'),
        eventType: 'agenda_window_rollover_refused',
        actor: 'local',
        payload: {
          studyPlanId: plan.id,
          commandId,
          reason: error instanceof Error ? error.message : String(error),
        },
        createdAt: at,
      });
      return {
        status: 'refused',
        reason: `successor_install_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Execution bookkeeping for a completed Lesson: the SessionAgenda item and
   * the linked `teach_unit` StudyPlan progress reach `completed` atomically.
   *
   * This means only "the StudyPlan execution item no longer needs scheduling".
   * It is NOT Formal Evidence, formal credit, LearningUnit mastery, a
   * progression decision or a Repair resolution, and it writes none of them.
   */
  function completeTeachingExecution(
    input: CompleteTeachingExecutionInput,
  ): CompleteTeachingExecutionResult {
    if (
      input.item.kind !== 'learning_unit_teaching' ||
      input.item.linkedPlanItemId !== input.planItem.id ||
      input.planItem.kind !== 'teach_unit'
    ) {
      return {
        agendaItemCompleted: false,
        planProgressCompleted: false,
        continuation: { status: 'refused', reason: 'not_linked_teaching_execution' },
      };
    }
    const written = repos.transaction(() => {
      const agenda = repos.sessionAgendas.get(input.agenda.id);
      const current = agenda?.items.find((item) => item.id === input.item.id);
      if (!agenda || !current) return { agendaItemCompleted: false, planProgressCompleted: false };
      let agendaItemCompleted = false;
      if (current.state !== 'completed') {
        const items = agenda.items.map((item) =>
          item.id === current.id ? { ...item, state: 'completed' as const } : item,
        );
        const progressForContinuation = repos.studyPlans
          .listProgress(input.plan.id)
          .map((entry) =>
            entry.planItemId === input.planItem.id
              ? { ...entry, state: 'completed' as const }
              : entry,
          );
        const firstQueuedId =
          items.find((item) => item.state === 'queued' && item.launch.status === 'launchable')
            ?.id ?? null;
        const agendaForContinuation = { ...agenda, items, currentItemId: firstQueuedId };
        const curriculum = repos.curricula.get(input.plan.curriculumVersionId);
        const formalReadiness = curriculum
          ? assessCourseFormalReadiness(repos, curriculum, {
              studyPlan: input.plan,
              agenda: agendaForContinuation,
            })
          : null;
        const nextItemId =
          curriculum && formalReadiness
            ? (resolveStudyContinuationItem({
                agenda: agendaForContinuation,
                plan: input.plan,
                progress: progressForContinuation,
                formalReadiness,
              })?.id ?? null)
            : null;
        const routedItems = formalReadiness
          ? blockUnreadySynthesisItems(agendaForContinuation, formalReadiness).items
          : items;
        repos.sessionAgendas.update(
          {
            ...agenda,
            version: agenda.version + 1,
            items: routedItems,
            currentItemId: nextItemId,
            updatedAt: input.at,
          },
          agenda.version,
          {
            id: newId('agenda_evt'),
            eventType: 'teaching_execution_completed',
            actor: 'local',
            payload: {
              agendaItemId: current.id,
              linkedPlanItemId: input.planItem.id,
              learningUnitId: input.item.learningUnitId,
              commandId: input.commandId,
              currentItemId: nextItemId,
              credit: 'none',
            },
            createdAt: input.at,
          },
        );
        agendaItemCompleted = true;
        for (const session of repos.studySessions
          .list(input.workspaceId)
          .filter(
            (candidate) =>
              candidate.sessionAgendaId === agenda.id &&
              (candidate.status === 'active' || candidate.status === 'paused'),
          )) {
          repos.studySessions.update(
            {
              ...session,
              version: session.version + 1,
              currentAgendaItemId: nextItemId,
              updatedAt: input.at,
            },
            session.version,
          );
        }
      }
      const progress = repos.studyPlans
        .listProgress(input.plan.id)
        .find((entry) => entry.planItemId === input.planItem.id);
      let planProgressCompleted = false;
      if (progress && progress.state !== 'completed') {
        repos.studyPlans.updateProgress(
          input.plan.id,
          input.planItem.id,
          progress.version,
          'completed',
          newId('plan_progress_evt'),
          `Teaching execution completed for Agenda item ${current.id}.`,
          input.at,
        );
        planProgressCompleted = true;
      }
      return { agendaItemCompleted, planProgressCompleted };
    });
    return {
      ...written,
      continuation: continueIfDrained(input.workspaceId, input.commandId),
    };
  }

  return { continueIfDrained, completeTeachingExecution };
}

export type AgendaWindowRolloverService = ReturnType<typeof createAgendaWindowRolloverService>;
