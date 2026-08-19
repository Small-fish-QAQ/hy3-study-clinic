import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { FakeProvider, type FakeVisualDescriptionFixture } from '../llm/fakeProvider.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions, VisualDescriptionInput } from '../llm/provider.js';
import { searchRetrievalUnits, visualDerivationToRetrievalUnit } from '../retrieval/lexical.js';
import { buildTestApp } from '../testing/testApp.js';
import { T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createTelemetryProvider } from './providerTelemetry.js';
import { createVisualPreparationService } from './visualPreparation.js';

async function pngBase64(width = 4, height = 3): Promise<string> {
  return (
    await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } },
    })
      .png()
      .toBuffer()
  ).toString('base64');
}

async function directPreparationFixture(provider: FakeProvider) {
  const clock = fixedClock(T0);
  const ctx = buildTestApp({ provider, clock });
  const uploaded = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces/ws_1/documents',
    payload: {
      kind: 'file',
      filename: 'visual-fixture.png',
      mediaType: 'image/png',
      dataBase64: await pngBase64(),
    },
  });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const materialId = uploaded.json().material.id as string;
  const trackedProvider = createTelemetryProvider({
    repos: ctx.repos,
    clock,
    provider,
    providerGeneration: () => 1,
  });
  const service = createVisualPreparationService({
    repos: ctx.repos,
    clock,
    provider: trackedProvider,
  });
  const visualRef = service.list('ws_1', materialId)[0]!.visualRef;
  return { ctx, materialId, service, visualRef };
}

function visualAttempts(ctx: ReturnType<typeof buildTestApp>) {
  return ctx.db
    .prepare(
      `SELECT a.attempt_number AS attemptNumber, a.attempt_kind AS attemptKind,
              a.status, a.error_code AS errorCode
       FROM model_call_attempts a
       JOIN model_logical_calls c ON c.id = a.logical_call_id
       WHERE c.operation_type = 'prepare_visual_description'
       ORDER BY a.attempt_number ASC`,
    )
    .all();
}

describe('visual source preparation', () => {
  it('ingests a standalone image and exposes an advisory prepared description', async () => {
    const ctx = buildTestApp();
    const workspace = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'Visuals' },
    });
    const workspaceId = workspace.json().workspace.id as string;
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: {
        kind: 'file',
        filename: 'diagram.png',
        mediaType: 'image/png',
        dataBase64: await pngBase64(),
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const materialId = uploaded.json().material.id as string;
    expect(uploaded.json().blocks).toEqual([]);
    expect(uploaded.json().assets).toHaveLength(1);

    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/documents/${materialId}/visuals`,
    });
    expect(before.statusCode).toBe(200);
    const visual = before.json().visuals[0];
    expect(visual.visualRef).toMatch(/^visual_[0-9a-f]{24}$/u);
    expect(visual.sourceAuthority).toBe('original_visual');
    expect(visual.preparation.state).toBe('missing');

    const prepared = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents/${materialId}/visuals/${visual.visualRef}/prepare`,
      payload: { commandId: 'prepare-1' },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().status).toBe('prepared');
    expect(prepared.json().visual.description.authority).toBe('advisory');
    expect(prepared.json().visual.description.provenanceCategory).toBe(
      'generated_visual_explanation',
    );
    expect(prepared.json().visual.description.text).not.toContain(materialId);
    expect(prepared.json().visual).not.toHaveProperty('assetId');
    expect(prepared.json().visual).not.toHaveProperty('assetByteHash');

    const history = ctx.repos.visualDerivations.listForRevision(
      ctx.repos.materials.get(materialId)!.activeRevisionId!,
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.authority).toBe('derived');
    expect(history[0]!.contentOrigin).toBe('derived_visual_description');
    expect(history[0]!.evidenceAdmissibility).toBe('advisory_nonblocking');
  });

  it('replays the same command without creating a second immutable derivation', async () => {
    const ctx = buildTestApp();
    const workspace = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'Replay' },
    });
    const workspaceId = workspace.json().workspace.id as string;
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/documents`,
      payload: {
        kind: 'file',
        filename: 'photo.webp',
        mediaType: 'image/webp',
        dataBase64: (
          await sharp({
            create: { width: 2, height: 2, channels: 3, background: '#fff' },
          })
            .webp()
            .toBuffer()
        ).toString('base64'),
      },
    });
    const materialId = uploaded.json().material.id as string;
    const visualRef = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspaceId}/documents/${materialId}/visuals`,
      })
    ).json().visuals[0].visualRef as string;
    const path = `/api/workspaces/${workspaceId}/documents/${materialId}/visuals/${visualRef}/prepare`;
    const first = await ctx.app.inject({
      method: 'POST',
      url: path,
      payload: { commandId: 'same' },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: path,
      payload: { commandId: 'same' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('prepared');
    expect(
      ctx.repos.visualDerivations.listForAsset(ctx.repos.materials.getAssets(materialId)[0]!.id),
    ).toHaveLength(1);
  });

  it('recovers an expired preparation lease before accepting a new command', async () => {
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new FakeProvider(),
    );
    const expiredId = 'op_expired_visual';
    const before = new Date(new Date(T0).getTime() - 2_000).toISOString();
    const expiredAt = new Date(new Date(T0).getTime() - 1_000).toISOString();
    ctx.repos.operations.createOrGet({
      id: expiredId,
      workspaceId: 'ws_1',
      commandId: `visual-description:${visualRef}:abandoned`,
      idempotencyKey: `visual-description:${visualRef}:abandoned`,
      logicalOperationId: `visual-description:${visualRef}:abandoned`,
      operationType: 'prepare_visual_description',
      expectedFingerprint: `visual_derivation_${'0'.repeat(64)}`,
      createdAt: before,
      updatedAt: before,
    });
    expect(ctx.repos.operations.claim(expiredId, 'abandoned-worker', expiredAt, before)).not.toBe(
      null,
    );

    await expect(
      service.prepare('ws_1', materialId, visualRef, { commandId: 'retry-after-expiry' }),
    ).resolves.toMatchObject({ status: 'prepared' });
    expect(ctx.repos.operations.get(expiredId)?.status).toBe('interrupted');
    expect(
      ctx.repos.visualDerivations.listForAsset(ctx.repos.materials.getAssets(materialId)[0]!.id),
    ).toHaveLength(1);
  });

  it('reuses identical bytes while preserving two occurrence-bound searchable derivations', async () => {
    const ctx = buildTestApp();
    const image = await pngBase64(8, 6);
    const workspace = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'Repeated visuals' },
    });
    const workspaceId = workspace.json().workspace.id as string;
    const upload = async (filename: string) => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents`,
        payload: { kind: 'file', filename, mediaType: 'image/png', dataBase64: image },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().material.id as string;
    };
    const firstMaterialId = await upload('first.png');
    const secondMaterialId = await upload('second.png');
    const prepare = async (materialId: string, commandId: string) => {
      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspaceId}/documents/${materialId}/visuals`,
      });
      const visualRef = listed.json().visuals[0].visualRef as string;
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/documents/${materialId}/visuals/${visualRef}/prepare`,
        payload: { commandId },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response;
    };

    expect((await prepare(firstMaterialId, 'first-occurrence')).json().status).toBe('prepared');
    expect((await prepare(secondMaterialId, 'second-occurrence')).json().status).toBe('reused');

    const first = ctx.repos.visualDerivations.listForRevision(
      ctx.repos.materials.get(firstMaterialId)!.activeRevisionId!,
    )[0]!;
    const second = ctx.repos.visualDerivations.listForRevision(
      ctx.repos.materials.get(secondMaterialId)!.activeRevisionId!,
    )[0]!;
    expect(first.assetByteHash).toBe(second.assetByteHash);
    expect(first.assetId).not.toBe(second.assetId);
    expect(first.identityFingerprint).not.toBe(second.identityFingerprint);
    expect(first.semanticIdentityFingerprint).toBe(second.semanticIdentityFingerprint);
    expect(second.reusedFromDerivationId).toBe(first.id);
    expect(ctx.repos.telemetry.usageSummary(workspaceId)).toMatchObject({
      logicalCalls: 1,
      physicalAttempts: 1,
    });

    const results = searchRetrievalUnits(
      [],
      [first, second].map(visualDerivationToRetrievalUnit),
      'visual learning source',
    );
    expect(results).toHaveLength(2);
    expect(
      results.map((result) => ({
        derivationId: result.kind === 'visual_derivation' ? result.derivationId : null,
        assetOccurrenceId: result.kind === 'visual_derivation' ? result.assetOccurrenceId : null,
        assetByteHash: result.kind === 'visual_derivation' ? result.assetByteHash : null,
        authority: result.authority,
        contentOrigin: result.contentOrigin,
      })),
    ).toEqual(
      expect.arrayContaining(
        [first, second].map((derivation) => ({
          derivationId: derivation.id,
          assetOccurrenceId: derivation.assetId,
          assetByteHash: derivation.assetByteHash,
          authority: 'advisory_nonblocking',
          contentOrigin: 'derived_visual_description',
        })),
      ),
    );
  });

  it('coordinates concurrent SHA-identical occurrences by semantic identity', async () => {
    let enteredProvider!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    class BlockingVisualProvider extends FakeProvider {
      calls = 0;

      override async describeVisual(input: VisualDescriptionInput, options?: ProviderCallOptions) {
        this.calls += 1;
        enteredProvider();
        await released;
        return super.describeVisual(input, options);
      }
    }
    const provider = new BlockingVisualProvider();
    const ctx = buildTestApp({ provider, clock: fixedClock(T0) });
    const image = await pngBase64(6, 4);
    const upload = async (filename: string) => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/ws_1/documents',
        payload: { kind: 'file', filename, mediaType: 'image/png', dataBase64: image },
      });
      expect(response.statusCode, response.body).toBe(201);
      const materialId = response.json().material.id as string;
      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/workspaces/ws_1/documents/${materialId}/visuals`,
      });
      return { materialId, visualRef: listed.json().visuals[0].visualRef as string };
    };
    const first = await upload('first-concurrent.png');
    const second = await upload('second-concurrent.png');
    const prepare = (visual: typeof first, commandId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/workspaces/ws_1/documents/${visual.materialId}/visuals/${visual.visualRef}/prepare`,
        payload: { commandId },
      });

    const firstPending = prepare(first, 'first-concurrent');
    await entered;
    const concurrent = await prepare(second, 'second-concurrent');
    expect(concurrent.statusCode).toBe(409);
    expect(provider.calls).toBe(1);

    releaseProvider();
    const firstResult = await firstPending;
    expect(firstResult.statusCode, firstResult.body).toBe(200);
    const reused = await prepare(second, 'second-concurrent');
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json().status).toBe('reused');
    expect(provider.calls).toBe(1);
  });

  it('uses exactly one repair request and persists only the accepted result', async () => {
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new FakeProvider({ visualDescriptionFixture: 'repair_once' }),
    );

    await expect(
      service.prepare('ws_1', materialId, visualRef, { commandId: 'repair-once' }),
    ).resolves.toMatchObject({ status: 'prepared' });
    expect(visualAttempts(ctx)).toMatchObject([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        errorCode: 'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED',
      },
      { attemptNumber: 2, attemptKind: 'repair', status: 'completed', errorCode: null },
    ]);
    expect(ctx.repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(2);
    expect(
      ctx.repos.visualDerivations.listForRevision(
        ctx.repos.materials.get(materialId)!.activeRevisionId!,
      ),
    ).toHaveLength(1);
  });

  it.each<[FakeVisualDescriptionFixture, string, string]>([
    ['malformed_json', 'JSON_PARSE_FAILURE_REPAIR_REQUIRED', 'REPAIR_EXHAUSTED:JSON_PARSE_FAILURE'],
    [
      'invalid_schema',
      'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED',
      'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    ],
    [
      'repair_exhausted',
      'SCHEMA_VALIDATION_FAILURE_REPAIR_REQUIRED',
      'REPAIR_EXHAUSTED:SCHEMA_VALIDATION_FAILURE',
    ],
    [
      'semantic_invalid',
      'SEMANTIC_VALIDATION_FAILURE_REPAIR_REQUIRED',
      'REPAIR_EXHAUSTED:SEMANTIC_VALIDATION_FAILURE',
    ],
  ])(
    'fails closed after the bounded repair for %s without persisting a derivation',
    async (fixture, firstError, secondError) => {
      const { ctx, materialId, service, visualRef } = await directPreparationFixture(
        new FakeProvider({ visualDescriptionFixture: fixture }),
      );

      await expect(
        service.prepare('ws_1', materialId, visualRef, { commandId: `failure-${fixture}` }),
      ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
      expect(visualAttempts(ctx)).toMatchObject([
        { attemptNumber: 1, attemptKind: 'original', errorCode: firstError },
        { attemptNumber: 2, attemptKind: 'repair', status: 'failed', errorCode: secondError },
      ]);
      expect(ctx.repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(2);
      expect(
        ctx.repos.visualDerivations.listForRevision(
          ctx.repos.materials.get(materialId)!.activeRevisionId!,
        ),
      ).toEqual([]);
    },
  );

  it('does not retry a timeout and records one physical attempt', async () => {
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new FakeProvider({ delayMs: 100 }),
    );

    await expect(
      service.prepare('ws_1', materialId, visualRef, { commandId: 'timeout' }, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderTimeout });
    expect(visualAttempts(ctx)).toMatchObject([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        status: 'failed',
        errorCode: 'PROVIDER_TIMEOUT',
      },
    ]);
    expect(ctx.repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(1);
  });

  it('cancels a sent request without retrying or persisting a derivation', async () => {
    let enteredProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    class CancellableVisualProvider extends FakeProvider {
      constructor() {
        super({ delayMs: 10_000 });
      }

      override async describeVisual(input: VisualDescriptionInput, options?: ProviderCallOptions) {
        enteredProvider();
        return super.describeVisual(input, options);
      }
    }
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new CancellableVisualProvider(),
    );
    const controller = new AbortController();
    const pending = service.prepare(
      'ws_1',
      materialId,
      visualRef,
      { commandId: 'cancelled' },
      { signal: controller.signal },
    );
    await entered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    expect(visualAttempts(ctx)).toMatchObject([
      {
        attemptNumber: 1,
        attemptKind: 'original',
        status: 'cancelled',
        errorCode: 'REQUEST_CANCELLED',
      },
    ]);
    expect(ctx.repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(1);
    expect(
      ctx.repos.visualDerivations.listForRevision(
        ctx.repos.materials.get(materialId)!.activeRevisionId!,
      ),
    ).toEqual([]);
  });

  it('rejects a late result from a provider that ignores cancellation', async () => {
    let enteredProvider!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    class UncooperativeVisualProvider extends FakeProvider {
      override async describeVisual(input: VisualDescriptionInput) {
        enteredProvider();
        await released;
        return super.describeVisual(input);
      }
    }
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new UncooperativeVisualProvider(),
    );
    const controller = new AbortController();
    const pending = service.prepare(
      'ws_1',
      materialId,
      visualRef,
      { commandId: 'late-cancelled' },
      { signal: controller.signal },
    );
    await entered;
    controller.abort();
    releaseProvider();

    await expect(pending).rejects.toMatchObject({ code: ApiErrorCode.RequestCancelled });
    expect(visualAttempts(ctx)).toMatchObject([
      { attemptNumber: 1, status: 'cancelled', errorCode: 'REQUEST_CANCELLED' },
    ]);
    expect(
      ctx.repos.visualDerivations.listForRevision(
        ctx.repos.materials.get(materialId)!.activeRevisionId!,
      ),
    ).toEqual([]);
    expect(
      ctx.repos.operations.findLatestByIdempotencyPrefix(
        'ws_1',
        'prepare_visual_description',
        `visual-description:${visualRef}:`,
      )?.status,
    ).toBe('cancelled');
  });

  it.each([
    'asset_private_visible_identity',
    `sha256:${'a'.repeat(64)}`,
    'This visible text definitively grants mastery.',
  ])('rejects prohibited semantic content in visibleText: %s', async (visibleText) => {
    class InvalidVisibleTextProvider extends FakeProvider {
      override async describeVisual(input: VisualDescriptionInput, options?: ProviderCallOptions) {
        const candidate = { ...(await super.describeVisual(input)), visibleText };
        const validation = options?.validateCandidate?.(candidate);
        if (validation && !validation.valid) {
          options?.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
          throw ProviderError.invalidOutput(
            validation.diagnostics.join('; '),
            'candidate',
            'SEMANTIC_VALIDATION_FAILURE',
            true,
          );
        }
        return candidate;
      }
    }
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new InvalidVisibleTextProvider(),
    );

    await expect(
      service.prepare('ws_1', materialId, visualRef, {
        commandId: `invalid-visible-text-${visibleText.length}`,
      }),
    ).rejects.toMatchObject({ code: ApiErrorCode.ProviderInvalidOutput });
    expect(
      ctx.repos.visualDerivations.listForRevision(
        ctx.repos.materials.get(materialId)!.activeRevisionId!,
      ),
    ).toEqual([]);
  });

  it('finds visual preparation state beyond 200 unrelated workspace operations', async () => {
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new FakeProvider(),
    );
    const targetKey = `visual-description:${visualRef}:older-active`;
    const oldest = new Date(Date.parse(T0) - 1_000).toISOString();
    ctx.repos.operations.createOrGet({
      id: 'op_visual_older_active',
      workspaceId: 'ws_1',
      commandId: targetKey,
      idempotencyKey: targetKey,
      logicalOperationId: targetKey,
      operationType: 'prepare_visual_description',
      expectedFingerprint: 'visual_semantic_older_active',
      createdAt: oldest,
      updatedAt: oldest,
    });
    for (let index = 0; index < 201; index += 1) {
      const key = `noise:${index}`;
      const at = new Date(Date.parse(T0) + index + 1).toISOString();
      ctx.repos.operations.createOrGet({
        id: `op_noise_${index}`,
        workspaceId: 'ws_1',
        commandId: key,
        idempotencyKey: key,
        logicalOperationId: key,
        operationType: 'prepare_visual_description',
        expectedFingerprint: `noise_${index}`,
        createdAt: at,
        updatedAt: at,
      });
    }

    expect(service.list('ws_1', materialId)[0]!.preparation.state).toBe('preparing');
    await expect(
      service.prepare('ws_1', materialId, visualRef, { commandId: 'must-see-older-active' }),
    ).rejects.toMatchObject({ code: ApiErrorCode.VersionConflict });
  });

  it('fences a stale source before opening a repair attempt', async () => {
    let makeSourceStale = () => undefined;
    class StaleBeforeRepairProvider extends FakeProvider {
      override async describeVisual(_input: VisualDescriptionInput, options?: ProviderCallOptions) {
        makeSourceStale();
        options?.onRepairAttempt?.('schema', 'SCHEMA_VALIDATION_FAILURE');
        throw new Error('stale source should fence before this fallback');
      }
    }
    const { ctx, materialId, service, visualRef } = await directPreparationFixture(
      new StaleBeforeRepairProvider(),
    );
    makeSourceStale = () => {
      ctx.repos.materialRevisions.retire(materialId, T0);
    };

    await expect(
      service.prepare('ws_1', materialId, visualRef, { commandId: 'stale-before-repair' }),
    ).rejects.toThrow();
    expect(visualAttempts(ctx)).toMatchObject([
      { attemptNumber: 1, attemptKind: 'original', status: 'failed' },
    ]);
    expect(ctx.repos.telemetry.usageSummary('ws_1').physicalAttempts).toBe(1);
  });
});
