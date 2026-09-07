import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  TeachingBriefPreparationRequestSchema,
  TeachingBriefPreparationResponseSchema,
  TeachingBriefSchema,
  PracticeContentProposalPayloadSchema,
  TeachingCapsulePayloadSchema,
  type LessonSlotContentProposalPayload,
  classifyConstructAuthority,
  projectAcceptedLessonSegments,
  type AcceptedLessonCheckpoint,
  type CurriculumAuthorityEnvelopeTier,
  type SourceBlockRevision,
  type CurriculumObjective,
  type TeachingBriefObjective,
  type TeachingBriefPrerequisite,
  type TeachingBriefSegment,
  type TeachingBriefSourceReference,
  type TeachingBriefVisualReference,
  type LessonPedagogyEvaluation,
  type PracticeContentProposalPayload,
  type PracticeQualityEvaluation,
  type TeachingSkeleton,
  type TeachingBrief,
  type TeachingBriefPreparationResponse,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { ProviderError } from '../llm/errors.js';
import { LEARNER_CONTENT_LOCALE } from '../llm/provider.js';
import { classifyPreparationError } from '../llm/preparationRecovery.js';
import type {
  LlmProvider,
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  ProviderCallOptions,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import { CurriculumExactAuthorityClaimHydrationError } from '../repositories/curricula.js';
import { searchRetrievalUnits, visualDerivationToRetrievalUnit } from '../retrieval/lexical.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
  type TrackedProviderOperation,
} from './agentProviderRuntime.js';
import {
  runRecoverableGenerationStage,
  invalidateGenerationDependency,
} from './generationStages.js';
import {
  validateLessonSlotContentCandidate,
  validatePracticeContentCandidate,
} from './teachingBriefContract.js';
import {
  buildTeachingBriefSourceContext,
  serializedTeachingProviderSourceEnvelopeBytes,
  TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
  type TeachingBriefProviderSourceOffer,
} from './teachingBriefContext.js';
import { profileTeachingBrief } from './teachingBriefQuality.js';
import {
  COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
  COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
  assertCurrentCognitiveContract,
  evaluateLessonSlotPedagogy,
  evaluatePlannedPracticeQuality,
} from './lessonPedagogyEvaluator.js';
import { visualManifestMatchesCurrentDerivations } from './advisoryVisuals.js';
import { deriveTeachingConstruct } from './teachingConstruct.js';
import {
  planTeachingSkeleton,
  TeachingSkeletonPlanningError,
  type TeachingSkeletonPlanningInput,
} from './teachingSkeletonPlanner.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import { verifyPreparedTeaching } from './teachingContentReview.js';
import { capsuleInputs, assembleCapsules } from './teachingCapsules.js';
import { validateTeachingCapsule, usesComputedTeachingCases } from '../llm/teachingCapsule.js';
import { confineTeachingCitations } from '../llm/teachingCitations.js';
import { TeachingStrategiesSchema, validateTeachingStrategies } from '../llm/teachingStrategy.js';
import {
  assertCurrentLessonObjectiveAuthoritySemanticSupport,
  objectiveAuthoritySemanticallySupportedClaimIds,
} from './objectiveAuthoritySemanticSupport.js';

export const TEACHING_BRIEF_PROMPT_VERSION =
  'teaching-brief-v3-compositional-source-guided-interaction';
export const LESSON_CONTENT_PROMPT_VERSION = 'teaching-lesson-content-v16-scoped-authoring';
export const PRACTICE_CONTENT_PROMPT_VERSION = 'teaching-practice-content-v15-scoped-authoring';
/**
 * Retain the accepted R2 lease window. It is renewed before each bounded call;
 * this is a stale-worker fence, not a target preparation duration. Computed
 * teaching normally needs one compact call per objective, with no editor/reviewer.
 */
export const COMPOSITIONAL_PREPARATION_LEASE_MS = 152 * 60 * 1000;

interface TeachingBriefPreparationDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  providerModel?: string | null;
}

interface TeachingBriefRouteInput {
  workspaceId: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  learningUnitId: string;
  studySessionId: string;
  sessionAgendaId: string;
  expectedSessionVersion: number;
  expectedAgendaVersion: number;
  expectedAgendaItemId: string;
  expectedStudyPlanItemId: string;
  expectedExecutionSourceManifestFingerprint: string;
}

/** Read-only accepted-Lesson view used only while its Practice successor is retried. */
export interface AcceptedLessonPreview {
  checkpointId: string;
  objective: TeachingBrief['objective'];
  prerequisites: TeachingBriefPrerequisite[];
  segments: TeachingBriefSegment[];
  formalOpportunities: string[];
  summary: string;
  nextConnection: string | null;
  sourceReferences: TeachingBriefSourceReference[];
  visualReferences: TeachingBriefVisualReference[];
  pedagogyEvaluation: LessonPedagogyEvaluation;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function diagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function candidateValidatorCodes(value: unknown): string[] {
  const record = diagnosticRecord(value);
  if (!record || !Array.isArray(record.diagnostics)) return [];
  return [
    ...new Set(
      record.diagnostics.flatMap((entry) => {
        const diagnostic = diagnosticRecord(entry);
        return diagnostic && typeof diagnostic.code === 'string' ? [diagnostic.code] : [];
      }),
    ),
  ].slice(0, 20);
}

export function compositionFingerprint(
  contextFingerprint: string,
  skeleton: Pick<TeachingSkeleton, 'fingerprint'>,
  policyVersions: {
    lessonPedagogy: string;
    practiceQuality: string;
  } = {
    lessonPedagogy: COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
    practiceQuality: COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
  },
): string {
  return `lesson_context_${fingerprint({
    sourceContextFingerprint: contextFingerprint,
    skeletonFingerprint: skeleton.fingerprint,
    teachingBriefPromptVersion: TEACHING_BRIEF_PROMPT_VERSION,
    lessonPromptVersion: LESSON_CONTENT_PROMPT_VERSION,
    practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
    lessonPedagogyPolicyVersion: policyVersions.lessonPedagogy,
    practiceQualityPolicyVersion: policyVersions.practiceQuality,
  }).slice(0, 40)}`;
}

export function isCurrentAcceptedLessonCheckpoint(
  checkpoint: AcceptedLessonCheckpoint | undefined,
): checkpoint is AcceptedLessonCheckpoint {
  return (
    checkpoint?.promptVersion === LESSON_CONTENT_PROMPT_VERSION &&
    checkpoint.lessonEvaluation.policyVersion === COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION &&
    checkpoint.lessonLogicalCallId !== null &&
    checkpoint.lessonContent[0]?.lessonNarrative !== undefined
  );
}

export function selectCurrentAcceptedLessonCheckpoint(
  checkpoint: AcceptedLessonCheckpoint | undefined,
): AcceptedLessonCheckpoint | undefined {
  if (!checkpoint) return undefined;
  if (!isCurrentAcceptedLessonCheckpoint(checkpoint)) {
    throw new AppError(
      ApiErrorCode.VersionConflict,
      'The accepted Lesson checkpoint is legacy or lacks current evaluation and logical-call provenance.',
    );
  }
  return checkpoint;
}

export function isCurrentCompositionalBrief(
  candidate: TeachingBrief | undefined,
  skeleton: Pick<TeachingSkeleton, 'fingerprint'>,
): candidate is TeachingBrief {
  return (
    candidate?.promptVersion === TEACHING_BRIEF_PROMPT_VERSION &&
    candidate.composition?.skeletonFingerprint === skeleton.fingerprint &&
    candidate.composition.lessonPromptVersion === LESSON_CONTENT_PROMPT_VERSION &&
    candidate.composition.practicePromptVersion === PRACTICE_CONTENT_PROMPT_VERSION &&
    candidate.composition.lessonLogicalCallId !== undefined &&
    candidate.composition.practiceLogicalCallId !== undefined &&
    candidate.pedagogyEvaluation?.policyVersion === COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION &&
    candidate.practice?.qualityEvaluation.policyVersion ===
      COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION
  );
}

export function createTeachingBriefPreparationService({
  repos,
  provider,
  clock,
  providerModel = null,
}: TeachingBriefPreparationDeps) {
  const inferenceProvider = createTelemetryProvider({
    repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });
  function routeContext(input: TeachingBriefRouteInput, requireActive = true) {
    const workspace = repos.workspaces.get(input.workspaceId);
    if (!workspace) throw notFound('Course workspace not found.');
    const state = repos.courseExecution.get(input.workspaceId);
    let curriculum;
    try {
      curriculum = repos.curricula.get(input.curriculumVersionId);
    } catch (error) {
      if (!(error instanceof CurriculumExactAuthorityClaimHydrationError)) throw error;
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Curriculum objective authority is not semantically supported for this operation.',
        {
          kind: 'objective_authority_semantic_support_invalid',
          boundary: 'lesson_provider',
          diagnosticCodes: ['semantic_exact_claim_hydration_invalid'],
          diagnostics: [error.message],
        },
      );
    }
    const plan = repos.studyPlans.get(input.studyPlanVersionId);
    const contract = curriculum
      ? repos.learningContracts.get(curriculum.contractVersionId)
      : undefined;
    const session = repos.studySessions.get(input.studySessionId);
    const agenda = repos.sessionAgendas.get(input.sessionAgendaId);
    if (
      !curriculum ||
      !contract ||
      !plan ||
      !session ||
      !agenda ||
      curriculum.workspaceId !== input.workspaceId ||
      plan.workspaceId !== input.workspaceId ||
      session.workspaceId !== input.workspaceId ||
      agenda.workspaceId !== input.workspaceId ||
      curriculum.status !== 'accepted' ||
      contract.status !== 'active' ||
      state.activeContractId !== contract.id ||
      plan.status !== 'accepted' ||
      plan.contractVersionId !== contract.id ||
      plan.curriculumVersionId !== curriculum.id ||
      state.activeCurriculumId !== curriculum.id ||
      state.acceptedPlanId !== plan.id ||
      state.activeAgendaId !== agenda.id ||
      session.curriculumVersionId !== curriculum.id ||
      session.studyPlanVersionId !== plan.id ||
      session.sessionAgendaId !== agenda.id ||
      agenda.curriculumVersionId !== curriculum.id ||
      agenda.studyPlanVersionId !== plan.id ||
      session.version !== input.expectedSessionVersion ||
      agenda.version !== input.expectedAgendaVersion ||
      session.currentAgendaItemId !== input.expectedAgendaItemId ||
      agenda.currentItemId !== input.expectedAgendaItemId ||
      (requireActive
        ? session.status !== 'active' || agenda.status !== 'active'
        : (session.status !== 'active' && session.status !== 'paused') ||
          (agenda.status !== 'active' && agenda.status !== 'paused')) ||
      state.routeValidationStatus !== 'valid'
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation requires the exact active Session and Agenda route.',
      );
    }
    if (
      curriculum.executionSourceManifest.fingerprint !==
        input.expectedExecutionSourceManifestFingerprint ||
      plan.executionSourceManifestFingerprint !==
        input.expectedExecutionSourceManifestFingerprint ||
      session.executionSourceManifestFingerprint !==
        input.expectedExecutionSourceManifestFingerprint ||
      agenda.executionSourceManifestFingerprint !== input.expectedExecutionSourceManifestFingerprint
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
    const agendaItem = agenda.items.find((item) => item.id === input.expectedAgendaItemId);
    const planItem = plan.items.find((item) => item.id === input.expectedStudyPlanItemId);
    if (
      !node?.learningUnit ||
      !agendaItem ||
      !planItem ||
      agendaItem.kind !== 'learning_unit_teaching' ||
      (agendaItem.state !== 'queued' && agendaItem.state !== 'active') ||
      agendaItem.launch.status !== 'launchable' ||
      agendaItem.launch.capability !== 'lesson' ||
      agendaItem.learningUnitId !== input.learningUnitId ||
      agendaItem.linkedPlanItemId !== input.expectedStudyPlanItemId ||
      planItem.kind !== 'teach_unit' ||
      planItem.curriculumLearningUnitId !== input.learningUnitId
    ) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'LearningUnit is not the exact executable Session Agenda teaching item.',
      );
    }
    if (planItem.objectiveIds.length === 0) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'The accepted StudyPlan teaching item must reference at least one objective.',
      );
    }
    if (new Set(planItem.objectiveIds).size !== planItem.objectiveIds.length) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'The accepted StudyPlan teaching item contains duplicate objective IDs.',
      );
    }
    const objectiveById = new Map(
      node.learningUnit.objectives.map((objective) => [objective.id, objective]),
    );
    const routeObjectives = planItem.objectiveIds.map((objectiveId) =>
      objectiveById.get(objectiveId),
    );
    if (routeObjectives.some((objective) => objective === undefined)) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'The accepted StudyPlan teaching item references an unknown or missing LearningUnit objective.',
      );
    }
    return {
      workspace,
      state,
      contract,
      curriculum,
      plan,
      session,
      agenda,
      agendaItem,
      node,
      planItem,
      routeObjectives: routeObjectives as CurriculumObjective[],
    };
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
    const directlyScopedVisuals = visualCandidates.filter(({ asset }) =>
      relevantMaterialIds.has(asset.materialId),
    );
    // A source-backed LearningUnit may legitimately use a separately scoped
    // course image as advisory teaching context. Prefer visuals attached to
    // its exact source materials, but when those materials have none, retain
    // the manifest-bounded candidates for relevance ranking below. This never
    // changes the objective's exact source authority or Formal evidence.
    const scopedVisuals =
      relevantMaterialIds.size === 0 || directlyScopedVisuals.length === 0
        ? visualCandidates
        : directlyScopedVisuals;
    const visualQuery = [
      input.node.title,
      ...input.routeObjectives.flatMap((objective) => [objective.title, objective.description]),
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
    const sourceAuthorityBundles = [
      ...new Set(input.routeObjectives.flatMap((objective) => objective.truthAuthorityRecordIds)),
    ].map((authorityRecordId) => {
      const bundle = repos.sourceAuthority.getBundle(authorityRecordId);
      if (!bundle) {
        throw new Error('Teaching Brief semantically supported source authority is unavailable.');
      }
      return bundle;
    });
    const built = buildTeachingBriefSourceContext({
      workspaceId: input.workspace.id,
      curriculum: input.curriculum,
      learningUnitId: input.node.id,
      materials,
      blocks,
      concepts: repos.materials.getConceptsByWorkspace(input.workspace.id),
      authorizedObjectiveIds: input.routeObjectives.map((objective) => objective.id),
      sourceAuthorityBundles,
      isBlockingEligible: (authorityRecordId) =>
        repos.sourceAuthority.isBlockingEligible(authorityRecordId),
      visuals,
    });
    return built;
  }

  function providerInput(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
  ): TeachingBriefGenerationInput {
    const teachingConstruct = (objective: CurriculumObjective) =>
      deriveTeachingConstruct(objective);
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
    const strongerConstructs: Record<
      NonNullable<CurriculumObjective['formalAssessmentConstruct']>,
      NonNullable<CurriculumObjective['formalAssessmentConstruct']>[]
    > = {
      identify: ['explain', 'apply', 'design', 'evaluate'],
      explain: ['apply', 'design', 'evaluate'],
      apply: ['design', 'evaluate'],
      design: ['evaluate'],
      evaluate: [],
    };
    const objectiveRefs = route.routeObjectives.map((_objective, index) => `O${index + 1}`);
    const durationTarget = route.agendaItem.estimatedMinutes;
    const supportedClaimIdsByObjective = new Map(
      route.routeObjectives.map((objective) => [
        objective.id,
        new Set(
          objective.semanticSupport
            ? objectiveAuthoritySemanticallySupportedClaimIds(objective.semanticSupport)
            : [],
        ),
      ]),
    );
    const isSourceAuthorizedForObjective = (
      offer: (typeof context.offers)[number],
      objective: CurriculumObjective,
    ) => {
      const reference = context.references.find((candidate) => candidate.refId === offer.sourceRef);
      if (!reference) return false;
      if (objective.semanticSupport?.verdict !== 'pass') {
        // Teaching-only lane: exact current source text that carries no claim
        // identity, so it can never reach another objective's exact envelope.
        return !reference.authorityClaimIds?.length;
      }
      const supportedClaimIds = supportedClaimIdsByObjective.get(objective.id);
      return (
        Boolean(reference.authorityClaimIds?.length) &&
        reference.authorityClaimIds!.some((claimId) => supportedClaimIds?.has(claimId))
      );
    };
    const hasExactTeachingContext = (objective: CurriculumObjective) =>
      context.offers.some((offer) => isSourceAuthorizedForObjective(offer, objective));
    const hasCurrentFormalProjection = (objective: CurriculumObjective) =>
      objective.semanticSupport?.verdict === 'pass' &&
      (objective.authorityEnvelopeTier === 'formal_sufficient' ||
        objective.authorityEnvelopeTier === 'narrower_formal') &&
      Boolean(objective.formalAssessmentConstruct) &&
      (objective.formalEvidenceSourceBlockIds?.length ?? 0) > 0;
    /**
     * Teaching authority follows the current semantic sidecar. A current PASS
     * may retain the accepted Curriculum projection; missing support or a
     * validated FAIL can only use exact current text as teaching_only.
     */
    const teachingAuthorityEnvelopeTier = (
      objective: CurriculumObjective,
    ): CurriculumAuthorityEnvelopeTier | undefined =>
      objective.semanticSupport?.verdict === 'pass'
        ? objective.authorityEnvelopeTier
        : hasExactTeachingContext(objective)
          ? 'teaching_only'
          : undefined;
    const providerObjectives: TeachingBriefGenerationInput['learningUnit']['objectives'] =
      route.routeObjectives.map((objective, index) => ({
        objectiveRef: `O${index + 1}`,
        title: objective.title,
        description: objective.description,
        priority: objective.priority ?? 'normal',
        construct: teachingConstruct(objective),
        authorityEnvelopeTier: teachingAuthorityEnvelopeTier(objective) ?? 'unavailable',
        practiceAuthority:
          hasExactTeachingContext(objective) && hasCurrentFormalProjection(objective)
            ? 'exact_formal'
            : hasExactTeachingContext(objective)
              ? 'exact_teaching'
              : context.visualOffers.length > 0
                ? 'advisory_visual'
                : 'unavailable',
        practiceEnvelope: (() => {
          const exactEvidence = context.offers
            .filter((offer) => isSourceAuthorizedForObjective(offer, objective))
            .map((offer) => ({ sourceRef: offer.sourceRef, text: offer.text }));
          const requiresFormalAuthority = hasCurrentFormalProjection(objective);
          const authorityMode =
            exactEvidence.length > 0
              ? ('exact_source' as const)
              : requiresFormalAuthority
                ? ('unavailable' as const)
                : context.visualOffers.length > 0
                  ? ('advisory_visual' as const)
                  : ('unavailable' as const);
          const targetConstruct = teachingConstruct(objective);
          // `authorityMode` answers "is there an exact evidence alias?"; it has
          // never answered "does this construct have Formal authority?". State
          // the second separately so no reader can substitute one for the other.
          const constructAuthority = classifyConstructAuthority(targetConstruct);
          return {
            targetConstruct,
            constructAuthority,
            authorityMode,
            evidenceAliases: exactEvidence,
            allowedCapability:
              targetConstruct === 'apply'
                ? 'Use a source-stated rule or procedure in its supported context to choose a next step, order a step, detect a missing step, or diagnose a bounded procedure failure.'
                : targetConstruct === 'explain'
                  ? 'Express a mechanism, relation, reason, consequence, or conceptual connection.'
                  : targetConstruct === 'identify'
                    ? 'Select, name, distinguish, or classify the correct entity or component.'
                    : `Practise the ${targetConstruct} capability as teaching only. It carries no Formal assessment authority and earns no Formal evidence or credit; stay inside the cited source and do not promote it to a stronger construct.`,
            prohibitedStrongerConstructs: targetConstruct
              ? strongerConstructs[targetConstruct]
              : [],
          };
        })(),
      }));
    const providerSourceOffers: TeachingBriefProviderSourceOffer[] = context.offers.map((offer) => {
      const reference = context.references.find((candidate) => candidate.refId === offer.sourceRef);
      return {
        ...offer,
        authorizedObjectiveRefs: route.routeObjectives.flatMap((objective, index) => {
          if (!reference || objective.semanticSupport?.verdict !== 'pass') return [];
          return reference.authorityClaimIds?.some((claimId) =>
            supportedClaimIdsByObjective.get(objective.id)?.has(claimId),
          )
            ? [`O${index + 1}`]
            : [];
        }),
      };
    });
    const providerSourceEnvelopeBytes = serializedTeachingProviderSourceEnvelopeBytes({
      offers: providerSourceOffers,
      objectiveEvidenceAliases: providerObjectives.map((objective) => ({
        objectiveRef: objective.objectiveRef,
        evidenceAliases: objective.practiceEnvelope?.evidenceAliases ?? [],
      })),
    });
    if (providerSourceEnvelopeBytes > TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Teaching Brief exact provider source envelope exceeds the byte budget.',
        {
          serializedBytes: providerSourceEnvelopeBytes,
          maxSerializedBytes: TEACHING_BRIEF_MAX_SERIALIZED_OFFER_BYTES,
        },
      );
    }
    return {
      workspaceName: route.workspace.name,
      courseDesign: {
        desiredDepth: route.contract.desiredDepth,
        unitFocus: route.node.learningUnit!.focus ?? 'normal',
      },
      learningUnit: {
        title: route.node.title,
        objectives: providerObjectives,
        concepts,
        canonicalConcepts,
      },
      prerequisites,
      nextConnection: nextNode ? { title: nextNode.title } : null,
      sourceContext: {
        blockCount: context.blockCount,
        offerCount: context.offerCount,
        serializedBytes: providerSourceEnvelopeBytes,
        materialCount: context.materialCount,
        sectionCount: context.sectionCount,
        offers: providerSourceOffers,
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
      plannedMinutes: durationTarget,
      durationBudget: {
        targetMinutes: durationTarget,
        acceptableActiveMinutes: {
          min: Math.max(1, durationTarget - 8),
          max: durationTarget + 3,
        },
        protectedRoles: [
          'objective_orientation',
          'explanation',
          'worked_example',
          'guided_practice',
        ],
        protectedObjectiveRefs: objectiveRefs,
        reductionOrder: [
          'remove redundant explanation',
          'collapse duplicated examples',
          'reduce unnecessary learner interruptions',
          'prioritize required objective teaching',
          'preserve one strong worked reasoning path',
          'preserve meaningful learner cognition',
          'preserve required Practice coverage',
        ],
      },
    };
  }

  function planningInput(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
    input: TeachingBriefGenerationInput,
  ): TeachingSkeletonPlanningInput {
    return {
      learningUnitTitle: route.node.title,
      targetMinutes: route.agendaItem.estimatedMinutes,
      targetDepth: route.planItem.targetDepth,
      maxLessonSlots: input.limits.maxSegments,
      maxPracticeSlots: 8,
      objectives: input.learningUnit.objectives.map((objective) => ({
        objectiveRef: objective.objectiveRef,
        title: objective.title,
        description: objective.description,
        priority: objective.priority,
        construct: objective.construct ?? 'identify',
        authorityMode: objective.practiceEnvelope?.authorityMode ?? 'unavailable',
        allowedSourceRefs:
          objective.practiceEnvelope?.evidenceAliases.map((evidence) => evidence.sourceRef) ?? [],
        allowedVisualRefs:
          objective.practiceEnvelope?.authorityMode === 'advisory_visual'
            ? context.visualOffers.map((offer) => offer.referenceKey)
            : [],
      })),
    };
  }

  function lessonInput(
    route: ReturnType<typeof routeContext>,
    input: TeachingBriefGenerationInput,
    skeleton: TeachingSkeleton,
  ): LessonSlotContentGenerationInput {
    const lessonSkeleton: LessonSlotContentGenerationInput['skeleton'] = {
      id: skeleton.id,
      schemaVersion: skeleton.schemaVersion,
      plannerVersion: skeleton.plannerVersion,
      fingerprint: skeleton.fingerprint,
      learningUnitTitle: skeleton.learningUnitTitle,
      objectives: skeleton.objectives,
      targetMinutes: skeleton.targetMinutes,
      acceptableActiveMinutes: skeleton.acceptableActiveMinutes,
      lessonSlots: skeleton.lessonSlots,
      synthesisActivityBudget: skeleton.synthesisActivityBudget,
      protectedActivityBudget: skeleton.protectedActivityBudget,
      plannedActivityBudget: skeleton.plannedActivityBudget,
    };
    return {
      workspaceName: route.workspace.name,
      learnerLocale: LEARNER_CONTENT_LOCALE,
      ...(input.courseDesign ? { courseDesign: input.courseDesign } : {}),
      skeleton: lessonSkeleton,
      sourceContext: input.sourceContext,
      visualContext: input.visualContext,
      learningContext: {
        concepts: input.learningUnit.concepts,
        canonicalConcepts: input.learningUnit.canonicalConcepts,
        prerequisites: input.prerequisites,
        nextConnection: input.nextConnection,
      },
    };
  }

  function practiceInput(
    route: ReturnType<typeof routeContext>,
    input: TeachingBriefGenerationInput,
    checkpoint: AcceptedLessonCheckpoint,
  ): PracticeContentGenerationInput {
    return {
      workspaceName: route.workspace.name,
      learnerLocale: LEARNER_CONTENT_LOCALE,
      ...(input.courseDesign ? { courseDesign: input.courseDesign } : {}),
      skeleton: checkpoint.skeleton,
      acceptedLesson: checkpoint.lessonContent,
      preparedTogether: Boolean(checkpoint.lessonEvaluation.jointAuthoring),
      sourceContext: input.sourceContext,
      visualContext: input.visualContext,
    };
  }

  function derivedObjective(
    route: ReturnType<typeof routeContext>,
    input: TeachingBriefGenerationInput,
    skeleton: TeachingSkeleton,
  ): TeachingBriefObjective[] {
    return route.routeObjectives.map((objective, index) => {
      const planned = skeleton.objectives[index]!;
      const providerTier = input.learningUnit.objectives[index]!.authorityEnvelopeTier;
      const hasCurrentFormalAuthority =
        objective.semanticSupport?.verdict === 'pass' &&
        (providerTier === 'formal_sufficient' || providerTier === 'narrower_formal');
      return {
        id: objective.id,
        title: objective.title,
        description: objective.description,
        priority: planned.priority,
        formalAssessmentReady: hasCurrentFormalAuthority ? objective.formalAssessmentReady : false,
        construct: planned.construct,
        authorityEnvelopeTier: providerTier,
        formalEvidenceSourceBlockIds: hasCurrentFormalAuthority
          ? objective.formalEvidenceSourceBlockIds
          : [],
      };
    });
  }

  function derivedPrerequisites(
    route: ReturnType<typeof routeContext>,
    input: TeachingBriefGenerationInput,
  ): TeachingBriefPrerequisite[] {
    return input.prerequisites.flatMap((prerequisite, index) => {
      const node = route.curriculum.nodes.find(
        (candidate) => candidate.id === route.node.learningUnit!.prerequisiteUnitIds[index],
      );
      return node
        ? [
            {
              learningUnitId: node.id,
              title: node.title,
              reason: `Understanding ${node.title} will make the ideas in ${route.node.title} easier to follow.`,
              readinessHint:
                prerequisite.objectiveSummaries.length > 0
                  ? `Before continuing, briefly recall ${prerequisite.objectiveSummaries.join('; ')}.`.slice(
                      0,
                      500,
                    )
                  : null,
            },
          ]
        : [];
    });
  }

  function assembleSegments(
    route: ReturnType<typeof routeContext>,
    checkpoint: AcceptedLessonCheckpoint,
  ): TeachingBriefSegment[] {
    return projectAcceptedLessonSegments(
      checkpoint,
      route.routeObjectives.map((objective) => objective.id),
    );
  }

  function localLessonMetadata(
    route: ReturnType<typeof routeContext>,
    input: TeachingBriefGenerationInput,
    checkpoint: AcceptedLessonCheckpoint,
  ) {
    const narrative = checkpoint.lessonContent[0]?.lessonNarrative;
    if (!narrative) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Current accepted Lesson content requires one coherent learner-facing narrative.',
      );
    }
    return {
      objective: {
        title: route.node.title,
        whyNow: narrative.whyNow,
        objectives: derivedObjective(route, input, checkpoint.skeleton),
      },
      prerequisites: derivedPrerequisites(route, input),
      formalOpportunities: [],
      summary: narrative.summary,
      nextConnection: narrative.forwardBridge,
    };
  }

  function materialize(
    route: ReturnType<typeof routeContext>,
    context: ReturnType<typeof sourceContext>,
    input: TeachingBriefGenerationInput,
    checkpoint: AcceptedLessonCheckpoint,
    practicePayload: PracticeContentProposalPayload,
    practiceEvaluation: PracticeQualityEvaluation,
    practiceOperationId: string,
    practiceLogicalCallId: string,
  ): TeachingBrief {
    const briefId = newId('teaching_brief');
    const segments = assembleSegments(route, checkpoint);
    const metadata = localLessonMetadata(route, input, checkpoint);
    const objectiveIds = route.routeObjectives.map((objective) => objective.id);
    const qualityProfile = profileTeachingBrief({
      objectiveIds,
      segments,
      sourceReferences: context.references,
      prerequisiteCount: metadata.prerequisites.length,
      formalOpportunityCount: 0,
      summary: metadata.summary,
      nextConnection: metadata.nextConnection,
    });
    if (checkpoint.lessonLogicalCallId === null) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Teaching Brief candidate requires accepted Lesson, Practice, and logical-call provenance.',
      );
    }
    const objectiveByRef = new Map(
      route.routeObjectives.map((objective, index) => [`O${index + 1}`, objective]),
    );
    const practiceContentById = new Map(
      practicePayload.items.map((item) => [item.practiceSlotId, item]),
    );
    const practice = {
      schemaVersion: 1 as const,
      items: checkpoint.skeleton.practicePlan.slots.map((slot, itemIndex) => {
        const item = practiceContentById.get(slot.practiceSlotId)!;
        const objective = objectiveByRef.get(slot.objectiveRef)!;
        const itemId = `${briefId}_practice_${itemIndex + 1}`;
        const surface = (
          value: (typeof item)['initial'] | (typeof item)['retry'],
          name: 'initial' | 'retry',
        ) => ({
          reasoningOperation: value.reasoningOperation,
          requiredInference: value.requiredInference,
          decisiveCondition: value.decisiveCondition,
          evidenceContrast: value.evidenceContrast,
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
          construct: slot.construct,
          capabilityTested: item.capabilityTested,
          pedagogicalReason: item.pedagogicalReason,
          authority:
            item.sourceRefs.length > 0
              ? ('exact_source' as const)
              : item.visualRefs.length > 0
                ? ('advisory_visual' as const)
                : ('ai_teaching_synthesis' as const),
          sourceRefIds: item.sourceRefs,
          visualRefIds: item.visualRefs,
          application: item.application,
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
      sourceContextFingerprint: checkpoint.sourceContextFingerprint,
      sourceManifest: route.curriculum.executionSourceManifest,
      conceptIds: route.node.learningUnit!.conceptIds,
      canonicalConceptIds: route.node.learningUnit!.canonicalConceptIds,
      objective: metadata.objective,
      prerequisites: metadata.prerequisites,
      segments,
      formalOpportunities: metadata.formalOpportunities,
      summary: metadata.summary,
      nextConnection: metadata.nextConnection,
      sourceReferences: context.references,
      visualReferences: context.visualReferences,
      qualityProfile,
      composition: {
        schemaVersion: 1,
        skeletonId: checkpoint.skeleton.id,
        skeletonSchemaVersion: checkpoint.skeleton.schemaVersion,
        skeletonPlannerVersion: checkpoint.skeleton.plannerVersion,
        skeletonFingerprint: checkpoint.skeleton.fingerprint,
        acceptedLessonCheckpointId: checkpoint.id,
        lessonOperationId: checkpoint.operationId,
        practiceOperationId,
        lessonLogicalCallId: checkpoint.lessonLogicalCallId,
        practiceLogicalCallId,
        ...(checkpoint.lessonEvaluation.jointAuthoring
          ? {
              jointAuthoringLogicalCallIds:
                checkpoint.lessonEvaluation.jointAuthoring.logicalCallIds,
            }
          : {}),
        lessonPromptVersion: checkpoint.promptVersion,
        practicePromptVersion: PRACTICE_CONTENT_PROMPT_VERSION,
        targetMinutes: checkpoint.skeleton.targetMinutes,
        acceptableActiveMinutes: {
          min: checkpoint.skeleton.acceptableActiveMinutes.minMinutes,
          max: checkpoint.skeleton.acceptableActiveMinutes.maxMinutes,
        },
        protectedActivityMinutes: {
          min: checkpoint.skeleton.protectedActivityBudget.minMinutes,
          max: checkpoint.skeleton.protectedActivityBudget.maxMinutes,
        },
        plannedActivityMinutes: {
          min: checkpoint.skeleton.plannedActivityBudget.minMinutes,
          max: checkpoint.skeleton.plannedActivityBudget.maxMinutes,
        },
      },
      pedagogyEvaluation: checkpoint.lessonEvaluation,
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

  function routeStillCurrent(input: TeachingBriefRouteInput, expectedContextFingerprint: string) {
    const currentRoute = routeContext(input);
    assertLessonObjectiveAuthoritySemanticSupport(currentRoute);
    const currentContext = sourceContext(currentRoute);
    if (currentContext.fingerprint !== expectedContextFingerprint) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief source context changed during generation.',
      );
    }
    return { route: currentRoute, context: currentContext };
  }

  function assertLessonObjectiveAuthoritySemanticSupport(
    route: ReturnType<typeof routeContext>,
  ): void {
    assertCurrentLessonObjectiveAuthoritySemanticSupport(route.curriculum, route.routeObjectives, {
      isBlockingEligible: (authorityRecordId) =>
        repos.sourceAuthority.isBlockingEligible(authorityRecordId),
    });
  }

  function checkpointIdentity(
    input: TeachingBriefRouteInput,
    contextFingerprint: string,
    skeleton: TeachingSkeleton,
  ) {
    return {
      workspaceId: input.workspaceId,
      studySessionId: input.studySessionId,
      sessionAgendaId: input.sessionAgendaId,
      agendaItemId: input.expectedAgendaItemId,
      expectedSessionVersion: input.expectedSessionVersion,
      expectedAgendaVersion: input.expectedAgendaVersion,
      curriculumVersionId: input.curriculumVersionId,
      studyPlanVersionId: input.studyPlanVersionId,
      studyPlanItemId: input.expectedStudyPlanItemId,
      learningUnitId: input.learningUnitId,
      executionSourceManifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
      sourceContextFingerprint: compositionFingerprint(contextFingerprint, skeleton),
      skeletonFingerprint: skeleton.fingerprint,
      promptVersion: LESSON_CONTENT_PROMPT_VERSION,
    };
  }

  function renewPreparationLease(operationId: string, owner: string, fencingToken: number): void {
    const now = clock.now();
    const renewed = repos.operations.renewLease(
      operationId,
      owner,
      fencingToken,
      new Date(now.getTime() + COMPOSITIONAL_PREPARATION_LEASE_MS).toISOString(),
      now.toISOString(),
    );
    if (!renewed) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation lost its operation lease.',
      );
    }
  }

  function acceptedLessonPreview(input: TeachingBriefRouteInput): AcceptedLessonPreview | null {
    const route = routeContext(input, false);
    assertLessonObjectiveAuthoritySemanticSupport(route);
    const context = sourceContext(route);
    const generationInput = providerInput(route, context);
    let skeleton: TeachingSkeleton;
    try {
      skeleton = planTeachingSkeleton(planningInput(route, context, generationInput));
    } catch (error) {
      if (error instanceof TeachingSkeletonPlanningError) return null;
      throw error;
    }
    const checkpoint = repos.acceptedLessonCheckpoints.findReusable(
      checkpointIdentity(input, context.fingerprint, skeleton),
    );
    if (!isCurrentAcceptedLessonCheckpoint(checkpoint)) {
      return null;
    }
    const metadata = localLessonMetadata(route, generationInput, checkpoint);
    return {
      checkpointId: checkpoint.id,
      objective: metadata.objective,
      prerequisites: metadata.prerequisites,
      segments: assembleSegments(route, checkpoint),
      formalOpportunities: metadata.formalOpportunities,
      summary: metadata.summary,
      nextConnection: metadata.nextConnection,
      sourceReferences: context.references,
      visualReferences: context.visualReferences,
      pedagogyEvaluation: checkpoint.lessonEvaluation,
    };
  }

  async function prepare(
    rawInput: unknown,
    options?: ProviderCallOptions,
  ): Promise<TeachingBriefPreparationResponse> {
    const input = TeachingBriefPreparationRequestSchema.parse(rawInput);
    if (provider.name === 'hy3' && !inferenceProvider.reviewTeachingContent) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'REAL teaching requires the preparation content-review capability.',
      );
    }
    const operationStudySession = repos.studySessions.get(input.studySessionId);
    if (!operationStudySession || operationStudySession.workspaceId !== input.workspaceId) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation requires the exact active Session and Agenda route.',
      );
    }
    const operationKey = `teaching-brief:${input.learningUnitId}:${input.commandId}`;
    let lessonLogicalCallId = `${operationKey}:lesson`;
    let practiceLogicalCallId = `${operationKey}:practice`;
    const startedAt = clock.now();
    const operation = repos.operations.createOrGet({
      id: newId('op'),
      workspaceId: input.workspaceId,
      commandId: operationKey,
      idempotencyKey: operationKey,
      logicalOperationId: operationKey,
      operationType: 'prepare_teaching_brief',
      studySessionId: input.studySessionId,
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
      new Date(startedAt.getTime() + COMPOSITIONAL_PREPARATION_LEASE_MS).toISOString(),
      startedAt.toISOString(),
    );
    if (!claim) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief preparation is in progress.',
      );
    }

    let preparationBoundary: 'route' | 'lesson' | 'checkpoint' | 'practice' | 'assembly' = 'route';
    let checkpointForDiagnostics: AcceptedLessonCheckpoint | undefined;
    const authorCallsByItem = new Map<string, Set<string>>();
    let rejectedTeachingItems: string[] = [];
    const registerAuthorCall = (itemIds: string[], logicalCallId: string) => {
      for (const id of itemIds) {
        const calls = authorCallsByItem.get(id) ?? new Set<string>();
        calls.add(logicalCallId);
        authorCallsByItem.set(id, calls);
      }
    };
    try {
      const route = routeContext(input);
      // This canonical defensive check covers every downstream
      // composition path: fresh Lesson generation, accepted-Lesson Practice
      // retry, and immutable Teaching Brief reuse. No checkpoint may outlive
      // every objective on the exact accepted Plan item that authorized it.
      assertLessonObjectiveAuthoritySemanticSupport(route);
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
      const generationInput = providerInput(route, context);
      let skeleton: TeachingSkeleton;
      try {
        skeleton = planTeachingSkeleton(planningInput(route, context, generationInput));
      } catch (error) {
        if (error instanceof TeachingSkeletonPlanningError) {
          throw new AppError(ApiErrorCode.ValidationError, error.message, {
            planningCode: error.code,
            ...error.details,
          });
        }
        throw error;
      }
      const scopedFingerprint = compositionFingerprint(context.fingerprint, skeleton);
      const effectiveObjectives = derivedObjective(route, generationInput, skeleton);
      const history = repos.teachingBriefs.listForUnit(input.workspaceId, input.learningUnitId);
      const reusableCheckpoint = repos.acceptedLessonCheckpoints.findReusable(
        checkpointIdentity(input, context.fingerprint, skeleton),
      );
      let checkpoint = selectCurrentAcceptedLessonCheckpoint(reusableCheckpoint);
      checkpointForDiagnostics = checkpoint;
      const reusableCandidate = checkpoint
        ? repos.teachingBriefs.findReusable({
            workspaceId: input.workspaceId,
            curriculumVersionId: input.curriculumVersionId,
            studyPlanVersionId: input.studyPlanVersionId,
            learningUnitId: input.learningUnitId,
            manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
            sourceContextFingerprint: scopedFingerprint,
            acceptedLessonCheckpointId: checkpoint.id,
          })
        : undefined;
      const reuse =
        isCurrentCompositionalBrief(reusableCandidate, skeleton) &&
        JSON.stringify(reusableCandidate.objective.objectives) ===
          JSON.stringify(effectiveObjectives)
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

      const trackedReviewCall = <T>(
        logicalCallId: string,
        schemaFingerprint: string,
        invoke: (providerOptions?: ProviderCallOptions) => Promise<T>,
        dependency?: { identity: unknown; validateResult: (value: unknown) => T },
      ) => {
        routeStillCurrent(input, context.fingerprint);
        renewPreparationLease(claim.id, owner, claim.fencingToken);
        const costAdmission = () =>
          enforceAgentCostPolicies(repos, {
            workspaceId: input.workspaceId,
            operationType: 'prepare_teaching_brief',
            studySessionId: input.studySessionId,
            at: clock.now().toISOString(),
            confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
          });
        const tracked: TrackedProviderOperation<T> = {
          repos,
          clock,
          provider,
          providerModel: provider.model ?? providerModel ?? null,
          operationId: claim.id,
          fencingToken: claim.fencingToken,
          workspaceId: input.workspaceId,
          studySessionId: input.studySessionId,
          learningUnitId: input.learningUnitId,
          assessmentId: null,
          operationType: 'prepare_teaching_brief',
          logicalCallId,
          schemaFingerprint,
          policyFingerprint: dependency ? null : costAdmission(),
          sourceFingerprint: scopedFingerprint,
          providerOptions: options,
          invoke,
        };
        return dependency
          ? runRecoverableGenerationStage({
              ...tracked,
              beforeGenerate: costAdmission,
              owner,
              stageIdentity: {
                stageVersion: 'teaching-stages-v3-independent-cases',
                lessonVersion: LESSON_CONTENT_PROMPT_VERSION,
                practiceVersion: PRACTICE_CONTENT_PROMPT_VERSION,
                curriculumId: input.curriculumVersionId,
                studyPlanId: input.studyPlanVersionId,
                sessionAgendaId: input.sessionAgendaId,
                agendaItemId: input.expectedAgendaItemId,
                studyPlanItemId: input.expectedStudyPlanItemId,
                input: dependency.identity,
              },
              assertCurrent: () => {
                routeStillCurrent(input, context.fingerprint);
              },
              validateResult: dependency.validateResult,
            })
          : runTrackedAgentProviderOperation(tracked);
      };

      if (!checkpoint) {
        preparationBoundary = 'lesson';
        const compositionalLessonInput = lessonInput(route, generationInput, skeleton);
        const computedSlotIds = new Set<string>();
        let jointAuthoring: LessonPedagogyEvaluation['jointAuthoring'];
        let jointLesson: LessonSlotContentProposalPayload | undefined;
        const parts = capsuleInputs(compositionalLessonInput, skeleton);
        if (provider.name === 'hy3' && inferenceProvider.generateTeachingCapsule) {
          const eligibleObjectives = skeleton.objectives.filter((objective) =>
            parts.some(
              (part) =>
                usesComputedTeachingCases(part) &&
                part.lesson.skeleton.objectives.some(
                  (o) => o.objectiveRef === objective.objectiveRef,
                ),
            ),
          );
          if (eligibleObjectives.length && inferenceProvider.planTeachingStrategies) {
            const strategyInput = {
              courseDesign: compositionalLessonInput.courseDesign,
              objectives: eligibleObjectives.map(({ objectiveRef, title, description }) => ({
                objectiveRef,
                title,
                description,
              })),
            };
            const strategies = await trackedReviewCall(
              `${operationKey}:strategies`,
              'teaching-strategies-v1',
              (opts) => inferenceProvider.planTeachingStrategies!(strategyInput, opts),
              {
                identity: strategyInput,
                validateResult: (raw) => {
                  if (!validateTeachingStrategies(raw, strategyInput).valid)
                    throw ProviderError.invalidOutput('Teaching strategy inventory changed.');
                  return TeachingStrategiesSchema.parse(raw);
                },
              },
            );
            for (const part of parts) {
              part.authoringStrategy =
                strategies.choices.find((choice) =>
                  part.lesson.skeleton.objectives.some(
                    (o) => o.objectiveRef === choice.objectiveRef,
                  ),
                )?.strategy ?? 'authored';
            }
          }
          const slots: LessonSlotContentProposalPayload['slots'] = [];
          const items: PracticeContentProposalPayload['items'] = [];
          let narrative: LessonSlotContentProposalPayload['narrative'];
          const logicalCallIds: string[] = [];
          for (const [index, capsuleInput] of parts.entries()) {
            capsuleInput.priorLesson = structuredClone(slots);
            const logicalCallId = `${operationKey}:capsule-${index + 1}`;
            const capsule = await trackedReviewCall(
              logicalCallId,
              'teaching-capsule-v1',
              (opts) =>
                inferenceProvider.generateTeachingCapsule!(structuredClone(capsuleInput), {
                  ...opts,
                  validateCandidate: (candidate) =>
                    validateTeachingCapsule(candidate, capsuleInput),
                }),
              {
                identity: capsuleInput,
                validateResult: (raw) => {
                  const result = confineTeachingCitations(
                    TeachingCapsulePayloadSchema.parse(raw),
                    capsuleInput,
                  );
                  if (!validateTeachingCapsule(result, capsuleInput).valid)
                    throw ProviderError.invalidOutput('Teaching dependency no longer validates.');
                  return result;
                },
              },
            );
            if (!validateTeachingCapsule(capsule, capsuleInput).valid)
              throw ProviderError.invalidOutput(
                'Joint authoring changed its exact slot inventory.',
                'candidate',
                'SEMANTIC_VALIDATION_FAILURE',
                false,
              );
            slots.push(...capsule.lesson.slots);
            registerAuthorCall(
              capsule.lesson.slots.map((slot) => slot.slotId),
              logicalCallId,
            );
            if (usesComputedTeachingCases(capsuleInput))
              for (const slot of capsule.lesson.slots) computedSlotIds.add(slot.slotId);
            items.push(...capsule.practice.items);
            if (index === 0) narrative = capsule.lesson.narrative;
            logicalCallIds.push(logicalCallId);
          }
          const assembled = assembleCapsules(skeleton, slots, narrative, items);
          jointLesson = assembled.lesson;
          const executionVerified = parts.every(
            (part) =>
              !part.lesson.skeleton.lessonSlots.some((s) => s.learnerActionRequired) ||
              usesComputedTeachingCases(part),
          );
          jointAuthoring = {
            logicalCallIds,
            practiceCandidate: assembled.practice,
            executionVerified,
            practiceExecutionVerified: parts
              .filter((part) => part.practiceSlots.length > 0)
              .every(usesComputedTeachingCases),
          };
          lessonLogicalCallId = logicalCallIds.at(-1)!;
          compositionalLessonInput.preparedTogether = true;
          compositionalLessonInput.computedCases = executionVerified;
        }
        const lessonProviderInput = structuredClone(compositionalLessonInput);
        let lessonRepairAttempted = false;
        const lessonPolicyFingerprint = enforceAgentCostPolicies(repos, {
          workspaceId: input.workspaceId,
          operationType: 'prepare_teaching_brief',
          studySessionId: input.studySessionId,
          at: clock.now().toISOString(),
          confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
        });
        let lessonPayload =
          jointLesson ??
          (await runTrackedAgentProviderOperation({
            repos,
            clock,
            provider,
            providerModel:
              provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
            operationId: claim.id,
            fencingToken: claim.fencingToken,
            workspaceId: input.workspaceId,
            studySessionId: input.studySessionId,
            learningUnitId: input.learningUnitId,
            assessmentId: null,
            operationType: 'prepare_teaching_brief',
            logicalCallId: lessonLogicalCallId,
            schemaFingerprint: 'lesson-slot-content-proposal-v1',
            policyFingerprint: lessonPolicyFingerprint,
            sourceFingerprint: scopedFingerprint,
            providerOptions: options,
            invoke: (providerOptions) =>
              inferenceProvider.generateLessonSlotContent(lessonProviderInput, {
                ...providerOptions,
                onRepairAttempt: (reason, category, recoveryAction) => {
                  lessonRepairAttempted = true;
                  providerOptions?.onRepairAttempt?.(reason, category, recoveryAction);
                },
                // The REAL draft is untrusted input to the editor, never an accepted checkpoint.
                ...(provider.name === 'hy3'
                  ? {}
                  : {
                      validateCandidate: (candidate: unknown) =>
                        validateLessonSlotContentCandidate(candidate, compositionalLessonInput),
                    }),
              }),
          }));
        if (
          provider.name === 'hy3' &&
          (!jointLesson ||
            !validateLessonSlotContentCandidate(jointLesson, compositionalLessonInput).valid)
        ) {
          routeStillCurrent(input, context.fingerprint);
          renewPreparationLease(claim.id, owner, claim.fencingToken);
          lessonLogicalCallId = `${operationKey}:lesson-editor`;
          const editorialInput = {
            ...structuredClone(compositionalLessonInput),
            draftForReview: structuredClone(lessonPayload),
          };
          lessonPayload = await runTrackedAgentProviderOperation({
            repos,
            clock,
            provider,
            providerModel: provider.model ?? providerModel ?? null,
            operationId: claim.id,
            fencingToken: claim.fencingToken,
            workspaceId: input.workspaceId,
            studySessionId: input.studySessionId,
            learningUnitId: input.learningUnitId,
            assessmentId: null,
            operationType: 'prepare_teaching_brief',
            logicalCallId: lessonLogicalCallId,
            schemaFingerprint: 'lesson-slot-content-proposal-v1',
            policyFingerprint: enforceAgentCostPolicies(repos, {
              workspaceId: input.workspaceId,
              operationType: 'prepare_teaching_brief',
              studySessionId: input.studySessionId,
              at: clock.now().toISOString(),
              confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
            }),
            sourceFingerprint: scopedFingerprint,
            providerOptions: options,
            invoke: (providerOptions) =>
              inferenceProvider.generateLessonSlotContent(editorialInput, {
                ...providerOptions,
                validateCandidate: (candidate) =>
                  validateLessonSlotContentCandidate(candidate, compositionalLessonInput),
                onRepairAttempt: (reason, category, action) => {
                  lessonRepairAttempted = true;
                  providerOptions?.onRepairAttempt?.(reason, category, action);
                },
              }),
          });
        }
        let contentReview: LessonPedagogyEvaluation['contentReview'];
        if (
          provider.name === 'hy3' &&
          !compositionalLessonInput.computedCases &&
          inferenceProvider.reviewTeachingContent
        ) {
          // A mixed Unit can contain both executed cases and open authored text.
          // Review only the latter; repeating calculated traces in a whole-Lesson
          // review needlessly consumes its budget and conflates validation roles.
          const reviewSlots = compositionalLessonInput.skeleton.lessonSlots.filter(
            (slot) => !computedSlotIds.has(slot.slotId),
          );
          const reviewContext = {
            ...compositionalLessonInput,
            skeleton: {
              ...compositionalLessonInput.skeleton,
              lessonSlots: reviewSlots,
              objectives: compositionalLessonInput.skeleton.objectives.filter((objective) =>
                reviewSlots.some((slot) => slot.objectiveRefs.includes(objective.objectiveRef)),
              ),
            },
          };
          const reviewScope = (payload: LessonSlotContentProposalPayload) => ({
            ...(computedSlotIds.size ? {} : { narrative: payload.narrative }),
            slots: payload.slots.filter((slot) => !computedSlotIds.has(slot.slotId)),
          });
          const verified = await verifyPreparedTeaching(
            reviewContext,
            reviewScope(lessonPayload),
            async (prepared, round) => {
              const logicalCallId = `${operationKey}:lesson-review-${round}`;
              const result = await trackedReviewCall(
                logicalCallId,
                'teaching-content-review-v1',
                (opts) =>
                  inferenceProvider.reviewTeachingContent!(prepared.input, {
                    ...opts,
                    validateCandidate: prepared.validate,
                  }),
              );
              rejectedTeachingItems = prepared.findings(result).map((finding) => finding.itemId);
              return { logicalCallId, result };
            },
            async (draft, findings) => {
              if (jointAuthoring && inferenceProvider.generateTeachingCapsule) {
                const revised = {
                  ...structuredClone(lessonPayload),
                  ...(draft.narrative ? { narrative: draft.narrative } : {}),
                  slots: lessonPayload.slots.map((slot) =>
                    structuredClone(draft.slots.find((s) => s.slotId === slot.slotId) ?? slot),
                  ),
                };
                const practice = PracticeContentProposalPayloadSchema.parse(
                  jointAuthoring.practiceCandidate,
                );
                const affected = structuredClone(parts).filter((part) =>
                  findings.some((f) =>
                    part.lesson.skeleton.lessonSlots.some((s) => s.slotId === f.itemId),
                  ),
                );
                if (!affected.length || affected.length > 2)
                  throw ProviderError.invalidOutput(
                    'Joint teaching revision exceeds its bounded affected portions.',
                    'candidate',
                    'SEMANTIC_VALIDATION_FAILURE',
                    true,
                  );
                for (const [index, part] of affected.entries()) {
                  part.priorLesson = revised.slots.filter(
                    (s) => !part.lesson.skeleton.lessonSlots.some((p) => p.slotId === s.slotId),
                  );
                  part.lesson.editorialFindings = findings.filter((f) =>
                    part.lesson.skeleton.lessonSlots.some((s) => s.slotId === f.itemId),
                  );
                  part.lesson.draftForReview = {
                    ...(part.includeNarrative ? { narrative: revised.narrative } : {}),
                    slots: revised.slots.filter((s) =>
                      part.lesson.skeleton.lessonSlots.some((p) => p.slotId === s.slotId),
                    ),
                  };
                  lessonLogicalCallId = `${operationKey}:capsule-revision-${index + 1}`;
                  const result = await trackedReviewCall(
                    lessonLogicalCallId,
                    'teaching-capsule-v1',
                    (opts) =>
                      inferenceProvider.generateTeachingCapsule!(structuredClone(part), {
                        ...opts,
                        validateCandidate: (c) => validateTeachingCapsule(c, part),
                      }),
                    {
                      identity: part,
                      validateResult: (raw) => {
                        const result = confineTeachingCitations(
                          TeachingCapsulePayloadSchema.parse(raw),
                          part,
                        );
                        if (!validateTeachingCapsule(result, part).valid)
                          throw ProviderError.invalidOutput(
                            'Teaching revision dependency no longer validates.',
                          );
                        return result;
                      },
                    },
                  );
                  registerAuthorCall(
                    result.lesson.slots.map((slot) => slot.slotId),
                    lessonLogicalCallId,
                  );
                  for (const slot of result.lesson.slots)
                    revised.slots[revised.slots.findIndex((s) => s.slotId === slot.slotId)] = slot;
                  if (part.includeNarrative) revised.narrative = result.lesson.narrative;
                  for (const item of result.practice.items)
                    practice.items[
                      practice.items.findIndex((p) => p.practiceSlotId === item.practiceSlotId)
                    ] = item;
                  jointAuthoring.logicalCallIds.push(lessonLogicalCallId);
                }
                jointAuthoring.practiceCandidate = practice;
                const validation = validateLessonSlotContentCandidate(
                  revised,
                  compositionalLessonInput,
                );
                if (!validation.valid)
                  throw ProviderError.invalidOutput(
                    'Revised joint Lesson still fails its full immutable contract.',
                    'candidate',
                    'SEMANTIC_VALIDATION_FAILURE',
                    true,
                    validation.failureArtifact,
                  );
                return reviewScope(revised);
              }
              lessonLogicalCallId = `${operationKey}:lesson-revision`;
              return trackedReviewCall(
                lessonLogicalCallId,
                'lesson-slot-content-proposal-v1',
                (opts) =>
                  inferenceProvider.generateLessonSlotContent(
                    {
                      ...structuredClone(compositionalLessonInput),
                      draftForReview: draft,
                      editorialFindings: findings,
                    },
                    {
                      ...opts,
                      validateCandidate: (candidate) =>
                        validateLessonSlotContentCandidate(candidate, compositionalLessonInput),
                    },
                  ),
              );
            },
          );
          lessonPayload = {
            ...lessonPayload,
            ...(verified.candidate.narrative ? { narrative: verified.candidate.narrative } : {}),
            slots: lessonPayload.slots.map(
              (slot) => verified.candidate.slots.find((s) => s.slotId === slot.slotId) ?? slot,
            ),
          };
          contentReview = verified.receipts;
        }
        if (provider.name === 'hy3') {
          lessonPayload = confineTeachingCitations(
            { lesson: lessonPayload, practice: { items: [] } },
            { lesson: compositionalLessonInput },
          ).lesson;
        }
        const lessonEvaluation = evaluateLessonSlotPedagogy(
          lessonPayload,
          compositionalLessonInput,
          {
            evaluatedAt: clock.now().toISOString(),
            boundedRepairAttempted: lessonRepairAttempted,
          },
        );
        if (contentReview) lessonEvaluation.contentReview = contentReview;
        if (jointAuthoring) lessonEvaluation.jointAuthoring = jointAuthoring;
        assertCurrentCognitiveContract(lessonEvaluation);
        if (!lessonPayload.narrative) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Current Lesson generation requires a coherent opening, summary, and forward bridge.',
          );
        }
        const acceptedLessonContent = lessonPayload.slots.map((content, index) =>
          index === 0 ? { ...content, lessonNarrative: lessonPayload.narrative } : content,
        );
        preparationBoundary = 'checkpoint';
        checkpoint = repos.transaction(() => {
          const current = routeStillCurrent(input, context.fingerprint);
          assertLessonObjectiveAuthoritySemanticSupport(current.route);
          const concurrentCandidate = repos.acceptedLessonCheckpoints.findReusable(
            checkpointIdentity(input, context.fingerprint, skeleton),
          );
          const concurrent = selectCurrentAcceptedLessonCheckpoint(concurrentCandidate);
          return (
            concurrent ??
            repos.acceptedLessonCheckpoints.create({
              id: newId('accepted_lesson'),
              workspaceId: input.workspaceId,
              studySessionId: input.studySessionId,
              sessionAgendaId: input.sessionAgendaId,
              agendaItemId: input.expectedAgendaItemId,
              expectedSessionVersion: input.expectedSessionVersion,
              expectedAgendaVersion: input.expectedAgendaVersion,
              curriculumVersionId: input.curriculumVersionId,
              studyPlanVersionId: input.studyPlanVersionId,
              studyPlanItemId: input.expectedStudyPlanItemId,
              learningUnitId: input.learningUnitId,
              executionSourceManifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
              sourceContextFingerprint: scopedFingerprint,
              skeleton,
              lessonContent: acceptedLessonContent,
              lessonEvaluation,
              operationId: claim.id,
              lessonLogicalCallId,
              provider: provider.name,
              providerModel:
                provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
              promptVersion: LESSON_CONTENT_PROMPT_VERSION,
              createdAt: clock.now().toISOString(),
            })
          );
        });
        checkpointForDiagnostics = checkpoint;
      }
      preparationBoundary = 'practice';
      const currentBeforePractice = routeStillCurrent(input, context.fingerprint);
      assertLessonObjectiveAuthoritySemanticSupport(currentBeforePractice.route);
      renewPreparationLease(claim.id, owner, claim.fencingToken);
      const compositionalPracticeInput = practiceInput(route, generationInput, checkpoint);
      const practiceProviderInput = structuredClone(compositionalPracticeInput);
      const jointPractice = PracticeContentProposalPayloadSchema.safeParse(
        checkpoint.lessonEvaluation.jointAuthoring?.practiceCandidate,
      );
      const reusableJointPractice =
        jointPractice.success &&
        validatePracticeContentCandidate(jointPractice.data, compositionalPracticeInput).valid
          ? jointPractice.data
          : undefined;
      compositionalPracticeInput.computedCases = Boolean(
        reusableJointPractice &&
        (checkpoint.lessonEvaluation.jointAuthoring?.practiceExecutionVerified ??
          checkpoint.lessonEvaluation.jointAuthoring?.executionVerified),
      );
      if (jointPractice.success) practiceProviderInput.draftForReview = jointPractice.data;
      if (reusableJointPractice)
        practiceLogicalCallId = checkpoint.lessonEvaluation.jointAuthoring!.logicalCallIds.at(-1)!;
      let practiceRepairAttempted = false;
      const practicePolicyFingerprint = enforceAgentCostPolicies(repos, {
        workspaceId: input.workspaceId,
        operationType: 'prepare_teaching_brief',
        studySessionId: input.studySessionId,
        at: clock.now().toISOString(),
        confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
      });
      let practicePayload =
        reusableJointPractice ??
        (await runTrackedAgentProviderOperation({
          repos,
          clock,
          provider,
          providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
          operationId: claim.id,
          fencingToken: claim.fencingToken,
          workspaceId: input.workspaceId,
          studySessionId: input.studySessionId,
          learningUnitId: input.learningUnitId,
          assessmentId: null,
          operationType: 'prepare_teaching_brief',
          logicalCallId: practiceLogicalCallId,
          schemaFingerprint: 'practice-content-proposal-v1',
          policyFingerprint: practicePolicyFingerprint,
          sourceFingerprint: scopedFingerprint,
          providerOptions: options,
          invoke: (providerOptions) =>
            inferenceProvider.generatePracticeContent(practiceProviderInput, {
              ...providerOptions,
              onRepairAttempt: (reason, category, recoveryAction) => {
                practiceRepairAttempted = true;
                providerOptions?.onRepairAttempt?.(reason, category, recoveryAction);
              },
              ...(provider.name === 'hy3' && !compositionalPracticeInput.preparedTogether
                ? {}
                : {
                    validateCandidate: (candidate: unknown) =>
                      validatePracticeContentCandidate(candidate, compositionalPracticeInput),
                  }),
            }),
        }));
      if (provider.name === 'hy3' && !compositionalPracticeInput.preparedTogether) {
        routeStillCurrent(input, context.fingerprint);
        renewPreparationLease(claim.id, owner, claim.fencingToken);
        practiceLogicalCallId = `${operationKey}:practice-editor`;
        const editorialInput = {
          ...structuredClone(compositionalPracticeInput),
          draftForReview: structuredClone(practicePayload),
        };
        practicePayload = await runTrackedAgentProviderOperation({
          repos,
          clock,
          provider,
          providerModel: provider.model ?? providerModel ?? null,
          operationId: claim.id,
          fencingToken: claim.fencingToken,
          workspaceId: input.workspaceId,
          studySessionId: input.studySessionId,
          learningUnitId: input.learningUnitId,
          assessmentId: null,
          operationType: 'prepare_teaching_brief',
          logicalCallId: practiceLogicalCallId,
          schemaFingerprint: 'practice-content-proposal-v1',
          policyFingerprint: enforceAgentCostPolicies(repos, {
            workspaceId: input.workspaceId,
            operationType: 'prepare_teaching_brief',
            studySessionId: input.studySessionId,
            at: clock.now().toISOString(),
            confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
          }),
          sourceFingerprint: scopedFingerprint,
          providerOptions: options,
          invoke: (providerOptions) =>
            inferenceProvider.generatePracticeContent(editorialInput, {
              ...providerOptions,
              validateCandidate: (candidate) =>
                validatePracticeContentCandidate(candidate, compositionalPracticeInput),
              onRepairAttempt: (reason, category, action) => {
                practiceRepairAttempted = true;
                providerOptions?.onRepairAttempt?.(reason, category, action);
              },
            }),
        });
      }
      let contentReview: PracticeQualityEvaluation['contentReview'];
      if (
        provider.name === 'hy3' &&
        !compositionalPracticeInput.computedCases &&
        inferenceProvider.reviewTeachingContent
      ) {
        const verified = await verifyPreparedTeaching(
          compositionalPracticeInput,
          practicePayload,
          async (prepared, round) => {
            const logicalCallId = `${operationKey}:practice-review-${round}`;
            const result = await trackedReviewCall(
              logicalCallId,
              'teaching-content-review-v1',
              (opts) =>
                inferenceProvider.reviewTeachingContent!(prepared.input, {
                  ...opts,
                  validateCandidate: prepared.validate,
                }),
            );
            return { logicalCallId, result };
          },
          async (draft, findings) => {
            if (compositionalPracticeInput.computedCases) {
              throw ProviderError.invalidOutput(
                'Computed Practice has a material teaching defect; preserve its Lesson and refuse an unverified prose rewrite.',
                'candidate',
                'SEMANTIC_VALIDATION_FAILURE',
                true,
                {
                  kind: 'computed_practice_review_failed',
                  diagnostics: findings.map((f) => ({ code: f.code, message: f.problem })),
                },
              );
            }
            compositionalPracticeInput.computedCases = false;
            practiceLogicalCallId = `${operationKey}:practice-revision`;
            return trackedReviewCall(
              practiceLogicalCallId,
              'practice-content-proposal-v1',
              (opts) =>
                inferenceProvider.generatePracticeContent(
                  {
                    ...structuredClone(compositionalPracticeInput),
                    draftForReview: draft,
                    editorialFindings: findings,
                  },
                  {
                    ...opts,
                    validateCandidate: (candidate) =>
                      validatePracticeContentCandidate(candidate, compositionalPracticeInput),
                  },
                ),
            );
          },
        );
        practicePayload = verified.candidate;
        contentReview = verified.receipts;
      }
      if (provider.name === 'hy3') {
        practicePayload = confineTeachingCitations(
          { lesson: { slots: [] }, practice: practicePayload },
          { lesson: compositionalPracticeInput },
        ).practice;
      }
      const practiceEvaluation = evaluatePlannedPracticeQuality(
        practicePayload,
        compositionalPracticeInput,
        {
          evaluatedAt: clock.now().toISOString(),
          boundedRepairAttempted: practiceRepairAttempted,
        },
      );
      if (contentReview) practiceEvaluation.contentReview = contentReview;
      assertCurrentCognitiveContract(practiceEvaluation);
      preparationBoundary = 'assembly';
      const brief = materialize(
        route,
        context,
        generationInput,
        checkpoint,
        practicePayload,
        practiceEvaluation,
        claim.id,
        practiceLogicalCallId,
      );
      return repos.transaction(() => {
        const current = routeStillCurrent(input, context.fingerprint);
        assertLessonObjectiveAuthoritySemanticSupport(current.route);
        const concurrentCandidate = repos.teachingBriefs.findReusable({
          workspaceId: input.workspaceId,
          curriculumVersionId: input.curriculumVersionId,
          studyPlanVersionId: input.studyPlanVersionId,
          learningUnitId: input.learningUnitId,
          manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
          sourceContextFingerprint: scopedFingerprint,
          acceptedLessonCheckpointId: checkpoint.id,
        });
        const concurrent = isCurrentCompositionalBrief(concurrentCandidate, skeleton)
          ? concurrentCandidate
          : undefined;
        const stored = concurrent ?? repos.teachingBriefs.create(brief);
        const response = TeachingBriefPreparationResponseSchema.parse({
          status: concurrent ? 'reused' : 'prepared',
          staleReason: concurrent ? 'none' : staleReason(history, route, scopedFingerprint),
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
      const currentOperation = repos.operations.get(claim.id);
      if (
        !checkpointForDiagnostics &&
        currentOperation?.status === 'running' &&
        currentOperation.leaseOwner === owner &&
        currentOperation.fencingToken === claim.fencingToken &&
        currentOperation.leaseExpiresAt !== null &&
        currentOperation.leaseExpiresAt > clock.now().toISOString()
      ) {
        for (const itemId of new Set(rejectedTeachingItems)) {
          for (const callId of authorCallsByItem.get(itemId) ?? [])
            invalidateGenerationDependency(repos, callId, clock.now().toISOString());
        }
      }
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
      const structuredRecord = diagnosticRecord(structuredFailure);
      const classification = classifyPreparationError(error, preparationBoundary);
      const validatorCodes = [
        ...new Set([
          ...candidateValidatorCodes(candidateFailure),
          ...(Array.isArray(structuredRecord?.semanticIssueCodes)
            ? structuredRecord.semanticIssueCodes.filter(
                (value): value is string => typeof value === 'string',
              )
            : []),
        ]),
      ].slice(0, 20);
      const terminalReason =
        error instanceof ProviderError
          ? (error.technicalFailureCode ?? error.code)
          : error instanceof AppError
            ? error.code
            : 'PREPARATION_FAILED';
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
              preparationFailure: {
                ...classification,
                phase: preparationBoundary,
                validatorCodes,
                normalizationRan: structuredRecord?.normalizationRan === true,
                normalizationActions: Array.isArray(structuredRecord?.normalizationActions)
                  ? structuredRecord.normalizationActions
                  : [],
                recoveryAction:
                  typeof structuredRecord?.recoveryAction === 'string'
                    ? structuredRecord.recoveryAction
                    : 'none',
                localizedRepair: structuredRecord?.localizedRepair === true,
                affectedItemIds: Array.isArray(structuredRecord?.affectedItemIds)
                  ? structuredRecord.affectedItemIds
                  : [],
                affectedComponents: Array.isArray(structuredRecord?.affectedComponents)
                  ? structuredRecord.affectedComponents
                  : [],
                recoveryExhausted: structuredRecord
                  ? structuredRecord.repairAction === 'exhausted'
                  : true,
                terminalReason,
                checkpointPreserved: Boolean(checkpointForDiagnostics),
              },
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
    getAcceptedLessonPreview: acceptedLessonPreview,
    getCurrent(input: TeachingBriefRouteInput): TeachingBrief | null {
      const route = routeContext(input, false);
      assertLessonObjectiveAuthoritySemanticSupport(route);
      const context = sourceContext(route);
      const generationInput = providerInput(route, context);
      let skeleton: TeachingSkeleton;
      try {
        skeleton = planTeachingSkeleton(planningInput(route, context, generationInput));
      } catch (error) {
        if (error instanceof TeachingSkeletonPlanningError) return null;
        throw error;
      }
      const checkpoint = repos.acceptedLessonCheckpoints.findReusable(
        checkpointIdentity(input, context.fingerprint, skeleton),
      );
      if (!isCurrentAcceptedLessonCheckpoint(checkpoint)) return null;
      const candidate = repos.teachingBriefs.findReusable({
        workspaceId: input.workspaceId,
        curriculumVersionId: input.curriculumVersionId,
        studyPlanVersionId: input.studyPlanVersionId,
        learningUnitId: input.learningUnitId,
        manifestFingerprint: input.expectedExecutionSourceManifestFingerprint,
        sourceContextFingerprint: compositionFingerprint(context.fingerprint, skeleton),
        acceptedLessonCheckpointId: checkpoint.id,
      });
      return isCurrentCompositionalBrief(candidate, skeleton) ? candidate : null;
    },
    history: (workspaceId: string, learningUnitId: string) =>
      repos.teachingBriefs.listForUnit(workspaceId, learningUnitId),
  };
}

export type TeachingBriefPreparationService = ReturnType<
  typeof createTeachingBriefPreparationService
>;
