import {
  ApiErrorCode,
  CreateAssessmentRequestSchema,
  CurrentReviewItemSchema,
  ReviewTargetSchema,
  decideFormalCredit,
  type AssessmentAttempt,
  type AssessmentVersion,
  type MemoryScheduleState,
  type ReviewExecution,
  type SessionAgendaItem,
  type ReviewTarget,
  type ReviewTargetBinding,
  type SuccessorReviewEvent,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import {
  DEFAULT_CONFIGURATION,
  scheduleWithFsrs,
  type AdapterOutcome,
} from '../review/fsrsAdapter.js';
import { newId, type Clock } from '../util/ids.js';

interface EnsureTargetInput {
  workspaceId: string;
  courseId: string;
  learningUnitId: string;
  objectiveId: string;
  contractVersionId: string;
  curriculumVersionId: string;
  manifestFingerprint: string;
  evidenceId?: string | null;
  at?: string;
  pendingDueAt?: string;
}

interface ApplyInput {
  target: ReviewTarget;
  binding: ReviewTargetBinding;
  state: MemoryScheduleState;
  outcome: AdapterOutcome;
  kind: 'activation' | 'retrieval_failure' | 'fresh_verification_success';
  sourceOutcomeId: string;
  reviewExecutionId?: string | null;
  occurredAt?: string;
}

interface BeginExecutionInput {
  targetId: string;
  workspaceId: string;
  courseId: string;
  agendaId: string;
  agendaItemId: string;
  contractVersionId: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  manifestFingerprint: string;
}

export function resolveReviewTargetContext(repos: Repositories, targetId: string) {
  const target = repos.reviewSuccessor.getTarget(targetId);
  if (
    !target ||
    (target.status !== 'pending_initial_review' && target.status !== 'active') ||
    !target.currentBindingVersion
  ) {
    return undefined;
  }
  const binding = repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion);
  const state = repos.reviewSuccessor.getState(target.id);
  const curriculum = binding ? repos.curricula.get(binding.curriculumVersionId) : undefined;
  const unit = curriculum?.nodes.find(
    (node) => node.id === binding?.learningUnitId && node.learningUnit !== null,
  );
  const objective = unit?.learningUnit?.objectives.find(
    (candidate) => candidate.id === binding?.objectiveId,
  );
  const exactBinding = Boolean(
    binding &&
    state &&
    curriculum &&
    curriculum.workspaceId === target.workspaceId &&
    curriculum.contractVersionId === binding.contractVersionId &&
    curriculum.executionSourceManifest.fingerprint === binding.executionSourceManifestFingerprint &&
    objective,
  );
  if (!binding || !state || !unit?.learningUnit || !objective || !exactBinding) return undefined;

  const conceptIds = unit.learningUnit.conceptIds.filter((conceptId) => {
    const concept = repos.materials.getConcept(conceptId);
    const material = concept ? repos.materials.getRouteIdentity(concept.materialId) : undefined;
    return material?.workspaceId === target.workspaceId;
  });
  if (conceptIds.length === 0) return undefined;
  return { target, binding, state, curriculum, unit, objective, conceptIds };
}

export function createReviewSuccessorService({
  repos,
  clock,
}: {
  repos: Repositories;
  clock: Clock;
}) {
  repos.reviewSuccessor.ensureConfiguration(DEFAULT_CONFIGURATION);

  function ensureTarget(input: EnsureTargetInput): {
    target: ReviewTarget;
    binding: ReviewTargetBinding;
    state: MemoryScheduleState;
  } {
    const at = input.at ?? clock.now().toISOString();
    const id = `review-target:${input.workspaceId}:${input.objectiveId}`;
    let target = repos.reviewSuccessor.getTarget(id);
    if (!target) {
      repos.transaction(() => {
        repos.reviewSuccessor.insertTarget(
          ReviewTargetSchema.parse({
            id,
            workspaceId: input.workspaceId,
            courseId: input.courseId,
            targetKind: 'curriculum_objective',
            originEvidenceId: input.evidenceId ?? null,
            status: 'pending_initial_review',
            currentBindingVersion: 1,
            createdAt: at,
            updatedAt: at,
          }),
        );
        repos.reviewSuccessor.insertBinding({
          reviewTargetId: id,
          bindingVersion: 1,
          contractVersionId: input.contractVersionId,
          curriculumVersionId: input.curriculumVersionId,
          learningUnitId: input.learningUnitId,
          objectiveId: input.objectiveId,
          executionSourceManifestFingerprint: input.manifestFingerprint,
          validFrom: at,
          validTo: null,
          createdAt: at,
        });
        repos.reviewSuccessor.insertPendingState(
          id,
          DEFAULT_CONFIGURATION.version,
          input.pendingDueAt ?? at,
          at,
        );
      });
      target = repos.reviewSuccessor.getTarget(id);
    }
    const binding = target
      ? repos.reviewSuccessor.getBinding(id, target.currentBindingVersion ?? 1)
      : undefined;
    const state = repos.reviewSuccessor.getState(id);
    if (!target || !binding || !state)
      throw new Error('Review target is missing its binding/state.');
    if (
      target.workspaceId !== input.workspaceId ||
      target.courseId !== input.courseId ||
      binding.contractVersionId !== input.contractVersionId ||
      binding.curriculumVersionId !== input.curriculumVersionId ||
      binding.learningUnitId !== input.learningUnitId ||
      binding.objectiveId !== input.objectiveId ||
      binding.executionSourceManifestFingerprint !== input.manifestFingerprint
    ) {
      throw new Error('Review target binding is stale or ambiguous.');
    }
    return { target, binding, state };
  }

  function launchTargetIds(item: SessionAgendaItem): string[] {
    if (item.kind !== 'due_review' || item.launch.capability !== 'assessment') return [];
    try {
      const request = CreateAssessmentRequestSchema.parse(JSON.parse(item.launch.resourceId ?? ''));
      return request.mode === 'review' ? (request.conceptIds ?? []) : [];
    } catch {
      return [];
    }
  }

  function validateExecutionRoute(input: BeginExecutionInput) {
    const context = resolveReviewTargetContext(repos, input.targetId);
    if (
      !context ||
      context.target.workspaceId !== input.workspaceId ||
      context.target.courseId !== input.courseId ||
      context.binding.contractVersionId !== input.contractVersionId ||
      context.binding.curriculumVersionId !== input.curriculumVersionId ||
      context.binding.executionSourceManifestFingerprint !== input.manifestFingerprint
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Review target binding is stale.');
    }
    const route = repos.courseExecution.get(input.workspaceId);
    const agenda = repos.sessionAgendas.get(input.agendaId);
    const plan = repos.studyPlans.get(input.studyPlanVersionId);
    const item = agenda?.items.find((candidate) => candidate.id === input.agendaItemId);
    const planItem = item?.linkedPlanItemId
      ? plan?.items.find((candidate) => candidate.id === item.linkedPlanItemId)
      : undefined;
    if (
      route.executionStatus !== 'active' ||
      route.routeValidationStatus !== 'valid' ||
      route.activeContractId !== input.contractVersionId ||
      route.activeCurriculumId !== input.curriculumVersionId ||
      route.acceptedPlanId !== input.studyPlanVersionId ||
      route.activeAgendaId !== input.agendaId ||
      !agenda ||
      agenda.status !== 'active' ||
      agenda.contractVersionId !== input.contractVersionId ||
      agenda.curriculumVersionId !== input.curriculumVersionId ||
      agenda.studyPlanVersionId !== input.studyPlanVersionId ||
      agenda.executionSourceManifestFingerprint !== input.manifestFingerprint ||
      !plan ||
      plan.status !== 'accepted' ||
      plan.executionSourceManifestFingerprint !== input.manifestFingerprint ||
      !item ||
      item.kind !== 'due_review' ||
      (item.state !== 'queued' && item.state !== 'active') ||
      item.learningUnitId !== context.binding.learningUnitId ||
      !planItem ||
      planItem.curriculumLearningUnitId !== context.binding.learningUnitId ||
      !planItem.objectiveIds.includes(context.binding.objectiveId) ||
      launchTargetIds(item).length !== 1 ||
      launchTargetIds(item)[0] !== context.target.id
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Review Agenda route is stale.');
    }
    return { ...context, agenda, item, plan };
  }

  function gradeDemonstrated(version: AssessmentVersion, attempt: AssessmentAttempt): boolean {
    const grade = repos.formalAssessments
      .listGrades(attempt.id)
      .find((candidate) => candidate.status === 'current');
    if (!grade) return false;
    return version.items
      .filter((item) => item.formalEligible)
      .every((item) => {
        const criterionIds = new Set((item.rubric ?? []).map((criterion) => criterion.id));
        return decideFormalCredit({
          rubric: item.rubric ?? [],
          criterionResults: grade.judgment.criterionResults.filter((result) =>
            criterionIds.has(result.criterionId),
          ),
        }).formallyDemonstrated;
      });
  }

  function reconcileDueAgenda(workspaceId: string) {
    const route = repos.courseExecution.get(workspaceId);
    const agenda = route.activeAgendaId
      ? repos.sessionAgendas.get(route.activeAgendaId)
      : undefined;
    const plan = route.acceptedPlanId ? repos.studyPlans.get(route.acceptedPlanId) : undefined;
    const curriculum = route.activeCurriculumId
      ? repos.curricula.get(route.activeCurriculumId)
      : undefined;
    if (
      route.executionStatus !== 'active' ||
      route.routeValidationStatus !== 'valid' ||
      !agenda ||
      agenda.status !== 'active' ||
      !plan ||
      plan.status !== 'accepted' ||
      !curriculum ||
      agenda.studyPlanVersionId !== plan.id ||
      agenda.curriculumVersionId !== curriculum.id ||
      agenda.contractVersionId !== plan.contractVersionId ||
      agenda.executionSourceManifestFingerprint !== plan.executionSourceManifestFingerprint
    ) {
      return agenda ?? null;
    }

    const progress = new Map(
      repos.studyPlans.listProgress(plan.id).map((item) => [item.planItemId, item.state]),
    );
    const activeSessions = repos.studySessions
      .list(workspaceId)
      .filter(
        (session) =>
          session.sessionAgendaId === agenda.id &&
          (session.status === 'active' || session.status === 'paused'),
      );
    const canPrioritize = activeSessions.every((session) => !session.currentAgendaItemId);
    let items = [...agenda.items];
    const inserted: SessionAgendaItem[] = [];

    for (const { target } of listDue(workspaceId)) {
      const context = resolveReviewTargetContext(repos, target.id);
      if (
        !context ||
        context.binding.contractVersionId !== plan.contractVersionId ||
        context.binding.curriculumVersionId !== curriculum.id ||
        context.binding.executionSourceManifestFingerprint !==
          plan.executionSourceManifestFingerprint ||
        repos.reviewSuccessor.activeExecution(target.id) ||
        items.some(
          (item) =>
            !['completed', 'cancelled', 'deferred'].includes(item.state) &&
            launchTargetIds(item).includes(target.id),
        )
      ) {
        continue;
      }
      const planItem = [...plan.items]
        .filter(
          (item) =>
            item.curriculumLearningUnitId === context.binding.learningUnitId &&
            item.objectiveIds.includes(context.binding.objectiveId) &&
            progress.get(item.id) !== 'deferred' &&
            progress.get(item.id) !== 'obsolete',
        )
        .sort(
          (left, right) =>
            Number(right.kind === 'due_review') - Number(left.kind === 'due_review') ||
            Number(right.kind === 'formal_checkpoint') -
              Number(left.kind === 'formal_checkpoint') ||
            left.index - right.index ||
            left.id.localeCompare(right.id),
        )[0];
      if (!planItem || items.length >= 200) continue;
      const launch = {
        status: 'launchable' as const,
        capability: 'assessment' as const,
        resourceId: JSON.stringify({ mode: 'review', conceptIds: [target.id] }),
        reason: null,
      };
      const dueItem: SessionAgendaItem = {
        id: newId('agenda_item'),
        index: Math.max(-1, ...items.map((item) => item.index)) + 1,
        kind: 'due_review',
        origin: 'due_review',
        reason: `复习“${context.objective.title}”：这项目标已到复习时间，需要先独立回忆再继续。`,
        estimatedMinutes: Math.max(5, Math.min(20, planItem.estimatedMinutes)),
        linkedPlanItemId: planItem.id,
        learningUnitId: context.binding.learningUnitId,
        priority: 'high',
        state: 'queued',
        launch,
        displacedAgendaItemIds: [],
        timeImpactMinutes: Math.max(5, Math.min(20, planItem.estimatedMinutes)),
      };
      items = [...items, dueItem];
      inserted.push(dueItem);
    }
    if (inserted.length === 0) return agenda;

    const at = clock.now().toISOString();
    const currentItemId = canPrioritize ? inserted[0]!.id : agenda.currentItemId;
    return repos.transaction(() => {
      const updated = repos.sessionAgendas.update(
        {
          ...agenda,
          version: agenda.version + 1,
          items,
          currentItemId,
          updatedAt: at,
        },
        agenda.version,
        {
          id: newId('agenda_event'),
          eventType: 'due_reviews_reconciled',
          actor: 'local',
          payload: {
            reviewTargetIds: inserted.map((item) => launchTargetIds(item)[0]),
            prioritizedAgendaItemId: currentItemId === agenda.currentItemId ? null : currentItemId,
          },
          createdAt: at,
        },
      );
      if (canPrioritize) {
        for (const session of activeSessions) {
          repos.studySessions.update(
            {
              ...session,
              version: session.version + 1,
              currentAgendaItemId: currentItemId,
              updatedAt: at,
            },
            session.version,
          );
        }
      }
      return updated;
    });
  }

  function apply(input: ApplyInput): SuccessorReviewEvent {
    const at = input.occurredAt ?? clock.now().toISOString();
    const existing = repos.reviewSuccessor.findEventBySource(
      input.target.id,
      input.sourceOutcomeId,
      DEFAULT_CONFIGURATION.version,
    );
    if (existing) return existing;

    const execution = input.reviewExecutionId
      ? repos.reviewSuccessor.getExecution(input.reviewExecutionId)
      : undefined;
    const scheduledInput =
      input.state.lifecycleState === 'pending_initial_review' ? null : input.state;
    const result = scheduleWithFsrs({
      state: scheduledInput,
      outcome: input.outcome,
      reviewTime: new Date(at),
      configuration: DEFAULT_CONFIGURATION,
    });
    const eventId = newId('review_event');
    const event: SuccessorReviewEvent = {
      id: eventId,
      reviewTargetId: input.target.id,
      bindingVersion: input.binding.bindingVersion,
      policyVersion: DEFAULT_CONFIGURATION.version,
      kind: input.kind,
      sequence: repos.reviewSuccessor.nextEventSequence(input.target.id),
      sourceOutcomeId: input.sourceOutcomeId,
      reviewExecutionId: input.reviewExecutionId ?? null,
      rating: input.outcome,
      occurredAt: at,
      recordedAt: clock.now().toISOString(),
      preState: input.state,
      postState: result.state,
      exactInputTime: at,
      dueAt: result.state.dueAt,
      idempotencyKey: `${input.target.id}:${input.sourceOutcomeId}:${DEFAULT_CONFIGURATION.version}`,
    };
    const nextState: MemoryScheduleState = {
      ...input.state,
      ...result.state,
      lastReviewEventId: eventId,
      policyVersion: DEFAULT_CONFIGURATION.version,
      rowVersion: input.state.rowVersion + 1,
      createdAt: input.state.createdAt,
      updatedAt: at,
    };
    return repos.reviewSuccessor.commitEventAndState(
      event,
      nextState,
      input.state.rowVersion,
      execution
        ? {
            id: execution.id,
            expectedConsumedRowVersion: execution.consumedRowVersion,
            nextConsumedRowVersion: nextState.rowVersion,
            status: input.kind === 'fresh_verification_success' ? 'completed' : 'active',
            updatedAt: at,
          }
        : undefined,
    ).event;
  }

  function findExistingExecutionEvent(input: {
    targetId: string;
    sourceOutcomeId: string;
    executionId: string;
    kind: 'retrieval_failure' | 'fresh_verification_success';
  }) {
    const existing = repos.reviewSuccessor.findEventBySource(
      input.targetId,
      input.sourceOutcomeId,
      DEFAULT_CONFIGURATION.version,
    );
    if (!existing) return undefined;
    if (existing.reviewExecutionId !== input.executionId || existing.kind !== input.kind) {
      throw new Error('Review outcome idempotency identity does not match this execution.');
    }
    return existing;
  }

  function listDue(workspaceId: string, at = clock.now()) {
    return repos.reviewSuccessor
      .listTargets(workspaceId)
      .map((target) => ({
        target,
        state: repos.reviewSuccessor.getState(target.id),
        binding: repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion!),
      }))
      .filter(
        (item) =>
          item.target.status === 'active' &&
          item.state &&
          new Date(item.state.dueAt).getTime() <= at.getTime(),
      )
      .sort(
        (a, b) =>
          new Date(a.state!.dueAt).getTime() - new Date(b.state!.dueAt).getTime() ||
          a.target.id.localeCompare(b.target.id),
      );
  }

  function beginExecution(input: BeginExecutionInput): ReviewExecution {
    const context = validateExecutionRoute(input);
    const active = repos.reviewSuccessor.activeExecution(context.target.id);
    if (active) {
      if (
        active.bindingVersion !== context.binding.bindingVersion ||
        active.agendaId !== input.agendaId ||
        active.consumedRowVersion !== context.state.rowVersion
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Active Review execution is stale.');
      }
      return active;
    }
    if (new Date(context.state.dueAt).getTime() > clock.now().getTime()) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Review target is no longer due.');
    }
    const now = clock.now().toISOString();
    return repos.reviewSuccessor.insertExecution({
      id: newId('review_execution'),
      reviewTargetId: context.target.id,
      bindingVersion: context.binding.bindingVersion,
      consumedRowVersion: context.state.rowVersion,
      workspaceId: input.workspaceId,
      courseId: input.courseId,
      agendaId: input.agendaId,
      assessmentVersionId: null,
      attemptId: null,
      status: 'active',
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  function bindAssessment(executionId: string, version: AssessmentVersion): ReviewExecution {
    const execution = repos.reviewSuccessor.getExecution(executionId);
    const context = execution
      ? resolveReviewTargetContext(repos, execution.reviewTargetId)
      : undefined;
    const progression = version.progressionContext;
    if (
      !execution ||
      execution.status !== 'active' ||
      !context ||
      version.status !== 'accepted' ||
      !progression ||
      progression.assessmentKind !== 'due_review' ||
      progression.agendaId !== execution.agendaId ||
      progression.contractVersionId !== context.binding.contractVersionId ||
      progression.curriculumVersionId !== context.binding.curriculumVersionId ||
      progression.executionSourceManifestFingerprint !==
        context.binding.executionSourceManifestFingerprint ||
      !version.items.every(
        (item) =>
          item.formalEligible &&
          item.targetLearningUnitId === context.binding.learningUnitId &&
          item.targetObjectiveId === context.binding.objectiveId,
      )
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Review AssessmentVersion does not match the active target binding.',
      );
    }
    return repos.reviewSuccessor.bindExecutionAssessment(
      execution.id,
      version.id,
      clock.now().toISOString(),
    );
  }

  function bindAttempt(executionId: string, attempt: AssessmentAttempt): ReviewExecution {
    const execution = repos.reviewSuccessor.getExecution(executionId);
    if (
      !execution ||
      execution.status !== 'active' ||
      execution.assessmentVersionId !== attempt.assessmentVersionId ||
      execution.workspaceId !== attempt.workspaceId ||
      attempt.status === 'cancelled'
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Review Attempt does not match the active AssessmentVersion.',
      );
    }
    return repos.reviewSuccessor.bindExecutionAttempt(
      execution.id,
      attempt.id,
      clock.now().toISOString(),
    );
  }

  function recordDueFailure(input: {
    targetId: string;
    gradeRecordId: string;
    executionId: string;
  }): SuccessorReviewEvent {
    const existing = findExistingExecutionEvent({
      targetId: input.targetId,
      sourceOutcomeId: input.gradeRecordId,
      executionId: input.executionId,
      kind: 'retrieval_failure',
    });
    if (existing) return existing;
    const priorAgain = repos.reviewSuccessor
      .listEvents(input.targetId)
      .find(
        (event) =>
          event.reviewExecutionId === input.executionId && event.kind === 'retrieval_failure',
      );
    if (priorAgain) return priorAgain;
    const execution = repos.reviewSuccessor.getExecution(input.executionId);
    const grade = repos.formalAssessments.getGrade(input.gradeRecordId);
    const attempt = execution?.attemptId
      ? repos.formalAssessments.getAttempt(execution.attemptId)
      : undefined;
    const version = execution?.assessmentVersionId
      ? repos.formalAssessments.getVersion(execution.assessmentVersionId)
      : undefined;
    if (
      !execution ||
      execution.status !== 'active' ||
      execution.reviewTargetId !== input.targetId ||
      !grade ||
      grade.status !== 'current' ||
      !attempt ||
      grade.attemptId !== attempt.id ||
      !version ||
      grade.assessmentVersionId !== version.id ||
      gradeDemonstrated(version, attempt)
    ) {
      throw new Error('Again requires the active failed due-Review Attempt.');
    }
    const target = repos.reviewSuccessor.getTarget(input.targetId);
    const binding = target?.currentBindingVersion
      ? repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion)
      : undefined;
    const state = target ? repos.reviewSuccessor.getState(target.id) : undefined;
    if (
      !target ||
      !binding ||
      binding.bindingVersion !== execution.bindingVersion ||
      !state ||
      state.rowVersion !== execution.consumedRowVersion
    ) {
      throw new Error('Review execution row version is stale.');
    }
    return apply({
      target,
      binding,
      state,
      outcome: 'Again',
      kind: 'retrieval_failure',
      sourceOutcomeId: input.gradeRecordId,
      reviewExecutionId: input.executionId,
    });
  }

  function recordSupportedEvidence(input: {
    targetId: string;
    evidenceId: string;
    executionId: string;
  }): SuccessorReviewEvent {
    const existing = findExistingExecutionEvent({
      targetId: input.targetId,
      sourceOutcomeId: input.evidenceId,
      executionId: input.executionId,
      kind: 'fresh_verification_success',
    });
    if (existing) return existing;

    let execution = repos.reviewSuccessor.getExecution(input.executionId);
    const evidence = repos.formalAssessments.getEvidence(input.evidenceId);
    const attempt = evidence ? repos.formalAssessments.getAttempt(evidence.attemptId) : undefined;
    const grade = evidence ? repos.formalAssessments.getGrade(evidence.gradeRecordId) : undefined;
    const version = evidence
      ? repos.formalAssessments.getVersion(evidence.assessmentVersionId)
      : undefined;
    const context = execution
      ? resolveReviewTargetContext(repos, execution.reviewTargetId)
      : undefined;
    const item = version?.items.find((candidate) => candidate.id === evidence?.itemId);
    if (
      !execution ||
      execution.status !== 'active' ||
      execution.reviewTargetId !== input.targetId ||
      !evidence ||
      evidence.conclusion !== 'supported' ||
      !attempt ||
      attempt.status !== 'submitted' ||
      !grade ||
      grade.status !== 'current' ||
      !version ||
      !context ||
      !item ||
      item.targetLearningUnitId !== context.binding.learningUnitId ||
      item.targetObjectiveId !== context.binding.objectiveId ||
      !gradeDemonstrated(version, attempt)
    ) {
      throw new Error('Good requires supported Evidence for the active Review target.');
    }

    let again = repos.reviewSuccessor
      .listEvents(input.targetId)
      .find(
        (event) =>
          event.reviewExecutionId === input.executionId && event.kind === 'retrieval_failure',
      );
    const direct =
      attempt.id === execution.attemptId && version.id === execution.assessmentVersionId;
    if (direct && again) {
      throw new Error('A failed retrieval requires changed-context fresh verification.');
    }
    if (!direct) {
      const episode = repos.repair
        .listByWorkspace(execution.workspaceId)
        .find(
          (candidate) =>
            candidate.triggerAttemptId === execution!.attemptId &&
            candidate.verificationAttemptId === attempt.id,
        );
      if (!episode) {
        throw new Error('Good after failure requires the linked fresh verification Attempt.');
      }
      if (!again) {
        const originalGrade = execution.attemptId
          ? repos.formalAssessments
              .listGrades(execution.attemptId)
              .find((candidate) => candidate.status === 'current')
          : undefined;
        if (!originalGrade) throw new Error('Initial Again outcome is unavailable.');
        again = recordDueFailure({
          targetId: input.targetId,
          gradeRecordId: originalGrade.id,
          executionId: input.executionId,
        });
        execution = repos.reviewSuccessor.getExecution(input.executionId);
      }
      if (!again || !execution || execution.status !== 'active') {
        throw new Error('Initial Again event must be durable before Good.');
      }
    }

    const target = repos.reviewSuccessor.getTarget(input.targetId);
    const binding = target?.currentBindingVersion
      ? repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion)
      : undefined;
    const state = target ? repos.reviewSuccessor.getState(target.id) : undefined;
    if (
      !target ||
      !binding ||
      binding.bindingVersion !== execution.bindingVersion ||
      !state ||
      state.rowVersion !== execution.consumedRowVersion
    ) {
      throw new Error('Review execution row version is stale.');
    }
    return apply({
      target,
      binding,
      state,
      outcome: 'Good',
      kind: 'fresh_verification_success',
      sourceOutcomeId: input.evidenceId,
      reviewExecutionId: input.executionId,
    });
  }

  return {
    ensureTarget,
    activate(input: EnsureTargetInput & { sourceOutcomeId: string; eligible: boolean }) {
      if (!input.eligible) return null;
      const occurredAt = input.at ?? clock.now().toISOString();
      if (occurredAt < DEFAULT_CONFIGURATION.effectiveAt) return null;
      const current = ensureTarget({ ...input, at: occurredAt });
      const existing = repos.reviewSuccessor.findEventBySource(
        current.target.id,
        input.sourceOutcomeId,
        DEFAULT_CONFIGURATION.version,
      );
      if (existing) return existing;
      if (current.target.status === 'active') return null;
      return apply({
        ...current,
        outcome: 'Good',
        kind: 'activation',
        sourceOutcomeId: input.sourceOutcomeId,
        occurredAt,
      });
    },
    reconcileDueAgenda,
    beginExecution,
    bindAssessment,
    bindAttempt,
    recordDueFailure,
    recordSupportedEvidence,
    markExecutionFailure(executionId: string, error: unknown) {
      return repos.reviewSuccessor.setExecutionFailure(
        executionId,
        error instanceof Error ? error.message.slice(0, 500) : 'Review scheduling is retryable.',
        clock.now().toISOString(),
      );
    },
    clearExecutionFailure(executionId: string) {
      return repos.reviewSuccessor.setExecutionFailure(
        executionId,
        null,
        clock.now().toISOString(),
      );
    },
    listDue,
    getTarget: repos.reviewSuccessor.getTarget,
    listCurrent(workspaceId: string) {
      return repos.reviewSuccessor
        .listCurrent(workspaceId)
        .map(({ target, state }) => ({
          target,
          state,
          binding: repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion!),
        }))
        .filter(
          (item): item is typeof item & { binding: ReviewTargetBinding } =>
            item.binding !== undefined,
        );
    },
    listCurrentProjection(workspaceId: string) {
      return repos.reviewSuccessor.listCurrent(workspaceId).flatMap(({ target }) => {
        const context = resolveReviewTargetContext(repos, target.id);
        if (!context) return [];
        const { binding, state, objective, conceptIds } = context;
        const execution = repos.reviewSuccessor.latestExecution(target.id);
        const episode = execution?.attemptId
          ? repos.repair
              .listByWorkspace(workspaceId)
              .find((candidate) => candidate.triggerAttemptId === execution.attemptId)
          : undefined;
        const schedulingRetryRequired =
          execution?.failureReason !== null && execution !== undefined;
        const workflowPhase =
          execution?.status === 'active'
            ? schedulingRetryRequired
              ? ('scheduling_retry' as const)
              : episode?.status === 'OPEN'
                ? ('repair' as const)
                : episode?.status === 'ACTIVE' || episode?.status === 'DEFERRED'
                  ? ('practice' as const)
                  : episode?.status === 'AWAITING_VERIFICATION'
                    ? ('fresh_verification' as const)
                    : ('retrieval' as const)
            : new Date(state.dueAt).getTime() <= clock.now().getTime()
              ? ('due' as const)
              : ('scheduled' as const);
        return [
          CurrentReviewItemSchema.parse({
            reviewTargetId: target.id,
            workspaceId: target.workspaceId,
            courseId: target.courseId,
            learningUnitId: binding.learningUnitId,
            objectiveId: binding.objectiveId,
            objectiveTitle: objective.title,
            conceptIds,
            targetStatus: target.status,
            lifecycleState: state.lifecycleState,
            dueAt: state.dueAt,
            lastReviewedAt: state.lastReviewedAt,
            stability: state.stability,
            difficulty: state.difficulty,
            scheduledDays: state.scheduledDays,
            repetitions: state.repetitions,
            lapses: state.lapses,
            policyVersion: state.policyVersion,
            workflowPhase,
            schedulingRetryRequired,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          }),
        ];
      });
    },
  };
}

export type ReviewSuccessorService = ReturnType<typeof createReviewSuccessorService>;
