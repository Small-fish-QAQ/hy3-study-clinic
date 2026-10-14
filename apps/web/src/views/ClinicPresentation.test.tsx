import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClinicShell } from './ClinicShell.js';
import { ClinicClassroom } from './ClinicClassroom.js';
import { clinicRoom } from '../test/clinicRoom.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
function narrowScreen() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}
function classroom() {
  const onTutor = vi.fn();
  render(
    <ClinicClassroom
      room={clinicRoom()}
      plan={null}
      busy={false}
      question="速度和速率有什么不同？"
      onQuestion={vi.fn()}
      onTutor={onTutor}
      onComplete={vi.fn()}
      onPractice={vi.fn()}
      onLesson={vi.fn()}
      onCourse={vi.fn()}
      onSession={vi.fn()}
    />,
  );
  return { onTutor };
}
describe('复用成熟界面的导航与阅读交互', () => {
  it('窄屏课程导航关闭背景、圈定焦点，并在 Escape 后返回入口', async () => {
    narrowScreen();
    render(
      <ClinicShell
        activeView="home"
        courseId="w"
        courseName="课程"
        courses={[{ id: 'w', name: '课程' }]}
        onCourseChange={vi.fn()}
        onViewChange={vi.fn()}
        onOpenSettings={vi.fn()}
      >
        <button>正文操作</button>
      </ClinicShell>,
    );
    const opener = screen.getByRole('button', { name: '打开课程导航' });
    await userEvent.click(opener);
    const drawer = screen.getByRole('dialog', { name: '课程侧边栏' });
    const close = within(drawer).getByRole('button', { name: '关闭课程导航' });
    await waitFor(() => expect(close).toHaveFocus());
    expect(screen.getByText('正文操作').closest('.course-workspace')).toHaveAttribute('inert');
    await userEvent.tab({ shift: true });
    expect(within(drawer).getByRole('button', { name: '设置' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('正文操作').closest('.course-workspace')).not.toHaveAttribute('inert');
  });
  it('Tutor 窄屏作为弹层，含来源披露，焦点圈定且关闭后恢复阅读', async () => {
    narrowScreen();
    classroom();
    const opener = screen.getByRole('button', { name: '问 Tutor' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Tutor 辅助区' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('textbox', { name: '课堂问题' })).toHaveFocus();
    expect(document.querySelector('.study-session-learning-stack')).toHaveAttribute('inert');
    await userEvent.click(within(dialog).getByRole('button', { name: '提问' }));
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: '回到讲解' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.study-session-learning-stack')).not.toHaveAttribute('inert');
    await userEvent.click(screen.getByText('来源依据（1）'));
    expect(screen.getByText('物理讲义')).toBeVisible();
  });
  it('Tutor 发送支持 Enter、换行和中文输入法，桌面辅助区不锁定背景', async () => {
    const { onTutor } = classroom();
    const input = screen.getByRole('textbox', { name: '课堂问题' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onTutor).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTutor).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.study-session-learning-stack')).not.toHaveAttribute('inert');
  });
});
