import { createHash } from 'node:crypto';
import {
  type CanonicalConcept,
  type CanonicalMember,
  type CourseMapAnalysis,
  type Curriculum,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
  type LearningContract,
  type SourceBlock,
  type StudyPlanPreflight,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { computeSections } from '../ingestion/sections.js';
import { MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL } from '../llm/provider.js';
import type {
  CurriculumProposalInput,
  LlmProvider,
  ProviderCallOptions,
  ProviderRepairReason,
  ProviderUsage,
} from '../llm/provider.js';
import {
  measureCourseMapRequest,
  measureCurriculumDetailRequest,
  measureCurriculumRequest,
} from '../llm/prompts.js';
import type { Repositories } from '../repositories/index.js';
import {
  buildCourseMapProposalInput,
  buildCourseMapSourceAllocation,
  generateCourseMapPrototype,
} from '../services/courseMap.js';
import {
  COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  CURRICULUM_PROVIDER_TIMEOUT_MS,
  LEGACY_CURRICULUM_GENERATION_POLICY,
  buildCurriculumCourseSourceMap,
  buildCurriculumExecutionContext,
  buildOfferedCurriculumKnowledge,
  curriculumLimits,
  requiresStudyPlanExecutionRepair,
  validateExecutionRepairCandidate,
  type CurriculumGenerationPolicy,
} from '../services/curriculum.js';
import {
  buildCurriculumEvidenceCatalog,
  selectCurriculumEvidenceOffersWithTrace,
  type CurriculumEvidenceSelectionTrace,
} from '../services/curriculumEvidence.js';
import { CURRICULUM_EVIDENCE_PRODUCTION_POLICY } from '../services/curriculumEvidencePolicy.js';
import {
  MAX_DETAIL_BATCHES,
  assembleCurriculumDetailBatches,
  planCurriculumDetailBatches,
  validateCurriculumDetailCandidate,
} from '../services/curriculumMaterialization.js';
import {
  assertValidMaterializedCurriculum,
  materializeCurriculumProposal,
  type CurriculumValidationContext,
  type MaterializedCurriculum,
} from '../services/curriculumValidation.js';
import {
  buildUnitLaunchProfiles,
  type UnitLaunchProfile,
} from '../services/studyPlanValidation.js';
import { preflightStudyPlan } from '../services/studyPlansAgent.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { evaluateCurriculumQuality, type CurriculumQualityProfile } from './curriculumQuality.js';

export interface PrepareCurriculumPolicyEvaluationInput {
  workspaceId: string;
  contractId: string;
  expectedContractVersion: number;
  predecessorCurriculumId: string | null;
}

interface EvaluationBindingAuthority {
  concepts: ReturnType<typeof buildOfferedCurriculumKnowledge>['concepts'];
  canonicalConcepts: CanonicalConcept[];
  canonicalMemberships: CanonicalMember[];
}

export interface PreparedCurriculumPolicyEvaluation {
  fingerprint: string;
  workspaceId: string;
  workspaceName: string;
  contract: LearningContract;
  predecessor: Curriculum | null;
  context: ReturnType<typeof buildCurriculumExecutionContext>;
  knowledge: ReturnType<typeof buildOfferedCurriculumKnowledge>;
  sourceMap: ReturnType<typeof buildCurriculumCourseSourceMap>;
  evidenceOffers: CurriculumProposalInput['evidenceCatalog'];
  evidenceTrace: CurriculumEvidenceSelectionTrace;
  providerInput: CurriculumProposalInput;
  validationContext: CurriculumValidationContext;
  sourceCorpus: Array<{
    materialId: string;
    materialRevisionId: string;
    title: string;
    blocks: SourceBlock[];
  }>;
  bindingAuthority: EvaluationBindingAuthority;
}

type EvaluationProviderOptions = Omit<
  ProviderCallOptions,
  'telemetry' | 'validateCandidate' | 'onRepairAttempt' | 'onRequestSent' | 'onUsage'
> & {
  onRepairAttempt?: ProviderCallOptions['onRepairAttempt'];
  onRequestSent?: ProviderCallOptions['onRequestSent'];
  onUsage?: ProviderCallOptions['onUsage'];
};

type RequestMeasure =
  | ReturnType<typeof measureCurriculumRequest>
  | ReturnType<typeof measureCourseMapRequest>
  | ReturnType<typeof measureCurriculumDetailRequest>;

export interface CurriculumEvaluationStageTelemetry {
  stage: 'legacy_curriculum' | 'course_map' | 'curriculum_detail';
  detailBatchIndex: number | null;
  logicalCallId: string;
  schemaFingerprint: string;
  sourceFingerprint: string;
  logicalCalls: 1;
  physicalCalls: number;
  repairReasons: ProviderRepairReason[];
  usage: ProviderUsage[];
  latencyMs: number;
  request: RequestMeasure;
}

export interface CurriculumEvidenceUseSection {
  sectionKey: string;
  materialId: string;
  title: string;
  sourceOrder: number;
  providerVisibleBlockCount: number;
  selectedBlockCount: number;
  unusedVisibleBlockCount: number;
  visibleUseRatio: number | null;
}

export interface CurriculumEvidenceUseMetrics {
  candidateBlockCount: number;
  providerVisibleOfferCount: number;
  providerVisibleBlockCount: number;
  selectedSourceReferenceCount: number;
  selectedUniqueBlockCount: number;
  selectedCandidateBlockCount: number;
  selectedProviderVisibleBlockCount: number;
  candidateUseRatio: number | null;
  providerVisibleUseRatio: number | null;
  unusedProviderVisibleBlockIds: string[];
  selectedBlocksOutsideProviderVisibility: string[];
  sections: CurriculumEvidenceUseSection[];
  maximumSelectedSectionShare: number | null;
  maximumSelectedMaterialShare: number | null;
  lateVisibleBlockCount: number;
  lateSelectedBlockCount: number;
  lateVisibleUseRatio: number | null;
}

export interface CurriculumCourseMapEvaluation {
  analysis: CourseMapAnalysis;
  detailBatchCount: number;
  skeletonPrerequisiteCount: number;
  finalPrerequisiteCount: number;
  lostPrerequisiteCount: number;
  regionAllocationComplete: boolean;
}

export interface CurriculumPolicyEvaluationResult {
  schemaVersion: 1;
  inputFingerprint: string;
  policy: CurriculumGenerationPolicy;
  provider: LlmProvider['name'];
  providerModel: string | null;
  curriculum: Curriculum;
  studyPlanPreflight: StudyPlanPreflight;
  unitLaunchProfiles: UnitLaunchProfile[];
  qualityProfile: CurriculumQualityProfile;
  evidenceSelectionTrace: CurriculumEvidenceSelectionTrace;
  evidenceUse: CurriculumEvidenceUseMetrics;
  stages: CurriculumEvaluationStageTelemetry[];
  totals: {
    logicalCalls: number;
    physicalCalls: number;
    repairs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    estimatedCostMicrounits: number | null;
    currency: string | null;
    latencyMs: number;
  };
  courseMap: CurriculumCourseMapEvaluation | null;
}

export class CurriculumPolicyEvaluationError extends Error {
  readonly inputFingerprint: string;
  readonly policy: CurriculumGenerationPolicy;
  readonly stages: CurriculumEvaluationStageTelemetry[];
  override readonly cause: unknown;

  constructor(
    inputFingerprint: string,
    policy: CurriculumGenerationPolicy,
    stages: CurriculumEvaluationStageTelemetry[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Curriculum policy evaluation failed.');
    this.name = 'CurriculumPolicyEvaluationError';
    this.inputFingerprint = inputFingerprint;
    this.policy = policy;
    this.stages = stages;
    this.cause = cause;
  }
}

function fingerprint(value: unknown): string {
  return `curriculum_eval_${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function requireContract(
  repos: Repositories,
  input: PrepareCurriculumPolicyEvaluationInput,
): LearningContract {
  const contract = repos.learningContracts.get(input.contractId);
  if (!contract || contract.workspaceId !== input.workspaceId) {
    throw notFound('Learning Contract not found.');
  }
  if (contract.version !== input.expectedContractVersion) {
    throw new AppError('VERSION_CONFLICT', 'Learning Contract version is stale.');
  }
  if (contract.status !== 'learner_confirmed' && contract.status !== 'active') {
    throw new AppError(
      'VALIDATION_ERROR',
      'Curriculum evaluation requires a learner-confirmed Learning Contract.',
    );
  }
  return contract;
}

function bindingAuthority(
  repos: Repositories,
  workspaceId: string,
  concepts: PreparedCurriculumPolicyEvaluation['knowledge']['concepts'],
): EvaluationBindingAuthority {
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const views = repos.alignment
    .listCanonical(workspaceId)
    .filter((view) => view.members.some((member) => conceptIds.has(member.sourceConceptId)));
  return {
    concepts,
    canonicalConcepts: views.map((view) => ({
      id: view.id,
      workspaceId: view.workspaceId,
      displayName: view.displayName,
      normalizedKey: view.normalizedKey,
      description: view.description,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    })),
    canonicalMemberships: views.flatMap((view) =>
      view.members.filter((member) => conceptIds.has(member.sourceConceptId)),
    ),
  };
}

/** Freeze the exact read-only production planning input once for all paired runs. */
export function prepareCurriculumPolicyEvaluation(
  repos: Repositories,
  input: PrepareCurriculumPolicyEvaluationInput,
): PreparedCurriculumPolicyEvaluation {
  const workspace = repos.workspaces.get(input.workspaceId);
  if (!workspace) throw notFound('Course not found.');
  const contract = requireContract(repos, input);
  const predecessor = input.predecessorCurriculumId
    ? (repos.curricula.get(input.predecessorCurriculumId) ?? null)
    : null;
  if (input.predecessorCurriculumId && (!predecessor || predecessor.workspaceId !== workspace.id)) {
    throw notFound('Predecessor Curriculum not found.');
  }

  const context = buildCurriculumExecutionContext(repos, contract);
  const knowledge = buildOfferedCurriculumKnowledge(repos, workspace.id, context);
  const sourceMap = buildCurriculumCourseSourceMap(context, knowledge.concepts, predecessor);
  const predecessorAuthorityIds = new Set(
    predecessor?.nodes.flatMap(
      (node) =>
        node.learningUnit?.objectives.flatMap((objective) => objective.truthAuthorityRecordIds) ??
        [],
    ) ?? [],
  );
  const preferredGroundings = [
    ...knowledge.concepts.map((concept) => concept.grounding),
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
  const priorityGroundings = [
    ...knowledge.concepts.map((concept) => concept.grounding),
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
  const fullCatalog = buildCurriculumEvidenceCatalog({
    workspaceId: workspace.id,
    manifest: context.manifest,
    blocks: context.blocks,
    preferredGroundings,
  });
  const evidence = selectCurriculumEvidenceOffersWithTrace({
    catalog: fullCatalog,
    blocks: context.blocks,
    predecessor,
    concepts: knowledge.concepts,
    contract,
    priorityGroundings,
    sourceMap,
    policy: CURRICULUM_EVIDENCE_PRODUCTION_POLICY,
  });
  const providerInput: CurriculumProposalInput = {
    workspaceName: workspace.name,
    contract: context.contractContext,
    executionSourceManifest: context.manifest,
    outline: context.outline,
    concepts: knowledge.concepts,
    graphEdges: knowledge.graphEdges,
    allowedCanonicalConceptIds: knowledge.allowedCanonicalConceptIds,
    canonicalConcepts: knowledge.canonicalConcepts,
    predecessor,
    blocks: context.blocks,
    evidenceCatalog: evidence.offers,
    limits: curriculumLimits(context.outline, predecessor),
  };
  const structuralUnitOwners = new Map(
    context.outline.flatMap((item) =>
      item.structuralUnitId
        ? [
            [
              item.structuralUnitId,
              { materialId: item.materialId, materialRevisionId: item.materialRevisionId },
            ] as const,
          ]
        : [],
    ),
  );
  const eligibleAuthorityIds = new Set(
    context.authorityBundles
      .filter((bundle) => repos.sourceAuthority.isBlockingEligible(bundle.record.id))
      .map((bundle) => bundle.record.id),
  );
  const validationContext: CurriculumValidationContext = {
    workspaceId: workspace.id,
    courseTitle: workspace.name,
    executionSourceManifest: context.manifest,
    blocks: context.blocks,
    concepts: knowledge.concepts,
    graphEdges: knowledge.graphEdges,
    structuralUnitOwners,
    canonicalConceptIds: new Set(knowledge.allowedCanonicalConceptIds),
    canonicalConceptMembers: new Map(
      knowledge.canonicalConcepts.map((canonical) => [
        canonical.id,
        [...canonical.sourceConceptIds].sort((left, right) => left.localeCompare(right)),
      ]),
    ),
    canonicalConceptIdsBySourceConcept: knowledge.canonicalConcepts.reduce((memberships, item) => {
      for (const conceptId of item.sourceConceptIds) {
        const ids = memberships.get(conceptId) ?? [];
        ids.push(item.id);
        memberships.set(conceptId, ids);
      }
      return memberships;
    }, new Map<string, string[]>()),
    evidenceCatalog: evidence.offers.map((offer) => ({
      ...offer,
      headingPath: [...offer.headingPath],
    })),
    limits: providerInput.limits,
    authorityBundles: context.authorityBundles,
    isAuthorityBlockingEligible: (id) => eligibleAuthorityIds.has(id),
  };
  const titleByMaterialId = new Map(
    context.contractContext.materials.map((material) => [material.materialId, material.title]),
  );
  const sourceCorpus = context.manifest.revisions.map((revision) => ({
    materialId: revision.materialId,
    materialRevisionId: revision.materialRevisionId,
    title: titleByMaterialId.get(revision.materialId) ?? revision.materialId,
    blocks: context.blocks.filter((block) => block.materialId === revision.materialId),
  }));
  const authority = bindingAuthority(repos, workspace.id, knowledge.concepts);
  const preparedFingerprint = fingerprint({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    contract,
    predecessor,
    manifest: context.manifest,
    blocks: context.blocks,
    authorityBundles: context.authorityBundles,
    concepts: knowledge.concepts,
    graphEdges: knowledge.graphEdges,
    canonicalConcepts: knowledge.canonicalConcepts,
    sourceMap,
    evidenceOffers: evidence.offers,
    evidenceTrace: evidence.trace,
  });
  return {
    fingerprint: preparedFingerprint,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    contract,
    predecessor,
    context,
    knowledge,
    sourceMap,
    evidenceOffers: evidence.offers,
    evidenceTrace: evidence.trace,
    providerInput,
    validationContext,
    sourceCorpus,
    bindingAuthority: authority,
  };
}

function sumKnown(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + value!, 0)
    : null;
}

function evidenceUseMetrics(
  prepared: PreparedCurriculumPolicyEvaluation,
  curriculum: Curriculum,
  visibleOffers: CurriculumProposalInput['evidenceCatalog'],
): CurriculumEvidenceUseMetrics {
  const candidateBlockIds = new Set(prepared.evidenceTrace.blocks.map((item) => item.blockId));
  const visibleBlockIds = new Set(visibleOffers.map((offer) => offer.blockId));
  const sourceReferences = curriculum.nodes.flatMap((node) =>
    node.sourceReferences.filter((reference) => reference.sourceBlockId !== null),
  );
  const selectedBlockIds = new Set(sourceReferences.map((reference) => reference.sourceBlockId!));
  const selectedCandidateBlockCount = [...selectedBlockIds].filter((id) =>
    candidateBlockIds.has(id),
  ).length;
  const selectedProviderVisibleBlockCount = [...selectedBlockIds].filter((id) =>
    visibleBlockIds.has(id),
  ).length;
  const sectionRows: Array<{
    sectionKey: string;
    materialId: string;
    title: string;
    sourceOrder: number;
    blockIds: string[];
  }> = [];
  let sourceOrder = 0;
  for (const material of prepared.sourceCorpus) {
    for (const section of computeSections(material.blocks)) {
      sectionRows.push({
        sectionKey: `${material.materialId}:${section.key}`,
        materialId: material.materialId,
        title: section.title,
        sourceOrder,
        blockIds: section.blocks.map((block) => block.id),
      });
      sourceOrder += 1;
    }
  }
  const sections = sectionRows.map((section) => {
    const providerVisibleBlockCount = section.blockIds.filter((id) =>
      visibleBlockIds.has(id),
    ).length;
    const selectedBlockCount = section.blockIds.filter((id) => selectedBlockIds.has(id)).length;
    return {
      sectionKey: section.sectionKey,
      materialId: section.materialId,
      title: section.title,
      sourceOrder: section.sourceOrder,
      providerVisibleBlockCount,
      selectedBlockCount,
      unusedVisibleBlockCount: section.blockIds.filter(
        (id) => visibleBlockIds.has(id) && !selectedBlockIds.has(id),
      ).length,
      visibleUseRatio: ratio(selectedBlockCount, providerVisibleBlockCount),
    };
  });
  const selectedByMaterial = new Map<string, number>();
  for (const blockId of selectedBlockIds) {
    const block = prepared.context.blocks.find((candidate) => candidate.id === blockId);
    if (block) {
      selectedByMaterial.set(block.materialId, (selectedByMaterial.get(block.materialId) ?? 0) + 1);
    }
  }
  const lateStart = Math.floor(prepared.context.blocks.length * 0.75);
  const lateBlockIds = new Set(prepared.context.blocks.slice(lateStart).map((block) => block.id));
  const lateVisibleBlockCount = [...visibleBlockIds].filter((id) => lateBlockIds.has(id)).length;
  const lateSelectedBlockCount = [...selectedBlockIds].filter(
    (id) => lateBlockIds.has(id) && visibleBlockIds.has(id),
  ).length;
  return {
    candidateBlockCount: candidateBlockIds.size,
    providerVisibleOfferCount: visibleOffers.length,
    providerVisibleBlockCount: visibleBlockIds.size,
    selectedSourceReferenceCount: sourceReferences.length,
    selectedUniqueBlockCount: selectedBlockIds.size,
    selectedCandidateBlockCount,
    selectedProviderVisibleBlockCount,
    candidateUseRatio: ratio(selectedCandidateBlockCount, candidateBlockIds.size),
    providerVisibleUseRatio: ratio(selectedProviderVisibleBlockCount, visibleBlockIds.size),
    unusedProviderVisibleBlockIds: [...visibleBlockIds].filter((id) => !selectedBlockIds.has(id)),
    selectedBlocksOutsideProviderVisibility: [...selectedBlockIds].filter(
      (id) => !visibleBlockIds.has(id),
    ),
    sections,
    maximumSelectedSectionShare:
      selectedBlockIds.size === 0
        ? null
        : Math.max(0, ...sections.map((section) => section.selectedBlockCount)) /
          selectedBlockIds.size,
    maximumSelectedMaterialShare:
      selectedBlockIds.size === 0
        ? null
        : Math.max(0, ...selectedByMaterial.values()) / selectedBlockIds.size,
    lateVisibleBlockCount,
    lateSelectedBlockCount,
    lateVisibleUseRatio: ratio(lateSelectedBlockCount, lateVisibleBlockCount),
  };
}

interface RunStageInput<T> {
  stage: CurriculumEvaluationStageTelemetry['stage'];
  detailBatchIndex?: number;
  schemaFingerprint: string;
  sourceFingerprint: string;
  request: RequestMeasure;
  invoke: (options: ProviderCallOptions) => Promise<T>;
}

export async function evaluateCurriculumPolicy(
  prepared: PreparedCurriculumPolicyEvaluation,
  policy: CurriculumGenerationPolicy,
  deps: { provider: LlmProvider; repos: Repositories; clock: Clock },
  providerOptions: EvaluationProviderOptions = {},
): Promise<CurriculumPolicyEvaluationResult> {
  if (
    policy !== LEGACY_CURRICULUM_GENERATION_POLICY &&
    policy !== COURSE_MAP_CURRICULUM_GENERATION_POLICY
  ) {
    throw new AppError('VALIDATION_ERROR', 'Unknown Curriculum generation policy.');
  }
  const stages: CurriculumEvaluationStageTelemetry[] = [];
  const runStage = async <T>(input: RunStageInput<T>): Promise<T> => {
    const logicalCallId = newId('llm_call');
    const repairReasons: ProviderRepairReason[] = [];
    const usage: ProviderUsage[] = [];
    let physicalCalls = 0;
    const startedAt = Date.now();
    try {
      return await input.invoke({
        ...providerOptions,
        timeoutMs: providerOptions.timeoutMs ?? CURRICULUM_PROVIDER_TIMEOUT_MS,
        onRequestSent: () => {
          physicalCalls += 1;
          providerOptions.onRequestSent?.();
        },
        onRepairAttempt: (reason = 'schema') => {
          repairReasons.push(reason);
          providerOptions.onRepairAttempt?.(reason);
        },
        onUsage: (reported) => {
          usage.push(reported);
          providerOptions.onUsage?.(reported);
        },
        telemetry: {
          workspaceId: null,
          operationType: 'evaluate_curriculum_policy',
          logicalCallId,
          schemaFingerprint: input.schemaFingerprint,
          policyFingerprint: policy,
          sourceFingerprint: input.sourceFingerprint,
        },
      });
    } finally {
      stages.push({
        stage: input.stage,
        detailBatchIndex: input.detailBatchIndex ?? null,
        logicalCallId,
        schemaFingerprint: input.schemaFingerprint,
        sourceFingerprint: input.sourceFingerprint,
        logicalCalls: 1,
        physicalCalls,
        repairReasons,
        usage,
        latencyMs: Math.max(0, Date.now() - startedAt),
        request: input.request,
      });
    }
  };

  try {
    let materialized: MaterializedCurriculum;
    let visibleOffers = prepared.evidenceOffers;
    let courseMapEvaluation: CurriculumCourseMapEvaluation | null = null;
    const executionRepairRequired = requiresStudyPlanExecutionRepair(
      deps.repos,
      deps.clock,
      prepared.contract,
      prepared.predecessor,
      prepared.workspaceName,
    );
    if (policy === LEGACY_CURRICULUM_GENERATION_POLICY) {
      let lastCandidate: MaterializedCurriculum | null = null;
      const payload = await runStage({
        stage: 'legacy_curriculum',
        schemaFingerprint: 'curriculum-proposal-v2-evidence-identity',
        sourceFingerprint: prepared.context.manifest.fingerprint,
        request: measureCurriculumRequest(prepared.providerInput),
        invoke: (options) =>
          deps.provider.proposeCurriculum(prepared.providerInput, {
            ...options,
            validateCandidate: (candidate) => {
              lastCandidate = validateExecutionRepairCandidate({
                repos: deps.repos,
                clock: deps.clock,
                contract: prepared.contract,
                executionRepairRequired,
                workspaceName: prepared.workspaceName,
                manifest: prepared.context.manifest,
                materialized: materializeCurriculumProposal(
                  candidate as CurriculumProposalPayload,
                  prepared.validationContext,
                ),
              });
              return {
                valid: lastCandidate.validation.valid,
                diagnostics: lastCandidate.validation.errors,
                diagnosticCodes: lastCandidate.validation.valid
                  ? []
                  : ['curriculum_candidate_invalid'],
              };
            },
          }),
      });
      materialized =
        lastCandidate ??
        validateExecutionRepairCandidate({
          repos: deps.repos,
          clock: deps.clock,
          contract: prepared.contract,
          executionRepairRequired,
          workspaceName: prepared.workspaceName,
          manifest: prepared.context.manifest,
          materialized: materializeCurriculumProposal(payload, prepared.validationContext),
        });
    } else {
      const sourceAllocation = buildCourseMapSourceAllocation({
        workspaceId: prepared.workspaceId,
        sourceMap: prepared.sourceMap,
        blocks: prepared.context.blocks,
        evidenceCatalog: prepared.evidenceOffers,
      });
      visibleOffers = sourceAllocation.regions.flatMap((region) =>
        region.evidence.flatMap((visibility) => {
          const offer = prepared.evidenceOffers.find(
            (candidate) => candidate.id === visibility.evidenceId,
          );
          return offer ? [offer] : [];
        }),
      );
      const courseMapProviderInput = buildCourseMapProposalInput({
        workspaceName: prepared.workspaceName,
        contract: prepared.context.contractContext,
        sourceAllocation,
        concepts: prepared.knowledge.concepts,
        canonicalConcepts: prepared.knowledge.canonicalConcepts,
      });
      const courseMapResult = await runStage({
        stage: 'course_map',
        schemaFingerprint: 'course-map-proposal-v2-local-refs',
        sourceFingerprint: sourceAllocation.fingerprint,
        request: measureCourseMapRequest(courseMapProviderInput),
        invoke: (options) =>
          generateCourseMapPrototype(
            {
              provider: deps.provider,
              providerInput: courseMapProviderInput,
              sourceAllocation,
            },
            options,
          ),
      });
      const detailBatches = planCurriculumDetailBatches({
        workspaceName: prepared.workspaceName,
        contract: prepared.context.contractContext,
        courseMap: courseMapResult.analysis.courseMap,
        sourceAllocation,
        evidenceCatalog: prepared.evidenceOffers,
        concepts: prepared.knowledge.concepts,
        canonicalConcepts: prepared.knowledge.canonicalConcepts,
      });
      if (detailBatches.length > MAX_DETAIL_BATCHES) {
        throw new Error('Curriculum evaluation exceeded the fixed detail-batch ceiling.');
      }
      const completedBatches: Array<{
        input: (typeof detailBatches)[number]['input'];
        payload: CurriculumDetailProposalPayload;
      }> = [];
      for (const batch of detailBatches) {
        const payload = await runStage({
          stage: 'curriculum_detail',
          detailBatchIndex: batch.index,
          schemaFingerprint: 'curriculum-detail-proposal-v1',
          sourceFingerprint: `${sourceAllocation.fingerprint}:${batch.input.batchKey}`,
          request: measureCurriculumDetailRequest(batch.input),
          invoke: (options) =>
            deps.provider.proposeCurriculumDetails(batch.input, {
              ...options,
              validateCandidate: (candidate) =>
                validateCurriculumDetailCandidate(candidate, batch.input),
            }),
        });
        completedBatches.push({ input: batch.input, payload });
      }
      const assembly = assembleCurriculumDetailBatches(
        courseMapResult.analysis.courseMap,
        completedBatches,
      );
      materialized = validateExecutionRepairCandidate({
        repos: deps.repos,
        clock: deps.clock,
        contract: prepared.contract,
        executionRepairRequired: true,
        workspaceName: prepared.workspaceName,
        manifest: prepared.context.manifest,
        materialized: materializeCurriculumProposal(assembly.payload, prepared.validationContext),
      });
      const finalLearningUnits = materialized.nodes.filter((node) => node.kind === 'learning_unit');
      const finalPrerequisiteCount = finalLearningUnits.reduce(
        (count, node) => count + (node.learningUnit?.prerequisiteUnitIds.length ?? 0),
        0,
      );
      const lostPrerequisiteCount = Math.max(
        0,
        assembly.prerequisiteCount - finalPrerequisiteCount,
      );
      if (
        finalLearningUnits.length !== assembly.regionCount ||
        finalPrerequisiteCount !== assembly.prerequisiteCount
      ) {
        throw new Error('Course Map structure was lost during final Curriculum materialization.');
      }
      courseMapEvaluation = {
        analysis: courseMapResult.analysis,
        detailBatchCount: detailBatches.length,
        skeletonPrerequisiteCount: courseMapResult.analysis.courseMap.prerequisites.length,
        finalPrerequisiteCount,
        lostPrerequisiteCount,
        regionAllocationComplete:
          courseMapResult.analysis.qualityProfile.sourceAllocation.unallocatedSourceRegionCount ===
            0 &&
          courseMapResult.analysis.qualityProfile.sourceAllocation.duplicateAllocationCount === 0 &&
          courseMapResult.analysis.qualityProfile.sourceAllocation.unsupportedRegionCount === 0,
      };
    }

    assertValidMaterializedCurriculum(
      materialized,
      stages.some((stage) => stage.repairReasons.length > 0),
    );
    const createdAt = deps.clock.now().toISOString();
    const curriculum: Curriculum = {
      id: `evaluation_curriculum_${createHash('sha256')
        .update(
          `${prepared.fingerprint}:${policy}:${createdAt}:${stages.map((stage) => stage.logicalCallId).join(':')}`,
        )
        .digest('hex')
        .slice(0, 24)}`,
      workspaceId: prepared.workspaceId,
      contractVersionId: prepared.contract.id,
      version: (prepared.predecessor?.version ?? 0) + 1,
      predecessorId: prepared.predecessor?.id ?? null,
      status: 'proposed',
      executionSourceManifest: prepared.context.manifest,
      nodes: materialized.nodes,
      synthesisGroups: materialized.synthesisGroups,
      validation: materialized.validation,
      provider: deps.provider.name,
      providerModel: deps.provider.name === 'hy3' ? (deps.provider.model ?? null) : null,
      createdAt,
      acceptedAt: null,
    };
    const studyPlanPreflight = preflightStudyPlan(
      deps.repos,
      deps.clock,
      prepared.contract,
      curriculum,
      prepared.workspaceName,
    );
    const unitLaunchProfiles = buildUnitLaunchProfiles(
      deps.repos,
      deps.clock,
      prepared.workspaceId,
      curriculum,
    );
    const profileByUnitId = new Map(
      unitLaunchProfiles.map((profile) => [profile.curriculumLearningUnitId, profile]),
    );
    const execution = curriculum.nodes
      .filter((node) => node.kind === 'learning_unit' && node.learningUnit)
      .map((node) => {
        const profile = profileByUnitId.get(node.id);
        const executable = (profile?.allowedItemKinds.length ?? 0) > 0;
        return {
          learningUnitId: node.id,
          executable,
          frontierEligible: executable && node.learningUnit!.prerequisiteUnitIds.length === 0,
          reasonCodes: executable ? profile!.allowedItemKinds : ['no_launch_capability'],
        };
      });
    const qualityProfile = evaluateCurriculumQuality({
      workspaceId: prepared.workspaceId,
      contract: prepared.contract,
      curriculum,
      sourceCorpus: prepared.sourceCorpus,
      bindingAuthority: prepared.bindingAuthority,
      execution,
    });
    const allUsage = stages.flatMap((stage) => stage.usage);
    const currencies = [...new Set(allUsage.map((usage) => usage.currency).filter(Boolean))];
    const maximumPhysicalCalls =
      (policy === LEGACY_CURRICULUM_GENERATION_POLICY ? 1 : 1 + MAX_DETAIL_BATCHES) *
      MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL;
    const logicalCalls = stages.length;
    const physicalCalls = stages.reduce((sum, stage) => sum + stage.physicalCalls, 0);
    const repairs = stages.reduce((sum, stage) => sum + stage.repairReasons.length, 0);
    if (
      logicalCalls >
        (policy === LEGACY_CURRICULUM_GENERATION_POLICY ? 1 : 1 + MAX_DETAIL_BATCHES) ||
      physicalCalls > maximumPhysicalCalls ||
      stages.some(
        (stage) =>
          stage.physicalCalls > MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL ||
          stage.repairReasons.length > MAX_STRUCTURED_OUTPUT_ATTEMPTS_PER_LOGICAL_CALL - 1,
      )
    ) {
      throw new Error('Curriculum evaluation exceeded the production provider-call ceiling.');
    }
    return {
      schemaVersion: 1,
      inputFingerprint: prepared.fingerprint,
      policy,
      provider: deps.provider.name,
      providerModel: deps.provider.name === 'hy3' ? (deps.provider.model ?? null) : null,
      curriculum,
      studyPlanPreflight,
      unitLaunchProfiles,
      qualityProfile,
      evidenceSelectionTrace: prepared.evidenceTrace,
      evidenceUse: evidenceUseMetrics(prepared, curriculum, visibleOffers),
      stages,
      totals: {
        logicalCalls,
        physicalCalls,
        repairs,
        inputTokens: sumKnown(allUsage.map((usage) => usage.inputTokens)),
        outputTokens: sumKnown(allUsage.map((usage) => usage.outputTokens)),
        reasoningTokens: sumKnown(allUsage.map((usage) => usage.reasoningTokens)),
        estimatedCostMicrounits: sumKnown(allUsage.map((usage) => usage.estimatedCostMicrounits)),
        currency: currencies.length === 1 ? currencies[0]! : null,
        latencyMs: stages.reduce((sum, stage) => sum + stage.latencyMs, 0),
      },
      courseMap: courseMapEvaluation,
    };
  } catch (error) {
    throw new CurriculumPolicyEvaluationError(prepared.fingerprint, policy, stages, error);
  }
}
