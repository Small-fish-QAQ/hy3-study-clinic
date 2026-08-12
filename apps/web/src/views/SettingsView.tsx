import { useState } from 'react';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

type Provider = 'fake' | 'hy3';

export interface SettingsViewProps {
  provider?: Provider | null;
  currentCourseId?: string | null;
  currentCourseName?: string | null;
  sidebarDefaultCollapsed: boolean;
  onSidebarDefaultCollapsedChange: (collapsed: boolean) => void;
}

interface ConnectionResult {
  provider: Provider;
  healthStatus: string;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  fake: '模拟模式',
  hy3: 'Hy3 在线模式',
};

/** System-level settings. Server-owned provider configuration is intentionally read-only here. */
export function SettingsView({
  provider = null,
  currentCourseId = null,
  currentCourseName = null,
  sidebarDefaultCollapsed,
  onSidebarDefaultCollapsedChange,
}: SettingsViewProps) {
  const connection = useAsyncAction();
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);

  async function checkLocalService(): Promise<void> {
    setConnectionResult(null);
    const result = await connection.run(async (signal) => {
      const [health, config] = await Promise.all([api.health(signal), api.config(signal)]);
      return { provider: config.provider, healthStatus: health.status };
    });
    if (result) setConnectionResult(result);
  }

  const displayedProvider = connectionResult?.provider ?? provider;

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
            <p className="muted">提供程序由服务器启动配置决定，不能在浏览器中更改。</p>
          </div>
          <RuntimeBadge provider={displayedProvider} />
        </div>

        <div className="settings-status-strip">
          <div>
            <strong>{providerHeading(displayedProvider)}</strong>
            <p>{providerDescription(displayedProvider)}</p>
          </div>
          <div className="settings-action-row">
            <button
              type="button"
              className="primary"
              disabled={connection.loading}
              onClick={() => void checkLocalService()}
            >
              {connection.loading ? '正在检查' : '检查本地服务状态'}
            </button>
            {connection.loading ? (
              <button type="button" className="ghost" onClick={connection.cancel}>
                取消
              </button>
            ) : null}
          </div>
        </div>

        {connection.loading ? <Loading label="正在检查本地服务" /> : null}
        {connection.error ? (
          <Banner kind="error">
            <strong>无法连接本地服务。</strong> {connection.error}
          </Banner>
        ) : null}
        {connectionResult ? (
          <div className="settings-connection-result success" role="status" aria-live="polite">
            <strong>本地服务可访问</strong>
            <span>服务器运行方式：{PROVIDER_LABELS[connectionResult.provider]}</span>
            <small>这项检查只确认本地服务响应，不验证 Hy3 凭据或外部服务可用性。</small>
          </div>
        ) : null}

        <dl className="settings-runtime-facts" aria-label="运行与配置边界">
          <div>
            <dt>Study Clinic API</dt>
            <dd>{connectionResult ? '本地服务可访问' : '尚未检查'}</dd>
          </div>
          <div>
            <dt>提供程序模式</dt>
            <dd>{displayedProvider ? PROVIDER_LABELS[displayedProvider] : '尚未读取'}</dd>
          </div>
          <div>
            <dt>配置来源</dt>
            <dd>服务器启动环境（浏览器只读）</dd>
          </div>
          <div>
            <dt>外部 Hy3 可用性</dt>
            <dd>此页面不检查凭据或外部服务</dd>
          </div>
        </dl>
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
              <dd>{displayedProvider ? PROVIDER_LABELS[displayedProvider] : '尚未读取'}</dd>
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
              <dd>提供程序与凭据由服务器启动配置管理</dd>
            </div>
            {connectionResult ? (
              <div>
                <dt>本地健康状态</dt>
                <dd>{connectionResult.healthStatus}</dd>
              </div>
            ) : null}
          </dl>
          <p className="muted">
            Hy3 负责有依据的生成与语义判断；分数、学习状态和持久化变更仍由本地确定性代码控制。
          </p>
        </div>
      </details>
    </div>
  );
}

function RuntimeBadge({ provider }: { provider: Provider | null }) {
  return (
    <span className={`settings-runtime-badge ${provider ?? 'unknown'}`}>
      <span className="settings-runtime-dot" aria-hidden="true" />
      {provider ? PROVIDER_LABELS[provider] : '状态未知'}
    </span>
  );
}

function providerHeading(provider: Provider | null): string {
  if (provider === 'fake') return '当前使用模拟模式';
  if (provider === 'hy3') return '服务器已配置为 Hy3 在线模式';
  return '正在等待服务器运行信息';
}

function providerDescription(provider: Provider | null): string {
  if (provider === 'fake') {
    return '使用本地确定性模拟提供程序，适合离线开发与演示；不会调用真实 Hy3 服务。';
  }
  if (provider === 'hy3') {
    return '生成请求将由服务器交给 Hy3；这里显示的是启动配置，不代表凭据已经验证。';
  }
  return '连接本地服务后可以读取当前运行方式。';
}
