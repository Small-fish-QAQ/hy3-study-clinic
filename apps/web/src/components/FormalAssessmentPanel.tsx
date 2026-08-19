import { useEffect, useRef, useState } from 'react';
import type { LearnerAssessmentExecution, LearnerRepairProjection } from '@hy3-clinic/shared';
import { api, ApiClientError } from '../api.js';
import { Banner, Loading } from './ui.js';

function errorText(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'ABORTED') return '';
  return '这次检查暂时没有完成，原有学习记录没有被替换。你可以稍后重试。';
}

export function FormalAssessmentPanel({
  workspaceId,
  versionId,
  onChanged,
}: {
  workspaceId: string;
  versionId: string;
  onChanged?: () => void;
}) {
  const [execution, setExecution] = useState<LearnerAssessmentExecution | null>(null);
  const [repair, setRepair] = useState<LearnerRepairProjection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [practice, setPractice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);

  async function load(signal?: AbortSignal) {
    const current = ++epoch.current;
    setLoading(true);
    try {
      const existing = await api.getFormalExecution(workspaceId, versionId, signal);
      if (current !== epoch.current) return;
      setExecution(existing);
      if (existing?.result?.repairEpisodeId) {
        setRepair(await api.getLearnerRepair(existing.result.repairEpisodeId, signal));
      }
    } catch (cause) {
      if (current === epoch.current) setError(errorText(cause));
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }

  // `load` intentionally captures the current panel identity; the effect is
  // fenced by workspace/version and aborts the previous request on change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    void load(next.signal);
    return () => {
      epoch.current += 1;
      next.abort();
    };
  }, [workspaceId, versionId]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setExecution(await api.startFormalExecution(workspaceId, versionId));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!execution) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.submitFormalExecution(execution.attempt.id, drafts);
      setExecution(next);
      if (next.result?.repairEpisodeId) {
        setRepair(await api.startLearnerRepair(next.result.repairEpisodeId));
      }
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function repairAction(action: 'defer' | 'cancel' | 'resume') {
    if (!repair) return;
    setBusy(true);
    try {
      setRepair(await api.learnerRepairAction(repair.episodeId, action));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendPractice(
    outcome: 'CONTINUE' | 'READY_FOR_VERIFICATION' | 'NEEDS_MORE_SUPPORT',
  ) {
    if (!repair || !practice.trim()) return;
    setBusy(true);
    try {
      setRepair(await api.learnerRepairPractice(repair.episodeId, practice.trim(), outcome));
      setPractice('');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!repair) return;
    setBusy(true);
    try {
      setExecution(await api.createRepairVerification(repair.episodeId));
      setRepair(await api.getLearnerRepair(repair.episodeId));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="加载理解检查…" />;
  if (!execution) {
    return (
      <section className="formal-assessment-panel" aria-label="理解检查">
        <p className="eyebrow">正式检查</p>
        <h3>检查你是否能说明这个关键能力</h3>
        <p>这是一次正式的简答检查；Tutor 对话和练习回应不会代替它。</p>
        {error ? <Banner kind="error">{error}</Banner> : null}
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
          {busy ? '正在准备…' : '开始检查'}
        </button>
      </section>
    );
  }

  const submitted = execution.attempt.status === 'submitted';
  return (
    <section className="formal-assessment-panel" aria-label="正式理解检查">
      <header>
        <p className="eyebrow">正式检查</p>
        <h3>{execution.title}</h3>
        <p>用自己的话回答。提交后，这次回答会作为不可改写的学习记录保存。</p>
      </header>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {!submitted ? (
        <>
          {execution.items.map((item) => (
            <div className="formal-assessment-item" key={item.itemId}>
              <h4>{item.prompt}</h4>
              {item.sourceReferences.length > 0 ? (
                <details>
                  <summary>查看课程来源</summary>
                  {item.sourceReferences.map((source) => (
                    <blockquote key={`${source.materialTitle}:${source.locationLabel}`}>
                      <strong>{source.materialTitle}</strong> · {source.locationLabel}
                      <br />
                      {source.excerpt}
                    </blockquote>
                  ))}
                </details>
              ) : null}
              <label htmlFor={`formal-answer-${item.itemId}`}>你的回答</label>
              <textarea
                id={`formal-answer-${item.itemId}`}
                rows={5}
                value={drafts[item.itemId] ?? ''}
                disabled={busy}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [item.itemId]: event.target.value }))
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="primary"
            disabled={busy || Object.values(drafts).every((value) => !value.trim())}
            onClick={() => void submit()}
          >
            {busy ? '正在检查…' : '提交回答'}
          </button>
        </>
      ) : execution.result ? (
        <>
          <div
            className={`formal-result ${execution.result.demonstrated ? 'demonstrated' : 'needs-repair'}`}
            role="status"
          >
            <strong>
              {execution.result.demonstrated
                ? '你展示了这个关键能力。'
                : '这次回答还需要补一小块。'}
            </strong>
            <p>{execution.result.summary}</p>
            {execution.result.minorNotice ? <p>{execution.result.minorNotice}</p> : null}
          </div>
          <ul className="formal-criteria-feedback">
            {execution.result.criteria.map((criterion) => (
              <li key={criterion.criterionId} className={criterion.result}>
                <strong>{criterion.label}</strong>
                <span>{criterion.message}</span>
              </li>
            ))}
          </ul>
          {!execution.result.demonstrated && !repair ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void (execution.result?.repairEpisodeId
                  ? api.startLearnerRepair(execution.result.repairEpisodeId).then(setRepair)
                  : undefined)
              }
            >
              查看针对性修复
            </button>
          ) : null}
          {repair ? (
            <RepairPanel
              repair={repair}
              practice={practice}
              setPractice={setPractice}
              busy={busy}
              onAction={repairAction}
              onPractice={sendPractice}
              onVerify={verify}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RepairPanel({
  repair,
  practice,
  setPractice,
  busy,
  onAction,
  onPractice,
  onVerify,
}: {
  repair: LearnerRepairProjection;
  practice: string;
  setPractice: (value: string) => void;
  busy: boolean;
  onAction: (action: 'defer' | 'cancel' | 'resume') => void;
  onPractice: (outcome: 'CONTINUE' | 'READY_FOR_VERIFICATION' | 'NEEDS_MORE_SUPPORT') => void;
  onVerify: () => void;
}) {
  if (repair.resolved)
    return (
      <p className="formal-repair-resolved" role="status">
        这个知识缺口已经通过新的检查验证。
      </p>
    );
  if (repair.deeperSupportRecommended) {
    return (
      <section className="formal-repair-panel" role="status">
        <strong>这一块可能需要更系统的补充。</strong>
        <p>你可以先回到前置课程，之后再从这里继续。</p>
        <button type="button" onClick={() => onAction('defer')}>
          稍后继续
        </button>
      </section>
    );
  }
  return (
    <section className="formal-repair-panel" aria-label="针对性修复">
      <p className="eyebrow">针对性修复 · 练习，不计入正式进展</p>
      <h4>{repair.packet?.interventionLabel ?? '补一小块关键内容'}</h4>
      <p>{repair.diagnosis}</p>
      {repair.packet ? (
        <>
          <p>{repair.packet.explanation}</p>
          <p className="formal-repair-practice-prompt">{repair.packet.practicePrompt}</p>
        </>
      ) : null}
      {repair.sourceReferences.length > 0 ? (
        <details>
          <summary>查看来源</summary>
          {repair.sourceReferences.map((source) => (
            <blockquote key={`${source.materialTitle}:${source.locationLabel}`}>
              {source.materialTitle} · {source.locationLabel}
              <br />
              {source.excerpt}
            </blockquote>
          ))}
        </details>
      ) : null}
      {repair.status === 'DEFERRED' ? (
        <button type="button" disabled={busy} onClick={() => onAction('resume')}>
          继续修复
        </button>
      ) : (
        <>
          <label htmlFor={`repair-practice-${repair.episodeId}`}>练习回应</label>
          <textarea
            id={`repair-practice-${repair.episodeId}`}
            rows={3}
            value={practice}
            disabled={busy}
            onChange={(event) => setPractice(event.target.value)}
          />
          <div className="formal-repair-actions">
            <button
              type="button"
              disabled={busy || !practice.trim()}
              onClick={() => onPractice('CONTINUE')}
            >
              记录练习
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !practice.trim()}
              onClick={() => onPractice('READY_FOR_VERIFICATION')}
            >
              准备好后再检查
            </button>
          </div>
          <div className="formal-repair-actions">
            <button type="button" disabled={busy} onClick={onVerify}>
              换个情境再确认
            </button>
            <button type="button" disabled={busy} onClick={() => onAction('defer')}>
              稍后继续
            </button>
            <button type="button" disabled={busy} onClick={() => onAction('cancel')}>
              离开修复
            </button>
          </div>
        </>
      )}
    </section>
  );
}
