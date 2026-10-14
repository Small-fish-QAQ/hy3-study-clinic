import { useEffect, useState } from 'react';
import type {
  CourseOperation,
  CoursePreferences,
  CoursePlan,
  LessonDepth,
} from '@hy3-clinic/shared';
import type { ClinicMaterialSummary } from '../clinicApi.js';
import { materialTitle } from './ClinicMaterials.js';
import { OperationFailure } from '../components/OperationFailure.js';

export const depthLabel: Record<LessonDepth, string> = {
  introductory: '基础理解',
  standard: '熟练运用',
  proficient: '高水平表现',
  advanced: '深入迁移',
};
export const depthDescription: Record<LessonDepth, string> = {
  introductory: '从概念和直观例子起步，建立完整的基础理解。',
  standard: '讲清机制与适用条件，在新案例中推理并运用。',
  proficient: '辨析失败原因与边界，比较相互作用的条件和约束取舍。',
  advanced: '综合已有知识，在陌生情境中作出有依据的迁移与设计判断。',
};
export function ClinicPreparationStatus({
  operation,
  plan,
  syncError,
  busy,
  onRetry,
  onCancel,
  onSettings,
}: {
  operation: CourseOperation;
  plan: CoursePlan | null;
  syncError?: string;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onSettings: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const running = ['queued', 'running'].includes(operation.status);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const phase = operation.progress?.phase;
  const phaseIndex = phase ? ['knowledge', 'planning', 'validation', 'ready'].indexOf(phase) : -1;
  const done = operation.status === 'completed' && plan?.id === operation.resourceId;
  const stopped = ['failed', 'interrupted', 'cancelled'].includes(operation.status);
  const elapsed = Math.max(
    0,
    Math.floor(
      ((running ? now : Date.parse(operation.updatedAt)) - Date.parse(operation.createdAt)) / 1000,
    ),
  );
  const labels = ['提取完整知识', '组织课程与路线', '检查完整规划', '审阅并确认'];
  const content = (
    <>
      <div className="preparation-heading">
        <div className="section-heading">
          <p className="eyebrow">课程准备</p>
          <h2>
            {done
              ? '课程规划已经准备好'
              : operation.status === 'cancelled'
                ? '课程准备已停止'
                : stopped
                  ? '课程准备暂时中断'
                  : (operation.progress?.label ?? '正在开始课程准备')}
          </h2>
        </div>
        <span className="preparation-elapsed">
          {running ? '已用时' : '本次用时'} {Math.floor(elapsed / 60)}:
          {String(elapsed % 60).padStart(2, '0')}
        </span>
      </div>
      <ol>
        {labels.map((label, index) => {
          const complete = done ? index < 3 || plan?.status === 'accepted' : phaseIndex > index;
          const active = !complete && (phaseIndex === index || (phaseIndex === -1 && index === 0));
          const state = complete
            ? 'complete'
            : index === 3 && done
              ? 'review'
              : active && stopped
                ? 'blocked'
                : active && running
                  ? 'in_progress'
                  : 'pending';
          return (
            <li
              key={label}
              data-state={state}
              aria-current={
                active || (done && index === 3 && plan?.status === 'draft') ? 'step' : undefined
              }
            >
              <span className="preparation-step-number" aria-hidden="true">
                {complete ? '✓' : index + 1}
              </span>
              <div>
                <strong>{label}</strong>
                <small>
                  {complete
                    ? '已完成'
                    : state === 'review'
                      ? '等待你的审阅'
                      : state === 'blocked'
                        ? '等待继续'
                        : state === 'in_progress'
                          ? '进行中'
                          : '等待前一步'}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="preparation-observation">
        {operation.modelRequest && (
          <p className="small preparation-model-request" role="status">
            {operation.modelRequest.provider === 'moma' ? 'MoMA' : operation.modelRequest.provider}
            {' · '}
            {operation.modelRequest.model}
            {' · '}
            {running
              ? operation.modelRequest.responseReceived
                ? '已收到响应，正在读取与校验结果'
                : '请求已发起，等待模型返回'
              : operation.modelRequest.responseReceived
                ? '本次请求已收到响应'
                : '本次请求未收到响应，完成情况未知'}
            {running && !operation.modelRequest.responseReceived && (
              <span className="muted">
                {' '}
                · 本次最多等待 {Math.ceil(operation.modelRequest.timeoutMs / 1000)} 秒
              </span>
            )}
          </p>
        )}
        <div className="preparation-facts" aria-live="polite">
          {operation.progress && (
            <>
              <span>
                已保存 {operation.progress.completedSourceBlocks} /{' '}
                {operation.progress.totalSourceBlocks} 个来源片段
              </span>
              <span>{operation.progress.knowledgeCount} 个知识点</span>
              {operation.progress.lessonCount !== undefined && (
                <span>{operation.progress.lessonCount} 课</span>
              )}
            </>
          )}
        </div>
        <p className="small muted">
          {running
            ? '每完成一部分就保存有效结果。完整规划准备好后，由你审阅确认；此时不生成课文。'
            : done
              ? '完整知识、课程路线与考核范围已保存，确认后再按需打开 Lesson。'
              : '已有有效结果会保留，继续时复用已完成内容。'}
        </p>
        {running && now - Date.parse(operation.updatedAt) > 90000 && (
          <p className="small muted">
            暂未收到新的完整结果，已保存数量只在返回并校验后更新。你可以稍后回来查看。
          </p>
        )}
        {syncError && (
          <p role="alert">暂时无法同步进度。{syncError} 已保存结果不受影响，页面会继续查询。</p>
        )}
        {operation.error && (
          <div role="alert">
            <OperationFailure operation={operation} />
          </div>
        )}
      </div>
      {(running || stopped) && (
        <div className="preparation-controls">
          {running ? (
            <button disabled={busy} className="ghost" onClick={onCancel}>
              停止本次准备
            </button>
          ) : (
            <>
              <button
                disabled={busy || operation.error?.retryable === false}
                className="primary"
                onClick={onRetry}
              >
                {operation.status === 'cancelled' ? '继续准备课程' : '重试未完成部分'}
              </button>
              <button disabled={busy} className="ghost" onClick={onSettings}>
                调整准备设置
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
  return (
    <section
      className={`course-preparation-status${done ? ' is-ready' : ''}`}
      aria-label="课程准备状态"
      aria-busy={running}
    >
      {done ? (
        <details className="preparation-complete-disclosure">
          <summary>
            <strong>完整课程规划已准备好</strong>
            <span>
              已保存{' '}
              {operation.progress?.knowledgeCount ?? plan?.teachingRequiredKnowledgeIds.length}{' '}
              个知识点 · 查看准备记录
            </span>
          </summary>
          <div>{content}</div>
        </details>
      ) : (
        content
      )}
    </section>
  );
}
export function ClinicPreparation({
  courseName,
  materials,
  preferences,
  busy,
  hasPlan,
  onPreferences,
  onStart,
  onMaterials,
  onBack,
}: {
  courseName: string;
  materials: ClinicMaterialSummary[];
  preferences: CoursePreferences;
  busy: boolean;
  hasPlan: boolean;
  onPreferences: (value: CoursePreferences) => void;
  onStart: () => void;
  onMaterials: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="clinic-preparation-view">
      <header className="course-home-context">
        <p className="eyebrow">让学习从你出发</p>
        <h1>{courseName}</h1>
        <p className="muted">资料决定学什么，学习深度决定怎样讲；把你特别想弄懂的内容也带上。</p>
      </header>
      <form
        className="contract-editor stack"
        aria-label="课程准备设置"
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
      >
        <header className="contract-header row between">
          <div className="contract-heading">
            <p className="eyebrow">先看清方向</p>
            <h2>准备这门课程</h2>
            <p className="muted">一次整理完整知识，一次组织课程路线。确认后，再开始每一课。</p>
          </div>
          {onBack && (
            <button type="button" disabled={busy} className="ghost" onClick={onBack}>
              返回规划
            </button>
          )}
        </header>
        <div className="contract-flow">
          <fieldset className="contract-question contract-materials">
            <legend>
              <span>1</span>课程资料
            </legend>
            <p className="contract-question-hint">
              当前课程中的全部资料都会用于知识提取；选择基础理解也不会减少必学内容。
            </p>
            {materials.length ? (
              <ul className="material-scope-list">
                {materials.map((material) => (
                  <li className="material-scope-row" key={material.id}>
                    <strong>{materialTitle(material)}</strong>
                    <small className="muted">
                      {material.sourceType === 'paste'
                        ? '文本讲义'
                        : (material.sourceType?.toUpperCase() ?? '资料')}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="banner info">先添加至少一份教材或讲义，就可以开始课程准备。</p>
            )}
            <button type="button" className="ghost" disabled={busy} onClick={onMaterials}>
              {materials.length ? '管理课程资料' : '添加课程资料'}
            </button>
          </fieldset>
          <fieldset className="contract-question">
            <legend>
              <span>2</span>整体学习深度
            </legend>
            <p className="contract-question-hint">
              影响课程目标、后续讲解和考核要求。生成后仍可逐课调整，全部必学知识保持完整。
            </p>
            <label>
              整体学习深度
              <select
                disabled={busy}
                value={preferences.desiredDepth}
                onChange={(e) =>
                  onPreferences({ ...preferences, desiredDepth: e.target.value as LessonDepth })
                }
              >
                {Object.entries(depthLabel).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className="preparation-depth-note" aria-live="polite">
              <strong>{depthLabel[preferences.desiredDepth]}</strong> ·{' '}
              {depthDescription[preferences.desiredDepth]}
            </p>
            {preferences.desiredDepth === 'advanced' && (
              <p className="contract-question-hint">
                深入迁移会加强陌生情境下的综合与设计判断。Practice 和正式考核仍由你自主选择，不影响
                Lesson 的完成。
              </p>
            )}
          </fieldset>
          <fieldset className="contract-question">
            <legend>
              <span>3</span>有没有特别想深入的内容？
            </legend>
            <p className="contract-question-hint">
              可选。写一个具体主题，再补一句你想弄懂什么。只调整教学侧重，不缩减教材范围；留空则均衡安排。
            </p>
            <label>
              特别关注的内容（可选）
              <textarea
                rows={3}
                value={preferences.focusRequest}
                disabled={busy}
                onChange={(e) => onPreferences({ ...preferences, focusRequest: e.target.value })}
                placeholder="例如：怎样区分事实和推断？实际访谈中如何追问，才能得到可靠的经历？"
              />
            </label>
          </fieldset>
        </div>
        <footer className="contract-actions">
          <p className="small muted">
            {hasPlan
              ? '新的设置会形成一份待确认规划，现有课堂与学习历史保留。'
              : '生成完整规划后先由你审阅。不会自动确认，也不会提前生成全部课文。'}
          </p>
          <button className="primary" disabled={busy || !materials.length}>
            {busy ? '正在开始课程准备…' : '准备完整课程规划'}
            <img src="/icons/tabler/arrow-right.svg" alt="" width="18" height="18" />
          </button>
        </footer>
      </form>
    </div>
  );
}
