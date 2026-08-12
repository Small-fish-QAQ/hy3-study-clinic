import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { SettingsView } from './SettingsView.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsView', () => {
  it('describes fake mode as a normal offline simulation mode', () => {
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByText('当前使用模拟模式')).toBeInTheDocument();
    expect(screen.getByText(/不会调用真实 Hy3 服务/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels Hy3 mode without claiming that credentials are valid', () => {
    render(
      <SettingsView
        provider="hy3"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByText('服务器已配置为 Hy3 在线模式')).toBeInTheDocument();
    expect(screen.getByText(/不代表凭据已经验证/)).toBeInTheDocument();
  });

  it('reports local reachability while keeping credential validation out of scope', async () => {
    const user = userEvent.setup();
    const health = vi.spyOn(api, 'health').mockResolvedValue({ status: 'ok' });
    const config = vi.spyOn(api, 'config').mockResolvedValue({ provider: 'hy3' });
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: '检查本地服务状态' }));

    expect(await screen.findByRole('status')).toHaveTextContent('本地服务可访问');
    expect(screen.getByText('服务器运行方式：Hy3 在线模式')).toBeInTheDocument();
    expect(screen.getByText(/只确认本地服务响应，不验证 Hy3 凭据/)).toBeInTheDocument();
    expect(health).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(config).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('shows a connection failure without implying that provider settings changed', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'health').mockRejectedValue(new Error('本地服务没有响应。'));
    vi.spyOn(api, 'config').mockResolvedValue({ provider: 'fake' });
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: '检查本地服务状态' }));

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
    vi.spyOn(api, 'config').mockResolvedValue({ provider: 'fake' });
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: '检查本地服务状态' }));
    await user.click(await screen.findByRole('button', { name: '取消' }));

    await waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('本地服务可访问')).not.toBeInTheDocument();
  });

  it('delegates the sidebar default preference to its owner', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SettingsView
        provider="fake"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={onChange}
      />,
    );

    await user.click(screen.getByRole('switch', { name: /默认展开课程侧边栏/ }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the selected Course and the honest server-owned configuration boundary', async () => {
    const user = userEvent.setup();
    render(
      <SettingsView
        provider="fake"
        currentCourseId="ws_probability"
        currentCourseName="Probability"
        sidebarDefaultCollapsed={false}
        onSidebarDefaultCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByLabelText('运行与配置边界')).toHaveTextContent(
      '配置来源服务器启动环境（浏览器只读）',
    );
    expect(screen.getByLabelText('课程连续性')).toHaveTextContent('已启用 · Probability');
    await user.click(screen.getByText('诊断与关于'));
    expect(screen.getByText('Probability')).toBeInTheDocument();
    expect(screen.getByText('ws_probability')).toBeInTheDocument();
    expect(screen.getByText(/提供程序与凭据由服务器启动配置管理/)).toBeInTheDocument();
  });
});
