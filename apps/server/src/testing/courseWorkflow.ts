import type { LessonExecutionCommandRequest } from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import type { Repositories } from '../repositories/index.js';

/** Runs a real Lesson to completion for the given teaching Agenda item. */
export async function teachThroughLesson(
  harness: { services: Services; repos: Repositories },
  workspaceId: string,
  agendaId: string,
  agendaItemId: string,
  tag: string,
  failPractice = false,
) {
  const { services, repos } = harness;
  const command = (id: string) => ({
    commandId: id,
    idempotencyKey: id,
    workspaceId,
    actor: 'learner' as const,
  });
  const execution = repos.courseExecution.get(workspaceId);
  const agenda = repos.sessionAgendas.get(agendaId)!;
  const session = services.studySessions.start(workspaceId, {
    contractVersionId: agenda.contractVersionId,
    curriculumVersionId: agenda.curriculumVersionId,
    studyPlanVersionId: agenda.studyPlanVersionId,
    sessionAgendaId: agenda.id,
    expectedCourseExecutionVersion: execution.version,
  }).session;
  let current = await services.lessonExecution.ensure(workspaceId, session.id, {
    command: command(`${tag}-prepare`),
    expectedSessionVersion: session.version,
    expectedAgendaVersion: agenda.version,
    expectedAgendaItemId: agendaItemId,
  });
  if (current.status !== 'ready') return { session, projection: current };
  if (current.allowedActions.includes('start_lesson'))
    current = await services.lessonExecution.command(workspaceId, session.id, {
      command: command(`${tag}-start`),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItemId,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
  let guard = 0;
  while (!current.allowedActions.includes('complete_presentation') && guard < 40) {
    guard += 1;
    if (current.allowedActions.includes('respond_to_worked_interaction')) {
      const index = current.progress!.currentSegmentIndex;
      const projected = current.lesson!.segments[index]!.workedProcess!.interaction!;
      const authored = repos.teachingBriefs.get(
        repos.lessonExecution.getForSession(session.id, agendaItemId)!.teachingBriefId!,
      )!.segments[index]!.workedProcess!.interaction!;
      const phase =
        projected.stage === 'scaffold'
          ? 'scaffold'
          : projected.stage === 'transfer'
            ? 'transfer'
            : 'guided';
      const response =
        phase === 'guided' ? authored.activity.correctOptionId : authored[phase].correctOptionId;
      current = await services.lessonExecution.command(workspaceId, session.id, {
        command: command(`${tag}-worked-${guard}`),
        expectedSessionVersion: current.session.version,
        expectedAgendaVersion: current.agenda!.version,
        expectedAgendaItemId: agendaItemId,
        expectedLessonStateVersion: current.progress!.stateVersion,
        action: { kind: 'respond_to_worked_interaction', segmentIndex: index, phase, response },
      });
      continue;
    }
    const action = current.allowedActions.includes('respond_to_informal_check')
      ? ({
          kind: 'respond_to_informal_check',
          segmentIndex: current.progress!.currentSegmentIndex,
          response:
            current.currentInformalCheck?.options?.[0]?.id ??
            'The source states the limit directly.',
        } as const)
      : ({
          kind: 'move_to_segment',
          segmentIndex: current.progress!.currentSegmentIndex + 1,
        } as const);
    current = await services.lessonExecution.command(workspaceId, session.id, {
      command: command(`${tag}-step-${guard}`),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItemId,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action,
    });
  }
  current = await services.lessonExecution.command(workspaceId, session.id, {
    command: command(`${tag}-present-complete`),
    expectedSessionVersion: current.session.version,
    expectedAgendaVersion: current.agenda!.version,
    expectedAgendaItemId: agendaItemId,
    expectedLessonStateVersion: current.progress!.stateVersion,
    action: { kind: 'complete_presentation' },
  });
  let practiceGuard = 0;
  while (current.practice && current.practice.status !== 'completed' && practiceGuard < 20) {
    practiceGuard += 1;
    const item = current.practice.item;
    const recovery = current.practice.recovery;
    const action: LessonExecutionCommandRequest['action'] =
      recovery?.phase === 'diagnosis'
        ? { kind: 'prepare_practice_repair', learnerNote: '' }
        : recovery?.phase === 'repair'
          ? { kind: 'start_practice_retest' }
          : recovery?.retest
            ? { kind: 'submit_practice_retest', index: recovery.retest.index, optionId: 'A' }
            : {
                kind: 'submit_practice_response',
                itemIndex: item!.index,
                optionId: item!.options[failPractice && practiceGuard === 1 ? 1 : 0]!.id,
              };
    current = await services.lessonExecution.command(workspaceId, session.id, {
      command: command(`${tag}-practice-${practiceGuard}`),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItemId,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action,
    });
  }
  return { session, projection: current };
}
