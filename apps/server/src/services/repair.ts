import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  MASTERY_RED_TEAM_MAX_OVERLAP,
  REPAIR_DIFFERENTIATION_POLICY_VERSION,
  RepairEpisodeSchema,
  RepairPacketSchema,
  RepairPracticeEventSchema,
  RepairStatusTransitionSchema,
  isRepairTransitionAllowed,
  selectRepairDifferentiation,
  type GradeRecord,
  type MasteryChallengeFamily,
  type RepairDiagnosticCategory,
  type RepairDifferentiationRequirement,
  type RepairEpisode,
  type RepairInterventionMode,
  type RepairStatus,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { lexicalChallengeOverlap } from './masteryRedTeamPolicy.js';

export const MAX_REPAIR_VERIFICATION_FAILURES = 3;
const GENERATOR_VERSION = 'diagnostic-repair-v1';
const PROMPT_VERSION = 'repair-prompt-v3';
const POLICY_VERSION = 'minimum-sufficient-intervention-v1';

/** Bounded history window: the current mistake's own remediation rounds only. */
const MAX_PRIOR_REMEDIATION_ROUNDS = 4;

function fallbackDiagnosis(grade: GradeRecord): {
  category: RepairDiagnosticCategory;
  affectedCriterionIds: string[];
  summary: string;
} {
  const affected = grade.judgment.criterionResults
    .filter((result) => result.result !== 'met')
    .map((result) => result.criterionId);
  const partial = grade.judgment.criterionResults.some((result) => result.result === 'partial');
  const noneMet = grade.judgment.criterionResults.every((result) => result.result === 'not_met');
  return {
    category: noneMet
      ? 'IRRELEVANT_OR_GUESSING'
      : partial || affected.length < grade.judgment.criterionResults.length
        ? 'INCOMPLETE_EXPRESSION'
        : 'UNCERTAIN',
    affectedCriterionIds: affected,
    summary: partial
      ? 'The response shows part of the idea but needs a more complete explanation.'
      : noneMet
        ? 'The response did not yet demonstrate the required idea.'
        : 'The available grading evidence is not specific enough for a stronger diagnosis.',
  };
}

export function diagnosisFromGrade(grade: GradeRecord) {
  if (grade.judgment.score >= 1) return null;
  const diagnostic = grade.judgment.diagnostic;
  if (!diagnostic) return fallbackDiagnosis(grade);
  if (diagnostic.category === 'SURFACE_SLIP') {
    return {
      ...fallbackDiagnosis(grade),
      category: 'UNCERTAIN' as const,
      summary:
        'The response did not fully satisfy the rubric, so the apparent surface slip cannot be assumed harmless.',
    };
  }
  const known = new Set(grade.judgment.criterionResults.map((result) => result.criterionId));
  const affected = diagnostic.affectedCriterionIds.filter((id) => known.has(id));
  return {
    category: diagnostic.uncertainty >= 0.75 ? ('UNCERTAIN' as const) : diagnostic.category,
    affectedCriterionIds: affected,
    summary: diagnostic.summary,
  };
}

export interface RepairDifferentiationContext {
  priorInterventionModes: RepairInterventionMode[];
  priorCheckIntents: MasteryChallengeFamily[];
  priorCheckPrompts: string[];
}

/**
 * Bounded, deterministic projection of what this learner has already been shown
 * for THIS mistake. Not a stored history: it is recomputed on demand from
 * durable state that already exists — accepted Repair packets plus the
 * assessment item intents of the same target — so no history table is added.
 * Another target's context never enters.
 */
export function repairDifferentiationContext(input: {
  repos: Repositories;
  episode: RepairEpisode;
}): RepairDifferentiationContext {
  const { repos, episode } = input;
  // Strictly earlier rounds only. Including the current round's own packet
  // would make each repeated call ladder past its own output and defeat the
  // per-round idempotency the generation key provides.
  const packets = repos.repair
    .listPackets(episode.id)
    .filter((packet) => packet.attemptOrdinal < episode.attemptCount)
    .slice(-MAX_PRIOR_REMEDIATION_ROUNDS);

  // Check intents already requested for this same target through the formal
  // lane. Scoped by target learning unit, so a sibling objective cannot
  // contaminate this decision.
  const intentsForTarget: MasteryChallengeFamily[] = [];
  const intents = repos.formalAssessments.listItemIntentsForWorkspace(episode.workspaceId);
  const versionCache = new Map<string, ReturnType<typeof repos.formalAssessments.getVersion>>();
  for (const intent of intents) {
    if (!intent.requestedChallengeFamily) continue;
    if (!versionCache.has(intent.assessmentVersionId)) {
      versionCache.set(
        intent.assessmentVersionId,
        repos.formalAssessments.getVersion(intent.assessmentVersionId),
      );
    }
    const item = versionCache
      .get(intent.assessmentVersionId)
      ?.items.find((candidate) => candidate.id === intent.itemId);
    if (item?.targetLearningUnitId !== episode.targetLearningUnitId) continue;
    intentsForTarget.push(intent.requestedChallengeFamily);
  }

  return {
    priorInterventionModes: packets.map((packet) => packet.interventionMode),
    priorCheckIntents: [
      ...packets.flatMap((packet) => (packet.checkIntent ? [packet.checkIntent] : [])),
      ...intentsForTarget.slice(-MAX_PRIOR_REMEDIATION_ROUNDS),
    ],
    priorCheckPrompts: packets.map((packet) => packet.practicePrompt),
  };
}

export interface RepairDifferentiationFinding {
  diagnostics: string[];
  diagnosticCodes: string[];
}

/**
 * Deterministic differentiation gate. A model claim of being different is not
 * evidence; this is the only authority on whether the new remediation differs.
 *
 * Exact-overlap comparison is a lexical novelty fence, not proof of semantic
 * non-equivalence — a genuine paraphrase defeats it by construction.
 */
export function validateRepairDifferentiation(input: {
  requirement: RepairDifferentiationRequirement;
  history: RepairDifferentiationContext;
  candidate: { interventionMode?: unknown; checkIntent?: unknown; practicePrompt?: unknown };
  failedPrompt: string;
}): RepairDifferentiationFinding {
  const { requirement, history, candidate } = input;
  const diagnostics: string[] = [];
  const diagnosticCodes: string[] = [];

  if (candidate.interventionMode !== requirement.requiredInterventionMode) {
    diagnostics.push(
      `interventionMode mismatch: returned ${String(candidate.interventionMode)}, required ${requirement.requiredInterventionMode}.`,
    );
    diagnosticCodes.push('repair_intervention_mode_mismatch');
  } else if (
    !requirement.interventionLadderExhausted &&
    history.priorInterventionModes.includes(requirement.requiredInterventionMode)
  ) {
    // Defensive: selection must never require an already-used mode while an
    // unused one remains.
    diagnostics.push(
      `interventionMode ${requirement.requiredInterventionMode} was already used for this mistake and an alternative exists.`,
    );
    diagnosticCodes.push('repair_explanation_strategy_repeated');
  }

  if (candidate.checkIntent !== requirement.requiredCheckIntent) {
    diagnostics.push(
      `checkIntent mismatch: returned ${String(candidate.checkIntent)}, required ${requirement.requiredCheckIntent}.`,
    );
    diagnosticCodes.push('repair_check_intent_mismatch');
  } else if (
    !requirement.checkIntentLadderExhausted &&
    history.priorCheckIntents.includes(requirement.requiredCheckIntent)
  ) {
    diagnostics.push(
      `checkIntent ${requirement.requiredCheckIntent} was already used for this mistake and an alternative exists.`,
    );
    diagnosticCodes.push('repair_check_intent_repeated');
  }

  // Structural fence. Always applied: a typed relabel of the same concrete
  // check is still the same check.
  const prompt = typeof candidate.practicePrompt === 'string' ? candidate.practicePrompt : '';
  if (prompt) {
    const against = [...history.priorCheckPrompts, input.failedPrompt];
    const worst = against.reduce(
      (max, prior) => Math.max(max, lexicalChallengeOverlap(prompt, prior)),
      0,
    );
    if (worst >= MASTERY_RED_TEAM_MAX_OVERLAP) {
      diagnostics.push(
        `practicePrompt repeats an earlier check for this mistake (lexical overlap ${worst.toFixed(2)} >= ${MASTERY_RED_TEAM_MAX_OVERLAP}). Ask the learner to demonstrate the same idea a different way.`,
      );
      diagnosticCodes.push('repair_check_prompt_repeated');
    }
  }

  return { diagnostics, diagnosticCodes };
}

export function createRepairService({
  repos,
  provider,
  clock,
}: {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}) {
  const get = (id: string): RepairEpisode => {
    const episode = repos.repair.getEpisode(id);
    if (!episode) throw notFound(`Repair episode does not exist: ${id}`);
    return episode;
  };

  const transition = (episode: RepairEpisode, to: RepairStatus, reason: string): RepairEpisode => {
    if (episode.status === to) return episode;
    if (!isRepairTransitionAllowed(episode.status, to)) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        `Repair cannot move from ${episode.status} to ${to}.`,
      );
    }
    const now = clock.now().toISOString();
    return repos.transaction(() => {
      repos.repair.insertTransition(
        RepairStatusTransitionSchema.parse({
          id: newId('repair_transition'),
          episodeId: episode.id,
          from: episode.status,
          to,
          reason,
          createdAt: now,
        }),
      );
      return repos.repair.updateEpisode({ ...episode, status: to, updatedAt: now });
    });
  };

  return {
    get,
    inspect(id: string) {
      return {
        episode: get(id),
        packets: repos.repair.listPackets(id),
        practice: repos.repair.listPractice(id),
        transitions: repos.repair.listTransitions(id),
      };
    },
    createForGrade(gradeRecordId: string): RepairEpisode | null {
      const existing = repos.repair.findByTriggerGrade(gradeRecordId);
      if (existing) return existing;
      const grade = repos.formalAssessments.getGrade(gradeRecordId);
      if (!grade || grade.status !== 'current')
        throw notFound(`Current formal grade does not exist: ${gradeRecordId}`);
      const attempt = repos.formalAssessments.getAttempt(grade.attemptId);
      const version = repos.formalAssessments.getVersion(grade.assessmentVersionId);
      if (!attempt || attempt.status !== 'submitted' || !version) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Repair requires a submitted formal assessment attempt.',
        );
      }
      const diagnosis = diagnosisFromGrade(grade);
      if (!diagnosis) return null;
      const affected = new Set(diagnosis.affectedCriterionIds);
      const item =
        version.items.find((candidate) =>
          candidate.rubric?.some((criterion) => affected.has(criterion.id)),
        ) ?? version.items[0];
      if (!item?.formalEligible) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Repair requires a formally eligible triggering item.',
        );
      }
      const now = clock.now().toISOString();
      return repos.transaction(() => {
        const episode = repos.repair.insertEpisode(
          RepairEpisodeSchema.parse({
            id: newId('repair'),
            workspaceId: attempt.workspaceId,
            triggerGradeRecordId: grade.id,
            triggerAttemptId: attempt.id,
            assessmentVersionId: version.id,
            itemId: item.id,
            targetLearningUnitId: item.targetLearningUnitId,
            diagnosticCategory: diagnosis.category,
            affectedCriterionIds: diagnosis.affectedCriterionIds,
            gapSummary: diagnosis.summary,
            status: 'OPEN',
            attemptCount: 0,
            verificationAttemptId: null,
            resolvedEvidenceId: null,
            createdAt: now,
            updatedAt: now,
          }),
        );
        repos.repair.insertTransition(
          RepairStatusTransitionSchema.parse({
            id: newId('repair_transition'),
            episodeId: episode.id,
            from: null,
            to: 'OPEN',
            reason: 'Created from a current failed or partial formal grade.',
            createdAt: now,
          }),
        );
        return episode;
      });
    },
    async generatePacket(id: string, opts?: ProviderCallOptions) {
      let episode = get(id);
      if (['RESOLVED', 'CANCELLED'].includes(episode.status)) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'A terminal Repair episode cannot generate content.',
        );
      }
      const version = repos.formalAssessments.getVersion(episode.assessmentVersionId);
      const item = version?.items.find((candidate) => candidate.id === episode.itemId);
      if (!item)
        throw new AppError(
          ApiErrorCode.ValidationError,
          'The triggering assessment item is unavailable.',
        );
      for (const binding of item.sourceBindings) {
        if (
          repos.materialRevisions.getActive(binding.materialId)?.id !== binding.materialRevisionId
        ) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Repair source revision is stale; generation was not persisted.',
          );
        }
      }
      // Differentiation context is derived before the generation key, because
      // the key must change when the required strategy/intent changes —
      // otherwise a repeat round would return the previous packet verbatim.
      const history = repairDifferentiationContext({ repos, episode });
      const requirement = selectRepairDifferentiation({
        category: episode.diagnosticCategory,
        priorInterventionModes: history.priorInterventionModes,
        priorCheckIntents: history.priorCheckIntents,
      });
      // Pinned before any status transition reassigns `episode`, so the
      // generation key and the stored packet can never disagree on the round.
      const attemptOrdinal = episode.attemptCount;
      const generationKey = createHash('sha256')
        .update(
          JSON.stringify({
            episodeId: episode.id,
            attemptCount: attemptOrdinal,
            generator: GENERATOR_VERSION,
            prompt: PROMPT_VERSION,
            policy: POLICY_VERSION,
            differentiationPolicy: REPAIR_DIFFERENTIATION_POLICY_VERSION,
            requiredInterventionMode: requirement.requiredInterventionMode,
            requiredCheckIntent: requirement.requiredCheckIntent,
            source: item.sourceBindings,
          }),
        )
        .digest('hex');
      const prior = repos.repair
        .listPackets(id)
        .find((packet) => packet.generationKey === generationKey);
      if (prior) return prior;
      const criterionById = new Map(
        item.rubric?.map((criterion) => [criterion.id, criterion.text]) ?? [],
      );
      const expectedMode = requirement.requiredInterventionMode;
      const payload = await provider.generateRepair(
        {
          targetLearningUnitId: episode.targetLearningUnitId,
          diagnosticCategory: episode.diagnosticCategory,
          requiredInterventionMode: expectedMode,
          requiredCheckIntent: requirement.requiredCheckIntent,
          gapSummary: episode.gapSummary,
          affectedCriteria: episode.affectedCriterionIds.map(
            (criterionId) => criterionById.get(criterionId) ?? 'the required idea',
          ),
          sourceContext: item.sourceBindings.map((binding) => ({
            blockId: binding.sourceBlockId,
            quote: binding.quote,
          })),
          failedPrompt: item.prompt,
          priorInterventionModes: [...history.priorInterventionModes],
          priorCheckIntents: [...history.priorCheckIntents],
          priorCheckPrompts: [...history.priorCheckPrompts],
        },
        {
          ...opts,
          telemetry: {
            workspaceId: episode.workspaceId,
            operationType: 'generate_repair_packet',
            operationId: episode.id,
            learningUnitId: episode.targetLearningUnitId,
            assessmentId: episode.assessmentVersionId,
            schemaFingerprint: 'repair-generation-v1',
            policyFingerprint: POLICY_VERSION,
            sourceFingerprint: generationKey,
          },
          validateCandidate: (candidate) => {
            const value = candidate as {
              diagnosticCategory?: unknown;
              interventionMode?: unknown;
              checkIntent?: unknown;
              practicePrompt?: unknown;
            };
            const diagnostics: string[] = [];
            const diagnosticCodes: string[] = [];
            if (value.diagnosticCategory !== episode.diagnosticCategory) {
              diagnostics.push(
                `diagnosticCategory mismatch: returned ${String(value.diagnosticCategory)}, required ${episode.diagnosticCategory}.`,
              );
              diagnosticCodes.push('repair_diagnostic_category_mismatch');
            }
            const differentiation = validateRepairDifferentiation({
              requirement,
              history,
              candidate: value,
              failedPrompt: item.prompt,
            });
            diagnostics.push(...differentiation.diagnostics);
            diagnosticCodes.push(...differentiation.diagnosticCodes);
            return {
              valid: diagnostics.length === 0,
              diagnostics,
              diagnosticCodes,
            };
          },
        },
      );
      episode =
        episode.status === 'OPEN' || episode.status === 'DEFERRED'
          ? transition(episode, 'ACTIVE', 'A validated Repair packet is ready.')
          : episode;
      return repos.repair.insertPacket(
        RepairPacketSchema.parse({
          id: newId('repair_packet'),
          episodeId: episode.id,
          generationKey,
          provider: provider.name,
          providerModel: provider.model ?? null,
          interventionMode: payload.interventionMode,
          checkIntent: payload.checkIntent,
          attemptOrdinal,
          explanation: payload.explanation,
          practicePrompt: payload.practicePrompt,
          hints: payload.hints,
          sourceBlockIds: item.sourceBindings.map((binding) => binding.sourceBlockId),
          targetLearningUnitId: episode.targetLearningUnitId,
          createdAt: clock.now().toISOString(),
        }),
      );
    },
    recordPractice(
      id: string,
      responseSummary: string,
      outcome: 'CONTINUE' | 'READY_FOR_VERIFICATION' | 'NEEDS_MORE_SUPPORT',
    ) {
      let episode = get(id);
      if (episode.status === 'OPEN' || episode.status === 'DEFERRED') {
        episode = transition(episode, 'ACTIVE', 'Repair practice resumed.');
      }
      if (episode.status !== 'ACTIVE')
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Practice requires an active Repair episode.',
        );
      return repos.repair.insertPractice(
        RepairPracticeEventSchema.parse({
          id: newId('repair_practice'),
          episodeId: id,
          ordinal: repos.repair.nextPracticeOrdinal(id),
          responseSummary,
          outcome,
          createdAt: clock.now().toISOString(),
        }),
      );
    },
    defer(id: string) {
      return transition(get(id), 'DEFERRED', 'Deferred by the learner.');
    },
    cancel(id: string) {
      return transition(get(id), 'CANCELLED', 'Cancelled by the learner.');
    },
    resume(id: string) {
      return transition(get(id), 'ACTIVE', 'Resumed by the learner.');
    },
    markAwaitingVerification(id: string) {
      return transition(
        get(id),
        'AWAITING_VERIFICATION',
        'Repair is ready for a fresh formal verification.',
      );
    },
    linkVerificationAttempt(id: string, attemptId: string) {
      const episode = get(id);
      if (episode.status !== 'AWAITING_VERIFICATION')
        throw new AppError(ApiErrorCode.ValidationError, 'Repair is not awaiting verification.');
      const attempt = repos.formalAssessments.getAttempt(attemptId);
      const version = attempt
        ? repos.formalAssessments.getVersion(attempt.assessmentVersionId)
        : undefined;
      if (
        !attempt ||
        !version ||
        attempt.workspaceId !== episode.workspaceId ||
        version.id === episode.assessmentVersionId ||
        !version.items.some(
          (item) =>
            item.formalEligible && item.targetLearningUnitId === episode.targetLearningUnitId,
        )
      ) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Verification must be a fresh formal assessment for the same target.',
        );
      }
      return repos.repair.updateEpisode({
        ...episode,
        verificationAttemptId: attempt.id,
        updatedAt: clock.now().toISOString(),
      });
    },
    resolveFromEvidence(id: string, evidenceId: string) {
      const episode = get(id);
      const evidence = repos.formalAssessments.getEvidence(evidenceId);
      if (
        episode.status !== 'AWAITING_VERIFICATION' ||
        !episode.verificationAttemptId ||
        !evidence ||
        evidence.attemptId !== episode.verificationAttemptId ||
        evidence.targetLearningUnitId !== episode.targetLearningUnitId ||
        evidence.conclusion !== 'supported' ||
        evidence.attemptId === episode.triggerAttemptId
      ) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Only supported evidence from the linked fresh verification can resolve Repair.',
        );
      }
      const now = clock.now().toISOString();
      return repos.transaction(() => {
        repos.repair.insertTransition(
          RepairStatusTransitionSchema.parse({
            id: newId('repair_transition'),
            episodeId: id,
            from: episode.status,
            to: 'RESOLVED',
            reason: 'Fresh formal verification produced supported evidence.',
            createdAt: now,
          }),
        );
        return repos.repair.updateEpisode({
          ...episode,
          status: 'RESOLVED',
          resolvedEvidenceId: evidence.id,
          updatedAt: now,
        });
      });
    },
    recordVerificationFailure(id: string) {
      const episode = get(id);
      if (episode.status !== 'AWAITING_VERIFICATION')
        throw new AppError(ApiErrorCode.ValidationError, 'Repair is not awaiting verification.');
      const count = episode.attemptCount + 1;
      if (count >= MAX_REPAIR_VERIFICATION_FAILURES) {
        const updated = repos.repair.updateEpisode({
          ...episode,
          attemptCount: count,
          updatedAt: clock.now().toISOString(),
        });
        return transition(
          updated,
          'DEFERRED',
          'Verification failure limit reached; deeper support is required.',
        );
      }
      const updated = repos.repair.updateEpisode({
        ...episode,
        attemptCount: count,
        updatedAt: clock.now().toISOString(),
      });
      return transition(
        updated,
        'ACTIVE',
        'Fresh verification did not yet support the target; Repair continues.',
      );
    },
  };
}

export type RepairService = ReturnType<typeof createRepairService>;
