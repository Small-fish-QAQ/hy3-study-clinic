import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  RepairEpisodeSchema,
  RepairPacketSchema,
  RepairPracticeEventSchema,
  RepairStatusTransitionSchema,
  isRepairTransitionAllowed,
  repairInterventionFor,
  type GradeRecord,
  type RepairDiagnosticCategory,
  type RepairEpisode,
  type RepairStatus,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export const MAX_REPAIR_VERIFICATION_FAILURES = 3;
const GENERATOR_VERSION = 'diagnostic-repair-v1';
const PROMPT_VERSION = 'repair-prompt-v2';
const POLICY_VERSION = 'minimum-sufficient-intervention-v1';

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
      const generationKey = createHash('sha256')
        .update(
          JSON.stringify({
            episodeId: episode.id,
            attemptCount: episode.attemptCount,
            generator: GENERATOR_VERSION,
            prompt: PROMPT_VERSION,
            policy: POLICY_VERSION,
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
      const expectedMode = repairInterventionFor(episode.diagnosticCategory);
      const payload = await provider.generateRepair(
        {
          targetLearningUnitId: episode.targetLearningUnitId,
          diagnosticCategory: episode.diagnosticCategory,
          requiredInterventionMode: expectedMode,
          gapSummary: episode.gapSummary,
          affectedCriteria: episode.affectedCriterionIds.map(
            (criterionId) => criterionById.get(criterionId) ?? 'the required idea',
          ),
          sourceContext: item.sourceBindings.map((binding) => ({
            blockId: binding.sourceBlockId,
            quote: binding.quote,
          })),
          failedPrompt: item.prompt,
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
            const value = candidate as { diagnosticCategory?: unknown; interventionMode?: unknown };
            const diagnostics: string[] = [];
            const diagnosticCodes: string[] = [];
            if (value.diagnosticCategory !== episode.diagnosticCategory) {
              diagnostics.push(
                `diagnosticCategory mismatch: returned ${String(value.diagnosticCategory)}, required ${episode.diagnosticCategory}.`,
              );
              diagnosticCodes.push('repair_diagnostic_category_mismatch');
            }
            if (value.interventionMode !== expectedMode) {
              diagnostics.push(
                `interventionMode mismatch: returned ${String(value.interventionMode)}, required ${expectedMode} for ${episode.diagnosticCategory}.`,
              );
              diagnosticCodes.push('repair_intervention_mode_mismatch');
            }
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
        verificationAttemptId: null,
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
