import { describe, expect, it } from 'vitest';
import {
  CurriculumDetailProposalPayloadSchema,
  FORMAL_SUPPORTED_CONSTRUCTS,
  FormalAssessmentConstructSchema,
  classifyConstructAuthority,
  isFormalSupportedConstruct,
  supportsFormalApplicationDemand,
  type CurriculumObjective,
  type DesiredDepth,
  type FormalAssessmentConstruct,
  type ObjectiveAuthoritySemanticSupport,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import { curriculumDetailProposalMessages } from '../llm/prompts.js';
import type { CurriculumDetailProposalInput } from '../llm/provider.js';
import { buildCurriculumAuthorityEnvelope } from './curriculumAuthority.js';
import { validateCurriculumDetailCandidate } from './curriculumMaterialization.js';
import { deriveEffectiveObjectiveSubjectClass } from './objectiveAuthoritySemanticSupport.js';
import {
  TeachingSkeletonPlanningError,
  planTeachingSkeleton,
  requiredDepthContracts,
} from './teachingSkeletonPlanner.js';

const DEPTHS: readonly DesiredDepth[] = [
  'pass_oriented',
  'working_fluency',
  'high_performance',
  'deep_transfer',
];
const CONSTRUCTS = FormalAssessmentConstructSchema.options;
const MODES = ['exact_source', 'advisory_visual', 'unavailable'] as const;
const PRIORITIES = ['required', 'high', 'normal', 'optional'] as const;
const HIGHER_CONSTRUCTS: FormalAssessmentConstruct[] = ['design', 'evaluate'];

function plan(
  construct: FormalAssessmentConstruct,
  authorityMode: (typeof MODES)[number],
  priority: (typeof PRIORITIES)[number],
  targetDepth: DesiredDepth,
): { planned: boolean; code: string | null } {
  try {
    planTeachingSkeleton({
      learningUnitTitle: 'Bounded unit',
      targetMinutes: 30,
      targetDepth,
      objectives: [
        {
          objectiveRef: 'O1',
          title: 'Bounded objective',
          description: 'A bounded objective for the construct-authority matrix.',
          priority,
          construct,
          authorityMode,
          allowedSourceRefs: authorityMode === 'exact_source' ? ['S1'] : [],
          allowedVisualRefs: authorityMode === 'advisory_visual' ? ['V1'] : [],
        },
      ],
    });
    return { planned: true, code: null };
  } catch (error) {
    return {
      planned: false,
      code: error instanceof TeachingSkeletonPlanningError ? error.code : 'UNKNOWN',
    };
  }
}

/** Constructs describe the learner capability; current source and scoring
 * review determine whether a particular objective earns Formal authority. */
describe('all supported constructs stay teachable', () => {
  it('keeps every construct in the shared teaching vocabulary', () => {
    expect([...CONSTRUCTS]).toEqual(['identify', 'explain', 'apply', 'design', 'evaluate']);
    for (const construct of HIGHER_CONSTRUCTS) {
      // Still parseable everywhere the shared vocabulary is used, so accepted
      // history containing these values stays readable.
      expect(FormalAssessmentConstructSchema.parse(construct)).toBe(construct);
      expect(isFormalSupportedConstruct(construct)).toBe(true);
    }
  });

  it('plans a higher construct with exact teaching evidence', () => {
    for (const construct of HIGHER_CONSTRUCTS) {
      for (const priority of PRIORITIES) {
        for (const targetDepth of DEPTHS) {
          expect(plan(construct, 'exact_source', priority, targetDepth).planned).toBe(true);
        }
      }
    }
  });

  it('keeps its teaching obligations rather than downgrading it to a weaker construct', () => {
    // Formal eligibility never lowers the requested teaching capability.
    for (const construct of HIGHER_CONSTRUCTS) {
      expect(requiredDepthContracts('deep_transfer', construct)).toContain('semantic_relation');
      expect(requiredDepthContracts('pass_oriented', construct)).toEqual([]);
    }
  });
});

describe('construct eligibility preserves source authority boundaries', () => {
  it('classifies constructs eligible for independent Formal review', () => {
    for (const construct of CONSTRUCTS) {
      expect(classifyConstructAuthority(construct)).toBe(
        (FORMAL_SUPPORTED_CONSTRUCTS as readonly string[]).includes(construct)
          ? 'formal_supported'
          : 'teaching_only',
      );
    }
  });

  it('refuses unavailable sources and stronger constructs on advisory visuals', () => {
    const cells = CONSTRUCTS.flatMap((construct) =>
      MODES.flatMap((mode) =>
        PRIORITIES.flatMap((priority) =>
          DEPTHS.map((depth) => ({
            construct,
            mode,
            priority,
            depth,
            ...plan(construct, mode, priority, depth),
          })),
        ),
      ),
    );
    expect(cells).toHaveLength(
      CONSTRUCTS.length * MODES.length * PRIORITIES.length * DEPTHS.length,
    );
    const refused = cells.filter((cell) => !cell.planned);

    // The refusals are exactly the pre-existing authority-mode refusals:
    // every `unavailable` cell, plus every `advisory_visual` cell whose
    // construct is stronger than `explain`; source permission stays bounded.
    const perPriorityDepth = PRIORITIES.length * DEPTHS.length;
    const strongerThanExplain = CONSTRUCTS.filter(
      (construct) => construct !== 'identify' && construct !== 'explain',
    ).length;
    expect(refused).toHaveLength(
      CONSTRUCTS.length * perPriorityDepth + strongerThanExplain * perPriorityDepth,
    );
    expect([...new Set(refused.map((cell) => cell.code))].sort()).toEqual([
      'construct_authority_incompatible',
      'objective_authority_unavailable',
    ]);
    expect(refused.every((cell) => cell.mode !== 'exact_source')).toBe(true);

    // Higher constructs remain available at every ordinary priority.
    const leak = cells.filter(
      (cell) =>
        HIGHER_CONSTRUCTS.includes(cell.construct) &&
        cell.mode === 'exact_source' &&
        cell.priority !== 'required',
    );
    expect(leak).toHaveLength(24);
    expect(leak.every((cell) => cell.planned)).toBe(true);
    expect(
      leak.every((cell) => classifyConstructAuthority(cell.construct) === 'formal_supported'),
    ).toBe(true);
  });

  it('can request application-level demand for higher constructs while unknown constructs remain unavailable', () => {
    for (const construct of HIGHER_CONSTRUCTS) {
      expect(supportsFormalApplicationDemand(construct)).toBe(true);
    }
    expect(supportsFormalApplicationDemand('apply')).toBe(true);
    expect(supportsFormalApplicationDemand(null)).toBe(false);
  });
});

/**
 * Standing owner decision: depth decides WHICH obligations are required, never
 * WHICH constructs may be formally assessed. The authority input type has no
 * depth field, so this is a compile-time property as well as a runtime one.
 */
describe('depth is orthogonal to Formal construct authority', () => {
  it('changes no cell of the construct x mode x priority x depth reachability matrix', () => {
    let depthSensitive = 0;
    for (const construct of CONSTRUCTS) {
      for (const mode of MODES) {
        for (const priority of PRIORITIES) {
          const byDepth = DEPTHS.map((depth) => plan(construct, mode, priority, depth).planned);
          if (new Set(byDepth).size > 1) depthSensitive += 1;
        }
      }
    }
    expect(depthSensitive).toBe(0);
  });

  it('keeps higher constructs eligible at the deepest target depth', () => {
    for (const construct of HIGHER_CONSTRUCTS) {
      expect(classifyConstructAuthority(construct)).toBe('formal_supported');
      expect(supportsFormalApplicationDemand(construct)).toBe(true);
      // Depth adds teaching obligations, without certifying source support.
      expect(requiredDepthContracts('deep_transfer', construct).length).toBeGreaterThan(0);
    }
  });

  it('keeps the strongest supported construct valid at the deepest target depth', () => {
    expect(plan('apply', 'exact_source', 'required', 'deep_transfer').planned).toBe(true);
    expect(supportsFormalApplicationDemand('apply')).toBe(true);
  });
});

/**
 * U-12. The general lane is reachable offline only through one hard-coded
 * FakeProvider proposition, so any offline test routed through the provider
 * proves nothing about the production gate. These drive the production rule
 * directly, with no fixture string anywhere.
 */
describe('general-lane subject-class relaxation is dual-key and fail-closed', () => {
  const objective = (subjectClass: CurriculumObjective['subjectClass']) =>
    ({ subjectClass }) as Pick<CurriculumObjective, 'subjectClass'>;
  const support = (subjectDependency: 'general_sufficient' | 'source_specific_required') =>
    ({ subjectDependency }) as Pick<ObjectiveAuthoritySemanticSupport, 'subjectDependency'>;

  it('relaxes to general only when both keys agree', () => {
    expect(
      deriveEffectiveObjectiveSubjectClass(objective('general'), support('general_sufficient')),
    ).toBe('general');
  });

  it('collapses to source_specific whenever either key withholds', () => {
    const cases: Array<[CurriculumObjective['subjectClass'], ReturnType<typeof support> | null]> = [
      ['general', support('source_specific_required')],
      ['source_specific', support('general_sufficient')],
      ['source_specific', support('source_specific_required')],
      ['general', null],
      ['source_specific', null],
    ];
    for (const [subjectClass, semanticSupport] of cases) {
      expect(deriveEffectiveObjectiveSubjectClass(objective(subjectClass), semanticSupport)).toBe(
        'source_specific',
      );
    }
    expect(deriveEffectiveObjectiveSubjectClass(objective('general'), undefined)).toBe(
      'source_specific',
    );
    expect(deriveEffectiveObjectiveSubjectClass(objective('general'), {})).toBe('source_specific');
  });

  it('grants no Formal construct to a general objective with no exact source claim', () => {
    // A general/supplemental objective has by construction no exact claim bound
    // to a source block, so the envelope is `unavailable` and carries nothing.
    const authority = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [],
      authorityBundles: [],
      isBlockingEligible: () => true,
    });
    expect(authority.tier).toBe('unavailable');
    expect(authority.supportedConstructs).toEqual([]);
    expect(authority.strongestSupportedConstruct).toBeNull();
  });
});

describe('the Formal provider contract states its own limits', () => {
  const prompt = () =>
    curriculumDetailProposalMessages({
      workspaceName: 'Contract test',
      contract: {
        intent: 'Master the source',
        targetOutcome: { description: 'Explain the source', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: [],
        includedTopics: [],
        excludedTopics: [],
        priorKnowledge: null,
        constraints: null,
      },
      courseMapId: 'course_map_000000000000000000000001',
      sourceAllocationFingerprint:
        'course_map_source_allocation_0000000000000000000000000000000000000000',
      regions: [],
      limits: { maxObjectivesPerUnit: 3 },
    } as unknown as Parameters<typeof curriculumDetailProposalMessages>[0])
      .map((message) => message.content)
      .join('\n');

  it('distinguishes review eligibility from semantic and scoring approval', () => {
    const text = prompt();
    expect(text).toContain('These constructs may be independently reviewed for Formal assessment');
    expect(text).toContain(FORMAL_SUPPORTED_CONSTRUCTS.join(' | '));
    expect(text).toContain('not a semantic approval');
    expect(text).toContain('question-specific scoring authority');
  });

  it('does not tell the provider that design or evaluate are impossible learning goals', () => {
    const text = prompt();
    expect(text).toContain(
      'A goal without sufficient source rules or criteria remains teaching-only regardless of its construct',
    );
    expect(text).toContain('Depth, difficulty, and learner ambition never widen this set');
  });
});

/**
 * U-12 / §23. FakeProvider must not be a cheat that only ever emits happy-path
 * constructs, or offline tests would prove nothing about the real refusal. The
 * fixture below drives the ORDINARY Formal lane with a teaching-only construct
 * over the STRONGEST evidence the system can produce - an envelope that
 * genuinely supports `apply` - and the production validator still refuses.
 */
describe('FakeProvider general lane exercises the real refusal', () => {
  const APPLY_EVIDENCE = '[SUPPORTS:apply] 必须：先检索 → 按权限过滤 → 再给模型。';

  const applyEnvelope = {
    sourceRegionId: 'source-region-1',
    sourceBlockIds: ['block-1'],
    formalEvidenceIds: ['E-apply'],
    supportedConstructs: ['identify', 'explain', 'apply'] as const,
    strongestSupportedConstruct: 'apply' as const,
    narrowerClaim: '必须：先检索 → 按权限过滤 → 再给模型。',
    tier: 'formal_sufficient' as const,
    rationale: 'The exact source states a bounded ordered procedure.',
  };

  const detailInput = () =>
    ({
      workspaceName: 'Authority lane',
      contract: {
        intent: 'Master the bounded workflow',
        // `apply` in the target outcome is what makes the ordinary lane reach
        // for an application-capable objective at `required` priority.
        targetOutcome: { description: 'Apply the source-stated workflow', targetScore: null },
        desiredDepth: 'deep_transfer',
        subjectBoundaries: [],
        includedTopics: [],
        excludedTopics: [],
        priorKnowledge: null,
        constraints: null,
      },
      courseMapId: `course_map_${'a'.repeat(24)}`,
      sourceAllocationFingerprint: `course_map_source_allocation_${'b'.repeat(40)}`,
      batchKey: 'authority-batch-1',
      regions: [
        {
          regionId: `course_map_region_${'c'.repeat(24)}`,
          moduleId: 'module-1',
          moduleIndex: 0,
          moduleTitle: 'Workflow',
          regionIndex: 0,
          title: 'Bounded retrieval workflow',
          learningIntent: 'Apply the source-stated retrieval workflow.',
          approximateScope: 'focused',
          sourceAllocationRegionIds: ['source-region-1'],
          prerequisiteRegionIds: [],
          synthesisGroups: [],
          concepts: [],
          canonicalConcepts: [],
          evidence: [
            {
              evidenceId: 'E-apply',
              sourceAllocationRegionId: 'source-region-1',
              text: APPLY_EVIDENCE,
              authorityEnvelope: applyEnvelope,
            },
          ],
        },
      ],
      limits: { maxUnits: 1, maxObjectivesPerUnit: 1, maxEvidenceSelectionsPerUnit: 2 },
    }) as unknown as CurriculumDetailProposalInput;

  it('accepts the ordinary supported construct on the same evidence', async () => {
    const input = detailInput();
    const payload = await new FakeProvider().proposeCurriculumDetails(input);
    const objective = payload.units[0]!.objectives[0]!;
    expect(objective.construct).toBe('apply');
    expect(objective.priority).toBe('required');
    expect(validateCurriculumDetailCandidate(payload, input).diagnosticCodes ?? []).not.toContain(
      'required_objective_formal_authority_missing',
    );
  });

  it.each(HIGHER_CONSTRUCTS)(
    'refuses a provider-authored %s objective without corrupting the proposal',
    async (curriculumObjectiveConstructFixture) => {
      const input = detailInput();
      const payload = await new FakeProvider({
        curriculumObjectiveConstructFixture,
      }).proposeCurriculumDetails(input);

      // The wire contract still ACCEPTS the teaching vocabulary: the refusal is
      // an authority decision, not a parse failure, so the learner goal is
      // visible and reportable rather than silently dropped.
      expect(CurriculumDetailProposalPayloadSchema.parse(payload)).toEqual(payload);
      const objective = payload.units[0]!.objectives[0]!;
      expect(objective.construct).toBe(curriculumObjectiveConstructFixture);
      expect(objective.priority).toBe('required');

      const before = structuredClone(payload);
      expect(validateCurriculumDetailCandidate(payload, input)).toMatchObject({
        valid: false,
        diagnosticCodes: expect.arrayContaining(['required_objective_formal_authority_missing']),
      });
      // Fail closed: nothing was rewritten, narrowed, or aliased to a supported
      // construct to manufacture a pass.
      expect(payload).toEqual(before);
    },
  );
});

/** Occurrence authority records available premises, not semantic proof. */
describe('the source envelope leaves semantic adequacy to independent review', () => {
  const NOW = '2026-09-02T00:00:00.000Z';
  const evaluateShaped =
    'Evaluate whether a proposed retrieval configuration is appropriate for production.';

  it('offers all constructs for review even when a statement alone proves no capability', () => {
    const authority = buildCurriculumAuthorityEnvelope({
      sourceRegionId: 'region-1',
      sourceBlockIds: ['block-1'],
      evidence: [
        {
          id: 'evidence-1',
          bindingId: 'binding-1',
          materialId: 'material-1',
          materialRevisionId: 'revision-1',
          blockId: 'block-1',
          startOffset: 0,
          endOffset: evaluateShaped.length,
          quote: evaluateShaped,
          headingPath: [],
          pageNumber: null,
        },
      ],
      authorityBundles: [
        {
          record: {
            id: 'authority-1',
            workspaceId: 'workspace-1',
            logicalSourceId: 'source-1',
            materialId: 'material-1',
            materialRevisionId: 'revision-1',
            version: 1,
            predecessorId: null,
            premiseScope: 'exact source statement',
            policyBasis: {
              policyVersion: 'local-verbatim-source-v1',
              premiseKind: 'claim',
              basis: 'exact occurrence only',
            },
            validationState: 'validated',
            conflictState: 'none',
            actor: 'local_validator',
            createdAt: NOW,
            updatedAt: NOW,
          },
          claims: [
            {
              id: 'claim-1',
              authorityRecordId: 'authority-1',
              sourceBlockId: 'block-1',
              claim: evaluateShaped,
              quote: evaluateShaped,
              startOffset: 0,
              endOffset: evaluateShaped.length,
              occurrenceCount: 1,
              createdAt: NOW,
            },
          ],
          events: [],
        },
      ],
      isBlockingEligible: () => true,
    });
    expect(authority.supportedConstructs).toEqual([...FORMAL_SUPPORTED_CONSTRUCTS]);
    // These are candidate constructs, never an approval of this objective.
    expect(authority.supportedConstructs).toContain('evaluate');
    expect(authority.strongestSupportedConstruct).toBe('evaluate');
  });
});
