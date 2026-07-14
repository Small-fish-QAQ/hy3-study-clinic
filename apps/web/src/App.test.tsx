import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { installFetchMock, type MockRoute } from './test/mockFetch';
import {
  blocks,
  concepts,
  fullQuestions,
  grading,
  material,
  mastery,
  mistakes,
  quiz,
} from './test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const baseRoutes: MockRoute[] = [
  { method: 'GET', pattern: /\/api\/config$/, handler: () => ({ body: { provider: 'fake' } }) },
  {
    method: 'GET',
    pattern: /\/api\/sample-material$/,
    handler: () => ({
      body: {
        title: material.material.title,
        content: '# 示例\n\n示例内容。',
        filename: 'sample.md',
      },
    }),
  },
  {
    method: 'POST',
    pattern: /\/api\/materials$/,
    handler: () => ({ status: 201, body: material }),
  },
  {
    method: 'POST',
    pattern: /\/api\/materials\/mat_1\/analyze$/,
    handler: () => ({ body: { concepts } }),
  },
  { method: 'POST', pattern: /\/api\/quizzes$/, handler: () => ({ status: 201, body: { quiz } }) },
  {
    method: 'POST',
    pattern: /\/api\/quizzes\/qz_1\/submissions$/,
    handler: () => ({ status: 201, body: { grading, questions: fullQuestions } }),
  },
  {
    method: 'GET',
    pattern: /\/api\/materials\/mat_1\/mistakes/,
    handler: () => ({
      body: {
        mistakes,
        weakConcepts: [{ conceptId: 'con_0', conceptName: '工作记忆', openMistakes: 1 }],
      },
    }),
  },
  {
    method: 'GET',
    pattern: /\/api\/materials\/mat_1\/mastery$/,
    handler: () => ({
      body: {
        mastery,
        weakConcepts: [{ conceptId: 'con_0', conceptName: '工作记忆', openMistakes: 1 }],
      },
    }),
  },
];

async function importSample(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '载入示例资料' }));
  await waitFor(() =>
    expect(screen.getByLabelText('资料内容')).toHaveValue('# 示例\n\n示例内容。'),
  );
  await user.click(screen.getByRole('button', { name: '导入并切分' }));
  await screen.findByText('源块预览');
}

describe('App shell', () => {
  it('shows the offline provider badge and disables flow tabs before import', async () => {
    installFetchMock(baseRoutes);
    render(<App />);
    expect(await screen.findByText(/离线模式/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '② 出题作答' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '④ 错题本' })).toBeDisabled();
    expect(screen.getByText(/还没有导入资料/)).toBeInTheDocument();
  });
});

describe('Import flow', () => {
  it('loads the sample, imports it, and previews source blocks', async () => {
    const { calls } = installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);

    await importSample(user);

    expect(screen.getByRole('heading', { name: /认知科学入门:记忆与学习/ })).toBeInTheDocument();
    expect(screen.getByText('2 个源块')).toBeInTheDocument();
    expect(screen.getByText(blocks[0]!.content)).toBeInTheDocument();
    const importCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/materials'));
    expect(importCall).toBeDefined();
    expect((importCall!.body as { filename: string }).filename).toBe('sample.md');
    // Flow tabs unlocked.
    expect(screen.getByRole('button', { name: '② 出题作答' })).toBeEnabled();
  });

  it('surfaces structured server errors in Chinese', async () => {
    installFetchMock([
      ...baseRoutes.filter((r) => !(r.method === 'POST' && r.pattern.test('/api/materials'))),
      {
        method: 'POST',
        pattern: /\/api\/materials$/,
        handler: () => ({
          status: 400,
          body: { error: { code: 'EMPTY_SOURCE', message: '源材料为空,请粘贴或上传文本内容。' } },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('资料内容'), '一些内容');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));
    expect(await screen.findByText(/源材料为空/)).toBeInTheDocument();
  });
});

describe('Concept analysis', () => {
  it('analyzes and renders concepts with evidence', async () => {
    installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '分析核心概念' }));
    expect(await screen.findByText('核心概念(1)')).toBeInTheDocument();
    expect(screen.getByText('工作记忆')).toBeInTheDocument();
  });
});

describe('Quiz flow', () => {
  async function generateQuiz(user: ReturnType<typeof userEvent.setup>) {
    await importSample(user);
    await user.click(screen.getByRole('button', { name: '② 出题作答' }));
    await user.click(screen.getByRole('button', { name: '生成测验' }));
    await screen.findByRole('button', { name: '提交并判分' });
  }

  it('generates a quiz and supports answering both question types', async () => {
    installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);
    await generateQuiz(user);

    expect(screen.getByText(quiz.questions[0]!.stem)).toBeInTheDocument();
    // Answer the single choice.
    await user.click(screen.getByRole('radio', { name: /工作记忆的容量十分有限/ }));
    expect(screen.getByText('已作答 1/2')).toBeInTheDocument();
    // Answer the short answer.
    await user.type(screen.getByLabelText('第 2 题作答'), '容量有限');
    expect(screen.getByText('已作答 2/2')).toBeInTheDocument();
  });

  it('submits answers and shows grading with gradedBy labels', async () => {
    const { calls } = installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);
    await generateQuiz(user);

    await user.click(screen.getByRole('radio', { name: /工作记忆的容量十分有限/ }));
    await user.type(screen.getByLabelText('第 2 题作答'), '容量有限');
    await user.click(screen.getByRole('button', { name: '提交并判分' }));

    expect(await screen.findByText('60 分')).toBeInTheDocument();
    expect(screen.getByText('确定性判分')).toBeInTheDocument();
    expect(screen.getByText('模型评分')).toBeInTheDocument();
    expect(screen.getByText('置信度 72%')).toBeInTheDocument();
    expect(screen.getByText(/仍需补充/)).toBeInTheDocument();

    const submitCall = calls.find((c) => c.url.includes('/submissions'));
    const submitted = submitCall!.body as { answers: Array<{ questionId: string }> };
    expect(submitted.answers).toHaveLength(2);
  });

  it('supports cancelling a slow generation and returning to idle', async () => {
    installFetchMock([
      ...baseRoutes.filter((r) => !(r.method === 'POST' && r.pattern.test('/api/quizzes'))),
      { method: 'POST', pattern: /\/api\/quizzes$/, handler: () => 'never' },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '② 出题作答' }));
    await user.click(screen.getByRole('button', { name: '生成测验' }));
    expect(await screen.findByText('正在生成测验…')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消' }));
    // Back to idle: the generate button is visible again, no error shown.
    expect(await screen.findByRole('button', { name: '生成测验' })).toBeInTheDocument();
    expect(screen.queryByText(/请求已取消/)).not.toBeInTheDocument();
  });

  it('shows a structured provider error when generation fails', async () => {
    installFetchMock([
      ...baseRoutes.filter((r) => !(r.method === 'POST' && r.pattern.test('/api/quizzes'))),
      {
        method: 'POST',
        pattern: /\/api\/quizzes$/,
        handler: () => ({
          status: 502,
          body: {
            error: {
              code: 'PROVIDER_INVALID_OUTPUT',
              message: '模型返回的数据不符合约定格式,已在一次修复尝试后放弃。',
            },
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '② 出题作答' }));
    await user.click(screen.getByRole('button', { name: '生成测验' }));
    expect(await screen.findByText(/不符合约定格式/)).toBeInTheDocument();
  });
});

describe('Mistake notebook and mastery', () => {
  it('lists mistakes with status and weak concepts', async () => {
    installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '④ 错题本' }));
    expect(await screen.findByText('工作记忆 · 1 个未解决')).toBeInTheDocument();
    expect(screen.getByText(mistakes[0]!.question.stem)).toBeInTheDocument();
    // Status appears both in the filter dropdown and on the mistake card.
    expect(screen.getAllByText('未解决').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('不太记得了')).toBeInTheDocument();
  });

  it('renders mastery meters from the deterministic model', async () => {
    installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '⑤ 掌握度' }));
    expect(await screen.findByText('掌握度总览')).toBeInTheDocument();
    expect(screen.getByText('47%')).toBeInTheDocument();
    expect(screen.getByText(/作答 2 次 · 达标 1 次/)).toBeInTheDocument();
  });
});
