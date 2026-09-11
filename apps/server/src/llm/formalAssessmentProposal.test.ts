import { describe, expect, it } from 'vitest';
import type { AssessmentProposalInput } from './provider.js';
import { validateFormalScoringProposal } from './formalAssessmentProposal.js';

const quote = 'Cooling begins above 8 C and stops at 3 C.';
const input: AssessmentProposalInput = {
  workspaceName: 'Cooling',
  mode: 'concept_practice',
  targets: [],
  blocks: [],
  allowedTypes: ['short_answer'],
  questionCount: 1,
  requiredRepresentation: null,
  requestedChallengeFamily: null,
  misconception: null,
  scoringAuthorityCatalogue: [
    {
      objectiveRef: 'O1',
      claims: [
        {
          text: quote,
          sourceBlockId: 'b1',
          premiseKinds: ['expected_answer', 'rubric_point'],
        },
      ],
    },
  ],
};
function proposal() {
  return {
    items: [
      {
        objectiveRef: 'O1',
        blueprint: {
          conceptIds: ['c1'],
          questionType: 'short_answer',
          difficulty: 'medium',
          learningObjective: 'Explain the thresholds.',
          reasoningSteps: [{ description: 'Relate both thresholds.', evidenceIndexes: [0] }],
        },
        question: {
          type: 'short_answer',
          stem: 'Describe both thresholds.',
          conceptId: 'c1',
          blockId: 'b1',
          quote,
          expectedAnswer: quote,
          explanation: quote,
          rubricKeyPoints: [{ text: quote, required: true, sourceRefs: ['b1'] }],
        },
        extraEvidence: [],
      },
    ],
  };
}
describe('Formal authoring scoring bindings', () => {
  it('accepts complete existing premises without granting new authority', () => {
    expect(validateFormalScoringProposal(proposal(), input).valid).toBe(true);
  });
  it('rejects paraphrased and condition-truncated expected answers before admission', () => {
    for (const answer of ['Cooling starts when hot.', 'Cooling begins above 8 C.']) {
      const draft = proposal();
      draft.items[0]!.question.expectedAnswer = answer;
      expect(validateFormalScoringProposal(draft, input).valid).toBe(false);
    }
  });
  it('rejects a foreign objective, an unoffered rubric claim and a foreign citation', () => {
    const foreign = proposal();
    foreign.items[0]!.objectiveRef = 'O2';
    expect(validateFormalScoringProposal(foreign, input).valid).toBe(false);
    const rubric = proposal();
    rubric.items[0]!.question.rubricKeyPoints[0]!.text = 'Always cool.';
    expect(validateFormalScoringProposal(rubric, input).valid).toBe(false);
    const citation = proposal();
    citation.items[0]!.question.rubricKeyPoints[0]!.sourceRefs = ['b2'];
    expect(validateFormalScoringProposal(citation, input).valid).toBe(false);
  });
  it('does not substitute expected-answer permission for rubric permission', () => {
    const narrow = structuredClone(input);
    narrow.scoringAuthorityCatalogue![0]!.claims[0]!.premiseKinds = ['expected_answer'];
    expect(validateFormalScoringProposal(proposal(), narrow).valid).toBe(false);
  });
});
