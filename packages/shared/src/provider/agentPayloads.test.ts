import { describe, expect, it } from 'vitest';
import {
  CurriculumProposalPayloadSchema,
  GroupedStudyPlanProposalPayloadSchema,
  StudyPlanProposalPayloadSchema,
} from './payloads.js';

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
        sourceEvidence: [{ evidenceId: 'evidence_1' }],
        conceptIds: ['con_1'],
        canonicalConceptIds: [],
        objectives: [
          {
            key: 'objective-1',
            title: 'Explain the first idea',
            description: 'Explain it from the accepted course material.',
            subjectClass: 'source_specific',
            scopeOrigin: 'anchored',
            construct: 'explain',
            evidence: [{ evidenceId: 'evidence_1' }],
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
            subjectClass: 'general',
            scopeOrigin: 'supplemental',
            construct: 'identify',
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

  it('accepts only server-offered evidence identities, never model-authored quote text', () => {
    const payload = curriculumPayload() as {
      nodes: Array<{ sourceEvidence: Array<Record<string, unknown>> }>;
    };
    payload.nodes[2]!.sourceEvidence = [{ blockId: 'blk_1', quote: 'paraphrased' }];
    expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('requires every proposed objective to declare its immutable construct', () => {
    const payload = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    delete payload.nodes[2]!.objectives[0]!.construct;
    expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('accepts all valid subject-class and scope-origin combinations', () => {
    for (const [subjectClass, scopeOrigin] of [
      ['source_specific', 'anchored'],
      ['general', 'anchored'],
      ['general', 'supplemental'],
    ] as const) {
      const payload = curriculumPayload() as {
        nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
      };
      payload.nodes[2]!.objectives[0]!.subjectClass = subjectClass;
      payload.nodes[2]!.objectives[0]!.scopeOrigin = scopeOrigin;
      expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(true);
    }
  });

  it('rejects forbidden, missing, and partial provider classification metadata', () => {
    const forbidden = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    forbidden.nodes[2]!.objectives[0]!.scopeOrigin = 'supplemental';
    expect(CurriculumProposalPayloadSchema.safeParse(forbidden).success).toBe(false);

    const missingBoth = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    delete missingBoth.nodes[2]!.objectives[0]!.subjectClass;
    delete missingBoth.nodes[2]!.objectives[0]!.scopeOrigin;
    expect(CurriculumProposalPayloadSchema.safeParse(missingBoth).success).toBe(false);

    const missingSubjectClass = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    delete missingSubjectClass.nodes[2]!.objectives[0]!.subjectClass;
    expect(CurriculumProposalPayloadSchema.safeParse(missingSubjectClass).success).toBe(false);

    const missingScopeOrigin = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    delete missingScopeOrigin.nodes[2]!.objectives[0]!.scopeOrigin;
    expect(CurriculumProposalPayloadSchema.safeParse(missingScopeOrigin).success).toBe(false);
  });

  it('accepts an operation-local recovery capability reference on an objective', () => {
    const payload = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    payload.nodes[2]!.objectives[0]!.capabilityRequirementRef = 'capability-1';

    expect(CurriculumProposalPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects one recovery capability emitted by more than one objective', () => {
    const payload = curriculumPayload() as {
      nodes: Array<{ objectives: Array<Record<string, unknown>> }>;
    };
    payload.nodes[2]!.objectives[0]!.capabilityRequirementRef = 'capability-1';
    payload.nodes[3]!.objectives[0]!.capabilityRequirementRef = 'capability-1';

    expect(() => CurriculumProposalPayloadSchema.parse(payload)).toThrow(
      /duplicate Curriculum capability requirement/u,
    );
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

describe('GroupedStudyPlanProposalPayloadSchema', () => {
  const groupedPayload = () => ({
    format: 'grouped_units',
    rationale: 'Move from foundations to application.',
    groups: [
      {
        key: 'foundation',
        phase: 'Foundation',
        kind: 'teach_unit',
        curriculumLearningUnitIds: ['unit_1', 'unit_2'],
        rationale: 'Build the prerequisite chain.',
        estimatedMinutesPerUnit: 20,
        targetDepth: 'working_fluency',
      },
    ],
    deferrals: [],
  });

  it('accepts compact unit groups without provider-assigned objective identity', () => {
    expect(GroupedStudyPlanProposalPayloadSchema.safeParse(groupedPayload()).success).toBe(true);
  });

  it('rejects duplicate unit accounting across groups and deferrals', () => {
    const payload = groupedPayload();
    payload.deferrals = [
      { curriculumLearningUnitIds: ['unit_2'], reason: 'Explicit learner deferral.' },
    ];
    expect(GroupedStudyPlanProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects consequential fields and unsupported synthesis grouping', () => {
    const payload = groupedPayload() as ReturnType<typeof groupedPayload> & {
      status?: string;
    };
    payload.status = 'accepted';
    payload.groups[0]!.kind = 'synthesis';
    expect(GroupedStudyPlanProposalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
