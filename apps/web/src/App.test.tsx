import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOCUMENT_FILE_BYTES } from '@hy3-clinic/shared';
import { App } from './App';
import type { MaterialSummary } from './api';
import { installFetchMock, type MockRoute } from './test/mockFetch';
import {
  blocks,
  concepts,
  fullQuestions,
  grading,
  material,
  materialSummary,
  mastery,
  mistakes,
  quiz,
} from './test/fixtures';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LAST_MATERIAL_ID_KEY = 'hy3-clinic:last-material-id';

const baseRoutes: MockRoute[] = [
  { method: 'GET', pattern: /\/api\/config$/, handler: () => ({ body: { provider: 'fake' } }) },
  {
    method: 'GET',
    pattern: /\/api\/materials$/,
    handler: () => ({ body: { materials: [] } }),
  },
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

function routesWithHistory(materials = [materialSummary]): MockRoute[] {
  return [
    ...baseRoutes.filter(
      (route) => !(route.method === 'GET' && route.pattern.test('/api/materials')),
    ),
    {
      method: 'GET',
      pattern: /\/api\/materials$/,
      handler: () => ({ body: { materials } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/materials\/mat_1$/,
      handler: () => ({ body: material }),
    },
    {
      method: 'GET',
      pattern: /\/api\/materials\/mat_1\/concepts$/,
      handler: () => ({ body: { concepts } }),
    },
  ];
}

interface ManagedHistoryOptions {
  patchError?: { status: number; message: string };
  deleteError?: { status: number; message: string };
  conceptsByMaterial?: Record<string, typeof concepts>;
  analyzeHandler?: MockRoute['handler'];
}

function managedHistoryRoutes(
  initialMaterials: MaterialSummary[],
  options: ManagedHistoryOptions = {},
): { routes: MockRoute[]; materials: () => MaterialSummary[] } {
  const storedMaterials = initialMaterials.map((item) => ({ ...item }));
  const base = baseRoutes.filter((route) => {
    if (route.method === 'GET' && route.pattern.test('/api/materials')) return false;
    if (
      options.analyzeHandler &&
      route.method === 'POST' &&
      route.pattern.test('/api/materials/mat_1/analyze')
    ) {
      return false;
    }
    return true;
  });

  const routes: MockRoute[] = [
    ...base,
    {
      method: 'GET',
      pattern: /\/api\/materials$/,
      handler: () => ({ body: { materials: storedMaterials.map((item) => ({ ...item })) } }),
    },
    {
      method: 'GET',
      pattern: /\/api\/materials\/[^/?]+$/,
      handler: (_body, url) => {
        const id = materialIdFromUrl(url);
        const summary = storedMaterials.find((item) => item.id === id);
        if (!summary) {
          return {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: '资料不存在。' } },
          };
        }
        return { body: materialDetails(summary) };
      },
    },
    {
      method: 'GET',
      pattern: /\/api\/materials\/[^/?]+\/concepts$/,
      handler: (_body, url) => {
        const id = materialIdFromUrl(url);
        return {
          body: {
            concepts:
              options.conceptsByMaterial?.[id] ?? (id === material.material.id ? concepts : []),
          },
        };
      },
    },
    {
      method: 'PATCH',
      pattern: /\/api\/materials\/[^/?]+$/,
      handler: (body, url) => {
        if (options.patchError) {
          return {
            status: options.patchError.status,
            body: {
              error: { code: 'INTERNAL', message: options.patchError.message },
            },
          };
        }
        const id = materialIdFromUrl(url);
        const index = storedMaterials.findIndex((item) => item.id === id);
        if (index < 0) {
          return {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: '资料不存在。' } },
          };
        }
        const title = String((body as { title?: unknown }).title ?? '').trim();
        storedMaterials[index] = { ...storedMaterials[index]!, title };
        return { body: { material: materialDetails(storedMaterials[index]!).material } };
      },
    },
    {
      method: 'DELETE',
      pattern: /\/api\/materials\/[^/?]+$/,
      handler: (_body, url) => {
        if (options.deleteError) {
          return {
            status: options.deleteError.status,
            body: {
              error: { code: 'INTERNAL', message: options.deleteError.message },
            },
          };
        }
        const id = materialIdFromUrl(url);
        const index = storedMaterials.findIndex((item) => item.id === id);
        if (index < 0) {
          return {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: '资料不存在。' } },
          };
        }
        storedMaterials.splice(index, 1);
        return { status: 204 };
      },
    },
  ];

  if (options.analyzeHandler) {
    routes.push({
      method: 'POST',
      pattern: /\/api\/materials\/mat_1\/analyze$/,
      handler: options.analyzeHandler,
    });
  }

  return {
    routes,
    materials: () => storedMaterials.map((item) => ({ ...item })),
  };
}

function materialIdFromUrl(url: string): string {
  return decodeURIComponent(url.match(/\/api\/materials\/([^/?]+)/)?.[1] ?? '');
}

function materialDetails(summary: MaterialSummary) {
  return {
    material: {
      ...material.material,
      id: summary.id,
      title: summary.title,
      sourceType: summary.sourceType,
      charCount: summary.charCount,
      createdAt: summary.createdAt,
    },
    blocks: blocks.map((block, index) => ({
      ...block,
      id: `${summary.id}_block_${index}`,
      materialId: summary.id,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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
    expect(screen.getByRole('button', { name: '练习' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '错题' })).toBeDisabled();
    expect(screen.getByText(/还没有导入资料/)).toBeInTheDocument();
  });
});

describe('Material recovery', () => {
  it('shows a local timestamp and record suffix for each history row', async () => {
    const targetMaterial = {
      ...materialSummary,
      id: 'mat_2190da55-ed5b-4990-8baa-2940451db58c',
    };
    installFetchMock(routesWithHistory([targetMaterial]));

    render(<App />);

    const openButton = await screen.findByRole('button', {
      name: `打开资料：${targetMaterial.title}`,
    });
    const historyRow = openButton.closest('.block-preview');
    const timestamp = historyRow?.querySelector('time');

    expect(timestamp).toHaveAttribute('datetime', targetMaterial.createdAt);
    expect(timestamp).toHaveTextContent(/\d{1,2}:\d{2}/);
    expect(historyRow).toHaveTextContent('记录 …1db58c');
  });

  it('keeps history compact while search and expansion cover every record', async () => {
    const historyMaterials = [
      {
        ...materialSummary,
        id: 'mat_history_000001',
        title: '历史资料 1',
        createdAt: '2026-06-05T04:00:00.000Z',
      },
      {
        ...materialSummary,
        id: 'mat_history_000002',
        title: '历史资料 2',
        createdAt: '2026-06-04T04:00:00.000Z',
      },
      {
        ...materialSummary,
        id: 'mat_history_000003',
        title: '历史资料 3',
        createdAt: '2026-06-03T04:00:00.000Z',
      },
      {
        ...materialSummary,
        id: 'mat_history_000004',
        title: '历史资料 4',
        createdAt: '2026-06-02T04:00:00.000Z',
      },
      {
        ...materialSummary,
        id: 'mat_history_000005',
        title: '隐藏的间隔复习资料',
        createdAt: '2024-05-01T04:00:00.000Z',
      },
      materialSummary,
    ];
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    installFetchMock(routesWithHistory(historyMaterials));
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole('button', { name: `当前资料：${material.material.title}` }),
    ).toBeDisabled();
    for (const title of ['历史资料 1', '历史资料 2', '历史资料 3']) {
      expect(screen.getByRole('button', { name: `打开资料：${title}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '打开资料：历史资料 4' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开资料：隐藏的间隔复习资料' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看全部历史资料（6 条）' }));
    expect(
      screen.getByRole('button', { name: '打开资料：隐藏的间隔复习资料' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '收起历史资料' }));

    const search = screen.getByRole('searchbox', { name: '搜索历史资料' });
    await user.type(search, '隐藏的间隔复习资料');
    expect(
      screen.getByRole('button', { name: '打开资料：隐藏的间隔复习资料' }),
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '000005');
    expect(
      screen
        .getByRole('button', { name: '打开资料：隐藏的间隔复习资料' })
        .closest('.block-preview'),
    ).toHaveTextContent('记录 …000005');

    await user.clear(search);
    await user.type(search, '2024');
    expect(
      screen.getByRole('button', { name: '打开资料：隐藏的间隔复习资料' }),
    ).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '不存在的资料');
    expect(screen.getByText('未找到匹配的历史资料。')).toBeInTheDocument();
  });

  it('renames a historical material and immediately searches by its new title', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_history_abcdef',
      title: '待重命名的历史资料',
    };
    const server = managedHistoryRoutes([historical]);
    const { calls } = installFetchMock(server.routes);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '重命名：待重命名的历史资料（记录 …abcdef）',
      }),
    );
    const titleInput = screen.getByRole('textbox', {
      name: '资料标题：待重命名的历史资料',
    });
    expect(titleInput).toHaveValue('待重命名的历史资料');
    await user.clear(titleInput);
    await user.type(titleInput, '  已重命名的间隔复习资料  ');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByRole('button', { name: '打开资料：已重命名的间隔复习资料' }),
    ).toBeInTheDocument();
    const patchCall = calls.find(
      (call) => call.method === 'PATCH' && call.url.endsWith('/api/materials/mat_history_abcdef'),
    );
    expect(patchCall?.body).toEqual({ title: '已重命名的间隔复习资料' });

    await user.type(screen.getByRole('searchbox', { name: '搜索历史资料' }), '已重命名');
    expect(
      screen.getByRole('button', { name: '打开资料：已重命名的间隔复习资料' }),
    ).toBeInTheDocument();
  });

  it('renames the currently open material without changing its saved selection', async () => {
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary]);
    installFetchMock(server.routes);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: `重命名：${material.material.title}（记录 …${material.material.id.slice(-6)}）`,
      }),
    );
    const titleInput = screen.getByRole('textbox', {
      name: `资料标题：${material.material.title}`,
    });
    await user.clear(titleInput);
    await user.type(titleInput, '当前资料的新标题');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByRole('button', { name: '当前资料：当前资料的新标题' }),
    ).toBeDisabled();
    expect(screen.getByRole('heading', { name: /当前资料的新标题/ })).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(material.material.id);
  });

  it('validates rename input and preserves the editor when the server rejects the rename', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_rename_failure',
      title: '不可丢失的原标题',
    };
    const server = managedHistoryRoutes([historical], {
      patchError: { status: 500, message: '测试重命名失败' },
    });
    const { calls } = installFetchMock(server.routes);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '重命名：不可丢失的原标题（记录 …ailure）',
      }),
    );
    const titleInput = screen.getByRole('textbox', { name: '资料标题：不可丢失的原标题' });
    await user.clear(titleInput);
    expect(screen.getByRole('alert')).toHaveTextContent('资料标题不能为空。');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);

    await user.type(titleInput, '服务器不会接受的新标题');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/重命名失败：测试重命名失败/)).toBeInTheDocument();
    expect(titleInput).toHaveValue('服务器不会接受的新标题');
    expect(titleInput.closest('.block-preview')).toHaveTextContent('记录 …ailure');
    expect(server.materials()[0]?.title).toBe('不可丢失的原标题');
  });

  it('cancels inline renaming without sending a request or changing the title', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_cancel_rename',
      title: '保留原标题',
    };
    const server = managedHistoryRoutes([historical]);
    const { calls } = installFetchMock(server.routes);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '重命名：保留原标题（记录 …rename）',
      }),
    );
    const titleInput = screen.getByRole('textbox', { name: '资料标题：保留原标题' });
    await user.clear(titleInput);
    await user.type(titleInput, '不应保存的标题');
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.getByRole('button', { name: '打开资料：保留原标题' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('不应保存的标题')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('loads a renamed title from API history after the app reloads', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_reload_rename',
      title: '重新加载前标题',
    };
    const server = managedHistoryRoutes([historical]);
    installFetchMock(server.routes);
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '重命名：重新加载前标题（记录 …rename）',
      }),
    );
    const titleInput = screen.getByRole('textbox', { name: '资料标题：重新加载前标题' });
    await user.clear(titleInput);
    await user.type(titleInput, 'API 持久化后的标题');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('button', { name: '打开资料：API 持久化后的标题' });

    firstRender.unmount();
    installFetchMock(server.routes);
    render(<App />);

    expect(
      await screen.findByRole('button', { name: '打开资料：API 持久化后的标题' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('重新加载前标题')).not.toBeInTheDocument();
  });

  it('permanently deletes only a confirmed non-current material with full identity details', async () => {
    const target = {
      ...materialSummary,
      id: 'mat_history_111111',
      title: '准备永久删除的资料',
      createdAt: '2026-06-05T04:00:00.000Z',
    };
    const survivor = {
      ...materialSummary,
      id: 'mat_history_222222',
      title: '必须保留的资料',
      createdAt: '2026-06-04T04:00:00.000Z',
    };
    const server = managedHistoryRoutes([target, survivor]);
    const { calls } = installFetchMock(server.routes);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    const deleteButton = await screen.findByRole('button', {
      name: '永久删除：准备永久删除的资料（记录 …111111）',
    });
    const row = deleteButton.closest('.block-preview');
    const displayedTime = row?.querySelector('time')?.textContent;
    await user.click(deleteButton);

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '打开资料：准备永久删除的资料' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '打开资料：必须保留的资料' })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'DELETE')?.url).toMatch(
      /\/api\/materials\/mat_history_111111$/,
    );

    const confirmationMessage = String(confirm.mock.calls[0]?.[0]);
    expect(confirmationMessage).toContain('永久删除以下资料及其全部相关学习记录？');
    expect(confirmationMessage).toContain('标题：准备永久删除的资料');
    expect(confirmationMessage).toContain(`创建时间：${displayedTime}`);
    expect(confirmationMessage).toContain('记录：…111111');
    expect(confirmationMessage).toContain('此操作无法恢复。');
  });

  it('cancels permanent deletion before any DELETE request is sent', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_delete_cancel',
      title: '取消删除的资料',
    };
    const server = managedHistoryRoutes([historical]);
    const { calls } = installFetchMock(server.routes);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '永久删除：取消删除的资料（记录 …cancel）',
      }),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '打开资料：取消删除的资料' })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('preserves a material row when permanent deletion fails', async () => {
    const historical = {
      ...materialSummary,
      id: 'mat_delete_failure',
      title: '删除失败后保留的资料',
    };
    const server = managedHistoryRoutes([historical], {
      deleteError: { status: 500, message: '测试永久删除失败' },
    });
    const { calls } = installFetchMock(server.routes);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: '永久删除：删除失败后保留的资料（记录 …ailure）',
      }),
    );

    expect(await screen.findByText(/永久删除失败：测试永久删除失败/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开资料：删除失败后保留的资料' }),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('deletes the current material, clears selection and state, and does not auto-open history', async () => {
    const survivor = {
      ...materialSummary,
      id: 'mat_history_survive',
      title: '删除后仍在历史中的资料',
      createdAt: '2025-01-01T04:00:00.000Z',
    };
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary, survivor]);
    installFetchMock(server.routes);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: `当前资料：${material.material.title}` });
    await user.click(screen.getByRole('button', { name: '练习' }));
    await user.click(screen.getByRole('button', { name: '生成测验' }));
    await screen.findByRole('button', { name: '提交并判分' });
    await user.click(screen.getByRole('radio', { name: /工作记忆的容量十分有限/ }));
    await user.type(screen.getByLabelText('第 2 题作答'), '容量有限');
    await user.click(screen.getByRole('button', { name: '提交并判分' }));
    expect(await screen.findByText('60 分')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '判分结果' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '资料库' }));
    await user.click(
      screen.getByRole('button', {
        name: `永久删除：${material.material.title}（记录 …${material.material.id.slice(-6)}）`,
      }),
    );

    await waitFor(() => expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull());
    expect(
      screen.getByRole('button', { name: '打开资料：删除后仍在历史中的资料' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /删除后仍在历史中的资料/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: new RegExp(material.material.title) }),
    ).not.toBeInTheDocument();
    for (const tabName of ['练习', '错题', '学习进展']) {
      expect(screen.getByRole('button', { name: tabName })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: '资料库' })).toHaveClass('active');
  });

  it('aborts current work and ignores a late response after deleting that material', async () => {
    const survivor = {
      ...materialSummary,
      id: 'mat_history_later',
      title: '随后手动打开的资料',
      createdAt: '2025-01-01T04:00:00.000Z',
    };
    const lateAnalysis = deferred<{ body: { concepts: typeof concepts } }>();
    const analyzeRequest: { signal?: AbortSignal } = {};
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary, survivor], {
      conceptsByMaterial: { [material.material.id]: [], [survivor.id]: [] },
      analyzeHandler: (_body, _url, init) => {
        if (init?.signal) analyzeRequest.signal = init.signal;
        return lateAnalysis.promise;
      },
    });
    installFetchMock(server.routes);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: `当前资料：${material.material.title}` });
    await user.click(screen.getByRole('button', { name: '分析核心概念' }));
    await waitFor(() => expect(analyzeRequest.signal).toBeDefined());

    await user.click(
      screen.getByRole('button', {
        name: `永久删除：${material.material.title}（记录 …${material.material.id.slice(-6)}）`,
      }),
    );
    await waitFor(() => expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull());
    expect(analyzeRequest.signal?.aborted).toBe(true);

    await user.click(screen.getByRole('button', { name: '打开资料：随后手动打开的资料' }));
    expect(await screen.findByRole('heading', { name: /随后手动打开的资料/ })).toBeInTheDocument();

    await act(async () => {
      lateAnalysis.resolve({ body: { concepts } });
      await lateAnalysis.promise;
    });

    await waitFor(() => expect(screen.queryByText('核心概念(1)')).not.toBeInTheDocument());
    expect(
      screen.queryByRole('heading', { name: new RegExp(material.material.title) }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /随后手动打开的资料/ })).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(survivor.id);
  });

  it('aborts a pending import when deleting the current material and ignores its late response', async () => {
    const survivor = {
      ...materialSummary,
      id: 'mat_history_after_import',
      title: '删除后保留的历史资料',
      createdAt: '2025-01-01T04:00:00.000Z',
    };
    const lateImportedMaterial = {
      ...material,
      material: {
        ...material.material,
        id: 'mat_late_import',
        title: '不应被晚到响应恢复的资料',
      },
      blocks: blocks.map((block) => ({ ...block, materialId: 'mat_late_import' })),
    };
    const lateImport = deferred<{ status: number; body: typeof lateImportedMaterial }>();
    const importRequest: { signal?: AbortSignal } = {};
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary, survivor]);
    installFetchMock([
      ...server.routes.filter(
        (route) => !(route.method === 'POST' && route.pattern.test('/api/materials')),
      ),
      {
        method: 'POST',
        pattern: /\/api\/materials$/,
        handler: (_body, _url, init) => {
          if (init?.signal) importRequest.signal = init.signal;
          return lateImport.promise;
        },
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: `当前资料：${material.material.title}` });
    await user.type(screen.getByLabelText('资料内容'), '等待中的新资料');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));
    await waitFor(() => expect(importRequest.signal).toBeDefined());

    await user.click(
      screen.getByRole('button', {
        name: `永久删除：${material.material.title}（记录 …${material.material.id.slice(-6)}）`,
      }),
    );
    await waitFor(() => expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull());
    expect(importRequest.signal?.aborted).toBe(true);

    await act(async () => {
      lateImport.resolve({ status: 201, body: lateImportedMaterial });
      await lateImport.promise;
    });

    expect(screen.queryByText('不应被晚到响应恢复的资料')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开资料：删除后保留的历史资料' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '练习' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '资料库' })).toHaveClass('active');
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull();
  });

  it('keeps duplicate titles distinguishable by timestamp and record suffix', async () => {
    const duplicateTitle = '同名学习资料';
    const first = {
      ...materialSummary,
      id: 'mat_duplicate_aaa111',
      title: duplicateTitle,
      createdAt: '2026-06-05T04:00:00.000Z',
    };
    const second = {
      ...materialSummary,
      id: 'mat_duplicate_bbb222',
      title: duplicateTitle,
      createdAt: '2026-06-04T04:00:00.000Z',
    };
    const server = managedHistoryRoutes([first, second]);
    installFetchMock(server.routes);
    render(<App />);

    const firstDelete = await screen.findByRole('button', {
      name: '永久删除：同名学习资料（记录 …aaa111）',
    });
    const secondDelete = screen.getByRole('button', {
      name: '永久删除：同名学习资料（记录 …bbb222）',
    });
    const firstRow = firstDelete.closest('.block-preview');
    const secondRow = secondDelete.closest('.block-preview');

    expect(firstRow).toHaveTextContent('记录 …aaa111');
    expect(secondRow).toHaveTextContent('记录 …bbb222');
    expect(firstRow?.querySelector('time')).toHaveAttribute('datetime', first.createdAt);
    expect(secondRow?.querySelector('time')).toHaveAttribute('datetime', second.createdAt);
    expect(firstRow?.querySelector('time')?.textContent).not.toBe(
      secondRow?.querySelector('time')?.textContent,
    );
    expect(
      screen.getByRole('button', { name: '重命名：同名学习资料（记录 …aaa111）' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '重命名：同名学习资料（记录 …bbb222）' }),
    ).toBeInTheDocument();
  });

  it('restores a valid saved material with its source and persisted concepts', async () => {
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const { calls } = installFetchMock(routesWithHistory());

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: new RegExp(material.material.title) }),
    ).toBeInTheDocument();
    expect(screen.getByText(blocks[0]!.content)).toBeInTheDocument();
    expect(screen.getByText('核心概念(1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '练习' })).toBeEnabled();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(material.material.id);
    expect(
      calls.some((call) => call.method === 'GET' && call.url.endsWith('/api/materials/mat_1')),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.method === 'GET' && call.url.endsWith('/api/materials/mat_1/concepts'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.url.endsWith('/api/materials/mat_1/analyze'),
      ),
    ).toBe(false);
  });

  it('clears a stale saved material ID and leaves history available', async () => {
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, 'mat_stale');
    const { calls } = installFetchMock(routesWithHistory());

    render(<App />);

    expect(
      await screen.findByRole('button', {
        name: `打开资料：${material.material.title}`,
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull());
    expect(screen.getByRole('button', { name: '练习' })).toBeDisabled();
    expect(calls.some((call) => call.url.includes('/api/materials/mat_stale'))).toBe(false);
  });

  it('opens a historical material and continues into mistakes and mastery', async () => {
    const { calls } = installFetchMock(routesWithHistory());
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', {
        name: `打开资料：${material.material.title}`,
      }),
    );

    expect(await screen.findByText('源块预览')).toBeInTheDocument();
    expect(screen.getByText('核心概念(1)')).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(material.material.id);
    expect(screen.getByRole('button', { name: '练习' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '错题' }));
    expect(await screen.findByText('工作记忆 · 1 个未解决')).toBeInTheDocument();
    expect(screen.getByText(mistakes[0]!.question.stem)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '学习进展' }));
    expect(
      await screen.findByRole('heading', { name: '综合掌握度（历史加权）' }),
    ).toBeInTheDocument();
    expect(screen.getByText('47%')).toBeInTheDocument();
    expect(
      calls.some(
        (call) => call.method === 'POST' && call.url.endsWith('/api/materials/mat_1/analyze'),
      ),
    ).toBe(false);
  });

  it('shows an explicit empty-history state while keeping import available', async () => {
    installFetchMock(baseRoutes);

    render(<App />);

    expect(await screen.findByText('暂无历史资料。导入后会显示在这里。')).toBeInTheDocument();
    expect(screen.getByLabelText('资料内容')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入并切分' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '练习' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: '练习' })).toBeEnabled();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(material.material.id);
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

describe('File import (PDF/DOCX)', () => {
  const FILE_INPUT_LABEL = '选择 .md、.txt、.pdf 或 .docx 文件';
  const PDF_BYTES = '%PDF-1.4 fake fixture body';

  const pdfMaterial = {
    material: {
      ...material.material,
      title: '认知科学讲义',
      sourceType: 'pdf',
      mediaType: 'application/pdf',
      originalFilename: 'lecture.pdf',
      pageCount: 2,
    },
    blocks: material.blocks,
  };

  function pickFile(file: File) {
    fireEvent.change(screen.getByLabelText(FILE_INPUT_LABEL), { target: { files: [file] } });
  }

  function pdfFile(name = 'lecture.pdf'): File {
    return new File([PDF_BYTES], name, { type: 'application/pdf' });
  }

  function routesWithImportHandler(handler: MockRoute['handler']): MockRoute[] {
    return [
      ...baseRoutes.filter((r) => !(r.method === 'POST' && r.pattern.test('/api/materials'))),
      { method: 'POST', pattern: /\/api\/materials$/, handler },
    ];
  }

  it('shows the supported formats, the OCR limitation, and the full accept list', async () => {
    installFetchMock(baseRoutes);
    render(<App />);

    expect(
      await screen.findByText(/支持粘贴文本及 Markdown、TXT、PDF、DOCX 文件。/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/暂不支持纯扫描图片型 PDF;PDF 中需要包含可提取文本。/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(FILE_INPUT_LABEL)).toHaveAttribute(
      'accept',
      '.md,.markdown,.txt,.pdf,.docx',
    );
  });

  it('stages a PDF with its type, imports it as base64 with a title override, and opens it', async () => {
    const { calls } = installFetchMock(
      routesWithImportHandler(() => ({ status: 201, body: pdfMaterial })),
    );
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: '选择文件' });
    pickFile(pdfFile());

    expect(await screen.findByText('lecture.pdf(PDF,待导入)')).toBeInTheDocument();
    expect(screen.getByText('导入后在服务器解析并切分')).toBeInTheDocument();
    expect(screen.getByLabelText('资料内容')).toHaveValue('');
    expect(screen.getByRole('button', { name: '移除文件' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('标题(可选)'), '认知科学讲义');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));
    await screen.findByText('源块预览');

    const importCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/materials'));
    expect(importCall).toBeDefined();
    const body = importCall!.body as { filename: string; dataBase64: string; title: string };
    expect(body.filename).toBe('lecture.pdf');
    expect(body.title).toBe('认知科学讲义');
    expect(atob(body.dataBase64)).toBe(PDF_BYTES);
    expect(importCall!.body).not.toHaveProperty('content');

    // The imported PDF becomes the current material and a history entry.
    expect(screen.getByRole('button', { name: '当前资料：认知科学讲义' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '练习' })).toBeEnabled();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(material.material.id);
    // Staging is cleared after a successful import.
    expect(screen.queryByRole('button', { name: '移除文件' })).not.toBeInTheDocument();
  });

  it('shows an importing state, blocks duplicate submissions, and supports cancel', async () => {
    const importRequest: { signal?: AbortSignal } = {};
    const { calls } = installFetchMock(
      routesWithImportHandler((_body, _url, init) => {
        if (init?.signal) importRequest.signal = init.signal;
        return 'never';
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: '选择文件' });
    pickFile(pdfFile());
    await screen.findByText('lecture.pdf(PDF,待导入)');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));

    const importing = await screen.findByRole('button', { name: '导入中…' });
    expect(importing).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '载入示例资料' })).toBeDisabled();
    expect(screen.getByLabelText('资料内容')).toBeDisabled();
    expect(screen.getByLabelText('标题(可选)')).toBeDisabled();

    // A second click on the disabled button must not fire another request.
    await user.click(importing);
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/materials')),
    ).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(await screen.findByRole('button', { name: '导入并切分' })).toBeEnabled();
    expect(importRequest.signal?.aborted).toBe(true);
    // Cancellation is quiet and keeps the staged file for a retry.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('lecture.pdf(PDF,待导入)')).toBeInTheDocument();
  });

  it('restores the controls and keeps the staged file when the server rejects a scanned PDF', async () => {
    installFetchMock(
      routesWithImportHandler(() => ({
        status: 422,
        body: {
          error: {
            code: 'PARSE_FAILED',
            message: 'PDF 中没有可提取的文本(可能是纯扫描件;本产品未启用 OCR),已拒绝导入。',
          },
        },
      })),
    );
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: '选择文件' });
    pickFile(pdfFile('scan.pdf'));
    await screen.findByText('scan.pdf(PDF,待导入)');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));

    expect(await screen.findByText(/可能是纯扫描件/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入并切分' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeEnabled();
    expect(screen.getByText('scan.pdf(PDF,待导入)')).toBeInTheDocument();
    // Nothing was imported: no history entry, no saved selection.
    expect(screen.getByText('暂无历史资料。导入后会显示在这里。')).toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull();
  });

  it('rejects unsupported and oversized files locally without any request', async () => {
    const { calls } = installFetchMock(baseRoutes);
    render(<App />);

    await screen.findByRole('button', { name: '选择文件' });
    pickFile(new File(['slides'], 'slides.pptx'));
    expect(
      await screen.findByText('不支持的文件类型:仅接受 .md、.txt、.pdf 与 .docx 文件。'),
    ).toBeInTheDocument();

    pickFile(new File([new ArrayBuffer(MAX_DOCUMENT_FILE_BYTES + 1)], 'big.pdf'));
    expect(await screen.findByText(/文件过大/)).toBeInTheDocument();

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '导入并切分' })).toBeDisabled();
    expect(screen.queryByText(/待导入/)).not.toBeInTheDocument();
  });

  it('still loads a picked markdown file into the editable textarea and imports it as text', async () => {
    const { calls } = installFetchMock(baseRoutes);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: '选择文件' });
    pickFile(new File(['# 笔记\n\n第一段。'], 'notes.md', { type: 'text/markdown' }));

    await waitFor(() =>
      expect(screen.getByLabelText('资料内容')).toHaveValue('# 笔记\n\n第一段。'),
    );
    expect(screen.getByText('notes.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '导入并切分' }));
    await screen.findByText('源块预览');

    const importCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/materials'));
    expect(importCall!.body).toMatchObject({ content: '# 笔记\n\n第一段。', filename: 'notes.md' });
    expect(importCall!.body).not.toHaveProperty('dataBase64');
  });

  it('aborts a pending PDF import when deleting the current material and ignores its late response', async () => {
    const lateImportedMaterial = {
      ...pdfMaterial,
      material: { ...pdfMaterial.material, id: 'mat_late_pdf', title: '不应出现的晚到 PDF' },
    };
    const lateImport = deferred<{ status: number; body: typeof lateImportedMaterial }>();
    const importRequest: { signal?: AbortSignal } = {};
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary]);
    installFetchMock([
      ...server.routes.filter(
        (route) => !(route.method === 'POST' && route.pattern.test('/api/materials')),
      ),
      {
        method: 'POST',
        pattern: /\/api\/materials$/,
        handler: (_body, _url, init) => {
          if (init?.signal) importRequest.signal = init.signal;
          return lateImport.promise;
        },
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: `当前资料：${material.material.title}` });
    pickFile(pdfFile());
    await screen.findByText('lecture.pdf(PDF,待导入)');
    await user.click(screen.getByRole('button', { name: '导入并切分' }));
    await waitFor(() => expect(importRequest.signal).toBeDefined());

    await user.click(
      screen.getByRole('button', {
        name: `永久删除：${material.material.title}（记录 …${material.material.id.slice(-6)}）`,
      }),
    );
    await waitFor(() => expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull());
    expect(importRequest.signal?.aborted).toBe(true);

    await act(async () => {
      lateImport.resolve({ status: 201, body: lateImportedMaterial });
      await lateImport.promise;
    });

    expect(screen.queryByText('不应出现的晚到 PDF')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '练习' })).toBeDisabled();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBeNull();
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

  it('ignores a late analysis response after manual cancellation', async () => {
    const lateAnalysis = deferred<{ body: { concepts: typeof concepts } }>();
    const analyzeRequest: { signal?: AbortSignal } = {};
    installFetchMock([
      ...baseRoutes.filter(
        (route) => !(route.method === 'POST' && route.pattern.test('/api/materials/mat_1/analyze')),
      ),
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/analyze$/,
        handler: (_body, _url, init) => {
          if (init?.signal) analyzeRequest.signal = init.signal;
          return lateAnalysis.promise;
        },
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '分析核心概念' }));
    await waitFor(() => expect(analyzeRequest.signal).toBeDefined());
    expect(screen.getByText('正在分析概念…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(analyzeRequest.signal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: '分析核心概念' })).toBeInTheDocument();
    await act(async () => {
      lateAnalysis.resolve({ body: { concepts } });
      await lateAnalysis.promise;
    });

    expect(screen.queryByText('核心概念(1)')).not.toBeInTheDocument();
    expect(screen.queryByText('请求已取消。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分析核心概念' })).toBeInTheDocument();
  });
});

describe('Quiz flow', () => {
  async function generateQuiz(user: ReturnType<typeof userEvent.setup>) {
    await importSample(user);
    await user.click(screen.getByRole('button', { name: '练习' }));
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
    const lateGeneration = deferred<{ status: number; body: { quiz: typeof quiz } }>();
    const generationRequest: { signal?: AbortSignal } = {};
    installFetchMock([
      ...baseRoutes.filter((r) => !(r.method === 'POST' && r.pattern.test('/api/quizzes'))),
      {
        method: 'POST',
        pattern: /\/api\/quizzes$/,
        handler: (_body, _url, init) => {
          if (init?.signal) generationRequest.signal = init.signal;
          return lateGeneration.promise;
        },
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '练习' }));
    await user.click(screen.getByRole('button', { name: '生成测验' }));
    expect(await screen.findByText('正在生成测验…')).toBeInTheDocument();
    await waitFor(() => expect(generationRequest.signal).toBeDefined());

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(generationRequest.signal?.aborted).toBe(true);
    // Back to idle: the generate button is visible again, no error shown.
    expect(await screen.findByRole('button', { name: '生成测验' })).toBeInTheDocument();
    expect(screen.queryByText(/请求已取消/)).not.toBeInTheDocument();

    await act(async () => {
      lateGeneration.resolve({ status: 201, body: { quiz } });
      await lateGeneration.promise;
    });
    expect(
      screen.queryByRole('heading', { name: `作答(${quiz.questions.length} 题)` }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成测验' })).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: '练习' }));
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

    await user.click(screen.getByRole('button', { name: '错题' }));
    expect(await screen.findByText('工作记忆 · 1 个未解决')).toBeInTheDocument();
    expect(screen.getByText(mistakes[0]!.question.stem)).toBeInTheDocument();
    // Status appears both in the filter dropdown and on the mistake card.
    expect(screen.getAllByText('未解决').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('不太记得了')).toBeInTheDocument();
  });

  it('labels a resolved mistake percentage as its original score', async () => {
    const resolvedMistake = {
      ...mistakes[0]!,
      score: 0.25,
      status: 'resolved' as const,
      remediationCount: 1,
      resolvedAt: '2026-01-02T00:00:00.000Z',
    };
    installFetchMock([
      ...baseRoutes.filter(
        (route) => !(route.method === 'GET' && route.pattern.test('/api/materials/mat_1/mistakes')),
      ),
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1\/mistakes/,
        handler: (_body, url) => ({
          body: {
            mistakes: url.includes('status=all') ? [resolvedMistake] : [],
            weakConcepts: [],
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '错题' }));
    await user.selectOptions(await screen.findByLabelText('筛选状态'), 'all');

    const card = (await screen.findByText(resolvedMistake.question.stem)).closest('section');
    expect(card).toHaveTextContent('已解决');
    expect(card).toHaveTextContent('原始得分 25%');
    expect(screen.queryByText('得分 25%', { exact: true })).not.toBeInTheDocument();
  });

  it('disables remediation and explains the empty state when no mistakes are open', async () => {
    installFetchMock([
      ...baseRoutes.filter(
        (route) => !(route.method === 'GET' && route.pattern.test('/api/materials/mat_1/mistakes')),
      ),
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1\/mistakes/,
        handler: () => ({ body: { mistakes: [], weakConcepts: [] } }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '错题' }));

    expect(await screen.findByText('当前没有未解决的错题，无需生成康复练习。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成康复练习' })).toBeDisabled();
  });

  it('shows remediation scope instead of ordinary quiz controls and regenerates in place', async () => {
    const remediationQuiz = {
      ...quiz,
      id: 'qz_remediation',
      kind: 'remediation' as const,
      targetConceptIds: ['con_0'],
    };
    const { calls } = installFetchMock([
      ...baseRoutes,
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/remediation$/,
        handler: () => ({ status: 201, body: { quiz: remediationQuiz } }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);
    await user.click(screen.getByRole('button', { name: '错题' }));
    await user.click(await screen.findByRole('button', { name: '生成康复练习' }));

    expect(await screen.findByText('根据 1 个未解决概念自动生成 2 道康复题')).toBeInTheDocument();
    expect(screen.getByLabelText('生成的康复题型')).toHaveTextContent('单选题');
    expect(screen.getByLabelText('生成的康复题型')).toHaveTextContent('简答题');
    expect(
      screen.getByText('每个概念 1 道单选题 + 1 道简答题，最多 3 个概念。'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('难度')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/每种题型数量/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新生成康复练习' }));
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.method === 'POST' && call.url.endsWith('/api/materials/mat_1/remediation'),
        ),
      ).toHaveLength(2),
    );
    expect(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/quizzes')),
    ).toHaveLength(0);
  });

  it('cancels pending remediation on manual navigation and ignores its late response after switching materials', async () => {
    const survivor = {
      ...materialSummary,
      id: 'mat_after_remediation',
      title: '康复取消后打开的资料',
      createdAt: '2025-01-01T04:00:00.000Z',
    };
    const remediationQuiz = {
      ...quiz,
      id: 'qz_late_remediation',
      kind: 'remediation' as const,
      targetConceptIds: ['con_0'],
    };
    const lateRemediation = deferred<{
      status: number;
      body: { quiz: typeof remediationQuiz };
    }>();
    const remediationRequest: { signal?: AbortSignal } = {};
    window.localStorage.setItem(LAST_MATERIAL_ID_KEY, material.material.id);
    const server = managedHistoryRoutes([materialSummary, survivor]);
    installFetchMock([
      ...server.routes,
      {
        method: 'POST',
        pattern: /\/api\/materials\/mat_1\/remediation$/,
        handler: (_body, _url, init) => {
          if (init?.signal) remediationRequest.signal = init.signal;
          return lateRemediation.promise;
        },
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: `当前资料：${material.material.title}` });
    await user.click(screen.getByRole('button', { name: '错题' }));
    await screen.findByText('工作记忆 · 1 个未解决');
    await user.click(screen.getByRole('button', { name: '生成康复练习' }));
    await waitFor(() => expect(remediationRequest.signal).toBeDefined());

    await user.click(screen.getByRole('button', { name: '资料库' }));
    expect(remediationRequest.signal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '打开资料：康复取消后打开的资料' }));
    expect(
      await screen.findByRole('heading', { name: /康复取消后打开的资料/ }),
    ).toBeInTheDocument();

    await act(async () => {
      lateRemediation.resolve({ status: 201, body: { quiz: remediationQuiz } });
      await lateRemediation.promise;
    });

    expect(screen.getByRole('button', { name: '资料库' })).toHaveClass('active');
    expect(screen.getByRole('heading', { name: /康复取消后打开的资料/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '康复练习' })).not.toBeInTheDocument();
    expect(screen.queryByText(remediationQuiz.questions[0]!.stem)).not.toBeInTheDocument();
    expect(screen.queryByText(/请求已取消/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_MATERIAL_ID_KEY)).toBe(survivor.id);
  });

  it('distinguishes recent scores and labels historical weighted mastery', async () => {
    const masteryCases = [
      { percentage: 59, status: '待巩固', recentScore: 100 },
      { percentage: 60, status: '基本掌握', recentScore: 80 },
      { percentage: 80, status: '掌握良好', recentScore: 70 },
      { percentage: 90, status: '稳固掌握', recentScore: 60 },
    ];
    installFetchMock([
      ...baseRoutes.filter(
        (route) => !(route.method === 'GET' && route.pattern.test('/api/materials/mat_1/mastery')),
      ),
      {
        method: 'GET',
        pattern: /\/api\/materials\/mat_1\/mastery$/,
        handler: () => ({
          body: {
            mastery: masteryCases.map(({ percentage, recentScore }, index) => ({
              ...mastery[0]!,
              conceptId: `con_mastery_${index}`,
              conceptName: `掌握度概念 ${percentage}`,
              mastery: percentage / 100,
              lastScore: recentScore / 100,
            })),
            weakConcepts: [],
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await importSample(user);

    await user.click(screen.getByRole('button', { name: '学习进展' }));
    expect(
      await screen.findByRole('heading', { name: '综合掌握度（历史加权）' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/单次满分不会立即代表完全掌握。/)).toBeInTheDocument();
    expect(screen.getByText('查看计算方式')).toBeInTheDocument();

    for (const { percentage, status, recentScore } of masteryCases) {
      const row = screen.getByText(`掌握度概念 ${percentage}`).closest('.block-preview');
      expect(row).toHaveTextContent(`最近得分 ${recentScore}%`);
      expect(row).toHaveTextContent('综合掌握度（历史加权）');
      expect(row).toHaveTextContent(`${percentage}%`);
      expect(row).toHaveTextContent(status);
    }
  });
});
