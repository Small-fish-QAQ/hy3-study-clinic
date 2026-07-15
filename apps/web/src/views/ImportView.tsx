import { useRef, useState } from 'react';
import type { Concept } from '@hy3-clinic/shared';
import { api, type MaterialWithBlocks } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { SourceEvidencePanel } from '../components/SourceEvidencePanel.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface ImportViewProps {
  material: MaterialWithBlocks | null;
  concepts: Concept[];
  onImported: (material: MaterialWithBlocks) => void;
  onAnalyzed: (concepts: Concept[]) => void;
}

const IMPORTANCE_TEXT: Record<Concept['importance'], string> = {
  high: '核心',
  medium: '重要',
  low: '了解',
};

/** 学习资料导入与预览视图(Flow A 第一步)。 */
export function ImportView({ material, concepts, onImported, onAnalyzed }: ImportViewProps) {
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importAction = useAsyncAction();
  const analyzeAction = useAsyncAction();

  async function loadSample() {
    setFileError(null);
    const sample = await importAction.run(() => api.sampleMaterial());
    if (sample) {
      setContent(sample.content);
      setFilename(sample.filename);
    }
  }

  async function onFileChange(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown') && !lower.endsWith('.txt')) {
      setFileError('仅支持 .md 与 .txt 文件。');
      return;
    }
    setFileError(null);
    const text = await file.text();
    setContent(text);
    setFilename(file.name);
  }

  async function doImport() {
    setFileError(null);
    const payload: { content: string; filename?: string } = { content };
    if (filename) payload.filename = filename;
    const imported = await importAction.run(() => api.importMaterial(payload));
    if (imported) onImported(imported);
  }

  async function doAnalyze() {
    if (!material) return;
    const result = await analyzeAction.run((signal) => api.analyze(material.material.id, signal));
    if (result) onAnalyzed(result.concepts);
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>导入学习资料</h2>
        <p className="muted small">
          支持粘贴文本或选择 .md / .txt 文件(≤10 万字)。学习记录保存在本机 SQLite;使用在线 Hy3
          模式时,分析、出题与简答判分所需的数据会发送到你配置的 HY3_BASE_URL。fake
          模式不会向外发送数据。
        </p>
        {importAction.error ? <Banner kind="error">{importAction.error}</Banner> : null}
        {fileError ? <Banner kind="error">{fileError}</Banner> : null}
        <div className="field">
          <label htmlFor="material-content">资料内容</label>
          <textarea
            id="material-content"
            rows={10}
            placeholder="在此粘贴学习资料(Markdown 或纯文本)……"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setFilename(null);
            }}
          />
        </div>
        <div className="row between">
          <div className="row">
            <button type="button" onClick={() => fileRef.current?.click()}>
              选择文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.txt"
              style={{ display: 'none' }}
              onChange={(e) => void onFileChange(e.target.files)}
              aria-label="选择 .md 或 .txt 文件"
            />
            <button type="button" onClick={() => void loadSample()}>
              载入示例资料
            </button>
            <span className="muted small">{filename ?? (content ? '(粘贴文本)' : '')}</span>
          </div>
          <div className="row">
            <span className="muted small">{content.length} 字</span>
            <button
              type="button"
              className="primary"
              disabled={importAction.loading || content.trim().length === 0}
              onClick={() => void doImport()}
            >
              {importAction.loading ? '导入中…' : '导入并切分'}
            </button>
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
                <button type="button" className="primary" onClick={() => void doAnalyze()}>
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
                  : ' · (无标题)'}
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
