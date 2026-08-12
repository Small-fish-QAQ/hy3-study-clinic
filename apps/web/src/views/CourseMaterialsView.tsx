import { useRef, useState } from 'react';
import type { DocumentSummary, MaterialRoleHistoryResponse } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import {
  UPLOAD_ACCEPT,
  UPLOAD_OCR_LIMIT_TEXT,
  fileToBase64,
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
  docx: 'DOCX',
};

export interface CourseMaterialsViewProps {
  workspaceId: string;
  documents: DocumentSummary[];
  roleHistory: Record<string, MaterialRoleHistoryResponse>;
  onChanged: () => Promise<void> | void;
  onBack: () => void;
}

/** Course-scoped material management. Revision metadata stays behind disclosure. */
export function CourseMaterialsView({
  workspaceId,
  documents,
  roleHistory,
  onChanged,
  onBack,
}: CourseMaterialsViewProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [importOpen, setImportOpen] = useState(documents.length === 0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const action = useAsyncAction();

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
    const validationError = uploadValidationError(file);
    if (validationError) {
      await action.run(async () => {
        throw new Error(validationError);
      });
      return;
    }
    const lower = file.name.toLowerCase();
    const binary = lower.endsWith('.pdf') || lower.endsWith('.docx');
    const result = await action.run(async (signal) => {
      if (binary) {
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
      <header className="supporting-page-intro row between">
        <div>
          <p className="eyebrow">课程来源</p>
          <p className="muted">
            管理教材、参考资料和练习依据。资料在课程中的用途不等于其事实依据已经独立验证。
          </p>
        </div>
        <button type="button" className="ghost" onClick={onBack}>
          返回主页
        </button>
      </header>

      {action.error ? <Banner kind="error">{action.error}</Banner> : null}

      {documents.length === 0 ? (
        <Banner kind="empty">
          这门课程还没有资料，这是新课程的正常状态。添加教材或参考资料后即可建立学习目标与课程结构。
        </Banner>
      ) : (
        <section className="material-list" aria-label={`当前课程资料，共 ${documents.length} 份`}>
          {documents.map((document) => {
            const role = roleHistory[document.id]?.current?.role ?? 'unknown';
            return (
              <article className="material-row" key={document.id}>
                <div className="material-row-main">
                  <div>
                    <h3>{document.title}</h3>
                    <p className="small muted">
                      {ROLE_LABELS[role] ?? role} ·{' '}
                      {SOURCE_LABELS[document.sourceType] ?? document.sourceType}
                      {document.pageCount ? ` · ${document.pageCount} 页` : ''}
                    </p>
                  </div>
                  <span
                    className={`pill ${document.parseStatus === 'parsed' ? 'deterministic' : ''}`}
                  >
                    {document.parseStatus === 'parsed' ? '可用于学习' : '已解析，有提示'}
                  </span>
                </div>
                {document.extractionWarnings.length > 0 ? (
                  <Banner kind="info">{document.extractionWarnings.join('；')}</Banner>
                ) : null}
                <p className="material-identity-note small muted">
                  这是课程中的同一份逻辑资料；重新解析只更新其当前处理结果，不会创建另一份课程资料。
                </p>
                <div className="row material-actions">
                  {document.sourceType === 'pdf' || document.sourceType === 'docx' ? (
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
                <details className="technical-details small">
                  <summary>当前处理版本与来源</summary>
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
        <summary>添加课程资料</summary>
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
          <p className="small muted">支持 Markdown、TXT、PDF 和 DOCX。{UPLOAD_OCR_LIMIT_TEXT}</p>
        </div>
      </details>
    </div>
  );
}
