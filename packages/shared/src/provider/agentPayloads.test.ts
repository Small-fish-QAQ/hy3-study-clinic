import { describe, expect, it } from 'vitest';
import { CurriculumProposalPayloadSchema, StudyPlanProposalPayloadSchema } from './payloads.js';

function curriculumPayload(): unknown {
  return {
    nodes: [
      {
        key: 'chapter-1',
        parentKey: null,
        kind: 'chapter',
        index: 0,
        title: 'Foundations',
        structuralUnitIds: ['su_chapter'],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'section-1',
        parentKey: 'chapter-1',
        kind: 'section',
        index: 0,
        title: 'Core ideas',
        structuralUnitIds: ['su_section'],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'unit-1',
        parentKey: 'section-1',
        kind: 'learning_unit',
        index: 0,
        title: 'First idea',
        structuralUnitIds: ['su_unit_1'],
        sourceEvidence: [{ blockId: 'blk_1', quote: 'First source statement.' }],
        conceptIds: ['con_1'],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-1',
            title: 'Explain the first idea',
            description: 'Explain it from the accepted course material.',
            evidence: [{ blockId: 'blk_1', quote: 'First source statement.' }],
          },
        ],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
      {
        key: 'unit-2',
        parentKey: 'section-1',
        kind: 'learning_unit',
        index: 1,
        title: 'Second idea',
        structuralUnitIds: ['su_unit_2'],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-2',
            title: 'Explore the second idea',
            description: 'A learner-scoped objective without verified source evidence.',
            evidence: [],
          },
        ],
        prerequisiteUnitKeys: ['unit-1'],
        graphRelationIds: ['edge_1'],
      },
    ],
    synthesisGroups: [
      {
        key: 'synthesis-1',
        title: 'Connect both ideas',
        level: 'section',
        learningUnitKeys: ['unit-1', 'unit-2'],
        objectiveKeys: ['objective-1', 'objective-2'],
      },
    ],
  };
}

function studyPlanPayload(): unknown {
  return {
    rationale: 'Learn prerequisites before dependent work.',
    items: [
      {
        key: 'item-1',
        phase: 'Foundation',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_1',
        rationale: 'Teach the prerequisite.',
        estimatedMinutes: 20,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_1'],
        prerequisiteItemKeys: [],
      },
      {
        key: 'item-2',
        phase: 'Foundation',
        kind: 'formal_checkpoint',
        curriculumLearningUnitId: 'unit_1',
        rationale: 'Check the independently supported objective.',
        estimatedMinutes: 10,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_1'],
        prerequisiteItemKeys: ['item-1'],
      },
    ],
    deferrals: [
      {
        curriculumLearningUnitId: 'unit_2',
        objectiveIds: ['objective_2'],
        reason: 'The learner explicitly allowed this deferral.',
      },
    ],
  };
}

describe('CurriculumProposalPayloadSchema', () => {
  it('accepts a bounded hierarchy including an unverified teaching objective', () => {
    expect(CurriculumProposalPayloadSchema.safeParse(curriculumPayload()).success).toBe(true);
  });

  it('rejects provider attempts to assign truth or lifecycle authority', () => {
    const payload = curriculumPayload() as {
      status?: string;
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    payload.status = 'accepted';
    payload.nodes[2]!.objectives[0]!.truthPremiseStatus = 'independently_verified';
    expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects unknown internal references and duplicate proposal-local keys', () => {
    const payload = curriculumPayload() as {
      nodes: Array<{ key: string; prerequisiteUnitKeys: string[] }>;
    };
    payload.nodes[3]!.key = 'unit-1';
    payload.nodes[3]!.prerequisiteUnitKeys = ['missing-unit'];
    expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('StudyPlanProposalPayloadSchema', () => {
  it('accepts route semantics without consequential local fields', () => {
    expect(StudyPlanProposalPayloadSchema.safeParse(studyPlanPayload()).success).toBe(true);
  });

  it('rejects acceptance, admissibility, and completion-policy fields', () => {
    const payload = studyPlanPayload() as {
      status?: string;
      items: Array<Record<string, unknown>>;
    };
    payload.status = 'accepted';
    payload.items[1]!.admissibilityTier = 'tier_1_course_truth';
    payload.items[1]!.completionRequirements = [];
    expect(StudyPlanProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects duplicate and self-referential proposal-local item keys', () => {
    const payload = studyPlanPayload() as {
      items: Array<{ key: string; prerequisiteItemKeys: string[] }>;
    };
    payload.items[1]!.key = 'item-1';
    payload.items[1]!.prerequisiteItemKeys = ['item-1'];
    expect(StudyPlanProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
