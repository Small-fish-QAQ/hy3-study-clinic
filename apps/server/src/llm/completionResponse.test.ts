import { describe, it, expect } from 'vitest';
import { readCompletionResponse } from './completionResponse.js';
import { HttpCourseProvider } from './courseProvider.js';
import type { ProviderRequestDiagnostic, ProviderUsage } from './provider.js';

const encoded = (events: unknown[], done = true) =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') +
  (done ? 'data: [DONE]\r\n\r\n' : '');
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
describe('MoMA 完整 SSE 响应', () => {
  it('正文和finish已收到但DONE缺失时保留流诊断和已报告用量，不发布或自动重发', async () => {
    const diagnostics: ProviderRequestDiagnostic[] = [];
    const usages: ProviderUsage[] = [];
    let sends = 0;
    const provider = new HttpCourseProvider({
      provider: 'moma',
      model: 'glm-5.3',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'offline-secret',
      timeoutMs: 1000,
      fetchImpl: async () => {
        sends++;
        return response(
          encoded(
            [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: JSON.stringify({
                        text: '完整解释',
                        sourceRefs: [],
                        includesExtension: false,
                      }),
                    },
                    finish_reason: 'stop',
                  },
                ],
              },
              { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
            ],
            false,
          ),
        );
      },
    });
    await expect(
      provider.respondToTutorTurn(
        {
          lesson: { title: '课', segments: [], teachingCoverage: [] },
          question: '问题',
          recentTurns: [],
          sources: [],
        },
        { onRequestDiagnostic: (d) => diagnostics.push(d), onUsage: (u) => usages.push(u) },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(sends).toBe(1);
    expect(diagnostics[0]).toMatchObject({
      bodyReadCompleted: false,
      finishReason: 'stop',
      streamDone: false,
      usageKnown: true,
      responseBodyState: 'finished_waiting_done',
    });
    expect(diagnostics[0]!.visibleBodyBytes).toBeGreaterThan(0);
    expect(usages[0]).toMatchObject({ inputTokens: 10, outputTokens: 20 });
  });
  it('跨网络分片/CRLF/中文边界聚合正文，保留末尾用量，立即丢弃推理文本', async () => {
    const text = encoded([
      {
        choices: [
          { index: 0, delta: { reasoning_content: '不应保存的内部推理' }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: { content: '{"text":"完整中文' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '讲解"}' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      },
    ]);
    const result = await readCompletionResponse(response(text), 'offline-secret');
    expect(result.envelope.choices?.[0]?.message?.content).toBe('{"text":"完整中文讲解"}');
    expect(result.envelope.usage?.completion_tokens).toBe(50);
    expect(result.reasoningBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('不应保存的内部推理');
  });
  it('无完整终止标记或凭据跨delta反射不得发布部分候选', async () => {
    await expect(
      readCompletionResponse(
        response(
          encoded([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }], false),
        ),
        'secret',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    await expect(
      readCompletionResponse(
        response(
          encoded([
            { choices: [{ delta: { content: 'off' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'line-secret' }, finish_reason: 'stop' }] },
          ]),
        ),
        'offline-secret',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });
  it('stream 参数被明确拒绝只重发一次，保持模型与合同', async () => {
    const sent: Record<string, unknown>[] = [];
    const provider = new HttpCourseProvider({
      provider: 'moma',
      model: 'glm-5.3',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'secret',
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => {
        sent.push(JSON.parse(init!.body as string));
        if (sent.length === 1) return new Response('stream unsupported', { status: 400 });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          }),
        );
      },
    });
    await provider.testConnection();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.stream).toBe(true);
    expect(sent[1]?.stream).toBeUndefined();
    expect(sent.every((body) => body.model === 'glm-5.3')).toBe(true);
  });
});
