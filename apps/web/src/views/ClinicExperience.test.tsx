import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { CourseTutorAnchor, LessonReflection } from '@hy3-clinic/shared';
import { ClinicClassroom } from './ClinicClassroom.js';
import { ClinicReflection } from '../components/ClinicReflection.js';
import { clinicRoom } from '../test/clinicRoom.js';
afterEach(() => vi.restoreAllMocks());

describe('连续阅读的引用和可选课堂思考', () => {
  it('在选区旁打开 Tutor，引用独立展示，保留自由问题而不套固定 Prompt', async () => {
    function Harness() {
      const [anchor, setAnchor] = useState<CourseTutorAnchor | null>(null);
      const [question, setQuestion] = useState('我的自由问题');
      return (
        <ClinicClassroom
          room={clinicRoom()}
          plan={null}
          busy={false}
          question={question}
          onQuestion={setQuestion}
          anchor={anchor}
          onAnchor={setAnchor}
          onTutor={vi.fn()}
          onComplete={vi.fn()}
          onPractice={vi.fn()}
          onLesson={vi.fn()}
          onCourse={vi.fn()}
          onSession={vi.fn()}
        />
      );
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 800,
      left: 0,
      right: 1000,
      width: 1000,
      height: 800,
    } as DOMRect);
    render(<Harness />);
    const paragraph = document.querySelector('.clinic-reading-segment .study-rich-text p')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 4);
    Object.defineProperty(range, 'getClientRects', {
      value: () => [{ top: 120, bottom: 145, left: 260, width: 70 }],
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    const trigger = await screen.findByRole('button', { name: '就这段问 Tutor' });
    expect(trigger).toHaveStyle({ left: '260px', top: '153px' });
    await userEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: '课堂问题' })).toHaveValue('我的自由问题');
    expect(document.querySelector('.study-tutor-selection blockquote')).toHaveTextContent(
      paragraph.textContent!.slice(0, 4),
    );
    expect(screen.queryByRole('button', { name: '就选中的内容问 Tutor' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '移除引用' }));
    expect(document.querySelector('.study-tutor-selection')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '课堂问题' })).toHaveValue('我的自由问题');
  });
  it('延后与跳过都带上当前回答，返回后能继续写；Tutor 提示不会被当作正式分数', async () => {
    const save = vi.fn(),
      tutor = vi.fn();
    const deferred: LessonReflection = {
      lessonVersionId: 'lv',
      segmentId: 'think',
      status: 'deferred',
      response: '先确认条件',
      version: 1,
      updatedAt: '2026-10-12T00:00:00.000Z',
    };
    render(
      <ClinicReflection
        segmentId="think"
        prompt="条件改变后会怎样？"
        record={deferred}
        busy={false}
        onSave={save}
        onTutor={tutor}
      />,
    );
    expect(screen.getByLabelText('我的思考')).toHaveValue('先确认条件');
    await userEvent.type(screen.getByLabelText('我的思考'), '，再判断。');
    await userEvent.click(screen.getByRole('button', { name: '先跳过' }));
    expect(save).toHaveBeenLastCalledWith('skipped', '先确认条件，再判断。');
    await userEvent.click(screen.getByRole('button', { name: '保存思考' }));
    expect(save).toHaveBeenLastCalledWith('answered', '先确认条件，再判断。');
    await userEvent.click(screen.getByRole('button', { name: '请 Tutor 检查' }));
    expect(tutor.mock.calls[0]![0]).toContain('先确认条件，再判断。');
    expect(screen.getByText(/不计入正式成绩/)).toBeInTheDocument();
  });
  it('来源默认仍折叠，历史引用单独回看，完整课文没有逐段切换入口', async () => {
    const room = clinicRoom();
    room.turns.push({
      id: 'turn',
      question: '条件在哪里？',
      text: '请留意方向。',
      createdAt: '2026-10-12T00:00:00.000Z',
      anchor: {
        lessonVersionId: room.content.id,
        segmentIds: [room.content.segments[0]!.id],
        selectedText: '速度',
      },
    });
    render(
      <ClinicClassroom
        room={room}
        plan={null}
        busy={false}
        question=""
        onQuestion={vi.fn()}
        onTutor={vi.fn()}
        onComplete={vi.fn()}
        onPractice={vi.fn()}
        onLesson={vi.fn()}
        onCourse={vi.fn()}
        onSession={vi.fn()}
      />,
    );
    expect(document.querySelector('.clinic-source-notes')).not.toHaveAttribute('open');
    expect(document.querySelector('.study-tutor-turn-context blockquote')).toHaveTextContent(
      '速度',
    );
    expect(screen.queryByText('下一段')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('来源依据（1）'));
    await waitFor(() =>
      expect(document.querySelector('.clinic-source-notes')).toHaveAttribute('open'),
    );
  });
});
