import { useEffect, useState, type RefObject } from 'react';
import type { CourseLessonContent, CourseTutorAnchor } from '@hy3-clinic/shared';

export function useLessonSelection(
  ref: RefObject<HTMLElement | null>,
  content?: CourseLessonContent,
) {
  const [selection, setSelection] = useState<{
    anchor: CourseTutorAnchor;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    setSelection(null);
    if (!content) return;
    let frame = 0;
    const capture = () => {
      const selected = window.getSelection();
      const article = ref.current;
      const text = selected?.toString().trim() ?? '';
      if (
        !article ||
        !selected?.rangeCount ||
        selected.isCollapsed ||
        text.length < 2 ||
        text.length > 1800
      ) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      const parent = (node: Node) => (node instanceof Element ? node : node.parentElement);
      const start = parent(range.startContainer)?.closest<HTMLElement>('[data-tutor-segment]');
      const end = parent(range.endContainer)?.closest<HTMLElement>('[data-tutor-segment]');
      if (
        !start ||
        !end ||
        !article.contains(start) ||
        !article.contains(end) ||
        !parent(range.startContainer)?.closest('.study-rich-text') ||
        !parent(range.endContainer)?.closest('.study-rich-text')
      ) {
        setSelection(null);
        return;
      }
      const all = Array.from(article.querySelectorAll<HTMLElement>('[data-tutor-segment]'));
      const segments = all.slice(all.indexOf(start), all.indexOf(end) + 1);
      const segmentIds = segments.map((el) => el.dataset.tutorSegment!);
      // Cross-paragraph selection excludes labels, source notes and interaction
      // controls; the quote remains precisely the displayed teaching prose.
      const quote = segments
        .flatMap((segment) =>
          Array.from(segment.querySelectorAll('.study-rich-text')).flatMap((body) => {
            if (!range.intersectsNode(body)) return [];
            const part = document.createRange();
            part.selectNodeContents(body);
            if (body.contains(range.startContainer))
              part.setStart(range.startContainer, range.startOffset);
            if (body.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
            return [part.toString().trim()];
          }),
        )
        .filter(Boolean)
        .join(' ');
      if (!quote || quote.length > 1800) {
        setSelection(null);
        return;
      }
      const scroll = article.closest('.study-session-learning-stack')?.getBoundingClientRect();
      const top = Math.max(0, scroll?.top ?? 0),
        bottom = Math.min(window.innerHeight, scroll?.bottom ?? window.innerHeight);
      const rect = Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.bottom > top && r.top < bottom)
        .at(-1);
      if (!rect) {
        setSelection(null);
        return;
      }
      setSelection({
        anchor: { lessonVersionId: content.id, segmentIds, selectedText: quote },
        x: Math.max(12, Math.min(window.innerWidth - 152, rect.left)),
        y: rect.bottom + 50 < bottom ? rect.bottom + 8 : Math.max(top + 4, rect.top - 46),
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(capture);
    };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (ref.current) observer?.observe(ref.current);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [content, ref]);
  return selection;
}
