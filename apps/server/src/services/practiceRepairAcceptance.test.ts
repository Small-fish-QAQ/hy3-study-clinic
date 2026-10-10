import { describe, expect, it, vi } from 'vitest';
import {
  PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_REPAIR_INTEGRITY_SCOPE,
  PracticeRepairGroundingResultSchema,
  PracticeRepairContentSchema,
  type PracticeRepairAcceptance,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { maximumRepairCandidate } from '../testing/practiceRepairComparisonFixture.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { teachingContentReviewMessages } from '../llm/prompts.js';
import {
  practiceRepairMessages,
  PRACTICE_REPAIR_MAX_REQUEST_BYTES,
  localRepairTutorExcerpts,
} from '../llm/practiceRepair.js';
import {
  hasPracticeRepairProof,
  preparePracticeRepairReviews,
  practiceRepairHash,
} from './practiceRepairAcceptance.js';

const context: PracticeRepairInput = {
  desiredDepth: 'working_fluency',
  unitFocus: 'normal',
  objective: {
    objectiveTitle: '条件判断',
    construct: 'explain',
    capabilityTested: '区分必要条件与充分条件',
  },
  failedPrompt: '已回答的旧问题 PRIVATE_CASE',
  selectedAnswer: '单个条件成立即可。',
  feedback: 'PRIVATE_SAVED_FEEDBACK',
  failedCase: {
    options: ['PRIVATE_OPTIONS'],
    expectedAnswer: 'PRIVATE_KEY',
    explanation: 'PRIVATE_EXPLANATION',
  },
  learnerNote: 'PRIVATE_NOTE',
  teachingContext: ['PUBLIC_RULE: 且要求两项都成立。'],
  sourceExcerpts: ['PRIVATE_SOURCE: 特殊案例甲为真、乙为假。'],
  priorRounds: [],
  priorResponses: ['UNREVEALED_RESPONSE'],
  visibleFeedback: ['PUBLIC_FEEDBACK: 两项同时成立。'],
  unseenPracticeTasks: [{ prompt: 'RESERVED_PROMPT', options: ['RESERVED_OPTIONS'] }],
  currentPracticeTasks: [{ prompt: 'CURRENT_RESERVED_PROMPT', options: ['CURRENT_OPTIONS'] }],
  archivedRetestTasks: [{ prompt: 'ARCHIVED_PROMPT', options: ['ARCHIVED_OPTIONS'] }],
  tutorExplanations: ['PUBLIC_TUTOR_RULE'],
};

async function fixture(input: PracticeRepairInput = context) {
  const provider = new FakeProvider();
  const content = await provider.generatePracticeRepair(input);
  const prepared = preparePracticeRepairReviews(input, content);
  const receipt = async (
    input: typeof prepared.grounding | (typeof prepared.solves)[number] | typeof prepared.integrity,
  ) => ({
    logicalCallId:
      input.purpose +
      ('candidate' in input && !Array.isArray(input.candidate) && 'actionId' in input.candidate
        ? input.candidate.actionId
        : ''),
    inputHash: prepared.inputHash(input),
    result: await provider.reviewTeachingContent(input),
  });
  const proof: PracticeRepairAcceptance = {
    policyVersion: PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
    candidateHash: practiceRepairHash(content),
    bindingHash: practiceRepairHash('current binding'),
    context: prepared.context,
    grounding: await receipt(prepared.grounding),
    solves: await Promise.all(
      prepared.solves.map(async (input, index) => ({ index, ...(await receipt(input)) })),
    ),
    integrity: { ...(await receipt(prepared.integrity)), scope: PRACTICE_REPAIR_INTEGRITY_SCOPE },
  };
  return { provider, content, prepared, proof };
}

describe('Repair purpose acceptance', () => {
  it('rejects a schema-valid oversized complete candidate request while allowing a concise candidate under the same source scope', async () => {
    const { content } = await fixture();
    const input = {
      ...context,
      sourceExcerpts: Array.from({ length: 8 }, () => '源'.repeat(2000)),
    };
    const oversized = maximumRepairCandidate(content);
    expect(PracticeRepairContentSchema.safeParse(oversized).success).toBe(true);
    expect(() => preparePracticeRepairReviews(input, oversized)).toThrow(/单次请求容量/);
    expect(() => preparePracticeRepairReviews(input, content)).not.toThrow();
  });
  it('softens older history while rejecting a concrete disclosure in reviewed recent excerpts', async () => {
    const { provider, content } = await fixture();
    const answer = content.retest[0]!.explanation;
    for (const recent of [false, true]) {
      const tutorExplanations = recent
        ? ['一般规则。'.repeat(1800) + answer]
        : [answer, ...Array.from({ length: 8 }, () => '共享的一般规则：逐项检查条件。')];
      const input = { ...context, tutorExplanations };
      const prepared = preparePracticeRepairReviews(input, content);
      expect(JSON.stringify(prepared.integrity).includes(answer)).toBe(recent);
      expect(practiceRepairMessages(input)[1]!.content.includes(answer)).toBe(recent);
      const findings = (await provider.reviewTeachingContent(prepared.integrity)).findings;
      if (recent)
        expect(findings).toContainEqual(
          expect.objectContaining({ itemId: 'retest0', code: 'answer_leak' }),
        );
      else expect(findings).toEqual([]);
      expect(prepared.integrity.scope).toBe(PRACTICE_REPAIR_INTEGRITY_SCOPE);
    }
  });

  it.each(['65 replies', 'six long replies', 'unrelated teaching'])(
    'bounds purpose requests without rejecting accumulated history (%s)',
    async (history) => {
      const changed = structuredClone(context);
      if (history === '65 replies')
        changed.tutorExplanations = Array.from({ length: 65 }, () => 'General rule.');
      if (history === 'six long replies')
        changed.tutorExplanations = Array.from({ length: 6 }, () => '教'.repeat(7500));
      if (history === 'unrelated teaching') changed.teachingContext = ['教'.repeat(150000)];
      const { content, prepared, proof } = await fixture(changed);
      expect(hasPracticeRepairProof(content, proof)).toBe(true);
      expect(
        localRepairTutorExcerpts(prepared.context.tutorExplanations ?? []).join('').length,
      ).toBeLessThanOrEqual(3000);
      for (const input of [prepared.grounding, ...prepared.solves, prepared.integrity]) {
        expect(
          Buffer.byteLength(
            JSON.stringify({
              model: 'test',
              messages: teachingContentReviewMessages(input),
              temperature: 0.2,
              max_tokens: 32768,
            }),
          ),
        ).toBeLessThan(PRACTICE_REPAIR_MAX_REQUEST_BYTES);
      }
      expect(JSON.stringify(prepared.grounding)).not.toContain('tutorExplanations');
      expect(JSON.stringify(prepared.solves)).not.toContain('priorTeaching');
    },
  );

  it('bounds actual Hy3 request bytes before transport even when bare input fits', async () => {
    const { prepared } = await fixture();
    const input = structuredClone(prepared.integrity);
    input.priorTeaching = ['教'.repeat(40000)];
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(
      PRACTICE_REPAIR_MAX_REQUEST_BYTES,
    );
    // JSON escaping/envelope/prompt also consume the genuine individual bound.
    input.priorTeaching.push('"'.repeat(7000));
    const transport = vi.fn();
    const provider = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test',
      model: 'test',
      timeoutMs: 30000,
      fetchImpl: transport as typeof fetch,
    });
    await expect(provider.reviewTeachingContent(input)).rejects.toMatchObject({
      details: { kind: 'practice_repair_request_limit' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['necessary only', 'sufficient and public'] as const)(
    'certifies the controlled reservoir only with sufficient public premises (%s)',
    async (premises) => {
      const sourceRule =
        '水源充足，每个阀门独立控制对应城区；开启即可向对应城区供水，关闭就停止对应城区供水。';
      const input = { ...context, sourceExcerpts: [sourceRule] };
      const { provider, content, proof } = await fixture(input);
      if (premises === 'necessary only')
        content.retest[0]!.prompt =
          '水库规则：每个阀门独立控制对应城区，阀门开启才供水，关闭就停止供水。东阀关闭，西阀开启。哪个城区仍收到供水，为什么？';
      const prepared = preparePracticeRepairReviews(input, content);
      const result = await provider.reviewTeachingContent(prepared.solves[0]!);
      const grounding = await provider.reviewTeachingContent(prepared.grounding);
      // Independent truth-table oracle: supply => open admits either western
      // outcome; supply <=> open admits only supply. East is closed in both.
      const westernModels = [false, true].filter((westSupply) => {
        const eastOpen = false,
          westOpen = true,
          eastSupply = false;
        const necessary = (!eastSupply || eastOpen) && (!westSupply || westOpen);
        const sufficient = (!eastOpen || eastSupply) && (!westOpen || westSupply);
        return necessary && (premises === 'necessary only' || sufficient);
      });
      expect(westernModels).toEqual(premises === 'necessary only' ? [false, true] : [true]);
      if (premises === 'necessary only') {
        expect(result.decisions[0]!.answerId).toBeNull();
        expect(grounding.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ itemId: 'retest0' })]),
        );
        // A private source, saved hint/explanation and a declared key cannot
        // repair the missing public sufficient condition.
        expect(JSON.stringify(prepared.solves[0])).not.toContain(sourceRule);
        expect(hasPracticeRepairProof(content, proof)).toBe(false);
      } else {
        expect(prepared.grounding.evidence.sourceExcerpts).toContain(sourceRule);
        expect(content.retest[0]!.prompt).toContain(sourceRule);
        expect(
          content.retest[0]!.options.find((option) => option.id === result.decisions[0]!.answerId)
            ?.text,
        ).toBe('只有西区供水，因为西阀开启。');
        expect(grounding.findings).toEqual([]);
        expect(hasPracticeRepairProof(content, proof)).toBe(true);
      }
    },
  );

  it('uses purpose-specific Hy3 schema and prompts for all four actual transport calls without a live API', async () => {
    const { prepared, proof } = await fixture();
    const results = [
      proof.grounding.result,
      proof.solves[0]!.result,
      proof.solves[1]!.result,
      proof.integrity.result,
    ];
    const transport = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify(results.shift()) }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-secret',
      model: 'test-model',
      timeoutMs: 30000,
      fetchImpl: transport as typeof fetch,
    });
    for (const input of [prepared.grounding, ...prepared.solves, prepared.integrity])
      await provider.reviewTeachingContent(input);
    expect(transport).toHaveBeenCalledTimes(4);
    const bodies = transport.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies[0].messages[0].content).toContain('COMPLETE saved informal Repair packet');
    expect(bodies[0].messages[1].content).toContain('feedbackIfSelected');
    for (const index of [1, 2]) {
      expect(bodies[index].messages[0].content).toContain('ONE unanswered Retest');
      expect(bodies[index].messages[1].content).not.toContain('PRIVATE_');
      expect(bodies[index].messages[1].content).not.toContain('correctOptionId');
    }
    expect(bodies[3].messages[0].content).toContain(
      'comparison purpose never establishes blind answers',
    );
  });

  it('passes complete controlled claims and restricts both isolated inputs to their own public tasks', async () => {
    const { content, prepared, proof } = await fixture();
    expect(hasPracticeRepairProof(content, proof)).toBe(true);
    // New generic metadata cannot broaden these completed purpose contracts.
    const advisory = {
      itemId: 'repair',
      code: 'weak_transfer' as const,
      problem: 'Prefer more teaching richness.',
      repairInstruction: 'Consider a clearer contrast.',
    };
    expect(
      hasPracticeRepairProof(content, {
        ...proof,
        grounding: {
          ...proof.grounding,
          result: {
            ...proof.grounding.result,
            advisories: [
              {
                ...advisory,
                responsibility: 'grounding',
              },
            ],
          },
        },
      }),
    ).toBe(false);
    expect(
      hasPracticeRepairProof(content, {
        ...proof,
        solves: proof.solves.map((solve) => ({
          ...solve,
          result: { ...solve.result, advisories: [advisory] },
        })),
      }),
    ).toBe(false);
    for (const [index, input] of prepared.solves.entries()) {
      const serialized = JSON.stringify(input);
      expect(input).not.toHaveProperty('priorTeaching');
      expect(serialized).not.toContain('PUBLIC_RULE');
      expect(serialized).not.toContain('PUBLIC_FEEDBACK');
      expect(serialized).not.toContain('PUBLIC_TUTOR_RULE');
      expect(serialized).not.toMatch(
        /PRIVATE_|RESERVED_PROMPT|ARCHIVED_PROMPT|UNREVEALED_RESPONSE/,
      );
      expect(serialized).not.toContain(content.retest[1 - index]!.prompt);
      expect(serialized).not.toContain('correctOptionId');
      expect(serialized).not.toContain('feedbackIfSelected');
    }
    expect(prepared.grounding.candidate).toEqual(content);
    expect(JSON.stringify(prepared.integrity)).not.toContain('PRIVATE_KEY');
    expect(prepared.integrity.comparisonTasks).not.toContainEqual(context.archivedRetestTasks[0]);
    expect(prepared.integrity.comparisonTasks).toContainEqual(context.currentPracticeTasks[0]);
    expect(prepared.integrity.collisionInventoryHash).toMatch(/^sha256:/u);
    expect(JSON.stringify(prepared.solves)).not.toContain('ARCHIVED_OPTIONS');
    expect(JSON.stringify(prepared.solves)).not.toContain('RESERVED_OPTIONS');
    expect(JSON.stringify(prepared.integrity)).not.toContain(content.retest[0]!.explanation);
  });

  it.each(['explanation', 'hint', 'correct feedback', 'distractor feedback'] as const)(
    'rejects wrong %s with the same correct Retest key',
    async (field) => {
      const { provider, content } = await fixture();
      const surface = content.retest[1]!;
      if (field === 'explanation' || field === 'hint')
        surface[field] = 'One false condition makes the conjunction true.';
      else
        surface.options[field === 'correct feedback' ? 0 : 2]!.feedbackIfSelected =
          'The false condition is sufficient.';
      const prepared = preparePracticeRepairReviews(context, content);
      const result = await provider.reviewTeachingContent(prepared.grounding);
      expect(result.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ itemId: 'retest1' })]),
      );
      expect(
        (await provider.reviewTeachingContent(prepared.solves[1]!)).decisions[0]!.answerId,
      ).toBe(surface.correctOptionId);
    },
  );

  it('derives the offered ID from verified answer text and refuses unknown, missing or duplicate public answers', async () => {
    const { provider, content } = await fixture();
    const question = content.retest[0]!;
    [question.options[0]!.id, question.options[1]!.id] = ['B', 'A'];
    question.correctOptionId = 'B';
    const prepared = preparePracticeRepairReviews(context, content);
    expect((await provider.reviewTeachingContent(prepared.solves[0]!)).decisions[0]!.answerId).toBe(
      'B',
    );
    expect((await provider.reviewTeachingContent(prepared.grounding)).findings).toEqual([]);
    for (const change of [
      'unknown prompt',
      'missing givens',
      'duplicate answer',
      'no offered answer',
    ] as const) {
      const input = structuredClone(prepared.solves[0]!);
      if (change === 'duplicate answer')
        input.candidate.options[2]!.text = input.candidate.options[0]!.text;
      else if (change === 'no offered answer')
        input.candidate.options[0]!.text = 'Only the eastern district has water.';
      else input.candidate.prompt = change;
      expect((await provider.reviewTeachingContent(input)).decisions[0]!.answerId).toBeNull();
    }
    expect(
      (
        await provider.reviewPracticeRepair({
          stage: 'practice',
          desiredDepth: 'pass_oriented',
          objectives: [],
          sources: [],
          candidate: {},
          actionIds: ['retest0.check'],
        })
      ).decisions[0]!.answerId,
    ).toBeNull();
  });

  it('rejects stale receipts, context changes and feedback-only modifications after JSON hydration', async () => {
    const { content, proof } = await fixture();
    expect(
      hasPracticeRepairProof(
        JSON.parse(JSON.stringify(content)),
        JSON.parse(JSON.stringify(proof)),
      ),
    ).toBe(true);
    const variants = [
      { ...proof, policyVersion: 'practice-repair-acceptance-v1-purpose-proofs' },
      { ...proof, policyVersion: 'practice-repair-acceptance-v3-public-comparison' },
      { ...proof, policyVersion: 'practice-repair-acceptance-v4-local-integrity' },
      { ...proof, integrity: { ...proof.integrity, scope: 'full-history' } },
      { ...proof, context: { ...proof.context, sourceExcerpts: ['changed source'] } },
      { ...proof, context: { ...proof.context, tutorExplanations: ['changed public exposure'] } },
      {
        ...proof,
        context: {
          ...proof.context,
          archivedRetestTasks: [{ prompt: 'ARCHIVED_PROMPT', options: ['CHANGED_OPTIONS'] }],
        },
      },
      { ...proof, solves: [proof.solves[0], proof.solves[0]] },
      {
        ...proof,
        solves: proof.solves.map((solve) => ({ ...solve, inputHash: practiceRepairHash('stale') })),
      },
      {
        ...proof,
        grounding: {
          ...proof.grounding,
          result: {
            decisions: [],
            findings: [
              { itemId: 'repair', code: 'accuracy', problem: 'False.', repairInstruction: 'Fix.' },
            ],
          },
        },
      },
    ];
    for (const variant of variants) expect(hasPracticeRepairProof(content, variant)).toBe(false);
    content.retest[0]!.options[2]!.feedbackIfSelected += ' False added assertion.';
    expect(hasPracticeRepairProof(content, proof)).toBe(false);
  });

  it('separates material findings from advisory quality and gives Hy3 explicit purpose contracts', async () => {
    const { content, prepared, proof } = await fixture();
    proof.grounding.result.advisories = [
      {
        itemId: 'repair',
        code: 'weak_transfer',
        problem: 'Prefer more richness.',
        repairInstruction: 'Add detail.',
      },
    ];
    proof.integrity.result.advisories = [
      {
        itemId: 'retest0',
        code: 'shallow_task',
        problem: 'Prefer harder work.',
        repairInstruction: 'Add depth.',
      },
    ];
    proof.solves.forEach((solve) => {
      solve.result.decisions[0]!.requiresCaseInference = false;
    });
    expect(hasPracticeRepairProof(content, proof)).toBe(true);
    expect(
      PracticeRepairGroundingResultSchema.safeParse({
        decisions: [],
        findings: proof.grounding.result.advisories,
      }).success,
    ).toBe(false);
    expect(
      PracticeRepairGroundingResultSchema.safeParse({
        decisions: [],
        findings: [],
        advisories: [
          { itemId: 'repair', code: 'accuracy', problem: 'False.', repairInstruction: 'Fix.' },
        ],
      }).success,
    ).toBe(false);
    expect(teachingContentReviewMessages(prepared.grounding)[0]!.content).toContain(
      'EVERY option feedbackIfSelected',
    );
    expect(teachingContentReviewMessages(prepared.solves[1]!)[0]!.content).toContain(
      'successful feedback is not revealed',
    );
    expect(teachingContentReviewMessages(prepared.integrity)[0]!.content).toContain(
      'Shared taught rules',
    );
  });
});
