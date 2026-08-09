import { useEffect, useRef, useState } from 'react';
import type {
  ConceptLesson,
  DocumentSummary,
  LessonDirective,
  LessonSectionKind,
  SourceBlock,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { SourceEvidencePanel } from './SourceEvidencePanel.js';
import { Banner, Loading } from './ui.js';
import { useAsyncAction } from './useAsyncAction.js';

const SECTION_TEXT: Record<LessonSectionKind, string> = {
  explanation: '概念讲解',
  intuition: '直观理解',
  worked_example: '例子演练',
  misconception_warning: '常见误区',
  contrast: '对比辨析',
  application: '实际应用',
};

const DIRECTIVES: Array<{ key: LessonDirective; label: string }> = [
  { key: 'more_intuitive', label: '更直观' },
  { key: 'more_examples', label: '更多例子' },
  { key: 'deeper', label: '更深入' },
];

export interface LessonCardProps {
  workspaceId: string;
  conceptId: string;
  conceptName: string;
  blocks: SourceBlock[];
  documents: DocumentSummary[];
}

/**
 * 讲解卡片 — the teaching-enrichment surface.
 *
 * Provenance is SEGMENT-level and server-decided: a segment carrying a
 * verified anchor renders as 课程资料/本地已验证 with its expandable source
 * quote; a segment without one renders as AI 辅助讲解(非资料原文). The card
 * never claims AI teaching is source text, and reading or regenerating it
 * changes no learning state.
 */
export function LessonCard({
  workspaceId,
  conceptId,
  conceptName,
  blocks,
  documents,
}: LessonCardProps) {
  const [lesson, setLesson] = useState<ConceptLesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generateAction = useAsyncAction();
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    setLesson(null);
    setLoading(true);
    setLoadError(null);
    generateAction.cancel();
    generateAction.clearError();
    void api
      .getLesson(workspaceId, conceptId)
      .then((result) => {
        if (epochRef.current !== epoch) return;
        setLesson(result.lesson);
      })
      .catch((error: unknown) => {
        if (epochRef.current !== epoch) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoading(false);
      });
    return () => {
      epochRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, conceptId]);

  async function handleGenerate(directive?: LessonDirective) {
    const epoch = epochRef.current;
    const result = await generateAction.run((signal) =>
      api.generateLesson(workspaceId, conceptId, directive, signal),
    );
    if (result && epochRef.current === epoch) {
      setLesson(result.lesson);
    }
  }

  return (
    <section aria-label={`讲解卡片:${conceptName}`}>
      <h4>讲解卡片</h4>
      <p className="small muted">
        AI
        可以运用模型自身的知识来讲解课程已确认的概念。讲解不是上传资料的原文,也不会成为判分依据;标注为「本地已验证」的引文除外。
      </p>
      {loading ? <Loading label="加载讲解…" /> : null}
      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {generateAction.error ? <Banner kind="error">{generateAction.error}</Banner> : null}

      {!loading && !generateAction.loading ? (
        <p className="lesson-actions">
          <button
            type="button"
            className={lesson ? 'ghost small' : 'primary'}
            onClick={() => void handleGenerate()}
          >
            {lesson ? '重新生成讲解' : '生成讲解卡片'}
          </button>
          {lesson
            ? DIRECTIVES.map((directive) => (
                <button
                  key={directive.key}
                  type="button"
                  className="ghost small"
                  onClick={() => void handleGenerate(directive.key)}
                >
                  {directive.label}
                </button>
              ))
            : null}
        </p>
      ) : null}
      {generateAction.loading ? (
        <p>
          <Loading label="Hy3 正在撰写讲解…" />{' '}
          <button type="button" className="ghost small" onClick={generateAction.cancel}>
            取消
          </button>
        </p>
      ) : null}

      {lesson ? (
        <div className="lesson-card">
          {lesson.content.sections.map((section, sectionIndex) => (
            <section
              key={`${section.kind}-${sectionIndex}`}
              aria-label={SECTION_TEXT[section.kind]}
            >
              <h5>{SECTION_TEXT[section.kind]}</h5>
              {section.segments.map((segment, segmentIndex) => (
                <div key={segmentIndex} className="lesson-segment">
                  <p>
                    {segment.anchor ? (
                      <span className="pill deterministic">课程资料 · 本地已验证</span>
                    ) : (
                      <span className="pill model">AI 辅助讲解(非资料原文)</span>
                    )}{' '}
                    {segment.text}
                  </p>
                  {segment.anchor ? (
                    <SourceEvidencePanel grounding={segment.anchor} blocks={blocks} />
                  ) : null}
                </div>
              ))}
            </section>
          ))}

          {lesson.conflicts.length > 0 ? (
            <section aria-label="资料与常见表述不同">
              <h5>资料与常见表述不同</h5>
              <p className="small muted">课程考核以资料为准。</p>
              {lesson.conflicts.map((conflict, index) => (
                <div key={index} className="lesson-conflict">
                  <p>
                    <span className="pill model">常见表述</span> {conflict.claim}
                  </p>
                  <p className="small">
                    <span className="pill deterministic">资料原文 · 本地已验证</span>
                  </p>
                  <SourceEvidencePanel grounding={conflict.sourceQuote} blocks={blocks} />
                </div>
              ))}
            </section>
          ) : null}

          <p className="small muted">
            出处文档:
            {[
              ...new Set(
                lesson.content.sections
                  .flatMap((s) => s.segments)
                  .filter((s) => s.anchor)
                  .map((s) => {
                    const block = blocks.find((b) => b.id === s.anchor!.blockId);
                    return block
                      ? (documents.find((d) => d.id === block.materialId)?.title ?? null)
                      : null;
                  })
                  .filter((title): title is string => title !== null),
              ),
            ].join('、') || '(本卡片没有已验证的原文引文)'}
          </p>
        </div>
      ) : null}
      {!loading && !lesson && !generateAction.loading ? (
        <p className="small muted">
          还没有讲解卡片。生成后,这里会按「课程资料/本地已验证」与「AI
          辅助讲解(非资料原文)」逐段标注内容来源。
        </p>
      ) : null}
    </section>
  );
}
