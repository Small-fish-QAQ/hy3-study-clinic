import { describe, expect, it } from 'vitest';
import { projectTaughtExposure, type LearningContractDraftFields } from '@hy3-clinic/shared';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { createRepositories } from '../repositories/index.js';
import { fixedClock } from '../util/ids.js';
import { createServices } from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const SOURCE = 'Working memory has limited capacity;';

class RouteChangingFakeProvider extends FakeProvider {
  onAssessmentProposal: (() => void) | null = null;

  override async proposeAssessment(...args: Parameters<FakeProvider['proposeAssessment']>) {
    const result = await super.proposeAssessment(...args);
    this.onAssessmentProposal?.();
    return result;
  }
}

function command(workspaceId: string, id: string, actor: 'learner' | 'local' = 'learner') {
  return { commandId: id, idempotencyKey: id, workspaceId, actor } as const;
}

describe('ordinary Fake learning execution core loop', () => {
  it('carries exact source authority through formal grading into deterministic progression', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const provider = new RouteChangingFakeProvider();
    const services = createServices({
      repos,
      provider,
      clock: fixedClock(NOW),
    });

    const workspace = services.workspaces.create({ name: 'Memory course' });
    const created = services.materials.create(
      { title: 'Memory notes', content: SOURCE },
      workspace.id,
    );
    const material = created.material;
    const revision = repos.materialRevisions.getActive(material.id)!;
    const block = created.blocks[0]!;
    expect(
      repos.sourceAuthority.findEligibleByBlock(workspace.id, revision.id, block.id),
    ).not.toHaveLength(0);
    expect(repos.learningContracts.list(workspace.id)).toEqual([]);

    const analysis = await services.analysis.analyze(material.id);
    expect(analysis.concepts).not.toHaveLength(0);

    const currentRole = repos.materialRoles.getCurrent(material.id)!;
    const roleProposal = services.materialRoles.propose({
      command: command(workspace.id, 'role-propose'),
      materialId: material.id,
      role: 'course_material',
      expectedCurrentAssignmentId: currentRole.id,
    });
    const role = services.materialRoles.confirm({
      command: command(workspace.id, 'role-confirm'),
      assignmentId: roleProposal.id,
      expectedVersion: roleProposal.version,
    });

    const fields: LearningContractDraftFields = {
      intent: 'Learn the source-defined limit of working memory.',
      targetOutcome: {
        description: 'Explain the source accurately.',
        targetScore: null,
        credential: null,
      },
      deadline: null,
      studyBudget: {
        minutesPerDay: 60,
        minutesPerWeek: null,
        preferredSessionMinutes: 60,
        unavailablePeriods: [],
      },
      desiredDepth: 'working_fluency',
      courseScope: {
        subjectBoundaries: ['Working memory'],
        materials: [
          {
            materialId: material.id,
            materialRoleAssignmentId: role.id,
            materialRoleAssignmentVersion: role.version,
            role: role.role,
            disposition: 'included',
          },
        ],
        includedTopics: ['Working memory capacity'],
        excludedTopics: [],
      },
      learnerSelfReport: null,
      examContext: null,
      riskTolerance: {
        description: null,
        allowExplicitDeferral: true,
        maximumUnresolvedPriority: 'high',
      },
    };
    const draft = services.learningContracts.createDraft({
      command: command(workspace.id, 'contract-draft'),
      fields,
      predecessorContractId: null,
      expectedActiveContractId: null,
    }).contract;
    const proposedContract = services.learningContracts.transition({
      command: command(workspace.id, 'contract-propose'),
      contractId: draft.id,
      expectedVersion: draft.version,
      transition: 'propose',
    }).contract;
    const contract = services.learningContracts.transition({
      command: command(workspace.id, 'contract-confirm'),
      contractId: proposedContract.id,
      expectedVersion: proposedContract.version,
      transition: 'confirm',
    }).contract;

    const proposedCurriculum = await services.curriculum.propose({
      command: command(workspace.id, 'curriculum-propose', 'local'),
      contractId: contract.id,
      expectedContractVersion: contract.version,
      predecessorCurriculumId: null,
      expectedActiveCurriculumId: null,
    });
    const curriculum = services.curriculum.accept({
      command: command(workspace.id, 'curriculum-accept'),
      curriculumId: proposedCurriculum.curriculum.id,
      expectedVersion: proposedCurriculum.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        proposedCurriculum.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const objective = curriculum.nodes
      .flatMap((node) => node.learningUnit?.objectives ?? [])
      .find((candidate) => candidate.truthPremiseStatus === 'independently_verified');
    expect(objective?.truthAuthorityRecordIds.length).toBeGreaterThan(0);

    const proposedPlan = await services.studyPlansAgent.propose({
      command: command(workspace.id, 'plan-propose', 'local'),
      contractId: contract.id,
      expectedContractVersion: contract.version,
      curriculumId: curriculum.id,
      expectedCurriculumVersion: curriculum.version,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      predecessorStudyPlanId: null,
      expectedAcceptedStudyPlanId: null,
      proposalTrigger: 'Initial learner-confirmed route.',
    });
    const route = services.courseExecution.decideStudyPlan({
      command: command(workspace.id, 'plan-accept'),
      studyPlanId: proposedPlan.studyPlan.id,
      expectedVersion: proposedPlan.studyPlan.version,
      expectedContractId: contract.id,
      expectedCurriculumId: curriculum.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      decision: 'accept',
      reason: null,
    }).activeRoute!;
    const checkpoint = route.agenda.items.find((item) => item.kind === 'formal_checkpoint');
    expect(checkpoint?.launch).toMatchObject({
      status: 'launchable',
      capability: 'assessment',
    });

    const teachingItem = route.agenda.items.find(
      (item) =>
        item.kind === 'learning_unit_teaching' &&
        item.learningUnitId === checkpoint?.learningUnitId,
    );
    expect(teachingItem?.launch).toMatchObject({
      status: 'launchable',
      capability: 'lesson',
    });
    const lessonLaunch = await services.courseActionLaunch.launch({
      command: command(workspace.id, 'lesson-launch'),
      agendaId: route.agenda.id,
      expectedAgendaVersion: route.agenda.version,
      agendaItemId: teachingItem!.id,
      expectedContractId: contract.id,
      expectedStudyPlanId: route.studyPlan.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    });
    expect(lessonLaunch).toMatchObject({
      kind: 'lesson',
      agendaItemId: teachingItem!.id,
      learningUnitId: checkpoint!.learningUnitId,
    });
    const execution = repos.courseExecution.get(workspace.id);
    const startedSession = services.studySessions.start(workspace.id, {
      contractVersionId: contract.id,
      curriculumVersionId: curriculum.id,
      studyPlanVersionId: route.studyPlan.id,
      sessionAgendaId: route.agenda.id,
      expectedCourseExecutionVersion: execution.version,
    }).session;
    expect(startedSession.currentAgendaItemId).toBe(teachingItem!.id);
    const preparedLesson = await services.lessonExecution.ensure(workspace.id, startedSession.id, {
      command: command(workspace.id, 'lesson-prepare'),
      expectedSessionVersion: startedSession.version,
      expectedAgendaVersion: route.agenda.version,
      expectedAgendaItemId: teachingItem!.id,
    });
    expect(preparedLesson.status).toBe('ready');
    const startedLesson = await services.lessonExecution.command(workspace.id, startedSession.id, {
      command: command(workspace.id, 'lesson-start'),
      expectedSessionVersion: preparedLesson.session.version,
      expectedAgendaVersion: preparedLesson.agenda!.version,
      expectedAgendaItemId: teachingItem!.id,
      expectedLessonStateVersion: preparedLesson.progress!.stateVersion,
      action: { kind: 'start_lesson' },
    });
    expect(startedLesson.progress).toMatchObject({
      presentedSegmentIndexes: [0],
      presentationCompletedAt: null,
    });
    const lessonState = repos.lessonExecution.getForSession(startedSession.id, teachingItem!.id)!;
    const teachingBrief = repos.teachingBriefs.get(lessonState.teachingBriefId!)!;
    const acceptedLessonCheckpoint = repos.acceptedLessonCheckpoints.get(
      lessonState.acceptedLessonCheckpointId!,
    )!;
    expect(
      projectTaughtExposure({
        brief: teachingBrief,
        state: lessonState,
        checkpoint: acceptedLessonCheckpoint,
      }),
    ).toMatchObject({
      objectiveIds: expect.arrayContaining([objective!.id]),
      presentedSegmentIndexes: [0],
    });

    let launchAgenda = route.agenda;
    for (const invalidState of ['blocked', 'completed', 'cancelled'] as const) {
      const prior = launchAgenda;
      launchAgenda = repos.sessionAgendas.update(
        {
          ...prior,
          version: prior.version + 1,
          items: prior.items.map((item) =>
            item.id === checkpoint!.id ? { ...item, state: invalidState } : item,
          ),
          updatedAt: NOW,
        },
        prior.version,
        {
          id: `agenda_state_${invalidState}`,
          eventType: 'test_state_transition',
          actor: 'local',
          payload: { state: invalidState },
          createdAt: NOW,
        },
      );
      const blockedLaunch = await services.courseActionLaunch.launch({
        command: command(workspace.id, `launch-${invalidState}-item`),
        agendaId: launchAgenda.id,
        expectedAgendaVersion: launchAgenda.version,
        agendaItemId: checkpoint!.id,
        expectedContractId: contract.id,
        expectedStudyPlanId: route.studyPlan.id,
        expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      });
      expect(blockedLaunch).toMatchObject({
        kind: 'blocked',
        agendaItemId: checkpoint!.id,
        reason: expect.stringContaining(`state ${invalidState}`),
      });
    }
    const invalid = launchAgenda;
    launchAgenda = repos.sessionAgendas.update(
      {
        ...invalid,
        version: invalid.version + 1,
        items: invalid.items.map((item) =>
          item.id === checkpoint!.id ? { ...item, state: 'queued' as const } : item,
        ),
        updatedAt: NOW,
      },
      invalid.version,
      {
        id: 'agenda_state_queued',
        eventType: 'test_state_transition',
        actor: 'local',
        payload: { state: 'queued' },
        createdAt: NOW,
      },
    );

    const quizCountBeforeFencedLaunch = (
      db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }
    ).n;
    provider.onAssessmentProposal = () => {
      db.prepare(
        `UPDATE agent_operations SET fencing_token = fencing_token + 1
         WHERE operation_type = 'launch_course_action' AND status = 'running'`,
      ).run();
      provider.onAssessmentProposal = null;
    };
    await expect(
      services.courseActionLaunch.launch({
        command: command(workspace.id, 'fenced-checkpoint-launch'),
        agendaId: launchAgenda.id,
        expectedAgendaVersion: launchAgenda.version,
        agendaItemId: checkpoint!.id,
        expectedContractId: contract.id,
        expectedStudyPlanId: route.studyPlan.id,
        expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      }),
    ).rejects.toThrow(/lease/i);
    expect((db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n).toBe(
      quizCountBeforeFencedLaunch,
    );
    expect(
      db
        .prepare(
          `SELECT a.status, a.error_code AS errorCode, c.status AS logicalStatus
           FROM model_call_attempts a
           JOIN model_logical_calls c ON c.id = a.logical_call_id
           WHERE c.operation_type = 'propose_formal_assessment'
           ORDER BY a.rowid DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({
      status: 'outcome_unknown',
      errorCode: 'OPERATION_LEASE_LOST',
      logicalStatus: 'failed',
    });

    const launched = await services.courseActionLaunch.launch({
      command: command(workspace.id, 'checkpoint-launch'),
      agendaId: launchAgenda.id,
      expectedAgendaVersion: launchAgenda.version,
      agendaItemId: checkpoint!.id,
      expectedContractId: contract.id,
      expectedStudyPlanId: route.studyPlan.id,
      expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
    });
    expect(launched.kind).toBe('assessment');
    if (launched.kind !== 'assessment') throw new Error('Expected a formal assessment.');
    expect(
      db
        .prepare(
          `SELECT COUNT(DISTINCT c.id) AS logicalCalls,
                  COUNT(DISTINCT CASE WHEN a.sent_at IS NOT NULL THEN a.id END) AS physicalAttempts
           FROM model_logical_calls c
           LEFT JOIN model_call_attempts a ON a.logical_call_id = c.id
           WHERE c.operation_type = 'propose_formal_assessment'`,
        )
        .get(),
    ).toEqual({ logicalCalls: 2, physicalAttempts: 2 });

    const contracts = repos.formalProgression.listQuestionContractsForQuiz(launched.quiz.id);
    expect(contracts).toEqual([
      expect.objectContaining({
        admissibilityTier: 'tier_1_authorized_truth',
        primaryObjectiveId: objective!.id,
      }),
    ]);
    const quiz = repos.quizzes.get(launched.quiz.id)!;
    const question = quiz.questions[0]!;
    expect(question.type).toBe('short_answer');
    if (question.type !== 'short_answer') throw new Error('Expected a short-answer checkpoint.');

    const outcome = await services.grading.grade(
      {
        quizId: quiz.id,
        answers: [
          {
            questionId: question.id,
            type: 'short_answer',
            text: question.expectedAnswer,
          },
        ],
      },
      {
        stateCreditResolver: () =>
          new Set(services.formalProgression.stateCreditingQuestionIdsForQuiz(quiz.id) ?? []),
      },
    );
    expect(outcome.result.overallScore).toBe(1);

    const progression = services.formalProgression.reconcileAfterGrading(outcome.result.id)!;
    expect(progression.evidence[0]).toMatchObject({
      admissibilityTier: 'tier_1_authorized_truth',
      stateCreditable: true,
    });
    expect(progression.reconciliations[0]?.status).toBe('applied');
    expect(progression.decisions[0]?.kind).toBe('complete');
    expect(
      repos.formalProgression.getUnitProgress(
        workspace.id,
        curriculum.id,
        checkpoint!.learningUnitId!,
      ),
    ).toMatchObject({ state: 'complete' });

    const successorDraft = services.learningContracts.createDraft({
      command: command(workspace.id, 'successor-contract-draft'),
      fields: { ...fields, intent: 'Continue the course under a revised learner intention.' },
      predecessorContractId: contract.id,
      expectedActiveContractId: contract.id,
    }).contract;
    const successorProposedContract = services.learningContracts.transition({
      command: command(workspace.id, 'successor-contract-propose'),
      contractId: successorDraft.id,
      expectedVersion: successorDraft.version,
      transition: 'propose',
    }).contract;
    const successorContract = services.learningContracts.transition({
      command: command(workspace.id, 'successor-contract-confirm'),
      contractId: successorProposedContract.id,
      expectedVersion: successorProposedContract.version,
      transition: 'confirm',
    }).contract;
    const successorCurriculumProposal = await services.curriculum.propose({
      command: command(workspace.id, 'successor-curriculum-propose', 'local'),
      contractId: successorContract.id,
      expectedContractVersion: successorContract.version,
      predecessorCurriculumId: curriculum.id,
      expectedActiveCurriculumId: curriculum.id,
    });
    const successorCurriculum = services.curriculum.accept({
      command: command(workspace.id, 'successor-curriculum-accept'),
      curriculumId: successorCurriculumProposal.curriculum.id,
      expectedVersion: successorCurriculumProposal.curriculum.version,
      expectedContractId: successorContract.id,
      expectedExecutionSourceManifestFingerprint:
        successorCurriculumProposal.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const successorOverview = services.courseOverview.get(workspace.id);
    expect(successorOverview).toMatchObject({
      activeContract: { id: contract.id },
      pendingContract: { id: successorContract.id },
      acceptedCurriculum: { id: curriculum.id },
      planningCurriculum: { id: successorCurriculum.id },
      acceptedStudyPlan: { id: route.studyPlan.id },
      capabilities: { canProposeStudyPlan: true },
    });
    const successorPlan = await services.studyPlansAgent.propose({
      command: command(workspace.id, 'successor-plan-propose', 'local'),
      contractId: successorContract.id,
      expectedContractVersion: successorContract.version,
      curriculumId: successorOverview.planningCurriculum!.id,
      expectedCurriculumVersion: successorOverview.planningCurriculum!.version,
      expectedExecutionSourceManifestFingerprint:
        successorOverview.planningCurriculum!.executionSourceManifest.fingerprint,
      predecessorStudyPlanId: route.studyPlan.id,
      expectedAcceptedStudyPlanId: route.studyPlan.id,
      proposalTrigger: 'Learner-confirmed successor intention.',
    });
    expect(successorPlan.studyPlan).toMatchObject({
      contractVersionId: successorContract.id,
      curriculumVersionId: successorCurriculum.id,
      predecessorId: route.studyPlan.id,
      status: 'proposed',
    });

    const contractBeforeRevisionChange = repos.learningContracts.get(contract.id);
    const quizCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number })
      .n;
    const nextContent = `${SOURCE} Updated extraction.`;
    repos.materialRevisions.stage({
      revisionId: 'revision_after_route',
      material: {
        ...material,
        content: nextContent,
        charCount: nextContent.length,
        updatedAt: NOW,
      },
      blocks: [
        {
          ...block,
          id: 'block_after_route',
          content: nextContent,
          startOffset: 0,
          endOffset: nextContent.length,
        },
      ],
      originalData: null,
      parserFingerprint: 'parser-after-route',
      contentFingerprint: 'content-after-route',
      parserAttemptId: 'parser-attempt-after-route',
      createdAt: NOW,
    });
    const latestRouteState = repos.courseExecution.get(workspace.id);
    const latestAgenda = repos.sessionAgendas.get(latestRouteState.activeAgendaId!)!;
    repos.materialRevisions.activate(material.id, 'revision_after_route', NOW);

    await expect(
      services.courseActionLaunch.launch({
        command: command(workspace.id, 'stale-checkpoint-launch'),
        agendaId: route.agenda.id,
        expectedAgendaVersion: latestAgenda.version,
        agendaItemId: checkpoint!.id,
        expectedContractId: contract.id,
        expectedStudyPlanId: route.studyPlan.id,
        expectedExecutionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    expect((db.prepare('SELECT COUNT(*) AS n FROM quizzes').get() as { n: number }).n).toBe(
      quizCountBefore,
    );
    expect(repos.learningContracts.get(contract.id)).toEqual(contractBeforeRevisionChange);
    expect(repos.courseExecution.get(workspace.id)).toMatchObject({
      activeContractId: contract.id,
      acceptedPlanId: route.studyPlan.id,
      routeValidationStatus: 'revalidation_required',
    });
  });
});
