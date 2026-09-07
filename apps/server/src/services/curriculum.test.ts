import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorCode } from '@hy3-clinic/shared';
import type {
  CurriculumProposalPayload,
  LearningContract,
  LearningContractDraftFields,
  ObjectiveAuthoritySemanticEvaluationInput,
  ObjectiveAuthoritySemanticEvaluationProposal,
  ObjectiveAuthoritySemanticRepairInput,
  ObjectiveAuthoritySemanticRepairProposal,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { Hy3Provider } from '../llm/hy3Provider.js';
import { ProviderError } from '../llm/errors.js';
import type { CurriculumProposalInput, ProviderCallOptions } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock, type Clock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { buildCourseMapSourceAllocation } from './courseMap.js';
import { createCourseOverviewService } from './courseOverview.js';
import {
  buildCurriculumCourseSourceMap,
  buildCurriculumExecutionContext,
  COURSE_MAP_CURRICULUM_GENERATION_POLICY,
  createCurriculumService,
  CURRICULUM_GENERATION_POLICY,
  CURRICULUM_MAX_OBJECTIVE_AUTHORITY_REPAIR_CALLS,
  curriculumGenerationPolicyForOutline,
  curriculumOperationLeaseMs,
  LEGACY_CURRICULUM_GENERATION_POLICY,
  type CurriculumService,
} from './curriculum.js';
import { createLearningContractService } from './learningContracts.js';
import { assessLearningContractScope } from './learningContractScope.js';
import { createMaterialRoleService } from './materialRoles.js';
import { createSourceAuthorityService } from './sourceAuthority.js';
import { preflightStudyPlan } from './studyPlansAgent.js';
import { buildCurriculumEvidenceCatalog } from './curriculumEvidence.js';

const QUOTE = 'Working memory is limited.';
const clock = fixedClock(T0);

class ControlledCurriculumProvider extends FakeProvider {
  calls = 0;
  fail = false;
  lastInput: CurriculumProposalInput | null = null;
  makePayload: (input: CurriculumProposalInput) => CurriculumProposalPayload = (input) => {
    const defaultEvidenceId =
      input.evidenceCatalog.find((offer) => offer.quote === QUOTE)?.id ??
      input.evidenceCatalog[0]!.id;
    const recoveryRequirements = input.capabilityRecovery?.requirements ?? [];
    const objectives =
      recoveryRequirements.length > 0
        ? recoveryRequirements.map((requirement, index) => {
            const evidenceId = requirement.allowedEvidenceIds[0];
            if (!evidenceId) {
              throw new Error(`Recovery capability ${requirement.capabilityRef} has no evidence.`);
            }
            return {
              key: `objective-recovery-${index + 1}`,
              title: requirement.title,
              description: requirement.description,
              subjectClass: requirement.subjectClass ?? ('source_specific' as const),
              scopeOrigin: requirement.scopeOrigin ?? ('anchored' as const),
              construct: requirement.construct,
              evidence: [{ evidenceId }],
              capabilityRequirementRef: requirement.capabilityRef,
              priority: requirement.priority,
            };
          })
        : [
            {
              key: 'objective-1',
              title: QUOTE,
              description: QUOTE,
              subjectClass: 'source_specific' as const,
              scopeOrigin: 'anchored' as const,
              construct: 'identify' as const,
              evidence: [{ evidenceId: defaultEvidenceId }],
            },
          ];
    const sourceEvidenceIds =
      recoveryRequirements.length > 0
        ? [
            ...new Set(
              recoveryRequirements.flatMap((requirement) => requirement.allowedEvidenceIds),
            ),
          ]
        : [defaultEvidenceId];
    return {
      nodes: [
        {
          key: 'chapter-1',
          parentKey: null,
          kind: 'chapter',
          index: 0,
          title: 'Foundations',
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
          title: 'Memory',
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
          title: 'Working memory capacity',
          structuralUnitIds: [],
          sourceEvidence: sourceEvidenceIds.map((evidenceId) => ({ evidenceId })),
          conceptIds: [],
          canonicalConceptIds: [],
          objectives,
          prerequisiteUnitKeys: [],
          graphRelationIds: [],
        },
      ],
      synthesisGroups: [],
    };
  };

  override async proposeCurriculum(
    input: CurriculumProposalInput,
    _opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    this.calls += 1;
    this.lastInput = input;
    if (this.fail) throw new Error('controlled provider failure');
    return this.makePayload(input);
  }
}

class SourceOnlyFakeProvider extends FakeProvider {
  override proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    return super.proposeCurriculum(
      {
        ...input,
        concepts: [],
        canonicalConcepts: [],
        allowedCanonicalConceptIds: [],
        evidenceCatalog: [],
      },
      opts,
    );
  }
}

function controlledSemanticEvaluation(
  input: ObjectiveAuthoritySemanticEvaluationInput,
  failedObjectiveIndexes: ReadonlySet<number>,
): ObjectiveAuthoritySemanticEvaluationProposal {
  return {
    schemaVersion: 2,
    evaluations: input.objectives.map((objective, index) => {
      const authorityFailed = failedObjectiveIndexes.has(index);
      const fragmentId = `fragment_${index + 1}`;
      const preservationRequirement = objective.requiredCapabilityPreservation;
      const capabilityPreserved =
        !preservationRequirement ||
        preservationRequirement.originalProposition === objective.proposition;
      const supportType =
        objective.construct === 'apply'
          ? ('procedure' as const)
          : objective.construct === 'explain'
            ? ('relationship' as const)
            : ('definition' as const);
      return {
        objectiveRef: objective.objectiveRef,
        subjectDependency: 'source_specific_required' as const,
        subjectDependencyRationale:
          'The controlled evaluator conservatively requires source-specific truth.',
        candidateLabels: objective.candidates.map((candidate) => ({
          evidenceRef: candidate.evidenceRef,
          relation: 'relevant' as const,
        })),
        supportGroups:
          authorityFailed || !objective.candidates[0]
            ? []
            : [
                {
                  evidenceRefs: [objective.candidates[0].evidenceRef],
                  supportType,
                  rationale: 'The exact candidate supports the complete controlled proposition.',
                },
              ],
        ...(preservationRequirement
          ? {
              fragments: [
                {
                  fragmentId,
                  text: objective.proposition,
                  status: authorityFailed ? ('unsupported' as const) : ('supported' as const),
                  supportType: authorityFailed ? null : supportType,
                  evidenceRefs:
                    authorityFailed || !objective.candidates[0]
                      ? []
                      : [objective.candidates[0].evidenceRef],
                  rationale: authorityFailed
                    ? 'The controlled evaluator rejects this exact objective-authority pair.'
                    : 'The controlled evaluator accepts this complete exact proposition.',
                },
              ],
              capabilityPreservation: {
                originalProposition: preservationRequirement.originalProposition,
                mappings: preservationRequirement.originalFragments.map((original) => ({
                  originalFragmentId: original.fragmentId,
                  originalText: original.text,
                  repairedFragmentIds: [fragmentId],
                  status: capabilityPreserved ? ('preserved' as const) : ('lost' as const),
                  rationale: capabilityPreserved
                    ? 'The exact original controlled proposition is unchanged.'
                    : 'The controlled replacement deleted or substituted the original capability.',
                })),
                lostOriginalFragmentIds: capabilityPreserved
                  ? []
                  : preservationRequirement.originalFragments.map(
                      (original) => original.fragmentId,
                    ),
                verdict: capabilityPreserved ? ('pass' as const) : ('fail' as const),
                rationale: capabilityPreserved
                  ? 'The complete original controlled capability is preserved.'
                  : 'At least one original controlled capability fragment was lost.',
              },
            }
          : {}),
      };
    }),
  };
}

class ControlledSemanticRepairProvider extends ControlledCurriculumProvider {
  readonly evaluationInputs: ObjectiveAuthoritySemanticEvaluationInput[] = [];
  readonly repairInputs: ObjectiveAuthoritySemanticRepairInput[] = [];
  initialPayload: CurriculumProposalPayload | null = null;

  constructor(
    private readonly failAfterRepair: boolean,
    private readonly beforeEvaluation?: (round: number) => void,
    objectiveCount = 2,
    private readonly repairText?: (
      objective: ObjectiveAuthoritySemanticRepairInput['objectives'][number],
    ) => { title: string; description: string },
  ) {
    super();
    this.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      if ((input.capabilityRecovery?.requirements.length ?? 0) > 0) {
        this.initialPayload = structuredClone(payload);
        return payload;
      }
      const template = payload.nodes[2]!.objectives[0]!;
      payload.nodes[2]!.objectives = Array.from({ length: objectiveCount }, (_, index) => ({
        ...structuredClone(template),
        key: `objective-${index + 1}`,
        title:
          index === 0 ? 'Identify the repaired capacity claim' : `Capacity checkpoint ${index + 1}`,
        description:
          index === 0
            ? 'Identify the exact source-stated working-memory capacity claim.'
            : `Identify exact source-stated working-memory capacity checkpoint ${index + 1}.`,
        priority: index === 0 ? ('required' as const) : ('optional' as const),
      }));
      this.initialPayload = structuredClone(payload);
      return payload;
    };
  }

  override async evaluateObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticEvaluationInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticEvaluationProposal> {
    const round = this.evaluationInputs.length;
    this.evaluationInputs.push(structuredClone(input));
    this.beforeEvaluation?.(round);
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    const failed = round === 0 || this.failAfterRepair ? new Set([0]) : new Set<number>();
    const candidate = controlledSemanticEvaluation(input, failed);
    const validation = opts?.validateCandidate?.(candidate);
    if (validation && !validation.valid) {
      throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
    }
    return candidate;
  }

  override async repairObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticRepairInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticRepairProposal> {
    this.repairInputs.push(structuredClone(input));
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    const candidate: ObjectiveAuthoritySemanticRepairProposal = {
      schemaVersion: 1,
      replacements: input.objectives.map((objective) => {
        const text = this.repairText?.(objective) ?? {
          title: objective.title,
          description: objective.description,
        };
        return {
          objectiveRef: objective.objectiveRef,
          ...text,
          subjectClass: objective.subjectClass,
          scopeOrigin: objective.scopeOrigin,
          construct: objective.construct,
          evidenceRefs: [
            (objective.allowedEvidence.find((evidence) => evidence.selected) ??
              objective.allowedEvidence[0])!.evidenceRef,
          ],
        };
      }),
    };
    const validation = opts?.validateCandidate?.(candidate);
    if (validation && !validation.valid) {
      throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
    }
    return candidate;
  }
}

let db: SqliteDb;
let repos: Repositories;
let provider: ControlledCurriculumProvider;
let curriculum: CurriculumService;
let contract: LearningContract;
let commands: ReturnType<typeof createCourseCommandService>;
let roles: ReturnType<typeof createMaterialRoleService>;

function command(id: string, actor: 'learner' | 'local' = 'local') {
  return { commandId: id, idempotencyKey: id, workspaceId: 'ws_1', actor } as const;
}

function contractFields(roleId: string, roleVersion: number): LearningContractDraftFields {
  return {
    intent: 'Study working memory.',
    targetOutcome: {
      description: 'Explain the source accurately.',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 30,
      minutesPerWeek: null,
      preferredSessionMinutes: 30,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    courseScope: {
      subjectBoundaries: ['Cognitive science'],
      materials: [
        {
          materialId: 'mat_1',
          materialRoleAssignmentId: roleId,
          materialRoleAssignmentVersion: roleVersion,
          role: 'course_material',
          disposition: 'included',
        },
      ],
      includedTopics: ['Working memory'],
      excludedTopics: [],
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: null,
    },
  };
}

function proposalRequest(id: string, predecessorCurriculumId: string | null = null) {
  return {
    command: command(id),
    contractId: contract.id,
    expectedContractVersion: contract.version,
    predecessorCurriculumId,
    expectedActiveCurriculumId: null,
  };
}

function currentProposalRequest(id: string, predecessorCurriculumId: string | null = null) {
  return {
    ...proposalRequest(id, predecessorCurriculumId),
    expectedActiveCurriculumId: repos.courseExecution.get('ws_1').activeCurriculumId,
  };
}

function curriculumEvidenceId(): string {
  return 'E1';
}

function payloadForFetch(evidenceId = curriculumEvidenceId()): CurriculumProposalPayload {
  const input = {
    blocks: repos.materials.getBlocks('mat_1'),
    evidenceCatalog: [{ id: evidenceId, quote: QUOTE }],
  } as CurriculumProposalInput;
  const payload = new ControlledCurriculumProvider().makePayload(input);
  payload.nodes[2]!.sourceEvidence = [{ evidenceId }];
  payload.nodes[2]!.objectives[0]!.evidence = [{ evidenceId }];
  return payload;
}

function useMockedHy3(contents: string[], beforeResponse?: (index: number) => void) {
  let index = 0;
  const fetchMock = vi.fn<typeof fetch>(async () => {
    beforeResponse?.(index);
    const content = contents[Math.min(index, contents.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const hy3 = new Hy3Provider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key-never-persist',
    model: 'test-model',
    timeoutMs: 30_000,
    fetchImpl: fetchMock,
  });
  curriculum = createCurriculumService({
    repos,
    provider: hy3,
    clock,
    commands: createCourseCommandService({ repos, clock }),
    sourceAuthority: createSourceAuthorityService({
      sourceAuthority: repos.sourceAuthority,
      clock,
    }),
    generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
  });
  return fetchMock;
}

function attemptsForCommand(commandId: string) {
  const row = db
    .prepare(
      `SELECT lc.id
       FROM model_logical_calls lc
       JOIN agent_operations op ON op.id = lc.operation_id
       WHERE op.command_id = ?`,
    )
    .get(commandId) as { id: string } | undefined;
  return row ? repos.telemetry.listAttempts(row.id) : [];
}

function usageRowsForCommand(commandId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM model_usage_records u
         JOIN model_call_attempts a ON a.id = u.attempt_id
         JOIN model_logical_calls lc ON lc.id = a.logical_call_id
         JOIN agent_operations op ON op.id = lc.operation_id
         WHERE op.command_id = ?`,
      )
      .get(commandId) as { count: number }
  ).count;
}

function modelCallLedgerForCommand(commandId: string): {
  logicalCalls: number;
  physicalAttempts: number;
  schemaFingerprints: Array<string | null>;
} {
  const counts = db
    .prepare(
      `SELECT COUNT(DISTINCT lc.id) AS logicalCalls,
              COUNT(a.id) AS physicalAttempts
       FROM agent_operations op
       LEFT JOIN model_logical_calls lc ON lc.operation_id = op.id
       LEFT JOIN model_call_attempts a ON a.logical_call_id = lc.id
       WHERE op.command_id = ?`,
    )
    .get(commandId) as { logicalCalls: number; physicalAttempts: number };
  const schemaFingerprints = (
    db
      .prepare(
        `SELECT lc.schema_fingerprint AS schemaFingerprint
         FROM model_logical_calls lc
         JOIN agent_operations op ON op.id = lc.operation_id
         WHERE op.command_id = ?
         ORDER BY lc.rowid`,
      )
      .all(commandId) as Array<{ schemaFingerprint: string | null }>
  ).map((row) => row.schemaFingerprint);
  return { ...counts, schemaFingerprints };
}

async function acceptSourceOnlyCurriculum(id: string) {
  const first = await curriculum.propose(proposalRequest(`${id}-propose`));
  return curriculum.accept({
    command: command(`${id}-accept`, 'learner'),
    curriculumId: first.curriculum.id,
    expectedVersion: first.curriculum.version,
    expectedContractId: contract.id,
    expectedExecutionSourceManifestFingerprint:
      first.curriculum.executionSourceManifest.fingerprint,
    acceptanceBasis: 'learner_review',
  }).curriculum;
}

function addGroundedConcept(id: string, blockId = 'blk_1', quote = QUOTE) {
  const concept = {
    id,
    materialId: 'mat_1',
    name: `Concept ${id}`,
    summary: quote,
    importance: 'high' as const,
    grounding: {
      blockId,
      quote,
      startOffset: 0,
      endOffset: quote.length,
      occurrenceCount: 1,
      reanchored: false,
    },
    createdAt: T0,
  };
  repos.materials.addConcepts([concept]);
  return concept;
}

function activateChangedSourceRevision(id: string): void {
  const content = `${QUOTE} Changed source revision ${id}.`;
  repos.materialRevisions.stage({
    revisionId: id,
    material: makeMaterial({ content, charCount: content.length, title: 'Memory notes' }),
    blocks: [
      makeBlock({
        id: `blk_${id}`,
        content,
        startOffset: 0,
        endOffset: content.length,
      }),
    ],
    originalData: null,
    parserFingerprint: `parser_${id}`,
    contentFingerprint: `content_${id}`,
    parserAttemptId: `attempt_${id}`,
    createdAt: T0,
  });
  repos.materialRevisions.activate('mat_1', id, T0);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace({ name: 'Cognitive science' }));
  repos.materials.insertWithBlocks(
    makeMaterial({ content: QUOTE, charCount: QUOTE.length, title: 'Memory notes' }),
    [
      makeBlock({
        content: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        heading: 'Working memory',
      }),
    ],
  );
  commands = createCourseCommandService({ repos, clock });
  roles = createMaterialRoleService({ repos, clock, commands });
  const roleProposal = roles.propose({
    command: command('role-propose'),
    materialId: 'mat_1',
    role: 'course_material',
    expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_1')!.id,
  });
  const role = roles.confirm({
    command: command('role-confirm', 'learner'),
    assignmentId: roleProposal.id,
    expectedVersion: roleProposal.version,
  });
  const contracts = createLearningContractService({ repos, clock, commands });
  const draft = contracts.createDraft({
    command: command('contract-create', 'learner'),
    fields: contractFields(role.id, role.version),
    predecessorContractId: null,
    expectedActiveContractId: null,
  }).contract;
  const proposed = contracts.transition({
    command: command('contract-propose', 'learner'),
    contractId: draft.id,
    expectedVersion: draft.version,
    transition: 'propose',
  }).contract;
  contract = contracts.transition({
    command: command('contract-confirm', 'learner'),
    contractId: proposed.id,
    expectedVersion: proposed.version,
    transition: 'confirm',
  }).contract;
  provider = new ControlledCurriculumProvider();
  curriculum = createCurriculumService({
    repos,
    provider,
    clock,
    commands,
    sourceAuthority: createSourceAuthorityService({
      sourceAuthority: repos.sourceAuthority,
      clock,
    }),
    generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
  });
});

describe('Curriculum proposal and authority boundaries', () => {
  it('resumes a failed Detail dependency without regenerating its valid Course Map', async () => {
    addGroundedConcept('stage-concept');
    const model = new FakeProvider();
    const map = vi.spyOn(model, 'proposeCourseMap');
    const detail = vi.spyOn(model, 'proposeCurriculumDetails');
    detail.mockRejectedValueOnce(ProviderError.network());
    const service = () =>
      createCurriculumService({
        repos: createRepositories(db),
        provider: model,
        clock,
        commands,
        sourceAuthority: createSourceAuthorityService({
          sourceAuthority: repos.sourceAuthority,
          clock,
        }),
      });
    await expect(service().propose(proposalRequest('detail-failure'))).rejects.toThrow();
    expect(map).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(repos.curricula.list('ws_1')).toEqual([]);
    const completed = await service().propose(proposalRequest('detail-resume'));
    expect(completed.curriculum.status).toBe('proposed');
    expect(map).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(2);
    const hits = db
      .prepare("SELECT id FROM model_logical_calls WHERE cache_status='hit'")
      .all() as { id: string }[];
    expect(hits).toHaveLength(1);
    expect(repos.telemetry.listAttempts(hits[0]!.id)).toEqual([]);
    expect(repos.courseExecution.get('ws_1').activeCurriculumId).toBeNull();
  });

  it('selects the hierarchy-first generation path at the large-outline threshold', () => {
    expect(curriculumGenerationPolicyForOutline(79, LEGACY_CURRICULUM_GENERATION_POLICY)).toBe(
      LEGACY_CURRICULUM_GENERATION_POLICY,
    );
    expect(curriculumGenerationPolicyForOutline(80, LEGACY_CURRICULUM_GENERATION_POLICY)).toBe(
      'course_map_materialization_v1',
    );
    expect(
      curriculumGenerationPolicyForOutline(200, LEGACY_CURRICULUM_GENERATION_POLICY, true),
    ).toBe(LEGACY_CURRICULUM_GENERATION_POLICY);
  });

  it('defaults production generation to Course Map materialization for any outline size', () => {
    expect(CURRICULUM_GENERATION_POLICY).toBe(COURSE_MAP_CURRICULUM_GENERATION_POLICY);
    // A: small course, no explicit policy. B: large course, no explicit policy.
    // Neither size reaches legacy, so the >= 80 escalation is now unreachable
    // from the default and only rewrites an explicitly legacy service default.
    for (const outlineLength of [0, 1, 12, 79, 80, 500]) {
      expect(
        curriculumGenerationPolicyForOutline(outlineLength, CURRICULUM_GENERATION_POLICY),
      ).toBe(COURSE_MAP_CURRICULUM_GENERATION_POLICY);
    }
    // C: explicit Course Map stays Course Map. D: explicit legacy stays legacy
    // at every outline length, including past the escalation threshold.
    expect(
      curriculumGenerationPolicyForOutline(12, COURSE_MAP_CURRICULUM_GENERATION_POLICY, true),
    ).toBe(COURSE_MAP_CURRICULUM_GENERATION_POLICY);
    expect(
      curriculumGenerationPolicyForOutline(12, LEGACY_CURRICULUM_GENERATION_POLICY, true),
    ).toBe(LEGACY_CURRICULUM_GENERATION_POLICY);
    expect(
      curriculumGenerationPolicyForOutline(200, LEGACY_CURRICULUM_GENERATION_POLICY, true),
    ).toBe(LEGACY_CURRICULUM_GENERATION_POLICY);
    expect(curriculumOperationLeaseMs(240_000)).toBe(242 * 60 * 1000);
    expect(curriculumOperationLeaseMs(240_000, LEGACY_CURRICULUM_GENERATION_POLICY)).toBe(
      218 * 60 * 1000,
    );
  });

  it('loads eligible authority once per source manifest instead of once per SourceBlock', () => {
    const byRevision = vi.spyOn(repos.sourceAuthority, 'findEligibleByRevisions');
    const byBlock = vi.spyOn(repos.sourceAuthority, 'findEligibleByBlock');
    const revision = repos.materialRevisions.getActive('mat_1')!;

    const context = buildCurriculumExecutionContext(repos, contract);

    expect(context.blocks).toHaveLength(1);
    expect(byRevision).toHaveBeenCalledOnce();
    expect(byRevision).toHaveBeenCalledWith('ws_1', [revision.id]);
    expect(byBlock).not.toHaveBeenCalled();
  });

  it('admits an asset-only scoped revision without promoting its advisory description to evidence or authority', () => {
    const bytes = Buffer.from('exact standalone image bytes');
    const byteHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    repos.materials.insertWithBlocks(
      makeMaterial({
        id: 'mat_visual',
        title: 'Capacity diagram',
        sourceType: 'image',
        mediaType: 'image/png',
        originalFilename: 'capacity.png',
        content: '',
        charCount: 0,
        parserVersion: 'standalone-image-sharp-v1',
      }),
      [],
      bytes,
      [],
      { sourceFingerprint: byteHash },
      [
        {
          id: 'candidate_visual',
          materialId: 'mat_visual',
          materialRevisionId: 'mat_visual:candidate',
          index: 0,
          parentStructuralUnitId: null,
          sourcePath: 'original-image',
          mediaType: 'image/png',
          byteHash,
          byteLength: bytes.length,
          width: 640,
          height: 480,
          location: { domPath: 'standalone:image' },
          relationshipKind: 'image',
          contentOrigin: 'extracted_original',
          parserVersion: 'standalone-image-sharp-v1',
          bytes,
        },
      ],
    );
    const roleProposal = roles.propose({
      command: command('visual-role-propose'),
      materialId: 'mat_visual',
      role: 'course_material',
      expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_visual')!.id,
    });
    const visualRole = roles.confirm({
      command: command('visual-role-confirm', 'learner'),
      assignmentId: roleProposal.id,
      expectedVersion: roleProposal.version,
    });
    const asset = repos.materials.getAssets('mat_visual')[0]!;
    repos.visualDerivations.create({
      id: 'visual_derivation_asset_only',
      materialId: asset.materialId,
      materialRevisionId: asset.materialRevisionId,
      assetId: asset.id,
      assetByteHash: asset.byteHash,
      identityFingerprint: `visual_derivation_${'d'.repeat(64)}`,
      semanticIdentityFingerprint: `visual_semantic_${'e'.repeat(64)}`,
      derivationKind: 'visual_description',
      contentOrigin: 'derived_visual_description',
      authority: 'derived',
      evidenceAdmissibility: 'advisory_nonblocking',
      validationStatus: 'accepted',
      generatorIdentity: 'provider_visual_description',
      generatorVersion: 'provider-visual-description-v1',
      provider: 'fake',
      providerModel: null,
      providerEndpointIdentity: 'local:fake',
      providerRuntimeIdentity: 'fake-provider-v1',
      configurationFingerprint: `sha256:${'f'.repeat(64)}`,
      contextMode: 'image_only',
      contextFingerprint: null,
      transport: {
        mediaType: 'image/png',
        width: 640,
        height: 480,
        byteLength: bytes.length,
        transformation: 'validated_original',
        preparationVersion: 'sharp-visual-transport-v1',
        fingerprint: byteHash,
      },
      payload: {
        description: 'Hy3 describes a capacity diagram with two linked regions.',
        visualType: 'diagram',
        visibleText: null,
        importantConcepts: ['capacity'],
        pedagogicalNotes: ['Use only as advisory teaching context.'],
        uncertainty: ['The image alone does not establish a formal premise.'],
      },
      reusedFromDerivationId: null,
      createdAt: T0,
    });
    const visualContract: LearningContract = {
      ...contract,
      id: 'contract_visual',
      courseScope: {
        ...contract.courseScope,
        materials: [
          {
            materialId: 'mat_visual',
            materialRoleAssignmentId: visualRole.id,
            materialRoleAssignmentVersion: visualRole.version,
            role: 'course_material',
            disposition: 'included',
          },
        ],
      },
    };

    const context = buildCurriculumExecutionContext(repos, visualContract);
    const sourceMap = buildCurriculumCourseSourceMap(context, [], null);
    const evidenceCatalog = buildCurriculumEvidenceCatalog({
      workspaceId: 'ws_1',
      manifest: context.manifest,
      blocks: context.blocks,
      preferredGroundings: [],
    });

    expect(context.manifest.revisions[0]).toMatchObject({
      materialId: 'mat_visual',
      materialRevisionId: asset.materialRevisionId,
      sourceBlockRevisionIds: [],
    });
    expect(context.blocks).toEqual([]);
    expect(context.outline).toEqual([]);
    expect(context.authorityBundles).toEqual([]);
    expect(evidenceCatalog).toEqual([]);
    expect(sourceMap).toMatchObject({
      blockCount: 0,
      sectionCount: 0,
      materials: [
        {
          visuals: [
            {
              assetOccurrenceId: asset.id,
              assetByteHash: byteHash,
              contentOrigin: 'extracted_original',
              advisoryDescription: {
                text: 'Hy3 describes a capacity diagram with two linked regions.',
                authority: 'advisory_nonblocking',
              },
            },
          ],
        },
      ],
    });
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM truth_authority_records WHERE material_id = ?')
          .get('mat_visual') as { count: number }
      ).count,
    ).toBe(0);
    // Under the Course Map default this revision has no textual allocation
    // surface, so it must be accounted for at material level rather than
    // receiving a fabricated region built from its advisory description.
    // An all-asset-only course has no textual allocation surface at all, so the
    // Course Map path fails closed with a typed refusal instead of fabricating a
    // region from the advisory description or crashing on an empty section list.
    expect(() =>
      buildCourseMapSourceAllocation({
        workspaceId: 'ws_1',
        sourceMap,
        blocks: context.blocks,
        evidenceCatalog,
      }),
    ).toThrowError(/authoritative textual allocation surface/);
  });

  it('keeps a pending role proposal below Contract authority, then blocks a confirmed role change', async () => {
    const scoped = contract.courseScope.materials[0]!;
    const future = roles.propose({
      command: command('live01-future-role', 'learner'),
      materialId: scoped.materialId,
      role: 'supplementary_reference',
      expectedCurrentAssignmentId: scoped.materialRoleAssignmentId,
    });

    expect(assessLearningContractScope(repos, contract).state).toBe('current');
    expect(() => buildCurriculumExecutionContext(repos, contract)).not.toThrow();
    roles.confirm({
      command: command('live01-future-role-confirm', 'learner'),
      assignmentId: future.id,
      expectedVersion: future.version,
    });
    await expect(curriculum.propose(proposalRequest('live01-stale-curriculum'))).rejects.toThrow(
      '课程资料范围发生了变化',
    );
    expect(provider.calls).toBe(0);
    expect(future).toMatchObject({
      materialId: scoped.materialId,
      predecessorId: scoped.materialRoleAssignmentId,
      version: scoped.materialRoleAssignmentVersion + 1,
      role: 'supplementary_reference',
    });
    expect(createCourseOverviewService({ repos, clock }).get('ws_1')).toMatchObject({
      contractScopeReadiness: {
        state: 'reconfirmation_required',
        issues: [{ kind: 'material_role_changed', materialId: scoped.materialId }],
      },
      capabilities: { canProposeCurriculum: false, canProposeStudyPlan: false },
    });
    expect(repos.materials.get(scoped.materialId)?.id).toBe(scoped.materialId);
  });

  it('resolves stable Contract Material scope to the exact active revision manifest', () => {
    const before = buildCurriculumExecutionContext(repos, contract).manifest;
    const sameContract = repos.learningContracts.get(contract.id)!;
    repos.materialRevisions.stage({
      revisionId: 'revision-2',
      material: makeMaterial({
        content: `${QUOTE} Updated.`,
        charCount: `${QUOTE} Updated.`.length,
        title: 'Memory notes',
      }),
      blocks: [
        makeBlock({
          id: 'blk_revision_2',
          content: `${QUOTE} Updated.`,
          startOffset: 0,
          endOffset: `${QUOTE} Updated.`.length,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser-fingerprint-2',
      contentFingerprint: 'content-fingerprint-2',
      parserAttemptId: 'attempt-2',
      createdAt: T0,
    });
    repos.materialRevisions.activate('mat_1', 'revision-2', T0);
    const after = buildCurriculumExecutionContext(repos, contract).manifest;

    expect(repos.learningContracts.get(contract.id)).toEqual(sameContract);
    expect(after.revisions[0]!.materialId).toBe(before.revisions[0]!.materialId);
    expect(after.revisions[0]!.materialRevisionId).not.toBe(
      before.revisions[0]!.materialRevisionId,
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(JSON.stringify(contract.courseScope)).not.toContain('materialRevisionId');
  });

  it('builds the production Course Source Map from current persisted multi-Material facts', async () => {
    addGroundedConcept('concept_source_map');
    const predecessor = await curriculum.propose(proposalRequest('curriculum-source-map-prior'));
    const companionText = 'Companion transfer evidence remains exact.';
    repos.materials.insertWithBlocks(
      makeMaterial({
        id: 'mat_2',
        workspaceId: 'ws_1',
        title: 'Companion cases',
        content: companionText,
        charCount: companionText.length,
      }),
      [
        makeBlock({
          id: 'blk_2',
          materialId: 'mat_2',
          content: companionText,
          startOffset: 0,
          endOffset: companionText.length,
          heading: 'Transfer',
          headingPath: ['Transfer'],
        }),
      ],
    );
    const companionProposal = roles.propose({
      command: command('source-map-companion-role-propose'),
      materialId: 'mat_2',
      role: 'supplementary_reference',
      expectedCurrentAssignmentId: repos.materialRoles.getCurrent('mat_2')!.id,
    });
    const companionRole = roles.confirm({
      command: command('source-map-companion-role-confirm', 'learner'),
      assignmentId: companionProposal.id,
      expectedVersion: companionProposal.version,
    });
    const multiMaterialContract: LearningContract = {
      ...contract,
      courseScope: {
        ...contract.courseScope,
        materials: [
          ...contract.courseScope.materials,
          {
            materialId: 'mat_2',
            materialRoleAssignmentId: companionRole.id,
            materialRoleAssignmentVersion: companionRole.version,
            role: companionRole.role,
            disposition: 'included',
          },
        ],
      },
    };
    const context = buildCurriculumExecutionContext(repos, multiMaterialContract);
    const concepts = repos.materials.getConceptsByWorkspace('ws_1');
    const sourceMap = buildCurriculumCourseSourceMap(context, concepts, predecessor.curriculum);
    const repeated = buildCurriculumCourseSourceMap(
      structuredClone(context),
      structuredClone(concepts),
      structuredClone(predecessor.curriculum),
    );

    expect(repeated).toEqual(sourceMap);
    expect(sourceMap).toMatchObject({
      workspaceId: 'ws_1',
      manifestFingerprint: context.manifest.fingerprint,
      authority: 'organization_only',
      materialCount: 2,
      blockCount: 2,
      conceptAssociationCount: 1,
      predecessorUsedBlockCount: 1,
    });
    expect(sourceMap.materials.map((material) => material.materialId)).toEqual(['mat_1', 'mat_2']);
    expect(sourceMap.materials.flatMap((material) => material.blocks)).toMatchObject([
      {
        sourceBlockId: 'blk_1',
        courseSourceIndex: 0,
        conceptIds: ['concept_source_map'],
        predecessorUsage: { curriculumId: predecessor.curriculum.id },
      },
      {
        sourceBlockId: 'blk_2',
        courseSourceIndex: 1,
        conceptIds: [],
        predecessorUsage: null,
      },
    ]);

    const stale = structuredClone(context);
    stale.manifest.fingerprint = 'manifest_stale';
    expect(() => buildCurriculumCourseSourceMap(stale, concepts, predecessor.curriculum)).toThrow(
      /manifest fingerprint is stale/u,
    );
    const foreign = structuredClone(context);
    foreign.sourceMapMaterials[1]!.workspaceId = 'course_foreign';
    expect(() => buildCurriculumCourseSourceMap(foreign, concepts, predecessor.curriculum)).toThrow(
      /foreign Course/u,
    );
    const duplicate = structuredClone(context);
    duplicate.sourceMapMaterials[1]!.blocks[0]!.id = duplicate.sourceMapMaterials[0]!.blocks[0]!.id;
    expect(() =>
      buildCurriculumCourseSourceMap(duplicate, concepts, predecessor.curriculum),
    ).toThrow(/SourceBlock identities must be unique/u);
  });

  it('keeps learner scope separate while a local validator admits exact source statements', async () => {
    const revision = repos.materialRevisions.getActive('mat_1')!;
    expect(repos.sourceAuthority.findEligibleByBlock('ws_1', revision.id, 'blk_1')).toEqual([]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-verified'));
    expect(
      proposed.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.objectives[0],
    ).toMatchObject({
      truthPremiseStatus: 'independently_verified',
      truthAuthorityRecordIds: [expect.any(String), expect.any(String)],
    });
    const admitted = repos.sourceAuthority.findEligibleByBlock('ws_1', revision.id, 'blk_1');
    expect(admitted.every((bundle) => bundle.record.actor === 'local_validator')).toBe(true);
    expect(
      admitted.flatMap((bundle) => bundle.claims).every((claim) => claim.claim === claim.quote),
    ).toBe(true);
    expect(provider.lastInput?.evidenceCatalog.some((offer) => offer.quote === QUOTE)).toBe(true);
    expect(
      proposed.curriculum.nodes.find((node) => node.learningUnit)?.sourceReferences[0],
    ).toMatchObject({
      materialId: 'mat_1',
      materialRevisionId: revision.id,
      sourceBlockId: 'blk_1',
      sourceBlockRevisionFingerprint: expect.stringMatching(/^block_/),
    });
    expect(attemptsForCommand('curriculum-verified')).toHaveLength(1);
    expect(usageRowsForCommand('curriculum-verified')).toBe(1);
  });

  it('links ordinary Fake Curriculum premises to exact locally admitted source claims', async () => {
    const fake = createCurriculumService({
      repos,
      provider: new FakeProvider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    const proposed = await fake.propose(proposalRequest('curriculum-fake-authority'));
    const objectives = proposed.curriculum.nodes.flatMap(
      (node) => node.learningUnit?.objectives ?? [],
    );

    expect(objectives).not.toHaveLength(0);
    expect(
      objectives.every((objective) => objective.truthPremiseStatus === 'independently_verified'),
    ).toBe(true);
    expect(objectives.every((objective) => objective.truthAuthorityRecordIds.length >= 2)).toBe(
      true,
    );
    expect(objectives.some((objective) => objective.title.startsWith('Understand '))).toBe(true);
    const proposalEvent = repos.curricula
      .listEvents(proposed.curriculum.id)
      .find((event) => event.eventType === 'proposed');
    expect(proposalEvent?.payload).toMatchObject({
      generationOperationId: expect.any(String),
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM model_logical_calls WHERE operation_id = ?')
        .get((proposalEvent?.payload as { generationOperationId: string }).generationOperationId),
    ).toMatchObject({ count: 1 });
  });

  it('rejects a client-fabricated manifest and resolves provider context locally', async () => {
    const request = {
      ...proposalRequest('curriculum-client-manifest'),
      executionSourceManifest: {
        fingerprint: 'client-fabricated',
        revisions: [],
      },
    };
    await expect(curriculum.propose(request)).rejects.toThrow('Unrecognized key');
    expect(provider.calls).toBe(0);
    expect(repos.curricula.list('ws_1')).toEqual([]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-server-manifest'));
    expect(provider.lastInput?.executionSourceManifest).toEqual(
      proposed.curriculum.executionSourceManifest,
    );
  });

  it('offers and validates canonical Concepts backed by scoped source Concepts', async () => {
    const concept = {
      id: 'concept_working_memory',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    const canonicalId = repos.alignment.listCanonical('ws_1')[0]!.id;
    provider.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      payload.nodes[2]!.canonicalConceptIds = [canonicalId];
      return payload;
    };

    const proposed = await curriculum.propose(proposalRequest('curriculum-canonical-context'));

    expect(provider.lastInput?.allowedCanonicalConceptIds).toEqual([canonicalId]);
    expect(provider.lastInput?.canonicalConcepts).toEqual([
      {
        id: canonicalId,
        displayName: 'Working memory',
        sourceConceptIds: [concept.id],
      },
    ]);
    expect(
      proposed.curriculum.nodes.find((node) => node.kind === 'learning_unit')?.learningUnit,
    ).toMatchObject({
      conceptIds: [concept.id],
      canonicalConceptIds: [canonicalId],
    });
    const preflight = preflightStudyPlan(
      repos,
      clock,
      contract,
      proposed.curriculum,
      'Memory course',
    );
    expect(preflight.executableLearningUnitCount).toBe(1);
    expect(preflight.canGenerate).toBe(true);
  });

  it('derives exact source Concept and canonical bindings when real-shaped output leaves them empty', async () => {
    const concept = {
      id: 'concept_exact_evidence',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    const canonicalId = repos.alignment.listCanonical('ws_1')[0]!.id;

    const proposed = await curriculum.propose(proposalRequest('curriculum-derived-bindings'));
    const unit = proposed.curriculum.nodes.find((node) => node.kind === 'learning_unit');

    expect(unit?.learningUnit).toMatchObject({
      conceptIds: [concept.id],
      canonicalConceptIds: [canonicalId],
    });
    expect(
      preflightStudyPlan(repos, clock, contract, proposed.curriculum, 'Memory course'),
    ).toMatchObject({
      executableLearningUnitCount: 1,
      nonExecutableLearningUnitCount: 0,
      canGenerate: true,
    });
  });

  it('rejects an unknown provider-selected Concept even when its evidence selection is exact', async () => {
    provider.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      payload.nodes[2]!.conceptIds = ['concept_not_offered'];
      return payload;
    };

    await expect(
      curriculum.propose(proposalRequest('curriculum-unknown-concept')),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      details: expect.objectContaining({
        errors: expect.arrayContaining(['Unknown or out-of-scope Concept: concept_not_offered']),
      }),
    });
    expect(provider.calls).toBe(1);
    expect(repos.curricula.list('ws_1')).toEqual([]);
  });

  it('stops impossible successor retries at the Concept prerequisite without provider calls or mutation', async () => {
    const accepted = await acceptSourceOnlyCurriculum('curriculum-missing-concepts');
    const acceptedSnapshot = structuredClone(accepted);
    const overview = createCourseOverviewService({ repos, clock }).get('ws_1');

    expect(overview.curriculumRecovery).toMatchObject({
      state: 'concept_grounding_missing',
      nextAction: 'build_concept_grounding',
      currentConceptCount: 0,
      validGroundedConceptCount: 0,
      canonicalConceptCount: 0,
      canonicalMembershipCount: 0,
    });
    expect(overview.contractScopeReadiness).toEqual({ state: 'current', issues: [] });
    expect(overview.capabilities.canProposeCurriculum).toBe(false);

    for (const id of ['curriculum-missing-concepts-first', 'curriculum-missing-concepts-again']) {
      await expect(curriculum.propose(proposalRequest(id, accepted.id))).rejects.toMatchObject({
        code: ApiErrorCode.GroundingFailed,
        message: expect.stringContaining('请先提取并检查概念'),
        details: expect.objectContaining({
          kind: 'curriculum_recovery_prerequisite',
          state: 'concept_grounding_missing',
          nextAction: 'build_concept_grounding',
        }),
      });
      expect(attemptsForCommand(id)).toEqual([]);
    }

    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    expect(provider.calls).toBe(1);
  });

  it('keeps B4 fail-closed validation when Concepts exist but selected evidence yields no frontier', async () => {
    const otherQuote = 'Long-term memory stores durable knowledge.';
    const revisionId = repos.materialRevisions.getActive('mat_1')!.id;
    db.prepare(
      `INSERT INTO source_blocks
         (id, material_id, material_revision_id, idx, heading, heading_path,
          page_number, page_end, content, start_offset, end_offset)
       VALUES (?, 'mat_1', ?, 1, 'Long-term memory', '["Long-term memory"]',
               NULL, NULL, ?, 0, ?)`,
    ).run('blk_other', revisionId, otherQuote, otherQuote.length);
    const accepted = await acceptSourceOnlyCurriculum('curriculum-empty-frontier');
    const acceptedSnapshot = structuredClone(accepted);
    addGroundedConcept('concept_other_evidence', 'blk_other', otherQuote);

    await expect(
      curriculum.propose(proposalRequest('curriculum-empty-frontier-successor', accepted.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      message: expect.stringContaining('仍不能支持下一步学习'),
      details: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining('StudyPlan execution repair: 0 of 1 LearningUnits'),
        ]),
      }),
    });

    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    expect(provider.calls).toBe(2);
  });

  it.each(['rejected', 'superseded'] as const)(
    'requires a launchable legacy successor for a historically accepted %s recovery predecessor at proposal and acceptance',
    async (historicalStatus) => {
      const unrelatedQuote = `Unrelated ${historicalStatus} recovery evidence.`;
      const unrelatedBlockId = `blk_historical_${historicalStatus}`;
      const revisionId = repos.materialRevisions.getActive('mat_1')!.id;
      db.prepare(
        `INSERT INTO source_blocks
           (id, material_id, material_revision_id, idx, heading, heading_path,
            page_number, page_end, content, start_offset, end_offset)
         VALUES (?, 'mat_1', ?, 1, 'Unrelated recovery evidence',
                 '["Unrelated recovery evidence"]', NULL, NULL, ?, 0, ?)`,
      ).run(unrelatedBlockId, revisionId, unrelatedQuote, unrelatedQuote.length);
      const accepted = await acceptSourceOnlyCurriculum(
        `curriculum-historical-${historicalStatus}`,
      );
      expect(
        preflightStudyPlan(repos, clock, contract, accepted, 'Memory course').canGenerate,
      ).toBe(false);

      if (historicalStatus === 'rejected') {
        curriculum.reject({
          command: command(`curriculum-historical-${historicalStatus}-reject`, 'learner'),
          curriculumId: accepted.id,
          expectedVersion: accepted.version,
          reason: 'Retain this historically accepted Curriculum only as recovery lineage.',
        });
      } else {
        const row = db
          .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
          .get(accepted.id) as { payload: string };
        const aggregate = JSON.parse(row.payload) as Record<string, unknown>;
        db.prepare(
          `UPDATE curriculum_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...aggregate, status: 'superseded' }), accepted.id);
      }
      expect(repos.curricula.get(accepted.id)).toMatchObject({
        status: historicalStatus,
        acceptedAt: T0,
      });

      addGroundedConcept(
        `concept_historical_${historicalStatus}_unrelated`,
        unrelatedBlockId,
        unrelatedQuote,
      );
      const persistedIdsBefore = repos.curricula.list('ws_1').map((item) => item.id);
      await expect(
        curriculum.propose(
          proposalRequest(`curriculum-historical-${historicalStatus}-invalid`, accepted.id),
        ),
      ).rejects.toMatchObject({
        code: ApiErrorCode.GroundingFailed,
        message: expect.stringContaining('仍不能支持下一步学习'),
        details: expect.objectContaining({
          errors: expect.arrayContaining([
            expect.stringContaining('StudyPlan execution repair: 0 of 1 LearningUnits'),
          ]),
        }),
      });
      expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual(persistedIdsBefore);

      const launchConcept = addGroundedConcept(`concept_historical_${historicalStatus}_launchable`);
      const successor = await curriculum.propose(
        proposalRequest(`curriculum-historical-${historicalStatus}-valid`, accepted.id),
      );
      expect(
        preflightStudyPlan(repos, clock, contract, successor.curriculum, 'Memory course')
          .canGenerate,
      ).toBe(true);

      db.prepare('DELETE FROM concepts WHERE id = ?').run(launchConcept.id);
      expect(() =>
        curriculum.accept({
          command: command(`curriculum-historical-${historicalStatus}-successor-accept`, 'learner'),
          curriculumId: successor.curriculum.id,
          expectedVersion: successor.curriculum.version,
          expectedContractId: contract.id,
          expectedExecutionSourceManifestFingerprint:
            successor.curriculum.executionSourceManifest.fingerprint,
          acceptanceBasis: 'learner_review',
        }),
      ).toThrow('仍不能支持下一步学习');
      expect(repos.curricula.get(successor.curriculum.id)?.status).toBe('proposed');
      expect(repos.curricula.get(accepted.id)).toMatchObject({
        status: historicalStatus,
        acceptedAt: T0,
      });
    },
  );

  it('reports stale Concept grounding and routes recovery to rebuilding', async () => {
    const accepted = await acceptSourceOnlyCurriculum('curriculum-stale-concepts');
    addGroundedConcept('concept_stale');
    const material = repos.materials.get('mat_1')!;
    const updatedQuote = 'Working memory has a deliberately revised source.';
    repos.materialRevisions.stage({
      revisionId: 'rev_2',
      material: {
        ...material,
        content: updatedQuote,
        charCount: updatedQuote.length,
        updatedAt: T0,
      },
      blocks: [
        makeBlock({
          id: 'blk_rev_2',
          content: updatedQuote,
          startOffset: 0,
          endOffset: updatedQuote.length,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser-rev-2',
      contentFingerprint: 'content-rev-2',
      parserAttemptId: 'parser_attempt_rev_2',
      createdAt: T0,
    });
    repos.materialRevisions.activate('mat_1', 'rev_2', T0);

    const overview = createCourseOverviewService({ repos, clock }).get('ws_1');
    expect(overview.planningCurriculum?.id).toBe(accepted.id);
    expect(overview.curriculumRecovery).toMatchObject({
      state: 'concept_grounding_stale',
      nextAction: 'rebuild_concept_grounding',
      currentConceptCount: 0,
      validGroundedConceptCount: 0,
      staleConceptCount: 1,
    });
    expect(overview.contractScopeReadiness).toEqual({ state: 'current', issues: [] });
    expect(overview.capabilities.canProposeCurriculum).toBe(false);
  });

  it('enables Curriculum remediation only after exact current Concept grounding exists', async () => {
    const accepted = await acceptSourceOnlyCurriculum('curriculum-grounding-ready');
    const concept = addGroundedConcept('concept_recovery_ready');

    let overview = createCourseOverviewService({ repos, clock }).get('ws_1');
    expect(overview.curriculumRecovery).toMatchObject({
      state: 'curriculum_remediation_ready',
      nextAction: 'propose_curriculum_successor',
      validGroundedConceptCount: 1,
      canonicalMembershipCount: 0,
    });
    expect(overview.contractScopeReadiness).toEqual({ state: 'current', issues: [] });
    expect(overview.capabilities.canProposeCurriculum).toBe(true);

    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    const successor = await curriculum.propose(
      proposalRequest('curriculum-grounding-ready-successor', accepted.id),
    );
    overview = createCourseOverviewService({ repos, clock }).get('ws_1');
    expect(overview.curriculumRecovery).toMatchObject({
      state: 'curriculum_candidate_ready',
      nextAction: 'review_curriculum_successor',
      canonicalConceptCount: 1,
      canonicalMembershipCount: 1,
    });
    expect(overview.capabilities.canProposeCurriculum).toBe(false);
    expect(overview.capabilities.canAcceptCurriculum).toBe(true);
    expect(
      preflightStudyPlan(repos, clock, contract, successor.curriculum, 'Memory course').canGenerate,
    ).toBe(true);
  });

  it('projects persisted raw coverage diagnostics without mutating accepted history', async () => {
    const revisionId = repos.materialRevisions.getActive('mat_1')!.id;
    const extra = 'Additional source context.';
    db.prepare(
      `INSERT INTO source_blocks
         (id, material_id, material_revision_id, idx, heading, heading_path,
          page_number, page_end, content, start_offset, end_offset)
       VALUES ('blk_unmapped', 'mat_1', ?, 1, 'Extra', '["Extra"]',
               NULL, NULL, ?, 0, ?)`,
    ).run(revisionId, extra, extra.length);
    const accepted = await acceptSourceOnlyCurriculum('curriculum-warning-projection');
    const storedBefore = structuredClone(repos.curricula.get(accepted.id));
    const raw = accepted.validation.warnings.find((warning) =>
      warning.startsWith('Unmapped source blocks remain visible'),
    );

    expect(raw).toBe('Unmapped source blocks remain visible for risk reconciliation: 1.');
    expect(curriculum.detail('ws_1', accepted.id).hierarchy.coverageWarnings).toEqual([
      { code: 'unmapped_source_blocks', count: 1, technicalDetail: raw },
    ]);
    expect(repos.curricula.get(accepted.id)).toEqual(storedBefore);
    expect(repos.curricula.get(accepted.id)?.validation.warnings).toEqual([raw]);
  });

  it('accepts an execution-remediation successor only after deterministic bindings create a frontier', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-remediation-first'));
    const accepted = curriculum.accept({
      command: command('curriculum-remediation-first-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const concept = {
      id: 'concept_remediation_frontier',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    repos.alignment.ensureBaseline('ws_1', [concept], T0);

    const successor = await curriculum.propose(
      proposalRequest('curriculum-remediation-successor', accepted.id),
    );
    const preflight = preflightStudyPlan(
      repos,
      clock,
      contract,
      successor.curriculum,
      'Memory course',
    );
    expect(
      successor.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.conceptIds,
    ).toEqual([concept.id]);
    expect(preflight).toMatchObject({
      executableLearningUnitCount: 1,
      nonExecutableLearningUnitCount: 0,
      canGenerate: true,
    });

    const acceptedSuccessor = curriculum.accept({
      command: command('curriculum-remediation-successor-accept', 'learner'),
      curriculumId: successor.curriculum.id,
      expectedVersion: successor.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        successor.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    expect(acceptedSuccessor.status).toBe('accepted');
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
  });

  it('persists an ordinary execution repair when a legacy-invalid predecessor has only optional objectives', async () => {
    const ordinaryPayload = provider.makePayload;
    provider.makePayload = (input) => {
      const payload = ordinaryPayload(input);
      if (!input.predecessor) {
        for (const objective of payload.nodes.flatMap((node) => node.objectives)) {
          objective.priority = 'optional';
        }
      }
      return payload;
    };
    const accepted = await acceptSourceOnlyCurriculum('curriculum-optional-legacy');
    const acceptedObjective = accepted.nodes.find((node) => node.learningUnit)?.learningUnit
      ?.objectives[0];
    expect(acceptedObjective?.priority).toBe('optional');
    expect(acceptedObjective?.semanticSupport).toBeUndefined();
    const legacyPredecessor = repos.curricula.get(accepted.id)!;
    const predecessorSnapshot = structuredClone(legacyPredecessor);

    const concept = addGroundedConcept('concept_optional_legacy_repair');
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    expect(
      preflightStudyPlan(repos, clock, contract, legacyPredecessor, 'Memory course').canGenerate,
    ).toBe(false);

    const successor = await curriculum.propose(
      proposalRequest('curriculum-optional-legacy-successor', accepted.id),
    );
    const successorObjective = successor.curriculum.nodes.find((node) => node.learningUnit)
      ?.learningUnit?.objectives[0];

    expect(provider.lastInput?.capabilityRecovery).toBeUndefined();
    expect(
      successorObjective?.semanticSupport?.capabilityPreservation?.recoveryOrigin,
    ).toBeUndefined();
    expect(
      preflightStudyPlan(repos, clock, contract, successor.curriculum, 'Memory course').canGenerate,
    ).toBe(true);
    expect(repos.curricula.get(accepted.id)).toEqual(predecessorSnapshot);
  });

  it.each(['learning_contract', 'source_manifest'] as const)(
    'does not carry recovery aliases across a changed %s boundary',
    async (boundary) => {
      const accepted = await acceptSourceOnlyCurriculum(`curriculum-boundary-${boundary}`);
      const acceptedSnapshot = structuredClone(accepted);
      let concept;

      if (boundary === 'learning_contract') {
        concept = addGroundedConcept('concept_contract_boundary');
        const currentRole = repos.materialRoles.getCurrent('mat_1')!;
        const contracts = createLearningContractService({ repos, clock, commands });
        const draft = contracts.createDraft({
          command: command('contract-boundary-create', 'learner'),
          fields: {
            ...contractFields(currentRole.id, currentRole.version),
            intent: 'Continue studying working memory under a revised learning intention.',
          },
          predecessorContractId: contract.id,
          expectedActiveContractId: repos.courseExecution.get('ws_1').activeContractId,
        }).contract;
        const proposed = contracts.transition({
          command: command('contract-boundary-propose', 'learner'),
          contractId: draft.id,
          expectedVersion: draft.version,
          transition: 'propose',
        }).contract;
        contract = contracts.transition({
          command: command('contract-boundary-confirm', 'learner'),
          contractId: proposed.id,
          expectedVersion: proposed.version,
          transition: 'confirm',
        }).contract;
      } else {
        const revisionId = 'revision_manifest_boundary';
        const revisedQuote = `${QUOTE} Changed source revision ${revisionId}.`;
        activateChangedSourceRevision(revisionId);
        concept = addGroundedConcept(
          'concept_manifest_boundary',
          `blk_${revisionId}`,
          revisedQuote,
        );
      }
      repos.alignment.ensureBaseline('ws_1', [concept], T0);

      const successor = await curriculum.propose(
        proposalRequest(`curriculum-boundary-${boundary}-successor`, accepted.id),
      );

      expect(provider.lastInput?.capabilityRecovery).toBeUndefined();
      expect(successor.curriculum.contractVersionId).toBe(contract.id);
      expect(
        successor.curriculum.nodes.find((node) => node.learningUnit)?.learningUnit?.conceptIds,
      ).toContain(concept.id);
      expect(
        successor.curriculum.nodes.flatMap(
          (node) =>
            node.learningUnit?.objectives.map(
              (objective) => objective.semanticSupport?.capabilityPreservation,
            ) ?? [],
        ),
      ).toEqual([undefined]);
      expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    },
  );

  it('fences an accepted recovery-predecessor race before semantic evaluation or persistence', async () => {
    const accepted = await acceptSourceOnlyCurriculum('curriculum-recovery-race');
    const concept = addGroundedConcept('concept_recovery_race');
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    const intermediate = await curriculum.propose(
      proposalRequest('curriculum-recovery-race-intermediate', accepted.id),
    );

    class AcceptingRecoveryRaceProvider extends ControlledSemanticRepairProvider {
      override async proposeCurriculum(
        input: CurriculumProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<CurriculumProposalPayload> {
        const candidate = await super.proposeCurriculum(input, opts);
        curriculum.accept({
          command: command('curriculum-recovery-race-intermediate-accept', 'learner'),
          curriculumId: intermediate.curriculum.id,
          expectedVersion: intermediate.curriculum.version,
          expectedContractId: contract.id,
          expectedExecutionSourceManifestFingerprint:
            intermediate.curriculum.executionSourceManifest.fingerprint,
          acceptanceBasis: 'learner_review',
        });
        return candidate;
      }
    }

    const raceProvider = new AcceptingRecoveryRaceProvider(false);
    curriculum = createCurriculumService({
      repos,
      provider: raceProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const persistedIdsBefore = repos.curricula.list('ws_1').map((item) => item.id);

    await expect(
      curriculum.propose(
        proposalRequest('curriculum-recovery-race-successor', intermediate.curriculum.id),
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });

    expect(raceProvider.evaluationInputs).toHaveLength(0);
    expect(raceProvider.repairInputs).toHaveLength(0);
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual(persistedIdsBefore);
    expect(repos.curricula.get(intermediate.curriculum.id)?.status).toBe('accepted');
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
  });

  it('keeps the local recovery evidence frontier immutable against provider-input mutation', async () => {
    const unrelatedQuote = 'Long-term memory stores durable knowledge.';
    const revisionId = repos.materialRevisions.getActive('mat_1')!.id;
    db.prepare(
      `INSERT INTO source_blocks
         (id, material_id, material_revision_id, idx, heading, heading_path,
          page_number, page_end, content, start_offset, end_offset)
       VALUES ('blk_recovery_mutation_extra', 'mat_1', ?, 1, 'Long-term memory',
               '["Long-term memory"]', NULL, NULL, ?, 0, ?)`,
    ).run(revisionId, unrelatedQuote, unrelatedQuote.length);
    const accepted = await acceptSourceOnlyCurriculum('curriculum-recovery-mutation');
    const acceptedSnapshot = structuredClone(accepted);
    const concept = addGroundedConcept('concept_recovery_mutation');
    repos.alignment.ensureBaseline('ws_1', [concept], T0);

    class MutatingRecoveryProvider extends ControlledCurriculumProvider {
      originalAllowedEvidenceIds: string[][] = [];
      injectedEvidenceId: string | null = null;

      override async proposeCurriculum(
        input: CurriculumProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<CurriculumProposalPayload> {
        const requirements = input.capabilityRecovery?.requirements;
        if (!requirements?.[0]) {
          throw new Error('The mutation regression requires a recovery capability frontier.');
        }
        this.originalAllowedEvidenceIds = requirements.map((requirement) => [
          ...requirement.allowedEvidenceIds,
        ]);
        const originalIds = new Set(this.originalAllowedEvidenceIds.flat());
        const unrelatedOffer = input.evidenceCatalog.find(
          (offer) => offer.blockId === 'blk_recovery_mutation_extra' && !originalIds.has(offer.id),
        );
        if (!unrelatedOffer) {
          throw new Error('The mutation regression requires an unrelated offered evidence ID.');
        }
        this.injectedEvidenceId = unrelatedOffer.id;
        requirements[0].allowedEvidenceIds.splice(
          0,
          requirements[0].allowedEvidenceIds.length,
          unrelatedOffer.id,
        );
        return super.proposeCurriculum(input, opts);
      }
    }

    const mutatingProvider = new MutatingRecoveryProvider();
    curriculum = createCurriculumService({
      repos,
      provider: mutatingProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    await expect(
      curriculum.propose(proposalRequest('curriculum-recovery-mutation-attempt', accepted.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      details: expect.objectContaining({
        kind: 'curriculum_capability_recovery_candidate_invalid',
        diagnosticCodes: expect.arrayContaining(['recovery_capability_evidence_outside_envelope']),
      }),
    });
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);

    const legitimateProvider = new ControlledCurriculumProvider();
    curriculum = createCurriculumService({
      repos,
      provider: legitimateProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const successor = await curriculum.propose(
      proposalRequest('curriculum-recovery-mutation-legitimate', accepted.id),
    );
    const legitimateAllowedEvidenceIds =
      legitimateProvider.lastInput?.capabilityRecovery?.requirements.map((requirement) => [
        ...requirement.allowedEvidenceIds,
      ]);
    const recoveredObjective = successor.curriculum.nodes
      .flatMap((node) => node.learningUnit?.objectives ?? [])
      .find(
        (objective) =>
          objective.semanticSupport?.capabilityPreservation?.recoveryOrigin
            ?.predecessorCurriculumId === accepted.id,
      );

    expect(legitimateAllowedEvidenceIds).toEqual(mutatingProvider.originalAllowedEvidenceIds);
    expect(legitimateAllowedEvidenceIds?.flat()).not.toContain(mutatingProvider.injectedEvidenceId);
    expect(recoveredObjective?.authoritySourceBlockIds).toEqual(['blk_1']);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
  });

  it('revalidates remediation launchability at acceptance after a Concept disappears', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-accept-gate-first'));
    const accepted = curriculum.accept({
      command: command('curriculum-accept-gate-first-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const concept = {
      id: 'concept_acceptance_gate',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    const successor = await curriculum.propose(
      proposalRequest('curriculum-accept-gate-successor', accepted.id),
    );
    const courseOverview = createCourseOverviewService({ repos, clock });
    expect(courseOverview.get('ws_1').capabilities.canAcceptCurriculum).toBe(true);
    db.prepare('DELETE FROM concepts WHERE id = ?').run(concept.id);
    expect(courseOverview.get('ws_1').capabilities.canAcceptCurriculum).toBe(false);

    expect(() =>
      curriculum.accept({
        command: command('curriculum-accept-gate-rejected', 'learner'),
        curriculumId: successor.curriculum.id,
        expectedVersion: successor.curriculum.version,
        expectedContractId: contract.id,
        expectedExecutionSourceManifestFingerprint:
          successor.curriculum.executionSourceManifest.fingerprint,
        acceptanceBasis: 'learner_review',
      }),
    ).toThrow('仍不能支持下一步学习');
    expect(repos.curricula.get(successor.curriculum.id)?.status).toBe('proposed');
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
  });

  it('reports a historically accepted recovery successor as unlaunchable before acceptance', async () => {
    const first = await curriculum.propose(
      proposalRequest('curriculum-historical-accept-gate-first'),
    );
    const accepted = curriculum.accept({
      command: command('curriculum-historical-accept-gate-first-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    repos.curricula.reject(accepted.id, 'Exercise recovery from immutable accepted history.', {
      id: 'curriculum_evt_historical_accept_gate_reject',
      eventType: 'rejected',
      actor: 'learner',
      payload: {},
      createdAt: T0,
    });
    const concept = {
      id: 'concept_historical_acceptance_gate',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    const successor = await curriculum.propose(
      proposalRequest('curriculum-historical-accept-gate-successor', accepted.id),
    );
    const courseOverview = createCourseOverviewService({ repos, clock });
    expect(courseOverview.get('ws_1').capabilities.canAcceptCurriculum).toBe(true);

    db.prepare('DELETE FROM concepts WHERE id = ?').run(concept.id);

    expect(courseOverview.get('ws_1').capabilities.canAcceptCurriculum).toBe(false);
    expect(() =>
      curriculum.accept({
        command: command('curriculum-historical-accept-gate-rejected', 'learner'),
        curriculumId: successor.curriculum.id,
        expectedVersion: successor.curriculum.version,
        expectedContractId: contract.id,
        expectedExecutionSourceManifestFingerprint:
          successor.curriculum.executionSourceManifest.fingerprint,
        acceptanceBasis: 'learner_review',
      }),
    ).toThrow('仍不能支持下一步学习');
    expect(repos.curricula.get(successor.curriculum.id)?.status).toBe('proposed');
    expect(repos.curricula.get(accepted.id)?.status).toBe('rejected');
    expect(repos.curricula.get(accepted.id)?.acceptedAt).toBe(accepted.acceptedAt);
  });

  it('deterministically rebinds zero-sidecar B7C2 recovery from selected E1 to unselected frozen E2 and accepts it', async () => {
    const title = '解释 WeKnora 综合系统定位';
    const description =
      '解释 WeKnora 是集文档系统、搜索系统、大模型、权限系统、工具调用系统于一体的综合系统，而非单纯大模型或搜索引擎。';
    const proposition = `${title}\n${description}`;
    const ingestionBlockId = 'blk_3_87594204';
    const ingestion = '入库：上传 → 解析 → 切 chunk → embedding → 写入向量库';
    const positioningBlockId = 'blk_1_706f25b9';
    const positioning =
      '### 一、概念层1. 系统定位与 RAG 全景\n\nWeKnora 不是单纯的大模型或搜索引擎，而是：文档系统 + 搜索系统 + 大模型 + 权限系统 + 工具调用系统。';
    const separator = '\n\n';
    const content = `${ingestion}${separator}${positioning}`;
    const positioningStart = ingestion.length + separator.length;
    const revisionId = 'revision_b7c2_exact_recovery';
    const heading = '系统定位与 RAG 全景';
    repos.materialRevisions.stage({
      revisionId,
      material: makeMaterial({ content, charCount: content.length, title: 'WeKnora notes' }),
      blocks: [
        makeBlock({
          id: ingestionBlockId,
          index: 0,
          heading,
          headingPath: [heading],
          content: ingestion,
          startOffset: 0,
          endOffset: ingestion.length,
        }),
        makeBlock({
          id: positioningBlockId,
          index: 1,
          heading,
          headingPath: [heading],
          content: positioning,
          startOffset: positioningStart,
          endOffset: positioningStart + positioning.length,
        }),
      ],
      originalData: null,
      parserFingerprint: 'parser_b7c2_exact_recovery',
      contentFingerprint: 'content_b7c2_exact_recovery',
      parserAttemptId: 'attempt_b7c2_exact_recovery',
      createdAt: T0,
    });
    repos.materialRevisions.activate('mat_1', revisionId, T0);

    class HistoricalB7C2Provider extends ControlledCurriculumProvider {
      constructor() {
        super();
        this.makePayload = (input) => {
          const ingestionOffer = input.evidenceCatalog.find(
            (offer) => offer.blockId === ingestionBlockId,
          );
          const positioningOffer = input.evidenceCatalog.find(
            (offer) => offer.blockId === positioningBlockId,
          );
          if (!ingestionOffer || !positioningOffer) {
            throw new Error('The historical B7C2 fixture requires both exact evidence offers.');
          }
          const payload = new ControlledCurriculumProvider().makePayload(input);
          const unit = payload.nodes[2]!;
          unit.title = title;
          unit.sourceEvidence = [ingestionOffer, positioningOffer].map((offer) => ({
            evidenceId: offer.id,
          }));
          unit.objectives = [
            {
              key: 'objective-b7c2-positioning',
              title,
              description,
              subjectClass: 'source_specific',
              scopeOrigin: 'anchored',
              construct: 'explain',
              evidence: [{ evidenceId: ingestionOffer.id }],
              priority: 'required',
              priorityRationale:
                'Historical fixture for the exact accepted B7C2 authority contradiction.',
            },
          ];
          return payload;
        };
      }

      override async evaluateObjectiveAuthoritySupport(
        input: ObjectiveAuthoritySemanticEvaluationInput,
        opts?: ProviderCallOptions,
      ): Promise<ObjectiveAuthoritySemanticEvaluationProposal> {
        if (opts?.signal?.aborted) throw ProviderError.cancelled();
        const candidate = controlledSemanticEvaluation(input, new Set());
        const validation = opts?.validateCandidate?.(candidate);
        if (validation && !validation.valid) {
          throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
        }
        return candidate;
      }
    }

    const historicalCurriculum = createCurriculumService({
      repos,
      provider: new HistoricalB7C2Provider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const historicalProposal = await historicalCurriculum.propose(
      proposalRequest('curriculum-b7c2-historical-propose'),
    );
    const predecessor = historicalCurriculum.accept({
      command: command('curriculum-b7c2-historical-accept', 'learner'),
      curriculumId: historicalProposal.curriculum.id,
      expectedVersion: historicalProposal.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        historicalProposal.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const predecessorSnapshot = structuredClone(predecessor);
    const predecessorUnit = predecessor.nodes.find((node) => node.learningUnit)!;
    const predecessorObjective = predecessorUnit.learningUnit!.objectives[0]!;
    expect(predecessorUnit.sourceReferences.map((reference) => reference.sourceBlockId)).toEqual(
      expect.arrayContaining([ingestionBlockId, positioningBlockId]),
    );
    expect(predecessorObjective).toMatchObject({
      title,
      description,
      formalAssessmentConstruct: 'explain',
      priority: 'required',
      authoritySourceBlockIds: [ingestionBlockId],
      formalEvidenceSourceBlockIds: [ingestionBlockId],
    });
    expect(predecessorObjective.semanticSupport).toBeUndefined();
    const predecessorBytes = {
      aggregate: db
        .prepare('SELECT hex(payload) AS payload FROM curriculum_versions WHERE id = ?')
        .get(predecessor.id),
      semanticSupport: db
        .prepare(
          `SELECT objective_id AS objectiveId, hex(payload) AS payload
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(predecessor.id),
    };

    const concept = addGroundedConcept(
      'concept_b7c2_exact_positioning',
      positioningBlockId,
      positioning,
    );
    repos.alignment.ensureBaseline('ws_1', [concept], T0);
    class LegacyB7C2SemanticRepairProvider extends ControlledSemanticRepairProvider {
      constructor() {
        super(false, undefined, 1);
      }

      override async proposeCurriculum(
        input: CurriculumProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<CurriculumProposalPayload> {
        const candidate = await super.proposeCurriculum(input, opts);
        if (!input.capabilityRecovery?.requirements[0]) {
          throw new Error('The legacy semantic-repair fixture requires a recovery capability.');
        }
        const ingestionOffer = input.evidenceCatalog.find(
          (offer) => offer.blockId === ingestionBlockId,
        );
        if (!ingestionOffer) {
          throw new Error('The legacy semantic-repair fixture requires the initial E1 offer.');
        }
        const unit = candidate.nodes.find((node) => node.kind === 'learning_unit')!;
        unit.sourceEvidence = [{ evidenceId: ingestionOffer.id }];
        unit.conceptIds = [concept.id];
        unit.objectives[0]!.evidence = [{ evidenceId: ingestionOffer.id }];
        this.initialPayload = structuredClone(candidate);
        return candidate;
      }

      override async evaluateObjectiveAuthoritySupport(
        input: ObjectiveAuthoritySemanticEvaluationInput,
        opts?: ProviderCallOptions,
      ): Promise<ObjectiveAuthoritySemanticEvaluationProposal> {
        this.evaluationInputs.push(structuredClone(input));
        if (opts?.signal?.aborted) throw ProviderError.cancelled();
        const candidate = controlledSemanticEvaluation(input, new Set());
        const objective = input.objectives[0]!;
        const positioningRef = objective.candidates.find(
          (offer) => offer.text === positioning,
        )?.evidenceRef;
        if (!positioningRef) {
          throw new Error('Frozen E2 was not exposed in the blind semantic candidate window.');
        }
        const evaluation = candidate.evaluations[0]!;
        evaluation.candidateLabels = objective.candidates.map((offer) => ({
          evidenceRef: offer.evidenceRef,
          relation: offer.evidenceRef === positioningRef ? 'relevant' : 'unrelated',
        }));
        evaluation.supportGroups = [
          {
            evidenceRefs: [positioningRef],
            supportType: 'relationship',
            rationale: 'The exact positioning statement supports the recovery proposition.',
          },
        ];
        if ('fragments' in evaluation) {
          evaluation.fragments = evaluation.fragments.map((fragment) => ({
            ...fragment,
            status: 'supported',
            supportType: 'relationship',
            evidenceRefs: [positioningRef],
          }));
        }
        const validation = opts?.validateCandidate?.(candidate);
        if (validation && !validation.valid) {
          throw ProviderError.invalidOutput(validation.diagnostics.join('; '), 'candidate');
        }
        return candidate;
      }
    }
    const recoveryProvider = new LegacyB7C2SemanticRepairProvider();
    const recoveryCurriculum = createCurriculumService({
      repos,
      provider: recoveryProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const successor = (
      await recoveryCurriculum.propose(
        proposalRequest('curriculum-b7c2-successor-propose', predecessor.id),
      )
    ).curriculum;
    const recoveredObjective = successor.nodes
      .flatMap((node) => node.learningUnit?.objectives ?? [])
      .find(
        (objective) =>
          objective.semanticSupport?.capabilityPreservation?.recoveryOrigin
            ?.predecessorCurriculumId === predecessor.id,
      )!;
    const preservation = recoveredObjective.semanticSupport!.capabilityPreservation!;
    expect(recoveryProvider.evaluationInputs).toHaveLength(2);
    expect(recoveryProvider.repairInputs).toHaveLength(0);
    expect(recoveryProvider.evaluationInputs[1]).toEqual(recoveryProvider.evaluationInputs[0]);
    expect(recoveredObjective).toMatchObject({
      title,
      description,
      formalAssessmentConstruct: 'explain',
      priority: 'required',
      authoritySourceBlockIds: [positioningBlockId],
      formalEvidenceSourceBlockIds: [positioningBlockId],
      semanticSupport: {
        boundSourceBlockIds: [positioningBlockId],
        validationDiagnosticCodes: ['semantic_deterministic_rebind_applied'],
        verdict: 'pass',
      },
    });
    expect([
      ...recoveredObjective.authoritySourceBlockIds,
      ...recoveredObjective.formalEvidenceSourceBlockIds,
      ...recoveredObjective.semanticSupport!.boundSourceBlockIds,
    ]).not.toContain(ingestionBlockId);
    expect(preservation).toMatchObject({
      originalProposition: proposition,
      verdict: 'pass',
      lostOriginalFragmentIds: [],
      recoveryOrigin: {
        predecessorCurriculumId: predecessor.id,
        predecessorCurriculumVersion: predecessor.version,
        predecessorLearningUnitId: predecessorUnit.id,
        predecessorObjectiveId: predecessorObjective.id,
        predecessorPriority: 'required',
        contractVersionId: contract.id,
        executionSourceManifestFingerprint: predecessor.executionSourceManifest.fingerprint,
      },
    });
    expect(preservation.recoveryOrigin!.sourceEnvelopeFingerprint.length).toBeGreaterThan(0);
    expect(preflightStudyPlan(repos, clock, contract, successor, 'Memory course').canGenerate).toBe(
      true,
    );
    expect(repos.curricula.get(successor.id)).toEqual(successor);
    expect(
      repos.curricula
        .getObjectiveSemanticSupport(successor.id)
        .find((support) => support.objectiveId === recoveredObjective.id)?.capabilityPreservation
        ?.recoveryOrigin,
    ).toEqual(preservation.recoveryOrigin);

    const acceptedSuccessor = recoveryCurriculum.accept({
      command: command('curriculum-b7c2-successor-accept', 'learner'),
      curriculumId: successor.id,
      expectedVersion: successor.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint: successor.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    expect(acceptedSuccessor.status).toBe('accepted');
    expect(repos.curricula.get(acceptedSuccessor.id)).toEqual(acceptedSuccessor);
    expect(repos.curricula.get(predecessor.id)).toEqual(predecessorSnapshot);
    expect(repos.curricula.get(predecessor.id)?.status).toBe('accepted');
    expect({
      aggregate: db
        .prepare('SELECT hex(payload) AS payload FROM curriculum_versions WHERE id = ?')
        .get(predecessor.id),
      semanticSupport: db
        .prepare(
          `SELECT objective_id AS objectiveId, hex(payload) AS payload
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(predecessor.id),
    }).toEqual(predecessorBytes);
  });

  it('fails Fake recovery before semantic repair when no exact evidence can place the predecessor capability', async () => {
    const validFakeCurriculum = createCurriculumService({
      repos,
      provider: new FakeProvider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    const first = await validFakeCurriculum.propose(
      proposalRequest('curriculum-fake-parity-first'),
    );
    const accepted = validFakeCurriculum.accept({
      command: command('curriculum-fake-parity-first-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const acceptedSnapshot = structuredClone(accepted);
    const fakeCurriculum = createCurriculumService({
      repos,
      provider: new SourceOnlyFakeProvider(),
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });
    addGroundedConcept('concept_fake_empty_frontier');

    await expect(
      fakeCurriculum.propose(proposalRequest('curriculum-fake-parity-successor', accepted.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ProviderInvalidOutput,
      message: expect.stringContaining('约定格式'),
    });
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    expect(attemptsForCommand('curriculum-fake-parity-successor')).toHaveLength(1);
  });

  it('keeps the earliest Concept prerequisite through a rejected intermediate version', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-lineage-first'));
    const accepted = curriculum.accept({
      command: command('curriculum-lineage-first-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const concept = {
      id: 'concept_rejected_intermediate',
      materialId: 'mat_1',
      name: 'Working memory',
      summary: QUOTE,
      importance: 'high' as const,
      grounding: {
        blockId: 'blk_1',
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
        occurrenceCount: 1,
        reanchored: false,
      },
      createdAt: T0,
    };
    repos.materials.addConcepts([concept]);
    const executable = await curriculum.propose(
      proposalRequest('curriculum-lineage-executable', accepted.id),
    );
    const rejected = curriculum.reject({
      command: command('curriculum-lineage-reject', 'learner'),
      curriculumId: executable.curriculum.id,
      expectedVersion: executable.curriculum.version,
      reason: 'Learner requested another proposal.',
    }).curriculum;
    db.prepare('DELETE FROM concepts WHERE id = ?').run(concept.id);

    await expect(
      curriculum.propose(proposalRequest('curriculum-lineage-source-only', rejected.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      details: expect.objectContaining({
        kind: 'curriculum_recovery_prerequisite',
        state: 'concept_grounding_missing',
        nextAction: 'build_concept_grounding',
      }),
    });
    expect(attemptsForCommand('curriculum-lineage-source-only')).toEqual([]);
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id, rejected.id]);
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
    expect(repos.curricula.get(rejected.id)?.status).toBe('rejected');
  });

  it('enforces an explicitly configured operation cap before a Curriculum provider call', async () => {
    repos.telemetry.upsertCostPolicy({
      id: 'curriculum_cost_policy',
      policyKey: 'curriculum-cost-policy',
      workspaceId: 'ws_1',
      scopeType: 'operation',
      scopeKey: 'propose_curriculum',
      limitMicrounits: 0,
      currency: 'USD',
      onExceed: 'refuse',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    await expect(curriculum.propose(proposalRequest('curriculum-cost-refused'))).rejects.toThrow(
      'does not permit another provider operation',
    );
    expect(provider.calls).toBe(0);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 0,
      physicalAttempts: 0,
    });
  });

  it('preserves an accepted Curriculum when successor generation fails', async () => {
    const proposal = proposalRequest('curriculum-first');
    const first = await curriculum.propose(proposal);
    expect(await curriculum.propose(proposal)).toEqual(first);
    expect(provider.calls).toBe(1);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
      attemptsWithKnownCost: 1,
    });
    expect(usageRowsForCommand('curriculum-first')).toBe(1);
    const acceptance = {
      command: command('curriculum-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review' as const,
    };
    const acceptedResponse = curriculum.accept(acceptance);
    expect(curriculum.accept(acceptance)).toEqual(acceptedResponse);
    const accepted = acceptedResponse.curriculum;
    addGroundedConcept('concept_provider_failure');
    provider.fail = true;

    await expect(
      curriculum.propose(proposalRequest('curriculum-successor-fails', accepted.id)),
    ).rejects.toThrow('controlled provider failure');
    expect(repos.curricula.get(accepted.id)?.status).toBe('accepted');
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
  });

  it('keeps an accepted Curriculum unchanged on one sent timeout and stores safe recovery copy', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-timeout-prior'));
    const accepted = curriculum.accept({
      command: command('curriculum-timeout-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const acceptedSnapshot = structuredClone(accepted);
    addGroundedConcept('concept_timeout');
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    const hy3 = new Hy3Provider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key-never-persist',
      model: 'test-model',
      timeoutMs: 30_000,
      fetchImpl: fetchMock,
    });
    curriculum = createCurriculumService({
      repos,
      provider: hy3,
      clock,
      commands: createCourseCommandService({ repos, clock }),
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    await expect(
      curriculum.propose(currentProposalRequest('curriculum-timeout-successor', accepted.id), {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: ApiErrorCode.ProviderTimeout,
      message: '课程结构生成时间超过预期，本次没有修改现有课程结构。你可以稍后重试。',
      details: expect.objectContaining({ kind: 'curriculum_timeout', timeoutMs: 20 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attemptsForCommand('curriculum-timeout-successor')).toMatchObject([
      { attemptNumber: 1, attemptKind: 'original', errorCode: ApiErrorCode.ProviderTimeout },
    ]);
    expect(usageRowsForCommand('curriculum-timeout-successor')).toBe(0);
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    const operation = db
      .prepare('SELECT id FROM agent_operations WHERE command_id = ?')
      .get('curriculum-timeout-successor') as { id: string };
    expect(repos.operations.getResult(operation.id)).toMatchObject({
      status: 'failed',
      payload: {
        code: ApiErrorCode.ProviderTimeout,
        message: '课程结构生成时间超过预期，本次没有修改现有课程结构。你可以稍后重试。',
      },
    });
    expect(JSON.stringify(repos.operations.getResult(operation.id))).not.toContain('fake');
  });

  it('fails closed on invalid citations and keeps acceptance expected-version safe', async () => {
    provider.makePayload = (input) => {
      const payload = new ControlledCurriculumProvider().makePayload(input);
      payload.nodes[2]!.sourceEvidence = [{ evidenceId: 'cev_outside_offered_manifest' }];
      return payload;
    };
    await expect(curriculum.propose(proposalRequest('curriculum-invalid'))).rejects.toThrow(
      '资料一致性检查',
    );
    expect(repos.curricula.list('ws_1')).toEqual([]);

    provider.makePayload = new ControlledCurriculumProvider().makePayload;
    const proposed = await curriculum.propose(proposalRequest('curriculum-valid'));
    expect(() =>
      curriculum.accept({
        command: command('curriculum-stale-accept', 'learner'),
        curriculumId: proposed.curriculum.id,
        expectedVersion: proposed.curriculum.version + 1,
        expectedContractId: contract.id,
        expectedExecutionSourceManifestFingerprint:
          proposed.curriculum.executionSourceManifest.fingerprint,
        acceptanceBasis: 'learner_review',
      }),
    ).toThrow('acceptance identity is stale');
    expect(repos.curricula.get(proposed.curriculum.id)?.status).toBe('proposed');
  });

  it('persists and accepts an ordinary Curriculum without semantic evaluation or sidecar rows', async () => {
    const semanticProvider = new ControlledSemanticRepairProvider(true);
    curriculum = createCurriculumService({
      repos,
      provider: semanticProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    const proposed = await curriculum.propose(
      proposalRequest('curriculum-formal-authority-deferred'),
    );
    const proposedObjectives = proposed.curriculum.nodes.flatMap(
      (node) => node.learningUnit?.objectives ?? [],
    );

    expect(proposedObjectives).toHaveLength(2);
    expect(proposedObjectives.every((objective) => objective.semanticSupport === undefined)).toBe(
      true,
    );
    expect(semanticProvider.evaluationInputs).toHaveLength(0);
    expect(semanticProvider.repairInputs).toHaveLength(0);
    expect(modelCallLedgerForCommand('curriculum-formal-authority-deferred')).toEqual({
      logicalCalls: 1,
      physicalAttempts: 1,
      schemaFingerprints: ['curriculum-proposal-v4-node-key-presence'],
    });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support WHERE curriculum_id = ?',
        )
        .get(proposed.curriculum.id),
    ).toEqual({ count: 0 });

    const accepted = curriculum.accept({
      command: command('curriculum-formal-authority-deferred-accept', 'learner'),
      curriculumId: proposed.curriculum.id,
      expectedVersion: proposed.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        proposed.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;

    expect(accepted.status).toBe('accepted');
    expect(
      accepted.nodes
        .flatMap((node) => node.learningUnit?.objectives ?? [])
        .every((objective) => objective.semanticSupport === undefined),
    ).toBe(true);
    expect(repos.curricula.getObjectiveSemanticSupport(accepted.id)).toEqual([]);
  });
  it('bounds failed semantic repair to one call and leaves the accepted predecessor byte-identical', async () => {
    const predecessorProposal = await curriculum.propose(
      proposalRequest('curriculum-objective-repair-predecessor'),
    );
    const predecessor = curriculum.accept({
      command: command('curriculum-objective-repair-predecessor-accept', 'learner'),
      curriculumId: predecessorProposal.curriculum.id,
      expectedVersion: predecessorProposal.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        predecessorProposal.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const predecessorSnapshot = structuredClone(predecessor);
    addGroundedConcept('concept_failed_objective_repair');
    const semanticProvider = new ControlledSemanticRepairProvider(true);
    curriculum = createCurriculumService({
      repos,
      provider: semanticProvider,
      clock,
      commands,
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    await expect(
      curriculum.propose(
        currentProposalRequest('curriculum-objective-repair-exhausted', predecessor.id),
      ),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      details: {
        kind: 'objective_authority_semantic_support_failed',
        repairAttempted: true,
      },
    });

    expect(semanticProvider.evaluationInputs).toHaveLength(2);
    expect(semanticProvider.repairInputs).toHaveLength(
      CURRICULUM_MAX_OBJECTIVE_AUTHORITY_REPAIR_CALLS,
    );
    expect(modelCallLedgerForCommand('curriculum-objective-repair-exhausted')).toEqual({
      logicalCalls: 4,
      physicalAttempts: 4,
      schemaFingerprints: [
        'curriculum-proposal-v4-node-key-presence',
        'objective-authority-semantic-evaluation-v4',
        'objective-authority-semantic-repair-v2-claim-scope',
        'objective-authority-semantic-evaluation-v4',
      ],
    });
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([predecessor.id]);
    expect(repos.curricula.get(predecessor.id)).toEqual(predecessorSnapshot);
  });

  it('repairs a schema-valid invalid evidence selection once and persists only the repaired candidate', async () => {
    const invalid = payloadForFetch('cev_not_offered');
    const valid = payloadForFetch();
    const fetchMock = useMockedHy3([JSON.stringify(invalid), JSON.stringify(valid)]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-semantic-repair'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proposed.curriculum.validation.valid).toBe(true);
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
    expect(attemptsForCommand('curriculum-semantic-repair')).toMatchObject([
      {
        attemptKind: 'original',
        status: 'completed',
        errorCode: 'SEMANTIC_VALIDATION_FAILURE_REPAIR_REQUIRED',
      },
      { attemptKind: 'repair', status: 'completed' },
    ]);
    expect(repos.telemetry.usageSummary('ws_1')).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 2,
      attemptsWithKnownCost: 0,
    });
    expect(usageRowsForCommand('curriculum-semantic-repair')).toBe(2);
  });

  it('fails after one semantic repair, preserves the accepted Curriculum, and persists safe details', async () => {
    const first = await curriculum.propose(proposalRequest('curriculum-prior-valid'));
    const accepted = curriculum.accept({
      command: command('curriculum-prior-accept', 'learner'),
      curriculumId: first.curriculum.id,
      expectedVersion: first.curriculum.version,
      expectedContractId: contract.id,
      expectedExecutionSourceManifestFingerprint:
        first.curriculum.executionSourceManifest.fingerprint,
      acceptanceBasis: 'learner_review',
    }).curriculum;
    const acceptedSnapshot = structuredClone(accepted);
    const executionSnapshot = structuredClone(repos.courseExecution.get('ws_1'));
    addGroundedConcept('concept_semantic_repair_failure');
    const invalid = payloadForFetch('cev_still_not_offered');
    const fetchMock = useMockedHy3([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      curriculum.propose(currentProposalRequest('curriculum-semantic-repair-fails', accepted.id)),
    ).rejects.toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      message: expect.stringContaining('原版本未改变。系统已尝试一次修复。'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attemptsForCommand('curriculum-semantic-repair-fails')).toHaveLength(2);
    expect(usageRowsForCommand('curriculum-semantic-repair-fails')).toBe(2);
    expect(repos.curricula.list('ws_1').map((item) => item.id)).toEqual([accepted.id]);
    expect(repos.curricula.get(accepted.id)).toEqual(acceptedSnapshot);
    expect(repos.courseExecution.get('ws_1')).toEqual(executionSnapshot);
    const operation = db
      .prepare(`SELECT id FROM agent_operations WHERE command_id = ?`)
      .get('curriculum-semantic-repair-fails') as { id: string };
    const result = repos.operations.getResult(operation.id);
    expect(result).toMatchObject({
      status: 'failed',
      payload: {
        code: ApiErrorCode.GroundingFailed,
        details: {
          kind: 'curriculum_candidate_validation',
          repairAttempted: true,
          errors: expect.arrayContaining([
            expect.stringContaining('offered Curriculum evidence ID'),
          ]),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('test-key-never-persist');
  });

  it('uses independent schema and candidate repairs in one bounded Curriculum call', async () => {
    const invalidCandidate = payloadForFetch('cev_not_offered_after_schema_repair');
    const fetchMock = useMockedHy3([
      '{}',
      JSON.stringify(invalidCandidate),
      JSON.stringify(payloadForFetch()),
    ]);

    const proposed = await curriculum.propose(proposalRequest('curriculum-schema-then-semantic'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(proposed.curriculum.validation.valid).toBe(true);
    expect(attemptsForCommand('curriculum-schema-then-semantic')).toMatchObject([
      { attemptKind: 'original', errorCode: 'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED' },
      { attemptKind: 'repair', errorCode: 'SEMANTIC_VALIDATION_FAILURE_REPAIR_REQUIRED' },
      { attemptKind: 'repair', status: 'completed' },
    ]);
    expect(usageRowsForCommand('curriculum-schema-then-semantic')).toBe(3);
    expect(repos.curricula.list('ws_1')).toHaveLength(1);
  });

  it('does not ask the model to repair an authoritative manifest change', async () => {
    const invalid = payloadForFetch('cev_not_offered_during_authority_race');
    const fetchMock = useMockedHy3([JSON.stringify(invalid)], (index) => {
      if (index !== 0) return;
      const content = `${QUOTE} Updated.`;
      repos.materialRevisions.stage({
        revisionId: 'revision-during-provider-call',
        material: makeMaterial({ content, charCount: content.length, title: 'Memory notes' }),
        blocks: [
          makeBlock({
            id: 'blk_during_provider_call',
            content,
            startOffset: 0,
            endOffset: content.length,
          }),
        ],
        originalData: null,
        parserFingerprint: 'parser-during-provider-call',
        contentFingerprint: 'content-during-provider-call',
        parserAttemptId: 'attempt-during-provider-call',
        createdAt: T0,
      });
      repos.materialRevisions.activate('mat_1', 'revision-during-provider-call', T0);
    });

    await expect(
      curriculum.propose(proposalRequest('curriculum-authority-race')),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attemptsForCommand('curriculum-authority-race')).toHaveLength(1);
    expect(repos.curricula.list('ws_1')).toEqual([]);
  });

  it('keeps ownership through a bounded Curriculum repair crossing five minutes', async () => {
    let nowMs = Date.parse(T0);
    const timedClock: Clock = { now: () => new Date(nowMs) };
    class TimedRepairProvider extends ControlledCurriculumProvider {
      override async proposeCurriculum(
        input: CurriculumProposalInput,
        opts?: ProviderCallOptions,
      ): Promise<CurriculumProposalPayload> {
        this.calls += 1;
        this.lastInput = input;
        nowMs = Date.parse(T0) + 4 * 60 * 1000;
        opts?.onRepairAttempt?.('candidate');
        nowMs = Date.parse(T0) + 6 * 60 * 1000;
        return this.makePayload(input);
      }
    }
    curriculum = createCurriculumService({
      repos,
      provider: new TimedRepairProvider(),
      clock: timedClock,
      commands: createCourseCommandService({ repos, clock: timedClock }),
      sourceAuthority: createSourceAuthorityService({
        sourceAuthority: repos.sourceAuthority,
        clock: timedClock,
      }),
      generationPolicy: LEGACY_CURRICULUM_GENERATION_POLICY,
    });

    const proposed = await curriculum.propose(proposalRequest('curriculum-long-repair'));
    const operation = db
      .prepare(
        `SELECT id, lease_expires_at AS leaseExpiresAt FROM agent_operations WHERE command_id = ?`,
      )
      .get('curriculum-long-repair') as { id: string; leaseExpiresAt: string | null };

    expect(curriculumOperationLeaseMs(240_000, LEGACY_CURRICULUM_GENERATION_POLICY)).toBe(
      218 * 60 * 1000,
    );
    expect(proposed.curriculum.status).toBe('proposed');
    expect(attemptsForCommand('curriculum-long-repair')).toHaveLength(2);
    expect(operation.leaseExpiresAt).toBeNull();
    expect(repos.operations.getResult(operation.id)?.status).toBe('completed');
  });
});
