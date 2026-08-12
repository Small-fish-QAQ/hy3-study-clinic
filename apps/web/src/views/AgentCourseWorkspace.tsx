import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContractCourseScope,
  CourseExecutionCommandEnvelope,
  CourseExecutionOverview,
  CurriculumHierarchyView,
  DesiredDepth,
  DocumentSummary,
  LearningContract,
  LearningContractDraftFields,
  MaterialRole,
  MaterialRoleAssignment,
  MaterialRoleHistoryResponse,
  PublicQuiz,
  StudyPlanDraftEdit,
  WorkspaceSummary,
} from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import {
  AgentCourseShell,
  readSidebarCollapsedPreference,
  type AgentCourseView,
} from './AgentCourseShell.js';
import { CourseHomeView } from './CourseHomeView.js';
import { CurriculumView } from './CurriculumView.js';
import { StudySessionView } from './StudySessionView.js';
import { CourseMaterialsView } from './CourseMaterialsView.js';
import { CourseProgressView } from './CourseProgressView.js';
import { GraphWorkspaceView } from './GraphWorkspaceView.js';
import { SettingsView } from './SettingsView.js';

const ROLE_LABELS: Record<MaterialRole, string> = {
  course_material: '课程主资料',
  supplementary_reference: '补充参考',
  past_exam: '往年试题',
  exercise_sheet: '练习资料',
  question_set: '题目集合',
};

const DEPTH_LABELS: Record<DesiredDepth, string> = {
  pass_oriented: '通过导向',
  working_fluency: '熟练应用',
  high_performance: '高分表现',
  deep_transfer: '深入迁移',
};

const MATERIAL_ROLE_RECONFIRMATION_MESSAGE =
  '课程资料已更新，需要重新确认资料用途。请检查资料角色与范围后再次保存学习约定。';

interface ContractFormState {
  intent: string;
  targetDescription: string;
  targetScore: string;
  deadlineLocal: string;
  minutesPerDay: string;
  minutesPerWeek: string;
  preferredSessionMinutes: string;
  desiredDepth: DesiredDepth;
  subjectBoundaries: string;
  includedTopics: string;
  excludedTopics: string;
  priorStudy: string;
  examFormat: string;
  allowExplicitDeferral: boolean;
}

interface MaterialScopeChoice {
  role: MaterialRole | '';
  disposition: 'included' | 'excluded';
}

export interface AgentCourseWorkspaceProps {
  workspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null) => void;
  onLaunchQuiz: (quiz: PublicQuiz) => void;
  refreshKey: number;
  provider?: 'fake' | 'hy3' | null;
  onOpenAdvancedTools?: () => void;
  onWorkspaceDeleted?: (workspaceId: string) => void;
}

let fallbackCommandSequence = 0;

function nextCommandId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  fallbackCommandSequence += 1;
  return `${prefix}_${random ?? `${Date.now()}_${fallbackCommandSequence}`}`;
}

function command(workspaceId: string, prefix: string): CourseExecutionCommandEnvelope {
  const commandId = nextCommandId(prefix);
  return {
    commandId,
    idempotencyKey: commandId,
    workspaceId,
    actor: 'learner',
  };
}

function list(text: string): string[] {
  return text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function optionalPositiveInt(value: string): number | null {
  if (value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function initialForm(contract: LearningContract | null): ContractFormState {
  return {
    intent: contract?.intent ?? '',
    targetDescription: contract?.targetOutcome.description ?? '',
    targetScore: contract?.targetOutcome.targetScore?.toString() ?? '',
    deadlineLocal: contract?.deadline?.at ? contract.deadline.at.slice(0, 16) : '',
    minutesPerDay: contract?.studyBudget.minutesPerDay?.toString() ?? '',
    minutesPerWeek: contract?.studyBudget.minutesPerWeek?.toString() ?? '',
    preferredSessionMinutes: contract?.studyBudget.preferredSessionMinutes?.toString() ?? '',
    desiredDepth: contract?.desiredDepth ?? 'working_fluency',
    subjectBoundaries: contract?.courseScope.subjectBoundaries.join(', ') ?? '',
    includedTopics: contract?.courseScope.includedTopics.join(', ') ?? '',
    excludedTopics: contract?.courseScope.excludedTopics.join(', ') ?? '',
    priorStudy: contract?.learnerSelfReport?.priorStudy ?? '',
    examFormat: contract?.examContext?.format ?? '',
    allowExplicitDeferral: contract?.riskTolerance?.allowExplicitDeferral ?? true,
  };
}

/** Controlled Phase-2 Course execution workspace. All lifecycle facts come from the server. */
export function AgentCourseWorkspace({
  workspaceId,
  onWorkspaceChange,
  onLaunchQuiz,
  refreshKey,
  provider = null,
  onOpenAdvancedTools,
  onWorkspaceDeleted,
}: AgentCourseWorkspaceProps) {
  const [view, setView] = useState<AgentCourseView>('home');
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [overview, setOverview] = useState<CourseExecutionOverview | null>(null);
  const [hierarchy, setHierarchy] = useState<CurriculumHierarchyView | null>(null);
  const [roleHistory, setRoleHistory] = useState<Record<string, MaterialRoleHistoryResponse>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contractEditorOpen, setContractEditorOpen] = useState(false);
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [contractForm, setContractForm] = useState<ContractFormState>(() => initialForm(null));
  const [materialChoices, setMaterialChoices] = useState<Record<string, MaterialScopeChoice>>({});
  const [newCourseName, setNewCourseName] = useState('');
  const loadEpoch = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  const action = useAsyncAction();
  const progressRemediationAction = useAsyncAction();

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

  const loadCourse = useCallback(
    async (targetWorkspaceId: string | null, signal: AbortSignal) => {
      const epoch = ++loadEpoch.current;
      setLoading(true);
      setLoadError(null);
      try {
        const listed = await api.listWorkspaces(signal);
        if (signal.aborted || epoch !== loadEpoch.current) return;
        setWorkspaces(listed.workspaces);
        if (!targetWorkspaceId) {
          setDocuments([]);
          setOverview(null);
          setHierarchy(null);
          setRoleHistory({});
          return;
        }
        if (!listed.workspaces.some((workspace) => workspace.id === targetWorkspaceId)) {
          onWorkspaceChange(null);
          setDocuments([]);
          setOverview(null);
          setHierarchy(null);
          setRoleHistory({});
          return;
        }
        const [detail, execution] = await Promise.all([
          api.getWorkspace(targetWorkspaceId, signal),
          api.courseExecution(targetWorkspaceId, signal),
        ]);
        const roles = await Promise.all(
          detail.documents.map((document) =>
            api.materialRoleHistory(targetWorkspaceId, document.id, signal),
          ),
        );
        if (signal.aborted || epoch !== loadEpoch.current) return;
        setDocuments(detail.documents);
        setOverview(execution.overview);
        setHierarchy(execution.overview.curriculumHierarchy);
        setRoleHistory(Object.fromEntries(roles.map((role) => [role.materialId, role])));
      } catch (error) {
        if (!signal.aborted && epoch === loadEpoch.current) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!signal.aborted && epoch === loadEpoch.current) setLoading(false);
      }
    },
    [onWorkspaceChange],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadCourse(workspaceId, controller.signal);
    return () => {
      controller.abort();
      loadEpoch.current += 1;
    };
  }, [loadCourse, workspaceId]);

  async function refresh(signal?: AbortSignal): Promise<void> {
    if (!workspaceId) return;
    const execution = await api.courseExecution(workspaceId, signal);
    if (signal?.aborted) return;
    setOverview(execution.overview);
    setHierarchy(execution.overview.curriculumHierarchy);
  }

  async function refreshCourse(): Promise<void> {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return;
    const controller = new AbortController();
    await loadCourse(targetWorkspaceId, controller.signal);
  }

  async function createCourse(): Promise<void> {
    const name = newCourseName.trim();
    if (!name) return;
    setBusyAction('create-course');
    const created = await action.run((signal) => api.createWorkspace({ name }, signal));
    setBusyAction(null);
    if (!created) return;
    setNewCourseName('');
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setView('home');
    onWorkspaceChange(created.workspace.id);
  }

  async function remediateMaterial(materialId: string): Promise<void> {
    const capturedWorkspaceId = workspaceId;
    const response = await progressRemediationAction.run((signal) =>
      api.remediation(materialId, signal),
    );
    if (!response || capturedWorkspaceId !== workspaceIdRef.current) return;
    onLaunchQuiz(response.quiz);
  }

  async function runAction<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
    after?: (result: T, signal: AbortSignal) => Promise<void> | void,
  ): Promise<void> {
    const capturedWorkspaceId = workspaceId;
    setBusyAction(name);
    setNotice(null);
    await action.run(async (signal) => {
      const result = await operation(signal);
      if (capturedWorkspaceId === workspaceIdRef.current) await after?.(result, signal);
      return result;
    });
    if (capturedWorkspaceId === workspaceIdRef.current) setBusyAction(null);
  }

  function openContractEditor(contract: LearningContract | null): void {
    setEditingContractId(contract?.status === 'draft' ? contract.id : null);
    setContractForm(initialForm(contract));
    const existingByMaterial = new Map(
      contract?.courseScope.materials.map((scope) => [scope.materialId, scope]) ?? [],
    );
    setMaterialChoices(
      Object.fromEntries(
        documents.map((document) => {
          const scoped = existingByMaterial.get(document.id);
          const current = roleHistory[document.id]?.current;
          const persistedRole =
            current?.status === 'learner_confirmed' &&
            current.role !== 'unknown' &&
            current.role !== 'excluded'
              ? current.role
              : '';
          return [
            document.id,
            {
              role: scoped?.role ?? persistedRole,
              disposition: scoped?.disposition ?? 'included',
            },
          ];
        }),
      ),
    );
    setContractEditorOpen(true);
  }

  async function ensureConfirmedRoles(
    signal: AbortSignal,
  ): Promise<ContractCourseScope['materials']> {
    if (!workspaceId) throw new Error('请先选择课程空间。');

    const acceptAuthoritativeHistory = (history: MaterialRoleHistoryResponse) => {
      if (signal.aborted || workspaceId !== workspaceIdRef.current) {
        throw new ApiClientError('ABORTED', '请求已取消。');
      }
      setRoleHistory((current) => ({ ...current, [history.materialId]: history }));
      return history;
    };

    const reloadRole = async (materialId: string) =>
      acceptAuthoritativeHistory(await api.materialRoleHistory(workspaceId, materialId, signal));

    const scopes: ContractCourseScope['materials'] = [];
    for (const document of documents) {
      const choice = materialChoices[document.id];
      if (!choice?.role) throw new Error(`请明确选择“${document.title}”的资料角色。`);
      try {
        const current = (await reloadRole(document.id)).current;
        let confirmed: MaterialRoleAssignment;
        if (current.status === 'learner_confirmed' && current.role === choice.role) {
          confirmed = current;
        } else {
          const proposal =
            current.status === 'proposed' && current.role === choice.role
              ? current
              : await api.proposeMaterialRole(
                  workspaceId,
                  document.id,
                  {
                    command: command(workspaceId, 'propose_role'),
                    materialId: document.id,
                    role: choice.role,
                    expectedCurrentAssignmentId: current.id,
                  },
                  signal,
                );
          const confirmation = await api.confirmMaterialRole(
            workspaceId,
            document.id,
            proposal.id,
            {
              command: command(workspaceId, 'confirm_role'),
              assignmentId: proposal.id,
              expectedVersion: proposal.version,
            },
            signal,
          );
          const refreshed = await reloadRole(document.id);
          if (
            refreshed.current.id !== confirmation.id ||
            refreshed.current.version !== confirmation.version ||
            refreshed.current.status !== 'learner_confirmed' ||
            refreshed.current.role !== choice.role
          ) {
            throw new Error(MATERIAL_ROLE_RECONFIRMATION_MESSAGE);
          }
          confirmed = refreshed.current;
        }
        scopes.push({
          materialId: document.id,
          materialRoleAssignmentId: confirmed.id,
          materialRoleAssignmentVersion: confirmed.version,
          role: choice.role,
          disposition: choice.disposition,
        });
      } catch (error) {
        if (
          error instanceof ApiClientError &&
          error.code === 'VERSION_CONFLICT' &&
          error.message.startsWith('Material role')
        ) {
          await reloadRole(document.id);
          throw new Error(MATERIAL_ROLE_RECONFIRMATION_MESSAGE);
        }
        throw error;
      }
    }
    return scopes;
  }

  function contractFields(scopes: ContractCourseScope['materials']): LearningContractDraftFields {
    const minutesPerDay = optionalPositiveInt(contractForm.minutesPerDay);
    const minutesPerWeek = optionalPositiveInt(contractForm.minutesPerWeek);
    if (minutesPerDay === null && minutesPerWeek === null) {
      throw new Error('请填写每天或每周至少一项可用学习时间。');
    }
    const subjectBoundaries = list(contractForm.subjectBoundaries);
    if (subjectBoundaries.length === 0) throw new Error('请填写课程主题范围。');
    const deadlineAt = contractForm.deadlineLocal
      ? new Date(contractForm.deadlineLocal).toISOString()
      : null;
    return {
      intent: contractForm.intent.trim(),
      targetOutcome: {
        description: contractForm.targetDescription.trim(),
        targetScore:
          contractForm.targetScore.trim() === '' ? null : Number(contractForm.targetScore),
        credential: null,
      },
      deadline: deadlineAt
        ? {
            at: deadlineAt,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }
        : null,
      studyBudget: {
        minutesPerDay,
        minutesPerWeek,
        preferredSessionMinutes: optionalPositiveInt(contractForm.preferredSessionMinutes),
        unavailablePeriods: [],
      },
      desiredDepth: contractForm.desiredDepth,
      courseScope: {
        subjectBoundaries,
        materials: scopes,
        includedTopics: list(contractForm.includedTopics),
        excludedTopics: list(contractForm.excludedTopics),
      },
      learnerSelfReport: contractForm.priorStudy.trim()
        ? {
            priorStudy: contractForm.priorStudy.trim(),
            confidence: null,
            strengths: [],
            knownGaps: [],
          }
        : null,
      examContext: contractForm.examFormat.trim()
        ? {
            examAt: deadlineAt,
            intendedScope: list(contractForm.includedTopics),
            materialIds: scopes
              .filter((scope) => scope.role === 'past_exam' && scope.disposition === 'included')
              .map((scope) => scope.materialId),
            format: contractForm.examFormat.trim(),
            constraints: [],
          }
        : null,
      riskTolerance: {
        description: null,
        allowExplicitDeferral: contractForm.allowExplicitDeferral,
        maximumUnresolvedPriority: null,
      },
    };
  }

  async function submitContract(): Promise<void> {
    if (!workspaceId || !overview) return;
    await runAction(
      'save-contract',
      async (signal) => {
        const scopes = await ensureConfirmedRoles(signal);
        const fields = contractFields(scopes);
        if (editingContractId) {
          const editing = overview.pendingContract;
          if (!editing || editing.id !== editingContractId) throw new Error('约定草稿已过期。');
          return api.updateLearningContract(
            workspaceId,
            editing.id,
            {
              command: command(workspaceId, 'update_contract'),
              contractId: editing.id,
              expectedVersion: editing.version,
              fields,
            },
            signal,
          );
        }
        const latestContractId = overview.contractHistory.at(-1)?.id ?? null;
        return api.createLearningContract(
          workspaceId,
          {
            command: command(workspaceId, 'create_contract'),
            fields,
            predecessorContractId: latestContractId,
            expectedActiveContractId: overview.activeContract?.id ?? null,
          },
          signal,
        );
      },
      async (_result, signal) => {
        setContractEditorOpen(false);
        await refresh(signal);
      },
    );
  }

  async function transitionContract(): Promise<void> {
    if (!workspaceId || !overview?.pendingContract) return;
    const current = overview.pendingContract;
    if (current.status !== 'draft' && current.status !== 'proposed') return;
    const transition = current.status === 'draft' ? 'propose' : 'confirm';
    await runAction(
      'confirm-contract',
      (signal) =>
        api.transitionLearningContract(
          workspaceId,
          current.id,
          {
            command: command(workspaceId, `${transition}_contract`),
            contractId: current.id,
            expectedVersion: current.version,
            transition,
          },
          signal,
        ),
      async (_result, signal) => refresh(signal),
    );
  }

  async function proposeCurriculum(): Promise<void> {
    if (!workspaceId || !overview) return;
    const contract = overview.pendingContract ?? overview.activeContract;
    if (!contract) return;
    await runAction(
      'propose-curriculum',
      (signal) =>
        api.proposeCurriculum(
          workspaceId,
          {
            command: command(workspaceId, 'propose_curriculum'),
            contractId: contract.id,
            expectedContractVersion: contract.version,
            predecessorCurriculumId: overview.curriculumHistory.at(-1)?.id ?? null,
            expectedActiveCurriculumId: overview.acceptedCurriculum?.id ?? null,
          },
          signal,
        ),
      async (result, signal) => {
        setHierarchy(result.hierarchy);
        setView('curriculum');
        await refresh(signal);
      },
    );
  }

  async function decideCurriculum(decision: 'accept' | 'reject'): Promise<void> {
    if (!workspaceId || !overview?.proposedCurriculum) return;
    const curriculum = overview.proposedCurriculum;
    await runAction(
      `${decision}-curriculum`,
      (signal) => {
        if (decision === 'accept') {
          return api.acceptCurriculum(
            workspaceId,
            curriculum.id,
            {
              command: command(workspaceId, 'accept_curriculum'),
              curriculumId: curriculum.id,
              expectedVersion: curriculum.version,
              expectedContractId: curriculum.contractVersionId,
              expectedExecutionSourceManifestFingerprint:
                curriculum.executionSourceManifest.fingerprint,
              acceptanceBasis: 'learner_review',
            },
            signal,
          );
        }
        const reason = window.prompt('请说明拒绝该课程结构的原因：')?.trim();
        if (!reason) throw new Error('拒绝课程结构需要填写原因。');
        return api.rejectCurriculum(
          workspaceId,
          curriculum.id,
          {
            command: command(workspaceId, 'reject_curriculum'),
            curriculumId: curriculum.id,
            expectedVersion: curriculum.version,
            reason,
          },
          signal,
        );
      },
      async (result, signal) => {
        setHierarchy(result.hierarchy);
        await refresh(signal);
      },
    );
  }

  async function proposePlan(): Promise<void> {
    if (!workspaceId || !overview) return;
    const contract = overview.pendingContract ?? overview.activeContract;
    const curriculum = overview.planningCurriculum;
    if (!contract || !curriculum) return;
    await runAction(
      'propose-plan',
      (signal) =>
        api.proposeStudyPlan(
          workspaceId,
          {
            command: command(workspaceId, 'propose_plan'),
            contractId: contract.id,
            expectedContractVersion: contract.version,
            curriculumId: curriculum.id,
            expectedCurriculumVersion: curriculum.version,
            expectedExecutionSourceManifestFingerprint:
              curriculum.executionSourceManifest.fingerprint,
            predecessorStudyPlanId: overview.studyPlanHistory.at(-1)?.id ?? null,
            expectedAcceptedStudyPlanId: overview.acceptedStudyPlan?.id ?? null,
            proposalTrigger: overview.acceptedStudyPlan
              ? 'Learner requested a successor route.'
              : 'Initial route',
          },
          signal,
        ),
      async (_result, signal) => refresh(signal),
    );
  }

  async function editPlan(edit: StudyPlanDraftEdit): Promise<void> {
    if (!workspaceId || !overview?.proposedStudyPlan) return;
    const current = overview.proposedStudyPlan;
    await runAction(
      'edit-plan',
      (signal) =>
        api.editStudyPlan(
          workspaceId,
          current.id,
          {
            command: command(workspaceId, 'edit_plan'),
            studyPlanId: current.id,
            expectedVersion: current.version,
            expectedContractId: current.contractVersionId,
            expectedCurriculumId: current.curriculumVersionId,
            expectedExecutionSourceManifestFingerprint: current.executionSourceManifestFingerprint,
            edit,
          },
          signal,
        ),
      async (_result, signal) => refresh(signal),
    );
  }

  async function decidePlan(decision: 'accept' | 'reject'): Promise<void> {
    if (!workspaceId || !overview?.proposedStudyPlan) return;
    const current = overview.proposedStudyPlan;
    const reason =
      decision === 'reject' ? window.prompt('请说明拒绝该学习路线的原因：')?.trim() : null;
    if (decision === 'reject' && !reason) {
      setNotice('拒绝学习路线需要填写原因。');
      return;
    }
    await runAction(
      `${decision}-plan`,
      (signal) =>
        api.decideStudyPlan(
          workspaceId,
          current.id,
          {
            command: command(workspaceId, `${decision}_plan`),
            studyPlanId: current.id,
            expectedVersion: current.version,
            expectedContractId: current.contractVersionId,
            expectedCurriculumId: current.curriculumVersionId,
            expectedExecutionSourceManifestFingerprint: current.executionSourceManifestFingerprint,
            decision,
            reason: reason ?? null,
          },
          signal,
        ),
      async (_result, signal) => refresh(signal),
    );
  }

  async function launchNext(): Promise<void> {
    if (
      !workspaceId ||
      !overview?.nextAction ||
      !overview.activeContract ||
      !overview.acceptedStudyPlan
    )
      return;
    const next = overview.nextAction;
    await runAction(
      'launch-next',
      (signal) =>
        api.launchAgendaItem(
          workspaceId,
          next.agendaId,
          next.item.id,
          {
            command: command(workspaceId, 'launch_agenda_item'),
            agendaId: next.agendaId,
            expectedAgendaVersion: next.agendaVersion,
            agendaItemId: next.item.id,
            expectedContractId: overview.activeContract!.id,
            expectedStudyPlanId: overview.acceptedStudyPlan!.id,
            expectedExecutionSourceManifestFingerprint:
              overview.acceptedStudyPlan!.executionSourceManifestFingerprint,
          },
          signal,
        ),
      async (result, signal) => {
        if (result.kind === 'assessment') onLaunchQuiz(result.quiz);
        if (result.kind === 'lesson') {
          setNotice('当前学习内容已重新验证，可以在学习页继续。');
          setView('session');
        }
        if (result.kind === 'blocked') setNotice(result.reason);
        await refresh(signal);
      },
    );
  }

  async function selectCurriculumHistory(curriculumId: string): Promise<void> {
    if (!workspaceId) return;
    await runAction(
      'load-curriculum-history',
      (signal) => api.curriculum(workspaceId, curriculumId, signal),
      (result) => {
        setHierarchy(result.hierarchy);
      },
    );
  }

  function changeView(next: AgentCourseView): void {
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setView(next);
  }

  function changeCourse(nextWorkspaceId: string | null): void {
    action.cancel();
    progressRemediationAction.cancel();
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setView('home');
    onWorkspaceChange(nextWorkspaceId);
  }

  return (
    <AgentCourseShell
      activeView={view}
      courseId={workspaceId}
      courseName={selectedWorkspace?.name ?? null}
      courses={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
      materialsActive={materialsOpen}
      settingsActive={settingsOpen}
      provider={provider}
      sidebarCollapsed={sidebarCollapsed}
      onCourseChange={changeCourse}
      onViewChange={changeView}
      onOpenMaterials={() => {
        setSettingsOpen(false);
        setMaterialsOpen(true);
      }}
      onOpenSettings={() => {
        setMaterialsOpen(false);
        setSettingsOpen(true);
      }}
      onOpenAdvancedTools={onOpenAdvancedTools}
      onSidebarCollapsedChange={setSidebarCollapsed}
    >
      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}

      {settingsOpen ? (
        <SettingsView
          provider={provider}
          sidebarDefaultCollapsed={sidebarCollapsed}
          onSidebarDefaultCollapsedChange={setSidebarCollapsed}
        />
      ) : !workspaceId ? (
        loading ? (
          <Loading label="加载课程…" />
        ) : (
          <section className="no-course-state" aria-label="选择或创建课程">
            <p className="eyebrow">开始学习</p>
            <h2>选择一门课程</h2>
            <p className="muted">
              课程会保存资料、学习目标、当前路线和正式进展。请从上方选择已有课程，或现在创建一门课程。
            </p>
            <form
              className="course-create-inline row"
              onSubmit={(event) => {
                event.preventDefault();
                void createCourse();
              }}
            >
              <label>
                <span className="sr-only">新课程名称</span>
                <input
                  aria-label="新课程名称"
                  value={newCourseName}
                  placeholder="例如：认知科学导论"
                  onChange={(event) => setNewCourseName(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="primary"
                disabled={action.loading || newCourseName.trim().length === 0}
              >
                创建课程
              </button>
            </form>
          </section>
        )
      ) : loading && !overview ? (
        <Loading label="加载课程状态…" />
      ) : materialsOpen ? (
        <CourseMaterialsView
          workspaceId={workspaceId}
          documents={documents}
          roleHistory={roleHistory}
          onChanged={refreshCourse}
          onBack={() => setMaterialsOpen(false)}
        />
      ) : contractEditorOpen && overview ? (
        <ContractEditor
          documents={documents}
          form={contractForm}
          materialChoices={materialChoices}
          roleHistory={roleHistory}
          busy={busyAction !== null}
          onFormChange={setContractForm}
          onMaterialChoicesChange={setMaterialChoices}
          onSubmit={() => void submitContract()}
          onCancel={() => setContractEditorOpen(false)}
        />
      ) : view === 'home' ? (
        <CourseHomeView
          courseName={selectedWorkspace?.name ?? '课程'}
          overview={overview}
          loading={loading}
          error={loadError}
          busyAction={busyAction}
          onCreateContract={() => openContractEditor(overview?.activeContract ?? null)}
          onEditContract={() => openContractEditor(overview?.pendingContract ?? null)}
          onConfirmContract={() => void transitionContract()}
          onProposeCurriculum={() => void proposeCurriculum()}
          onOpenCurriculum={() => setView('curriculum')}
          onProposeStudyPlan={() => void proposePlan()}
          onEditStudyPlan={(edit) => void editPlan(edit)}
          onAcceptStudyPlan={() => void decidePlan('accept')}
          onRejectStudyPlan={() => void decidePlan('reject')}
          onLaunchNext={() => void launchNext()}
          onOpenStudySession={() => setView('session')}
          onOpenMaterials={() => setMaterialsOpen(true)}
        />
      ) : view === 'curriculum' ? (
        <CurriculumView
          hierarchy={hierarchy}
          history={overview?.curriculumHistory ?? []}
          loading={loading}
          error={loadError}
          canPropose={overview?.capabilities.canProposeCurriculum ?? false}
          canAccept={overview?.capabilities.canAcceptCurriculum ?? false}
          busyAction={busyAction}
          onPropose={() => void proposeCurriculum()}
          onAccept={() => void decideCurriculum('accept')}
          onReject={() => void decideCurriculum('reject')}
          onSelectHistory={(id) => void selectCurriculumHistory(id)}
        />
      ) : view === 'session' ? (
        <StudySessionView
          workspaceId={workspaceId}
          courseName={selectedWorkspace?.name ?? '课程'}
          curriculumUnits={(overview?.activeCurriculumHierarchy?.nodes ?? [])
            .filter((node) => node.kind === 'learning_unit')
            .map((node) => ({ id: node.id, title: node.title }))}
          route={
            overview?.activeContract &&
            overview.acceptedCurriculum &&
            overview.acceptedStudyPlan &&
            overview.activeAgenda
              ? {
                  contractVersionId: overview.activeContract.id,
                  curriculumVersionId: overview.acceptedCurriculum.id,
                  studyPlanVersionId: overview.acceptedStudyPlan.id,
                  sessionAgendaId: overview.activeAgenda.id,
                  executionVersion: overview.courseExecutionVersion,
                }
              : null
          }
          onSessionChanged={() => void refresh()}
          onLaunchQuiz={onLaunchQuiz}
        />
      ) : view === 'progress' ? (
        <CourseProgressView
          workspaceId={workspaceId}
          documents={documents}
          overview={overview}
          refreshKey={refreshKey}
          command={(prefix) => command(workspaceId, prefix)}
          onAcceptProposedPlan={() => void decidePlan('accept')}
          onRejectProposedPlan={() => void decidePlan('reject')}
          onCourseChanged={() => void refresh()}
          onRemediate={(materialId) => void remediateMaterial(materialId)}
          remediationLoading={progressRemediationAction.loading}
          remediationError={progressRemediationAction.error}
        />
      ) : (
        <GraphWorkspaceView
          refreshKey={refreshKey}
          selectedWorkspaceId={workspaceId}
          onWorkspaceSelected={(nextWorkspaceId) => {
            if (nextWorkspaceId !== workspaceId) onWorkspaceChange(nextWorkspaceId);
          }}
          onWorkspaceDeleted={onWorkspaceDeleted}
          onLaunchQuiz={(quiz) => onLaunchQuiz(quiz)}
          onOpenMaterials={() => {
            setView('home');
            setMaterialsOpen(true);
          }}
          courseLocked
        />
      )}
    </AgentCourseShell>
  );
}

interface ContractEditorProps {
  documents: DocumentSummary[];
  form: ContractFormState;
  materialChoices: Record<string, MaterialScopeChoice>;
  roleHistory: Record<string, MaterialRoleHistoryResponse>;
  busy: boolean;
  onFormChange: (value: ContractFormState) => void;
  onMaterialChoicesChange: (value: Record<string, MaterialScopeChoice>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function ContractEditor({
  documents,
  form,
  materialChoices,
  roleHistory,
  busy,
  onFormChange,
  onMaterialChoicesChange,
  onSubmit,
  onCancel,
}: ContractEditorProps) {
  const change = <K extends keyof ContractFormState>(key: K, value: ContractFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  const needsRoleConfirmation = documents.some((document) => {
    const current = roleHistory[document.id]?.current;
    const choice = materialChoices[document.id];
    return !choice?.role || current?.status !== 'learner_confirmed' || current.role !== choice.role;
  });
  const hasChangedRoleAssignment = documents.some((document) => {
    const history = roleHistory[document.id];
    const choice = materialChoices[document.id];
    return Boolean(
      history &&
      history.history.length > 1 &&
      (history.current.status !== 'learner_confirmed' || history.current.role !== choice?.role),
    );
  });
  return (
    <form
      className="contract-editor stack"
      aria-label="学习约定编辑器"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header className="contract-header row between">
        <div className="contract-heading">
          <p className="eyebrow">学习约定</p>
          <h2>定义你与 Hy3 的学习约定</h2>
          <p className="muted">从目标开始。范围、时间与资料用途由你确认，Hy3 据此提出学习路线。</p>
        </div>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          返回
        </button>
      </header>

      <div className="contract-flow">
        <fieldset className="contract-question">
          <legend>
            <span>1</span>
            你想达成什么？
          </legend>
          <p className="contract-question-hint">
            说清学习动机与可验证的结果，Hy3 才能规划合适的路径。
          </p>
          <div className="contract-grid contract-grid-goal">
            <label>
              学习意图
              <input
                required
                value={form.intent}
                placeholder="例如：系统掌握课程核心内容并通过期末考试"
                onChange={(event) => change('intent', event.target.value)}
              />
            </label>
            <label>
              目标结果
              <input
                required
                value={form.targetDescription}
                placeholder="例如：能独立完成综合题并解释关键推导"
                onChange={(event) => change('targetDescription', event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>2</span>
            希望何时完成？
          </legend>
          <p className="contract-question-hint">
            没有固定日期也可以留空，路线会按当前投入持续调整。
          </p>
          <div className="contract-grid contract-grid-compact">
            <label>
              截止时间（可选）
              <input
                type="datetime-local"
                value={form.deadlineLocal}
                onChange={(event) => change('deadlineLocal', event.target.value)}
              />
            </label>
            <label>
              目标分数（可选）
              <input
                type="number"
                min="0"
                max="100"
                value={form.targetScore}
                placeholder="0-100"
                onChange={(event) => change('targetScore', event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>3</span>
            你能投入多少时间？
          </legend>
          <p className="contract-question-hint">
            每天或每周至少填写一项；单次时长帮助安排可完成的学习活动。
          </p>
          <div className="contract-grid contract-grid-budget">
            <label>
              每天可用分钟
              <input
                type="number"
                min="1"
                value={form.minutesPerDay}
                placeholder="例如：45"
                onChange={(event) => change('minutesPerDay', event.target.value)}
              />
            </label>
            <label>
              每周可用分钟
              <input
                type="number"
                min="1"
                value={form.minutesPerWeek}
                placeholder="例如：300"
                onChange={(event) => change('minutesPerWeek', event.target.value)}
              />
            </label>
            <label>
              单次学习分钟（可选）
              <input
                type="number"
                min="1"
                value={form.preferredSessionMinutes}
                placeholder="例如：30"
                onChange={(event) => change('preferredSessionMinutes', event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>4</span>
            你从哪里开始？
          </legend>
          <p className="contract-question-hint">
            简要说明已有基础；这只是你的自述，不会替代正式证据。
          </p>
          <div className="contract-grid contract-grid-start">
            <label>
              既往学习情况（自述）
              <textarea
                value={form.priorStudy}
                placeholder="学过哪些内容？哪些地方最不确定？"
                onChange={(event) => change('priorStudy', event.target.value)}
              />
            </label>
            <label>
              目标深度
              <select
                value={form.desiredDepth}
                onChange={(event) => change('desiredDepth', event.target.value as DesiredDepth)}
              >
                {(Object.keys(DEPTH_LABELS) as DesiredDepth[]).map((depth) => (
                  <option key={depth} value={depth}>
                    {DEPTH_LABELS[depth]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className="contract-question contract-materials">
          <legend>
            <span>5</span>
            哪些课程资料定义学习范围？
          </legend>
          <p className="contract-question-hint">
            资料用途决定路线范围，不等于内容已经被验证为事实或评分依据。
          </p>
          <label className="contract-subject-boundaries">
            课程主题范围（逗号或换行分隔）
            <textarea
              required
              value={form.subjectBoundaries}
              placeholder="例如：核心定义、主要定理、典型应用"
              onChange={(event) => change('subjectBoundaries', event.target.value)}
            />
          </label>
          {hasChangedRoleAssignment ? (
            <Banner kind="info">
              <strong>课程资料已更新，需要重新确认资料用途</strong>
              <br />
              资料用途的当前版本发生了变化。请检查资料角色与范围，确认后再继续保存学习约定。
            </Banner>
          ) : needsRoleConfirmation && documents.length > 0 ? (
            <Banner kind="info">
              <strong>请确认课程资料用途</strong>
              <br />
              学习约定会记录你确认的资料角色与范围，确认前不会继续建立课程结构。
            </Banner>
          ) : null}
          {documents.length === 0 ? (
            <Banner kind="info">课程没有可纳入学习约定的资料。</Banner>
          ) : (
            <div className="material-scope-list">
              {documents.map((document) => {
                const choice = materialChoices[document.id] ?? {
                  role: '',
                  disposition: 'included' as const,
                };
                return (
                  <div key={document.id} className="material-scope-row">
                    <strong>{document.title}</strong>
                    <label>
                      角色
                      <select
                        aria-label={`${document.title}资料角色`}
                        required
                        value={choice.role}
                        onChange={(event) =>
                          onMaterialChoicesChange({
                            ...materialChoices,
                            [document.id]: { ...choice, role: event.target.value as MaterialRole },
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {(Object.keys(ROLE_LABELS) as MaterialRole[]).map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      范围
                      <select
                        aria-label={`${document.title}范围`}
                        value={choice.disposition}
                        onChange={(event) =>
                          onMaterialChoicesChange({
                            ...materialChoices,
                            [document.id]: {
                              ...choice,
                              disposition: event.target.value as 'included' | 'excluded',
                            },
                          })
                        }
                      >
                        <option value="included">纳入本轮学习</option>
                        <option value="excluded">明确排除</option>
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>6</span>
            还有其他约束吗？
          </legend>
          <p className="contract-question-hint">可选设置不会阻挡你先建立基本约定。</p>
          <details className="contract-advanced">
            <summary>高级范围与考试设置</summary>
            <div className="contract-grid contract-grid-advanced">
              <label>
                明确包含的主题
                <textarea
                  value={form.includedTopics}
                  onChange={(event) => change('includedTopics', event.target.value)}
                />
              </label>
              <label>
                明确排除的主题
                <textarea
                  value={form.excludedTopics}
                  onChange={(event) => change('excludedTopics', event.target.value)}
                />
              </label>
              <label className="span-2">
                考试形式或情境（可选）
                <textarea
                  value={form.examFormat}
                  onChange={(event) => change('examFormat', event.target.value)}
                />
              </label>
              <label className="checkbox-row span-2">
                <input
                  type="checkbox"
                  checked={form.allowExplicitDeferral}
                  onChange={(event) => change('allowExplicitDeferral', event.target.checked)}
                />
                允许在路线中明确延期，并持续显示为学习缺口
              </label>
            </div>
          </details>
        </fieldset>
      </div>

      <footer className="contract-actions">
        <p className="small muted">保存后仍需由你确认，才会成为当前学习约定。</p>
        <button type="submit" className="primary" disabled={busy || documents.length === 0}>
          {busy
            ? '正在保存…'
            : needsRoleConfirmation
              ? '确认资料用途并保存约定草稿'
              : '保存约定草稿'}
        </button>
      </footer>
    </form>
  );
}
