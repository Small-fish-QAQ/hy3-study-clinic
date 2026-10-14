import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeProviderConfig } from '@hy3-clinic/shared';
import { api } from '../clinicApi.js';
import { ModelServiceSettings, MOMA_DEFAULT_BASE_URL } from './ModelServiceSettings.js';

const active = (overrides: Partial<SafeProviderConfig> = {}): SafeProviderConfig => ({
  provider: 'moma',
  baseUrl: 'https://saved.test/v1',
  model: 'saved-model',
  apiKeyConfigured: true,
  source: 'saved',
  complete: true,
  runtimeGeneration: 3,
  externalConnection: { status: 'untested', testedGeneration: null, testedAt: null, message: null },
  ...overrides,
});
async function setup(config = active()) {
  const read = vi.spyOn(api, 'config').mockResolvedValue(config);
  const callback = vi.fn();
  const view = render(<ModelServiceSettings onActiveConfig={callback} />);
  await screen.findByLabelText('API Base URL');
  return { ...view, read, callback, user: userEvent.setup() };
}
afterEach(() => vi.restoreAllMocks());

describe('model service settings drafts', () => {
  it('显式推理偏好可保存，修改后撤销回到已保存档位', async () => {
    const { user } = await setup(active({ reasoningEffort: 'high' }));
    await user.click(screen.getByText('请求资源与等待时间'));
    expect(screen.getByLabelText('思考强度')).toHaveValue('high');
    const save = vi
      .spyOn(api, 'updateConfig')
      .mockResolvedValue(active({ reasoningEffort: 'low', runtimeGeneration: 2 }));
    await user.selectOptions(screen.getByLabelText('思考强度'), 'low');
    await user.click(screen.getByRole('button', { name: '保存并启用' }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'low', secret: { action: 'unchanged' } }),
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByLabelText('思考强度')).toHaveValue('low'));
  });
  it('preserves historical Hy3 identity and lets the user explicitly create a new compatible connection', async () => {
    const { user } = await setup(active({ provider: 'hy3' }));
    expect(screen.getByLabelText('当前启用连接')).toHaveTextContent('Hy3 历史配置');
    expect(screen.getByLabelText('API Base URL')).toHaveValue('https://saved.test/v1');
    await user.click(screen.getByRole('radio', { name: '其他兼容平台' }));
    expect(screen.getByRole('radio', { name: '其他兼容平台' })).toBeChecked();
    expect(screen.getByLabelText('API Base URL')).toHaveValue('');
    expect(screen.getByLabelText('Model ID')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('当前启用连接')).toHaveTextContent('Hy3 历史配置');
  });
  it('defaults a new connection to MoMA, keeps Key and Model ID empty, and makes no external calls', async () => {
    const models = vi.spyOn(api, 'providerModels');
    const test = vi.spyOn(api, 'testProviderDraft');
    const save = vi.spyOn(api, 'updateConfig');
    await setup(
      active({
        provider: 'fake',
        baseUrl: null,
        model: null,
        apiKeyConfigured: false,
        source: 'default',
      }),
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: '移动云 MoMA' })).toBeChecked();
    expect(screen.getByLabelText('API Base URL')).toHaveValue(MOMA_DEFAULT_BASE_URL);
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Model ID')).toHaveValue('');
    expect(screen.getByRole('button', { name: '保存并启用' })).toBeDisabled();
    expect(models).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('clears new compatible-platform fields and restores the saved connection when switching back', async () => {
    const { user, callback } = await setup();
    await user.click(screen.getByRole('radio', { name: '其他兼容平台' }));
    expect(screen.getByLabelText('API Base URL')).toHaveValue('');
    expect(screen.getByLabelText('Model ID')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('当前启用连接')).toHaveTextContent('移动云 MoMA · saved-model');
    await user.click(screen.getByRole('radio', { name: '移动云 MoMA' }));
    expect(screen.getByLabelText('API Base URL')).toHaveValue('https://saved.test/v1');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', '已配置，留空保留');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('keeps an editable MoMA URL and recovers its default for a fresh draft', async () => {
    const { user } = await setup(active({ provider: 'compatible' }));
    await user.click(screen.getByRole('radio', { name: '移动云 MoMA' }));
    expect(screen.getByLabelText('API Base URL')).toHaveValue(MOMA_DEFAULT_BASE_URL);
    await user.clear(screen.getByLabelText('API Base URL'));
    await user.type(screen.getByLabelText('API Base URL'), 'https://moma.cmecloud.cn/v1');
    expect(screen.getByLabelText('API Base URL')).toHaveValue('https://moma.cmecloud.cn/v1');
    expect(screen.getByText(/当前模型和套餐提供的地址/)).toBeInTheDocument();
  });
  it('fetches models for a draft, permits selection and retains manual Model ID editing', async () => {
    const models = vi
      .spyOn(api, 'providerModels')
      .mockResolvedValue({ models: ['model-a', 'model-b'] });
    const { user, callback } = await setup();
    await user.click(screen.getByRole('button', { name: '获取模型' }));
    await user.selectOptions(await screen.findByLabelText('可用模型'), 'model-b');
    expect(screen.getByLabelText('Model ID')).toHaveValue('model-b');
    expect(models).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'moma',
        secret: { action: 'unchanged' },
        expectedGeneration: 3,
      }),
      expect.any(AbortSignal),
    );
    await user.clear(screen.getByLabelText('Model ID'));
    await user.type(screen.getByLabelText('Model ID'), 'manual-model');
    expect(screen.getByLabelText('Model ID')).toHaveValue('manual-model');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it.each(['未授权', '权限不足', '接口不存在', '限流', '网络不可达', '响应不兼容'])(
    'keeps manual entry and connection testing available when discovery fails: %s',
    async (message) => {
      vi.spyOn(api, 'providerModels').mockRejectedValue(new Error(message));
      const { user } = await setup();
      await user.click(screen.getByRole('button', { name: '获取模型' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('仍可手动输入 Model ID');
      expect(screen.getByLabelText('Model ID')).toBeEnabled();
      expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
    },
  );
  it('permits manual input for an empty model list', async () => {
    vi.spyOn(api, 'providerModels').mockResolvedValue({ models: [] });
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: '获取模型' }));
    expect(await screen.findByRole('status')).toHaveTextContent('空列表');
    expect(screen.getByLabelText('Model ID')).toBeEnabled();
  });
  it('tests the edited Model ID only after explicit click without changing the saved connection', async () => {
    const test = vi
      .spyOn(api, 'testProviderDraft')
      .mockResolvedValue({ status: 'verified', message: '连接正常。草稿尚未保存启用。' });
    const save = vi.spyOn(api, 'updateConfig');
    const { user, callback } = await setup();
    await user.clear(screen.getByLabelText('Model ID'));
    await user.type(screen.getByLabelText('Model ID'), 'manual-model');
    expect(test).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('status')).toHaveTextContent('草稿尚未保存');
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'manual-model' }),
      expect.any(AbortSignal),
    );
    expect(screen.getByLabelText('当前启用连接')).toHaveTextContent('saved-model');
    expect(save).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('Model ID'), '-edited');
    expect(screen.queryByText('连接正常。草稿尚未保存启用。')).not.toBeInTheDocument();
  });
  it('replaces a Key on save and clears plaintext without persisting it in browser storage', async () => {
    const save = vi.spyOn(api, 'updateConfig').mockResolvedValue(active({ runtimeGeneration: 4 }));
    const store = vi.spyOn(Storage.prototype, 'setItem');
    const test = vi.spyOn(api, 'testProviderDraft');
    const { user, callback } = await setup();
    await user.type(screen.getByLabelText('API Key'), 'offline-replacement-key');
    await user.click(screen.getByRole('button', { name: '保存并启用' }));
    expect(await screen.findByRole('status')).toHaveTextContent('模型服务已保存并启用');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: { action: 'replace', value: 'offline-replacement-key' },
        expectedGeneration: 3,
      }),
      expect.any(AbortSignal),
    );
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(document.body.textContent).not.toContain('offline-replacement-key');
    expect(store).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it('clears a saved Key only on save and keeps the disabled connection identity', async () => {
    const save = vi
      .spyOn(api, 'updateConfig')
      .mockResolvedValue(
        active({ apiKeyConfigured: false, complete: false, runtimeGeneration: 4 }),
      );
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: '清除 Key' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存并启用' }));
    expect(await screen.findByRole('status')).toHaveTextContent('API Key 已清除');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'moma', secret: { action: 'remove' } }),
      expect.any(AbortSignal),
    );
  });
  it('keeps the active connection and replacement draft when save fails', async () => {
    vi.spyOn(api, 'updateConfig').mockRejectedValue(new Error('配置保存不可用。'));
    const { user, callback } = await setup();
    await user.type(screen.getByLabelText('API Key'), 'offline-draft');
    await user.click(screen.getByRole('button', { name: '保存并启用' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(screen.getByLabelText('API Key')).toHaveValue('offline-draft');
    expect(screen.getByLabelText('当前启用连接')).toHaveTextContent('saved-model');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('cancels a late draft test without showing stale success', async () => {
    let complete!: (result: { status: 'verified'; message: string }) => void;
    vi.spyOn(api, 'testProviderDraft').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => complete({ status: 'verified', message: 'obsolete success' }));
    expect(screen.queryByText('obsolete success')).not.toBeInTheDocument();
  });
  it('cancels a late save without clearing a draft or changing active truth', async () => {
    let complete!: (result: SafeProviderConfig) => void;
    vi.spyOn(api, 'updateConfig').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { user, callback } = await setup();
    await user.type(screen.getByLabelText('API Key'), 'offline-draft');
    await user.click(screen.getByRole('button', { name: '保存并启用' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => complete(active({ provider: 'compatible' })));
    expect(screen.getByLabelText('API Key')).toHaveValue('offline-draft');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('reports an initial read failure without inventing an active connection', async () => {
    vi.spyOn(api, 'config').mockRejectedValue(new Error('本地配置不可达。'));
    render(<ModelServiceSettings onActiveConfig={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取服务器配置');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
  it('never publishes an initial read after unmount', async () => {
    let complete!: (result: SafeProviderConfig) => void;
    vi.spyOn(api, 'config').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const callback = vi.fn();
    const { unmount } = render(<ModelServiceSettings onActiveConfig={callback} />);
    unmount();
    await act(async () => complete(active()));
    await waitFor(() => expect(callback).not.toHaveBeenCalled());
  });
});
