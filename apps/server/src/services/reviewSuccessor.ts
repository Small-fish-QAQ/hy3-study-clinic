import {
  CurrentReviewItemSchema,
  ReviewTargetSchema,
  type MemoryScheduleState,
  type ReviewTarget,
  type ReviewTargetBinding,
  type SuccessorReviewEvent,
} from '@hy3-clinic/shared';
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
    const material = concept ? repos.materials.get(concept.materialId) : undefined;
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
    if (
      input.kind === 'fresh_verification_success' &&
      input.reviewExecutionId &&
      !repos.reviewSuccessor
        .listEvents(input.target.id)
        .some(
          (event) =>
            event.reviewExecutionId === input.reviewExecutionId &&
            event.kind === 'retrieval_failure',
        )
    ) {
      throw new Error('Initial Again event must be reconciled before Good.');
    }

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
    successForActive(input: {
      targetId: string;
      sourceOutcomeId: string;
      executionId?: string | null;
    }) {
      if (!input.executionId) throw new Error('ReviewExecution is required for Good.');
      return this.recordFreshSuccess({
        targetId: input.targetId,
        sourceOutcomeId: input.sourceOutcomeId,
        executionId: input.executionId,
      });
    },
    beginExecution(input: {
      targetId: string;
      workspaceId: string;
      courseId: string;
      agendaId?: string | null;
    }) {
      const target = repos.reviewSuccessor.getTarget(input.targetId);
      if (
        !target ||
        target.workspaceId !== input.workspaceId ||
        target.courseId !== input.courseId
      ) {
        throw new Error('Review target context is stale.');
      }
      const binding = repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion!);
      const state = repos.reviewSuccessor.getState(target.id);
      if (!binding || !state || target.status !== 'active') {
        throw new Error('Review target is not active.');
      }
      const active = repos.reviewSuccessor.activeExecution(target.id);
      if (active) return active;
      const now = clock.now().toISOString();
      return repos.reviewSuccessor.insertExecution({
        id: newId('review_execution'),
        reviewTargetId: target.id,
        bindingVersion: binding.bindingVersion,
        consumedRowVersion: state.rowVersion,
        workspaceId: input.workspaceId,
        courseId: input.courseId,
        agendaId: input.agendaId ?? null,
        assessmentVersionId: null,
        attemptId: null,
        status: 'active',
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    completeExecution(input: {
      executionId: string;
      assessmentVersionId?: string | null;
      attemptId?: string | null;
    }) {
      const execution = repos.reviewSuccessor.getExecution(input.executionId);
      if (!execution || execution.status !== 'active') {
        throw new Error('Review execution is not active.');
      }
      return repos.reviewSuccessor.updateExecution({
        ...execution,
        assessmentVersionId: input.assessmentVersionId ?? execution.assessmentVersionId,
        attemptId: input.attemptId ?? execution.attemptId,
        status: 'completed',
        updatedAt: clock.now().toISOString(),
      });
    },
    recordDueFailure(input: { targetId: string; sourceOutcomeId: string; executionId: string }) {
      const existing = findExistingExecutionEvent({ ...input, kind: 'retrieval_failure' });
      if (existing) return existing;
      const execution = repos.reviewSuccessor.getExecution(input.executionId);
      if (
        !execution ||
        execution.status !== 'active' ||
        execution.reviewTargetId !== input.targetId
      ) {
        throw new Error('Review execution is stale or inactive.');
      }
      const target = repos.reviewSuccessor.getTarget(input.targetId);
      if (!target) throw new Error('Review target not found.');
      const binding = repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion!);
      const state = repos.reviewSuccessor.getState(target.id);
      if (!binding || !state || state.rowVersion !== execution.consumedRowVersion) {
        throw new Error('Review execution row version is stale.');
      }
      return apply({
        target,
        binding,
        state,
        outcome: 'Again',
        kind: 'retrieval_failure',
        sourceOutcomeId: input.sourceOutcomeId,
        reviewExecutionId: input.executionId,
      });
    },
    recordFreshSuccess(input: { targetId: string; sourceOutcomeId: string; executionId: string }) {
      const existing = findExistingExecutionEvent({
        ...input,
        kind: 'fresh_verification_success',
      });
      if (existing) {
        const execution = repos.reviewSuccessor.getExecution(input.executionId);
        const state = repos.reviewSuccessor.getState(input.targetId);
        if (execution?.status === 'active' && state) {
          repos.reviewSuccessor.updateExecution({
            ...execution,
            consumedRowVersion: state.rowVersion,
            status: 'completed',
            updatedAt: clock.now().toISOString(),
          });
        }
        return existing;
      }
      const execution = repos.reviewSuccessor.getExecution(input.executionId);
      if (
        !execution ||
        execution.status !== 'active' ||
        execution.reviewTargetId !== input.targetId
      ) {
        throw new Error('Review execution is stale or inactive.');
      }
      const target = repos.reviewSuccessor.getTarget(input.targetId);
      if (!target) throw new Error('Review target not found.');
      const binding = repos.reviewSuccessor.getBinding(target.id, target.currentBindingVersion!);
      const state = repos.reviewSuccessor.getState(target.id);
      if (!binding || !state || state.rowVersion !== execution.consumedRowVersion) {
        throw new Error('Review execution row version is stale.');
      }
      return apply({
        target,
        binding,
        state,
        outcome: 'Good',
        kind: 'fresh_verification_success',
        sourceOutcomeId: input.sourceOutcomeId,
        reviewExecutionId: input.executionId,
      });
    },
    listDue(workspaceId: string, at = clock.now()) {
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
    },
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
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          }),
        ];
      });
    },
  };
}

export type ReviewSuccessorService = ReturnType<typeof createReviewSuccessorService>;
