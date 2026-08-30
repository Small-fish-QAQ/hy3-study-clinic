import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASSESSMENT_INTENT_POLICY_VERSION,
  RepairDiagnosticCategorySchema,
  repairCheckIntentLadderFor,
  repairInterventionFor,
  repairInterventionLadderFor,
  selectRepairDifferentiation,
  type GradeRecord,
} from '@hy3-clinic/shared';
import { INTERVENTION_LABELS } from './learnerAssessments.js';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider, type FakeRepairFixture } from '../llm/fakeProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { fixedClock } from '../util/ids.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import {
  createRepairService,
  diagnosisFromGrade,
  repairDifferentiationContext,
  validateRepairDifferentiation,
} from './repair.js';

const item = (id: string, targetLearningUnitId = 'unit_1', materialRevisionId = 'revision_1') => ({
  id,
  index: 0,
  targetLearningUnitId,
  targetObjectiveId: 'objective_1',
  questionType: 'short_answer' as const,
  prompt: 'Explain why working memory is limited.',
  rubric: [
    {
      id: 'criterion_1',
      text: 'States the capacity limit',
      required: true,
      sourceBindingIds: ['block_1'],
    },
  ],
  sourceBindings: [
    {
      materialId: 'material_1',
      materialRevisionId,
      sourceBlockId: 'block_1',
      quote: 'Working memory is limited.',
      contentOrigin: 'extracted_original' as const,
      authoritative: true,
    },
  ],
  formalEligible: true,
  policyReason: 'FORMAL_ELIGIBLE' as const,
});

function grade(overrides: Partial<GradeRecord> = {}): GradeRecord {
  return {
    id: 'grade_1',
    attemptId: 'attempt_1',
    assessmentVersionId: 'version_1',
    grader: 'fake',
    rubricVersion: 'rubric-v1',
    status: 'current',
    judgment: {
      score: 0.5,
      criterionResults: [{ criterionId: 'criterion_1', result: 'partial' }],
      feedback: 'Partial.',
    },
    supersedesId: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('diagnostic Repair orchestration', () => {
  let db: SqliteDb;
  let repos: Repositories;
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.workspaces.insert(makeWorkspace());
    repos.formalAssessments.insertDefinition({
      id: 'definition_1',
      workspaceId: 'ws_1',
      logicalKey: 'check',
      title: 'Check',
      createdAt: T0,
      updatedAt: T0,
    });
    repos.formalAssessments.insertVersion({
      id: 'version_1',
      definitionId: 'definition_1',
      version: 1,
      predecessorId: null,
      status: 'accepted',
      items: [item('item_1')],
      sourceRevisionIds: ['revision_1'],
      createdAt: T0,
      acceptedAt: T0,
    });
    repos.formalAssessments.insertAttempt({
      id: 'attempt_1',
      assessmentVersionId: 'version_1',
      workspaceId: 'ws_1',
      ordinal: 1,
      status: 'submitted',
      responses: { item_1: 'Some answer' },
      startedAt: T0,
      submittedAt: T0,
      cancelledAt: null,
    });
  });
  afterEach(() => db.close());

  it('does not overreact to a semantic pass with a harmless surface slip', () => {
    expect(
      diagnosisFromGrade(
        grade({
          judgment: {
            score: 1,
            criterionResults: [{ criterionId: 'criterion_1', result: 'met' }],
            feedback: 'Correct; minor spelling slip.',
            diagnostic: {
              category: 'SURFACE_SLIP',
              affectedCriterionIds: [],
              summary: 'Minor spelling slip.',
              uncertainty: 0,
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it('does not excuse a failed proposition as a surface slip', () => {
    expect(
      diagnosisFromGrade(
        grade({
          judgment: {
            score: 0,
            criterionResults: [{ criterionId: 'criterion_1', result: 'not_met' }],
            feedback: 'The relation is reversed.',
            diagnostic: {
              category: 'SURFACE_SLIP',
              affectedCriterionIds: ['criterion_1'],
              summary: 'Possible typo.',
              uncertainty: 0,
            },
          },
        }),
      )?.category,
    ).toBe('UNCERTAIN');
  });

  it('creates one durable episode and keeps practice non-credit', () => {
    repos.formalAssessments.insertGrade(grade());
    const service = createRepairService({
      repos,
      provider: new FakeProvider(),
      clock: fixedClock(T0),
    });
    const episode = service.createForGrade('grade_1')!;
    expect(service.createForGrade('grade_1')?.id).toBe(episode.id);
    service.recordPractice(episode.id, 'A practice response', 'READY_FOR_VERIFICATION');
    expect(repos.formalAssessments.listEvidenceForGrade('grade_1')).toHaveLength(0);
    expect(service.get(episode.id).status).toBe('ACTIVE');
    repos.repair.insertPacket({
      id: 'packet_1',
      episodeId: episode.id,
      generationKey: 'generation_1',
      provider: 'fake',
      providerModel: null,
      interventionMode: 'TARGETED_PROMPT',
      explanation: 'Add the missing idea.',
      practicePrompt: 'Try a nearby example.',
      hints: [],
      sourceBlockIds: ['block_1'],
      targetLearningUnitId: 'unit_1',
      createdAt: T0,
    });
    expect(() =>
      db.prepare("UPDATE repair_packets SET provider = 'hy3' WHERE id = 'packet_1'").run(),
    ).toThrow(/immutable/);
  });

  it('requires supported evidence from a distinct linked verification', () => {
    repos.formalAssessments.insertGrade(grade());
    const service = createRepairService({
      repos,
      provider: new FakeProvider(),
      clock: fixedClock(T0),
    });
    const episode = service.createForGrade('grade_1')!;
    service.resume(service.defer(episode.id).id);
    service.markAwaitingVerification(episode.id);
    expect(() => service.linkVerificationAttempt(episode.id, 'attempt_1')).toThrow(
      /fresh formal assessment/,
    );

    repos.formalAssessments.insertVersion({
      id: 'version_2',
      definitionId: 'definition_1',
      version: 2,
      predecessorId: 'version_1',
      status: 'accepted',
      items: [item('item_2')],
      sourceRevisionIds: ['revision_1'],
      createdAt: T0,
      acceptedAt: T0,
    });
    repos.formalAssessments.insertAttempt({
      id: 'attempt_2',
      assessmentVersionId: 'version_2',
      workspaceId: 'ws_1',
      ordinal: 1,
      status: 'submitted',
      responses: { item_2: 'A complete answer' },
      startedAt: T0,
      submittedAt: T0,
      cancelledAt: null,
    });
    repos.formalAssessments.insertGrade(
      grade({
        id: 'grade_2',
        attemptId: 'attempt_2',
        assessmentVersionId: 'version_2',
        judgment: {
          score: 1,
          criterionResults: [{ criterionId: 'criterion_1', result: 'met' }],
          feedback: 'Correct.',
        },
      }),
    );
    repos.formalAssessments.insertEvidence({
      id: 'evidence_2',
      attemptId: 'attempt_2',
      gradeRecordId: 'grade_2',
      assessmentVersionId: 'version_2',
      itemId: 'item_2',
      targetLearningUnitId: 'unit_1',
      conclusion: 'supported',
      policyVersion: 'formal-assessment-evidence-v1',
      sourceBindingIds: ['block_1'],
      createdAt: T0,
    });
    service.linkVerificationAttempt(episode.id, 'attempt_2');
    expect(service.resolveFromEvidence(episode.id, 'evidence_2').status).toBe('RESOLVED');
    expect(service.get(episode.id).resolvedEvidenceId).toBe('evidence_2');
  });

  it('bounds repeated verification failures and defers for deeper support', () => {
    repos.formalAssessments.insertGrade(grade());
    const service = createRepairService({
      repos,
      provider: new FakeProvider(),
      clock: fixedClock(T0),
    });
    const episode = service.createForGrade('grade_1')!;
    service.resume(service.defer(episode.id).id);
    for (let count = 0; count < 3; count++) {
      service.markAwaitingVerification(episode.id);
      service.recordVerificationFailure(episode.id);
    }
    expect(service.get(episode.id)).toMatchObject({ status: 'DEFERRED', attemptCount: 3 });
  });
});

describe('differentiated Repair remediation', () => {
  let db: SqliteDb;
  let repos: Repositories;
  /** The revision `insertWithBlocks` activates; packet generation must match it. */
  let revisionId: string;

  const setupTargets = () => {
    repos.formalAssessments.insertDefinition({
      id: 'definition_1',
      workspaceId: 'ws_1',
      logicalKey: 'check',
      title: 'Check',
      createdAt: T0,
      updatedAt: T0,
    });
    repos.formalAssessments.insertVersion({
      id: 'version_1',
      definitionId: 'definition_1',
      version: 1,
      predecessorId: null,
      status: 'accepted',
      items: [item('item_1', 'unit_1', revisionId)],
      sourceRevisionIds: [revisionId],
      createdAt: T0,
      acceptedAt: T0,
    });
    repos.formalAssessments.insertAttempt({
      id: 'attempt_1',
      assessmentVersionId: 'version_1',
      workspaceId: 'ws_1',
      ordinal: 1,
      status: 'submitted',
      responses: { item_1: 'Some answer' },
      startedAt: T0,
      submittedAt: T0,
      cancelledAt: null,
    });
  };

  const service = (fixture?: FakeRepairFixture) =>
    createRepairService({
      repos,
      provider: new FakeProvider(fixture ? { repairFixture: fixture } : {}),
      clock: fixedClock(T0),
    });

  /** Advance to the next remediation round exactly as a failed check does. */
  const failVerification = (id: string) => {
    const svc = service();
    svc.markAwaitingVerification(id);
    svc.recordVerificationFailure(id);
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.workspaces.insert(makeWorkspace());
    repos.materials.insertWithBlocks(makeMaterial({ id: 'material_1' }), [
      makeBlock({ id: 'block_1', materialId: 'material_1' }),
    ]);
    // generatePacket refuses to persist against a stale source revision, so the
    // item bindings must name whichever revision the insert activated.
    revisionId = repos.materialRevisions.getActive('material_1')!.id;
    setupTargets();
    repos.formalAssessments.insertGrade(grade());
  });
  afterEach(() => db.close());

  it('T1/T18 generates ordinary first-time remediation with no history', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const packet = await svc.generatePacket(episode.id);
    // Unchanged from the pre-differentiation mapping for this diagnosis.
    expect(packet.interventionMode).toBe(repairInterventionFor(episode.diagnosticCategory));
    expect(packet.checkIntent).toBe(repairCheckIntentLadderFor(episode.diagnosticCategory)[0]);
    expect(packet.attemptOrdinal).toBe(0);
  });

  it('T2/T3 carries prior strategy and intent history into the next request', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    failVerification(episode.id);

    const seen: Array<{
      priorInterventionModes: readonly string[];
      priorCheckIntents: readonly string[];
      priorCheckPrompts: readonly string[];
    }> = [];
    const spy = new FakeProvider();
    const original = spy.generateRepair.bind(spy);
    spy.generateRepair = async (input, opts) => {
      seen.push({
        priorInterventionModes: input.priorInterventionModes,
        priorCheckIntents: input.priorCheckIntents,
        priorCheckPrompts: input.priorCheckPrompts,
      });
      return original(input, opts);
    };
    await createRepairService({ repos, provider: spy, clock: fixedClock(T0) }).generatePacket(
      episode.id,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.priorInterventionModes).toContain(first.interventionMode);
    expect(seen[0]!.priorCheckIntents).toContain(first.checkIntent);
    expect(seen[0]!.priorCheckPrompts).toContain(first.practicePrompt);
  });

  it('T5/T7 accepts a different strategy and intent on the next round', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    failVerification(episode.id);
    const second = await service().generatePacket(episode.id);

    expect(second.id).not.toBe(first.id);
    expect(second.interventionMode).not.toBe(first.interventionMode);
    expect(second.checkIntent).not.toBe(first.checkIntent);
    expect(second.practicePrompt).not.toBe(first.practicePrompt);
    expect(second.attemptOrdinal).toBe(1);
  });

  it('T4/A21C rejects the same strategy when an alternative exists, then repairs', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    failVerification(episode.id);

    // Adversarial C: different wording, same pedagogical strategy.
    const repaired = await service('repeated_strategy_once').generatePacket(episode.id);
    expect(repaired.interventionMode).not.toBe(first.interventionMode);

    failVerification(episode.id);
    await expect(
      service('repeated_strategy_exhausted').generatePacket(episode.id),
    ).rejects.toThrow();
  });

  it('T6/A21A rejects the same assessment intent when an alternative exists', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    failVerification(episode.id);

    // Adversarial A: same intent, rewritten wording.
    const repaired = await service('repeated_intent_once').generatePacket(episode.id);
    expect(repaired.checkIntent).not.toBe(first.checkIntent);

    failVerification(episode.id);
    await expect(service('repeated_intent_exhausted').generatePacket(episode.id)).rejects.toThrow();
  });

  it('T9/A21B rejects a repeated concrete check even under a new intent label', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    await svc.generatePacket(episode.id);
    failVerification(episode.id);
    // repeated_prompt_* keeps the correct typed labels and replays the earlier
    // prompt verbatim, so only the structural fence can catch it.
    await expect(service('repeated_prompt_exhausted').generatePacket(episode.id)).rejects.toThrow();
  });

  it('T14 bounds repair to one attempt and fails closed', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    await svc.generatePacket(episode.id);
    failVerification(episode.id);

    let repairs = 0;
    const provider = new FakeProvider({ repairFixture: 'repeated_strategy_exhausted' });
    const inner = provider.generateRepair.bind(provider);
    provider.generateRepair = (input, opts) =>
      inner(input, { ...opts, onRepairAttempt: () => repairs++ });
    await expect(
      createRepairService({ repos, provider, clock: fixedClock(T0) }).generatePacket(episode.id),
    ).rejects.toThrow();
    expect(repairs).toBe(1);
  });

  it('T10 rejected remediation leaves the episode and its packets untouched', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    failVerification(episode.id);
    const before = svc.get(episode.id);

    await expect(
      service('repeated_strategy_exhausted').generatePacket(episode.id),
    ).rejects.toThrow();

    expect(svc.get(episode.id)).toEqual(before);
    // The already-valid packet survives; nothing was overwritten.
    const packets = repos.repair.listPackets(episode.id);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.id).toBe(first.id);
    expect(repos.formalAssessments.listEvidenceForGrade('grade_1')).toHaveLength(0);
  });

  it('T11/T12 accepted generation creates no evidence and no mastery movement', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const masteryBefore = repos.mastery.listByMaterial('material_1');
    await svc.generatePacket(episode.id);
    failVerification(episode.id);
    await service().generatePacket(episode.id);

    expect(repos.formalAssessments.listEvidenceForGrade('grade_1')).toHaveLength(0);
    expect(repos.repair.getEpisode(episode.id)!.resolvedEvidenceId).toBeNull();
    expect(svc.get(episode.id).status).not.toBe('RESOLVED');
    expect(repos.mastery.listByMaterial('material_1')).toEqual(masteryBefore);
  });

  it('T13 remediation alone never closes the episode; only fresh evidence does', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    await svc.generatePacket(episode.id);
    failVerification(episode.id);
    await service().generatePacket(episode.id);
    expect(svc.get(episode.id).status).toBe('ACTIVE');
    expect(() => svc.resolveFromEvidence(episode.id, 'evidence_missing')).toThrow(
      /supported evidence/,
    );
  });

  it('T15 a stale response cannot overwrite the newer accepted packet', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    const first = await svc.generatePacket(episode.id);
    // Same round, repeated call: idempotent, returns the same packet rather
    // than laddering onto its own output or writing a second row.
    const again = await service().generatePacket(episode.id);
    expect(again.id).toBe(first.id);
    expect(again.generationKey).toBe(first.generationKey);
    expect(repos.repair.listPackets(episode.id)).toHaveLength(1);

    // A late writer replaying the earlier generation key cannot mutate it.
    expect(() =>
      db.prepare("UPDATE repair_packets SET payload = '{}' WHERE id = ?").run(first.id),
    ).toThrow(/immutable/);
  });

  it('T16/A21F reads same-target intents and ignores a sibling target', () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;

    // Two accepted versions: one on this episode's target, one on a sibling.
    // `transfer` + transfer_context_missing is the pairing the existing
    // AssessmentItemIntent invariant permits, so these rows are realistic.
    const addIntent = (
      versionId: string,
      itemId: string,
      unit: string,
      intentId: string,
      version: number,
    ) => {
      repos.formalAssessments.insertVersion({
        id: versionId,
        definitionId: 'definition_1',
        version,
        predecessorId: 'version_1',
        status: 'accepted',
        items: [item(itemId, unit, revisionId)],
        sourceRevisionIds: [revisionId],
        createdAt: T0,
        acceptedAt: T0,
      });
      db.prepare(
        `INSERT INTO assessment_item_intents (
          id, workspace_id, assessment_version_id, item_id, assessment_stage,
          policy_version, requested_challenge_family, requested_representation,
          selection_reason, created_at
        ) VALUES (?, 'ws_1', ?, ?, 'targeted_repair', ?, 'transfer', 'application',
                  'transfer_context_missing', ?)`,
      ).run(intentId, versionId, itemId, ASSESSMENT_INTENT_POLICY_VERSION, T0);
    };

    addIntent('version_sibling', 'item_sibling', 'unit_other', 'intent_sibling', 2);
    let history = repairDifferentiationContext({ repos, episode: svc.get(episode.id) });
    expect(history.priorCheckIntents).not.toContain('transfer');

    // The same intent on THIS target must be seen, proving the filter is a
    // target scope and not a blanket exclusion.
    addIntent('version_same', 'item_same', 'unit_1', 'intent_same', 3);
    history = repairDifferentiationContext({ repos, episode: svc.get(episode.id) });
    expect(history.priorCheckIntents).toContain('transfer');
  });

  it('T16 bounds the history window instead of replaying the whole course', async () => {
    const svc = service();
    const episode = svc.createForGrade('grade_1')!;
    await svc.generatePacket(episode.id);
    for (let n = 0; n < 8; n++) {
      repos.repair.insertPacket({
        id: `packet_hist_${n}`,
        episodeId: episode.id,
        generationKey: `key_hist_${n}`,
        provider: 'fake',
        providerModel: null,
        interventionMode: 'TARGETED_PROMPT',
        checkIntent: 'discriminative_follow_up',
        attemptOrdinal: 0,
        explanation: `Earlier explanation ${n}.`,
        practicePrompt: `Earlier check ${n}.`,
        hints: [],
        sourceBlockIds: ['block_1'],
        targetLearningUnitId: 'unit_1',
        createdAt: T0,
      });
    }
    failVerification(episode.id);
    const history = repairDifferentiationContext({ repos, episode: svc.get(episode.id) });
    expect(history.priorCheckPrompts.length).toBeLessThanOrEqual(4);
  });

  it('T19/§18 gives every reachable strategy its own learner-facing wording', () => {
    // A strategy change must be visible as different language, not internal
    // taxonomy. Every mode any ladder can reach needs a distinct label.
    const reachable = new Set(
      RepairDiagnosticCategorySchema.options.flatMap((category) => [
        ...repairInterventionLadderFor(category),
      ]),
    );
    const labels = [...reachable].map((mode) => {
      const label = INTERVENTION_LABELS[mode];
      expect(label, `no learner wording for ${mode}`).toBeTruthy();
      // Internal taxonomy must not leak into learner copy.
      expect(label).not.toContain(mode);
      return label;
    });
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('T8/A21E falls back rather than dead-ending when no alternative intent exists', () => {
    // SURFACE_SLIP has one legitimate intent. Exhausting it must not block
    // remediation; the strategy axis carries the differentiation instead.
    const requirement = selectRepairDifferentiation({
      category: 'SURFACE_SLIP',
      priorInterventionModes: ['NOTICE'],
      priorCheckIntents: ['discriminative_follow_up'],
    });
    expect(requirement.checkIntentLadderExhausted).toBe(true);
    expect(requirement.requiredCheckIntent).toBe('discriminative_follow_up');
    expect(requirement.requiredInterventionMode).not.toBe('NOTICE');

    // Same broad intent is permitted here, and the structural fence still runs.
    const accepted = validateRepairDifferentiation({
      requirement,
      history: {
        priorInterventionModes: ['NOTICE'],
        priorCheckIntents: ['discriminative_follow_up'],
        priorCheckPrompts: ['Name the capacity limit of working memory.'],
      },
      candidate: {
        interventionMode: requirement.requiredInterventionMode,
        checkIntent: 'discriminative_follow_up',
        practicePrompt: 'Give the boundary where this stops holding, and say why.',
      },
      failedPrompt: 'Explain why working memory is limited.',
    });
    expect(accepted.diagnostics).toEqual([]);

    const repeated = validateRepairDifferentiation({
      requirement,
      history: {
        priorInterventionModes: ['NOTICE'],
        priorCheckIntents: ['discriminative_follow_up'],
        priorCheckPrompts: ['Name the capacity limit of working memory.'],
      },
      candidate: {
        interventionMode: requirement.requiredInterventionMode,
        checkIntent: 'discriminative_follow_up',
        practicePrompt: 'Name the capacity limit of working memory.',
      },
      failedPrompt: 'Explain why working memory is limited.',
    });
    expect(repeated.diagnosticCodes).toContain('repair_check_prompt_repeated');
  });

  it('A21D rejects a permitted strategy paired with an unrequested intent', () => {
    const requirement = selectRepairDifferentiation({
      category: 'LOCAL_MISCONCEPTION',
      priorInterventionModes: ['CONTRAST'],
      priorCheckIntents: ['historical_misconception'],
    });
    const finding = validateRepairDifferentiation({
      requirement,
      history: {
        priorInterventionModes: ['CONTRAST'],
        priorCheckIntents: ['historical_misconception'],
        priorCheckPrompts: ['Contrast the two relations.'],
      },
      candidate: {
        interventionMode: requirement.requiredInterventionMode,
        // Not the requested intent, and not on this diagnosis's ladder.
        checkIntent: 'cross_learning_unit_synthesis',
        practicePrompt: 'Link this to a different unit entirely.',
      },
      failedPrompt: 'Explain the relation.',
    });
    expect(finding.diagnosticCodes).toContain('repair_check_intent_mismatch');
  });

  it('a provider claim of novelty cannot substitute for the typed contract', () => {
    const requirement = selectRepairDifferentiation({
      category: 'LOCAL_MISCONCEPTION',
      priorInterventionModes: ['CONTRAST'],
      priorCheckIntents: ['historical_misconception'],
    });
    const history = {
      priorInterventionModes: ['CONTRAST' as const],
      priorCheckIntents: ['historical_misconception' as const],
      priorCheckPrompts: ['Explain why working memory is limited.'],
    };
    // Asserting novelty in prose while repeating both typed axes is rejected on
    // the typed axes; the claim itself carries no weight.
    const attested = validateRepairDifferentiation({
      requirement,
      history,
      candidate: {
        interventionMode: 'CONTRAST',
        checkIntent: 'historical_misconception',
        practicePrompt: 'A genuinely new approach: contrast the two relations again.',
      },
      failedPrompt: 'Explain why working memory is limited.',
    });
    expect(attested.diagnosticCodes).toContain('repair_intervention_mode_mismatch');
    expect(attested.diagnosticCodes).toContain('repair_check_intent_mismatch');
  });

  it('catches verbatim check replay but does not claim paraphrase detection', () => {
    const requirement = selectRepairDifferentiation({
      category: 'LOCAL_MISCONCEPTION',
      priorInterventionModes: [],
      priorCheckIntents: [],
    });
    const failedPrompt = 'Explain why working memory is limited.';
    const check = (practicePrompt: string) =>
      validateRepairDifferentiation({
        requirement,
        history: { priorInterventionModes: [], priorCheckIntents: [], priorCheckPrompts: [] },
        candidate: {
          interventionMode: requirement.requiredInterventionMode,
          checkIntent: requirement.requiredCheckIntent,
          practicePrompt,
        },
        failedPrompt,
      }).diagnosticCodes;

    // Verbatim and near-verbatim replay are caught.
    expect(check(failedPrompt)).toContain('repair_check_prompt_repeated');
    expect(check(`Now: ${failedPrompt}`)).toContain('repair_check_prompt_repeated');

    // A padded replay is NOT caught. This is the documented limit of a lexical
    // novelty fence, asserted here so the guarantee is not overstated: typed
    // strategy/intent differentiation is enforced, semantic paraphrase is not.
    expect(check(`This is a completely different question. ${failedPrompt}`)).not.toContain(
      'repair_check_prompt_repeated',
    );
  });
});

describe('Fake Repair provider contract', () => {
  const input = {
    targetLearningUnitId: 'unit_1',
    diagnosticCategory: 'INCOMPLETE_EXPRESSION' as const,
    requiredInterventionMode: 'TARGETED_PROMPT' as const,
    requiredCheckIntent: 'discriminative_follow_up' as const,
    gapSummary: 'The response omitted one required idea.',
    affectedCriteria: ['States the capacity limit'],
    sourceContext: [{ blockId: 'block_1', quote: 'Working memory is limited.' }],
    failedPrompt: 'Explain working memory.',
    priorInterventionModes: [],
    priorCheckIntents: [],
    priorCheckPrompts: [],
  };
  const validateCandidate = (candidate: unknown) => ({
    valid: (candidate as { interventionMode?: string }).interventionMode === 'TARGETED_PROMPT',
    diagnostics: ['Use the minimum sufficient intervention.'],
  });

  it('uses one normal request and at most one semantic repair', async () => {
    let repairs = 0;
    await expect(
      new FakeProvider({ repairFixture: 'repair_once' }).generateRepair(input, {
        validateCandidate,
        onRepairAttempt: () => repairs++,
      }),
    ).resolves.toMatchObject({ interventionMode: 'TARGETED_PROMPT' });
    expect(repairs).toBe(1);
  });

  it('fails after repair exhaustion and does not blind-retry cancellation', async () => {
    await expect(
      new FakeProvider({ repairFixture: 'repair_exhausted' }).generateRepair(input, {
        validateCandidate,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    const controller = new AbortController();
    controller.abort();
    let repairs = 0;
    await expect(
      new FakeProvider().generateRepair(input, {
        signal: controller.signal,
        onRepairAttempt: () => repairs++,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(repairs).toBe(0);
  });

  it('repairs an exact wrong intervention mode and preserves the local mapping', async () => {
    let repairs = 0;
    const payload = await new FakeProvider({ repairFixture: 'wrong_mode_once' }).generateRepair(
      {
        ...input,
        diagnosticCategory: 'RELATION_REVERSAL',
        requiredInterventionMode: 'CONTRAST',
      },
      {
        validateCandidate: (candidate) => {
          const value = candidate as { diagnosticCategory?: unknown; interventionMode?: unknown };
          const diagnostics: string[] = [];
          if (value.diagnosticCategory !== 'RELATION_REVERSAL') {
            diagnostics.push(
              'diagnosticCategory mismatch: returned value, required RELATION_REVERSAL.',
            );
          }
          if (value.interventionMode !== 'CONTRAST') {
            diagnostics.push(
              'interventionMode mismatch: returned value, required CONTRAST for RELATION_REVERSAL.',
            );
          }
          return { valid: diagnostics.length === 0, diagnostics };
        },
        onRepairAttempt: () => repairs++,
      },
    );
    expect(payload).toMatchObject({
      diagnosticCategory: 'RELATION_REVERSAL',
      interventionMode: 'CONTRAST',
    });
    expect(repairs).toBe(1);
  });

  it('fails closed when the wrong intervention mode remains after one repair', async () => {
    await expect(
      new FakeProvider({ repairFixture: 'wrong_mode_exhausted' }).generateRepair(
        {
          ...input,
          diagnosticCategory: 'RELATION_REVERSAL',
          requiredInterventionMode: 'CONTRAST',
        },
        {
          validateCandidate: (candidate) => ({
            valid:
              (candidate as { diagnosticCategory?: unknown }).diagnosticCategory ===
                'RELATION_REVERSAL' &&
              (candidate as { interventionMode?: unknown }).interventionMode === 'CONTRAST',
            diagnostics: [
              'interventionMode mismatch: returned TARGETED_PROMPT, required CONTRAST for RELATION_REVERSAL.',
            ],
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });
});
