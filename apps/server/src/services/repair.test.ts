import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GradeRecord } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { fixedClock } from '../util/ids.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepairService, diagnosisFromGrade } from './repair.js';

const item = (id: string, targetLearningUnitId = 'unit_1') => ({
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
      materialRevisionId: 'revision_1',
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

describe('Fake Repair provider contract', () => {
  const input = {
    targetLearningUnitId: 'unit_1',
    diagnosticCategory: 'INCOMPLETE_EXPRESSION' as const,
    requiredInterventionMode: 'TARGETED_PROMPT' as const,
    gapSummary: 'The response omitted one required idea.',
    affectedCriteria: ['States the capacity limit'],
    sourceContext: [{ blockId: 'block_1', quote: 'Working memory is limited.' }],
    failedPrompt: 'Explain working memory.',
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
