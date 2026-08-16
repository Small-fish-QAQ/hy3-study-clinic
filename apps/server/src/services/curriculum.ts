import {
  AcceptCurriculumRequestSchema,
  ApiErrorCode,
  CurriculumHierarchyViewSchema,
  CurriculumHistoryResponseSchema,
  CurriculumProposalResponseSchema,
  ExecutionSourceManifestSchema,
  ProposeCurriculumRequestSchema,
  RejectCurriculumRequestSchema,
  fnv1a32,
  type AcceptCurriculumRequest,
  type Curriculum,
  type CurriculumCoverageWarning,
  type CurriculumProposalPayload,
  type CurriculumHierarchyView,
  type CurriculumHistoryResponse,
  type CurriculumProposalResponse,
  type ExecutionSourceManifest,
  type LearningContract,
  type ProposeCurriculumRequest,
  type RejectCurriculumRequest,
  type StudyPlanPreflight,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import type {
  CurriculumContractContext,
  CurriculumOutlineItem,
  CurriculumProposalInput,
  LlmProvider,
  ProviderCallOptions,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import { createCoverageRiskAgentService } from './coverageRisksAgent.js';
import {
  assertValidMaterializedCurriculum,
  materializeCurriculumProposal,
  type CurriculumValidationContext,
  type MaterializedCurriculum,
} from './curriculumValidation.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';
import type { SourceAuthorityService } from './sourceAuthority.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import {
  buildCurriculumEvidenceCatalog,
  selectCurriculumEvidenceOffers,
} from './curriculumEvidence.js';
import { preflightStudyPlan } from './studyPlansAgent.js';
import { assessCurriculumRecovery } from './curriculumRecovery.js';
import { assertLearningContractScopeCurrent } from './learningContractScope.js';

/** HTTP/service request: the server, never the client, resolves exact revisions. */
export const ProposeCurriculumCommandRequestSchema = ProposeCurriculumRequestSchema.omit({
  executionSourceManifest: true,
}).strict();
export type ProposeCurriculumCommandRequest = Omit<
  ProposeCurriculumRequest,
  'executionSourceManifest'
>;

function curriculumLimits(
  outline: CurriculumOutlineItem[],
  predecessor: Curriculum | null,
): CurriculumProposalInput['limits'] {
  const sourceSectionCount = new Set(
    outline.map((item) => `${item.materialId}\u0000${item.headingPath.join('\u0001')}`),
  ).size;
  const semanticBaseline = Math.max(
    predecessor?.nodes.filter((node) => node.kind !== 'course').length ?? 0,
    sourceSectionCount * 2,
  );
  const maxNodes = Math.min(500, Math.max(64, semanticBaseline * 2));
  return {
    maxNodes,
    maxObjectives: maxNodes * 8,
    maxSynthesisGroups: Math.min(100, Math.max(16, sourceSectionCount * 2)),
  };
}

export const CURRICULUM_PROVIDER_TIMEOUT_MS = 240_000;
const PROVIDER_REPAIR_LEASE_MARGIN_MS = 120_000;
export const CURRICULUM_OPERATION_LEASE_MS =
  CURRICULUM_PROVIDER_TIMEOUT_MS * 2 + PROVIDER_REPAIR_LEASE_MARGIN_MS;

export function curriculumOperationLeaseMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppError(ApiErrorCode.ValidationError, 'Curriculum provider timeout is invalid.');
  }
  return timeoutMs * 2 + PROVIDER_REPAIR_LEASE_MARGIN_MS;
}

interface CurriculumServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  commands: CourseCommandService;
  providerModel?: string | null;
  sourceAuthority: Pick<SourceAuthorityService, 'ensureVerbatimAssessmentAuthority'>;
}

function manifestFingerprint(revisions: ExecutionSourceManifest['revisions']): string {
  return `manifest_${fnv1a32(JSON.stringify(revisions)).toString(16).padStart(8, '0')}`;
}

function requireContract(
  repos: Repositories,
  workspaceId: string,
  contractId: string,
  expectedVersion: number,
): LearningContract {
  const contract = repos.learningContracts.get(contractId);
  if (!contract || contract.workspaceId !== workspaceId) {
    throw notFound('Learning Contract not found.');
  }
  if (contract.version !== expectedVersion) {
    throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract version is stale.');
  }
  if (contract.status !== 'learner_confirmed' && contract.status !== 'active') {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'Curriculum proposal requires a learner-confirmed Learning Contract.',
    );
  }
  return contract;
}

/**
 * Resolve stable learner scope to the exact current extraction identity used
 * by one Curriculum proposal. Reprocessing changes this manifest, never the
 * Contract's stable Material identity.
 */
export function buildCurriculumExecutionContext(
  repos: Repositories,
  contract: LearningContract,
): {
  manifest: ExecutionSourceManifest;
  contractContext: CurriculumContractContext;
  outline: CurriculumOutlineItem[];
  blocks: ReturnType<Repositories['materials']['getBlocksByWorkspace']>;
  authorityBundles: SourceAuthorityBundle[];
} {
  assertLearningContractScopeCurrent(repos, contract);
  const materials = new Map(
    repos.materials
      .listByWorkspace(contract.workspaceId)
      .map((material) => [material.id, material]),
  );
  const revisions: ExecutionSourceManifest['revisions'] = [];
  const outline: CurriculumOutlineItem[] = [];
  const blocks = [] as ReturnType<Repositories['materials']['getBlocksByWorkspace']>;
  const authorityBundles: SourceAuthorityBundle[] = [];
  const authorityIds = new Set<string>();
  const contextMaterials: CurriculumContractContext['materials'] = [];

  for (const scoped of contract.courseScope.materials) {
    const material = materials.get(scoped.materialId);
    if (!material) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        `Scoped Material not found: ${scoped.materialId}`,
      );
    }
    contextMaterials.push({ ...scoped, title: material.title });
    if (scoped.disposition === 'excluded') continue;
    if (material.availability !== 'active') {
      throw new AppError(
        ApiErrorCode.ValidationError,
        `Scoped Material is retired: ${material.id}`,
      );
    }
    const revision = repos.materialRevisions.getActive(material.id);
    if (!revision || revision.status !== 'active' || material.activeRevisionId !== revision.id) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        `Scoped Material has no current active revision: ${material.id}`,
      );
    }
    const materialBlocks = repos.materials.getBlocks(material.id);
    if (
      materialBlocks.length === 0 ||
      materialBlocks.some((block) => block.materialRevisionId !== revision.id)
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        `Scoped Material SourceBlocks do not match its active revision: ${material.id}`,
      );
    }
    revisions.push({
      materialId: material.id,
      materialRevisionId: revision.id,
      parserVersion: revision.parserVersion,
      parserFingerprint: revision.parserFingerprint,
      sourceBlockRevisionIds: materialBlocks.map((block) => block.id),
    });
    for (const block of materialBlocks) {
      blocks.push(block);
      outline.push({
        structuralUnitId: null,
        materialId: material.id,
        materialRevisionId: revision.id,
        parentStructuralUnitId: null,
        kind: block.heading ? 'section' : 'paragraph',
        index: block.index,
        title: block.heading,
        headingPath: block.headingPath,
        sourceBlockIds: [block.id],
      });
      for (const bundle of repos.sourceAuthority.findEligibleByBlock(
        contract.workspaceId,
        revision.id,
        block.id,
      )) {
        if (authorityIds.has(bundle.record.id)) continue;
        authorityIds.add(bundle.record.id);
        authorityBundles.push(bundle);
      }
    }
  }

  if (revisions.length === 0) {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'Curriculum proposal requires at least one included active Material.',
    );
  }
  const manifest = ExecutionSourceManifestSchema.parse({
    fingerprint: manifestFingerprint(revisions),
    revisions,
  });
  return {
    manifest,
    outline,
    blocks,
    authorityBundles,
    contractContext: {
      contractVersionId: contract.id,
      intent: contract.intent,
      targetOutcome: {
        description: contract.targetOutcome.description,
        targetScore: contract.targetOutcome.targetScore,
      },
      desiredDepth: contract.desiredDepth,
      subjectBoundaries: contract.courseScope.subjectBoundaries,
      materials: contextMaterials,
      includedTopics: contract.courseScope.includedTopics,
      excludedTopics: contract.courseScope.excludedTopics,
    },
  };
}

function manifestsEqual(left: ExecutionSourceManifest, right: ExecutionSourceManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function requiresStudyPlanExecutionRepair(
  repos: Repositories,
  clock: Clock,
  contract: LearningContract,
  predecessor: Curriculum | null,
  workspaceName: string,
): boolean {
  const visited = new Set<string>();
  let ancestor = predecessor;
  while (ancestor && !visited.has(ancestor.id)) {
    if (ancestor.status === 'accepted') {
      return !preflightStudyPlan(repos, clock, contract, ancestor, workspaceName).canGenerate;
    }
    visited.add(ancestor.id);
    ancestor = ancestor.predecessorId
      ? (repos.curricula.get(ancestor.predecessorId) ?? null)
      : null;
  }
  return false;
}

function executionRepairErrors(preflight: StudyPlanPreflight): string[] {
  if (preflight.canGenerate) return [];
  const blockerCodes = preflight.blockers.map((blocker) => blocker.code).join(', ');
  return [
    `StudyPlan execution repair: ${preflight.executableLearningUnitCount} of ${preflight.totalLearningUnitCount} LearningUnits have a supported launch capability; blockers: ${blockerCodes}. Current launch implementations require an exact current source Concept binding or another supported capability.`,
  ];
}

function validateExecutionRepairCandidate(input: {
  repos: Repositories;
  clock: Clock;
  contract: LearningContract;
  executionRepairRequired: boolean;
  workspaceName: string;
  manifest: ExecutionSourceManifest;
  materialized: MaterializedCurriculum;
}): MaterializedCurriculum {
  if (!input.executionRepairRequired || !input.materialized.validation.valid) {
    return input.materialized;
  }
  const candidate: Curriculum = {
    id: 'curriculum_execution_repair_candidate',
    workspaceId: input.contract.workspaceId,
    contractVersionId: input.contract.id,
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: input.manifest,
    nodes: input.materialized.nodes,
    synthesisGroups: input.materialized.synthesisGroups,
    validation: input.materialized.validation,
    provider: 'candidate',
    providerModel: null,
    createdAt: input.clock.now().toISOString(),
    acceptedAt: null,
  };
  const preflight = preflightStudyPlan(
    input.repos,
    input.clock,
    input.contract,
    candidate,
    input.workspaceName,
  );
  const errors = executionRepairErrors(preflight);
  if (errors.length === 0) return input.materialized;
  return {
    ...input.materialized,
    validation: {
      ...input.materialized.validation,
      valid: false,
      errors: [...input.materialized.validation.errors, ...errors].slice(0, 100),
    },
  };
}

function buildOfferedCurriculumKnowledge(
  repos: Repositories,
  workspaceId: string,
  context: ReturnType<typeof buildCurriculumExecutionContext>,
) {
  const workspace = repos.workspaces.get(workspaceId);
  if (!workspace) throw notFound('Course not found.');
  const concepts = repos.materials
    .getConceptsByWorkspace(workspaceId)
    .filter((concept) => context.blocks.some((block) => block.id === concept.grounding.blockId));
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const graphEdges = workspace.activeGraphVersionId
    ? repos.graph
        .getEdges(workspace.activeGraphVersionId)
        .filter(
          (edge) => conceptIds.has(edge.sourceConceptId) && conceptIds.has(edge.targetConceptId),
        )
    : [];
  const canonicalConcepts = repos.alignment
    .listCanonical(workspaceId)
    .filter((canonical) =>
      canonical.members.some((member) => conceptIds.has(member.sourceConceptId)),
    )
    .map((canonical) => ({
      id: canonical.id,
      displayName: canonical.displayName,
      sourceConceptIds: canonical.members
        .map((member) => member.sourceConceptId)
        .filter((conceptId) => conceptIds.has(conceptId)),
    }));
  const allowedCanonicalConceptIds = canonicalConcepts.map((canonical) => canonical.id);
  const fingerprint = `curriculum_context_${fnv1a32(
    JSON.stringify({
      workspaceName: workspace.name,
      concepts,
      graphEdges,
      canonicalConcepts,
      authorityBundles: context.authorityBundles.map((bundle) => ({
        record: bundle.record,
        claims: bundle.claims,
      })),
    }),
  )
    .toString(16)
    .padStart(8, '0')}`;
  return {
    workspace,
    concepts,
    graphEdges,
    canonicalConcepts,
    allowedCanonicalConceptIds,
    fingerprint,
  };
}

function assertProposalAuthorityCurrent(
  repos: Repositories,
  request: ProposeCurriculumCommandRequest,
  contract: LearningContract,
  manifest: ExecutionSourceManifest,
  offeredKnowledgeFingerprint: string,
): void {
  const currentContract = repos.learningContracts.get(contract.id);
  if (
    !currentContract ||
    currentContract.workspaceId !== request.command.workspaceId ||
    currentContract.version !== request.expectedContractVersion ||
    (currentContract.status !== 'learner_confirmed' && currentContract.status !== 'active')
  ) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'Learning Contract changed while the Curriculum proposal was running.',
    );
  }
  const currentContext = buildCurriculumExecutionContext(repos, currentContract);
  if (!manifestsEqual(currentContext.manifest, manifest)) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'Course Material revisions changed while the Curriculum proposal was running.',
    );
  }
  if (
    buildOfferedCurriculumKnowledge(repos, request.command.workspaceId, currentContext)
      .fingerprint !== offeredKnowledgeFingerprint
  ) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'Course Concept or graph context changed while the Curriculum proposal was running.',
    );
  }
  if (
    repos.courseExecution.get(request.command.workspaceId).activeCurriculumId !==
    request.expectedActiveCurriculumId
  ) {
    throw new AppError(ApiErrorCode.VersionConflict, 'Active Curriculum pointer is stale.');
  }
  const latest = repos.curricula.list(request.command.workspaceId).at(-1);
  if ((latest?.id ?? null) !== request.predecessorCurriculumId) {
    throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum predecessor is stale.');
  }
}

const UNMAPPED_BLOCK_WARNING_PREFIX =
  'Unmapped source blocks remain visible for risk reconciliation:';
const UNMAPPED_STRUCTURE_WARNING_PREFIX = 'Unmapped structural units remain visible:';

function warningCount(warning: string, prefix: string): number | null {
  if (!warning.startsWith(prefix) || !warning.endsWith('.')) return null;
  const count = Number(warning.slice(prefix.length, -1).trim());
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function curriculumCoverageWarning(warning: string): CurriculumCoverageWarning {
  const unmappedBlockCount = warningCount(warning, UNMAPPED_BLOCK_WARNING_PREFIX);
  if (unmappedBlockCount !== null) {
    return {
      code: 'unmapped_source_blocks',
      count: unmappedBlockCount,
      technicalDetail: warning,
    };
  }
  const unmappedStructuralUnitCount = warningCount(warning, UNMAPPED_STRUCTURE_WARNING_PREFIX);
  if (unmappedStructuralUnitCount !== null) {
    return {
      code: 'unmapped_structural_units',
      count: unmappedStructuralUnitCount,
      technicalDetail: warning,
    };
  }
  return { code: 'other_coverage_warning', count: null, technicalDetail: warning };
}

export function curriculumHierarchy(curriculum: Curriculum): CurriculumHierarchyView {
  const children = new Map<string | null, Curriculum['nodes']>();
  const byId = new Map(curriculum.nodes.map((node) => [node.id, node]));
  for (const node of curriculum.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  children.forEach((siblings) =>
    siblings.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id)),
  );
  const depthOf = (node: Curriculum['nodes'][number]): number => {
    let depth = 0;
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      depth += 1;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return depth;
  };
  const breadcrumbs = (node: Curriculum['nodes'][number]): string[] => {
    const titles = [node.title];
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent) {
      titles.unshift(parent.title);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return titles;
  };
  return CurriculumHierarchyViewSchema.parse({
    curriculumId: curriculum.id,
    curriculumVersion: curriculum.version,
    status: curriculum.status,
    rootNodeIds: (children.get(null) ?? []).map((node) => node.id),
    nodes: curriculum.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      childIds: (children.get(node.id) ?? []).map((child) => child.id),
      kind: node.kind,
      index: node.index,
      depth: depthOf(node),
      title: node.title,
      breadcrumbTitles: breadcrumbs(node),
      learningUnit: node.learningUnit,
      sourceReferences: node.sourceReferences,
      mappedPlanItemIds: [],
      progressState: null,
    })),
    synthesisGroups: curriculum.synthesisGroups,
    validation: curriculum.validation,
    coverageWarnings: curriculum.validation.warnings.map(curriculumCoverageWarning),
    executionSourceManifest: curriculum.executionSourceManifest,
  });
}

export function createCurriculumService({
  repos,
  provider,
  clock,
  commands,
  providerModel,
  sourceAuthority,
}: CurriculumServiceDeps) {
  const inferenceProvider = createTelemetryProvider({
    repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });
  const coverageRisks = createCoverageRiskAgentService({ repos, clock });
  function requireCurriculum(workspaceId: string, id: string): Curriculum {
    const curriculum = repos.curricula.get(id);
    if (!curriculum || curriculum.workspaceId !== workspaceId)
      throw notFound('Curriculum not found.');
    return curriculum;
  }

  function detail(workspaceId: string, curriculumId: string): CurriculumProposalResponse {
    const curriculum = requireCurriculum(workspaceId, curriculumId);
    return CurriculumProposalResponseSchema.parse({
      curriculum,
      hierarchy: curriculumHierarchy(curriculum),
      retainedAcceptedCurriculumId: repos.courseExecution.get(workspaceId).activeCurriculumId,
    });
  }

  function history(workspaceId: string): CurriculumHistoryResponse {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
    const items = repos.curricula.list(workspaceId);
    const state = repos.courseExecution.get(workspaceId);
    return CurriculumHistoryResponseSchema.parse({
      workspaceId,
      acceptedCurriculumId: state.activeCurriculumId,
      proposedCurriculumId:
        [...items].reverse().find((item) => item.status === 'proposed')?.id ?? null,
      items: items.map((item) => ({
        id: item.id,
        version: item.version,
        predecessorId: item.predecessorId,
        contractVersionId: item.contractVersionId,
        status: item.status,
        title: item.nodes.find((node) => node.kind === 'course')?.title ?? 'Course',
        learningUnitCount: item.nodes.filter((node) => node.kind === 'learning_unit').length,
        unmappedStructuralUnitCount: item.validation.unmappedStructuralUnitIds.length,
        validationValid: item.validation.valid,
        executionSourceManifestFingerprint: item.executionSourceManifest.fingerprint,
        createdAt: item.createdAt,
        acceptedAt: item.acceptedAt,
      })),
    });
  }

  async function propose(
    input: ProposeCurriculumCommandRequest,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalResponse> {
    const parsed = ProposeCurriculumCommandRequestSchema.parse(input);
    const workspace = repos.workspaces.get(parsed.command.workspaceId);
    if (!workspace) throw notFound('Course not found.');
    const contract = requireContract(
      repos,
      parsed.command.workspaceId,
      parsed.contractId,
      parsed.expectedContractVersion,
    );
    // Backfill Materials created before local-verbatim authority admission.
    // This local validator establishes exact source occurrence independently
    // of learner Contract, role, Curriculum, or Plan acceptance.
    for (const scope of contract.courseScope.materials) {
      if (scope.disposition !== 'included') continue;
      const revision = repos.materialRevisions.getActive(scope.materialId);
      if (!revision) continue;
      sourceAuthority.ensureVerbatimAssessmentAuthority(
        contract.workspaceId,
        scope.materialId,
        revision.id,
      );
    }
    const context = buildCurriculumExecutionContext(repos, contract);
    const providerTimeoutMs = opts?.timeoutMs ?? CURRICULUM_PROVIDER_TIMEOUT_MS;
    const claim = commands.begin(
      parsed.command,
      'propose_curriculum',
      {
        contractId: contract.id,
        contractVersion: contract.version,
        predecessorCurriculumId: parsed.predecessorCurriculumId,
        expectedActiveCurriculumId: parsed.expectedActiveCurriculumId,
        manifestFingerprint: context.manifest.fingerprint,
        confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
      },
      { leaseMs: curriculumOperationLeaseMs(providerTimeoutMs) },
    );
    if (claim.replayPayload !== undefined) {
      return CurriculumProposalResponseSchema.parse(claim.replayPayload);
    }
    const activeState = repos.courseExecution.get(parsed.command.workspaceId);
    if (activeState.activeCurriculumId !== parsed.expectedActiveCurriculumId) {
      commands.fail(claim, new Error('Active Curriculum pointer is stale.'));
      throw new AppError(ApiErrorCode.VersionConflict, 'Active Curriculum pointer is stale.');
    }
    const priorVersions = repos.curricula.list(parsed.command.workspaceId);
    const latest = priorVersions.at(-1);
    if (parsed.predecessorCurriculumId !== (latest?.id ?? null)) {
      commands.fail(claim, new Error('Curriculum predecessor is stale.'));
      throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum predecessor is stale.');
    }
    const offeredKnowledge = buildOfferedCurriculumKnowledge(
      repos,
      parsed.command.workspaceId,
      context,
    );
    const { concepts, graphEdges, canonicalConcepts, allowedCanonicalConceptIds } =
      offeredKnowledge;
    const structuralUnitOwners = new Map(
      context.outline.flatMap((item) =>
        item.structuralUnitId
          ? [
              [
                item.structuralUnitId,
                {
                  materialId: item.materialId,
                  materialRevisionId: item.materialRevisionId,
                },
              ] as const,
            ]
          : [],
      ),
    );
    const preferredGroundings = [
      ...concepts.map((concept) => concept.grounding),
      ...context.authorityBundles.flatMap((bundle) =>
        bundle.claims.map((claim) => ({
          blockId: claim.sourceBlockId,
          quote: claim.quote,
          startOffset: claim.startOffset,
          endOffset: claim.endOffset,
          occurrenceCount: claim.occurrenceCount,
          reanchored: false,
        })),
      ),
    ];
    const fullEvidenceCatalog = buildCurriculumEvidenceCatalog({
      workspaceId: parsed.command.workspaceId,
      manifest: context.manifest,
      blocks: context.blocks,
      preferredGroundings,
    });
    const predecessor = latest ?? null;
    const executionRepairRequired = requiresStudyPlanExecutionRepair(
      repos,
      clock,
      contract,
      predecessor,
      workspace.name,
    );
    if (executionRepairRequired) {
      const recovery = assessCurriculumRecovery(repos, contract, {
        remediationRequired: true,
        candidateLaunchable: false,
      });
      if (
        recovery.state === 'concept_grounding_missing' ||
        recovery.state === 'concept_grounding_stale'
      ) {
        const error = new AppError(
          ApiErrorCode.GroundingFailed,
          recovery.state === 'concept_grounding_stale'
            ? '当前概念依据已过期。请先重新提取并检查概念，再更新课程结构。'
            : '当前课程还没有可用的概念依据。请先提取并检查概念，再更新课程结构。',
          { kind: 'curriculum_recovery_prerequisite', ...recovery },
        );
        commands.fail(claim, error);
        throw error;
      }
    }
    const predecessorAuthorityIds = new Set(
      predecessor?.nodes.flatMap(
        (node) =>
          node.learningUnit?.objectives.flatMap((objective) => objective.truthAuthorityRecordIds) ??
          [],
      ) ?? [],
    );
    const priorityGroundings = [
      ...concepts.map((concept) => concept.grounding),
      ...context.authorityBundles
        .filter((bundle) => predecessorAuthorityIds.has(bundle.record.id))
        .flatMap((bundle) =>
          bundle.claims.map((claim) => ({
            blockId: claim.sourceBlockId,
            quote: claim.quote,
            startOffset: claim.startOffset,
            endOffset: claim.endOffset,
            occurrenceCount: claim.occurrenceCount,
            reanchored: false,
          })),
        ),
    ];
    const evidenceCatalog = selectCurriculumEvidenceOffers({
      catalog: fullEvidenceCatalog,
      blocks: context.blocks,
      predecessor,
      concepts,
      contract,
      priorityGroundings,
    });
    const providerInput: CurriculumProposalInput = {
      workspaceName: workspace.name,
      contract: context.contractContext,
      executionSourceManifest: context.manifest,
      outline: context.outline,
      concepts,
      graphEdges,
      allowedCanonicalConceptIds,
      canonicalConcepts,
      predecessor,
      blocks: context.blocks,
      evidenceCatalog,
      limits: curriculumLimits(context.outline, predecessor),
    };
    const validationContext: CurriculumValidationContext = {
      workspaceId: parsed.command.workspaceId,
      courseTitle: workspace.name,
      executionSourceManifest: context.manifest,
      blocks: context.blocks,
      concepts,
      graphEdges,
      structuralUnitOwners,
      canonicalConceptIds: new Set(allowedCanonicalConceptIds),
      canonicalConceptMembers: new Map(
        canonicalConcepts.map((canonical) => [
          canonical.id,
          [...canonical.sourceConceptIds].sort((left, right) => left.localeCompare(right)),
        ]),
      ),
      canonicalConceptIdsBySourceConcept: canonicalConcepts.reduce((memberships, canonical) => {
        for (const conceptId of canonical.sourceConceptIds) {
          const ids = memberships.get(conceptId) ?? [];
          ids.push(canonical.id);
          memberships.set(conceptId, ids);
        }
        return memberships;
      }, new Map<string, string[]>()),
      evidenceCatalog: providerInput.evidenceCatalog.map((offer) => ({
        ...offer,
        headingPath: [...offer.headingPath],
      })),
      limits: providerInput.limits,
      authorityBundles: context.authorityBundles,
      isAuthorityBlockingEligible: (id) => repos.sourceAuthority.isBlockingEligible(id),
    };
    let repairAttempted = false;
    let lastCandidateValidation: MaterializedCurriculum | null = null;
    try {
      const policyFingerprint = enforceAgentCostPolicies(repos, {
        workspaceId: parsed.command.workspaceId,
        operationType: 'propose_curriculum',
        studySessionId: null,
        at: clock.now().toISOString(),
        confirmedPolicyIds: parsed.confirmedCostPolicyIds ?? [],
      });
      const payload = await runTrackedAgentProviderOperation({
        repos,
        clock,
        provider,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        operationId: claim.operationId,
        fencingToken: claim.fencingToken,
        workspaceId: parsed.command.workspaceId,
        studySessionId: null,
        learningUnitId: null,
        assessmentId: null,
        operationType: 'propose_curriculum',
        schemaFingerprint: 'curriculum-proposal-v2-evidence-identity',
        policyFingerprint,
        sourceFingerprint: context.manifest.fingerprint,
        providerOptions: opts,
        invoke: (options) =>
          inferenceProvider.proposeCurriculum(providerInput, {
            ...options,
            timeoutMs: providerTimeoutMs,
            onRepairAttempt: (reason) => {
              repairAttempted = true;
              options?.onRepairAttempt?.(reason);
            },
            validateCandidate: (candidate) => {
              assertProposalAuthorityCurrent(
                repos,
                parsed,
                contract,
                context.manifest,
                offeredKnowledge.fingerprint,
              );
              lastCandidateValidation = validateExecutionRepairCandidate({
                repos,
                clock,
                contract,
                executionRepairRequired,
                workspaceName: workspace.name,
                manifest: context.manifest,
                materialized: materializeCurriculumProposal(
                  candidate as CurriculumProposalPayload,
                  validationContext,
                ),
              });
              return {
                valid: lastCandidateValidation.validation.valid,
                diagnostics: lastCandidateValidation.validation.errors,
              };
            },
          }),
      });
      const materialized = validateExecutionRepairCandidate({
        repos,
        clock,
        contract,
        executionRepairRequired,
        workspaceName: workspace.name,
        manifest: context.manifest,
        materialized: materializeCurriculumProposal(payload, validationContext),
      });
      assertValidMaterializedCurriculum(materialized, repairAttempted);
      const now = clock.now().toISOString();
      const curriculum: Curriculum = {
        id: newId('curriculum'),
        workspaceId: parsed.command.workspaceId,
        contractVersionId: contract.id,
        version: (latest?.version ?? 0) + 1,
        predecessorId: latest?.id ?? null,
        status: 'proposed',
        executionSourceManifest: context.manifest,
        nodes: materialized.nodes,
        synthesisGroups: materialized.synthesisGroups,
        validation: materialized.validation,
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        createdAt: now,
        acceptedAt: null,
      };
      return commands.complete(claim, () => {
        assertProposalAuthorityCurrent(
          repos,
          parsed,
          contract,
          context.manifest,
          offeredKnowledge.fingerprint,
        );
        repos.curricula.createManifest(
          newId('manifest'),
          curriculum.workspaceId,
          curriculum.executionSourceManifest,
          now,
        );
        const stored = repos.curricula.createVersion(curriculum, {
          id: newId('curriculum_evt'),
          eventType: 'proposed',
          actor: parsed.command.actor,
          payload: { contractId: contract.id, manifestFingerprint: context.manifest.fingerprint },
          createdAt: now,
        });
        coverageRisks.seedCurriculum(contract, stored);
        return CurriculumProposalResponseSchema.parse({
          curriculum: stored,
          hierarchy: curriculumHierarchy(stored),
          retainedAcceptedCurriculumId: activeState.activeCurriculumId,
        });
      });
    } catch (error) {
      let failure: unknown = error;
      if (error instanceof ProviderError && error.code === ApiErrorCode.ProviderTimeout) {
        failure = new AppError(
          ApiErrorCode.ProviderTimeout,
          '课程结构生成时间超过预期，本次没有修改现有课程结构。你可以稍后重试。',
          {
            kind: 'curriculum_timeout',
            timeoutMs: providerTimeoutMs,
            provider: provider.name,
            operationId: claim.operationId,
          },
        );
      }
      const failedCandidate = lastCandidateValidation as MaterializedCurriculum | null;
      if (
        failure === error &&
        error instanceof ProviderError &&
        error.code === ApiErrorCode.ProviderInvalidOutput &&
        typeof error.details === 'object' &&
        error.details !== null &&
        'validationKind' in error.details &&
        error.details.validationKind === 'candidate' &&
        failedCandidate &&
        !failedCandidate.validation.valid
      ) {
        try {
          assertValidMaterializedCurriculum(failedCandidate, repairAttempted);
        } catch (validationError) {
          failure = validationError;
        }
      }
      commands.fail(claim, failure);
      throw failure;
    }
  }

  function accept(input: AcceptCurriculumRequest): CurriculumProposalResponse {
    const parsed = AcceptCurriculumRequestSchema.parse(input);
    const current = requireCurriculum(parsed.command.workspaceId, parsed.curriculumId);
    if (
      current.version !== parsed.expectedVersion ||
      current.contractVersionId !== parsed.expectedContractId ||
      current.executionSourceManifest.fingerprint !==
        parsed.expectedExecutionSourceManifestFingerprint
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum acceptance identity is stale.');
    }
    const claim = commands.begin(parsed.command, 'accept_curriculum', {
      curriculumId: current.id,
      version: current.version,
      contractId: current.contractVersionId,
      manifestFingerprint: current.executionSourceManifest.fingerprint,
    });
    if (claim.replayPayload !== undefined) {
      return CurriculumProposalResponseSchema.parse(claim.replayPayload);
    }
    try {
      const contract = repos.learningContracts.get(current.contractVersionId);
      if (
        !contract ||
        contract.workspaceId !== current.workspaceId ||
        (contract.status !== 'learner_confirmed' && contract.status !== 'active')
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Curriculum Contract is no longer eligible.',
        );
      }
      const context = buildCurriculumExecutionContext(repos, contract);
      if (!manifestsEqual(context.manifest, current.executionSourceManifest)) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum source manifest is stale.');
      }
      const predecessor = current.predecessorId
        ? (repos.curricula.get(current.predecessorId) ?? null)
        : null;
      const workspaceName = repos.workspaces.get(current.workspaceId)?.name ?? 'Course';
      if (requiresStudyPlanExecutionRepair(repos, clock, contract, predecessor, workspaceName)) {
        const preflight = preflightStudyPlan(repos, clock, contract, current, workspaceName);
        const errors = executionRepairErrors(preflight);
        if (errors.length > 0) {
          assertValidMaterializedCurriculum({
            nodes: current.nodes,
            synthesisGroups: current.synthesisGroups,
            validation: {
              ...current.validation,
              valid: false,
              errors: [...current.validation.errors, ...errors].slice(0, 100),
            },
          });
        }
      }
      return commands.complete(claim, () => {
        const accepted = repos.curricula.accept(current.id, clock.now().toISOString(), {
          id: newId('curriculum_evt'),
          eventType: 'accepted',
          actor: parsed.command.actor,
          payload: { acceptanceBasis: parsed.acceptanceBasis },
          createdAt: clock.now().toISOString(),
        });
        return CurriculumProposalResponseSchema.parse({
          curriculum: accepted,
          hierarchy: curriculumHierarchy(accepted),
          retainedAcceptedCurriculumId: repos.courseExecution.get(current.workspaceId)
            .activeCurriculumId,
        });
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function reject(input: RejectCurriculumRequest): CurriculumProposalResponse {
    const parsed = RejectCurriculumRequestSchema.parse(input);
    const current = requireCurriculum(parsed.command.workspaceId, parsed.curriculumId);
    if (current.version !== parsed.expectedVersion) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum rejection identity is stale.');
    }
    const claim = commands.begin(parsed.command, 'reject_curriculum', {
      curriculumId: current.id,
      version: current.version,
      status: current.status,
    });
    if (claim.replayPayload !== undefined) {
      return CurriculumProposalResponseSchema.parse(claim.replayPayload);
    }
    try {
      return commands.complete(claim, () => {
        const rejected = repos.curricula.reject(current.id, parsed.reason, {
          id: newId('curriculum_evt'),
          eventType: 'rejected',
          actor: parsed.command.actor,
          payload: {},
          createdAt: clock.now().toISOString(),
        });
        return CurriculumProposalResponseSchema.parse({
          curriculum: rejected,
          hierarchy: curriculumHierarchy(rejected),
          retainedAcceptedCurriculumId: repos.courseExecution.get(current.workspaceId)
            .activeCurriculumId,
        });
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return { detail, history, propose, accept, reject };
}

export type CurriculumService = ReturnType<typeof createCurriculumService>;
