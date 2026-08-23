import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  TeachingBriefPreparationRequestSchema,
  TeachingBriefPreparationResponseSchema,
  TeachingBriefSchema,
  type SourceBlockRevision,
  type CurriculumObjective,
  type TeachingBrief,
  type TeachingBriefPreparationResponse,
  type TeachingBriefProposalPayload,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { ProviderError } from '../llm/errors.js';
import type {
  LlmProvider,
  ProviderCallOptions,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import { searchRetrievalUnits, visualDerivationToRetrievalUnit } from '../retrieval/lexical.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import { validateTeachingBriefCandidate } from './teachingBriefContract.js';
import { buildTeachingBriefSourceContext } from './teachingBriefContext.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';
import { evaluateLessonPedagogy, evaluatePracticeQuality } from './lessonPedagogyEvaluator.js';
import { visualManifestMatchesCurrentDerivations } from './advisoryVisuals.js';

export const TEACHING_BRIEF_PROMPT_VERSION = 'teaching-brief-v2-pedagogy-practice-authority-v2';
const PREPARATION_LEASE_MS = 10 * 60 * 1000;

interface TeachingBriefPreparationDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  providerModel?: string | null;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createTeachingBriefPreparationService({
  repos,
  provider,
  clock,
  providerModel = null,
}: TeachingBriefPreparationDeps) {
  function routeContext(input: {
    workspaceId: string;
    curriculumVersionId: string;
    studyPlanVersionId: string;
    learningUnitId: string;
    expectedExecutionSourceManifestFingerprint: string;
  }) {
    const workspace = repos.workspaces.get(input.workspaceId);
    if (!workspace) throw notFound('Course workspace not found.');
    const state = repos.courseExecution.get(input.workspaceId);
    const curriculum = repos.curricula.get(input.curriculumVersionId);
    const plan = repos.studyPlans.get(input.studyPlanVersionId);
    if (
      !curriculum ||
      !plan ||
      curriculum.workspaceId !== input.workspaceId ||
      plan.workspaceId !== input.workspaceId ||
      curriculum.status !== 'accepted' ||
      plan.status !== 'accepted' ||
      plan.curriculumVersionId !== curriculum.id ||
      state.activeCurriculumId !== curriculum.id ||
      state.acceptedPlanId !== plan.id ||
      state.routeValidationStatus !== 'valid'
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation requires the current accepted Course route.',
      );
    }
    if (
      curriculum.executionSourceManifest.fingerprint !==
        input.expectedExecutionSourceManifestFingerprint ||
      plan.executionSourceManifestFingerprint !== input.expectedExecutionSourceManifestFingerprint
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Teaching Brief source route is stale.');
    }
    if (!visualManifestMatchesCurrentDerivations(repos, curriculum.executionSourceManifest)) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief visual source route is stale.',
      );
    }
    const node = curriculum.nodes.find((candidate) => candidate.id === input.learningUnitId);
    const planItem = plan.items.find(
      (item) =>
        item.curriculumLearningUnitId === input.learningUnitId && item.kind === 'teach_unit',
    );
    if (!node?.learningUnit || !planItem) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'LearningUnit is not executable teaching work in the accepted StudyPlan.',
      );
    }
    return { workspace, state, curriculum, plan, node, planItem };
  }

  function sourceContext(input: ReturnType<typeof routeContext>) {
    const materials = repos.materials.listByWorkspace(input.workspace.id);
    const blocks = repos.materials
      .getBlocksByWorkspace(input.workspace.id)
      .map((block): SourceBlockRevision => {
        if (!block.materialRevisionId) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Teaching Brief source block has no immutable revision owner.',
          );
        }
        return {
          ...block,
          materialRevisionId: block.materialRevisionId,
          structuralUnitId: null,
          revisionFingerprint: curriculumSourceBlockFingerprint(block, block.materialRevisionId),
        };
      });
    const relevantMaterialIds = new Set([
      ...input.node.sourceReferences.map((reference) => reference.materialId),
      ...input.node.learningUnit!.conceptIds.flatMap((conceptId) => {
        const concept = repos.materials.getConcept(conceptId);
        return concept ? [concept.materialId] : [];
      }),
    ]);
    const manifestRevisionByMaterial = new Map(
      input.curriculum.executionSourceManifest.revisions.map((revision) => [
        revision.materialId,
        revision.materialRevisionId,
      ]),
    );
    const visualCandidates = materials.flatMap((material) => {
      const revisionId = manifestRevisionByMaterial.get(material.id);
      if (!revisionId) return [];
      return repos.materialRevisions.getAssets(revisionId).flatMap((asset) => {
        const derivation = repos.visualDerivations
          .listForAsset(asset.id)
          .filter(
            (candidate) =>
              candidate.materialRevisionId === revisionId &&
              candidate.assetByteHash === asset.byteHash &&
              candidate.validationStatus === 'accepted' &&
              candidate.authority === 'derived' &&
              candidate.evidenceAdmissibility === 'advisory_nonblocking',
          )
          .at(-1);
        return derivation ? [{ asset, derivation }] : [];
      });
    });
    const scopedVisuals =
      relevantMaterialIds.size === 0
        ? visualCandidates
        : visualCandidates.filter(({ asset }) => relevantMaterialIds.has(asset.materialId));
    const visualQuery = [
      input.node.title,
      ...input.node.learningUnit!.objectives.flatMap((objective) => [
        objective.title,
        objective.description,
      ]),
      ...input.node.learningUnit!.conceptIds.flatMap((conceptId) => {
        const concept = repos.materials.getConcept(conceptId);
        return concept ? [concept.name, concept.summary] : [];
      }),
    ].join(' ');
    const visualByRetrievalId = new Map(
      scopedVisuals.map((candidate) => [
        `${candidate.derivation.id}\u0000${candidate.asset.id}`,
        candidate,
      ]),
    );
    const rankedVisuals = searchRetrievalUnits(
      [],
      scopedVisuals.map(({ derivation }) => visualDerivationToRetrievalUnit(derivation)),
      visualQuery,
      { limit: 8 },
    ).flatMap((result) => {
      if (result.kind !== 'visual_derivation') return [];
      const candidate = visualByRetrievalId.get(
        `${result.derivationId}\u0000${result.assetOccurrenceId}`,
      );
      return candidate ? [candidate] : [];
    });
    const visuals = rankedVisuals.length > 0 ? rankedVisuals : scopedVisuals.slice(0, 8);
    const built = buildTeachingBriefSourceContext({
      workspaceId: input.workspace.id,
      curriculum: input.curriculum,
      learningUnitId: input.node.id,
      materials,
      blocks,
      concepts: repos.materials.getConceptsByWorkspace(input.workspace.id),
      visuals,
    });
    return {
      ...built,
      fingerprint: `lesson_context_${fingerprint({
        sourceContextFingerprint: built.fingerprint,
        promptVersion: TEACHING_BRIEF_PROMPT_VERSION,
      }).slice(0, 40)}`,
    };
  }

  function providerInput(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
  ): TeachingBriefGenerationInput {
    const teachingConstruct = (objective: CurriculumObjective) => {
      if (objective.formalAssessmentConstruct) return objective.formalAssessmentConstruct;
      return /(?:\b(?:explain|why|how|reason|mechanism)\b|解释|为什么|如何|原因|机制)/iu.test(
        `${objective.title} ${objective.description}`,
      )
        ? ('explain' as const)
        : ('identify' as const);
    };
    const concepts = route.node.learningUnit!.conceptIds.flatMap((conceptId) => {
      const concept = repos.materials.getConcept(conceptId);
      return concept ? [{ name: concept.name, summary: concept.summary }] : [];
    });
    const canonicalConcepts = route.node.learningUnit!.canonicalConceptIds.flatMap(
      (canonicalId) => {
        const canonical = repos.alignment.getCanonical(canonicalId);
        return canonical ? [{ name: canonical.displayName }] : [];
      },
    );
    const prerequisites = route.node.learningUnit!.prerequisiteUnitIds.flatMap(
      (learningUnitId, index) => {
        const prerequisite = route.curriculum.nodes.find(
          (candidate) => candidate.id === learningUnitId,
        );
        return prerequisite?.learningUnit
          ? [
              {
                prerequisiteRef: `P${index + 1}`,
                title: prerequisite.title,
                objectiveSummaries: prerequisite.learningUnit.objectives.map(
                  (objective) => objective.title,
                ),
              },
            ]
          : [];
      },
    );
    const nextPlanItem = route.plan.items
      .filter((item) => item.index > route.planItem.index && item.curriculumLearningUnitId)
      .sort((left, right) => left.index - right.index)[0];
    const nextNode = nextPlanItem?.curriculumLearningUnitId
      ? route.curriculum.nodes.find(
          (candidate) => candidate.id === nextPlanItem.curriculumLearningUnitId,
        )
      : undefined;
    return {
      workspaceName: route.workspace.name,
      learningUnit: {
        title: route.node.title,
        objectives: route.node.learningUnit!.objectives.map((objective, index) => ({
          objectiveRef: `O${index + 1}`,
          title: objective.title,
          description: objective.description,
          priority: objective.priority ?? 'normal',
          construct: teachingConstruct(objective),
          authorityEnvelopeTier: objective.authorityEnvelopeTier ?? 'unavailable',
          practiceAuthority:
            objective.formalAssessmentConstruct &&
            (objective.formalEvidenceSourceBlockIds?.length ?? 0) > 0
              ? 'exact_formal'
              : route.node.sourceReferences.some((reference) => reference.sourceBlockId !== null)
                ? 'exact_teaching'
                : context.visualOffers.length > 0
                  ? 'advisory_visual'
                  : 'unavailable',
        })),
        concepts,
        canonicalConcepts,
      },
      prerequisites,
      nextConnection: nextNode ? { title: nextNode.title } : null,
      sourceContext: {
        blockCount: context.blockCount,
        offerCount: context.offerCount,
        serializedBytes: context.serializedBytes,
        materialCount: context.materialCount,
        sectionCount: context.sectionCount,
        offers: context.offers.map((offer) => {
          const reference = context.references.find(
            (candidate) => candidate.refId === offer.sourceRef,
          );
          return {
            ...offer,
            authorizedObjectiveRefs: route.node.learningUnit!.objectives.flatMap(
              (objective, index) => {
                if (!reference) return [];
                const formallyAuthorized = objective.formalEvidenceSourceBlockIds?.includes(
                  reference.sourceBlockId,
                );
                const teachingAuthorized = route.node.sourceReferences.some(
                  (candidate) => candidate.sourceBlockId === reference.sourceBlockId,
                );
                const hasExactFormalAuthority =
                  Boolean(objective.formalAssessmentConstruct) &&
                  (objective.formalEvidenceSourceBlockIds?.length ?? 0) > 0;
                return (hasExactFormalAuthority ? formallyAuthorized : teachingAuthorized)
                  ? [`O${index + 1}`]
                  : [];
              },
            ),
          };
        }),
      },
      visualContext: {
        offerCount: context.visualOfferCount,
        serializedBytes: context.visualSerializedBytes,
        offers: context.visualOffers,
      },
      limits: {
        maxSegments: 12,
        maxSourceRefsPerSegment: 8,
        maxFormalOpportunities: 8,
      },
      plannedMinutes: route.planItem.estimatedMinutes,
    };
  }

  function materialize(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
    input: TeachingBriefGenerationInput,
    payload: TeachingBriefProposalPayload,
    boundedRepairAttempted: boolean,
  ): TeachingBrief {
    const objectiveIdByRef = new Map(
      route.node.learningUnit!.objectives.map((objective, index) => [
        `O${index + 1}`,
        objective.id,
      ]),
    );
    const prerequisiteByRef = new Map(
      input.prerequisites.map((prerequisite, index) => [
        prerequisite.prerequisiteRef,
        route.curriculum.nodes.find(
          (candidate) => candidate.id === route.node.learningUnit!.prerequisiteUnitIds[index],
        )!,
      ]),
    );
    const briefId = newId('teaching_brief');
    const segments = payload.segments.map((segment, index) => ({
      index,
      purpose: segment.purpose,
      objectiveIds: segment.objectiveRefs.map((ref) => objectiveIdByRef.get(ref)!),
      explanation: segment.explanation,
      explanationAuthority: segment.explanationAuthority,
      sourceRefIds: segment.sourceRefs,
      ...(segment.example
        ? {
            example: {
              text: segment.example.text,
              authority: segment.example.authority,
              sourceRefIds: segment.example.sourceRefs,
            },
          }
        : {}),
      ...(segment.contrast
        ? {
            contrast: {
              text: segment.contrast.text,
              authority: segment.contrast.authority,
              sourceRefIds: segment.contrast.sourceRefs,
            },
          }
        : {}),
      ...(segment.misconception
        ? {
            misconception: {
              authority: 'pedagogical_risk_candidate' as const,
              hypothesis: segment.misconception.hypothesis,
              correction: segment.misconception.correction,
              sourceRefIds: segment.misconception.sourceRefs,
            },
          }
        : {}),
      ...(segment.informalCheck ? { informalCheck: segment.informalCheck } : {}),
    }));
    const prerequisites = payload.prerequisites.map((prerequisite) => {
      const node = prerequisiteByRef.get(prerequisite.prerequisiteRef)!;
      return {
        learningUnitId: node.id,
        title: node.title,
        reason: prerequisite.reason,
        readinessHint: prerequisite.readinessHint,
      };
    });
    const objectiveIds = route.node.learningUnit!.objectives.map((objective) => objective.id);
    const qualityProfile = profileTeachingBrief({
      objectiveIds,
      segments,
      sourceReferences: context.references,
      prerequisiteCount: prerequisites.length,
      formalOpportunityCount: payload.formalOpportunities.length,
      summary: payload.summary,
      nextConnection: payload.nextConnection,
    });
    const evaluatedAt = clock.now().toISOString();
    const pedagogyEvaluation = evaluateLessonPedagogy(payload, input, {
      evaluatedAt,
      boundedRepairAttempted,
    });
    const practiceEvaluation = evaluatePracticeQuality(payload, input, {
      evaluatedAt,
      boundedRepairAttempted,
    });
    if (pedagogyEvaluation.status !== 'pass' || practiceEvaluation.status !== 'pass') {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Teaching Brief candidate failed independent Lesson or Practice evaluation.',
      );
    }
    const objectiveByRef = new Map(
      route.node.learningUnit!.objectives.map((objective, index) => [`O${index + 1}`, objective]),
    );
    const practice = {
      schemaVersion: 1 as const,
      items: payload.practice.items.map((item, itemIndex) => {
        const objective = objectiveByRef.get(item.objectiveRef)!;
        const itemId = `${briefId}_practice_${itemIndex + 1}`;
        const surface = (
          value: (typeof item)['initial'] | (typeof item)['retry'],
          name: 'initial' | 'retry',
        ) => ({
          prompt: value.prompt,
          options: value.options.map((option) => ({
            id: `${itemId}_${name}_${option.optionRef}`,
            text: option.text,
            feedbackIfSelected: option.feedbackIfSelected,
          })),
          correctOptionId: `${itemId}_${name}_${value.correctOptionRef}`,
          hint: value.hint,
          explanation: value.explanation,
        });
        return {
          id: itemId,
          objectiveId: objective.id,
          objectiveTitle: objective.title,
          construct: item.construct,
          capabilityTested: item.capabilityTested,
          pedagogicalReason: item.pedagogicalReason,
          authority: item.authority,
          sourceRefIds: item.sourceRefs,
          visualRefIds: item.visualRefs,
          initial: surface(item.initial, 'initial'),
          retry: surface(item.retry, 'retry'),
        };
      }),
      qualityEvaluation: practiceEvaluation,
      credit: 'none' as const,
    };
    return TeachingBriefSchema.parse({
      id: briefId,
      workspaceId: route.workspace.id,
      curriculumVersionId: route.curriculum.id,
      studyPlanVersionId: route.plan.id,
      learningUnitId: route.node.id,
      executionSourceManifestFingerprint: route.curriculum.executionSourceManifest.fingerprint,
      sourceContextFingerprint: context.fingerprint,
      sourceManifest: route.curriculum.executionSourceManifest,
      conceptIds: route.node.learningUnit!.conceptIds,
      canonicalConceptIds: route.node.learningUnit!.canonicalConceptIds,
      objective: {
        title: route.node.title,
        whyNow: payload.whyNow,
        objectives: route.node.learningUnit!.objectives.map((objective) => ({
          id: objective.id,
          title: objective.title,
          description: objective.description,
          priority: objective.priority,
          formalAssessmentReady: objective.formalAssessmentReady,
          construct: objective.formalAssessmentConstruct,
          authorityEnvelopeTier: objective.authorityEnvelopeTier,
          formalEvidenceSourceBlockIds: objective.formalEvidenceSourceBlockIds,
        })),
      },
      prerequisites,
      segments,
      formalOpportunities: payload.formalOpportunities,
      summary: payload.summary,
      nextConnection: payload.nextConnection,
      sourceReferences: context.references,
      visualReferences: context.visualReferences,
      qualityProfile,
      pedagogyEvaluation,
      practice,
      provider: provider.name,
      providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
      promptVersion: TEACHING_BRIEF_PROMPT_VERSION,
      createdAt: clock.now().toISOString(),
    });
  }

  function staleReason(
    history: TeachingBrief[],
    route: ReturnType<typeof routeContext>,
    contextFingerprint: string,
  ): TeachingBriefPreparationResponse['staleReason'] {
    const previous = history.at(-1);
    if (!previous) return null;
    if (
      previous.curriculumVersionId !== route.curriculum.id ||
      previous.studyPlanVersionId !== route.plan.id
    ) {
      return 'route_changed';
    }
    if (
      previous.executionSourceManifestFingerprint !==
      route.curriculum.executionSourceManifest.fingerprint
    ) {
      return 'source_changed';
    }
    return previous.sourceContextFingerprint === contextFingerprint ? 'none' : 'context_changed';
  }

  async function prepare(
    rawInput: unknown,
    options?: ProviderCallOptions,
  ): Promise<TeachingBriefPreparationResponse> {
    const input = TeachingBriefPreparationRequestSchema.parse(rawInput);
    const operationKey = `teaching-brief:${input.learningUnitId}:${input.commandId}`;
    const startedAt = clock.now();
    const operation = repos.operations.createOrGet({
      id: newId('op'),
      workspaceId: input.workspaceId,
      commandId: operationKey,
      idempotencyKey: operationKey,
      logicalOperationId: operationKey,
      operationType: 'prepare_teaching_brief',
      expectedFingerprint: fingerprint(input),
      createdAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
    }).operation;
    const priorResult = repos.operations.getResult(operation.id);
    if (priorResult?.status === 'completed') {
      return TeachingBriefPreparationResponseSchema.parse(priorResult.payload);
    }
    if (priorResult) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'The prior Teaching Brief preparation did not complete successfully.',
      );
    }
    const owner = newId('worker');
    const claim = repos.operations.claim(
      operation.id,
      owner,
      new Date(startedAt.getTime() + PREPARATION_LEASE_MS).toISOString(),
      startedAt.toISOString(),
    );
    if (!claim) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation is in progress.',
      );
    }

    try {
      const route = routeContext(input);
      let context: ReturnType<typeof sourceContext>;
      try {
        context = sourceContext(route);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          ApiErrorCode.VersionConflict,
          error instanceof Error
            ? error.message
            : 'Teaching Brief source context is stale or unavailable.',
        );
      }
      const history = repos.teachingBriefs.listForUnit(input.workspaceId, input.learningUnitId);
      const reusableCandidate = repos.teachingBriefs.findReusable({
        workspaceId: input.workspaceId,
        curriculumVersionId: input.curriculumVersionId,
        studyPlanVersionId: input.studyPlanVersionId,
        learningUnitId: input.learningUnitId,
        manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
        sourceContextFingerprint: context.fingerprint,
      });
      const reuse =
        reusableCandidate?.promptVersion === TEACHING_BRIEF_PROMPT_VERSION &&
        reusableCandidate.pedagogyEvaluation?.status === 'pass' &&
        reusableCandidate.practice?.qualityEvaluation.status === 'pass'
          ? reusableCandidate
          : undefined;
      if (reuse) {
        const response = TeachingBriefPreparationResponseSchema.parse({
          status: 'reused',
          staleReason: 'none',
          brief: reuse,
        });
        const completed = repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'completed',
            payload: response,
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
        if (!completed)
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Teaching Brief reuse lost its operation lease.',
          );
        return response;
      }

      const generationInput = providerInput(route, context);
      const policyFingerprint = enforceAgentCostPolicies(repos, {
        workspaceId: input.workspaceId,
        operationType: 'prepare_teaching_brief',
        studySessionId: null,
        at: clock.now().toISOString(),
        confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
      });
      let semanticEvaluationCount = 0;
      const payload = await runTrackedAgentProviderOperation({
        repos,
        clock,
        provider,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        operationId: claim.id,
        fencingToken: claim.fencingToken,
        workspaceId: input.workspaceId,
        studySessionId: null,
        learningUnitId: input.learningUnitId,
        assessmentId: null,
        operationType: 'prepare_teaching_brief',
        schemaFingerprint: 'teaching-brief-proposal-v2-pedagogy-practice',
        policyFingerprint,
        sourceFingerprint: context.fingerprint,
        providerOptions: options,
        invoke: (providerOptions) =>
          provider.generateTeachingBrief(generationInput, {
            ...providerOptions,
            validateCandidate: (candidate) => {
              semanticEvaluationCount += 1;
              return validateTeachingBriefCandidate(candidate, generationInput);
            },
          }),
      });
      const brief = materialize(
        route,
        context,
        generationInput,
        payload,
        semanticEvaluationCount > 1,
      );
      return repos.transaction(() => {
        const currentRoute = routeContext(input);
        const currentContext = sourceContext(currentRoute);
        if (currentContext.fingerprint !== context.fingerprint) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Teaching Brief source context changed during generation.',
          );
        }
        const concurrentCandidate = repos.teachingBriefs.findReusable({
          workspaceId: input.workspaceId,
          curriculumVersionId: input.curriculumVersionId,
          studyPlanVersionId: input.studyPlanVersionId,
          learningUnitId: input.learningUnitId,
          manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
          sourceContextFingerprint: context.fingerprint,
        });
        const concurrent =
          concurrentCandidate?.promptVersion === TEACHING_BRIEF_PROMPT_VERSION &&
          concurrentCandidate.pedagogyEvaluation?.status === 'pass' &&
          concurrentCandidate.practice?.qualityEvaluation.status === 'pass'
            ? concurrentCandidate
            : undefined;
        const stored = concurrent ?? repos.teachingBriefs.create(brief);
        const response = TeachingBriefPreparationResponseSchema.parse({
          status: concurrent ? 'reused' : 'prepared',
          staleReason: concurrent ? 'none' : staleReason(history, route, context.fingerprint),
          brief: stored,
        });
        const completed = repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'completed',
            payload: response,
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
        if (!completed) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Teaching Brief result was fenced because its operation lease is stale.',
          );
        }
        return response;
      });
    } catch (error) {
      const candidateFailure =
        error instanceof ProviderError &&
        error.details &&
        typeof error.details === 'object' &&
        'candidateFailure' in error.details
          ? error.details.candidateFailure
          : undefined;
      const structuredFailure =
        error instanceof ProviderError &&
        error.details &&
        typeof error.details === 'object' &&
        'structuredFailure' in error.details
          ? error.details.structuredFailure
          : undefined;
      const current = repos.operations.get(claim.id);
      if (
        current?.status === 'running' &&
        current.leaseOwner === owner &&
        current.fencingToken === claim.fencingToken
      ) {
        repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'failed',
            payload: {
              message:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : 'Teaching Brief preparation failed.',
              ...(candidateFailure ? { candidateFailure } : {}),
              ...(structuredFailure ? { structuredFailure } : {}),
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
    prepare,
    getCurrent(input: {
      workspaceId: string;
      curriculumVersionId: string;
      studyPlanVersionId: string;
      learningUnitId: string;
      expectedExecutionSourceManifestFingerprint: string;
    }): TeachingBrief | null {
      const route = routeContext(input);
      const context = sourceContext(route);
      const candidate = repos.teachingBriefs.findReusable({
        workspaceId: input.workspaceId,
        curriculumVersionId: input.curriculumVersionId,
        studyPlanVersionId: input.studyPlanVersionId,
        learningUnitId: input.learningUnitId,
        manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
        sourceContextFingerprint: context.fingerprint,
      });
      return candidate?.promptVersion === TEACHING_BRIEF_PROMPT_VERSION &&
        candidate.pedagogyEvaluation?.status === 'pass' &&
        candidate.practice?.qualityEvaluation.status === 'pass'
        ? candidate
        : null;
    },
    history: (workspaceId: string, learningUnitId: string) =>
      repos.teachingBriefs.listForUnit(workspaceId, learningUnitId),
  };
}

export type TeachingBriefPreparationService = ReturnType<
  typeof createTeachingBriefPreparationService
>;
