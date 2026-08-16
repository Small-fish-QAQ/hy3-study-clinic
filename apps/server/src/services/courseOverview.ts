import {
  CourseExecutionOverviewSchema,
  CoverageRiskSummarySchema,
  type CourseExecutionOverview,
  type CoverageRiskEntry,
  type CoverageRiskSummary,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { curriculumHierarchy, requiresStudyPlanExecutionRepair } from './curriculum.js';
import { preflightStudyPlan } from './studyPlansAgent.js';

interface CourseOverviewDeps {
  repos: Repositories;
  clock: Clock;
}

const SEVERITY = ['low', 'medium', 'high', 'critical'] as const;

function summarizeRisks(risks: CoverageRiskEntry[], computedAt: string): CoverageRiskSummary {
  const open = risks.filter((risk) =>
    ['open', 'acknowledged', 'planned', 'checking'].includes(risk.status),
  );
  const highestOpenSeverity = open.reduce<CoverageRiskSummary['highestOpenSeverity']>(
    (highest, risk) =>
      highest === null || SEVERITY.indexOf(risk.severity) > SEVERITY.indexOf(highest)
        ? risk.severity
        : highest,
    null,
  );
  return CoverageRiskSummarySchema.parse({
    openCount: open.length,
    deferredCount: risks.filter((risk) => risk.status === 'deferred').length,
    staleCount: risks.filter((risk) => risk.status === 'stale').length,
    highestOpenSeverity,
    deterministicMappingGapCount: risks.filter(
      (risk) => risk.origin === 'deterministic' && risk.facets.includes('structurally_mapped'),
    ).length,
    explicitDeferralCount: risks.filter((risk) => risk.facets.includes('intentionally_deferred'))
      .length,
    highlights: risks.slice(0, 20).map((risk) => ({
      id: risk.id,
      claim: risk.claim,
      uncertainty: risk.uncertainty,
      severity: risk.severity,
      status: risk.status,
      facets: risk.facets,
      scopeAuthorityStatus: risk.scopeAuthorityStatus,
      truthPremiseStatus: risk.truthPremiseStatus,
      materialId: risk.materialId,
      curriculumNodeId: risk.referencedCurriculumNodeIds[0] ?? null,
      isCurrent: risk.status !== 'stale',
    })),
    analysisState: 'available',
    computedAt,
  });
}

export function createCourseOverviewService({ repos, clock }: CourseOverviewDeps) {
  function get(workspaceId: string): CourseExecutionOverview {
    const workspace = repos.workspaces.get(workspaceId);
    if (!workspace) throw notFound('Course not found.');
    const generatedAt = clock.now().toISOString();
    const state = repos.courseExecution.get(workspaceId);
    const contracts = repos.learningContracts.list(workspaceId);
    const curricula = repos.curricula.list(workspaceId);
    const plans = repos.studyPlans.list(workspaceId);
    const activeContract = state.activeContractId
      ? (repos.learningContracts.get(state.activeContractId) ?? null)
      : null;
    const pendingContract =
      [...contracts]
        .reverse()
        .find(
          (contract) =>
            contract.id !== state.activeContractId &&
            ['draft', 'proposed', 'learner_confirmed'].includes(contract.status),
        ) ?? null;
    const acceptedCurriculum = state.activeCurriculumId
      ? (repos.curricula.get(state.activeCurriculumId) ?? null)
      : null;
    const selectedContract = pendingContract ?? activeContract;
    const planningCurriculum = selectedContract
      ? ([...curricula]
          .reverse()
          .find(
            (item) => item.status === 'accepted' && item.contractVersionId === selectedContract.id,
          ) ?? null)
      : null;
    const proposedCurriculum =
      [...curricula]
        .reverse()
        .find(
          (item) => item.status === 'proposed' && item.contractVersionId === selectedContract?.id,
        ) ?? null;
    const acceptedStudyPlan = state.acceptedPlanId
      ? (repos.studyPlans.get(state.acceptedPlanId) ?? null)
      : null;
    const proposedStudyPlan =
      [...plans].reverse().find((item) => item.status === 'proposed') ?? null;
    const activeAgenda = state.activeAgendaId
      ? (repos.sessionAgendas.get(state.activeAgendaId) ?? null)
      : null;
    const planProgress = acceptedStudyPlan
      ? repos.studyPlans.listProgress(acceptedStudyPlan.id)
      : [];
    const routeEvidence =
      activeContract && acceptedStudyPlan
        ? repos.formalProgression.listEvidenceForRoute(activeContract.id, acceptedStudyPlan.id)
        : [];
    const currentAgendaItem = activeAgenda
      ? (activeAgenda.items.find((item) => item.id === activeAgenda.currentItemId) ??
        activeAgenda.items.find((item) => item.state === 'queued') ??
        null)
      : null;
    const selectedCurriculum = proposedCurriculum ?? planningCurriculum;
    const studyPlanPreflight =
      selectedContract && planningCurriculum
        ? preflightStudyPlan(repos, clock, selectedContract, planningCurriculum, workspace.name)
        : null;
    const proposedCurriculumPreflight =
      selectedContract &&
      proposedCurriculum &&
      requiresStudyPlanExecutionRepair(
        repos,
        clock,
        selectedContract,
        proposedCurriculum.predecessorId
          ? (repos.curricula.get(proposedCurriculum.predecessorId) ?? null)
          : null,
        workspace.name,
      )
        ? preflightStudyPlan(repos, clock, selectedContract, proposedCurriculum, workspace.name)
        : null;
    const risks = selectedContract
      ? repos.coverageRisks.list(workspaceId, selectedContract.id)
      : repos.coverageRisks.list(workspaceId);

    const setupStage: CourseExecutionOverview['setupStage'] = activeStudyStage(
      activeContract,
      pendingContract,
      planningCurriculum,
      proposedCurriculum,
      acceptedStudyPlan,
      proposedStudyPlan,
    );

    return CourseExecutionOverviewSchema.parse({
      workspaceId,
      setupStage,
      executionStatus: state.executionStatus,
      courseExecutionVersion: state.version,
      activeContract,
      pendingContract,
      contractFeasibility: selectedContract
        ? (repos.learningContracts.getLatestFeasibility(selectedContract.id) ?? null)
        : null,
      acceptedCurriculum,
      planningCurriculum,
      proposedCurriculum,
      curriculumHierarchy: selectedCurriculum ? curriculumHierarchy(selectedCurriculum) : null,
      activeCurriculumHierarchy: acceptedCurriculum
        ? curriculumHierarchy(acceptedCurriculum)
        : null,
      acceptedStudyPlan,
      proposedStudyPlan,
      studyPlanPreflight,
      activeAgenda,
      formalProgress: {
        planItemCount: acceptedStudyPlan?.items.length ?? 0,
        completedPlanItemCount: planProgress.filter((item) => item.state === 'completed').length,
        startedPlanItemCount: planProgress.filter((item) => item.state === 'started').length,
        repairNeededPlanItemCount: planProgress.filter((item) => item.state === 'repair_needed')
          .length,
        deferredPlanItemCount: planProgress.filter((item) => item.state === 'deferred').length,
        stateCreditingEvidenceCount: routeEvidence.filter((item) => item.stateCreditable).length,
        advisoryEvidenceCount: routeEvidence.filter((item) => !item.stateCreditable).length,
      },
      nextAction:
        activeAgenda && currentAgendaItem
          ? {
              agendaId: activeAgenda.id,
              agendaVersion: activeAgenda.version,
              item: currentAgendaItem,
              whyNext: currentAgendaItem.reason,
            }
          : null,
      riskSummary: summarizeRisks(risks, generatedAt),
      capabilities: {
        canEditContract: pendingContract?.status === 'draft',
        canConfirmContract: pendingContract?.status === 'proposed',
        canProposeCurriculum:
          selectedContract?.status === 'learner_confirmed' || selectedContract?.status === 'active',
        canAcceptCurriculum:
          proposedCurriculum?.validation.valid === true &&
          proposedCurriculum.status === 'proposed' &&
          proposedCurriculumPreflight?.canGenerate !== false,
        canProposeStudyPlan:
          planningCurriculum !== null &&
          studyPlanPreflight?.canGenerate === true &&
          (selectedContract?.status === 'learner_confirmed' ||
            selectedContract?.status === 'active'),
        canEditStudyPlan: proposedStudyPlan?.status === 'proposed',
        canAcceptStudyPlan: proposedStudyPlan?.status === 'proposed',
        canContinueStudy: currentAgendaItem?.launch.status === 'launchable',
      },
      contractHistory: contracts.slice(-50).map((contract) => ({
        id: contract.id,
        version: contract.version,
        predecessorId: contract.predecessorId,
        status: contract.status,
        intent: contract.intent,
        targetDescription: contract.targetOutcome.description,
        deadlineAt: contract.deadline?.at ?? null,
        desiredDepth: contract.desiredDepth,
        learnerConfirmedAt: contract.learnerConfirmedAt,
        createdAt: contract.createdAt,
      })),
      curriculumHistory: curricula.slice(-50).map((curriculum) => ({
        id: curriculum.id,
        version: curriculum.version,
        predecessorId: curriculum.predecessorId,
        contractVersionId: curriculum.contractVersionId,
        status: curriculum.status,
        title: curriculum.nodes.find((node) => node.kind === 'course')?.title ?? 'Course',
        learningUnitCount: curriculum.nodes.filter((node) => node.kind === 'learning_unit').length,
        unmappedStructuralUnitCount: curriculum.validation.unmappedStructuralUnitIds.length,
        validationValid: curriculum.validation.valid,
        executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
        createdAt: curriculum.createdAt,
        acceptedAt: curriculum.acceptedAt,
      })),
      studyPlanHistory: plans.slice(-50).map((plan) => ({
        id: plan.id,
        version: plan.version,
        predecessorId: plan.predecessorId,
        contractVersionId: plan.contractVersionId,
        curriculumVersionId: plan.curriculumVersionId,
        status: plan.status,
        proposalTrigger: plan.proposalTrigger,
        itemCount: plan.items.length,
        deferredUnitCount: plan.deferrals.length,
        projectedMinutes: plan.feasibility.projectedMinutes,
        feasibilityState: plan.feasibility.state,
        executionSourceManifestFingerprint: plan.executionSourceManifestFingerprint,
        learnerAcceptedAt: plan.learnerAcceptedAt,
        createdAt: plan.createdAt,
      })),
      generatedAt,
    });
  }

  return { get };
}

function activeStudyStage(
  activeContract: CourseExecutionOverview['activeContract'],
  pendingContract: CourseExecutionOverview['pendingContract'],
  acceptedCurriculum: CourseExecutionOverview['acceptedCurriculum'],
  proposedCurriculum: CourseExecutionOverview['proposedCurriculum'],
  acceptedStudyPlan: CourseExecutionOverview['acceptedStudyPlan'],
  proposedStudyPlan: CourseExecutionOverview['proposedStudyPlan'],
): CourseExecutionOverview['setupStage'] {
  if (activeContract && acceptedStudyPlan) return 'route_active';
  const contract = pendingContract ?? activeContract;
  if (!contract) return 'contract_required';
  if (contract.status === 'draft' || contract.status === 'proposed') return 'contract_review';
  if (proposedCurriculum) return 'curriculum_review';
  if (!acceptedCurriculum) return 'curriculum_required';
  if (proposedStudyPlan) return 'plan_review';
  return 'plan_required';
}

export type CourseOverviewService = ReturnType<typeof createCourseOverviewService>;
