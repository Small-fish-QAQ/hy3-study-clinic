import {
  ApiErrorCode,
  ApiErrorCodeSchema,
  CoursePreparationResponseSchema,
  CoursePreparationMachineActionSchema,
  CoursePreparationSchema,
  RunCoursePreparationRequestSchema,
  fnv1a32,
  type CourseExecutionOverview,
  type CourseFormalReadiness,
  type CoursePreparation,
  type CoursePreparationMachineAction,
  type Curriculum,
  type LearningContract,
  type RunCoursePreparationRequest,
  type SessionAgenda,
  type StudyPlan,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import type { AnalysisService } from './analysis.js';
import type { ClaimedCourseCommand, CourseCommandService } from './courseCommands.js';
import { commandFingerprint } from './courseCommands.js';
import type { CourseOverviewService } from './courseOverview.js';
import {
  buildCurriculumExecutionContext,
  COURSE_PREPARATION_POLICY_ID,
  type CurriculumService,
} from './curriculum.js';
import { preflightStudyPlan, type StudyPlanAgentService } from './studyPlansAgent.js';
import { listAcceptedAdvisoryVisuals } from './advisoryVisuals.js';

interface CoursePreparationDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  overview: CourseOverviewService;
  analysis: AnalysisService;
  curriculum: CurriculumService;
  studyPlans: StudyPlanAgentService;
  sourceAuthority: {
    ensureVerbatimAssessmentAuthority: (
      workspaceId: string,
      materialId: string,
      materialRevisionId: string,
    ) => unknown;
  };
}

interface PreparationFacts {
  overview: CourseExecutionOverview;
  contract: LearningContract | null;
  missingConceptMaterialIds: string[];
  proposedCurriculum: Curriculum | null;
  planningCurriculum: Curriculum | null;
  formalReadiness?: CourseFormalReadiness;
  projection: Omit<CoursePreparation, 'operationKey' | 'canCancel' | 'failure'>;
}

const OPERATION_TYPE = 'course_preparation';
const OPERATION_LEASE_MS = 30 * 60 * 1000;
const MAX_MACHINE_TRANSITIONS = 200;

function preparationStateForAction(
  action: CoursePreparationMachineAction,
): CoursePreparation['state'] {
  switch (action) {
    case 'prepare_concepts':
      return 'preparing_concepts';
    case 'prepare_course_structure':
      return 'preparing_course_structure';
    case 'accept_prepared_course_structure':
    case 'prepare_course_plan':
      return 'validating_course_plan';
    case 'prepare_assessment_readiness':
      return 'preparing_assessment_readiness';
  }
}

function isPreparationCurriculum(repos: Repositories, curriculumId: string): boolean {
  const proposed = repos.curricula
    .listEvents(curriculumId)
    .find((event) => event.eventType === 'proposed');
  return (
    proposed?.actor === 'local' &&
    typeof proposed.payload === 'object' &&
    proposed.payload !== null &&
    'preparationPolicyId' in proposed.payload &&
    proposed.payload.preparationPolicyId === COURSE_PREPARATION_POLICY_ID
  );
}

function safeRevision(workspaceId: string, basis: unknown): string {
  return `${fnv1a32(workspaceId).toString(16)}-${commandFingerprint(basis)}`;
}

function operationKey(workspaceId: string, revision: string, attempt: number): string {
  return `course-preparation:${fnv1a32(workspaceId).toString(16)}:${revision}:${attempt}`;
}

function recoveryAuthorityIdentity(overview: CourseExecutionOverview) {
  const recovery = overview.curriculumRecovery;
  const preflight = overview.studyPlanPreflight;
  return {
    curriculumRecovery: recovery
      ? {
          state: recovery.state,
          nextAction: recovery.nextAction,
          remediationRequired: recovery.remediationRequired,
        }
      : null,
    studyPlanPreflight: preflight
      ? {
          curriculumVersionId: preflight.curriculumVersionId,
          promptStrategy: preflight.promptStrategy,
          canGenerate: preflight.canGenerate,
          blockers: preflight.blockers
            .slice(0, 10)
            .map((blocker) => ({
              code: blocker.code,
              affectedLearningUnitCount: blocker.affectedLearningUnitCount,
            }))
            .sort((left, right) => {
              if (left.code === right.code) {
                return left.affectedLearningUnitCount - right.affectedLearningUnitCount;
              }
              return left.code < right.code ? -1 : 1;
            }),
        }
      : null,
  };
}

function failurePayloadDetails(payload: unknown): { code: string | null; details: unknown } {
  if (typeof payload !== 'object' || payload === null) return { code: null, details: null };
  const code =
    'code' in payload && ApiErrorCodeSchema.safeParse(payload.code).success
      ? (payload.code as string)
      : null;
  return { code, details: 'details' in payload ? payload.details : null };
}

function isStructuralCurriculumFailure(
  action: CoursePreparationMachineAction,
  payload: unknown,
): boolean {
  if (action !== 'prepare_course_structure') return false;
  const { code, details } = failurePayloadDetails(payload);
  if (code !== ApiErrorCode.GroundingFailed && code !== ApiErrorCode.ValidationError) return false;
  if (typeof details !== 'object' || details === null || !('kind' in details)) return false;
  return details.kind === 'curriculum_candidate_validation';
}

function structuralCurriculumFailureMessage(payload: unknown): string {
  const details = failurePayloadDetails(payload).details;
  const errors =
    typeof details === 'object' &&
    details !== null &&
    'errors' in details &&
    Array.isArray(details.errors)
      ? details.errors.filter((error): error is string => typeof error === 'string')
      : [];
  const joined = errors.join(' ');
  if (/unresolved_meaningful_source_gap|unmapped source|coverage/iu.test(joined)) {
    return '部分学习内容还没有可靠纳入课程结构。';
  }
  if (
    /over_compressed|semantic_topic_scattering|numbering|prerequisite|objective_alignment|Pedagogical Curriculum quality/iu.test(
      joined,
    )
  ) {
    return '课程结构需要重新组织。';
  }
  return '课程结构没有通过完整性检查。';
}

function operationReachedPreparationAction(
  repos: Repositories,
  operationId: string,
  action: CoursePreparationMachineAction,
  revision: string,
): boolean {
  return repos.operations.listEvents(operationId).some((event) => {
    if (event.kind !== 'preparation_step_started') return false;
    if (typeof event.payload !== 'object' || event.payload === null) return false;
    const payload = event.payload as { action?: unknown; revision?: unknown };
    return payload.action === action && payload.revision === revision;
  });
}

function machineCommand(
  workspaceId: string,
  parentOperationKey: string,
  transition: number,
  action: CoursePreparationMachineAction,
  revision: string,
) {
  const identity = commandFingerprint({ parentOperationKey, transition, action, revision });
  const id = `course-preparation-step:${fnv1a32(workspaceId).toString(16)}:${identity}`;
  return { commandId: id, idempotencyKey: id, workspaceId, actor: 'local' as const };
}

function projectionForAction(
  workspaceId: string,
  revision: string,
  generatedAt: string,
  action: CoursePreparationMachineAction,
  checkpoints: CoursePreparation['checkpoints'],
  formalReadiness: CourseFormalReadiness = {
    status: 'pending',
    requiredObjectiveCount: 0,
    readyObjectiveCount: 0,
    unresolvedObjectiveIds: [],
    teachingOnlyObjectiveIds: [],
  },
): PreparationFacts['projection'] {
  return {
    workspaceId,
    revision,
    state: preparationStateForAction(action),
    machineAction: action,
    learnerAction: 'resume_preparation',
    learnerDecisionRequired: false,
    canResume: true,
    checkpoints,
    formalReadiness,
    blocker: null,
    generatedAt,
  };
}

/**
 * Formal readiness is deliberately narrower than teaching readiness. It only
 * accepts objectives whose exact current SourceBlock claims are independently
 * validated and still eligible for blocking use. Curriculum prose or Lesson
 * output never participates in this decision.
 */
function assessFormalReadiness(
  repos: Repositories,
  curriculum: Curriculum | null,
  route?: { studyPlan: StudyPlan | null; agenda: SessionAgenda | null },
): CourseFormalReadiness {
  if (!curriculum) {
    return {
      status: 'pending',
      requiredObjectiveCount: 0,
      readyObjectiveCount: 0,
      unresolvedObjectiveIds: [],
      teachingOnlyObjectiveIds: [],
    };
  }
  const objectives = curriculum.nodes.flatMap(
    (node) => node.learningUnit?.objectives.map((objective) => ({ node, objective })) ?? [],
  );
  const required = objectives.filter(({ objective }) => objective.priority !== 'optional');
  const unresolved = required.filter(({ node, objective }) => {
    if (objective.truthPremiseStatus !== 'independently_verified') return true;
    const sourceBlockIds = new Set(
      node.sourceReferences
        .map((reference) => reference.sourceBlockId)
        .filter((id): id is string => id !== null),
    );
    const authorityReady = objective.truthAuthorityRecordIds.some((authorityId) => {
      if (!repos.sourceAuthority.isBlockingEligible(authorityId)) return false;
      const bundle = repos.sourceAuthority.getBundle(authorityId);
      return Boolean(
        bundle?.claims.some(
          (claim) =>
            sourceBlockIds.has(claim.sourceBlockId) &&
            repos.materials.getBlock(claim.sourceBlockId)?.materialRevisionId ===
              bundle.record.materialRevisionId,
        ),
      );
    });
    if (!authorityReady) return true;

    // Once an accepted route exists, authority alone is insufficient: the
    // objective must have an accepted formal-checkpoint route item and that
    // item must remain launchable on the current Agenda. Question generation
    // itself remains launch-time work, but the path cannot be absent.
    if (!route?.studyPlan || !route.agenda) return false;
    const planItem = route.studyPlan.items.find(
      (item) => item.kind === 'formal_checkpoint' && item.objectiveIds.includes(objective.id),
    );
    if (!planItem) return true;
    const planLaunch = repos.studyPlans
      .listLaunchValidations(route.studyPlan.id)
      .find((entry) => entry.planItemId === planItem.id);
    if (
      !planLaunch ||
      planLaunch.launch.status !== 'launchable' ||
      planLaunch.launch.capability !== 'assessment'
    ) {
      return true;
    }
    const agendaItem = route.agenda.items.find(
      (item) => item.linkedPlanItemId === planItem.id && item.kind === 'formal_checkpoint',
    );
    return !agendaItem || agendaItem.launch.status !== 'launchable';
  });
  const unresolvedIds = unresolved.map(({ objective }) => objective.id).sort();
  return {
    status: unresolvedIds.length === 0 ? 'ready' : 'blocked',
    requiredObjectiveCount: required.length,
    readyObjectiveCount: required.length - unresolvedIds.length,
    unresolvedObjectiveIds: unresolvedIds,
    teachingOnlyObjectiveIds: unresolvedIds,
  };
}

export function createCoursePreparationService({
  repos,
  clock,
  commands,
  overview: courseOverview,
  analysis,
  curriculum,
  studyPlans,
  sourceAuthority,
}: CoursePreparationDeps) {
  function authorityFingerprint(facts: PreparationFacts): string {
    const includedMaterialIds =
      facts.contract?.courseScope.materials
        .filter((scope) => scope.disposition === 'included')
        .map((scope) => scope.materialId)
        .sort() ?? [];
    return commandFingerprint({
      contract: facts.contract
        ? {
            id: facts.contract.id,
            version: facts.contract.version,
            status: facts.contract.status,
          }
        : null,
      scope: facts.overview.contractScopeReadiness,
      materials: includedMaterialIds.map((materialId) => ({
        materialId,
        revisionId: repos.materialRevisions.getActive(materialId)?.id ?? null,
        visualDerivationIdentityFingerprints: (() => {
          const revision = repos.materialRevisions.getActive(materialId);
          return revision
            ? listAcceptedAdvisoryVisuals(repos, materialId, revision.id)
                .map(({ derivation }) => derivation.identityFingerprint)
                .sort()
            : [];
        })(),
      })),
    });
  }

  function assertAuthorityCurrent(
    workspaceId: string,
    expectedFingerprint: string,
  ): PreparationFacts {
    const facts = projectFacts(workspaceId);
    if (authorityFingerprint(facts) !== expectedFingerprint) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Course authority changed while preparation was running.',
      );
    }
    return facts;
  }

  function projectFacts(workspaceId: string): PreparationFacts {
    const workspace = repos.workspaces.get(workspaceId);
    if (!workspace) throw notFound('Course not found.');
    const overview = courseOverview.get(workspaceId);
    const contract = overview.pendingContract ?? overview.activeContract;
    const generatedAt = clock.now().toISOString();
    const includedMaterialIds =
      contract?.courseScope.materials
        .filter((scope) => scope.disposition === 'included')
        .map((scope) => scope.materialId) ?? [];
    const materialFacts = includedMaterialIds.map((materialId) => {
      const material = repos.materials.get(materialId);
      const revision = repos.materialRevisions.getActive(materialId);
      const blocks = repos.materials.getBlocks(materialId);
      const concepts = repos.materials.getConcepts(materialId);
      const acceptedVisuals = revision
        ? listAcceptedAdvisoryVisuals(repos, materialId, revision.id)
        : [];
      const authoritativeBlocksReady = Boolean(
        revision &&
        blocks.length > 0 &&
        blocks.every(
          (block) =>
            block.materialRevisionId === revision.id &&
            (block.contentOrigin === undefined ||
              block.contentOrigin === null ||
              block.contentOrigin === 'extracted_original'),
        ),
      );
      const visualOnlyReady = Boolean(
        material && blocks.length === 0 && acceptedVisuals.length > 0,
      );
      const validConceptIds = concepts
        .filter((concept) => verifyGrounding(blocks, concept.grounding).ok)
        .map((concept) => concept.id)
        .sort();
      return {
        materialId,
        materialCurrent: Boolean(
          material &&
          material.workspaceId === workspaceId &&
          revision &&
          (authoritativeBlocksReady || visualOnlyReady),
        ),
        revisionId: revision?.id ?? null,
        blockIds: blocks.map((block) => block.id),
        validConceptIds,
        visualOnlyReady,
        visualDerivationIdentityFingerprints: acceptedVisuals
          .map(({ derivation }) => derivation.identityFingerprint)
          .sort(),
      };
    });
    const materialsCurrent = materialFacts.every((material) => material.materialCurrent);
    const missingConceptMaterialIds = materialFacts
      .filter((material) => material.validConceptIds.length === 0 && !material.visualOnlyReady)
      .map((material) => material.materialId);
    const conceptsCurrent = materialsCurrent && missingConceptMaterialIds.length === 0;
    const latestCurriculumId = overview.curriculumHistory.at(-1)?.id ?? null;
    const proposedCurriculum =
      overview.proposedCurriculum?.id === latestCurriculumId &&
      overview.proposedCurriculum.contractVersionId === contract?.id
        ? overview.proposedCurriculum
        : null;
    const planningCurriculumCandidate =
      overview.planningCurriculum?.contractVersionId === contract?.id
        ? overview.planningCurriculum
        : null;
    const currentExecutionManifest =
      contract && materialsCurrent && overview.contractScopeReadiness?.state === 'current'
        ? buildCurriculumExecutionContext(repos, contract).manifest
        : null;
    const planningCurriculum =
      planningCurriculumCandidate &&
      currentExecutionManifest &&
      JSON.stringify(planningCurriculumCandidate.executionSourceManifest) ===
        JSON.stringify(currentExecutionManifest)
        ? planningCurriculumCandidate
        : null;
    const proposedCurriculumSourceCurrent = Boolean(
      proposedCurriculum &&
      currentExecutionManifest &&
      JSON.stringify(proposedCurriculum.executionSourceManifest) ===
        JSON.stringify(currentExecutionManifest),
    );
    const proposedPlan =
      overview.proposedStudyPlan &&
      overview.proposedStudyPlan.id === overview.studyPlanHistory.at(-1)?.id &&
      overview.proposedStudyPlan.contractVersionId === contract?.id &&
      overview.proposedStudyPlan.curriculumVersionId === planningCurriculum?.id &&
      overview.proposedStudyPlan.executionSourceManifestFingerprint ===
        planningCurriculum.executionSourceManifest.fingerprint
        ? overview.proposedStudyPlan
        : null;
    const activeRouteCurrent = Boolean(
      contract &&
      overview.activeContract?.id === contract.id &&
      overview.acceptedCurriculum &&
      planningCurriculum?.id === overview.acceptedCurriculum.id &&
      overview.acceptedStudyPlan &&
      overview.acceptedStudyPlan.curriculumVersionId === planningCurriculum.id &&
      overview.acceptedStudyPlan.executionSourceManifestFingerprint ===
        planningCurriculum.executionSourceManifest.fingerprint &&
      overview.activeAgenda,
    );
    const formalReadiness = assessFormalReadiness(repos, planningCurriculum, {
      studyPlan: overview.acceptedStudyPlan,
      agenda: overview.activeAgenda,
    });
    const revision = safeRevision(workspaceId, {
      contract: contract
        ? { id: contract.id, version: contract.version, status: contract.status }
        : null,
      scope: overview.contractScopeReadiness,
      materials: materialFacts,
      curricula: overview.curriculumHistory.map((item) => ({
        id: item.id,
        version: item.version,
        status: item.status,
        fingerprint: item.executionSourceManifestFingerprint,
      })),
      plans: overview.studyPlanHistory.map((item) => ({
        id: item.id,
        version: item.version,
        status: item.status,
        curriculumVersionId: item.curriculumVersionId,
        fingerprint: item.executionSourceManifestFingerprint,
      })),
      executionVersion: overview.courseExecutionVersion,
      formalReadiness,
      recoveryAuthority: recoveryAuthorityIdentity(overview),
    });
    const readinessAttempted = repos.operations
      .listForWorkspace(workspaceId, OPERATION_TYPE, 200)
      .some((operation) =>
        repos.operations.listEvents(operation.id).some((event) => {
          if (event.kind !== 'preparation_step_completed') return false;
          if (typeof event.payload !== 'object' || event.payload === null) return false;
          const payload = event.payload as { action?: unknown; revision?: unknown };
          return payload.action === 'prepare_assessment_readiness' && payload.revision === revision;
        }),
      );

    const checkpoints: CoursePreparation['checkpoints'] = {
      materials: materialsCurrent ? 'complete' : 'pending',
      concepts: conceptsCurrent ? 'complete' : materialsCurrent ? 'pending' : 'blocked',
      courseStructure: planningCurriculum ? 'complete' : 'pending',
      coursePlan: proposedPlan || activeRouteCurrent ? 'complete' : 'pending',
      assessmentReadiness:
        formalReadiness.status === 'ready'
          ? 'complete'
          : activeRouteCurrent && readinessAttempted
            ? 'blocked'
            : activeRouteCurrent
              ? 'pending'
              : 'in_progress',
    };
    const common = { workspaceId, revision, generatedAt, checkpoints, formalReadiness };

    if (!contract || contract.status === 'draft' || contract.status === 'proposed') {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'not_started',
          machineAction: null,
          learnerAction: 'confirm_learning_goal',
          learnerDecisionRequired: false,
          canResume: false,
          blocker: {
            code: 'learning_goal_required',
            message: '请先确认学习目标和课程资料范围。',
          },
        },
      };
    }

    if (overview.contractScopeReadiness?.state !== 'current') {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'awaiting_required_governance',
          machineAction: null,
          learnerAction: 'reconfirm_learning_goal',
          learnerDecisionRequired: true,
          canResume: false,
          blocker: {
            code: 'learning_scope_changed',
            message: '课程资料范围发生了实质变化，需要你重新确认。',
          },
        },
      };
    }

    if (!materialsCurrent) {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'blocked',
          machineAction: null,
          learnerAction: 'none',
          learnerDecisionRequired: false,
          canResume: false,
          checkpoints: { ...checkpoints, materials: 'blocked' },
          blocker: {
            code: 'material_not_ready',
            message: '至少一份课程资料还没有可用的当前内容，请先检查资料。',
          },
        },
      };
    }

    // A current route remains usable while its immutable successor is prepared,
    // but it must not hide a diagnosed Curriculum-recovery transition. In
    // particular, legacy accepted Curricula without the current semantic-support
    // contract need to reach the ordinary versioned successor path before
    // assessment-readiness work can resume.
    if (
      activeRouteCurrent &&
      !overview.pendingContract &&
      overview.curriculumRecovery?.remediationRequired !== true &&
      !proposedCurriculum
    ) {
      if (formalReadiness.status !== 'ready') {
        if (readinessAttempted) {
          return {
            overview,
            contract,
            missingConceptMaterialIds,
            proposedCurriculum,
            planningCurriculum,
            formalReadiness,
            projection: {
              ...common,
              state: 'blocked',
              machineAction: null,
              learnerAction: 'none',
              learnerDecisionRequired: false,
              canResume: false,
              checkpoints: { ...checkpoints, assessmentReadiness: 'blocked' },
              blocker: {
                code: 'formal_assessment_readiness_unavailable',
                message:
                  '部分必修目标目前没有可独立验证的正式评估依据；课程仍可教学，但不能宣称已具备完整掌握验证路径。',
              },
            },
          };
        }
        return {
          overview,
          contract,
          missingConceptMaterialIds,
          proposedCurriculum,
          planningCurriculum,
          formalReadiness,
          projection: projectionForAction(
            workspaceId,
            revision,
            generatedAt,
            'prepare_assessment_readiness',
            { ...checkpoints, assessmentReadiness: 'in_progress' },
            formalReadiness,
          ),
        };
      }
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'complete',
          machineAction: null,
          learnerAction: 'continue_study',
          learnerDecisionRequired: false,
          canResume: false,
          blocker: null,
        },
      };
    }

    if (missingConceptMaterialIds.length > 0) {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: projectionForAction(workspaceId, revision, generatedAt, 'prepare_concepts', {
          ...checkpoints,
          concepts: 'in_progress',
        }),
      };
    }

    if (proposedCurriculum) {
      if (!isPreparationCurriculum(repos, proposedCurriculum.id)) {
        return {
          overview,
          contract,
          missingConceptMaterialIds,
          proposedCurriculum,
          planningCurriculum,
          projection: {
            ...common,
            state: 'awaiting_required_governance',
            machineAction: null,
            learnerAction: 'review_course_structure',
            learnerDecisionRequired: true,
            canResume: false,
            checkpoints: { ...checkpoints, courseStructure: 'in_progress' },
            blocker: {
              code: 'course_structure_review_required',
              message: '已有一份需要你决定的课程结构，系统不会替你接受它。',
            },
          },
        };
      }
      if (!proposedCurriculumSourceCurrent) {
        return {
          overview,
          contract,
          missingConceptMaterialIds,
          proposedCurriculum,
          planningCurriculum,
          projection: projectionForAction(
            workspaceId,
            revision,
            generatedAt,
            'prepare_course_structure',
            { ...checkpoints, courseStructure: 'in_progress' },
          ),
        };
      }
      const preflight = preflightStudyPlan(
        repos,
        clock,
        contract,
        proposedCurriculum,
        workspace.name,
      );
      if (!preflight.canGenerate) {
        return {
          overview,
          contract,
          missingConceptMaterialIds,
          proposedCurriculum,
          planningCurriculum,
          projection: {
            ...common,
            state: 'blocked',
            machineAction: null,
            learnerAction: 'review_course_structure',
            learnerDecisionRequired: true,
            canResume: false,
            checkpoints: { ...checkpoints, courseStructure: 'blocked' },
            blocker: {
              code: 'course_structure_not_executable',
              message: '生成的课程结构还不能形成可执行课程方案，需要你检查后再继续。',
            },
          },
        };
      }
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: projectionForAction(
          workspaceId,
          revision,
          generatedAt,
          'accept_prepared_course_structure',
          { ...checkpoints, courseStructure: 'in_progress', coursePlan: 'in_progress' },
        ),
      };
    }

    if (proposedPlan) {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'course_plan_ready',
          machineAction: null,
          learnerAction: 'review_course_plan',
          learnerDecisionRequired: true,
          canResume: false,
          checkpoints: { ...checkpoints, coursePlan: 'complete' },
          blocker: null,
        },
      };
    }

    if (!planningCurriculum) {
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: projectionForAction(
          workspaceId,
          revision,
          generatedAt,
          'prepare_course_structure',
          { ...checkpoints, courseStructure: 'in_progress' },
        ),
      };
    }

    const preflight = preflightStudyPlan(
      repos,
      clock,
      contract,
      planningCurriculum,
      workspace.name,
    );
    if (!preflight.canGenerate) {
      if (overview.curriculumRecovery?.nextAction === 'propose_curriculum_successor') {
        return {
          overview,
          contract,
          missingConceptMaterialIds,
          proposedCurriculum,
          planningCurriculum,
          projection: projectionForAction(
            workspaceId,
            revision,
            generatedAt,
            'prepare_course_structure',
            { ...checkpoints, courseStructure: 'in_progress' },
          ),
        };
      }
      return {
        overview,
        contract,
        missingConceptMaterialIds,
        proposedCurriculum,
        planningCurriculum,
        projection: {
          ...common,
          state: 'blocked',
          machineAction: null,
          learnerAction: 'review_course_structure',
          learnerDecisionRequired: true,
          canResume: false,
          checkpoints: { ...checkpoints, courseStructure: 'blocked' },
          blocker: {
            code: 'course_structure_not_executable',
            message: '当前课程结构无法形成可执行课程方案，需要你检查后再继续。',
          },
        },
      };
    }

    return {
      overview,
      contract,
      missingConceptMaterialIds,
      proposedCurriculum,
      planningCurriculum,
      projection: projectionForAction(workspaceId, revision, generatedAt, 'prepare_course_plan', {
        ...checkpoints,
        coursePlan: 'in_progress',
      }),
    };
  }

  function get(workspaceId: string): CoursePreparation {
    const facts = projectFacts(workspaceId);
    const base = facts.projection;
    if (!base.machineAction) {
      return CoursePreparationSchema.parse({
        ...base,
        operationKey: null,
        canCancel: false,
        failure:
          base.state === 'blocked'
            ? {
                code: null,
                action: 'prepare_course_plan',
                occurredAt: base.generatedAt,
                retryable: false,
              }
            : null,
      });
    }

    const expectedFingerprint = commandFingerprint({
      revision: base.revision,
      machineAction: base.machineAction,
    });
    const operations = repos.operations.listForWorkspace(workspaceId, OPERATION_TYPE, 200);
    const active = operations.find(
      (operation) => operation.status === 'running' || operation.status === 'queued',
    );
    const activeExpired = Boolean(
      active?.status === 'running' &&
      active.leaseExpiresAt !== null &&
      active.leaseExpiresAt <= base.generatedAt,
    );
    if (active && !activeExpired) {
      return CoursePreparationSchema.parse({
        ...base,
        operationKey: active.idempotencyKey,
        state: preparationStateForAction(base.machineAction),
        canCancel: active.status === 'running',
        failure: null,
      });
    }
    const matching = operations.filter(
      (operation) =>
        operation.expectedFingerprint === expectedFingerprint ||
        operationReachedPreparationAction(repos, operation.id, base.machineAction!, base.revision),
    );
    const latest = matching[0];
    const nextOperationKey = operationKey(workspaceId, base.revision, matching.length + 1);

    if (activeExpired && active) {
      return CoursePreparationSchema.parse({
        ...base,
        operationKey: nextOperationKey,
        state: 'failed_recoverable',
        learnerAction: 'resume_preparation',
        canCancel: false,
        blocker: {
          code: 'preparation_interrupted',
          message: '课程准备被中断，已完成的有效内容仍然保留，可以安全继续。',
        },
        failure: {
          code: null,
          action: base.machineAction,
          occurredAt: active.leaseExpiresAt ?? active.updatedAt,
          retryable: true,
        },
      });
    }

    if (latest?.status === 'failed' || latest?.status === 'interrupted') {
      const result = repos.operations.getResult(latest.id);
      const payload =
        typeof result?.payload === 'object' && result.payload !== null ? result.payload : null;
      const code = payload && 'code' in payload ? ApiErrorCodeSchema.safeParse(payload.code) : null;
      const interrupted = latest.status === 'interrupted';
      const structuralFailure =
        !interrupted && isStructuralCurriculumFailure(base.machineAction, payload);
      if (structuralFailure) {
        return CoursePreparationSchema.parse({
          ...base,
          state: 'blocked',
          machineAction: null,
          learnerAction: 'none',
          learnerDecisionRequired: false,
          canResume: false,
          operationKey: null,
          canCancel: false,
          blocker: {
            code: 'course_structure_generation_failed',
            message: `课程结构准备未完成。${structuralCurriculumFailureMessage(payload)} 当前有效课程结构没有改变。`,
          },
          failure: {
            code: code?.success ? code.data : null,
            action: base.machineAction,
            occurredAt: latest.updatedAt,
            retryable: false,
          },
        });
      }
      return CoursePreparationSchema.parse({
        ...base,
        operationKey: nextOperationKey,
        state: 'failed_recoverable',
        learnerAction: 'resume_preparation',
        canCancel: false,
        blocker: {
          code: interrupted ? 'preparation_interrupted' : 'preparation_failed',
          message: interrupted
            ? '课程准备被中断，已完成的有效内容仍然保留，可以安全继续。'
            : '课程准备暂未完成，已有有效内容没有被覆盖，可以稍后重试。',
        },
        failure: {
          code: code?.success ? code.data : null,
          action: base.machineAction,
          occurredAt: latest.updatedAt,
          retryable: true,
        },
      });
    }

    return CoursePreparationSchema.parse({
      ...base,
      operationKey: nextOperationKey,
      canCancel: false,
      failure: null,
    });
  }

  async function executeAction(
    facts: PreparationFacts,
    action: CoursePreparationMachineAction,
    parentOperationKey: string,
    transition: number,
    claim: ClaimedCourseCommand,
    expectedAuthorityFingerprint: string,
    opts?: ProviderCallOptions,
  ): Promise<void> {
    const contract = facts.contract;
    if (!contract) throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract changed.');
    const command = machineCommand(
      contract.workspaceId,
      parentOperationKey,
      transition,
      action,
      facts.projection.revision,
    );
    switch (action) {
      case 'prepare_concepts': {
        const materialId = facts.missingConceptMaterialIds[0];
        if (!materialId) throw new Error('Course Preparation has no missing Material to analyze.');
        await analysis.analyze(materialId, opts, {
          beforePersist: () => commands.renew(claim, OPERATION_LEASE_MS),
        });
        return;
      }
      case 'prepare_course_structure': {
        await curriculum.propose(
          {
            command,
            contractId: contract.id,
            expectedContractVersion: contract.version,
            predecessorCurriculumId: facts.overview.curriculumHistory.at(-1)?.id ?? null,
            expectedActiveCurriculumId: facts.overview.acceptedCurriculum?.id ?? null,
          },
          { ...opts, preparationPolicyId: COURSE_PREPARATION_POLICY_ID },
        );
        return;
      }
      case 'accept_prepared_course_structure': {
        const candidate = facts.proposedCurriculum;
        if (!candidate || !isPreparationCurriculum(repos, candidate.id)) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Prepared Curriculum candidate changed.',
          );
        }
        curriculum.accept({
          command,
          curriculumId: candidate.id,
          expectedVersion: candidate.version,
          expectedContractId: contract.id,
          expectedExecutionSourceManifestFingerprint: candidate.executionSourceManifest.fingerprint,
          acceptanceBasis: 'explicit_local_policy',
        });
        return;
      }
      case 'prepare_course_plan': {
        const accepted = facts.planningCurriculum;
        if (!accepted) throw new AppError(ApiErrorCode.VersionConflict, 'Curriculum changed.');
        await studyPlans.propose(
          {
            command,
            contractId: contract.id,
            expectedContractVersion: contract.version,
            curriculumId: accepted.id,
            expectedCurriculumVersion: accepted.version,
            expectedExecutionSourceManifestFingerprint:
              accepted.executionSourceManifest.fingerprint,
            predecessorStudyPlanId: facts.overview.studyPlanHistory.at(-1)?.id ?? null,
            expectedAcceptedStudyPlanId: facts.overview.acceptedStudyPlan?.id ?? null,
            proposalTrigger: 'Course Preparation after learner-confirmed scope.',
          },
          opts,
          {
            beforePersist: () => {
              if (opts?.signal?.aborted) throw ProviderError.cancelled();
              commands.renew(claim, OPERATION_LEASE_MS);
              const currentFacts = assertAuthorityCurrent(
                contract.workspaceId,
                expectedAuthorityFingerprint,
              );
              if (
                currentFacts.planningCurriculum?.id !== accepted.id ||
                currentFacts.proposedCurriculum
              ) {
                throw new AppError(
                  ApiErrorCode.VersionConflict,
                  'Curriculum authority changed while the course plan was being prepared.',
                );
              }
            },
          },
        );
        return;
      }
      case 'prepare_assessment_readiness': {
        for (const scope of contract.courseScope.materials) {
          if (scope.disposition !== 'included') continue;
          const revision = repos.materialRevisions.getActive(scope.materialId);
          if (revision) {
            sourceAuthority.ensureVerbatimAssessmentAuthority(
              contract.workspaceId,
              scope.materialId,
              revision.id,
            );
          }
        }
        return;
      }
    }
  }

  async function run(
    input: RunCoursePreparationRequest,
    opts?: ProviderCallOptions,
  ): Promise<CoursePreparation> {
    const parsed = RunCoursePreparationRequestSchema.parse(input);
    repos.operations.recoverExpiredForWorkspace(
      parsed.command.workspaceId,
      OPERATION_TYPE,
      clock.now().toISOString(),
    );
    const existing = repos.operations.getByIdempotencyKey(
      parsed.command.workspaceId,
      parsed.command.idempotencyKey,
    );
    const firstStep = existing
      ? repos.operations
          .listEvents(existing.id)
          .find((event) => event.kind === 'preparation_step_started')
      : null;
    const firstStepPayload =
      typeof firstStep?.payload === 'object' && firstStep.payload !== null
        ? firstStep.payload
        : null;
    const firstAction =
      firstStepPayload && 'action' in firstStepPayload
        ? CoursePreparationMachineActionSchema.safeParse(firstStepPayload.action)
        : null;
    const exactFingerprint = firstAction?.success
      ? commandFingerprint({
          revision: parsed.expectedRevision,
          machineAction: firstAction.data,
        })
      : null;
    const exactExisting =
      existing?.operationType === OPERATION_TYPE &&
      existing.commandId === parsed.command.commandId &&
      exactFingerprint === existing.expectedFingerprint
        ? existing
        : null;
    if (exactExisting?.status === 'running' || exactExisting?.status === 'queued') {
      return get(parsed.command.workspaceId);
    }
    if (exactExisting?.status === 'completed') {
      const result = repos.operations.getResult(exactExisting.id);
      if (result?.status === 'completed') return CoursePreparationSchema.parse(result.payload);
    }
    const initial = get(parsed.command.workspaceId);
    if (initial.revision !== parsed.expectedRevision) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Course Preparation state is stale.');
    }
    if (!initial.canResume || !initial.machineAction || !initial.operationKey) return initial;
    if (
      parsed.command.commandId !== initial.operationKey ||
      parsed.command.idempotencyKey !== initial.operationKey
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Course Preparation operation identity is stale.',
      );
    }

    const claim = commands.begin(
      parsed.command,
      OPERATION_TYPE,
      { revision: initial.revision, machineAction: initial.machineAction },
      { leaseMs: OPERATION_LEASE_MS },
    );
    if (claim.replayPayload !== undefined) return get(parsed.command.workspaceId);

    try {
      const expectedAuthorityFingerprint = authorityFingerprint(
        projectFacts(parsed.command.workspaceId),
      );
      let previousRevision = initial.revision;
      for (let transition = 0; transition < MAX_MACHINE_TRANSITIONS; transition += 1) {
        if (opts?.signal?.aborted) throw ProviderError.cancelled();
        const facts = projectFacts(parsed.command.workspaceId);
        assertAuthorityCurrent(parsed.command.workspaceId, expectedAuthorityFingerprint);
        const action = facts.projection.machineAction;
        if (!action) {
          return commands.complete(claim, () => get(parsed.command.workspaceId));
        }
        commands.renew(claim, OPERATION_LEASE_MS);
        commands.appendEvent(claim, 'preparation_step_started', {
          action,
          revision: facts.projection.revision,
          transition,
        });
        await executeAction(
          facts,
          action,
          parsed.command.idempotencyKey,
          transition,
          claim,
          expectedAuthorityFingerprint,
          opts,
        );
        if (opts?.signal?.aborted) throw ProviderError.cancelled();
        commands.renew(claim, OPERATION_LEASE_MS);
        const after = projectFacts(parsed.command.workspaceId);
        assertAuthorityCurrent(parsed.command.workspaceId, expectedAuthorityFingerprint);
        if (
          after.projection.revision === previousRevision &&
          action !== 'prepare_assessment_readiness'
        ) {
          throw new AppError(
            ApiErrorCode.Internal,
            'Course Preparation made no durable progress and stopped safely.',
          );
        }
        commands.appendEvent(claim, 'preparation_step_completed', {
          action,
          revision: after.projection.revision,
          transition,
        });
        previousRevision = after.projection.revision;
        if (!after.projection.machineAction) {
          return commands.complete(claim, () => get(parsed.command.workspaceId));
        }
      }
      throw new AppError(
        ApiErrorCode.Internal,
        'Course Preparation reached its transition limit and stopped safely.',
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return {
    get,
    run: async (input: RunCoursePreparationRequest, opts?: ProviderCallOptions) =>
      CoursePreparationResponseSchema.parse({ preparation: await run(input, opts) }),
  };
}

export type CoursePreparationService = ReturnType<typeof createCoursePreparationService>;
