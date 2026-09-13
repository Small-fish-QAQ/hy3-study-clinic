import { describe, expect, it } from 'vitest';
import {
  TRANSFER_CRITERIA,
  type FormalScoringReview,
  type FormalScoringReviewInput,
} from '@hy3-clinic/shared';
import { makeBlock, makeQuestion, T0 } from '../testing/fixtures.js';
import {
  formalBlindSolutionMessages,
  formalScoringChallengeMessages,
  formalScoringReviewMessages,
} from '../llm/formalScoringReview.js';
import {
  currentScoringReview,
  normalizeScoringPremiseKeys,
  scoringFingerprint,
  scoringQuestionFingerprint,
  validateScoringReviewProposal,
} from './formalScoringReview.js';
import { toPublicQuiz } from './quizzes.js';
import { makeQuiz } from '../testing/fixtures.js';

function fixture() {
  const block = makeBlock({
    materialRevisionId: 'revision_1',
    content: '总价等于每件价格乘件数。',
    contentOrigin: 'extracted_original',
  });
  const objective = { title: '应用总价规则', description: '用单价和件数计算总价并说明依据。' };
  const question = makeQuestion({
    type: 'short_answer',
    options: undefined,
    correctOptionIds: undefined,
    stem: '每件7元，买3件，总价多少？说明计算。',
    expectedAnswer: '21元，因为7乘3等于21。',
    rubric: { keyPoints: [{ text: '算得21元并用单价乘件数说明。', required: true }] },
  });
  const receipt: FormalScoringReview = {
    policyVersion: 'formal-scoring-independent-review-v1',
    provider: 'hy3',
    questionFingerprint: scoringQuestionFingerprint(question),
    objectiveFingerprint: scoringFingerprint(objective),
    sources: [
      {
        sourceBlockId: block.id,
        materialRevisionId: block.materialRevisionId!,
        contentFingerprint: scoringFingerprint(block.content),
      },
    ],
    blindSolution: { answerable: true, solution: '7×3=21元。', limitations: [] },
    review: {
      answerable: true,
      objectiveAligned: true,
      unseenAssessment: true,
      keyCorrect: true,
      requiredCriteriaAppropriate: true,
      premises: ['expected_answer', 'rubric_point:0'].map((p) => ({
        premiseKey: p,
        supported: true,
        claimRefs: ['P1'],
        rationale: '按原文总价规则将题干7元与3件相乘。',
      })),
      issues: [],
    },
    claims: [{ ref: 'P1', sourceBlockId: block.id, text: block.content }],
    reviewedAt: T0,
  };
  question.formalScoringReview = receipt;
  return { block, objective, question, receipt };
}

describe('independently reviewed Formal scoring custody', () => {
  it('requires a complete resolved and unchanged version 2 challenge receipt', () => {
    const { block, objective, question, receipt } = fixture();
    receipt.policyVersion = 'formal-scoring-independent-review-v2';
    expect(currentScoringReview(question, objective, [block])).toBeNull();
    receipt.challenges = {
      challenges: [
        {
          premiseKey: 'rubric_point:0',
          objection: 'Maybe addition suffices.',
          counterexample: '7+3=10.',
        },
      ],
    };
    receipt.challengeFingerprint = scoringFingerprint(receipt.challenges);
    receipt.review.challengeResolutions = [
      {
        challengeRef: 'C1',
        valid: false,
        rationale:
          'The source explicitly requires multiplication, so addition is not a valid solution.',
      },
    ];
    expect(currentScoringReview(question, objective, [block])).not.toBeNull();
    receipt.review.challengeResolutions[0]!.valid = true;
    expect(currentScoringReview(question, objective, [block])).toBeNull();
    receipt.review.challengeResolutions[0]!.valid = false;
    receipt.review.challengeResolutions = [];
    expect(currentScoringReview(question, objective, [block])).toBeNull();
    receipt.review.challengeResolutions = [
      { challengeRef: 'C1', valid: false, rationale: 'Multiplication is required.' },
    ];
    receipt.challenges.challenges[0]!.counterexample = 'A different witness.';
    expect(currentScoringReview(question, objective, [block])).toBeNull();
  });
  it('does not allow omitted, foreign or reordered challenge resolutions', () => {
    const { question, objective, receipt } = fixture();
    const input: FormalScoringReviewInput = {
      question,
      objective,
      claims: receipt.claims,
      sources: [],
      priorExposure: [],
      challenges: {
        challenges: [
          { premiseKey: 'expected_answer', objection: 'First', counterexample: 'First witness' },
          { premiseKey: 'rubric_point:0', objection: 'Second', counterexample: 'Second witness' },
        ],
      },
    };
    for (const refs of [[], ['C1'], ['C2', 'C1'], ['C1', 'C3'], ['C1', 'C1']]) {
      receipt.review.challengeResolutions = refs.map((challengeRef) => ({
        challengeRef,
        valid: false,
        rationale: 'Resolved',
      }));
      expect(validateScoringReviewProposal(receipt.review, input)).not.toEqual([]);
    }
    receipt.review.challengeResolutions = ['C1', 'C2'].map((challengeRef) => ({
      challengeRef,
      valid: false,
      rationale: 'Resolved',
    }));
    expect(validateScoringReviewProposal(receipt.review, input)).toEqual([]);
    input.challenges!.challenges[1]!.premiseKey = 'rubric_point:99';
    expect(validateScoringReviewProposal(receipt.review, input)).not.toEqual([]);
  });
  it('isolates the challenger from other review opinions and treats its witnesses as private data', () => {
    const { question, objective, receipt } = fixture();
    const input = {
      question,
      objective,
      claims: receipt.claims,
      sources: [],
      priorExposure: ['Prior opinion'],
      blindSolution: receipt.blindSolution,
      challenges: { challenges: [] },
    };
    const body = JSON.parse(formalScoringChallengeMessages(input)[1]!.content);
    expect(body).not.toHaveProperty('blindSolution');
    expect(body).not.toHaveProperty('priorExposure');
    expect(body).not.toHaveProperty('challenges');
    expect(body.question.expectedAnswer).toBe(question.expectedAnswer);
  });
  it('shows both independent reviewers the enforced transfer criteria without exposing them to the blind solver', () => {
    const { question, objective, receipt } = fixture();
    const input: FormalScoringReviewInput = {
      question,
      objective,
      claims: receipt.claims,
      sources: [],
      priorExposure: [],
    };
    expect(JSON.parse(formalScoringChallengeMessages(input)[1]!.content).scoringContract).toEqual({
      mode: 'complete_task_answer',
    });
    question.transferTask = {
      version: 'unit-transfer-v1',
      presentedExamples: [],
      priorResponses: [],
    };
    for (const messages of [
      formalScoringChallengeMessages(input),
      formalScoringReviewMessages(input, receipt.blindSolution),
    ]) {
      const body = JSON.parse(messages[1]!.content);
      expect(body.scoringContract).toEqual({
        mode: 'source_principles_and_transfer_performance',
        expectedAnswerRole: 'source_principles',
        requiredTransferPerformance: TRANSFER_CRITERIA,
        allTransferCriteriaRequired: true,
      });
    }
    expect(JSON.parse(formalBlindSolutionMessages(input)[1]!.content)).not.toHaveProperty(
      'scoringContract',
    );
  });
  it('preserves a negative review while correcting only an index-preserving alias spelling', () => {
    const { block, objective, question, receipt } = fixture();
    receipt.review.unseenAssessment = false;
    receipt.review.issues = ['The same worked answer was already delivered.'];
    receipt.review.premises[1]!.premiseKey = 'rubric_0';
    const input: FormalScoringReviewInput = {
      question,
      objective,
      claims: receipt.claims,
      sources: [
        {
          sourceBlockId: block.id,
          materialRevisionId: block.materialRevisionId!,
          content: block.content,
        },
      ],
      priorExposure: [],
    };
    const normalized = normalizeScoringPremiseKeys(receipt.review, input);
    expect(normalized).toEqual({
      ...receipt.review,
      premises: [
        receipt.review.premises[0],
        { ...receipt.review.premises[1], premiseKey: 'rubric_point:0' },
      ],
    });
  });
  it('binds a reviewed calculation to the actual rule without fabricating a verbatim answer', () => {
    const { block, objective, question } = fixture();
    expect(block.content).not.toContain(question.expectedAnswer);
    expect(currentScoringReview(question, objective, [block])).not.toBeNull();
  });
  it.each([
    'key',
    'rubric',
    'stem',
    'objective',
    'source',
    'revision',
    'missing',
    'foreign_claim',
    'missing_criterion',
    'failed_review',
    'missing_review',
  ])('refuses %s changes or missing evidence', (kind) => {
    const { block, objective, question, receipt } = fixture();
    if (kind === 'key') question.expectedAnswer = '27元';
    if (kind === 'rubric') question.rubric!.keyPoints[0]!.required = false;
    if (kind === 'stem') question.stem = '每件9元，买3件，总价多少？';
    if (kind === 'objective') objective.description = '证明供应商已实际交货。';
    if (kind === 'source') block.content = '总价等于单价加件数。';
    if (kind === 'revision') block.materialRevisionId = 'other_revision';
    if (kind === 'foreign_claim') receipt.claims[0]!.sourceBlockId = 'foreign_block';
    if (kind === 'missing_criterion') receipt.review.premises.pop();
    if (kind === 'failed_review') receipt.review.keyCorrect = false;
    if (kind === 'missing_review') delete question.formalScoringReview;
    expect(currentScoringReview(question, objective, kind === 'missing' ? [] : [block])).toBeNull();
  });
  it('keeps author keys and grading criteria out of the blind solver request', () => {
    const { block, objective, question, receipt } = fixture();
    const input: FormalScoringReviewInput = {
      question,
      objective,
      claims: receipt.claims,
      sources: [
        {
          sourceBlockId: block.id,
          materialRevisionId: block.materialRevisionId!,
          content: block.content,
        },
      ],
      priorExposure: [],
    };
    const body = JSON.parse(formalBlindSolutionMessages(input)[1]!.content);
    expect(body.question).toEqual({ type: 'short_answer', stem: question.stem });
    expect(body).not.toHaveProperty('claims');
    expect(JSON.stringify(body)).not.toContain(question.expectedAnswer);
  });
  it('keeps the review and hidden solution off the unanswered learner surface', () => {
    const { question } = fixture();
    const visible = toPublicQuiz(makeQuiz({ questions: [question] }));
    expect(visible.questions[0]).not.toHaveProperty('formalScoringReview');
    expect(JSON.stringify(visible)).not.toContain(question.expectedAnswer);
  });
});
