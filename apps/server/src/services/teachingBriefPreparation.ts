import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  TeachingBriefPreparationRequestSchema,
  TeachingBriefPreparationResponseSchema,
  TeachingBriefSchema,
  type SourceBlockRevision,
  type TeachingBrief,
  type TeachingBriefPreparationResponse,
  type TeachingBriefProposalPayload,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import type {
  LlmProvider,
  ProviderCallOptions,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import { validateTeachingBriefCandidate } from './teachingBriefContract.js';
import { buildTeachingBriefSourceContext } from './teachingBriefContext.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';

export const TEACHING_BRIEF_PROMPT_VERSION = 'teaching-brief-v1';
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
    return buildTeachingBriefSourceContext({
      workspaceId: input.workspace.id,
      curriculum: input.curriculum,
      learningUnitId: input.node.id,
      materials,
      blocks,
      concepts: repos.materials.getConceptsByWorkspace(input.workspace.id),
    });
  }

  function providerInput(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
  ): TeachingBriefGenerationInput {
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
        offers: context.offers,
      },
      limits: {
        maxSegments: 12,
        maxSourceRefsPerSegment: 8,
        maxFormalOpportunities: 8,
      },
    };
  }

  function materialize(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
    input: TeachingBriefGenerationInput,
    payload: TeachingBriefProposalPayload,
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
    return TeachingBriefSchema.parse({
      id: newId('teaching_brief'),
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
        })),
      },
      prerequisites,
      segments,
      formalOpportunities: payload.formalOpportunities,
      summary: payload.summary,
      nextConnection: payload.nextConnection,
      sourceReferences: context.references,
      qualityProfile,
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
      const context = sourceContext(route);
      const history = repos.teachingBriefs.listForUnit(input.workspaceId, input.learningUnitId);
      const reuse = repos.teachingBriefs.findReusable({
        workspaceId: input.workspaceId,
        curriculumVersionId: input.curriculumVersionId,
        studyPlanVersionId: input.studyPlanVersionId,
        learningUnitId: input.learningUnitId,
        manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
        sourceContextFingerprint: context.fingerprint,
      });
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
        schemaFingerprint: 'teaching-brief-proposal-v1-local-refs',
        policyFingerprint,
        sourceFingerprint: context.fingerprint,
        providerOptions: options,
        invoke: (providerOptions) =>
          provider.generateTeachingBrief(generationInput, {
            ...providerOptions,
            validateCandidate: (candidate) =>
              validateTeachingBriefCandidate(candidate, generationInput),
          }),
      });
      const brief = materialize(route, context, generationInput, payload);
      return repos.transaction(() => {
        const currentRoute = routeContext(input);
        const currentContext = sourceContext(currentRoute);
        if (currentContext.fingerprint !== context.fingerprint) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Teaching Brief source context changed during generation.',
          );
        }
        const concurrent = repos.teachingBriefs.findReusable({
          workspaceId: input.workspaceId,
          curriculumVersionId: input.curriculumVersionId,
          studyPlanVersionId: input.studyPlanVersionId,
          learningUnitId: input.learningUnitId,
          manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
          sourceContextFingerprint: context.fingerprint,
        });
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
      return (
        repos.teachingBriefs.findReusable({
          workspaceId: input.workspaceId,
          curriculumVersionId: input.curriculumVersionId,
          studyPlanVersionId: input.studyPlanVersionId,
          learningUnitId: input.learningUnitId,
          manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
          sourceContextFingerprint: context.fingerprint,
        }) ?? null
      );
    },
    history: (workspaceId: string, learningUnitId: string) =>
      repos.teachingBriefs.listForUnit(workspaceId, learningUnitId),
  };
}

export type TeachingBriefPreparationService = ReturnType<
  typeof createTeachingBriefPreparationService
>;
