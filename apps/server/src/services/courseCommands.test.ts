import { ApiErrorCode } from '@hy3-clinic/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../llm/errors.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
});

afterEach(() => db.close());

function envelope(id: string) {
  return {
    commandId: id,
    idempotencyKey: id,
    workspaceId: 'ws_1',
    actor: 'local' as const,
  };
}

describe('Course command failure serialization', () => {
  it('replays bounded known diagnostics and strips sensitive detail keys', () => {
    const commands = createCourseCommandService({ repos, clock: fixedClock(T0) });
    const claim = commands.begin(envelope('known-failure'), 'propose_curriculum', {
      manifestFingerprint: 'manifest_1',
    });
    commands.fail(
      claim,
      new AppError(ApiErrorCode.GroundingFailed, 'Safe learner message.', {
        kind: 'curriculum_candidate_validation',
        repairAttempted: true,
        errors: Array.from({ length: 30 }, (_, index) => `safe diagnostic ${index}`),
        warnings: [],
        apiKey: 'SECRET_API_KEY',
        nested: { prompt: 'SECRET_PROMPT', stack: 'SECRET_STACK' },
      }),
    );

    const result = repos.operations.getResult(claim.operationId)!;
    expect(result.payload).toMatchObject({
      code: ApiErrorCode.GroundingFailed,
      message: 'Safe learner message.',
      details: {
        kind: 'curriculum_candidate_validation',
        repairAttempted: true,
      },
    });
    expect((result.payload as { details: { errors: string[] } }).details.errors).toHaveLength(20);
    expect(JSON.stringify(result.payload).length).toBeLessThan(16_000);
    expect(JSON.stringify(result.payload)).not.toMatch(/SECRET_|apiKey|prompt|stack/u);

    expect(() =>
      commands.begin(envelope('known-failure'), 'propose_curriculum', {
        manifestFingerprint: 'manifest_1',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ApiErrorCode.GroundingFailed,
        message: 'Safe learner message.',
      }),
    );
  });

  it('does not persist an unexpected error message or raw details', () => {
    const commands = createCourseCommandService({ repos, clock: fixedClock(T0) });
    const claim = commands.begin(envelope('unexpected-failure'), 'propose_curriculum', {});
    commands.fail(claim, new Error('SECRET_RAW_PROVIDER_PAYLOAD'));

    expect(repos.operations.getResult(claim.operationId)?.payload).toEqual({
      message: 'Course command failed.',
    });
  });

  it('persists the provider-sanitized nested candidate failure facts', () => {
    const commands = createCourseCommandService({ repos, clock: fixedClock(T0) });
    const claim = commands.begin(envelope('candidate-failure'), 'propose_curriculum', {});
    commands.fail(
      claim,
      ProviderError.invalidOutput(
        'PRIVATE_PROVIDER_DIAGNOSTIC_SUMMARY',
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        true,
        {
          kind: 'curriculum_detail_candidate_validation_failed',
          context: { courseMapId: 'course_map_1', batchKey: 'detail_batch_1' },
          diagnostics: [
            {
              code: 'required_objective_formal_authority_missing',
              message: 'Safe exact local diagnostic.',
              facts: {
                courseMapRegionId: 'course_map_region_1',
                objectiveKey: 'u4-obj1',
                selectedEvidenceIds: ['evidence_1'],
                selectedEvidenceAuthority: [
                  {
                    evidenceId: 'evidence_1',
                    authorityTier: 'narrower_formal',
                    supportedConstructs: ['identify'],
                    formalEvidenceCount: 1,
                    narrowerClaim: 'Safe bounded claim.',
                    rawPayload: 'SECRET_RAW_PROVIDER_PAYLOAD',
                  },
                ],
              },
            },
          ],
        },
      ),
    );

    const payload = repos.operations.getResult(claim.operationId)?.payload;
    expect(payload).toMatchObject({
      code: ApiErrorCode.ProviderInvalidOutput,
      details: {
        validationKind: 'candidate',
        candidateFailure: {
          diagnostics: [
            {
              facts: {
                courseMapRegionId: 'course_map_region_1',
                objectiveKey: 'u4-obj1',
                selectedEvidenceIds: ['evidence_1'],
                selectedEvidenceAuthority: [
                  {
                    evidenceId: 'evidence_1',
                    authorityTier: 'narrower_formal',
                    supportedConstructs: ['identify'],
                    formalEvidenceCount: 1,
                    narrowerClaim: 'Safe bounded claim.',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC_SUMMARY');
    expect(serialized).not.toContain('SECRET_RAW_PROVIDER_PAYLOAD');
    expect(serialized.length).toBeLessThan(16_000);
  });
});
