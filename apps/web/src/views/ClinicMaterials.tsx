import { useRef, useState } from 'react';
import type { ClinicMaterialSummary } from '../clinicApi.js';
import { friendlyFilename, MATERIAL_FORMATS, MATERIAL_LIMITS } from '../materialPresentation.js';

const sourceLabel: Record<string, string> = {
  paste: '粘贴文本',
  md: 'Markdown',
  txt: 'TXT',
  pdf: 'PDF',
  docx: 'DOCX',
  pptx: 'PPTX',
  html: 'HTML',
  source_code: '源码',
};
export function materialTitle(material: ClinicMaterialSummary) {
  return material.filename && material.title === material.filename
    ? friendlyFilename(material.filename)
    : material.title;
}
export function ClinicMaterials({
  materials,
  busy,
  hasPlan,
  onBack,
  onImport,
  onRename,
  onRemove,
}: {
  materials: ClinicMaterialSummary[];
  busy: boolean;
  hasPlan: boolean;
  onBack: () => void;
  onImport: (input: { file?: File; content?: string; title: string }) => Promise<boolean>;
  onRename: (id: string, title: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [open, setOpen] = useState(materials.length === 0);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  async function submit() {
    const ok = await onImport({ ...(mode === 'file' ? { file: file! } : { content }), title });
    if (!ok) return;
    setFile(null);
    setContent('');
    setTitle('');
    setOpen(false);
    setMessage('资料已导入，可以继续准备课程。');
    if (inputRef.current) inputRef.current.value = '';
  }
  return (
    <div className="course-materials clinic-materials-view stack" aria-label="课程资料管理">
      <header className="supporting-page-intro course-page-intro material-page-intro row between">
        <div className="material-page-heading">
          <p className="eyebrow">教材与讲义</p>
          <h1>课程资料</h1>
          <p className="muted">添加与管理这门课程的学习资料。</p>
        </div>
        <div className="material-page-actions">
          <span className="material-count">{materials.length} 份资料</span>
          <button className="ghost" onClick={onBack}>
            返回课程
          </button>
        </div>
      </header>
      {message && (
        <p className="material-feedback" role="status">
          {message}
        </p>
      )}
      {materials.length > 0 && (
        <section className="material-list" aria-label="当前课程资料">
          {materials.map((material) => (
            <article className="material-row" key={material.id}>
              <div className="material-row-layout">
                <span className="material-source-mark" aria-hidden="true">
                  {material.sourceType === 'paste'
                    ? 'TXT'
                    : (material.sourceType === 'source_code'
                        ? 'CODE'
                        : (material.sourceType ?? 'TXT')
                      ).toUpperCase()}
                </span>
                <div className="material-row-content">
                  <div className="material-row-main">
                    <div className="material-row-title">
                      {editing === material.id ? (
                        <form
                          className="material-title-editor"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void onRename(material.id, titleDraft.trim()).then((ok) => {
                              if (ok) {
                                setEditing(null);
                                setMessage('阅读标题已保存，原始文件与引用保持不变。');
                              }
                            });
                          }}
                        >
                          <label>
                            阅读标题
                            <input
                              autoFocus
                              value={titleDraft}
                              disabled={busy}
                              onChange={(e) => setTitleDraft(e.target.value)}
                            />
                          </label>
                          <div className="row">
                            <button className="primary" disabled={busy || !titleDraft.trim()}>
                              保存标题
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy}
                              onClick={() => setEditing(null)}
                            >
                              取消编辑
                            </button>
                          </div>
                        </form>
                      ) : (
                        <h3>{materialTitle(material)}</h3>
                      )}
                      <p className="material-row-meta small muted">
                        <span>{sourceLabel[material.sourceType ?? 'paste'] ?? '资料'}</span>
                        {!!material.pageCount && (
                          <span>
                            {material.pageCount}{' '}
                            {material.sourceType === 'pptx' ? '页幻灯片' : '页'}
                          </span>
                        )}
                        {material.blockCount !== undefined && (
                          <span>{material.blockCount} 个引用片段</span>
                        )}
                      </p>
                    </div>
                    <span
                      className={`pill material-status ${material.warnings.length ? 'attention' : 'deterministic'}`}
                    >
                      {material.warnings.length ? '已解析，请留意提示' : '可用于准备课程'}
                    </span>
                  </div>
                  {material.warnings.map((warning, i) => (
                    <p className="banner info" key={i}>
                      {warning}
                    </p>
                  ))}
                  <div className="material-row-footer">
                    <details className="technical-details material-provenance small">
                      <summary>处理版本与来源</summary>
                      <p className="material-identity-note muted">
                        阅读标题便于识别资料。原始文件名与来源身份单独保留，修改标题不会改变教材内容。
                      </p>
                      <dl>
                        <div>
                          <dt>原始文件名</dt>
                          <dd>{material.filename ?? '粘贴文本'}</dd>
                        </div>
                        {material.charCount !== undefined && (
                          <div>
                            <dt>内容规模</dt>
                            <dd>{material.charCount.toLocaleString('zh-CN')} 字</dd>
                          </div>
                        )}
                        {material.parserVersion && (
                          <div>
                            <dt>解析器</dt>
                            <dd>{material.parserVersion}</dd>
                          </div>
                        )}
                        <div>
                          <dt>资料 ID</dt>
                          <dd>{material.id}</dd>
                        </div>
                        <div>
                          <dt>来源版本</dt>
                          <dd>{material.revisionId}</dd>
                        </div>
                        {material.createdAt && (
                          <div>
                            <dt>导入时间</dt>
                            <dd>
                              <time dateTime={material.createdAt}>
                                {new Date(material.createdAt).toLocaleString('zh-CN')}
                              </time>
                            </dd>
                          </div>
                        )}
                      </dl>
                    </details>
                    <div className="row material-actions">
                      <button
                        className="ghost"
                        disabled={busy || editing !== null}
                        onClick={() => {
                          setEditing(material.id);
                          setTitleDraft(materialTitle(material));
                        }}
                      >
                        编辑标题
                      </button>
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() => setRemoving(material.id)}
                      >
                        从课程中移除
                      </button>
                    </div>
                  </div>
                  {removing === material.id && (
                    <div
                      className="material-remove-confirm"
                      role="group"
                      aria-label={`移除${materialTitle(material)}`}
                    >
                      <p>
                        移除后，后续课程准备将不再使用这份资料。已有学习记录会保留；当前规划的来源范围会改变。
                      </p>
                      <div className="row">
                        <button
                          disabled={busy}
                          className="danger"
                          onClick={() =>
                            void onRemove(material.id).then((ok) => {
                              if (ok) {
                                setRemoving(null);
                                setMessage('资料已移出课程，学习历史仍保留。');
                              }
                            })
                          }
                        >
                          确认移出课程
                        </button>
                        <button disabled={busy} className="ghost" onClick={() => setRemoving(null)}>
                          保留资料
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
      <details
        className="material-import"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          <span>添加课程资料</span>
          <small>上传文件或粘贴文本</small>
        </summary>
        <form
          className="material-import-content"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="material-import-modes" role="group" aria-label="资料导入方式">
            <button
              type="button"
              aria-pressed={mode === 'file'}
              onClick={() => {
                setMode('file');
                setTitle(file ? friendlyFilename(file.name) : '');
              }}
            >
              上传文件
            </button>
            <button
              type="button"
              aria-pressed={mode === 'text'}
              onClick={() => {
                setMode('text');
                setTitle('');
              }}
            >
              粘贴文本
            </button>
          </div>
          {mode === 'file' ? (
            <div className="material-upload-area">
              <label className="file-upload">
                <input
                  ref={inputRef}
                  type="file"
                  aria-label="上传教材或讲义"
                  accept=".md,.txt,.pdf,.docx,.pptx,.html,.htm,.js,.jsx,.ts,.tsx,.py,.cpp,.c,.h,.java,.go,.rs,.rb,.cs,.sql,.sh,.json,.yaml,.yml"
                  disabled={busy}
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    if (selected) {
                      setFile(selected);
                      setTitle(friendlyFilename(selected.name));
                      setMessage('');
                    }
                  }}
                />
                选择教材或讲义
              </label>
              <p className="small muted">
                {file
                  ? `${file.name} · ${(file.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`
                  : MATERIAL_FORMATS}
              </p>
            </div>
          ) : (
            <label className="material-text-input">
              正文
              <textarea
                rows={6}
                disabled={busy}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="粘贴 Markdown 或完整讲义正文"
              />
            </label>
          )}
          <label className="material-reading-title">
            阅读标题（可选）
            <input
              aria-label="阅读标题（可选）"
              aria-describedby="material-reading-title-help"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：用户访谈 · 教材与案例"
            />
            <small className="muted" id="material-reading-title-help">
              阅读标题便于辨认；原始文件名始终保留。留空则从正文提取标题。
            </small>
          </label>
          <div className="row material-import-actions">
            <button
              className="primary"
              disabled={busy || (mode === 'file' ? !file : !content.trim())}
            >
              {busy ? '正在导入与解析…' : '导入资料'}
            </button>
            <span className="small muted">导入后再准备课程，不会自动开始生成。</span>
          </div>
          <p className="small muted">{MATERIAL_LIMITS}</p>
        </form>
      </details>
      <footer className="material-next-step">
        <p>
          {hasPlan
            ? '资料范围改变后，可重新准备完整规划。历史课程与学习记录保留。'
            : '资料准备好了，就来选择学习深度和特别关注的内容。'}
        </p>
        <button className="primary" disabled={busy || !materials.length} onClick={onBack}>
          {hasPlan ? '查看课程与准备设置' : '继续准备课程'}
          <img src="/icons/tabler/arrow-right.svg" width="18" height="18" alt="" />
        </button>
      </footer>
    </div>
  );
}
