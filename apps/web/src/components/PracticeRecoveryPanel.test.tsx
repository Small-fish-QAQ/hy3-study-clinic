import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { LearnerPracticeRecovery } from '@hy3-clinic/shared';
import { PracticeRecoveryPanel } from './PracticeRecoveryPanel.js';

const recovery: LearnerPracticeRecovery = {
  phase: 'diagnosis',
  selectedAnswer: 'Both roles must allow the operation.',
  feedback: 'Roles combine by union; the session then restricts them.',
  round: 1,
  diagnosis: null,
  teaching: null,
  retest: null,
  learnerNote: 'I intersected the roles.',
};
describe('Practice recovery controls', () => {
  it('restores learner reasoning and requests targeted teaching without a retest shortcut', async () => {
    const onAction = vi.fn();
    render(<PracticeRecoveryPanel recovery={recovery} disabled={false} onAction={onAction} />);
    expect(screen.getByRole('textbox')).toHaveValue('I intersected the roles.');
    expect(screen.queryByRole('button', { name: '用新情境检验' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '学习针对性讲解' }));
    expect(onAction).toHaveBeenCalledWith({
      kind: 'prepare_practice_repair',
      learnerNote: 'I intersected the roles.',
    });
  });
  it('submits only the current retest choice and keeps teaching hidden during the check', async () => {
    const onAction = vi.fn();
    render(
      <PracticeRecoveryPanel
        recovery={{
          ...recovery,
          phase: 'retest',
          retest: {
            index: 1,
            prompt: 'Which permission remains?',
            options: [
              { id: 'A', text: 'Read' },
              { id: 'B', text: 'Write' },
              { id: 'C', text: 'Neither' },
            ],
          },
        }}
        disabled={false}
        onAction={onAction}
      />,
    );
    expect(screen.queryByText('补上关键一步')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    expect(onAction).toHaveBeenCalledWith({
      kind: 'submit_practice_retest',
      index: 1,
      optionId: 'B',
    });
  });
});
