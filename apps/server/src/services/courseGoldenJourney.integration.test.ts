import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CourseActionLaunchResult,
  CourseLearningProgress,
  FormalProgressionOverview,
  GoalOutcome,
  LearnerAssessmentExecution,
  LessonExecutionProjection,
  StartStudySessionResponse,
  StudyPlan,
  StudySessionDetailResponse,
} from '@hy3-clinic/shared';
import { buildTestApp, type TestApp } from '../testing/testApp.js';
import {
  goldenCommand,
  goldenLessonCommand,
  goldenOverview,
  goldenRequest,
  prepareGoldenCourse,
  presentGoldenLesson,
} from '../testing/courseWorkflow.js';
import {
  GOLDEN_ANSWERS,
  GOLDEN_UNITS,
  goldenProvider,
  publicOptionId,
} from '../testing/goldenCourseFixture.js';

let context: TestApp | undefined;
let directory: string | undefined;
afterEach(async () => {
  await context?.app.close();
  context = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('ordinary three-unit complete-course Golden Journey', () => {
  it('learns, repairs, formally completes and persists the entire accepted Course', async () => {
    directory = mkdtempSync(join(tmpdir(), 'hy3-golden-course-'));
    const databasePath = join(directory, 'clinic.sqlite');
    let tracked = goldenProvider();
    context = buildTestApp({ databasePath, provider: tracked.provider });
    const { app } = context;
    const course = await prepareGoldenCourse(app);
    const workspaceId = course.workspace.id;
    const base = `/api/workspaces/${workspaceId}`;
    const units = course.curriculum.nodes.filter((node) => node.learningUnit);
    expect(units.map((unit) => unit.title)).toEqual(GOLDEN_UNITS.map((unit) => unit.title));
    expect(new Set(units.map((unit) => unit.id)).size).toBe(3);
    expect(units.every((unit) => unit.learningUnit!.objectives.length > 0)).toBe(true);
    expect(
      new Set(
        units.flatMap((unit) =>
          unit.learningUnit!.objectives.map((objective) => objective.description),
        ),
      ).size,
    ).toBe(3);
    const plan = course.overview.acceptedStudyPlan!;
    expect(plan).toMatchObject({
      provider: 'local',
      acceptanceBasis: 'derived_from_accepted_curriculum',
      status: 'accepted',
    });
    expect(tracked.calls.proposeStudyPlan ?? 0).toBe(0);
    expect(
      plan.items
        .filter((item) => item.kind === 'teach_unit')
        .map((item) => item.curriculumLearningUnitId),
    ).toEqual(units.map((unit) => unit.id));
    expect(plan.items.filter((item) => item.kind === 'formal_checkpoint')).toHaveLength(3);

    // Ordinary reads of the accepted Course must not call the Provider.
    const preparedCalls = { ...tracked.calls };
    await goldenOverview(app, workspaceId);
    await goldenRequest(app, `${base}/preparation`);
    await goldenRequest(app, `${base}/curricula/${course.curriculum.id}`);
    await goldenRequest(app, `${base}/study-plans/${plan.id}`);
    expect(tracked.calls).toEqual(preparedCalls);

    const taught: string[] = [];
    const checked: string[] = [];
    const agendaIds = new Set<string>();
    const sessionIds = new Set<string>();
    let repairObserved = false;
    for (let step = 0; step < plan.items.length; step += 1) {
      const overview = await goldenOverview(app, workspaceId);
      expect(overview.acceptedStudyPlan?.id).toBe(plan.id);
      const { agendaId, item } = overview.nextAction!;
      agendaIds.add(agendaId);
      const agenda = overview.activeAgenda!;
      expect(item.launch.status).toBe('launchable');
      const progressionBefore = await goldenRequest<FormalProgressionOverview>(
        app,
        `${base}/progression`,
      );
      if (item.kind === 'learning_unit_teaching') {
        const { session } = await goldenRequest<StartStudySessionResponse>(
          app,
          `${base}/study-sessions`,
          {
            contractVersionId: course.contract.id,
            curriculumVersionId: course.curriculum.id,
            studyPlanVersionId: plan.id,
            sessionAgendaId: agendaId,
            expectedCourseExecutionVersion: overview.courseExecutionVersion,
          },
        );
        sessionIds.add(session.id);
        const prepareUrl = `${base}/study-sessions/${session.id}/lesson-execution/prepare`;
        const prepareInput = {
          command: goldenCommand(workspaceId, `${item.id}-prepare`),
          expectedSessionVersion: session.version,
          expectedAgendaVersion: agenda.version,
          expectedAgendaItemId: item.id,
        };
        let lesson = await goldenRequest<LessonExecutionProjection>(app, prepareUrl, prepareInput);
        expect(lesson.status, JSON.stringify(lesson)).toBe('ready');
        const afterEnsure = { ...tracked.calls };
        expect(await goldenRequest(app, prepareUrl, prepareInput)).toEqual(lesson);
        expect(
          await goldenRequest(app, `${base}/study-sessions/${session.id}/lesson-execution`),
        ).toEqual(lesson);
        lesson = await goldenRequest<LessonExecutionProjection>(app, prepareUrl, {
          ...prepareInput,
          command: goldenCommand(workspaceId, `${item.id}-accepted-reuse`),
          expectedSessionVersion: lesson.session.version,
          expectedAgendaVersion: lesson.agenda!.version,
        });
        expect(lesson.status).toBe('ready');
        expect(tracked.calls).toEqual(afterEnsure);
        lesson = await presentGoldenLesson(app, workspaceId, session, item.id, lesson);
        const perform = async (
          suffix: string,
          action: Parameters<typeof goldenLessonCommand>[6],
        ) => {
          lesson = await goldenLessonCommand(
            app,
            workspaceId,
            session.id,
            item.id,
            lesson,
            `${item.id}-${suffix}`,
            action,
          );
        };
        if (!repairObserved) {
          const practiceItem = lesson.practice!.item!;
          await perform('wrong-answer', {
            kind: 'submit_practice_response',
            itemIndex: practiceItem.index,
            optionId: publicOptionId(practiceItem.options, GOLDEN_ANSWERS.wrongPractice),
          });
          expect(lesson.practice!.attempts[0]).toMatchObject({ correct: false });
          expect(lesson.practice!.attempts[0]!.recovered).not.toBe(true);
          expect(lesson.practice!.recovery).toMatchObject({
            phase: 'diagnosis',
            selectedAnswer: GOLDEN_ANSWERS.wrongPractice,
          });
          expect(lesson.practice!.recovery!.feedback).toContain('优先级');
          expect(lesson.practice!.status).not.toBe('completed');
          const beforeRepairCalls = { ...tracked.calls };
          await perform('repair', {
            kind: 'prepare_practice_repair',
            learnerNote: '我误以为提高优先级就能归还配额。',
          });
          expect(lesson.practice!.recovery).toMatchObject({ phase: 'repair' });
          expect(lesson.practice!.recovery!.teaching!.explanation).toBeTruthy();
          expect(tracked.calls.generatePracticeRepair).toBe(
            (beforeRepairCalls.generatePracticeRepair ?? 0) + 1,
          );
          await perform('retest-start', { kind: 'start_practice_retest' });
          for (const index of [0, 1] as const) {
            const task = lesson.practice!.recovery!.retest!;
            expect(task.index).toBe(index);
            expect(lesson.practice!.recovery!.teaching).toBeNull();
            await perform(`retest-${index}`, {
              kind: 'submit_practice_retest',
              index,
              optionId: publicOptionId(task.options, GOLDEN_ANSWERS.retest[index]),
            });
            if (index === 0) {
              expect(lesson.practice!.status).not.toBe('completed');
              expect(lesson.practice!.attempts[0]!.recovered).not.toBe(true);
              expect(lesson.practice!.recovery!.retest!.index).toBe(1);
              expect(
                (await goldenOverview(app, workspaceId)).formalProgress.completedPlanItemCount,
              ).toBe(0);
            }
          }
          expect(lesson.practice!.attempts[0]).toMatchObject({ correct: false, recovered: true });
          repairObserved = true;
        }
        for (
          let practiceStep = 0;
          lesson.practice!.status !== 'completed' && practiceStep < 10;
          practiceStep += 1
        ) {
          const task = lesson.practice!.item!;
          await perform(`correct-${practiceStep}`, {
            kind: 'submit_practice_response',
            itemIndex: task.index,
            optionId: publicOptionId(task.options, GOLDEN_ANSWERS.practice),
          });
        }
        expect(lesson.practice!.status).toBe('completed');
        expect(
          (await goldenRequest<FormalProgressionOverview>(app, `${base}/progression`)).evidence,
        ).toEqual(progressionBefore.evidence);
        // Informal success cannot turn this unit into a formally completed one.
        const progress = await goldenRequest<CourseLearningProgress>(
          app,
          `${base}/learning-progress`,
        );
        expect(
          progress.units.find((unit) => unit.id === item.learningUnitId)!.formalState,
        ).not.toBe('complete');
        expect(context.repos.mastery.listByWorkspace(workspaceId)).toEqual([]);
        taught.push(item.learningUnitId!);
      } else {
        expect(item.kind).toBe('formal_checkpoint');
        const launch = await goldenRequest<CourseActionLaunchResult>(
          app,
          `${base}/agendas/${agendaId}/items/${item.id}/launch`,
          {
            command: goldenCommand(workspaceId, `${item.id}-launch`),
            agendaId,
            expectedAgendaVersion: agenda.version,
            agendaItemId: item.id,
            expectedContractId: course.contract.id,
            expectedStudyPlanId: plan.id,
            expectedExecutionSourceManifestFingerprint:
              course.curriculum.executionSourceManifest.fingerprint,
          },
        );
        if (launch.kind !== 'assessment' || !launch.formalAssessmentVersionId)
          throw new Error(`Checkpoint did not launch: ${JSON.stringify(launch)}`);
        const { execution } = await goldenRequest<{ execution: LearnerAssessmentExecution }>(
          app,
          `${base}/formal-assessment-versions/${launch.formalAssessmentVersionId}/execution`,
          {},
        );
        expect(execution.result).toBeNull();
        // This is the learner's authored course summary, not a saved grading key.
        const title = units.find((unit) => unit.id === item.learningUnitId)!.title;
        const source = GOLDEN_UNITS.find((unit) => unit.title === title)!;
        const responses = Object.fromEntries(
          execution.items.map((task) => [task.itemId, source.paragraphs.join(' ')]),
        );
        const submitted = await goldenRequest<{ execution: LearnerAssessmentExecution }>(
          app,
          `/api/formal-assessment-attempts/${execution.attempt.id}/learner-submit`,
          { responses },
        );
        expect(submitted.execution.result, JSON.stringify(submitted)).toMatchObject({
          demonstrated: true,
        });
        const progression = await goldenRequest<FormalProgressionOverview>(
          app,
          `${base}/progression`,
        );
        expect(progression.evidence.length).toBe(progressionBefore.evidence.length + 1);
        expect(progression.evidence.at(-1)).toMatchObject({ stateCreditable: true });
        expect(progression.reconciliations.at(-1)).toMatchObject({ status: 'applied' });
        checked.push(item.learningUnitId!);
      }
    }
    expect(repairObserved).toBe(true);
    expect(taught).toEqual(units.map((unit) => unit.id));
    expect(checked).toEqual(units.map((unit) => unit.id));
    expect(agendaIds.size).toBeGreaterThan(1);
    const complete = await goldenOverview(app, workspaceId);
    expect(complete.nextAction).toBeNull();
    expect(complete.formalProgress).toMatchObject({
      planItemCount: 6,
      completedPlanItemCount: 6,
      deferredPlanItemCount: 0,
    });
    const progress = await goldenRequest<CourseLearningProgress>(app, `${base}/learning-progress`);
    expect(progress.summary).toMatchObject({
      teachingTotal: 3,
      teachingCompleted: 3,
      supportedObjectives: 3,
      openRepairs: 0,
    });
    expect(progress.units.every((unit) => unit.formalState === 'complete')).toBe(true);
    expect(
      progress.assessments.every(
        (assessment) => assessment.credited && assessment.result === 'supported',
      ),
    ).toBe(true);
    expect(
      context.repos.studyPlans.listProgress(plan.id).every((entry) => entry.state === 'completed'),
    ).toBe(true);
    const outcomeInput = {
      command: goldenCommand(workspaceId, 'course-achieved'),
      expectedCourseExecutionVersion: complete.courseExecutionVersion,
      expectedContractVersionId: course.contract.id,
      expectedCurriculumVersionId: course.curriculum.id,
      expectedStudyPlanVersionId: plan.id,
      expectedAgendaVersionId: complete.activeAgenda!.id,
      status: 'achieved',
      unresolvedRiskIds: [],
      reason: '三个主题的教学和正式检查均已完成。',
    };
    const { outcome } = await goldenRequest<{ outcome: GoalOutcome }>(
      app,
      `${base}/goal-outcomes`,
      outcomeInput,
    );
    expect(outcome).toMatchObject({ status: 'achieved', unresolvedRiskIds: [] });
    expect(outcome.formalEvidenceIds).toHaveLength(3);
    expect(await goldenRequest(app, `${base}/goal-outcomes`, outcomeInput)).toEqual({ outcome });

    const finalReads = async (active: TestApp) => ({
      overview: await goldenOverview(active.app, workspaceId),
      progression: await goldenRequest<FormalProgressionOverview>(
        active.app,
        `${base}/progression`,
      ),
      learning: await goldenRequest<CourseLearningProgress>(
        active.app,
        `${base}/learning-progress`,
      ),
      plan: await goldenRequest<{ studyPlan: StudyPlan }>(
        active.app,
        `${base}/study-plans/${plan.id}`,
      ),
      preparation: await goldenRequest(active.app, `${base}/preparation`),
      sessions: await Promise.all(
        [...sessionIds].map((id) =>
          goldenRequest<StudySessionDetailResponse>(active.app, `${base}/study-sessions/${id}`),
        ),
      ),
      planProgress: active.repos.studyPlans.listProgress(plan.id),
    });
    const finalCalls = { ...tracked.calls };
    expect(finalCalls).toMatchObject({
      analyzeConcepts: 3,
      proposeCourseMap: 1,
      proposeCurriculumDetails: 1,
      generateLessonSlotContent: 3,
      generatePracticeContent: 3,
      generatePracticeRepair: 1,
      proposeAssessment: 3,
      gradeShortAnswer: 3,
    });
    const saved = await finalReads(context);
    expect(saved.overview).toMatchObject({
      executionStatus: 'stopped',
      acceptedStudyPlan: null,
      activeAgenda: null,
      nextAction: null,
    });
    expect(saved.plan.studyPlan.status).toBe('closed');
    expect(saved.progression.goalOutcomes).toEqual([outcome]);
    expect(saved.learning.assessments).toHaveLength(3);
    expect(saved.learning.lessons.filter((lesson) => lesson.completedAt)).toHaveLength(3);
    expect(new Set(saved.sessions.map((detail) => detail.agenda.id)).size).toBe(agendaIds.size);
    expect(
      saved.sessions.every((detail) =>
        detail.agenda.items.every((item) => item.state === 'completed'),
      ),
    ).toBe(true);
    expect(tracked.calls).toEqual(finalCalls);

    await app.close();
    tracked = goldenProvider();
    context = buildTestApp({ databasePath, provider: tracked.provider });
    expect(await finalReads(context)).toEqual(saved);
    expect(tracked.calls).toEqual({});
    console.info('Golden Journey Provider calls:', JSON.stringify(finalCalls));
  }, 240_000);
});
