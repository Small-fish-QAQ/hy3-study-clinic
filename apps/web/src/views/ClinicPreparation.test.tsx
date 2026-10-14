import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { CourseOperation } from '@hy3-clinic/shared';
import { ClinicMaterials } from './ClinicMaterials.js';
import { ClinicPreparation, ClinicPreparationStatus } from './ClinicPreparation.js';
import { friendlyFilename } from '../materialPresentation.js';

describe('资料展示身份与课程准备体验', () => {
  it('仅解码一次阅读标题，保留 +、不完整编码与原名身份', () => {
    expect(friendlyFilename('%E7%94%A8%E6%88%B7%E8%AE%BF%E8%B0%88.pdf')).toBe('用户访谈');
    expect(friendlyFilename('notes+examples%20v2.pdf')).toBe('notes+examples v2');
    expect(friendlyFilename('notes%ZZ%20.pdf')).toBe('notes%ZZ%20');
    expect(friendlyFilename('%25E7%2594%25A8.pdf')).toBe('%E7%94%A8');
    expect(friendlyFilename('notes%0A.pdf')).toBe('notes%0A');
  });
  it('编码 PDF 可修改阅读标题，导入仍传原始 File.name；失败后不清空选择', async () => {
    const onImport = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(
      <ClinicMaterials
        materials={[]}
        busy={false}
        hasPlan={false}
        onBack={vi.fn()}
        onImport={onImport}
        onRename={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const filename = '%E7%94%A8%E6%88%B7%E8%AE%BF%E8%B0%88.pdf';
    const file = new File(['fixture bytes'], filename, { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('上传教材或讲义'), file);
    expect(screen.getByLabelText('阅读标题（可选）')).toHaveValue('用户访谈');
    await userEvent.clear(screen.getByLabelText('阅读标题（可选）'));
    await userEvent.type(screen.getByLabelText('阅读标题（可选）'), '访谈教材');
    await userEvent.click(screen.getByRole('button', { name: '导入资料' }));
    expect(onImport).toHaveBeenLastCalledWith({ file, title: '访谈教材' });
    expect(onImport.mock.calls[0]![0].file.name).toBe(filename);
    expect(screen.getByLabelText('阅读标题（可选）')).toHaveValue('访谈教材');
    await userEvent.click(screen.getByRole('button', { name: '导入资料' }));
    expect(screen.getByRole('status')).toHaveTextContent('资料已导入');
  });
  it('公开等待模型的真实状态，0 个已保存片段不声称模型已完成', () => {
    render(
      <ClinicPreparationStatus
        operation={{
          id: 'waiting',
          workspaceId: 'w',
          kind: 'preparePlan',
          resourceKind: 'curriculum',
          resourceId: null,
          status: 'running',
          version: 2,
          fence: 1,
          result: null,
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          progress: {
            phase: 'knowledge',
            label: '推理理论',
            totalSourceBlocks: 214,
            completedSourceBlocks: 0,
            knowledgeCount: 0,
          },
          modelRequest: {
            provider: 'moma',
            model: 'glm-5.3',
            method: 'extractCourseKnowledge',
            timeoutMs: 240000,
            startedAt: new Date().toISOString(),
            responseReceived: false,
          },
        }}
        plan={null}
        busy={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'MoMA · glm-5.3 · 请求已发起，等待模型返回',
    );
    expect(screen.getByRole('status')).toHaveTextContent('240 秒');
    expect(screen.getByRole('region')).toHaveTextContent('已保存 0 / 214 个来源片段');
  });
  it('移除先说明范围和历史影响，必须明确确认；原始编码文件名可查', async () => {
    const onRemove = vi.fn().mockResolvedValue(true);
    const filename = '%E7%94%A8%E6%88%B7.pdf';
    render(
      <ClinicMaterials
        materials={[
          {
            id: 'm',
            title: filename,
            filename,
            revisionId: 'r',
            warnings: [],
            sourceType: 'pdf',
            charCount: 123,
            blockCount: 2,
          },
        ]}
        busy={false}
        hasPlan
        onBack={vi.fn()}
        onImport={vi.fn()}
        onRename={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByRole('heading', { name: '用户', level: 3 })).toBeInTheDocument();
    await userEvent.click(screen.getByText('处理版本与来源'));
    expect(screen.getByText(filename)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '从课程中移除' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: '移除用户' })).toHaveTextContent('已有学习记录会保留');
    await userEvent.click(screen.getByRole('button', { name: '保留资料' }));
    expect(onRemove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '从课程中移除' }));
    await userEvent.click(screen.getByRole('button', { name: '确认移出课程' }));
    expect(onRemove).toHaveBeenCalledWith('m');
  });
  it('三档学习需求说明真实影响，迁移也没有强制考试，设置不会自动生成', async () => {
    const onStart = vi.fn();
    const onPreferences = vi.fn();
    render(
      <ClinicPreparation
        courseName="访谈课程"
        materials={[{ id: 'm', title: '教材', revisionId: 'r', warnings: [] }]}
        preferences={{ desiredDepth: 'advanced', focusRequest: '中立提问' }}
        busy={false}
        hasPlan={false}
        onPreferences={onPreferences}
        onStart={onStart}
        onMaterials={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('整体学习深度')).toHaveValue('advanced');
    expect(screen.getByText(/Practice 和正式考核仍由你自主选择/)).toBeVisible();
    expect(screen.getByText(/全部必学知识保持完整/)).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('整体学习深度'), 'introductory');
    expect(onPreferences).toHaveBeenCalledWith({
      desiredDepth: 'introductory',
      focusRequest: '中立提问',
    });
    expect(onStart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '准备完整课程规划' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
  it('无资料时提供添加入口，不假装可以生成规划', () => {
    render(
      <ClinicPreparation
        courseName="新课程"
        materials={[]}
        preferences={{ desiredDepth: 'standard', focusRequest: '' }}
        busy={false}
        hasPlan={false}
        onPreferences={vi.fn()}
        onStart={vi.fn()}
        onMaterials={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '准备完整课程规划' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加课程资料' })).toBeEnabled();
  });
  it('部分提取失败只展示已保存数量，保留重试和设置入口，重载不编造完成进度', async () => {
    const onRetry = vi.fn();
    const op: CourseOperation = {
      id: 'o',
      workspaceId: 'w',
      kind: 'preparePlan',
      resourceKind: 'curriculum',
      resourceId: null,
      status: 'failed',
      version: 3,
      fence: 1,
      result: null,
      error: { code: 'TIMEOUT', message: '本部分暂未完成', retryable: true },
      progress: {
        phase: 'knowledge',
        label: '第二章',
        totalSourceBlocks: 10,
        completedSourceBlocks: 2,
        knowledgeCount: 4,
      },
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:01:00.000Z',
    };
    render(
      <ClinicPreparationStatus
        operation={op}
        plan={null}
        busy={false}
        onRetry={onRetry}
        onCancel={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    const status = screen.getByRole('region', { name: '课程准备状态' });
    expect(status).toHaveAttribute('aria-busy', 'false');
    expect(status).toHaveTextContent('已保存 2 / 10 个来源片段');
    expect(within(status).queryByText('已完成')).not.toBeInTheDocument();
    expect(within(status).getByText('等待继续')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重试未完成部分' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '调整准备设置' })).toBeEnabled();
  });
});
