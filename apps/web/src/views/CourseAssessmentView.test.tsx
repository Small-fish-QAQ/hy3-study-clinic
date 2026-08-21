import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import {
  concepts,
  documentSummary,
  fullQuestions,
  grading,
  material,
  quiz,
} from '../test/fixtures.js';
import { CourseAssessmentView } from './CourseAssessmentView.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CourseAssessmentView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getMaterial').mockResolvedValue(material);
    vi.spyOn(api, 'getConcepts').mockResolvedValue({ concepts });
  });

  it('preserves manual generation, grading, evidence, and Progress refresh signaling', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.spyOn(api, 'generateQuiz').mockResolvedValue({ quiz });
    vi.spyOn(api, 'submit').mockResolvedValue({ grading, questions: fullQuestions });

    render(
      <CourseAssessmentView
        workspaceId="ws_1"
        documents={[documentSummary]}
        launchedQuiz={null}
        onChanged={onChanged}
        onBack={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '生成测验' }));
    expect(await screen.findByRole('heading', { name: '作答(2 题)' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /工作记忆的容量十分有限/ }));
    await user.type(screen.getByLabelText('第 2 题作答'), '容量有限');
    await user.click(screen.getByRole('button', { name: '提交并判分' }));

    expect(await screen.findByText('60 分')).toBeInTheDocument();
    expect(screen.getByText(/错题已保留.*进展.*修复记录/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('rejects a late source response after switching to another Course', async () => {
    let resolveOldMaterial!: (value: typeof material) => void;
    vi.mocked(api.getMaterial)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldMaterial = resolve;
        }),
      )
      .mockResolvedValue(material);
    const secondDocument = { ...documentSummary, id: 'mat_2', title: '第二门课程资料' };
    const rendered = render(
      <CourseAssessmentView
        workspaceId="ws_1"
        documents={[documentSummary]}
        launchedQuiz={null}
        onChanged={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    rendered.rerender(
      <CourseAssessmentView
        workspaceId="ws_2"
        documents={[secondDocument]}
        launchedQuiz={null}
        onChanged={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await act(async () => resolveOldMaterial(material));

    await waitFor(() =>
      expect(api.getMaterial).toHaveBeenCalledWith('mat_2', expect.any(AbortSignal)),
    );
    expect(screen.queryByText(/评估依据暂时无法读取/)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '生成测验' })).toBeInTheDocument();
  });
});
