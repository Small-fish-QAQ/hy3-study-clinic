import { describe, expect, it } from 'vitest';
import {
  ConceptAnalysisPayloadSchema,
  CourseMapProposalPayloadSchema,
  CurriculumDetailProposalPayloadSchema,
  CurriculumProposalPayloadSchema,
  MasteryChallengeProposalPayloadSchema,
  QuizGenerationPayloadSchema,
  RubricGradeSchema,
  SAMPLE_MATERIAL_CONTENT,
  SAMPLE_MATERIAL_TITLE,
  TutorTurnPayloadSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  type Concept,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticRepairInput,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { segmentMaterial } from '../ingestion/segment.js';
import { verifyGrounding } from '../grounding/verify.js';
import {
  FakeProvider,
  type FakeMasteryRedTeamFixture,
  type FakeTutorTurnFixture,
} from './fakeProvider.js';
import { ProviderError } from './errors.js';
import type {
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
  CurriculumProposalInput,
  MasteryChallengeProposalInput,
  TutorTurnInput,
} from './provider.js';
import { validateTutorTurnCandidate } from '../tutor/pedagogy.js';

const materialId = 'mat_fixture';
const blocks = segmentMaterial(materialId, SAMPLE_MATERIAL_CONTENT.replace(/\r\n?/g, '\n'));
const provider = new FakeProvider();
const B7C2_POSITIONING_PROPOSITION =
  '解释 WeKnora 综合系统定位\n解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。';
const B7C2_INGESTION = '入库：上传 → 解析 → 切 chunk → embedding → 写入向量库';
const B7C2_POSITIONING =
  '### 一、概念层1. 系统定位与 RAG 全景\n\nWeKnora 不是单纯的大模型或搜索引擎，而是：文档系统 + 搜索系统 + 大模型 + 权限系统 + 工具调用系统。';

const semanticEvaluationInput: ObjectiveAuthoritySemanticEvaluationInput = {
  schemaVersion: 1,
  policyVersion: 'objective-authority-semantic-v1',
  objectives: [
    {
      objectiveRef: 'O1',
      proposition: 'Explain how the components jointly position the system.',
      construct: 'explain',
      evidence: [
        {
          evidenceRef: 'E1',
          text: '[SUPPORTS:explain] The system combines documents, search, language models, permissions, and tools.',
          claimKinds: ['claim'],
          headingPath: [],
        },
      ],
    },
  ],
};

function semanticRepairInput(): ObjectiveAuthoritySemanticRepairInput {
  return {
    schemaVersion: 1,
    policyVersion: 'objective-authority-semantic-v1',
    objectives: [
      {
        objectiveRef: 'O1',
        title: 'Explain the system positioning',
        description: semanticEvaluationInput.objectives[0]!.proposition,
        construct: 'explain',
        priority: 'required',
        currentEvidenceRefs: ['E1'],
        allowedEvidence: [
          {
            ...semanticEvaluationInput.objectives[0]!.evidence[0]!,
            text: '[UNSUPPORTED] The ingestion procedure has five ordered steps.',
            selected: true,
          },
          {
            evidenceRef: 'E2',
            text: '[SUPPORTS:explain] The system combines documents, search, language models, permissions, and tools.',
            claimKinds: ['claim'],
            headingPath: [],
            selected: false,
          },
        ],
        fragments: [
          {
            fragmentId: 'F1',
            text: semanticEvaluationInput.objectives[0]!.proposition,
            status: 'unsupported',
            supportType: null,
            evidenceRefs: [],
            rationale: 'The current binding supports a different proposition.',
          },
        ],
        unsupportedFragmentIds: ['F1'],
        conflicts: [],
        overreach: [],
        verdict: 'fail',
        rationale: 'Same-topic evidence does not entail the objective.',
      },
    ],
  };
}

describe('FakeProvider objective-authority semantic contract', () => {
  it('returns a deterministic same-construct support mapping without token-overlap scoring', async () => {
    const first = await provider.evaluateObjectiveAuthoritySupport(semanticEvaluationInput);
    const second = await provider.evaluateObjectiveAuthoritySupport(
      structuredClone(semanticEvaluationInput),
    );

    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.parse(first)).toEqual(second);
    expect(first.evaluations[0]).toMatchObject({
      objectiveRef: 'O1',
      construct: 'explain',
      verdict: 'pass',
      unsupportedFragmentIds: [],
    });
    expect(first.evaluations[0]!.fragments[0]).toMatchObject({
      text: semanticEvaluationInput.objectives[0]!.proposition,
      status: 'supported',
      supportType: 'relationship',
      evidenceRefs: ['E1'],
    });
  });

  it('fails the complete proposition when the explicit fake authority sentinel is unsupported', async () => {
    const result = await provider.evaluateObjectiveAuthoritySupport({
      ...semanticEvaluationInput,
      objectives: [
        {
          ...semanticEvaluationInput.objectives[0]!,
          evidence: [
            {
              ...semanticEvaluationInput.objectives[0]!.evidence[0]!,
              text: '[UNSUPPORTED] The ingestion procedure has five ordered steps.',
            },
          ],
        },
      ],
    });

    expect(result.evaluations[0]).toMatchObject({
      verdict: 'fail',
      unsupportedFragmentIds: ['O1:F1'],
    });
    expect(result.evaluations[0]!.fragments[0]).toMatchObject({
      status: 'unsupported',
      supportType: null,
      evidenceRefs: [],
    });
  });

  it('fails exact required preservation when unmarked evidence supports an unrelated proposition', async () => {
    const proposition = 'Explain how photosynthesis converts light into stored chemical energy.';
    const result = await provider.evaluateObjectiveAuthoritySupport({
      schemaVersion: 1,
      policyVersion: 'objective-authority-semantic-v1',
      objectives: [
        {
          objectiveRef: 'O1',
          proposition,
          construct: 'explain',
          evidence: [
            {
              evidenceRef: 'E-mitochondria',
              text: 'Mitochondria produce ATP through cellular respiration.',
              claimKinds: ['claim'],
              headingPath: ['Cellular respiration'],
            },
          ],
          requiredCapabilityPreservation: {
            originalProposition: proposition,
            originalFragments: [{ fragmentId: 'capability:F1', text: proposition }],
          },
        },
      ],
    });

    expect(result.evaluations[0]).toMatchObject({
      verdict: 'fail',
      unsupportedFragmentIds: ['O1:F1'],
      capabilityPreservation: {
        verdict: 'pass',
        lostOriginalFragmentIds: [],
      },
    });
    expect(result.evaluations[0]!.fragments[0]).toMatchObject({
      status: 'unsupported',
      supportType: null,
      evidenceRefs: [],
    });
  });

  it('distinguishes the exact B7C2 integrated-positioning authority from ingestion-only evidence', async () => {
    const ingestionOnly: ObjectiveAuthoritySemanticEvaluationInput = {
      schemaVersion: 1,
      policyVersion: 'objective-authority-semantic-v1',
      objectives: [
        {
          objectiveRef: 'O1',
          proposition: B7C2_POSITIONING_PROPOSITION,
          construct: 'explain',
          evidence: [
            {
              evidenceRef: 'E-ingestion',
              text: B7C2_INGESTION,
              claimKinds: ['procedure'],
              headingPath: ['RAG'],
            },
          ],
        },
      ],
    };
    const invalid = await provider.evaluateObjectiveAuthoritySupport(ingestionOnly);
    expect(invalid.evaluations[0]).toMatchObject({
      verdict: 'fail',
      unsupportedFragmentIds: ['O1:F1'],
    });

    const repairedInput: ObjectiveAuthoritySemanticRepairInput = {
      schemaVersion: 1,
      policyVersion: 'objective-authority-semantic-v1',
      objectives: [
        {
          objectiveRef: 'O1',
          title: '解释 WeKnora 综合系统定位',
          description:
            '解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。',
          construct: 'explain',
          priority: 'required',
          currentEvidenceRefs: ['E-ingestion'],
          allowedEvidence: [
            { ...ingestionOnly.objectives[0]!.evidence[0]!, selected: true },
            {
              evidenceRef: 'E-positioning',
              text: B7C2_POSITIONING,
              claimKinds: ['claim'],
              headingPath: ['系统定位与 RAG 全景'],
              selected: false,
            },
          ],
          fragments: [
            {
              fragmentId: 'O1:F1',
              text: B7C2_POSITIONING_PROPOSITION,
              status: 'unsupported',
              supportType: null,
              evidenceRefs: [],
              rationale: 'The ingestion procedure does not support integrated positioning.',
            },
          ],
          unsupportedFragmentIds: ['O1:F1'],
          conflicts: [],
          overreach: [],
          verdict: 'fail',
          rationale: 'The exact accepted binding is semantically unsupported.',
          requiredCapabilityPreservation: {
            originalProposition: B7C2_POSITIONING_PROPOSITION,
            originalFragments: [
              { fragmentId: 'recovery_capability_1:F1', text: B7C2_POSITIONING_PROPOSITION },
            ],
          },
        },
      ],
    };
    const repair = await provider.repairObjectiveAuthoritySupport(repairedInput);
    expect(repair.replacements[0]).toMatchObject({
      title: '解释 WeKnora 综合系统定位',
      construct: 'explain',
      evidenceRefs: ['E-positioning'],
    });

    const supported = await provider.evaluateObjectiveAuthoritySupport({
      ...ingestionOnly,
      objectives: [
        {
          ...ingestionOnly.objectives[0]!,
          evidence: [repairedInput.objectives[0]!.allowedEvidence[1]!],
          requiredCapabilityPreservation:
            repairedInput.objectives[0]!.requiredCapabilityPreservation,
        },
      ],
    });
    expect(supported.evaluations[0]).toMatchObject({
      verdict: 'pass',
      capabilityPreservation: { verdict: 'pass' },
      fragments: [{ evidenceRefs: ['E-positioning'], status: 'supported' }],
    });
  });

  it('selects only an explicitly allowed same-construct repair offer', async () => {
    const result = await provider.repairObjectiveAuthoritySupport(semanticRepairInput());

    expect(ObjectiveAuthoritySemanticRepairProposalSchema.parse(result)).toEqual(result);
    expect(result.replacements).toEqual([
      expect.objectContaining({
        objectiveRef: 'O1',
        construct: 'explain',
        evidenceRefs: ['E2'],
      }),
    ]);
    expect(result.replacements[0]).toMatchObject({
      title: 'Explain the system positioning',
      description: semanticEvaluationInput.objectives[0]!.proposition,
    });
  });

  it('passes exact learning-goal preservation and rejects a supported changed proposition', async () => {
    const originalProposition = semanticEvaluationInput.objectives[0]!.proposition;
    const originalFragments = [{ fragmentId: 'original_F1', text: originalProposition }];
    const preserved = await provider.evaluateObjectiveAuthoritySupport({
      ...semanticEvaluationInput,
      objectives: [
        {
          ...semanticEvaluationInput.objectives[0]!,
          requiredCapabilityPreservation: { originalProposition, originalFragments },
        },
      ],
    });
    expect(preserved.evaluations[0]).toMatchObject({
      verdict: 'pass',
      capabilityPreservation: {
        verdict: 'pass',
        lostOriginalFragmentIds: [],
        mappings: [{ originalFragmentId: 'original_F1', status: 'preserved' }],
      },
    });

    const changed = await provider.evaluateObjectiveAuthoritySupport({
      ...semanticEvaluationInput,
      objectives: [
        {
          ...semanticEvaluationInput.objectives[0]!,
          proposition: 'Explain only that a system exists.',
          requiredCapabilityPreservation: { originalProposition, originalFragments },
        },
      ],
    });
    expect(changed.evaluations[0]).toMatchObject({
      verdict: 'fail',
      unsupportedFragmentIds: [],
      capabilityPreservation: {
        verdict: 'fail',
        lostOriginalFragmentIds: ['original_F1'],
        mappings: [{ originalFragmentId: 'original_F1', status: 'lost' }],
      },
    });
  });

  it('restores the immutable predecessor proposition during recovery repair', async () => {
    const input = semanticRepairInput();
    input.objectives[0]!.title = 'Generic replacement title';
    input.objectives[0]!.description = 'A generic replacement description.';
    input.objectives[0]!.requiredCapabilityPreservation = {
      originalProposition:
        'Explain the original integrated system\nExplain how all original components jointly position the system.',
      originalFragments: [
        {
          fragmentId: 'original_F1',
          text: 'Explain the original integrated system\nExplain how all original components jointly position the system.',
        },
      ],
    };

    const result = await provider.repairObjectiveAuthoritySupport(input);

    expect(result.replacements[0]).toEqual({
      objectiveRef: 'O1',
      title: 'Explain the original integrated system',
      description: 'Explain how all original components jointly position the system.',
      construct: 'explain',
      evidenceRefs: ['E2'],
    });
  });

  it('preserves cancellation for evaluation and repair', async () => {
    const delayed = new FakeProvider({ delayMs: 30 });
    const evaluationAbort = new AbortController();
    const evaluation = delayed.evaluateObjectiveAuthoritySupport(semanticEvaluationInput, {
      signal: evaluationAbort.signal,
    });
    evaluationAbort.abort();
    await expect(evaluation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });

    const repairAbort = new AbortController();
    const repair = delayed.repairObjectiveAuthoritySupport(semanticRepairInput(), {
      signal: repairAbort.signal,
    });
    repairAbort.abort();
    await expect(repair).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});

describe('FakeProvider Curriculum capability recovery', () => {
  it('assigns every Course Map capability once within its source envelope and region capacity', async () => {
    const requirements: NonNullable<CourseMapProposalInput['capabilityRecovery']>['requirements'] =
      [
        {
          capabilityRef: 'capability-marker',
          title: '解释 WeKnora 综合系统定位',
          description:
            '解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。',
          originalProposition: B7C2_POSITIONING_PROPOSITION,
          construct: 'explain',
          priority: 'required',
          allowedSourceRegionRefs: ['R1', 'R2'],
          allowedRecoveryEvidenceRefs: ['CE1', 'CE2'],
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          capabilityRef: `capability-r1-${index + 1}`,
          title: `Explain bounded relation ${index + 1}`,
          description: `Explain the source-bounded relation ${index + 1}.`,
          originalProposition: `Explain bounded relation ${index + 1}\nExplain the source-bounded relation ${index + 1}.`,
          construct: 'explain' as const,
          priority: 'high' as const,
          allowedSourceRegionRefs: ['R1'],
          allowedRecoveryEvidenceRefs: ['CE1'],
        })),
      ];
    const input: CourseMapProposalInput = {
      contractVersion: 'course_map_proposal_v2',
      workspaceName: 'Recovery course',
      contract: {
        contractVersionId: 'contract-recovery',
        intent: 'Recover predecessor capabilities.',
        targetOutcome: { description: 'Explain the course.', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: [],
        materials: [
          {
            materialId: 'material-recovery',
            title: 'Recovery source',
            materialRoleAssignmentId: 'role-recovery',
            materialRoleAssignmentVersion: 1,
            role: 'course_material',
            disposition: 'included',
          },
        ],
        includedTopics: [],
        excludedTopics: [],
      },
      courseSourceMapFingerprint: 'course-source-map-recovery',
      sourceAllocationFingerprint: 'course-map-source-allocation-recovery',
      sourceRegions: [
        {
          sourceRegionRef: 'R1',
          sourceAllocationRegionId: 'source-region-1',
          materialId: 'material-recovery',
          materialTitle: 'Recovery source',
          title: 'Bounded relations',
          sectionCount: 1,
          blockCount: 1,
          charCount: 120,
          anchorOptions: [],
          evidence: [{ evidenceId: 'E1', text: 'A capped generic navigation excerpt.' }],
          authorityEnvelope: {
            sourceRegionId: 'source-region-1',
            sourceBlockIds: ['block-1'],
            formalEvidenceIds: ['E1'],
            supportedConstructs: ['identify', 'explain'],
            strongestSupportedConstruct: 'explain',
            narrowerClaim: null,
            tier: 'formal_sufficient',
            rationale: 'The exact source supports explanation.',
          },
        },
        {
          sourceRegionRef: 'R2',
          sourceAllocationRegionId: 'source-region-2',
          materialId: 'material-recovery',
          materialTitle: 'Recovery source',
          title: 'Integrated positioning',
          sectionCount: 1,
          blockCount: 1,
          charCount: 140,
          anchorOptions: [],
          evidence: [
            {
              evidenceId: 'E2',
              text: 'A second capped generic navigation excerpt.',
            },
          ],
        },
      ],
      capabilityRecovery: {
        evidenceOffers: [
          {
            recoveryEvidenceRef: 'CE1',
            sourceRegionRef: 'R1',
            text: `[SUPPORTS:explain] ${B7C2_INGESTION}`,
          },
          {
            recoveryEvidenceRef: 'CE2',
            sourceRegionRef: 'R2',
            text: B7C2_POSITIONING,
          },
        ],
        requirements,
      },
      limits: {
        maxModules: 1,
        maxRegions: 2,
        maxPrerequisiteEdges: 0,
        maxPrerequisiteDegree: 0,
        maxSynthesisGroups: 0,
      },
    };

    const payload = await provider.proposeCourseMap(input);
    expect(CourseMapProposalPayloadSchema.parse(payload)).toEqual(payload);
    const regions = payload.modules.flatMap((module) => module.regions);
    const emitted = regions.flatMap((region) =>
      (region.capabilityRequirementRefs ?? []).map((capabilityRef) => ({
        capabilityRef,
        sourceRegionRef: region.sourceRegionRef,
      })),
    );
    expect(emitted.map((row) => row.capabilityRef).sort()).toEqual(
      requirements.map((requirement) => requirement.capabilityRef).sort(),
    );
    expect(new Set(emitted.map((row) => row.capabilityRef)).size).toBe(requirements.length);
    for (const row of emitted) {
      const requirement = requirements.find(
        (candidate) => candidate.capabilityRef === row.capabilityRef,
      )!;
      expect(requirement.allowedSourceRegionRefs).toContain(row.sourceRegionRef);
    }
    expect(
      regions.find((region) => region.sourceRegionRef === 'R1')!.capabilityRequirementRefs,
    ).toHaveLength(4);
    expect(
      regions.find((region) => region.sourceRegionRef === 'R2')!.capabilityRequirementRefs,
    ).toEqual(['capability-marker']);
    expect(input.sourceRegions[1]!.evidence.map((offer) => offer.text)).not.toContain(
      B7C2_POSITIONING,
    );
    expect(input.capabilityRecovery.evidenceOffers[1]!.text).toBe(B7C2_POSITIONING);

    const unrelatedOnly = structuredClone(input);
    unrelatedOnly.capabilityRecovery = {
      evidenceOffers: [
        {
          recoveryEvidenceRef: 'CE-unrelated',
          sourceRegionRef: 'R1',
          text: 'Mitochondria produce ATP through cellular respiration.',
        },
      ],
      requirements: [
        {
          capabilityRef: 'capability-photosynthesis',
          title: 'Explain photosynthesis',
          description: 'Explain how photosynthesis converts light into stored chemical energy.',
          originalProposition:
            'Explain photosynthesis\nExplain how photosynthesis converts light into stored chemical energy.',
          construct: 'explain',
          priority: 'required',
          allowedSourceRegionRefs: ['R1'],
          allowedRecoveryEvidenceRefs: ['CE-unrelated'],
        },
      ],
    };
    await expect(provider.proposeCourseMap(unrelatedOnly)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('materializes exact recovery objectives from only allowed same-construct evidence', async () => {
    const input: CurriculumDetailProposalInput = {
      workspaceName: 'Recovery course',
      contract: {
        intent: 'Recover predecessor capabilities.',
        targetOutcome: { description: 'Explain the course.', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: [],
        includedTopics: [],
        excludedTopics: [],
      },
      courseMapId: `course_map_${'a'.repeat(24)}`,
      sourceAllocationFingerprint: `course_map_source_allocation_${'b'.repeat(40)}`,
      batchKey: 'recovery-batch-1',
      regions: [
        {
          regionId: `course_map_region_${'c'.repeat(24)}`,
          moduleId: 'module-recovery',
          moduleIndex: 0,
          moduleTitle: 'Recovery',
          regionIndex: 0,
          title: 'Integrated positioning',
          learningIntent: 'Explain the integrated positioning.',
          approximateScope: 'focused',
          sourceAllocationRegionIds: ['source-region-recovery'],
          prerequisiteRegionIds: [],
          synthesisGroups: [],
          concepts: [],
          canonicalConcepts: [],
          evidence: [
            {
              evidenceId: 'E-plain',
              sourceAllocationRegionId: 'source-region-recovery',
              text: 'A same-topic but weaker statement.',
            },
            {
              evidenceId: 'E-support',
              sourceAllocationRegionId: 'source-region-recovery',
              text: '[SUPPORTS:explain] The components jointly position the integrated system.',
            },
          ],
          capabilityRequirements: [
            {
              capabilityRef: 'capability-explain',
              title: 'Explain the integrated system',
              description: 'Explain how the components jointly position the system.',
              originalProposition:
                'Explain the integrated system\nExplain how the components jointly position the system.',
              construct: 'explain',
              priority: 'required',
              allowedEvidenceIds: ['E-plain', 'E-support'],
            },
          ],
        },
      ],
      limits: { maxUnits: 1, maxObjectivesPerUnit: 1, maxEvidenceSelectionsPerUnit: 2 },
    };

    const payload = await provider.proposeCurriculumDetails(input);
    expect(CurriculumDetailProposalPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload.units[0]!.objectives).toEqual([
      expect.objectContaining({
        title: 'Explain the integrated system',
        description: 'Explain how the components jointly position the system.',
        construct: 'explain',
        priority: 'required',
        capabilityRequirementRef: 'capability-explain',
        evidence: [{ evidenceId: 'E-support' }],
      }),
    ]);

    const noAllowedEvidence = structuredClone(input);
    noAllowedEvidence.regions[0]!.capabilityRequirements![0]!.allowedEvidenceIds = ['E-missing'];
    await expect(provider.proposeCurriculumDetails(noAllowedEvidence)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });

    const unrelatedAllowedEvidence = structuredClone(input);
    unrelatedAllowedEvidence.regions[0]!.capabilityRequirements![0]!.allowedEvidenceIds = [
      'E-plain',
    ];
    await expect(provider.proposeCurriculumDetails(unrelatedAllowedEvidence)).rejects.toMatchObject(
      {
        code: 'PROVIDER_INVALID_OUTPUT',
      },
    );

    const applicationInput = structuredClone(input);
    applicationInput.contract.targetOutcome.description =
      'Apply the source-stated procedure in a bounded decision.';
    applicationInput.limits.maxObjectivesPerUnit = 4;
    applicationInput.limits.maxEvidenceSelectionsPerUnit = 4;
    applicationInput.regions[0]!.evidence.push({
      evidenceId: 'E-apply',
      sourceAllocationRegionId: 'source-region-recovery',
      text: '[SUPPORTS:apply] Apply the bounded procedure by checking its stated condition.',
      authorityEnvelope: {
        sourceRegionId: 'source-region-recovery',
        sourceBlockIds: ['block-apply'],
        formalEvidenceIds: ['E-apply'],
        supportedConstructs: ['identify', 'explain', 'apply'],
        strongestSupportedConstruct: 'apply',
        narrowerClaim: null,
        tier: 'formal_sufficient',
        rationale: 'The exact source states a bounded procedure for application.',
      },
    });
    applicationInput.regions[0]!.capabilityRequirements = Array.from({ length: 3 }, (_, index) => ({
      capabilityRef: `capability-explain-${index + 1}`,
      title: `Explain bounded relation ${index + 1}`,
      description: `Explain how bounded relation ${index + 1} follows from the source.`,
      originalProposition: `Explain bounded relation ${index + 1}\nExplain how bounded relation ${index + 1} follows from the source.`,
      construct: 'explain' as const,
      priority: 'high' as const,
      allowedEvidenceIds: ['E-support'],
    }));

    const applicationPayload = await provider.proposeCurriculumDetails(applicationInput);
    expect(applicationPayload.units[0]!.objectives).toHaveLength(4);
    expect(
      applicationPayload.units[0]!.objectives.filter(
        (objective) => objective.capabilityRequirementRef,
      ).map((objective) => objective.capabilityRequirementRef),
    ).toEqual(['capability-explain-1', 'capability-explain-2', 'capability-explain-3']);
    expect(applicationPayload.units[0]!.objectives.at(-1)).toMatchObject({
      construct: 'apply',
      priority: 'required',
      evidence: [{ evidenceId: 'E-apply' }],
    });

    const applicationWithoutCapacity = structuredClone(applicationInput);
    applicationWithoutCapacity.limits.maxObjectivesPerUnit = 3;
    await expect(
      provider.proposeCurriculumDetails(applicationWithoutCapacity),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('selects the exact B7C2 positioning block instead of the earlier ingestion block', async () => {
    const input: CurriculumDetailProposalInput = {
      workspaceName: 'WeKnora recovery',
      contract: {
        intent: 'Recover the accepted WeKnora capability.',
        targetOutcome: { description: 'Explain WeKnora positioning.', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: [],
        includedTopics: [],
        excludedTopics: [],
      },
      courseMapId: `course_map_${'d'.repeat(24)}`,
      sourceAllocationFingerprint: `course_map_source_allocation_${'e'.repeat(40)}`,
      batchKey: 'b7c2-recovery-batch',
      regions: [
        {
          regionId: `course_map_region_${'f'.repeat(24)}`,
          moduleId: 'module-weknora',
          moduleIndex: 0,
          moduleTitle: 'WeKnora',
          regionIndex: 0,
          title: '系统定位与 RAG 全景',
          learningIntent: '解释 WeKnora 综合系统定位。',
          approximateScope: 'focused',
          sourceAllocationRegionIds: ['source-region-weknora'],
          prerequisiteRegionIds: [],
          synthesisGroups: [],
          concepts: [],
          canonicalConcepts: [],
          evidence: [
            {
              evidenceId: 'E-ingestion',
              sourceAllocationRegionId: 'source-region-weknora',
              text: B7C2_INGESTION,
              authorityEnvelope: {
                sourceRegionId: 'E-ingestion',
                sourceBlockIds: ['blk_3_87594204'],
                formalEvidenceIds: ['E-ingestion'],
                supportedConstructs: ['identify', 'explain'],
                strongestSupportedConstruct: 'explain',
                narrowerClaim: null,
                tier: 'formal_sufficient',
                rationale: 'Coarse exact-occurrence authority does not prove semantic support.',
              },
            },
            {
              evidenceId: 'E-positioning',
              sourceAllocationRegionId: 'source-region-weknora',
              text: B7C2_POSITIONING,
              authorityEnvelope: {
                sourceRegionId: 'E-positioning',
                sourceBlockIds: ['blk_1_706f25b9'],
                formalEvidenceIds: ['E-positioning'],
                supportedConstructs: ['identify', 'explain'],
                strongestSupportedConstruct: 'explain',
                narrowerClaim: null,
                tier: 'formal_sufficient',
                rationale: 'Exact positioning authority is available for independent evaluation.',
              },
            },
          ],
          capabilityRequirements: [
            {
              capabilityRef: 'recovery_capability_1',
              title: '解释 WeKnora 综合系统定位',
              description:
                '解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。',
              originalProposition: B7C2_POSITIONING_PROPOSITION,
              construct: 'explain',
              priority: 'required',
              allowedEvidenceIds: ['E-ingestion', 'E-positioning'],
            },
          ],
        },
      ],
      limits: { maxUnits: 1, maxObjectivesPerUnit: 1, maxEvidenceSelectionsPerUnit: 2 },
    };

    const payload = await provider.proposeCurriculumDetails(input);

    expect(payload.units[0]!.objectives[0]).toMatchObject({
      title: '解释 WeKnora 综合系统定位',
      construct: 'explain',
      capabilityRequirementRef: 'recovery_capability_1',
      evidence: [{ evidenceId: 'E-positioning' }],
    });
  });
});

const tutorInput: TutorTurnInput = {
  workspaceName: 'Fixture course',
  learnerMessage: '举个例子',
  session: {
    id: 'session_fixture',
    routeState: 'on_route',
    currentAgendaItemId: 'agenda_fixture',
    currentAgendaItem: {
      kind: 'teach_unit',
      reason: 'Explain the segment',
      learningUnitId: 'unit_fixture',
    },
  },
  summary: null,
  lessonContext: null,
  currentUnit: null,
  allowedMoves: ['GIVE_EXAMPLE', 'ANSWER_QUESTION', 'SELF_EXPLANATION'],
  recentMoves: [],
  formalCheckpointAvailable: false,
  offeredSourceRefs: [
    { referenceKey: 'S1', excerpt: 'A bounded source excerpt.', origin: 'lesson' },
  ],
  learnerState: {
    formalEvidence: [],
    openMistakes: [],
    misconceptions: [],
    reviews: [],
    mastery: [],
    riskIds: [],
  },
  recentExchanges: [],
};

const masteryRedTeamInput: MasteryChallengeProposalInput = {
  contractVersion: 'mastery-red-team-challenge-v1',
  selectedFamily: 'transfer',
  hypothesisBasis: ['direct_recall_only'],
  objectives: [
    {
      objectiveRef: 'O1',
      title: 'Explain the bounded claim',
      description: 'Explain and apply the claim from the supplied source.',
      primary: true,
    },
  ],
  sources: [{ sourceRef: 'S1', text: 'The claim holds only under the supplied condition.' }],
  priorPrompts: [{ promptRef: 'P1', prompt: 'State the source claim directly.' }],
  historicalSummaries: [],
  limits: {
    candidateCount: 3,
    maxPromptChars: 2_000,
    maxAnswerChars: 1_500,
    maxRubricCriteria: 8,
  },
};

async function fixtureConcepts(): Promise<Concept[]> {
  const analysis = await provider.analyzeConcepts({
    materialTitle: SAMPLE_MATERIAL_TITLE,
    blocks,
  });
  return analysis.concepts.map((c, i) => {
    const verification = verifyGrounding(blocks, { blockId: c.blockId, quote: c.quote });
    if (!verification.ok) throw new Error(`fixture grounding failed: ${verification.message}`);
    return {
      id: `con_${i}`,
      materialId,
      name: c.name,
      summary: c.summary,
      importance: c.importance,
      grounding: verification.grounding,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  });
}

describe('FakeProvider.analyzeConcepts', () => {
  it('produces schema-valid, grounded concepts from the sample material', async () => {
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(() => ConceptAnalysisPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.concepts.length).toBeGreaterThanOrEqual(3);

    // Every quote must verify against the actual source blocks.
    for (const concept of payload.concepts) {
      const verification = verifyGrounding(blocks, {
        blockId: concept.blockId,
        quote: concept.quote,
      });
      expect(verification.ok).toBe(true);
    }
  });

  it('is deterministic across runs', async () => {
    const a = await provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks });
    const b = await provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks });
    expect(a).toEqual(b);
  });

  it('uses section headings as concept names for the sample material', async () => {
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    const names = payload.concepts.map((c) => c.name);
    expect(names).toContain('记忆的三种类型');
    expect(names).toContain('间隔重复');
  });

  it('samples sections across the whole document when there are more than eight', async () => {
    // 14 single-paragraph sections: representative coverage must reach the
    // document tail instead of stopping after the first eight sections.
    const content = Array.from(
      { length: 14 },
      (_, i) => `## 第${i + 1}节标题\n\n第${i + 1}节的正文内容,用于覆盖度测试。`,
    ).join('\n\n');
    const manyBlocks = segmentMaterial('mat_many', content);
    const payload = await provider.analyzeConcepts({ materialTitle: '覆盖', blocks: manyBlocks });

    expect(payload.concepts.length).toBeLessThanOrEqual(8);
    const names = payload.concepts.map((c) => c.name);
    expect(names).toContain('第1节标题');
    expect(names).toContain('第14节标题');

    const again = await provider.analyzeConcepts({ materialTitle: '覆盖', blocks: manyBlocks });
    expect(again).toEqual(payload);
  });
});

describe('FakeProvider.generateQuiz', () => {
  it('produces schema-valid grounded questions for all requested types', async () => {
    const concepts = await fixtureConcepts();
    const payload = await provider.generateQuiz({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
      concepts,
      config: {
        difficulty: 'medium',
        types: ['single_choice', 'multiple_choice', 'short_answer'],
        countPerType: 2,
      },
    });
    expect(() => QuizGenerationPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.questions).toHaveLength(6);

    for (const q of payload.questions) {
      const verification = verifyGrounding(blocks, { blockId: q.blockId, quote: q.quote });
      expect(verification.ok).toBe(true);
      expect(concepts.some((c) => c.id === q.conceptId)).toBe(true);
    }

    const types = new Set(payload.questions.map((q) => q.type));
    expect(types).toEqual(new Set(['single_choice', 'multiple_choice', 'short_answer']));
  });

  it('is deterministic across runs', async () => {
    const concepts = await fixtureConcepts();
    const input = {
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
      concepts,
      config: {
        difficulty: 'hard' as const,
        types: ['single_choice' as const],
        countPerType: 3,
      },
    };
    expect(await provider.generateQuiz(input)).toEqual(await provider.generateQuiz(input));
  });
});

describe('FakeProvider.gradeShortAnswer', () => {
  const gradingInput = {
    stem: '请根据资料,简述「间隔重复」的要点。',
    expectedAnswer: '把复习分散到多次进行,安排在即将遗忘的临界点附近。',
    rubricKeyPoints: [
      { text: '复习应分散到多次进行', required: true },
      { text: '复习安排在即将遗忘的临界点附近', required: true },
    ],
    quote: '与其把复习集中在一次完成,不如把同样的时间分散到多次进行。',
  };

  it('gives full credit to an answer covering all key points', async () => {
    const grade = await provider.gradeShortAnswer({
      ...gradingInput,
      answerText: '间隔重复要求把复习分散到多次进行,并且每次安排在即将遗忘的临界点附近效果最好。',
    });
    expect(() => RubricGradeSchema.parse(grade)).not.toThrow();
    expect(grade.matchedKeyPointIndexes).toEqual([0, 1]);
    expect(grade.score).toBe(1);
  });

  it('gives low score to an empty/unrelated answer', async () => {
    const grade = await provider.gradeShortAnswer({ ...gradingInput, answerText: '不知道' });
    expect(grade.matchedKeyPointIndexes).toEqual([]);
    expect(grade.score).toBeLessThan(0.2);
    expect(grade.feedback).toContain('未覆盖');
  });

  it('is deterministic', async () => {
    const a = await provider.gradeShortAnswer({ ...gradingInput, answerText: '分散复习多次进行' });
    const b = await provider.gradeShortAnswer({ ...gradingInput, answerText: '分散复习多次进行' });
    expect(a).toEqual(b);
  });

  it('never reduces the score for missing OPTIONAL points', async () => {
    const grade = await provider.gradeShortAnswer({
      ...gradingInput,
      rubricKeyPoints: [
        ...gradingInput.rubricKeyPoints,
        { text: '间隔重复实施起来比较麻烦', required: false },
      ],
      answerText: '间隔重复要求把复习分散到多次进行,并且每次安排在即将遗忘的临界点附近效果最好。',
    });
    expect(grade.score).toBe(1);
    expect(grade.feedback).toContain('可补充');
    expect(grade.feedback).toContain('不影响得分');
  });

  it('awards partial credit for partially covered required points', async () => {
    const grade = await provider.gradeShortAnswer({
      ...gradingInput,
      answerText: '把复习分散到多次进行。',
    });
    expect(grade.matchedKeyPointIndexes).toEqual([0]);
    expect(grade.score).toBeLessThan(1);
    expect(grade.score).toBeGreaterThanOrEqual(0.5);
  });
});

describe('FakeProvider.generateRemediation', () => {
  it('targets the weak concepts and grounds every question', async () => {
    const concepts = await fixtureConcepts();
    const targets = concepts.slice(0, 2).map((concept) => ({
      concept,
      missedStems: [`关于「${concept.name}」,以下哪项表述与资料一致?`],
      openMistakeCount: 1,
    }));
    const payload = await provider.generateRemediation({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
      targets,
      questionsPerConcept: 2,
    });
    expect(() => QuizGenerationPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.questions).toHaveLength(4);
    const targetIds = new Set(targets.map((t) => t.concept.id));
    for (const q of payload.questions) {
      expect(targetIds.has(q.conceptId)).toBe(true);
      expect(q.stem).toContain('巩固练习');
      const verification = verifyGrounding(blocks, { blockId: q.blockId, quote: q.quote });
      expect(verification.ok).toBe(true);
    }
  });
});

describe('FakeProvider.proposeCurriculum', () => {
  function curriculumInputFor(
    sourceBlocks: SourceBlock[],
    outline: CurriculumProposalInput['outline'],
  ): CurriculumProposalInput {
    const revisionId = sourceBlocks[0]!.materialRevisionId!;
    return {
      workspaceName: 'Structural grouping course',
      contract: {
        contractVersionId: 'contract_grouping',
        intent: 'Preserve parser-authoritative regions.',
        targetOutcome: { description: 'Review every region.', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: [],
        materials: [
          {
            materialId: sourceBlocks[0]!.materialId,
            title: 'Grouping fixture',
            materialRoleAssignmentId: 'role_grouping',
            materialRoleAssignmentVersion: 1,
            role: 'course_material',
            disposition: 'included',
          },
        ],
        includedTopics: [],
        excludedTopics: [],
      },
      executionSourceManifest: {
        fingerprint: 'manifest_grouping',
        revisions: [
          {
            materialId: sourceBlocks[0]!.materialId,
            materialRevisionId: revisionId,
            parserVersion: 'test-parser',
            parserFingerprint: null,
            sourceBlockRevisionIds: sourceBlocks.map((block) => block.id),
          },
        ],
      },
      outline,
      concepts: [],
      graphEdges: [],
      allowedCanonicalConceptIds: [],
      canonicalConcepts: [],
      blocks: sourceBlocks,
      evidenceCatalog: sourceBlocks.map((block) => ({
        id: block.id,
        materialId: block.materialId,
        materialRevisionId: revisionId,
        blockId: block.id,
        startOffset: 0,
        endOffset: block.content.length,
        quote: block.content,
        headingPath: block.headingPath,
        pageNumber: block.pageNumber,
      })),
      limits: { maxNodes: 100, maxObjectives: 100, maxSynthesisGroups: 10 },
    };
  }

  function sourceBackedFixtureInput(): CurriculumProposalInput {
    const content = 'Evaporation, condensation, and precipitation form a repeating water cycle.';
    const sourceBlock: SourceBlock = {
      id: 'block_water_cycle_authority',
      materialId: 'material_water_cycle_authority',
      materialRevisionId: 'revision_water_cycle_authority',
      index: 0,
      heading: 'Water cycle',
      headingPath: ['Water cycle'],
      pageNumber: null,
      pageEnd: null,
      content,
      startOffset: 0,
      endOffset: content.length,
    };
    return curriculumInputFor(
      [sourceBlock],
      [
        {
          structuralUnitId: null,
          materialId: sourceBlock.materialId,
          materialRevisionId: sourceBlock.materialRevisionId!,
          parentStructuralUnitId: null,
          kind: 'section',
          index: 0,
          title: sourceBlock.heading,
          headingPath: sourceBlock.headingPath,
          sourceBlockIds: [sourceBlock.id],
        },
      ],
    );
  }

  it('places every direct recovery capability once and prefers matching support markers', async () => {
    const sourceContents = [
      'A same-topic statement without explicit construct support.',
      '[SUPPORTS:explain] The components jointly position the integrated system.',
      '[SUPPORTS:identify] The integrated system has a recognizable bounded definition.',
    ];
    const sourceBlocks: SourceBlock[] = sourceContents.map((content, index) => ({
      id: `block-recovery-${index + 1}`,
      materialId: 'material-recovery-direct',
      materialRevisionId: 'revision-recovery-direct',
      index,
      heading: 'Recovery topic',
      headingPath: ['Recovery topic'],
      pageNumber: null,
      pageEnd: null,
      content,
      startOffset: 0,
      endOffset: content.length,
    }));
    const input = curriculumInputFor(
      sourceBlocks,
      sourceBlocks.map((block) => ({
        structuralUnitId: null,
        materialId: block.materialId,
        materialRevisionId: block.materialRevisionId!,
        parentStructuralUnitId: null,
        kind: 'section' as const,
        index: block.index,
        title: block.heading,
        headingPath: block.headingPath,
        sourceBlockIds: [block.id],
      })),
    );
    input.capabilityRecovery = {
      requirements: [
        {
          capabilityRef: 'capability-explain',
          title: 'Explain the integrated system',
          description: 'Explain how the components jointly position the system.',
          originalProposition:
            'Explain the integrated system\nExplain how the components jointly position the system.',
          construct: 'explain',
          priority: 'required',
          allowedEvidenceIds: ['block-recovery-1', 'block-recovery-2'],
        },
        {
          capabilityRef: 'capability-identify',
          title: 'Identify the integrated system',
          description: 'Identify the source-stated integrated-system definition.',
          originalProposition:
            'Identify the integrated system\nIdentify the source-stated integrated-system definition.',
          construct: 'identify',
          priority: 'high',
          allowedEvidenceIds: ['block-recovery-1', 'block-recovery-3'],
        },
      ],
    };

    const payload = await provider.proposeCurriculum(input);
    expect(CurriculumProposalPayloadSchema.parse(payload)).toEqual(payload);
    const objectives = payload.nodes.flatMap((node) => node.objectives);
    expect(objectives.map((objective) => objective.capabilityRequirementRef)).toEqual([
      'capability-explain',
      'capability-identify',
    ]);
    expect(objectives[0]).toMatchObject({
      title: 'Explain the integrated system',
      description: 'Explain how the components jointly position the system.',
      construct: 'explain',
      priority: 'required',
      evidence: [{ evidenceId: 'block-recovery-2' }],
    });
    expect(objectives[1]).toMatchObject({
      title: 'Identify the integrated system',
      description: 'Identify the source-stated integrated-system definition.',
      construct: 'identify',
      priority: 'high',
      evidence: [{ evidenceId: 'block-recovery-3' }],
    });

    const unrelatedOnly = structuredClone(input);
    unrelatedOnly.capabilityRecovery = {
      requirements: [
        {
          ...input.capabilityRecovery.requirements[0]!,
          allowedEvidenceIds: ['block-recovery-1'],
        },
      ],
    };
    await expect(provider.proposeCurriculum(unrelatedOnly)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('keeps a second same-block recovery excerpt outside a full 100-entry unit summary', async () => {
    const navigation = 'Generic navigation excerpt.';
    const support =
      '[SUPPORTS:explain] The bounded components jointly position the integrated system.';
    const sourceBlocks: SourceBlock[] = Array.from({ length: 100 }, (_, index) => {
      const content = index === 0 ? `${navigation} ${support}` : `Exact source block ${index + 1}.`;
      return {
        id: `block-source-summary-boundary-${index + 1}`,
        materialId: 'material-source-summary-boundary',
        materialRevisionId: 'revision-source-summary-boundary',
        index,
        heading: 'One bounded source region',
        headingPath: ['One bounded source region'],
        pageNumber: null,
        pageEnd: null,
        content,
        startOffset: 0,
        endOffset: content.length,
      };
    });
    const input = curriculumInputFor(sourceBlocks, [
      {
        structuralUnitId: 'structural-source-summary-boundary',
        materialId: sourceBlocks[0]!.materialId,
        materialRevisionId: sourceBlocks[0]!.materialRevisionId!,
        parentStructuralUnitId: null,
        kind: 'section',
        index: 0,
        title: 'One bounded source region',
        headingPath: ['One bounded source region'],
        sourceBlockIds: sourceBlocks.map((block) => block.id),
      },
    ]);
    input.evidenceCatalog[0] = {
      ...input.evidenceCatalog[0]!,
      endOffset: navigation.length,
      quote: navigation,
    };
    const supportingEvidenceId = 'evidence-source-summary-boundary-support';
    input.evidenceCatalog.push({
      ...input.evidenceCatalog[0]!,
      id: supportingEvidenceId,
      startOffset: navigation.length + 1,
      endOffset: navigation.length + 1 + support.length,
      quote: support,
    });
    input.capabilityRecovery = {
      requirements: [
        {
          capabilityRef: 'capability-source-summary-boundary',
          title: 'Explain the integrated system',
          description: 'Explain how the bounded components jointly position the system.',
          originalProposition:
            'Explain the integrated system\nExplain how the bounded components jointly position the system.',
          construct: 'explain',
          priority: 'required',
          allowedEvidenceIds: [supportingEvidenceId],
        },
      ],
    };

    const payload = await provider.proposeCurriculum(input);
    expect(CurriculumProposalPayloadSchema.parse(payload)).toEqual(payload);
    const unit = payload.nodes.find((node) => node.kind === 'learning_unit')!;
    expect(unit.sourceEvidence).toHaveLength(100);
    expect(unit.sourceEvidence).not.toContainEqual({ evidenceId: supportingEvidenceId });
    expect(unit.objectives).toEqual([
      expect.objectContaining({
        capabilityRequirementRef: 'capability-source-summary-boundary',
        evidence: [{ evidenceId: supportingEvidenceId }],
      }),
    ]);
  });

  it('preserves a feasible legacy 30-slot placement when a flexible capability arrives first', async () => {
    const sourceBlocks: SourceBlock[] = ['R1', 'R2'].map((heading, index) => {
      const content = `[SUPPORTS:explain] Exact recovery evidence for ${heading}.`;
      return {
        id: `block-legacy-matching-${index + 1}`,
        materialId: 'material-legacy-matching',
        materialRevisionId: 'revision-legacy-matching',
        index,
        heading,
        headingPath: [heading],
        pageNumber: null,
        pageEnd: null,
        content,
        startOffset: 0,
        endOffset: content.length,
      };
    });
    const input = curriculumInputFor(
      sourceBlocks,
      sourceBlocks.map((block, index) => ({
        structuralUnitId: `structural-legacy-matching-${index + 1}`,
        materialId: block.materialId,
        materialRevisionId: block.materialRevisionId!,
        parentStructuralUnitId: null,
        kind: 'section' as const,
        index,
        title: block.heading,
        headingPath: block.headingPath,
        sourceBlockIds: [block.id],
      })),
    );
    input.capabilityRecovery = {
      requirements: [
        {
          capabilityRef: 'capability-flexible',
          title: 'Explain the flexible predecessor capability',
          description: 'Explain the complete flexible capability.',
          originalProposition:
            'Explain the flexible predecessor capability\nExplain the complete flexible capability.',
          construct: 'explain',
          priority: 'required',
          allowedEvidenceIds: sourceBlocks.map((block) => block.id),
        },
        ...Array.from({ length: 30 }, (_, index) => ({
          capabilityRef: `capability-r1-only-${index + 1}`,
          title: `Explain constrained predecessor capability ${index + 1}`,
          description: `Explain constrained capability ${index + 1} from R1.`,
          originalProposition: `Explain constrained predecessor capability ${index + 1}\nExplain constrained capability ${index + 1} from R1.`,
          construct: 'explain' as const,
          priority: 'high' as const,
          allowedEvidenceIds: [sourceBlocks[0]!.id],
        })),
      ],
    };

    const payload = await provider.proposeCurriculum(input);
    const placements = payload.nodes.flatMap((node) =>
      node.objectives.flatMap((objective) =>
        objective.capabilityRequirementRef ? [{ node, objective }] : [],
      ),
    );

    expect(placements).toHaveLength(31);
    expect(
      placements.find(
        ({ objective }) => objective.capabilityRequirementRef === 'capability-flexible',
      )?.objective.evidence,
    ).toEqual([{ evidenceId: sourceBlocks[1]!.id }]);
    expect(
      placements.filter(({ objective }) =>
        objective.capabilityRequirementRef?.startsWith('capability-r1-only-'),
      ),
    ).toHaveLength(30);
  });

  it('omits independent visual-only units from a mixed source-backed course', async () => {
    const sourceBackedInput = sourceBackedFixtureInput();
    const input: CurriculumProposalInput = {
      ...sourceBackedInput,
      contract: {
        ...sourceBackedInput.contract,
        materials: [
          ...sourceBackedInput.contract.materials,
          {
            materialId: 'material_water_cycle_visual',
            title: 'Advisory water-cycle diagram',
            materialRoleAssignmentId: 'role_water_cycle_visual',
            materialRoleAssignmentVersion: 1,
            role: 'course_material',
            disposition: 'included',
          },
        ],
      },
      executionSourceManifest: {
        ...sourceBackedInput.executionSourceManifest,
        revisions: [
          ...sourceBackedInput.executionSourceManifest.revisions,
          {
            materialId: 'material_water_cycle_visual',
            materialRevisionId: 'revision_water_cycle_visual',
            parserVersion: 'image-asset-v1',
            parserFingerprint: null,
            sourceBlockRevisionIds: [],
          },
        ],
      },
    };

    const payload = await provider.proposeCurriculum(input);
    const units = payload.nodes.filter((node) => node.kind === 'learning_unit');
    const sections = payload.nodes.filter((node) => node.kind === 'section');

    expect(units).toHaveLength(1);
    expect(sections.map((section) => section.title)).not.toContain('Advisory water-cycle diagram');
    expect(
      units.every(
        (unit) =>
          unit.sourceEvidence.length > 0 &&
          unit.objectives.every((objective) => objective.evidence.length > 0),
      ),
    ).toBe(true);
    expect(
      units.flatMap((unit) => unit.sourceEvidence.map((evidence) => evidence.evidenceId)),
    ).toEqual(['block_water_cycle_authority']);
  });

  it('fails before emitting a candidate for a pure visual-only course', async () => {
    const sourceBackedInput = sourceBackedFixtureInput();
    const input: CurriculumProposalInput = {
      ...sourceBackedInput,
      contract: {
        ...sourceBackedInput.contract,
        materials: [
          {
            materialId: 'material_visual_only',
            title: 'Advisory visual only',
            materialRoleAssignmentId: 'role_visual_only',
            materialRoleAssignmentVersion: 1,
            role: 'course_material',
            disposition: 'included',
          },
        ],
      },
      executionSourceManifest: {
        fingerprint: 'manifest_visual_only',
        revisions: [
          {
            materialId: 'material_visual_only',
            materialRevisionId: 'revision_visual_only',
            parserVersion: 'image-asset-v1',
            parserFingerprint: null,
            sourceBlockRevisionIds: [],
          },
        ],
      },
      outline: [],
      concepts: [],
      graphEdges: [],
      allowedCanonicalConceptIds: [],
      canonicalConcepts: [],
      blocks: [],
      evidenceCatalog: [],
    };
    let validationCalls = 0;

    await expect(
      provider.proposeCurriculum(input, {
        validateCandidate: () => {
          validationCalls += 1;
          return { valid: true, diagnostics: [] };
        },
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          kind: 'curriculum_objective_authority_unavailable',
          diagnostics: [
            {
              code: 'visual_only_material_cannot_originate_objective',
              message: expect.stringContaining('advisory visual-only Materials'),
            },
          ],
        },
      },
    });
    expect(validationCalls).toBe(0);
  });

  it('turns a 277-block headed document into source-complete pedagogical units', async () => {
    const topicSizes = [
      1, 5, 5, 5, 8, 8, 14, 9, 1, 12, 11, 37, 25, 10, 8, 4, 16, 14, 24, 14, 21, 19, 6,
    ];
    const largeBlocks: SourceBlock[] = [];
    const outline: CurriculumProposalInput['outline'] = [];
    const concepts: Concept[] = [];
    let offset = 0;
    for (const [topicIndex, size] of topicSizes.entries()) {
      const title = `Topic ${topicIndex + 1}`;
      for (let localIndex = 0; localIndex < size; localIndex += 1) {
        const index = largeBlocks.length;
        const content = `${title} source fragment ${localIndex + 1}.`;
        const block: SourceBlock = {
          id: `block_${index + 1}`,
          materialId: 'material_large',
          materialRevisionId: 'revision_large',
          index,
          heading: title,
          headingPath: [title],
          pageNumber: null,
          pageEnd: null,
          content,
          startOffset: offset,
          endOffset: offset + content.length,
        };
        offset += content.length + 1;
        largeBlocks.push(block);
        outline.push({
          structuralUnitId: null,
          materialId: block.materialId,
          materialRevisionId: 'revision_large',
          parentStructuralUnitId: null,
          kind: 'section',
          index,
          title,
          headingPath: [title],
          sourceBlockIds: [block.id],
        });
      }
      if (topicIndex === 1) continue;
      const groundingBlock = largeBlocks.at(-size)!;
      concepts.push({
        id: `concept_${topicIndex + 1}`,
        materialId: 'material_large',
        materialRevisionId: 'revision_large',
        name: title,
        summary: `${title} summary`,
        importance: 'medium',
        grounding: {
          blockId: groundingBlock.id,
          quote: groundingBlock.content,
          startOffset: 0,
          endOffset: groundingBlock.content.length,
          occurrenceCount: 1,
          reanchored: false,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const input: CurriculumProposalInput = {
      workspaceName: 'Large grounded course',
      contract: {
        contractVersionId: 'contract_large',
        intent: 'Learn the complete course.',
        targetOutcome: { description: 'Explain every topic.', targetScore: null },
        desiredDepth: 'working_fluency',
        subjectBoundaries: ['Course'],
        materials: [
          {
            materialId: 'material_large',
            title: 'Large material',
            materialRoleAssignmentId: 'role_large',
            materialRoleAssignmentVersion: 1,
            role: 'course_material',
            disposition: 'included',
          },
        ],
        includedTopics: [],
        excludedTopics: [],
      },
      executionSourceManifest: {
        fingerprint: 'manifest_large',
        revisions: [
          {
            materialId: 'material_large',
            materialRevisionId: 'revision_large',
            parserVersion: 'pdf-layout-v2',
            parserFingerprint: 'parser_large',
            sourceBlockRevisionIds: largeBlocks.map((block) => block.id),
          },
        ],
      },
      outline,
      concepts,
      graphEdges: [],
      allowedCanonicalConceptIds: [],
      canonicalConcepts: [],
      blocks: largeBlocks,
      evidenceCatalog: largeBlocks.map((block) => ({
        id: block.id,
        materialId: block.materialId,
        materialRevisionId: 'revision_large',
        blockId: block.id,
        startOffset: 0,
        endOffset: block.content.length,
        quote: block.content,
        headingPath: block.headingPath,
        pageNumber: block.pageNumber,
      })),
      limits: { maxNodes: 1999, maxObjectives: 30_000, maxSynthesisGroups: 200 },
    };

    const payload = await provider.proposeCurriculum(input);
    expect(() => CurriculumProposalPayloadSchema.parse(payload)).not.toThrow();
    const units = payload.nodes.filter((node) => node.kind === 'learning_unit');
    expect(units).toHaveLength(topicSizes.length);
    expect(new Set(units.map((unit) => unit.title))).toHaveLength(units.length);
    expect(units.filter((unit) => unit.conceptIds.length > 0)).toHaveLength(concepts.length);
    expect(units.reduce((count, unit) => count + unit.sourceEvidence.length, 0)).toBe(277);
    expect(units.every((unit) => unit.objectives[0]!.evidence.length <= 5)).toBe(true);
  });

  it('keeps identical section names separate under different chapter paths', async () => {
    const sourceBlocks: SourceBlock[] = [
      {
        id: 'block_chapter_a',
        materialId: 'material_grouping',
        materialRevisionId: 'revision_grouping',
        index: 0,
        heading: '小结',
        headingPath: ['Chapter A', '小结'],
        pageNumber: null,
        pageEnd: null,
        content: 'Chapter A summary evidence.',
        startOffset: 0,
        endOffset: 27,
      },
      {
        id: 'block_chapter_b',
        materialId: 'material_grouping',
        materialRevisionId: 'revision_grouping',
        index: 1,
        heading: '小结',
        headingPath: ['Chapter B', '小结'],
        pageNumber: null,
        pageEnd: null,
        content: 'Chapter B summary evidence.',
        startOffset: 28,
        endOffset: 55,
      },
    ];
    const outline = sourceBlocks.map((block) => ({
      structuralUnitId: null,
      materialId: block.materialId,
      materialRevisionId: block.materialRevisionId!,
      parentStructuralUnitId: null,
      kind: 'section' as const,
      index: block.index,
      title: block.heading,
      headingPath: block.headingPath,
      sourceBlockIds: [block.id],
    }));

    const proposal = await provider.proposeCurriculum(curriculumInputFor(sourceBlocks, outline));
    const units = proposal.nodes.filter((node) => node.kind === 'learning_unit');

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.sourceEvidence.map((evidence) => evidence.evidenceId))).toEqual(
      [['block_chapter_a'], ['block_chapter_b']],
    );
  });

  it('does not collapse consecutive headingless SourceBlock regions', async () => {
    const sourceBlocks: SourceBlock[] = Array.from({ length: 4 }, (_, index) => ({
      id: `block_headingless_${index + 1}`,
      materialId: 'material_grouping',
      materialRevisionId: 'revision_grouping',
      index,
      heading: null,
      headingPath: [],
      pageNumber: null,
      pageEnd: null,
      content: `Independent headingless region ${index + 1}.`,
      startOffset: index * 40,
      endOffset: index * 40 + 33,
    }));
    const outline = sourceBlocks.map((block) => ({
      structuralUnitId: null,
      materialId: block.materialId,
      materialRevisionId: block.materialRevisionId!,
      parentStructuralUnitId: null,
      kind: 'paragraph' as const,
      index: block.index,
      title: null,
      headingPath: [],
      sourceBlockIds: [block.id],
    }));

    const proposal = await provider.proposeCurriculum(curriculumInputFor(sourceBlocks, outline));
    const units = proposal.nodes.filter((node) => node.kind === 'learning_unit');

    expect(units).toHaveLength(sourceBlocks.length);
    expect(
      units.flatMap((unit) => unit.sourceEvidence.map((evidence) => evidence.evidenceId)),
    ).toEqual(sourceBlocks.map((block) => block.id));
  });
});

describe('FakeProvider cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.analyzeConcepts(
        { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('rejects mid-delay when aborted', async () => {
    const slow = new FakeProvider({ delayMs: 5_000 });
    const controller = new AbortController();
    const pending = slow.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('FakeProvider Tutor contract fixtures', () => {
  it.each([
    'invalid_source_ref',
    'unsupported_move',
    'malformed_json',
    'semantic_invalid',
    'repair_once',
  ] as FakeTutorTurnFixture[])('exercises one bounded repair for %s', async (fixture) => {
    let repairs = 0;
    const payload = await new FakeProvider({ tutorTurnFixture: fixture }).respondToTutorTurn(
      tutorInput,
      {
        validateCandidate: (candidate) => {
          const parsed = TutorTurnPayloadSchema.safeParse(candidate);
          if (!parsed.success) return { valid: false, diagnostics: ['schema'] };
          return validateTutorTurnCandidate(parsed.data, tutorInput);
        },
        onRepairAttempt: () => {
          repairs += 1;
        },
      },
    );
    expect(TutorTurnPayloadSchema.parse(payload).move).toBe('GIVE_EXAMPLE');
    expect(repairs).toBe(1);
  });

  it('fails closed when a Tutor repair remains invalid', async () => {
    await expect(
      new FakeProvider({ tutorTurnFixture: 'repair_exhausted' }).respondToTutorTurn(tutorInput, {
        validateCandidate: (candidate) => {
          const parsed = TutorTurnPayloadSchema.safeParse(candidate);
          if (!parsed.success) return { valid: false, diagnostics: ['schema'] };
          return validateTutorTurnCandidate(parsed.data, tutorInput);
        },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });
});

describe('FakeProvider Mastery Red Team contract fixtures', () => {
  it('returns a schema-valid bounded candidate pool by default', async () => {
    const payload = await provider.proposeMasteryChallenges(masteryRedTeamInput);

    expect(MasteryChallengeProposalPayloadSchema.parse(payload).candidates).toHaveLength(3);
    expect(payload.candidates.every((candidate) => candidate.family === 'transfer')).toBe(true);
    expect(payload.candidates.every((candidate) => candidate.sourceRefs.includes('S1'))).toBe(true);
  });

  it.each([
    [
      'duplicate_candidates',
      (payload) => new Set(payload.candidates.map((item) => item.prompt)).size === 1,
    ],
    [
      'unsupported_source',
      (payload) => payload.candidates.every((item) => item.sourceRefs.includes('S99')),
    ],
    [
      'unfair_unanswerable',
      (payload) => payload.candidates.every((item) => item.requiresExternalKnowledge),
    ],
    [
      'trivial_candidate',
      (payload) => payload.candidates.every((item) => item.prompt === 'What is it?'),
    ],
  ] as Array<
    [
      FakeMasteryRedTeamFixture,
      (payload: ReturnType<typeof MasteryChallengeProposalPayloadSchema.parse>) => boolean,
    ]
  >)('emits the deterministic %s fault', async (fixture, assertion) => {
    const payload = await new FakeProvider({
      masteryRedTeamFixture: fixture,
    }).proposeMasteryChallenges(masteryRedTeamInput);

    expect(() => MasteryChallengeProposalPayloadSchema.parse(payload)).not.toThrow();
    expect(assertion(payload)).toBe(true);
  });

  it('performs one bounded semantic repair and returns the repaired pool', async () => {
    let repairs = 0;
    const payload = await new FakeProvider({
      masteryRedTeamFixture: 'candidate_repair_once',
    }).proposeMasteryChallenges(masteryRedTeamInput, {
      validateCandidate: (candidate) => {
        const parsed = MasteryChallengeProposalPayloadSchema.safeParse(candidate);
        return {
          valid:
            parsed.success &&
            parsed.data.candidates.every((item) => !item.requiresExternalKnowledge),
          diagnostics: parsed.success ? ['external knowledge'] : ['schema'],
        };
      },
      onRepairAttempt: () => {
        repairs += 1;
      },
    });

    expect(repairs).toBe(1);
    expect(payload.candidates.every((candidate) => !candidate.requiresExternalKnowledge)).toBe(
      true,
    );
  });

  it.each(['schema_failure', 'candidate_repair_failure'] as const)(
    'fails closed after the bounded %s path',
    async (fixture) => {
      let repairs = 0;
      await expect(
        new FakeProvider({ masteryRedTeamFixture: fixture }).proposeMasteryChallenges(
          masteryRedTeamInput,
          {
            validateCandidate: (candidate) => {
              const parsed = MasteryChallengeProposalPayloadSchema.safeParse(candidate);
              return {
                valid:
                  parsed.success &&
                  parsed.data.candidates.every((item) => !item.requiresExternalKnowledge),
                diagnostics: parsed.success ? ['external knowledge'] : ['schema'],
              };
            },
            onRepairAttempt: () => {
              repairs += 1;
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
      expect(repairs).toBe(1);
    },
  );
});
