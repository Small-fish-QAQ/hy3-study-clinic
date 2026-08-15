import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderMode, SafeProviderConfig } from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface SettingsViewProps {
  provider?: ProviderMode | null;
  onProviderChange?: (provider: ProviderMode) => void;
  currentCourseId?: string | null;
  currentCourseName?: string | null;
  sidebarDefaultCollapsed: boolean;
  onSidebarDefaultCollapsedChange: (collapsed: boolean) => void;
}

const labels: Record<ProviderMode, string> = { fake: '模拟模式', hy3: 'Hy3 模式' };

export function SettingsView({
  provider = null,
  onProviderChange,
  currentCourseId = null,
  currentCourseName = null,
  sidebarDefaultCollapsed,
  onSidebarDefaultCollapsedChange,
}: SettingsViewProps) {
  const load = useAsyncAction();
  const save = useAsyncAction();
  const localCheck = useAsyncAction();
  const externalTest = useAsyncAction();
  const [active, setActive] = useState<SafeProviderConfig | null>(null);
  const [draft, setDraft] = useState({
    provider: provider ?? ('fake' as ProviderMode),
    baseUrl: '',
    model: '',
  });
  const [secret, setSecret] = useState('');
  const [secretMode, setSecretMode] = useState<'unchanged' | 'replace' | 'remove'>('unchanged');
  const [editingSecret, setEditingSecret] = useState(false);
  const [localStatus, setLocalStatus] = useState<'unknown' | 'ok'>('unknown');
  const runLoad = load.run;
  const onProviderChangeRef = useRef(onProviderChange);

  useEffect(() => {
    onProviderChangeRef.current = onProviderChange;
  }, [onProviderChange]);

  const applyActiveConfig = useCallback((result: SafeProviderConfig, syncDraft = true) => {
    setActive(result);
    if (syncDraft) {
      setDraft({
        provider: result.provider,
        baseUrl: result.baseUrl ?? '',
        model: result.model ?? '',
      });
    }
    onProviderChangeRef.current?.(result.provider);
  }, []);
  const loadConfig = useCallback((signal: AbortSignal) => api.config(signal), []);

  useEffect(() => {
    void runLoad(loadConfig).then((result) => {
      if (result) applyActiveConfig(result);
    });
  }, [runLoad, loadConfig, applyActiveConfig]);

  const current = active;
  const dirty = Boolean(
    current &&
    (draft.provider !== current.provider ||
      draft.baseUrl !== (current.baseUrl ?? '') ||
      draft.model !== (current.model ?? '') ||
      secretMode !== 'unchanged' ||
      secret.length > 0),
  );
  const draftApiKeyConfigured =
    secretMode === 'replace'
      ? Boolean(secret.trim())
      : secretMode === 'remove'
        ? false
        : Boolean(current?.apiKeyConfigured);
  const hy3DraftComplete =
    draft.provider === 'fake' ||
    Boolean(draft.baseUrl.trim() && draft.model.trim() && draftApiKeyConfigured);
  const secretInvalid = secretMode === 'replace' && !secret.trim();
  const formLocked = save.loading || localCheck.loading || externalTest.loading;

  function resetDraft() {
    if (!current) return;
    setDraft({
      provider: current.provider,
      baseUrl: current.baseUrl ?? '',
      model: current.model ?? '',
    });
    setSecret('');
    setSecretMode('unchanged');
    setEditingSecret(false);
  }

  async function saveConfig() {
    if (!current) return;
    if (secretInvalid || (draft.provider === 'hy3' && !hy3DraftComplete)) return;
    externalTest.cancel();
    externalTest.clearError();
    const result = await save.run((signal) =>
      api.updateConfig(
        {
          provider: draft.provider,
          ...(draft.provider === 'hy3' ? { baseUrl: draft.baseUrl, model: draft.model } : {}),
          secret:
            secretMode === 'replace'
              ? { action: 'replace', value: secret }
              : { action: secretMode },
        },
        signal,
      ),
    );
    if (!result) return;
    applyActiveConfig(result);
    setSecret('');
    setSecretMode('unchanged');
    setEditingSecret(false);
  }

  async function checkLocalService() {
    setLocalStatus('unknown');
    const result = await localCheck.run(async (signal) => {
      const health = await api.health(signal);
      const config = await api.config(signal);
      return { health, config };
    });
    if (result) {
      setLocalStatus('ok');
      externalTest.clearError();
      applyActiveConfig(result.config, !dirty);
    }
  }

  async function testHy3() {
    const result = await externalTest.run((signal) => api.testProviderConnection(signal));
    if (result) applyActiveConfig(result);
  }

  const connectionStatus = dirty
    ? 'untested'
    : externalTest.loading
      ? 'testing'
      : externalTest.error
        ? 'failed'
        : (current?.externalConnection.status ?? 'untested');
  const sourceLabel =
    current?.source === 'saved'
      ? '保存的设置'
      : current?.source === 'environment'
        ? '服务器环境变量'
        : '默认值';

  return (
    <div className="settings-view" aria-labelledby="settings-title">
      <header className="settings-page-intro">
        <p className="eyebrow">系统</p>
        <h2 id="settings-title">设置</h2>
        <p className="muted">查看运行方式并调整这台设备上的界面偏好。</p>
      </header>

      <section className="settings-section settings-connection" aria-labelledby="connection-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="connection-title">提供程序与连接</h3>
            <p className="muted">配置由服务器验证、保存并激活；浏览器不会保存凭据。</p>
          </div>
          <RuntimeBadge provider={current?.provider ?? null} />
        </div>

        {load.loading && !current ? <Loading label="正在读取服务器配置" /> : null}
        {load.error ? (
          <Banner kind="error">
            <strong>无法读取服务器配置。</strong> {load.error}
          </Banner>
        ) : null}
        {current ? (
          <>
            <fieldset className="settings-mode-picker">
              <legend>运行模式</legend>
              {(['hy3', 'fake'] as ProviderMode[]).map((mode) => (
                <label key={mode} className="settings-mode-option">
                  <input
                    type="radio"
                    name="provider-mode"
                    checked={draft.provider === mode}
                    disabled={formLocked}
                    onChange={() => setDraft((v) => ({ ...v, provider: mode }))}
                  />
                  <span>{labels[mode]}</span>
                </label>
              ))}
            </fieldset>
            {draft.provider === 'hy3' ? (
              <div className="settings-provider-form">
                <label>
                  <span>API 地址</span>
                  <input
                    value={draft.baseUrl}
                    disabled={formLocked}
                    onChange={(e) => setDraft((v) => ({ ...v, baseUrl: e.target.value }))}
                    placeholder="https://…"
                    inputMode="url"
                  />
                </label>
                <label>
                  <span>模型 / 服务</span>
                  <input
                    value={draft.model}
                    disabled={formLocked}
                    onChange={(e) => setDraft((v) => ({ ...v, model: e.target.value }))}
                  />
                </label>
                <label>
                  <span>API Key / Token</span>
                  {current.apiKeyConfigured && !editingSecret && secretMode === 'unchanged' ? (
                    <span className="settings-secret-configured">
                      已配置{' '}
                      <button
                        type="button"
                        className="ghost"
                        disabled={formLocked}
                        onClick={() => setEditingSecret(true)}
                      >
                        更改
                      </button>
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={formLocked}
                        onClick={() => {
                          if (window.confirm('移除已保存的 Hy3 凭据并切换到本地模拟模式？')) {
                            setSecretMode('remove');
                            setDraft((value) => ({ ...value, provider: 'fake' }));
                          }
                        }}
                      >
                        移除凭据
                      </button>
                    </span>
                  ) : (
                    <span className="settings-secret-editor">
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        disabled={formLocked}
                        onChange={(e) => {
                          setSecret(e.target.value);
                          setSecretMode('replace');
                        }}
                        placeholder={current.apiKeyConfigured ? '输入新凭据' : '输入凭据'}
                      />
                      {editingSecret ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={formLocked}
                          onClick={() => {
                            setSecret('');
                            setSecretMode('unchanged');
                            setEditingSecret(false);
                          }}
                        >
                          取消更改
                        </button>
                      ) : null}
                    </span>
                  )}
                </label>
              </div>
            ) : (
              <p className="muted settings-fake-note">
                当前使用模拟模式。本地模拟模式不会调用外部服务，也不会删除已保存的 Hy3 凭据。
              </p>
            )}

            <div className="settings-status-strip">
              <div>
                <strong>
                  {dirty
                    ? '更改尚未保存'
                    : current.provider === 'fake'
                      ? '当前使用模拟模式'
                      : '服务器已配置为 Hy3 模式'}
                </strong>
                <p>
                  {dirty
                    ? `保存后将使用${draft.provider === 'fake' ? '模拟模式' : 'Hy3 模式'}；当前活动配置保持不变。`
                    : current.provider === 'fake'
                      ? '适合离线开发、测试与演示。'
                      : `${current.complete ? '配置完整，可按需测试外部连接。' : '请补全 API 地址、凭据和模型。'} 这里显示的是配置状态，不代表凭据已经验证。`}
                </p>
              </div>
              <div className="settings-action-row">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    !dirty ||
                    formLocked ||
                    secretInvalid ||
                    (draft.provider === 'hy3' && !hy3DraftComplete)
                  }
                  onClick={() => void saveConfig()}
                >
                  {save.loading ? '正在保存' : '保存更改'}
                </button>
                {dirty ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={formLocked}
                    onClick={resetDraft}
                  >
                    重置
                  </button>
                ) : null}
              </div>
            </div>
            {save.error ? (
              <Banner kind="error">
                <strong>保存失败。</strong> {save.error}
              </Banner>
            ) : null}

            <dl className="settings-runtime-facts" aria-label="运行与配置边界">
              <div>
                <dt>Study Clinic 服务</dt>
                <dd>{localCheck.error ? '异常' : localStatus === 'ok' ? '正常' : '尚未检查'}</dd>
              </div>
              <div>
                <dt>提供程序</dt>
                <dd>
                  {labels[current.provider]} · {current.complete ? '配置完整' : '配置不完整'}
                </dd>
              </div>
              <div>
                <dt>配置来源</dt>
                <dd>{sourceLabel}</dd>
              </div>
              <div>
                <dt>外部 Hy3 连接</dt>
                <dd>
                  {connectionStatus === 'verified'
                    ? '已验证'
                    : connectionStatus === 'failed'
                      ? '失败'
                      : connectionStatus === 'testing'
                        ? '测试中'
                        : '未测试'}
                </dd>
              </div>
            </dl>
            <div className="settings-action-row">
              <button
                type="button"
                className="primary"
                disabled={localCheck.loading || save.loading || externalTest.loading}
                onClick={() => void checkLocalService()}
              >
                {localCheck.loading ? '正在检查' : '检查本地服务状态'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={
                  externalTest.loading ||
                  save.loading ||
                  dirty ||
                  current.provider !== 'hy3' ||
                  !current.complete
                }
                onClick={() => void testHy3()}
              >
                {externalTest.loading ? '正在测试' : '测试 Hy3 连接'}
              </button>
              {save.loading || localCheck.loading || externalTest.loading ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    localCheck.cancel();
                    externalTest.cancel();
                    save.cancel();
                  }}
                >
                  取消
                </button>
              ) : null}
            </div>
            {localStatus === 'ok' ? (
              <div className="settings-connection-result success" role="status" aria-live="polite">
                <strong>本地服务可访问</strong>
                <span>服务器运行方式：{current.provider === 'hy3' ? 'Hy3 模式' : '模拟模式'}</span>
                <small>只确认本地服务响应，不验证 Hy3 凭据或外部服务可用性。</small>
              </div>
            ) : null}
            {localCheck.error ? (
              <Banner kind="error">
                <strong>无法连接本地服务。</strong> {localCheck.error}
              </Banner>
            ) : null}
            {externalTest.error && !dirty ? (
              <Banner kind="error">
                <strong>Hy3 连接失败。</strong> {externalTest.error}
              </Banner>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        className="settings-section settings-preferences"
        aria-labelledby="preferences-title"
      >
        <div className="settings-section-heading">
          <div>
            <h3 id="preferences-title">工作区偏好</h3>
            <p className="muted">这些偏好只影响界面，不会改变课程或学习记录。</p>
          </div>
        </div>
        <label className="settings-preference-row">
          <span className="settings-preference-copy">
            <strong>默认展开课程侧边栏</strong>
            <small>在宽屏设备上进入课程工作区时显示完整导航。</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={!sidebarDefaultCollapsed}
            onChange={(event) => onSidebarDefaultCollapsedChange(!event.target.checked)}
          />
        </label>
        <div className="settings-preference-row" aria-label="课程连续性">
          <span className="settings-preference-copy">
            <strong>恢复最近选择的课程</strong>
            <small>在这台设备上切换页面或重新打开应用时保留课程上下文。</small>
          </span>
          <span className="settings-readonly-value">
            {currentCourseName ? `已启用 · ${currentCourseName}` : '已启用 · 尚未选择课程'}
          </span>
        </div>
      </section>

      <details className="settings-disclosure">
        <summary>诊断与关于</summary>
        <div className="settings-diagnostics">
          <dl>
            <div>
              <dt>产品</dt>
              <dd>Hy3 Study Clinic</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>0.1.0</dd>
            </div>
            <div>
              <dt>服务器运行方式</dt>
              <dd>{current ? labels[current.provider] : '尚未读取'}</dd>
            </div>
            <div>
              <dt>当前课程</dt>
              <dd>{currentCourseName ?? '尚未选择'}</dd>
            </div>
            {currentCourseId ? (
              <div>
                <dt>课程 ID</dt>
                <dd>{currentCourseId}</dd>
              </div>
            ) : null}
            <div>
              <dt>配置权限</dt>
              <dd>提供程序与凭据由服务器管理</dd>
            </div>
          </dl>
          <p className="muted">
            Hy3 负责有依据的生成与语义判断；分数、学习状态和持久化变更仍由本地确定性代码控制。
          </p>
        </div>
      </details>
    </div>
  );
}

function RuntimeBadge({ provider }: { provider: ProviderMode | null }) {
  return (
    <span className={`settings-runtime-badge ${provider ?? 'unknown'}`}>
      <span className="settings-runtime-dot" aria-hidden="true" />
      {provider ? labels[provider] : '状态未知'}
    </span>
  );
}
