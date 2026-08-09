import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConceptLesson } from '@hy3-clinic/shared';
import { LessonCard } from './LessonCard';
import { installFetchMock } from '../test/mockFetch';
import { blocks, documentSummary } from '../test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const anchoredQuote = blocks[0]!.content.slice(0, 11);

const lesson: ConceptLesson = {
  id: 'les_1',
  workspaceId: 'ws_1',
  conceptId: 'con_0',
  content: {
    sections: [
      {
        kind: 'explanation',
        segments: [
          {
            text: '课程资料这样界定工作记忆。',
            anchor: {
              blockId: blocks[0]!.id,
              quote: anchoredQuote,
              startOffset: 0,
              endOffset: anchoredQuote.length,
              occurrenceCount: 1,
              reanchored: false,
            },
          },
          { text: '可以把工作记忆想象成一块临时白板,这是模型的补充讲解。' },
        ],
      },
    ],
  },
  conflicts: [
    {
      claim: '常见表述认为容量没有硬性限制。',
      sourceQuote: {
        blockId: blocks[0]!.id,
        quote: anchoredQuote,
        startOffset: 0,
        endOffset: anchoredQuote.length,
        occurrenceCount: 1,
        reanchored: false,
      },
    },
  ],
  provider: 'fake',
  providerModel: null,
  promptVersion: 'lesson-v1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderCard() {
  return render(
    <LessonCard
      workspaceId="ws_1"
      conceptId="con_0"
      conceptName="工作记忆"
      blocks={blocks}
      documents={[documentSummary]}
    />,
  );
}

describe('LessonCard provenance rendering', () => {
  it('labels segments by SERVER-decided provenance and shows verified conflicts', async () => {
    installFetchMock([
      {
        method: 'GET',
        pattern: /\/concepts\/con_0\/lesson$/,
        handler: () => ({ body: { lesson } }),
      },
    ]);
    renderCard();

    const card = await screen.findByLabelText('讲解卡片:工作记忆');
    // Anchored segment → 课程资料 / 本地已验证 (with its evidence panel).
    expect(within(card).getAllByText('课程资料 · 本地已验证').length).toBeGreaterThan(0);
    // Unanchored segment → clearly-labeled AI teaching, NOT source text.
    expect(within(card).getByText('AI 辅助讲解(非资料原文)')).toBeInTheDocument();
    expect(within(card).getByText(/临时白板/)).toBeInTheDocument();
    // Conflict: model claim + verified source quote, source wins for grading.
    expect(within(card).getByText('资料与常见表述不同')).toBeInTheDocument();
    expect(within(card).getByText(/课程考核以资料为准/)).toBeInTheDocument();
    expect(within(card).getByText(/容量没有硬性限制/)).toBeInTheDocument();
    // Help text explains the AI-teaching semantics.
    expect(within(card).getByText(/不会成为判分依据/)).toBeInTheDocument();
  });

  it('generates on demand and sends fixed directives on regeneration', async () => {
    const posts: unknown[] = [];
    let current: ConceptLesson | null = null;
    installFetchMock([
      {
        method: 'GET',
        pattern: /\/concepts\/con_0\/lesson$/,
        handler: () => ({ body: { lesson: current } }),
      },
      {
        method: 'POST',
        pattern: /\/concepts\/con_0\/lesson$/,
        handler: (body) => {
          posts.push(body);
          current = lesson;
          return { status: 201, body: { lesson } };
        },
      },
    ]);
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText(/还没有讲解卡片/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '生成讲解卡片' }));
    expect(await screen.findByText(/临时白板/)).toBeInTheDocument();
    expect(posts[0]).toEqual({});

    await user.click(screen.getByRole('button', { name: '更直观' }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]).toEqual({ directive: 'more_intuitive' });
  });

  it('a failed regeneration keeps the previous card visible with an error', async () => {
    installFetchMock([
      {
        method: 'GET',
        pattern: /\/concepts\/con_0\/lesson$/,
        handler: () => ({ body: { lesson } }),
      },
      {
        method: 'POST',
        pattern: /\/concepts\/con_0\/lesson$/,
        handler: () => ({
          status: 502,
          body: { error: { code: 'PROVIDER_ERROR', message: '生成失败,请稍后重试。' } },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText(/临时白板/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新生成讲解' }));
    expect(await screen.findByText(/生成失败/)).toBeInTheDocument();
    // The previous valid card is still shown.
    expect(screen.getByText(/临时白板/)).toBeInTheDocument();
  });
});
