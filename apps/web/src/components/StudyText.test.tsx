import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudyText } from './StudyText.js';

describe('课堂文字的安全阅读排版', () => {
  it('真实Lesson中紧邻讲解的真值表仍渲染为表格，前后解释和代码不丢', () => {
    render(
      <StudyText
        text={
          '先列出真值表：\n| P | Q |\n|---|---|\n| T | F |\n接下来只看前提全真的行。\n\n```\n| 原样 | 代码 |\n```'
        }
      />,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'F' })).toBeInTheDocument();
    expect(screen.getByText('先列出真值表：')).toBeInTheDocument();
    expect(screen.getByText('接下来只看前提全真的行。')).toBeInTheDocument();
    expect(document.querySelector('pre code')).toHaveTextContent('| 原样 | 代码 |');
  });
  it('将标题、正文、列表、表格和代码保留为可读的语义结构', () => {
    const { container } = render(
      <StudyText
        text={
          '## 关键条件\n速度有**方向**，与 `速率` 不同。\n\n- 看大小\n- 看方向\n\n| 量 | 含义 |\n| --- | --- |\n| 速度 | 有方向 |\n\n```js\nif (a < b) { return a; }\n```'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: '关键条件' })).toHaveTextContent('关键条件');
    expect(container.querySelector('strong')).toHaveTextContent('方向');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '有方向' })).toBeInTheDocument();
    expect(container.querySelector('pre code')).toHaveTextContent('if (a < b) { return a; }');
  });
  it('教材或模型中的 HTML、脚本和危险链接都保持为文字', () => {
    const text =
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [链接](javascript:alert(1))';
    const { container } = render(<StudyText text={text} />);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(
      screen.getByText('<img src=x onerror=alert(1)> [链接](javascript:alert(1))'),
    ).toBeInTheDocument();
    expect(container.querySelector('script,img,a,iframe')).toBeNull();
  });
});
