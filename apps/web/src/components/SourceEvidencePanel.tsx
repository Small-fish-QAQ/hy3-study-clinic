import { useState } from 'react';
import type { SourceBlock, VerifiedGrounding } from '@hy3-clinic/shared';
import { formatPageRange } from './ui.js';

export interface SourceEvidencePanelProps {
  grounding: VerifiedGrounding;
  /** All blocks of the current material, to locate the cited block. */
  blocks: SourceBlock[];
  /** Initially expanded (used in results view). */
  defaultOpen?: boolean;
}

/**
 * 原文依据面板:展示题目/概念引用的源块,并高亮服务器验证过的引文。
 *
 * The quote span comes from server-side verification (offsets computed by
 * the server, never by the model). Rendering slices the block text and wraps
 * the quote in <mark> — plain text only, React escapes everything, and no
 * HTML in the source is ever interpreted.
 */
export function SourceEvidencePanel({
  grounding,
  blocks,
  defaultOpen = false,
}: SourceEvidencePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const block = blocks.find((b) => b.id === grounding.blockId);
  const panelId = `evidence-${grounding.blockId}-${grounding.startOffset}-${grounding.endOffset}`;

  if (!open) {
    return (
      <button
        type="button"
        className="ghost small"
        aria-expanded={false}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
      >
        查看原文依据
      </button>
    );
  }

  if (!block) {
    return (
      <div className="evidence" id={panelId}>
        <div className="evidence-head">
          <span>原文依据</span>
          <button
            type="button"
            className="ghost small"
            aria-expanded
            aria-controls={panelId}
            onClick={() => setOpen(false)}
          >
            收起
          </button>
        </div>
        <p className="quote">「{grounding.quote}」</p>
        <p className="context small">(未加载所在源块,仅显示引文)</p>
      </div>
    );
  }

  const before = block.content.slice(0, grounding.startOffset);
  const quote = block.content.slice(grounding.startOffset, grounding.endOffset);
  const after = block.content.slice(grounding.endOffset);
  // Provenance shown beside the title: heading path (Markdown/DOCX/PDF)
  // and/or page range (PDF) — same wording as the graph inspector's cards.
  const location = [
    block.headingPath.join(' / '),
    formatPageRange(block.pageNumber, block.pageEnd) ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="evidence" id={panelId}>
      <div className="evidence-head">
        <span>
          原文依据{location ? ` · ${location}` : ''}
          {grounding.reanchored ? '(已自动校正到正确源块)' : ''}
          {grounding.occurrenceCount > 1
            ? `(该引文在源块中出现 ${grounding.occurrenceCount} 次,高亮第一处)`
            : ''}
        </span>
        <button
          type="button"
          className="ghost small"
          aria-expanded
          aria-controls={panelId}
          onClick={() => setOpen(false)}
        >
          收起
        </button>
      </div>
      <p className="quote" style={{ whiteSpace: 'pre-wrap' }}>
        <span className="context">{before}</span>
        <mark>{quote}</mark>
        <span className="context">{after}</span>
      </p>
    </div>
  );
}
