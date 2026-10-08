import { describe, expect, it, vi } from 'vitest';
import {
  PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
  PracticeRepairGroundingResultSchema,
  type PracticeRepairAcceptance,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import type { PracticeRepairInput } from '../llm/provider.js';
import { teachingContentReviewMessages } from '../llm/prompts.js';
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
  unseenPracticePrompts: ['RESERVED_PROMPT'],
  archivedRetestPrompts: ['ARCHIVED_PROMPT'],
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
    integrity: await receipt(prepared.integrity),
  };
  return { provider, content, prepared, proof };
}

describe('Repair purpose acceptance', () => {
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

  it('passes complete controlled claims and keeps legitimately taught rules in both isolated inputs', async () => {
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
      expect(input.priorTeaching).toContain(context.teachingContext[0]);
      expect(input.priorTeaching).toContain(context.visibleFeedback![0]);
      expect(input.priorTeaching).toContain(context.tutorExplanations![0]);
      expect(serialized).not.toMatch(
        /PRIVATE_|RESERVED_PROMPT|ARCHIVED_PROMPT|UNREVEALED_RESPONSE/,
      );
      expect(serialized).not.toContain(content.retest[1 - index]!.prompt);
      expect(serialized).not.toContain('correctOptionId');
      expect(serialized).not.toContain('feedbackIfSelected');
    }
    expect(prepared.grounding.candidate).toEqual(content);
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
    for (const change of ['unknown prompt', 'missing givens', 'duplicate answer'] as const) {
      const input = structuredClone(prepared.solves[0]!);
      if (change === 'duplicate answer')
        input.candidate.options[2]!.text = input.candidate.options[0]!.text;
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
      { ...proof, context: { ...proof.context, sourceExcerpts: ['changed source'] } },
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
