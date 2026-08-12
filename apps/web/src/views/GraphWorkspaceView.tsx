import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CanonicalConceptView,
  Concept,
  ConceptLearnerState,
  CreateAssessmentRequest,
  DailyQueueItem,
  DocumentSummary,
  GraphEdge,
  GraphVersion,
  MisconceptionRecord,
  PublicQuiz,
  RemediationPlan,
  ReviewItem,
  SourceBlock,
  TutorRun,
  Workspace,
  WorkspaceSummary,
} from '@hy3-clinic/shared';
import { api, ApiClientError, type DocumentMapping } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { ConceptGraph, RELATION_LABELS as RELATION_TEXT } from '../components/ConceptGraph.js';
import { ConceptDetailPanel, EdgeDetailPanel } from '../components/DetailPanels.js';
import { AlignmentPanel } from '../components/AlignmentPanel.js';
import { DailyQueue } from '../components/DailyQueue.js';
import { ACTIVITY_TEXT, TutorPanel } from '../components/TutorPanel.js';
import { aggregateOverlay, buildCanonicalDisplayGraph } from '../components/graph/canonicalView.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import {
  UPLOAD_ACCEPT,
  UPLOAD_OCR_LIMIT_TEXT,
  fileToBase64,
  uploadValidationError,
} from '../upload.js';

const LAST_WORKSPACE_KEY = 'hy3-clinic:last-workspace-id';

const SOURCE_TYPE_TEXT: Record<string, string> = {
  paste: '粘贴文本',
  md: 'Markdown',
  txt: 'TXT',
  pdf: 'PDF',
  docx: 'DOCX',
};

export interface GraphWorkspaceViewProps {
  /** Launch an assessment quiz produced by a plan (App opens the quiz tab). */
  onLaunchQuiz: (quiz: PublicQuiz, mode: 'remediation' | 'practice' | 'assessment') => void;
  /** Bumped by App after grading so learner overlays refresh. */
  refreshKey: number;
  /**
   * Notified after the server confirmed a course-space deletion, so App can
   * reconcile state that referenced it (open material, assessment context,
   * material history list).
   */
  onWorkspaceDeleted?: (workspaceId: string) => void;
  /** Optional App-owned Course selection shared with Course Home. */
  selectedWorkspaceId?: string | null;
  onWorkspaceSelected?: (workspaceId: string | null) => void;
  /** Course shell already owns selection and navigation. */
  courseLocked?: boolean;
  /** Course-scoped path back to material management when Explore is empty. */
  onOpenMaterials?: () => void;
}

interface WorkspaceData {
  workspace: Workspace;
  documents: DocumentSummary[];
  version: GraphVersion | null;
  edges: GraphEdge[];
  concepts: Concept[];
  blocks: SourceBlock[];
  overlay: ConceptLearnerState[];
  versions: GraphVersion[];
  canonical: CanonicalConceptView[];
  pendingAlignmentCount: number;
  misconceptions: MisconceptionRecord[];
  reviewItems: ReviewItem[];
  queue: DailyQueueItem[];
}

/** One in-flight assessment launch: which surface started it, keyed for UI. */
interface PendingLaunch {
  surface: 'queue' | 'tutor' | 'diagnostic';
  key: string;
}

/**
 * 学习图谱工作台 — the three coordinated areas of the upgraded product:
 * 资料面板(左,可折叠)· 个人学习图谱(中,填满剩余空间)· 检查器(右,可折叠)。
 *
 * Stale-response protection: every workspace-scoped request captures the
 * current epoch; switching or deleting a workspace (or unmounting) bumps the
 * epoch so late responses can never overwrite newer state. Selection-scoped
 * requests (plan fetch/generation) additionally verify the selected concept.
 */
export function GraphWorkspaceView({
  onLaunchQuiz,
  refreshKey,
  onWorkspaceDeleted,
  selectedWorkspaceId,
  onWorkspaceSelected,
  courseLocked = false,
  onOpenMaterials,
}: GraphWorkspaceViewProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [tutorPathIds, setTutorPathIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);

  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  /** Honest note when a Tutor recommendation was adjusted at launch time. */
  const [activityNotice, setActivityNotice] = useState<string | null>(null);
  const [generationSummary, setGenerationSummary] = useState<string | null>(null);
  /** Outcome summary of the latest extraction run (initial or deepen). */
  const [extractionNotice, setExtractionNotice] = useState<string | null>(null);
  /** Document whose 资料映射 disclosure is open, plus its loaded mapping. */
  const [mappingDoc, setMappingDoc] = useState<string | null>(null);
  const [mapping, setMapping] = useState<DocumentMapping | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [deepeningSection, setDeepeningSection] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(courseLocked);
  const [rightCollapsed, setRightCollapsed] = useState(courseLocked);

  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  /** Ref twin of pendingLaunch: duplicate clicks in the same tick see it. */
  const pendingLaunchRef = useRef<PendingLaunch | null>(null);
  /** Ref twin of selectedNodeId for staleness checks after awaits. */
  const selectedNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  const createAction = useAsyncAction();
  const addDocAction = useAsyncAction();
  const analyzeAction = useAsyncAction();
  const documentAction = useAsyncAction();
  const deleteWorkspaceAction = useAsyncAction();
  const graphAction = useAsyncAction();
  const planAction = useAsyncAction();
  const launchAction = useAsyncAction();
  const assessmentAction = useAsyncAction();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  /**
   * Monotonic id of workspace-list requests: only the LATEST response may
   * update the list, so a slow earlier GET can never resurrect an entry that
   * a later mutation (for example a course-space deletion) already removed.
   */
  const workspacesFetchSeq = useRef(0);

  const loadWorkspaces = useCallback(async () => {
    const epoch = epochRef.current;
    const fetchId = ++workspacesFetchSeq.current;
    const isCurrent = () =>
      mountedRef.current && epochRef.current === epoch && workspacesFetchSeq.current === fetchId;
    setWorkspacesLoading(true);
    setWorkspacesError(null);
    try {
      const result = await api.listWorkspaces();
      if (!isCurrent()) return null;
      setWorkspaces(result.workspaces);
      return result.workspaces;
    } catch (error) {
      if (isCurrent()) {
        setWorkspacesError(errorMessage(error));
      }
      return null;
    } finally {
      if (isCurrent()) setWorkspacesLoading(false);
    }
  }, []);

  /** Load everything the three areas need for one workspace. */
  const loadWorkspaceData = useCallback(
    async (workspaceId: string) => {
      const epoch = epochRef.current;
      setDataLoading(true);
      setDataError(null);
      try {
        const [detail, graph, overlay, versions, alignment, misconceptions, review, queue] =
          await Promise.all([
            api.getWorkspace(workspaceId),
            api.getWorkspaceGraph(workspaceId),
            api.learnerOverlay(workspaceId),
            api.listGraphVersions(workspaceId),
            api.alignmentOverview(workspaceId),
            api.misconceptions(workspaceId),
            api.reviewItems(workspaceId),
            api.dailyQueue(workspaceId),
          ]);
        const blockLists = await Promise.all(
          detail.documents.map((doc) => api.getMaterial(doc.id).then((m) => m.blocks)),
        );
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setData({
          workspace: detail.workspace,
          documents: detail.documents,
          version: graph.version,
          edges: graph.edges,
          concepts: graph.concepts,
          blocks: blockLists.flat(),
          overlay: overlay.states,
          versions: versions.versions,
          canonical: alignment.canonical,
          pendingAlignmentCount: alignment.pendingProposals.length,
          misconceptions: misconceptions.misconceptions,
          reviewItems: review.items,
          queue: queue.items,
        });
      } catch (error) {
        if (!mountedRef.current || epochRef.current !== epoch) return;
        if (error instanceof ApiClientError && error.status === 404) {
          setActiveWorkspaceId(null);
          setData(null);
          void loadWorkspaces();
        } else {
          setDataError(errorMessage(error));
        }
      } finally {
        if (mountedRef.current && epochRef.current === epoch) setDataLoading(false);
      }
    },
    [loadWorkspaces],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string | null) => {
      // Re-clicking the active workspace must not blank it: clearing `data`
      // while activeWorkspaceId stays identical would never re-trigger the
      // load effect, leaving the graph area empty until a full reload.
      if (workspaceId !== null && workspaceId === activeWorkspaceId) return;
      epochRef.current += 1;
      planAction.cancel();
      graphAction.cancel();
      addDocAction.cancel();
      analyzeAction.cancel();
      documentAction.cancel();
      launchAction.cancel();
      assessmentAction.cancel();
      setActiveWorkspaceId(workspaceId);
      onWorkspaceSelected?.(workspaceId);
      setData(null);
      setDataError(null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setPlan(null);
      setActionError(null);
      setActivityNotice(null);
      setGenerationSummary(null);
      setExtractionNotice(null);
      setMappingDoc(null);
      setMapping(null);
      setDeepeningSection(null);
      setAlignmentOpen(false);
      setTutorPathIds(new Set());
      pendingLaunchRef.current = null;
      setPendingLaunch(null);
      if (workspaceId) writeLastWorkspaceId(workspaceId);
    },
    [
      activeWorkspaceId,
      addDocAction.cancel,
      analyzeAction.cancel,
      assessmentAction.cancel,
      documentAction.cancel,
      graphAction.cancel,
      launchAction.cancel,
      onWorkspaceSelected,
      planAction.cancel,
    ],
  );

  /** Initial load + restore last opened workspace. */
  useEffect(() => {
    void (async () => {
      const list = await loadWorkspaces();
      if (!list) return;
      const saved = selectedWorkspaceId === undefined ? readLastWorkspaceId() : selectedWorkspaceId;
      const target = saved && list.some((w) => w.id === saved) ? saved : null;
      if (target) {
        setActiveWorkspaceId(target);
      }
    })();
  }, [loadWorkspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (selectedWorkspaceId === undefined || selectedWorkspaceId === activeWorkspaceId) return;
    switchWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId, activeWorkspaceId, switchWorkspace]);

  /** (Re)load workspace data on switch and after grading refreshes. */
  useEffect(() => {
    if (!activeWorkspaceId) return;
    void loadWorkspaceData(activeWorkspaceId);
  }, [activeWorkspaceId, refreshKey, loadWorkspaceData]);

  /** Selecting a node clears edge selection and loads its accepted plan. */
  const selectNode = useCallback(
    (conceptId: string | null) => {
      setSelectedNodeId(conceptId);
      if (conceptId) setRightCollapsed(false);
      // Synchronous ref update: the staleness guard below must see the newest
      // selection even before React commits the state change.
      selectedNodeIdRef.current = conceptId;
      setSelectedEdgeId(null);
      setPlan(null);
      setActivityNotice(null);
      planAction.cancel();
      planAction.clearError();
      // A Tutor-recommended launch belongs to the concept it was started
      // from; switching concepts cancels it instead of navigating late.
      if (pendingLaunchRef.current?.surface === 'tutor') {
        assessmentAction.cancel();
      }
      if (!conceptId || !activeWorkspaceId) return;
      const epoch = epochRef.current;
      void api
        .getPlan(activeWorkspaceId, conceptId)
        .then((result) => {
          if (!mountedRef.current || epochRef.current !== epoch) return;
          // Late responses may not cross concept selections: only the plan of
          // the concept that is STILL selected may land (a fast A→B switch
          // must never leave A's plan on B's panel).
          if (selectedNodeIdRef.current !== conceptId) return;
          setPlan((current) => current ?? result.plan);
        })
        .catch(() => {
          /* accepted-plan lookup is best-effort; generation reports errors */
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkspaceId],
  );

  const selectEdge = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) setRightCollapsed(false);
    setSelectedNodeId(null);
    setPlan(null);
  }, []);

  async function handleCreateWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) return;
    setActionError(null);
    const result = await createAction.run((signal) => api.createWorkspace({ name }, signal));
    if (!result) return;
    setNewWorkspaceName('');
    await loadWorkspaces();
    switchWorkspace(result.workspace.id);
  }

  /**
   * Delete an entire course space (documents, concepts, graph, quizzes and
   * attempt history, mistakes, mastery, review progress, tutor records — the
   * server cascades all of it). Deleting a document never removes its course
   * space; THIS is the explicit way to retire one. The list/App state is
   * only updated after the server confirmed the deletion; a 404 means it was
   * already gone, which reaches the same goal state.
   */
  async function handleDeleteWorkspace(target: WorkspaceSummary) {
    if (deleteWorkspaceAction.loading) return;
    const scope =
      target.documentCount > 0 || target.conceptCount > 0
        ? `其中的 ${target.documentCount} 个文档、${target.conceptCount} 个概念,以及全部图谱、测验与成绩历史、错题、掌握度、复习进度和辅导记录都会被永久删除。`
        : '该课程空间已没有文档;它的历史测验成绩、复习进度等剩余记录(如有)也会一并删除。';
    if (!window.confirm(`删除课程空间「${target.name}」?\n\n${scope}\n\n此操作无法恢复。`)) {
      return;
    }
    const wasActive = activeWorkspaceId === target.id;
    const result = await deleteWorkspaceAction.run(async (signal) => {
      try {
        await api.deleteWorkspace(target.id, signal);
      } catch (error) {
        // Already deleted (for example in another tab): the goal state is
        // reached, so continue with the local cleanup instead of failing.
        if (error instanceof ApiClientError && error.status === 404) return true;
        throw error;
      }
      return true;
    });
    if (!result) return;

    clearLastWorkspaceId(target.id);
    if (wasActive) switchWorkspace(null);
    const remaining = await loadWorkspaces();
    if (wasActive && remaining && remaining.length > 0) {
      // Fall back to the most recently updated remaining course space.
      switchWorkspace(remaining[0]!.id);
    }
    onWorkspaceDeleted?.(target.id);
  }

  async function handleAddText(content: string, title: string) {
    if (!activeWorkspaceId || !content.trim()) return;
    const workspaceId = activeWorkspaceId;
    const result = await addDocAction.run((signal) =>
      api.addDocument(
        workspaceId,
        { kind: 'text', content, ...(title.trim() ? { title: title.trim() } : {}) },
        signal,
      ),
    );
    if (result && epochRef.current && activeWorkspaceId === workspaceId) {
      await loadWorkspaceData(workspaceId);
      await loadWorkspaces();
    }
  }

  async function handleAddFile(file: File) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const lower = file.name.toLowerCase();
    const isBinary = lower.endsWith('.pdf') || lower.endsWith('.docx');
    const result = await addDocAction.run(async (signal) => {
      // Same pre-flight rules as the material library; the server re-checks.
      const validationError = uploadValidationError(file);
      if (validationError) throw new Error(validationError);
      if (isBinary) {
        const dataBase64 = await fileToBase64(file);
        return api.addDocument(
          workspaceId,
          { kind: 'file', filename: file.name, dataBase64 },
          signal,
        );
      }
      const content = await file.text();
      return api.addDocument(workspaceId, { kind: 'text', content, filename: file.name }, signal);
    });
    if (result && activeWorkspaceId === workspaceId) {
      await loadWorkspaceData(workspaceId);
      await loadWorkspaces();
    }
  }

  async function handleAnalyze(documentId: string, section?: string) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    if (section) setDeepeningSection(section);
    try {
      const result = await analyzeAction.run((signal) => api.analyze(documentId, signal, section));
      if (result && activeWorkspaceId === workspaceId) {
        if (result.extraction) {
          const failed = result.extraction.sections.filter((s) => s.status === 'failed').length;
          setExtractionNotice(
            `本次提取:新增 ${result.extraction.conceptsAdded} 个概念(共 ${result.extraction.conceptTotal} 个)` +
              `${failed > 0 ? `;${failed} 个小节提取失败,可稍后重试` : ''}` +
              `${result.extraction.capReached ? ';已达单文档概念上限,剩余小节未提取' : ''}。`,
          );
        }
        await loadWorkspaceData(workspaceId);
        // The sidebar summaries include a concept count — keep them in step.
        await loadWorkspaces();
        if (mappingDoc === documentId) await loadMapping(documentId);
      }
    } finally {
      if (section) setDeepeningSection(null);
    }
  }

  /** Lazily load the structural mapping of one document (资料映射). */
  async function loadMapping(documentId: string) {
    const epoch = epochRef.current;
    setMappingLoading(true);
    try {
      const mapping = await api.documentMapping(documentId);
      if (mountedRef.current && epochRef.current === epoch) {
        setMappingDoc(documentId);
        setMapping(mapping);
      }
    } catch {
      if (mountedRef.current && epochRef.current === epoch) setMapping(null);
    } finally {
      if (mountedRef.current && epochRef.current === epoch) setMappingLoading(false);
    }
  }

  function toggleMapping(documentId: string) {
    if (mappingDoc === documentId) {
      setMappingDoc(null);
      setMapping(null);
      return;
    }
    void loadMapping(documentId);
  }

  async function handleDeleteDocument(documentId: string) {
    if (!activeWorkspaceId || !data) return;
    const workspaceId = activeWorkspaceId;
    // An import-created workspace is retired together with its FINAL
    // document (server-side, one transaction) — the confirmation must say
    // so. Manual and legacy/unknown workspaces are always preserved.
    const retiresWorkspace =
      data.workspace.origin === 'material_import' && data.documents.length === 1;
    const confirmText = retiresWorkspace
      ? '删除文档将同时删除它的源块、概念、相关图谱关系、测验与错题记录,且不可恢复。\n\n这是该课程空间中的最后一个文档,而该课程空间由资料库导入自动创建:课程空间将随文档一并删除,包括其测验与成绩历史、复习进度等全部剩余记录。确定删除?'
      : '删除文档将同时删除它的源块、概念、相关图谱关系、测验与错题记录,且不可恢复。课程空间本身会保留,之后可以继续添加文档。确定删除?';
    if (!window.confirm(confirmText)) {
      return;
    }
    const result = await documentAction.run((signal) =>
      api.deleteDocument(workspaceId, documentId, signal),
    );
    if (!result) return;

    if (result.workspaceDeleted) {
      // Server-confirmed: the import workspace went with its final document.
      // Same reconciliation as an explicit course-space deletion.
      clearLastWorkspaceId(workspaceId);
      if (activeWorkspaceId === workspaceId) switchWorkspace(null);
      const remaining = await loadWorkspaces();
      if (remaining && remaining.length > 0) {
        switchWorkspace(remaining[0]!.id);
      }
      onWorkspaceDeleted?.(workspaceId);
      return;
    }

    if (activeWorkspaceId === workspaceId) {
      if (selectedNodeId || selectedEdgeId) {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setPlan(null);
      }
      await loadWorkspaceData(workspaceId);
      await loadWorkspaces();
    }
  }

  async function handleReprocessDocument(documentId: string) {
    if (!activeWorkspaceId) return;
    if (
      !window.confirm(
        '重新解析会创建并启用新的资料版本。旧版本的概念、测验与学习记录会保留在历史中;当前路线与图谱需要基于新版本重新验证。确定继续?',
      )
    ) {
      return;
    }
    const workspaceId = activeWorkspaceId;
    const result = await documentAction.run((signal) =>
      api.reprocessDocument(workspaceId, documentId, signal),
    );
    if (result && activeWorkspaceId === workspaceId) {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setPlan(null);
      await loadWorkspaceData(workspaceId);
    }
  }

  async function handleGenerateGraph() {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    setGenerationSummary(null);
    const result = await graphAction.run((signal) => api.generateGraph(workspaceId, signal));
    if (result && activeWorkspaceId === workspaceId) {
      setSelectedEdgeId(null);
      const accepted = result.version.validationSummary?.acceptedCount ?? result.edges.length;
      setGenerationSummary(
        `已构建 ${data?.concepts.length ?? 0} 个概念与 ${result.edges.length} 条关系;${accepted} 条关系已通过本地证据验证。`,
      );
      await loadWorkspaceData(workspaceId);
    }
  }

  async function handleActivateVersion(versionId: string) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const result = await graphAction.run((signal) =>
      api.activateGraphVersion(workspaceId, versionId, signal),
    );
    if (result && activeWorkspaceId === workspaceId) {
      setSelectedEdgeId(null);
      setGenerationSummary(null);
      await loadWorkspaceData(workspaceId);
    }
  }

  async function handleGeneratePlan() {
    if (!activeWorkspaceId || !selectedNodeId) return;
    const workspaceId = activeWorkspaceId;
    const conceptId = selectedNodeId;
    const result = await planAction.run((signal) =>
      api.generatePlan(workspaceId, conceptId, signal),
    );
    // A late plan must never attach to a different workspace/concept.
    if (result && activeWorkspaceId === workspaceId && selectedNodeId === conceptId) {
      setPlan(result.plan);
    }
  }

  async function handleLaunchPlan(acceptedPlan: RemediationPlan) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const result = await launchAction.run((signal) =>
      api.launchPlan(workspaceId, acceptedPlan.id, signal),
    );
    if (result && activeWorkspaceId === workspaceId) {
      onLaunchQuiz(result.quiz, result.mode);
    }
  }

  /**
   * Launch a workspace assessment (queue items / Tutor activities / the
   * empty-state diagnostic). One launch at a time: the ref guard makes rapid
   * repeated clicks a no-op, so only one activity is ever created. A late
   * completion is dropped after workspace switch/unmount (epoch) or when the
   * caller's own staleness check fails (e.g. Tutor concept changed).
   */
  async function launchAssessment(
    input: CreateAssessmentRequest,
    pending: PendingLaunch,
    isStale?: () => boolean,
  ) {
    if (!activeWorkspaceId || pendingLaunchRef.current !== null) return;
    const workspaceId = activeWorkspaceId;
    const epoch = epochRef.current;
    pendingLaunchRef.current = pending;
    setPendingLaunch(pending);
    try {
      const result = await assessmentAction.run((signal) =>
        api.createAssessment(workspaceId, input, signal),
      );
      if (result && mountedRef.current && epochRef.current === epoch && !(isStale?.() ?? false)) {
        onLaunchQuiz(result.quiz, 'assessment');
      }
    } finally {
      pendingLaunchRef.current = null;
      if (mountedRef.current && epochRef.current === epoch) setPendingLaunch(null);
    }
  }

  function handleStartQueueItem(item: DailyQueueItem) {
    // The server resolved the launch request when composing the queue; the
    // client sends it verbatim and never re-derives modes or parameters.
    void launchAssessment(item.launch, { surface: 'queue', key: item.conceptId });
  }

  /** Launch the standalone workspace diagnostic from the empty daily queue. */
  function handleStartDiagnostic() {
    void launchAssessment({ mode: 'diagnostic' }, { surface: 'diagnostic', key: 'diagnostic' });
  }

  /**
   * Launch the recommended activity of a completed Tutor run through the
   * server-owned route: the backend revalidates the persisted recommendation
   * against CURRENT state and constructs the launch itself. When it had to
   * adjust the mode, the substitution is surfaced honestly.
   */
  function handleStartTutorActivity(run: TutorRun) {
    if (!activeWorkspaceId || pendingLaunchRef.current !== null) return;
    const workspaceId = activeWorkspaceId;
    const runId = run.id;
    // The recommendation belongs to the currently selected concept; if the
    // selection changes while the activity is being created, drop the launch.
    const conceptAtLaunch = selectedNodeIdRef.current;
    const isStale = () => selectedNodeIdRef.current !== conceptAtLaunch;
    const pending: PendingLaunch = {
      surface: 'tutor',
      key: run.activity?.conceptIds[0] ?? 'tutor',
    };
    const epoch = epochRef.current;
    pendingLaunchRef.current = pending;
    setPendingLaunch(pending);
    setActivityNotice(null);
    void (async () => {
      try {
        const result = await assessmentAction.run((signal) =>
          api.launchTutorActivity(workspaceId, runId, signal),
        );
        if (result && mountedRef.current && epochRef.current === epoch && !isStale()) {
          if (result.adjusted) {
            setActivityNotice(
              `推荐活动已按当前状态调整:${result.adjusted.reason}已改为${
                ACTIVITY_TEXT[result.launchedMode]
              }。`,
            );
          }
          onLaunchQuiz(result.quiz, 'assessment');
        }
      } finally {
        pendingLaunchRef.current = null;
        if (mountedRef.current && epochRef.current === epoch) setPendingLaunch(null);
      }
    })();
  }

  /** Refetch the accepted plan after a Tutor session persisted one. */
  const refreshPlanForSelection = useCallback(() => {
    if (!activeWorkspaceId || !selectedNodeId) return;
    const epoch = epochRef.current;
    const conceptId = selectedNodeId;
    void api
      .getPlan(activeWorkspaceId, conceptId)
      .then((result) => {
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setPlan((current) => (selectedNodeId === conceptId ? result.plan : current));
      })
      .catch(() => {
        /* best-effort refresh */
      });
  }, [activeWorkspaceId, selectedNodeId]);

  const overlayByConcept = useMemo(
    () => new Map((data?.overlay ?? []).map((s) => [s.conceptId, s])),
    [data],
  );
  /** Canonical display projection: one node per aligned concept group. */
  const displayGraph = useMemo(
    () =>
      buildCanonicalDisplayGraph(data?.concepts ?? [], data?.edges ?? [], data?.canonical ?? []),
    [data],
  );
  const displayOverlay = useMemo(
    () => aggregateOverlay(overlayByConcept, displayGraph),
    [overlayByConcept, displayGraph],
  );
  const conceptNameById = useMemo(
    () => new Map(displayGraph.concepts.map((c) => [c.id, c.name])),
    [displayGraph],
  );
  const misconceptionsByConcept = useMemo(() => {
    const map = new Map<string, MisconceptionRecord[]>();
    for (const record of data?.misconceptions ?? []) {
      const representative = displayGraph.representativeByConcept.get(record.conceptId);
      if (!representative) continue;
      const list = map.get(representative) ?? [];
      list.push(record);
      map.set(representative, list);
    }
    return map;
  }, [data, displayGraph]);
  const reviewByConcept = useMemo(() => {
    const map = new Map<string, ReviewItem>();
    for (const item of data?.reviewItems ?? []) {
      const representative = displayGraph.representativeByConcept.get(item.conceptId);
      if (representative && !map.has(representative)) map.set(representative, item);
    }
    return map;
  }, [data, displayGraph]);
  const highlightIds = useMemo(() => {
    const ids = new Set<string>();
    for (const target of plan?.targets ?? []) {
      ids.add(displayGraph.representativeByConcept.get(target.conceptId) ?? target.conceptId);
    }
    for (const id of tutorPathIds) {
      ids.add(displayGraph.representativeByConcept.get(id) ?? id);
    }
    return ids;
  }, [plan, tutorPathIds, displayGraph]);
  const selectedConcept = displayGraph.concepts.find((c) => c.id === selectedNodeId) ?? null;
  const selectedEdge = displayGraph.edges.find((e) => e.id === selectedEdgeId) ?? null;
  const weakCount = [...displayOverlay.values()].filter((s) => s.treatAsWeak).length;
  const summary = data?.version?.validationSummary ?? null;
  const hasGraph = data !== null && data.concepts.length > 0;
  const anyAttempts = (data?.overlay ?? []).some((s) => s.attempts > 0);
  const dueReviewCount = useMemo(() => {
    const now = Date.now();
    return (data?.reviewItems ?? []).filter((item) => new Date(item.dueAt).getTime() <= now).length;
  }, [data]);

  return (
    <section
      className={`graph-workspace ${courseLocked ? 'course-locked' : ''} ${leftCollapsed ? 'left-collapsed' : ''} ${
        rightCollapsed ? 'right-collapsed' : ''
      }`}
    >
      {leftCollapsed ? (
        <div className="panel-rail left">
          <button
            type="button"
            className="rail-toggle"
            aria-label="展开资料面板"
            title="展开资料面板"
            onClick={() => setLeftCollapsed(false)}
          >
            »
          </button>
        </div>
      ) : (
        <aside className="workspace-panel" aria-label="课程空间与文档">
          <div className="panel-head">
            <h2>{courseLocked ? '图谱资料与版本' : '课程与资料'}</h2>
            <button
              type="button"
              className="rail-toggle"
              aria-label="折叠资料面板"
              title="折叠资料面板"
              onClick={() => setLeftCollapsed(true)}
            >
              «
            </button>
          </div>
          {!courseLocked ? (
            <>
              {workspacesError ? <Banner kind="error">{workspacesError}</Banner> : null}
              {workspacesLoading ? <Loading label="加载课程…" /> : null}
              <ul className="workspace-list">
                {workspaces.map((ws) => (
                  <li key={ws.id} className="workspace-item">
                    <button
                      type="button"
                      className={`workspace-open ${ws.id === activeWorkspaceId ? 'active' : ''}`}
                      onClick={() => switchWorkspace(ws.id)}
                    >
                      {ws.name}
                      <span className="small muted">
                        {' '}
                        {ws.documentCount} 份资料 · {ws.conceptCount} 个概念
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ghost small danger workspace-delete"
                      aria-label={`删除课程空间:${ws.name}`}
                      title={`删除课程空间:${ws.name}`}
                      disabled={deleteWorkspaceAction.loading}
                      onClick={() => void handleDeleteWorkspace(ws)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              {deleteWorkspaceAction.error ? (
                <Banner kind="error">删除课程失败:{deleteWorkspaceAction.error}</Banner>
              ) : null}
              {!workspacesLoading && workspaces.length === 0 ? (
                <Banner kind="empty">还没有课程。先创建一门课程，然后添加学习资料。</Banner>
              ) : null}
              <div className="workspace-create">
                <label htmlFor="new-workspace-name">新建课程</label>
                <input
                  id="new-workspace-name"
                  value={newWorkspaceName}
                  placeholder="例如:认知科学导论"
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={createAction.loading || newWorkspaceName.trim().length === 0}
                  onClick={() => void handleCreateWorkspace()}
                >
                  创建
                </button>
                {createAction.error ? <Banner kind="error">{createAction.error}</Banner> : null}
              </div>
            </>
          ) : null}

          {activeWorkspaceId && data ? (
            <>
              {!courseLocked ? (
                <DailyQueue
                  items={data.queue}
                  loading={dataLoading}
                  error={assessmentAction.error}
                  launchBusy={pendingLaunch !== null}
                  startingConceptId={pendingLaunch?.surface === 'queue' ? pendingLaunch.key : null}
                  diagnosticStarting={pendingLaunch?.surface === 'diagnostic'}
                  canDiagnose={data.concepts.length > 0}
                  onStartItem={handleStartQueueItem}
                  onStartDiagnostic={handleStartDiagnostic}
                />
              ) : null}

              <h3>文档({data.documents.length})</h3>
              <ul className="document-list">
                {data.documents.map((doc) => (
                  <li key={doc.id} className="document-item">
                    <div>
                      <strong>{doc.title}</strong>
                      <p className="small muted">
                        {SOURCE_TYPE_TEXT[doc.sourceType] ?? doc.sourceType}
                        {doc.pageCount ? ` · ${doc.pageCount} 页` : ''} · {doc.blockCount} 段 ·{' '}
                        {doc.parseStatus === 'parsed_with_warnings' ? '解析有警告' : '解析成功'} ·{' '}
                        {doc.conceptCount} 概念
                      </p>
                      {doc.extractionWarnings.length > 0 ? (
                        <details className="small">
                          <summary>{doc.extractionWarnings.length} 条提取警告</summary>
                          <ul>
                            {doc.extractionWarnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {doc.conceptCount > 0 ? (
                        <details
                          className="small"
                          open={mappingDoc === doc.id}
                          onToggle={(event) => {
                            const open = (event.target as HTMLDetailsElement).open;
                            if (open && mappingDoc !== doc.id) void loadMapping(doc.id);
                            if (!open && mappingDoc === doc.id) toggleMapping(doc.id);
                          }}
                        >
                          <summary>资料映射</summary>
                          {mappingDoc === doc.id && mapping ? (
                            <div aria-label={`资料映射:${doc.title}`}>
                              <p className="small muted">
                                已映射 {mapping.totals.mappedSectionCount}/
                                {mapping.totals.sectionCount} 小节 · 概念{' '}
                                {mapping.totals.conceptCount} 个 · 引用锚点覆盖{' '}
                                {mapping.totals.anchoredBlockCount}/{mapping.totals.blockCount} 段
                              </p>
                              <p className="small muted">
                                映射指小节是否已有取证概念,不代表小节内容已被完整覆盖。
                              </p>
                              <ul className="small">
                                {mapping.sections.map((section) => (
                                  <li key={section.key}>
                                    {section.title} · {section.conceptCount} 概念
                                    {section.mapped ? null : (
                                      <>
                                        {' '}
                                        <span className="pill">未映射</span>
                                        {!courseLocked ? (
                                          <>
                                            {' '}
                                            <button
                                              type="button"
                                              className="ghost small"
                                              disabled={analyzeAction.loading}
                                              aria-busy={deepeningSection === section.key}
                                              onClick={() =>
                                                void handleAnalyze(doc.id, section.key)
                                              }
                                            >
                                              {deepeningSection === section.key
                                                ? '正在提取…'
                                                : '继续提取'}
                                            </button>
                                          </>
                                        ) : null}
                                      </>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : mappingDoc === doc.id && mappingLoading ? (
                            <Loading label="加载映射…" />
                          ) : null}
                        </details>
                      ) : null}
                    </div>
                    {!courseLocked ? (
                      <div className="document-actions">
                        {doc.conceptCount === 0 ? (
                          <button
                            type="button"
                            className="small"
                            disabled={analyzeAction.loading}
                            onClick={() => void handleAnalyze(doc.id)}
                          >
                            提取概念
                          </button>
                        ) : null}
                        {doc.sourceType === 'pdf' || doc.sourceType === 'docx' ? (
                          <button
                            type="button"
                            className="ghost small"
                            disabled={documentAction.loading}
                            onClick={() => void handleReprocessDocument(doc.id)}
                          >
                            重新解析
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ghost small danger"
                          disabled={documentAction.loading}
                          onClick={() => void handleDeleteDocument(doc.id)}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {analyzeAction.loading ? (
                <p>
                  <Loading label="Hy3 正在分节提取概念…" />{' '}
                  <button type="button" className="ghost small" onClick={analyzeAction.cancel}>
                    取消
                  </button>
                </p>
              ) : null}
              {extractionNotice ? <Banner kind="info">{extractionNotice}</Banner> : null}
              {analyzeAction.error ? <Banner kind="error">{analyzeAction.error}</Banner> : null}
              {documentAction.error ? <Banner kind="error">{documentAction.error}</Banner> : null}

              {!courseLocked ? (
                <AddDocumentForm
                  loading={addDocAction.loading}
                  error={addDocAction.error}
                  onCancel={addDocAction.cancel}
                  onAddText={(content, title) => void handleAddText(content, title)}
                  onAddFile={(file) => void handleAddFile(file)}
                />
              ) : null}

              <h3>概念图谱</h3>
              <p className="small muted">
                {data.version
                  ? `当前版本:${data.version.id.slice(0, 11)}…(${graphVersionStatusLabel(data.version.status)})`
                  : '还没有生成图谱。'}
              </p>
              {summary ? (
                <p className="small muted">
                  候选 {summary.candidateCount} 条 · 采纳 {summary.acceptedCount} 条 · 拒绝{' '}
                  {summary.rejectedCount} 条
                  {summary.duplicateCount > 0 ? ` · 去重 ${summary.duplicateCount} 条` : ''}
                  {summary.pruned ? '(已因文档变更修剪)' : ''}
                </p>
              ) : null}
              <p>
                <button
                  type="button"
                  className="primary"
                  disabled={graphAction.loading || data.concepts.length < 2}
                  onClick={() => void handleGenerateGraph()}
                >
                  {data.version ? '重新生成图谱' : '生成概念图谱'}
                </button>{' '}
                {graphAction.loading ? (
                  <>
                    <Loading label="Hy3 正在提出概念关系…" />{' '}
                    <button type="button" className="ghost small" onClick={graphAction.cancel}>
                      取消
                    </button>
                  </>
                ) : null}
              </p>
              {data.concepts.length < 2 ? (
                <p className="small muted">生成图谱前,请先为文档提取概念(至少 2 个)。</p>
              ) : null}
              {graphAction.error ? <Banner kind="error">{graphAction.error}</Banner> : null}
              {data.versions.length > 1 ? (
                <details className="small">
                  <summary>历史版本({data.versions.length})</summary>
                  <ul>
                    {data.versions.map((v) => (
                      <li key={v.id}>
                        {v.id.slice(0, 11)}… · {graphVersionStatusLabel(v.status)}
                        {v.id === data.workspace.activeGraphVersionId ? '(当前)' : null}
                        {v.status === 'ready' && v.id !== data.workspace.activeGraphVersionId ? (
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => void handleActivateVersion(v.id)}
                          >
                            启用
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
          {activeWorkspaceId && dataLoading && !data ? <Loading label="加载课程空间数据…" /> : null}
          {dataError ? <Banner kind="error">{dataError}</Banner> : null}
          {actionError ? <Banner kind="error">{actionError}</Banner> : null}
        </aside>
      )}

      <div className="graph-area" aria-label="个人学习图谱">
        <div className="graph-area-head">
          <div>
            {courseLocked ? <h3>概念图谱</h3> : <h2>个人学习图谱</h2>}
            {courseLocked ? (
              <p className="small muted">查看概念关系与课程依据，不会改变当前学习路线。</p>
            ) : null}
          </div>
          {data && weakCount > 0 ? (
            <span className="pill weak">薄弱概念 {weakCount} 个</span>
          ) : null}
          {data && dueReviewCount > 0 ? (
            <span className="pill review-due">待复习 {dueReviewCount} 个</span>
          ) : null}
          {data && data.documents.length > 1 ? (
            <button
              type="button"
              className={`ghost small alignment-toggle ${alignmentOpen ? 'active' : ''}`}
              onClick={() => setAlignmentOpen((open) => !open)}
            >
              概念对齐
              {data.pendingAlignmentCount > 0 ? (
                <span className="badge-count">{data.pendingAlignmentCount} 待审</span>
              ) : null}
            </button>
          ) : null}
          {generationSummary ? (
            <p className="generation-summary" role="status">
              {generationSummary}
              <button
                type="button"
                className="ghost small"
                aria-label="关闭生成摘要"
                onClick={() => setGenerationSummary(null)}
              >
                ✕
              </button>
            </p>
          ) : null}
        </div>
        {alignmentOpen && data && activeWorkspaceId ? (
          <AlignmentPanel
            workspaceId={activeWorkspaceId}
            concepts={data.concepts}
            blocks={data.blocks}
            documents={data.documents}
            onClose={() => setAlignmentOpen(false)}
            onChanged={() => {
              if (activeWorkspaceId) void loadWorkspaceData(activeWorkspaceId);
            }}
          />
        ) : null}
        {!activeWorkspaceId ? (
          <Banner kind="empty">选择或创建一个课程空间,查看你的学习图谱。</Banner>
        ) : dataLoading && !data ? (
          <div className="graph-skeleton" aria-hidden="true">
            <Loading label="加载图谱…" />
          </div>
        ) : data && data.concepts.length === 0 ? (
          <GraphOnboarding
            data={data}
            anyAttempts={anyAttempts}
            weakCount={weakCount}
            analyzeLoading={analyzeAction.loading}
            graphLoading={graphAction.loading}
            courseLocked={courseLocked}
            onOpenMaterials={onOpenMaterials}
            onAnalyzeFirst={() => {
              const target = data.documents.find((doc) => doc.conceptCount === 0);
              if (target) void handleAnalyze(target.id);
            }}
            onGenerate={() => void handleGenerateGraph()}
          />
        ) : data ? (
          <>
            {data.version === null && data.concepts.length >= 2 ? (
              <div className="graph-cta-banner">
                <span>概念已就绪,还没有关系图谱。</span>
                <button
                  type="button"
                  className="primary"
                  disabled={graphAction.loading}
                  onClick={() => void handleGenerateGraph()}
                >
                  {graphAction.loading ? '正在生成…' : '生成学习图谱'}
                </button>
                {graphAction.loading ? (
                  <button type="button" className="ghost small" onClick={graphAction.cancel}>
                    取消
                  </button>
                ) : null}
              </div>
            ) : null}
            <ConceptGraph
              concepts={displayGraph.concepts}
              edges={displayGraph.edges}
              overlay={displayOverlay}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
              versionId={data.version?.id ?? null}
              planTargetIds={highlightIds}
              refitKey={`${leftCollapsed ? 'L' : 'l'}${rightCollapsed ? 'R' : 'r'}`}
              summary={{
                documentCount: data.documents.length,
                weakCount,
                acceptedCount: summary?.acceptedCount ?? null,
                rejectedCount: summary?.rejectedCount ?? null,
              }}
            />
            {data.version?.status === 'failed' ? (
              <Banner kind="error">
                最近一次图谱生成失败:{data.version.errorMessage ?? '原因未知'}。原有图谱未受影响。
              </Banner>
            ) : null}
            {summary && summary.rejectedCount > 0 ? (
              <Banner kind="info">
                部分候选关系未通过本地校验({summary.rejectedCount} 条被拒绝),已仅采纳通过校验的{' '}
                {summary.acceptedCount} 条。
              </Banner>
            ) : null}
          </>
        ) : null}
      </div>

      {rightCollapsed ? (
        <div className="panel-rail right">
          <button
            type="button"
            className="rail-toggle"
            aria-label="展开详情面板"
            title="展开详情面板"
            onClick={() => setRightCollapsed(false)}
          >
            «
          </button>
        </div>
      ) : (
        <aside className="detail-area" aria-label="证据与辅导详情">
          <div className="panel-head">
            <h2>详情</h2>
            <button
              type="button"
              className="rail-toggle"
              aria-label="折叠详情面板"
              title="折叠详情面板"
              onClick={() => setRightCollapsed(true)}
            >
              »
            </button>
          </div>
          {selectedConcept && data ? (
            <>
              <ConceptDetailPanel
                workspaceId={activeWorkspaceId ?? ''}
                concept={selectedConcept}
                blocks={data.blocks}
                documents={data.documents}
                state={displayOverlay.get(selectedConcept.id)}
                edges={displayGraph.edges}
                conceptNameById={conceptNameById}
                canonical={displayGraph.canonicalByRepresentative.get(selectedConcept.id)}
                misconceptions={misconceptionsByConcept.get(selectedConcept.id) ?? []}
                reviewItem={reviewByConcept.get(selectedConcept.id)}
                plan={plan}
                planLoading={planAction.loading}
                planError={planAction.error}
                launchLoading={launchAction.loading}
                onGeneratePlan={() => void handleGeneratePlan()}
                onCancelPlan={planAction.cancel}
                onLaunchPlan={(p) => void handleLaunchPlan(p)}
              />
              {activeWorkspaceId ? (
                <TutorPanel
                  workspaceId={activeWorkspaceId}
                  conceptId={selectedConcept.id}
                  conceptName={selectedConcept.name}
                  activityLaunching={pendingLaunch?.surface === 'tutor'}
                  onPathChange={setTutorPathIds}
                  onStartActivity={handleStartTutorActivity}
                  onPlanAccepted={refreshPlanForSelection}
                />
              ) : null}
            </>
          ) : selectedEdge && data ? (
            <EdgeDetailPanel
              edge={selectedEdge}
              blocks={data.blocks}
              documents={data.documents}
              conceptNameById={conceptNameById}
              mergedEdgeCount={
                displayGraph.underlyingEdgesByDisplayEdge.get(selectedEdge.id)?.length ?? 1
              }
            />
          ) : (
            <Banner kind="empty">
              在图谱中选择一个概念或一条关系,这里会显示它的原文依据、学习状态与康复计划。
            </Banner>
          )}
          {launchAction.error ? <Banner kind="error">{launchAction.error}</Banner> : null}
          {activityNotice ? <Banner kind="info">{activityNotice}</Banner> : null}
          {assessmentAction.error && selectedConcept ? (
            <Banner kind="error">{assessmentAction.error}</Banner>
          ) : null}
          {hasGraph && data && displayGraph.edges.length > 0 ? (
            <details className="edge-list small">
              <summary>关系列表({displayGraph.edges.length})— 键盘可访问的选择方式</summary>
              <ul>
                {displayGraph.edges.map((edge) => (
                  <li key={edge.id}>
                    <button
                      type="button"
                      className={`ghost small ${selectedEdgeId === edge.id ? 'active' : ''}`}
                      onClick={() => selectEdge(edge.id)}
                    >
                      {conceptNameById.get(edge.sourceConceptId) ?? edge.sourceConceptId} —
                      {RELATION_TEXT[edge.relation]}→{' '}
                      {conceptNameById.get(edge.targetConceptId) ?? edge.targetConceptId}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>
      )}
    </section>
  );
}

/**
 * Staged onboarding shown before any concepts exist. Completion marks come
 * from real persisted state only — no fake progress.
 */
function GraphOnboarding({
  data,
  anyAttempts,
  weakCount,
  analyzeLoading,
  graphLoading,
  courseLocked,
  onOpenMaterials,
  onAnalyzeFirst,
  onGenerate,
}: {
  data: WorkspaceData;
  anyAttempts: boolean;
  weakCount: number;
  analyzeLoading: boolean;
  graphLoading: boolean;
  courseLocked: boolean;
  onOpenMaterials?: () => void;
  onAnalyzeFirst: () => void;
  onGenerate: () => void;
}) {
  const hasDocuments = data.documents.length > 0;
  const hasConcepts = data.concepts.length > 0;
  const hasGraph = data.version?.status === 'ready';
  const stages: Array<{ label: string; done: boolean }> = [
    { label: '添加课程资料', done: hasDocuments },
    { label: '提取核心概念', done: hasConcepts },
    { label: '生成个人学习图谱', done: hasGraph },
    { label: '完成诊断练习', done: anyAttempts },
    { label: '查看薄弱路径并开始补救', done: hasGraph && anyAttempts && weakCount === 0 },
  ];

  return (
    <div className="graph-onboarding" aria-label="学习图谱引导">
      <h3>从课程资料到个人学习图谱</h3>
      <ol className="onboarding-stages">
        {stages.map((stage, index) => (
          <li key={stage.label} className={stage.done ? 'done' : ''}>
            <span className="stage-marker" aria-hidden="true">
              {stage.done ? '✓' : index + 1}
            </span>
            <span>{stage.label}</span>
            {stage.done ? <span className="visually-hidden">(已完成)</span> : null}
          </li>
        ))}
      </ol>
      {!hasDocuments ? (
        <p className="onboarding-cta">
          <span>
            {courseLocked
              ? '请先从主页添加课程资料，之后即可在这里提取概念并生成学习图谱。'
              : '先在左侧「课程资料」添加课程文档(支持粘贴文本、Markdown、TXT、PDF、DOCX)。'}
          </span>
          {courseLocked && onOpenMaterials ? (
            <button type="button" className="primary" onClick={onOpenMaterials}>
              前往课程资料
            </button>
          ) : null}
        </p>
      ) : !hasConcepts ? (
        <p className="onboarding-cta">
          <button
            type="button"
            className="primary"
            disabled={analyzeLoading}
            onClick={onAnalyzeFirst}
          >
            {analyzeLoading ? '正在提取概念…' : '提取核心概念'}
          </button>
        </p>
      ) : (
        <p className="onboarding-cta">
          <button type="button" className="primary" disabled={graphLoading} onClick={onGenerate}>
            {graphLoading ? '正在生成…' : '生成学习图谱'}
          </button>
        </p>
      )}
    </div>
  );
}

function graphVersionStatusLabel(value: GraphVersion['status']): string {
  const labels: Record<GraphVersion['status'], string> = {
    generating: '生成中',
    ready: '可用',
    failed: '生成失败',
  };
  return labels[value];
}

function AddDocumentForm({
  loading,
  error,
  onCancel,
  onAddText,
  onAddFile,
}: {
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onAddText: (content: string, title: string) => void;
  onAddFile: (file: File) => void;
}) {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="add-document">
      <h3>添加文档</h3>
      <label htmlFor="add-doc-title">标题(可选)</label>
      <input
        id="add-doc-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="文档标题"
      />
      <label htmlFor="add-doc-content">粘贴文本</label>
      <textarea
        id="add-doc-content"
        rows={4}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="粘贴 Markdown 或纯文本…"
      />
      <div className="add-document-actions">
        <button
          type="button"
          disabled={loading || content.trim().length === 0}
          onClick={() => {
            onAddText(content, title);
            setContent('');
            setTitle('');
          }}
        >
          添加文本文档
        </button>
        <label className="file-upload">
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            aria-label="上传文档文件(.md / .txt / .pdf / .docx)"
            disabled={loading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onAddFile(file);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          上传文件(.md / .txt / .pdf / .docx,≤10MB)
        </label>
        <p className="muted small">{UPLOAD_OCR_LIMIT_TEXT}</p>
        {loading ? (
          <>
            <Loading label="正在导入文档…" />
            <button type="button" className="ghost small" onClick={onCancel}>
              取消
            </button>
          </>
        ) : null}
      </div>
      {error ? <Banner kind="error">{error}</Banner> : null}
    </div>
  );
}

function readLastWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function writeLastWorkspaceId(id: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // Storage can be unavailable; the workspace simply is not restored.
  }
}

/**
 * Forget the saved 学习图谱 workspace selection if it points at
 * `expectedId`. Exported for App: a 资料库 deletion can retire the
 * document's import-created workspace, and a stale saved id must not survive
 * it.
 */
export function clearLastWorkspaceId(expectedId: string): void {
  try {
    if (window.localStorage.getItem(LAST_WORKSPACE_KEY) === expectedId) {
      window.localStorage.removeItem(LAST_WORKSPACE_KEY);
    }
  } catch {
    // Treat unavailable storage like an absent saved selection.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
