import { useEffect, useState } from 'react';
import type { LessonReflection } from '@hy3-clinic/shared';
import { StudyText } from './StudyText.js';

export const reflectionStatusLabel = {
  open: '推荐完成',
  deferred: '已延后',
  skipped: '已跳过',
  answered: '思考已保存',
};
export function ClinicReflection({
  segmentId,
  prompt,
  record,
  busy,
  onSave,
  onTutor,
}: {
  segmentId: string;
  prompt: string;
  record?: LessonReflection;
  busy: boolean;
  onSave: (status: LessonReflection['status'], response: string) => void;
  onTutor: (question: string) => void;
}) {
  const [response, setResponse] = useState(record?.response ?? '');
  const [editing, setEditing] = useState(Boolean(record?.response));
  useEffect(() => setResponse(record?.response ?? ''), [record?.version, record?.response]);
  return (
    <div className="clinic-reflection" aria-label="可选课堂思考">
      <header>
        <strong>课堂思考</strong>
        <span className="pill">{reflectionStatusLabel[record?.status ?? 'open']}</span>
      </header>
      <StudyText text={prompt} />
      <p className="clinic-footnote">写下你的推断，或稍后回来。这里的思考不计入正式成绩。</p>
      {editing ? (
        <>
          <label htmlFor={`reflection-${segmentId}`}>我的思考</label>
          <textarea
            id={`reflection-${segmentId}`}
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            rows={4}
            disabled={busy}
            placeholder="先试着说明你的判断与理由…"
          />
          <div className="clinic-button-row">
            <button
              className="primary"
              disabled={busy || !response.trim()}
              onClick={() => onSave('answered', response)}
            >
              保存思考
            </button>
            <button
              disabled={busy || !response.trim()}
              onClick={() =>
                onTutor(
                  `请检查我对这道课堂思考的回答，指出具体推理是否成立及需要改进的地方，不作正式判分。我的回答：\n${response}`,
                )
              }
            >
              请 Tutor 检查
            </button>
          </div>
        </>
      ) : (
        <button disabled={busy} onClick={() => setEditing(true)}>
          {record?.status === 'deferred' || record?.status === 'skipped'
            ? '回来试试'
            : '写下我的思考'}
        </button>
      )}
      <div className="clinic-reflection-secondary">
        <button
          className="ghost"
          disabled={busy}
          onClick={() => onTutor('请给我这道课堂思考的一点提示，先不要给完整答案。')}
        >
          一点提示
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => onTutor('请展示这道课堂思考的参考思路，并解释关键条件。')}
        >
          参考思路
        </button>
        <button
          className="ghost"
          disabled={busy || record?.status === 'deferred'}
          onClick={() => onSave('deferred', response)}
        >
          以后再想
        </button>
        <button
          className="ghost"
          disabled={busy || record?.status === 'skipped'}
          onClick={() => onSave('skipped', response)}
        >
          先跳过
        </button>
      </div>
    </div>
  );
}
