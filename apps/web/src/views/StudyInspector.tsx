import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type {
  MixedInitiativeCommandRequest,
  StudySessionDetailResponse,
  StudyTurnEvent,
} from '@hy3-clinic/shared';

export type StudyInspectorTab =
  'agenda' | 'context' | 'sources' | 'evidence' | 'activity' | 'artifacts';

interface StudyInspectorProps {
  open: boolean;
  modal: boolean;
  activeTab: StudyInspectorTab;
  courseName: string;
  detail: StudySessionDetailResponse;
  curriculumUnits: Array<{ id: string; title: string }>;
  detourLearningUnitId: string;
  active: boolean;
  busy: boolean;
  actionLoading: boolean;
  canPromoteCurrentDetour: boolean;
  directCheckpointItemId: string | null;
  onTabChange: (tab: StudyInspectorTab) => void;
  onClose: () => void;
  onDetourLearningUnitIdChange: (id: string) => void;
  onCommand: (
    kind: MixedInitiativeCommandRequest['kind'],
    targetAgendaItemId?: string | null,
  ) => void;
}

const TABS: Array<{ id: StudyInspectorTab; label: string }> = [
  { id: 'agenda', label: '安排' },
  { id: 'context', label: '上下文' },
  { id: 'sources', label: '来源' },
  { id: 'evidence', label: '证据' },
  { id: 'activity', label: '活动' },
  { id: 'artifacts', label: '产物' },
];

const ACTIVITY_KINDS = new Set<StudyTurnEvent['kind']>([
  'queued',
  'started',
  'action_proposed',
  'action_rejected',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);

export function StudyInspector({
  open,
  modal,
  activeTab,
  courseName,
  detail,
  curriculumUnits,
  detourLearningUnitId,
  active,
  busy,
  actionLoading,
  canPromoteCurrentDetour,
  directCheckpointItemId,
  onTabChange,
  onClose,
  onDetourLearningUnitIdChange,
  onCommand,
}: StudyInspectorProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const orderedAgenda = [...detail.agenda.items].sort((left, right) => left.index - right.index);
  const currentAgendaItem = orderedAgenda.find(
    (item) => item.id === detail.session.currentAgendaItemId,
  );
  const currentLearningUnit = curriculumUnits.find(
    (unit) => unit.id === currentAgendaItem?.learningUnitId,
  );
  const latestTurn = detail.turns.at(-1) ?? null;
  const formalItems = orderedAgenda.filter((item) =>
    ['formal_checkpoint', 'synthesis', 'due_review', 'targeted_repair'].includes(item.kind),
  );
  const activityEvents = detail.turnEvents
    .filter((event) => ACTIVITY_KINDS.has(event.kind))
    .slice(-30)
    .reverse();

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!modal || event.key !== 'Tab') return;
      const focusable = [
        ...(inspectorRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => !element.hidden && !element.closest('details:not([open])'));
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modal, onClose, open]);

  if (!open) return null;

  const activeIndex = TABS.findIndex((tab) => tab.id === activeTab);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (activeIndex + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (activeIndex - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = TABS[nextIndex]!;
    onTabChange(next.id);
    requestAnimationFrame(() => document.getElementById(`study-inspector-tab-${next.id}`)?.focus());
  }

  return (
    <>
      {modal ? (
        <div className="study-inspector-backdrop" aria-hidden="true" onClick={onClose} />
      ) : null}
      <aside
        id="study-inspector"
        ref={inspectorRef}
        className={`study-inspector${modal ? ' is-modal' : ''}`}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal || undefined}
        aria-labelledby="study-inspector-title"
      >
        <header className="study-inspector-header">
          <div>
            <p className="eyebrow">本次学习</p>
            <h3 id="study-inspector-title">学习上下文</h3>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="study-inspector-close"
            aria-label="关闭学习上下文"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="study-inspector-tabs" role="tablist" aria-label="学习上下文分类">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`study-inspector-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`study-inspector-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={onTabKeyDown}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="study-inspector-scroll">
          <section
            id={`study-inspector-panel-${activeTab}`}
            className="study-inspector-panel"
            role="tabpanel"
            aria-labelledby={`study-inspector-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'agenda' ? (
              <AgendaPanel
                detail={detail}
                curriculumUnits={curriculumUnits}
                detourLearningUnitId={detourLearningUnitId}
                active={active}
                busy={busy}
                actionLoading={actionLoading}
                canPromoteCurrentDetour={canPromoteCurrentDetour}
                onDetourLearningUnitIdChange={onDetourLearningUnitIdChange}
                onCommand={onCommand}
              />
            ) : null}
            {activeTab === 'context' ? (
              <ContextPanel
                courseName={courseName}
                detail={detail}
                currentObjective={currentLearningUnit?.title ?? currentAgendaItem?.reason ?? null}
              />
            ) : null}
            {activeTab === 'sources' ? <SourcesPanel latestTurn={latestTurn} /> : null}
            {activeTab === 'evidence' ? (
              <EvidencePanel
                formalItems={formalItems}
                referencedFormalEvidenceCount={
                  latestTurn?.contextManifest.formalEvidenceIds.length ?? 0
                }
                directCheckpointItemId={directCheckpointItemId}
                active={active}
                busy={busy}
                onCommand={onCommand}
              />
            ) : null}
            {activeTab === 'activity' ? (
              <ActivityPanel detail={detail} events={activityEvents} />
            ) : null}
            {activeTab === 'artifacts' ? <ArtifactsPanel /> : null}
          </section>
        </div>
      </aside>
    </>
  );
}

type AgendaItem = StudySessionDetailResponse['agenda']['items'][number];

function AgendaPanel({
  detail,
  curriculumUnits,
  detourLearningUnitId,
  active,
  busy,
  actionLoading,
  canPromoteCurrentDetour,
  onDetourLearningUnitIdChange,
  onCommand,
}: Pick<
  StudyInspectorProps,
  | 'detail'
  | 'curriculumUnits'
  | 'detourLearningUnitId'
  | 'active'
  | 'busy'
  | 'actionLoading'
  | 'canPromoteCurrentDetour'
  | 'onDetourLearningUnitIdChange'
  | 'onCommand'
>) {
  const orderedAgenda = [...detail.agenda.items].sort((left, right) => left.index - right.index);
  const currentItem = orderedAgenda.find((item) => item.id === detail.session.currentAgendaItemId);
  const resolvedCount = orderedAgenda.filter((item) =>
    ['completed', 'deferred', 'cancelled'].includes(item.state),
  ).length;

  return (
    <>
      <div className="inspector-panel-intro">
        <p className="eyebrow">动态 Session Agenda</p>
        <h4>{currentItem?.reason ?? '等待选择下一项学习内容'}</h4>
        <p className="small muted">
          {resolvedCount}/{orderedAgenda.length} 项已处理
          {currentItem ? ` · 当前为${agendaKindLabel(currentItem.kind)}` : ''}
        </p>
      </div>

      {detail.session.routeStack.length > 0 ? (
        <div className="inspector-route-context" role="status">
          <strong>临时探索仍保留返回路线</strong>
          <p>{detail.session.routeStack.at(-1)?.reason}</p>
          <button
            type="button"
            aria-label="从学习上下文返回原学习路线"
            disabled={!active || busy}
            onClick={() => onCommand('return')}
          >
            返回原学习路线
          </button>
        </div>
      ) : null}

      <ol className="study-agenda-list inspector-agenda-list" aria-label="本次学习安排">
        {orderedAgenda.map((item) => {
          const current = item.id === detail.session.currentAgendaItemId;
          return (
            <li
              key={item.id}
              className="study-agenda-item"
              aria-current={current ? 'step' : undefined}
              aria-label={`${item.reason}，${current ? '当前，' : ''}${agendaStateLabel(item.state)}`}
            >
              <div className="row between">
                <strong>{item.reason}</strong>
                {current ? <span className="pill">当前</span> : null}
              </div>
              <p className="small muted">
                {agendaKindLabel(item.kind)} · {item.estimatedMinutes} 分钟 ·{' '}
                {agendaStateLabel(item.state)}
              </p>
            </li>
          );
        })}
      </ol>

      <details className="session-disclosure inspector-actions">
        <summary>调整本次学习</summary>
        <p className="small muted">
          这些操作只调整当前 Session Agenda；纳入长期路线仍会产生单独的学习路线变更请求。
        </p>
        {curriculumUnits.length > 0 ? (
          <label className="field">
            <span>想探索的学习单元</span>
            <select
              value={detourLearningUnitId}
              disabled={!active || busy}
              onChange={(event) => onDetourLearningUnitIdChange(event.target.value)}
            >
              <option value="">当前学习单元</option>
              {curriculumUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="study-session-controls">
          <button type="button" disabled={!active || busy} onClick={() => onCommand('detour')}>
            临时探索
          </button>
          <button
            type="button"
            disabled={!active || actionLoading}
            onClick={() => onCommand('agenda_insert')}
          >
            插入短活动
          </button>
          <button
            type="button"
            disabled={!active || actionLoading}
            onClick={() => onCommand('deep_dive')}
          >
            深入学习
          </button>
          <button type="button" disabled={!active || busy} onClick={() => onCommand('defer')}>
            延期当前内容
          </button>
          <button
            type="button"
            disabled={busy || !canPromoteCurrentDetour}
            onClick={() => onCommand('promote_to_plan')}
          >
            纳入长期路线
          </button>
        </div>
      </details>

      {detail.latestSummary?.unresolvedConfusions.length ? (
        <div className="inspector-summary">
          <h4>待解决问题</h4>
          <ul>
            {detail.latestSummary.unresolvedConfusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ContextPanel({
  courseName,
  detail,
  currentObjective,
}: Pick<StudyInspectorProps, 'courseName' | 'detail'> & { currentObjective: string | null }) {
  return (
    <>
      <div className="inspector-panel-intro">
        <p className="eyebrow">Course</p>
        <h4>{courseName}</h4>
        <p className="small muted">当前目标：{currentObjective ?? '等待学习内容'}</p>
      </div>
      <dl className="inspector-context-list">
        <div>
          <dt>Learning Contract</dt>
          <dd>当前已接受范围</dd>
        </div>
        <div>
          <dt>Curriculum</dt>
          <dd>当前已接受结构</dd>
        </div>
        <div>
          <dt>StudyPlan</dt>
          <dd>当前已接受且版本化的路线</dd>
        </div>
        <div>
          <dt>Session Agenda</dt>
          <dd>执行版本 {detail.agenda.version}</dd>
        </div>
        <div>
          <dt>本次学习</dt>
          <dd>{sessionStatusLabel(detail.session.status)}</dd>
        </div>
      </dl>
      <div className="inspector-authority-note">
        <strong>范围权限不等于真值权限</strong>
        <p>
          Learning Contract 决定哪些稳定 Material 身份与角色进入学习范围；下游 Tutor
          上下文仍绑定具体修订，并接受本地证据校验。
        </p>
      </div>
    </>
  );
}

function SourcesPanel({
  latestTurn,
}: {
  latestTurn: StudySessionDetailResponse['turns'][number] | null;
}) {
  const sourceRevisionCount = latestTurn?.contextManifest.sourceBlockRevisionIds.length ?? 0;
  return (
    <>
      <div className="inspector-panel-intro">
        <p className="eyebrow">Grounding</p>
        <h4>来源与修订</h4>
        <p className="small muted">查看当前会话实际暴露的来源上下文，不补造引用。</p>
      </div>
      {sourceRevisionCount > 0 ? (
        <div className="inspector-metric">
          <strong>{sourceRevisionCount}</strong>
          <span>个具体源块修订进入最近一次 Tutor 的受限上下文</span>
        </div>
      ) : (
        <EmptyInspectorState>
          当前会话详情没有可供学习者逐条查看的来源引用。这里不会根据对话内容反推或生成出处。
        </EmptyInspectorState>
      )}
      <div className="inspector-authority-note">
        <strong>进入上下文不代表内容为真</strong>
        <p>
          Course 范围、具体修订、证据出处和真值权限是不同概念。源块进入受限上下文，也不证明 Tutor
          的每句话都由该源块完整蕴含。
        </p>
      </div>
      <div className="inspector-authority-note subtle">
        <strong>原文匹配只验证文字位置</strong>
        <p>精确引文校验能证明文字存在于声明的位置，不能单独证明完整语义蕴含。</p>
      </div>
    </>
  );
}

function EvidencePanel({
  formalItems,
  referencedFormalEvidenceCount,
  directCheckpointItemId,
  active,
  busy,
  onCommand,
}: {
  formalItems: AgendaItem[];
  referencedFormalEvidenceCount: number;
  directCheckpointItemId: string | null;
  active: boolean;
  busy: boolean;
  onCommand: StudyInspectorProps['onCommand'];
}) {
  return (
    <>
      <section className="formal-checkpoint-entry" aria-label="正式证据边界">
        <div className="formal-checkpoint-heading">
          <span className="formal-checkpoint-icon" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="eyebrow">正式评估</p>
            <h4>进入可影响进展的独立活动</h4>
          </div>
        </div>
        <p className="small">
          普通 Tutor
          对话和非正式检查不会改变掌握状态。只有单独发起、完成并通过本地校验的正式评估，才可能形成进展证据。
        </p>
        <button
          type="button"
          className="primary"
          disabled={!active || busy || !directCheckpointItemId}
          onClick={() => onCommand('direct_checkpoint', directCheckpointItemId)}
        >
          发起正式评估
        </button>
        {!directCheckpointItemId ? (
          <p className="small muted">当前安排中还没有可发起的正式评估。</p>
        ) : null}
      </section>

      {formalItems.length > 0 ? (
        <ul className="inspector-evidence-list" aria-label="正式评估安排">
          {formalItems.map((item) => (
            <li key={item.id}>
              <strong>{item.reason}</strong>
              <span>
                {agendaKindLabel(item.kind)} · {agendaStateLabel(item.state)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {referencedFormalEvidenceCount > 0 ? (
        <p className="inspector-evidence-reference">
          最近一次 Tutor 受限上下文包含了 {referencedFormalEvidenceCount}{' '}
          条既有正式证据记录；这不是本次对话产生的新证据。
        </p>
      ) : null}

      <div className="inspector-authority-note">
        <strong>评分耐久性与进展对账保持分离</strong>
        <p>
          本页不授予掌握度，也不把对话解释为状态信用。当前会话详情未暴露证据层级或阻断性明细，因此不会推断这些属性。
        </p>
      </div>
    </>
  );
}

function ActivityPanel({
  detail,
  events,
}: {
  detail: StudySessionDetailResponse;
  events: StudyTurnEvent[];
}) {
  return (
    <>
      <div className="inspector-panel-intro">
        <p className="eyebrow">Durable activity</p>
        <h4>本次学习活动</h4>
        <p className="small muted">
          {sessionStatusLabel(detail.session.status)} · 更新于{' '}
          {formatEventTime(detail.session.updatedAt)}
        </p>
      </div>
      {events.length > 0 ? (
        <ol className="inspector-activity-list">
          {events.map((event) => (
            <li key={event.id}>
              <span className={`activity-marker ${event.kind}`} aria-hidden="true" />
              <div>
                <div className="row between">
                  <strong>{turnEventLabel(event.kind)}</strong>
                  <time dateTime={event.createdAt}>{formatEventTime(event.createdAt)}</time>
                </div>
                {event.content && event.kind !== 'started' && event.kind !== 'completed' ? (
                  <p>{event.content}</p>
                ) : null}
                {event.provisional ? (
                  <span className="small muted">临时事件，不具状态权限</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyInspectorState>
          当前会话没有可展示的持久 Tutor 活动事件。普通页面交互不会被包装成伪造的活动历史。
        </EmptyInspectorState>
      )}
    </>
  );
}

function ArtifactsPanel() {
  return (
    <>
      <div className="inspector-panel-intro">
        <p className="eyebrow">Artifacts</p>
        <h4>学习产物</h4>
      </div>
      <EmptyInspectorState>
        当前 StudySession API
        没有暴露独立的学习产物。对话、摘要和正式证据会保留各自语义，不会被重新包装成虚构产物。
      </EmptyInspectorState>
    </>
  );
}

function EmptyInspectorState({ children }: { children: ReactNode }) {
  return <div className="study-inspector-empty">{children}</div>;
}

function agendaKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    learning_unit_teaching: '学习单元',
    informal_check: '非正式检查',
    formal_checkpoint: '正式评估',
    synthesis: '综合练习',
    due_review: '到期复习',
    targeted_repair: '定向修复',
    learner_detour: '临时探索',
    prerequisite_repair: '先修修复',
    deep_dive: '深入学习',
  };
  return labels[kind] ?? '学习活动';
}

function agendaStateLabel(state: string): string {
  const labels: Record<string, string> = {
    queued: '待开始',
    active: '进行中',
    completed: '已完成',
    deferred: '已延期',
    cancelled: '已取消',
    blocked: '暂时受阻',
  };
  return labels[state] ?? state;
}

function sessionStatusLabel(status: StudySessionDetailResponse['session']['status']): string {
  const labels: Record<StudySessionDetailResponse['session']['status'], string> = {
    active: '学习中',
    paused: '已暂停',
    completed: '已完成',
    abandoned: '已结束',
    interrupted: '已中断',
  };
  return labels[status];
}

function turnEventLabel(kind: StudyTurnEvent['kind']): string {
  const labels: Record<StudyTurnEvent['kind'], string> = {
    queued: 'Tutor 请求已排队',
    started: 'Tutor 开始回应',
    content_delta: 'Tutor 回应片段',
    action_proposed: 'Tutor 提出学习操作',
    action_rejected: '学习操作未被接受',
    completed: 'Tutor 回应已完成',
    failed: 'Tutor 请求失败',
    interrupted: 'Tutor 请求中断',
    cancelled: 'Tutor 请求已取消',
  };
  return labels[kind];
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
