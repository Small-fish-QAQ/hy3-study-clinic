import {
  VisualDerivationSchema,
  type VisualDerivation,
  type VisualDescriptionPayload,
} from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';

interface VisualDerivationRow {
  id: string;
  material_id: string;
  material_revision_id: string;
  asset_id: string;
  asset_byte_hash: string;
  identity_fingerprint: string;
  semantic_identity_fingerprint: string;
  derivation_kind: 'visual_description';
  content_origin: 'derived_visual_description';
  authority: 'derived';
  evidence_admissibility: 'advisory_nonblocking';
  validation_status: 'accepted';
  generator_identity: 'provider_visual_description';
  generator_version: string;
  provider: 'fake' | 'hy3' | 'tokenhub';
  provider_model: string | null;
  provider_endpoint_identity: string;
  provider_runtime_identity: string;
  configuration_fingerprint: string;
  context_mode: 'image_only';
  context_fingerprint: null;
  transport_media_type: 'image/png' | 'image/jpeg' | 'image/webp';
  transport_width: number;
  transport_height: number;
  transport_byte_length: number;
  transport_transformation: 'validated_original' | 'auto_orient_resize_transcode';
  transport_preparation_version: string;
  transport_fingerprint: string;
  description: string;
  visual_type: VisualDescriptionPayload['visualType'];
  visible_text: string | null;
  important_concepts: string;
  pedagogical_notes: string;
  uncertainty: string;
  reused_from_derivation_id: string | null;
  created_at: string;
}

function hydrate(row: VisualDerivationRow): VisualDerivation {
  return VisualDerivationSchema.parse({
    id: row.id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    assetId: row.asset_id,
    assetByteHash: row.asset_byte_hash,
    identityFingerprint: row.identity_fingerprint,
    semanticIdentityFingerprint: row.semantic_identity_fingerprint,
    derivationKind: row.derivation_kind,
    contentOrigin: row.content_origin,
    authority: row.authority,
    evidenceAdmissibility: row.evidence_admissibility,
    validationStatus: row.validation_status,
    generatorIdentity: row.generator_identity,
    generatorVersion: row.generator_version,
    provider: row.provider,
    providerModel: row.provider_model,
    providerEndpointIdentity: row.provider_endpoint_identity,
    providerRuntimeIdentity: row.provider_runtime_identity,
    configurationFingerprint: row.configuration_fingerprint,
    contextMode: row.context_mode,
    contextFingerprint: row.context_fingerprint,
    transport: {
      mediaType: row.transport_media_type,
      width: row.transport_width,
      height: row.transport_height,
      byteLength: row.transport_byte_length,
      transformation: row.transport_transformation,
      preparationVersion: row.transport_preparation_version,
      fingerprint: row.transport_fingerprint,
    },
    payload: {
      description: row.description,
      visualType: row.visual_type,
      visibleText: row.visible_text,
      importantConcepts: JSON.parse(row.important_concepts) as unknown,
      pedagogicalNotes: JSON.parse(row.pedagogical_notes) as unknown,
      uncertainty: JSON.parse(row.uncertainty) as unknown,
    },
    reusedFromDerivationId: row.reused_from_derivation_id,
    createdAt: row.created_at,
  });
}

export function createVisualDerivationsRepo(db: SqliteDb) {
  const tableExists = Boolean(
    (
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'visual_derivations'",
        )
        .get() as { present?: number } | undefined
    )?.present,
  );
  const insert = tableExists
    ? db.prepare(
        `INSERT INTO visual_derivations (
       id, material_id, material_revision_id, asset_id, asset_byte_hash,
       identity_fingerprint, semantic_identity_fingerprint, derivation_kind,
       content_origin, authority, evidence_admissibility, validation_status,
        generator_identity, generator_version, provider, provider_model,
        provider_endpoint_identity, provider_runtime_identity,
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
        @providerEndpointIdentity, @providerRuntimeIdentity,
       @configurationFingerprint, @contextMode, @contextFingerprint,
       @transportMediaType, @transportWidth, @transportHeight, @transportByteLength,
       @transportTransformation, @transportPreparationVersion, @transportFingerprint,
       @description, @visualType, @visibleText, @importantConcepts, @pedagogicalNotes,
       @uncertainty, @reusedFromDerivationId, @createdAt
     )`,
      )
    : null;

  function get(id: string): VisualDerivation | undefined {
    const row = db.prepare('SELECT * FROM visual_derivations WHERE id = ?').get(id) as
      VisualDerivationRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  return {
    create(raw: VisualDerivation): VisualDerivation {
      if (!insert) throw new Error('Visual derivation persistence requires migration 25.');
      const derivation = VisualDerivationSchema.parse(raw);
      const binding = db
        .prepare(
          `SELECT a.material_id, a.material_revision_id, a.byte_hash
           FROM material_revision_assets a WHERE a.id = ?`,
        )
        .get(derivation.assetId) as
        { material_id: string; material_revision_id: string; byte_hash: string } | undefined;
      if (
        !binding ||
        binding.material_id !== derivation.materialId ||
        binding.material_revision_id !== derivation.materialRevisionId ||
        binding.byte_hash !== derivation.assetByteHash
      ) {
        throw new Error('Visual derivation original-asset binding is stale or foreign.');
      }
      if (derivation.reusedFromDerivationId) {
        const reused = get(derivation.reusedFromDerivationId);
        if (
          !reused ||
          reused.semanticIdentityFingerprint !== derivation.semanticIdentityFingerprint ||
          reused.assetByteHash !== derivation.assetByteHash ||
          JSON.stringify(reused.payload) !== JSON.stringify(derivation.payload)
        ) {
          throw new Error('Visual derivation reuse identity is invalid.');
        }
      }
      insert.run({
        ...derivation,
        transportMediaType: derivation.transport.mediaType,
        transportWidth: derivation.transport.width,
        transportHeight: derivation.transport.height,
        transportByteLength: derivation.transport.byteLength,
        transportTransformation: derivation.transport.transformation,
        transportPreparationVersion: derivation.transport.preparationVersion,
        transportFingerprint: derivation.transport.fingerprint,
        description: derivation.payload.description,
        visualType: derivation.payload.visualType,
        visibleText: derivation.payload.visibleText,
        importantConcepts: JSON.stringify(derivation.payload.importantConcepts),
        pedagogicalNotes: JSON.stringify(derivation.payload.pedagogicalNotes),
        uncertainty: JSON.stringify(derivation.payload.uncertainty),
      });
      return get(derivation.id)!;
    },

    get(id: string): VisualDerivation | undefined {
      if (!tableExists) return undefined;
      return get(id);
    },

    getByIdentity(identityFingerprint: string): VisualDerivation | undefined {
      if (!tableExists) return undefined;
      const row = db
        .prepare('SELECT * FROM visual_derivations WHERE identity_fingerprint = ?')
        .get(identityFingerprint) as VisualDerivationRow | undefined;
      return row ? hydrate(row) : undefined;
    },

    findReusable(semanticIdentityFingerprint: string): VisualDerivation | undefined {
      if (!tableExists) return undefined;
      const row = db
        .prepare(
          `SELECT * FROM visual_derivations
           WHERE semantic_identity_fingerprint = ?
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get(semanticIdentityFingerprint) as VisualDerivationRow | undefined;
      return row ? hydrate(row) : undefined;
    },

    listForAsset(assetId: string): VisualDerivation[] {
      if (!tableExists) return [];
      const rows = db
        .prepare(
          `SELECT * FROM visual_derivations
           WHERE asset_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(assetId) as VisualDerivationRow[];
      return rows.map(hydrate);
    },

    listForRevision(materialRevisionId: string): VisualDerivation[] {
      if (!tableExists) return [];
      const rows = db
        .prepare(
          `SELECT * FROM visual_derivations
           WHERE material_revision_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(materialRevisionId) as VisualDerivationRow[];
      return rows.map(hydrate);
    },
  };
}

export type VisualDerivationsRepo = ReturnType<typeof createVisualDerivationsRepo>;
