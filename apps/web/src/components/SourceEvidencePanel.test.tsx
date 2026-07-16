import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceEvidencePanel } from './SourceEvidencePanel';
import { blocks, concepts } from '../test/fixtures';

afterEach(() => vi.restoreAllMocks());

describe('SourceEvidencePanel', () => {
  it('is collapsed by default and expands on click', async () => {
    const user = userEvent.setup();
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} />);

    expect(screen.queryByText(/记忆的三种类型/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看原文依据' }));
    expect(screen.getByText(/记忆的三种类型/)).toBeInTheDocument();
  });

  it('highlights exactly the verified quote via <mark>', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} defaultOpen />);
    const mark = document.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('工作记忆的容量十分有限');
  });

  it('does not render source markdown as HTML (injection-safe)', () => {
    const evilBlocks = [
      { ...blocks[0]!, content: '<img src=x onerror=alert(1)> 工作记忆的容量十分有限' },
    ];
    const grounding = {
      ...concepts[0]!.grounding,
      startOffset: evilBlocks[0]!.content.indexOf('工作记忆的容量十分有限'),
      endOffset:
        evilBlocks[0]!.content.indexOf('工作记忆的容量十分有限') + '工作记忆的容量十分有限'.length,
    };
    render(<SourceEvidencePanel grounding={grounding} blocks={evilBlocks} defaultOpen />);
    // The <img> is text, not an element.
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/onerror=alert/)).toBeInTheDocument();
  });

  it('shows a re-anchor note when grounding was corrected', () => {
    render(
      <SourceEvidencePanel
        grounding={{ ...concepts[0]!.grounding, reanchored: true }}
        blocks={blocks}
        defaultOpen
      />,
    );
    expect(screen.getByText(/已自动校正到正确源块/)).toBeInTheDocument();
  });

  it('exposes collapsed state and aria-expanded/aria-controls before interaction', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} />);
    const toggle = screen.getByRole('button', { name: '查看原文依据' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // No evidence panel is rendered while collapsed.
    expect(document.getElementById(controls!)).toBeNull();
  });

  it('flips aria-expanded and reveals a panel with a matching id on open', async () => {
    const user = userEvent.setup();
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} />);

    expect(screen.getByRole('button', { name: '查看原文依据' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await user.click(screen.getByRole('button', { name: '查看原文依据' }));
    // Re-query: the collapsed and expanded states render distinct button nodes.
    const openToggle = screen.getByRole('button', { name: '收起' });
    expect(openToggle).toHaveAttribute('aria-expanded', 'true');
    const controls = openToggle.getAttribute('aria-controls')!;
    const panel = document.getElementById(controls);
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('evidence');

    await user.click(screen.getByRole('button', { name: '收起' }));
    const collapsedToggle = screen.getByRole('button', { name: '查看原文依据' });
    expect(collapsedToggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(controls)).toBeNull();
  });

  it('aria-controls matches the rendered panel id once expanded', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} defaultOpen />);
    const toggle = screen.getByRole('button', { name: '收起' });
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('id', toggle.getAttribute('aria-controls'));
  });

  it('renders the source quote and surrounding text as plain text', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} defaultOpen />);
    const mark = document.querySelector('mark')!;
    expect(mark.textContent).toBe('工作记忆的容量十分有限');
    // The quote sits at offset 0 in the fixture, so all following block text is
    // rendered as plain context text after the highlighted mark.
    const after = document.querySelector('.quote')!.textContent ?? '';
    expect(after).toContain('一般一次只能同时保持大约四个组块。');
    expect(screen.getByText(/容量十分有限/)).toBeInTheDocument();
  });

  it('highlights the first of several repeated occurrences and notes the count', () => {
    const repeatedContent =
      '工作记忆的容量十分有限。注意:工作记忆的容量十分有限,所以要善用外部记忆。';
    const grounding = {
      ...concepts[0]!.grounding,
      startOffset: repeatedContent.indexOf('工作记忆的容量十分有限'),
      endOffset:
        repeatedContent.indexOf('工作记忆的容量十分有限') + '工作记忆的容量十分有限'.length,
      occurrenceCount: 2,
    };
    const repeatedBlocks = [{ ...blocks[0]!, content: repeatedContent }];
    render(<SourceEvidencePanel grounding={grounding} blocks={repeatedBlocks} defaultOpen />);

    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('工作记忆的容量十分有限');
    // The second occurrence remains plain text (not duplicated into a mark).
    expect(screen.getByText(/所以要善用外部记忆/)).toBeInTheDocument();
    expect(screen.getByText(/出现 2 次/)).toBeInTheDocument();
  });

  it('shows only the quote when the cited block is not loaded (offsets unused)', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={[]} defaultOpen />);
    // The fallback panel renders the quote without offsets applied.
    expect(screen.getByText('「工作记忆的容量十分有限」')).toBeInTheDocument();
    expect(screen.getByText(/未加载所在源块/)).toBeInTheDocument();
    expect(document.querySelector('mark')).toBeNull();
  });

  it('does not duplicate or corrupt the highlighted text', () => {
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} defaultOpen />);
    // Joining all rendered quote text must equal the original block content once.
    const quoteText = document.querySelector('.quote')!.textContent ?? '';
    expect(quoteText).toBe(blocks[0]!.content);
    expect(blocks[0]!.content.split('工作记忆的容量十分有限')).toHaveLength(2);
  });

  it('opens and closes via keyboard (Enter/Space) as a native button', async () => {
    const user = userEvent.setup();
    render(<SourceEvidencePanel grounding={concepts[0]!.grounding} blocks={blocks} />);

    // Collapsed toggle: focus + Enter opens.
    const toggle = screen.getByRole('button', { name: '查看原文依据' });
    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    const openToggle = screen.getByRole('button', { name: '收起' });
    expect(openToggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(openToggle.getAttribute('aria-controls')!)).not.toBeNull();

    // Expanded toggle: focus + Space closes.
    openToggle.focus();
    await user.keyboard(' ');
    const collapsedToggle = screen.getByRole('button', { name: '查看原文依据' });
    expect(collapsedToggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(openToggle.getAttribute('aria-controls')!)).toBeNull();
  });

  it('applies offsets only when a matching block is present (offset-unused fallback)', () => {
    // When the cited block is absent, the panel must not slice by offsets or
    // render a <mark>; it shows the raw quote so the evidence is still legible.
    render(
      <SourceEvidencePanel
        grounding={concepts[0]!.grounding}
        blocks={blocks.slice(1)}
        defaultOpen
      />,
    );
    const quoteText = screen.getByText('「工作记忆的容量十分有限」').textContent ?? '';
    expect(quoteText).toBe('「工作记忆的容量十分有限」');
    expect(document.querySelector('mark')).toBeNull();
    expect(screen.getByText(/未加载所在源块/)).toBeInTheDocument();
  });
});
