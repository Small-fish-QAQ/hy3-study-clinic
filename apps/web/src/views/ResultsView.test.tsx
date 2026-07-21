import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GradingResult, Question } from '@hy3-clinic/shared';
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

describe('ResultsView — 评分要点与结果徽标', () => {
  const shortAnswer: Question = {
    ...fullQuestions[1]!,
    rubric: {
      keyPoints: [
        { text: '容量有限', required: true },
        { text: '约四个组块', required: true },
        { text: '超出容量的内容会被迅速丢失', required: false },
      ],
    },
  };

  function renderShortAnswer(gradeOverrides: Partial<GradingResult['grades'][number]>) {
    const result: GradingResult = {
      ...grading,
      grades: [
        {
          ...grading.grades[1]!,
          ...gradeOverrides,
        },
      ],
    };
    render(
      <ResultsView
        quiz={quiz}
        result={{ grading: result, questions: [fullQuestions[0]!, shortAnswer] }}
        answers={[{ questionId: 'que_2', type: 'short_answer', text: '容量有限,约四个组块。' }]}
        blocks={blocks}
        onRemediate={() => {}}
        remediationLoading={false}
      />,
    );
  }

  it('numbers rubric points starting from 1 and never shows 要点 0', () => {
    renderShortAnswer({});
    expect(screen.getByText(/要点 1:/)).toBeInTheDocument();
    expect(screen.getByText(/要点 2:/)).toBeInTheDocument();
    expect(screen.getByText(/要点 3:/)).toBeInTheDocument();
    expect(screen.queryByText(/要点 0/)).not.toBeInTheDocument();
  });

  it('shows missing optional points as 可补充 without an error marker', () => {
    renderShortAnswer({
      correct: true,
      normalizedScore: 1,
      awardedPoints: 2,
      matchedKeyPoints: ['容量有限', '约四个组块'],
      missedKeyPoints: [],
      enrichmentKeyPoints: ['超出容量的内容会被迅速丢失'],
    });
    const optionalItem = screen.getByText(/超出容量的内容会被迅速丢失/).closest('li')!;
    expect(within(optionalItem).getByText('可补充')).toBeInTheDocument();
    expect(optionalItem).toHaveClass('enrichment');
    expect(optionalItem.textContent).not.toContain('✗');
  });

  it('labels full required coverage 正确 even when optional enrichment is missing', () => {
    renderShortAnswer({
      correct: true,
      normalizedScore: 1,
      awardedPoints: 2,
      matchedKeyPoints: ['容量有限', '约四个组块'],
      missedKeyPoints: [],
      enrichmentKeyPoints: ['超出容量的内容会被迅速丢失'],
    });
    expect(screen.getByText('正确')).toBeInTheDocument();
  });

  it('labels a materially partial passing score 基本正确, not 正确', () => {
    renderShortAnswer({
      correct: true,
      normalizedScore: 0.67,
      awardedPoints: 1.34,
      matchedKeyPoints: ['容量有限'],
      partialKeyPoints: ['约四个组块'],
      missedKeyPoints: [],
    });
    expect(screen.getByText('基本正确')).toBeInTheDocument();
    expect(screen.queryByText('正确')).not.toBeInTheDocument();
  });

  it('labels sub-pass coverage 部分正确 and zero coverage 需巩固', () => {
    renderShortAnswer({
      correct: false,
      normalizedScore: 0.5,
      awardedPoints: 1,
      matchedKeyPoints: ['容量有限'],
      missedKeyPoints: ['约四个组块'],
    });
    expect(screen.getByText('部分正确')).toBeInTheDocument();
  });

  it('marks partially covered required points with a non-error 部分覆盖 note', () => {
    renderShortAnswer({
      correct: true,
      normalizedScore: 0.75,
      awardedPoints: 1.5,
      matchedKeyPoints: ['容量有限'],
      partialKeyPoints: ['约四个组块'],
      missedKeyPoints: [],
    });
    const partialItem = screen.getByText(/要点 2:/).closest('li')!;
    expect(partialItem).toHaveClass('partial');
    expect(within(partialItem).getByText('(部分覆盖)')).toBeInTheDocument();
  });
});
