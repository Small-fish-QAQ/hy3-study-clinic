import { createHash } from 'node:crypto';
import {
  AssessmentAttemptSchema,
  AssessmentDefinitionSchema,
  AssessmentVersionSchema,
  ApiErrorCode,
  EvidenceRecordSchema,
  FORMAL_EVIDENCE_POLICY_VERSION,
  GradingResultSchema,
  GradeRecordSchema,
  ProgressionReconciliationRecordSchema,
  classifyFormalAssessmentItem,
  type AssessmentAttempt,
  type AssessmentAuthorityMode,
  type AssessmentIntentSelection,
  type AssessmentDefinition,
  type AssessmentVersion,
  type EvidenceRecord,
  type EvidenceRepresentation,
  type FormalAssessmentItem,
  type GradeRecord,
  type LessonExecutionState,
  type ProgressionReconciliationRecord,
  type Quiz,
  type TeachingBrief,
  decideFormalCredit,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { verifyGrounding } from '../grounding/verify.js';
import { DEFAULT_CONFIGURATION } from '../review/fsrsAdapter.js';
import type { FormalProgressionService } from './formalProgression.js';
import type { ReviewSuccessorService } from './reviewSuccessor.js';

const POLICY_VERSION = FORMAL_EVIDENCE_POLICY_VERSION;

function learnerVisibleItemFingerprint(prompt: string): string {
  return createHash('sha256').update(JSON.stringify({ prompt })).digest('hex');
}

export function assessmentItemFingerprint(item: FormalAssessmentItem): string {
  return learnerVisibleItemFingerprint(item.prompt);
}

/** Exact learner-visible Lesson/Practice surfaces already proven presented by durable state. */
export function lessonExecutionExposureFingerprints(
  brief: Pick<TeachingBrief, 'segments' | 'practice'>,
  state: Pick<
    LessonExecutionState,
    | 'presentedSegmentIndexes'
    | 'presentationCompletedAt'
    | 'practiceInteractions'
    | 'practiceCompletedAt'
  >,
): string[] {
  const fingerprints = new Set<string>();
  const presentedSegments = new Set(state.presentedSegmentIndexes);
  for (const segment of brief.segments) {
    if (presentedSegments.has(segment.index) && segment.informalCheck) {
      fingerprints.add(learnerVisibleItemFingerprint(segment.informalCheck.prompt));
    }
  }
  if (!brief.practice || !state.presentationCompletedAt) return [...fingerprints];

  for (const interaction of state.practiceInteractions) {
    const item = brief.practice.items[interaction.itemIndex];
    const surface = item?.[interaction.surface];
    if (surface) {
      fingerprints.add(learnerVisibleItemFingerprint(surface.prompt));
    }
  }

  if (!state.practiceCompletedAt) {
    const completed = (itemIndex: number) => {
      const attempts = state.practiceInteractions.filter(
        (interaction) => interaction.itemIndex === itemIndex,
      );
      return attempts.some((interaction) => interaction.correct) || attempts.length >= 2;
    };
    const unresolvedIndex = brief.practice.items.findIndex((_, index) => !completed(index));
    const itemIndex = unresolvedIndex === -1 ? brief.practice.items.length - 1 : unresolvedIndex;
    const item = brief.practice.items[itemIndex];
    if (item) {
      const attempts = state.practiceInteractions.filter(
        (interaction) => interaction.itemIndex === itemIndex,
      );
      const surface = attempts.length === 1 && !attempts[0]!.correct ? item.retry : item.initial;
      fingerprints.add(learnerVisibleItemFingerprint(surface.prompt));
    }
  }
  return [...fingerprints];
}

export function createFormalAssessmentsService({
  repos,
  clock,
  progression,
  reviewSuccessor,
}: {
  repos: Repositories;
  clock: Clock;
  progression: FormalProgressionService;
  reviewSuccessor?: ReviewSuccessorService;
}) {
  function getVersion(id: string) {
    const version = repos.formalAssessments.getVersion(id);
    if (!version) throw notFound(`正式评估版本不存在:${id}`);
    return version;
  }
  function validateItem(workspaceId: string, item: FormalAssessmentItem): FormalAssessmentItem {
    const materialIds = new Set<string>();
    for (const binding of item.sourceBindings) {
      const block = repos.materials.getBlock(binding.sourceBlockId);
      if (
        !block ||
        block.materialId !== binding.materialId ||
        block.materialRevisionId !== binding.materialRevisionId
      ) {
        throw new AppError(ApiErrorCode.ValidationError, '正式评估的来源绑定不存在或版本不匹配。');
      }
      const material = repos.materials.get(binding.materialId);
      if (!material || material.workspaceId !== workspaceId)
        throw notFound('正式评估来源不属于当前课程空间。');
      materialIds.add(binding.materialId);
      const verification = verifyGrounding([block], {
        blockId: binding.sourceBlockId,
        quote: binding.quote,
      });
      if (!verification.ok)
        throw new AppError(ApiErrorCode.ValidationError, '正式评估引文未通过本地原文校验。');
      const active = repos.materialRevisions.getActive(binding.materialId);
      if (!active || active.id !== binding.materialRevisionId) {
        return { ...item, formalEligible: false, policyReason: 'STALE_SOURCE_BINDING' };
      }
    }
    const policy = classifyFormalAssessmentItem({ ...item, sourceBindings: item.sourceBindings });
    return { ...item, formalEligible: policy.formalEligible, policyReason: policy.policyReason };
  }

  function hasCurrentFormalSource(item: FormalAssessmentItem): boolean {
    return item.sourceBindings.every((binding) => {
      const block = repos.materials.getBlock(binding.sourceBlockId);
      const active = repos.materialRevisions.getActive(binding.materialId);
      return Boolean(
        block &&
        block.materialId === binding.materialId &&
        block.materialRevisionId === binding.materialRevisionId &&
        active?.id === binding.materialRevisionId &&
        binding.contentOrigin === 'extracted_original' &&
        binding.authoritative &&
        verifyGrounding([block], {
          blockId: binding.sourceBlockId,
          quote: binding.quote,
        }).ok,
      );
    });
  }

  function createDefinition(
    input: Omit<AssessmentDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): AssessmentDefinition {
    if (!repos.workspaces.get(input.workspaceId))
      throw notFound(`课程空间不存在:${input.workspaceId}`);
    const now = clock.now().toISOString();
    return repos.formalAssessments.insertDefinition(
      AssessmentDefinitionSchema.parse({
        ...input,
        id: newId('assessment'),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  function createVersion(input: {
    definitionId: string;
    items: FormalAssessmentItem[];
    sourceRevisionIds: string[];
    predecessorId?: string | null;
    progressionContext?: AssessmentVersion['progressionContext'];
    authorityMode?: AssessmentAuthorityMode;
    assessmentIntent?: AssessmentIntentSelection;
  }): AssessmentVersion {
    const definition = repos.formalAssessments.getDefinition(input.definitionId);
    if (!definition) throw notFound(`正式评估定义不存在:${input.definitionId}`);
    const items = input.items.map((item) => validateItem(definition.workspaceId, item));
    const boundRevisionIds = new Set(
      items.flatMap((item) => item.sourceBindings.map((binding) => binding.materialRevisionId)),
    );
    const declaredRevisionIds = new Set(input.sourceRevisionIds);
    if (
      declaredRevisionIds.size !== boundRevisionIds.size ||
      [...declaredRevisionIds].some((revisionId) => !boundRevisionIds.has(revisionId))
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        '正式评估版本声明了未被题目绑定的来源修订。',
      );
    }
    const previous = repos.formalAssessments.listVersions(input.definitionId).at(-1);
    const authorityMode = input.authorityMode ?? 'formal';
    if (authorityMode === 'mastery_red_team_shadow' && input.progressionContext) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        '影子 Mastery Red Team 评估不能携带进度上下文。',
      );
    }
    if (input.assessmentIntent && !input.progressionContext) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Assessment intent requires an immutable progression stage.',
      );
    }
    const now = clock.now().toISOString();
    const version = AssessmentVersionSchema.parse({
      id: newId('assessment_version'),
      definitionId: input.definitionId,
      version: (previous?.version ?? 0) + 1,
      predecessorId: input.predecessorId ?? previous?.id ?? null,
      status: 'draft',
      items,
      sourceRevisionIds: [...new Set(input.sourceRevisionIds)],
      createdAt: now,
      acceptedAt: null,
      authorityMode,
      progressionContext: input.progressionContext ?? null,
    });
    return repos.transaction(() => {
      const inserted = repos.formalAssessments.insertVersion(version);
      if (input.assessmentIntent && inserted.progressionContext) {
        repos.formalAssessments.insertItemIntents(
          inserted.items.map((item) => ({
            id: newId('assessment_intent'),
            workspaceId: definition.workspaceId,
            assessmentVersionId: inserted.id,
            itemId: item.id,
            assessmentStage: inserted.progressionContext!.assessmentKind,
            ...input.assessmentIntent!,
            createdAt: now,
          })),
        );
      }
      return inserted;
    });
  }

  function startAttemptForMode(
    assessmentVersionId: string,
    workspaceId: string,
    authorityMode: AssessmentAuthorityMode,
  ): AssessmentAttempt {
    const version = getVersion(assessmentVersionId);
    const definition = repos.formalAssessments.getDefinition(version.definitionId);
    if (
      version.status !== 'accepted' ||
      version.authorityMode !== authorityMode ||
      !definition ||
      definition.workspaceId !== workspaceId
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        authorityMode === 'formal'
          ? '只能执行当前课程空间已接受的正式评估版本。'
          : '只能执行当前课程空间已接受的影子 Mastery Red Team 版本。',
      );
    }
    const now = clock.now().toISOString();
    return repos.formalAssessments.insertAttempt(
      AssessmentAttemptSchema.parse({
        id: newId('assessment_attempt'),
        assessmentVersionId,
        workspaceId,
        ordinal: repos.formalAssessments.nextAttemptOrdinal(assessmentVersionId),
        status: 'started',
        responses: {},
        startedAt: now,
        submittedAt: null,
        cancelledAt: null,
      }),
    );
  }

  function recordAttemptExposure(attemptId: string): AssessmentAttempt {
    const attempt = repos.formalAssessments.getAttempt(attemptId);
    if (!attempt) throw new AppError(ApiErrorCode.ValidationError, '评估尝试不存在。');
    const version = getVersion(attempt.assessmentVersionId);
    const definition = repos.formalAssessments.getDefinition(version.definitionId);
    if (!definition || definition.workspaceId !== attempt.workspaceId) {
      throw new AppError(ApiErrorCode.ValidationError, '评估尝试不属于当前课程空间。');
    }
    const visibleItems =
      version.authorityMode === 'formal'
        ? version.items.filter((item) => item.formalEligible)
        : version.items;
    if (visibleItems.every((item) => repos.formalAssessments.getExposure(attempt.id, item.id))) {
      return attempt;
    }

    const priorRecords = repos.formalAssessments.listProjectionRecords(attempt.workspaceId);
    const priorVersionById = new Map(
      priorRecords.versions.map((candidate) => [candidate.id, candidate]),
    );
    const recordedExposureKeys = new Set(
      priorRecords.exposures.map((exposure) => `${exposure.attemptId}:${exposure.itemId}`),
    );
    const exposureTrackedAttemptIds = new Set(
      repos.formalAssessments.listExposureTrackedAttemptIds(attempt.workspaceId),
    );
    const currentAttemptExposureTracked = exposureTrackedAttemptIds.has(attempt.id);
    const knownSeenFingerprints = new Set(
      priorRecords.exposures
        .filter((exposure) => exposure.attemptId !== attempt.id)
        .map((exposure) => exposure.itemFingerprint),
    );
    for (const lessonState of repos.lessonExecution.listForWorkspace(attempt.workspaceId)) {
      const brief = lessonState.teachingBriefId
        ? repos.teachingBriefs.get(lessonState.teachingBriefId)
        : undefined;
      if (!brief) continue;
      for (const fingerprint of lessonExecutionExposureFingerprints(brief, lessonState)) {
        knownSeenFingerprints.add(fingerprint);
      }
    }
    const historicallyUncertainFingerprints = new Set<string>();
    for (const priorAttempt of priorRecords.attempts) {
      if (priorAttempt.id === attempt.id) continue;
      const priorVersion = priorVersionById.get(priorAttempt.assessmentVersionId);
      if (!priorVersion) continue;
      const priorVisibleItems =
        priorVersion.authorityMode === 'formal'
          ? priorVersion.items.filter((item) => item.formalEligible)
          : priorVersion.items;
      for (const priorItem of priorVisibleItems) {
        if (
          !exposureTrackedAttemptIds.has(priorAttempt.id) &&
          !recordedExposureKeys.has(`${priorAttempt.id}:${priorItem.id}`)
        ) {
          historicallyUncertainFingerprints.add(assessmentItemFingerprint(priorItem));
        }
      }
    }
    const now = clock.now().toISOString();
    repos.transaction(() => {
      for (const item of visibleItems) {
        const itemFingerprint = assessmentItemFingerprint(item);
        repos.formalAssessments.insertExposure({
          id: newId('item_exposure'),
          workspaceId: attempt.workspaceId,
          assessmentVersionId: version.id,
          attemptId: attempt.id,
          itemId: item.id,
          itemFingerprint,
          surface:
            version.authorityMode === 'formal' ? 'formal_assessment' : 'mastery_red_team_shadow',
          seenBeforeAttempt: knownSeenFingerprints.has(itemFingerprint)
            ? true
            : !currentAttemptExposureTracked ||
                historicallyUncertainFingerprints.has(itemFingerprint)
              ? null
              : false,
          exposedAt: now,
        });
      }
    });
    return attempt;
  }

  function recordGradeForMode(input: GradeRecord, authorityMode: AssessmentAuthorityMode) {
    const attempt = repos.formalAssessments.getAttempt(input.attemptId);
    const version = repos.formalAssessments.getVersion(input.assessmentVersionId);
    if (
      !attempt ||
      attempt.status !== 'submitted' ||
      attempt.assessmentVersionId !== input.assessmentVersionId ||
      !version ||
      version.authorityMode !== authorityMode
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        '只能为已提交、版本一致且权威模式匹配的评估尝试判分。',
      );
    }
    if (input.supersedesId) {
      const prior = repos.formalAssessments.getGrade(input.supersedesId);
      if (
        !prior ||
        prior.attemptId !== input.attemptId ||
        prior.assessmentVersionId !== input.assessmentVersionId ||
        prior.status !== 'current'
      ) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '重判只能替换同一评估尝试的当前判分记录。',
        );
      }
    }
    return repos.formalAssessments.insertGrade(GradeRecordSchema.parse(input));
  }

  return {
    createDefinition,
    createVersion,
    acceptVersion(id: string) {
      return repos.formalAssessments.acceptVersion(id, clock.now().toISOString());
    },
    getVersion,
    getAcceptedForAgenda(workspaceId: string, agendaId: string, agendaItemId: string) {
      const definition = repos.formalAssessments.findDefinitionByLogicalKey(
        workspaceId,
        `agenda:${agendaId}:${agendaItemId}`,
      );
      if (!definition) return null;
      return (
        repos.formalAssessments
          .listVersions(definition.id)
          .find((candidate) => candidate.status === 'accepted') ?? null
      );
    },
    createAcceptedFromQuiz(input: {
      workspaceId: string;
      quiz: Quiz;
      logicalKey: string;
      title: string;
      targetLearningUnitId: string;
      targetObjectiveId: string;
      representation: EvidenceRepresentation;
      assessmentIntent?: AssessmentIntentSelection;
      progressionContext?: NonNullable<AssessmentVersion['progressionContext']>;
    }): AssessmentVersion {
      const questions = input.quiz.questions.filter(
        (question) => question.type === 'short_answer' && question.rubric,
      );
      if (questions.length === 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '本次检查没有可接受的正式简答题，未创建正式评估。',
        );
      }
      const definition = createDefinition({
        workspaceId: input.workspaceId,
        logicalKey: input.logicalKey,
        title: input.title,
      });
      const items = questions.map((question, index): FormalAssessmentItem => {
        const grounding = [question.grounding, ...(question.supplementaryEvidence ?? [])];
        const sourceBindings = grounding.map((reference) => {
          const block = repos.materials.getBlock(reference.blockId);
          const revisionId = block?.materialRevisionId;
          if (!block || !revisionId) {
            throw new AppError(ApiErrorCode.ValidationError, '正式评估题目缺少当前来源修订绑定。');
          }
          return {
            materialId: block.materialId,
            materialRevisionId: revisionId,
            sourceBlockId: block.id,
            quote: reference.quote,
            contentOrigin: block.contentOrigin ?? ('extracted_original' as const),
            authoritative: (block.contentOrigin ?? 'extracted_original') === 'extracted_original',
          };
        });
        const sourceBindingIds = sourceBindings.map((binding) => binding.sourceBlockId);
        return {
          id: newId('assessment_item'),
          sourceQuestionId: question.id,
          index,
          targetLearningUnitId: input.targetLearningUnitId,
          targetObjectiveId: input.targetObjectiveId,
          representation: input.representation,
          questionType: 'short_answer',
          prompt: question.stem,
          rubric: question.rubric!.keyPoints.map((criterion) => ({
            id: newId('criterion'),
            text: criterion.text,
            required: criterion.required,
            sourceBindingIds,
          })),
          sourceBindings,
          formalEligible: false,
          policyReason: 'MISSING_AUTHORITATIVE_SOURCE',
        };
      });
      const version = createVersion({
        definitionId: definition.id,
        items,
        sourceRevisionIds: [
          ...new Set(
            items.flatMap((item) =>
              item.sourceBindings.map((binding) => binding.materialRevisionId),
            ),
          ),
        ],
        progressionContext: input.progressionContext,
        assessmentIntent: input.assessmentIntent,
      });
      if (!version.items.every((item) => item.formalEligible)) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '题目未满足正式证据来源要求，未开放正式检查。',
        );
      }
      return repos.formalAssessments.acceptVersion(version.id, clock.now().toISOString());
    },
    startAttempt(assessmentVersionId: string, workspaceId: string): AssessmentAttempt {
      return startAttemptForMode(assessmentVersionId, workspaceId, 'formal');
    },
    startShadowAttempt(assessmentVersionId: string, workspaceId: string): AssessmentAttempt {
      return startAttemptForMode(assessmentVersionId, workspaceId, 'mastery_red_team_shadow');
    },
    recordAttemptExposure,
    submitAttempt(id: string, responses: Record<string, string>) {
      return repos.formalAssessments.submitAttempt(id, responses, clock.now().toISOString());
    },
    cancelAttempt(id: string) {
      return repos.formalAssessments.cancelAttempt(id, clock.now().toISOString());
    },
    recordGrade(input: GradeRecord) {
      return recordGradeForMode(input, 'formal');
    },
    recordShadowGrade(input: GradeRecord) {
      return recordGradeForMode(input, 'mastery_red_team_shadow');
    },
    deriveEvidence(gradeRecordId: string): EvidenceRecord[] {
      const grade = repos.formalAssessments.getGrade(gradeRecordId);
      if (!grade || grade.status !== 'current') return [];
      const attempt = repos.formalAssessments.getAttempt(grade.attemptId);
      const version = getVersion(grade.assessmentVersionId);
      if (version.authorityMode !== 'formal') return [];
      if (!attempt || attempt.status !== 'submitted') return [];
      const existing = repos.formalAssessments.listEvidenceForGrade(gradeRecordId);
      if (existing.length > 0) return existing;
      return version.items.flatMap((item) => {
        const result = grade.judgment.criterionResults.filter((r) =>
          item.rubric?.some((c) => c.id === r.criterionId),
        );
        const credit = decideFormalCredit({
          rubric: item.rubric ?? [],
          criterionResults: result,
        });
        const anyCoverage = result.some((criterion) => criterion.result !== 'not_met');
        const conclusion =
          !item.formalEligible || !hasCurrentFormalSource(item) || result.length === 0
            ? 'unsupported'
            : credit.formallyDemonstrated
              ? 'supported'
              : anyCoverage
                ? 'partial'
                : 'unsupported';
        if (conclusion === 'unsupported') return [];
        return [
          repos.formalAssessments.insertEvidence(
            EvidenceRecordSchema.parse({
              id: newId('evidence'),
              attemptId: attempt.id,
              gradeRecordId,
              assessmentVersionId: version.id,
              itemId: item.id,
              targetLearningUnitId: item.targetLearningUnitId,
              conclusion,
              policyVersion: POLICY_VERSION,
              sourceBindingIds: item.sourceBindings.map((b) => b.sourceBlockId),
              createdAt: clock.now().toISOString(),
            }),
          ),
        ];
      });
    },
    reconcileEvidence(evidenceRecordId: string): ProgressionReconciliationRecord {
      const evidence = repos.formalAssessments.getEvidence(evidenceRecordId);
      if (!evidence) throw notFound(`正式证据不存在:${evidenceRecordId}`);
      const current = repos.formalAssessments.insertReconciliation(
        ProgressionReconciliationRecordSchema.parse({
          id: newId('reconciliation'),
          evidenceRecordId,
          status: 'pending',
          appliedAt: null,
          createdAt: clock.now().toISOString(),
        }),
      );
      if (evidence.conclusion !== 'supported') {
        return current.status === 'pending'
          ? repos.formalAssessments.markFailed(
              current.id,
              'Only supported Formal Evidence may enter progression.',
            )
          : current;
      }
      const grade = repos.formalAssessments.getGrade(evidence.gradeRecordId);
      const attempt = repos.formalAssessments.getAttempt(evidence.attemptId);
      const version = getVersion(evidence.assessmentVersionId);
      const context = version.progressionContext;
      if (
        !grade ||
        grade.status !== 'current' ||
        !attempt ||
        attempt.status !== 'submitted' ||
        !context
      ) {
        return repos.formalAssessments.markFailed(
          current.id,
          'Assessment Evidence has no current, route-bound formal assessment context.',
        );
      }

      let reconciled = current;
      if (current.status !== 'applied') {
        try {
          let gradingResultId = current.gradingResultId;
          const priorForGrade = repos.formalAssessments.getReconciliationForGrade(grade.id);
          if (!gradingResultId && priorForGrade?.gradingResultId) {
            gradingResultId = priorForGrade.gradingResultId;
          }
          if (!gradingResultId) {
            const quiz = repos.quizzes.get(context.quizId);
            const supported = repos.formalAssessments
              .listEvidenceForGrade(grade.id)
              .filter((record) => record.conclusion === 'supported');
            const grades = supported.flatMap((record) => {
              const item = version.items.find((candidate) => candidate.id === record.itemId);
              const question = item?.sourceQuestionId
                ? quiz?.questions.find((candidate) => candidate.id === item.sourceQuestionId)
                : undefined;
              if (!item || !question) return [];
              const rubric = item.rubric ?? [];
              const criterionIds = new Set(rubric.map((criterion) => criterion.id));
              const criteria = grade.judgment.criterionResults.filter((result) =>
                criterionIds.has(result.criterionId),
              );
              const required = rubric.filter((criterion) => criterion.required);
              const score =
                required.length > 0 &&
                required.every(
                  (criterion) =>
                    criteria.find((result) => result.criterionId === criterion.id)?.result ===
                    'met',
                )
                  ? 1
                  : 0;
              return [
                {
                  questionId: question.id,
                  type: question.type,
                  gradedBy: 'deterministic' as const,
                  correct: score === 1,
                  awardedPoints: score * question.points,
                  maxPoints: question.points,
                  normalizedScore: score,
                  matchedKeyPoints: rubric
                    .filter(
                      (criterion) =>
                        criteria.find((result) => result.criterionId === criterion.id)?.result ===
                        'met',
                    )
                    .map((criterion) => criterion.text),
                  missedKeyPoints: rubric
                    .filter(
                      (criterion) =>
                        criterion.required &&
                        criteria.find((result) => result.criterionId === criterion.id)?.result !==
                          'met',
                    )
                    .map((criterion) => criterion.text),
                  needsReview: false,
                },
              ];
            });
            if (!quiz || grades.length === 0) {
              return repos.formalAssessments.markFailed(
                current.id,
                'Supported Evidence cannot be mapped to the accepted formal route.',
              );
            }
            const now = clock.now().toISOString();
            const submissionId = newId('bridge_submission');
            repos.submissions.insertSubmission({
              id: submissionId,
              quizId: quiz.id,
              answers: grades.map((item) => ({
                questionId: item.questionId,
                type: item.type,
                text:
                  attempt.responses[
                    version.items.find(
                      (candidate) => candidate.sourceQuestionId === item.questionId,
                    )?.id ?? ''
                  ] ?? '',
              })),
              createdAt: now,
            });
            const bridgeResult = GradingResultSchema.parse({
              id: newId('bridge_grade'),
              submissionId,
              quizId: quiz.id,
              grades,
              totalAwarded: grades.reduce((sum, item) => sum + item.awardedPoints, 0),
              totalPossible: grades.reduce((sum, item) => sum + item.maxPoints, 0),
              overallScore:
                grades.reduce((sum, item) => sum + item.normalizedScore, 0) / grades.length,
              createdAt: now,
            });
            repos.submissions.insertGradingResult(bridgeResult);
            gradingResultId = bridgeResult.id;
          }
          repos.formalAssessments.linkReconciliation(current.id, gradingResultId);
          const projection = progression.reconcileAfterGrading(gradingResultId, {
            studyPlanId: context.studyPlanVersionId,
            manifestFingerprint: context.executionSourceManifestFingerprint,
          });
          if (!projection || projection.reconciliations.some((item) => item.status !== 'applied')) {
            return repos.formalAssessments.markFailed(
              current.id,
              'Deterministic progression rejected or fenced this Evidence.',
            );
          }
          reconciled = repos.formalAssessments.markReconciled(
            current.id,
            clock.now().toISOString(),
          );
        } catch (error) {
          return repos.formalAssessments.markFailed(
            current.id,
            error instanceof Error
              ? error.message
              : 'Deterministic progression projection failed; retryable.',
          );
        }
      }

      // Formal progression is already durable. Review scheduling is a separate,
      // idempotent projection and its failure must remain visible and retryable.
      if (reviewSuccessor && evidence.createdAt >= DEFAULT_CONFIGURATION.effectiveAt) {
        const item = version.items.find((candidate) => candidate.id === evidence.itemId);
        if (item && context.assessmentKind === 'due_review') {
          const targetId = `review-target:${attempt.workspaceId}:${item.targetObjectiveId}`;
          const linkedRepair = repos.repair
            .listByWorkspace(attempt.workspaceId)
            .find((episode) => episode.verificationAttemptId === attempt.id);
          const execution =
            repos.reviewSuccessor.findExecutionByAssessmentVersion(version.id) ??
            repos.reviewSuccessor.findExecutionByAttempt(attempt.id) ??
            (linkedRepair
              ? repos.reviewSuccessor.findExecutionByAttempt(linkedRepair.triggerAttemptId)
              : undefined);
          if (!execution || execution.reviewTargetId !== targetId) {
            throw new Error('Due Review Evidence has no learner-launched ReviewExecution.');
          }
          try {
            reviewSuccessor.recordSupportedEvidence({
              targetId,
              evidenceId: evidence.id,
              executionId: execution.id,
            });
            reviewSuccessor.clearExecutionFailure(execution.id);
          } catch (error) {
            reviewSuccessor.markExecutionFailure(execution.id, error);
          }
        } else if (item) {
          reviewSuccessor.activate({
            workspaceId: attempt.workspaceId,
            courseId: attempt.workspaceId,
            learningUnitId: item.targetLearningUnitId,
            objectiveId: item.targetObjectiveId,
            contractVersionId: context.contractVersionId,
            curriculumVersionId: context.curriculumVersionId,
            manifestFingerprint: context.executionSourceManifestFingerprint,
            evidenceId: evidence.id,
            sourceOutcomeId: evidence.id,
            eligible: true,
            at: evidence.createdAt,
          });
        }
      }
      return reconciled;
    },
  };
}

export type FormalAssessmentsService = ReturnType<typeof createFormalAssessmentsService>;
