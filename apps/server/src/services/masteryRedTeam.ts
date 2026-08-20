import { createHash } from 'node:crypto';
import {
  MASTERY_RED_TEAM_MAX_OBJECTIVES,
  MasteryRedTeamEvaluationSchema,
  MasteryRedTeamRunDetailSchema,
  MasteryRedTeamRunSchema,
  MasterySnapshotSchema,
  type AssessmentVersion,
  type FormalAssessmentItem,
  type MasteryChallengeCandidate,
  type MasteryRedTeamRunDetail,
  type MasterySnapshot,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { verifyGrounding } from '../grounding/verify.js';
import { newId, type Clock } from '../util/ids.js';
import { resolveReviewTargetContext } from './reviewSuccessor.js';
import type { FormalAssessmentsService } from './formalAssessments.js';
import type { LearnerAssessmentsService } from './learnerAssessments.js';
import {
  analyzeMasteryChallengeProposal,
  classifyShadowOutcome,
  deriveFragilityHypotheses,
  selectChallengeFamily,
} from './masteryRedTeamPolicy.js';

const MAX_SOURCE_CHARS = 2_000;
const MAX_PRIOR_PROMPTS = 8;
const MAX_HISTORY = 4;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const technical = 'technicalFailureCode' in error ? error.technicalFailureCode : undefined;
    if (typeof technical === 'string' && technical.length > 0) return technical.slice(0, 120);
    const code = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && code.length > 0) return code.slice(0, 120);
  }
  return error instanceof Error ? error.name.slice(0, 120) : 'MASTERY_RED_TEAM_FAILED';
}

export function createMasteryRedTeamService({
  repos,
  provider,
  clock,
  providerModel,
  formalAssessments,
  learnerAssessments,
}: {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  providerModel?: string;
  formalAssessments: FormalAssessmentsService;
  learnerAssessments: LearnerAssessmentsService;
}) {
  function workspaceRoute(workspaceId: string, snapshotRoute: MasterySnapshot['route']) {
    const route = repos.courseExecution.get(workspaceId);
    if (
      route.executionStatus !== 'active' ||
      route.routeValidationStatus !== 'valid' ||
      route.version !== snapshotRoute.courseExecutionVersion ||
      route.activeContractId !== snapshotRoute.contractVersionId ||
      route.activeCurriculumId !== snapshotRoute.curriculumVersionId ||
      route.acceptedPlanId !== snapshotRoute.studyPlanVersionId ||
      route.activeAgendaId !== snapshotRoute.agendaId
    ) {
      throw new AppError('VERSION_CONFLICT', 'Mastery Red Team snapshot route is stale.');
    }
    const curriculum = repos.curricula.get(snapshotRoute.curriculumVersionId);
    const plan = repos.studyPlans.get(snapshotRoute.studyPlanVersionId);
    const agenda = repos.sessionAgendas.get(snapshotRoute.agendaId);
    if (
      !curriculum ||
      curriculum.status !== 'accepted' ||
      curriculum.executionSourceManifest.fingerprint !==
        snapshotRoute.executionSourceManifestFingerprint ||
      !plan ||
      plan.status !== 'accepted' ||
      plan.executionSourceManifestFingerprint !==
        snapshotRoute.executionSourceManifestFingerprint ||
      !agenda ||
      agenda.status !== 'active' ||
      agenda.executionSourceManifestFingerprint !== snapshotRoute.executionSourceManifestFingerprint
    ) {
      throw new AppError('VERSION_CONFLICT', 'Mastery Red Team route versions are stale.');
    }
    return { route, curriculum, plan, agenda };
  }

  function currentSource(snapshotSource: MasterySnapshot['sources'][number]): void {
    const material = repos.materials.get(snapshotSource.materialId);
    const activeRevision = repos.materialRevisions.getActive(snapshotSource.materialId);
    const block = repos.materials.getBlock(snapshotSource.sourceBlockId);
    if (
      !material ||
      material.availability === 'retired' ||
      !activeRevision ||
      activeRevision.id !== snapshotSource.materialRevisionId ||
      !block ||
      block.materialId !== snapshotSource.materialId ||
      block.materialRevisionId !== snapshotSource.materialRevisionId ||
      curriculumSourceBlockFingerprint(block, snapshotSource.materialRevisionId) !==
        snapshotSource.sourceBlockRevisionFingerprint ||
      !verifyGrounding([block], { blockId: block.id, quote: snapshotSource.quote }).ok
    ) {
      throw new AppError('VERSION_CONFLICT', 'Mastery Red Team source binding is stale.');
    }
  }

  function assertSnapshotCurrent(snapshot: MasterySnapshot): void {
    workspaceRoute(snapshot.workspaceId, snapshot.route);
    const context = resolveReviewTargetContext(repos, snapshot.reviewTargetId);
    if (
      !context ||
      context.target.workspaceId !== snapshot.workspaceId ||
      context.target.courseId !== snapshot.courseId ||
      context.target.status !== 'active' ||
      context.binding.contractVersionId !== snapshot.route.contractVersionId ||
      context.binding.curriculumVersionId !== snapshot.route.curriculumVersionId ||
      context.binding.learningUnitId !== snapshot.target.learningUnitId ||
      context.binding.objectiveId !== snapshot.target.objectiveId ||
      context.binding.executionSourceManifestFingerprint !==
        snapshot.route.executionSourceManifestFingerprint ||
      context.state.rowVersion !== snapshot.review.rowVersion ||
      context.state.dueAt !== snapshot.review.dueAt ||
      context.state.dueAt <= clock.now().toISOString()
    ) {
      throw new AppError('VERSION_CONFLICT', 'Mastery Red Team snapshot eligibility is stale.');
    }
    for (const source of snapshot.sources) currentSource(source);
  }

  function buildSnapshot(
    workspaceId: string,
    reviewTargetId: string,
    parentRunId: string | null,
  ): MasterySnapshot {
    const context = resolveReviewTargetContext(repos, reviewTargetId);
    const route = repos.courseExecution.get(workspaceId);
    if (
      !context ||
      context.target.workspaceId !== workspaceId ||
      context.target.status !== 'active' ||
      route.executionStatus !== 'active' ||
      route.routeValidationStatus !== 'valid' ||
      route.activeContractId !== context.binding.contractVersionId ||
      route.activeCurriculumId !== context.binding.curriculumVersionId ||
      route.acceptedPlanId === null ||
      route.activeAgendaId === null
    ) {
      throw new AppError('VALIDATION_ERROR', '当前 ReviewTarget 不具备影子挑战资格。');
    }
    const contextUnit = context.unit.learningUnit;
    if (!contextUnit) throw new AppError('VALIDATION_ERROR', 'LearningUnit 不存在。');
    const routeContext = workspaceRoute(workspaceId, {
      courseExecutionVersion: route.version,
      contractVersionId: context.binding.contractVersionId,
      curriculumVersionId: context.binding.curriculumVersionId,
      studyPlanVersionId: route.acceptedPlanId,
      agendaId: route.activeAgendaId,
      executionSourceManifestFingerprint: context.binding.executionSourceManifestFingerprint,
    });
    const { curriculum, plan, agenda } = routeContext;
    const unitNode = curriculum.nodes.find((node) => node.id === context.binding.learningUnitId);
    if (!unitNode?.learningUnit) throw new AppError('VALIDATION_ERROR', 'LearningUnit 不存在。');
    const synthesisGroups = curriculum.synthesisGroups.filter(
      (group) =>
        group.learningUnitIds.includes(context.binding.learningUnitId) &&
        group.learningUnitIds.every(
          (learningUnitId) =>
            curriculum.nodes.some(
              (node) => node.id === learningUnitId && node.learningUnit !== null,
            ) &&
            repos.formalProgression.getUnitProgress(workspaceId, curriculum.id, learningUnitId)
              .state === 'complete',
        ),
    );
    const relatedUnitIds = new Set(
      synthesisGroups.flatMap((group) => group.learningUnitIds).filter((id) => id !== unitNode.id),
    );
    const relatedObjectives = [
      unitNode,
      ...curriculum.nodes.filter((node) => relatedUnitIds.has(node.id) && node.learningUnit),
    ]
      .flatMap((node) =>
        (node.learningUnit?.objectives ?? []).map((objective) => ({
          id: objective.id,
          learningUnitId: node.id,
          title: objective.title,
          description: objective.description,
        })),
      )
      .filter((objective) => objective.id !== context.objective.id)
      .slice(0, 30);
    const sourceByBlock = new Map<string, MasterySnapshot['sources'][number]>();
    const nodes = [unitNode, ...curriculum.nodes.filter((node) => relatedUnitIds.has(node.id))];
    for (const node of nodes) {
      for (const reference of node.sourceReferences) {
        if (!reference.sourceBlockId || !reference.sourceBlockRevisionFingerprint) continue;
        const block = repos.materials.getBlock(reference.sourceBlockId);
        const material = repos.materials.get(reference.materialId);
        const revision = repos.materialRevisions.getActive(reference.materialId);
        if (
          !block ||
          !material ||
          material.workspaceId !== workspaceId ||
          material.availability === 'retired' ||
          !revision ||
          revision.id !== reference.materialRevisionId ||
          revision.id !== material.activeRevisionId ||
          !contextualManifestHasRevision(
            curriculum.executionSourceManifest.revisions,
            reference.materialId,
            revision.id,
          ) ||
          curriculumSourceBlockFingerprint(block, revision.id) !==
            reference.sourceBlockRevisionFingerprint
        ) {
          throw new AppError('VALIDATION_ERROR', 'LearningUnit 来源绑定已失效。');
        }
        const quote = block.content.slice(0, MAX_SOURCE_CHARS);
        if (!verifyGrounding([block], { blockId: block.id, quote }).ok) {
          throw new AppError('VALIDATION_ERROR', 'LearningUnit 来源无法通过原文校验。');
        }
        const existing = sourceByBlock.get(block.id);
        const learningUnitIds = new Set(existing?.learningUnitIds ?? []);
        learningUnitIds.add(node.id);
        const objectiveIds = new Set(existing?.objectiveIds ?? []);
        for (const objective of node.learningUnit?.objectives ?? []) objectiveIds.add(objective.id);
        sourceByBlock.set(block.id, {
          ref: existing?.ref ?? `S${sourceByBlock.size + 1}`,
          materialId: material.id,
          materialRevisionId: revision.id,
          sourceBlockId: block.id,
          sourceBlockRevisionFingerprint: reference.sourceBlockRevisionFingerprint,
          learningUnitIds: [...learningUnitIds].slice(0, 8),
          objectiveIds: [...objectiveIds].slice(0, 20),
          quote,
          contentOrigin: 'extracted_original',
          authoritative: true,
        });
      }
    }
    const sources = [...sourceByBlock.values()].slice(0, 8);
    if (sources.length === 0)
      throw new AppError('VALIDATION_ERROR', '当前目标没有可供挑战的权威来源。');
    const now = clock.now().toISOString();
    const progress = repos.formalProgression.getUnitProgress(
      workspaceId,
      curriculum.id,
      context.binding.learningUnitId,
    );
    if (progress.state !== 'complete') {
      throw new AppError('VALIDATION_ERROR', '只有已完成 LearningUnit 才能进入影子挑战。');
    }
    if (context.state.dueAt <= now || context.state.lifecycleState === 'pending_initial_review') {
      throw new AppError('VALIDATION_ERROR', '当前 Review 已到期，必须先完成普通 Review。');
    }
    if (repos.reviewSuccessor.activeExecution(reviewTargetId)) {
      throw new AppError('VALIDATION_ERROR', '当前 ReviewTarget 正在执行另一项 Review。');
    }
    const conceptIds = new Set(context.conceptIds);
    if (
      repos.repair
        .listByWorkspace(workspaceId)
        .some(
          (episode) =>
            episode.targetLearningUnitId === context.binding.learningUnitId &&
            ['OPEN', 'ACTIVE', 'AWAITING_VERIFICATION'].includes(episode.status),
        ) ||
      repos.mistakes
        .listOpenByWorkspace(workspaceId)
        .some((mistake) => conceptIds.has(mistake.conceptId)) ||
      repos.misconceptions
        .listByWorkspace(workspaceId)
        .some((record) => conceptIds.has(record.conceptId) && record.status === 'confirmed')
    ) {
      throw new AppError('VALIDATION_ERROR', '已有当前缺口或修复流程，不能重复启动影子挑战。');
    }
    const attempts = repos.formalAssessments
      .listAttemptsForWorkspace(workspaceId)
      .filter((attempt) => attempt.status === 'submitted')
      .map((attempt) => ({
        attempt,
        version: repos.formalAssessments.getVersion(attempt.assessmentVersionId),
      }))
      .filter(
        (item): item is { attempt: NonNullable<typeof item.attempt>; version: AssessmentVersion } =>
          Boolean(item.version),
      );
    const evidence: MasterySnapshot['evidence'] = [];
    const targetAttempts = attempts.filter(
      ({ version }) =>
        version.authorityMode === 'formal' &&
        version.items.some((item) => item.targetObjectiveId === context.objective.id),
    );
    const priorQuestions: MasterySnapshot['priorQuestions'] = repos.masteryRedTeam
      .selectedPromptsForTarget(reviewTargetId)
      .map((candidate) => ({
        id: candidate.id,
        prompt: candidate.prompt,
        source: 'mastery_red_team' as const,
      }));
    for (const { attempt, version } of attempts) {
      for (const item of version.items) {
        if (item.targetObjectiveId === context.objective.id && version.authorityMode === 'formal') {
          priorQuestions.push({ id: item.id, prompt: item.prompt, source: 'formal_assessment' });
        }
      }
      const grade = repos.formalAssessments
        .listGrades(attempt.id)
        .find((candidate) => candidate.status === 'current');
      if (!grade || version.authorityMode !== 'formal') continue;
      for (const itemEvidence of repos.formalAssessments.listEvidenceForGrade(grade.id)) {
        const item = version.items.find((candidate) => candidate.id === itemEvidence.itemId);
        const reconciliation = repos.formalAssessments.getReconciliationForEvidence(
          itemEvidence.id,
        );
        if (
          item?.targetObjectiveId === context.objective.id &&
          itemEvidence.conclusion === 'supported' &&
          reconciliation?.status === 'applied'
        ) {
          evidence.push({
            evidenceRecordId: itemEvidence.id,
            gradeRecordId: grade.id,
            attemptId: attempt.id,
            assessmentVersionId: version.id,
            itemId: item.id,
            conclusion: 'supported',
            policyVersion: itemEvidence.policyVersion,
            reconciliationId: reconciliation.id,
            reconciliationStatus: 'applied',
            criterionResults: (item.rubric ?? []).map((criterion) => ({
              criterionId: criterion.id,
              result:
                grade.judgment.criterionResults.find(
                  (result) => result.criterionId === criterion.id,
                )?.result ?? 'not_met',
            })),
            createdAt: itemEvidence.createdAt,
          });
        }
      }
    }
    if (
      !context.target.originEvidenceId ||
      !evidence.some((item) => item.evidenceRecordId === context.target.originEvidenceId)
    ) {
      throw new AppError('VALIDATION_ERROR', 'ReviewTarget 没有当前已应用的正式证据。');
    }
    const latestTargetAttempt = [...targetAttempts].sort(
      (a, b) =>
        b.attempt.startedAt.localeCompare(a.attempt.startedAt) ||
        b.attempt.id.localeCompare(a.attempt.id),
    )[0];
    if (
      !latestTargetAttempt ||
      !evidence.some((item) => item.attemptId === latestTargetAttempt.attempt.id)
    ) {
      throw new AppError('VALIDATION_ERROR', '最近一次正式尝试未形成当前支持证据。');
    }
    const originEvidence = evidence.find(
      (item) => item.evidenceRecordId === context.target.originEvidenceId,
    )!;
    const snapshotEvidence = [
      originEvidence,
      ...evidence.filter(
        (item) =>
          item.attemptId === latestTargetAttempt.attempt.id &&
          item.evidenceRecordId !== originEvidence.evidenceRecordId,
      ),
      ...evidence.filter(
        (item) =>
          item.attemptId !== latestTargetAttempt.attempt.id &&
          item.evidenceRecordId !== originEvidence.evidenceRecordId,
      ),
    ].slice(0, 30);
    const parent = parentRunId ? repos.masteryRedTeam.getRun(parentRunId) : undefined;
    if (parentRunId && (!parent || parent.workspaceId !== workspaceId)) {
      throw new AppError('VALIDATION_ERROR', '影子挑战父运行不存在或不属于当前空间。');
    }
    const parentEvaluation = parent
      ? repos.masteryRedTeam.getEvaluationForRun(parent.id)
      : undefined;
    const followUpDepth = parent ? parent.followUpDepth + 1 : 0;
    if (
      followUpDepth > 1 ||
      (parent &&
        (!parentEvaluation || !['possible_gap', 'inconclusive'].includes(parentEvaluation.outcome)))
    ) {
      throw new AppError('VALIDATION_ERROR', '影子挑战只能进行一次明确的后续辨别。');
    }
    const hypotheses = deriveFragilityHypotheses({
      reviewTargetId,
      evidencePrompts: evidence.map((item) => ({
        id: item.itemId,
        prompt:
          repos.formalAssessments
            .getVersion(item.assessmentVersionId)
            ?.items.find((candidate) => candidate.id === item.itemId)?.prompt ?? '',
      })),
      conceptIds: context.conceptIds,
      relatedObjectiveIds: relatedObjectives.map((objective) => objective.id),
      prerequisiteUnitIds: contextUnit.prerequisiteUnitIds,
      synthesisGroupIds: synthesisGroups.map((group) => group.id),
      misconceptions: repos.misconceptions
        .listByWorkspace(workspaceId)
        .filter((record) => conceptIds.has(record.conceptId))
        .map((record) => ({ id: record.id, status: record.status, category: record.category })),
      repairs: repos.repair
        .listByWorkspace(workspaceId)
        .filter((episode) => episode.targetLearningUnitId === context.binding.learningUnitId)
        .map((episode) => ({ id: episode.id, diagnosticCategory: episode.diagnosticCategory })),
      parentOutcome: parentEvaluation?.outcome ?? null,
    });
    const createdAt = now;
    const snapshotWithoutIdentity = {
      workspaceId,
      courseId: context.target.courseId,
      reviewTargetId,
      parentRunId: parentRunId ?? null,
      followUpDepth,
      route: {
        courseExecutionVersion: route.version,
        contractVersionId: context.binding.contractVersionId,
        curriculumVersionId: curriculum.id,
        studyPlanVersionId: plan.id,
        agendaId: agenda.id,
        executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
      },
      target: {
        learningUnitId: context.binding.learningUnitId,
        learningUnitTitle: unitNode.title,
        objectiveId: context.objective.id,
        objectiveTitle: context.objective.title,
        objectiveDescription: context.objective.description,
        relatedObjectives,
        conceptIds: context.conceptIds,
        prerequisiteUnitIds: contextUnit.prerequisiteUnitIds,
        synthesisGroupIds: synthesisGroups.map((group) => group.id),
      },
      progression: {
        state: 'completed' as const,
        reconciliationIds: [...new Set(snapshotEvidence.map((item) => item.reconciliationId))],
      },
      evidence: snapshotEvidence,
      masteryObservations: repos.mastery
        .listByWorkspace(workspaceId)
        .filter((item) => conceptIds.has(item.conceptId))
        .map((item) => ({ ...item, authority: 'legacy_observation_only' as const }))
        .slice(0, 60),
      mistakeObservations: repos.materials
        .list()
        .filter((material) => material.workspaceId === workspaceId)
        .flatMap((material) => repos.mistakes.listByMaterial(material.id))
        .filter((mistake) => conceptIds.has(mistake.conceptId))
        .map((mistake) => ({
          id: mistake.id,
          conceptId: mistake.conceptId,
          status: mistake.status,
          score: mistake.score,
        }))
        .slice(0, 60),
      misconceptionObservations: repos.misconceptions
        .listByWorkspace(workspaceId)
        .filter((record) => conceptIds.has(record.conceptId))
        .map((record) => ({
          id: record.id,
          conceptId: record.conceptId,
          status: record.status,
          category: record.category,
          hypothesis: record.hypothesis,
        }))
        .slice(0, 60),
      repairObservations: repos.repair
        .listByWorkspace(workspaceId)
        .filter((episode) => episode.targetLearningUnitId === context.binding.learningUnitId)
        .map((episode) => ({
          id: episode.id,
          status: episode.status,
          diagnosticCategory: episode.diagnosticCategory,
          gapSummary: episode.gapSummary,
        }))
        .slice(0, 60),
      review: {
        dueAt: context.state.dueAt,
        lifecycleState: context.state.lifecycleState,
        rowVersion: context.state.rowVersion,
        authority: 'scheduling_only' as const,
        events: repos.reviewSuccessor
          .listEvents(reviewTargetId)
          .slice(-20)
          .map((event) => ({
            id: event.id,
            kind: event.kind,
            sourceOutcomeId: event.sourceOutcomeId,
            rating: event.rating,
            occurredAt: event.occurredAt,
          })),
      },
      priorQuestions: priorQuestions.slice(0, 100),
      sources,
      hypotheses,
      policies: {
        snapshot: 'mastery-red-team-snapshot-v1' as const,
        hypothesis: 'mastery-red-team-hypothesis-v1' as const,
        familySelection: 'mastery-red-team-family-selection-v1' as const,
        challengeContract: 'mastery-red-team-challenge-v1' as const,
        validation: 'mastery-red-team-validation-v1' as const,
        novelty: 'mastery-red-team-novelty-v1' as const,
        outcome: 'mastery-red-team-shadow-outcome-v1' as const,
      },
      createdAt,
    };
    const snapshotHash = hash(snapshotWithoutIdentity);
    return MasterySnapshotSchema.parse({
      ...snapshotWithoutIdentity,
      id: newId('mastery_snapshot'),
      snapshotHash,
    });
  }

  function runDetail(runId: string): MasteryRedTeamRunDetail {
    const run = repos.masteryRedTeam.getRun(runId);
    if (!run) throw notFound('Mastery Red Team 运行不存在。');
    const snapshot = repos.masteryRedTeam.getSnapshot(run.snapshotId);
    if (!snapshot) throw notFound('Mastery Red Team 快照不存在。');
    return MasteryRedTeamRunDetailSchema.parse({
      run,
      snapshot,
      candidates: repos.masteryRedTeam.listCandidates(run.id),
      evaluation: repos.masteryRedTeam.getEvaluationForRun(run.id) ?? null,
    });
  }

  function itemFromCandidate(
    snapshot: MasterySnapshot,
    candidate: MasteryChallengeCandidate,
  ): FormalAssessmentItem {
    const sourceByRef = new Map(snapshot.sources.map((source) => [source.ref, source]));
    const refs = [...new Set(candidate.sourceRefs)];
    const sourceBindings = refs.map((ref) => {
      const source = sourceByRef.get(ref);
      if (!source) throw new AppError('VALIDATION_ERROR', '影子候选题引用了未知来源。');
      return {
        materialId: source.materialId,
        materialRevisionId: source.materialRevisionId,
        sourceBlockId: source.sourceBlockId,
        quote: source.quote,
        contentOrigin: source.contentOrigin,
        authoritative: source.authoritative,
      };
    });
    const bindingByRef = new Map(sourceBindings.map((binding, index) => [refs[index]!, binding]));
    return {
      id: newId('mastery_shadow_item'),
      index: 0,
      targetLearningUnitId: snapshot.target.learningUnitId,
      targetObjectiveId: snapshot.target.objectiveId,
      questionType: 'short_answer',
      prompt: candidate.prompt,
      rubric: candidate.rubric.map((criterion) => ({
        id: newId(`mastery_shadow_criterion_${criterion.key}`),
        text: criterion.text,
        required: criterion.required,
        sourceBindingIds: criterion.sourceRefs.map(
          (ref) => bindingByRef.get(ref)?.sourceBlockId ?? '',
        ),
      })),
      sourceBindings,
      formalEligible: false,
      policyReason: 'MISSING_AUTHORITATIVE_SOURCE',
    };
  }

  async function start(
    input: {
      workspaceId: string;
      reviewTargetId: string;
      idempotencyKey: string;
      parentRunId?: string | null;
    },
    opts?: ProviderCallOptions,
  ) {
    const existing = repos.masteryRedTeam.findRunByIdempotencyKey(
      input.workspaceId,
      input.idempotencyKey,
    );
    const parentRunId = input.parentRunId ?? null;
    if (existing) {
      const existingSnapshot = repos.masteryRedTeam.getSnapshot(existing.snapshotId);
      if (
        !existingSnapshot ||
        existingSnapshot.reviewTargetId !== input.reviewTargetId ||
        existing.parentRunId !== parentRunId
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Mastery Red Team 启动键已被用于不同的目标或父运行。',
        );
      }
      return runDetail(existing.id);
    }
    let snapshot: MasterySnapshot;
    try {
      snapshot = buildSnapshot(input.workspaceId, input.reviewTargetId, parentRunId);
      const selectableHypotheses = parentRunId
        ? snapshot.hypotheses.filter(
            (hypothesis) => hypothesis.family === 'discriminative_follow_up',
          )
        : snapshot.hypotheses;
      const selected = selectChallengeFamily(
        selectableHypotheses,
        repos.masteryRedTeam.familyExposure(input.reviewTargetId),
      );
      snapshot = MasterySnapshotSchema.parse({ ...snapshot, hypotheses: snapshot.hypotheses });
      repos.masteryRedTeam.insertSnapshot(snapshot);
      const now = clock.now().toISOString();
      const run = MasteryRedTeamRunSchema.parse({
        id: newId('mastery_run'),
        workspaceId: input.workspaceId,
        snapshotId: snapshot.id,
        idempotencyKey: input.idempotencyKey,
        parentRunId,
        followUpDepth: snapshot.followUpDepth,
        selectedHypothesisId: selected.hypothesis.id,
        selectedFamily: selected.hypothesis.family,
        familySelection: selected.selection,
        status: 'generating',
        selectedCandidateId: null,
        assessmentVersionId: null,
        submissionKey: null,
        submissionAnswerHash: null,
        failureCode: null,
        provider: provider.name,
        providerModel: providerModel ?? provider.model ?? null,
        repairAttempted: false,
        createdAt: now,
        updatedAt: now,
      });
      repos.masteryRedTeam.insertRun(run);
      const providerInput = {
        contractVersion: 'mastery-red-team-challenge-v1' as const,
        selectedFamily: selected.hypothesis.family,
        hypothesisBasis: selected.hypothesis.basisCodes,
        objectives: [
          {
            objectiveRef: 'O1',
            title: snapshot.target.objectiveTitle,
            description: snapshot.target.objectiveDescription,
            primary: true,
          },
          ...snapshot.target.relatedObjectives
            .slice(0, MASTERY_RED_TEAM_MAX_OBJECTIVES - 1)
            .map((objective, index) => ({
              objectiveRef: `O${index + 2}`,
              title: objective.title,
              description: objective.description,
              primary: false,
            })),
        ],
        sources: snapshot.sources.map((source) => ({ sourceRef: source.ref, text: source.quote })),
        priorPrompts: snapshot.priorQuestions.slice(0, MAX_PRIOR_PROMPTS).map((item, index) => ({
          promptRef: `P${index + 1}`,
          prompt: item.prompt,
        })),
        historicalSummaries: [
          ...snapshot.misconceptionObservations.map((item) => item.hypothesis),
          ...snapshot.repairObservations.map((item) => item.gapSummary),
        ]
          .slice(0, MAX_HISTORY)
          .map((summary, index) => ({ summaryRef: `H${index + 1}`, summary })),
        limits: {
          candidateCount: 3 as const,
          maxPromptChars: 2_000,
          maxAnswerChars: 1_500,
          maxRubricCriteria: 8,
        },
      };
      const providerOptions: ProviderCallOptions = {
        ...opts,
        telemetry: {
          ...opts?.telemetry,
          workspaceId: input.workspaceId,
          operationType: 'mastery_red_team_challenge_generation',
          operationId: run.id,
          schemaFingerprint: 'mastery-red-team-challenge-v1',
          policyFingerprint: 'mastery-red-team-validation-v1',
          sourceFingerprint: snapshot.snapshotHash,
        },
        validateCandidate: (candidate) => {
          const parsed = analyzeMasteryChallengeProposal(
            candidate as never,
            snapshot,
            selected.hypothesis.family,
          );
          return parsed.providerValidation;
        },
        onRepairAttempt: () => {
          const current = repos.masteryRedTeam.getRun(run.id);
          if (current && !current.repairAttempted) {
            repos.masteryRedTeam.updateRun({
              ...current,
              repairAttempted: true,
              updatedAt: clock.now().toISOString(),
            });
          }
        },
        beforeTelemetryComplete: () => assertSnapshotCurrent(snapshot),
      };
      const payload = await provider.proposeMasteryChallenges(providerInput, providerOptions);
      assertSnapshotCurrent(snapshot);
      const analysis = analyzeMasteryChallengeProposal(
        payload,
        snapshot,
        selected.hypothesis.family,
      );
      if (analysis.selectedIndex === null)
        throw new Error('No admissible Mastery Red Team candidate.');
      const candidateRecords = payload.candidates.map((candidate, ordinal) => ({
        id: newId('mastery_candidate'),
        runId: run.id,
        ordinal,
        providerCandidateKey: candidate.candidateKey,
        candidate,
        validation: analysis.validations[ordinal]!,
        selected: ordinal === analysis.selectedIndex,
        createdAt: clock.now().toISOString(),
      }));
      repos.masteryRedTeam.insertCandidates(candidateRecords);
      const selectedCandidate = payload.candidates[analysis.selectedIndex]!;
      const item = itemFromCandidate(snapshot, selectedCandidate);
      const definition = formalAssessments.createDefinition({
        workspaceId: input.workspaceId,
        logicalKey: `mastery-red-team:${run.id}`,
        title: `Mastery Red Team shadow: ${snapshot.target.objectiveTitle}`,
      });
      const version = formalAssessments.createVersion({
        definitionId: definition.id,
        items: [item],
        sourceRevisionIds: [
          ...new Set(item.sourceBindings.map((binding) => binding.materialRevisionId)),
        ],
        authorityMode: 'mastery_red_team_shadow',
      });
      const accepted = formalAssessments.acceptVersion(version.id);
      const selectedRun = MasteryRedTeamRunSchema.parse({
        ...run,
        status: 'selected',
        selectedCandidateId: candidateRecords[analysis.selectedIndex]!.id,
        assessmentVersionId: accepted.id,
        repairAttempted:
          repos.masteryRedTeam.getRun(run.id)?.repairAttempted ?? run.repairAttempted,
        updatedAt: clock.now().toISOString(),
      });
      repos.masteryRedTeam.updateRun(selectedRun);
      return runDetail(run.id);
    } catch (error) {
      const existingRun = repos.masteryRedTeam.findRunByIdempotencyKey(
        input.workspaceId,
        input.idempotencyKey,
      );
      if (existingRun && !['selected', 'evaluated'].includes(existingRun.status)) {
        repos.masteryRedTeam.updateRun({
          ...existingRun,
          status: 'generation_failed',
          failureCode: failureCode(error),
          repairAttempted: existingRun.repairAttempted,
          updatedAt: clock.now().toISOString(),
        });
      }
      throw error;
    }
  }

  async function submit(
    workspaceId: string,
    runId: string,
    input: { answer: string; submissionKey: string },
    opts?: ProviderCallOptions,
  ) {
    const run = repos.masteryRedTeam.getRun(runId);
    if (!run || run.workspaceId !== workspaceId) throw notFound('Mastery Red Team 运行不存在。');
    const submissionAnswerHash = hash(input.answer);
    if (run.submissionKey && run.submissionKey !== input.submissionKey) {
      throw new AppError('VALIDATION_ERROR', '该影子运行已经绑定了另一个提交键。');
    }
    if (
      run.submissionKey === input.submissionKey &&
      run.submissionAnswerHash !== null &&
      run.submissionAnswerHash !== submissionAnswerHash
    ) {
      throw new AppError('VALIDATION_ERROR', '该影子提交键已被用于不同的答案。');
    }
    const detail = runDetail(run.id);
    if (detail.evaluation) return detail;
    if (
      !run.assessmentVersionId ||
      !['selected', 'evaluating', 'evaluation_failed'].includes(run.status)
    ) {
      throw new AppError('VALIDATION_ERROR', '该影子运行当前不能提交答案。');
    }
    assertSnapshotCurrent(detail.snapshot);
    const attempt =
      repos.formalAssessments
        .listAttemptsForWorkspace(workspaceId)
        .find(
          (candidate) =>
            candidate.assessmentVersionId === run.assessmentVersionId &&
            candidate.status !== 'cancelled',
        ) ?? formalAssessments.startShadowAttempt(run.assessmentVersionId, workspaceId);
    try {
      const version = repos.formalAssessments.getVersion(run.assessmentVersionId)!;
      const itemId = version.items[0]!.id;
      const evaluating = MasteryRedTeamRunSchema.parse({
        ...run,
        status: 'evaluating',
        submissionKey: input.submissionKey,
        submissionAnswerHash,
        failureCode: null,
        updatedAt: clock.now().toISOString(),
      });
      repos.masteryRedTeam.updateRun(evaluating);
      const submitted =
        attempt.status === 'submitted'
          ? attempt
          : formalAssessments.submitAttempt(attempt.id, { [itemId]: input.answer });
      const grade = await learnerAssessments.gradeShadowAttempt(submitted.id, {
        ...opts,
        telemetry: {
          ...opts?.telemetry,
          workspaceId,
          operationType: 'mastery_red_team_shadow_grade',
          operationId: run.id,
          assessmentId: run.assessmentVersionId,
          schemaFingerprint: 'formal-grade-v1-shadow',
          policyFingerprint: 'mastery-red-team-shadow-outcome-v1',
          sourceFingerprint: detail.snapshot.snapshotHash,
        },
        beforeTelemetryComplete: () => assertSnapshotCurrent(detail.snapshot),
      });
      assertSnapshotCurrent(detail.snapshot);
      const item = version.items[0]!;
      const requiredCriterionIds = (item.rubric ?? [])
        .filter((criterion) => criterion.required)
        .map((criterion) => criterion.id);
      const outcome = classifyShadowOutcome({
        requiredCriterionIds,
        criterionResults: grade.judgment.criterionResults,
      });
      const evaluation = MasteryRedTeamEvaluationSchema.parse({
        id: newId('mastery_evaluation'),
        runId: run.id,
        attemptId: submitted.id,
        gradeRecordId: grade.id,
        outcome,
        advisoryConfidence: outcome === 'inconclusive' ? 'low' : 'medium',
        advisoryRisk:
          outcome === 'robust_signal'
            ? 'none_observed'
            : outcome === 'possible_gap'
              ? 'possible_hidden_gap'
              : 'indeterminate',
        proposedNextAction:
          outcome === 'possible_gap'
            ? 'propose_fresh_formal_inspection'
            : outcome === 'inconclusive'
              ? 'inspect_shadow_result'
              : 'none',
        validationLimits: [
          'Lexical overlap is a novelty fence, not semantic-equivalence proof.',
          'Exact quotations prove source occurrence, not complete semantic entailment.',
          'Shadow grade cannot create Evidence, Repair, Review events, or progression.',
        ],
        evidenceCreated: false,
        masteryMutated: false,
        progressionMutated: false,
        reviewMutated: false,
        repairMutated: false,
        policyVersion: 'mastery-red-team-shadow-outcome-v1',
        createdAt: clock.now().toISOString(),
      });
      repos.masteryRedTeam.completeEvaluation(
        {
          ...evaluating,
          status: 'evaluated',
          updatedAt: clock.now().toISOString(),
        },
        evaluation,
      );
      return runDetail(run.id);
    } catch (error) {
      const current = repos.masteryRedTeam.getRun(run.id);
      if (current && current.status === 'evaluating') {
        repos.masteryRedTeam.updateRun({
          ...current,
          status: 'evaluation_failed',
          failureCode: failureCode(error),
          updatedAt: clock.now().toISOString(),
        });
      }
      throw error;
    }
  }

  return { start, submit, get: runDetail, assertSnapshotCurrent };
}

function contextualManifestHasRevision(
  revisions: Array<{ materialId: string; materialRevisionId: string }>,
  materialId: string,
  revisionId: string,
): boolean {
  return revisions.some(
    (revision) => revision.materialId === materialId && revision.materialRevisionId === revisionId,
  );
}

export type MasteryRedTeamService = ReturnType<typeof createMasteryRedTeamService>;
