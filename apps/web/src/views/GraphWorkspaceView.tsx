import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Concept,
  ConceptLearnerState,
  DocumentSummary,
  GraphEdge,
  GraphVersion,
  PublicQuiz,
  RemediationPlan,
  SourceBlock,
  Workspace,
  WorkspaceSummary,
} from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { ConceptGraph, RELATION_LABELS as RELATION_TEXT } from '../components/ConceptGraph.js';
import { ConceptDetailPanel, EdgeDetailPanel } from '../components/DetailPanels.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

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
  onLaunchQuiz: (quiz: PublicQuiz, mode: 'remediation' | 'practice') => void;
  /** Bumped by App after grading so learner overlays refresh. */
  refreshKey: number;
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
export function GraphWorkspaceView({ onLaunchQuiz, refreshKey }: GraphWorkspaceViewProps) {
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

  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [generationSummary, setGenerationSummary] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  const createAction = useAsyncAction();
  const addDocAction = useAsyncAction();
  const analyzeAction = useAsyncAction();
  const documentAction = useAsyncAction();
  const graphAction = useAsyncAction();
  const planAction = useAsyncAction();
  const launchAction = useAsyncAction();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const epoch = epochRef.current;
    setWorkspacesLoading(true);
    setWorkspacesError(null);
    try {
      const result = await api.listWorkspaces();
      if (!mountedRef.current || epochRef.current !== epoch) return null;
      setWorkspaces(result.workspaces);
      return result.workspaces;
    } catch (error) {
      if (mountedRef.current && epochRef.current === epoch) {
        setWorkspacesError(errorMessage(error));
      }
      return null;
    } finally {
      if (mountedRef.current && epochRef.current === epoch) setWorkspacesLoading(false);
    }
  }, []);

  /** Load everything the three areas need for one workspace. */
  const loadWorkspaceData = useCallback(
    async (workspaceId: string) => {
      const epoch = epochRef.current;
      setDataLoading(true);
      setDataError(null);
      try {
        const [detail, graph, overlay, versions] = await Promise.all([
          api.getWorkspace(workspaceId),
          api.getWorkspaceGraph(workspaceId),
          api.learnerOverlay(workspaceId),
          api.listGraphVersions(workspaceId),
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

  /** Initial load + restore last opened workspace. */
  useEffect(() => {
    void (async () => {
      const list = await loadWorkspaces();
      if (!list) return;
      const saved = readLastWorkspaceId();
      const target = saved && list.some((w) => w.id === saved) ? saved : null;
      if (target) {
        setActiveWorkspaceId(target);
      }
    })();
  }, [loadWorkspaces]);

  /** (Re)load workspace data on switch and after grading refreshes. */
  useEffect(() => {
    if (!activeWorkspaceId) return;
    void loadWorkspaceData(activeWorkspaceId);
  }, [activeWorkspaceId, refreshKey, loadWorkspaceData]);

  function switchWorkspace(workspaceId: string | null) {
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
    setActiveWorkspaceId(workspaceId);
    setData(null);
    setDataError(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setPlan(null);
    setActionError(null);
    setGenerationSummary(null);
    if (workspaceId) writeLastWorkspaceId(workspaceId);
  }

  /** Selecting a node clears edge selection and loads its accepted plan. */
  const selectNode = useCallback(
    (conceptId: string | null) => {
      setSelectedNodeId(conceptId);
      setSelectedEdgeId(null);
      setPlan(null);
      planAction.cancel();
      planAction.clearError();
      if (!conceptId || !activeWorkspaceId) return;
      const epoch = epochRef.current;
      void api
        .getPlan(activeWorkspaceId, conceptId)
        .then((result) => {
          if (!mountedRef.current || epochRef.current !== epoch) return;
          // Ignore if the user has already selected a different node.
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
      if (isBinary) {
        const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
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

  async function handleAnalyze(documentId: string) {
    if (!activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const result = await analyzeAction.run((signal) => api.analyze(documentId, signal));
    if (result && activeWorkspaceId === workspaceId) {
      await loadWorkspaceData(workspaceId);
    }
  }

  async function handleDeleteDocument(documentId: string) {
    if (!activeWorkspaceId) return;
    if (
      !window.confirm(
        '删除文档将同时删除它的源块、概念、相关图谱关系、测验与错题记录,且不可恢复。确定删除?',
      )
    ) {
      return;
    }
    const workspaceId = activeWorkspaceId;
    const result = await documentAction.run((signal) =>
      api.deleteDocument(workspaceId, documentId, signal).then(() => true),
    );
    if (result && activeWorkspaceId === workspaceId) {
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
        '重新解析会用当前解析器重建文本与段落,并清空该文档已有的概念、图谱关系、测验、错题与掌握度记录。确定继续?',
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

  const overlayByConcept = useMemo(
    () => new Map((data?.overlay ?? []).map((s) => [s.conceptId, s])),
    [data],
  );
  const conceptNameById = useMemo(
    () => new Map((data?.concepts ?? []).map((c) => [c.id, c.name])),
    [data],
  );
  const planTargetIds = useMemo(() => new Set(plan?.targets.map((t) => t.conceptId) ?? []), [plan]);
  const selectedConcept = data?.concepts.find((c) => c.id === selectedNodeId) ?? null;
  const selectedEdge = data?.edges.find((e) => e.id === selectedEdgeId) ?? null;
  const weakCount = (data?.overlay ?? []).filter((s) => s.treatAsWeak).length;
  const summary = data?.version?.validationSummary ?? null;
  const hasGraph = data !== null && data.concepts.length > 0;
  const anyAttempts = (data?.overlay ?? []).some((s) => s.attempts > 0);

  return (
    <section
      className={`graph-workspace ${leftCollapsed ? 'left-collapsed' : ''} ${
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
            <h2>资料库</h2>
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
          {workspacesError ? <Banner kind="error">{workspacesError}</Banner> : null}
          {workspacesLoading ? <Loading label="加载课程空间…" /> : null}
          <ul className="workspace-list">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <button
                  type="button"
                  className={ws.id === activeWorkspaceId ? 'active' : ''}
                  onClick={() => switchWorkspace(ws.id)}
                >
                  {ws.name}
                  <span className="small muted">
                    {' '}
                    {ws.documentCount} 文档 · {ws.conceptCount} 概念
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!workspacesLoading && workspaces.length === 0 ? (
            <Banner kind="empty">还没有课程空间。先创建一个,然后导入学习文档。</Banner>
          ) : null}
          <div className="workspace-create">
            <label htmlFor="new-workspace-name">新建课程空间</label>
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

          {activeWorkspaceId && data ? (
            <>
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
                    </div>
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
                  </li>
                ))}
              </ul>
              {analyzeAction.loading ? (
                <p>
                  <Loading label="Hy3 正在提取概念…" />{' '}
                  <button type="button" className="ghost small" onClick={analyzeAction.cancel}>
                    取消
                  </button>
                </p>
              ) : null}
              {analyzeAction.error ? <Banner kind="error">{analyzeAction.error}</Banner> : null}
              {documentAction.error ? <Banner kind="error">{documentAction.error}</Banner> : null}

              <AddDocumentForm
                loading={addDocAction.loading}
                error={addDocAction.error}
                onCancel={addDocAction.cancel}
                onAddText={(content, title) => void handleAddText(content, title)}
                onAddFile={(file) => void handleAddFile(file)}
              />

              <h3>概念图谱</h3>
              <p className="small muted">
                {data.version
                  ? `当前版本:${data.version.id.slice(0, 11)}…(${data.version.status})`
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
                        {v.id.slice(0, 11)}… · {v.status}
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
          <h2>个人学习图谱</h2>
          {data && weakCount > 0 ? (
            <span className="pill weak">薄弱概念 {weakCount} 个</span>
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
              concepts={data.concepts}
              edges={data.edges}
              overlay={overlayByConcept}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
              versionId={data.version?.id ?? null}
              planTargetIds={planTargetIds}
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
            <ConceptDetailPanel
              concept={selectedConcept}
              blocks={data.blocks}
              documents={data.documents}
              state={overlayByConcept.get(selectedConcept.id)}
              edges={data.edges}
              conceptNameById={conceptNameById}
              plan={plan}
              planLoading={planAction.loading}
              planError={planAction.error}
              launchLoading={launchAction.loading}
              onGeneratePlan={() => void handleGeneratePlan()}
              onCancelPlan={planAction.cancel}
              onLaunchPlan={(p) => void handleLaunchPlan(p)}
            />
          ) : selectedEdge && data ? (
            <EdgeDetailPanel
              edge={selectedEdge}
              blocks={data.blocks}
              documents={data.documents}
              conceptNameById={conceptNameById}
            />
          ) : (
            <Banner kind="empty">
              在图谱中选择一个概念或一条关系,这里会显示它的原文依据、学习状态与康复计划。
            </Banner>
          )}
          {launchAction.error ? <Banner kind="error">{launchAction.error}</Banner> : null}
          {hasGraph && data && data.edges.length > 0 ? (
            <details className="edge-list small">
              <summary>关系列表({data.edges.length})— 键盘可访问的选择方式</summary>
              <ul>
                {data.edges.map((edge) => (
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
  onAnalyzeFirst,
  onGenerate,
}: {
  data: WorkspaceData;
  anyAttempts: boolean;
  weakCount: number;
  analyzeLoading: boolean;
  graphLoading: boolean;
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
          <span>先在左侧「资料库」添加课程文档(支持粘贴文本、Markdown、TXT、PDF、DOCX)。</span>
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
            accept=".md,.markdown,.txt,.pdf,.docx"
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
