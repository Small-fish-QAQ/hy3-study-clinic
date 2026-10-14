import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { CourseLibrary } from './CourseLibrary.js';
import { LearningCenter, type LearningCenterTab } from './LearningCenter.js';
import { ClinicShell } from './ClinicShell.js';
describe('最终导航与显式删除', () => {
  it('侧栏只保留学习中心，三个完整模块通过标签访问', async () => {
    function View() {
      const [tab, setTab] = useState<LearningCenterTab>('progress');
      return (
        <ClinicShell
          activeView="progress"
          courseId="w"
          courseName="课程"
          courses={[{ id: 'w', name: '课程' }]}
          onCourseChange={vi.fn()}
          onViewChange={vi.fn()}
        >
          <LearningCenter active={tab} onChange={setTab}>
            <p>
              {tab === 'progress'
                ? '全部知识和复习建议'
                : tab === 'records'
                  ? '补救轮次与可恢复操作'
                  : '完整资料管理'}
            </p>
          </LearningCenter>
        </ClinicShell>
      );
    }
    render(<View />);
    const sidebar = screen.getByRole('complementary');
    expect(within(sidebar).getByRole('button', { name: '学习中心' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(sidebar).queryByRole('button', { name: '学习记录' })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole('button', { name: '课程资料' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '学习记录' }));
    expect(screen.getByText('补救轮次与可恢复操作')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('完整资料管理')).toBeInTheDocument();
  });
  it('未选不能删除，确认只提交所选ID，取消不调用删除', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    render(
      <CourseLibrary
        courses={[
          { id: 'a', title: '同名课程' },
          { id: 'b', title: '同名课程' },
        ]}
        busy={false}
        onOpen={vi.fn()}
        onDelete={remove}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '管理课程' }));
    expect(screen.getByRole('button', { name: '删除所选课程' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: '选择课程 02 同名课程' }));
    await userEvent.click(screen.getByRole('button', { name: '删除所选课程' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '删除所选课程' }));
    await userEvent.click(screen.getByRole('button', { name: '确认永久删除' }));
    expect(remove).toHaveBeenCalledWith(['b']);
  });
});
