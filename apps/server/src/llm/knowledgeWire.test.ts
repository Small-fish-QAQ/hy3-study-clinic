import { describe, it, expect } from 'vitest';
import { knowledgeWire } from './knowledgeWire.js';
import { knowledgePackets } from '../services/courseKnowledge.js';
import type { SourcePacketBlock } from './courseContract.js';
import type { ProviderError } from './errors.js';
const blocks: SourcePacketBlock[] = [
  {
    id: 'opaque1',
    revisionId: 'revision',
    text: '定义：当前提均真时，',
    headingPath: ['推理'],
    start: 0,
    end: 10,
  },
  {
    id: 'opaque2',
    revisionId: 'revision',
    text: '结论必须为真。',
    headingPath: ['推理'],
    start: 10,
    end: 18,
  },
];
describe('提取的短引用与完整语义包', () => {
  it('短引用由服务端还原原始完整跨度，外来引用明确拒绝', () => {
    const wire = knowledgeWire({ blocks });
    expect(wire.input.blocks[0]?.id).toBe('s0');
    expect(JSON.stringify(wire.input)).not.toContain('opaque1');
    const value = {
      knowledge: [
        {
          localRef: 'validity',
          title: '有效推理',
          statement: '当前提全真时结论必须为真。',
          kind: 'principle' as const,
          origin: 'textbook' as const,
          sourceBlockIds: ['s0', 's1'],
          prerequisiteRefs: [],
          relatedRefs: [],
          uncertaintyCodes: [],
        },
      ],
      dispositions: blocks.map((b, i) => ({
        blockId: `s${i}`,
        exclusion: null,
      })),
    };
    const result = wire.materialize(value);
    expect(result.knowledge[0]?.sourceSpans).toEqual(
      blocks.map((b) => ({ blockId: b.id, revisionId: b.revisionId, start: b.start, end: b.end })),
    );
    expect(() =>
      wire.materialize({
        ...value,
        dispositions: [{ blockId: 's999', exclusion: null }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_INVALID_OUTPUT' }));
    expect(() =>
      wire.materialize({
        ...value,
        knowledge: [{ ...value.knowledge[0]!, prerequisiteRefs: ['missing'] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_INVALID_OUTPUT' }));
  });
  it('不能因工作量目标把前提和结论、表头和真值行拆开；所有原文保持顺序', () => {
    const rows: SourcePacketBlock[] = [
      ...blocks,
      {
        id: 'header',
        revisionId: 'revision',
        text: '| P | Q |',
        headingPath: ['真值表'],
        start: 18,
        end: 27,
      },
      {
        id: 'row',
        revisionId: 'revision',
        text: '| T | F |',
        headingPath: ['真值表'],
        start: 27,
        end: 36,
      },
    ];
    const packets = knowledgePackets(rows, 10000, undefined, (_packet, single) => !!single);
    expect(packets).toEqual([blocks, rows.slice(2)]);
    expect(packets.flat()).toEqual(rows);
  });
  it('定位分组规则的不存在引用；旧完整失败候选恢复时补充同一定位而不改内容', () => {
    const candidate = {
      knowledge: [
        {
          localRef: 'rules',
          title: '规则组',
          statement: 'I13: P→Q,Q→R⇒P→R。',
          kind: 'principle' as const,
          origin: 'textbook' as const,
          sourceBlockIds: ['s0'],
          prerequisiteRefs: [],
          relatedRefs: [],
          uncertaintyCodes: [],
        },
        {
          localRef: 'example',
          title: '例题',
          statement: '利用规则组证明。',
          kind: 'procedure' as const,
          origin: 'textbook' as const,
          sourceBlockIds: ['s1'],
          prerequisiteRefs: [],
          relatedRefs: ['I13'],
          uncertaintyCodes: [],
        },
      ],
      dispositions: [
        { blockId: 's0', exclusion: null },
        { blockId: 's1', exclusion: null },
      ],
    };
    let failure: ProviderError | undefined;
    try {
      knowledgeWire({ blocks }).materialize(candidate);
    } catch (error) {
      failure = error as ProviderError;
    }
    expect(failure?.technicalFailureCode).toBe('COMPLETE_CANDIDATE_INVALID');
    const details = failure?.details as { candidate: unknown; findings: string[] };
    expect(details.candidate).toEqual(candidate);
    expect(details.findings[0]).toContain('knowledge[1](example).relatedRefs[0]');
    expect(details.findings[0]).toContain('I13');
    const retry = knowledgeWire({
      blocks,
      revision: { draft: candidate, findings: ['旧泛化错误'] },
    });
    expect(retry.input.revision?.draft).toEqual(candidate);
    expect(retry.input.revision?.findings).toContain(details.findings[0]);
    const repaired = structuredClone(candidate);
    repaired.knowledge[1]!.relatedRefs = ['rules'];
    expect(
      knowledgeWire({ blocks }).materialize(repaired).knowledge[1]?.relatedKnowledgeIds,
    ).toEqual(['rules']);
  });
});
