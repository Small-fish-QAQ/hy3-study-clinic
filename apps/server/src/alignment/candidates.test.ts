import { beforeEach, describe, expect, it } from 'vitest';
import type { Concept } from '@hy3-clinic/shared';
import { generateAlignmentCandidates, pairKey } from '../alignment/candidates.js';
import { makeConcept, makeGrounding } from '../testing/fixtures.js';

function concept(id: string, name: string, materialId: string, blockId = `blk_${id}`): Concept {
  return makeConcept({
    id,
    name,
    materialId,
    grounding: makeGrounding({ blockId }),
  });
}

const EMPTY_CTX = {
  headingByConcept: new Map<string, string>(),
  canonicalByConcept: new Map<string, string>(),
  existingPairKeys: new Set<string>(),
  knownAliasKeyPairs: new Set<string>(),
};

describe('alignment candidate generation', () => {
  it('flags exact-normalized pairs as auto-acceptable', () => {
    const candidates = generateAlignmentCandidates(
      [concept('a', 'Spaced repetition', 'm1'), concept('b', 'Spacedrepetition', 'm2')],
      EMPTY_CTX,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.autoAcceptable).toBe(true);
    expect(candidates[0]!.signals).toContain('exact_normalized');
  });

  it('detects malformed concatenations via containment WITHOUT auto-accepting', () => {
    const candidates = generateAlignmentCandidates(
      [concept('a', 'Working memory', 'm1'), concept('b', 'Workingmemoryhas', 'm2')],
      EMPTY_CTX,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.signals).toContain('containment');
    expect(candidates[0]!.autoAcceptable).toBe(false);
  });

  it('pairs bilingual concepts through summary overlap, never by name', () => {
    const zh = makeConcept({
      id: 'zh',
      name: '工作记忆',
      materialId: 'm1',
      summary: '工作记忆是容量有限的短时信息加工系统,一次约四个组块。',
    });
    const en = makeConcept({
      id: 'en',
      name: 'Working memory',
      materialId: 'm2',
      summary: '工作记忆的容量有限,一次只能保持大约四个组块的信息。',
    });
    const candidates = generateAlignmentCandidates([zh, en], EMPTY_CTX);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.signals).toContain('summary_overlap');
    expect(candidates[0]!.autoAcceptable).toBe(false);
  });

  it('pairs concepts extracted under the same heading in different documents', () => {
    const a = concept('a', '甲概念', 'm1');
    const b = concept('b', '乙概念', 'm2');
    const candidates = generateAlignmentCandidates([a, b], {
      ...EMPTY_CTX,
      headingByConcept: new Map([
        ['a', '记忆 / 间隔重复'],
        ['b', '记忆 / 间隔重复'],
      ]),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.signals).toContain('shared_heading');
  });

  it('skips pairs already in one canonical group and already-proposed pairs', () => {
    const a = concept('a', 'Spaced repetition', 'm1');
    const b = concept('b', 'Spacedrepetition', 'm2');
    expect(
      generateAlignmentCandidates([a, b], {
        ...EMPTY_CTX,
        canonicalByConcept: new Map([
          ['a', 'can_1'],
          ['b', 'can_1'],
        ]),
      }),
    ).toHaveLength(0);
    expect(
      generateAlignmentCandidates([a, b], {
        ...EMPTY_CTX,
        existingPairKeys: new Set([pairKey('a', 'b')]),
      }),
    ).toHaveLength(0);
  });

  it('produces no candidate for unrelated names (no all-pairs model calls)', () => {
    const candidates = generateAlignmentCandidates(
      [concept('a', '傅里叶变换', 'm1'), concept('b', '南北战争', 'm2')],
      EMPTY_CTX,
    );
    expect(candidates).toHaveLength(0);
  });

  it('bounds output and is deterministic', () => {
    const many: Concept[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(concept(`a${i}`, `Concept name ${i}`, 'm1'));
      many.push(concept(`b${i}`, `concept  name ${i}`, 'm2'));
    }
    const first = generateAlignmentCandidates(many, EMPTY_CTX);
    const second = generateAlignmentCandidates(many, EMPTY_CTX);
    expect(first.length).toBeLessThanOrEqual(30);
    expect(first).toEqual(second);
  });
});

describe('candidate context isolation', () => {
  let concepts: Concept[];

  beforeEach(() => {
    concepts = [concept('a', 'Working memory', 'm1'), concept('b', 'working  memory', 'm2')];
  });

  it('known alias pairs add a signal without forcing auto-accept', () => {
    const candidates = generateAlignmentCandidates(concepts, {
      ...EMPTY_CTX,
      knownAliasKeyPairs: new Set(['workingmemory|workingmemory']),
    });
    expect(candidates[0]!.signals).toContain('exact_normalized');
    expect(candidates[0]!.signals).toContain('known_alias_pair');
  });
});
