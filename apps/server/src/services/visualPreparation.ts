import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  VisualDescriptionPayloadSchema,
  VisualMediaTypeSchema,
  VisualPreparationRequestSchema,
  VisualPreparationResponseSchema,
  VisualSourceProjectionSchema,
  type EmbeddedAsset,
  type Material,
  type VisualDerivation,
  type VisualDescriptionPayload,
  type VisualPreparationResponse,
  type VisualSourceProjection,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import {
  prepareVisualTransport,
  VISUAL_TRANSPORT_PREPARATION_VERSION,
} from '../ingestion/images.js';
import { ProviderError } from '../llm/errors.js';
import type { ProviderCallOptions, VisualDescriptionProvider } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import {
  enforceAgentCostPolicies,
  runTrackedAgentProviderOperation,
} from './agentProviderRuntime.js';

export const VISUAL_DESCRIPTION_GENERATOR_VERSION = 'provider-visual-description-v1';
export const VISUAL_DESCRIPTION_SCHEMA_FINGERPRINT = 'visual-description-payload-v1';
export const VISUAL_PREPARATION_FINALIZATION_MARGIN_MS = 30_000;
const DEFAULT_VISUAL_REQUEST_TIMEOUT_MS = 30_000;
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LIMITS = {
  maxDescriptionChars: 1200,
  maxVisibleTextChars: 2000,
  maxConcepts: 12,
  maxPedagogicalNotes: 6,
  maxUncertaintyItems: 6,
} as const;

interface VisualPreparationDeps {
  repos: Repositories;
  provider: VisualDescriptionProvider;
  clock: Clock;
}

interface ResolvedVisual {
  workspaceId: string;
  material: Material;
  asset: EmbeddedAsset;
  visualRef: string;
}

interface DerivationIdentity {
  configurationFingerprint: string;
  semanticIdentityFingerprint: `visual_semantic_${string}`;
  identityFingerprint: `visual_derivation_${string}`;
  providerModel: string | null;
  providerEndpointIdentity: string;
  providerRuntimeIdentity: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function visualRefForAsset(assetId: string): string {
  return `visual_${sha256(assetId).slice(0, 24)}`;
}

function providerModel(provider: VisualDescriptionProvider): string | null {
  return provider.name === 'fake' ? null : (provider.model ?? null);
}

export function visualConfigurationFingerprint(provider: VisualDescriptionProvider): string {
  return `sha256:${sha256(
    JSON.stringify({
      generatorVersion: VISUAL_DESCRIPTION_GENERATOR_VERSION,
      schemaFingerprint: VISUAL_DESCRIPTION_SCHEMA_FINGERPRINT,
      provider: provider.name,
      providerModel: providerModel(provider),
      providerEndpointIdentity: provider.endpointIdentity ?? `unbound:${provider.name}`,
      providerRuntimeIdentity: provider.runtimeIdentity ?? `unbound:${provider.name}`,
      visualPromptVersion: provider.promptIdentity ?? `unbound:${provider.name}`,
      contextMode: 'image_only',
      transportPreparationVersion: VISUAL_TRANSPORT_PREPARATION_VERSION,
      limits: LIMITS,
    }),
  )}`;
}

function derivationIdentity(
  resolved: ResolvedVisual,
  provider: VisualDescriptionProvider,
  transportFingerprint: string,
): DerivationIdentity {
  const model = providerModel(provider);
  const configuration = visualConfigurationFingerprint(provider);
  const semanticIdentityFingerprint = `visual_semantic_${sha256(
    JSON.stringify({
      assetByteHash: resolved.asset.byteHash,
      transportFingerprint,
      generatorVersion: VISUAL_DESCRIPTION_GENERATOR_VERSION,
      configurationFingerprint: configuration,
      contextMode: 'image_only',
    }),
  )}` as const;
  const identityFingerprint = `visual_derivation_${sha256(
    JSON.stringify({
      semanticIdentityFingerprint,
      materialRevisionId: resolved.asset.materialRevisionId,
      assetId: resolved.asset.id,
    }),
  )}` as const;
  return {
    configurationFingerprint: configuration,
    semanticIdentityFingerprint,
    identityFingerprint,
    providerModel: model,
    providerEndpointIdentity: provider.endpointIdentity ?? `unbound:${provider.name}`,
    providerRuntimeIdentity: provider.runtimeIdentity ?? `unbound:${provider.name}`,
  };
}

export function visualPreparationLeaseMs(
  provider: VisualDescriptionProvider,
  timeoutOverrideMs?: number,
): number {
  const requestTimeoutMs =
    timeoutOverrideMs ?? provider.timeoutMs ?? DEFAULT_VISUAL_REQUEST_TIMEOUT_MS;
  return requestTimeoutMs * 2 + VISUAL_PREPARATION_FINALIZATION_MARGIN_MS;
}

function semanticCandidateValidation(candidate: unknown) {
  const parsed = VisualDescriptionPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: ['The visual description does not match the bounded schema.'],
      diagnosticCodes: ['VISUAL_SCHEMA_INVALID'],
    };
  }
  const advisoryText = [
    parsed.data.description,
    parsed.data.visibleText ?? '',
    ...parsed.data.importantConcepts,
    ...parsed.data.pedagogicalNotes,
    ...parsed.data.uncertainty,
  ].join('\n');
  const persistentStateClaim =
    /\b(grants?|awards?|proves?)\s+(formal\s+evidence|mastery)|\b(close[sd]?|resolve[sd]?)\s+(a\s+)?mistake\b/iu;
  if (persistentStateClaim.test(advisoryText)) {
    return {
      valid: false,
      diagnostics: ['Describe visible content without claiming persistent learning-state effects.'],
      diagnosticCodes: ['VISUAL_STATE_AUTHORITY_CLAIM'],
    };
  }
  if (
    /\b(?:mat|rev|asset|visual_derivation)_[a-z0-9_-]+\b|sha256:[0-9a-f]{64}/iu.test(advisoryText)
  ) {
    return {
      valid: false,
      diagnostics: ['Describe visible content without emitting internal source identities.'],
      diagnosticCodes: ['VISUAL_INTERNAL_IDENTITY_CLAIM'],
    };
  }
  return { valid: true, diagnostics: [] };
}

function locationLabel(material: Material, asset: EmbeddedAsset): string {
  if (material.sourceType === 'image') return 'Standalone image';
  if (asset.location.slideNumber) return `Slide ${asset.location.slideNumber}`;
  if (asset.location.pageNumber) return `Page ${asset.location.pageNumber}`;
  return `Embedded visual ${asset.index + 1}`;
}

function isSupportedVisual(asset: EmbeddedAsset): boolean {
  return (
    asset.relationshipKind === 'image' &&
    asset.contentOrigin === 'extracted_original' &&
    SUPPORTED_MEDIA_TYPES.has(asset.mediaType) &&
    asset.width !== null &&
    asset.height !== null
  );
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw ProviderError.cancelled();
}

export function createVisualPreparationService({ repos, provider, clock }: VisualPreparationDeps) {
  function materialInWorkspace(workspaceId: string, materialId: string): Material {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course workspace not found.');
    const material = repos.materials.get(materialId);
    if (
      !material ||
      material.workspaceId !== workspaceId ||
      material.availability === 'retired' ||
      !material.activeRevisionId
    ) {
      throw notFound('Active visual material not found.');
    }
    return material;
  }

  function activeVisuals(workspaceId: string, materialId: string): ResolvedVisual[] {
    const material = materialInWorkspace(workspaceId, materialId);
    return repos.materials
      .getAssets(materialId)
      .filter(isSupportedVisual)
      .map((asset) => ({
        workspaceId,
        material,
        asset,
        visualRef: visualRefForAsset(asset.id),
      }));
  }

  function resolveVisual(
    workspaceId: string,
    materialId: string,
    visualRef: string,
  ): ResolvedVisual {
    const matches = activeVisuals(workspaceId, materialId).filter(
      (candidate) => candidate.visualRef === visualRef,
    );
    if (matches.length !== 1) throw notFound('Active visual source not found.');
    return matches[0]!;
  }

  function assertStillCurrent(expected: ResolvedVisual): ResolvedVisual {
    const current = resolveVisual(expected.workspaceId, expected.material.id, expected.visualRef);
    if (
      current.material.activeRevisionId !== expected.material.activeRevisionId ||
      current.asset.id !== expected.asset.id ||
      current.asset.materialRevisionId !== expected.asset.materialRevisionId ||
      current.asset.byteHash !== expected.asset.byteHash
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Visual source changed while semantic preparation was running.',
      );
    }
    return current;
  }

  function project(resolved: ResolvedVisual): VisualSourceProjection {
    const history = repos.visualDerivations.listForAsset(resolved.asset.id);
    const currentModel = providerModel(provider);
    const currentConfiguration = visualConfigurationFingerprint(provider);
    const exact = history.findLast(
      (derivation) =>
        derivation.assetByteHash === resolved.asset.byteHash &&
        derivation.generatorVersion === VISUAL_DESCRIPTION_GENERATOR_VERSION &&
        derivation.provider === provider.name &&
        derivation.providerModel === currentModel &&
        derivation.configurationFingerprint === currentConfiguration &&
        derivation.contextMode === 'image_only' &&
        derivation.transport.preparationVersion === VISUAL_TRANSPORT_PREPARATION_VERSION,
    );
    const available = exact ?? history.at(-1) ?? null;
    const operation = repos.operations.findLatestByIdempotencyPrefix(
      resolved.workspaceId,
      'prepare_visual_description',
      `visual-description:${resolved.visualRef}:`,
    );
    const state = exact
      ? 'ready'
      : operation?.status === 'queued' || operation?.status === 'running'
        ? 'preparing'
        : operation?.status === 'failed' || operation?.status === 'interrupted'
          ? 'failed'
          : history.length > 0
            ? 'stale'
            : 'missing';
    return VisualSourceProjectionSchema.parse({
      visualRef: resolved.visualRef,
      sourceKind: resolved.material.sourceType === 'image' ? 'standalone' : 'embedded',
      mediaType: resolved.asset.mediaType,
      width: resolved.asset.width,
      height: resolved.asset.height,
      location: {
        pageNumber: resolved.asset.location.pageNumber ?? null,
        slideNumber: resolved.asset.location.slideNumber ?? null,
        contextLabel: locationLabel(resolved.material, resolved.asset),
      },
      sourceAuthority: 'original_visual',
      preparation: {
        state,
        retryable: state !== 'ready' && state !== 'preparing',
        descriptionAvailable: available !== null,
        ocrTextAvailable: false,
      },
      description: available
        ? {
            text: available.payload.description,
            visualType: available.payload.visualType,
            importantConcepts: available.payload.importantConcepts,
            pedagogicalNotes: available.payload.pedagogicalNotes,
            uncertainty: available.payload.uncertainty,
            provenanceCategory: 'generated_visual_explanation',
            authority: 'advisory',
            createdAt: available.createdAt,
          }
        : null,
    });
  }

  function materialize(
    resolved: ResolvedVisual,
    identity: DerivationIdentity,
    transport: VisualDerivation['transport'],
    payload: VisualDescriptionPayload,
    reusedFromDerivationId: string | null,
  ): VisualDerivation {
    if (provider.name === 'disabled') {
      throw ProviderError.invalidOutput(
        'Disabled visual providers cannot materialize accepted derivations.',
        undefined,
        'PROVIDER_FORMAT_INCOMPATIBILITY',
      );
    }
    return {
      id: newId('visual_derivation'),
      materialId: resolved.material.id,
      materialRevisionId: resolved.asset.materialRevisionId,
      assetId: resolved.asset.id,
      assetByteHash: resolved.asset.byteHash,
      identityFingerprint: identity.identityFingerprint,
      semanticIdentityFingerprint: identity.semanticIdentityFingerprint,
      derivationKind: 'visual_description',
      contentOrigin: 'derived_visual_description',
      authority: 'derived',
      evidenceAdmissibility: 'advisory_nonblocking',
      validationStatus: 'accepted',
      generatorIdentity: 'provider_visual_description',
      generatorVersion: VISUAL_DESCRIPTION_GENERATOR_VERSION,
      provider: provider.name,
      providerModel: identity.providerModel,
      providerEndpointIdentity: identity.providerEndpointIdentity,
      providerRuntimeIdentity: identity.providerRuntimeIdentity,
      configurationFingerprint: identity.configurationFingerprint,
      contextMode: 'image_only',
      contextFingerprint: null,
      transport,
      payload: VisualDescriptionPayloadSchema.parse(payload),
      reusedFromDerivationId,
      createdAt: clock.now().toISOString(),
    };
  }

  async function prepare(
    workspaceId: string,
    materialId: string,
    visualRef: string,
    rawInput: unknown,
    options?: ProviderCallOptions,
  ): Promise<VisualPreparationResponse> {
    const input = VisualPreparationRequestSchema.parse(rawInput);
    const resolved = resolveVisual(workspaceId, materialId, visualRef);
    throwIfCancelled(options?.signal);
    const bytes = repos.materials.getAssetBytes(resolved.asset.id);
    if (!bytes)
      throw new AppError(ApiErrorCode.VersionConflict, 'Original visual bytes are missing.');
    const prepared = await prepareVisualTransport(
      bytes,
      VisualMediaTypeSchema.parse(resolved.asset.mediaType),
      options?.signal,
    );
    throwIfCancelled(options?.signal);
    const identity = derivationIdentity(resolved, provider, prepared.transport.fingerprint);
    const operationKey = `visual-description:${visualRef}:${input.commandId}`;
    const startedAt = clock.now();
    repos.operations.recoverExpiredForWorkspace(
      workspaceId,
      'prepare_visual_description',
      startedAt.toISOString(),
    );
    const inFlight = repos.operations.findLatestByIdempotencyPrefix(
      workspaceId,
      'prepare_visual_description',
      `visual-description:${visualRef}:`,
      ['queued', 'running'],
    );
    if (inFlight && inFlight.idempotencyKey !== operationKey) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Visual preparation is in progress.');
    }
    let created: ReturnType<Repositories['operations']['createOrGet']>;
    try {
      created = repos.operations.createOrGet({
        id: newId('op'),
        workspaceId,
        commandId: operationKey,
        idempotencyKey: operationKey,
        logicalOperationId: operationKey,
        operationType: 'prepare_visual_description',
        expectedFingerprint: identity.semanticIdentityFingerprint,
        createdAt: startedAt.toISOString(),
        updatedAt: startedAt.toISOString(),
      });
    } catch (error) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Visual command identity was reused.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const priorResult = repos.operations.getResult(created.operation.id);
    if (priorResult?.status === 'completed') {
      return VisualPreparationResponseSchema.parse(priorResult.payload);
    }
    if (priorResult) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'The prior visual preparation did not complete successfully.',
      );
    }
    const owner = newId('worker');
    const claim = repos.operations.claim(
      created.operation.id,
      owner,
      new Date(
        startedAt.getTime() + visualPreparationLeaseMs(provider, options?.timeoutMs),
      ).toISOString(),
      startedAt.toISOString(),
    );
    if (!claim) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Visual preparation is in progress.');
    }

    try {
      throwIfCancelled(options?.signal);
      assertStillCurrent(resolved);
      const existing = repos.visualDerivations.getByIdentity(identity.identityFingerprint);
      if (existing) {
        const response = VisualPreparationResponseSchema.parse({
          status: 'reused',
          visual: project(resolved),
        });
        const completed = repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'completed',
            payload: response,
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
        if (!completed) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Visual reuse lost its operation lease.',
          );
        }
        return response;
      }

      const reusable = repos.visualDerivations.findReusable(identity.semanticIdentityFingerprint);
      if (reusable) {
        return repos.transaction(() => {
          throwIfCancelled(options?.signal);
          assertStillCurrent(resolved);
          const concurrent = repos.visualDerivations.getByIdentity(identity.identityFingerprint);
          if (!concurrent) {
            repos.visualDerivations.create(
              materialize(resolved, identity, reusable.transport, reusable.payload, reusable.id),
            );
          }
          const response = VisualPreparationResponseSchema.parse({
            status: 'reused',
            visual: project(resolved),
          });
          const completed = repos.operations.finalize(
            {
              operationId: claim.id,
              status: 'completed',
              payload: response,
              createdAt: clock.now().toISOString(),
            },
            owner,
            claim.fencingToken,
          );
          if (!completed) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Visual reuse was fenced by a stale operation lease.',
            );
          }
          return response;
        });
      }

      const policyFingerprint = enforceAgentCostPolicies(repos, {
        workspaceId,
        operationType: 'prepare_visual_description',
        studySessionId: null,
        at: clock.now().toISOString(),
        confirmedPolicyIds: input.confirmedCostPolicyIds ?? [],
      });
      const payload = await runTrackedAgentProviderOperation({
        repos,
        clock,
        provider,
        providerModel: identity.providerModel,
        operationId: claim.id,
        fencingToken: claim.fencingToken,
        workspaceId,
        studySessionId: null,
        learningUnitId: null,
        assessmentId: null,
        operationType: 'prepare_visual_description',
        schemaFingerprint: VISUAL_DESCRIPTION_SCHEMA_FINGERPRINT,
        policyFingerprint,
        sourceFingerprint: identity.semanticIdentityFingerprint,
        providerOptions: {
          ...options,
          onRepairAttempt: (reason, category) => {
            throwIfCancelled(options?.signal);
            assertStillCurrent(resolved);
            if (category) options?.onRepairAttempt?.(reason, category);
            else options?.onRepairAttempt?.(reason);
            throwIfCancelled(options?.signal);
          },
          beforeTelemetryComplete: () => {
            throwIfCancelled(options?.signal);
            assertStillCurrent(resolved);
            options?.beforeTelemetryComplete?.();
            throwIfCancelled(options?.signal);
          },
        },
        invoke: (providerOptions) =>
          provider.describeVisual(
            {
              image: {
                dataBase64: prepared.bytes.toString('base64'),
                mediaType: prepared.transport.mediaType,
                width: prepared.transport.width,
                height: prepared.transport.height,
                byteLength: prepared.transport.byteLength,
              },
              limits: LIMITS,
            },
            {
              ...providerOptions,
              validateCandidate: semanticCandidateValidation,
            },
          ),
      });
      return repos.transaction(() => {
        throwIfCancelled(options?.signal);
        assertStillCurrent(resolved);
        const concurrent = repos.visualDerivations.getByIdentity(identity.identityFingerprint);
        if (!concurrent) {
          repos.visualDerivations.create(
            materialize(resolved, identity, prepared.transport, payload, null),
          );
        }
        const response = VisualPreparationResponseSchema.parse({
          status: concurrent ? 'reused' : 'prepared',
          visual: project(resolved),
        });
        const completed = repos.operations.finalize(
          {
            operationId: claim.id,
            status: 'completed',
            payload: response,
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
        if (!completed) {
          throw new AppError(
            ApiErrorCode.VersionConflict,
            'Visual result was fenced by a stale operation lease.',
          );
        }
        return response;
      });
    } catch (error) {
      const current = repos.operations.get(claim.id);
      if (
        current?.status === 'running' &&
        current.leaseOwner === owner &&
        current.fencingToken === claim.fencingToken
      ) {
        const cancelled =
          options?.signal?.aborted === true ||
          (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled);
        repos.operations.finalize(
          {
            operationId: claim.id,
            status: cancelled ? 'cancelled' : 'failed',
            payload: {
              message:
                error instanceof Error ? error.message.slice(0, 500) : 'Visual preparation failed.',
            },
            createdAt: clock.now().toISOString(),
          },
          owner,
          claim.fencingToken,
        );
      }
      throw error;
    }
  }

  return {
    list(workspaceId: string, materialId: string): VisualSourceProjection[] {
      return activeVisuals(workspaceId, materialId).map(project);
    },
    prepare,
  };
}

export type VisualPreparationService = ReturnType<typeof createVisualPreparationService>;
