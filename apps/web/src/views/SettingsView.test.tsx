import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { workspaceSummary } from '../test/fixtures.js';
import { SettingsView } from './SettingsView.js';
import type { SafeProviderConfig } from '@hy3-clinic/shared';

function config(overrides: Partial<SafeProviderConfig> = {}): SafeProviderConfig {
  return {
    provider: 'fake',
    baseUrl: 'https://example.test/v1',
    model: 'model-a',
    apiKeyConfigured: true,
    source: 'saved',
    complete: true,
    runtimeGeneration: 1,
    externalConnection: {
      status: 'untested',
      testedGeneration: null,
      testedAt: null,
      message: null,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsView', () => {
  it('shows initial loading and then the server-owned fake configuration', async () => {
    let resolveConfig!: (value: SafeProviderConfig) => void;
    vi.spyOn(api, 'config').mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    render(
      <SettingsView sidebarDefaultCollapsed={false} onSidebarDefaultCollapsedChange={() => {}} />,
    );

    expect(screen.getByText('正在读取服务器配置')).toBeInTheDocument();
    await act(async () => resolveConfig(config({ provider: 'fake' })));
    expect(screen.getByText('当前使用模拟模式')).toBeInTheDocument();
    expect(screen.getByText(/不会调用外部服务/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows initial load failure without inventing configuration state', async () => {
    vi.spyOn(api, 'config').mockRejectedValue(new Error('配置服务不可达。'));
    render(
      <SettingsView sidebarDefaultCollapsed={false} onSidebarDefaultCollapsedChange={() => {}} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法读取服务器配置。 配置服务不可达。',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('labels Hy3 mode without claiming that credentials are valid', async () => {
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(await screen.findByText('服务器已配置为 Hy3 模式')).toBeInTheDocument();
    expect(screen.getByText(/不代表凭据已经验证/)).toBeInTheDocument();
  });

  it('reports local reachability while keeping credential validation out of scope', async () => {
    const user = userEvent.setup();
    const health = vi.spyOn(api, 'health').mockResolvedValue({ status: 'ok' });
    const readConfig = vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '检查本地服务状态' }));

    expect(await screen.findByRole('status')).toHaveTextContent('本地服务可访问');
    expect(screen.getByText('服务器运行方式：Hy3 模式')).toBeInTheDocument();
    expect(screen.getByText(/只确认本地服务响应，不验证 Hy3 凭据/)).toBeInTheDocument();
    expect(health).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(readConfig).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('shows a connection failure without implying that provider settings changed', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'health').mockRejectedValue(new Error('本地服务没有响应。'));
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'fake' }));
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '检查本地服务状态' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法连接本地服务。 本地服务没有响应。',
    );
    expect(screen.getByText('当前使用模拟模式')).toBeInTheDocument();
  });

  it('cancels an in-flight connection check', async () => {
    const user = userEvent.setup();
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(api, 'health').mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'fake' }));
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '检查本地服务状态' }));
    await user.click(await screen.findByRole('button', { name: '取消' }));

    await waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('本地服务可访问')).not.toBeInTheDocument();
  });

  it('delegates the sidebar default preference to its owner', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'fake' }));
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={onChange}
      />,
    );

    await user.click(await screen.findByRole('switch', { name: /默认展开课程侧边栏/ }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the selected Course and the honest server-owned configuration boundary', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(
      config({
        provider: 'fake',
        baseUrl: null,
        model: null,
        apiKeyConfigured: false,
        source: 'default',
      }),
    );
    render(
      <SettingsView
        provider="fake"
        currentCourseId="ws_probability"
        currentCourseName="Probability"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(await screen.findByLabelText('运行与配置边界')).toHaveTextContent(
      '保存的提供程序配置模拟模式 · 默认值 · 配置完整',
    );
    expect(screen.getByLabelText('课程连续性')).toHaveTextContent('已启用 · Probability');
    await user.click(screen.getByText('诊断与关于'));
    expect(screen.getByText('Probability')).toBeInTheDocument();
    expect(screen.getByText('ws_probability')).toBeInTheDocument();
    expect(screen.getByText(/提供程序与凭据由服务器管理/)).toBeInTheDocument();
  });

  it('saves an intentional Hy3 secret replacement and clears plaintext afterward', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config());
    const update = vi
      .spyOn(api, 'updateConfig')
      .mockResolvedValue(config({ provider: 'hy3', runtimeGeneration: 2 }));
    const onProviderChange = vi.fn();
    render(
      <SettingsView
        provider="fake"
        onProviderChange={onProviderChange}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await screen.findByText('已保存的 Hy3 配置');
    await user.click(screen.getByRole('radio', { name: 'Hy3 模式' }));
    expect(screen.getByText('已配置')).toBeInTheDocument();
    await user.click(screen.getByText('更改'));
    await user.type(screen.getByPlaceholderText('输入新凭据'), 'sentinel-key');
    await user.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      provider: 'hy3',
      secret: { action: 'replace', value: 'sentinel-key' },
    });
    expect(screen.queryByDisplayValue('sentinel-key')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('sentinel-key');
    expect(onProviderChange).toHaveBeenLastCalledWith('hy3');
  });

  it('keeps the active configuration and draft when save fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config());
    vi.spyOn(api, 'updateConfig').mockRejectedValue(new Error('保存介质不可用。'));
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );
    await screen.findByText('已保存的 Hy3 配置');
    await user.click(screen.getByRole('radio', { name: 'Hy3 模式' }));
    await user.clear(screen.getByDisplayValue('model-a'));
    await user.type(screen.getByDisplayValue(''), 'model-b');
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存介质不可用');
    expect(screen.getByDisplayValue('model-b')).toBeInTheDocument();
  });

  it('switches to Fake without removing the saved Hy3 credential', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    const update = vi
      .spyOn(api, 'updateConfig')
      .mockResolvedValue(config({ provider: 'fake', runtimeGeneration: 2 }));
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('radio', { name: '模拟模式' }));
    expect(screen.getByText('更改尚未保存')).toBeInTheDocument();
    expect(screen.getByText(/当前活动配置保持不变/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        { provider: 'fake', secret: { action: 'unchanged' } },
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole('radio', { name: 'Hy3 模式' }));
    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.getByDisplayValue('model-a')).toBeInTheDocument();
  });

  it('removes a saved credential only after explicit confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const update = vi.spyOn(api, 'updateConfig').mockResolvedValue(
      config({
        provider: 'fake',
        apiKeyConfigured: false,
        runtimeGeneration: 2,
      }),
    );
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '移除凭据' }));
    expect(window.confirm).toHaveBeenCalledWith('移除已保存的 Hy3 凭据并切换到本地模拟模式？');
    await user.click(screen.getByRole('radio', { name: 'Hy3 模式' }));
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: '模拟模式' }));
    await user.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        { provider: 'fake', secret: { action: 'remove' } },
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole('radio', { name: 'Hy3 模式' }));
    expect(screen.queryByText('已配置')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入凭据')).toHaveValue('');
  });

  it('tests external Hy3 only on explicit click and shows verified truth', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    const testConnection = vi.spyOn(api, 'testProviderConnection').mockResolvedValue(
      config({
        provider: 'hy3',
        externalConnection: {
          status: 'verified',
          testedGeneration: 1,
          testedAt: '2026-08-15T08:00:00.000Z',
          message: '连接正常。',
        },
      }),
    );
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );
    const button = await screen.findByRole('button', { name: '测试 Hy3 连接' });
    expect(testConnection).not.toHaveBeenCalled();
    await user.click(button);
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith(expect.any(AbortSignal)));
    expect(screen.getByLabelText('运行与配置边界')).toHaveTextContent(
      '上次 Hy3 连接测试已通过 · 2026/08/15',
    );
  });

  it('invalidates a verified result when changed configuration is activated', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(
      config({
        provider: 'hy3',
        externalConnection: {
          status: 'verified',
          testedGeneration: 1,
          testedAt: '2026-08-15T08:00:00.000Z',
          message: '连接正常。',
        },
      }),
    );
    vi.spyOn(api, 'updateConfig').mockResolvedValue(
      config({
        provider: 'hy3',
        model: 'model-b',
        runtimeGeneration: 2,
        externalConnection: {
          status: 'untested',
          testedGeneration: null,
          testedAt: null,
          message: null,
        },
      }),
    );
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(await screen.findByLabelText('运行与配置边界')).toHaveTextContent(
      '上次 Hy3 连接测试已通过 · 2026/08/15',
    );
    await user.clear(screen.getByDisplayValue('model-a'));
    await user.type(screen.getByDisplayValue(''), 'model-b');
    expect(screen.getByLabelText('运行与配置边界')).toHaveTextContent(
      '上次 Hy3 连接测试配置已修改，保存后需重新测试',
    );
    await user.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() =>
      expect(screen.getByLabelText('运行与配置边界')).toHaveTextContent(
        '上次 Hy3 连接测试尚未测试',
      ),
    );
  });

  it('ignores a late external-test response after cancellation', async () => {
    const user = userEvent.setup();
    let resolveTest!: (value: SafeProviderConfig) => void;
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    const testConnection = vi.spyOn(api, 'testProviderConnection').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve;
        }),
    );
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: '测试 Hy3 连接' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    await act(async () =>
      resolveTest(
        config({
          provider: 'hy3',
          externalConnection: {
            status: 'verified',
            testedGeneration: 1,
            testedAt: '2026-08-15T08:00:00.000Z',
            message: '连接正常。',
          },
        }),
      ),
    );

    expect(testConnection).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByLabelText('运行与配置边界')).toHaveTextContent('上次 Hy3 连接测试尚未测试');
  });

  it('does not publish an initial config response after unmount cancellation', async () => {
    let resolveConfig!: (value: SafeProviderConfig) => void;
    const onProviderChange = vi.fn();
    vi.spyOn(api, 'config').mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    const rendered = render(
      <SettingsView
        onProviderChange={onProviderChange}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    rendered.unmount();
    await act(async () => resolveConfig(config({ provider: 'hy3' })));

    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('cancels a pending save without applying its late response or clearing the draft', async () => {
    const user = userEvent.setup();
    let resolveUpdate!: (value: SafeProviderConfig) => void;
    let updateSignal: AbortSignal | undefined;
    const onProviderChange = vi.fn();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'fake' }));
    vi.spyOn(api, 'updateConfig').mockImplementation(
      (_input, signal) =>
        new Promise((resolve) => {
          updateSignal = signal;
          resolveUpdate = resolve;
        }),
    );
    render(
      <SettingsView
        onProviderChange={onProviderChange}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole('radio', { name: 'Hy3 模式' }));
    await user.clear(screen.getByDisplayValue('model-a'));
    await user.type(screen.getByDisplayValue(''), 'model-b');
    await user.click(screen.getByRole('button', { name: '保存更改' }));

    expect(screen.getByDisplayValue('model-b')).toBeDisabled();
    expect(screen.getByRole('button', { name: '重置' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(updateSignal?.aborted).toBe(true);
    await act(async () =>
      resolveUpdate(config({ provider: 'hy3', model: 'model-b', runtimeGeneration: 2 })),
    );

    expect(screen.getByDisplayValue('model-b')).toBeEnabled();
    expect(screen.getByText('更改尚未保存')).toBeInTheDocument();
    expect(onProviderChange).toHaveBeenLastCalledWith('fake');
  });

  it('cancels credential editing without retaining the typed plaintext', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    const update = vi.spyOn(api, 'updateConfig');
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByText('更改'));
    await user.type(screen.getByPlaceholderText('输入新凭据'), 'sentinel-new-key');
    await user.click(screen.getByRole('button', { name: '取消更改' }));

    expect(screen.getByText('已配置')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('sentinel-new-key')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('sentinel-new-key');
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not allow whitespace-only input to replace a credential in Fake mode', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'config').mockResolvedValue(config({ provider: 'hy3' }));
    const update = vi.spyOn(api, 'updateConfig');
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(await screen.findByText('更改'));
    await user.type(screen.getByPlaceholderText('输入新凭据'), '   ');
    await user.click(screen.getByRole('radio', { name: '模拟模式' }));

    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refreshes active provider truth after a successful local service check', async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    vi.spyOn(api, 'health').mockResolvedValue({ status: 'ok' });
    vi.spyOn(api, 'config')
      .mockResolvedValueOnce(config({ provider: 'fake' }))
      .mockResolvedValueOnce(config({ provider: 'hy3', runtimeGeneration: 2 }));
    render(
      <SettingsView
        onProviderChange={onProviderChange}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await screen.findByText('当前使用模拟模式');
    await user.click(screen.getByRole('button', { name: '检查本地服务状态' }));

    expect(await screen.findByText('服务器运行方式：Hy3 模式')).toBeInTheDocument();
    expect(onProviderChange).toHaveBeenLastCalledWith('hy3');
  });

  it('delegates Course creation and renaming with bounded learner input', async () => {
    const user = userEvent.setup();
    const onCreateCourse = vi.fn().mockResolvedValue(true);
    const onRenameCourse = vi.fn().mockResolvedValue(true);
    vi.spyOn(api, 'config').mockResolvedValue(config());
    render(
      <SettingsView
        currentCourseId={workspaceSummary.id}
        currentCourseName={workspaceSummary.name}
        courses={[workspaceSummary]}
        onCreateCourse={onCreateCourse}
        onRenameCourse={onRenameCourse}
        onDeleteCourse={vi.fn().mockResolvedValue(true)}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    const createInput = await screen.findByLabelText('创建另一门课程');
    expect(createInput).toHaveAttribute('maxlength', '120');
    await user.type(createInput, '  概率论  ');
    await user.click(screen.getByRole('button', { name: '创建课程' }));
    expect(onCreateCourse).toHaveBeenCalledWith('概率论');

    const renameInput = screen.getByLabelText('当前课程名称');
    await user.clear(renameInput);
    await user.type(renameInput, '认知科学进阶');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    expect(onRenameCourse).toHaveBeenCalledWith(workspaceSummary.id, '认知科学进阶');
    expect(screen.getByLabelText('当前课程内容数量')).toHaveTextContent('课程资料1 份');
    expect(screen.getByLabelText('当前课程内容数量')).toHaveTextContent('图谱概念2 个');
  });

  it('requires the exact Course name and manages destructive-dialog focus', async () => {
    const user = userEvent.setup();
    const onDeleteCourse = vi.fn().mockResolvedValue(false);
    vi.spyOn(api, 'config').mockResolvedValue(config());
    const { container } = render(
      <SettingsView
        currentCourseId={workspaceSummary.id}
        currentCourseName={workspaceSummary.name}
        courses={[workspaceSummary]}
        onCreateCourse={vi.fn().mockResolvedValue(true)}
        onRenameCourse={vi.fn().mockResolvedValue(true)}
        onDeleteCourse={onDeleteCourse}
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    const opener = await screen.findByRole('button', { name: '删除当前课程' });
    await user.click(opener);
    const dialog = screen.getByRole('alertdialog', {
      name: `永久删除「${workspaceSummary.name}」？`,
    });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(
      '已接受学习路线、Evidence、Repair、Review、掌握度与全部学习历史',
    );
    expect(container.querySelector('.settings-page-intro')).toHaveAttribute('inert');

    const confirmation = screen.getByLabelText(`输入课程名称 ${workspaceSummary.name} 以确认`);
    await waitFor(() => expect(confirmation).toHaveFocus());
    const confirmDelete = screen.getByRole('button', { name: '永久删除课程' });
    expect(confirmDelete).toBeDisabled();
    await user.type(confirmation, `${workspaceSummary.name} `);
    expect(confirmDelete).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, workspaceSummary.name);
    expect(confirmDelete).toBeEnabled();

    confirmDelete.focus();
    await user.tab();
    expect(confirmation).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmDelete).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(container.querySelector('.settings-page-intro')).not.toHaveAttribute('inert');
    expect(onDeleteCourse).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on deletion failure and locks every control while busy', async () => {
    const user = userEvent.setup();
    const onDeleteCourse = vi.fn().mockResolvedValue(false);
    const baseProps = {
      currentCourseId: workspaceSummary.id,
      currentCourseName: workspaceSummary.name,
      courses: [workspaceSummary],
      onCreateCourse: vi.fn().mockResolvedValue(true),
      onRenameCourse: vi.fn().mockResolvedValue(true),
      onDeleteCourse,
      sidebarDefaultCollapsed: false,
      onSidebarDefaultCollapsedChange: () => {},
    };
    vi.spyOn(api, 'config').mockResolvedValue(config());
    const { rerender } = render(<SettingsView {...baseProps} />);

    await user.click(await screen.findByRole('button', { name: '删除当前课程' }));
    const confirmation = screen.getByLabelText(`输入课程名称 ${workspaceSummary.name} 以确认`);
    await user.type(confirmation, workspaceSummary.name);
    await user.click(screen.getByRole('button', { name: '永久删除课程' }));
    expect(onDeleteCourse).toHaveBeenCalledWith(workspaceSummary.id);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    rerender(
      <SettingsView
        {...baseProps}
        courseLifecycleLoading
        courseLifecycleOperation="delete"
        courseLifecycleError="服务器拒绝删除。"
      />,
    );
    const busyDialog = screen.getByRole('alertdialog');
    expect(busyDialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText(`输入课程名称 ${workspaceSummary.name} 以确认`)).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在永久删除' })).toBeDisabled();
    expect(busyDialog).toHaveTextContent('删除失败，课程及其学习历史没有被删除。');
  });
});
