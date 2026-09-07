import { useState } from 'react';
import type { LearnerPracticeRecovery, LessonExecutionCommandRequest } from '@hy3-clinic/shared';

export function PracticeRecoveryPanel({
  recovery,
  disabled,
  onAction,
}: {
  recovery: LearnerPracticeRecovery;
  disabled: boolean;
  onAction: (action: LessonExecutionCommandRequest['action']) => void;
}) {
  const [note, setNote] = useState(recovery.learnerNote ?? '');
  return (
    <section className="practice-recovery" data-phase={recovery.phase} aria-label="针对性修补">
      <ol className="recovery-steps" aria-label="修补步骤">
        <li
          aria-current={
            ['diagnosis', 'needs_support', 'preparing'].includes(recovery.phase)
              ? 'step'
              : undefined
          }
        >
          <span>01</span>找到缺口
        </li>
        <li aria-current={recovery.phase === 'repair' ? 'step' : undefined}>
          <span>02</span>补上理解
        </li>
        <li aria-current={recovery.phase === 'retest' ? 'step' : undefined}>
          <span>03</span>换题检验
        </li>
      </ol>
      <p className="eyebrow">
        {recovery.phase === 'retest' ? 'Retest · 再检验' : 'Diagnosis / Repair · 针对性修补'}
      </p>
      {recovery.phase !== 'retest' ? (
        <>
          <h3>找出这一步的缺口</h3>
          <p>你的选择：{recovery.selectedAnswer}</p>
          <p>{recovery.feedback}</p>
          {recovery.diagnosis ? (
            <div className="practice-diagnosis">
              <p>{recovery.diagnosis.observation}</p>
              <strong>{recovery.diagnosis.gap}</strong>
              <p className="small muted">{recovery.diagnosis.uncertainty}</p>
            </div>
          ) : (
            <p className="small muted">
              这次选择还没有展示出所需的判断。仅凭一个选项，暂时不能确定你的完整思路。
            </p>
          )}
        </>
      ) : (
        <h3>第 {recovery.retest!.index + 1}/2 个新情境</h3>
      )}
      {recovery.phase === 'diagnosis' || recovery.phase === 'needs_support' ? (
        <>
          <label>
            {recovery.phase === 'needs_support'
              ? '你现在怎样理解这一步？'
              : '当时你是怎么想的？（可选）'}
            <textarea
              value={note}
              maxLength={1000}
              disabled={disabled}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={disabled || (recovery.phase === 'needs_support' && !note.trim())}
            onClick={() => onAction({ kind: 'prepare_practice_repair', learnerNote: note })}
          >
            {disabled
              ? '正在准备修补…'
              : recovery.phase === 'needs_support'
                ? '根据新思路继续修补'
                : recovery.round > 1
                  ? '换一种方式补上缺口'
                  : '学习针对性讲解'}
          </button>
        </>
      ) : null}
      {recovery.phase === 'preparing' ? (
        <p role="status">正在根据你的回答准备讲解和新情境…</p>
      ) : null}
      {recovery.teaching ? (
        <div className="practice-repair-teaching">
          <p className="small muted">Hy3 补充讲解 · 不作为正式证据</p>
          <h3>补上关键一步</h3>
          <p>{recovery.teaching.explanation}</p>
          <h4>一起推演</h4>
          <p>{recovery.teaching.workedExample.prompt}</p>
          <ol>
            {recovery.teaching.workedExample.steps.map((step, index) => (
              <li key={index}>{step.replace(/^\s*\d+[.)、]\s+/, '')}</li>
            ))}
          </ol>
          <p>{recovery.teaching.workedExample.conclusion}</p>
          <h4>区分两种判断</h4>
          <p>{recovery.teaching.contrast}</p>
        </div>
      ) : null}
      {recovery.phase === 'repair' ? (
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => onAction({ kind: 'start_practice_retest' })}
        >
          用新情境检验
        </button>
      ) : null}
      {recovery.retest ? (
        <div className="lesson-practice-item">
          <p>{recovery.retest.prompt}</p>
          <div className="lesson-practice-options">
            {recovery.retest.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={disabled}
                onClick={() =>
                  onAction({
                    kind: 'submit_practice_retest',
                    index: recovery.retest!.index,
                    optionId: option.id,
                  })
                }
              >
                {option.text}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {recovery.phase === 'needs_support' ? (
        <p role="status">
          这项能力仍需更多支持，本节练习尚未通过。先回看讲解或向老师追问，再写下你现在的思路。
        </p>
      ) : null}
    </section>
  );
}
