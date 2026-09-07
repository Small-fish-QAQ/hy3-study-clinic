import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions } from '../llm/provider.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createCourseCommandService } from './courseCommands.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import {
  runRecoverableGenerationStage,
  invalidateGenerationDependency,
} from './generationStages.js';

let db: SqliteDb;
let repos: Repositories;
const clock = fixedClock(T0);
const schema = z.object({ units: z.array(z.string()).length(1) }).strict();
const generate = vi.fn(async (_input: unknown, opts?: ProviderCallOptions) => {
  opts?.onRequestSent?.();
  return { units: ['one'] };
});
function stage(id: string, identity: unknown = { depth: 'working_fluency', focus: 'normal' }) {
  const command = createCourseCommandService({ repos, clock }).begin(
    {
      commandId: id,
      idempotencyKey: id,
      workspaceId: 'ws_1',
      actor: 'system',
    },
    'propose_curriculum',
    {},
  );
  const provider = new FakeProvider();
  const measured = createTelemetryProvider({
    repos,
    clock,
    provider: { name: 'fake', generate },
    providerGeneration: () => 1,
  });
  return {
    repos,
    clock,
    provider,
    providerModel: null,
    ...command,
    workspaceId: 'ws_1',
    studySessionId: null,
    learningUnitId: null,
    assessmentId: null,
    operationType: 'propose_curriculum',
    logicalCallId: `call-${id}`,
    schemaFingerprint: 'detail-v1',
    sourceFingerprint: 'source-v1',
    policyFingerprint: null,
    stageIdentity: identity,
    assertCurrent: vi.fn(),
    validateResult: (value: unknown) => schema.parse(value),
    invoke: (opts?: ProviderCallOptions) => measured.generate({}, opts),
  };
}
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  generate.mockClear();
});
afterEach(() => db.close());

describe('recoverable generation dependencies', () => {
  it('replaces a quality-rejected dependency once and reuses the validated successor', async () => {
    const original = stage('original');
    await runRecoverableGenerationStage(original);
    const unaffected = stage('other', { topic: 'separate unit' });
    await runRecoverableGenerationStage(unaffected);
    invalidateGenerationDependency(repos, 'call-original', T0);
    await runRecoverableGenerationStage(stage('replacement'));
    await runRecoverableGenerationStage(stage('replacement-hit'));
    await runRecoverableGenerationStage(stage('other-hit', { topic: 'separate unit' }));
    expect(generate).toHaveBeenCalledTimes(3);
    expect(repos.telemetry.getLogicalCall('call-replacement-hit')?.cacheStatus).toBe('hit');
    expect(repos.telemetry.getLogicalCall('call-other-hit')?.cacheStatus).toBe('hit');
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM semantic_cache_entries WHERE invalidated_at IS NOT NULL',
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it('admits cost only for a new request while allowing an exact cached dependency', async () => {
    const first = stage('first');
    const admission = vi.fn(() => null);
    await runRecoverableGenerationStage({ ...first, beforeGenerate: admission });
    expect(admission).toHaveBeenCalledOnce();
    const refuse = () => {
      throw new Error('cache only');
    };
    await expect(
      runRecoverableGenerationStage({ ...stage('cached'), beforeGenerate: refuse }),
    ).resolves.toEqual({ units: ['one'] });
    await expect(
      runRecoverableGenerationStage({
        ...stage('different', { depth: 'deep_transfer' }),
        beforeGenerate: refuse,
      }),
    ).rejects.toThrow('cache only');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('survives a failed owner and rehydration with exact original provenance and no new request', async () => {
    const first = stage('first');
    expect(await runRecoverableGenerationStage(first)).toEqual({ units: ['one'] });
    createCourseCommandService({ repos, clock }).fail(first, new Error('Later dependency failed'));
    const original = repos.telemetry.getLogicalCall('call-first');
    repos = createRepositories(db);
    const retry = stage('retry');
    expect(await runRecoverableGenerationStage(retry)).toEqual({ units: ['one'] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(repos.telemetry.getLogicalCall('call-first')).toEqual(original);
    expect(repos.telemetry.getLogicalCall('call-retry')).toMatchObject({
      status: 'completed',
      cacheStatus: 'hit',
      operationId: retry.operationId,
    });
    expect(repos.telemetry.listAttempts('call-retry')).toEqual([]);
    expect(repos.operations.listEvents(retry.operationId).at(-1)?.payload).toMatchObject({
      originLogicalCallId: 'call-first',
    });
  });
  it.each([
    { depth: 'high_performance', focus: 'normal' },
    { depth: 'working_fluency', focus: 'focused' },
    { depth: 'working_fluency', focus: 'normal', predecessor: 'new-proposal' },
  ])('does not reuse a different instructional or governance input: %j', async (identity) => {
    await runRecoverableGenerationStage(stage('first'));
    await runRecoverableGenerationStage(stage('changed', identity));
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('does not cache failure or a result rejected by current validation', async () => {
    generate.mockRejectedValueOnce(ProviderError.invalidOutput('bad provider response'));
    await expect(runRecoverableGenerationStage(stage('failed'))).rejects.toThrow();
    const rejected = stage('rejected');
    rejected.validateResult = () => {
      throw new Error('inventory changed');
    };
    await expect(runRecoverableGenerationStage(rejected)).rejects.toThrow('inventory changed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM semantic_cache_entries').get()).toEqual({ n: 0 });
    await runRecoverableGenerationStage(stage('valid'));
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it('checks source and route authority before cache reuse', async () => {
    await runRecoverableGenerationStage(stage('first'));
    const retry = stage('retry');
    retry.assertCurrent.mockImplementation(() => {
      throw new Error('source changed');
    });
    await expect(runRecoverableGenerationStage(retry)).rejects.toThrow('source changed');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(repos.telemetry.getLogicalCall('call-retry')).toBeUndefined();
  });
  it('fences cancellation and ownership loss before recording a completed dependency', async () => {
    const first = stage('first');
    const abort = new AbortController();
    const invoke = first.invoke;
    first.invoke = async (opts) => {
      const result = await invoke(opts);
      abort.abort();
      return result;
    };
    await expect(
      runRecoverableGenerationStage({ ...first, providerOptions: { signal: abort.signal } }),
    ).rejects.toThrow();
    const retry = stage('retry');
    await expect(
      runRecoverableGenerationStage({ ...retry, owner: 'foreign-owner' }),
    ).rejects.toThrow('lease');
    expect(db.prepare('SELECT COUNT(*) AS n FROM semantic_cache_entries').get()).toEqual({ n: 0 });
  });
  it.each(['payload', 'origin', 'schema'])(
    'rejects a corrupt %s dependency and regenerates locally',
    async (kind) => {
      await runRecoverableGenerationStage(stage('first'));
      if (kind === 'payload')
        db.prepare("UPDATE semantic_cache_entries SET result_payload='{}'").run();
      if (kind === 'origin')
        db.prepare("UPDATE model_logical_calls SET workspace_id=NULL WHERE id='call-first'").run();
      if (kind === 'schema')
        db.prepare("UPDATE semantic_cache_entries SET schema_fingerprint='foreign'").run();
      await runRecoverableGenerationStage(stage('retry'));
      expect(generate).toHaveBeenCalledTimes(2);
      expect(repos.telemetry.getLogicalCall('call-retry')?.cacheStatus).not.toBe('hit');
    },
  );
  it('revalidates cached content rather than trusting the original verdict', async () => {
    await runRecoverableGenerationStage(stage('first'));
    const retry = stage('retry');
    const validate = vi.fn(retry.validateResult).mockImplementationOnce(() => {
      throw new Error('obsolete');
    });
    await runRecoverableGenerationStage({ ...retry, validateResult: validate });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
  });
});
