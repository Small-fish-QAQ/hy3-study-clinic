import {
  CourseLearningProgressSchema,
  type CourseRepairRecord,
  type CourseAssessmentRecord,
  evaluateDurableMastery,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import { practiceItemPassed } from './practiceRecovery.js';
import { initialReviewSchedulingPending } from './reviewSuccessor.js';

/** Read-only join of the current objective workflow and immutable attempt history. */
export function createCourseLearningProgressService({ repos }: { repos: Repositories }) {
  return {
    get(workspaceId: string) {
      if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
      const route = repos.courseExecution.get(workspaceId);
      const curriculum = route.activeCurriculumId
        ? repos.curricula.get(route.activeCurriculumId)
        : undefined;
      const plan = route.acceptedPlanId ? repos.studyPlans.get(route.acceptedPlanId) : undefined;
      const contract = route.activeContractId
        ? repos.learningContracts.get(route.activeContractId)
        : undefined;
      const routeCurrent =
        route.routeValidationStatus === 'valid' &&
        !!curriculum &&
        !!plan &&
        contract?.workspaceId === workspaceId &&
        contract.status === 'active' &&
        curriculum.workspaceId === workspaceId &&
        curriculum.status === 'accepted' &&
        curriculum.validation.valid &&
        plan.workspaceId === workspaceId &&
        plan.status === 'accepted' &&
        plan.curriculumVersionId === curriculum.id &&
        plan.contractVersionId === contract.id &&
        curriculum.contractVersionId === contract.id &&
        plan.executionSourceManifestFingerprint ===
          curriculum.executionSourceManifest.fingerprint &&
        curriculum.executionSourceManifest.revisions.every((revision) => {
          const material = repos.materials.getRouteIdentity(revision.materialId);
          return (
            material?.availability === 'active' &&
            material.activeRevisionId === revision.materialRevisionId
          );
        });
      const progress = new Map(
        (plan ? repos.studyPlans.listProgress(plan.id) : []).map((item) => [
          item.planItemId,
          item.state,
        ]),
      );
      const currentContext = (
        context:
          | {
              contractVersionId: string;
              curriculumVersionId: string;
              studyPlanVersionId: string;
              executionSourceManifestFingerprint: string;
            }
          | null
          | undefined,
      ) =>
        !!context &&
        routeCurrent &&
        context.contractVersionId === contract!.id &&
        context.curriculumVersionId === curriculum!.id &&
        context.studyPlanVersionId === plan!.id &&
        context.executionSourceManifestFingerprint === plan!.executionSourceManifestFingerprint;
      const records = repos.formalAssessments.listProjectionRecords(workspaceId);
      const versions = new Map(
        records.versions
          .filter((version) => version.authorityMode === 'formal')
          .map((version) => [version.id, version]),
      );
      const episodes = repos.repair.listByWorkspace(workspaceId);
      const creditedObjectives = new Set<string>();
      const assessments: CourseAssessmentRecord[] = records.attempts
        .flatMap((attempt): CourseAssessmentRecord[] => {
          const version = versions.get(attempt.assessmentVersionId);
          if (!version) return [];
          const grade = records.grades.find(
            (item) => item.attemptId === attempt.id && item.status === 'current',
          );
          const evidence = records.evidence.filter((item) => item.gradeRecordId === grade?.id);
          const current =
            version.status === 'accepted' && currentContext(version.progressionContext);
          const credited = evidence.filter(
            (item) =>
              item.conclusion === 'supported' &&
              records.reconciliations.some(
                (r) => r.evidenceRecordId === item.id && r.status === 'applied',
              ),
          );
          if (current)
            for (const record of credited) {
              const objectiveId = version.items.find(
                (item) => item.id === record.itemId,
              )?.targetObjectiveId;
              if (objectiveId) creditedObjectives.add(objectiveId);
            }
          const supported =
            evidence.length > 0 && evidence.every((item) => item.conclusion === 'supported');
          const repair = episodes.find(
            (item) =>
              item.triggerAttemptId === attempt.id || item.verificationAttemptId === attempt.id,
          );
          return [
            {
              attemptId: attempt.id,
              versionId: version.id,
              title:
                repos.formalAssessments.getDefinition(version.definitionId)?.title ?? '正式检查',
              learningUnitId: version.items[0]?.targetLearningUnitId ?? null,
              objectiveIds: [...new Set(version.items.map((item) => item.targetObjectiveId))],
              current,
              status: attempt.status,
              result: !grade
                ? 'pending'
                : supported
                  ? 'supported'
                  : evidence.some(
                        (item) => item.conclusion === 'partial' || item.conclusion === 'supported',
                      )
                    ? 'partial'
                    : 'unsupported',
              credited: current && supported && credited.length === evidence.length,
              reconciliationPending:
                current &&
                evidence.some(
                  (item) => item.conclusion === 'supported' && !credited.includes(item),
                ),
              reviewSchedulingPending:
                current && initialReviewSchedulingPending(repos, version, evidence),
              startedAt: attempt.startedAt,
              submittedAt: attempt.submittedAt,
              feedback: grade?.judgment.feedback ?? null,
              repairEpisodeId: repair?.id ?? null,
              repairResolved: repair?.status === 'RESOLVED',
              // No unseen prompts, rubrics or answers are exposed by browsing progress.
              items:
                attempt.status === 'submitted'
                  ? version.items.map((item) => ({
                      prompt: item.prompt,
                      response: attempt.responses[item.id] ?? '',
                    }))
                  : [],
              criteria: grade
                ? grade.judgment.criterionResults.map((result) => ({
                    label:
                      version.items
                        .flatMap((item) => item.rubric ?? [])
                        .find((criterion) => criterion.id === result.criterionId)?.text ??
                      '评分标准',
                    result: result.result,
                  }))
                : [],
            },
          ];
        })
        .sort(
          (a, b) =>
            b.startedAt.localeCompare(a.startedAt) || b.attemptId.localeCompare(a.attemptId),
        );
      const repairs: CourseRepairRecord[] = episodes.map((episode) => {
        const version = versions.get(episode.assessmentVersionId);
        const unit = curriculum?.nodes.find((node) => node.id === episode.targetLearningUnitId);
        return {
          id: episode.id,
          kind: 'formal',
          title: unit?.title ?? '正式检查修复',
          learningUnitId: episode.targetLearningUnitId,
          status: episode.status,
          resolved: episode.status === 'RESOLVED',
          current: currentContext(version?.progressionContext),
          description: episode.gapSummary,
          updatedAt: episode.updatedAt,
          versionId: episode.assessmentVersionId,
          sessionId: null,
        };
      });
      const lessonStates = repos.lessonExecution.listForWorkspace(workspaceId);
      const sessions = new Map(
        repos.studySessions.list(workspaceId).map((session) => [session.id, session]),
      );
      for (const state of lessonStates) {
        const session = sessions.get(state.sessionId);
        const unit = repos.curricula
          .get(state.curriculumVersionId)
          ?.nodes.find((node) => node.id === state.learningUnitId);
        const failedItems = new Map(
          state.practiceInteractions
            .filter((attempt) => !attempt.correct)
            .map((attempt) => [attempt.itemIndex, attempt]),
        );
        for (const attempt of failedItems.values()) {
          const resolved = practiceItemPassed(state, attempt.itemIndex);
          repairs.push({
            id: `${state.id}:${attempt.itemIndex}`,
            kind: 'practice',
            title: unit?.title ?? '课堂练习',
            learningUnitId: state.learningUnitId,
            status: resolved ? 'RESOLVED' : 'OPEN',
            resolved,
            current:
              routeCurrent &&
              (session?.status === 'active' || session?.status === 'paused') &&
              state.curriculumVersionId === curriculum!.id &&
              state.studyPlanVersionId === plan!.id,
            description:
              attempt.recovery?.rounds.at(-1)?.content.diagnosis.gap ??
              '这道课堂练习需要补充讲解并重新练习，不计入正式证据。',
            updatedAt: state.updatedAt,
            versionId: null,
            sessionId: state.sessionId,
          });
        }
      }
      const unitProgress = new Map(
        (curriculum
          ? repos.formalProgression.listUnitProgress(workspaceId, curriculum.id)
          : []
        ).map((unit) => [unit.learningUnitId, unit.state]),
      );
      const completionPolicy = contract
        ? repos.formalProgression.latestCompletionPolicy(contract.id)
        : undefined;
      const reviewRecords = repos.reviewSuccessor.listProjectionRecords(workspaceId);
      const currentGrades = new Set(
        records.grades.filter((grade) => grade.status === 'current').map((grade) => grade.id),
      );
      const submittedAttempts = new Set(
        records.attempts
          .filter((attempt) => attempt.status === 'submitted')
          .map((attempt) => attempt.id),
      );
      const appliedEvidence = new Set(
        records.reconciliations
          .filter((record) => record.status === 'applied')
          .map((record) => record.evidenceRecordId),
      );
      const exposures = new Map(
        records.exposures.map((exposure) => [`${exposure.attemptId}:${exposure.itemId}`, exposure]),
      );
      const units = (curriculum?.nodes ?? [])
        .filter((node) => node.learningUnit)
        .map((node) => {
          const teaching = (plan?.items ?? []).filter(
            (item) => item.kind === 'teach_unit' && item.curriculumLearningUnitId === node.id,
          );
          const reviewTargetIds = new Set(
            reviewRecords.bindings
              .filter(
                (binding) =>
                  binding.validTo === null &&
                  binding.contractVersionId === contract?.id &&
                  binding.curriculumVersionId === curriculum?.id &&
                  binding.learningUnitId === node.id &&
                  binding.executionSourceManifestFingerprint ===
                    plan?.executionSourceManifestFingerprint,
              )
              .map((binding) => binding.reviewTargetId),
          );
          const durableMastery =
            routeCurrent && completionPolicy
              ? evaluateDurableMastery({
                  routeProgressComplete: unitProgress.get(node.id) === 'complete',
                  currentReviewFailure: [...reviewTargetIds].some(
                    (targetId) =>
                      reviewRecords.events
                        .filter((event) => event.reviewTargetId === targetId)
                        .at(-1)?.kind === 'retrieval_failure',
                  ),
                  policy: completionPolicy.durableMastery,
                  evidence: records.evidence.flatMap((record) => {
                    const version = versions.get(record.assessmentVersionId);
                    const item = version?.items.find((item) => item.id === record.itemId);
                    if (
                      record.targetLearningUnitId !== node.id ||
                      version?.status !== 'accepted' ||
                      !currentContext(version.progressionContext) ||
                      !currentGrades.has(record.gradeRecordId) ||
                      !submittedAttempts.has(record.attemptId) ||
                      !item
                    )
                      return [];
                    const exposure = exposures.get(`${record.attemptId}:${record.itemId}`);
                    return [
                      {
                        evidenceId: record.id,
                        representation: item.representation,
                        supported: record.conclusion === 'supported',
                        reconciled: appliedEvidence.has(record.id),
                        delayedReview:
                          version.progressionContext?.assessmentKind === 'due_review' &&
                          reviewRecords.events.some(
                            (event) =>
                              reviewTargetIds.has(event.reviewTargetId) &&
                              event.kind === 'fresh_verification_success' &&
                              event.sourceOutcomeId === record.id,
                          ),
                        unseenBeforeAttempt:
                          exposure?.seenBeforeAttempt === false
                            ? true
                            : exposure?.seenBeforeAttempt === true
                              ? false
                              : null,
                      },
                    ];
                  }),
                })
              : null;
          return {
            id: node.id,
            title: node.title,
            durableMastery,
            teachingTotal: teaching.length,
            teachingCompleted: teaching.filter((item) => progress.get(item.id) === 'completed')
              .length,
            objectiveTotal: node.learningUnit!.objectives.length,
            supportedObjectives: node.learningUnit!.objectives.filter((objective) =>
              creditedObjectives.has(objective.id),
            ).length,
            formalState: routeCurrent ? (unitProgress.get(node.id) ?? 'not_started') : 'stale',
            scheduledTransfers: (plan?.items ?? []).filter(
              (item) =>
                item.synthesisMode === 'unit_transfer' && item.curriculumLearningUnitId === node.id,
            ).length,
            completedTransfers: (plan?.items ?? []).filter(
              (item) =>
                item.synthesisMode === 'unit_transfer' &&
                item.curriculumLearningUnitId === node.id &&
                progress.get(item.id) === 'completed',
            ).length,
            scheduledCheckpoints: (plan?.items ?? []).filter(
              (item) =>
                item.kind === 'formal_checkpoint' && item.curriculumLearningUnitId === node.id,
            ).length,
          };
        });
      return CourseLearningProgressSchema.parse({
        workspaceId,
        units,
        assessments,
        repairs: repairs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        summary: {
          teachingTotal: units.reduce((n, unit) => n + unit.teachingTotal, 0),
          teachingCompleted: units.reduce((n, unit) => n + unit.teachingCompleted, 0),
          objectiveTotal: units.reduce((n, unit) => n + unit.objectiveTotal, 0),
          supportedObjectives: units.reduce((n, unit) => n + unit.supportedObjectives, 0),
          openRepairs: repairs.filter(
            (repair) => repair.current && !repair.resolved && repair.status !== 'CANCELLED',
          ).length,
        },
        lessons: lessonStates.map((state) => ({
          id: state.id,
          title:
            repos.curricula
              .get(state.curriculumVersionId)
              ?.nodes.find((node) => node.id === state.learningUnitId)?.title ?? '课程讲解',
          completedAt:
            state.practiceCompletedAt ??
            (state.teachingBriefId && repos.teachingBriefs.get(state.teachingBriefId)?.practice
              ? null
              : state.presentationCompletedAt),
          updatedAt: state.updatedAt,
        })),
      });
    },
  };
}
export type CourseLearningProgressService = ReturnType<typeof createCourseLearningProgressService>;
