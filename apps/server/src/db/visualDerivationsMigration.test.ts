import { createHash } from 'node:crypto';
import type { EmbeddedAsset, VisualDerivation } from '@hy3-clinic/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { makeMaterial, makeWorkspace } from '../testing/fixtures.js';
import { openDatabase, type SqliteDb } from './database.js';
import { migrate } from './migrate.js';

const AT = '2026-08-19T00:00:00.000Z';
let db: SqliteDb | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function hash(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function insertImageMaterial(
  repos: Repositories,
  materialId: string,
  bytes: Buffer,
): EmbeddedAsset {
  const byteHash = hash(bytes);
  repos.materials.insertWithBlocks(
    makeMaterial({
      id: materialId,
      workspaceId: 'ws_visual_migration',
      title: `Image ${materialId}`,
      sourceType: 'image',
      mediaType: 'image/png',
      originalFilename: `${materialId}.png`,
      content: '',
      charCount: 0,
      parserVersion: 'standalone-image-sharp-v1',
      createdAt: AT,
      updatedAt: AT,
    }),
    [],
    bytes,
    [],
    { sourceFingerprint: byteHash },
    [
      {
        id: `${materialId}:candidate-asset`,
        materialId,
        materialRevisionId: `${materialId}:candidate`,
        index: 0,
        parentStructuralUnitId: null,
        sourcePath: 'original-image',
        mediaType: 'image/png',
        byteHash,
        byteLength: bytes.length,
        width: 320,
        height: 200,
        location: { domPath: 'standalone:image' },
        relationshipKind: 'image',
        contentOrigin: 'extracted_original',
        parserVersion: 'standalone-image-sharp-v1',
        bytes,
      },
    ],
  );
  return repos.materials.getAssets(materialId)[0]!;
}

function derivation(asset: EmbeddedAsset, hex: string): VisualDerivation {
  return {
    id: `visual_derivation_${hex}`,
    materialId: asset.materialId,
    materialRevisionId: asset.materialRevisionId,
    assetId: asset.id,
    assetByteHash: asset.byteHash,
    identityFingerprint: `visual_derivation_${hex.repeat(64)}`,
    semanticIdentityFingerprint: `visual_semantic_${hex.repeat(64)}`,
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
    configurationFingerprint: `sha256:${hex.repeat(64)}`,
    contextMode: 'image_only',
    contextFingerprint: null,
    transport: {
      mediaType: 'image/png',
      width: 320,
      height: 200,
      byteLength: asset.byteLength,
      transformation: 'validated_original',
      preparationVersion: 'sharp-test-v1',
      fingerprint: asset.byteHash,
    },
    payload: {
      description: `Migration fixture visual ${hex}.`,
      visualType: 'diagram',
      visibleText: null,
      importantConcepts: ['migration'],
      pedagogicalNotes: [],
      uncertainty: [],
    },
    reusedFromDerivationId: null,
    createdAt: AT,
  };
}

function insertCopiedRow(
  sourceId: string,
  suffix: string,
  overrides: Record<string, unknown>,
): void {
  const columns = (db!.pragma('table_info(visual_derivations)') as Array<{ name: string }>).map(
    (column) => column.name,
  );
  const source = db!
    .prepare('SELECT * FROM visual_derivations WHERE id = ?')
    .get(sourceId) as Record<string, unknown>;
  const values = {
    ...source,
    id: `visual_derivation_raw_${suffix}`,
    identity_fingerprint: `visual_derivation_${suffix.repeat(64)}`,
    ...overrides,
  };
  db!
    .prepare(
      `INSERT INTO visual_derivations (${columns.join(', ')})
       VALUES (${columns.map((column) => `@${column}`).join(', ')})`,
    )
    .run(values);
}

describe('visual derivation invariants across migration 26', () => {
  it('enforces exact original occurrence binding and immutable accepted rows on a fresh install', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.workspaces.insert(
      makeWorkspace({ id: 'ws_visual_migration', name: 'Visual migration course' }),
    );
    const first = insertImageMaterial(repos, 'mat_visual_first', Buffer.from('first image bytes'));
    const second = insertImageMaterial(
      repos,
      'mat_visual_second',
      Buffer.from('second image bytes'),
    );
    const accepted = repos.visualDerivations.create(derivation(first, 'a'));

    expect(repos.visualDerivations.get(accepted.id)).toEqual(accepted);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND tbl_name = 'visual_derivations'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'guard_visual_derivation_source_binding' },
      { name: 'prevent_direct_visual_derivation_delete' },
      { name: 'prevent_visual_derivation_update' },
    ]);

    for (const [suffix, overrides] of [
      ['b', { material_id: second.materialId }],
      ['c', { material_revision_id: second.materialRevisionId }],
      ['d', { asset_id: second.id }],
      ['e', { asset_byte_hash: second.byteHash }],
    ] as const) {
      expect(() => insertCopiedRow(accepted.id, suffix, overrides)).toThrow(
        /visual derivation source binding mismatch/u,
      );
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM visual_derivations').get()).toEqual({
      count: 1,
    });
    expect(() =>
      db!
        .prepare('UPDATE visual_derivations SET description = ? WHERE id = ?')
        .run('Mutated description', accepted.id),
    ).toThrow(/visual derivations are immutable/u);
    expect(() =>
      db!.prepare('DELETE FROM visual_derivations WHERE id = ?').run(accepted.id),
    ).toThrow(/visual derivations are immutable/u);
    expect(repos.visualDerivations.get(accepted.id)).toEqual(accepted);

    expect(repos.materials.purge(first.materialId)).toBe(true);
    expect(repos.visualDerivations.get(accepted.id)).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades populated v24 assets without changing bytes or occurrence provenance', () => {
    db = openDatabase(':memory:');
    migrate(db, { toVersion: 24 });
    const legacyRepos = createRepositories(db);
    legacyRepos.workspaces.insert(
      makeWorkspace({ id: 'ws_visual_migration', name: 'Visual migration course' }),
    );
    const originalBytes = Buffer.from('v24 original visual bytes');
    const legacyAsset = insertImageMaterial(legacyRepos, 'mat_visual_legacy', originalBytes);

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'visual_derivations'").get(),
    ).toBeUndefined();
    expect(legacyRepos.visualDerivations.listForAsset(legacyAsset.id)).toEqual([]);

    migrate(db, { toVersion: 25 });
    const historical = derivation(legacyAsset, 'f');
    db.prepare(
      `INSERT INTO visual_derivations (
         id, material_id, material_revision_id, asset_id, asset_byte_hash,
         identity_fingerprint, semantic_identity_fingerprint, derivation_kind,
         content_origin, authority, evidence_admissibility, validation_status,
         generator_identity, generator_version, provider, provider_model,
         configuration_fingerprint, context_mode, context_fingerprint,
         transport_media_type, transport_width, transport_height, transport_byte_length,
         transport_transformation, transport_preparation_version, transport_fingerprint,
         description, visual_type, visible_text, important_concepts, pedagogical_notes,
         uncertainty, reused_from_derivation_id, created_at
       ) VALUES (
         @id, @materialId, @materialRevisionId, @assetId, @assetByteHash,
         @identityFingerprint, @semanticIdentityFingerprint, @derivationKind,
         @contentOrigin, @authority, @evidenceAdmissibility, @validationStatus,
         @generatorIdentity, @generatorVersion, @provider, @providerModel,
         @configurationFingerprint, @contextMode, @contextFingerprint,
         @transportMediaType, @transportWidth, @transportHeight, @transportByteLength,
         @transportTransformation, @transportPreparationVersion, @transportFingerprint,
         @description, @visualType, @visibleText, @importantConcepts, @pedagogicalNotes,
         @uncertainty, @reusedFromDerivationId, @createdAt
       )`,
    ).run({
      ...historical,
      transportMediaType: historical.transport.mediaType,
      transportWidth: historical.transport.width,
      transportHeight: historical.transport.height,
      transportByteLength: historical.transport.byteLength,
      transportTransformation: historical.transport.transformation,
      transportPreparationVersion: historical.transport.preparationVersion,
      transportFingerprint: historical.transport.fingerprint,
      description: historical.payload.description,
      visualType: historical.payload.visualType,
      visibleText: historical.payload.visibleText,
      importantConcepts: JSON.stringify(historical.payload.importantConcepts),
      pedagogicalNotes: JSON.stringify(historical.payload.pedagogicalNotes),
      uncertainty: JSON.stringify(historical.payload.uncertainty),
    });
    insertCopiedRow(historical.id, 'g', {
      reused_from_derivation_id: historical.id,
      identity_fingerprint: `visual_derivation_${'e'.repeat(64)}`,
    });
    migrate(db);
    const repos = createRepositories(db);
    expect(repos.materialRevisions.getAssets(legacyAsset.materialRevisionId)).toEqual([
      legacyAsset,
    ]);
    expect(repos.materialRevisions.getAssetBytes(legacyAsset.id)).toEqual(originalBytes);
    expect(
      db.prepare('SELECT media_type, byte_length, original_data FROM source_asset_blobs').get(),
    ).toEqual({
      media_type: 'image/png',
      byte_length: originalBytes.length,
      original_data: originalBytes,
    });

    const accepted = repos.visualDerivations.get(historical.id)!;
    const reused = repos.visualDerivations.get('visual_derivation_raw_g')!;
    expect(repos.visualDerivations.listForAsset(legacyAsset.id)).toHaveLength(2);
    expect(accepted).toMatchObject({
      ...historical,
      providerEndpointIdentity: 'historical:unrecorded',
      providerRuntimeIdentity: 'historical:unrecorded',
    });
    expect(reused).toMatchObject({
      ...historical,
      id: 'visual_derivation_raw_g',
      identityFingerprint: `visual_derivation_${'e'.repeat(64)}`,
      providerEndpointIdentity: 'historical:unrecorded',
      providerRuntimeIdentity: 'historical:unrecorded',
      reusedFromDerivationId: historical.id,
    });
    expect(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 26').get(),
    ).toEqual({ version: 26, name: 'visual_provider_runtime_identity' });
    expect(
      db
        .prepare(
          'SELECT provider_endpoint_identity, provider_runtime_identity FROM visual_derivations WHERE id = ?',
        )
        .get(accepted.id),
    ).toEqual({
      provider_endpoint_identity: 'historical:unrecorded',
      provider_runtime_identity: 'historical:unrecorded',
    });
    expect(accepted).toMatchObject({
      assetId: legacyAsset.id,
      assetByteHash: legacyAsset.byteHash,
      providerEndpointIdentity: 'historical:unrecorded',
      providerRuntimeIdentity: 'historical:unrecorded',
    });
    expect(reused.reusedFromDerivationId).toBe(historical.id);
    expect(() =>
      db!
        .prepare('UPDATE visual_derivations SET description = ? WHERE id = ?')
        .run('mutated historical row', accepted.id),
    ).toThrow(/visual derivations are immutable/u);
    expect(() =>
      db!.prepare('DELETE FROM visual_derivations WHERE id = ?').run(accepted.id),
    ).toThrow(/visual derivations are immutable/u);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
