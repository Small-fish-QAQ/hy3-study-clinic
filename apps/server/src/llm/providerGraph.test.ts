import { describe, expect, it, vi } from 'vitest';
import type { Concept, MasteryState, SourceBlock } from '@hy3-clinic/shared';
import { FakeProvider } from './fakeProvider.js';
import { Hy3Provider } from './hy3Provider.js';
import { ProviderError } from './errors.js';

/** Provider contract tests for graph-edge and remediation-plan proposal. */

const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '工作记忆',
    headingPath: ['工作记忆'],
    pageNumber: null,
    content: '工作记忆的容量十分有限。它一次只能保持大约四个组块。',
    startOffset: 0,
    endOffset: 26,
  },
  {
    id: 'blk_1',
    materialId: 'mat_1',
    index: 1,
    heading: '长时记忆',
    headingPath: ['长时记忆'],
    pageNumber: null,
    content: '长时记忆通过巩固过程形成,睡眠对巩固十分重要。',
    startOffset: 30,
    endOffset: 52,
  },
  {
    id: 'blk_2',
    materialId: 'mat_1',
    index: 2,
    heading: '间隔重复',
    headingPath: ['间隔重复'],
    pageNumber: null,
    content: '间隔重复通过在遗忘边缘复习来提升长期保持率。',
    startOffset: 56,
    endOffset: 77,
  },
];

function concept(id: string, name: string, blockId: string, quote: string): Concept {
  return {
    id,
    materialId: 'mat_1',
    name,
    summary: `${name}的概念摘要。`,
    importance: 'high',
    grounding: {
      blockId,
      quote,
      startOffset: 0,
      endOffset: quote.length,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const concepts = [
  concept('con_a', '工作记忆', 'blk_0', '工作记忆的容量十分有限。'),
  concept('con_b', '长时记忆', 'blk_1', '长时记忆通过巩固过程形成,睡眠对巩固十分重要。'),
  concept('con_c', '间隔重复', 'blk_2', '间隔重复通过在遗忘边缘复习来提升长期保持率。'),
];

const graphInput = { workspaceName: '认知科学', blocks, concepts, maxEdges: 40 };

const mastery: MasteryState[] = [
  {
    materialId: 'mat_1',
    conceptId: 'con_a',
    conceptName: '工作记忆',
    mastery: 0.3,
    attempts: 3,
    correctCount: 1,
    lastScore: 0.2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const planInput = {
  workspaceName: '认知科学',
  selected: concepts[0]!,
  prerequisites: [concepts[1]!],
  neighbors: [
    { concept: concepts[2]!, relation: 'contrasts_with' as const, direction: 'out' as const },
  ],
  blocks,
  masteryStates: mastery,
  openMistakes: [{ conceptId: 'con_a', stem: '工作记忆容量?', score: 0 }],
  usedQuestionTypes: ['single_choice' as const],
};

describe('FakeProvider.proposeGraphEdges', () => {
  it('is deterministic and only references existing concepts and verbatim quotes', async () => {
    const provider = new FakeProvider();
    const first = await provider.proposeGraphEdges(graphInput);
    const second = await provider.proposeGraphEdges(graphInput);
    expect(second).toEqual(first);

    expect(first.edges.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(concepts.map((c) => c.id));
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    for (const edge of first.edges) {
      expect(ids.has(edge.sourceConceptId)).toBe(true);
      expect(ids.has(edge.targetConceptId)).toBe(true);
      expect(edge.sourceConceptId).not.toBe(edge.targetConceptId);
      for (const evidence of edge.evidence) {
        const block = blockById.get(evidence.blockId);
        expect(block, evidence.blockId).toBeDefined();
        expect(block!.content).toContain(evidence.quote);
      }
    }
    const relations = new Set(first.edges.map((e) => e.relation));
    expect(relations.size).toBeGreaterThanOrEqual(2);
  });

  it('respects the caller-provided edge budget', async () => {
    const provider = new FakeProvider();
    const payload = await provider.proposeGraphEdges({ ...graphInput, maxEdges: 2 });
    expect(payload.edges.length).toBeLessThanOrEqual(2);
  });

  it('supports cancellation through the shared gate', async () => {
    const provider = new FakeProvider({ delayMs: 50 });
    const controller = new AbortController();
    const promise = provider.proposeGraphEdges(graphInput, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});

describe('FakeProvider.proposeRemediationPlan', () => {
  it('is deterministic and grounded in the provided input only', async () => {
    const provider = new FakeProvider();
    const first = await provider.proposeRemediationPlan(planInput);
    const second = await provider.proposeRemediationPlan(planInput);
    expect(second).toEqual(first);

    expect(first.targets[0]!.conceptId).toBe('con_a');
    expect(first.targets.length).toBeLessThanOrEqual(4);
    expect(first.steps.length).toBeLessThanOrEqual(6);
    expect(['single_choice']).toEqual(first.questionTypes);
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    for (const target of first.targets) {
      for (const evidence of target.evidence) {
        expect(blockById.get(evidence.blockId)!.content).toContain(evidence.quote);
      }
    }
  });

  it('proposes prerequisite repair when a prerequisite is weak', async () => {
    const provider = new FakeProvider();
    const weakPrereqInput = {
      ...planInput,
      masteryStates: [
        ...mastery,
        { ...mastery[0]!, conceptId: 'con_b', conceptName: '长时记忆', mastery: 0.2 },
      ],
    };
    const payload = await provider.proposeRemediationPlan(weakPrereqInput);
    expect(payload.strategy).toBe('prerequisite_repair');
    expect(payload.targets.map((t) => t.conceptId)).toContain('con_b');
  });
});

// ---------------------------------------------------------------------------
// Hy3 provider: structured output, bounded repair, timeout, cancellation.
// ---------------------------------------------------------------------------

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-should-never-leak',
    model: 'test-model',
    timeoutMs,
    fetchImpl,
  });
}

const validEdgesJson = JSON.stringify({
  edges: [
    {
      sourceConceptId: 'con_a',
      targetConceptId: 'con_b',
      relation: 'prerequisite',
      explanation: '先理解工作记忆。',
      evidence: [{ blockId: 'blk_0', quote: '工作记忆的容量十分有限。' }],
    },
  ],
});

const validPlanJson = JSON.stringify({
  summary: '巩固工作记忆。',
  weaknessHypothesis: '容量限制理解不清。',
  strategy: 'retrieval_practice',
  difficulty: 'medium',
  questionTypes: ['single_choice'],
  steps: [{ description: '重读原文。' }],
  targets: [
    {
      conceptId: 'con_a',
      reason: '存在未解决错题。',
      evidence: [{ blockId: 'blk_0', quote: '工作记忆的容量十分有限。' }],
    },
  ],
});

describe('Hy3Provider.proposeGraphEdges', () => {
  it('parses valid structured edges', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validEdgesJson)) as unknown as typeof fetch;
    const payload = await makeProvider(fetchImpl).proposeGraphEdges(graphInput);
    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0]!.relation).toBe('prerequisite');
  });

  it('repairs once on a schema violation, then succeeds', async () => {
    const invalid = JSON.stringify({
      edges: [{ sourceConceptId: 'con_a', relation: 'not_a_relation' }],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(invalid))
      .mockResolvedValueOnce(jsonResponse(validEdgesJson)) as unknown as typeof fetch;
    const payload = await makeProvider(fetchImpl).proposeGraphEdges(graphInput);
    expect(payload.edges).toHaveLength(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('fails structured after the single repair attempt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"edges":[]}')) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).proposeGraphEdges(graphInput)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('propagates timeout as PROVIDER_TIMEOUT', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl, 30).proposeGraphEdges(graphInput)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
  });

  it('propagates external cancellation as REQUEST_CANCELLED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    const promise = makeProvider(fetchImpl).proposeGraphEdges(graphInput, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});

describe('Hy3Provider.proposeRemediationPlan', () => {
  it('parses a valid structured plan', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validPlanJson)) as unknown as typeof fetch;
    const payload = await makeProvider(fetchImpl).proposeRemediationPlan(planInput);
    expect(payload.strategy).toBe('retrieval_practice');
    expect(payload.targets[0]!.conceptId).toBe('con_a');
  });

  it('rejects an out-of-vocabulary strategy after repair', async () => {
    const invalid = validPlanJson.replace('retrieval_practice', 'brainwash');
    const fetchImpl = vi.fn(async () => jsonResponse(invalid)) as unknown as typeof fetch;
    await expect(makeProvider(fetchImpl).proposeRemediationPlan(planInput)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('never leaks the API key in error messages', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('鉴权失败', { status: 401 }),
    ) as unknown as typeof fetch;
    try {
      await makeProvider(fetchImpl).proposeRemediationPlan(planInput);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('test-key-should-never-leak');
    }
  });
});
