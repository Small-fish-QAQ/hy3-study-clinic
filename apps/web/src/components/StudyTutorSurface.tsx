import { useEffect, useRef, type ReactNode } from 'react';

export function StudyTutorSurface({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const surface = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const node = surface.current!;
    const returnTo = document.activeElement as HTMLElement | null;
    const query = window.matchMedia?.('(max-width: 1100px)');
    const study = node.closest('.study-session');
    const siblings = [
      study?.querySelector('.study-session-header'),
      study?.querySelector('.study-session-learning-stack'),
    ];
    const update = () => {
      if (query?.matches) {
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-modal', 'true');
        siblings.forEach((sibling) => sibling?.setAttribute('inert', ''));
      } else {
        node.setAttribute('role', 'complementary');
        node.removeAttribute('aria-modal');
        siblings.forEach((sibling) => sibling?.removeAttribute('inert'));
      }
    };
    update();
    query?.addEventListener?.('change', update);
    const frame = requestAnimationFrame(() =>
      node.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab' && query?.matches) {
        const controls = [
          ...node.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    node.addEventListener('keydown', keydown);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener('keydown', keydown);
      query?.removeEventListener?.('change', update);
      siblings.forEach((sibling) => sibling?.removeAttribute('inert'));
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <>
      <button
        className="study-tutor-backdrop"
        aria-label="收起 Tutor"
        onClick={onClose}
        tabIndex={-1}
      />
      <aside
        ref={surface}
        className="study-tutor-secondary"
        aria-label="Tutor 辅助"
        id="study-tutor"
      >
        {children}
      </aside>
    </>
  );
}
