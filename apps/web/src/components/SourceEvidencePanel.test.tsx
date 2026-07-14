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
});
