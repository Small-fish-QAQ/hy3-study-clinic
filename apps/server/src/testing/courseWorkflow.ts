import {
  CourseExecutionOverviewResponseSchema,
  type CoursePreparationResponse,
  type Curriculum,
  type LearningContract,
  type LessonExecutionCommandRequest,
  type LessonExecutionProjection,
  type Material,
  type MaterialRoleAssignment,
  type MaterialRoleHistoryResponse,
  type StudySession,
  type Workspace,
} from '@hy3-clinic/shared';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../services/index.js';
import type { Repositories } from '../repositories/index.js';
import {
  GOLDEN_ANSWERS,
  GOLDEN_UNITS,
  goldenContractFields,
  publicOptionId,
} from './goldenCourseFixture.js';

/** Small inject helper: surface the first failing production transition in full. */
export async function goldenRequest<T>(
  app: FastifyInstance,
  url: string,
  payload?: object,
): Promise<T> {
  const result = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, payload });
  if (result.statusCode !== 200 && result.statusCode !== 201)
    throw new Error(
      `${payload === undefined ? 'GET' : 'POST'} ${url}: ${result.statusCode} ${result.body}`,
    );
  return result.json<T>();
}

export const goldenCommand = (workspaceId: string, id: string) => ({
  commandId: id,
  idempotencyKey: id,
  workspaceId,
  actor: 'learner' as const,
});

export async function goldenOverview(app: FastifyInstance, workspaceId: string) {
  return CourseExecutionOverviewResponseSchema.parse(
    await goldenRequest(app, `/api/workspaces/${workspaceId}/execution`),
  ).overview;
}

/** Current ordinary Course path, including the actual learner Structure decision. */
export async function prepareGoldenCourse(app: FastifyInstance) {
  const { workspace } = await goldenRequest<{ workspace: Workspace }>(app, '/api/workspaces', {
    name: '工作记忆入门',
  });
  const workspaceId = workspace.id;
  const base = `/api/workspaces/${workspaceId}`;
  const roles: MaterialRoleAssignment[] = [];
  for (const unit of GOLDEN_UNITS) {
    const { material } = await goldenRequest<{ material: Material }>(app, `${base}/documents`, {
      kind: 'text',
      title: unit.title,
      content: unit.paragraphs.join('\n\n'),
    });
    const roleBase = `${base}/documents/${material.id}/role`;
    const { current } = await goldenRequest<MaterialRoleHistoryResponse>(app, roleBase);
    const { assignment } = await goldenRequest<{ assignment: MaterialRoleAssignment }>(
      app,
      `${roleBase}/proposals`,
      {
        command: goldenCommand(workspaceId, `role-propose-${unit.title}`),
        materialId: material.id,
        role: 'course_material',
        expectedCurrentAssignmentId: current.id,
      },
    );
    roles.push(
      (
        await goldenRequest<{ assignment: MaterialRoleAssignment }>(
          app,
          `${roleBase}/${assignment.id}/confirm`,
          {
            command: goldenCommand(workspaceId, `role-confirm-${unit.title}`),
            assignmentId: assignment.id,
            expectedVersion: assignment.version,
          },
        )
      ).assignment,
    );
  }
  let { contract } = await goldenRequest<{ contract: LearningContract }>(app, `${base}/contracts`, {
    command: goldenCommand(workspaceId, 'contract-create'),
    fields: goldenContractFields(roles),
    predecessorContractId: null,
    expectedActiveContractId: null,
  });
  for (const transition of ['propose', 'confirm'] as const) {
    ({ contract } = await goldenRequest<{ contract: LearningContract }>(
      app,
      `${base}/contracts/${contract.id}/transition`,
      {
        command: goldenCommand(workspaceId, `contract-${transition}`),
        contractId: contract.id,
        expectedVersion: contract.version,
        transition,
      },
    ));
  }
  const run = async () => {
    const { preparation } = await goldenRequest<CoursePreparationResponse>(
      app,
      `${base}/preparation`,
    );
    if (!preparation.operationKey)
      throw new Error(`No preparation action: ${JSON.stringify(preparation)}`);
    return goldenRequest<CoursePreparationResponse>(app, `${base}/preparation/run`, {
      command: goldenCommand(workspaceId, preparation.operationKey),
      expectedRevision: preparation.revision,
    });
  };
  const prepared = await run();
  if (prepared.preparation.learnerAction !== 'review_course_structure')
    throw new Error(`Expected learner Structure review: ${JSON.stringify(prepared)}`);
  const candidate = (await goldenOverview(app, workspaceId)).proposedCurriculum!;
  const { curriculum } = await goldenRequest<{ curriculum: Curriculum }>(
    app,
    `${base}/curricula/${candidate.id}/accept`,
    {
      command: goldenCommand(workspaceId, 'structure-accept'),
      curriculumId: candidate.id,
      expectedVersion: candidate.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint: candidate.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    },
  );
  const activated = await run();
  if (activated.preparation.state !== 'complete')
    throw new Error(`Expected activated ordinary route: ${JSON.stringify(activated)}`);
  return { workspace, contract, curriculum, overview: await goldenOverview(app, workspaceId) };
}

export async function goldenLessonCommand(
  app: FastifyInstance,
  workspaceId: string,
  sessionId: string,
  agendaItemId: string,
  current: LessonExecutionProjection,
  id: string,
  action: LessonExecutionCommandRequest['action'],
) {
  const allowedAction =
    action.kind === 'move_to_segment'
      ? action.segmentIndex > current.progress!.currentSegmentIndex
        ? 'move_to_next_segment'
        : 'revisit_segment'
      : action.kind;
  if (!current.allowedActions.includes(allowedAction))
    throw new Error(
      `Action ${action.kind} unavailable: ${JSON.stringify({ status: current.status, allowedActions: current.allowedActions, progress: current.progress })}`,
    );
  return goldenRequest<LessonExecutionProjection>(
    app,
    `/api/workspaces/${workspaceId}/study-sessions/${sessionId}/lesson-execution/commands`,
    {
      command: goldenCommand(workspaceId, id),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItemId,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action,
    },
  );
}

/** Advance using only the public Lesson projection and the authored learner script. */
export async function presentGoldenLesson(
  app: FastifyInstance,
  workspaceId: string,
  session: StudySession,
  agendaItemId: string,
  initial: LessonExecutionProjection,
) {
  let current = initial;
  for (let step = 0; step < 40; step += 1) {
    let action: LessonExecutionCommandRequest['action'];
    const index = current.progress!.currentSegmentIndex;
    if (current.allowedActions.includes('complete_presentation')) {
      action = { kind: 'complete_presentation' };
    } else if (current.allowedActions.includes('start_lesson')) {
      action = { kind: 'start_lesson' };
    } else if (current.allowedActions.includes('respond_to_worked_interaction')) {
      const worked = current.lesson!.segments[index]!.workedProcess!.interaction!;
      const phase = worked.stage;
      if (phase === 'completed')
        throw new Error('Completed worked interaction still requires a response.');
      const task = phase === 'guided' ? worked.activity : worked[phase]!;
      action = {
        kind: 'respond_to_worked_interaction',
        segmentIndex: index,
        phase,
        response: publicOptionId(task.options, GOLDEN_ANSWERS[phase]),
      };
    } else if (current.allowedActions.includes('respond_to_informal_check')) {
      action = {
        kind: 'respond_to_informal_check',
        segmentIndex: index,
        response: publicOptionId(current.currentInformalCheck!.options!, GOLDEN_ANSWERS.informal),
      };
    } else {
      action = { kind: 'move_to_segment', segmentIndex: index + 1 };
    }
    current = await goldenLessonCommand(
      app,
      workspaceId,
      session.id,
      agendaItemId,
      current,
      `${agendaItemId}-presentation-${step}`,
      action,
    );
    if (action.kind === 'complete_presentation') return current;
  }
  throw new Error(`Golden Lesson did not reach Practice: ${JSON.stringify(current)}`);
}

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
