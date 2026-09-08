import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  type ProviderMode,
  type SafeProviderConfig,
  type WorkspaceSummary,
} from '@hy3-clinic/shared';
import { api } from '../api.js';
import { Banner, Loading } from '../components/ui.js';
import { useAsyncAction } from '../components/useAsyncAction.js';

export interface SettingsViewProps {
  provider?: ProviderMode | null;
  onProviderChange?: (provider: ProviderMode) => void;
  currentCourseId?: string | null;
  currentCourseName?: string | null;
  courses?: WorkspaceSummary[];
  courseLifecycleLoading?: boolean;
  courseLifecycleError?: string | null;
  courseLifecycleOperation?: 'create' | 'rename' | 'delete' | null;
  onCreateCourse?: (name: string) => Promise<boolean>;
  onRenameCourse?: (courseId: string, name: string) => Promise<boolean>;
  onDeleteCourse?: (courseId: string) => Promise<boolean>;
  onClearCourseLifecycleError?: () => void;
  sidebarDefaultCollapsed: boolean;
  onSidebarDefaultCollapsedChange: (collapsed: boolean) => void;
}

const labels: Record<ProviderMode, string> = { fake: '模拟模式', hy3: 'Hy3 模式' };
const DIALOG_FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

function formatConnectionTestTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

export function SettingsView({
  provider = null,
  onProviderChange,
  currentCourseId = null,
  currentCourseName = null,
  courses = [],
  courseLifecycleLoading = false,
  courseLifecycleError = null,
  courseLifecycleOperation = null,
  onCreateCourse,
  onRenameCourse,
  onDeleteCourse,
  onClearCourseLifecycleError,
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
  const [newCourseName, setNewCourseName] = useState('');
  const [renameCourseName, setRenameCourseName] = useState(currentCourseName ?? '');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const runLoad = load.run;
  const onProviderChangeRef = useRef(onProviderChange);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteConfirmInputRef = useRef<HTMLInputElement | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const lifecycleLoadingRef = useRef(courseLifecycleLoading);

  useEffect(() => {
    onProviderChangeRef.current = onProviderChange;
  }, [onProviderChange]);

  useEffect(() => {
    lifecycleLoadingRef.current = courseLifecycleLoading;
  }, [courseLifecycleLoading]);

  useEffect(() => {
    setRenameCourseName(currentCourseName ?? '');
    setDeleteConfirmation('');
    setDeleteDialogOpen(false);
  }, [currentCourseId, currentCourseName]);

  useEffect(() => {
    if (!deleteDialogOpen) return;
    const dialog = deleteDialogRef.current;
    if (!dialog) return;

    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        inerted.push({ element: sibling, wasInert: sibling.hasAttribute('inert') });
        sibling.setAttribute('inert', '');
      }
      branch = parent;
      if (branch.classList.contains('agent-course-shell')) break;
    }

    const focusFrame = window.requestAnimationFrame(() => deleteConfirmInputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lifecycleLoadingRef.current) {
        event.preventDefault();
        setDeleteDialogOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)].filter(
        (element) => !element.hidden,
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      for (const { element, wasInert } of inerted) {
        if (!wasInert) element.removeAttribute('inert');
      }
      const opener = deleteOpenerRef.current;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [deleteDialogOpen]);

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

  async function createCourse(): Promise<void> {
    const name = newCourseName.trim();
    if (!name || !onCreateCourse) return;
    if (await onCreateCourse(name)) setNewCourseName('');
  }

  async function renameCourse(): Promise<void> {
    const name = renameCourseName.trim();
    if (!currentCourseId || !name || !onRenameCourse || name === currentCourseName) return;
    if (await onRenameCourse(currentCourseId, name)) setRenameCourseName(name);
  }

  async function deleteCourse(): Promise<void> {
    if (!currentCourseId || !onDeleteCourse) return;
    if (await onDeleteCourse(currentCourseId)) setDeleteDialogOpen(false);
  }

  function closeDeleteDialog(): void {
    if (courseLifecycleLoading) return;
    setDeleteDialogOpen(false);
    setDeleteConfirmation('');
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
  const currentCourse = courses.find((course) => course.id === currentCourseId) ?? null;
  const deleteConfirmationMatches =
    currentCourseName !== null && deleteConfirmation === currentCourseName;

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
            <fieldset className="settings-mode-picker" aria-label="运行方式">
              <legend>运行方式</legend>
              {(['hy3', 'fake'] as ProviderMode[]).map((mode) => (
                <label
                  key={mode}
                  className={`settings-mode-option ${draft.provider === mode ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="provider-mode"
                    aria-label={labels[mode]}
                    checked={draft.provider === mode}
                    disabled={formLocked}
                    onChange={() => setDraft((v) => ({ ...v, provider: mode }))}
                  />
                  <span>{mode === 'hy3' ? 'Hy3 在线' : '模拟模式'}</span>
                </label>
              ))}
            </fieldset>
            <div className="settings-config-group" aria-label="提供程序配置">
              <div className="settings-config-heading">
                <div>
                  <h4>{draft.provider === 'hy3' ? 'Hy3 配置' : '模拟模式'}</h4>
                  <p className="muted">
                    {draft.provider === 'hy3'
                      ? '这些设置只保存在本地服务器；浏览器不会读取已保存的凭据。'
                      : '使用本地确定性模拟提供程序，不会调用外部服务。'}
                  </p>
                </div>
                <span className={`settings-dirty-indicator ${dirty ? 'dirty' : ''}`}>
                  {dirty ? '有未保存更改' : '已保存'}
                </span>
              </div>

              {draft.provider === 'hy3' ? (
                <div className="settings-provider-form">
                  <label>
                    <span>API 地址</span>
                    <input
                      className="settings-base-url-input"
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
                      className="settings-model-input"
                      value={draft.model}
                      disabled={formLocked}
                      onChange={(e) => setDraft((v) => ({ ...v, model: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>API Key / Token</span>
                    {current.apiKeyConfigured && !editingSecret && secretMode === 'unchanged' ? (
                      <span className="settings-secret-configured">
                        <span className="settings-configured-value">已配置</span>
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
                <details className="settings-saved-hy3">
                  <summary>已保存的 Hy3 配置</summary>
                  <dl>
                    <div>
                      <dt>API 地址</dt>
                      <dd>{current.baseUrl ?? '未配置'}</dd>
                    </div>
                    <div>
                      <dt>模型 / 服务</dt>
                      <dd>{current.model ?? '未配置'}</dd>
                    </div>
                    <div>
                      <dt>凭据</dt>
                      <dd>{current.apiKeyConfigured ? '已配置并保留' : '未配置'}</dd>
                    </div>
                  </dl>
                </details>
              )}

              <div className="settings-config-actions">
                <div>
                  <strong>
                    {dirty
                      ? '更改尚未保存'
                      : current.provider === 'fake'
                        ? '当前使用模拟模式'
                        : '服务器已配置为 Hy3 模式'}
                  </strong>
                  <p className="muted">
                    {dirty
                      ? `保存后将使用${draft.provider === 'fake' ? '模拟模式' : 'Hy3 模式'}；当前活动配置保持不变。`
                      : current.provider === 'fake'
                        ? '适合离线开发、测试与演示。'
                        : `${current.complete ? '配置完整，可按需测试外部连接。' : '请补全 API 地址、凭据和模型。'} 配置完整不代表凭据已经验证，也不保证后续大请求持续可用。`}
                  </p>
                </div>
                <div className="settings-action-row">
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
                </div>
              </div>
            </div>
            {save.error ? (
              <Banner kind="error">
                <strong>保存失败。</strong> {save.error}
              </Banner>
            ) : null}

            <div className="settings-connection-heading">
              <div>
                <h4 id="settings-connection-status">连接状态</h4>
                <p className="muted">服务、保存配置和最近一次 Hy3 测试是三项独立状态。</p>
              </div>
            </div>
            <dl className="settings-runtime-facts" aria-label="运行与配置边界">
              <div>
                <dt>Study Clinic 服务</dt>
                <dd>
                  <span
                    className={`settings-status-dot ${localCheck.error ? 'failed' : localStatus === 'ok' ? 'ok' : 'unknown'}`}
                    aria-hidden="true"
                  />
                  {localCheck.error ? '无法访问' : localStatus === 'ok' ? '正常' : '尚未检查'}
                </dd>
              </div>
              <div>
                <dt>保存的提供程序配置</dt>
                <dd>
                  <span
                    className={`settings-status-dot ${current.complete ? 'ok' : 'failed'}`}
                    aria-hidden="true"
                  />
                  {labels[current.provider]} · {sourceLabel} ·{' '}
                  {current.complete ? '配置完整' : '配置不完整'}
                </dd>
              </div>
              <div>
                <dt>上次 Hy3 连接测试</dt>
                <dd>
                  <span
                    className={`settings-status-dot ${connectionStatus === 'verified' ? 'ok' : connectionStatus === 'failed' ? 'failed' : 'unknown'}`}
                    aria-hidden="true"
                  />
                  {connectionStatus === 'verified'
                    ? current.externalConnection.testedAt
                      ? `已通过 · ${formatConnectionTestTime(current.externalConnection.testedAt)}`
                      : '已通过'
                    : connectionStatus === 'failed'
                      ? current.externalConnection.testedAt
                        ? `未通过 · ${formatConnectionTestTime(current.externalConnection.testedAt)}`
                        : '未通过 · 本次测试'
                      : connectionStatus === 'testing'
                        ? '正在测试'
                        : dirty
                          ? '配置已修改，保存后需重新测试'
                          : '尚未测试'}
                </dd>
              </div>
            </dl>
            <div className="settings-connection-actions">
              <button
                type="button"
                className="ghost"
                disabled={localCheck.loading || save.loading || externalTest.loading}
                onClick={() => void checkLocalService()}
              >
                {localCheck.loading ? '正在检查' : '检查本地服务状态'}
              </button>
              <button
                type="button"
                className="primary"
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
                <span className="settings-error-note">
                  此结果只属于本次连接测试，不会把已保存凭据标记为无效。
                </span>
              </Banner>
            ) : null}
          </>
        ) : null}
      </section>

      {onCreateCourse ? (
        <section
          className="settings-section settings-course-lifecycle"
          aria-labelledby="course-lifecycle-title"
        >
          <div className="settings-section-heading">
            <div>
              <h3 id="course-lifecycle-title">课程管理</h3>
              <p className="muted">创建和命名课程，或明确永久删除当前课程。</p>
            </div>
            <span className="settings-course-count">共 {courses.length} 门课程</span>
          </div>

          {courseLifecycleError ? (
            <Banner kind="error">
              <strong>
                {courseLifecycleOperation === 'delete'
                  ? '删除失败，课程及其学习历史没有被删除。'
                  : courseLifecycleOperation === 'rename'
                    ? '重命名失败，当前课程名称没有改变。'
                    : '创建失败，没有新增课程。'}
              </strong>{' '}
              {courseLifecycleError}
            </Banner>
          ) : null}

          <form
            className="settings-course-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createCourse();
            }}
          >
            <label htmlFor="settings-create-course">创建另一门课程</label>
            <div className="settings-course-control">
              <input
                id="settings-create-course"
                value={newCourseName}
                maxLength={WORKSPACE_NAME_MAX_LENGTH}
                disabled={courseLifecycleLoading}
                placeholder="课程名称"
                onChange={(event) => setNewCourseName(event.target.value)}
              />
              <button
                type="submit"
                className="primary"
                disabled={courseLifecycleLoading || newCourseName.trim().length === 0}
              >
                {courseLifecycleLoading && courseLifecycleOperation === 'create'
                  ? '正在创建'
                  : '创建课程'}
              </button>
            </div>
          </form>

          {currentCourseId && currentCourseName ? (
            <>
              <form
                className="settings-course-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameCourse();
                }}
              >
                <label htmlFor="settings-rename-course">当前课程名称</label>
                <div className="settings-course-control">
                  <input
                    id="settings-rename-course"
                    value={renameCourseName}
                    maxLength={WORKSPACE_NAME_MAX_LENGTH}
                    disabled={courseLifecycleLoading}
                    onChange={(event) => setRenameCourseName(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="primary"
                    disabled={
                      courseLifecycleLoading ||
                      renameCourseName.trim().length === 0 ||
                      renameCourseName.trim() === currentCourseName
                    }
                  >
                    {courseLifecycleLoading && courseLifecycleOperation === 'rename'
                      ? '正在保存'
                      : '保存名称'}
                  </button>
                </div>
              </form>

              {currentCourse ? (
                <dl className="settings-course-facts" aria-label="当前课程内容数量">
                  <div>
                    <dt>课程资料</dt>
                    <dd>{currentCourse.documentCount} 份</dd>
                  </div>
                  <div>
                    <dt>图谱概念</dt>
                    <dd>{currentCourse.conceptCount} 个</dd>
                  </div>
                </dl>
              ) : null}

              <div className="settings-danger-zone">
                <div>
                  <strong>永久删除当前课程</strong>
                  <p>
                    删除会一并移除资料、已接受学习路线、Evidence、Repair、Review、掌握度和全部学习历史，且无法恢复。
                  </p>
                </div>
                <button
                  type="button"
                  className="danger settings-delete-course"
                  disabled={courseLifecycleLoading}
                  onClick={(event) => {
                    deleteOpenerRef.current = event.currentTarget;
                    setDeleteConfirmation('');
                    onClearCourseLifecycleError?.();
                    setDeleteDialogOpen(true);
                  }}
                >
                  删除当前课程
                </button>
              </div>
            </>
          ) : (
            <p className="muted settings-no-current-course">
              尚未选择课程。创建课程后可在这里重命名或永久删除。
            </p>
          )}
        </section>
      ) : null}

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
          <div className="studio-about-brand">
            <img src="/brand/understanding-pine.png" width="44" height="44" alt="" />
            <div>
              <strong>Study Clinic</strong>
              <p>把不懂的地方，一步步学明白。</p>
            </div>
          </div>
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

      {deleteDialogOpen && currentCourseId && currentCourseName ? (
        <div className="settings-dialog-backdrop">
          <div
            ref={deleteDialogRef}
            className="settings-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="settings-delete-title"
            aria-describedby="settings-delete-description"
            aria-busy={courseLifecycleLoading || undefined}
          >
            <header>
              <p className="eyebrow">危险操作</p>
              <h3 id="settings-delete-title">永久删除「{currentCourseName}」？</h3>
            </header>
            <p id="settings-delete-description">
              这会永久删除当前课程、{currentCourse?.documentCount ?? 0} 份资料、
              {currentCourse?.conceptCount ?? 0}{' '}
              个图谱概念、已接受学习路线、Evidence、Repair、Review、掌握度与全部学习历史。此操作无法撤销。
            </p>
            <label htmlFor="settings-delete-confirmation">
              输入课程名称 <strong>{currentCourseName}</strong> 以确认
            </label>
            <input
              ref={deleteConfirmInputRef}
              id="settings-delete-confirmation"
              value={deleteConfirmation}
              disabled={courseLifecycleLoading}
              autoComplete="off"
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
            {courseLifecycleError && courseLifecycleOperation === 'delete' ? (
              <Banner kind="error">
                <strong>删除失败，课程及其学习历史没有被删除。</strong> {courseLifecycleError}
              </Banner>
            ) : null}
            <div className="settings-dialog-actions">
              <button
                type="button"
                className="ghost"
                disabled={courseLifecycleLoading}
                onClick={closeDeleteDialog}
              >
                取消
              </button>
              <button
                type="button"
                className="danger settings-delete-confirm"
                disabled={courseLifecycleLoading || !deleteConfirmationMatches}
                onClick={() => void deleteCourse()}
              >
                {courseLifecycleLoading && courseLifecycleOperation === 'delete'
                  ? '正在永久删除'
                  : '永久删除课程'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
