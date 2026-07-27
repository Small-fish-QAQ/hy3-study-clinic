import { useRef, useState } from 'react';
import type { Concept } from '@hy3-clinic/shared';
import { api, type MaterialSummary, type MaterialWithBlocks } from '../api.js';
import { Banner, formatPageRange, Loading } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS_TEXT,
  UPLOAD_KIND_LABELS,
  UPLOAD_OCR_LIMIT_TEXT,
  fileToBase64,
  isBinaryUploadKind,
  uploadKindOf,
  uploadValidationError,
} from '../upload.js';

export interface ImportViewProps {
  material: MaterialWithBlocks | null;
  concepts: Concept[];
  recentMaterials: MaterialSummary[];
  historyLoading: boolean;
  historyError: string | null;
  openingMaterialId: string | null;
  onImported: (material: MaterialWithBlocks) => void;
  onAnalyzed: (materialId: string, concepts: Concept[]) => void;
  onOpenMaterial: (materialId: string) => void;
  onRenameMaterial: (materialId: string, title: string, signal: AbortSignal) => Promise<void>;
  onDeleteMaterial: (materialId: string, signal: AbortSignal) => Promise<void>;
}

const IMPORTANCE_TEXT: Record<Concept['importance'], string> = {
  high: '核心',
  medium: '重要',
  low: '了解',
};

const HISTORY_PREVIEW_COUNT = 3;
const MATERIAL_TITLE_MAX_LENGTH = 120;

function formatLocalDateTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeHistoryQuery(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function matchesHistoryQuery(recent: MaterialSummary, query: string): boolean {
  return [recent.title, formatLocalDateTime(recent.createdAt), recent.id.slice(-6)].some((value) =>
    normalizeHistoryQuery(value).includes(query),
  );
}

/** 学习资料导入、历史恢复与预览视图(Flow A 第一步)。 */
export function ImportView({
  material,
  concepts,
  recentMaterials,
  historyLoading,
  historyError,
  openingMaterialId,
  onImported,
  onAnalyzed,
  onOpenMaterial,
  onRenameMaterial,
  onDeleteMaterial,
}: ImportViewProps) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ file: File; kind: 'pdf' | 'docx' } | null>(
    null,
  );
  const [title, setTitle] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [deletingMaterialId, setDeletingMaterialId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importAction = useAsyncAction();
  const analyzeAction = useAsyncAction();
  const renameAction = useAsyncAction();
  const deleteAction = useAsyncAction();
  const materialOpening = openingMaterialId !== null;
  const historyActionRunning = renameAction.loading || deleteAction.loading;
  const materialManagementActive = historyActionRunning || editingMaterialId !== null;
  const currentMaterialId = material?.material.id;
  const currentHistoryMaterial = recentMaterials.find((recent) => recent.id === currentMaterialId);
  const remainingHistoryMaterials = recentMaterials.filter(
    (recent) => recent.id !== currentHistoryMaterial?.id,
  );
  const orderedHistoryMaterials = currentHistoryMaterial
    ? [currentHistoryMaterial, ...remainingHistoryMaterials]
    : remainingHistoryMaterials;
  const defaultHistoryMaterials = currentHistoryMaterial
    ? [currentHistoryMaterial, ...remainingHistoryMaterials.slice(0, HISTORY_PREVIEW_COUNT)]
    : remainingHistoryMaterials.slice(0, HISTORY_PREVIEW_COUNT);
  const normalizedHistoryQuery = normalizeHistoryQuery(historyQuery);
  const visibleHistoryMaterials = normalizedHistoryQuery
    ? orderedHistoryMaterials.filter((recent) =>
        matchesHistoryQuery(recent, normalizedHistoryQuery),
      )
    : historyExpanded
      ? orderedHistoryMaterials
      : defaultHistoryMaterials;
  const hasHiddenHistory = orderedHistoryMaterials.length > defaultHistoryMaterials.length;

  async function loadSample() {
    setFileError(null);
    const sample = await importAction.run((signal) => api.sampleMaterial(signal));
    if (sample) {
      setSelectedFile(null);
      setContent(sample.content);
      setFilename(sample.filename);
    }
  }

  async function onFileChange(files: FileList | null) {
    const file = files?.[0];
    // Reset the input so picking the same file again re-triggers onChange.
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    const kind = uploadKindOf(file.name);
    const validationError = uploadValidationError(file);
    if (validationError || kind === null) {
      setFileError(validationError);
      return;
    }
    setFileError(null);
    if (isBinaryUploadKind(kind)) {
      // PDF/DOCX are parsed server-side: stage the file for import.
      setSelectedFile({ file, kind });
      setContent('');
      setFilename(file.name);
      return;
    }
    const text = await file.text();
    setSelectedFile(null);
    setContent(text);
    setFilename(file.name);
  }

  function removeSelectedFile() {
    setSelectedFile(null);
    setFilename(null);
    setFileError(null);
  }

  async function doImport() {
    setFileError(null);
    const staged = selectedFile;
    const trimmedTitle = title.trim();
    const imported = await importAction.run(async (signal) => {
      if (staged) {
        const dataBase64 = await fileToBase64(staged.file);
        return api.importMaterial(
          {
            filename: staged.file.name,
            dataBase64,
            ...(trimmedTitle ? { title: trimmedTitle } : {}),
          },
          signal,
        );
      }
      const payload: { content: string; filename?: string; title?: string } = { content };
      if (filename) payload.filename = filename;
      if (trimmedTitle) payload.title = trimmedTitle;
      return api.importMaterial(payload, signal);
    });
    if (imported) {
      if (staged) {
        setSelectedFile(null);
        setFilename(null);
      }
      setTitle('');
      onImported(imported);
    }
  }

  async function doAnalyze() {
    if (!material) return;
    const materialId = material.material.id;
    const result = await analyzeAction.run((signal) => api.analyze(materialId, signal));
    if (result) onAnalyzed(materialId, result.concepts);
  }

  function startRename(recent: MaterialSummary) {
    renameAction.clearError();
    deleteAction.clearError();
    setEditingMaterialId(recent.id);
    setTitleDraft(recent.title);
    setTitleError(null);
  }

  function cancelRename() {
    setEditingMaterialId(null);
    setTitleDraft('');
    setTitleError(null);
    renameAction.clearError();
  }

  async function saveRename(recent: MaterialSummary) {
    const title = titleDraft.trim();
    if (!title) {
      setTitleError('资料标题不能为空。');
      return;
    }
    if (title.length > MATERIAL_TITLE_MAX_LENGTH) {
      setTitleError(`资料标题不能超过 ${MATERIAL_TITLE_MAX_LENGTH} 个字符。`);
      return;
    }

    setTitleError(null);
    const saved = await renameAction.run(async (signal) => {
      await onRenameMaterial(recent.id, title, signal);
      return true;
    });
    if (saved) {
      setEditingMaterialId(null);
      setTitleDraft('');
    }
  }

  async function permanentlyDelete(recent: MaterialSummary, current: boolean) {
    renameAction.clearError();
    deleteAction.clearError();
    const suffix = recent.id.slice(-6);
    const confirmed = window.confirm(
      `永久删除以下资料及其全部相关学习记录？\n\n标题：${recent.title}\n创建时间：${formatLocalDateTime(recent.createdAt)}\n记录：…${suffix}\n\n此操作无法恢复。`,
    );
    if (!confirmed) return;

    if (current) {
      importAction.cancel();
      importAction.clearError();
      analyzeAction.cancel();
      analyzeAction.clearError();
    }
    setDeletingMaterialId(recent.id);
    const deleted = await deleteAction.run(async (signal) => {
      await onDeleteMaterial(recent.id, signal);
      return true;
    });
    setDeletingMaterialId(null);
    if (deleted && editingMaterialId === recent.id) cancelRename();
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>最近资料</h2>
        <p className="muted small">历史资料保存在本机 SQLite 中，可直接打开并继续学习。</p>
        {historyError ? <Banner kind="error">{historyError}</Banner> : null}
        {renameAction.error ? <Banner kind="error">重命名失败：{renameAction.error}</Banner> : null}
        {deleteAction.error ? (
          <Banner kind="error">永久删除失败：{deleteAction.error}</Banner>
        ) : null}
        {historyLoading ? (
          <Loading label="加载最近资料…" />
        ) : recentMaterials.length === 0 ? (
          historyError ? null : (
            <Banner kind="empty">暂无历史资料。导入后会显示在这里。</Banner>
          )
        ) : (
          <div className="stack">
            <div className="field">
              <label htmlFor="material-history-search">搜索历史资料</label>
              <input
                id="material-history-search"
                type="search"
                value={historyQuery}
                placeholder="按标题、显示日期时间或记录后缀搜索"
                onChange={(event) => setHistoryQuery(event.target.value)}
              />
            </div>
            {visibleHistoryMaterials.length === 0 ? (
              <Banner kind="empty">未找到匹配的历史资料。</Banner>
            ) : (
              visibleHistoryMaterials.map((recent) => {
                const current = currentMaterialId === recent.id;
                const opening = openingMaterialId === recent.id;
                const editing = editingMaterialId === recent.id;
                const suffix = recent.id.slice(-6);
                return (
                  <div key={recent.id} className="row between block-preview">
                    <div className="history-material-main">
                      {editing ? (
                        <form
                          className="history-rename-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveRename(recent);
                          }}
                        >
                          <label className="small" htmlFor={`history-title-${recent.id}`}>
                            资料标题
                          </label>
                          <div className="row">
                            <input
                              id={`history-title-${recent.id}`}
                              aria-label={`资料标题：${recent.title}`}
                              value={titleDraft}
                              maxLength={MATERIAL_TITLE_MAX_LENGTH}
                              autoFocus
                              disabled={renameAction.loading}
                              onChange={(event) => {
                                const value = event.target.value;
                                setTitleDraft(value);
                                setTitleError(
                                  value.trim().length === 0 ? '资料标题不能为空。' : null,
                                );
                              }}
                            />
                            <button
                              type="submit"
                              className="primary small"
                              disabled={
                                renameAction.loading ||
                                titleDraft.trim().length === 0 ||
                                titleDraft.trim().length > MATERIAL_TITLE_MAX_LENGTH
                              }
                            >
                              {renameAction.loading ? '保存中…' : '保存'}
                            </button>
                            <button
                              type="button"
                              className="ghost small"
                              disabled={renameAction.loading}
                              onClick={cancelRename}
                            >
                              取消
                            </button>
                          </div>
                          {titleError ? (
                            <div className="banner error small" role="alert">
                              {titleError}
                            </div>
                          ) : null}
                        </form>
                      ) : (
                        <strong>{recent.title}</strong>
                      )}
                      <div className="muted small">
                        源块 {recent.blockCount} · {recent.charCount.toLocaleString('zh-CN')} 字 ·{' '}
                        <time dateTime={recent.createdAt}>
                          {formatLocalDateTime(recent.createdAt)}
                        </time>
                        {' · '}记录 …{suffix}
                      </div>
                    </div>
                    {!editing ? (
                      <div className="row history-actions">
                        <button
                          type="button"
                          className="ghost small"
                          disabled={
                            materialOpening ||
                            importAction.loading ||
                            analyzeAction.loading ||
                            materialManagementActive ||
                            current
                          }
                          aria-label={
                            current ? `当前资料：${recent.title}` : `打开资料：${recent.title}`
                          }
                          onClick={() => onOpenMaterial(recent.id)}
                        >
                          {opening ? '打开中…' : current ? '当前资料' : '打开'}
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          disabled={
                            materialOpening || importAction.loading || materialManagementActive
                          }
                          aria-label={`重命名：${recent.title}（记录 …${suffix}）`}
                          onClick={() => startRename(recent)}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          disabled={
                            materialOpening ||
                            materialManagementActive ||
                            (importAction.loading && !current)
                          }
                          aria-label={`永久删除：${recent.title}（记录 …${suffix}）`}
                          onClick={() => void permanentlyDelete(recent, current)}
                        >
                          {deletingMaterialId === recent.id ? '删除中…' : '删除'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
            {!normalizedHistoryQuery && hasHiddenHistory ? (
              <button
                type="button"
                className="ghost"
                aria-expanded={historyExpanded}
                onClick={() => setHistoryExpanded((expanded) => !expanded)}
              >
                {historyExpanded
                  ? '收起历史资料'
                  : `查看全部历史资料（${orderedHistoryMaterials.length} 条）`}
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="card">
        <h2>导入学习资料</h2>
        <p className="muted small">
          {UPLOAD_FORMATS_TEXT}
          {UPLOAD_OCR_LIMIT_TEXT}单个文件不超过 10MB,提取文本不超过 10 万字。
        </p>
        <p className="muted small">
          学习记录保存在本机 SQLite;使用在线 Hy3
          模式时,分析、出题与简答判分所需的数据会发送到你配置的 HY3_BASE_URL。fake
          模式不会向外发送数据。
        </p>
        {importAction.error ? <Banner kind="error">{importAction.error}</Banner> : null}
        {fileError ? <Banner kind="error">{fileError}</Banner> : null}
        <div className="field">
          <label htmlFor="material-title">标题(可选)</label>
          <input
            id="material-title"
            value={title}
            maxLength={100}
            placeholder="默认取文首标题或文件名"
            disabled={materialOpening || materialManagementActive || importAction.loading}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="material-content">资料内容</label>
          <textarea
            id="material-content"
            rows={10}
            placeholder="在此粘贴学习资料(Markdown 或纯文本)……"
            value={content}
            disabled={materialOpening || materialManagementActive || importAction.loading}
            onChange={(e) => {
              setContent(e.target.value);
              setFilename(null);
              setSelectedFile(null);
            }}
          />
        </div>
        <div className="row between">
          <div className="row">
            <button
              type="button"
              disabled={materialOpening || materialManagementActive || importAction.loading}
              onClick={() => fileRef.current?.click()}
            >
              选择文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              disabled={materialOpening || materialManagementActive || importAction.loading}
              style={{ display: 'none' }}
              onChange={(e) => void onFileChange(e.target.files)}
              aria-label="选择 .md、.txt、.pdf 或 .docx 文件"
            />
            <button
              type="button"
              disabled={materialOpening || materialManagementActive || importAction.loading}
              onClick={() => void loadSample()}
            >
              载入示例资料
            </button>
            <span className="muted small">
              {selectedFile
                ? `${selectedFile.file.name}(${UPLOAD_KIND_LABELS[selectedFile.kind]},待导入)`
                : (filename ?? (content ? '(粘贴文本)' : ''))}
            </span>
            {selectedFile ? (
              <button
                type="button"
                className="ghost small"
                disabled={importAction.loading}
                onClick={removeSelectedFile}
              >
                移除文件
              </button>
            ) : null}
          </div>
          <div className="row">
            <span className="muted small">
              {selectedFile ? '导入后在服务器解析并切分' : `${content.length} 字`}
            </span>
            <button
              type="button"
              className="primary"
              disabled={
                materialOpening ||
                materialManagementActive ||
                importAction.loading ||
                (content.trim().length === 0 && !selectedFile)
              }
              onClick={() => void doImport()}
            >
              {importAction.loading ? '导入中…' : '导入并切分'}
            </button>
            {importAction.loading ? (
              <button type="button" onClick={importAction.cancel}>
                取消
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {material ? (
        <section className="card">
          <div className="row between">
            <h2>
              {material.material.title}{' '}
              <span className="pill">{material.blocks.length} 个源块</span>
            </h2>
            <div className="row">
              {concepts.length > 0 ? (
                <span className="muted small">概念已分析;重新导入资料可重置。</span>
              ) : analyzeAction.loading ? (
                <>
                  <Loading label="正在分析概念…" />
                  <button type="button" onClick={analyzeAction.cancel}>
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={materialOpening || materialManagementActive}
                  onClick={() => void doAnalyze()}
                >
                  分析核心概念
                </button>
              )}
            </div>
          </div>
          {analyzeAction.error ? <Banner kind="error">{analyzeAction.error}</Banner> : null}

          {concepts.length > 0 ? (
            <div className="stack" style={{ marginBottom: '1rem' }}>
              <h3>核心概念({concepts.length})</h3>
              {concepts.map((concept) => (
                <div key={concept.id} className="block-preview">
                  <div className="row between">
                    <strong>{concept.name}</strong>
                    <span className="pill">{IMPORTANCE_TEXT[concept.importance]}</span>
                  </div>
                  <p className="small" style={{ margin: '0.3rem 0' }}>
                    {concept.summary}
                  </p>
                  <SourceEvidencePanel grounding={concept.grounding} blocks={material.blocks} />
                </div>
              ))}
            </div>
          ) : (
            <Banner kind="empty">尚未分析概念。点击「分析核心概念」后即可生成测验。</Banner>
          )}

          <h3>源块预览</h3>
          <p className="muted small">
            资料被确定性切分为可引用的源块;出题与概念都必须引用这些原文。原始 Markdown 不会被渲染为
            HTML(防注入)。
          </p>
          {material.blocks.map((block) => (
            <div key={block.id} className="block-preview">
              <div className="heading-path">
                #{block.index}
                {block.headingPath.length > 0
                  ? ` · ${block.headingPath.join(' / ')}`
                  : ` · ${formatPageRange(block.pageNumber, block.pageEnd) ?? '(无标题)'}`}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{block.content}</div>
            </div>
          ))}
        </section>
      ) : (
        <Banner kind="empty">还没有导入资料。粘贴文本或点击「载入示例资料」开始。</Banner>
      )}
    </div>
  );
}
