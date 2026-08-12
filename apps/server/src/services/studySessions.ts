import {
  ApiErrorCode,
  fnv1a32,
  MixedInitiativeCommandRequestSchema,
  MixedInitiativeCommandResponseSchema,
  SessionExecutionCommandRequestSchema,
  SessionExecutionCommandResponseSchema,
  StartStudySessionRequestSchema,
  StartStudySessionResponseSchema,
  SubmitTutorTurnRequestSchema,
  SubmitTutorTurnResponseSchema,
  type StudyExchange,
  type StudySession,
  type StudySessionSummary,
  type StudyTurn,
  type StudyTurnEvent,
  type SessionAgendaItem,
  type TutorContextManifest,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { FormalProgressionService } from './formalProgression.js';
import { enforceAgentCostPolicies } from './agentProviderRuntime.js';

interface StudySessionServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  providerModel?: string | null;
  clock: Clock;
  replanning: Pick<FormalProgressionService, 'qualifyReplanTrigger' | 'proposeQualifiedReplan'>;
}

interface StudyTurnOptions extends ProviderCallOptions {
  onEvent?: (event: StudyTurnEvent) => void;
}

const LEASE_MS = 5 * 60 * 1000;

function fingerprint(value: unknown): string {
  return fnv1a32(JSON.stringify(value)).toString(16).padStart(8, '0');
}

function boundedUnique(existing: string[], additions: string[], max = 100): string[] {
  return [...new Set([...existing, ...additions].map((item) => item.trim()).filter(Boolean))].slice(
    -max,
  );
}

function requireSession(repos: Repositories, workspaceId: string, sessionId: string): StudySession {
  if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
  const session = repos.studySessions.get(sessionId);
  if (!session || session.workspaceId !== workspaceId) throw notFound('StudySession not found.');
  return session;
}

function requireCurrentRoute(
  repos: Repositories,
  session: StudySession,
  allowPaused = false,
): void {
  const state = repos.courseExecution.get(session.workspaceId);
  if (
    (state.executionStatus !== 'active' && !(allowPaused && state.executionStatus === 'paused')) ||
    state.routeValidationStatus !== 'valid' ||
    state.activeContractId !== session.contractVersionId ||
    state.activeCurriculumId !== session.curriculumVersionId ||
    state.acceptedPlanId !== session.studyPlanVersionId ||
    state.activeAgendaId !== session.sessionAgendaId
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'StudySession route is stale.');
  }
}

function operationFailure(message: string, operationId: string): AppError {
  return new AppError(ApiErrorCode.VersionConflict, message, { operationId });
}

function ownsOperation(
  repos: Repositories,
  operationId: string,
  owner: string,
  fencingToken: number,
  at: string,
): boolean {
  const operation = repos.operations.get(operationId);
  return Boolean(
    operation &&
    operation.status === 'running' &&
    operation.leaseOwner === owner &&
    operation.fencingToken === fencingToken &&
    operation.leaseExpiresAt !== null &&
    operation.leaseExpiresAt > at,
  );
}

/** Durable StudySession conversation. Provider output remains advisory. */
export function createStudySessionService({
  repos,
  provider,
  providerModel,
  clock,
  replanning,
}: StudySessionServiceDeps) {
  function enforceCostPolicies(
    workspaceId: string,
    sessionId: string,
    confirmedPolicyIds: string[],
  ): string | null {
    return enforceAgentCostPolicies(repos, {
      workspaceId,
      operationType: 'study_session_tutor_turn',
      studySessionId: sessionId,
      at: clock.now().toISOString(),
      confirmedPolicyIds,
    });
  }

  function detail(workspaceId: string, sessionId: string) {
    const session = requireSession(repos, workspaceId, sessionId);
    const agenda = repos.sessionAgendas.get(session.sessionAgendaId);
    if (!agenda) {
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession Agenda is unavailable.');
    }
    const turns = repos.studySessions.listTurns(session.id);
    return {
      session,
      agenda,
      turns,
      exchanges: repos.studySessions.listExchanges(session.id),
      turnEvents: turns.flatMap((turn) => repos.studySessions.listTurnEvents(turn.id)),
      latestSummary: repos.studySessions.latestSummary(session.id) ?? null,
    };
  }

  function list(workspaceId: string): StudySession[] {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    return repos.studySessions.list(workspaceId);
  }

  function start(workspaceId: string, input: unknown) {
    const parsed = StartStudySessionRequestSchema.parse(input);
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    const state = repos.courseExecution.get(workspaceId);
    if (
      state.executionStatus !== 'active' ||
      state.routeValidationStatus !== 'valid' ||
      state.version !== parsed.expectedCourseExecutionVersion ||
      state.activeContractId !== parsed.contractVersionId ||
      state.activeCurriculumId !== parsed.curriculumVersionId ||
      state.acceptedPlanId !== parsed.studyPlanVersionId ||
      state.activeAgendaId !== parsed.sessionAgendaId
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession start route is stale.');
    }
    const agenda = repos.sessionAgendas.get(parsed.sessionAgendaId);
    if (!agenda || agenda.status !== 'active') {
      throw new AppError(ApiErrorCode.VersionConflict, 'The active SessionAgenda is unavailable.');
    }
    const existing = repos.studySessions
      .list(workspaceId)
      .find(
        (session) =>
          (session.status === 'active' || session.status === 'paused') &&
          session.sessionAgendaId === agenda.id &&
          session.contractVersionId === parsed.contractVersionId &&
          session.curriculumVersionId === parsed.curriculumVersionId &&
          session.studyPlanVersionId === parsed.studyPlanVersionId,
      );
    if (existing) return StartStudySessionResponseSchema.parse({ session: existing });

    const now = clock.now().toISOString();
    const session = repos.studySessions.create({
      id: newId('study_session'),
      workspaceId,
      contractVersionId: parsed.contractVersionId,
      curriculumVersionId: parsed.curriculumVersionId,
      studyPlanVersionId: parsed.studyPlanVersionId,
      sessionAgendaId: agenda.id,
      executionSourceManifestFingerprint: agenda.executionSourceManifestFingerprint,
      version: 1,
      status: 'active',
      routeState: 'on_route',
      currentAgendaItemId: agenda.currentItemId,
      routeStack: [],
      transcriptWatermark: 0,
      createdAt: now,
      updatedAt: now,
    });
    return StartStudySessionResponseSchema.parse({ session });
  }

  function contextManifest(
    session: StudySession,
    turnNumber: number,
    agendaItem: SessionAgendaItem | null,
  ): TutorContextManifest {
    const contract = repos.learningContracts.get(session.contractVersionId);
    const curriculum = repos.curricula.get(session.curriculumVersionId);
    if (!contract || !curriculum)
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession route is incomplete.');
    const sourceBlockRevisionIds = curriculum.executionSourceManifest.revisions.flatMap(
      (revision) => revision.sourceBlockRevisionIds,
    );
    const learnerState = learnerStateContext(session, agendaItem);
    const base = {
      contractScopeFingerprint: fingerprint(contract.courseScope),
      contractVersionId: session.contractVersionId,
      curriculumVersionId: session.curriculumVersionId,
      studyPlanVersionId: session.studyPlanVersionId,
      sessionAgendaVersionId: `${session.sessionAgendaId}:v${repos.sessionAgendas.get(session.sessionAgendaId)?.version ?? 0}`,
      studySessionVersion: session.version,
      executionSourceManifestFingerprint: session.executionSourceManifestFingerprint,
      transcriptWatermark: session.transcriptWatermark,
      sourceBlockRevisionIds,
      formalEvidenceIds: learnerState.formalEvidence.map((evidence) => evidence.id),
      riskIds: learnerState.riskIds,
    };
    return { ...base, fingerprint: fingerprint({ ...base, turnNumber }) };
  }

  function currentUnitContext(session: StudySession, agendaItem: SessionAgendaItem | null) {
    if (!agendaItem?.learningUnitId) return null;
    const curriculum = repos.curricula.get(session.curriculumVersionId);
    const node = curriculum?.nodes.find((candidate) => candidate.id === agendaItem.learningUnitId);
    if (!node?.learningUnit) return null;
    const refs = node.sourceReferences.filter((ref) => ref.sourceBlockId).slice(0, 8);
    const sourceTruth = refs.flatMap((ref) => {
      const block = ref.sourceBlockId ? repos.materials.getBlock(ref.sourceBlockId) : undefined;
      if (!block) return [];
      return [
        {
          blockId: block.id,
          materialId: ref.materialId,
          materialRevisionId: ref.materialRevisionId,
          heading: block.heading,
          contentExcerpt: block.content.slice(0, 3500),
        },
      ];
    });
    return {
      id: node.id,
      title: node.title,
      conceptIds: node.learningUnit.conceptIds,
      objectives: node.learningUnit.objectives.map((objective) => ({
        id: objective.id,
        title: objective.title,
        description: objective.description,
        truthPremiseStatus: objective.truthPremiseStatus,
        truthAuthorityRecordIds: objective.truthAuthorityRecordIds,
      })),
      prerequisiteUnitIds: node.learningUnit.prerequisiteUnitIds,
      sourceTruth,
    };
  }

  function learnerStateContext(session: StudySession, agendaItem: SessionAgendaItem | null) {
    const curriculum = repos.curricula.get(session.curriculumVersionId);
    const unit = agendaItem?.learningUnitId
      ? curriculum?.nodes.find((node) => node.id === agendaItem.learningUnitId)?.learningUnit
      : null;
    const conceptIds = new Set(unit?.conceptIds ?? []);
    const formalEvidence = agendaItem?.learningUnitId
      ? repos.formalProgression
          .listEvidenceForUnit(
            session.workspaceId,
            session.curriculumVersionId,
            agendaItem.learningUnitId,
          )
          .slice(-20)
          .map((evidence) => ({
            id: evidence.id,
            primaryObjectiveId: evidence.primaryObjectiveId,
            normalizedScore: evidence.normalizedScore,
            admissibilityTier: evidence.admissibilityTier,
            stateCreditable: evidence.stateCreditable,
          }))
      : [];
    const materials = new Set(
      [...conceptIds]
        .map((conceptId) => repos.materials.getConcept(conceptId)?.materialId)
        .filter((materialId): materialId is string => Boolean(materialId)),
    );
    const openMistakes = [...materials]
      .flatMap((materialId) => repos.mistakes.listByMaterial(materialId))
      .filter((mistake) => conceptIds.has(mistake.conceptId) && mistake.status === 'open')
      .slice(0, 20)
      .map((mistake) => ({
        id: mistake.id,
        conceptId: mistake.conceptId,
        score: mistake.score,
        feedback: mistake.feedback ?? null,
      }));
    const misconceptions = [...conceptIds]
      .flatMap((conceptId) => repos.misconceptions.listByConcept(conceptId))
      .filter((record) => record.status === 'proposed' || record.status === 'confirmed')
      .slice(0, 20)
      .map((record) => ({
        id: record.id,
        conceptId: record.conceptId,
        status: record.status,
        hypothesis: record.hypothesis,
      }));
    const reviews = repos.review
      .listByWorkspace(session.workspaceId)
      .filter((review) => conceptIds.has(review.conceptId))
      .slice(0, 20)
      .map((review) => ({
        conceptId: review.conceptId,
        dueAt: review.dueAt,
        lastRating: review.lastRating,
      }));
    const mastery = repos.mastery
      .listByWorkspace(session.workspaceId)
      .filter((state) => conceptIds.has(state.conceptId))
      .slice(0, 20)
      .map((state) => ({
        conceptId: state.conceptId,
        mastery: state.mastery,
        attempts: state.attempts,
      }));
    const riskIds = repos.coverageRisks
      .list(session.workspaceId, session.contractVersionId)
      .filter(
        (risk) =>
          (agendaItem?.learningUnitId &&
            risk.referencedCurriculumNodeIds.includes(agendaItem.learningUnitId)) ||
          risk.referencedConceptIds.some((conceptId) => conceptIds.has(conceptId)),
      )
      .slice(0, 20)
      .map((risk) => risk.id);
    return { formalEvidence, openMistakes, misconceptions, reviews, mastery, riskIds };
  }

  function updateTurn(turn: StudyTurn): StudyTurn {
    return repos.studySessions.updateTurn(turn);
  }

  function createSummary(
    session: StudySession,
    throughExchangeSeq: number,
    delta: Awaited<ReturnType<LlmProvider['respondToTutorTurn']>>['summaryDelta'],
  ): StudySessionSummary {
    const previous = repos.studySessions.latestSummary(session.id);
    const now = clock.now().toISOString();
    return repos.studySessions.insertSummary({
      id: newId('study_summary'),
      sessionId: session.id,
      version: (previous?.version ?? 0) + 1,
      throughExchangeSeq,
      contextFingerprint: fingerprint({
        session: session.id,
        version: session.version,
        throughExchangeSeq,
      }),
      learnerQuestions: boundedUnique(previous?.learnerQuestions ?? [], delta.learnerQuestions),
      unresolvedConfusions: boundedUnique(
        previous?.unresolvedConfusions ?? [],
        delta.unresolvedConfusion,
      ),
      explanationsTried: boundedUnique(previous?.explanationsTried ?? [], delta.explanationsTried),
      provisionalUnderstanding: boundedUnique(
        previous?.provisionalUnderstanding ?? [],
        delta.learnerReactions,
      ),
      openActions: boundedUnique(previous?.openActions ?? [], delta.openActions),
      safetyFlags: boundedUnique(previous?.safetyFlags ?? [], delta.safetyFlags, 50),
      createdAt: now,
    });
  }

  async function submitTurn(
    workspaceId: string,
    sessionId: string,
    input: unknown,
    opts: StudyTurnOptions = {},
  ) {
    const { onEvent, ...providerOptions } = opts;
    const parsed = SubmitTutorTurnRequestSchema.parse(input);
    const session = requireSession(repos, workspaceId, sessionId);

    const operationIdentity = `study-turn:${session.id}:${parsed.commandId}`;
    const now = clock.now();
    let created: ReturnType<Repositories['operations']['createOrGet']>;
    try {
      created = repos.operations.createOrGet({
        id: newId('op'),
        workspaceId,
        commandId: operationIdentity,
        idempotencyKey: operationIdentity,
        logicalOperationId: operationIdentity,
        operationType: 'study_session_turn',
        expectedFingerprint: fingerprint({ sessionId, ...parsed }),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      throw new AppError(ApiErrorCode.VersionConflict, 'StudySession turn command was reused.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const previous = repos.operations.getResult(created.operation.id);
    if (previous?.status === 'completed')
      return SubmitTutorTurnResponseSchema.parse(previous.payload);
    if (previous)
      throw operationFailure('The prior StudySession turn did not complete.', created.operation.id);

    const interruptedTurn = repos.studySessions.getTurnByCommand(session.id, parsed.commandId);
    const sessionExchanges = repos.studySessions.listExchanges(session.id);
    const turnExchanges = interruptedTurn
      ? sessionExchanges.filter((exchange) => exchange.turnId === interruptedTurn.id)
      : [];
    const retryExchange = turnExchanges.find((exchange) => exchange.role === 'learner');
    const priorLogicalCall = interruptedTurn?.logicalCallId
      ? repos.telemetry.getLogicalCall(interruptedTurn.logicalCallId)
      : undefined;
    const priorAttempts = interruptedTurn?.logicalCallId
      ? repos.telemetry.listAttempts(interruptedTurn.logicalCallId)
      : [];
    const priorAttempt = priorAttempts.at(-1);
    const recoveryEvent = repos.operations.listEvents(created.operation.id).at(-1);
    const latestTurn = repos.studySessions.listTurns(session.id).at(-1);
    const latestExchange = sessionExchanges.at(-1);
    const recoveredInterruptedRetry = Boolean(
      interruptedTurn &&
      !created.created &&
      created.operation.status === 'interrupted' &&
      created.operation.leaseOwner === null &&
      created.operation.leaseExpiresAt === null &&
      interruptedTurn.status === 'interrupted' &&
      interruptedTurn.commandId === parsed.commandId &&
      latestTurn?.id === interruptedTurn.id &&
      turnExchanges.length === 1 &&
      retryExchange &&
      retryExchange.content === parsed.content &&
      retryExchange.channel === 'conversation' &&
      latestExchange?.id === retryExchange.id &&
      interruptedTurn.contextManifest.studySessionVersion === parsed.expectedSessionVersion &&
      interruptedTurn.contextManifest.transcriptWatermark === retryExchange.seq &&
      session.version === parsed.expectedSessionVersion + 1 &&
      session.transcriptWatermark === retryExchange.seq + 1 &&
      priorLogicalCall?.operationId === created.operation.id &&
      priorLogicalCall.studySessionId === session.id &&
      priorLogicalCall.operationType === 'study_session_tutor_turn' &&
      priorLogicalCall.status === 'open' &&
      priorAttempt &&
      (priorAttempt.status === 'interrupted' || priorAttempt.status === 'outcome_unknown') &&
      priorAttempt.fencingToken === created.operation.fencingToken &&
      recoveryEvent?.kind === 'operation_interrupted' &&
      recoveryEvent.fencingToken === created.operation.fencingToken,
    );
    if (
      (interruptedTurn && !recoveredInterruptedRetry) ||
      (!interruptedTurn && created.operation.status === 'interrupted')
    ) {
      throw operationFailure(
        'The interrupted StudySession turn does not own the durable retry state.',
        created.operation.id,
      );
    }
    const owner = newId('worker');
    const claim = repos.operations.claim(
      created.operation.id,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
    );
    if (!claim)
      throw operationFailure(
        'This StudySession turn is already in progress.',
        created.operation.id,
      );
    const ownedInterruptedRetry = Boolean(
      recoveredInterruptedRetry &&
      claim.fencingToken === created.operation.fencingToken + 1 &&
      ownsOperation(repos, claim.id, owner, claim.fencingToken, now.toISOString()),
    );
    if (recoveredInterruptedRetry && !ownedInterruptedRetry) {
      throw operationFailure('The interrupted StudySession turn lost retry ownership.', claim.id);
    }

    let policyFingerprint: string | null = null;
    try {
      policyFingerprint = enforceCostPolicies(
        workspaceId,
        session.id,
        parsed.confirmedCostPolicyIds ?? [],
      );
    } catch (error) {
      repos.operations.finalize(
        {
          operationId: claim.id,
          status: 'failed',
          payload: {
            message:
              error instanceof Error ? error.message.slice(0, 500) : 'Cost policy rejected call.',
          },
          createdAt: clock.now().toISOString(),
        },
        owner,
        claim.fencingToken,
      );
      throw error;
    }

    // Telemetry is unconditional. Unknown provider usage/cost remains NULL;
    // absence of a monetary policy never suppresses logical/physical counts.
    const logicalCallId = interruptedTurn?.logicalCallId ?? newId('llm_call');
    let attemptId = newId('llm_attempt');
    let attemptNumber = interruptedTurn
      ? repos.telemetry.listAttempts(logicalCallId).length + 1
      : 1;
    const callStartedAt = clock.now().toISOString();
    let attemptStartedAt = callStartedAt;
    if (!interruptedTurn) {
      repos.telemetry.insertLogicalCall({
        id: logicalCallId,
        operationId: claim.id,
        workspaceId,
        studySessionId: session.id,
        learningUnitId: null,
        assessmentId: null,
        operationType: 'study_session_tutor_turn',
        cacheKey: null,
        cacheStatus: 'not_checked',
        promptFingerprint: null,
        schemaFingerprint: 'tutor-turn-v1',
        policyFingerprint,
        sourceFingerprint: session.executionSourceManifestFingerprint,
        status: 'open',
        createdAt: callStartedAt,
        completedAt: null,
      });
    }
    repos.telemetry.insertAttempt({
      id: attemptId,
      logicalCallId,
      attemptNumber,
      attemptKind: interruptedTurn ? 'retry' : 'original',
      provider: provider.name,
      model: provider.name === 'hy3' ? (providerModel ?? null) : null,
      fencingToken: claim.fencingToken,
      status: 'queued',
      startedAt: callStartedAt,
      sentAt: null,
      firstTokenAt: null,
      completedAt: null,
      latencyMs: null,
      timeToFirstTokenMs: null,
      errorCode: null,
      errorMessage: null,
    });

    const recordUnknownUsage = (id: string, at: string): void => {
      repos.telemetry.insertUsage({
        id: newId('llm_usage'),
        attemptId: id,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
        recordedAt: at,
      });
    };
    const onRepairAttempt = (): void => {
      const repairStartedAt = clock.now().toISOString();
      if (!ownsOperation(repos, claim.id, owner, claim.fencingToken, repairStartedAt)) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Tutor repair was fenced because its operation lease is stale.',
        );
      }
      const nextAttemptNumber = attemptNumber + 1;
      const nextAttemptId = newId('llm_attempt');
      repos.transaction(() => {
        if (
          !repos.telemetry.finishAttempt(attemptId, {
            status: 'completed',
            completedAt: repairStartedAt,
            latencyMs: Math.max(0, Date.parse(repairStartedAt) - Date.parse(attemptStartedAt)),
            errorCode: 'STRUCTURED_OUTPUT_REPAIR_REQUIRED',
            errorMessage: 'The first response required bounded structured-output repair.',
          })
        ) {
          throw new Error('Original Tutor attempt was no longer open for repair.');
        }
        recordUnknownUsage(attemptId, repairStartedAt);
        repos.telemetry.insertAttempt({
          id: nextAttemptId,
          logicalCallId,
          attemptNumber: nextAttemptNumber,
          attemptKind: 'repair',
          provider: provider.name,
          model: provider.name === 'hy3' ? (providerModel ?? null) : null,
          fencingToken: claim.fencingToken,
          status: 'queued',
          startedAt: repairStartedAt,
          sentAt: null,
          firstTokenAt: null,
          completedAt: null,
          latencyMs: null,
          timeToFirstTokenMs: null,
          errorCode: null,
          errorMessage: null,
        });
        if (!repos.telemetry.markAttemptSent(nextAttemptId, repairStartedAt)) {
          throw new Error('Tutor repair attempt could not be marked sent.');
        }
      });
      attemptNumber = nextAttemptNumber;
      attemptId = nextAttemptId;
      attemptStartedAt = repairStartedAt;
    };

    const agenda = repos.sessionAgendas.get(session.sessionAgendaId)!;
    const currentAgendaItem = session.currentAgendaItemId
      ? (agenda.items.find((item) => item.id === session.currentAgendaItemId) ?? null)
      : null;
    const turnCreatedAt = clock.now().toISOString();
    const turn: StudyTurn = interruptedTurn
      ? {
          ...interruptedTurn,
          status: 'running',
          logicalCallId,
          errorMessage: null,
          completedAt: null,
        }
      : {
          id: newId('study_turn'),
          sessionId: session.id,
          seq: repos.studySessions.listTurns(session.id).length,
          commandId: parsed.commandId,
          status: 'running',
          contextManifest: contextManifest(
            session,
            repos.studySessions.listTurns(session.id).length,
            currentAgendaItem,
          ),
          logicalCallId,
          errorMessage: null,
          createdAt: turnCreatedAt,
          completedAt: null,
        };
    const learnerExchange: StudyExchange = retryExchange ?? {
      id: newId('study_exchange'),
      sessionId: session.id,
      turnId: turn.id,
      seq: session.transcriptWatermark,
      role: 'learner',
      content: parsed.content,
      channel: 'conversation',
      createdAt: turnCreatedAt,
    };
    const events: StudyTurnEvent[] = [];
    const eventSeqBase = interruptedTurn
      ? repos.studySessions.listTurnEvents(interruptedTurn.id).length
      : 0;
    const event = (kind: StudyTurnEvent['kind'], provisional: boolean, content: string | null) => {
      const createdAt = clock.now().toISOString();
      const value: StudyTurnEvent = {
        id: newId('study_event'),
        sessionId: session.id,
        turnId: turn.id,
        seq: eventSeqBase + events.length,
        kind,
        provisional,
        content,
        createdAt,
      };
      events.push(value);
      return value;
    };

    try {
      repos.transaction(() => {
        const current = requireSession(repos, workspaceId, sessionId);
        requireCurrentRoute(repos, current);
        const expectedDurableVersion = ownedInterruptedRetry
          ? parsed.expectedSessionVersion + 1
          : parsed.expectedSessionVersion;
        if (
          current.status !== 'active' ||
          current.version !== expectedDurableVersion ||
          (ownedInterruptedRetry && current.transcriptWatermark !== learnerExchange.seq + 1)
        ) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'StudySession turn became stale before it started.',
          );
        }
        if (interruptedTurn) repos.studySessions.updateTurn(turn);
        else {
          repos.studySessions.insertTurn(turn);
          repos.studySessions.insertExchange(learnerExchange);
        }
        repos.studySessions.insertTurnEvent(event('queued', false, null));
        repos.studySessions.insertTurnEvent(event('started', true, null));
        if (!ownedInterruptedRetry) {
          // Reserve the next transcript sequence before the provider call. This
          // makes concurrent browser submissions deterministically stale.
          repos.studySessions.update(
            {
              ...current,
              version: current.version + 1,
              transcriptWatermark: learnerExchange.seq + 1,
              updatedAt: turnCreatedAt,
            },
            current.version,
          );
        }
      });
      events.slice(0, 2).forEach((value) => onEvent?.(value));
    } catch (error) {
      const failedAt = clock.now().toISOString();
      repos.telemetry.finishAttempt(attemptId, {
        status: 'failed',
        completedAt: failedAt,
        latencyMs: Math.max(0, Date.parse(failedAt) - Date.parse(callStartedAt)),
        errorCode: 'TURN_NOT_STARTED',
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Tutor turn failed.',
      });
      repos.telemetry.insertUsage({
        id: newId('llm_usage'),
        attemptId,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
        recordedAt: failedAt,
      });
      repos.telemetry.completeLogicalCall(logicalCallId, 'failed', failedAt);
      repos.operations.finalize(
        {
          operationId: claim.id,
          status: 'failed',
          payload: {
            message: error instanceof Error ? error.message.slice(0, 500) : 'Tutor turn failed.',
          },
          createdAt: clock.now().toISOString(),
        },
        owner,
        claim.fencingToken,
      );
      throw error;
    }

    try {
      if (!repos.telemetry.markAttemptSent(attemptId, clock.now().toISOString())) {
        throw new Error('Tutor provider attempt could not be marked sent.');
      }
      const result = await provider.respondToTutorTurn(
        {
          workspaceName: repos.workspaces.get(workspaceId)!.name,
          learnerMessage: parsed.content,
          session: {
            id: session.id,
            routeState: session.routeState,
            currentAgendaItemId: session.currentAgendaItemId,
            currentAgendaItem: currentAgendaItem
              ? {
                  kind: currentAgendaItem.kind,
                  reason: currentAgendaItem.reason,
                  learningUnitId: currentAgendaItem.learningUnitId,
                }
              : null,
          },
          summary: repos.studySessions.latestSummary(session.id) ?? null,
          currentUnit: currentUnitContext(session, currentAgendaItem),
          learnerState: learnerStateContext(session, currentAgendaItem),
          recentExchanges: repos.studySessions.listExchanges(
            session.id,
            Math.max(-1, session.transcriptWatermark - 12),
          ),
        },
        { ...providerOptions, onRepairAttempt },
      );
      const completedAt = clock.now().toISOString();
      const response = repos.transaction(() => {
        const current = requireSession(repos, workspaceId, sessionId);
        requireCurrentRoute(repos, current);
        const reservedSessionVersion = ownedInterruptedRetry
          ? session.version
          : session.version + 1;
        if (current.status !== 'active' || current.version !== reservedSessionVersion) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'StudySession changed while the Tutor was responding.',
          );
        }
        const tutorExchange: StudyExchange = {
          id: newId('study_exchange'),
          sessionId: session.id,
          turnId: turn.id,
          seq: learnerExchange.seq + 1,
          role: 'tutor',
          content: result.text,
          channel: 'conversation',
          createdAt: completedAt,
        };
        const completedTurn = updateTurn({ ...turn, status: 'completed', completedAt });
        repos.studySessions.insertExchange(tutorExchange);
        repos.studySessions.insertTurnEvent(event('content_delta', false, result.text));
        for (const suggestedAction of result.suggestedActions) {
          repos.studySessions.insertTurnEvent(event('action_proposed', false, suggestedAction));
        }
        repos.studySessions.insertTurnEvent(event('completed', false, null));
        const updatedSession = repos.studySessions.update(
          {
            ...current,
            version: current.version + 1,
            transcriptWatermark: tutorExchange.seq + 1,
            updatedAt: completedAt,
          },
          current.version,
        );
        createSummary(updatedSession, tutorExchange.seq, result.summaryDelta);
        const payload = SubmitTutorTurnResponseSchema.parse({
          session: updatedSession,
          turn: completedTurn,
          exchanges: [learnerExchange, tutorExchange],
          events,
        });
        repos.telemetry.finishAttempt(attemptId, {
          status: 'completed',
          completedAt,
          latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
        });
        recordUnknownUsage(attemptId, completedAt);
        repos.telemetry.completeLogicalCall(logicalCallId, 'completed', completedAt);
        const finalized = repos.operations.finalize(
          { operationId: claim.id, status: 'completed', payload, createdAt: completedAt },
          owner,
          claim.fencingToken,
        );
        if (!finalized) throw new Error('StudySession turn lost its operation lease.');
        return payload;
      });
      response.events.slice(2).forEach((value) => onEvent?.(value));
      return response;
    } catch (error) {
      const cancelled =
        error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled;
      const completedAt = clock.now().toISOString();
      if (ownsOperation(repos, claim.id, owner, claim.fencingToken, completedAt)) {
        repos.transaction(() => {
          const stored = repos.studySessions.getTurn(turn.id);
          if (stored?.status === 'running') {
            updateTurn({
              ...stored,
              status: cancelled ? 'cancelled' : 'failed',
              errorMessage:
                error instanceof Error ? error.message.slice(0, 1000) : 'Tutor turn failed.',
              completedAt,
            });
            repos.studySessions.insertTurnEvent(
              event(cancelled ? 'cancelled' : 'failed', false, null),
            );
          }
          repos.telemetry.finishAttempt(attemptId, {
            status: cancelled ? 'cancelled' : 'failed',
            completedAt,
            latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(attemptStartedAt)),
            errorCode: error instanceof ProviderError ? error.code : 'TUTOR_TURN_FAILED',
            errorMessage:
              error instanceof Error ? error.message.slice(0, 500) : 'Tutor turn failed.',
          });
          recordUnknownUsage(attemptId, completedAt);
          repos.telemetry.completeLogicalCall(
            logicalCallId,
            cancelled ? 'cancelled' : 'failed',
            completedAt,
          );
          const finalized = repos.operations.finalize(
            {
              operationId: claim.id,
              status: cancelled ? 'cancelled' : 'failed',
              payload: {
                message:
                  error instanceof Error ? error.message.slice(0, 500) : 'Tutor turn failed.',
              },
              createdAt: completedAt,
            },
            owner,
            claim.fencingToken,
          );
          if (!finalized) throw new Error('StudySession turn lost its operation lease.');
        });
        events.slice(2).forEach((value) => onEvent?.(value));
      }
      throw error;
    }
  }

  function command(workspaceId: string, sessionId: string, input: unknown) {
    const parsed = MixedInitiativeCommandRequestSchema.parse(input);
    const session = requireSession(repos, workspaceId, sessionId);

    const operationIdentity = `study-command:${session.id}:${parsed.commandId}`;
    const now = clock.now();
    let created: ReturnType<Repositories['operations']['createOrGet']>;
    try {
      created = repos.operations.createOrGet({
        id: newId('op'),
        workspaceId,
        commandId: operationIdentity,
        idempotencyKey: operationIdentity,
        logicalOperationId: operationIdentity,
        operationType: 'study_session_command',
        expectedFingerprint: fingerprint({ sessionId, ...parsed }),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'StudySession command identity was reused.',
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const previous = repos.operations.getResult(created.operation.id);
    if (previous?.status === 'completed') {
      return MixedInitiativeCommandResponseSchema.parse(previous.payload);
    }
    if (previous)
      throw operationFailure(
        'The prior StudySession command did not complete.',
        created.operation.id,
      );
    const owner = newId('worker');
    const claim = repos.operations.claim(
      created.operation.id,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
    );
    if (!claim)
      throw operationFailure(
        'This StudySession command is already in progress.',
        created.operation.id,
      );

    try {
      const payload = repos.transaction(() => {
        const current = requireSession(repos, workspaceId, sessionId);
        requireCurrentRoute(repos, current);
        if (current.status !== 'active' || current.version !== parsed.expectedSessionVersion) {
          throw new AppError(ApiErrorCode.VersionConflict, 'StudySession command became stale.');
        }
        const currentAgenda = repos.sessionAgendas.get(current.sessionAgendaId);
        if (!currentAgenda || currentAgenda.status !== 'active') {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'The SessionAgenda is no longer active.',
          );
        }
        const targetId = parsed.targetAgendaItemId ?? current.currentAgendaItemId;
        const target = targetId
          ? (currentAgenda.items.find((item) => item.id === targetId) ?? null)
          : null;
        const curriculum = repos.curricula.get(current.curriculumVersionId);
        if (!curriculum) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'The accepted Curriculum is unavailable.',
          );
        }
        const selectedLearningUnit = parsed.targetLearningUnitId
          ? curriculum.nodes.find(
              (node) =>
                node.id === parsed.targetLearningUnitId &&
                node.kind === 'learning_unit' &&
                node.learningUnit !== null,
            )
          : null;
        if (parsed.targetLearningUnitId && !selectedLearningUnit) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'The detour target is not a LearningUnit in the accepted Curriculum.',
          );
        }
        if (
          parsed.targetLearningUnitId &&
          parsed.kind !== 'detour' &&
          parsed.kind !== 'deep_dive' &&
          parsed.kind !== 'agenda_insert'
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'A Curriculum target is only valid for a detour, deep dive, or Agenda insert.',
          );
        }
        const commandLearningUnitId = selectedLearningUnit?.id ?? target?.learningUnitId ?? null;
        if (
          parsed.kind !== 'promote_to_plan' &&
          parsed.kind !== 'agenda_insert' &&
          parsed.kind !== 'return' &&
          !target
        ) {
          throw new AppError(ApiErrorCode.ValidationError, 'The target Agenda item is unknown.');
        }
        if (
          targetId &&
          !target &&
          parsed.kind !== 'agenda_insert' &&
          parsed.kind !== 'promote_to_plan' &&
          parsed.kind !== 'return'
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'The target Agenda item is not in this StudySession.',
          );
        }
        const at = clock.now().toISOString();
        let nextAgenda = currentAgenda;
        let nextSession: StudySession = current;
        let affectedAgendaItemId = target?.id ?? null;
        let planChangeRequest: {
          predecessorStudyPlanId: string;
          targetLearningUnitId: string | null;
          reason: string;
          replanTriggerId: string;
          proposedStudyPlanId: string;
        } | null = null;
        const agendaEvent = (eventType: string, payload: unknown) => ({
          id: newId('agenda_event'),
          eventType,
          actor: 'learner',
          payload,
          createdAt: at,
        });
        const routeFrame = (currentSession: StudySession, reason: string) => ({
          id: newId('route_frame'),
          parentFrameId: currentSession.routeStack.at(-1)?.id ?? null,
          originAgendaItemId: currentSession.currentAgendaItemId,
          originPlanItemId:
            currentAgenda.items.find((item) => item.id === currentSession.currentAgendaItemId)
              ?.linkedPlanItemId ?? null,
          contractVersionId: currentSession.contractVersionId,
          studyPlanVersionId: currentSession.studyPlanVersionId,
          sessionAgendaVersionId: `${currentAgenda.id}:v${currentAgenda.version}`,
          reason,
          resumePolicy: 'recompose_if_stale' as const,
          state: 'active' as const,
        });
        const readyItems = (items: SessionAgendaItem[]) =>
          items.filter((item) => item.state === 'queued' && item.launch.status === 'launchable');

        if (parsed.kind === 'agenda_insert') {
          const minutes = parsed.requestedMinutes ?? 10;
          const nextIndex = Math.max(-1, ...currentAgenda.items.map((item) => item.index)) + 1;
          const frame = routeFrame(current, parsed.reason);
          const inserted: SessionAgendaItem = {
            id: newId('agenda_item'),
            index: nextIndex,
            kind: 'learner_detour',
            origin: 'learner_insert',
            reason: parsed.reason,
            estimatedMinutes: minutes,
            linkedPlanItemId: null,
            learningUnitId: commandLearningUnitId,
            priority: 'medium',
            state: 'active',
            launch: {
              status: 'launchable',
              capability: 'conversation',
              resourceId: null,
              reason: null,
            },
            displacedAgendaItemIds: current.currentAgendaItemId
              ? [current.currentAgendaItemId]
              : [],
            timeImpactMinutes: minutes,
          };
          affectedAgendaItemId = inserted.id;
          nextAgenda = repos.sessionAgendas.update(
            {
              ...currentAgenda,
              version: currentAgenda.version + 1,
              items: [...currentAgenda.items, inserted],
              currentItemId: inserted.id,
              updatedAt: at,
            },
            currentAgenda.version,
            agendaEvent('agenda_inserted', {
              itemId: inserted.id,
              originAgendaItemId: frame.originAgendaItemId,
              reason: parsed.reason,
              minutes,
              targetLearningUnitId: commandLearningUnitId,
            }),
          );
          nextSession = {
            ...current,
            routeState: 'detour_active',
            routeStack: [...current.routeStack, frame],
            currentAgendaItemId: inserted.id,
          };
        } else if (parsed.kind === 'promote_to_plan') {
          if (
            current.routeStack.length === 0 ||
            !target ||
            target.origin !== 'learner_detour' ||
            !target.learningUnitId
          ) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'Plan promotion requires an active detour with a LearningUnit target.',
            );
          }
          const acceptedPlan = repos.studyPlans.get(current.studyPlanVersionId);
          if (!acceptedPlan || acceptedPlan.status !== 'accepted') {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'The accepted StudyPlan is no longer available for promotion.',
            );
          }
          const affectedPlanItemIds = acceptedPlan.items
            .filter((item) => item.curriculumLearningUnitId === target.learningUnitId)
            .map((item) => item.id);
          const trigger = replanning.qualifyReplanTrigger({
            command: {
              commandId: `${parsed.commandId}:qualify`,
              idempotencyKey: `${parsed.commandId}:qualify`,
              workspaceId,
              actor: 'learner',
            },
            expectedAcceptedStudyPlanId: current.studyPlanVersionId,
            kind: 'promoted_detour',
            evidenceIds: [],
            reason: parsed.reason,
            facts: {
              qualifyingOccurrences: 1,
              affectedLearningUnitIds: [target.learningUnitId],
              affectedPlanItemIds,
              observedMinutesPerWeek: null,
              sourceManifestFingerprint: current.executionSourceManifestFingerprint,
              learnerConfirmedChange: true,
            },
          });
          const proposal = replanning.proposeQualifiedReplan({
            command: {
              commandId: `${parsed.commandId}:propose`,
              idempotencyKey: `${parsed.commandId}:propose`,
              workspaceId,
              actor: 'learner',
            },
            triggerId: trigger.id,
            expectedAcceptedStudyPlanId: current.studyPlanVersionId,
          });
          planChangeRequest = {
            predecessorStudyPlanId: current.studyPlanVersionId,
            targetLearningUnitId: target.learningUnitId,
            reason: parsed.reason,
            replanTriggerId: proposal.trigger.id,
            proposedStudyPlanId: proposal.studyPlan.id,
          };
          repos.sessionAgendas.appendEvent(
            currentAgenda.id,
            agendaEvent('plan_promotion_requested', planChangeRequest),
          );
        } else if (parsed.kind === 'return') {
          if (current.routeStack.length === 0) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'There is no active detour to return from.',
            );
          }
          const frame = current.routeStack.at(-1)!;
          const markedItems = currentAgenda.items.map((item) =>
            item.id === current.currentAgendaItemId &&
            item.linkedPlanItemId === null &&
            item.state === 'active'
              ? { ...item, state: 'completed' as const }
              : item,
          );
          const origin = frame.originAgendaItemId
            ? (markedItems.find((item) => item.id === frame.originAgendaItemId) ?? null)
            : null;
          const next =
            origin &&
            origin.launch.status === 'launchable' &&
            origin.state !== 'deferred' &&
            origin.state !== 'cancelled'
              ? origin
              : (readyItems(markedItems).find((item) => item.id !== current.currentAgendaItemId) ??
                null);
          nextAgenda = repos.sessionAgendas.update(
            {
              ...currentAgenda,
              version: currentAgenda.version + 1,
              items: markedItems,
              currentItemId: next?.id ?? null,
              updatedAt: at,
            },
            currentAgenda.version,
            agendaEvent('detour_returned', {
              frameId: frame.id,
              originAgendaItemId: frame.originAgendaItemId,
              restoredAgendaItemId: next?.id ?? null,
            }),
          );
          affectedAgendaItemId = next?.id ?? null;
          nextSession = {
            ...current,
            routeState: current.routeStack.length > 1 ? 'detour_active' : 'on_route',
            routeStack: current.routeStack.slice(0, -1),
            currentAgendaItemId: next?.id ?? null,
          };
        } else {
          if (!target)
            throw new AppError(ApiErrorCode.ValidationError, 'The target Agenda item is unknown.');
          if (parsed.kind === 'direct_checkpoint') {
            const checkpoint =
              target.kind === 'formal_checkpoint' ||
              target.kind === 'synthesis' ||
              target.kind === 'due_review' ||
              target.kind === 'targeted_repair';
            if (!checkpoint || target.launch.status !== 'launchable') {
              throw new AppError(
                ApiErrorCode.ValidationError,
                'A direct checkpoint requires a launchable formal Agenda item.',
              );
            }
          }
          if (parsed.kind === 'defer') {
            const deferredItems = currentAgenda.items.map((item) =>
              item.id === target.id ? { ...item, state: 'deferred' as const } : item,
            );
            const next = readyItems(deferredItems).find((item) => item.id !== target.id) ?? null;
            nextAgenda = repos.sessionAgendas.update(
              {
                ...currentAgenda,
                version: currentAgenda.version + 1,
                items: deferredItems,
                currentItemId: next?.id ?? null,
                updatedAt: at,
              },
              currentAgenda.version,
              agendaEvent('agenda_item_deferred', {
                agendaItemId: target.id,
                planItemId: target.linkedPlanItemId,
                reason: parsed.reason,
              }),
            );
            if (target.linkedPlanItemId) {
              const progress = repos.studyPlans
                .listProgress(current.studyPlanVersionId)
                .find((item) => item.planItemId === target.linkedPlanItemId);
              if (progress && progress.state !== 'deferred') {
                repos.studyPlans.updateProgress(
                  current.studyPlanVersionId,
                  target.linkedPlanItemId,
                  progress.version,
                  'deferred',
                  newId('plan_progress_event'),
                  parsed.reason,
                  at,
                );
              }
            }
            const contract = repos.learningContracts.get(current.contractVersionId);
            const plan = repos.studyPlans.get(current.studyPlanVersionId);
            const planItem = plan?.items.find((item) => item.id === target.linkedPlanItemId);
            if (!contract) {
              throw new AppError(
                ApiErrorCode.VersionConflict,
                'The active Learning Contract is unavailable.',
              );
            }
            repos.coverageRisks.create(
              {
                id: newId('coverage_risk'),
                workspaceId,
                contractVersionId: current.contractVersionId,
                stableScopeFingerprint: fingerprint(contract.courseScope),
                materialId: null,
                topicId: target.learningUnitId,
                objectiveId: planItem?.objectiveIds[0] ?? null,
                facets: ['intentionally_deferred'],
                scopeAuthorityStatus: 'in_scope',
                truthPremiseStatus: 'not_applicable',
                truthAuthorityRecordIds: [],
                referencedCurriculumNodeIds: target.learningUnitId ? [target.learningUnitId] : [],
                referencedConceptIds: [],
                referencedEvidenceIds: [],
                origin: 'learner',
                status: 'deferred',
                severity: 'medium',
                priority: 50,
                contractSensitive: true,
                claim: `Deferred Agenda work: ${target.reason}`,
                uncertainty:
                  'This accepted-route work remains incomplete until restored or superseded.',
                observations: [],
                resolutionEvidenceIds: [],
                learnerDecisionId: parsed.commandId,
                provider: null,
                providerModel: null,
                promptVersion: null,
                firstObservedAt: at,
                updatedAt: at,
              },
              {
                id: newId('coverage_risk_event'),
                eventType: 'learner_deferred',
                actor: 'learner',
                payload: {
                  agendaItemId: target.id,
                  planItemId: target.linkedPlanItemId,
                },
                createdAt: at,
              },
            );
            affectedAgendaItemId = next?.id ?? null;
            nextSession = {
              ...current,
              routeState: current.routeStack.length ? 'return_pending' : 'on_route',
              currentAgendaItemId: next?.id ?? null,
            };
          } else {
            const detour = parsed.kind === 'detour' || parsed.kind === 'deep_dive';
            const detourItem: SessionAgendaItem | null = detour
              ? {
                  id: newId('agenda_item'),
                  index: Math.max(-1, ...currentAgenda.items.map((item) => item.index)) + 1,
                  kind: parsed.kind === 'deep_dive' ? 'stretch_challenge' : 'learner_detour',
                  origin: 'learner_detour',
                  reason: parsed.reason,
                  estimatedMinutes: parsed.requestedMinutes ?? 10,
                  linkedPlanItemId: null,
                  learningUnitId: commandLearningUnitId,
                  priority: 'medium',
                  state: 'active',
                  launch: {
                    status: 'launchable',
                    capability: 'conversation',
                    resourceId: null,
                    reason: null,
                  },
                  displacedAgendaItemIds: [],
                  timeImpactMinutes: parsed.requestedMinutes ?? 10,
                }
              : null;
            const items = detourItem ? [...currentAgenda.items, detourItem] : currentAgenda.items;
            if (detourItem) {
              nextAgenda = repos.sessionAgendas.update(
                {
                  ...currentAgenda,
                  version: currentAgenda.version + 1,
                  items,
                  currentItemId: detourItem.id,
                  updatedAt: at,
                },
                currentAgenda.version,
                agendaEvent('detour_started', {
                  itemId: detourItem.id,
                  originAgendaItemId: current.currentAgendaItemId,
                  reason: parsed.reason,
                  targetLearningUnitId: commandLearningUnitId,
                }),
              );
              affectedAgendaItemId = detourItem.id;
            } else if (parsed.kind === 'direct_checkpoint') {
              nextAgenda = repos.sessionAgendas.update(
                {
                  ...currentAgenda,
                  version: currentAgenda.version + 1,
                  items: currentAgenda.items.map((item) =>
                    item.id === target.id ? { ...item, state: 'active' as const } : item,
                  ),
                  currentItemId: target.id,
                  updatedAt: at,
                },
                currentAgenda.version,
                agendaEvent('direct_checkpoint_selected', { agendaItemId: target.id }),
              );
            }
            nextSession = {
              ...current,
              routeState: detour ? 'detour_active' : 'on_route',
              routeStack: detour
                ? [...current.routeStack, routeFrame(current, parsed.reason)]
                : current.routeStack,
              currentAgendaItemId: detourItem?.id ?? target.id,
            };
          }
        }

        nextSession = repos.studySessions.update(
          { ...nextSession, version: current.version + 1, updatedAt: at },
          current.version,
        );
        const response = MixedInitiativeCommandResponseSchema.parse({
          session: nextSession,
          agenda: nextAgenda,
          effect: {
            kind: parsed.kind,
            affectedAgendaItemId,
            planChangeRequest,
          },
        });
        const finalized = repos.operations.finalize(
          { operationId: claim.id, status: 'completed', payload: response, createdAt: at },
          owner,
          claim.fencingToken,
        );
        if (!finalized) throw new Error('StudySession command lost its operation lease.');
        return response;
      });
      return payload;
    } catch (error) {
      if (ownsOperation(repos, claim.id, owner, claim.fencingToken, clock.now().toISOString())) {
        repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'failed',
            payload: {
              message:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : 'StudySession command failed.',
            },
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
      }
      throw error;
    }
  }

  function transition(
    workspaceId: string,
    sessionId: string,
    input: unknown,
    kind: 'pause' | 'resume' | 'stop',
  ) {
    const parsed = SessionExecutionCommandRequestSchema.parse(input);
    const session = requireSession(repos, workspaceId, sessionId);
    const operationIdentity = `study-lifecycle:${session.id}:${parsed.commandId}`;
    const now = clock.now();
    let created: ReturnType<Repositories['operations']['createOrGet']>;
    try {
      created = repos.operations.createOrGet({
        id: newId('op'),
        workspaceId,
        commandId: operationIdentity,
        idempotencyKey: operationIdentity,
        logicalOperationId: operationIdentity,
        operationType: `study_session_${kind}`,
        expectedFingerprint: fingerprint({ sessionId, kind, ...parsed }),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'StudySession lifecycle identity was reused.',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    const previous = repos.operations.getResult(created.operation.id);
    if (previous?.status === 'completed')
      return SessionExecutionCommandResponseSchema.parse(previous.payload);
    if (previous)
      throw operationFailure(
        'The prior StudySession lifecycle command did not complete.',
        created.operation.id,
      );
    const owner = newId('worker');
    const claim = repos.operations.claim(
      created.operation.id,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
    );
    if (!claim)
      throw operationFailure(
        'This StudySession lifecycle command is already in progress.',
        created.operation.id,
      );
    try {
      const payload = repos.transaction(() => {
        const current = requireSession(repos, workspaceId, sessionId);
        requireCurrentRoute(repos, current, kind === 'resume' || kind === 'stop');
        if (
          (kind === 'resume' && current.status !== 'paused') ||
          (kind !== 'resume' && current.status !== 'active' && current.status !== 'paused') ||
          current.version !== parsed.expectedSessionVersion
        ) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'StudySession lifecycle command became stale.',
          );
        }
        const currentState = repos.courseExecution.get(workspaceId);
        const currentAgenda = repos.sessionAgendas.get(current.sessionAgendaId);
        if (!currentAgenda)
          throw new AppError(ApiErrorCode.VersionConflict, 'StudySession Agenda is unavailable.');
        const at = clock.now().toISOString();
        const nextState =
          kind === 'stop' && currentState.executionStatus === 'active'
            ? currentState
            : repos.courseExecution.transitionExecution({
                workspaceId,
                expectedVersion: currentState.version,
                expectedAcceptedPlanId: current.studyPlanVersionId,
                expectedAgendaId: current.sessionAgendaId,
                // Stopping a paused Session reopens the accepted Course route;
                // Stop ends the Session, not the learner's accepted Plan.
                transition: kind === 'stop' ? 'resume' : kind,
                eventId: newId('course_execution_event'),
                reason: kind === 'stop' ? 'StudySession stopped; accepted route retained.' : null,
                actor: 'learner',
                at,
              });
        let nextAgenda = currentAgenda;
        if (kind !== 'stop' || currentAgenda.status === 'paused') {
          nextAgenda = repos.sessionAgendas.update(
            {
              ...currentAgenda,
              version: currentAgenda.version + 1,
              status: kind === 'pause' ? 'paused' : 'active',
              updatedAt: at,
            },
            currentAgenda.version,
            {
              id: newId('agenda_event'),
              eventType: `execution_${kind}`,
              actor: 'learner',
              payload: { acceptedPlanRetained: true },
              createdAt: at,
            },
          );
        } else {
          repos.sessionAgendas.appendEvent(currentAgenda.id, {
            id: newId('agenda_event'),
            eventType: 'study_session_stopped',
            actor: 'learner',
            payload: { acceptedPlanRetained: true },
            createdAt: at,
          });
        }
        const nextSession = repos.studySessions.update(
          {
            ...current,
            status: kind === 'pause' ? 'paused' : kind === 'resume' ? 'active' : 'abandoned',
            routeState:
              kind === 'pause'
                ? 'execution_paused'
                : kind === 'stop'
                  ? 'on_route'
                  : current.routeStack.length
                    ? 'detour_active'
                    : 'on_route',
            routeStack:
              kind === 'stop'
                ? current.routeStack.map((frame) => ({ ...frame, state: 'abandoned' as const }))
                : current.routeStack,
            currentAgendaItemId: kind === 'stop' ? null : current.currentAgendaItemId,
            version: current.version + 1,
            updatedAt: at,
          },
          current.version,
        );
        const response = SessionExecutionCommandResponseSchema.parse({
          session: nextSession,
          agenda: nextAgenda,
          courseExecutionVersion: nextState.version,
        });
        const finalized = repos.operations.finalize(
          { operationId: claim.id, status: 'completed', payload: response, createdAt: at },
          owner,
          claim.fencingToken,
        );
        if (!finalized) throw new Error('StudySession lifecycle command lost its operation lease.');
        return response;
      });
      return payload;
    } catch (error) {
      if (ownsOperation(repos, claim.id, owner, claim.fencingToken, clock.now().toISOString())) {
        repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'failed',
            payload: {
              message:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : 'StudySession lifecycle command failed.',
            },
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
      }
      throw error;
    }
  }

  return {
    list,
    detail,
    start,
    submitTurn,
    command,
    pause: (w: string, s: string, i: unknown) => transition(w, s, i, 'pause'),
    resume: (w: string, s: string, i: unknown) => transition(w, s, i, 'resume'),
    stop: (w: string, s: string, i: unknown) => transition(w, s, i, 'stop'),
  };
}

export type StudySessionService = ReturnType<typeof createStudySessionService>;
