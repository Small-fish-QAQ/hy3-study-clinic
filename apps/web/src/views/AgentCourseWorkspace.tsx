import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContractCourseScope,
  CourseExecutionCommandEnvelope,
  CourseExecutionOverview,
  CoursePreparation,
  CurriculumHierarchyView,
  DesiredDepth,
  DocumentSummary,
  LearningContract,
  LearningContractDraftFields,
  MaterialRole,
  MaterialRoleAssignment,
  MaterialRoleHistoryResponse,
  KnowledgeMapMode,
  PublicQuiz,
  SourceBlock,
  StudyPlanDraftEdit,
  WorkspaceSummary,
} from '@hy3-clinic/shared';
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
  refreshKey: number;
  provider?: 'fake' | 'hy3' | null;
  onProviderChange?: (provider: 'fake' | 'hy3') => void;
  navigationIntent?: { requestId: number; destination: CourseDestination };
  onDestinationChange?: (destination: CourseDestination) => void;
  onWorkspaceDeleted?: (workspaceId: string) => void;
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
        return await api.runCoursePreparation(
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
              role: persistedRole || scoped?.role || '',
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
          throw new Error('学习约定状态已更新，请检查当前约定后再保存。');
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
              throw new Error('学习约定状态已更新，请检查当前约定后再保存。');
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
    setNotice('已停止本次课程结构生成，当前已接受版本没有改变。');
  }

  async function decideCurriculum(decision: 'accept' | 'reject'): Promise<void> {
    if (!workspaceId || !overview?.proposedCurriculum) return;
    const curriculum = overview.proposedCurriculum;
    await runAction(
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
        if (capturedWorkspaceId === workspaceIdRef.current) await refresh(signal);
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
      view === 'progress' ? 'progress' : 'home-plan',
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
            <p className="eyebrow">开始学习</p>
            <h2>选择一门课程</h2>
            <p className="muted">
              课程会保存资料、学习目标、当前路线和正式进展。请从上方选择已有课程，或现在创建一门课程。
            </p>
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
            materialChoices={materialChoices}
            roleHistory={roleHistory}
            busy={busyAction !== null}
            onFormChange={setContractForm}
            onMaterialChoicesChange={setMaterialChoices}
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
          canPropose={overview?.capabilities.canProposeCurriculum ?? false}
          canAccept={overview?.capabilities.canAcceptCurriculum ?? false}
          recovery={overview?.curriculumRecovery}
          busyAction={busyAction}
          onPropose={() => void proposeCurriculum()}
          onOpenConceptGrounding={openConceptGrounding}
          onCancel={cancelCurriculum}
          onAccept={() => void decideCurriculum('accept')}
          onReject={() => void decideCurriculum('reject')}
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
          <p className="muted">从目标开始。范围、时间与资料用途由你确认，Hy3 据此准备课程方案。</p>
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
        <p className="small muted">确认后将立即开始准备课程。</p>
        <button type="submit" className="primary" disabled={busy || documents.length === 0}>
          {busy
            ? '正在确认…'
            : needsRoleConfirmation
              ? '确认资料用途并准备课程'
              : '确认目标并准备课程'}
        </button>
      </footer>
    </form>
  );
}
