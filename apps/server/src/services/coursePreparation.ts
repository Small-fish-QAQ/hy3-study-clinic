import {
  ApiErrorCode,
  ApiErrorCodeSchema,
  COURSE_PREPARATION_PLAN_TRIGGER,
  CoursePreparationResponseSchema,
  CoursePreparationMachineActionSchema,
  CoursePreparationSchema,
  CoursePreparationActivitySchema,
  RunCoursePreparationRequestSchema,
  fnv1a32,
  isPlannedFormalAgendaItemKind,
  type CourseExecutionOverview,
  type CourseFormalReadiness,
  type CoursePreparation,
  type CoursePreparationMachineAction,
  type CoursePreparationProgressUpdate,
  type Curriculum,
  type LearningContract,
  type RunCoursePreparationRequest,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { computeSections } from '../ingestion/sections.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import type { AnalysisService } from './analysis.js';
import type { ClaimedCourseCommand, CourseCommandService } from './courseCommands.js';
import { commandFingerprint } from './courseCommands.js';
import type { CourseOverviewService } from './courseOverview.js';
import type { CourseExecutionService } from './courseExecution.js';
import {
  buildCurriculumExecutionContext,
  COURSE_PREPARATION_POLICY_ID,
  type CurriculumService,
} from './curriculum.js';
import { preflightStudyPlan, type StudyPlanAgentService } from './studyPlansAgent.js';
import { listAcceptedAdvisoryVisuals } from './advisoryVisuals.js';
import { assessCourseFormalReadiness } from './formalReadiness.js';
import { isSelectedStudyItemExecutable } from './studyContinuation.js';

interface CoursePreparationDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
  overview: CourseOverviewService;
  analysis: AnalysisService;
  curriculum: CurriculumService;
  studyPlans: StudyPlanAgentService;
  courseExecution: CourseExecutionService;
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
    case 'activate_prepared_course_plan':
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

function isPreparationStudyPlan(repos: Repositories, studyPlanId: string): boolean {
  const proposed = repos.studyPlans
    .listEvents(studyPlanId)
    .find((event) => event.eventType === 'proposed');
  return (
    proposed?.actor === 'local' &&
    typeof proposed.payload === 'object' &&
    proposed.payload !== null &&
    'proposalTrigger' in proposed.payload &&
    proposed.payload.proposalTrigger === COURSE_PREPARATION_PLAN_TRIGGER
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

export function createCoursePreparationService({
  repos,
  clock,
  commands,
  overview: courseOverview,
  analysis,
  curriculum,
  studyPlans,
  courseExecution,
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
      materials: includedMaterialIds.map((materialId) => {
        const revision = repos.materialRevisions.getActive(materialId);
        return {
          materialId,
          revisionId: revision?.id ?? null,
          visualDerivationIdentityFingerprints: revision
            ? listAcceptedAdvisoryVisuals(repos, materialId, revision.id)
                .map(({ derivation }) => derivation.identityFingerprint)
                .sort()
            : [],
        };
      }),
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
      const material = repos.materials.getRouteIdentity(materialId);
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
    const formalReadiness = assessCourseFormalReadiness(repos, planningCurriculum, {
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
    const checkpoints: CoursePreparation['checkpoints'] = {
      materials: materialsCurrent ? 'complete' : 'pending',
      concepts: conceptsCurrent ? 'complete' : materialsCurrent ? 'pending' : 'blocked',
      courseStructure: planningCurriculum ? 'complete' : 'pending',
      coursePlan: proposedPlan || activeRouteCurrent ? 'complete' : 'pending',
      assessmentReadiness:
        formalReadiness.status === 'ready'
          ? 'complete'
          : activeRouteCurrent && formalReadiness.status === 'blocked'
            ? 'blocked'
            : 'pending',
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

    // Formal readiness is projected independently from Course teachability.
    // Missing or evaluated-unavailable semantic authority never turns an
    // otherwise current teaching route into a whole-Course failure.
    if (
      activeRouteCurrent &&
      !overview.pendingContract &&
      overview.curriculumRecovery?.remediationRequired !== true &&
      !proposedCurriculum
    ) {
      const selectedItem = overview.activeAgenda?.items.find(
        (item) => item.id === overview.activeAgenda?.currentItemId,
      );
      const selectedItemExecutable = Boolean(
        selectedItem &&
        overview.acceptedStudyPlan &&
        isSelectedStudyItemExecutable(
          selectedItem,
          overview.acceptedStudyPlan,
          repos.studyPlans.listProgress(overview.acceptedStudyPlan.id),
          formalReadiness,
        ),
      );
      if (!selectedItemExecutable) {
        const waitingForFormal = Boolean(
          selectedItem &&
          selectedItem.state === 'queued' &&
          isPlannedFormalAgendaItemKind(selectedItem.kind) &&
          formalReadiness.status !== 'ready',
        );
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
            blocker: waitingForFormal
              ? {
                  code: 'formal_assessment_readiness_unavailable',
                  message:
                    '当前安排是正式检验，但正式评估依据尚未就绪；系统不会把它当作可执行讲解。',
                }
              : {
                  code: 'preparation_failed',
                  message: '当前课程安排没有可执行的学习活动。',
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
      const simplifiedCourseDesign = Object.prototype.hasOwnProperty.call(contract, 'focusRequest');
      if (simplifiedCourseDesign && proposedCurriculumSourceCurrent) {
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
              message: '课程结构已生成，请审阅并接受；系统不会替你接受。',
            },
          },
        };
      }
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
      if (
        Object.prototype.hasOwnProperty.call(contract, 'focusRequest') &&
        isPreparationStudyPlan(repos, proposedPlan.id)
      ) {
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
            'activate_prepared_course_plan',
            { ...checkpoints, coursePlan: 'in_progress' },
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

  function getSnapshot(workspaceId: string): CoursePreparation {
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
      const repairableConceptGap =
        isStructuralCurriculumFailure(base.machineAction, payload) &&
        JSON.stringify(failurePayloadDetails(payload).details).includes(
          'unlaunchable_unit_deferral_forbidden',
        ) &&
        facts.contract?.courseScope.materials.some((scope) => {
          if (scope.disposition !== 'included') return false;
          const blocks = repos.materials.getBlocks(scope.materialId);
          const concepts = repos.materials.getConcepts(scope.materialId);
          return computeSections(blocks).some(
            (section) =>
              !concepts.some((concept) => verifyGrounding(section.blocks, concept.grounding).ok),
          );
        });
      const structuralFailure =
        !interrupted &&
        isStructuralCurriculumFailure(base.machineAction, payload) &&
        !repairableConceptGap;
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
            : repairableConceptGap
              ? '部分学习单元的原文关联需要重新校验。重试后会从已保存的课程结构继续准备。'
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

  function get(workspaceId: string): CoursePreparation {
    const snapshot = getSnapshot(workspaceId);
    const operation = repos.operations.listForWorkspace(workspaceId, OPERATION_TYPE, 1)[0];
    const event = operation
      ? repos.operations
          .listEvents(operation.id)
          .filter((item) => item.kind === 'preparation_progress')
          .at(-1)
      : undefined;
    const activity = event
      ? CoursePreparationActivitySchema.safeParse({
          ...(event.payload as object),
          updatedAt: event.createdAt,
        })
      : null;
    const overview = courseOverview.get(workspaceId);
    const contract = overview.pendingContract ?? overview.activeContract;
    const preparedConceptCount = (contract?.courseScope.materials ?? [])
      .filter((scope) => scope.disposition === 'included')
      .reduce((count, scope) => {
        const blocks = repos.materials.getBlocks(scope.materialId);
        return (
          count +
          repos.materials
            .getConcepts(scope.materialId)
            .filter((concept) => verifyGrounding(blocks, concept.grounding).ok).length
        );
      }, 0);
    const observed =
      activity?.success && operation && (!contract || operation.createdAt >= contract.createdAt)
        ? activity.data
        : null;
    if (
      snapshot.canCancel &&
      observed &&
      ['concepts', 'concept_recovery'].includes(observed.phase)
    ) {
      snapshot.state = 'preparing_concepts';
      snapshot.checkpoints = {
        ...snapshot.checkpoints,
        concepts: 'in_progress',
        courseStructure: 'pending',
      };
    }
    return CoursePreparationSchema.parse({
      ...snapshot,
      activity: observed,
      operationStartedAt: observed ? (operation?.createdAt ?? null) : null,
      preparedConceptCount,
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
    let recordedRevision = facts.projection.revision;
    const recordPreparationRevision = () => {
      const current = assertAuthorityCurrent(contract.workspaceId, expectedAuthorityFingerprint);
      if (current.projection.revision !== recordedRevision && current.projection.machineAction) {
        // Extraction persists each section. Associate the new revision even
        // when cancellation happens before the next section or generation stage.
        commands.appendEvent(claim, 'preparation_step_started', {
          action: current.projection.machineAction,
          revision: current.projection.revision,
          transition,
        });
        recordedRevision = current.projection.revision;
      }
    };
    const reportProgress = (progress: CoursePreparationProgressUpdate) => {
      if (progress.phase === 'concepts' || progress.phase === 'concept_recovery') {
        recordPreparationRevision();
      }
      if (opts?.signal?.aborted) throw ProviderError.cancelled();
      commands.renew(claim, OPERATION_LEASE_MS);
      commands.appendEvent(claim, 'preparation_progress', progress);
    };
    switch (action) {
      case 'prepare_concepts': {
        const materialId = facts.missingConceptMaterialIds[0];
        if (!materialId) throw new Error('Course Preparation has no missing Material to analyze.');
        await analysis.analyze(materialId, opts, {
          beforePersist: () => commands.renew(claim, OPERATION_LEASE_MS),
          onSectionProgress: ({ title, completed, total }) =>
            reportProgress({ phase: 'concepts', label: title.slice(0, 500), completed, total }),
        });
        return;
      }
      case 'prepare_course_structure': {
        // Sparse Concept extraction is legal: unit teaching also consumes exact
        // current Curriculum source blocks. Do not re-extract every empty section
        // before reusing an otherwise valid Map/Detail dependency.
        // Legacy Concept-lesson routes still need the additive recovery pass.
        if (!Object.hasOwn(contract, 'focusRequest')) {
          for (const scope of contract.courseScope.materials) {
            if (
              scope.disposition !== 'included' ||
              repos.materials.getBlocks(scope.materialId).length === 0
            )
              continue;
            await analysis.analyze(scope.materialId, opts, {
              recoverUncoveredSections: true,
              beforePersist: () => {
                assertAuthorityCurrent(contract.workspaceId, expectedAuthorityFingerprint);
                commands.renew(claim, OPERATION_LEASE_MS);
              },
              onSectionProgress: ({ title, completed, total }) =>
                reportProgress({
                  phase: 'concept_recovery',
                  label: title.slice(0, 500),
                  completed,
                  total,
                }),
            });
          }
        }
        recordPreparationRevision();
        await curriculum.propose(
          {
            command,
            contractId: contract.id,
            expectedContractVersion: contract.version,
            predecessorCurriculumId: facts.overview.curriculumHistory.at(-1)?.id ?? null,
            expectedActiveCurriculumId: facts.overview.acceptedCurriculum?.id ?? null,
          },
          {
            ...opts,
            preparationPolicyId: COURSE_PREPARATION_POLICY_ID,
            onPreparationProgress: reportProgress,
          },
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
            proposalTrigger: COURSE_PREPARATION_PLAN_TRIGGER,
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
      case 'activate_prepared_course_plan': {
        const candidate = facts.overview.proposedStudyPlan;
        const accepted = facts.planningCurriculum;
        if (
          !candidate ||
          !accepted ||
          candidate.curriculumVersionId !== accepted.id ||
          !isPreparationStudyPlan(repos, candidate.id)
        ) {
          throw new AppError(ApiErrorCode.VersionConflict, 'Prepared StudyPlan changed.');
        }
        courseExecution.acceptDerivedStudyPlan({
          command,
          studyPlanId: candidate.id,
          expectedVersion: candidate.version,
          expectedContractId: contract.id,
          expectedCurriculumId: accepted.id,
          expectedExecutionSourceManifestFingerprint: accepted.executionSourceManifest.fingerprint,
        });
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
        if (action !== 'activate_prepared_course_plan') {
          assertAuthorityCurrent(parsed.command.workspaceId, expectedAuthorityFingerprint);
        }
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
