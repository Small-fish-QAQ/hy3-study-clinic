import { describe, it, expect } from 'vitest';
import { HttpCourseProvider } from './courseProvider.js';
import { knowledgePackets } from '../services/courseKnowledge.js';
import type { SourcePacketBlock } from './courseContract.js';
import type { ProviderRequestDiagnostic } from './provider.js';

const config = {
  provider: 'moma' as const,
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'offline-only',
  model: 'glm-5.3',
  timeoutMs: 100,
  maxOutputTokens: 64000,
};
const blocks: SourcePacketBlock[] = Array.from({ length: 214 }, (_, i) => ({
  id: `block_${i}`,
  revisionId: 'revision',
  headingPath: ['推理理论'],
  start: i * 220,
  end: (i + 1) * 220,
  text: '命题包含条件与结论，推理需要说明前提。'.repeat(5),
}));
describe('知识工作包与实际 HTTP 预算一致', () => {
  it('在可见输出与推理估计溢出前拆包，完整覆盖所有来源，无固定数量上限', async () => {
    const diagnostics: ProviderRequestDiagnostic[] = [];
    const provider = new HttpCourseProvider({
      ...config,
      fetchImpl: async () => new Response('local rejection', { status: 503 }),
    });
    expect(knowledgePackets(blocks, provider.outputCap)).toHaveLength(1);
    const packets = knowledgePackets(
      blocks,
      provider.outputCap,
      provider.contextCap,
      provider.knowledgePacketFits.bind(provider),
    );
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.flat()).toEqual(blocks);
    for (const packet of packets) {
      await expect(
        provider.extractCourseKnowledge(
          { blocks: packet },
          {
            onRequestDiagnostic: (d) => {
              diagnostics.push(d);
            },
          },
        ),
      ).rejects.toBeInstanceOf(Error);
    }
    expect(diagnostics.every((d) => !d.softEstimateExceeded && d.maxTokens! <= 64000)).toBe(true);
    const larger = new HttpCourseProvider({
      ...config,
      maxOutputTokens: 128000,
      longTaskTimeoutMs: 3600000,
    });
    expect(
      knowledgePackets(
        blocks,
        larger.outputCap,
        larger.contextCap,
        larger.knowledgePacketFits.bind(larger),
      ),
    ).toHaveLength(1);
  });
  it('计入 system/schema/input 和输出的共同 context；完整单元不因 20k 软估计单独被拒绝', () => {
    const small = new HttpCourseProvider({ ...config, maxOutputTokens: 3000 });
    const packet = [blocks[0]!];
    expect(small.knowledgePacketFits(packet)).toBe(true);
    const contextLimited = new HttpCourseProvider({ ...config, contextTokens: 5000 });
    const packets = knowledgePackets(
      blocks.slice(0, 10),
      contextLimited.outputCap,
      contextLimited.contextCap,
      contextLimited.knowledgePacketFits.bind(contextLimited),
    );
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.flat()).toEqual(blocks.slice(0, 10));
    expect(() =>
      knowledgePackets(
        [{ ...blocks[0]!, text: '完整不可分割的来源单元。'.repeat(1000) }],
        contextLimited.outputCap,
        contextLimited.contextCap,
        contextLimited.knowledgePacketFits.bind(contextLimited),
      ),
    ).toThrow('source_unit_too_large');
  });
});
