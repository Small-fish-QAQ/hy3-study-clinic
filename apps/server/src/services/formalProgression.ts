import { transferPerformancePassed } from '@hy3-clinic/shared';
import {
  ApiErrorCode,
  AuthorityPremiseKindSchema,
  CompletionPolicySchema,
  FormalEvidenceRecordSchema,
  FormalProgressionOverviewSchema,
  FormalQuestionContractSchema,
  GoalOutcomeSchema,
  isStateCreditingAdmissibility,
  ProgressionReconciliationResponseSchema,
  QualifyReplanTriggerRequestSchema,
  ProposeQualifiedReplanRequestSchema,
  ReconcileProgressionRequestSchema,
  RecordGoalOutcomeRequestSchema,
  ReplanTriggerSchema,
  supportsFormalApplicationDemand,
  type CompletionPolicy,
  type CoverageRiskEntry,
  type Curriculum,
  type FormalAssessmentPremiseBinding,
  type FormalAssessmentPremiseKind,
  type FormalEvidenceRecord,
  type FormalQuestionContract,
  type GoalOutcome,
  type ProgressionDecision,
  type ProgressionReconciliation,
  type Question,
  type ReplanTrigger,
  type StudyPlan,
  type StudyPlanDiffOperation,
  type StudyPlanItem,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { FormalProgressionRepo } from '../repositories/formalProgression.js';
import type { SourceAuthorityBundle } from '../repositories/sourceAuthority.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { AgendaWindowRolloverService } from './agendaWindowRollover.js';
import { commandFingerprint } from './courseCommands.js';
import type { CourseCommandService } from './courseCommands.js';
import { validateObjectiveAuthoritySemanticSupport } from './objectiveAuthoritySemanticSupport.js';
import {
  deriveTeachUnitDurationsOrThrow,
  resolveAgendaBoundPlanItem,
  resolveLaunchForPlanItem,
} from './studyPlanValidation.js';
import { createHash } from 'node:crypto';
import { projectTaughtExposure, type PresentedTeachingSurface } from '@hy3-clinic/shared';

interface FormalProgressionDeps {
  repos: Repositories;
  progression: FormalProgressionRepo;
  commands: CourseCommandService;
  clock: Clock;
  agendaWindow: AgendaWindowRolloverService;
}

function learningUnits(curriculum: Curriculum) {
  return curriculum.nodes.filter((node) => node.kind === 'learning_unit' && node.learningUnit);
}

export function completionPolicyFor(
  contract: ReturnType<Repositories['learningContracts']['get']>,
): CompletionPolicy {
  if (!contract) throw new Error('Learning Contract is unavailable.');
  const desiredDepth = contract.desiredDepth;
  const version = Object.hasOwn(contract, 'focusRequest') ? 3 : 2;
  return CompletionPolicySchema.parse({
    id: `completion:${contract.id}:v${version}`,
    version,
    contractVersionId: contract.id,
    desiredDepth,
    minimumEligibleEvidenceCount: desiredDepth === 'deep_transfer' ? 2 : 1,
    minimumScore:
      desiredDepth === 'pass_oriented' ? 0.6 : desiredDepth === 'high_performance' ? 0.75 : 0.7,
    requireSynthesis: desiredDepth === 'deep_transfer',
    durableMastery: {
      minimumRepresentationCount: 2,
      minimumDemand: 'application',
      requireDelayedUnseenEvidence: true,
    },
    permittedTiers: ['tier_1_authorized_truth', 'tier_2_validated_representation'],
    createdAt: contract.createdAt,
  });
}

function unitFor(curriculum: Curriculum, id: string) {
  return learningUnits(curriculum).find((node) => node.id === id);
}

export interface FormalAssessmentProposalCatalogue {
  objectiveCatalogue: Array<{ objectiveRef: string; title: string; description: string }>;
  teachingSurfaceCatalogue: Array<{
    teachingSurfaceRef: string;
    surfaceKind: PresentedTeachingSurface['surfaceKind'];
    objectiveRefs: string[];
    text: string;
  }>;
  /** Local-only identity map; never passed to the provider. */
  surfaceRecords: Map<string, PresentedTeachingSurface>;
}

function surfaceFingerprint(text: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ prompt: text }))
    .digest('hex');
}

/** Build provider-blind O/T aliases over all accepted objectives before one proposal call. */
export function buildFormalAssessmentProposalCatalogue(input: {
  repos: Repositories;
  workspaceId: string;
  curriculum: Curriculum;
  plan: StudyPlan;
  planItemId: string;
  learningUnitId: string;
}): FormalAssessmentProposalCatalogue {
  const unit = unitFor(input.curriculum, input.learningUnitId);
  const planItem = input.plan.items.find((item) => item.id === input.planItemId);
  const objectiveIds = planItem?.objectiveIds.length
    ? planItem.objectiveIds
    : (unit?.learningUnit?.objectives.map((objective) => objective.id) ?? []);
  const objectiveById = new Map(
    learningUnits(input.curriculum).flatMap((candidateUnit) =>
      candidateUnit.learningUnit!.objectives.map((objective) => [objective.id, objective] as const),
    ),
  );
  const objectiveCatalogue = objectiveIds
    .map((id, index) => {
      const objective = objectiveById.get(id);
      return objective
        ? {
            objectiveRef: `O${index + 1}`,
            title: objective.title,
            description: objective.description,
          }
        : null;
    })
    .filter(
      (value): value is { objectiveRef: string; title: string; description: string } =>
        value !== null,
    );
  const objectiveRefById = new Map(objectiveIds.map((id, index) => [id, `O${index + 1}`]));
  const candidateUnitIds = new Set(
    learningUnits(input.curriculum)
      .filter((candidateUnit) =>
        candidateUnit.learningUnit!.objectives.some((objective) =>
          objectiveIds.includes(objective.id),
        ),
      )
      .map((candidateUnit) => candidateUnit.id),
  );
  const teachingSurfaceCatalogue: FormalAssessmentProposalCatalogue['teachingSurfaceCatalogue'] =
    [];
  const surfaceRecords = new Map<string, PresentedTeachingSurface>();
  let surfaceIndex = 1;
  for (const state of input.repos.lessonExecution.listForWorkspace(input.workspaceId)) {
    if (state.preparationStatus !== 'ready') continue;
    if (
      state.curriculumVersionId !== input.curriculum.id ||
      state.studyPlanVersionId !== input.plan.id ||
      !candidateUnitIds.has(state.learningUnitId) ||
      state.executionSourceManifestFingerprint !== input.plan.executionSourceManifestFingerprint ||
      !state.teachingBriefId
    )
      continue;
    const brief = input.repos.teachingBriefs.get(state.teachingBriefId);
    const checkpointId = brief?.composition?.acceptedLessonCheckpointId;
    const checkpoint = checkpointId
      ? input.repos.acceptedLessonCheckpoints.get(checkpointId)
      : undefined;
    if (!brief || !checkpoint) continue;
    const projection = projectTaughtExposure({ brief, state, checkpoint });
    if (!projection) continue;
    for (const surface of projection.surfaces) {
      const objectiveRefs = surface.objectiveIds
        .map((objectiveId) => objectiveRefById.get(objectiveId))
        .filter((value): value is string => value !== undefined);
      if (objectiveRefs.length === 0) continue;
      teachingSurfaceCatalogue.push({
        teachingSurfaceRef: `T${surfaceIndex++}`,
        surfaceKind: surface.surfaceKind,
        objectiveRefs,
        text: surface.text,
      });
      surfaceRecords.set(`T${surfaceIndex - 1}`, surface);
    }
  }
  return { objectiveCatalogue, teachingSurfaceCatalogue, surfaceRecords };
}

function currentTaughtExposure(input: {
  repos: Repositories;
  workspaceId: string;
  curriculumVersionId: string;
  studyPlanVersionId: string;
  learningUnitId: string;
  executionSourceManifestFingerprint: string;
}) {
  const result: Array<{
    projection: ReturnType<typeof projectTaughtExposure>;
    state: ReturnType<Repositories['lessonExecution']['listForWorkspace']>[number];
    brief: ReturnType<Repositories['teachingBriefs']['get']>;
    checkpoint: ReturnType<Repositories['acceptedLessonCheckpoints']['get']>;
  }> = [];
  for (const state of input.repos.lessonExecution.listForWorkspace(input.workspaceId)) {
    if (
      state.preparationStatus !== 'ready' ||
      state.curriculumVersionId !== input.curriculumVersionId ||
      state.studyPlanVersionId !== input.studyPlanVersionId ||
      state.learningUnitId !== input.learningUnitId ||
      state.executionSourceManifestFingerprint !== input.executionSourceManifestFingerprint ||
      !state.teachingBriefId
    )
      continue;
    const brief = input.repos.teachingBriefs.get(state.teachingBriefId);
    const checkpointId = brief?.composition?.acceptedLessonCheckpointId;
    const checkpoint = checkpointId
      ? input.repos.acceptedLessonCheckpoints.get(checkpointId)
      : undefined;
    if (!brief || !checkpoint) continue;
    const projection = projectTaughtExposure({ brief, state, checkpoint });
    if (projection) result.push({ projection, state, brief, checkpoint });
  }
  return result;
}

interface RequiredAssessmentPremise {
  premiseKey: string;
  premiseKind: FormalAssessmentPremiseKind;
  premiseFingerprint: string;
  admittedClaim: string;
  exactAuthorityKind: 'expected_answer' | 'rubric_point';
}

function normalizedPremise(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function requiredAssessmentPremises(question: Question): RequiredAssessmentPremise[] {
  if (question.options && question.correctOptionIds) {
    const answerFingerprintInput = {
      type: question.type,
      stem: question.stem,
      options: question.options,
      correctOptionIds: question.correctOptionIds,
    };
    return question.correctOptionIds.map((optionId) => {
      const option = question.options!.find((candidate) => candidate.id === optionId)!;
      return {
        premiseKey: `choice_answer:${optionId}`,
        premiseKind: 'choice_answer',
        premiseFingerprint: commandFingerprint({ ...answerFingerprintInput, optionId }),
        admittedClaim: option.text,
        exactAuthorityKind: 'expected_answer',
      };
    });
  }

  const premises: RequiredAssessmentPremise[] = [];
  if (question.expectedAnswer) {
    premises.push({
      premiseKey: 'expected_answer',
      premiseKind: 'expected_answer',
      premiseFingerprint: commandFingerprint({
        type: question.type,
        stem: question.stem,
        expectedAnswer: question.expectedAnswer,
      }),
      admittedClaim: question.expectedAnswer,
      exactAuthorityKind: 'expected_answer',
    });
  }
  question.rubric?.keyPoints.forEach((point, index) => {
    if (!point.required) return;
    premises.push({
      premiseKey: `rubric_point:${index}`,
      premiseKind: 'rubric_point',
      premiseFingerprint: commandFingerprint({
        type: question.type,
        stem: question.stem,
        rubricPointIndex: index,
        rubricPoint: point,
      }),
      admittedClaim: point.text,
      exactAuthorityKind: 'rubric_point',
    });
  });
  return premises;
}

function authorityPremiseKind(bundle: SourceAuthorityBundle) {
  return AuthorityPremiseKindSchema.safeParse(bundle.record.policyBasis.premiseKind).success
    ? bundle.record.policyBasis.premiseKind
    : null;
}

function authorityKindPermitsPremise(
  bundle: SourceAuthorityBundle,
  premise: RequiredAssessmentPremise,
): boolean {
  const kind = authorityPremiseKind(bundle);
  return kind === premise.exactAuthorityKind || kind === 'representation_equivalence';
}

function buildAssessmentPremiseBindings(input: {
  repos: Repositories;
  authorityIds: string[];
  question: Question;
  relevantBlockIds: Set<string>;
}): {
  required: RequiredAssessmentPremise[];
  bindings: FormalAssessmentPremiseBinding[];
  usesRepresentationEquivalence: boolean;
} {
  const required = requiredAssessmentPremises(input.question);
  const candidates = input.authorityIds
    .map((authorityId) => input.repos.sourceAuthority.getBundle(authorityId))
    .filter((bundle): bundle is SourceAuthorityBundle => Boolean(bundle))
    .filter((bundle) => input.repos.sourceAuthority.isBlockingEligible(bundle.record.id))
    .sort((left, right) => left.record.id.localeCompare(right.record.id));
  let usesRepresentationEquivalence = false;
  const bindings: FormalAssessmentPremiseBinding[] = [];
  for (const premise of required) {
    const match = candidates.flatMap((bundle) =>
      authorityKindPermitsPremise(bundle, premise)
        ? bundle.claims
            .filter(
              (claim) =>
                input.relevantBlockIds.has(claim.sourceBlockId) &&
                normalizedPremise(claim.claim) === normalizedPremise(premise.admittedClaim),
            )
            .map((claim) => ({ bundle, claim }))
        : [],
    )[0];
    if (!match) continue;
    if (authorityPremiseKind(match.bundle) === 'representation_equivalence') {
      usesRepresentationEquivalence = true;
    }
    bindings.push({
      id: newId('premise_binding'),
      premiseKey: premise.premiseKey,
      premiseKind: premise.premiseKind,
      premiseFingerprint: premise.premiseFingerprint,
      truthAuthorityRecordId: match.bundle.record.id,
      truthAuthorityClaimIds: [match.claim.id],
    });
  }
  return { required, bindings, usesRepresentationEquivalence };
}

function contractHasCurrentAgendaAuthority(
  repos: Repositories,
  contract: FormalQuestionContract,
): boolean {
  const route = repos.courseExecution.get(contract.workspaceId);
  if (
    route.routeValidationStatus !== 'valid' ||
    (route.executionStatus !== 'active' && route.executionStatus !== 'paused') ||
    route.activeContractId !== contract.contractVersionId ||
    route.activeCurriculumId !== contract.curriculumVersionId ||
    route.acceptedPlanId !== contract.studyPlanVersionId ||
    !contract.sessionAgendaId ||
    route.activeAgendaId !== contract.sessionAgendaId
  ) {
    return false;
  }
  const learningContract = repos.learningContracts.get(contract.contractVersionId);
  const curriculum = repos.curricula.get(contract.curriculumVersionId);
  const plan = repos.studyPlans.get(contract.studyPlanVersionId);
  const agenda = repos.sessionAgendas.get(contract.sessionAgendaId);
  if (
    !learningContract ||
    learningContract.workspaceId !== contract.workspaceId ||
    learningContract.status !== 'active' ||
    commandFingerprint(learningContract.courseScope) !== contract.stableScopeFingerprint ||
    !curriculum ||
    curriculum.workspaceId !== contract.workspaceId ||
    curriculum.status !== 'accepted' ||
    !curriculum.validation.valid ||
    curriculum.contractVersionId !== learningContract.id ||
    curriculum.executionSourceManifest.fingerprint !==
      contract.executionSourceManifestFingerprint ||
    !plan ||
    plan.workspaceId !== contract.workspaceId ||
    plan.status !== 'accepted' ||
    plan.contractVersionId !== learningContract.id ||
    plan.curriculumVersionId !== curriculum.id ||
    plan.executionSourceManifestFingerprint !== contract.executionSourceManifestFingerprint ||
    !agenda ||
    agenda.workspaceId !== contract.workspaceId ||
    (agenda.status !== 'active' && agenda.status !== 'paused') ||
    agenda.contractVersionId !== learningContract.id ||
    agenda.curriculumVersionId !== curriculum.id ||
    agenda.studyPlanVersionId !== plan.id ||
    agenda.executionSourceManifestFingerprint !== contract.executionSourceManifestFingerprint
  ) {
    return false;
  }
  const agendaItem = agenda.items.find((item) => item.id === contract.agendaItemId);
  if (!agendaItem || agendaItem.launch.status !== 'launchable') return false;
  const bound = resolveAgendaBoundPlanItem(repos, plan, agendaItem);
  if (
    !bound.ok ||
    bound.planItem.kind !== contract.assessmentKind ||
    !bound.planItem.objectiveIds.includes(contract.primaryObjectiveId) ||
    (contract.assessmentKind !== 'synthesis' &&
      bound.planItem.curriculumLearningUnitId !== contract.curriculumLearningUnitId)
  ) {
    return false;
  }
  if (agendaItem.launch.capability !== 'assessment') {
    return false;
  }
  if (contract.studySessionId) {
    const session = repos.studySessions.get(contract.studySessionId);
    if (
      !session ||
      session.workspaceId !== contract.workspaceId ||
      (session.status !== 'active' && session.status !== 'paused') ||
      session.contractVersionId !== learningContract.id ||
      session.curriculumVersionId !== curriculum.id ||
      session.studyPlanVersionId !== plan.id ||
      session.sessionAgendaId !== agenda.id ||
      session.executionSourceManifestFingerprint !== contract.executionSourceManifestFingerprint
    ) {
      return false;
    }
  }
  return true;
}

function contractHasCurrentPremiseAuthority(
  repos: Repositories,
  contract: FormalQuestionContract,
): boolean {
  if (!isStateCreditingAdmissibility(contract.admissibilityTier)) return false;
  const quiz = repos.quizzes.get(contract.quizId);
  const question = quiz?.questions.find((candidate) => candidate.id === contract.questionId);
  const curriculum = repos.curricula.get(contract.curriculumVersionId);
  const unit = curriculum ? unitFor(curriculum, contract.curriculumLearningUnitId) : undefined;
  const objective = unit?.learningUnit?.objectives.find(
    (candidate) => candidate.id === contract.primaryObjectiveId,
  );
  if (!question || !objective || (question.options && question.correctOptionIds)) return false;
  const semanticAuthority = validateObjectiveAuthoritySemanticSupport(
    curriculum!,
    [objective],
    {
      isBlockingEligible: (authorityRecordId) =>
        repos.sourceAuthority.isBlockingEligible(authorityRecordId),
    },
    'formal_credit',
  );
  if (!semanticAuthority.valid) return false;
  const required = requiredAssessmentPremises(question);
  if (
    required.length === 0 ||
    contract.assessmentPremiseBindings.length !== required.length ||
    contract.assessmentPremiseBindings.some((binding) => {
      const premise = required.find((candidate) => candidate.premiseKey === binding.premiseKey);
      if (!premise || premise.premiseFingerprint !== binding.premiseFingerprint) return true;
      if (!objective.truthAuthorityRecordIds.includes(binding.truthAuthorityRecordId)) return true;
      const bundle = repos.sourceAuthority.getBundle(binding.truthAuthorityRecordId);
      if (
        !bundle ||
        !repos.sourceAuthority.isBlockingEligible(bundle.record.id) ||
        !authorityKindPermitsPremise(bundle, premise)
      ) {
        return true;
      }
      const claimsById = new Map(bundle.claims.map((claim) => [claim.id, claim]));
      return binding.truthAuthorityClaimIds.some((claimId) => {
        const claim = claimsById.get(claimId);
        return (
          !claim ||
          normalizedPremise(claim.claim) !== normalizedPremise(premise.admittedClaim) ||
          !contract.provenance.some(
            (item) =>
              item.sourceBlockId === claim.sourceBlockId &&
              item.truthAuthorityClaimIds.includes(claimId),
          )
        );
      });
    })
  ) {
    return false;
  }
  // S1 proof fields are additive: historical contracts without them are
  // deliberately unproven rather than backfilled from current state.
  if (
    !contract.taughtExposureBindings ||
    contract.taughtExposureBindings.length === 0 ||
    !contract.declaredPremises ||
    contract.declaredPremises.length === 0 ||
    contract.premiseVisibilityVerdict !== 'satisfied' ||
    !contract.resolvedObjectiveBinding
  ) {
    return false;
  }
  if (contract.resolvedObjectiveBinding.objectiveId !== contract.primaryObjectiveId) return false;
  if (
    (contract.resolvedObjectiveBinding.source === 'provider_alias' &&
      question.formalProposal?.objectiveRef !== contract.resolvedObjectiveBinding.objectiveRef) ||
    (contract.resolvedObjectiveBinding.source === 'single_objective_plan_item' &&
      question.formalProposal?.objectiveRef !== undefined) ||
    (contract.resolvedObjectiveBinding.source === 'synthesis_mapping' &&
      contract.assessmentKind !== 'synthesis')
  ) {
    return false;
  }
  const currentDeclarations = question.formalProposal?.premises.map((premise, index) => ({
    premiseKey: premise.premiseKey ?? `premise:${index + 1}`,
    text: premise.text,
    sourceRefIds: premise.sourceRefs,
    teachingSurfaceRefs: premise.teachingSurfaceRefs,
    learnerVisible: premise.learnerVisible,
    scenarioLocal: premise.scenarioLocal,
    visibilityBasis: premise.visibilityBasis,
  }));
  if (
    !currentDeclarations ||
    JSON.stringify(currentDeclarations) !== JSON.stringify(contract.declaredPremises) ||
    question.formalProposal?.requiresExternalKnowledge ||
    question.formalProposal?.ambiguity === 'unresolved' ||
    (question.formalProposal?.undefinedTerms.length ?? 0) > 0
  ) {
    return false;
  }
  const relevantBlockIds = new Set([
    question.grounding.blockId,
    ...(question.supplementaryEvidence ?? []).map((item) => item.blockId),
  ]);
  const workspaceBlockTexts = repos.materials
    .listByWorkspace(contract.workspaceId)
    .flatMap((material) => repos.materials.getBlocks(material.id).map((block) => block.content));
  const requiredRubric = question.rubric?.keyPoints.filter((point) => point.required) ?? [];
  if (
    requiredRubric.some((point) => {
      const declaration = question.formalProposal?.rubricSourceRefs.find(
        (candidate) => normalizedPremise(candidate.text) === normalizedPremise(point.text),
      );
      return (
        !declaration?.sourceRefs.length ||
        declaration.sourceRefs.some((ref) => !relevantBlockIds.has(ref))
      );
    })
  ) {
    return false;
  }
  const taughtEntries = currentTaughtExposure({
    repos,
    workspaceId: contract.workspaceId,
    curriculumVersionId: contract.curriculumVersionId,
    studyPlanVersionId: contract.studyPlanVersionId,
    learningUnitId: contract.curriculumLearningUnitId,
    executionSourceManifestFingerprint: contract.executionSourceManifestFingerprint,
  });
  const validTaughtBindings = contract.taughtExposureBindings.every((binding) =>
    taughtEntries.some(({ projection }) => {
      if (!projection || !projection.objectiveIds.includes(binding.objectiveId)) return false;
      const objectiveSurfaces = projection.surfaces.filter((surface) =>
        surface.objectiveIds.includes(binding.objectiveId),
      );
      const surface = objectiveSurfaces[0];
      return Boolean(
        surface &&
        surface.checkpointId === binding.checkpointId &&
        surface.skeletonFingerprint === binding.skeletonFingerprint &&
        surface.sourceContextFingerprint === binding.sourceContextFingerprint &&
        binding.curriculumVersionId === contract.curriculumVersionId &&
        binding.studyPlanVersionId === contract.studyPlanVersionId &&
        binding.learningUnitId === contract.curriculumLearningUnitId &&
        binding.executionSourceManifestFingerprint ===
          contract.executionSourceManifestFingerprint &&
        binding.presentedSegmentIndexes.every((index) =>
          objectiveSurfaces.some((candidate) => candidate.segmentIndex === index),
        ),
      );
    }),
  );
  if (!validTaughtBindings) return false;
  const surfaceBindings = contract.presentedTeachingSurfaceBindings ?? [];
  const currentSurfaceBindingAuthorities = new Map<
    string,
    PresentedTeachingSurface['authority'][]
  >();
  for (const binding of surfaceBindings) {
    const current = taughtEntries
      .flatMap(({ projection }) => projection?.surfaces ?? [])
      .find(
        (surface) =>
          surface.checkpointId === binding.checkpointId &&
          surface.skeletonFingerprint === binding.skeletonFingerprint &&
          surface.segmentIndex === binding.segmentIndex &&
          surface.surfaceKind === binding.surfaceKind &&
          surface.surfaceOrdinal === binding.surfaceOrdinal &&
          surface.objectiveIds.includes(contract.primaryObjectiveId),
      );
    if (!current || surfaceFingerprint(current.text) !== binding.surfaceFingerprint) return false;
    const authorities = currentSurfaceBindingAuthorities.get(binding.premiseKey) ?? [];
    authorities.push(current.authority);
    currentSurfaceBindingAuthorities.set(binding.premiseKey, authorities);
  }
  if (
    contract.declaredPremises.some(
      (premise) =>
        premise.teachingSurfaceRefs.length !==
        (currentSurfaceBindingAuthorities.get(premise.premiseKey)?.length ?? 0),
    )
  ) {
    return false;
  }
  if (
    !contract.declaredPremises.every((premise) => {
      if (!premise.learnerVisible) return false;
      const textInStem = normalizedPremise(question.stem).includes(normalizedPremise(premise.text));
      const exactlyCourseSourced = workspaceBlockTexts.some((sourceText) =>
        normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
      );
      if (premise.visibilityBasis === 'stem') return textInStem;
      if (premise.visibilityBasis === 'scenario_local') {
        return (
          premise.scenarioLocal &&
          premise.sourceRefIds.length === 0 &&
          textInStem &&
          !exactlyCourseSourced
        );
      }
      if (premise.visibilityBasis === 'assumed_prerequisite') return textInStem;
      if (premise.visibilityBasis === 'cited_source') {
        return (
          premise.sourceRefIds.length > 0 &&
          premise.sourceRefIds.every((ref) => {
            const sourceText = repos.materials.getBlock(ref)?.content;
            return (
              relevantBlockIds.has(ref) &&
              Boolean(
                sourceText &&
                normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
              )
            );
          })
        );
      }
      if (
        premise.sourceRefIds.length > 0 &&
        premise.sourceRefIds.every((ref) => {
          const sourceText = repos.materials.getBlock(ref)?.content;
          return (
            relevantBlockIds.has(ref) &&
            Boolean(
              sourceText && normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
            )
          );
        })
      ) {
        return true;
      }
      return (
        premise.teachingSurfaceRefs.length > 0 &&
        currentSurfaceBindingAuthorities
          .get(premise.premiseKey)
          ?.every((authority) => authority === 'ai_teaching_synthesis') === true
      );
    })
  ) {
    return false;
  }
  const usesRepresentationEquivalence = contract.assessmentPremiseBindings.some((binding) => {
    const bundle = repos.sourceAuthority.getBundle(binding.truthAuthorityRecordId);
    return bundle ? authorityPremiseKind(bundle) === 'representation_equivalence' : false;
  });
  if (
    (contract.admissibilityTier === 'tier_2_validated_representation') !==
    usesRepresentationEquivalence
  ) {
    return false;
  }
  return (
    contract.provenance.length > 0 &&
    contract.provenance.every((item) => {
      const eligibleClaimIds = new Set(
        repos.sourceAuthority
          .findEligibleByBlock(contract.workspaceId, item.materialRevisionId, item.sourceBlockId)
          .flatMap((bundle) => bundle.claims.map((claim) => claim.id)),
      );
      return (
        item.truthAuthorityClaimIds.length > 0 &&
        item.truthAuthorityClaimIds.every((claimId) => eligibleClaimIds.has(claimId))
      );
    })
  );
}

function clonePlanItems(plan: StudyPlan) {
  return plan.items.map((item) => ({
    ...item,
    objectiveIds: [...item.objectiveIds],
    prerequisitePlanItemIds: [...item.prerequisitePlanItemIds],
    completionRequirements: item.completionRequirements.map((requirement) => ({
      ...requirement,
      objectiveIds: [...requirement.objectiveIds],
    })),
  }));
}

const DEPTH_ORDER: StudyPlanItem['targetDepth'][] = [
  'pass_oriented',
  'working_fluency',
  'high_performance',
  'deep_transfer',
];

function nextDepth(depth: StudyPlanItem['targetDepth']): StudyPlanItem['targetDepth'] {
  return DEPTH_ORDER[Math.min(DEPTH_ORDER.indexOf(depth) + 1, DEPTH_ORDER.length - 1)]!;
}

function setPlanItemOrder(items: StudyPlanItem[]): void {
  items.forEach((item, index) => {
    item.index = index;
  });
}

function movePlanItem(items: StudyPlanItem[], itemId: string, toIndex: number): boolean {
  const fromIndex = items.findIndex((item) => item.id === itemId);
  if (fromIndex < 0) return false;
  const [item] = items.splice(fromIndex, 1);
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, item!);
  setPlanItemOrder(items);
  return fromIndex !== toIndex;
}

function diffReplanItems(
  previous: StudyPlan,
  items: StudyPlanItem[],
  reason: string,
): StudyPlanDiffOperation[] {
  const beforeById = new Map(previous.items.map((item) => [item.id, item]));
  const afterIds = new Set(items.map((item) => item.id));
  const changes: StudyPlanDiffOperation[] = [];
  for (const item of items) {
    const before = beforeById.get(item.id);
    if (!before) {
      changes.push({
        kind: 'added',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: null,
        afterIndex: item.index,
        beforeMinutes: null,
        afterMinutes: item.estimatedMinutes,
        beforeDepth: null,
        afterDepth: item.targetDepth,
        reason,
      });
      continue;
    }
    if (before.index !== item.index) {
      changes.push({
        kind: 'reordered',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        beforeDepth: before.targetDepth,
        afterDepth: item.targetDepth,
        reason,
      });
    }
    if (before.estimatedMinutes !== item.estimatedMinutes) {
      changes.push({
        kind: 'resized',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        beforeDepth: before.targetDepth,
        afterDepth: item.targetDepth,
        reason,
      });
    }
    if (before.targetDepth !== item.targetDepth) {
      changes.push({
        kind: 'depth_changed',
        planItemId: item.id,
        curriculumLearningUnitId: item.curriculumLearningUnitId,
        beforeIndex: before.index,
        afterIndex: item.index,
        beforeMinutes: before.estimatedMinutes,
        afterMinutes: item.estimatedMinutes,
        beforeDepth: before.targetDepth,
        afterDepth: item.targetDepth,
        reason,
      });
    }
  }
  for (const item of previous.items) {
    if (afterIds.has(item.id)) continue;
    changes.push({
      kind: 'removed',
      planItemId: item.id,
      curriculumLearningUnitId: item.curriculumLearningUnitId,
      beforeIndex: item.index,
      afterIndex: null,
      beforeMinutes: item.estimatedMinutes,
      afterMinutes: null,
      beforeDepth: item.targetDepth,
      afterDepth: null,
      reason,
    });
  }
  return changes;
}

/**
 * Formal-evidence linkage and retryable progression reconciliation. The
 * existing grading service remains the first durable transaction; this
 * service can fail and be retried without regrading or mutating mastery twice.
 */
export function createFormalProgressionService({
  repos,
  progression,
  commands,
  clock,
  agendaWindow,
}: FormalProgressionDeps) {
  function stateCreditingQuestionIdsForQuiz(quizId: string): string[] | null {
    const contracts = progression.listQuestionContractsForQuiz(quizId);
    if (contracts.length === 0) return null;
    return contracts
      .filter(
        (contract) =>
          contractHasCurrentAgendaAuthority(repos, contract) &&
          contractHasCurrentPremiseAuthority(repos, contract),
      )
      .map((contract) => contract.questionId);
  }

  function registerAssessmentContracts(input: {
    workspaceId: string;
    quizId: string;
    studySessionId?: string | null;
    agendaId: string;
    agendaItemId: string;
    assessmentKind: FormalQuestionContract['assessmentKind'];
    contractVersionId: string;
    curriculumVersionId: string;
    studyPlanVersionId: string;
    executionSourceManifestFingerprint: string;
    proposalCatalogue?: FormalAssessmentProposalCatalogue;
  }): FormalQuestionContract[] {
    const curriculum = repos.curricula.get(input.curriculumVersionId);
    const contract = repos.learningContracts.get(input.contractVersionId);
    const plan = repos.studyPlans.get(input.studyPlanVersionId);
    const quiz = repos.quizzes.get(input.quizId);
    if (!curriculum || !contract || !plan || !quiz) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Formal assessment route is incomplete.');
    }
    const agenda = repos.sessionAgendas.get(input.agendaId);
    const agendaItem = agenda?.items.find((item) => item.id === input.agendaItemId);
    const planItem = plan.items.find((item) => item.id === agendaItem?.linkedPlanItemId);
    const fallbackUnit = learningUnits(curriculum).find((node) =>
      node.learningUnit?.conceptIds.includes(quiz.questions[0]?.conceptId ?? ''),
    );
    const unitId = planItem?.curriculumLearningUnitId ?? fallbackUnit?.id;
    if (!unitId) {
      throw new AppError(ApiErrorCode.ValidationError, 'Formal assessment has no LearningUnit.');
    }
    const unit = unitFor(curriculum, unitId);
    if (!unit?.learningUnit) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Formal assessment LearningUnit is unknown.',
      );
    }
    const objectiveIds = planItem?.objectiveIds.length
      ? planItem.objectiveIds
      : unit.learningUnit.objectives.map((objective) => objective.id);
    const targetDepth = planItem?.targetDepth ?? contract.desiredDepth;
    const difficulty = quiz.config.difficulty;
    const unitTransfer =
      input.assessmentKind === 'synthesis' && planItem?.synthesisMode === 'unit_transfer';
    const synthesisGroup =
      input.assessmentKind === 'synthesis' && !unitTransfer && planItem?.kind === 'synthesis'
        ? curriculum.synthesisGroups.find(
            (group) =>
              group.learningUnitIds.includes(unit.id) &&
              planItem.objectiveIds.every((objectiveId) =>
                group.objectiveIds.includes(objectiveId),
              ),
          )
        : undefined;
    const synthesisMappings = quiz.questions.map((question) => {
      if (!synthesisGroup || !planItem) return null;
      const matchingUnits = learningUnits(curriculum).filter(
        (candidate) =>
          synthesisGroup.learningUnitIds.includes(candidate.id) &&
          candidate.learningUnit!.conceptIds.includes(question.conceptId),
      );
      if (matchingUnits.length !== 1) return null;
      const matchingUnit = matchingUnits[0]!;
      const matchingObjectives = matchingUnit.learningUnit!.objectives.filter(
        (objective) =>
          planItem.objectiveIds.includes(objective.id) &&
          synthesisGroup.objectiveIds.includes(objective.id),
      );
      if (matchingObjectives.length !== 1) return null;
      return { unit: matchingUnit, objective: matchingObjectives[0]! };
    });
    const synthesisBreadthVerified =
      input.assessmentKind !== 'synthesis' ||
      (Boolean(synthesisGroup) &&
        synthesisMappings.every((mapping) => mapping !== null) &&
        new Set(synthesisMappings.map((mapping) => mapping?.unit.id)).size >= 2);
    // Existing quiz questions identify a concept and grounding block, but do
    // not carry a locally validated Curriculum objective ID. A Plan item with
    // more than one objective therefore cannot safely attribute a question by
    // position. Synthesis is the narrow exception: concept ownership must map
    // every question to exactly one group unit and one objective, and the quiz
    // must cover at least two distinct units before any question can earn
    // state credit.
    const proposalCatalogue =
      input.proposalCatalogue ??
      buildFormalAssessmentProposalCatalogue({
        repos,
        workspaceId: input.workspaceId,
        curriculum,
        plan,
        planItemId: planItem?.id ?? '',
        learningUnitId: unit.id,
      });
    const objectiveRefById = new Map(
      objectiveIds.map((objectiveId, index) => [objectiveId, `O${index + 1}`]),
    );
    const objectiveIdByRef = new Map(
      objectiveIds.map((objectiveId, index) => [`O${index + 1}`, objectiveId]),
    );
    const surfaceRecords = proposalCatalogue.surfaceRecords;
    const output = quiz.questions.map((question, index) => {
      const synthesisMapping = synthesisMappings[index];
      const questionUnit = synthesisMapping?.unit ?? unit;
      const providerObjectiveRef = question.formalProposal?.objectiveRef;
      const providerObjectiveId = providerObjectiveRef
        ? objectiveIdByRef.get(providerObjectiveRef)
        : undefined;
      const objectiveId =
        synthesisMapping?.objective.id ??
        providerObjectiveId ??
        objectiveIds[index % objectiveIds.length]!;
      const objective = questionUnit.learningUnit!.objectives.find(
        (candidate) => candidate.id === objectiveId,
      );
      if (!objective)
        throw new AppError(ApiErrorCode.ValidationError, 'Assessment objective is unknown.');
      const dueApplicationSupported =
        input.assessmentKind === 'due_review' &&
        supportsFormalApplicationDemand(objective.formalAssessmentConstruct ?? null);
      const objectiveAttributionVerified =
        input.assessmentKind === 'synthesis' && !unitTransfer
          ? Boolean(synthesisMapping) && synthesisBreadthVerified
          : objectiveIds.length === 1
            ? providerObjectiveRef === undefined || providerObjectiveId === objective.id
            : providerObjectiveRef !== undefined && providerObjectiveId === objective.id;
      const resolvedObjectiveBinding =
        input.assessmentKind === 'synthesis' && synthesisMapping
          ? {
              objectiveRef: null,
              objectiveId: objective.id,
              source: 'synthesis_mapping' as const,
            }
          : objectiveIds.length === 1 && providerObjectiveRef === undefined
            ? {
                objectiveRef: objectiveRefById.get(objective.id) ?? null,
                objectiveId: objective.id,
                source: 'single_objective_plan_item' as const,
              }
            : objectiveAttributionVerified && providerObjectiveRef
              ? {
                  objectiveRef: providerObjectiveRef,
                  objectiveId: objective.id,
                  source: 'provider_alias' as const,
                }
              : undefined;
      // Formal authority follows the question's actual verified evidence blocks.
      const relevantBlockIds = new Set([
        question.grounding.blockId,
        ...(question.supplementaryEvidence ?? []).map((item) => item.blockId),
      ]);
      const proposalPremises = question.formalProposal?.premises;
      const declaredPremises = proposalPremises?.map((premise, premiseIndex) => ({
        premiseKey: premise.premiseKey ?? `premise:${premiseIndex + 1}`,
        text: premise.text,
        sourceRefIds: premise.sourceRefs,
        teachingSurfaceRefs: premise.teachingSurfaceRefs,
        learnerVisible: premise.learnerVisible,
        scenarioLocal: premise.scenarioLocal,
        visibilityBasis: premise.visibilityBasis,
      }));
      const taughtEntries = currentTaughtExposure({
        repos,
        workspaceId: input.workspaceId,
        curriculumVersionId: curriculum.id,
        studyPlanVersionId: plan.id,
        learningUnitId: questionUnit.id,
        executionSourceManifestFingerprint: input.executionSourceManifestFingerprint,
      });
      const currentSurfaces = taughtEntries.flatMap(({ projection }) => projection?.surfaces ?? []);
      const currentSurfaceForRef = (ref: string): PresentedTeachingSurface | undefined => {
        const catalogued = surfaceRecords.get(ref);
        if (!catalogued || !catalogued.objectiveIds.includes(objective.id)) return undefined;
        return currentSurfaces.find(
          (surface) =>
            surface.checkpointId === catalogued.checkpointId &&
            surface.skeletonFingerprint === catalogued.skeletonFingerprint &&
            surface.sourceContextFingerprint === catalogued.sourceContextFingerprint &&
            surface.curriculumVersionId === catalogued.curriculumVersionId &&
            surface.studyPlanVersionId === catalogued.studyPlanVersionId &&
            surface.learningUnitId === catalogued.learningUnitId &&
            surface.executionSourceManifestFingerprint ===
              catalogued.executionSourceManifestFingerprint &&
            surface.segmentIndex === catalogued.segmentIndex &&
            surface.surfaceKind === catalogued.surfaceKind &&
            surface.surfaceOrdinal === catalogued.surfaceOrdinal &&
            surface.objectiveIds.includes(objective.id) &&
            surfaceFingerprint(surface.text) === surfaceFingerprint(catalogued.text),
        );
      };
      const premiseVisibilitySatisfied = (() => {
        if (!declaredPremises || declaredPremises.length === 0) return false;
        const currentSources = new Set(relevantBlockIds);
        const workspaceBlockTexts = repos.materials
          .listByWorkspace(input.workspaceId)
          .flatMap((material) =>
            repos.materials.getBlocks(material.id).map((block) => block.content),
          );
        const currentObjectiveRef = objectiveRefById.get(objective.id);
        const requiredRubric = question.rubric?.keyPoints.filter((point) => point.required) ?? [];
        if (
          requiredRubric.some((point) => {
            const declaration = question.formalProposal?.rubricSourceRefs.find(
              (candidate) => normalizedPremise(candidate.text) === normalizedPremise(point.text),
            );
            return (
              !declaration ||
              declaration.sourceRefs.length === 0 ||
              declaration.sourceRefs.some((ref) => !currentSources.has(ref))
            );
          })
        )
          return false;
        return declaredPremises.every((premise) => {
          if (premise.teachingSurfaceRefs.some((ref) => !currentSurfaceForRef(ref))) return false;
          if (
            !premise.learnerVisible ||
            question.formalProposal?.requiresExternalKnowledge ||
            question.formalProposal?.ambiguity === 'unresolved' ||
            (question.formalProposal?.undefinedTerms.length ?? 0) > 0
          )
            return false;
          const textInStem = normalizedPremise(question.stem).includes(
            normalizedPremise(premise.text),
          );
          const exactlyCourseSourced = workspaceBlockTexts.some((sourceText) =>
            normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
          );
          if (premise.visibilityBasis === 'stem') return textInStem;
          if (premise.visibilityBasis === 'scenario_local') {
            return (
              premise.scenarioLocal &&
              premise.sourceRefIds.length === 0 &&
              textInStem &&
              !exactlyCourseSourced
            );
          }
          if (premise.visibilityBasis === 'assumed_prerequisite') return textInStem;
          if (premise.visibilityBasis === 'cited_source') {
            return (
              premise.sourceRefIds.length > 0 &&
              premise.sourceRefIds.every((ref) => {
                const sourceText = repos.materials.getBlock(ref)?.content;
                return (
                  currentSources.has(ref) &&
                  Boolean(
                    sourceText &&
                    normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
                  )
                );
              })
            );
          }
          if (
            premise.sourceRefIds.length > 0 &&
            premise.sourceRefIds.every((ref) => {
              const sourceText = repos.materials.getBlock(ref)?.content;
              return (
                currentSources.has(ref) &&
                Boolean(
                  sourceText &&
                  normalizedPremise(sourceText).includes(normalizedPremise(premise.text)),
                )
              );
            })
          ) {
            return true;
          }
          if (!currentObjectiveRef || premise.teachingSurfaceRefs.length === 0) return false;
          return premise.teachingSurfaceRefs.every(
            (ref) => currentSurfaceForRef(ref)?.authority === 'ai_teaching_synthesis',
          );
        });
      })();
      const taughtExposureBindings = taughtEntries
        .flatMap(({ projection }) =>
          projection?.objectiveIds.includes(objective.id)
            ? (() => {
                const objectiveSurfaces = projection.surfaces.filter((surface) =>
                  surface.objectiveIds.includes(objective.id),
                );
                const surface = objectiveSurfaces[0];
                return surface
                  ? [
                      {
                        objectiveId: objective.id,
                        checkpointId: surface.checkpointId,
                        skeletonFingerprint: surface.skeletonFingerprint,
                        sourceContextFingerprint: surface.sourceContextFingerprint,
                        curriculumVersionId: curriculum.id,
                        studyPlanVersionId: plan.id,
                        learningUnitId: questionUnit.id,
                        executionSourceManifestFingerprint:
                          input.executionSourceManifestFingerprint,
                        presentedSegmentIndexes: [
                          ...new Set(objectiveSurfaces.map((candidate) => candidate.segmentIndex)),
                        ],
                        exposureClass: projection.exposureClass,
                      },
                    ]
                  : [];
              })()
            : [],
        )
        .slice(0, 1);
      const presentedTeachingSurfaceBindings = (question.formalProposal?.premises ?? []).flatMap(
        (premise, premiseIndex) =>
          premise.teachingSurfaceRefs.flatMap((ref) => {
            const surface = currentSurfaceForRef(ref);
            return surface
              ? [
                  {
                    premiseKey: premise.premiseKey ?? `premise:${premiseIndex + 1}`,
                    checkpointId: surface.checkpointId,
                    skeletonFingerprint: surface.skeletonFingerprint,
                    segmentIndex: surface.segmentIndex,
                    surfaceKind: surface.surfaceKind,
                    surfaceOrdinal: surface.surfaceOrdinal,
                    surfaceFingerprint: surfaceFingerprint(surface.text),
                  },
                ]
              : [];
          }),
      );
      // A different authorized block elsewhere in the unit cannot authorize this question's hidden scoring premises.
      const refs = questionUnit.sourceReferences
        .filter(
          (reference) =>
            reference.sourceBlockId !== null && relevantBlockIds.has(reference.sourceBlockId),
        )
        .slice(0, 20);
      const premiseResolution = buildAssessmentPremiseBindings({
        repos,
        authorityIds: objective.truthAuthorityRecordIds,
        question,
        relevantBlockIds,
      });
      const boundClaimIds = new Set(
        premiseResolution.bindings.flatMap((binding) => binding.truthAuthorityClaimIds),
      );
      const allProvenance = refs.map((reference) => ({
        materialId: reference.materialId,
        materialRevisionId: reference.materialRevisionId,
        sourceBlockId: reference.sourceBlockId!,
        sourceBlockRevisionFingerprint: reference.sourceBlockRevisionFingerprint,
        truthAuthorityClaimIds: [...boundClaimIds].filter((claimId) =>
          objective.truthAuthorityRecordIds.some((authorityId) =>
            repos.sourceAuthority
              .getBundle(authorityId)
              ?.claims.some(
                (claim) => claim.id === claimId && claim.sourceBlockId === reference.sourceBlockId,
              ),
          ),
        ),
      }));
      const premiseBindingsComplete =
        premiseResolution.required.length > 0 &&
        premiseResolution.bindings.length === premiseResolution.required.length;
      // A correct option alone does not authorize the false/classification
      // premise of every distractor. Phases 1-4 have no independently
      // validated full-option classification authority, so choice questions
      // remain advisory even when the correct option has exact source truth.
      const fullChoiceClassificationAuthorized = !(question.options && question.correctOptionIds);
      const authorizedProvenance = allProvenance.filter(
        (item) => item.truthAuthorityClaimIds.length > 0,
      );
      const semanticAuthorityReady = validateObjectiveAuthoritySemanticSupport(
        curriculum,
        [objective],
        {
          isBlockingEligible: (authorityRecordId) =>
            repos.sourceAuthority.isBlockingEligible(authorityRecordId),
        },
        'formal_admission',
      ).valid;
      const tier =
        semanticAuthorityReady &&
        (!unitTransfer || question.transferTask?.version === 'unit-transfer-v1') &&
        objectiveAttributionVerified &&
        taughtExposureBindings.length > 0 &&
        premiseVisibilitySatisfied &&
        objective.truthPremiseStatus === 'independently_verified' &&
        premiseBindingsComplete &&
        fullChoiceClassificationAuthorized &&
        authorizedProvenance.length > 0
          ? premiseResolution.usesRepresentationEquivalence
            ? 'tier_2_validated_representation'
            : 'tier_1_authorized_truth'
          : 'tier_3_advisory';
      const provenance = tier === 'tier_3_advisory' ? allProvenance : authorizedProvenance;
      return FormalQuestionContractSchema.parse({
        id: newId('formal_contract'),
        workspaceId: input.workspaceId,
        quizId: input.quizId,
        questionId: question.id,
        studySessionId: input.studySessionId ?? null,
        sessionAgendaId: input.agendaId,
        agendaItemId: input.agendaItemId,
        assessmentKind: input.assessmentKind,
        primaryObjectiveId: objective.id,
        scoredSecondaryObjectiveIds: [],
        curriculumLearningUnitId: questionUnit.id,
        difficulty,
        targetDepth,
        ...(unitTransfer && question.transferTask ? { transferTask: question.transferTask } : {}),
        representation: unitTransfer
          ? supportsFormalApplicationDemand(objective.formalAssessmentConstruct ?? null)
            ? 'transfer'
            : objective.formalAssessmentConstruct === 'explain'
              ? 'explanation'
              : 'recognition'
          : input.assessmentKind === 'synthesis'
            ? 'synthesis'
            : dueApplicationSupported
              ? 'application'
              : question.type === 'short_answer'
                ? 'recall'
                : 'recognition',
        admissibilityTier: tier,
        stableScopeFingerprint: commandFingerprint(contract.courseScope),
        contractVersionId: contract.id,
        curriculumVersionId: curriculum.id,
        studyPlanVersionId: plan.id,
        executionSourceManifestFingerprint: input.executionSourceManifestFingerprint,
        provenance,
        assessmentPremiseBindings: premiseResolution.bindings,
        ...(taughtExposureBindings.length > 0 ? { taughtExposureBindings } : {}),
        ...(presentedTeachingSurfaceBindings.length > 0
          ? { presentedTeachingSurfaceBindings }
          : {}),
        ...(declaredPremises
          ? {
              declaredPremises,
              premiseVisibilityVerdict: premiseVisibilitySatisfied
                ? ('satisfied' as const)
                : ('unsatisfied' as const),
            }
          : {}),
        ...(resolvedObjectiveBinding ? { resolvedObjectiveBinding } : {}),
        limitations:
          tier === 'tier_3_advisory'
            ? [
                !semanticAuthorityReady
                  ? 'The resolved objective has no current passing semantic-authority support; result is advisory only.'
                  : !fullChoiceClassificationAuthorized
                    ? 'Choice-question state credit requires independently validated classification authority for the full option set; correct-option truth alone is insufficient.'
                    : input.assessmentKind === 'synthesis' && !synthesisBreadthVerified
                      ? 'Synthesis state credit requires unambiguous objective attribution across at least two Curriculum LearningUnits; narrow or ambiguous results are advisory only.'
                      : !premiseBindingsComplete
                        ? 'One or more scoring answer/options/rubric premises lack an explicit independently authorized binding; result is advisory only.'
                        : !objectiveAttributionVerified
                          ? 'The question has no validated one-to-one objective attribution; result is advisory only.'
                          : !taughtExposureBindings.length
                            ? 'The resolved objective has no current, presented Lesson exposure on this route; result is advisory only.'
                            : !premiseVisibilitySatisfied
                              ? 'One or more declared premises are not structurally visible from the stem, cited source, prerequisite, or exact presented teaching surface; result is advisory only.'
                              : 'The question is advisory under the current formal-evidence policy.',
              ]
            : [],
        createdAt: clock.now().toISOString(),
      });
    });
    return progression.insertQuestionContracts(output);
  }

  function createPolicy(contractId: string): CompletionPolicy {
    const existing = progression.latestCompletionPolicy(contractId);
    const contract = repos.learningContracts.get(contractId);
    if (!contract) throw notFound('Learning Contract not found.');
    const expected = completionPolicyFor(contract);
    if (existing && existing.version >= expected.version) return existing;
    return progression.insertCompletionPolicy(expected);
  }

  function projectDecisionToExecutionRoute(
    plan: StudyPlan,
    curriculum: Curriculum,
    formalContract: FormalQuestionContract,
    policy: CompletionPolicy,
    unitId: string,
    decisionKind: ProgressionDecision['kind'],
    nextState: ProgressionDecision['nextState'],
    decisionId: string,
    at: string,
    resolvesSynthesisGap: boolean,
  ): void {
    const route = repos.courseExecution.get(plan.workspaceId);
    if (route.acceptedPlanId !== plan.id || !route.activeAgendaId) return;
    const agenda = repos.sessionAgendas.get(route.activeAgendaId);
    if (!agenda || agenda.studyPlanVersionId !== plan.id) return;
    const executedAgendaItem = agenda.items.find(
      (item) =>
        item.id === formalContract.agendaItemId &&
        item.learningUnitId === unitId &&
        item.state !== 'cancelled',
    );
    if (!executedAgendaItem) return;

    const relevantPlanItems = plan.items.filter((item) => item.curriculumLearningUnitId === unitId);
    const executedPlanItem = executedAgendaItem.linkedPlanItemId
      ? relevantPlanItems.find((item) => item.id === executedAgendaItem.linkedPlanItemId)
      : undefined;
    const planState =
      nextState === 'deferred'
        ? ('deferred' as const)
        : decisionKind === 'targeted_repair' || nextState === 'repair_needed'
          ? ('repair_needed' as const)
          : decisionKind === 'complete'
            ? ('completed' as const)
            : (executedPlanItem?.kind === 'formal_checkpoint' ||
                  executedPlanItem?.synthesisMode === 'unit_transfer') &&
                decisionKind === 'continue' &&
                executedPlanItem.objectiveIds.every((objectiveId) =>
                  progression
                    .listEvidenceForPlanUnit(plan.workspaceId, curriculum.id, plan.id, unitId)
                    .some(
                      (evidence) =>
                        evidence.primaryObjectiveId === objectiveId &&
                        evidence.stateCreditable &&
                        evidence.normalizedScore >= policy.minimumScore &&
                        (executedPlanItem.synthesisMode !== 'unit_transfer' ||
                          progression.getQuestionContract(evidence.formalQuestionContractId)
                            ?.transferTask !== undefined),
                    ),
                )
              ? ('completed' as const)
              : ('started' as const);
    if (executedPlanItem) {
      const current = repos.studyPlans
        .listProgress(plan.id)
        .find((item) => item.planItemId === executedPlanItem.id);
      if (
        current &&
        current.state !== planState &&
        (current.state !== 'completed' || planState === 'repair_needed')
      ) {
        repos.studyPlans.updateProgress(
          plan.id,
          executedPlanItem.id,
          current.version,
          planState,
          newId('plan_progress_evt'),
          `Formal progression decision ${decisionId} for Agenda item ${formalContract.agendaItemId}.`,
          at,
        );
      }
    }

    let items = agenda.items.map((item) => {
      if (item.id !== executedAgendaItem.id) return item;
      return {
        ...item,
        state:
          nextState === 'deferred'
            ? ('deferred' as const)
            : decisionKind === 'targeted_repair'
              ? ('blocked' as const)
              : ('completed' as const),
      };
    });

    if (resolvesSynthesisGap) {
      for (const planItem of relevantPlanItems) {
        if (planItem.id === executedPlanItem?.id || planItem.kind !== 'synthesis') continue;
        const current = repos.studyPlans
          .listProgress(plan.id)
          .find((item) => item.planItemId === planItem.id);
        if (current?.state === 'repair_needed') {
          repos.studyPlans.updateProgress(
            plan.id,
            planItem.id,
            current.version,
            'obsolete',
            newId('plan_progress_evt'),
            `Synthesis gap resolved by formal decision ${decisionId}.`,
            at,
          );
        }
      }
      items = items.map((item) =>
        item.id !== executedAgendaItem.id &&
        item.learningUnitId === unitId &&
        (item.kind === 'targeted_repair' ||
          (item.kind === 'synthesis' && item.state === 'blocked')) &&
        item.state !== 'completed' &&
        item.state !== 'cancelled'
          ? { ...item, state: 'cancelled' as const }
          : item,
      );
    }

    if (
      formalContract.assessmentKind === 'due_review' &&
      decisionKind === 'complete' &&
      nextState === 'complete'
    ) {
      items = items.map((item) =>
        item.id !== executedAgendaItem.id &&
        item.kind === 'targeted_repair' &&
        item.learningUnitId === unitId &&
        item.state !== 'completed' &&
        item.state !== 'cancelled'
          ? { ...item, state: 'cancelled' as const }
          : item,
      );
    }

    let preferredNextId: string | null = null;
    if (nextState === 'repair_needed' || decisionKind === 'targeted_repair') {
      const existingRepair = items.find(
        (item) =>
          item.kind === 'targeted_repair' &&
          item.learningUnitId === unitId &&
          item.state !== 'completed' &&
          item.state !== 'cancelled' &&
          item.state !== 'deferred',
      );
      if (existingRepair) {
        preferredNextId = existingRepair.id;
      } else {
        const planItem =
          executedPlanItem ??
          relevantPlanItems.find((item) => item.kind === 'formal_checkpoint') ??
          relevantPlanItems[0];
        if (planItem) {
          let launch = resolveLaunchForPlanItem(repos, clock, plan.workspaceId, curriculum, {
            kind: 'targeted_repair',
            curriculumLearningUnitId: unitId,
            objectiveIds: planItem.objectiveIds,
          });
          if (launch.status !== 'launchable') {
            // A synthesis/transfer gap may exist without an open question-level
            // mistake. Keep repair launchable through a bounded unit checkpoint.
            launch = resolveLaunchForPlanItem(repos, clock, plan.workspaceId, curriculum, {
              kind: 'formal_checkpoint',
              curriculumLearningUnitId: unitId,
              objectiveIds: planItem.objectiveIds,
            });
          }
          const repairItem = {
            id: newId('agenda_item'),
            index: Math.max(-1, ...items.map((item) => item.index)) + 1,
            kind: 'targeted_repair' as const,
            origin: 'open_repair' as const,
            reason: `Targeted repair required by formal decision ${decisionId}.`,
            estimatedMinutes: Math.max(5, Math.min(30, planItem.estimatedMinutes)),
            linkedPlanItemId: planItem.id,
            learningUnitId: unitId,
            priority: 'high' as const,
            state: launch.status === 'launchable' ? ('queued' as const) : ('blocked' as const),
            launch,
            displacedAgendaItemIds: [executedAgendaItem.id],
            timeImpactMinutes: Math.max(5, Math.min(30, planItem.estimatedMinutes)),
          };
          items = [...items, repairItem];
          preferredNextId = launch.status === 'launchable' ? repairItem.id : null;
        }
      }
    }
    const requiredSynthesisId =
      policy.requireSynthesis && nextState !== 'complete'
        ? (items.find(
            (item) =>
              item.kind === 'synthesis' &&
              item.learningUnitId === unitId &&
              item.state === 'queued' &&
              item.launch.status === 'launchable' &&
              plan.items
                .find((candidate) => candidate.id === item.linkedPlanItemId)
                ?.prerequisitePlanItemIds.every((id) =>
                  repos.studyPlans
                    .listProgress(plan.id)
                    .some((entry) => entry.planItemId === id && entry.state === 'completed'),
                ),
          )?.id ?? null)
        : null;
    const nextItemId =
      preferredNextId ??
      requiredSynthesisId ??
      items.find((item) => item.state === 'queued' && item.launch.status === 'launchable')?.id ??
      null;
    const updatedAgenda = repos.sessionAgendas.update(
      {
        ...agenda,
        version: agenda.version + 1,
        items,
        currentItemId: nextItemId,
        updatedAt: at,
      },
      agenda.version,
      {
        id: newId('agenda_event'),
        eventType: 'formal_progression_applied',
        actor: 'local',
        payload: {
          decisionId,
          unitId,
          nextState,
          executedAgendaItemId: formalContract.agendaItemId,
          linkedPlanItemId: executedPlanItem?.id ?? null,
          completionPolicyId: policy.id,
          currentItemId: nextItemId,
        },
        createdAt: at,
      },
    );
    for (const session of repos.studySessions
      .list(plan.workspaceId)
      .filter(
        (candidate) =>
          candidate.sessionAgendaId === agenda.id &&
          (candidate.status === 'active' || candidate.status === 'paused'),
      )) {
      repos.studySessions.update(
        {
          ...session,
          version: session.version + 1,
          currentAgendaItemId: updatedAgenda.currentItemId,
          updatedAt: at,
        },
        session.version,
      );
    }
    // A null next item is the assessment-side drain point. It shares the one
    // continuation predicate with Lesson completion so assessment-bearing and
    // teaching-only Agendas advance identically.
    if (nextItemId === null) {
      agendaWindow.continueIfDrained(plan.workspaceId, decisionId);
    }
  }

  function reconcile(
    workspaceId: string,
    gradingResultId: string,
    expected?: { studyPlanId: string; manifestFingerprint: string },
  ): ReturnType<typeof ProgressionReconciliationResponseSchema.parse> {
    const result = repos.submissions.getGradingResult(gradingResultId);
    if (!result) throw notFound('Grading result not found.');
    const quiz = repos.quizzes.get(result.quizId);
    if (!quiz || (quiz.workspaceId && quiz.workspaceId !== workspaceId)) {
      throw notFound('Grading result not found.');
    }
    const contracts = progression.listQuestionContractsForQuiz(quiz.id);
    if (contracts.length === 0) {
      throw new AppError(
        ApiErrorCode.ValidationError,
        'Grading result has no formal Agent contract.',
      );
    }
    if (
      expected &&
      contracts.some(
        (contract) =>
          contract.studyPlanVersionId !== expected.studyPlanId ||
          contract.executionSourceManifestFingerprint !== expected.manifestFingerprint,
      )
    ) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Formal evidence context is stale.');
    }
    const acceptedRouteChanged = Boolean(
      expected && repos.courseExecution.get(workspaceId).acceptedPlanId !== expected.studyPlanId,
    );
    const evidence: FormalEvidenceRecord[] = [];
    const decisions: ProgressionDecision[] = [];
    const reconciliations: ProgressionReconciliation[] = [];
    const replanTriggers: ReplanTrigger[] = [];
    const currentlyAgendaAuthorizedQuestionIds = new Set(
      contracts
        .filter((contract) => contractHasCurrentAgendaAuthority(repos, contract))
        .map((contract) => contract.questionId),
    );
    const currentlyCreditableQuestionIds = new Set(stateCreditingQuestionIdsForQuiz(quiz.id) ?? []);
    const grouped = new Map<string, FormalQuestionContract[]>();
    for (const contract of contracts) {
      grouped.set(contract.curriculumLearningUnitId, [
        ...(grouped.get(contract.curriculumLearningUnitId) ?? []),
        contract,
      ]);
      const grade = result.grades.find((candidate) => candidate.questionId === contract.questionId);
      if (!grade) continue;
      const record = FormalEvidenceRecordSchema.parse({
        id: newId('evidence'),
        formalQuestionContractId: contract.id,
        gradingResultId,
        questionId: contract.questionId,
        primaryObjectiveId: contract.primaryObjectiveId,
        curriculumLearningUnitId: contract.curriculumLearningUnitId,
        admissibilityTier: contract.admissibilityTier,
        normalizedScore: grade.normalizedScore,
        correct: grade.correct,
        needsReview: grade.needsReview,
        stateCreditable:
          currentlyCreditableQuestionIds.has(contract.questionId) &&
          (!contract.transferTask || transferPerformancePassed(grade.transferPerformance)),
        assessmentPremiseBindingIds: contract.assessmentPremiseBindings.map(
          (binding) => binding.id,
        ),
        limitations: currentlyCreditableQuestionIds.has(contract.questionId)
          ? contract.limitations
          : [
              ...contract.limitations,
              ...(isStateCreditingAdmissibility(contract.admissibilityTier)
                ? [
                    currentlyAgendaAuthorizedQuestionIds.has(contract.questionId)
                      ? 'Premise authority is no longer current; result is advisory only.'
                      : 'Exact Agenda route authority is no longer current; result is advisory only.',
                  ]
                : []),
            ],
        createdAt: clock.now().toISOString(),
      });
      try {
        evidence.push(progression.insertEvidence(record));
      } catch (error) {
        const prior = progression
          .listEvidenceForGrading(gradingResultId)
          .find((item) => item.formalQuestionContractId === contract.id);
        if (prior) evidence.push(prior);
        else throw error;
      }
    }

    for (const [unitId, unitContracts] of grouped) {
      const first = unitContracts[0]!;
      const policy = createPolicy(first.contractVersionId);
      const now = clock.now().toISOString();
      const reconciliation = progression.createReconciliation({
        id: newId('reconcile'),
        workspaceId,
        gradingResultId,
        curriculumVersionId: first.curriculumVersionId,
        studyPlanVersionId: first.studyPlanVersionId,
        curriculumLearningUnitId: unitId,
        completionPolicyId: policy.id,
        completionPolicyVersion: policy.version,
        status: 'reconciliation_pending',
        decisionId: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
      });
      if (acceptedRouteChanged && reconciliation.status === 'reconciliation_pending') {
        reconciliations.push(
          progression.updateReconciliation({
            ...reconciliation,
            status: 'stale',
            reason:
              'Accepted StudyPlan changed after grading; evidence is retained but cannot mutate the successor route.',
            updatedAt: now,
          }),
        );
        continue;
      }
      if (reconciliation.status !== 'reconciliation_pending') {
        reconciliations.push(reconciliation);
        if (reconciliation.decisionId) {
          const prior = progression.getDecision(reconciliation.decisionId);
          if (prior) decisions.push(prior);
        }
        continue;
      }

      const unitEvidence = progression.listEvidenceForPlanUnit(
        workspaceId,
        first.curriculumVersionId,
        first.studyPlanVersionId,
        unitId,
      );
      const eligible = unitEvidence.filter(
        (item) => item.stateCreditable && isStateCreditingAdmissibility(item.admissibilityTier),
      );
      const currentEligible = eligible.filter((item) => item.gradingResultId === gradingResultId);
      if (currentEligible.length === 0) {
        reconciliations.push(
          progression.rejectReconciliation(
            reconciliation.id,
            'No independently admissible evidence from the current authorized Agenda item; the result remains advisory.',
            now,
          ),
        );
        continue;
      }
      const passed = eligible.filter((item) => item.normalizedScore >= policy.minimumScore);
      const currentFailed = currentEligible.some(
        (item) => item.normalizedScore < policy.minimumScore,
      );
      const failedEvidence = eligible.filter((item) => item.normalizedScore < policy.minimumScore);
      const currentFailedEvidence = currentEligible.filter(
        (item) => item.normalizedScore < policy.minimumScore,
      );
      const plan = repos.studyPlans.get(first.studyPlanVersionId);
      const routeCurriculum = repos.curricula.get(first.curriculumVersionId);
      if (!plan || !routeCurriculum) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Formal progression route is no longer available.',
        );
      }
      const blockingObjectiveIds = new Set(
        plan.items
          .filter((item) => item.curriculumLearningUnitId === unitId)
          .flatMap((item) =>
            item.completionRequirements
              .filter((requirement) => requirement.blocking)
              .flatMap((requirement) => requirement.objectiveIds),
          ),
      );
      const passedObjectiveIds = new Set(
        passed
          .filter(
            (item) =>
              policy.version < 3 ||
              !progression.getQuestionContract(item.formalQuestionContractId)?.transferTask,
          )
          .map((item) => item.primaryObjectiveId),
      );
      const blockingObjectivesSatisfied = [...blockingObjectiveIds].every((objectiveId) =>
        passedObjectiveIds.has(objectiveId),
      );
      const synthesisRequired = policy.requireSynthesis;
      const evidenceContracts = new Map(
        eligible.map((item) => [
          item.id,
          progression.getQuestionContract(item.formalQuestionContractId),
        ]),
      );
      const synthesisEvidence = eligible.filter((item) =>
        policy.version >= 3
          ? evidenceContracts.get(item.id)?.transferTask !== undefined
          : evidenceContracts.get(item.id)?.representation === 'synthesis',
      );
      const passedSynthesisEvidence = synthesisEvidence.filter(
        (item) => item.normalizedScore >= policy.minimumScore,
      );
      const synthesisSatisfied =
        !synthesisRequired ||
        (policy.version >= 3
          ? blockingObjectiveIds.size > 0 &&
            [...blockingObjectiveIds].every((id) =>
              passedSynthesisEvidence.some((item) => item.primaryObjectiveId === id),
            )
          : passedSynthesisEvidence.length > 0);
      const currentFailedSynthesisEvidence = currentFailedEvidence.filter(
        (item) => evidenceContracts.get(item.id)?.representation === 'synthesis',
      );
      const failedSynthesis = currentFailedSynthesisEvidence.some(
        (item) => item.normalizedScore < policy.minimumScore,
      );
      const kind = currentFailed
        ? 'targeted_repair'
        : passed.length >= policy.minimumEligibleEvidenceCount &&
            synthesisSatisfied &&
            blockingObjectivesSatisfied
          ? 'complete'
          : 'continue';
      const synthesisRiskId = `risk_synthesis_${commandFingerprint({
        contractId: first.contractVersionId,
        unitId,
      })}`;
      const currentAssessmentKinds = new Set(
        unitContracts.map((candidate) => candidate.assessmentKind),
      );
      const resolvesSynthesisGap =
        !currentFailed &&
        currentEligible.length > 0 &&
        (currentAssessmentKinds.has('synthesis') ||
          currentAssessmentKinds.has('targeted_repair')) &&
        repos.coverageRisks.get(synthesisRiskId)?.status !== undefined &&
        repos.coverageRisks.get(synthesisRiskId)?.status !== 'resolved';
      const prior = progression.getUnitProgress(workspaceId, first.curriculumVersionId, unitId);
      const preserveCompleted = prior.state === 'complete' && kind !== 'complete';
      const nextState = preserveCompleted
        ? 'complete'
        : kind === 'complete'
          ? 'complete'
          : kind === 'targeted_repair'
            ? 'repair_needed'
            : 'in_progress';
      const reasonCodes = preserveCompleted
        ? failedSynthesis
          ? ['prior_completion_preserved', 'synthesis_transfer_gap']
          : ['prior_completion_preserved']
        : kind === 'complete'
          ? ['eligible_evidence_satisfied']
          : currentFailed
            ? ['eligible_evidence_below_policy']
            : synthesisRequired && !synthesisSatisfied
              ? ['synthesis_required']
              : !blockingObjectivesSatisfied
                ? ['blocking_objective_evidence_missing']
                : ['insufficient_eligible_evidence'];
      if (failedSynthesis) {
        const synthesisContract = unitContracts.find(
          (candidate) => candidate.assessmentKind === 'synthesis',
        );
        const curriculum = repos.curricula.get(first.curriculumVersionId);
        const curriculumUnit = curriculum ? unitFor(curriculum, unitId) : undefined;
        const objective = curriculumUnit?.learningUnit?.objectives.find(
          (candidate) => candidate.id === synthesisContract?.primaryObjectiveId,
        );
        if (synthesisContract && objective) {
          const firstProvenance = synthesisContract.provenance[0] ?? null;
          const existingSynthesisRisk = repos.coverageRisks.get(synthesisRiskId);
          if (!existingSynthesisRisk) {
            const risk: CoverageRiskEntry = {
              id: synthesisRiskId,
              workspaceId,
              contractVersionId: first.contractVersionId,
              stableScopeFingerprint: synthesisContract.stableScopeFingerprint,
              materialId: firstProvenance?.materialId ?? null,
              topicId: null,
              objectiveId: objective.id,
              facets: ['formally_assessed', 'transfer_integration_risk'],
              scopeAuthorityStatus: 'in_scope',
              truthPremiseStatus: objective.truthPremiseStatus,
              truthAuthorityRecordIds: objective.truthAuthorityRecordIds,
              referencedCurriculumNodeIds: [unitId],
              referencedConceptIds: curriculumUnit?.learningUnit?.conceptIds ?? [],
              referencedEvidenceIds: currentFailedSynthesisEvidence
                .slice(0, 50)
                .map((item) => item.id),
              origin: 'deterministic',
              status: 'planned',
              severity: 'high',
              priority: 80,
              contractSensitive: true,
              claim: `Synthesis gap: ${objective.title}`,
              uncertainty:
                'Formal synthesis evidence did not satisfy the current completion policy; a bounded targeted repair is required.',
              observations: firstProvenance
                ? [
                    {
                      id: newId('risk_observation'),
                      materialRevisionId: firstProvenance.materialRevisionId,
                      sourceBlockId: firstProvenance.sourceBlockId,
                      sourceBlockRevisionFingerprint:
                        firstProvenance.sourceBlockRevisionFingerprint,
                      executionSourceManifestFingerprint:
                        synthesisContract.executionSourceManifestFingerprint,
                      reconciliationStatus: 'current',
                      observedAt: now,
                      lastVerifiedAt: now,
                    },
                  ]
                : [],
              resolutionEvidenceIds: [],
              learnerDecisionId: null,
              provider: null,
              providerModel: null,
              promptVersion: null,
              firstObservedAt: now,
              updatedAt: now,
            };
            repos.coverageRisks.create(risk, {
              id: newId('risk_evt'),
              eventType: 'formal_synthesis_gap_recorded',
              actor: 'local',
              payload: {
                gradingResultId,
                reconciliationId: reconciliation.id,
                targetedRepairRequired: true,
              },
              createdAt: now,
            });
          } else {
            repos.coverageRisks.recordOutstanding(
              synthesisRiskId,
              currentFailedSynthesisEvidence.map((item) => item.id),
              {
                id: newId('risk_evt'),
                eventType: 'formal_synthesis_gap_recorded',
                actor: 'local',
                payload: {
                  gradingResultId,
                  reconciliationId: reconciliation.id,
                  targetedRepairRequired: true,
                },
                createdAt: now,
              },
            );
          }
        }
      }
      const automaticTriggerKind = failedSynthesis
        ? ('synthesis_failure' as const)
        : currentFailed && failedEvidence.length >= 2
          ? ('repeated_formal_evidence' as const)
          : currentFailed &&
              unitContracts.some((candidate) => candidate.assessmentKind === 'targeted_repair')
            ? ('strong_prerequisite_failure' as const)
            : null;
      if (automaticTriggerKind) {
        const affectedPlanItemIds =
          plan?.items
            .filter((item) => item.curriculumLearningUnitId === unitId)
            .map((item) => item.id) ?? [];
        replanTriggers.push(
          progression.insertReplanTrigger({
            id: newId('replan_trigger'),
            workspaceId,
            acceptedStudyPlanId: first.studyPlanVersionId,
            kind: automaticTriggerKind,
            status: 'qualified',
            evidenceIds: failedEvidence.slice(0, 100).map((item) => item.id),
            reason:
              automaticTriggerKind === 'synthesis_failure'
                ? `Formal synthesis failed for LearningUnit ${unitId}.`
                : automaticTriggerKind === 'strong_prerequisite_failure'
                  ? `Formal prerequisite repair failed for LearningUnit ${unitId}.`
                  : `Repeated formal evidence remains below policy for LearningUnit ${unitId}.`,
            facts: {
              qualifyingOccurrences: Math.max(1, failedEvidence.length),
              affectedLearningUnitIds: [unitId],
              affectedPlanItemIds,
              observedMinutesPerWeek: null,
              sourceManifestFingerprint: first.executionSourceManifestFingerprint,
              learnerConfirmedChange: false,
            },
            proposedStudyPlanId: null,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      const progressDecision: ProgressionDecision = {
        id: newId('progression'),
        workspaceId,
        curriculumLearningUnitId: unitId,
        completionPolicyId: policy.id,
        completionPolicyVersion: policy.version,
        kind,
        priorState: prior.state,
        nextState,
        evidenceIds: eligible.map((item) => item.id),
        reasonCodes,
        createdAt: now,
      };
      const applied = repos.transaction(() => {
        const result = progression.applyDecision(
          reconciliation.id,
          progressDecision,
          prior.version,
        );
        projectDecisionToExecutionRoute(
          plan,
          routeCurriculum,
          first,
          policy,
          unitId,
          result.decision.kind,
          result.decision.nextState,
          result.decision.id,
          now,
          resolvesSynthesisGap,
        );
        if (resolvesSynthesisGap) {
          repos.coverageRisks.resolve(
            synthesisRiskId,
            currentEligible.map((item) => item.id),
            {
              id: newId('risk_evt'),
              eventType: 'formal_synthesis_gap_resolved',
              actor: 'local',
              payload: { gradingResultId, reconciliationId: reconciliation.id },
              createdAt: now,
            },
          );
          const trigger = progression.findReplanTriggerByIdentity(
            first.studyPlanVersionId,
            'synthesis_failure',
            `Formal synthesis failed for LearningUnit ${unitId}.`,
          );
          if (trigger && trigger.status !== 'resolved') {
            progression.updateReplanTrigger({ ...trigger, status: 'resolved', updatedAt: now });
          }
        }
        return result;
      });
      reconciliations.push(applied.reconciliation);
      decisions.push(applied.decision);
    }
    return ProgressionReconciliationResponseSchema.parse({
      reconciliations,
      decisions,
      evidence,
      replanTriggers,
    });
  }

  function reconcileCommand(input: unknown) {
    const parsed = ReconcileProgressionRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'reconcile_progression', {
      gradingResultId: parsed.gradingResultId,
      expectedStudyPlanId: parsed.expectedStudyPlanId,
      expectedExecutionSourceManifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
    });
    if (claim.replayPayload !== undefined)
      return ProgressionReconciliationResponseSchema.parse(claim.replayPayload);
    try {
      return commands.complete(claim, () =>
        reconcile(parsed.command.workspaceId, parsed.gradingResultId, {
          studyPlanId: parsed.expectedStudyPlanId,
          manifestFingerprint: parsed.expectedExecutionSourceManifestFingerprint,
        }),
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function reconcileAfterGrading(
    gradingResultId: string,
    expected?: { studyPlanId: string; manifestFingerprint: string },
  ) {
    const result = repos.submissions.getGradingResult(gradingResultId);
    if (!result) throw notFound('Grading result not found.');
    const quiz = repos.quizzes.get(result.quizId);
    if (!quiz) throw notFound('Quiz not found.');
    if (progression.listQuestionContractsForQuiz(quiz.id).length === 0) return null;
    const workspaceId =
      quiz.workspaceId ??
      (quiz.materialId ? repos.materials.get(quiz.materialId)?.workspaceId : undefined);
    if (!workspaceId) throw new Error('Formal assessment workspace is unavailable.');
    const questionContract = progression.listQuestionContractsForQuiz(quiz.id)[0]!;
    return repos.transaction(() =>
      reconcile(workspaceId, gradingResultId, {
        studyPlanId: expected?.studyPlanId ?? questionContract.studyPlanVersionId,
        manifestFingerprint:
          expected?.manifestFingerprint ?? questionContract.executionSourceManifestFingerprint,
      }),
    );
  }

  function retryContextForGrading(gradingResultId: string) {
    const result = repos.submissions.getGradingResult(gradingResultId);
    if (!result) return null;
    const contract = progression.listQuestionContractsForQuiz(result.quizId)[0];
    return contract
      ? {
          gradingResultId,
          expectedStudyPlanId: contract.studyPlanVersionId,
          expectedExecutionSourceManifestFingerprint: contract.executionSourceManifestFingerprint,
        }
      : null;
  }

  function qualifyReplanTrigger(input: unknown): ReplanTrigger {
    const parsed = QualifyReplanTriggerRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'qualify_replan_trigger', {
      acceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
      kind: parsed.kind,
      evidenceIds: parsed.evidenceIds,
      reason: parsed.reason,
      facts: parsed.facts,
    });
    if (claim.replayPayload !== undefined) return ReplanTriggerSchema.parse(claim.replayPayload);
    try {
      const state = repos.courseExecution.get(parsed.command.workspaceId);
      if (state.acceptedPlanId !== parsed.expectedAcceptedStudyPlanId) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Accepted StudyPlan pointer is stale.');
      }
      const plan = repos.studyPlans.get(parsed.expectedAcceptedStudyPlanId);
      if (!plan || plan.status !== 'accepted') throw notFound('Accepted StudyPlan not found.');
      const curriculum = repos.curricula.get(plan.curriculumVersionId);
      const contract = repos.learningContracts.get(plan.contractVersionId);
      if (!curriculum || !contract) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Accepted route context is incomplete.');
      }
      const learnerAuthoritative = new Set([
        'deadline_or_target_change',
        'sustained_study_time_change',
        'learner_scope_change',
        'promoted_detour',
      ]).has(parsed.kind);
      if (learnerAuthoritative && parsed.command.actor !== 'learner') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'This replan trigger requires explicit learner authority.',
        );
      }

      const units = new Map(learningUnits(curriculum).map((unit) => [unit.id, unit]));
      const planItems = new Map(plan.items.map((item) => [item.id, item]));
      const suppliedUnitIds = [...new Set(parsed.facts.affectedLearningUnitIds)];
      const suppliedItemIds = [...new Set(parsed.facts.affectedPlanItemIds)];
      for (const unitId of suppliedUnitIds) {
        if (!units.has(unitId)) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            `Unknown affected LearningUnit: ${unitId}`,
          );
        }
      }
      for (const itemId of suppliedItemIds) {
        const item = planItems.get(itemId);
        if (!item) {
          throw new AppError(ApiErrorCode.ValidationError, `Unknown affected Plan item: ${itemId}`);
        }
        if (
          suppliedUnitIds.length > 0 &&
          item.curriculumLearningUnitId &&
          !suppliedUnitIds.includes(item.curriculumLearningUnitId)
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            `Affected Plan item ${itemId} is outside the declared LearningUnit scope.`,
          );
        }
      }

      const evidenceIds = [...new Set(parsed.evidenceIds)];
      const evidence = evidenceIds.map((evidenceId) => {
        const record = progression.getEvidence(evidenceId);
        const questionContract = record
          ? progression.getQuestionContract(record.formalQuestionContractId)
          : undefined;
        if (
          !record ||
          !questionContract ||
          questionContract.workspaceId !== parsed.command.workspaceId ||
          questionContract.contractVersionId !== plan.contractVersionId ||
          questionContract.curriculumVersionId !== plan.curriculumVersionId ||
          questionContract.studyPlanVersionId !== plan.id ||
          questionContract.executionSourceManifestFingerprint !==
            plan.executionSourceManifestFingerprint
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            `Replan evidence is absent or outside the accepted route: ${evidenceId}`,
          );
        }
        return { record, questionContract };
      });
      const evidenceKinds = new Set([
        'repeated_formal_evidence',
        'synthesis_failure',
        'strong_prerequisite_failure',
      ]);
      if (evidenceKinds.has(parsed.kind) && evidence.length === 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          `${parsed.kind} requires current formal evidence.`,
        );
      }
      const eligibleEvidence = evidence.filter(
        ({ record }) =>
          record.stateCreditable && isStateCreditingAdmissibility(record.admissibilityTier),
      );
      const evidenceUnitIds = [
        ...new Set(eligibleEvidence.map(({ record }) => record.curriculumLearningUnitId)),
      ];
      const affectedLearningUnitIds =
        evidenceKinds.has(parsed.kind) && evidenceUnitIds.length > 0
          ? evidenceUnitIds
          : suppliedUnitIds;
      const affectedPlanItemIds =
        suppliedItemIds.length > 0
          ? suppliedItemIds
          : plan.items
              .filter((item) =>
                item.curriculumLearningUnitId
                  ? affectedLearningUnitIds.includes(item.curriculumLearningUnitId)
                  : false,
              )
              .map((item) => item.id);
      for (const itemId of affectedPlanItemIds) {
        const unitId = planItems.get(itemId)?.curriculumLearningUnitId;
        if (
          unitId &&
          affectedLearningUnitIds.length > 0 &&
          !affectedLearningUnitIds.includes(unitId)
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            `Affected Plan item ${itemId} does not match the locally verified evidence scope.`,
          );
        }
      }

      let qualifyingOccurrences = parsed.facts.qualifyingOccurrences;
      let qualifies = false;
      if (parsed.kind === 'deadline_or_target_change') {
        qualifyingOccurrences = parsed.facts.learnerConfirmedChange ? 1 : 0;
        qualifies = parsed.facts.learnerConfirmedChange;
      } else if (parsed.kind === 'sustained_study_time_change') {
        const currentWeekly =
          contract.studyBudget.minutesPerWeek ??
          (contract.studyBudget.minutesPerDay === null
            ? null
            : contract.studyBudget.minutesPerDay * 7);
        const observed = parsed.facts.observedMinutesPerWeek;
        const materiallyChanged =
          observed !== null &&
          (currentWeekly === null ||
            Math.abs(observed - currentWeekly) >= Math.max(30, currentWeekly * 0.2));
        qualifies =
          parsed.facts.learnerConfirmedChange &&
          materiallyChanged &&
          parsed.facts.qualifyingOccurrences >= 2;
      } else if (parsed.kind === 'persistent_pace_risk') {
        const progress = new Map(
          repos.studyPlans.listProgress(plan.id).map((item) => [item.planItemId, item.state]),
        );
        const nowMs = clock.now().getTime();
        const missedMilestones =
          plan.paceBaseline?.milestones.filter(
            (milestone) =>
              new Date(milestone.at).getTime() <= nowMs &&
              milestone.throughPlanItemId !== null &&
              progress.get(milestone.throughPlanItemId) !== 'completed',
          ).length ?? 0;
        qualifyingOccurrences =
          (plan.feasibility.state === 'at_risk' || plan.feasibility.state === 'infeasible'
            ? 1
            : 0) + missedMilestones;
        qualifies = qualifyingOccurrences >= 2;
      } else if (parsed.kind === 'learner_scope_change') {
        qualifyingOccurrences = parsed.facts.learnerConfirmedChange ? 1 : 0;
        qualifies = parsed.facts.learnerConfirmedChange && affectedLearningUnitIds.length > 0;
      } else if (parsed.kind === 'promoted_detour') {
        qualifyingOccurrences = parsed.facts.learnerConfirmedChange ? 1 : 0;
        qualifies = parsed.facts.learnerConfirmedChange && affectedLearningUnitIds.length === 1;
      } else if (parsed.kind === 'repeated_formal_evidence') {
        qualifyingOccurrences = eligibleEvidence.length;
        qualifies = qualifyingOccurrences >= 2;
      } else if (parsed.kind === 'synthesis_failure') {
        const policy = completionPolicyFor(contract);
        const failures = eligibleEvidence.filter(
          ({ record, questionContract }) =>
            questionContract.assessmentKind === 'synthesis' &&
            record.normalizedScore < policy.minimumScore,
        );
        qualifyingOccurrences = failures.length;
        qualifies = failures.length > 0;
      } else if (parsed.kind === 'strong_prerequisite_failure') {
        const policy = completionPolicyFor(contract);
        const failedUnitIds = new Set(
          eligibleEvidence
            .filter(({ record }) => record.normalizedScore < policy.minimumScore)
            .map(({ record }) => record.curriculumLearningUnitId),
        );
        const prerequisiteFailures = [...failedUnitIds].filter((unitId) =>
          [...units.values()].some((unit) =>
            unit.learningUnit!.prerequisiteUnitIds.includes(unitId),
          ),
        );
        qualifyingOccurrences = prerequisiteFailures.length;
        qualifies = prerequisiteFailures.length > 0;
      } else if (parsed.kind === 'source_manifest_change') {
        qualifyingOccurrences =
          parsed.facts.sourceManifestFingerprint !== null &&
          parsed.facts.sourceManifestFingerprint !== plan.executionSourceManifestFingerprint
            ? 1
            : 0;
        qualifies = qualifyingOccurrences === 1;
      }
      const facts = {
        ...parsed.facts,
        qualifyingOccurrences,
        affectedLearningUnitIds,
        affectedPlanItemIds,
      };
      const now = clock.now().toISOString();
      return commands.complete(claim, () =>
        progression.insertReplanTrigger({
          id: newId('replan_trigger'),
          workspaceId: parsed.command.workspaceId,
          acceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
          kind: parsed.kind,
          status: qualifies ? 'qualified' : 'candidate',
          evidenceIds,
          reason: parsed.reason,
          facts,
          proposedStudyPlanId: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function proposeQualifiedReplan(input: unknown) {
    const parsed = ProposeQualifiedReplanRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'propose_replan', {
      triggerId: parsed.triggerId,
      expectedAcceptedStudyPlanId: parsed.expectedAcceptedStudyPlanId,
    });
    if (claim.replayPayload !== undefined)
      return claim.replayPayload as { trigger: ReplanTrigger; studyPlan: StudyPlan };
    try {
      const trigger = progression.getReplanTrigger(parsed.triggerId);
      const currentState = repos.courseExecution.get(parsed.command.workspaceId);
      if (!trigger || trigger.workspaceId !== parsed.command.workspaceId)
        throw notFound('Replan trigger not found.');
      if (trigger.status !== 'qualified')
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Only a qualified replan trigger may produce a proposal.',
        );
      if (
        currentState.acceptedPlanId !== parsed.expectedAcceptedStudyPlanId ||
        trigger.acceptedStudyPlanId !== parsed.expectedAcceptedStudyPlanId
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Accepted StudyPlan pointer is stale.');
      }
      const accepted = repos.studyPlans.get(parsed.expectedAcceptedStudyPlanId);
      if (!accepted || accepted.status !== 'accepted')
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Accepted StudyPlan is no longer executable.',
        );
      if (trigger.kind === 'deadline_or_target_change' || trigger.kind === 'learner_scope_change') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'This trigger changes learner intention and requires a successor Learning Contract before a StudyPlan can be proposed.',
        );
      }
      const latest = repos.studyPlans.list(parsed.command.workspaceId).at(-1) ?? accepted;
      let items = clonePlanItems(accepted);
      let curriculum = repos.curricula.get(accepted.curriculumVersionId);
      if (!curriculum) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Replan Curriculum is unavailable.');
      }
      if (trigger.kind === 'source_manifest_change') {
        const targetFingerprint = trigger.facts.sourceManifestFingerprint;
        const compatible = [...repos.curricula.list(parsed.command.workspaceId)]
          .reverse()
          .find(
            (candidate) =>
              candidate.status === 'accepted' &&
              candidate.contractVersionId === accepted.contractVersionId &&
              candidate.executionSourceManifest.fingerprint === targetFingerprint,
          );
        if (!compatible) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Source-manifest replanning requires a learner-accepted compatible Curriculum; the prior route was preserved.',
          );
        }
        curriculum = compatible;
      }
      const contract = repos.learningContracts.get(accepted.contractVersionId);
      if (!contract) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Replan Learning Contract is unavailable.',
        );
      }
      const affectedIds = new Set(trigger.facts.affectedPlanItemIds);
      const affectedUnits = new Set(trigger.facts.affectedLearningUnitIds);
      const targetItem = () =>
        items.find((item) => affectedIds.has(item.id)) ??
        items.find(
          (item) =>
            item.curriculumLearningUnitId !== null &&
            affectedUnits.has(item.curriculumLearningUnitId),
        );

      let deferrals = accepted.deferrals.map((deferral) => ({
        ...deferral,
        objectiveIds: [...deferral.objectiveIds],
        riskIds: [...deferral.riskIds],
      }));
      if (trigger.kind === 'promoted_detour') {
        let target = targetItem();
        if (!target) {
          const unitId = trigger.facts.affectedLearningUnitIds[0]!;
          const unit = learningUnits(curriculum).find((candidate) => candidate.id === unitId);
          if (!unit?.learningUnit) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              'The promoted detour is not represented by the accepted Curriculum.',
            );
          }
          target = {
            id: newId('plan_item'),
            index: 0,
            phase: 'Promoted detour',
            kind: 'teach_unit',
            curriculumLearningUnitId: unit.id,
            rationale: trigger.reason,
            estimatedMinutes: Math.max(10, contract.studyBudget.preferredSessionMinutes ?? 20),
            targetDepth: contract.desiredDepth,
            objectiveIds: unit.learningUnit.objectives.map((objective) => objective.id),
            prerequisitePlanItemIds: [],
            completionPolicy: null,
            completionRequirements: [],
          };
          items.unshift(target);
          deferrals = deferrals.filter((deferral) => deferral.curriculumLearningUnitId !== unit.id);
          setPlanItemOrder(items);
        } else if (!movePlanItem(items, target.id, 0)) {
          const deepened = nextDepth(target.targetDepth);
          target.targetDepth = deepened;
          target.estimatedMinutes = Math.min(240, target.estimatedMinutes + 10);
        }
      } else if (trigger.kind === 'repeated_formal_evidence') {
        const target = targetItem();
        if (!target) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Formal evidence has no current Plan item.',
          );
        }
        const evidence = trigger.evidenceIds
          .map((id) => progression.getEvidence(id))
          .filter((record): record is FormalEvidenceRecord => Boolean(record));
        const policy = completionPolicyFor(contract);
        const hasFailure = evidence.some((record) => record.normalizedScore < policy.minimumScore);
        target.estimatedMinutes = hasFailure
          ? Math.min(240, target.estimatedMinutes + 10)
          : Math.max(5, Math.floor(target.estimatedMinutes * 0.8));
        if (hasFailure) movePlanItem(items, target.id, 0);
      } else if (
        trigger.kind === 'synthesis_failure' ||
        trigger.kind === 'strong_prerequisite_failure'
      ) {
        const target =
          (trigger.kind === 'synthesis_failure'
            ? items.find(
                (item) =>
                  item.kind === 'synthesis' &&
                  item.curriculumLearningUnitId &&
                  affectedUnits.has(item.curriculumLearningUnitId),
              )
            : undefined) ?? targetItem();
        if (!target) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Repair trigger has no current Plan item.',
          );
        }
        target.estimatedMinutes = Math.min(240, target.estimatedMinutes + 10);
        movePlanItem(items, target.id, 0);
      } else if (
        trigger.kind === 'sustained_study_time_change' ||
        trigger.kind === 'persistent_pace_risk'
      ) {
        const target = targetItem();
        if (target) movePlanItem(items, target.id, 0);
      }
      setPlanItemOrder(items);
      // A replan is a new learner-visible proposal. Any legacy or adaptive minute
      // adjustment is advisory input only; persist the planner-derived duration.
      items = deriveTeachUnitDurationsOrThrow(curriculum, items);

      const projectedMinutes = items.reduce((sum, item) => sum + item.estimatedMinutes, 0);
      let availableMinutes = accepted.feasibility.availableMinutes;
      if (
        trigger.kind === 'sustained_study_time_change' &&
        trigger.facts.observedMinutesPerWeek !== null
      ) {
        const remainingWeeks = contract.deadline
          ? Math.max(
              1,
              Math.ceil(
                (new Date(contract.deadline.at).getTime() - clock.now().getTime()) /
                  (7 * 24 * 60 * 60 * 1000),
              ),
            )
          : 1;
        availableMinutes = trigger.facts.observedMinutesPerWeek * remainingWeeks;
      }
      const slackMinutes = availableMinutes === null ? null : availableMinutes - projectedMinutes;
      const feasibilityState =
        availableMinutes === null
          ? accepted.feasibility.state
          : slackMinutes! < 0
            ? ('infeasible' as const)
            : slackMinutes! < Math.max(30, projectedMinutes * 0.1)
              ? ('at_risk' as const)
              : ('feasible' as const);
      const feasibility = {
        projectedMinutes,
        availableMinutes,
        slackMinutes,
        state: feasibilityState,
        assumptions: [
          ...accepted.feasibility.assumptions,
          `Recomputed for ${trigger.kind}: ${trigger.reason}`,
        ].slice(-50),
      };
      const diff = diffReplanItems(accepted, items, trigger.reason);
      if (
        trigger.kind === 'sustained_study_time_change' ||
        trigger.kind === 'persistent_pace_risk'
      ) {
        diff.push({
          kind: 'schedule_changed',
          planItemId: null,
          curriculumLearningUnitId: null,
          beforeIndex: null,
          afterIndex: null,
          beforeMinutes: accepted.feasibility.availableMinutes,
          afterMinutes: feasibility.availableMinutes,
          beforeDepth: null,
          afterDepth: null,
          reason: trigger.reason,
        });
      }
      if (trigger.kind === 'source_manifest_change') {
        diff.push({
          kind: 'source_rebound',
          planItemId: null,
          curriculumLearningUnitId: null,
          beforeIndex: null,
          afterIndex: null,
          beforeMinutes: null,
          afterMinutes: null,
          beforeDepth: null,
          afterDepth: null,
          reason: trigger.reason,
        });
      }
      if (diff.length === 0) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'The qualified trigger produced no meaningful executable route change.',
        );
      }
      const now = clock.now().toISOString();
      const latestVersion = latest.version + 1;
      const planId = newId('study_plan');
      const plan: StudyPlan = {
        ...accepted,
        id: planId,
        curriculumVersionId: curriculum.id,
        executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
        version: latestVersion,
        predecessorId: accepted.id,
        proposalTrigger: trigger.reason,
        status: 'proposed',
        rationale: `Deterministic successor proposal for ${trigger.kind}: ${trigger.reason}`,
        items,
        deferrals,
        feasibility,
        diff,
        paceBaseline: accepted.paceBaseline
          ? {
              ...accepted.paceBaseline,
              id: newId('pace'),
              studyPlanVersionId: planId,
              explicitSlackMinutes: Math.max(0, feasibility.slackMinutes ?? 0),
              expectedSessionCadencePerWeek:
                trigger.kind === 'sustained_study_time_change' &&
                trigger.facts.observedMinutesPerWeek !== null &&
                contract.studyBudget.preferredSessionMinutes
                  ? Math.max(
                      1,
                      trigger.facts.observedMinutesPerWeek /
                        contract.studyBudget.preferredSessionMinutes,
                    )
                  : accepted.paceBaseline.expectedSessionCadencePerWeek,
              estimateSource:
                trigger.kind === 'sustained_study_time_change'
                  ? ('learner' as const)
                  : accepted.paceBaseline.estimateSource,
            }
          : null,
        learnerAcceptedAt: null,
        createdAt: now,
      };
      const launches = items.map((item) => ({
        planItemId: item.id,
        launch: resolveLaunchForPlanItem(
          repos,
          clock,
          parsed.command.workspaceId,
          curriculum,
          item,
        ),
        sourceFingerprint: plan.executionSourceManifestFingerprint,
        validatedAt: now,
      }));
      if (launches.some((item) => item.launch.status !== 'launchable')) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Replan proposal contains an action that is no longer launchable.',
        );
      }
      const stored = commands.complete(claim, () => {
        const created = repos.studyPlans.createVersion(plan, launches, {
          id: newId('plan_evt'),
          eventType: 'replan_proposed',
          actor: parsed.command.actor,
          payload: { triggerId: trigger.id, predecessorId: accepted.id },
          createdAt: now,
        });
        const updatedTrigger = progression.updateReplanTrigger({
          ...trigger,
          status: 'proposal_created',
          proposedStudyPlanId: created.id,
          updatedAt: now,
        });
        return { trigger: updatedTrigger, studyPlan: created };
      });
      return stored;
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function recordGoalOutcome(input: unknown): GoalOutcome {
    const parsed = RecordGoalOutcomeRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'record_goal_outcome', {
      expectedCourseExecutionVersion: parsed.expectedCourseExecutionVersion,
      contractId: parsed.expectedContractVersionId,
      curriculumId: parsed.expectedCurriculumVersionId,
      planId: parsed.expectedStudyPlanVersionId,
      agendaId: parsed.expectedAgendaVersionId,
      status: parsed.status,
      unresolvedRiskIds: parsed.unresolvedRiskIds,
      reason: parsed.reason,
    });
    if (claim.replayPayload !== undefined) return GoalOutcomeSchema.parse(claim.replayPayload);
    try {
      const state = repos.courseExecution.get(parsed.command.workspaceId);
      if (
        state.version !== parsed.expectedCourseExecutionVersion ||
        state.activeContractId !== parsed.expectedContractVersionId ||
        state.activeCurriculumId !== parsed.expectedCurriculumVersionId ||
        state.acceptedPlanId !== parsed.expectedStudyPlanVersionId ||
        state.activeAgendaId !== parsed.expectedAgendaVersionId
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Course route is stale.');
      }
      const plan = repos.studyPlans.get(parsed.expectedStudyPlanVersionId);
      if (!plan || plan.status !== 'accepted')
        throw new AppError(ApiErrorCode.VersionConflict, 'Accepted StudyPlan is unavailable.');
      const contract = repos.learningContracts.get(parsed.expectedContractVersionId);
      if (!contract || contract.workspaceId !== parsed.command.workspaceId) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract is unavailable.');
      }
      const agenda = repos.sessionAgendas.get(parsed.expectedAgendaVersionId);
      if (
        !agenda ||
        agenda.contractVersionId !== contract.id ||
        agenda.curriculumVersionId !== parsed.expectedCurriculumVersionId ||
        agenda.studyPlanVersionId !== plan.id
      ) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Session Agenda is unavailable.');
      }
      const now = clock.now().toISOString();
      const progressByPlanItemId = new Map(
        repos.studyPlans.listProgress(plan.id).map((item) => [item.planItemId, item.state]),
      );
      const planItemsById = new Map(plan.items.map((item) => [item.id, item]));
      const unfinishedPlanItemIds = new Set(
        plan.items
          .filter((item) => {
            const progress = progressByPlanItemId.get(item.id);
            return progress !== 'completed' && progress !== 'obsolete';
          })
          .map((item) => item.id),
      );
      for (const item of agenda.items) {
        if (
          item.linkedPlanItemId &&
          planItemsById.has(item.linkedPlanItemId) &&
          ['queued', 'active', 'deferred', 'blocked'].includes(item.state)
        ) {
          unfinishedPlanItemIds.add(item.linkedPlanItemId);
        }
      }
      const incompleteUnitIds = new Set(
        plan.items
          .map((item) => item.curriculumLearningUnitId)
          .filter((unitId): unitId is string => unitId !== null)
          .filter(
            (unitId) =>
              progression.getUnitProgress(
                parsed.command.workspaceId,
                parsed.expectedCurriculumVersionId,
                unitId,
              ).state !== 'complete',
          ),
      );
      if (parsed.status === 'achieved') {
        if (
          incompleteUnitIds.size > 0 ||
          unfinishedPlanItemIds.size > 0 ||
          plan.deferrals.length > 0
        )
          throw new AppError(
            ApiErrorCode.ValidationError,
            'Goal cannot be marked achieved while required work remains incomplete or deferred.',
          );
      }
      if (parsed.status === 'expired_unfinished') {
        if (!contract.deadline || now < contract.deadline.at) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'An expired_unfinished outcome requires a configured deadline that has elapsed.',
          );
        }
      }
      const selectedRiskIds = new Set(parsed.unresolvedRiskIds);
      if (selectedRiskIds.size !== parsed.unresolvedRiskIds.length) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          'Goal outcome risk identities must be unique.',
        );
      }
      const selectedRisks: CoverageRiskEntry[] = [];
      for (const riskId of selectedRiskIds) {
        const risk = repos.coverageRisks.get(riskId);
        if (
          !risk ||
          risk.workspaceId !== parsed.command.workspaceId ||
          risk.contractVersionId !== parsed.expectedContractVersionId ||
          ['resolved', 'rejected', 'stale'].includes(risk.status)
        ) {
          throw notFound(`Current unresolved Coverage risk ${riskId} not found.`);
        }
        selectedRisks.push(risk);
      }
      if (parsed.status === 'finished_with_gaps') {
        const severityRank = ['low', 'medium', 'high', 'critical'] as const;
        const maximumSeverity = contract.riskTolerance?.maximumUnresolvedPriority ?? null;
        if (
          maximumSeverity &&
          selectedRisks.some(
            (risk) => severityRank.indexOf(risk.severity) > severityRank.indexOf(maximumSeverity),
          )
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'A selected unresolved risk exceeds the accepted Contract risk tolerance.',
          );
        }
        const hasDeferredWork =
          plan.deferrals.length > 0 ||
          [...unfinishedPlanItemIds].some(
            (itemId) => progressByPlanItemId.get(itemId) === 'deferred',
          );
        if (hasDeferredWork && !contract.riskTolerance?.allowExplicitDeferral) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'The accepted Contract does not allow closing with deferred work.',
          );
        }

        const riskCoversPlanItem = (risk: CoverageRiskEntry, planItemId: string): boolean => {
          const item = planItemsById.get(planItemId);
          if (!item) return false;
          const scopedToItem =
            (item.curriculumLearningUnitId !== null &&
              (risk.topicId === item.curriculumLearningUnitId ||
                risk.referencedCurriculumNodeIds.includes(item.curriculumLearningUnitId))) ||
            (risk.objectiveId !== null && item.objectiveIds.includes(risk.objectiveId));
          if (!scopedToItem) return false;
          const state = progressByPlanItemId.get(planItemId);
          if (state === 'deferred') return risk.facets.includes('intentionally_deferred');
          if (state === 'repair_needed') {
            return (
              risk.facets.includes('formally_assessed') ||
              risk.facets.includes('prerequisite_risk') ||
              risk.facets.includes('transfer_integration_risk')
            );
          }
          return false;
        };
        const eligibleRiskIds = new Set(
          repos.coverageRisks
            .list(parsed.command.workspaceId, contract.id)
            .filter((risk) => !['resolved', 'rejected', 'stale'].includes(risk.status))
            .filter(
              (risk) =>
                [...unfinishedPlanItemIds].some((itemId) => riskCoversPlanItem(risk, itemId)) ||
                plan.deferrals.some((deferral) => deferral.riskIds.includes(risk.id)),
            )
            .map((risk) => risk.id),
        );
        const selectedExactlyMatchesCurrentGaps =
          eligibleRiskIds.size > 0 &&
          selectedRiskIds.size === eligibleRiskIds.size &&
          [...eligibleRiskIds].every((riskId) => selectedRiskIds.has(riskId));
        const everyUnfinishedItemIsNamed = [...unfinishedPlanItemIds].every((itemId) =>
          selectedRisks.some((risk) => riskCoversPlanItem(risk, itemId)),
        );
        const everyPlanDeferralIsNamed = plan.deferrals.every((deferral) =>
          deferral.riskIds.some((riskId) => selectedRiskIds.has(riskId)),
        );
        const everyIncompleteUnitIsNamed = [...incompleteUnitIds].every((unitId) =>
          selectedRisks.some(
            (risk) => risk.topicId === unitId || risk.referencedCurriculumNodeIds.includes(unitId),
          ),
        );
        if (
          !selectedExactlyMatchesCurrentGaps ||
          !everyUnfinishedItemIsNamed ||
          !everyPlanDeferralIsNamed ||
          !everyIncompleteUnitIsNamed
        ) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            'finished_with_gaps must name exactly the current unfinished accepted-route gaps.',
          );
        }
      }
      const outcome: GoalOutcome = {
        id: newId('goal_outcome'),
        workspaceId: parsed.command.workspaceId,
        contractVersionId: parsed.expectedContractVersionId,
        studyPlanVersionId: parsed.expectedStudyPlanVersionId,
        status: parsed.status,
        formalEvidenceIds: repos.formalProgression
          .listEvidenceForRoute(parsed.expectedContractVersionId, parsed.expectedStudyPlanVersionId)
          .map((item) => item.id),
        unresolvedRiskIds: parsed.unresolvedRiskIds,
        reason: parsed.reason,
        actor: parsed.command.actor,
        createdAt: now,
      };
      return commands.complete(claim, () => {
        const stored = progression.insertGoalOutcome(outcome);
        repos.courseExecution.terminateRoute({
          workspaceId: parsed.command.workspaceId,
          expectedStateVersion: parsed.expectedCourseExecutionVersion,
          expectedContractId: parsed.expectedContractVersionId,
          expectedCurriculumId: parsed.expectedCurriculumVersionId,
          expectedPlanId: parsed.expectedStudyPlanVersionId,
          expectedAgendaId: parsed.expectedAgendaVersionId,
          eventId: newId('course_evt'),
          actor: parsed.command.actor,
          outcomeId: stored.id,
          outcomeStatus: parsed.status,
          reason: stored.reason,
          terminatedAt: now,
        });
        return stored;
      });
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function overview(workspaceId: string) {
    return FormalProgressionOverviewSchema.parse({
      evidence: progression.listEvidenceForWorkspace(workspaceId),
      reconciliations: progression.listReconciliationsForWorkspace(workspaceId),
      decisions: progression.listDecisionsForWorkspace(workspaceId),
      replanTriggers: progression.listReplanTriggers(workspaceId),
      goalOutcomes: progression.listGoalOutcomes(workspaceId),
    });
  }

  return {
    stateCreditingQuestionIdsForQuiz,
    registerAssessmentContracts,
    reconcile,
    reconcileCommand,
    reconcileAfterGrading,
    retryContextForGrading,
    qualifyReplanTrigger,
    proposeQualifiedReplan,
    recordGoalOutcome,
    overview,
  };
}

export type FormalProgressionService = ReturnType<typeof createFormalProgressionService>;
