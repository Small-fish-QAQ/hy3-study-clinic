import { describe, expect, it } from 'vitest';
import type { AssessmentProposalInput } from './provider.js';
import {
  validateFormalScoringProposal,
  normalizeFormalConceptRefs,
} from './formalAssessmentProposal.js';
import { makeBlock, makeConcept } from '../testing/fixtures.js';

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
  it('expands an unambiguous offered UUID prefix while preserving semantic content', () => {
    const context = {
      ...input,
      targets: [
        {
          concept: makeConcept({ id: 'con_1234abcd-1111-4222-8333-123456789012' }),
          documentTitle: 'Source',
          alignedSiblings: [],
          mastery: null,
          openMistakes: 0,
        },
      ],
    };
    const raw = proposal();
    raw.items[0]!.question.conceptId = 'con_1234abcd';
    raw.items[0]!.blueprint.conceptIds = ['con_1234abcd'];
    const normalized = normalizeFormalConceptRefs(raw, context);
    const expected = structuredClone(raw);
    expected.items[0]!.question.conceptId = context.targets[0]!.concept.id;
    expected.items[0]!.blueprint.conceptIds = [context.targets[0]!.concept.id];
    expect(normalized.candidate).toEqual(expected);
    expect(normalized.actions[0]!.code).toBe('opaque_identity_expanded');
    expect(raw.items[0]!.question.conceptId).toBe('con_1234abcd');
    expect(validateFormalScoringProposal(normalized.candidate, context).valid).toBe(true);
    context.targets.push({
      ...context.targets[0]!,
      concept: makeConcept({ id: 'con_1234abcd-9999-4222-8333-123456789012' }),
    });
    expect(normalizeFormalConceptRefs(raw, context).candidate).toEqual(raw);
    expect(validateFormalScoringProposal(raw, context).valid).toBe(false);
    raw.items[0]!.question.conceptId = 'con_87654321';
    expect(normalizeFormalConceptRefs(raw, context).candidate).toEqual(raw);
  });
  it('accepts complete existing premises without granting new authority', () => {
    expect(validateFormalScoringProposal(proposal(), input).valid).toBe(true);
  });
  it('returns hidden-premise feedback before review without altering the visibility declaration', () => {
    const base = proposal();
    const candidate = {
      items: [
        {
          ...base.items[0]!,
          premises: [
            {
              text: quote,
              sourceRefs: ['b1'],
              teachingSurfaceRefs: ['T1'],
              learnerVisible: false,
              scenarioLocal: false,
              visibilityBasis: 'taught_exposure',
            },
          ],
        },
      ],
    };
    const context: AssessmentProposalInput = {
      ...input,
      semanticScoringReview: true,
      teachingSurfaceCatalogue: [
        {
          teachingSurfaceRef: 'T1',
          surfaceKind: 'explanation',
          objectiveRefs: ['O1'],
          text: quote,
        },
      ],
    };
    const result = validateFormalScoringProposal(candidate, context);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([expect.stringContaining('premises.0.learnerVisible')]);
    expect(result.diagnostics[0]).toContain('do not merely change the flag');
    expect(candidate.items[0]!.premises[0]!.learnerVisible).toBe(false);
    candidate.items[0]!.premises[0]!.learnerVisible = true;
    expect(validateFormalScoringProposal(candidate, context).valid).toBe(true);
  });
  it('catches unlocatable premise summaries before admission without rewriting their facts', () => {
    const base = proposal();
    const candidate = {
      items: [
        {
          ...base.items[0]!,
          question: {
            ...base.items[0]!.question,
            stem: 'Cut for 5 minutes, then dry for 4 minutes.',
          },
          premises: [
            {
              text: 'The task gives cutting 5 and drying 4.',
              sourceRefs: [] as string[],
              teachingSurfaceRefs: [] as string[],
              learnerVisible: true,
              scenarioLocal: true,
              visibilityBasis: 'scenario_local',
            },
          ],
        },
      ],
    };
    const context = {
      ...input,
      semanticScoringReview: true,
      blocks: [makeBlock({ id: 'b1', content: quote })],
    };
    const before = structuredClone(candidate);
    expect(validateFormalScoringProposal(candidate, context).diagnostics).toEqual([
      expect.stringContaining('complete contiguous passage'),
    ]);
    expect(candidate).toEqual(before);
    candidate.items[0]!.premises[0]!.text = candidate.items[0]!.question.stem;
    expect(validateFormalScoringProposal(candidate, context).valid).toBe(true);
    candidate.items[0]!.premises[0]!.text = 'Cut for 6 minutes.';
    expect(validateFormalScoringProposal(candidate, context).valid).toBe(false);
  });
  it('requires exact cited premise locations and distinguishes source facts from new scenarios', () => {
    const base = proposal();
    const candidate = {
      items: [
        {
          ...base.items[0]!,
          premises: [
            {
              text: 'Cooling starts when hot.',
              sourceRefs: ['b1'],
              teachingSurfaceRefs: [] as string[],
              learnerVisible: true,
              scenarioLocal: false,
              visibilityBasis: 'cited_source',
            },
          ],
        },
      ],
    };
    const context = {
      ...input,
      semanticScoringReview: true,
      blocks: [makeBlock({ id: 'b1', content: quote })],
    };
    expect(validateFormalScoringProposal(candidate, context).diagnostics).toEqual([
      expect.stringContaining('complete exact passage'),
    ]);
    candidate.items[0]!.premises[0]!.text = quote;
    expect(validateFormalScoringProposal(candidate, context).valid).toBe(true);
    candidate.items[0]!.question.stem = quote;
    Object.assign(candidate.items[0]!.premises[0]!, {
      visibilityBasis: 'scenario_local',
      scenarioLocal: true,
      sourceRefs: [],
    });
    expect(validateFormalScoringProposal(candidate, context).diagnostics).toEqual([
      expect.stringContaining('cannot claim scenario_local'),
    ]);
    candidate.items[0]!.premises[0]!.visibilityBasis = 'stem';
    expect(validateFormalScoringProposal(candidate, context).valid).toBe(true);
  });
  it('gives precise repair scope for an unsupported required criterion in semantic review mode', () => {
    const candidate = proposal();
    candidate.items[0]!.question.rubricKeyPoints[0]!.sourceRefs = ['b2'];
    const result = validateFormalScoringProposal(candidate, {
      ...input,
      semanticScoringReview: true,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.stringContaining('items.0.question.rubricKeyPoints.0'),
    ]);
    expect(result.diagnostics[0]).toContain('Allowed sourceRefs for O1: b1.');
    expect(result.diagnostics[0]).toContain('do not relabel a foreign fact');
    expect(candidate.items[0]!.question.rubricKeyPoints[0]!.sourceRefs).toEqual(['b2']);
  });
  it('rejects paraphrased and condition-truncated expected answers before admission', () => {
    for (const answer of ['Cooling starts when hot.', 'Cooling begins above 8 C.']) {
      const draft = proposal();
      draft.items[0]!.question.expectedAnswer = answer;
      expect(validateFormalScoringProposal(draft, input).valid).toBe(false);
    }
  });
  it('requires each scored source block to be attached, with actionable correction feedback', () => {
    const context = structuredClone(input);
    context.semanticScoringReview = true;
    context.scoringAuthorityCatalogue![0]!.claims.push({
      text: 'The minimum permitted temperature is 2 C.',
      sourceBlockId: 'b2',
      premiseKinds: ['expected_answer', 'rubric_point'],
    });
    const candidate = proposal();
    candidate.items[0]!.question.rubricKeyPoints[0]!.sourceRefs = ['b1', 'b2'];
    const result = validateFormalScoringProposal(candidate, context);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([expect.stringContaining('unattached sourceRefs: b2')]);
    expect(result.diagnostics[0]).toContain('extraEvidence');
    const attached = {
      items: [
        {
          ...candidate.items[0]!,
          extraEvidence: [
            { blockId: 'b2', quote: context.scoringAuthorityCatalogue![0]!.claims[1]!.text },
          ],
        },
      ],
    };
    expect(validateFormalScoringProposal(attached, context).valid).toBe(true);
    expect(candidate.items[0]!.question.rubricKeyPoints[0]!.sourceRefs).toEqual(['b1', 'b2']);
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
