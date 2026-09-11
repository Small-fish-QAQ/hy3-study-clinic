import { AssessmentProposalPayloadSchema } from '@hy3-clinic/shared';
import type { AssessmentProposalInput, ProviderCandidateValidation } from './provider.js';

export const FORMAL_PROPOSAL_DECLARATIONS =
  '每道正式题必须完整声明 objectiveRef、非空 premises、requiresExternalKnowledge、ambiguity、undefinedTerms 和 extraEvidence。没有额外证据时写 extraEvidence: []，不要为填字段加入无关资料。每个 premise 必须包含 text、sourceRefs、teachingSurfaceRefs、learnerVisible、scenarioLocal、visibilityBasis；不要因前一轮只报告部分字段而省略其他必需字段。';

/** Early authoring feedback only. Persisted authority is checked again at admission. */
export function validateFormalScoringProposal(
  raw: unknown,
  input: AssessmentProposalInput,
): ProviderCandidateValidation {
  const diagnostics: string[] = [];
  const parsed = AssessmentProposalPayloadSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, diagnostics: ['Invalid assessment proposal shape.'] };
  if (!input.scoringAuthorityCatalogue) return { valid: true, diagnostics };
  const normalize = (text: string) =>
    text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  for (const [index, item] of parsed.data.items.entries()) {
    const claims =
      input.scoringAuthorityCatalogue.find((entry) => entry.objectiveRef === item.objectiveRef)
        ?.claims ?? [];
    const evidenceBlocks = new Set([
      item.question.blockId,
      ...item.extraEvidence.map((e) => e.blockId),
    ]);
    const matches = (text: string, kind: 'expected_answer' | 'rubric_point', refs?: string[]) =>
      claims.some(
        (claim) =>
          claim.premiseKinds.includes(kind) &&
          normalize(claim.text) === normalize(text) &&
          evidenceBlocks.has(claim.sourceBlockId) &&
          (!refs || refs.includes(claim.sourceBlockId)),
      );
    if (!item.question.expectedAnswer || !matches(item.question.expectedAnswer, 'expected_answer'))
      diagnostics.push(
        `items.${index}.question.expectedAnswer must copy a complete offered expected_answer claim for its objective and cite that block. Do not paraphrase, concatenate or invent a scoring premise.`,
      );
    for (const [pointIndex, point] of (item.question.rubricKeyPoints ?? []).entries()) {
      if (
        typeof point === 'string' ||
        (point.required && !matches(point.text, 'rubric_point', point.sourceRefs))
      )
        diagnostics.push(
          `items.${index}.question.rubricKeyPoints.${pointIndex} must copy an offered rubric_point claim for this objective with its sourceRefs.`,
        );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    diagnosticCodes: diagnostics.map(() => 'formal_scoring_premise_not_offered'),
  };
}
