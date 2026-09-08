import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContractCourseScope,
  CourseExecutionCommandEnvelope,
  CourseExecutionOverview,
  CoursePreparation,
  CreateLearningContractDraftRequest,
  CurriculumDraftEdit,
  CurriculumHierarchyView,
  DesiredDepth,
  DocumentSummary,
  LearningContract,
  MaterialRole,
  MaterialRoleAssignment,
  MaterialRoleHistoryResponse,
  KnowledgeMapMode,
  PublicQuiz,
  SourceBlock,
  StudyPlanDraftEdit,
  StudyPlanItemPlannability,
  WorkspaceSummary,
} from '@hy3-clinic/shared';
import { StudyPlanItemPlannabilitySchema } from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import type { CourseDestination } from '../appRoutes.js';
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
import {
  CourseProgressView,
  type CourseProgressIntent,
  type ProgressSection,
} from './CourseProgressView.js';
import { CourseAssessmentView } from './CourseAssessmentView.js';
import { GraphWorkspaceView } from './GraphWorkspaceView.js';
import { SettingsView } from './SettingsView.js';
import {
  KnowledgeMapView,
  type KnowledgeMapIntent,
  type KnowledgeMapNavigationTarget,
} from './KnowledgeMapView.js';

const DEPTH_LABELS: Record<DesiredDepth, string> = {
  pass_oriented: '基础理解',
  working_fluency: '熟练运用',
  high_performance: '高水平表现',
  deep_transfer: '深入迁移',
};

const SYSTEM_COURSE_INTENT = '学习课程资料中的重要内容。';
const SYSTEM_COURSE_OUTCOME = '按学习者选择的全局深度掌握课程资料中的重要内容。';
const SYSTEM_SUBJECT_BOUNDARY = '课程主题由本课程纳入的资料定义。';

const MATERIAL_ROLE_RECONFIRMATION_MESSAGE =
  '课程资料已更新，需要重新确认资料用途。请检查资料状态后再次保存课程设置。';
const ROUTE_FAILURE_STORAGE_PREFIX = 'hy3-clinic:route-generation-failure:';

interface RouteGenerationFailure {
  workspaceId: string;
  kind: 'timeout' | 'provider';
  detail: string;
}

type ActionFailureOwner =
  | 'course-create'
  | 'contract-editor'
  | 'home-contract'
  | 'home-curriculum'
  | 'home-plan'
  | 'home-continue'
  | 'curriculum'
  | 'progress';

function readRouteGenerationFailure(workspaceId: string | null): RouteGenerationFailure | null {
  if (!workspaceId) return null;
  try {
    const value = window.sessionStorage.getItem(`${ROUTE_FAILURE_STORAGE_PREFIX}${workspaceId}`);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<RouteGenerationFailure>;
    if (
      parsed.workspaceId !== workspaceId ||
      (parsed.kind !== 'timeout' && parsed.kind !== 'provider') ||
      typeof parsed.detail !== 'string'
    ) {
      return null;
    }
    return parsed as RouteGenerationFailure;
  } catch {
    return null;
  }
}

function storeRouteGenerationFailure(failure: RouteGenerationFailure | null): void {
  try {
    if (failure) {
      window.sessionStorage.setItem(
        `${ROUTE_FAILURE_STORAGE_PREFIX}${failure.workspaceId}`,
        JSON.stringify(failure),
      );
    }
  } catch {
    // Failure persistence across Compatibility navigation is optional when storage is unavailable.
  }
}

function clearStoredRouteGenerationFailure(workspaceId: string | null): void {
  if (!workspaceId) return;
  try {
    window.sessionStorage.removeItem(`${ROUTE_FAILURE_STORAGE_PREFIX}${workspaceId}`);
  } catch {
    // Session storage can be unavailable in privacy-restricted browser contexts.
  }
}

interface ContractFormState {
  desiredDepth: DesiredDepth;
  focusRequest: string;
}

interface MaterialScopeChoice {
  role: MaterialRole | '';
  disposition: 'included' | 'excluded';
}

export interface AgentCourseWorkspaceProps {
  workspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null) => void;
  refreshKey: number;
  provider?: 'fake' | 'hy3' | null;
  onProviderChange?: (provider: 'fake' | 'hy3') => void;
  navigationIntent?: { requestId: number; destination: CourseDestination };
  onDestinationChange?: (destination: CourseDestination) => void;
  onWorkspaceDeleted?: (workspaceId: string) => void;
}

/**
 * Reads per-item Lesson plannability out of a refused acceptance. Validated with the
 * shared schema rather than trusted, and an unrecognised payload degrades to no
 * per-item detail instead of throwing over the learner's error message.
 */
function readPlannabilityFromError(error: unknown): StudyPlanItemPlannability[] {
  if (!(error instanceof ApiClientError) || !error.details || typeof error.details !== 'object') {
    return [];
  }
  const parsed = StudyPlanItemPlannabilitySchema.array()
    .max(500)
    .safeParse((error.details as { plannability?: unknown }).plannability);
  return parsed.success ? parsed.data : [];
}

function viewForDestination(destination: CourseDestination): AgentCourseView {
  if (destination === 'study') return 'session';
  if (destination === 'curriculum') return 'curriculum';
  if (destination === 'knowledge-map' || destination === 'grounding') return 'explore';
  if (destination.startsWith('progress-') || destination === 'assessment') return 'progress';
  return 'home';
}

function progressSectionForDestination(destination: CourseDestination): ProgressSection {
  if (destination === 'progress-evidence') return 'evidence';
  if (destination === 'progress-repair') return 'repair';
  if (destination === 'progress-mastery') return 'mastery';
  if (destination === 'progress-history') return 'history';
  return 'overview';
}

function destinationForProgressSection(section: ProgressSection): CourseDestination {
  const destinations: Record<ProgressSection, CourseDestination> = {
    overview: 'progress-overview',
    evidence: 'progress-evidence',
    repair: 'progress-repair',
    mastery: 'progress-mastery',
    history: 'progress-history',
  };
  return destinations[section];
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

function initialForm(contract: LearningContract | null): ContractFormState {
  return {
    desiredDepth: contract?.desiredDepth ?? 'working_fluency',
    focusRequest: contract?.focusRequest ?? '',
  };
}

/** Controlled Phase-2 Course execution workspace. All lifecycle facts come from the server. */
export function AgentCourseWorkspace({
  workspaceId,
  onWorkspaceChange,
  refreshKey,
  provider = null,
  onProviderChange,
  navigationIntent,
  onDestinationChange,
  onWorkspaceDeleted,
}: AgentCourseWorkspaceProps) {
  const initialDestination = navigationIntent?.destination ?? 'home';
  const [view, setView] = useState<AgentCourseView>(() => viewForDestination(initialDestination));
  const [exploreSurface, setExploreSurface] = useState<'map' | 'concept-grounding'>(() =>
    initialDestination === 'grounding' ? 'concept-grounding' : 'map',
  );
  const mapIntentSequence = useRef(0);
  const progressIntentSequence = useRef(0);
  const [knowledgeMapIntent, setKnowledgeMapIntent] = useState<KnowledgeMapIntent>({
    requestId: 0,
    mode: 'knowledge_structure',
  });
  const [progressIntent, setProgressIntent] = useState<CourseProgressIntent | null>(() =>
    initialDestination.startsWith('progress-')
      ? {
          requestId: navigationIntent?.requestId ?? 0,
          section: progressSectionForDestination(initialDestination),
        }
      : null,
  );
  const [progressSection, setProgressSection] = useState<ProgressSection>(() =>
    progressSectionForDestination(initialDestination),
  );
  const [materialsOpen, setMaterialsOpen] = useState(initialDestination === 'materials');
  const [settingsOpen, setSettingsOpen] = useState(initialDestination === 'settings');
  const [assessmentOpen, setAssessmentOpen] = useState(initialDestination === 'assessment');
  const [launchedQuiz, setLaunchedQuiz] = useState<PublicQuiz | null>(null);
  const [assessmentRevision, setAssessmentRevision] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [overview, setOverview] = useState<CourseExecutionOverview | null>(null);
  const [preparation, setPreparation] = useState<CoursePreparation | null>(null);
  const [hierarchy, setHierarchy] = useState<CurriculumHierarchyView | null>(null);
  const [roleHistory, setRoleHistory] = useState<Record<string, MaterialRoleHistoryResponse>>({});
  const [curriculumSourceBlocks, setCurriculumSourceBlocks] = useState<SourceBlock[]>([]);
  const [curriculumSourceLoading, setCurriculumSourceLoading] = useState(false);
  const [curriculumSourceError, setCurriculumSourceError] = useState<string | null>(null);
  const [focusedMaterialId, setFocusedMaterialId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Server-computed Lesson plannability for the current proposal. Sourced from the
   * propose/edit response and from a refused acceptance; never derived locally, because
   * the slot arithmetic has exactly one implementation and it is on the server.
   */
  const [studyPlanPlannability, setStudyPlanPlannability] = useState<StudyPlanItemPlannability[]>(
    [],
  );
  const [contractEditorOpen, setContractEditorOpen] = useState(false);
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [contractForm, setContractForm] = useState<ContractFormState>(() => initialForm(null));
  const [materialChoices, setMaterialChoices] = useState<Record<string, MaterialScopeChoice>>({});
  const [newCourseName, setNewCourseName] = useState('');
  const [courseLifecycleOperation, setCourseLifecycleOperation] = useState<
    'create' | 'rename' | 'delete' | null
  >(null);
  const [routeGenerationFailure, setRouteGenerationFailure] =
    useState<RouteGenerationFailure | null>(() => readRouteGenerationFailure(workspaceId));
  const [actionFailureOwner, setActionFailureOwner] = useState<ActionFailureOwner | null>(null);
  const loadEpoch = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  const applyingNavigationIntentRef = useRef<number | null>(null);
  const action = useAsyncAction();
  const cancelAction = action.cancel;
  const clearActionError = action.clearError;
  const preparationAction = useAsyncAction();
  const cancelPreparationAction = preparationAction.cancel;
  const clearPreparationError = preparationAction.clearError;
  const planAction = useAsyncAction();
  const cancelPlanAction = planAction.cancel;
  const clearPlanError = planAction.clearError;
  const progressRemediationAction = useAsyncAction();
  const cancelProgressRemediationAction = progressRemediationAction.cancel;
  const clearProgressRemediationError = progressRemediationAction.clearError;
  const courseLifecycleAction = useAsyncAction();
  const cancelCourseLifecycleAction = courseLifecycleAction.cancel;
  const clearCourseLifecycleError = courseLifecycleAction.clearError;

  useEffect(() => {
    if (!navigationIntent) return;
    const requestId = navigationIntent.requestId;
    applyingNavigationIntentRef.current = requestId;
    queueMicrotask(() => {
      if (applyingNavigationIntentRef.current === requestId) {
        applyingNavigationIntentRef.current = null;
      }
    });
    const destination = navigationIntent.destination;
    setNotice(null);
    setMaterialsOpen(destination === 'materials');
    setSettingsOpen(destination === 'settings');
    setAssessmentOpen(destination === 'assessment');
    setContractEditorOpen(false);
    setEditingContractId(null);
    setView(viewForDestination(destination));
    setExploreSurface(destination === 'grounding' ? 'concept-grounding' : 'map');
    const section = progressSectionForDestination(destination);
    setProgressSection(section);
    setProgressIntent(
      destination.startsWith('progress-')
        ? { requestId: navigationIntent.requestId, section }
        : null,
    );
    if (destination === 'knowledge-map') {
      setKnowledgeMapIntent({
        requestId: ++mapIntentSequence.current,
        mode: 'knowledge_structure',
      });
    }
  }, [navigationIntent]);

  useEffect(() => {
    if (applyingNavigationIntentRef.current !== null) return;
    let destination: CourseDestination;
    if (settingsOpen) destination = 'settings';
    else if (materialsOpen) destination = 'materials';
    else if (assessmentOpen) destination = 'assessment';
    else if (view === 'explore' && exploreSurface === 'concept-grounding')
      destination = 'grounding';
    else if (view === 'session') destination = 'study';
    else if (view === 'curriculum') destination = 'curriculum';
    else if (view === 'explore') destination = 'knowledge-map';
    else if (view === 'progress') destination = destinationForProgressSection(progressSection);
    else destination = 'home';
    onDestinationChange?.(destination);
  }, [
    assessmentOpen,
    exploreSurface,
    materialsOpen,
    onDestinationChange,
    progressSection,
    settingsOpen,
    view,
  ]);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    setRouteGenerationFailure(readRouteGenerationFailure(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    cancelAction();
    cancelPreparationAction();
    cancelPlanAction();
    cancelProgressRemediationAction();
    cancelCourseLifecycleAction();
    clearActionError();
    clearPreparationError();
    clearPlanError();
    clearProgressRemediationError();
    clearCourseLifecycleError();
    setActionFailureOwner(null);
    setCourseLifecycleOperation(null);
    setBusyAction(null);
  }, [
    cancelAction,
    cancelCourseLifecycleAction,
    cancelPlanAction,
    cancelPreparationAction,
    cancelProgressRemediationAction,
    clearActionError,
    clearCourseLifecycleError,
    clearPlanError,
    clearPreparationError,
    clearProgressRemediationError,
    workspaceId,
  ]);

  useEffect(() => {
    if (view !== 'curriculum' || !workspaceId || documents.length === 0) {
      setCurriculumSourceBlocks([]);
      setCurriculumSourceError(null);
      setCurriculumSourceLoading(false);
      return;
    }
    const controller = new AbortController();
    setCurriculumSourceLoading(true);
    setCurriculumSourceError(null);
    void Promise.all(documents.map((document) => api.getMaterial(document.id, controller.signal)))
      .then((materials) => {
        if (!controller.signal.aborted) {
          setCurriculumSourceBlocks(materials.flatMap((material) => material.blocks));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCurriculumSourceError(error instanceof Error ? error.message : String(error));
          setCurriculumSourceBlocks([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCurriculumSourceLoading(false);
      });
    return () => controller.abort();
  }, [documents, view, workspaceId]);

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
          setPreparation(null);
          setHierarchy(null);
          setRoleHistory({});
          return;
        }
        if (!listed.workspaces.some((workspace) => workspace.id === targetWorkspaceId)) {
          onWorkspaceChange(null);
          setDocuments([]);
          setOverview(null);
          setPreparation(null);
          setHierarchy(null);
          setRoleHistory({});
          return;
        }
        const [detail, execution, preparationResponse] = await Promise.all([
          api.getWorkspace(targetWorkspaceId, signal),
          api.courseExecution(targetWorkspaceId, signal),
          api.coursePreparation(targetWorkspaceId, signal),
        ]);
        const roles = await Promise.all(
          detail.documents.map((document) =>
            api.materialRoleHistory(targetWorkspaceId, document.id, signal),
          ),
        );
        if (signal.aborted || epoch !== loadEpoch.current) return;
        setDocuments(detail.documents);
        setOverview(execution.overview);
        setPreparation(preparationResponse.preparation);
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
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return;
    const [execution, preparationResponse] = await Promise.all([
      api.courseExecution(targetWorkspaceId, signal),
      api.coursePreparation(targetWorkspaceId, signal),
    ]);
    if (signal?.aborted || workspaceIdRef.current !== targetWorkspaceId) return;
    setOverview(execution.overview);
    setPreparation(preparationResponse.preparation);
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
    setActionFailureOwner('course-create');
    const created = await action.run((signal) => api.createWorkspace({ name }, signal));
    setBusyAction(null);
    if (!created) return;
    setNewCourseName('');
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setView('home');
    onWorkspaceChange(created.workspace.id);
  }

  async function createCourseFromSettings(name: string): Promise<boolean> {
    setCourseLifecycleOperation('create');
    const created = await courseLifecycleAction.run((signal) =>
      api.createWorkspace({ name }, signal),
    );
    if (!created) return false;
    setWorkspaces((current) => [
      {
        ...created.workspace,
        documentCount: 0,
        conceptCount: 0,
      },
      ...current.filter((course) => course.id !== created.workspace.id),
    ]);
    onWorkspaceChange(created.workspace.id);
    return true;
  }

  async function renameCourseFromSettings(courseId: string, name: string): Promise<boolean> {
    setCourseLifecycleOperation('rename');
    const renamed = await courseLifecycleAction.run((signal) =>
      api.renameWorkspace(courseId, name, signal),
    );
    if (!renamed || workspaceIdRef.current !== courseId) return false;
    setWorkspaces((current) =>
      current.map((course) =>
        course.id === courseId ? { ...course, ...renamed.workspace } : course,
      ),
    );
    return true;
  }

  async function deleteCourseFromSettings(courseId: string): Promise<boolean> {
    if (courseLifecycleAction.loading) return false;
    action.cancel();
    preparationAction.cancel();
    planAction.cancel();
    progressRemediationAction.cancel();
    action.clearError();
    preparationAction.clearError();
    planAction.clearError();
    progressRemediationAction.clearError();
    setActionFailureOwner(null);
    setBusyAction(null);
    setCourseLifecycleOperation('delete');

    const deleted = await courseLifecycleAction.run(async (signal) => {
      try {
        await api.deleteWorkspace(courseId, signal);
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) return true;
        throw error;
      }
      return true;
    });
    if (!deleted || workspaceIdRef.current !== courseId) return false;

    loadEpoch.current += 1;
    workspaceIdRef.current = null;
    clearStoredRouteGenerationFailure(courseId);
    setWorkspaces((current) => current.filter((course) => course.id !== courseId));
    setDocuments([]);
    setOverview(null);
    setPreparation(null);
    setHierarchy(null);
    setRoleHistory({});
    setCurriculumSourceBlocks([]);
    setRouteGenerationFailure(null);
    setNotice(null);
    setLaunchedQuiz(null);
    onWorkspaceDeleted?.(courseId);
    return true;
  }

  async function remediateMaterial(materialId: string): Promise<void> {
    const capturedWorkspaceId = workspaceId;
    const response = await progressRemediationAction.run((signal) =>
      api.remediation(materialId, signal),
    );
    if (!response || capturedWorkspaceId !== workspaceIdRef.current) return;
    openAssessment(response.quiz);
  }

  async function runAction<T>(
    name: string,
    failureOwner: ActionFailureOwner,
    operation: (signal: AbortSignal) => Promise<T>,
    after?: (result: T, signal: AbortSignal) => Promise<void> | void,
  ): Promise<T | null> {
    const capturedWorkspaceId = workspaceId;
    setBusyAction(name);
    setActionFailureOwner(failureOwner);
    setNotice(null);
    const result = await action.run(async (signal) => {
      const result = await operation(signal);
      if (capturedWorkspaceId === workspaceIdRef.current) await after?.(result, signal);
      return result;
    });
    if (capturedWorkspaceId === workspaceIdRef.current) setBusyAction(null);
    return result;
  }

  async function runPreparation(starting?: CoursePreparation): Promise<void> {
    const capturedWorkspaceId = workspaceIdRef.current;
    if (!capturedWorkspaceId) return;
    setBusyAction('prepare-course');
    setNotice(null);
    const response = await preparationAction.run(async (signal) => {
      const snapshot =
        starting ?? (await api.coursePreparation(capturedWorkspaceId, signal)).preparation;
      if (signal.aborted || workspaceIdRef.current !== capturedWorkspaceId) {
        return null;
      }
      setPreparation(snapshot);
      if (
        snapshot.workspaceId !== capturedWorkspaceId ||
        !snapshot.canResume ||
        !snapshot.operationKey
      ) {
        return { preparation: snapshot };
      }
      try {
        const current = await api.runCoursePreparation(
          capturedWorkspaceId,
          {
            command: {
              commandId: snapshot.operationKey!,
              idempotencyKey: snapshot.operationKey!,
              workspaceId: capturedWorkspaceId,
              actor: 'learner',
            },
            expectedRevision: snapshot.revision,
          },
          signal,
        );
        return current;
      } catch (error) {
        if (!signal.aborted && workspaceIdRef.current === capturedWorkspaceId) {
          try {
            const current = await api.coursePreparation(capturedWorkspaceId, signal);
            if (!signal.aborted && workspaceIdRef.current === capturedWorkspaceId) {
              setPreparation(current.preparation);
            }
          } catch {
            // Keep the original preparation error; the next Course refresh will reconcile state.
          }
        }
        throw error;
      }
    });
    if (workspaceIdRef.current !== capturedWorkspaceId) return;
    setBusyAction(null);
    if (!response) {
      try {
        await refresh();
      } catch {
        // The next Course refresh will reconcile an unavailable cancellation status.
      }
      return;
    }
    setPreparation(response.preparation);
    await refresh();
  }

  function cancelPreparation(): void {
    preparationAction.cancel();
    setBusyAction(null);
    setNotice('已停止本次课程准备，已经验证并保存的内容会保留。');
  }

  function openContractEditor(contract: LearningContract | null): void {
    action.clearError();
    setActionFailureOwner(null);
    setEditingContractId(contract?.status === 'draft' ? contract.id : null);
    setContractForm(initialForm(contract));
    const existingByMaterial = new Map(
      contract?.courseScope.materials.map((scope) => [scope.materialId, scope]) ?? [],
    );
    setMaterialChoices(
      Object.fromEntries(
        documents.map((document) => {
          const scoped = existingByMaterial.get(document.id);
          const history = roleHistory[document.id];
          const latestConfirmed = [...(history?.history ?? [])]
            .reverse()
            .find(
              (assignment) =>
                (assignment.status === 'learner_confirmed' || assignment.status === 'superseded') &&
                assignment.learnerConfirmedAt !== null &&
                assignment.role !== 'unknown' &&
                assignment.role !== 'excluded',
            );
          const persistedRole =
            latestConfirmed &&
            latestConfirmed.role !== 'unknown' &&
            latestConfirmed.role !== 'excluded'
              ? latestConfirmed.role
              : '';
          return [
            document.id,
            {
              role: persistedRole || scoped?.role || 'course_material',
              disposition: 'included',
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

  function contractFields(
    scopes: ContractCourseScope['materials'],
  ): CreateLearningContractDraftRequest['fields'] {
    return {
      intent: SYSTEM_COURSE_INTENT,
      targetOutcome: {
        description: SYSTEM_COURSE_OUTCOME,
        targetScore: null,
        credential: null,
      },
      desiredDepth: contractForm.desiredDepth,
      focusRequest: contractForm.focusRequest.trim() || null,
      courseScope: {
        subjectBoundaries: [SYSTEM_SUBJECT_BOUNDARY],
        materials: scopes,
        includedTopics: [],
        excludedTopics: [],
      },
      learnerSelfReport: null,
      examContext: null,
      riskTolerance: {
        description: null,
        allowExplicitDeferral: false,
        maximumUnresolvedPriority: null,
      },
    };
  }

  async function submitContract(): Promise<void> {
    if (!workspaceId || !overview) return;
    const result = await runAction(
      'save-contract',
      'contract-editor',
      async (signal) => {
        const authoritative = (await api.courseExecution(workspaceId, signal)).overview;
        if (signal.aborted || workspaceId !== workspaceIdRef.current) {
          throw new ApiClientError('ABORTED', '请求已取消。');
        }
        setOverview(authoritative);
        setHierarchy(authoritative.curriculumHierarchy);
        const openedPredecessorId = overview.contractHistory.at(-1)?.id ?? null;
        const currentPredecessorId = authoritative.contractHistory.at(-1)?.id ?? null;
        if (!editingContractId && openedPredecessorId !== currentPredecessorId) {
          if (authoritative.pendingContract?.status === 'draft') {
            setEditingContractId(authoritative.pendingContract.id);
          }
          throw new Error('课程设置状态已更新，请检查当前设置后再保存。');
        }
        const scopes = await ensureConfirmedRoles(signal);
        const fields = contractFields(scopes);
        let saved;
        if (editingContractId) {
          const editing = authoritative.pendingContract;
          if (!editing || editing.id !== editingContractId) throw new Error('约定草稿已过期。');
          saved = await api.updateLearningContract(
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
        } else {
          const latestContractId = authoritative.contractHistory.at(-1)?.id ?? null;
          try {
            saved = await api.createLearningContract(
              workspaceId,
              {
                command: command(workspaceId, 'create_contract'),
                fields,
                predecessorContractId: latestContractId,
                expectedActiveContractId: authoritative.activeContract?.id ?? null,
              },
              signal,
            );
          } catch (error) {
            if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
              throw new Error('课程设置状态已更新，请检查当前设置后再保存。');
            }
            throw error;
          }
        }
        const proposed = await api.transitionLearningContract(
          workspaceId,
          saved.contract.id,
          {
            command: command(workspaceId, 'propose_contract'),
            contractId: saved.contract.id,
            expectedVersion: saved.contract.version,
            transition: 'propose',
          },
          signal,
        );
        return api.transitionLearningContract(
          workspaceId,
          proposed.contract.id,
          {
            command: command(workspaceId, 'confirm_contract'),
            contractId: proposed.contract.id,
            expectedVersion: proposed.contract.version,
            transition: 'confirm',
          },
          signal,
        );
      },
      async (_result, signal) => {
        setContractEditorOpen(false);
        await refresh(signal);
      },
    );
    if (result?.contract.status === 'learner_confirmed') await runPreparation();
  }

  async function transitionContract(): Promise<void> {
    if (!workspaceId || !overview?.pendingContract) return;
    const current = overview.pendingContract;
    if (current.status !== 'draft' && current.status !== 'proposed') return;
    const result = await runAction(
      'confirm-contract',
      'home-contract',
      async (signal) => {
        const proposed =
          current.status === 'draft'
            ? await api.transitionLearningContract(
                workspaceId,
                current.id,
                {
                  command: command(workspaceId, 'propose_contract'),
                  contractId: current.id,
                  expectedVersion: current.version,
                  transition: 'propose',
                },
                signal,
              )
            : { contract: current };
        return api.transitionLearningContract(
          workspaceId,
          proposed.contract.id,
          {
            command: command(workspaceId, 'confirm_contract'),
            contractId: proposed.contract.id,
            expectedVersion: proposed.contract.version,
            transition: 'confirm',
          },
          signal,
        );
      },
      async (_result, signal) => refresh(signal),
    );
    if (result?.contract.status === 'learner_confirmed') await runPreparation();
  }

  async function proposeCurriculum(): Promise<void> {
    if (!workspaceId || !overview) return;
    const contract = overview.pendingContract ?? overview.activeContract;
    if (!contract) return;
    await runAction(
      'propose-curriculum',
      view === 'home' ? 'home-curriculum' : 'curriculum',
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

  function cancelCurriculum(): void {
    action.cancel();
    setBusyAction(null);
    setActionFailureOwner(null);
    setNotice('已停止本次课程结构生成，当前课程结构没有改变。');
  }

  async function decideCurriculum(decision: 'accept' | 'reject'): Promise<void> {
    if (!workspaceId || !overview?.proposedCurriculum) return;
    const capturedWorkspaceId = workspaceId;
    const curriculum = overview.proposedCurriculum;
    const result = await runAction(
      `${decision}-curriculum`,
      'curriculum',
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
    if (
      decision === 'accept' &&
      result?.curriculum.status === 'accepted' &&
      workspaceIdRef.current === capturedWorkspaceId
    ) {
      await runPreparation();
    }
  }

  async function editCurriculum(edit: CurriculumDraftEdit): Promise<void> {
    if (!workspaceId || !overview?.proposedCurriculum) return;
    const current = overview.proposedCurriculum;
    await runAction(
      'edit-curriculum',
      'curriculum',
      (signal) =>
        api.editCurriculum(
          workspaceId,
          current.id,
          {
            command: command(workspaceId, 'edit_curriculum'),
            curriculumId: current.id,
            expectedVersion: current.version,
            expectedContractId: current.contractVersionId,
            expectedExecutionSourceManifestFingerprint: current.executionSourceManifest.fingerprint,
            edit,
          },
          signal,
        ),
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
    const capturedWorkspaceId = workspaceId;
    clearStoredRouteGenerationFailure(capturedWorkspaceId);
    setRouteGenerationFailure(null);
    setBusyAction('propose-plan');
    setNotice(null);
    const result = await planAction.run(async (signal) => {
      try {
        const response = await api.proposeStudyPlan(
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
        );
        if (capturedWorkspaceId === workspaceIdRef.current) {
          setStudyPlanPlannability(response.plannability ?? []);
          await refresh(signal);
        }
        return response;
      } catch (error) {
        if (
          !signal.aborted &&
          capturedWorkspaceId === workspaceIdRef.current &&
          !(error instanceof ApiClientError && error.code === 'ABORTED')
        ) {
          const failure: RouteGenerationFailure = {
            workspaceId: capturedWorkspaceId,
            kind:
              error instanceof ApiClientError && error.code === 'PROVIDER_TIMEOUT'
                ? 'timeout'
                : 'provider',
            detail: error instanceof Error ? error.message : String(error),
          };
          setRouteGenerationFailure(failure);
          storeRouteGenerationFailure(failure);
        }
        throw error;
      }
    });
    if (capturedWorkspaceId === workspaceIdRef.current) {
      setBusyAction(null);
      if (result) {
        clearStoredRouteGenerationFailure(capturedWorkspaceId);
        setRouteGenerationFailure(null);
      }
    }
  }

  async function editPlan(edit: StudyPlanDraftEdit): Promise<void> {
    if (!workspaceId || !overview?.proposedStudyPlan) return;
    const current = overview.proposedStudyPlan;
    const capturedWorkspaceId = workspaceId;
    await runAction(
      'edit-plan',
      view === 'progress' ? 'progress' : 'home-plan',
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
      async (result, signal) => {
        // Recomputed for the successor version, so a repair that worked visibly clears.
        if (capturedWorkspaceId === workspaceIdRef.current) {
          setStudyPlanPlannability(result.plannability ?? []);
        }
        await refresh(signal);
      },
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
    const capturedWorkspaceId = workspaceId;
    await runAction(
      `${decision}-plan`,
      view === 'progress' ? 'progress' : 'home-plan',
      async (signal) => {
        try {
          return await api.decideStudyPlan(
            workspaceId,
            current.id,
            {
              command: command(workspaceId, `${decision}_plan`),
              studyPlanId: current.id,
              expectedVersion: current.version,
              expectedContractId: current.contractVersionId,
              expectedCurriculumId: current.curriculumVersionId,
              expectedExecutionSourceManifestFingerprint:
                current.executionSourceManifestFingerprint,
              decision,
              reason: reason ?? null,
            },
            signal,
          );
        } catch (error) {
          // A refused acceptance leaves the proposal editable; surface why, per item.
          if (capturedWorkspaceId === workspaceIdRef.current) {
            setStudyPlanPlannability(readPlannabilityFromError(error));
          }
          throw error;
        }
      },
      async (_result, signal) => {
        if (capturedWorkspaceId === workspaceIdRef.current) setStudyPlanPlannability([]);
        await refresh(signal);
      },
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
      'home-continue',
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
        if (result.kind === 'assessment') openAssessment(result.quiz);
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
      'curriculum',
      (signal) => api.curriculum(workspaceId, curriculumId, signal),
      (result) => {
        setHierarchy(result.hierarchy);
      },
    );
  }

  function changeView(next: AgentCourseView): void {
    if (actionFailureOwner === 'contract-editor') {
      action.cancel();
      action.clearError();
      setActionFailureOwner(null);
    }
    setNotice(null);
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setAssessmentOpen(false);
    setContractEditorOpen(false);
    setEditingContractId(null);
    if (next === 'explore') setExploreSurface('map');
    if (next !== 'progress') setProgressIntent(null);
    setView(next);
  }

  function openAssessment(quiz: PublicQuiz | null = null): void {
    setNotice(null);
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setContractEditorOpen(false);
    setEditingContractId(null);
    setLaunchedQuiz(quiz);
    setAssessmentOpen(true);
    setView('progress');
  }

  function openConceptGrounding(): void {
    changeView('explore');
    setExploreSurface('concept-grounding');
  }

  function openKnowledgeMap(
    mode: KnowledgeMapMode,
    focus: Pick<KnowledgeMapIntent, 'nodeId' | 'learningUnitId' | 'objectiveId'> = {},
  ): void {
    mapIntentSequence.current += 1;
    setKnowledgeMapIntent({ requestId: mapIntentSequence.current, mode, ...focus });
    changeView('explore');
  }

  function navigateFromKnowledgeMap(target: KnowledgeMapNavigationTarget): void {
    if (target.destination === 'materials') {
      setFocusedMaterialId(target.materialId);
      setSettingsOpen(false);
      setMaterialsOpen(true);
      return;
    }
    if (target.destination === 'curriculum') {
      changeView('curriculum');
      return;
    }
    if (target.destination === 'study') {
      changeView('session');
      return;
    }
    progressIntentSequence.current += 1;
    setProgressIntent({
      requestId: progressIntentSequence.current,
      section: target.repairEpisodeId ? 'repair' : target.reviewTargetId ? 'mastery' : 'evidence',
      learningUnitId: target.learningUnitId,
      objectiveId: target.objectiveId,
      repairEpisodeId: target.repairEpisodeId,
      reviewTargetId: target.reviewTargetId,
    });
    changeView('progress');
  }

  function changeCourse(nextWorkspaceId: string | null): void {
    action.cancel();
    preparationAction.cancel();
    planAction.cancel();
    progressRemediationAction.cancel();
    courseLifecycleAction.cancel();
    action.clearError();
    preparationAction.clearError();
    courseLifecycleAction.clearError();
    setActionFailureOwner(null);
    setCourseLifecycleOperation(null);
    clearStoredRouteGenerationFailure(workspaceIdRef.current);
    clearStoredRouteGenerationFailure(nextWorkspaceId);
    setRouteGenerationFailure(null);
    setPreparation(null);
    setBusyAction(null);
    setNotice(null);
    setMaterialsOpen(false);
    setSettingsOpen(false);
    setAssessmentOpen(false);
    setLaunchedQuiz(null);
    setContractEditorOpen(false);
    setEditingContractId(null);
    setExploreSurface('map');
    setKnowledgeMapIntent({
      requestId: ++mapIntentSequence.current,
      mode: 'knowledge_structure',
    });
    setProgressIntent(null);
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
      destinationLabel={
        assessmentOpen
          ? '手动评估'
          : view === 'explore' && exploreSurface === 'concept-grounding'
            ? '课程概念依据'
            : undefined
      }
      destinationDescription={
        assessmentOpen
          ? '高级出题、当前评估与旧活动兼容'
          : view === 'explore' && exploreSurface === 'concept-grounding'
            ? '概念提取、关系验证、对齐与版本审计'
            : undefined
      }
      provider={provider}
      sidebarCollapsed={sidebarCollapsed}
      onCourseChange={changeCourse}
      onViewChange={changeView}
      onOpenMaterials={() => {
        setNotice(null);
        setFocusedMaterialId(null);
        setSettingsOpen(false);
        setAssessmentOpen(false);
        setMaterialsOpen(true);
      }}
      onOpenSettings={() => {
        setNotice(null);
        setMaterialsOpen(false);
        setAssessmentOpen(false);
        setSettingsOpen(true);
      }}
      onSidebarCollapsedChange={setSidebarCollapsed}
      notifications={notice ? <Banner kind="info">{notice}</Banner> : null}
    >
      {settingsOpen ? (
        <SettingsView
          provider={provider}
          onProviderChange={onProviderChange}
          currentCourseId={workspaceId}
          currentCourseName={selectedWorkspace?.name ?? null}
          courses={workspaces}
          courseLifecycleLoading={courseLifecycleAction.loading}
          courseLifecycleError={courseLifecycleAction.error}
          courseLifecycleOperation={courseLifecycleOperation}
          onCreateCourse={createCourseFromSettings}
          onRenameCourse={renameCourseFromSettings}
          onDeleteCourse={deleteCourseFromSettings}
          onClearCourseLifecycleError={courseLifecycleAction.clearError}
          sidebarDefaultCollapsed={sidebarCollapsed}
          onSidebarDefaultCollapsedChange={setSidebarCollapsed}
        />
      ) : !workspaceId ? (
        loading ? (
          <Loading label="加载课程…" />
        ) : (
          <section className="no-course-state" aria-label="选择或创建课程">
            <header className="course-library-intro">
              <img
                className="studio-artwork"
                src="/brand/paper-study.webp"
                width="1152"
                height="768"
                alt=""
              />
              <p className="eyebrow">你的学习工作室</p>
              <h2>
                把不懂的地方，
                <br />
                <em>一步步学明白。</em>
              </h2>
              <p className="muted">
                从你的资料出发，串起讲解、练习与反馈。每次回来，都从上次停下的地方继续。
              </p>
            </header>
            {workspaces.length > 0 ? (
              <section className="course-library" aria-label="已有课程">
                <div className="course-library-heading">
                  <h3>我的课程</h3>
                  <span>{workspaces.length} 门课程</span>
                </div>
                <div className="course-library-grid">
                  {workspaces.map((course, index) => (
                    <button
                      key={course.id}
                      type="button"
                      className="course-library-card"
                      onClick={() => changeCourse(course.id)}
                    >
                      <span className="course-library-number" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <strong>{course.name}</strong>
                      <span className="course-library-open">
                        进入课程 <span aria-hidden="true">↗</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="course-create-heading">
              <h3>开始一门新课程</h3>
              <p>给它起个名字，再带上你想学的资料。</p>
            </div>
            {actionFailureOwner === 'course-create' && action.error ? (
              <Banner kind="error">课程暂未创建。{action.error}</Banner>
            ) : null}
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
          focusDocumentId={focusedMaterialId}
          onChanged={refreshCourse}
          onBack={() => {
            setFocusedMaterialId(null);
            setMaterialsOpen(false);
          }}
        />
      ) : assessmentOpen ? (
        <CourseAssessmentView
          workspaceId={workspaceId}
          documents={documents}
          launchedQuiz={launchedQuiz}
          onChanged={() => {
            setAssessmentRevision((revision) => revision + 1);
            void refresh();
          }}
          onBack={() => {
            setLaunchedQuiz(null);
            setAssessmentOpen(false);
            setProgressSection('overview');
            setProgressIntent(null);
            setView('progress');
          }}
        />
      ) : contractEditorOpen && overview ? (
        <div className="stack">
          {actionFailureOwner === 'contract-editor' && action.error ? (
            <Banner kind="error">{action.error}</Banner>
          ) : null}
          <ContractEditor
            documents={documents}
            form={contractForm}
            busy={busyAction !== null}
            onFormChange={setContractForm}
            onSubmit={() => void submitContract()}
            onCancel={() => setContractEditorOpen(false)}
          />
        </div>
      ) : view === 'home' ? (
        <CourseHomeView
          courseName={selectedWorkspace?.name ?? '课程'}
          overview={overview}
          preparation={preparation}
          preparationError={preparationAction.error}
          loading={loading}
          error={loadError}
          busyAction={busyAction}
          routeGenerationFailure={routeGenerationFailure}
          actionFailure={
            action.error && actionFailureOwner?.startsWith('home-')
              ? {
                  owner: actionFailureOwner.slice(5) as
                    'contract' | 'curriculum' | 'plan' | 'continue',
                  message: action.error,
                  details: action.errorDetails,
                }
              : null
          }
          onCreateContract={() =>
            openContractEditor(overview?.pendingContract ?? overview?.activeContract ?? null)
          }
          onEditContract={() => openContractEditor(overview?.pendingContract ?? null)}
          onConfirmContract={() => void transitionContract()}
          onRunPreparation={() => void runPreparation()}
          onCancelPreparation={cancelPreparation}
          onProposeCurriculum={() => void proposeCurriculum()}
          onCancelCurriculum={cancelCurriculum}
          onOpenCurriculum={() => setView('curriculum')}
          onOpenConceptGrounding={openConceptGrounding}
          onOpenKnowledgeMap={() => openKnowledgeMap('knowledge_structure')}
          onProposeStudyPlan={() => void proposePlan()}
          onDismissRouteGenerationFailure={() => {
            clearStoredRouteGenerationFailure(workspaceId);
            setRouteGenerationFailure(null);
          }}
          onOpenSettings={() => {
            setMaterialsOpen(false);
            setSettingsOpen(true);
          }}
          onEditStudyPlan={(edit) => void editPlan(edit)}
          studyPlanPlannability={studyPlanPlannability}
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
          error={actionFailureOwner === 'curriculum' ? (action.error ?? loadError) : loadError}
          errorDetails={actionFailureOwner === 'curriculum' ? action.errorDetails : null}
          canPropose={
            (overview?.capabilities.canProposeCurriculum ?? false) &&
            !(
              preparation?.canResume ||
              preparation?.state === 'preparing_course_structure' ||
              preparation?.blocker?.code === 'course_structure_generation_failed'
            )
          }
          canAccept={overview?.capabilities.canAcceptCurriculum ?? false}
          recovery={overview?.curriculumRecovery}
          busyAction={busyAction}
          onPropose={() => void proposeCurriculum()}
          onOpenConceptGrounding={openConceptGrounding}
          onCancel={cancelCurriculum}
          onAccept={() => void decideCurriculum('accept')}
          onReject={() => void decideCurriculum('reject')}
          onEdit={(edit) => void editCurriculum(edit)}
          onSelectHistory={(id) => void selectCurriculumHistory(id)}
          documents={documents}
          sourceBlocks={curriculumSourceBlocks}
          sourceLoading={curriculumSourceLoading}
          sourceError={curriculumSourceError}
          onOpenSource={(materialId) => {
            setFocusedMaterialId(materialId);
            setMaterialsOpen(true);
          }}
        />
      ) : view === 'session' ? (
        <StudySessionView
          workspaceId={workspaceId}
          courseName={selectedWorkspace?.name ?? '课程'}
          formalReadiness={preparation?.formalReadiness ?? null}
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
          onLaunchQuiz={(quiz) => openAssessment(quiz)}
          onOpenKnowledgeMap={(learningUnitId) =>
            openKnowledgeMap('learning_route', { learningUnitId })
          }
        />
      ) : view === 'progress' ? (
        <CourseProgressView
          workspaceId={workspaceId}
          documents={documents}
          overview={overview}
          refreshKey={refreshKey + assessmentRevision}
          command={(prefix) => command(workspaceId, prefix)}
          onAcceptProposedPlan={() => void decidePlan('accept')}
          onRejectProposedPlan={() => void decidePlan('reject')}
          onCourseChanged={() => void refresh()}
          onRemediate={(materialId) => void remediateMaterial(materialId)}
          remediationLoading={progressRemediationAction.loading}
          remediationError={progressRemediationAction.error}
          operationError={actionFailureOwner === 'progress' ? action.error : null}
          intent={progressIntent}
          onSectionChange={setProgressSection}
          onOpenAssessment={() => openAssessment()}
          onOpenKnowledgeMap={() => openKnowledgeMap('weakness_map')}
        />
      ) : exploreSurface === 'concept-grounding' ? (
        <div className="legacy-grounding-bridge">
          <div className="legacy-grounding-bridge-head">
            <div>
              <p className="eyebrow">课程准备工具</p>
              <strong>补充课程概念依据</strong>
            </div>
            <button type="button" onClick={() => openKnowledgeMap('knowledge_structure')}>
              返回知识地图
            </button>
          </div>
          <GraphWorkspaceView
            refreshKey={refreshKey}
            selectedWorkspaceId={workspaceId}
            onWorkspaceSelected={(nextWorkspaceId) => {
              if (nextWorkspaceId !== workspaceId) changeCourse(nextWorkspaceId);
            }}
            onWorkspaceDeleted={(deletedWorkspaceId) => {
              clearStoredRouteGenerationFailure(deletedWorkspaceId);
              if (routeGenerationFailure?.workspaceId === deletedWorkspaceId) {
                setRouteGenerationFailure(null);
              }
              onWorkspaceDeleted?.(deletedWorkspaceId);
            }}
            onLaunchQuiz={(quiz) => openAssessment(quiz)}
            onOpenMaterials={() => {
              setView('home');
              setMaterialsOpen(true);
            }}
            onConceptGroundingChanged={(changedWorkspaceId) => {
              if (changedWorkspaceId === workspaceIdRef.current) void refreshCourse();
            }}
            courseLocked
          />
        </div>
      ) : (
        <KnowledgeMapView
          workspaceId={workspaceId}
          refreshKey={refreshKey}
          intent={knowledgeMapIntent}
          onNavigate={navigateFromKnowledgeMap}
        />
      )}
    </AgentCourseShell>
  );
}

interface ContractEditorProps {
  documents: DocumentSummary[];
  form: ContractFormState;
  busy: boolean;
  onFormChange: (value: ContractFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function ContractEditor({
  documents,
  form,
  busy,
  onFormChange,
  onSubmit,
  onCancel,
}: ContractEditorProps) {
  const change = <K extends keyof ContractFormState>(key: K, value: ContractFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  return (
    <form
      className="contract-editor stack"
      aria-label="课程设计设置"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header className="contract-header row between">
        <div className="contract-heading">
          <p className="eyebrow">创建课程</p>
          <h2>准备 Hy3 Study Clinic 课程</h2>
          <p className="muted">
            资料决定学什么，全局深度决定整体教多深；你也可以指定特别想深入的内容。
          </p>
        </div>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          返回
        </button>
      </header>

      <div className="contract-flow">
        <fieldset className="contract-question contract-materials">
          <legend>
            <span>1</span>
            课程资料
          </legend>
          <p className="contract-question-hint">当前课程中的资料都会用于确定课程主题。</p>
          {documents.length === 0 ? (
            <Banner kind="info">请先添加至少一份课程资料。</Banner>
          ) : (
            <ul className="material-scope-list" aria-label="本课程资料">
              {documents.map((document) => (
                <li key={document.id} className="material-scope-row">
                  <strong>{document.title}</strong>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>2</span>
            全局学习深度
          </legend>
          <p className="contract-question-hint">这个选择是整门课程的教学基线，Hy3 不会替你改写。</p>
          <label>
            全局学习深度
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
        </fieldset>

        <fieldset className="contract-question">
          <legend>
            <span>3</span>
            有没有特别想深入的内容？（可选）
          </legend>
          <p className="contract-question-hint">
            例如：Embedding、向量检索、Rerank。留空则均衡安排。
          </p>
          <label>
            特别关注的内容（可选）
            <textarea
              value={form.focusRequest}
              maxLength={500}
              placeholder="例如：Embedding、向量检索、Rerank"
              onChange={(event) => change('focusRequest', event.target.value)}
            />
          </label>
        </fieldset>
      </div>

      <footer className="contract-actions">
        <p className="small muted">开始后，Hy3 会先提出课程结构供你审阅；此时不会自动接受。</p>
        <button type="submit" className="primary" disabled={busy || documents.length === 0}>
          {busy ? '正在准备…' : '开始准备课程'}
        </button>
      </footer>
    </form>
  );
}
