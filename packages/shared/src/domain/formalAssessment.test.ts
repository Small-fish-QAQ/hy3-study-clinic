import { describe, expect, it } from 'vitest';
import {
  classifyFormalAssessmentItem,
  FormalAssessmentSourceBindingSchema,
  LearnerAssessmentExecutionSchema,
} from './formalAssessment.js';

const binding = (overrides: Record<string, unknown> = {}) =>
  FormalAssessmentSourceBindingSchema.parse({
    materialId: 'mat_1',
    materialRevisionId: 'rev_1',
    sourceBlockId: 'block_1',
    quote: 'A stable claim.',
    contentOrigin: 'extracted_original',
    authoritative: true,
    ...overrides,
  });

describe('formal assessment policy', () => {
  it('allows only authoritative short-answer items with a target and sourced rubric', () => {
    expect(
      classifyFormalAssessmentItem({
        targetLearningUnitId: 'unit_1',
        questionType: 'short_answer',
        sourceBindings: [binding()],
        rubric: [
          {
            id: 'criterion_1',
            text: 'States the claim',
            required: true,
            sourceBindingIds: ['block_1'],
          },
        ],
      }),
    ).toEqual({ formalEligible: true, policyReason: 'FORMAL_ELIGIBLE' });
  });
  it('downgrades derived visual material and incomplete choice authority', () => {
    expect(
      classifyFormalAssessmentItem({
        targetLearningUnitId: 'unit_1',
        questionType: 'short_answer',
        sourceBindings: [
          binding({ contentOrigin: 'derived_visual_description', authoritative: false }),
        ],
        rubric: [{ id: 'c', text: 'idea', required: true, sourceBindingIds: ['block_1'] }],
      }).policyReason,
    ).toBe('DERIVED_ONLY_SOURCE');
    expect(
      classifyFormalAssessmentItem({
        targetLearningUnitId: 'unit_1',
        questionType: 'single_choice',
        sourceBindings: [binding()],
      }).policyReason,
    ).toBe('CHOICE_OPTION_AUTHORITY_INCOMPLETE');
  });
  it('requires each rubric criterion to cite a bound source block', () => {
    expect(
      classifyFormalAssessmentItem({
        targetLearningUnitId: 'unit_1',
        questionType: 'short_answer',
        sourceBindings: [binding()],
        rubric: [{ id: 'c', text: 'idea', required: true, sourceBindingIds: ['foreign_block'] }],
      }).policyReason,
    ).toBe('INVALID_RUBRIC_AUTHORITY');
  });
});

it('keeps learner execution projections free of internal rubric payloads', () => {
  const parsed = LearnerAssessmentExecutionSchema.parse({
    assessmentVersionId: 'version_1',
    title: '理解检查',
    attempt: {
      id: 'attempt_1',
      assessmentVersionId: 'version_1',
      workspaceId: 'workspace_1',
      ordinal: 1,
      status: 'started',
      responses: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      submittedAt: null,
      cancelledAt: null,
    },
    items: [
      { itemId: 'item_1', prompt: '说明关键能力。', purpose: '检验理解', sourceReferences: [] },
    ],
    result: null,
  });
  expect(parsed.items[0]?.prompt).toBe('说明关键能力。');
  expect(parsed.result).toBeNull();
});
