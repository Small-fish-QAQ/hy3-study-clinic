import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { ProviderError } from '../llm/errors.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { fixedClock } from '../util/ids.js';
import { createServices, type Services } from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SOURCE = [
  '# Working memory',
  'Working memory has limited capacity;',
  '',
  '# Chunking',
  'Chunking groups items to raise effective capacity;',
  '',
  '# Rehearsal',
  'Rehearsal maintains items in working memory;',
  '',
  '# Interference',
  'Interference displaces items from working memory;',
  '',
  '# Retrieval',
  'Retrieval brings items back into working memory;',
].join('\n');

/** Fails the compositional Lesson call until cleared, leaving earlier stages alone. */
class LessonFaultProvider extends FakeProvider {
  failLesson = false;
  lessonAttempts = 0;
  curriculumCalls = 0;
  studyPlanCalls = 0;

  override async proposeCurriculum(...args: Parameters<FakeProvider['proposeCurriculum']>) {
    this.curriculumCalls += 1;
    return super.proposeCurriculum(...args);
  }

  override async proposeStudyPlan(...args: Parameters<FakeProvider['proposeStudyPlan']>) {
    this.studyPlanCalls += 1;
    return super.proposeStudyPlan(...args);
  }

  override async generateLessonSlotContent(
    ...args: Parameters<FakeProvider['generateLessonSlotContent']>
  ) {
    this.lessonAttempts += 1;
    if (this.failLesson) throw ProviderError.network();
    return super.generateLessonSlotContent(...args);
  }
}

interface Harness {
  db: SqliteDb;
  repos: Repositories;
  services: Services;
  provider: LessonFaultProvider;
}

let dir: string;
let dbPath: string;
let harness: Harness;
let workspaceId: string;

function open(): Harness {
  const db = openDatabase(dbPath);
  migrate(db);
  const repos = createRepositories(db);
  const provider = new LessonFaultProvider();
  return {
    db,
    repos,
    provider,
    services: createServices({ repos, provider, clock: fixedClock(NOW) }),
  };
}

function command(id: string, actor: 'learner' | 'local' = 'learner') {
  return { commandId: id, idempotencyKey: id, workspaceId, actor } as const;
}

function contractFields(materialId: string, roleId: string, roleVersion: number, role: string) {
  return {
    intent: 'Learn every section of the source across several sessions.',
    targetOutcome: {
      description: 'Explain the source accurately.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 120,
      minutesPerWeek: null,
      // Sized so one window holds a teaching item plus its checkpoint.
      preferredSessionMinutes: 40,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Working memory'],
      materials: [
        {
          materialId,
          materialRoleAssignmentId: roleId,
          materialRoleAssignmentVersion: roleVersion,
          role,
          disposition: 'included',
        },
      ],
      includedTopics: [],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: 'high',
    },
  } as LearningContractDraftFields;
}

/** Fresh Course through real preparation to an accepted route and first window. */
async function prepareAcceptedRoute() {
  const { services, repos } = harness;
  const workspace = services.workspaces.create({ name: 'Continuation course' });
  workspaceId = workspace.id;
  const created = services.materials.create({ title: 'Notes', content: SOURCE }, workspaceId);
  await services.analysis.analyze(created.material.id);
  const currentRole = repos.materialRoles.getCurrent(created.material.id)!;
  const proposal = services.materialRoles.propose({
    command: command('role-propose'),
    materialId: created.material.id,
    role: 'course_material',
    expectedCurrentAssignmentId: currentRole.id,
  });
  const role = services.materialRoles.confirm({
    command: command('role-confirm'),
    assignmentId: proposal.id,
    expectedVersion: proposal.version,
  });
  const draft = services.learningContracts.createDraft({
    command: command('contract-draft'),
    fields: contractFields(created.material.id, role.id, role.version, role.role),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposed = services.learningContracts.transition({
    command: command('contract-propose'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  const contract = services.learningContracts.transition({
    command: command('contract-confirm'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;
  const preparation = services.coursePreparation.get(workspaceId);
  await services.coursePreparation.run({
    command: command(preparation.operationKey!),
    expectedRevision: preparation.revision,
  });
  const plan = repos.studyPlans.list(workspaceId).at(-1)!;
  const curriculum = repos.curricula.get(plan.curriculumVersionId)!;
  const route = services.courseExecution.decideStudyPlan({
    command: command('plan-accept'),
    studyPlanId: plan.id,
    expectedVersion: plan.version,
    expectedContractId: contract.id,
    expectedCurriculumId: curriculum.id,
    expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    decision: 'accept',
    reason: null,
  }).activeRoute!;
  return { contract, curriculum, plan: route.studyPlan, agenda: route.agenda };
}

function planIndexes(agendaId: string, planId: string): number[] {
  const plan = harness.repos.studyPlans.get(planId)!;
  return harness.repos.sessionAgendas
    .get(agendaId)!
    .items.map(
      (item) => plan.items.find((candidate) => candidate.id === item.linkedPlanItemId)?.index,
    )
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
}

/** Runs a real Lesson to completion for the given teaching Agenda item. */
async function teachThroughLesson(agendaId: string, agendaItemId: string, tag: string) {
  const { services, repos } = harness;
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
    const action = current.allowedActions.includes('respond_to_informal_check')
      ? ({
          kind: 'respond_to_informal_check',
          segmentIndex: current.progress!.currentSegmentIndex,
          response: 'The source states the limit directly.',
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
    const item = current.practice.item!;
    current = await services.lessonExecution.command(workspaceId, session.id, {
      command: command(`${tag}-practice-${practiceGuard}`),
      expectedSessionVersion: current.session.version,
      expectedAgendaVersion: current.agenda!.version,
      expectedAgendaItemId: agendaItemId,
      expectedLessonStateVersion: current.progress!.stateVersion,
      action: {
        kind: 'submit_practice_response',
        itemIndex: item.index,
        optionId: item.options[0]!.id,
      },
    });
  }
  return { session, projection: current };
}

/** Completes a formal checkpoint Agenda item through real grading. */
async function completeCheckpoint(agendaId: string, agendaItemId: string, tag: string) {
  const { services, repos } = harness;
  const agenda = repos.sessionAgendas.get(agendaId)!;
  const plan = repos.studyPlans.get(agenda.studyPlanVersionId)!;
  const curriculum = repos.curricula.get(agenda.curriculumVersionId)!;
  const launched = await services.courseActionLaunch.launch({
    command: command(`${tag}-launch`),
    agendaId: agenda.id,
    expectedAgendaVersion: agenda.version,
    agendaItemId,
    expectedContractId: agenda.contractVersionId,
    expectedStudyPlanId: plan.id,
    expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
  });
  if (launched.kind !== 'assessment') throw new Error('Expected a formal assessment launch.');
  const quiz = repos.quizzes.get(launched.quiz.id)!;
  const outcome = await services.grading.grade(
    {
      quizId: quiz.id,
      answers: quiz.questions.map((question) =>
        question.type === 'short_answer'
          ? {
              questionId: question.id,
              type: 'short_answer' as const,
              text: question.expectedAnswer,
            }
          : {
              questionId: question.id,
              type: 'single_choice' as const,
              optionId: question.correctOptionIds![0]!,
            },
      ),
    },
    {
      stateCreditResolver: () =>
        new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(quiz.id) ?? []),
    },
  );
  return services.formalProgression.reconcileAfterGrading(outcome.result.id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hy3-continuation-'));
  dbPath = join(dir, 'clinic.sqlite');
  harness = open();
});

afterEach(() => {
  harness.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('file-backed Course Execution continuation', () => {
  it('T17 carries a fresh Course through multiple Agenda windows to a later reachable Lesson', async () => {
    const route = await prepareAcceptedRoute();
    const plan = harness.repos.studyPlans.get(route.plan.id)!;
    expect(plan.items.filter((item) => item.kind === 'teach_unit').length).toBeGreaterThanOrEqual(
      4,
    );
    expect(planIndexes(route.agenda.id, plan.id)).toEqual([0, 1]);

    const firstTeaching = route.agenda.items.find(
      (item) => item.kind === 'learning_unit_teaching',
    )!;
    await teachThroughLesson(route.agenda.id, firstTeaching.id, 'w1-teach');

    // The teaching item completed, but the window still holds its checkpoint.
    const afterLesson = harness.repos.sessionAgendas.get(route.agenda.id)!;
    expect(afterLesson.items.find((item) => item.id === firstTeaching.id)!.state).toBe('completed');
    expect(
      harness.repos.studyPlans
        .listProgress(plan.id)
        .find((entry) => entry.planItemId === firstTeaching.linkedPlanItemId)!.state,
    ).toBe('completed');
    expect(harness.repos.courseExecution.get(workspaceId).activeAgendaId).toBe(route.agenda.id);

    const checkpointItem = afterLesson.items.find(
      (item) => item.kind === 'formal_checkpoint' && item.state === 'queued',
    )!;
    const progression = await completeCheckpoint(
      route.agenda.id,
      checkpointItem.id,
      'w1-checkpoint',
    );
    expect(progression?.decisions[0]?.kind).toBe('complete');

    // The formal decision drained the window, so the same accepted Plan
    // continued into a successor holding previously untaught work.
    const successorId = harness.repos.courseExecution.get(workspaceId).activeAgendaId!;
    expect(successorId).not.toBe(route.agenda.id);
    expect(harness.repos.sessionAgendas.get(route.agenda.id)!.status).toBe('completed');
    expect(planIndexes(successorId, plan.id)).toEqual([2, 3]);
    expect(harness.repos.studyPlans.get(plan.id)!.status).toBe('accepted');
    expect(harness.repos.studyPlans.get(plan.id)!.learnerAcceptedAt).toBe(
      route.plan.learnerAcceptedAt,
    );
    expect(harness.repos.formalProgression.listGoalOutcomes(workspaceId)).toHaveLength(0);

    // A later teaching item is now genuinely reachable and preparable.
    const successor = harness.repos.sessionAgendas.get(successorId)!;
    const laterTeaching = successor.items.find(
      (item) => item.kind === 'learning_unit_teaching' && item.state === 'queued',
    )!;
    expect(laterTeaching.launch.status).toBe('launchable');
    const later = await teachThroughLesson(successorId, laterTeaching.id, 'w2-teach');
    expect(later.projection.status).toBe('ready');
    expect(
      harness.repos.sessionAgendas
        .get(successorId)!
        .items.find((item) => item.id === laterTeaching.id)!.state,
    ).toBe('completed');
  }, 240_000);

  it('T18/T19/T23 resumes durable state after a process restart without regenerating it', async () => {
    const route = await prepareAcceptedRoute();
    const plan = harness.repos.studyPlans.get(route.plan.id)!;
    const firstTeaching = route.agenda.items.find(
      (item) => item.kind === 'learning_unit_teaching',
    )!;
    await teachThroughLesson(route.agenda.id, firstTeaching.id, 'w1-teach');
    const checkpointItem = harness.repos.sessionAgendas
      .get(route.agenda.id)!
      .items.find((item) => item.kind === 'formal_checkpoint' && item.state === 'queued')!;
    await completeCheckpoint(route.agenda.id, checkpointItem.id, 'w1-checkpoint');
    const successorId = harness.repos.courseExecution.get(workspaceId).activeAgendaId!;
    const before = {
      state: harness.repos.courseExecution.get(workspaceId),
      plans: harness.repos.studyPlans.list(workspaceId).length,
      agendas: harness.repos.sessionAgendas.list(workspaceId).length,
      progress: harness.repos.studyPlans.listProgress(plan.id),
      curriculumCalls: harness.provider.curriculumCalls,
    };

    // Destroy and rebuild every service, repository and provider object.
    harness.db.close();
    harness = open();

    const state = harness.repos.courseExecution.get(workspaceId);
    expect(state).toEqual(before.state);
    expect(state.acceptedPlanId).toBe(plan.id);
    expect(state.activeAgendaId).toBe(successorId);
    expect(harness.repos.studyPlans.get(plan.id)!.status).toBe('accepted');
    expect(harness.repos.sessionAgendas.get(successorId)!.status).toBe('active');
    expect(harness.repos.studyPlans.listProgress(plan.id)).toEqual(before.progress);

    // Completed preparation is reused: reopening proposes nothing new and
    // makes no fresh Curriculum or StudyPlan provider call.
    const preparation = harness.services.coursePreparation.get(workspaceId);
    if (preparation.operationKey) {
      await harness.services.coursePreparation.run({
        command: command(preparation.operationKey),
        expectedRevision: preparation.revision,
      });
    }
    expect(harness.provider.curriculumCalls).toBe(0);
    expect(harness.provider.studyPlanCalls).toBe(0);
    expect(harness.repos.studyPlans.list(workspaceId)).toHaveLength(before.plans);
    expect(harness.repos.sessionAgendas.list(workspaceId)).toHaveLength(before.agendas);
    expect(harness.repos.courseExecution.get(workspaceId).acceptedPlanId).toBe(plan.id);

    // Completed items are not rescheduled into the recovered window.
    const completedPlanItemIds = harness.repos.studyPlans
      .listProgress(plan.id)
      .filter((entry) => entry.state === 'completed')
      .map((entry) => entry.planItemId);
    expect(completedPlanItemIds.length).toBeGreaterThan(0);
    expect(
      harness.repos.sessionAgendas
        .get(successorId)!
        .items.filter((item) => completedPlanItemIds.includes(item.linkedPlanItemId ?? '')),
    ).toHaveLength(0);

    // A5: the still-current accepted route resumes normally, and no
    // replacement Plan was silently accepted.
    const activeRoute = harness.services.courseExecution.activeRoute(workspaceId);
    expect(activeRoute?.studyPlan.id).toBe(plan.id);
    expect(activeRoute?.agenda.id).toBe(successorId);
    expect(
      harness.repos.studyPlans.list(workspaceId).filter((entry) => entry.status === 'accepted'),
    ).toHaveLength(1);
  }, 240_000);

  it('T20 retries a failed Lesson provider stage without regenerating durable earlier stages', async () => {
    const route = await prepareAcceptedRoute();
    const plan = harness.repos.studyPlans.get(route.plan.id)!;
    const curriculumCallsAfterPreparation = harness.provider.curriculumCalls;
    const planCallsAfterPreparation = harness.provider.studyPlanCalls;
    const firstTeaching = route.agenda.items.find(
      (item) => item.kind === 'learning_unit_teaching',
    )!;

    harness.provider.failLesson = true;
    const failed = await teachThroughLesson(route.agenda.id, firstTeaching.id, 'fault');
    expect(failed.projection.status).not.toBe('ready');
    expect(harness.provider.lessonAttempts).toBeGreaterThan(0);

    // The fault left execution bookkeeping untouched and nothing falsely done.
    expect(
      harness.repos.sessionAgendas
        .get(route.agenda.id)!
        .items.find((item) => item.id === firstTeaching.id)!.state,
    ).not.toBe('completed');
    expect(
      harness.repos.studyPlans
        .listProgress(plan.id)
        .find((entry) => entry.planItemId === firstTeaching.linkedPlanItemId)!.state,
    ).not.toBe('completed');
    expect(harness.repos.courseExecution.get(workspaceId).activeAgendaId).toBe(route.agenda.id);
    expect(harness.repos.studyPlans.get(plan.id)!.status).toBe('accepted');

    // Restart, clear the fault, and retry: earlier durable stages are reused.
    harness.db.close();
    harness = open();
    expect(harness.repos.courseExecution.get(workspaceId).acceptedPlanId).toBe(plan.id);
    const retried = await teachThroughLesson(route.agenda.id, firstTeaching.id, 'retry');

    expect(retried.projection.status).toBe('ready');
    expect(harness.provider.curriculumCalls).toBe(0);
    expect(harness.provider.studyPlanCalls).toBe(0);
    expect(curriculumCallsAfterPreparation).toBeGreaterThan(0);
    expect(planCallsAfterPreparation).toBeGreaterThan(0);
    expect(
      harness.repos.sessionAgendas
        .get(route.agenda.id)!
        .items.find((item) => item.id === firstTeaching.id)!.state,
    ).toBe('completed');
    expect(harness.repos.formalProgression.listGoalOutcomes(workspaceId)).toHaveLength(0);
  }, 240_000);
});
