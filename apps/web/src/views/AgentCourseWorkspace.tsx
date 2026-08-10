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
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { AgentCourseShell, type AgentCourseView } from './AgentCourseShell.js';
import { CourseHomeView } from './CourseHomeView.js';
import { CurriculumView } from './CurriculumView.js';

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
  onOpenMaterials: () => void;
  onOpenExplore: () => void;
  onOpenProgress: (view: 'history' | 'mistakes' | 'mastery') => void;
  onLaunchQuiz: (quiz: PublicQuiz) => void;
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
  onOpenMaterials,
  onOpenExplore,
  onOpenProgress,
  onLaunchQuiz,
}: AgentCourseWorkspaceProps) {
  const [view, setView] = useState<AgentCourseView>('home');
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
  const loadEpoch = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  const action = useAsyncAction();

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
    const scopes: ContractCourseScope['materials'] = [];
    for (const document of documents) {
      const choice = materialChoices[document.id];
      if (!choice?.role) throw new Error(`请明确选择“${document.title}”的资料角色。`);
      const current = roleHistory[document.id]?.current;
      let confirmed: MaterialRoleAssignment;
      if (current?.status === 'learner_confirmed' && current.role === choice.role) {
        confirmed = current;
      } else {
        const proposed = await api.proposeMaterialRole(
          workspaceId,
          document.id,
          {
            command: command(workspaceId, 'propose_role'),
            materialId: document.id,
            role: choice.role,
            expectedCurrentAssignmentId: current?.id ?? null,
          },
          signal,
        );
        confirmed = await api.confirmMaterialRole(
          workspaceId,
          document.id,
          proposed.id,
          {
            command: command(workspaceId, 'confirm_role'),
            assignmentId: proposed.id,
            expectedVersion: proposed.version,
          },
          signal,
        );
      }
      scopes.push({
        materialId: document.id,
        materialRoleAssignmentId: confirmed.id,
        materialRoleAssignmentVersion: confirmed.version,
        role: choice.role,
        disposition: choice.disposition,
      });
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
    const curriculum =
      overview.proposedCurriculum?.status === 'accepted'
        ? overview.proposedCurriculum
        : overview.acceptedCurriculum;
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
          setNotice('学习单元已通过当前资料重新验证并启动。');
          onOpenExplore();
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
    if (next === 'explore') {
      onOpenExplore();
      return;
    }
    setView(next);
  }

  return (
    <AgentCourseShell
      activeView={view}
      courseName={selectedWorkspace?.name ?? null}
      onViewChange={changeView}
    >
      <div className="course-picker row">
        <label>
          课程空间
          <select
            aria-label="课程空间"
            value={workspaceId ?? ''}
            onChange={(event) => onWorkspaceChange(event.target.value || null)}
          >
            <option value="">请选择</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {action.error ? <Banner kind="error">{action.error}</Banner> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}

      {!workspaceId ? (
        loading ? (
          <Loading label="加载课程空间…" />
        ) : (
          <Banner kind="empty">选择课程空间，或在探索中创建课程并添加资料。</Banner>
        )
      ) : loading && !overview ? (
        <Loading label="加载课程执行状态…" />
      ) : contractEditorOpen && overview ? (
        <ContractEditor
          documents={documents}
          form={contractForm}
          materialChoices={materialChoices}
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
          onOpenMaterials={onOpenMaterials}
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
      ) : (
        <ProgressLanding onOpen={onOpenProgress} />
      )}
    </AgentCourseShell>
  );
}

interface ContractEditorProps {
  documents: DocumentSummary[];
  form: ContractFormState;
  materialChoices: Record<string, MaterialScopeChoice>;
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
  busy,
  onFormChange,
  onMaterialChoicesChange,
  onSubmit,
  onCancel,
}: ContractEditorProps) {
  const change = <K extends keyof ContractFormState>(key: K, value: ContractFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  return (
    <form
      className="contract-editor stack"
      aria-label="学习约定编辑器"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="row between">
        <div>
          <h2>学习约定</h2>
          <p className="small muted">学习范围由你确认；资料中的事实与评分依据另行验证。</p>
        </div>
        <button type="button" onClick={onCancel} disabled={busy}>
          返回
        </button>
      </div>

      <div className="contract-grid">
        <label>
          学习意图
          <input
            required
            value={form.intent}
            onChange={(event) => change('intent', event.target.value)}
          />
        </label>
        <label>
          目标结果
          <input
            required
            value={form.targetDescription}
            onChange={(event) => change('targetDescription', event.target.value)}
          />
        </label>
        <label>
          目标分数（可选）
          <input
            type="number"
            min="0"
            max="100"
            value={form.targetScore}
            onChange={(event) => change('targetScore', event.target.value)}
          />
        </label>
        <label>
          截止时间（可选）
          <input
            type="datetime-local"
            value={form.deadlineLocal}
            onChange={(event) => change('deadlineLocal', event.target.value)}
          />
        </label>
        <label>
          每天可用分钟
          <input
            type="number"
            min="1"
            value={form.minutesPerDay}
            onChange={(event) => change('minutesPerDay', event.target.value)}
          />
        </label>
        <label>
          每周可用分钟
          <input
            type="number"
            min="1"
            value={form.minutesPerWeek}
            onChange={(event) => change('minutesPerWeek', event.target.value)}
          />
        </label>
        <label>
          单次学习分钟（可选）
          <input
            type="number"
            min="1"
            value={form.preferredSessionMinutes}
            onChange={(event) => change('preferredSessionMinutes', event.target.value)}
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
        <label className="span-2">
          课程主题范围（逗号或换行分隔）
          <textarea
            required
            value={form.subjectBoundaries}
            onChange={(event) => change('subjectBoundaries', event.target.value)}
          />
        </label>
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
        <label>
          既往学习情况（自述）
          <textarea
            value={form.priorStudy}
            onChange={(event) => change('priorStudy', event.target.value)}
          />
        </label>
        <label>
          考试形式或情境（可选）
          <textarea
            value={form.examFormat}
            onChange={(event) => change('examFormat', event.target.value)}
          />
        </label>
      </div>

      <section aria-label="资料角色与范围">
        <h3>资料角色与范围</h3>
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
      </section>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.allowExplicitDeferral}
          onChange={(event) => change('allowExplicitDeferral', event.target.checked)}
        />
        允许在路线中明确延期，并持续显示为学习缺口
      </label>
      <button type="submit" className="primary" disabled={busy || documents.length === 0}>
        {busy ? '正在保存…' : '保存约定草稿'}
      </button>
    </form>
  );
}

function ProgressLanding({ onOpen }: { onOpen: AgentCourseWorkspaceProps['onOpenProgress'] }) {
  return (
    <div className="progress-landing" aria-label="学习进展">
      <section>
        <h2>学习进展</h2>
        <p className="muted">正式测验、错题和掌握记录来自现有确定性学习状态。</p>
      </section>
      <div className="progress-links">
        <button type="button" onClick={() => onOpen('history')}>
          正式测验记录
        </button>
        <button type="button" onClick={() => onOpen('mistakes')}>
          错题与修复
        </button>
        <button type="button" onClick={() => onOpen('mastery')}>
          掌握状态
        </button>
      </div>
    </div>
  );
}
