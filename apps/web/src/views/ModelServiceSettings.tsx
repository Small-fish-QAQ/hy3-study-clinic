import { useEffect, useRef, useState } from 'react';
import type {
  ProviderConfigUpdate,
  ProviderMode,
  SafeProviderConfig,
  ReasoningEffortPreference,
} from '@hy3-clinic/shared';
import { api } from '../clinicApi.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

// Official API overview, checked 2026-10-10. A preset, never a business endpoint.
export const MOMA_DEFAULT_BASE_URL = 'https://zhenze-huhehaote.cmecloud.cn/v1';
export const MOMA_API_DOCUMENTATION = 'https://ecloud.10086.cn/op-help-center/doc/article/98330';
export const PROVIDER_LABELS: Record<ProviderMode, string> = {
  fake: '模拟模式',
  hy3: 'Hy3 历史配置',
  moma: '移动云 MoMA',
  compatible: '其他兼容平台',
};
type Draft = { provider: Exclude<ProviderMode, 'fake'>; baseUrl: string; model: string };
const freshDraft = (provider: 'moma' | 'compatible' = 'moma'): Draft => ({
  provider,
  baseUrl: provider === 'moma' ? MOMA_DEFAULT_BASE_URL : '',
  model: '',
});
const fromActive = (config: SafeProviderConfig): Draft =>
  config.provider === 'fake'
    ? freshDraft()
    : {
        provider: config.provider,
        baseUrl: config.baseUrl || (config.provider === 'moma' ? MOMA_DEFAULT_BASE_URL : ''),
        model: config.model ?? '',
      };

export function ModelServiceSettings({
  onActiveConfig,
}: {
  onActiveConfig: (config: SafeProviderConfig) => void;
}) {
  const load = useAsyncAction();
  const save = useAsyncAction();
  const discover = useAsyncAction();
  const test = useAsyncAction();
  const local = useAsyncAction();
  const [active, setActive] = useState<SafeProviderConfig | null>(null);
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [secret, setSecret] = useState('');
  const [secretAction, setSecretAction] = useState<'unchanged' | 'replace' | 'remove'>('unchanged');
  const [models, setModels] = useState<string[]>([]);
  const [modelNotice, setModelNotice] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [localMessage, setLocalMessage] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortPreference>('auto');
  const [timeouts, setTimeouts] = useState({
    timeoutMs: 30000,
    longTaskTimeoutMs: 240000,
    maxOutputTokens: 64000,
  });
  const callback = useRef(onActiveConfig);
  const runLoad = load.run;
  useEffect(() => {
    callback.current = onActiveConfig;
  }, [onActiveConfig]);
  useEffect(() => {
    void runLoad((signal) => api.config(signal)).then((result) => {
      if (!result) return;
      setActive(result);
      setDraft(fromActive(result));
      setReasoningEffort(result.reasoningEffort ?? 'auto');
      setTimeouts({
        timeoutMs: result.timeoutMs ?? 30000,
        longTaskTimeoutMs: result.longTaskTimeoutMs ?? 240000,
        maxOutputTokens: result.maxOutputTokens ?? 64000,
      });
      callback.current(result);
    });
  }, [runLoad]);

  const savedKeyAvailable = active?.provider === draft.provider && active.apiKeyConfigured;
  const hasKey =
    secretAction === 'replace'
      ? Boolean(secret.trim())
      : secretAction === 'remove'
        ? false
        : savedKeyAvailable;
  const hasAddress = Boolean(draft.baseUrl.trim() && hasKey);
  const complete = hasAddress && Boolean(draft.model.trim());
  const locked = save.loading || discover.loading || test.loading || local.loading;
  const dirty =
    active &&
    (draft.provider !== active.provider ||
      draft.baseUrl !== (active.baseUrl ?? '') ||
      draft.model !== (active.model ?? '') ||
      secretAction !== 'unchanged' ||
      reasoningEffort !== (active.reasoningEffort ?? 'auto'));

  function input(): ProviderConfigUpdate {
    return {
      ...draft,
      ...timeouts,
      reasoningEffort,
      expectedGeneration: active!.runtimeGeneration,
      secret:
        secretAction === 'replace'
          ? { action: 'replace', value: secret }
          : { action: secretAction },
    };
  }
  function clearFeedback() {
    setTestMessage('');
    setSaveMessage('');
    test.clearError();
    save.clearError();
  }
  function changeDraft(value: Partial<Draft>) {
    clearFeedback();
    if (value.baseUrl !== undefined) {
      setModels([]);
      setModelNotice('');
      discover.clearError();
    }
    setDraft((current) => ({ ...current, ...value }));
  }
  function choosePlatform(provider: 'moma' | 'compatible') {
    setDraft(active?.provider === provider ? fromActive(active) : freshDraft(provider));
    setSecret('');
    setSecretAction('unchanged');
    setModels([]);
    setModelNotice('');
    clearFeedback();
    discover.clearError();
  }
  function reset() {
    if (!active) return;
    setDraft(fromActive(active));
    setReasoningEffort(active.reasoningEffort ?? 'auto');
    setSecret('');
    setSecretAction('unchanged');
    setModels([]);
    setModelNotice('');
    clearFeedback();
    discover.clearError();
  }
  async function fetchModels() {
    setModelNotice('');
    setModels([]);
    const result = await discover.run((signal) => api.providerModels(input(), signal));
    if (result) {
      setModels(result.models);
      setModelNotice(
        result.models.length
          ? `已获取 ${result.models.length} 个模型，请选择或手动输入 Model ID。`
          : '账号返回了空列表，可以直接手动输入 Model ID。',
      );
    }
  }
  async function testConnection() {
    setTestMessage('');
    const result = await test.run((signal) => api.testProviderDraft(input(), signal));
    if (result) setTestMessage(result.message);
  }
  async function saveConfig() {
    setSaveMessage('');
    const result = await save.run((signal) => api.updateConfig(input(), signal));
    if (!result) return;
    setActive(result);
    setDraft(fromActive(result));
    setReasoningEffort(result.reasoningEffort ?? 'auto');
    setSecret('');
    setSecretAction('unchanged');
    setTestMessage('');
    callback.current(result);
    setSaveMessage(
      result.complete
        ? '模型服务已保存并启用。后续新任务使用这份连接。'
        : 'API Key 已清除。请重新配置后再运行模型任务。',
    );
  }
  async function checkLocal() {
    setLocalMessage('');
    const result = await local.run((signal) => api.health(signal));
    if (result) setLocalMessage('本地服务可访问。此检查不验证外部模型连接。');
  }

  return (
    <section
      className="settings-section settings-connection settings-model-service"
      aria-labelledby="connection-title"
    >
      <div className="settings-section-heading">
        <div>
          <h3 id="connection-title">模型服务</h3>
          <p className="muted">选择平台、连接模型，让现有课程使用真实 API。</p>
        </div>
        <span className={`settings-runtime-badge ${active?.provider ?? 'unknown'}`}>
          {active ? PROVIDER_LABELS[active.provider] : '正在读取'}
        </span>
      </div>
      {load.loading && !active ? <Loading label="正在读取服务器配置" /> : null}
      {load.error ? (
        <Banner kind="error">
          <strong>无法读取服务器配置。</strong> {load.error}
        </Banner>
      ) : null}
      {active ? (
        <>
          <p className="muted" aria-label="当前启用连接">
            当前启用：{PROVIDER_LABELS[active.provider]}
            {active.model ? ` · ${active.model}` : ''}。
            {active.provider === 'fake'
              ? '离线模拟不会调用外部服务。'
              : active.complete
                ? '配置已保存；不代表凭据已经验证。'
                : '配置尚未完整，请填写连接信息。'}
          </p>
          <fieldset className="settings-mode-picker" aria-label="平台">
            <legend>平台</legend>
            {(['moma', 'compatible'] as const).map((platform) => (
              <label
                key={platform}
                className={`settings-mode-option ${draft.provider === platform ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="model-platform"
                  checked={draft.provider === platform}
                  disabled={locked}
                  onChange={() => choosePlatform(platform)}
                />
                <span>{PROVIDER_LABELS[platform]}</span>
              </label>
            ))}
          </fieldset>
          <div className="settings-config-group" aria-label="模型服务草稿">
            <details className="settings-request-budgets">
              <summary>请求资源与等待时间</summary>
              <label>
                思考强度
                <select
                  value={reasoningEffort}
                  disabled={locked}
                  onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffortPreference)}
                >
                  <option value="auto">自动：按任务选择</option>
                  <option value="provider-default">平台默认</option>
                  <option value="low">low</option>
                  <option value="high">high</option>
                  <option value="max">max</option>
                </select>
              </label>
              <p className="muted">
                自动策略用于已验证的 MoMA glm-5.3；其他模型使用平台默认。手动档位须由当前平台支持。
              </p>
              <label>
                普通请求超时（毫秒）
                <input
                  type="number"
                  min={1}
                  value={timeouts.timeoutMs}
                  onChange={(e) =>
                    setTimeouts((v) => ({ ...v, timeoutMs: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                长任务超时（毫秒）
                <input
                  type="number"
                  min={1}
                  value={timeouts.longTaskTimeoutMs}
                  onChange={(e) =>
                    setTimeouts((v) => ({ ...v, longTaskTimeoutMs: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                模型最大输出 Token
                <input
                  type="number"
                  min={1}
                  value={timeouts.maxOutputTokens}
                  onChange={(e) =>
                    setTimeouts((v) => ({ ...v, maxOutputTokens: Number(e.target.value) }))
                  }
                />
              </label>
              <p className="muted">
                按实际模型能力配置。推理预算是软估计，正文为零或被截断仍会明确失败。
              </p>
            </details>
            <div className="settings-config-heading">
              <h4>连接信息</h4>
              <span className={`settings-dirty-indicator ${dirty ? 'dirty' : ''}`}>
                {dirty ? '有未保存更改' : '已保存'}
              </span>
            </div>
            {draft.provider === 'moma' ? (
              <p className="muted">
                已预填移动云 MoMA 的文本模型 API 地址。请以当前模型和套餐提供的地址为准。
                <a href={MOMA_API_DOCUMENTATION} target="_blank" rel="noreferrer">
                  查看官方接口总览
                </a>
              </p>
            ) : null}
            {draft.provider === 'hy3' ? (
              <p className="muted">正在编辑历史 Hy3 连接。选择其他平台可新建连接。</p>
            ) : null}
            <div className="settings-provider-form">
              <label>
                <span>API Base URL</span>
                <input
                  className="settings-base-url-input"
                  value={draft.baseUrl}
                  maxLength={2048}
                  disabled={locked}
                  onChange={(event) => changeDraft({ baseUrl: event.target.value })}
                  placeholder="https://…/v1"
                  inputMode="url"
                  autoComplete="off"
                />
              </label>
              <label>
                <span>API Key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={512}
                  value={secret}
                  disabled={locked}
                  placeholder={
                    savedKeyAvailable && secretAction === 'unchanged'
                      ? '已配置，留空保留'
                      : '输入 API Key'
                  }
                  onChange={(event) => {
                    setSecret(event.target.value);
                    setSecretAction(event.target.value ? 'replace' : 'unchanged');
                    setModels([]);
                    setModelNotice('');
                    discover.clearError();
                    clearFeedback();
                  }}
                />
              </label>
              {savedKeyAvailable ? (
                <div className="settings-secret-configured">
                  <span>
                    {secretAction === 'remove'
                      ? '保存后清除'
                      : secretAction === 'replace'
                        ? '保存后替换'
                        : 'Key 已配置'}
                  </span>
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={locked}
                    onClick={() => {
                      setSecret('');
                      setSecretAction(secretAction === 'remove' ? 'unchanged' : 'remove');
                      clearFeedback();
                      setModels([]);
                    }}
                  >
                    {secretAction === 'remove' ? '保留已保存 Key' : '清除 Key'}
                  </button>
                </div>
              ) : null}
              <label>
                <span>Model ID</span>
                <input
                  className="settings-model-input"
                  value={draft.model}
                  maxLength={256}
                  disabled={locked}
                  onChange={(event) => changeDraft({ model: event.target.value })}
                  placeholder="选择模型，或手动输入 Model ID"
                  autoComplete="off"
                />
              </label>
              <div className="settings-model-discovery">
                <button
                  type="button"
                  className="ghost"
                  disabled={locked || !hasAddress}
                  onClick={() => void fetchModels()}
                >
                  {discover.loading ? '正在获取模型' : models.length ? '刷新模型列表' : '获取模型'}
                </button>
                {models.length ? (
                  <label>
                    <span>可用模型</span>
                    <select
                      value={models.includes(draft.model) ? draft.model : ''}
                      disabled={locked}
                      onChange={(event) => changeDraft({ model: event.target.value })}
                    >
                      <option value="">请选择模型</option>
                      {models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
            {modelNotice ? (
              <p className="muted" role="status">
                {modelNotice}
              </p>
            ) : null}
            {discover.error ? (
              <Banner kind="error">获取模型失败。{discover.error} 仍可手动输入 Model ID。</Banner>
            ) : null}
            <p className="muted">
              支持 OpenAI-compatible Chat Completions。Key
              由本机服务端加密保存，浏览器只显示配置状态。
            </p>
            <div className="settings-action-row">
              <button
                type="button"
                className="ghost"
                disabled={locked || !complete}
                onClick={() => void testConnection()}
              >
                {test.loading ? '正在测试' : '测试连接'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={locked || !dirty || (!complete && secretAction !== 'remove')}
                onClick={() => void saveConfig()}
              >
                {save.loading ? '正在保存' : '保存并启用'}
              </button>
              {dirty ? (
                <button type="button" className="ghost" disabled={locked} onClick={reset}>
                  恢复已启用配置
                </button>
              ) : null}
              {locked ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    discover.cancel();
                    test.cancel();
                    save.cancel();
                    local.cancel();
                  }}
                >
                  取消
                </button>
              ) : null}
            </div>
            <p className="muted">
              测试连接会发送一次最小模型请求，可能产生费用。获取模型列表与保存不会发送 Chat
              Completions 请求。
            </p>
            {testMessage ? (
              <div className="settings-connection-result success" role="status">
                {testMessage}
              </div>
            ) : null}
            {test.error ? <Banner kind="error">连接测试失败。{test.error}</Banner> : null}
            {saveMessage ? (
              <div className="settings-connection-result success" role="status">
                {saveMessage}
              </div>
            ) : null}
            {save.error ? <Banner kind="error">保存失败。{save.error}</Banner> : null}
          </div>
          <details className="settings-saved-hy3">
            <summary>已启用连接与本地服务</summary>
            <p>
              {PROVIDER_LABELS[active.provider]} ·{' '}
              {active.source === 'saved'
                ? '保存的设置'
                : active.source === 'environment'
                  ? '服务器环境变量'
                  : '默认值'}{' '}
              · {active.complete ? '配置完整' : '配置不完整'}
            </p>
            <p className="muted">{active.baseUrl ?? '未配置 API 地址'}</p>
            <button
              type="button"
              className="ghost"
              disabled={locked}
              onClick={() => void checkLocal()}
            >
              检查本地服务状态
            </button>
            {localMessage ? <p role="status">{localMessage}</p> : null}
            {local.error ? <Banner kind="error">无法连接本地服务。{local.error}</Banner> : null}
          </details>
        </>
      ) : null}
    </section>
  );
}
