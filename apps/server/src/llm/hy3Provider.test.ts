import { describe, expect, it, vi } from 'vitest';
import {
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  SAMPLE_MATERIAL_TITLE,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticRepairInput,
  type SourceBlock,
} from '@hy3-clinic/shared';
import {
  Hy3Provider,
  OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS,
} from './hy3Provider.js';
import { ProviderError } from './errors.js';
import type {
  AssessmentProposalInput,
  CurriculumProposalInput,
  RepairGenerationInput,
  StructuredOutputDiagnostic,
  StudyPlanProposalInput,
  VisualDescriptionInput,
} from './provider.js';
import { makeConcept, makeGrounding } from '../testing/fixtures.js';
import {
  groupedStudyPlanProposalMessages,
  OBJECTIVE_AUTHORITY_SEMANTIC_CLOSED_KEY_RULES,
  OBJECTIVE_AUTHORITY_SEMANTIC_VOCABULARY_RULES,
} from './prompts.js';
import { validateObjectiveAuthoritySemanticEvaluationProposal } from '../services/objectiveAuthoritySemanticSupport.js';

const blocks: SourceBlock[] = [
  {
    id: 'blk_0',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆',
    headingPath: ['记忆'],
    content: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
  },
];

const assessmentInput: AssessmentProposalInput = {
  workspaceName: 'Memory course',
  mode: 'concept_practice',
  targets: [
    {
      concept: makeConcept({
        id: 'con_0',
        materialId: 'mat_1',
        grounding: makeGrounding({
          blockId: 'blk_0',
          quote: blocks[0]!.content,
          startOffset: 0,
          endOffset: blocks[0]!.content.length,
          occurrenceCount: 1,
        }),
      }),
      documentTitle: 'Memory notes',
      alignedSiblings: [],
      mastery: null,
      openMistakes: 0,
    },
  ],
  blocks,
  allowedTypes: ['single_choice'],
  questionCount: 1,
  requiredRepresentation: null,
  requestedChallengeFamily: null,
  misconception: null,
};

const genericAssessmentProposal = {
  items: [
    {
      blueprint: {
        conceptIds: ['con_0'],
        questionType: 'single_choice',
        difficulty: 'medium',
        learningObjective: 'Identify the source-stated capacity limit.',
        reasoningSteps: [{ description: 'Read the exact source.', evidenceIndexes: [0] }],
      },
      question: {
        type: 'single_choice',
        stem: 'What does the source state about working-memory capacity?',
        options: [
          { id: 'A', text: 'It is limited.' },
          { id: 'B', text: 'It is unlimited.' },
        ],
        correctOptionIds: ['A'],
        conceptId: 'con_0',
        blockId: 'blk_0',
        quote: blocks[0]!.content,
        explanation: 'The exact source states that capacity is limited.',
      },
      extraEvidence: [],
    },
  ],
};

function jsonResponse(content: string, usage?: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl: typeof fetch, timeoutMs = 30_000): Hy3Provider {
  return new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-should-never-leak',
    model: 'test-model',
    timeoutMs,
    fetchImpl,
  });
}

const visualInput: VisualDescriptionInput = {
  image: {
    dataBase64: 'iVBORw0KGgo=',
    mediaType: 'image/png',
    width: 1,
    height: 1,
    byteLength: 8,
  },
  limits: {
    maxDescriptionChars: 1200,
    maxVisibleTextChars: 2000,
    maxConcepts: 12,
    maxPedagogicalNotes: 6,
    maxUncertaintyItems: 6,
  },
};

const semanticEvaluationInput: ObjectiveAuthoritySemanticEvaluationInput = {
  schemaVersion: 2,
  policyVersion: 'objective-authority-semantic-support-v2',
  objectives: [
    {
      objectiveRef: 'O1',
      proposition: 'Explain how the components jointly position the system.',
      construct: 'explain',
      candidates: [
        {
          evidenceRef: 'E1',
          text: 'The system combines documents, search, language models, permissions, and tools.',
          claimKinds: ['claim'],
          headingPath: ['Positioning'],
        },
      ],
    },
  ],
};

const semanticEvaluationProposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse({
  schemaVersion: 2,
  evaluations: [
    {
      objectiveRef: 'O1',
      subjectDependency: 'source_specific_required',
      subjectDependencyRationale:
        'The objective asserts how the source-specific system components jointly position it.',
      candidateLabels: [{ evidenceRef: 'E1', relation: 'relevant' }],
      supportGroups: [
        {
          evidenceRefs: ['E1'],
          supportType: 'positioning',
          rationale: 'The exact offered claim states the integrated positioning.',
        },
      ],
    },
  ],
});

const multiSemanticEvaluationInput: ObjectiveAuthoritySemanticEvaluationInput = {
  ...semanticEvaluationInput,
  objectives: Array.from({ length: 3 }, (_, index) => ({
    ...semanticEvaluationInput.objectives[0]!,
    objectiveRef: `objective_${index + 1}`,
    candidates: [
      {
        ...semanticEvaluationInput.objectives[0]!.candidates[0]!,
        evidenceRef: `evidence_${index + 1}`,
      },
    ],
  })),
};

const multiSemanticEvaluationProposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse({
  schemaVersion: 2,
  evaluations: multiSemanticEvaluationInput.objectives.map((objective) => ({
    ...semanticEvaluationProposal.evaluations[0]!,
    objectiveRef: objective.objectiveRef,
    candidateLabels: [
      {
        evidenceRef: objective.candidates[0]!.evidenceRef,
        relation: 'relevant' as const,
      },
    ],
    supportGroups: [
      {
        evidenceRefs: [objective.candidates[0]!.evidenceRef],
        supportType: 'positioning' as const,
      },
    ],
  })),
});

const semanticRepairInput: ObjectiveAuthoritySemanticRepairInput = {
  schemaVersion: 1,
  policyVersion: 'objective-authority-semantic-v1',
  objectives: [
    {
      objectiveRef: 'O1',
      title: 'Explain the system positioning',
      description: semanticEvaluationInput.objectives[0]!.proposition,
      subjectClass: 'source_specific',
      scopeOrigin: 'anchored',
      construct: 'explain',
      priority: 'required',
      currentEvidenceRefs: ['E1'],
      allowedEvidence: [
        {
          ...semanticEvaluationInput.objectives[0]!.candidates[0]!,
          selected: true,
        },
      ],
      fragments: [
        {
          fragmentId: 'F1',
          text: semanticEvaluationInput.objectives[0]!.proposition,
          status: 'unsupported',
          supportType: null,
          evidenceRefs: [],
          rationale: 'The current wording overstates the exact offered claim.',
        },
      ],
      unsupportedFragmentIds: ['F1'],
      conflicts: [],
      overreach: [],
      verdict: 'fail',
      rationale: 'A bounded same-construct repair is required.',
    },
  ],
};

const semanticRepairProposal = ObjectiveAuthoritySemanticRepairProposalSchema.parse({
  schemaVersion: 1,
  replacements: [
    {
      objectiveRef: 'O1',
      title: 'Explain the integrated system positioning',
      description:
        'Explain how documents, search, language models, permissions, and tools combine.',
      subjectClass: 'source_specific',
      scopeOrigin: 'anchored',
      construct: 'explain',
      evidenceRefs: ['E1'],
    },
  ],
});

const curriculumProposalCandidate = (capabilityRequirementRef?: string) => ({
  nodes: [
    {
      key: 'chapter-1',
      parentKey: null,
      kind: 'chapter',
      index: 0,
      title: 'Chapter',
      structuralUnitIds: [],
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
      title: 'Section',
      structuralUnitIds: [],
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
      title: 'Unit',
      structuralUnitIds: [],
      sourceEvidence: [{ evidenceId: 'E1' }],
      conceptIds: [],
      canonicalConceptIds: [],
      objectives: [
        {
          key: 'objective-1',
          title: 'Objective one',
          description: 'Explain one thing.',
          subjectClass: 'source_specific',
          scopeOrigin: 'anchored',
          construct: 'explain',
          evidence: [{ evidenceId: 'E1' }],
          ...(capabilityRequirementRef ? { capabilityRequirementRef } : {}),
        },
        ...(capabilityRequirementRef
          ? [
              {
                key: 'objective-2',
                title: 'Objective two',
                description: 'Explain another thing.',
                subjectClass: 'source_specific' as const,
                scopeOrigin: 'anchored' as const,
                construct: 'explain' as const,
                evidence: [{ evidenceId: 'E1' }],
                capabilityRequirementRef,
              },
            ]
          : []),
      ],
      prerequisiteUnitKeys: [],
      graphRelationIds: [],
    },
  ],
  synthesisGroups: [],
});

function curriculumProviderInput(withRecovery: boolean): CurriculumProposalInput {
  return {
    workspaceName: 'Workspace',
    contract: {
      intent: 'Learn',
      targetOutcome: { description: 'Understand the subject.' },
      desiredDepth: 'standard',
      subjectBoundaries: [],
      includedTopics: [],
      excludedTopics: [],
      materials: [],
    },
    executionSourceManifest: { fingerprint: 'manifest', revisions: [] },
    outline: [],
    concepts: [],
    graphEdges: [],
    allowedCanonicalConceptIds: [],
    canonicalConcepts: [],
    predecessor: null,
    ...(withRecovery
      ? {
          capabilityRecovery: {
            requirements: [
              {
                capabilityRef: 'recovery-capability-42',
                title: 'Recover the original capability',
                description: 'Explain the original capability exactly.',
                originalProposition: 'Explain the original capability exactly.',
                construct: 'explain',
                priority: 'required',
                allowedEvidenceIds: ['E1'],
              },
            ],
          },
        }
      : {}),
    blocks: [],
    evidenceCatalog: [],
    limits: { maxNodes: 4, maxObjectives: 4, maxSynthesisGroups: 4 },
  } as unknown as CurriculumProposalInput;
}

describe('Hy3Provider objective-authority semantic methods', () => {
  it('parses strict evaluation/repair payloads and reports fixed schema fingerprints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(semanticEvaluationProposal)))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify(semanticRepairProposal)),
      ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const schemaNames: string[] = [];

    await expect(
      provider.evaluateObjectiveAuthoritySupport(semanticEvaluationInput, {
        onStructuredOutputDiagnostic: (diagnostic) => schemaNames.push(diagnostic.schemaName),
      }),
    ).resolves.toEqual(semanticEvaluationProposal);
    await expect(
      provider.repairObjectiveAuthoritySupport(semanticRepairInput, {
        onStructuredOutputDiagnostic: (diagnostic) => schemaNames.push(diagnostic.schemaName),
      }),
    ).resolves.toEqual(semanticRepairProposal);
    expect(schemaNames).toEqual([
      'objective-authority-semantic-evaluation-v4',
      'objective-authority-semantic-repair-v2-claim-scope',
    ]);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(String(calls[0]![1]!.body)) as { max_tokens: number }).toMatchObject({
      max_tokens: OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS,
    });
    expect(JSON.parse(String(calls[1]![1]!.body)) as { max_tokens: number }).toMatchObject({
      max_tokens: 8_000,
    });
  });

  it('uses one bounded schema repair for malformed evaluator output', async () => {
    const malformed = {
      ...semanticEvaluationProposal,
      evaluations: [
        {
          ...semanticEvaluationProposal.evaluations[0]!,
          modelGrantedAuthority: true,
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(malformed)))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify(semanticEvaluationProposal)),
      ) as unknown as typeof fetch;
    const onRepairAttempt = vi.fn();

    await expect(
      makeProvider(fetchImpl).evaluateObjectiveAuthoritySupport(semanticEvaluationInput, {
        onRepairAttempt,
      }),
    ).resolves.toEqual(semanticEvaluationProposal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRepairAttempt).toHaveBeenCalledExactlyOnceWith('schema', 'SCHEMA_VALIDATION_FAILURE');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(repairBody.messages.at(-1)!.content).toContain(
      OBJECTIVE_AUTHORITY_SEMANTIC_VOCABULARY_RULES,
    );
    expect(JSON.parse(String(calls[0]![1]!.body)) as { max_tokens: number }).toMatchObject({
      max_tokens: OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS,
    });
    expect(JSON.parse(String(calls[1]![1]!.body)) as { max_tokens: number }).toMatchObject({
      max_tokens: OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS,
    });
  });

  it('freezes valid evaluation peers and repairs only locally invalid objective identities', async () => {
    const firstPass = structuredClone(multiSemanticEvaluationProposal);
    firstPass.evaluations[1]!.candidateLabels = [];
    const providerRepair = structuredClone(multiSemanticEvaluationProposal);
    providerRepair.evaluations[0]!.subjectDependencyRationale =
      'Provider attempted to rewrite a passing peer.';
    providerRepair.evaluations[2]!.subjectDependencyRationale =
      'Provider attempted to rewrite another peer.';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(firstPass)))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify(providerRepair)),
      ) as unknown as typeof fetch;
    const validateCandidate = (candidate: unknown) =>
      validateObjectiveAuthoritySemanticEvaluationProposal(multiSemanticEvaluationInput, candidate);

    const result = await makeProvider(fetchImpl).evaluateObjectiveAuthoritySupport(
      multiSemanticEvaluationInput,
      { validateCandidate },
    );

    expect(result).toEqual(multiSemanticEvaluationProposal);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(repairBody.messages.at(-1)!.content).toContain(
      'Only these stable item identities may change: objective_2.',
    );
    expect(result.evaluations[0]).toEqual(multiSemanticEvaluationProposal.evaluations[0]);
    expect(result.evaluations[2]).toEqual(multiSemanticEvaluationProposal.evaluations[2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves already-aborted evaluation and repair without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.evaluateObjectiveAuthoritySupport(semanticEvaluationInput, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await expect(
      provider.repairObjectiveAuthoritySupport(semanticRepairInput, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Hy3Provider Curriculum capability contract', () => {
  it('drops unsolicited recovery aliases from a fresh Curriculum before strict parsing', async () => {
    const candidate = curriculumProposalCandidate('capability-1');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(JSON.stringify(candidate))) as unknown as typeof fetch;

    const result = await makeProvider(fetchImpl).proposeCurriculum(curriculumProviderInput(false));

    expect(result.nodes.flatMap((node) => node.objectives)).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ capabilityRequirementRef: 'capability-1' }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery alias strictness when a real recovery frontier is offered', async () => {
    const candidate = curriculumProposalCandidate('recovery-capability-42');
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(JSON.stringify(candidate))),
      ) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl).proposeCurriculum(curriculumProviderInput(true)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Hy3Provider visual transport boundary', () => {
  it('fails closed without fetching when image transport is not configured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).describeVisual(visualInput)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'PROVIDER_FORMAT_INCOMPATIBILITY',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prioritizes an already-aborted visual request without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeProvider(fetchImpl).describeVisual(visualInput, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function largeStudyPlanInput(): StudyPlanProposalInput {
  const units = Array.from({ length: 80 }, (_, index) => ({
    id: `unit_${index + 1}`,
    title: `Unit ${index + 1}`,
    objectiveIds: [`objective_${index + 1}`],
    objectiveSummaries: [
      {
        id: `objective_${index + 1}`,
        title: `Objective ${index + 1}`,
        description: `PRIVATE_VERBOSE_OBJECTIVE_${index + 1}`,
      },
    ],
    prerequisiteUnitIds: index === 0 ? [] : [`unit_${index}`],
    blockingEligibleObjectiveIds: [],
    synthesisGroupIds: [],
  }));
  return {
    workspaceName: 'Large course',
    contract: {
      contractVersionId: 'contract_1',
      intent: 'Learn the course.',
      targetOutcome: { description: 'Working fluency', targetScore: null },
      deadline: null,
      studyBudget: {
        minutesPerDay: 60,
        minutesPerWeek: null,
        preferredSessionMinutes: 30,
      },
      desiredDepth: 'working_fluency',
      subjectBoundaries: [],
      materials: [],
      includedTopics: [],
      excludedTopics: [],
      allowExplicitDeferral: false,
    },
    curriculumVersionId: 'curriculum_1',
    executionSourceManifestFingerprint: 'manifest_1',
    units,
    synthesisGroups: [],
    learnerState: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      state: 'unassessed',
      observedMinutes: null,
      openMistakes: 0,
    })),
    requiredLearningUnitIds: units.map((unit) => unit.id),
    allowedItemKinds: ['teach_unit'],
    allowedDepths: ['working_fluency'],
    launchCapabilities: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      allowedItemKinds: ['teach_unit'],
      launchableAssessmentModes: [],
    })),
    feasibility: {
      projectedMinutes: 0,
      availableMinutes: null,
      slackMinutes: null,
      state: 'unknown',
      assumptions: [],
    },
  };
}

function detailedStudyPlanInput(): StudyPlanProposalInput {
  const large = largeStudyPlanInput();
  const units = large.units.slice(0, 2);
  return {
    ...large,
    workspaceName: 'Detailed course',
    units,
    learnerState: large.learnerState.slice(0, 2),
    requiredLearningUnitIds: units.map((unit) => unit.id),
    launchCapabilities: units.map((unit) => ({
      curriculumLearningUnitId: unit.id,
      allowedItemKinds: ['teach_unit'],
      launchableAssessmentModes: [],
    })),
  };
}

function validDetailedProposal() {
  return {
    rationale: 'Teach both required units in prerequisite order.',
    items: [
      {
        key: 'item-1',
        phase: 'Core route',
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
        phase: 'Core route',
        kind: 'teach_unit',
        curriculumLearningUnitId: 'unit_2',
        rationale: 'Teach the dependent unit.',
        estimatedMinutes: 20,
        targetDepth: 'working_fluency',
        objectiveIds: ['objective_2'],
        prerequisiteItemKeys: ['item-1'],
      },
    ],
    deferrals: [],
  } as const;
}

describe('Hy3Provider happy path', () => {
  it('repairs formal assessment proposals that omit the S1 declaration shape', async () => {
    const formalProposal = {
      items: [
        {
          ...genericAssessmentProposal.items[0],
          objectiveRef: 'O1',
          premises: [
            {
              premiseKey: 'source:0',
              text: blocks[0]!.content,
              sourceRefs: ['blk_0'],
              teachingSurfaceRefs: [],
              learnerVisible: true,
              scenarioLocal: false,
              visibilityBasis: 'cited_source',
            },
          ],
          requiresExternalKnowledge: false,
          ambiguity: 'none',
          undefinedTerms: [],
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(genericAssessmentProposal)))
      .mockResolvedValueOnce(
        jsonResponse(JSON.stringify(formalProposal)),
      ) as unknown as typeof fetch;

    const payload = await makeProvider(fetchImpl).proposeAssessment({
      ...assessmentInput,
      objectiveCatalogue: [
        {
          objectiveRef: 'O1',
          title: 'Explain capacity',
          description: 'Explain the source-stated limit.',
        },
      ],
      teachingSurfaceCatalogue: [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(payload.items[0]).toMatchObject({
      objectiveRef: 'O1',
      ambiguity: 'none',
      requiresExternalKnowledge: false,
    });
  });

  it('preserves the generic assessment payload contract outside formal proposal scope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(genericAssessmentProposal)),
    ) as unknown as typeof fetch;

    const payload = await makeProvider(fetchImpl).proposeAssessment(assessmentInput);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(payload.items[0]?.objectiveRef).toBeUndefined();
  });

  it('sends a bearer token and parses a valid concept payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
      ),
    ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts[0]?.name).toBe('工作记忆');

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer test-key-should-never-leak');
  });

  it('reports available standard usage without deriving unreported cost', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(JSON.stringify({ concepts: [] }), {
        prompt_tokens: 17,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    );
    const onUsage = vi.fn();
    await makeProvider(fetchMock).analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { onUsage },
    );
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 17,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      estimatedCostMicrounits: null,
      currency: null,
      pricingSource: null,
      pricingVersion: null,
    });
  });
});

describe('Hy3Provider detailed StudyPlan input-aware repair', () => {
  const invalidCases = [
    {
      name: 'unavailable capability',
      mutate: () => {
        const proposal = structuredClone(validDetailedProposal());
        proposal.items[1]!.kind = 'formal_checkpoint';
        return proposal;
      },
      expected: 'unavailable for LearningUnit unit_2',
    },
    {
      name: 'unknown LearningUnit id',
      mutate: () => {
        const proposal = structuredClone(validDetailedProposal());
        proposal.items[1]!.curriculumLearningUnitId = 'unit_unknown';
        return proposal;
      },
      expected: 'unknown or non-required LearningUnit',
    },
    {
      name: 'omitted required objective',
      mutate: () => ({
        ...structuredClone(validDetailedProposal()),
        items: [validDetailedProposal().items[0]],
      }),
      expected: 'objective is omitted',
    },
    {
      name: 'Contract-forbidden deferral',
      mutate: () => ({
        ...structuredClone(validDetailedProposal()),
        items: [validDetailedProposal().items[0]],
        deferrals: [
          {
            curriculumLearningUnitId: 'unit_2',
            objectiveIds: ['objective_2'],
            reason: 'Defer it.',
          },
        ],
      }),
      expected: 'Deferrals are not allowed',
    },
  ];

  it.each(invalidCases)(
    'repairs $name inside the one-repair contract',
    async ({ mutate, expected }) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(JSON.stringify(mutate())))
        .mockResolvedValueOnce(
          jsonResponse(JSON.stringify(validDetailedProposal())),
        ) as unknown as typeof fetch;

      const proposal = await makeProvider(fetchImpl).proposeStudyPlan(detailedStudyPlanInput());

      expect(proposal).toEqual(validDetailedProposal());
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const repairBody = JSON.parse(
        String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
      ) as { messages: Array<{ content: string }> };
      expect(repairBody.messages.at(-1)!.content).toContain(expected);
    },
  );

  it('fails closed after exactly one repair when the second detailed result is still invalid', async () => {
    const invalid = invalidCases[1]!.mutate();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(invalid)),
    ) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl).proposeStudyPlan(detailedStudyPlanInput()),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Hy3Provider connection probe', () => {
  it('sends one bounded minimal chat request without entering repair flow', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
      };
      expect(body).toMatchObject({
        model: 'test-model',
        temperature: 0,
        max_tokens: 1,
        messages: [
          { role: 'system', content: expect.stringContaining('OK') },
          { role: 'user', content: 'OK' },
        ],
      });
      return jsonResponse('OK');
    }) as unknown as typeof fetch;

    await makeProvider(fetchImpl).testConnection();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('uses a short timeout override without changing normal provider calls', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl, 30_000).testConnection({ timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', details: { timeoutMs: 20 } });
  });
});

describe('Hy3Provider large StudyPlan output', () => {
  it('places exact offered kinds beside units and does not advertise unavailable literals', () => {
    const input = largeStudyPlanInput();
    const content = groupedStudyPlanProposalMessages(input)[1]!.content;

    expect(content).toContain('"allowedItemKinds":["teach_unit"]');
    expect(content).toContain('kind MUST be exactly one of these offered literals: `teach_unit`');
    expect(content).toContain('Never invent, combine, translate, or paraphrase a kind literal');
    expect(content).not.toContain('teach_unit|');
    expect(content).not.toContain('`formal_checkpoint`');
    expect(content).not.toContain('`targeted_repair`');
    expect(content).not.toContain('`due_review`');
  });

  it('uses compact grouped output and derives objective and prerequisite ids locally', async () => {
    const input = largeStudyPlanInput();
    const unitIds = input.units.map((unit) => unit.id);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_VERBOSE_OBJECTIVE');
      return jsonResponse(
        JSON.stringify({
          format: 'grouped_units',
          rationale: 'Follow the accepted prerequisite order.',
          groups: [
            {
              key: 'core',
              phase: 'Core route',
              kind: 'teach_unit',
              curriculumLearningUnitIds: unitIds,
              rationale: 'Advance each accepted LearningUnit.',
              estimatedMinutesPerUnit: 20,
              targetDepth: 'working_fluency',
            },
          ],
          deferrals: [],
        }),
      );
    }) as unknown as typeof fetch;

    const proposal = await makeProvider(fetchImpl).proposeStudyPlan(input);

    expect(proposal.items).toHaveLength(80);
    expect(proposal.items[0]).toMatchObject({
      curriculumLearningUnitId: 'unit_1',
      objectiveIds: ['objective_1'],
      prerequisiteItemKeys: [],
    });
    expect(proposal.items[79]).toMatchObject({
      curriculumLearningUnitId: 'unit_80',
      objectiveIds: ['objective_80'],
      prerequisiteItemKeys: ['item-79'],
    });
  });

  it('rejects unknown, omitted, and out-of-order unit accounting', async () => {
    const input = largeStudyPlanInput();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        JSON.stringify({
          format: 'grouped_units',
          rationale: 'Invalid route.',
          groups: [
            {
              key: 'core',
              phase: 'Core route',
              kind: 'teach_unit',
              curriculumLearningUnitIds: ['unit_2', 'unknown_unit'],
              rationale: 'Invalid order and identity.',
              estimatedMinutesPerUnit: 20,
              targetDepth: 'working_fluency',
            },
          ],
          deferrals: [],
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).proposeStudyPlan(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
    });
  });

  it('repairs a schema-valid teach_unit assignment that violates per-unit capabilities', async () => {
    const input = largeStudyPlanInput();
    input.contract.allowExplicitDeferral = true;
    input.launchCapabilities[79] = {
      curriculumLearningUnitId: 'unit_80',
      allowedItemKinds: [],
      launchableAssessmentModes: [],
    };
    const first = {
      format: 'grouped_units',
      rationale: 'Teach every required unit.',
      groups: [
        {
          key: 'core',
          phase: 'Core route',
          kind: 'teach_unit',
          curriculumLearningUnitIds: input.requiredLearningUnitIds,
          rationale: 'Teach the route.',
          estimatedMinutesPerUnit: 20,
          targetDepth: 'working_fluency',
        },
      ],
      deferrals: [],
    };
    const repaired = {
      ...first,
      groups: [
        {
          ...first.groups[0],
          curriculumLearningUnitIds: input.requiredLearningUnitIds.slice(0, -1),
        },
      ],
      deferrals: [
        {
          curriculumLearningUnitIds: ['unit_80'],
          reason: 'No launch capability is currently available.',
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(first)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(repaired))) as unknown as typeof fetch;

    const proposal = await makeProvider(fetchImpl).proposeStudyPlan(input);

    expect(proposal.items).toHaveLength(79);
    expect(proposal.deferrals).toEqual([
      {
        curriculumLearningUnitId: 'unit_80',
        objectiveIds: ['objective_80'],
        reason: 'No launch capability is currently available.',
      },
    ]);
    const repairBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
    ) as { messages: Array<{ content: string }> };
    const repairInstruction = repairBody.messages.at(-1)!.content;
    expect(repairInstruction).toContain('teach_unit is unavailable for LearningUnit unit_80');
    expect(repairInstruction).toContain('Allowed kind literals for this request: teach_unit');
    expect(repairInstruction).toContain('must be moved to deferrals');
    expect(repairInstruction).toContain(
      'Preserve every otherwise-valid field and exact supplied ID',
    );
  });

  it('still rejects arbitrary unknown kind aliases after exactly one repair', async () => {
    const input = largeStudyPlanInput();
    const invalid = {
      format: 'grouped_units',
      rationale: 'Use an invented action.',
      groups: [
        {
          key: 'core',
          phase: 'Core route',
          kind: 'teach_course_unit',
          curriculumLearningUnitIds: input.requiredLearningUnitIds,
          rationale: 'Invented alias.',
          estimatedMinutesPerUnit: 20,
          targetDepth: 'working_fluency',
        },
      ],
      deferrals: [],
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify(invalid)),
    ) as unknown as typeof fetch;

    await expect(makeProvider(fetchImpl).proposeStudyPlan(input)).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      details: {
        validationKind: 'schema',
        structuredFailure: {
          attemptNumber: 2,
          attemptKind: 'repair',
          jsonParseSuccess: true,
          schemaIssueCount: 1,
          schemaIssues: [{ path: 'groups.0.kind', code: 'invalid_enum_value' }],
          failureCategory: 'SCHEMA_VALIDATION_FAILURE',
          repairAction: 'exhausted',
        },
      },
      technicalFailureCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Hy3Provider bounded repair', () => {
  it('carries the locally required Repair mode into the first request and exact mismatch into the one repair', async () => {
    const input: RepairGenerationInput = {
      targetLearningUnitId: 'unit_1',
      diagnosticCategory: 'RELATION_REVERSAL',
      requiredInterventionMode: 'CONTRAST',
      gapSummary: 'The relation was reversed.',
      affectedCriteria: ['States the correct relation.'],
      sourceContext: [{ blockId: 'block_1', quote: 'A precedes B.' }],
      failedPrompt: 'Explain the relation.',
    };
    const wrong = {
      interventionMode: 'TARGETED_PROMPT',
      diagnosticCategory: 'RELATION_REVERSAL',
      explanation: 'Ask the learner to reconsider.',
      practicePrompt: 'Try again.',
      hints: [],
    };
    const corrected = { ...wrong, interventionMode: 'CONTRAST' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(wrong)))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(corrected))) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const payload = await provider.generateRepair(input, {
      validateCandidate: (candidate) => ({
        valid: (candidate as { interventionMode?: string }).interventionMode === 'CONTRAST',
        diagnostics: [
          'interventionMode mismatch: returned TARGETED_PROMPT, required CONTRAST for RELATION_REVERSAL.',
        ],
        diagnosticCodes: ['repair_intervention_mode_mismatch'],
      }),
    });
    expect(payload.interventionMode).toBe('CONTRAST');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const firstBody = JSON.parse(String(calls[0]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    const repairBody = JSON.parse(String(calls[1]![1]!.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(JSON.stringify(firstBody.messages)).toContain('requiredInterventionMode');
    expect(JSON.stringify(firstBody.messages)).toContain('CONTRAST');
    expect(repairBody.messages.at(-1)!.content).toContain(
      'returned TARGETED_PROMPT, required CONTRAST for RELATION_REVERSAL',
    );
    expect(repairBody.messages.at(-1)!.content).toContain('这两个值不可更改');
  });

  it('retries exactly once on invalid output, then succeeds', async () => {
    const onRepairAttempt = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('这不是 JSON'))
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"工作记忆","summary":"容量有限","importance":"high","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts(
      {
        materialTitle: SAMPLE_MATERIAL_TITLE,
        blocks,
      },
      { onRepairAttempt },
    );
    expect(payload.concepts).toHaveLength(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(onRepairAttempt).toHaveBeenCalledTimes(1);
  });

  it('fails with PROVIDER_INVALID_OUTPUT after the repair also fails (no unbounded retry)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('仍然不是 JSON')) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    // Exactly two calls: initial + one repair.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('repairs a schema-valid-but-wrong payload once', async () => {
    // NOTE: an EMPTY concepts array is deliberately legal since the
    // section-aware extraction upgrade (a thin section may yield nothing),
    // so the invalid first payload violates the importance enum instead.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"CRITICAL","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          '{"concepts":[{"name":"X","summary":"y","importance":"low","blockId":"blk_0","quote":"工作记忆的容量十分有限。"}]}',
        ),
      ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const payload = await provider.analyzeConcepts({
      materialTitle: SAMPLE_MATERIAL_TITLE,
      blocks,
    });
    expect(payload.concepts).toHaveLength(1);
  });
});

describe('Hy3Provider error mapping', () => {
  it('maps non-2xx to PROVIDER_ERROR', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps network failure to PROVIDER_ERROR without leaking details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderError &&
        err.code === 'PROVIDER_ERROR' &&
        !err.message.includes('ECONNREFUSED') &&
        !err.message.includes('10.0.0.1')
      );
    });
  });

  it('maps a timeout to PROVIDER_TIMEOUT', async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('maps external cancellation to REQUEST_CANCELLED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('never includes the API key in a thrown error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderError && !err.message.includes('test-key'),
    );
  });
});

describe('Hy3Provider response-body cancellation', () => {
  function responseWithHangingBody(signal: AbortSignal): Response {
    return {
      ok: true,
      status: 200,
      text: () =>
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(Object.assign(new Error('aborted while reading body'), { name: 'AbortError' }));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        }),
    } as unknown as Response;
  }

  it('keeps the timeout active while reading the response body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl, 20);
    await expect(
      provider.analyzeConcepts({ materialTitle: SAMPLE_MATERIAL_TITLE, blocks }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('keeps external cancellation active while reading the response body', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return responseWithHangingBody(init!.signal as AbortSignal);
    }) as unknown as typeof fetch;

    const provider = makeProvider(fetchImpl);
    const pending = provider.analyzeConcepts(
      { materialTitle: SAMPLE_MATERIAL_TITLE, blocks },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });
});

/**
 * Real REAL_HY3 failure shape: one logical evaluator call spent three physical
 * attempts as schema failure -> deterministic candidate failure -> schema
 * failure again because the final candidate repair reintroduced an unknown key
 * in a later evaluation item. The model must produce a conforming payload; the
 * strict schema is never widened and unknown keys are never stripped.
 */
const STRICT_EVALUATION_OBJECTIVE_COUNT = 8;
const UNKNOWN_MODEL_KEY = 'modelAuthorityCommentaryNeverPersisted';
const UNKNOWN_MODEL_VALUE = 'MODEL_SCALAR_TEXT_NEVER_PERSISTED';

const strictEvaluationInput: ObjectiveAuthoritySemanticEvaluationInput = {
  ...semanticEvaluationInput,
  objectives: Array.from({ length: STRICT_EVALUATION_OBJECTIVE_COUNT }, (_, index) => ({
    ...semanticEvaluationInput.objectives[0]!,
    objectiveRef: `objective_${index + 1}`,
    candidates: [
      {
        ...semanticEvaluationInput.objectives[0]!.candidates[0]!,
        evidenceRef: `evidence_${index + 1}`,
      },
    ],
  })),
};

const strictEvaluationProposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse({
  schemaVersion: 2,
  evaluations: strictEvaluationInput.objectives.map((objective) => ({
    ...semanticEvaluationProposal.evaluations[0]!,
    objectiveRef: objective.objectiveRef,
    candidateLabels: [
      { evidenceRef: objective.candidates[0]!.evidenceRef, relation: 'relevant' as const },
    ],
    supportGroups: [
      {
        evidenceRefs: [objective.candidates[0]!.evidenceRef],
        supportType: 'positioning' as const,
      },
    ],
  })),
});

/** Schema-valid JSON carrying one model-authored key the strict item forbids. */
function withUnknownKeyAt(index: number): unknown {
  const payload = structuredClone(strictEvaluationProposal) as {
    evaluations: Array<Record<string, unknown>>;
  };
  payload.evaluations[index] = {
    ...payload.evaluations[index]!,
    [UNKNOWN_MODEL_KEY]: UNKNOWN_MODEL_VALUE,
  };
  return payload;
}

/** Strictly schema-valid, but the deterministic candidate validator rejects it. */
function withCandidateFailureAtFirstObjective(): unknown {
  const payload = structuredClone(strictEvaluationProposal);
  payload.evaluations[0]!.candidateLabels = [];
  return payload;
}

interface StrictRepairRun {
  promise: Promise<unknown>;
  fetchImpl: ReturnType<typeof vi.fn>;
  onRepairAttempt: ReturnType<typeof vi.fn>;
  diagnostics: StructuredOutputDiagnostic[];
  requestBodies: () => Array<{ messages: Array<{ role: string; content: string }> }>;
}

/** Drive the real complete()/tryParse() machinery over exact physical responses. */
function runStrictEvaluation(responses: unknown[]): StrictRepairRun {
  const fetchImpl = vi.fn();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(jsonResponse(JSON.stringify(response)));
  }
  const onRepairAttempt = vi.fn();
  const diagnostics: StructuredOutputDiagnostic[] = [];
  const promise = makeProvider(fetchImpl as unknown as typeof fetch)
    .evaluateObjectiveAuthoritySupport(strictEvaluationInput, {
      onRepairAttempt,
      onStructuredOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      validateCandidate: (candidate) =>
        validateObjectiveAuthoritySemanticEvaluationProposal(strictEvaluationInput, candidate),
    })
    .catch((error: unknown) => {
      throw error;
    });
  return {
    promise,
    fetchImpl,
    onRepairAttempt,
    diagnostics,
    requestBodies: () =>
      fetchImpl.mock.calls.map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)) as {
            messages: Array<{ role: string; content: string }>;
          },
      ),
  };
}

describe('Hy3Provider objective semantic evaluator strict-output repair', () => {
  it('fails closed after schema -> candidate -> schema repair without a fourth request', async () => {
    const run = runStrictEvaluation([
      withUnknownKeyAt(0),
      withCandidateFailureAtFirstObjective(),
      withUnknownKeyAt(STRICT_EVALUATION_OBJECTIVE_COUNT - 1),
    ]);

    await expect(run.promise).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_OUTPUT',
      technicalFailureCode: 'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
      details: { validationKind: 'schema' },
    });

    expect(run.fetchImpl).toHaveBeenCalledTimes(3);
    expect(run.onRepairAttempt.mock.calls).toEqual([
      ['schema', 'SCHEMA_VALIDATION_FAILURE'],
      ['candidate', 'SEMANTIC_VALIDATION_FAILURE'],
    ]);
    expect(
      run.diagnostics.map((diagnostic) => ({
        attemptNumber: diagnostic.attemptNumber,
        attemptKind: diagnostic.attemptKind,
        failureCategory: diagnostic.failureCategory,
        repairAction: diagnostic.repairAction,
      })),
    ).toEqual([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        failureCategory: 'SCHEMA_VALIDATION_FAILURE',
        repairAction: 'requested',
      },
      {
        attemptNumber: 2,
        attemptKind: 'repair',
        failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
        repairAction: 'requested',
      },
      {
        attemptNumber: 3,
        attemptKind: 'repair',
        failureCategory: 'SCHEMA_VALIDATION_FAILURE',
        repairAction: 'exhausted',
      },
    ]);
  });

  it('reports the exact unrecognized-key location without leaking the model key', async () => {
    const run = runStrictEvaluation([
      withUnknownKeyAt(0),
      withCandidateFailureAtFirstObjective(),
      withUnknownKeyAt(STRICT_EVALUATION_OBJECTIVE_COUNT - 1),
    ]);
    const error = await run.promise.then(
      () => {
        throw new Error('Expected the strict evaluator contract to fail closed.');
      },
      (thrown: unknown) => thrown as ProviderError,
    );

    const terminal = run.diagnostics.at(-1)!;
    expect(terminal.schemaIssues).toEqual([
      {
        path: 'evaluations.7',
        code: 'unrecognized_keys',
        unknownKeyCount: 1,
        unknownKeyTokens: [expect.stringMatching(/^<key:sha256:[0-9a-f]{64}>$/u)],
      },
    ]);
    expect(terminal.schemaIssueCount).toBe(1);

    const persisted = JSON.stringify({ message: error.message, details: error.details });
    expect(persisted).toContain('"path":"evaluations.7"');
    expect(persisted).not.toContain(UNKNOWN_MODEL_KEY);
    expect(persisted).not.toContain(UNKNOWN_MODEL_VALUE);
    expect(JSON.stringify(run.diagnostics)).not.toContain(UNKNOWN_MODEL_KEY);
    expect(JSON.stringify(run.diagnostics)).not.toContain(UNKNOWN_MODEL_VALUE);
  });

  it('accepts a third attempt that fixes the candidate and removes every unknown key', async () => {
    const run = runStrictEvaluation([
      withUnknownKeyAt(0),
      withCandidateFailureAtFirstObjective(),
      structuredClone(strictEvaluationProposal),
    ]);

    await expect(run.promise).resolves.toEqual(strictEvaluationProposal);
    expect(run.fetchImpl).toHaveBeenCalledTimes(3);
    expect(run.onRepairAttempt.mock.calls).toEqual([
      ['schema', 'SCHEMA_VALIDATION_FAILURE'],
      ['candidate', 'SEMANTIC_VALIDATION_FAILURE'],
    ]);
    expect(run.diagnostics.at(-1)).toMatchObject({
      attemptNumber: 3,
      attemptKind: 'repair',
      failureCategory: null,
      repairAction: 'none',
    });
    const accepted = await run.promise;
    for (const evaluation of (accepted as { evaluations: Array<Record<string, unknown>> })
      .evaluations) {
      expect(Object.keys(evaluation).sort()).toEqual([
        'candidateLabels',
        'objectiveRef',
        'subjectDependency',
        'subjectDependencyRationale',
        'supportGroups',
      ]);
    }
  });

  it('states the exact normal-item key whitelist in the final cross-kind repair prompt', async () => {
    const run = runStrictEvaluation([
      withUnknownKeyAt(0),
      withCandidateFailureAtFirstObjective(),
      withUnknownKeyAt(STRICT_EVALUATION_OBJECTIVE_COUNT - 1),
    ]);
    await expect(run.promise).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });

    const finalPrompt = run.requestBodies()[2]!.messages.at(-1)!.content;
    expect(finalPrompt).toContain(
      'Every normal evaluation object contains only these keys: objectiveRef, subjectDependency, subjectDependencyRationale, candidateLabels, supportGroups.',
    );
    expect(finalPrompt).toContain('Delete every other key from every evaluation object.');
    expect(finalPrompt).toContain(
      'Preserve the exact {"schemaVersion":2,"evaluations":[...]} top-level shape and never wrap evaluations in another object.',
    );
  });

  it('keeps the recovery-only key allowance explicit in the final repair prompt', async () => {
    const run = runStrictEvaluation([
      withUnknownKeyAt(0),
      withCandidateFailureAtFirstObjective(),
      withUnknownKeyAt(STRICT_EVALUATION_OBJECTIVE_COUNT - 1),
    ]);
    await expect(run.promise).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });

    expect(run.requestBodies()[2]!.messages.at(-1)!.content).toContain(
      'Only a required capability-recovery evaluation may add these two keys: fragments, capabilityPreservation.',
    );
  });

  it('retains the invariant closed-schema contract on a candidate-only repair', async () => {
    const run = runStrictEvaluation([
      withCandidateFailureAtFirstObjective(),
      structuredClone(strictEvaluationProposal),
    ]);

    await expect(run.promise).resolves.toEqual(strictEvaluationProposal);
    expect(run.onRepairAttempt).toHaveBeenCalledExactlyOnceWith(
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
    );
    const repairPrompt = run.requestBodies()[1]!.messages.at(-1)!.content;
    expect(repairPrompt).toContain(OBJECTIVE_AUTHORITY_SEMANTIC_CLOSED_KEY_RULES);
    expect(repairPrompt).toContain(
      'It still applies when the reported problem is local candidate validation rather than output format.',
    );
  });

  it('keeps rejecting an unknown key nested inside a strict evaluation sub-object', () => {
    const payload = structuredClone(strictEvaluationProposal) as {
      evaluations: Array<Record<string, unknown>>;
    };
    payload.evaluations[7]!.candidateLabels = [
      { evidenceRef: 'evidence_8', relation: 'relevant', [UNKNOWN_MODEL_KEY]: UNKNOWN_MODEL_VALUE },
    ];

    const parsed = ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected the nested strict object to reject.');
    expect(parsed.error.issues).toMatchObject([
      { code: 'unrecognized_keys', path: ['evaluations', 7, 'candidateLabels', 0] },
    ]);
  });

  it('blocks recovery-only keys on a normal evaluation at both enforcement layers', () => {
    const schemaPayload = structuredClone(strictEvaluationProposal) as {
      evaluations: Array<Record<string, unknown>>;
    };
    schemaPayload.evaluations[7]!.fragments = [
      {
        fragmentId: 'F1',
        text: strictEvaluationInput.objectives[7]!.proposition,
        status: 'unsupported',
        supportType: null,
        evidenceRefs: [],
        rationale: 'Recovery fragments are not permitted on the normal path.',
      },
    ];
    const parsed = ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(schemaPayload);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected recovery-only fragments to reject.');
    expect(parsed.error.issues).toMatchObject([
      { code: 'unrecognized_keys', keys: ['fragments'], path: ['evaluations', 7] },
    ]);

    const recoveryPair = structuredClone(strictEvaluationProposal) as {
      evaluations: Array<Record<string, unknown>>;
    };
    const proposition = strictEvaluationInput.objectives[7]!.proposition;
    recoveryPair.evaluations[7] = {
      ...recoveryPair.evaluations[7]!,
      fragments: [
        {
          fragmentId: 'F1',
          text: proposition,
          status: 'supported',
          supportType: 'positioning',
          evidenceRefs: ['evidence_8'],
          rationale: 'The offered claim states the integrated positioning.',
        },
      ],
      capabilityPreservation: {
        originalProposition: proposition,
        mappings: [
          {
            originalFragmentId: 'OF1',
            originalText: proposition,
            repairedFragmentIds: ['F1'],
            status: 'preserved',
            rationale: 'The repaired wording keeps the original capability.',
          },
        ],
        lostOriginalFragmentIds: [],
        verdict: 'pass',
        rationale: 'No original capability was lost.',
      },
    };
    expect(ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(recoveryPair).success).toBe(
      true,
    );
    expect(
      validateObjectiveAuthoritySemanticEvaluationProposal(strictEvaluationInput, recoveryPair),
    ).toMatchObject({
      valid: false,
      diagnosticCodes: expect.arrayContaining(['semantic_capability_preservation_unexpected']),
    });
  });

  it('leaves generic non-evaluator repair guidance unchanged', async () => {
    const malformed = curriculumProposalCandidate() as { nodes: Array<Record<string, unknown>> };
    malformed.nodes[0] = { ...malformed.nodes[0]!, [UNKNOWN_MODEL_KEY]: UNKNOWN_MODEL_VALUE };
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(JSON.stringify(malformed))),
      ) as unknown as typeof fetch;

    await expect(
      makeProvider(fetchImpl).proposeCurriculum(curriculumProviderInput(false)),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairPrompt = (
      JSON.parse(
        String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body),
      ) as { messages: Array<{ content: string }> }
    ).messages.at(-1)!.content;
    expect(repairPrompt).not.toContain(OBJECTIVE_AUTHORITY_SEMANTIC_CLOSED_KEY_RULES);
    expect(repairPrompt).not.toContain('Closed-key contract.');
  });
});
