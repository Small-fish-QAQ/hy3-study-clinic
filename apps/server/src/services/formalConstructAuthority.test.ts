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
const TEACHING_ONLY = CONSTRUCTS.filter(
  (construct) => !(FORMAL_SUPPORTED_CONSTRUCTS as readonly string[]).includes(construct),
);

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

/**
 * Slice 5B. OQ-2: the teaching vocabulary stays wide and Formal authority
 * narrows. `design`/`evaluate` must therefore remain fully usable as teaching
 * constructs - a learner goal must never silently disappear - while being
 * unable to acquire Formal authority by any route.
 */
describe('teaching-only constructs stay teachable', () => {
  it('keeps every construct in the shared teaching vocabulary', () => {
    expect([...CONSTRUCTS]).toEqual(['identify', 'explain', 'apply', 'design', 'evaluate']);
    for (const construct of TEACHING_ONLY) {
      // Still parseable everywhere the shared vocabulary is used, so accepted
      // history containing these values stays readable.
      expect(FormalAssessmentConstructSchema.parse(construct)).toBe(construct);
      expect(isFormalSupportedConstruct(construct)).toBe(false);
    }
  });

  it('plans a teaching-only construct with exact teaching evidence', () => {
    for (const construct of TEACHING_ONLY) {
      for (const priority of PRIORITIES) {
        for (const targetDepth of DEPTHS) {
          expect(plan(construct, 'exact_source', priority, targetDepth).planned).toBe(true);
        }
      }
    }
  });

  it('keeps its teaching obligations rather than downgrading it to a weaker construct', () => {
    // A teaching-only construct still earns real teaching contracts. Narrowing
    // Formal authority must not quietly rewrite what the lesson must contain.
    for (const construct of TEACHING_ONLY) {
      expect(requiredDepthContracts('deep_transfer', construct)).toContain('semantic_relation');
      expect(requiredDepthContracts('pass_oriented', construct)).toEqual([]);
    }
  });
});

describe('Formal authority cannot be reached through the teaching lane', () => {
  it('classifies exactly the constructs with a local evidence predicate as supported', () => {
    for (const construct of CONSTRUCTS) {
      expect(classifyConstructAuthority(construct)).toBe(
        (FORMAL_SUPPORTED_CONSTRUCTS as readonly string[]).includes(construct)
          ? 'formal_supported'
          : 'teaching_only',
      );
    }
  });

  it('keeps the planner refusing every case it refused before', () => {
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
    // construct is stronger than `explain`. 5B added no new planner refusal
    // and removed none, so the leak is closed downstream, not by deleting a
    // learner goal here.
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

    // N-U11T's 24 leak cells - teaching-only construct, exact teaching
    // evidence, non-required priority - are still PLANNED, by owner decision
    // OQ-2. Teaching intent survives; Formal authority is what narrowed.
    const leak = cells.filter(
      (cell) =>
        TEACHING_ONLY.includes(cell.construct) &&
        cell.mode === 'exact_source' &&
        cell.priority !== 'required',
    );
    expect(leak).toHaveLength(24);
    expect(leak.every((cell) => cell.planned)).toBe(true);
    expect(
      leak.every((cell) => classifyConstructAuthority(cell.construct) === 'teaching_only'),
    ).toBe(true);
  });

  it('refuses to promote a teaching-only construct to application-level Formal demand', () => {
    for (const construct of TEACHING_ONLY) {
      expect(supportsFormalApplicationDemand(construct)).toBe(false);
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

  it('leaves a teaching-only construct unsupported at the deepest target depth', () => {
    for (const construct of TEACHING_ONLY) {
      expect(classifyConstructAuthority(construct)).toBe('teaching_only');
      expect(supportsFormalApplicationDemand(construct)).toBe(false);
      // Depth still adds a real teaching obligation, so the goal is not lost -
      // it simply is not formally certifiable.
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

  it('names the supported constructs and the teaching-only ones separately', () => {
    const text = prompt();
    expect(text).toContain('Only these constructs can currently carry Formal assessment authority');
    expect(text).toContain(FORMAL_SUPPORTED_CONSTRUCTS.join(' | '));
    expect(text).toContain('teaching-only for now');
    expect(text).toContain(TEACHING_ONLY.join(' | '));
  });

  it('does not tell the provider that design or evaluate are impossible learning goals', () => {
    const text = prompt();
    expect(text).toContain('They are valid learning goals and valid teaching intent');
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

  it.each(TEACHING_ONLY)(
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

/**
 * N-EXPLAINLEX, recorded 2026-09-01 and NOT fixed in this Slice. `supportsExplain`
 * matches bare copulas, so the `explain` rung is granted by almost any validated
 * formal claim - an evaluate-shaped claim earns it on the word "is" alone.
 *
 * This is a CHARACTERISATION test, not an endorsement. It exists so that
 * tightening the predicate makes a test fail loudly instead of silently moving
 * an authority boundary, and so 5B's narrowing is not mistaken for a fix.
 */
describe('N-EXPLAINLEX: the explain rung is currently near-vacuous lexically', () => {
  const NOW = '2026-09-02T00:00:00.000Z';
  const evaluateShaped =
    'Evaluate whether a proposed retrieval configuration is appropriate for production.';

  it('grants explain to an evaluate-shaped claim on the copula alone', () => {
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
    expect(authority.supportedConstructs).toEqual(['identify', 'explain']);
    // The claim is evaluate-SHAPED, and `evaluate` is still refused. The loose
    // predicate widens `explain`, never the teaching-only rungs.
    expect(authority.supportedConstructs).not.toContain('evaluate');
    expect(authority.strongestSupportedConstruct).toBe('explain');
  });
});
