import {
  AcceptCurriculumRequestSchema,
  ApiErrorCode,
  CurriculumHierarchyViewSchema,
  CurriculumHistoryResponseSchema,
  CurriculumProposalResponseSchema,
  ExecutionSourceManifestSchema,
  VisualAdvisoryContextSchema,
  VisualMediaTypeSchema,
  ProposeCurriculumRequestSchema,
  RejectCurriculumRequestSchema,
  fnv1a32,
  type AcceptCurriculumRequest,
  type Curriculum,
  type CurriculumCoverageWarning,
  type CurriculumProposalPayload,
  type CurriculumDetailProposalPayload,
  type CourseMap,
  type CurriculumAuthorityEnvelope,
  type CurriculumHierarchyView,
  type CurriculumHistoryResponse,
  type CurriculumProposalResponse,
  type ExecutionSourceManifest,
  type LearningContract,
  type ObjectiveAuthorityCapabilityRecoveryOrigin,
  type ObjectiveAuthorityRequiredCapabilityPreservation,
  type ProposeCurriculumRequest,
  type RejectCurriculumRequest,
  type StudyPlanPreflight,
  type VisualAdvisoryContext,
  type VisualDerivation,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL } from '../llm/provider.js';
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
  curriculumSourceBlockFingerprint,
  materializeCurriculumProposal,
  type CurriculumValidationContext,
  type CurriculumDeterministicCoverageMembership,
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
import { CURRICULUM_EVIDENCE_PRODUCTION_POLICY } from './curriculumEvidencePolicy.js';
import {
  buildCourseSourceMap,
  type CourseSourceMap,
  type CourseSourceMapInput,
} from './courseSourceMap.js';
import { preflightStudyPlan } from './studyPlansAgent.js';
import { assessCurriculumRecovery } from './curriculumRecovery.js';
import {
  evaluateCurriculumSemantics,
  type CurriculumSemanticSourceRegion,
} from './curriculumSemanticEvaluator.js';
import { assertLearningContractScopeCurrent } from './learningContractScope.js';
import {
  assertCourseMapSourceAllocationIntegrity,
  buildCourseMapProposalInput,
  buildCourseMapSourceAllocation,
  generateCourseMapPrototype,
} from './courseMap.js';
import {
  CurriculumDetailBatchPlanningError,
  MAX_DETAIL_BATCHES,
  assertCurriculumCapabilityRecoveryDetailOutputFeasible,
  assembleCurriculumDetailBatches,
  buildCourseMapDeterministicCoverage,
  minimumCurriculumDetailObjectiveCount,
  planCurriculumDetailBatches,
  validateCurriculumDetailPlan,
  validateCurriculumDetailCandidate,
} from './curriculumMaterialization.js';
import { visualAwareManifestFingerprint } from './advisoryVisuals.js';
import {
  buildCurriculumAuthorityEnvelope,
  curriculumTargetRequestsApplication,
  selectApplyCapableProcedureGroundings,
} from './curriculumAuthority.js';
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
  assertCurrentCurriculumObjectiveAuthoritySemanticSupport,
  attachObjectiveAuthoritySemanticSupport,
  buildObjectiveAuthoritySemanticEvaluationBatches,
  materializeObjectiveAuthoritySemanticSupport,
  objectiveAuthoritySemanticEvaluationSourceFingerprint,
  validateObjectiveAuthoritySemanticEvaluationProposal,
} from './objectiveAuthoritySemanticSupport.js';
import {
  applyObjectiveAuthoritySemanticRepairProposal,
  objectiveAuthoritySemanticRepairSourceFingerprint,
  prepareObjectiveAuthoritySemanticRepair,
  validateObjectiveAuthoritySemanticRepairProposal,
} from './objectiveAuthoritySemanticRepair.js';
import {
  allocateCurriculumCapabilityRecoveryFrontier,
  assertCurriculumCapabilityRecoveryLineage,
  bindMaterializedCurriculumCapabilityRecovery,
  buildCurriculumCapabilityRecoveryFrontier,
  reserveCurriculumCapabilityRecoveryEvidence,
  validateCurriculumCapabilityRecoveryCandidate,
  type CurriculumCapabilityRecoveryFrontier,
} from './curriculumCapabilityRecovery.js';

/** HTTP/service request: the server, never the client, resolves exact revisions. */
export const ProposeCurriculumCommandRequestSchema = ProposeCurriculumRequestSchema.omit({
  executionSourceManifest: true,
}).strict();
export type ProposeCurriculumCommandRequest = Omit<
  ProposeCurriculumRequest,
  'executionSourceManifest'
>;

export function curriculumLimits(
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
export const LEGACY_CURRICULUM_GENERATION_POLICY = 'legacy_direct_v1' as const;
export const COURSE_MAP_CURRICULUM_GENERATION_POLICY = 'course_map_materialization_v1' as const;
export const CURRICULUM_GENERATION_POLICY = LEGACY_CURRICULUM_GENERATION_POLICY;
/** Long source outlines use the hierarchy-first path even for legacy callers. */
export const LARGE_CURRICULUM_OUTLINE_THRESHOLD = 80;
export type CurriculumGenerationPolicy =
  typeof LEGACY_CURRICULUM_GENERATION_POLICY | typeof COURSE_MAP_CURRICULUM_GENERATION_POLICY;

export function curriculumGenerationPolicyForOutline(
  outlineLength: number,
  requested: CurriculumGenerationPolicy,
  explicitlyConfigured = false,
): CurriculumGenerationPolicy {
  if (
    !explicitlyConfigured &&
    requested === LEGACY_CURRICULUM_GENERATION_POLICY &&
    outlineLength >= LARGE_CURRICULUM_OUTLINE_THRESHOLD
  ) {
    return COURSE_MAP_CURRICULUM_GENERATION_POLICY;
  }
  return requested;
}
/** Initial evaluation, one failed-objective repair, and a fresh full reevaluation. */
export const CURRICULUM_MAX_OBJECTIVE_AUTHORITY_EVALUATION_BATCHES =
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES /
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH;
export const CURRICULUM_MAX_OBJECTIVE_AUTHORITY_REPAIR_CALLS = 1;
export const CURRICULUM_MAX_OBJECTIVE_AUTHORITY_LOGICAL_CALLS =
  CURRICULUM_MAX_OBJECTIVE_AUTHORITY_EVALUATION_BATCHES * 2 +
  CURRICULUM_MAX_OBJECTIVE_AUTHORITY_REPAIR_CALLS;
export const CURRICULUM_MAX_LOGICAL_PROVIDER_CALLS =
  1 + MAX_DETAIL_BATCHES + CURRICULUM_MAX_OBJECTIVE_AUTHORITY_LOGICAL_CALLS;
export const CURRICULUM_MAX_PHYSICAL_PROVIDER_CALLS =
  CURRICULUM_MAX_LOGICAL_PROVIDER_CALLS * MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL;
export const CURRICULUM_OPERATION_LEASE_MS =
  CURRICULUM_PROVIDER_TIMEOUT_MS * CURRICULUM_MAX_PHYSICAL_PROVIDER_CALLS +
  PROVIDER_REPAIR_LEASE_MARGIN_MS;
export const COURSE_PREPARATION_POLICY_ID = 'course_preparation_v1';
export const CURRICULUM_MAX_VISUAL_OFFERS = 24;
export const CURRICULUM_MAX_SERIALIZED_VISUAL_BYTES = 32_768;

function isCurriculumDetailPlanningDiagnosticCode(code: string): boolean {
  return (
    code === 'curriculum_detail_planning_failed' ||
    code.startsWith('curriculum_detail_') ||
    code.startsWith('recovery_capability_detail_')
  );
}

function curriculumDetailPlanningFailure(error: unknown): {
  diagnostics: string[];
  diagnosticCodes: string[];
} | null {
  if (error instanceof CurriculumDetailBatchPlanningError) {
    return {
      diagnostics: error.diagnostics.slice(0, 20),
      diagnosticCodes: error.diagnosticCodes.slice(0, 20),
    };
  }
  if (!(error instanceof ProviderError) || error.code !== ApiErrorCode.ProviderInvalidOutput) {
    return null;
  }
  if (!error.details || typeof error.details !== 'object' || Array.isArray(error.details)) {
    return null;
  }
  const candidateFailure = (error.details as Record<string, unknown>).candidateFailure;
  if (
    !candidateFailure ||
    typeof candidateFailure !== 'object' ||
    Array.isArray(candidateFailure)
  ) {
    return null;
  }
  const rawDiagnostics = (candidateFailure as Record<string, unknown>).diagnostics;
  if (!Array.isArray(rawDiagnostics)) return null;
  const detailDiagnostics = rawDiagnostics.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const diagnostic = raw as Record<string, unknown>;
    if (
      typeof diagnostic.code !== 'string' ||
      typeof diagnostic.message !== 'string' ||
      !isCurriculumDetailPlanningDiagnosticCode(diagnostic.code)
    ) {
      return [];
    }
    return [{ code: diagnostic.code, message: diagnostic.message }];
  });
  return detailDiagnostics.length > 0
    ? {
        diagnostics: detailDiagnostics.map((diagnostic) => diagnostic.message).slice(0, 20),
        diagnosticCodes: detailDiagnostics.map((diagnostic) => diagnostic.code).slice(0, 20),
      }
    : null;
}

interface CurriculumVisualCandidate {
  materialTitle: string;
  sourceKind: 'standalone' | 'embedded';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  pageNumber: number | null;
  slideNumber: number | null;
  contextLabel: string;
  derivation: VisualDerivation;
}

function buildCurriculumVisualContext(
  candidates: CurriculumVisualCandidate[],
): NonNullable<CurriculumProposalInput['visualContext']> {
  const offers: VisualAdvisoryContext[] = [];
  for (const candidate of candidates) {
    if (offers.length >= CURRICULUM_MAX_VISUAL_OFFERS) break;
    const offer = VisualAdvisoryContextSchema.parse({
      referenceKey: `V${offers.length + 1}`,
      materialTitle: candidate.materialTitle,
      source: {
        sourceKind: candidate.sourceKind,
        mediaType: candidate.mediaType,
        width: candidate.width,
        height: candidate.height,
        location: {
          pageNumber: candidate.pageNumber,
          slideNumber: candidate.slideNumber,
          contextLabel: candidate.contextLabel,
        },
        authority: 'original_visual',
      },
      explanation: {
        text: candidate.derivation.payload.description,
        visualType: candidate.derivation.payload.visualType,
        importantConcepts: candidate.derivation.payload.importantConcepts,
        pedagogicalNotes: candidate.derivation.payload.pedagogicalNotes,
        uncertainty: candidate.derivation.payload.uncertainty,
        contentOrigin: 'derived_visual_description',
        provenanceCategory: 'generated_visual_explanation',
        authority: 'advisory',
        evidenceAdmissibility: 'advisory_nonblocking',
        formalEvidenceEligible: false,
      },
    });
    const next = [...offers, offer];
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > CURRICULUM_MAX_SERIALIZED_VISUAL_BYTES) {
      continue;
    }
    offers.push(offer);
  }
  return {
    offerCount: offers.length,
    serializedBytes: Buffer.byteLength(JSON.stringify(offers), 'utf8'),
    offers,
  };
}

export interface CurriculumProposalOptions extends ProviderCallOptions {
  preparationPolicyId?: typeof COURSE_PREPARATION_POLICY_ID;
  generationPolicy?: CurriculumGenerationPolicy;
}

export function curriculumOperationLeaseMs(
  timeoutMs: number,
  generationPolicy: CurriculumGenerationPolicy = CURRICULUM_GENERATION_POLICY,
): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AppError(ApiErrorCode.ValidationError, 'Curriculum provider timeout is invalid.');
  }
  const generationLogicalCalls =
    generationPolicy === LEGACY_CURRICULUM_GENERATION_POLICY ? 1 : 1 + MAX_DETAIL_BATCHES;
  const physicalCalls =
    (generationLogicalCalls + CURRICULUM_MAX_OBJECTIVE_AUTHORITY_LOGICAL_CALLS) *
    MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL;
  return timeoutMs * physicalCalls + PROVIDER_REPAIR_LEASE_MARGIN_MS;
}

interface CurriculumServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  commands: CourseCommandService;
  providerModel?: string | null;
  sourceAuthority: Pick<SourceAuthorityService, 'ensureVerbatimAssessmentAuthority'>;
  generationPolicy?: CurriculumGenerationPolicy;
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
  workspaceId: string;
  manifest: ExecutionSourceManifest;
  contractContext: CurriculumContractContext;
  outline: CurriculumOutlineItem[];
  blocks: ReturnType<Repositories['materials']['getBlocksByWorkspace']>;
  authorityBundles: SourceAuthorityBundle[];
  sourceMapMaterials: CourseSourceMapInput['materials'];
  visualCandidates: CurriculumVisualCandidate[];
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
  const sourceMapMaterials: CourseSourceMapInput['materials'] = [];
  const visualCandidates: CurriculumVisualCandidate[] = [];
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
    const originalVisuals = repos.materialRevisions
      .getAssets(revision.id)
      .filter(
        (asset) =>
          asset.relationshipKind === 'image' &&
          asset.contentOrigin === 'extracted_original' &&
          asset.width !== null &&
          asset.height !== null &&
          VisualMediaTypeSchema.safeParse(asset.mediaType).success,
      );
    if (
      materialBlocks.some(
        (block) =>
          block.materialRevisionId !== revision.id ||
          (block.contentOrigin !== undefined &&
            block.contentOrigin !== null &&
            block.contentOrigin !== 'extracted_original'),
      ) ||
      (materialBlocks.length === 0 && originalVisuals.length === 0)
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
      chunkerVersion: revision.chunkerVersion,
      chunkerFingerprint: revision.chunkerFingerprint,
      sourceBlockRevisionIds: materialBlocks.map((block) => block.id),
    });
    sourceMapMaterials.push({
      materialId: material.id,
      workspaceId: material.workspaceId,
      title: material.title,
      availability: 'active',
      activeRevisionId: revision.id,
      revision: {
        id: revision.id,
        materialId: revision.materialId,
        status: 'active',
        parserVersion: revision.parserVersion,
        parserFingerprint: revision.parserFingerprint,
        chunkerVersion: revision.chunkerVersion,
        chunkerFingerprint: revision.chunkerFingerprint,
      },
      visuals: originalVisuals.map((asset) => {
        const derivation = repos.visualDerivations
          .listForAsset(asset.id)
          .filter(
            (candidate) =>
              candidate.materialRevisionId === revision.id &&
              candidate.assetByteHash === asset.byteHash &&
              candidate.validationStatus === 'accepted' &&
              candidate.authority === 'derived' &&
              candidate.evidenceAdmissibility === 'advisory_nonblocking',
          )
          .at(-1);
        const pageNumber = asset.location.pageNumber ?? null;
        const slideNumber = asset.location.slideNumber ?? null;
        const contextLabel =
          slideNumber !== null
            ? `Slide ${slideNumber}`
            : pageNumber !== null
              ? `Page ${pageNumber}`
              : material.sourceType === 'image'
                ? 'Standalone image'
                : `Embedded visual ${asset.index + 1}`;
        if (derivation) {
          visualCandidates.push({
            materialTitle: material.title,
            sourceKind: material.sourceType === 'image' ? 'standalone' : 'embedded',
            mediaType: VisualMediaTypeSchema.parse(asset.mediaType),
            width: asset.width!,
            height: asset.height!,
            pageNumber,
            slideNumber,
            contextLabel,
            derivation,
          });
        }
        return {
          assetOccurrenceId: asset.id,
          assetByteHash: asset.byteHash,
          mediaType: VisualMediaTypeSchema.parse(asset.mediaType),
          width: asset.width!,
          height: asset.height!,
          location: {
            pageNumber,
            slideNumber,
            contextLabel,
          },
          contentOrigin: 'extracted_original' as const,
          advisoryDescription: derivation
            ? {
                text: derivation.payload.description,
                derivationId: derivation.id,
                identityFingerprint: derivation.identityFingerprint,
                authority: 'advisory_nonblocking' as const,
              }
            : null,
        };
      }),
      blocks: materialBlocks.map((block) => ({
        ...block,
        materialRevisionId: revision.id,
        structuralUnitId: block.structuralUnitId ?? null,
        revisionFingerprint: curriculumSourceBlockFingerprint(block, revision.id),
      })),
    });
    for (const block of materialBlocks) {
      blocks.push(block);
      outline.push({
        structuralUnitId: block.structuralUnitId ?? null,
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
    fingerprint: visualAwareManifestFingerprint(repos, revisions),
    revisions,
  });
  return {
    workspaceId: contract.workspaceId,
    manifest,
    outline,
    blocks,
    authorityBundles,
    sourceMapMaterials,
    visualCandidates,
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

/** Build the production navigation projection from the already-validated request facts. */
export function buildCurriculumCourseSourceMap(
  context: ReturnType<typeof buildCurriculumExecutionContext>,
  concepts: CourseSourceMapInput['concepts'],
  predecessor: CourseSourceMapInput['predecessor'],
): CourseSourceMap {
  return buildCourseSourceMap({
    workspaceId: context.workspaceId,
    manifest: context.manifest,
    materials: context.sourceMapMaterials,
    concepts,
    predecessor,
  });
}

function manifestsEqual(left: ExecutionSourceManifest, right: ExecutionSourceManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildAuthorityEnvelopeMap(
  regions: Array<{ id: string; sourceBlockIds: string[] }>,
  evidenceCatalog: ReturnType<typeof selectCurriculumEvidenceOffers>,
  context: ReturnType<typeof buildCurriculumExecutionContext>,
  repos: Repositories,
): Map<string, CurriculumAuthorityEnvelope> {
  return new Map(
    regions.map((region) => [
      region.id,
      buildCurriculumAuthorityEnvelope({
        sourceRegionId: region.id,
        sourceBlockIds: region.sourceBlockIds,
        evidence: evidenceCatalog.filter((offer) => region.sourceBlockIds.includes(offer.blockId)),
        authorityBundles: context.authorityBundles,
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      }),
    ]),
  );
}

/**
 * Detail requests are keyed by server-owned Course Map region ids, while the
 * initial Course Map request is keyed by source-allocation region ids. Keep
 * that identity boundary explicit and derive one envelope over every
 * allocation represented by each final Course Map region.
 */
export function buildCourseMapRegionAuthorityEnvelopeMap(
  courseMap: CourseMap,
  sourceAllocation: { regions: Array<{ id: string; sourceBlockIds: string[] }> },
  evidenceCatalog: ReturnType<typeof selectCurriculumEvidenceOffers>,
  context: ReturnType<typeof buildCurriculumExecutionContext>,
  repos: Repositories,
): Map<string, CurriculumAuthorityEnvelope> {
  const allocationById = new Map(sourceAllocation.regions.map((region) => [region.id, region]));
  return new Map(
    courseMap.modules.flatMap((module) =>
      module.regions.map((region) => {
        const sourceBlockIds = [
          ...new Set(
            region.sourceAllocationRegionIds.flatMap(
              (allocationId) => allocationById.get(allocationId)?.sourceBlockIds ?? [],
            ),
          ),
        ];
        return [
          region.id,
          buildCurriculumAuthorityEnvelope({
            sourceRegionId: region.id,
            sourceBlockIds,
            evidence: evidenceCatalog.filter((offer) => sourceBlockIds.includes(offer.blockId)),
            authorityBundles: context.authorityBundles,
            isBlockingEligible: (authorityRecordId) =>
              repos.sourceAuthority.isBlockingEligible(authorityRecordId),
          }),
        ] as const;
      }),
    ),
  );
}

/** Exact provider evidence offers carry the same authority boundary enforced after materialization. */
export function buildEvidenceAuthorityEnvelopeMap(
  evidenceCatalog: ReturnType<typeof selectCurriculumEvidenceOffers>,
  context: ReturnType<typeof buildCurriculumExecutionContext>,
  repos: Repositories,
): Map<string, CurriculumAuthorityEnvelope> {
  return new Map(
    evidenceCatalog.map((offer) => [
      offer.id,
      buildCurriculumAuthorityEnvelope({
        sourceRegionId: offer.id,
        sourceBlockIds: [offer.blockId],
        evidence: [offer],
        authorityBundles: context.authorityBundles,
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      }),
    ]),
  );
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

/**
 * Nearest accepted execution-repair ancestor whose Contract and complete
 * source manifest are identical to the candidate operation. Only that narrow
 * lineage may impose immutable capability-preservation obligations.
 */
export function acceptedCurriculumCapabilityRecoveryPredecessor(
  repos: Repositories,
  clock: Clock,
  contract: LearningContract,
  manifest: ExecutionSourceManifest,
  predecessor: Curriculum | null,
  workspaceName: string,
): Curriculum | null {
  const visited = new Set<string>();
  let ancestor = predecessor;
  while (ancestor && !visited.has(ancestor.id)) {
    if (ancestor.acceptedAt) {
      if (
        ancestor.workspaceId !== contract.workspaceId ||
        ancestor.contractVersionId !== contract.id ||
        ancestor.executionSourceManifest.fingerprint !== manifest.fingerprint ||
        JSON.stringify(ancestor.executionSourceManifest) !== JSON.stringify(manifest)
      ) {
        return null;
      }
      return preflightStudyPlan(repos, clock, contract, ancestor, workspaceName).canGenerate
        ? null
        : ancestor;
    }
    visited.add(ancestor.id);
    ancestor = ancestor.predecessorId
      ? (repos.curricula.get(ancestor.predecessorId) ?? null)
      : null;
  }
  return null;
}

function nonEmptyCurriculumCapabilityRecoveryFrontier(
  frontier: CurriculumCapabilityRecoveryFrontier,
): CurriculumCapabilityRecoveryFrontier | null {
  return frontier.requirements.length > 0 ? frontier : null;
}

function executionRepairErrors(preflight: StudyPlanPreflight): string[] {
  if (preflight.canGenerate) return [];
  const blockerCodes = preflight.blockers.map((blocker) => blocker.code).join(', ');
  return [
    `StudyPlan execution repair: ${preflight.executableLearningUnitCount} of ${preflight.totalLearningUnitCount} LearningUnits have a supported launch capability; blockers: ${blockerCodes}. Current launch implementations require an exact current source Concept binding or another supported capability.`,
  ];
}

export function validateExecutionRepairCandidate(input: {
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
    { requireObjectiveAuthoritySemanticSupport: false },
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

export function buildOfferedCurriculumKnowledge(
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
      visualCandidates: context.visualCandidates.map((candidate) => ({
        materialTitle: candidate.materialTitle,
        sourceKind: candidate.sourceKind,
        mediaType: candidate.mediaType,
        width: candidate.width,
        height: candidate.height,
        pageNumber: candidate.pageNumber,
        slideNumber: candidate.slideNumber,
        contextLabel: candidate.contextLabel,
        derivationId: candidate.derivation.id,
        derivationIdentityFingerprint: candidate.derivation.identityFingerprint,
      })),
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
    ...(curriculum.coverageAccountability
      ? { coverageAccountability: curriculum.coverageAccountability }
      : {}),
    ...(curriculum.qualityEvaluation ? { qualityEvaluation: curriculum.qualityEvaluation } : {}),
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
  generationPolicy: defaultGenerationPolicy = CURRICULUM_GENERATION_POLICY,
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
      proposedCurriculumId: items.at(-1)?.status === 'proposed' ? items.at(-1)!.id : null,
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
    opts?: CurriculumProposalOptions,
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
    const requestedGenerationPolicy = opts?.generationPolicy ?? defaultGenerationPolicy;
    const generationPolicy = curriculumGenerationPolicyForOutline(
      context.outline.length,
      requestedGenerationPolicy,
      opts?.generationPolicy !== undefined,
    );
    const claim = commands.begin(
      parsed.command,
      'propose_curriculum',
      {
        contractId: contract.id,
        contractVersion: contract.version,
        predecessorCurriculumId: parsed.predecessorCurriculumId,
        expectedActiveCurriculumId: parsed.expectedActiveCurriculumId,
        manifestFingerprint: context.manifest.fingerprint,
        generationPolicy,
        confirmedCostPolicyIds: parsed.confirmedCostPolicyIds ?? [],
      },
      { leaseMs: curriculumOperationLeaseMs(providerTimeoutMs, generationPolicy) },
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
    const applyProcedureGroundings = curriculumTargetRequestsApplication(
      context.contractContext.targetOutcome.description,
    )
      ? selectApplyCapableProcedureGroundings({
          authorityBundles: context.authorityBundles,
          isBlockingEligible: (authorityRecordId) =>
            repos.sourceAuthority.isBlockingEligible(authorityRecordId),
        })
      : [];
    const preferredGroundings = [
      ...applyProcedureGroundings,
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
    if (fullEvidenceCatalog.length === 0) {
      const diagnostic =
        'Curriculum objectives require exact source evidence; advisory visual-only Materials cannot independently support or originate LearningUnit objectives.';
      const manifestMaterialIds = new Set(
        context.manifest.revisions.map((revision) => revision.materialId),
      );
      const error = ProviderError.invalidOutput(
        diagnostic,
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        {
          kind: 'curriculum_objective_authority_unavailable',
          context: {
            includedManifestedMaterialCount: context.contractContext.materials.filter(
              (material) =>
                material.disposition === 'included' && manifestMaterialIds.has(material.materialId),
            ).length,
            authoritativeMaterialCount: 0,
          },
          diagnostics: [
            {
              code: 'visual_only_material_cannot_originate_objective',
              message: diagnostic,
            },
          ],
        },
      );
      commands.fail(claim, error);
      throw error;
    }
    const predecessor = latest ?? null;
    let sourceMap: CourseSourceMap;
    try {
      sourceMap = buildCurriculumCourseSourceMap(context, concepts, predecessor);
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
    const statusBasedExecutionRepairRequired = requiresStudyPlanExecutionRepair(
      repos,
      clock,
      contract,
      predecessor,
      workspace.name,
    );
    const capabilityRecoveryPredecessor = acceptedCurriculumCapabilityRecoveryPredecessor(
      repos,
      clock,
      contract,
      context.manifest,
      predecessor,
      workspace.name,
    );
    const executionRepairRequired =
      statusBasedExecutionRepairRequired || capabilityRecoveryPredecessor !== null;
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
    let evidenceCatalog: ReturnType<typeof selectCurriculumEvidenceOffers>;
    let recoveryEvidenceIdsByLearningUnitId: ReadonlyMap<string, readonly string[]> = new Map();
    try {
      const selectedEvidenceCatalog = selectCurriculumEvidenceOffers({
        catalog: fullEvidenceCatalog,
        blocks: context.blocks,
        predecessor,
        concepts,
        contract,
        priorityGroundings,
        applyProcedureGroundings,
        sourceMap,
        policy: CURRICULUM_EVIDENCE_PRODUCTION_POLICY,
      });
      if (capabilityRecoveryPredecessor) {
        const reservation = reserveCurriculumCapabilityRecoveryEvidence({
          predecessor: capabilityRecoveryPredecessor,
          fullEvidenceCatalog,
          selectedEvidenceCatalog,
        });
        evidenceCatalog = reservation.evidenceCatalog;
        recoveryEvidenceIdsByLearningUnitId = reservation.recoveryEvidenceIdsByLearningUnitId;
      } else {
        evidenceCatalog = selectedEvidenceCatalog;
      }
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
    let capabilityRecoveryFrontier: CurriculumCapabilityRecoveryFrontier | null = null;
    if (capabilityRecoveryPredecessor) {
      try {
        capabilityRecoveryFrontier = nonEmptyCurriculumCapabilityRecoveryFrontier(
          buildCurriculumCapabilityRecoveryFrontier({
            predecessor: capabilityRecoveryPredecessor,
            contract,
            manifest: context.manifest,
            sourceBlocks: context.blocks,
            evidenceCatalog,
            recoveryEvidenceIdsByLearningUnitId,
          }),
        );
      } catch (error) {
        commands.fail(claim, error);
        throw error;
      }
    }
    const legacyAuthorityEnvelopes = [
      ...buildAuthorityEnvelopeMap(
        context.outline.map((item, index) => ({
          id: `outline_region_${index + 1}`,
          sourceBlockIds: [...item.sourceBlockIds],
        })),
        evidenceCatalog,
        context,
        repos,
      ).values(),
    ];
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
      ...(capabilityRecoveryFrontier
        ? { capabilityRecovery: { requirements: capabilityRecoveryFrontier.requirements } }
        : {}),
      blocks: context.blocks,
      evidenceCatalog,
      authorityEnvelopes: legacyAuthorityEnvelopes,
      visualContext: buildCurriculumVisualContext(context.visualCandidates),
      limits: curriculumLimits(context.outline, predecessor),
    };
    const deterministicCoverageByNodeKey = new Map<
      string,
      CurriculumDeterministicCoverageMembership
    >();
    const validationContext: CurriculumValidationContext = {
      workspaceId: parsed.command.workspaceId,
      courseTitle: workspace.name,
      executionSourceManifest: context.manifest,
      blocks: context.blocks,
      concepts,
      graphEdges,
      structuralUnitOwners,
      deterministicCoverageByNodeKey,
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
    const recoveryFencedSourceFingerprint = (fingerprint: string): string =>
      capabilityRecoveryFrontier
        ? `${fingerprint}:${capabilityRecoveryFrontier.fingerprint}`
        : fingerprint;
    let repairAttempted = false;
    let lastCandidateValidation: MaterializedCurriculum | null = null;
    let semanticSourceRegions: CurriculumSemanticSourceRegion[] = sourceMap.materials.flatMap(
      (material) =>
        material.sections.map((section) => ({
          id: section.id,
          materialId: section.materialId,
          materialRevisionId: section.materialRevisionId,
          title: section.title,
          sourceSectionIds: [section.id],
          sourceBlockIds: [...section.sourceBlockIds],
          charCount: section.charCount,
        })),
    );
    const assertCapabilityRecoverySnapshotCurrent = (): void => {
      try {
        const currentLatest = repos.curricula.list(parsed.command.workspaceId).at(-1) ?? null;
        const currentPredecessor = acceptedCurriculumCapabilityRecoveryPredecessor(
          repos,
          clock,
          contract,
          context.manifest,
          currentLatest,
          workspace.name,
        );
        const currentFrontier = currentPredecessor
          ? nonEmptyCurriculumCapabilityRecoveryFrontier(
              buildCurriculumCapabilityRecoveryFrontier({
                predecessor: currentPredecessor,
                contract,
                manifest: context.manifest,
                sourceBlocks: context.blocks,
                evidenceCatalog,
                recoveryEvidenceIdsByLearningUnitId,
              }),
            )
          : null;
        if (
          currentFrontier?.predecessorCurriculumId !==
            capabilityRecoveryFrontier?.predecessorCurriculumId ||
          currentFrontier?.predecessorCurriculumVersion !==
            capabilityRecoveryFrontier?.predecessorCurriculumVersion ||
          currentFrontier?.fingerprint !== capabilityRecoveryFrontier?.fingerprint
        ) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'The accepted Curriculum recovery frontier changed while the successor proposal was running.',
          );
        }
      } catch (error) {
        if (error instanceof AppError && error.code === ApiErrorCode.VersionConflict) throw error;
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'The accepted Curriculum recovery frontier changed while the successor proposal was running.',
        );
      }
    };
    let assertGenerationSnapshotCurrent = (): void => {
      if (opts?.signal?.aborted) throw ProviderError.cancelled();
      assertProposalAuthorityCurrent(
        repos,
        parsed,
        contract,
        context.manifest,
        offeredKnowledge.fingerprint,
      );
      assertCapabilityRecoverySnapshotCurrent();
    };
    try {
      const enforceCurrentCostPolicy = (): string | null =>
        enforceAgentCostPolicies(repos, {
          workspaceId: parsed.command.workspaceId,
          operationType: 'propose_curriculum',
          studySessionId: null,
          at: clock.now().toISOString(),
          confirmedPolicyIds: parsed.confirmedCostPolicyIds ?? [],
        });
      const evaluateObjectiveAuthority = async (
        candidate: MaterializedCurriculum,
        phase: 'initial' | 'post_repair',
        requiredCapabilityPreservationByObjectiveId?: ReadonlyMap<
          string,
          ObjectiveAuthorityRequiredCapabilityPreservation
        >,
        recoveryOriginByObjectiveId?: ReadonlyMap<
          string,
          ObjectiveAuthorityCapabilityRecoveryOrigin
        >,
      ) => {
        for (const objectiveId of recoveryOriginByObjectiveId?.keys() ?? []) {
          if (!requiredCapabilityPreservationByObjectiveId?.has(objectiveId)) {
            throw new Error(
              `Curriculum recovery origin lacks a capability-preservation requirement: ${objectiveId}`,
            );
          }
        }
        const batches = buildObjectiveAuthoritySemanticEvaluationBatches(
          {
            nodes: candidate.nodes,
            sourceBlocks: context.blocks,
            authorityBundles: context.authorityBundles,
            isBlockingEligible: (authorityRecordId) =>
              repos.sourceAuthority.isBlockingEligible(authorityRecordId),
            requiredCapabilityPreservationByObjectiveId,
          },
          OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
        );
        if (batches.length === 0) {
          throw new AppError(
            ApiErrorCode.GroundingFailed,
            'Curriculum semantic-support evaluation requires at least one objective.',
            { kind: 'objective_authority_semantic_support_empty' },
          );
        }
        if (batches.length > CURRICULUM_MAX_OBJECTIVE_AUTHORITY_EVALUATION_BATCHES) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Curriculum objective-authority evaluation exceeds the fixed provider-call budget.',
            {
              kind: 'objective_authority_semantic_support_budget_exceeded',
              objectiveCount: batches.reduce(
                (count, batch) => count + batch.input.objectives.length,
                0,
              ),
              maxObjectives: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES,
              batchSize: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
              maxBatches: CURRICULUM_MAX_OBJECTIVE_AUTHORITY_EVALUATION_BATCHES,
            },
          );
        }
        const supportByObjectiveId = new Map<
          string,
          NonNullable<
            NonNullable<
              Curriculum['nodes'][number]['learningUnit']
            >['objectives'][number]['semanticSupport']
          >
        >();
        const firstPass = [] as Array<{
          batch: (typeof batches)[number];
          proposal: Awaited<ReturnType<LlmProvider['evaluateObjectiveAuthoritySupport']>>;
        }>;
        for (const [batchIndex, batch] of batches.entries()) {
          assertGenerationSnapshotCurrent();
          const policyFingerprint = enforceCurrentCostPolicy();
          const proposal = await runTrackedAgentProviderOperation({
            repos,
            clock,
            provider,
            providerModel:
              provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
            operationId: claim.operationId,
            fencingToken: claim.fencingToken,
            workspaceId: parsed.command.workspaceId,
            studySessionId: null,
            learningUnitId: null,
            assessmentId: null,
            operationType: 'propose_curriculum',
            schemaFingerprint: 'objective-authority-semantic-evaluation-v1',
            policyFingerprint,
            sourceFingerprint: recoveryFencedSourceFingerprint(
              objectiveAuthoritySemanticEvaluationSourceFingerprint(batch),
            ),
            providerOptions: opts,
            invoke: (options) =>
              inferenceProvider.evaluateObjectiveAuthoritySupport(structuredClone(batch.input), {
                ...options,
                timeoutMs: providerTimeoutMs,
                onRepairAttempt: (reason, category) => {
                  repairAttempted = true;
                  assertGenerationSnapshotCurrent();
                  if (category) options?.onRepairAttempt?.(reason, category);
                  else options?.onRepairAttempt?.(reason);
                },
                validateCandidate: (providerCandidate) => {
                  assertGenerationSnapshotCurrent();
                  return validateObjectiveAuthoritySemanticEvaluationProposal(
                    batch,
                    providerCandidate,
                  );
                },
              }),
          });
          assertGenerationSnapshotCurrent();
          const evaluated = materializeObjectiveAuthoritySemanticSupport(batch, proposal, {
            evaluator: 'independent-objective-authority-semantic-evaluator-v1',
            provider: provider.name,
            providerModel:
              provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
            evaluatedAt: clock.now().toISOString(),
            recoveryOriginByObjectiveId,
          });
          firstPass.push({ batch, proposal });
          for (const [objectiveId, support] of evaluated) {
            if (supportByObjectiveId.has(objectiveId)) {
              throw new Error(
                `Duplicate objective semantic-support result across ${phase} batch ${batchIndex + 1}: ${objectiveId}`,
              );
            }
            supportByObjectiveId.set(objectiveId, support);
          }
        }
        return {
          materialized: {
            ...candidate,
            nodes: attachObjectiveAuthoritySemanticSupport(candidate.nodes, supportByObjectiveId),
          },
          supportByObjectiveId,
          firstPass,
          failedObjectiveIds: [...supportByObjectiveId.values()]
            .filter((support) => support.verdict === 'fail')
            .map((support) => support.objectiveId),
        };
      };
      let payload: CurriculumProposalPayload;
      let requiredExecutionPreflight = executionRepairRequired;
      let expectedRegionCount: number | null = null;
      let expectedPrerequisiteCount: number | null = null;
      if (generationPolicy === LEGACY_CURRICULUM_GENERATION_POLICY) {
        const policyFingerprint = enforceCurrentCostPolicy();
        payload = await runTrackedAgentProviderOperation({
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
          sourceFingerprint: recoveryFencedSourceFingerprint(context.manifest.fingerprint),
          providerOptions: opts,
          invoke: (options) =>
            inferenceProvider.proposeCurriculum(structuredClone(providerInput), {
              ...options,
              timeoutMs: providerTimeoutMs,
              onRepairAttempt: (reason, category) => {
                repairAttempted = true;
                assertGenerationSnapshotCurrent();
                if (category) options?.onRepairAttempt?.(reason, category);
                else options?.onRepairAttempt?.(reason);
              },
              validateCandidate: (candidate) => {
                assertGenerationSnapshotCurrent();
                const candidateValue = candidate as CurriculumProposalPayload;
                const capabilityRecoveryValidation = validateCurriculumCapabilityRecoveryCandidate(
                  candidateValue,
                  capabilityRecoveryFrontier,
                );
                lastCandidateValidation = validateExecutionRepairCandidate({
                  repos,
                  clock,
                  contract,
                  executionRepairRequired,
                  workspaceName: workspace.name,
                  manifest: context.manifest,
                  materialized: materializeCurriculumProposal(candidateValue, validationContext),
                });
                const authorityDiagnostics = lastCandidateValidation.authorityCritiques.map(
                  (critique) =>
                    `Curriculum authority critique: objective=${critique.objectiveKey ?? critique.objectiveId ?? 'unknown'}; sourceRegions=${critique.affectedSourceRegionIds.join(',') || 'none'}; sourceBlocks=${critique.affectedSourceBlockIds.join(',') || 'none'}; tier=${critique.authorityTier}; supportedConstructs=${critique.supportedConstructs.join(',') || 'none'}; narrowerClaim=${critique.narrowerClaim ?? 'none'}; protectedPriority=${critique.protectedPriority}; reason=${critique.reason}`,
                );
                return {
                  valid:
                    lastCandidateValidation.validation.valid &&
                    lastCandidateValidation.authorityCritiques.length === 0 &&
                    capabilityRecoveryValidation.valid,
                  diagnostics: [
                    ...lastCandidateValidation.validation.errors,
                    ...authorityDiagnostics,
                    ...capabilityRecoveryValidation.diagnostics,
                  ].slice(0, 100),
                  diagnosticCodes:
                    lastCandidateValidation.validation.valid &&
                    lastCandidateValidation.authorityCritiques.length === 0 &&
                    capabilityRecoveryValidation.valid
                      ? []
                      : [
                          'curriculum_candidate_invalid',
                          ...(lastCandidateValidation.authorityCritiques.length > 0
                            ? ['required_objective_formal_authority_missing']
                            : []),
                          ...(capabilityRecoveryValidation.diagnosticCodes ?? []),
                        ],
                  ...(!capabilityRecoveryValidation.valid &&
                  capabilityRecoveryValidation.failureArtifact
                    ? { failureArtifact: capabilityRecoveryValidation.failureArtifact }
                    : {}),
                };
              },
            }),
        });
      } else {
        const sourceAllocation = buildCourseMapSourceAllocation({
          workspaceId: parsed.command.workspaceId,
          sourceMap,
          blocks: context.blocks,
          evidenceCatalog,
        });
        const capabilityRecoveryRequirements = capabilityRecoveryFrontier
          ? allocateCurriculumCapabilityRecoveryFrontier(
              capabilityRecoveryFrontier,
              sourceAllocation,
              evidenceCatalog,
            )
          : [];
        const authorityEnvelopesByRegionId = buildAuthorityEnvelopeMap(
          sourceAllocation.regions,
          evidenceCatalog,
          context,
          repos,
        );
        const authorityEnvelopesByEvidenceId = buildEvidenceAuthorityEnvelopeMap(
          evidenceCatalog,
          context,
          repos,
        );
        assertCurriculumCapabilityRecoveryDetailOutputFeasible(capabilityRecoveryRequirements, {
          workspaceName: workspace.name,
          contract: context.contractContext,
          sourceAllocation,
          evidenceCatalog,
          authorityEnvelopesBySourceAllocationRegionId: authorityEnvelopesByRegionId,
          authorityEnvelopesByEvidenceId,
        });
        const courseMapProviderInput = buildCourseMapProposalInput({
          workspaceName: workspace.name,
          contract: context.contractContext,
          sourceAllocation,
          concepts,
          canonicalConcepts,
          authorityEnvelopesByRegionId,
          capabilityRecoveryRequirements,
          evidenceCatalog,
        });
        assertGenerationSnapshotCurrent = (): void => {
          if (opts?.signal?.aborted) throw ProviderError.cancelled();
          assertProposalAuthorityCurrent(
            repos,
            parsed,
            contract,
            context.manifest,
            offeredKnowledge.fingerprint,
          );
          assertCourseMapSourceAllocationIntegrity(sourceAllocation);
          const currentContract = repos.learningContracts.get(contract.id)!;
          const currentContext = buildCurriculumExecutionContext(repos, currentContract);
          const currentKnowledge = buildOfferedCurriculumKnowledge(
            repos,
            parsed.command.workspaceId,
            currentContext,
          );
          const currentPredecessor =
            repos.curricula.list(parsed.command.workspaceId).at(-1) ?? null;
          const currentSourceMap = buildCurriculumCourseSourceMap(
            currentContext,
            currentKnowledge.concepts,
            currentPredecessor,
          );
          if (currentSourceMap.fingerprint !== sourceMap.fingerprint) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Course Source Map changed while the Curriculum proposal was running.',
            );
          }
          const currentAllocation = buildCourseMapSourceAllocation({
            workspaceId: parsed.command.workspaceId,
            sourceMap: currentSourceMap,
            blocks: currentContext.blocks,
            evidenceCatalog,
          });
          if (currentAllocation.fingerprint !== sourceAllocation.fingerprint) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Course Map source allocation changed while the Curriculum proposal was running.',
            );
          }
          assertCapabilityRecoverySnapshotCurrent();
        };
        assertGenerationSnapshotCurrent();
        const courseMapPolicyFingerprint = enforceCurrentCostPolicy();
        const courseMapResult = await runTrackedAgentProviderOperation({
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
          schemaFingerprint: 'course-map-proposal-v2-local-refs',
          policyFingerprint: courseMapPolicyFingerprint,
          sourceFingerprint: recoveryFencedSourceFingerprint(sourceAllocation.fingerprint),
          providerOptions: opts,
          invoke: (options) =>
            generateCourseMapPrototype(
              {
                provider: inferenceProvider,
                providerInput: courseMapProviderInput,
                sourceAllocation,
                validateAnalysis: (analysis) => {
                  assertGenerationSnapshotCurrent();
                  return validateCurriculumDetailPlan({
                    workspaceName: workspace.name,
                    contract: context.contractContext,
                    courseMap: analysis.courseMap,
                    sourceAllocation,
                    evidenceCatalog,
                    concepts,
                    canonicalConcepts,
                    authorityEnvelopesByRegionId: buildCourseMapRegionAuthorityEnvelopeMap(
                      analysis.courseMap,
                      sourceAllocation,
                      evidenceCatalog,
                      context,
                      repos,
                    ),
                    authorityEnvelopesByEvidenceId,
                    capabilityRecoveryRequirements,
                  });
                },
              },
              {
                ...options,
                timeoutMs: providerTimeoutMs,
                onRepairAttempt: (reason, category) => {
                  repairAttempted = true;
                  assertGenerationSnapshotCurrent();
                  if (category) options?.onRepairAttempt?.(reason, category);
                  else options?.onRepairAttempt?.(reason);
                },
              },
            ),
        });
        assertGenerationSnapshotCurrent();
        const detailBatches = planCurriculumDetailBatches({
          workspaceName: workspace.name,
          contract: context.contractContext,
          courseMap: courseMapResult.analysis.courseMap,
          sourceAllocation,
          evidenceCatalog,
          concepts,
          canonicalConcepts,
          authorityEnvelopesByRegionId: buildCourseMapRegionAuthorityEnvelopeMap(
            courseMapResult.analysis.courseMap,
            sourceAllocation,
            evidenceCatalog,
            context,
            repos,
          ),
          authorityEnvelopesByEvidenceId,
          capabilityRecoveryRequirements,
        });
        const completedBatches: Array<{
          input: (typeof detailBatches)[number]['input'];
          payload: CurriculumDetailProposalPayload;
        }> = [];
        for (const [batchIndex, batch] of detailBatches.entries()) {
          assertGenerationSnapshotCurrent();
          const completedObjectiveCount = completedBatches.reduce(
            (count, completed) =>
              count +
              completed.payload.units.reduce(
                (batchCount, unit) => batchCount + unit.objectives.length,
                0,
              ),
            0,
          );
          const remainingObjectiveMinimum = detailBatches
            .slice(batchIndex + 1)
            .reduce(
              (count, remaining) =>
                count +
                minimumCurriculumDetailObjectiveCount(
                  remaining.input.regions,
                  remaining.input.contract.targetOutcome.description,
                ),
              0,
            );
          const maxObjectivesTotal =
            OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES -
            completedObjectiveCount -
            remainingObjectiveMinimum;
          const currentObjectiveMinimum = minimumCurriculumDetailObjectiveCount(
            batch.input.regions,
            batch.input.contract.targetOutcome.description,
          );
          if (maxObjectivesTotal < currentObjectiveMinimum) {
            throw new CurriculumDetailBatchPlanningError(
              [
                `Curriculum detail batch ${batchIndex + 1} cannot reserve every current and remaining recovery objective within the global semantic-evaluation ceiling.`,
              ],
              ['curriculum_detail_objective_authority_semantic_budget_exceeded'],
            );
          }
          const detailInput = {
            ...batch.input,
            limits: {
              ...batch.input.limits,
              maxObjectivesTotal,
            },
          };
          const detailPolicyFingerprint = enforceCurrentCostPolicy();
          const detailPayload = await runTrackedAgentProviderOperation({
            repos,
            clock,
            provider,
            providerModel:
              provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
            operationId: claim.operationId,
            fencingToken: claim.fencingToken,
            workspaceId: parsed.command.workspaceId,
            studySessionId: null,
            learningUnitId: null,
            assessmentId: null,
            operationType: 'propose_curriculum',
            schemaFingerprint: 'curriculum-detail-proposal-v1',
            policyFingerprint: detailPolicyFingerprint,
            sourceFingerprint: recoveryFencedSourceFingerprint(
              `${sourceAllocation.fingerprint}:${detailInput.batchKey}:objective-budget-${maxObjectivesTotal}`,
            ),
            providerOptions: opts,
            invoke: (options) =>
              inferenceProvider.proposeCurriculumDetails(structuredClone(detailInput), {
                ...options,
                timeoutMs: providerTimeoutMs,
                onRepairAttempt: (reason, category) => {
                  repairAttempted = true;
                  assertGenerationSnapshotCurrent();
                  if (category) options?.onRepairAttempt?.(reason, category);
                  else options?.onRepairAttempt?.(reason);
                },
                validateCandidate: (candidate) => {
                  assertGenerationSnapshotCurrent();
                  return validateCurriculumDetailCandidate(candidate, detailInput);
                },
              }),
          });
          completedBatches.push({ input: detailInput, payload: detailPayload });
        }
        const assembly = assembleCurriculumDetailBatches(
          courseMapResult.analysis.courseMap,
          completedBatches,
        );
        payload = assembly.payload;
        for (const [nodeKey, membership] of buildCourseMapDeterministicCoverage(
          courseMapResult.analysis.courseMap,
          sourceAllocation,
          context.blocks,
        )) {
          deterministicCoverageByNodeKey.set(nodeKey, membership);
        }
        semanticSourceRegions = sourceAllocation.regions.map((region) => {
          const disposition = courseMapResult.analysis.courseMap.sourceDispositions?.find(
            (candidate) => candidate.sourceAllocationRegionId === region.id,
          );
          return {
            id: region.id,
            materialId: region.materialId,
            materialRevisionId: region.materialRevisionId,
            title: region.title,
            sourceSectionIds: [...region.sourceSectionIds],
            sourceBlockIds: [...region.sourceBlockIds],
            charCount: region.charCount,
            defaultDisposition: disposition?.disposition,
            defaultRationale: disposition?.rationale,
          };
        });
        expectedRegionCount = assembly.regionCount;
        expectedPrerequisiteCount = assembly.prerequisiteCount;
        requiredExecutionPreflight = true;
      }
      const capabilityRecoveryCandidateValidation = validateCurriculumCapabilityRecoveryCandidate(
        payload,
        capabilityRecoveryFrontier,
      );
      if (!capabilityRecoveryCandidateValidation.valid) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          'The successor Curriculum did not preserve its immutable predecessor capability frontier.',
          {
            kind: 'curriculum_capability_recovery_candidate_invalid',
            diagnosticCodes: capabilityRecoveryCandidateValidation.diagnosticCodes ?? [],
            diagnostics: capabilityRecoveryCandidateValidation.diagnostics.slice(0, 20),
          },
        );
      }
      let materialized = validateExecutionRepairCandidate({
        repos,
        clock,
        contract,
        executionRepairRequired: requiredExecutionPreflight,
        workspaceName: workspace.name,
        manifest: context.manifest,
        materialized: materializeCurriculumProposal(payload, validationContext),
      });
      if (expectedRegionCount !== null) {
        const learningUnits = materialized.nodes.filter((node) => node.kind === 'learning_unit');
        const prerequisiteCount = learningUnits.reduce(
          (count, node) => count + (node.learningUnit?.prerequisiteUnitIds.length ?? 0),
          0,
        );
        const preservationErrors = [
          ...(learningUnits.length === expectedRegionCount
            ? []
            : ['Course Map region coverage was lost during final Curriculum materialization.']),
          ...(prerequisiteCount === expectedPrerequisiteCount
            ? []
            : [
                'Course Map prerequisite structure was lost during final Curriculum materialization.',
              ]),
        ];
        if (preservationErrors.length > 0) {
          materialized.validation = {
            ...materialized.validation,
            valid: false,
            errors: [...materialized.validation.errors, ...preservationErrors].slice(0, 100),
          };
        }
      }
      lastCandidateValidation = materialized;
      assertValidMaterializedCurriculum(materialized, repairAttempted);
      let materializedCapabilityRecovery = bindMaterializedCurriculumCapabilityRecovery({
        candidate: payload,
        objectiveIdByProposalKey: materialized.objectiveIdByProposalKey ?? new Map(),
        frontier: capabilityRecoveryFrontier,
      });
      const objectiveAuthorityEvaluation = await evaluateObjectiveAuthority(
        materialized,
        'initial',
        materializedCapabilityRecovery.requiredCapabilityPreservationByObjectiveId,
        materializedCapabilityRecovery.recoveryOriginByObjectiveId,
      );
      materialized = objectiveAuthorityEvaluation.materialized;
      if (objectiveAuthorityEvaluation.failedObjectiveIds.length > 0) {
        const preparation = prepareObjectiveAuthoritySemanticRepair({
          candidate: payload,
          objectiveIdByProposalKey: materialized.objectiveIdByProposalKey ?? new Map(),
          firstPass: objectiveAuthorityEvaluation.firstPass,
          requiredCapabilityPreservationByObjectiveId:
            materializedCapabilityRecovery.requiredCapabilityPreservationByObjectiveId,
          recoveryEvidenceScopeByObjectiveId:
            materializedCapabilityRecovery.repairEvidenceScopeByObjectiveId,
          context: {
            workspaceId: parsed.command.workspaceId,
            evidenceCatalog: validationContext.evidenceCatalog,
            authorityBundles: context.authorityBundles,
            isAuthorityBlockingEligible: (authorityRecordId) =>
              repos.sourceAuthority.isBlockingEligible(authorityRecordId),
            deterministicCoverageByNodeKey:
              validationContext.deterministicCoverageByNodeKey &&
              validationContext.deterministicCoverageByNodeKey.size > 0
                ? validationContext.deterministicCoverageByNodeKey
                : undefined,
          },
        });
        if (!preparation.validation.valid || !preparation.batch) {
          throw new AppError(
            ApiErrorCode.GroundingFailed,
            'Curriculum objectives failed semantic support and no bounded local repair scope could be prepared.',
            {
              kind: 'objective_authority_semantic_repair_preparation_failed',
              failedObjectiveIds: objectiveAuthorityEvaluation.failedObjectiveIds,
              diagnosticCodes: preparation.validation.diagnosticCodes ?? [],
              diagnostics: preparation.validation.diagnostics.slice(0, 20),
              repairAttempted: false,
            },
          );
        }
        assertGenerationSnapshotCurrent();
        const repairPolicyFingerprint = enforceCurrentCostPolicy();
        repairAttempted = true;
        const repairBatch = preparation.batch;
        const repairProposal = await runTrackedAgentProviderOperation({
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
          schemaFingerprint: 'objective-authority-semantic-repair-v1',
          policyFingerprint: repairPolicyFingerprint,
          sourceFingerprint: recoveryFencedSourceFingerprint(
            objectiveAuthoritySemanticRepairSourceFingerprint(repairBatch),
          ),
          providerOptions: opts,
          invoke: (options) =>
            inferenceProvider.repairObjectiveAuthoritySupport(structuredClone(repairBatch.input), {
              ...options,
              timeoutMs: providerTimeoutMs,
              onRepairAttempt: (reason, category) => {
                assertGenerationSnapshotCurrent();
                if (category) options?.onRepairAttempt?.(reason, category);
                else options?.onRepairAttempt?.(reason);
              },
              validateCandidate: (providerCandidate) => {
                assertGenerationSnapshotCurrent();
                return validateObjectiveAuthoritySemanticRepairProposal(
                  repairBatch,
                  providerCandidate,
                );
              },
            }),
        });
        assertGenerationSnapshotCurrent();
        const application = applyObjectiveAuthoritySemanticRepairProposal(
          repairBatch,
          repairProposal,
        );
        if (!application.validation.valid || !application.payload) {
          throw new AppError(
            ApiErrorCode.GroundingFailed,
            'The bounded objective-authority repair failed local validation.',
            {
              kind: 'objective_authority_semantic_repair_invalid',
              diagnosticCodes: application.validation.diagnosticCodes ?? [],
              diagnostics: application.validation.diagnostics.slice(0, 20),
              repairAttempted: true,
            },
          );
        }
        payload = application.payload;
        const repairedCapabilityRecoveryValidation = validateCurriculumCapabilityRecoveryCandidate(
          payload,
          capabilityRecoveryFrontier,
        );
        if (!repairedCapabilityRecoveryValidation.valid) {
          throw new AppError(
            ApiErrorCode.GroundingFailed,
            'The bounded repair changed the immutable predecessor capability frontier.',
            {
              kind: 'curriculum_capability_recovery_repair_invalid',
              diagnosticCodes: repairedCapabilityRecoveryValidation.diagnosticCodes ?? [],
              diagnostics: repairedCapabilityRecoveryValidation.diagnostics.slice(0, 20),
              repairAttempted: true,
            },
          );
        }
        materialized = validateExecutionRepairCandidate({
          repos,
          clock,
          contract,
          executionRepairRequired: requiredExecutionPreflight,
          workspaceName: workspace.name,
          manifest: context.manifest,
          materialized: materializeCurriculumProposal(payload, validationContext),
        });
        lastCandidateValidation = materialized;
        assertValidMaterializedCurriculum(materialized, repairAttempted);
        materializedCapabilityRecovery = bindMaterializedCurriculumCapabilityRecovery({
          candidate: payload,
          objectiveIdByProposalKey: materialized.objectiveIdByProposalKey ?? new Map(),
          frontier: capabilityRecoveryFrontier,
        });
        const requiredCapabilityPreservationByObjectiveId = new Map<
          string,
          ObjectiveAuthorityRequiredCapabilityPreservation
        >();
        for (const [
          objectiveKey,
          requirement,
        ] of repairBatch.requiredCapabilityPreservationByObjectiveKey) {
          const objectiveId = materialized.objectiveIdByProposalKey?.get(objectiveKey);
          if (!objectiveId || requiredCapabilityPreservationByObjectiveId.has(objectiveId)) {
            throw new AppError(
              ApiErrorCode.GroundingFailed,
              'The repaired objective cannot be bound to its original capability requirement.',
              {
                kind: 'objective_authority_semantic_preservation_binding_failed',
                objectiveKey,
                repairAttempted: true,
              },
            );
          }
          requiredCapabilityPreservationByObjectiveId.set(objectiveId, requirement);
        }
        for (const [
          objectiveId,
          requirement,
        ] of materializedCapabilityRecovery.requiredCapabilityPreservationByObjectiveId) {
          const existing = requiredCapabilityPreservationByObjectiveId.get(objectiveId);
          if (existing && JSON.stringify(existing) !== JSON.stringify(requirement)) {
            throw new AppError(
              ApiErrorCode.GroundingFailed,
              'The repaired objective changed its predecessor capability-preservation requirement.',
              {
                kind: 'objective_authority_semantic_preservation_requirement_mismatch',
                objectiveId,
                repairAttempted: true,
              },
            );
          }
          requiredCapabilityPreservationByObjectiveId.set(objectiveId, requirement);
        }
        const freshEvaluation = await evaluateObjectiveAuthority(
          materialized,
          'post_repair',
          requiredCapabilityPreservationByObjectiveId,
          materializedCapabilityRecovery.recoveryOriginByObjectiveId,
        );
        materialized = freshEvaluation.materialized;
        if (freshEvaluation.failedObjectiveIds.length > 0) {
          throw new AppError(
            ApiErrorCode.GroundingFailed,
            'Curriculum objectives remain semantically unsupported after one bounded repair.',
            {
              kind: 'objective_authority_semantic_support_failed',
              failedObjectiveIds: freshEvaluation.failedObjectiveIds,
              repairAttempted: true,
            },
          );
        }
      }
      const now = clock.now().toISOString();
      let curriculum: Curriculum = {
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
      assertCurrentCurriculumObjectiveAuthoritySemanticSupport(curriculum, {
        boundary: 'proposal',
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      });
      assertCurriculumCapabilityRecoveryLineage(curriculum, capabilityRecoveryFrontier);
      const semantic = evaluateCurriculumSemantics({
        curriculum,
        sourceMapFingerprint: sourceMap.fingerprint,
        sourceRegions: semanticSourceRegions,
        scope:
          contract.desiredDepth === 'high_performance' || contract.desiredDepth === 'deep_transfer'
            ? 'systematic_mastery'
            : 'intentional_scope',
        evaluatedAt: now,
      });
      if (semantic.evaluation.status === 'fail') {
        const semanticErrors = semantic.evaluation.findings
          .filter((finding) => finding.severity === 'error')
          .map(
            (finding) => `Pedagogical Curriculum quality: ${finding.code} - ${finding.rationale}`,
          );
        materialized.validation = {
          ...materialized.validation,
          valid: false,
          errors: [...materialized.validation.errors, ...semanticErrors].slice(0, 100),
        };
        assertValidMaterializedCurriculum(materialized, repairAttempted);
      }
      curriculum = {
        ...curriculum,
        coverageAccountability: semantic.coverage,
        qualityEvaluation: semantic.evaluation,
      };
      return commands.complete(claim, () => {
        assertGenerationSnapshotCurrent();
        repos.curricula.createManifest(
          newId('manifest'),
          curriculum.workspaceId,
          curriculum.executionSourceManifest,
          now,
        );
        const stored = repos.curricula.createVersion(
          curriculum,
          {
            id: newId('curriculum_evt'),
            eventType: 'proposed',
            actor: parsed.command.actor,
            payload: {
              contractId: contract.id,
              manifestFingerprint: context.manifest.fingerprint,
              generationOperationId: claim.operationId,
              ...(opts?.preparationPolicyId
                ? { preparationPolicyId: opts.preparationPolicyId }
                : {}),
            },
            createdAt: now,
          },
          {
            capabilityRecoveryPredecessorId:
              capabilityRecoveryFrontier?.predecessorCurriculumId ?? null,
          },
        );
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
      const detailPlanningFailure = curriculumDetailPlanningFailure(error);
      if (detailPlanningFailure) {
        failure = new AppError(
          ApiErrorCode.ValidationError,
          '当前课程结构无法在固定的详细规划预算内完成，本次没有修改现有课程结构。',
          {
            kind: 'curriculum_detail_batch_bound_exceeded',
            maxDetailBatches: MAX_DETAIL_BATCHES,
            diagnostics: detailPlanningFailure.diagnostics,
            diagnosticCodes: detailPlanningFailure.diagnosticCodes,
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
        (!failedCandidate.validation.valid || failedCandidate.authorityCritiques.length > 0)
      ) {
        try {
          assertValidMaterializedCurriculum(failedCandidate, repairAttempted, true);
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
      assertCurrentCurriculumObjectiveAuthoritySemanticSupport(current, {
        boundary: 'acceptance',
        isBlockingEligible: (authorityRecordId) =>
          repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      });
      if (parsed.acceptanceBasis === 'explicit_local_policy') {
        const proposalEvent = repos.curricula
          .listEvents(current.id)
          .find((event) => event.eventType === 'proposed');
        const preparationPolicyId =
          typeof proposalEvent?.payload === 'object' &&
          proposalEvent.payload !== null &&
          'preparationPolicyId' in proposalEvent.payload
            ? proposalEvent.payload.preparationPolicyId
            : null;
        if (
          parsed.command.actor !== 'local' ||
          proposalEvent?.actor !== 'local' ||
          preparationPolicyId !== COURSE_PREPARATION_POLICY_ID
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Local Curriculum acceptance requires the Course Preparation policy.',
          );
        }
        const preflight = preflightStudyPlan(
          repos,
          clock,
          contract,
          current,
          repos.workspaces.get(current.workspaceId)?.name ?? 'Course',
        );
        if (!preflight.canGenerate) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Course Preparation cannot accept a non-executable Curriculum.',
            { preflightReasonCodes: preflight.blockers.map((blocker) => blocker.code) },
          );
        }
      }
      const predecessor = current.predecessorId
        ? (repos.curricula.get(current.predecessorId) ?? null)
        : null;
      const workspaceName = repos.workspaces.get(current.workspaceId)?.name ?? 'Course';
      const executionRepairRequired =
        requiresStudyPlanExecutionRepair(repos, clock, contract, predecessor, workspaceName) ||
        acceptedCurriculumCapabilityRecoveryPredecessor(
          repos,
          clock,
          contract,
          current.executionSourceManifest,
          predecessor,
          workspaceName,
        ) !== null;
      if (executionRepairRequired) {
        const preflight = preflightStudyPlan(repos, clock, contract, current, workspaceName);
        const errors = executionRepairErrors(preflight);
        if (errors.length > 0) {
          assertValidMaterializedCurriculum({
            nodes: current.nodes,
            synthesisGroups: current.synthesisGroups,
            authorityCritiques: [],
            validation: {
              ...current.validation,
              valid: false,
              errors: [...current.validation.errors, ...errors].slice(0, 100),
            },
          });
        }
      }
      return commands.complete(claim, () => {
        assertCurrentCurriculumObjectiveAuthoritySemanticSupport(
          requireCurriculum(current.workspaceId, current.id),
          {
            boundary: 'acceptance',
            isBlockingEligible: (authorityRecordId) =>
              repos.sourceAuthority.isBlockingEligible(authorityRecordId),
          },
        );
        if (repos.curricula.list(current.workspaceId).at(-1)?.id !== current.id) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Curriculum is no longer the latest version.',
          );
        }
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
