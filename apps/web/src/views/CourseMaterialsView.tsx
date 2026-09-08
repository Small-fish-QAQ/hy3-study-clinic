import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentSummary, MaterialRoleHistoryResponse } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import {
  UPLOAD_ACCEPT,
  UPLOAD_FORMATS_TEXT,
  UPLOAD_OCR_LIMIT_TEXT,
  fileToBase64,
  isBinaryUploadKind,
  uploadKindOf,
  uploadValidationError,
} from '../upload.js';

const ROLE_LABELS: Record<string, string> = {
  course_material: '教材',
  supplementary_reference: '参考资料',
  past_exam: '往年试题',
  exercise_sheet: '练习材料',
  question_set: '题目集',
  excluded: '不纳入本轮学习',
  unknown: '尚未确认用途',
};

const SOURCE_LABELS: Record<string, string> = {
  paste: '粘贴文本',
  md: 'Markdown',
  txt: 'TXT',
  pdf: 'PDF',
  pptx: 'PPTX',
  docx: 'DOCX',
};

export interface CourseMaterialsViewProps {
  workspaceId: string;
  documents: DocumentSummary[];
  roleHistory: Record<string, MaterialRoleHistoryResponse>;
  focusDocumentId?: string | null;
  onChanged: () => Promise<void> | void;
  onBack: () => void;
}

/** Course-scoped material management. Revision metadata stays behind disclosure. */
export function CourseMaterialsView({
  workspaceId,
  documents,
  roleHistory,
  focusDocumentId = null,
  onChanged,
  onBack,
}: CourseMaterialsViewProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [importOpen, setImportOpen] = useState(documents.length === 0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const action = useAsyncAction();
  const cancelAction = action.cancel;
  const clearActionError = action.clearError;
  const idPrefix = useId().replace(/:/g, '');

  useEffect(() => {
    cancelAction();
    clearActionError();
  }, [cancelAction, clearActionError, workspaceId]);

  useEffect(() => {
    if (!focusDocumentId) return;
    const element = window.document.getElementById(
      `${idPrefix}-material-${encodeURIComponent(focusDocumentId)}`,
    );
    element?.scrollIntoView({ block: 'center' });
    element?.focus({ preventScroll: true });
  }, [focusDocumentId, idPrefix]);

  async function addText(): Promise<void> {
    const normalized = content.trim();
    if (!normalized) return;
    const result = await action.run((signal) =>
      api.addDocument(
        workspaceId,
        { kind: 'text', content: normalized, ...(title.trim() ? { title: title.trim() } : {}) },
        signal,
      ),
    );
    if (!result) return;
    setContent('');
    setTitle('');
    await onChanged();
  }

  async function addFile(file: File): Promise<void> {
    const kind = uploadKindOf(file.name);
    const validationError = uploadValidationError(file);
    if (validationError || kind === null) {
      await action.run(async () => {
        throw new Error(validationError ?? '不支持的文件类型。');
      });
      return;
    }
    const result = await action.run(async (signal) => {
      if (isBinaryUploadKind(kind)) {
        const dataBase64 = await fileToBase64(file);
        return api.addDocument(
          workspaceId,
          { kind: 'file', filename: file.name, dataBase64 },
          signal,
        );
      }
      return api.addDocument(
        workspaceId,
        { kind: 'text', filename: file.name, content: await file.text() },
        signal,
      );
    });
    if (result) await onChanged();
  }

  async function reprocess(document: DocumentSummary): Promise<void> {
    const result = await action.run((signal) =>
      api.reprocessDocument(workspaceId, document.id, signal),
    );
    if (result) await onChanged();
  }

  async function retire(document: DocumentSummary): Promise<void> {
    if (
      !window.confirm(
        `从课程中移除「${document.title}」？\n\n历史学习记录会保留，但该资料及其当前提取结果将不再用于后续学习。`,
      )
    )
      return;
    const result = await action.run((signal) =>
      api.deleteDocument(workspaceId, document.id, signal),
    );
    if (result) await onChanged();
  }

  return (
    <div className="course-materials stack" aria-label="课程资料">
      <header className="supporting-page-intro course-page-intro material-page-intro row between">
        <div className="material-page-heading">
          <p className="eyebrow">学习所依据的内容</p>
          <h2>每一步理解，都有来处。</h2>
          <p className="muted">
            在这里管理教材、参考资料和练习内容。资料用途不等于其中的事实已经独立验证。
          </p>
        </div>
        <div className="material-page-actions">
          <span className="material-count" aria-label={`当前共有 ${documents.length} 份课程资料`}>
            {documents.length} 份资料
          </span>
          <button type="button" className="ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </header>

      {action.error ? <Banner kind="error">{action.error}</Banner> : null}

      {documents.length === 0 ? (
        <section className="course-empty-state material-empty-state" aria-label="还没有课程资料">
          <img
            className="studio-empty-mark"
            src="/brand/understanding-pine.png"
            alt=""
            width="48"
            height="48"
          />
          <strong>这门课程还没有资料，这是新课程的正常状态。</strong>
          <p>从下方添加教材或参考资料后，就可以选择全局深度并建立课程结构。</p>
        </section>
      ) : (
        <section className="material-list" aria-label={`当前课程资料，共 ${documents.length} 份`}>
          {documents.map((document) => {
            const role = roleHistory[document.id]?.current?.role ?? 'unknown';
            const sourceLabel = SOURCE_LABELS[document.sourceType] ?? document.sourceType;
            return (
              <article
                id={`${idPrefix}-material-${encodeURIComponent(document.id)}`}
                className={`material-row${focusDocumentId === document.id ? ' is-source-target' : ''}`}
                key={document.id}
                tabIndex={focusDocumentId === document.id ? -1 : undefined}
              >
                <div className="material-row-layout">
                  <span className="material-source-mark" aria-hidden="true">
                    {document.sourceType === 'paste' ? 'TXT' : document.sourceType.toUpperCase()}
                  </span>
                  <div className="material-row-content">
                    <div className="material-row-main">
                      <div className="material-row-title">
                        <h3>{document.title}</h3>
                        <p className="material-row-meta small muted">
                          <span>{ROLE_LABELS[role] ?? role}</span>
                          <span>{sourceLabel}</span>
                          {document.pageCount ? <span>{document.pageCount} 页</span> : null}
                          <span>{document.blockCount} 个引用片段</span>
                        </p>
                      </div>
                      <span
                        className={`pill material-status ${document.parseStatus === 'parsed' ? 'deterministic' : 'attention'}`}
                      >
                        {document.parseStatus === 'parsed' ? '可用于学习' : '已解析，有提示'}
                      </span>
                    </div>
                    {document.extractionWarnings.length > 0 ? (
                      <Banner kind="info">{document.extractionWarnings.join('；')}</Banner>
                    ) : null}
                    <div className="material-row-footer">
                      <details className="technical-details material-provenance small">
                        <summary>处理版本与来源</summary>
                        <p className="material-identity-note muted">
                          这是课程中的同一份逻辑资料；重新解析只更新其当前处理结果，不会创建另一份课程资料。
                        </p>
                        <dl>
                          <div>
                            <dt>当前解析器</dt>
                            <dd>{document.parserVersion ?? '历史版本未记录'}</dd>
                          </div>
                          <div>
                            <dt>内容规模</dt>
                            <dd>{document.charCount.toLocaleString('zh-CN')} 字</dd>
                          </div>
                          <div>
                            <dt>引用片段</dt>
                            <dd>{document.blockCount} 段</dd>
                          </div>
                          <div>
                            <dt>逻辑资料 ID</dt>
                            <dd>{document.id}</dd>
                          </div>
                          <div>
                            <dt>当前处理时间</dt>
                            <dd>
                              <time dateTime={document.updatedAt}>
                                {new Date(document.updatedAt).toLocaleString('zh-CN')}
                              </time>
                            </dd>
                          </div>
                        </dl>
                      </details>
                      <div className="row material-actions">
                        {document.sourceType === 'pdf' ||
                        document.sourceType === 'pptx' ||
                        document.sourceType === 'docx' ? (
                          <button
                            type="button"
                            disabled={action.loading}
                            onClick={() => void reprocess(document)}
                          >
                            重新解析
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ghost danger"
                          disabled={action.loading}
                          onClick={() => void retire(document)}
                        >
                          从课程中移除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      <details
        className="material-import"
        open={importOpen}
        onToggle={(event) => setImportOpen(event.currentTarget.open)}
      >
        <summary>
          <span>添加课程资料</span>
          <small>上传文件或粘贴文本</small>
        </summary>
        <div className="material-import-content" aria-label="添加课程资料">
          <div className="material-import-grid">
            <label>
              标题（可选）
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="span-2">
              粘贴文本
              <textarea
                rows={5}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="粘贴 Markdown 或纯文本"
              />
            </label>
          </div>
          <div className="row material-import-actions">
            <button
              type="button"
              className="primary"
              disabled={action.loading || content.trim().length === 0}
              onClick={() => void addText()}
            >
              添加文本资料
            </button>
            <label className="file-upload">
              <input
                ref={fileRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                disabled={action.loading}
                aria-label="上传课程资料"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void addFile(file);
                  if (fileRef.current) fileRef.current.value = '';
                }}
              />
              上传文件
            </label>
            {action.loading ? (
              <>
                <Loading label="正在处理课程资料…" />
                <button type="button" onClick={action.cancel}>
                  取消
                </button>
              </>
            ) : null}
          </div>
          <p className="small muted">
            {UPLOAD_FORMATS_TEXT}
            {UPLOAD_OCR_LIMIT_TEXT}
          </p>
        </div>
      </details>
    </div>
  );
}
