import { createHash } from 'node:crypto';
import {
  FormalScoringReviewSchema,
  FormalScoringReviewProposalSchema,
  type FormalScoringReview,
  type FormalScoringReviewInput,
  type FormalScoringReviewProposal,
  type FormalScoringChallenges,
  type Question,
  type SourceBlock,
} from '@hy3-clinic/shared';

export const scoringFingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function scoringQuestionFingerprint(question: Question): string {
  return scoringFingerprint({
    id: question.id,
    quizId: question.quizId,
    type: question.type,
    stem: question.stem,
    options: question.options,
    correctOptionIds: question.correctOptionIds,
    expectedAnswer: question.expectedAnswer,
    rubric: question.rubric,
    grounding: question.grounding,
    supplementaryEvidence: question.supplementaryEvidence,
    formalProposal: question.formalProposal,
    transferTask: question.transferTask,
  });
}

export function requiredScoringKeys(question: FormalScoringReviewInput['question']): string[] {
  return [
    ...(question.expectedAnswer ? ['expected_answer'] : []),
    ...(question.rubric?.keyPoints.flatMap((p, i) => (p.required ? [`rubric_point:${i}`] : [])) ??
      []),
  ];
}

/** Normalize only index-preserving field spelling; all semantic findings remain intact. */
export function normalizeScoringPremiseKeys(
  raw: unknown,
  input: FormalScoringReviewInput,
): unknown {
  const parsed = FormalScoringReviewProposalSchema.safeParse(raw);
  if (!parsed.success) return raw;
  const keys = new Set(requiredScoringKeys(input.question));
  const value = structuredClone(parsed.data);
  for (const p of value.premises) {
    const match = /^rubric(?:_point)?_(\d+)$/u.exec(p.premiseKey);
    const canonical = match ? `rubric_point:${match[1]}` : p.premiseKey;
    if (keys.has(canonical)) p.premiseKey = canonical;
  }
  return new Set(value.premises.map((p) => p.premiseKey)).size === value.premises.length
    ? value
    : raw;
}

export function validateScoringReviewProposal(
  review: FormalScoringReviewProposal,
  input: FormalScoringReviewInput,
): string[] {
  const issues: string[] = [];
  if (
    JSON.stringify(review.premises.map((p) => p.premiseKey)) !==
    JSON.stringify(requiredScoringKeys(input.question))
  )
    issues.push(
      'Return exactly the ordered expected_answer and required rubric_point:index inventory.',
    );
  const refs = new Set(input.claims.map((c) => c.ref));
  for (const p of review.premises) {
    if (new Set(p.claimRefs).size !== p.claimRefs.length || p.claimRefs.some((r) => !refs.has(r)))
      issues.push(`Unknown or duplicate original claim reference for ${p.premiseKey}.`);
    if (p.supported && !p.claimRefs.length)
      issues.push(`Supported ${p.premiseKey} needs actual source claims.`);
  }
  if (input.challenges) {
    issues.push(...validateScoringChallenges(input.challenges, input));
    const expected = input.challenges.challenges.map((_, i) => `C${i + 1}`);
    if (
      JSON.stringify(review.challengeResolutions?.map((r) => r.challengeRef)) !==
      JSON.stringify(expected)
    )
      issues.push('Resolve every supplied challenge exactly once in its original C-alias order.');
  } else if (review.challengeResolutions?.length) {
    issues.push('Do not invent challenges that were not supplied.');
  }
  return issues;
}

export function validateScoringChallenges(
  challenges: FormalScoringChallenges,
  input: FormalScoringReviewInput,
): string[] {
  const keys = new Set(requiredScoringKeys(input.question));
  return challenges.challenges.flatMap((c) =>
    keys.has(c.premiseKey)
      ? []
      : [
          `Unknown scoring premise for challenge: ${c.premiseKey}. Use the exact offered premiseKey.`,
        ],
  );
}

export function scoringReviewPassed(review: FormalScoringReviewProposal): boolean {
  return (
    review.answerable &&
    review.objectiveAligned &&
    review.unseenAssessment &&
    review.keyCorrect &&
    review.requiredCriteriaAppropriate &&
    review.premises.length > 0 &&
    review.premises.every((p) => p.supported && p.claimRefs.length > 0) &&
    (review.challengeResolutions ?? []).every((r) => !r.valid) &&
    review.issues.length === 0
  );
}

/** Recheck original input identity and every witness, never infer support from absent records. */
export function currentScoringReview(
  question: Question,
  objective: { title: string; description: string } | undefined,
  blocks: readonly SourceBlock[],
): FormalScoringReview | null {
  const parsed = FormalScoringReviewSchema.safeParse(question.formalScoringReview);
  if (!parsed.success || !objective) return null;
  const receipt = parsed.data;
  if (receipt.challenges && receipt.challengeFingerprint !== scoringFingerprint(receipt.challenges))
    return null;
  if (
    receipt.questionFingerprint !== scoringQuestionFingerprint(question) ||
    receipt.objectiveFingerprint !==
      scoringFingerprint({ title: objective.title, description: objective.description }) ||
    !receipt.blindSolution.answerable ||
    !scoringReviewPassed(receipt.review)
  )
    return null;
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  if (
    receipt.sources.some((s) => {
      const block = blockById.get(s.sourceBlockId);
      return (
        !block ||
        block.materialRevisionId !== s.materialRevisionId ||
        (block.contentOrigin && block.contentOrigin !== 'extracted_original') ||
        scoringFingerprint(block.content) !== s.contentFingerprint
      );
    })
  )
    return null;
  const sourceIds = new Set(receipt.sources.map((s) => s.sourceBlockId));
  if (
    new Set(receipt.claims.map((c) => c.ref)).size !== receipt.claims.length ||
    receipt.claims.some(
      (c) =>
        !sourceIds.has(c.sourceBlockId) ||
        !blockById.get(c.sourceBlockId)?.content.includes(c.text),
    )
  )
    return null;
  if (
    validateScoringReviewProposal(receipt.review, {
      question,
      objective,
      claims: receipt.claims,
      sources: [],
      priorExposure: [],
      ...(receipt.challenges ? { challenges: receipt.challenges } : {}),
    }).length
  )
    return null;
  return receipt;
}
