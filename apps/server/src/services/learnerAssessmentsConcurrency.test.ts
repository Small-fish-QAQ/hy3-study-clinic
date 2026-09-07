import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssessmentAttemptSchema,
  AssessmentDefinitionSchema,
  AssessmentVersionSchema,
} from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { ShortAnswerGradingInput, ProviderCallOptions } from '../llm/provider.js';
import type { RubricGrade } from '@hy3-clinic/shared';
import { makeBlock, makeMaterial, T0 } from '../testing/fixtures.js';
import { buildTestApp } from '../testing/testApp.js';
import { createServices } from './index.js';
import { fixedClock } from '../util/ids.js';
import { migrate } from '../db/migrate.js';
import { openDatabase } from '../db/database.js';

const contexts: Array<ReturnType<typeof buildTestApp>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.app.close()));
});

class BarrierProvider extends FakeProvider {
  private waiting: Array<() => void> = [];
  calls = 0;

  override async gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade> {
    this.calls += 1;
    if (this.calls <= 2) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length === 2) {
          const release = this.waiting.splice(0);
          release.forEach((resolveWaiting) => resolveWaiting());
        }
      });
    }
    return super.gradeShortAnswer(input, opts);
  }
}

class CountingProvider extends FakeProvider {
  calls = 0;

  override async gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade> {
    this.calls += 1;
    return super.gradeShortAnswer(input, opts);
  }
}

function seedAssessment(ctx: ReturnType<typeof buildTestApp>) {
  ctx.repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
  const block = ctx.repos.materials.getBlock('blk_1')!;
  const definition = ctx.repos.formalAssessments.insertDefinition(
    AssessmentDefinitionSchema.parse({
      id: 'assessment_1',
      workspaceId: 'ws_1',
      logicalKey: 'concurrency',
      title: 'Concurrency',
      createdAt: T0,
      updatedAt: T0,
    }),
  );
  const version = ctx.repos.formalAssessments.insertVersion(
    AssessmentVersionSchema.parse({
      id: 'assessment_version_1',
      definitionId: definition.id,
      version: 1,
      predecessorId: null,
      status: 'accepted',
      items: [
        {
          id: 'assessment_item_1',
          index: 0,
          targetLearningUnitId: 'unit_1',
          targetObjectiveId: 'objective_1',
          representation: 'recall',
          questionType: 'short_answer',
          prompt: 'Explain the source statement.',
          rubric: [
            {
              id: 'criterion_1',
              text: block.content,
              required: true,
              sourceBindingIds: [block.id],
            },
          ],
          sourceBindings: [
            {
              materialId: block.materialId,
              materialRevisionId: block.materialRevisionId!,
              sourceBlockId: block.id,
              quote: block.content,
              contentOrigin: 'extracted_original',
              authoritative: true,
            },
          ],
          formalEligible: true,
          policyReason: 'FORMAL_ELIGIBLE',
        },
      ],
      sourceRevisionIds: [block.materialRevisionId!],
      createdAt: T0,
      acceptedAt: T0,
      authorityMode: 'formal',
      progressionContext: null,
    }),
  );
  const attempt = ctx.repos.formalAssessments.insertAttempt(
    AssessmentAttemptSchema.parse({
      id: 'assessment_attempt_1',
      assessmentVersionId: version.id,
      workspaceId: 'ws_1',
      ordinal: 1,
      status: 'started',
      responses: {},
      startedAt: T0,
      submittedAt: null,
      cancelledAt: null,
    }),
  );
  return { version, attempt };
}

describe('formal assessment learner-submit concurrency', () => {
  it('submits and repairs through production telemetry without synthetic Agent operations', async () => {
    const provider = new CountingProvider();
    const ctx = buildTestApp({ provider });
    contexts.push(ctx);
    const { attempt, version } = seedAssessment(ctx);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/formal-assessment-attempts/${attempt.id}/learner-submit`,
      payload: { responses: { [version.items[0]!.id]: '工作记忆' } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().execution.result.gradeRecordId).toBeTruthy();
    expect(provider.calls).toBe(1);
    expect(
      ctx.db
        .prepare(
          'SELECT operation_id, workspace_id, assessment_id, status FROM model_logical_calls WHERE operation_type = ?',
        )
        .all('grade_formal_short_answer'),
    ).toEqual([
      {
        operation_id: null,
        workspace_id: attempt.workspaceId,
        assessment_id: version.id,
        status: 'completed',
      },
    ]);
    const repair = await ctx.app.inject({
      method: 'POST',
      url: `/api/repair-episodes/${response.json().execution.result.repairEpisodeId}/learner-start`,
    });
    expect(repair.statusCode).toBe(201);
    expect(repair.json().repair.packet).toBeTruthy();
    expect(
      ctx.db
        .prepare(
          'SELECT operation_id, workspace_id, assessment_id, status FROM model_logical_calls WHERE operation_type = ?',
        )
        .all('generate_repair_packet'),
    ).toEqual([
      {
        operation_id: null,
        workspace_id: attempt.workspaceId,
        assessment_id: version.id,
        status: 'completed',
      },
    ]);
    expect(ctx.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5])(
    'converges two overlapping learner submits on one authoritative grade (repetition %s)',
    async () => {
      const provider = new BarrierProvider();
      const ctx = buildTestApp({ provider });
      contexts.push(ctx);
      const { attempt, version } = seedAssessment(ctx);
      const responses = { [version.items[0]!.id]: '工作记忆' };
      const results = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/formal-assessment-attempts/${attempt.id}/learner-submit`,
          payload: { responses },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/formal-assessment-attempts/${attempt.id}/learner-submit`,
          payload: { responses },
        }),
      ]);
      expect(provider.calls).toBe(2);
      expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
      const executions = results.map((result) => result.json().execution);
      expect(executions[0].result.gradeRecordId).toBe(executions[1].result.gradeRecordId);
      const currentGrades = ctx.db
        .prepare(
          "SELECT id FROM assessment_grade_records WHERE attempt_id = ? AND status = 'current' ORDER BY id",
        )
        .all(attempt.id) as Array<{ id: string }>;
      expect(currentGrades).toHaveLength(1);
      const evidence = ctx.db
        .prepare(
          'SELECT id, grade_record_id, conclusion FROM assessment_evidence_records WHERE attempt_id = ?',
        )
        .all(attempt.id) as Array<{ id: string; grade_record_id: string; conclusion: string }>;
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.grade_record_id).toBe(currentGrades[0]!.id);
      const repairs = ctx.db
        .prepare(
          'SELECT id, trigger_grade_record_id FROM repair_episodes WHERE trigger_attempt_id = ? ORDER BY id',
        )
        .all(attempt.id);
      expect(repairs).toHaveLength(1);
      expect((repairs[0] as { trigger_grade_record_id: string }).trigger_grade_record_id).toBe(
        currentGrades[0]!.id,
      );
    },
  );

  it('reuses one current grade after a downstream projection failure', async () => {
    const provider = new FakeProvider();
    const ctx = buildTestApp({ provider });
    contexts.push(ctx);
    const { attempt, version } = seedAssessment(ctx);
    const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
    const responses = { [version.items[0]!.id]: '工作记忆' };
    const deriveEvidence = services.formalAssessments.deriveEvidence.bind(
      services.formalAssessments,
    );
    let failOnce = true;
    vi.spyOn(services.formalAssessments, 'deriveEvidence').mockImplementation((gradeId) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('projection failed');
      }
      return deriveEvidence(gradeId);
    });

    await expect(services.learnerAssessments.submit(attempt.id, responses)).rejects.toThrow(
      'projection failed',
    );
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM assessment_grade_records WHERE attempt_id = ?')
          .get(attempt.id) as { n: number }
      ).n,
    ).toBe(1);
    const retry = await services.learnerAssessments.submit(attempt.id, responses);
    expect(retry.result?.evidenceStatus).toBe('partial');
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM assessment_grade_records WHERE attempt_id = ?')
          .get(attempt.id) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM assessment_evidence_records WHERE attempt_id = ?')
          .get(attempt.id) as { n: number }
      ).n,
    ).toBe(1);
  });

  it('is sequentially idempotent', async () => {
    const provider = new CountingProvider();
    const ctx = buildTestApp({ provider });
    contexts.push(ctx);
    const { attempt, version } = seedAssessment(ctx);
    const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
    const responses = { [version.items[0]!.id]: '工作记忆' };
    const first = await services.learnerAssessments.submit(attempt.id, responses);
    const second = await services.learnerAssessments.submit(attempt.id, responses);
    expect(provider.calls).toBe(1);
    expect(first.result?.gradeRecordId).toBe(second.result?.gradeRecordId);
    const counts = ctx.db
      .prepare(
        "SELECT attempt_id, COUNT(*) AS n FROM assessment_grade_records WHERE status = 'current' GROUP BY attempt_id ORDER BY attempt_id",
      )
      .all() as Array<{ attempt_id: string; n: number }>;
    expect(counts).toEqual([{ attempt_id: attempt.id, n: 1 }]);
  });

  it('allows different attempts to grade concurrently', async () => {
    const provider = new BarrierProvider();
    const ctx = buildTestApp({ provider });
    contexts.push(ctx);
    const { attempt, version } = seedAssessment(ctx);
    const secondAttempt = ctx.repos.formalAssessments.insertAttempt(
      AssessmentAttemptSchema.parse({ ...attempt, id: 'assessment_attempt_2', ordinal: 2 }),
    );
    const services = createServices({ repos: ctx.repos, provider, clock: fixedClock(T0) });
    const responses = { [version.items[0]!.id]: '工作记忆' };
    const independent = await Promise.all([
      services.learnerAssessments.submit(attempt.id, responses),
      services.learnerAssessments.submit(secondAttempt.id, responses),
    ]);
    expect(provider.calls).toBe(2);
    expect(independent[0].result?.gradeRecordId).not.toBe(independent[1].result?.gradeRecordId);
    const counts = ctx.db
      .prepare(
        "SELECT attempt_id, COUNT(*) AS n FROM assessment_grade_records WHERE status = 'current' GROUP BY attempt_id ORDER BY attempt_id",
      )
      .all() as Array<{ attempt_id: string; n: number }>;
    expect(counts).toEqual([
      { attempt_id: attempt.id, n: 1 },
      { attempt_id: secondAttempt.id, n: 1 },
    ]);
  });

  it('creates the current-grade fence on fresh and upgraded databases', async () => {
    const fresh = buildTestApp();
    contexts.push(fresh);
    const index = fresh.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_assessment_grades_current_attempt'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain("WHERE status = 'current'");

    const upgrade = openDatabase(':memory:');
    migrate(upgrade, { toVersion: 44 });
    upgrade.exec(`
      INSERT INTO workspaces (id, name, origin, created_at, updated_at)
      VALUES ('upgrade_ws', 'Upgrade', 'manual', '${T0}', '${T0}');
      INSERT INTO assessment_definitions
        (id, workspace_id, logical_key, title, created_at, updated_at)
      VALUES ('upgrade_definition', 'upgrade_ws', 'upgrade', 'Upgrade', '${T0}', '${T0}');
      INSERT INTO assessment_versions
        (id, definition_id, version, predecessor_id, status, payload,
         source_revision_ids, progression_context, authority_mode, created_at, accepted_at)
      VALUES ('upgrade_version', 'upgrade_definition', 1, NULL, 'accepted', '{}', '[]', NULL,
        'formal', '${T0}', '${T0}');
      INSERT INTO assessment_attempts
        (id, assessment_version_id, workspace_id, ordinal, status, responses,
         started_at, submitted_at, cancelled_at, exposure_tracking_version)
      VALUES ('upgrade_attempt', 'upgrade_version', 'upgrade_ws', 1, 'submitted', '{}',
        '${T0}', '${T0}', NULL, 0);
      INSERT INTO assessment_grade_records
        (id, attempt_id, assessment_version_id, grader, rubric_version, status,
         payload, supersedes_id, created_at)
      VALUES ('upgrade_grade', 'upgrade_attempt', 'upgrade_version', 'fake', 'test', 'current',
        '{}', NULL, '${T0}');
    `);
    migrate(upgrade);
    expect(
      (
        upgrade
          .prepare("SELECT COUNT(*) AS n FROM assessment_grade_records WHERE status = 'current'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        upgrade
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_assessment_grades_current_attempt'",
          )
          .get() as { sql: string }
      ).sql,
    ).toContain("WHERE status = 'current'");
    upgrade.close();
  });
});
