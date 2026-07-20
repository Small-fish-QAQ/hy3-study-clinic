import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResultsView } from './ResultsView';
import { blocks, fullQuestions, grading, quiz, stateChanges } from '../test/fixtures';

describe('ResultsView — 学习状态变化', () => {
  it('explains mistakes, misconceptions, mastery, review scheduling and the next step', () => {
    render(
      <ResultsView
        quiz={quiz}
        result={{ grading, questions: fullQuestions, stateChanges }}
        answers={[]}
        blocks={blocks}
        onRemediate={() => {}}
        remediationLoading={false}
      />,
    );
    const card = screen.getByLabelText('本次判分引起的状态变化');
    expect(card).toHaveTextContent('评估 1 个概念');
    expect(card).toHaveTextContent('证据来自 1 份文档');
    expect(card).toHaveTextContent('错题:新增 1 道');
    expect(card).toHaveTextContent('新增疑似误区 1 个');
    expect(card).toHaveTextContent('工作记忆 50% → 44%');
    expect(card).toHaveTextContent('复习安排');
    expect(card).toHaveTextContent('again');
    expect(card).toHaveTextContent('建议下一步:');
  });

  it('renders without a state-change card for legacy responses', () => {
    render(
      <ResultsView
        quiz={quiz}
        result={{ grading, questions: fullQuestions }}
        answers={[]}
        blocks={blocks}
        onRemediate={() => {}}
        remediationLoading={false}
      />,
    );
    expect(screen.queryByLabelText('本次判分引起的状态变化')).not.toBeInTheDocument();
    expect(screen.getByText('判分结果')).toBeInTheDocument();
  });

  it('hides the per-document remediation button for workspace assessments', () => {
    render(
      <ResultsView
        quiz={{ ...quiz, materialId: null, workspaceId: 'ws_1', kind: 'adaptive' }}
        result={{ grading, questions: fullQuestions, stateChanges }}
        answers={[]}
        blocks={blocks}
        onRemediate={() => {}}
        remediationLoading={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /针对错题生成康复练习/ })).not.toBeInTheDocument();
    expect(screen.getByText(/建议下一步/)).toBeInTheDocument();
  });
});
