import { ApiErrorCode, TeachingBriefSchema, type TeachingBrief } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';
import { AppError } from '../errors.js';

interface TeachingBriefRow {
  id: string;
  workspace_id: string;
  curriculum_id: string;
  study_plan_id: string;
  learning_unit_id: string;
  manifest_fingerprint: string;
  source_context_fingerprint: string;
  payload: string;
  provider: string;
  provider_model: string | null;
  prompt_version: string;
  created_at: string;
}

function hydrate(row: TeachingBriefRow): TeachingBrief {
  return TeachingBriefSchema.parse({
    ...(JSON.parse(row.payload) as object),
    id: row.id,
    workspaceId: row.workspace_id,
    curriculumVersionId: row.curriculum_id,
    studyPlanVersionId: row.study_plan_id,
    learningUnitId: row.learning_unit_id,
    executionSourceManifestFingerprint: row.manifest_fingerprint,
    sourceContextFingerprint: row.source_context_fingerprint,
    provider: row.provider,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  });
}

export function createTeachingBriefsRepo(db: SqliteDb) {
  function get(id: string): TeachingBrief | undefined {
    const row = db.prepare('SELECT * FROM teaching_briefs WHERE id = ?').get(id) as
      TeachingBriefRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  function findReusable(input: {
    workspaceId: string;
    curriculumVersionId: string;
    studyPlanVersionId: string;
    learningUnitId: string;
    manifestFingerprint: string;
    sourceContextFingerprint: string;
  }): TeachingBrief | undefined {
    const row = db
      .prepare(
        `SELECT * FROM teaching_briefs
         WHERE workspace_id = @workspaceId
           AND curriculum_id = @curriculumVersionId
           AND study_plan_id = @studyPlanVersionId
           AND learning_unit_id = @learningUnitId
           AND manifest_fingerprint = @manifestFingerprint
           AND source_context_fingerprint = @sourceContextFingerprint
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input) as TeachingBriefRow | undefined;
    return row ? hydrate(row) : undefined;
  }

  const createTx = db.transaction((input: TeachingBrief): TeachingBrief => {
    const brief = TeachingBriefSchema.parse(input);
    const route = db
      .prepare(
        `SELECT c.workspace_id, c.status AS curriculum_status,
                p.status AS plan_status, p.curriculum_id,
                p.manifest_fingerprint AS plan_manifest_fingerprint,
                n.kind AS node_kind
         FROM curriculum_versions c
         JOIN study_plan_versions p ON p.id = ?
         JOIN curriculum_node_index n ON n.curriculum_id = c.id AND n.node_id = ?
         WHERE c.id = ?`,
      )
      .get(brief.studyPlanVersionId, brief.learningUnitId, brief.curriculumVersionId) as
      | {
          workspace_id: string;
          curriculum_status: string;
          plan_status: string;
          curriculum_id: string;
          plan_manifest_fingerprint: string;
          node_kind: string;
        }
      | undefined;
    if (
      !route ||
      route.workspace_id !== brief.workspaceId ||
      route.curriculum_status !== 'accepted' ||
      route.plan_status !== 'accepted' ||
      route.curriculum_id !== brief.curriculumVersionId ||
      route.node_kind !== 'learning_unit' ||
      route.plan_manifest_fingerprint !== brief.executionSourceManifestFingerprint
    ) {
      throw new AppError(
        ApiErrorCode.VersionConflict,
        'Teaching Brief persistence requires its exact accepted Course route.',
      );
    }
    for (const reference of brief.sourceReferences) {
      const block = db
        .prepare(
          `SELECT b.id, b.idx, b.content, b.start_offset, b.end_offset,
                  b.chunker_version, b.material_id, b.material_revision_id, m.workspace_id
           FROM source_blocks b JOIN materials m ON m.id = b.material_id
           WHERE b.id = ?`,
        )
        .get(reference.sourceBlockId) as
        | {
            content: string;
            id: string;
            idx: number;
            start_offset: number;
            end_offset: number;
            chunker_version: string | null;
            material_id: string;
            material_revision_id: string;
            workspace_id: string;
          }
        | undefined;
      if (
        !block ||
        block.workspace_id !== brief.workspaceId ||
        block.material_id !== reference.materialId ||
        block.material_revision_id !== reference.materialRevisionId ||
        curriculumSourceBlockFingerprint(
          {
            id: block.id,
            materialId: block.material_id,
            materialRevisionId: block.material_revision_id,
            index: block.idx,
            heading: null,
            headingPath: [],
            pageNumber: null,
            pageEnd: null,
            content: block.content,
            startOffset: block.start_offset,
            endOffset: block.end_offset,
            chunkerVersion: block.chunker_version,
          },
          block.material_revision_id,
        ) !== reference.sourceBlockRevisionFingerprint ||
        block.content.slice(reference.startOffset, reference.endOffset) !== reference.quote
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Teaching Brief source provenance is stale, foreign, or inexact.',
        );
      }
    }
    for (const reference of brief.visualReferences) {
      const manifestRevision = brief.sourceManifest.revisions.find(
        (revision) => revision.materialId === reference.materialId,
      );
      if (manifestRevision?.materialRevisionId !== reference.materialRevisionId) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Teaching Brief visual provenance is outside its source manifest.',
        );
      }
      const binding = db
        .prepare(
          `SELECT vd.material_id, vd.material_revision_id, vd.asset_id,
                  vd.asset_byte_hash, vd.identity_fingerprint, vd.content_origin,
                  vd.authority, vd.evidence_admissibility, vd.validation_status,
                  vd.description, vd.visual_type, vd.important_concepts,
                  vd.pedagogical_notes, vd.uncertainty,
                  a.media_type, a.width, a.height, a.location, a.relationship_kind,
                  a.content_origin AS asset_content_origin,
                  m.workspace_id, m.title, m.source_type, m.active_revision_id, m.availability
           FROM visual_derivations vd
           JOIN material_revision_assets a ON a.id = vd.asset_id
           JOIN materials m ON m.id = vd.material_id
           WHERE vd.id = ? AND a.id = ?`,
        )
        .get(reference.derivationId, reference.assetId) as
        | {
            material_id: string;
            material_revision_id: string;
            asset_id: string;
            asset_byte_hash: string;
            identity_fingerprint: string;
            content_origin: string;
            authority: string;
            evidence_admissibility: string;
            validation_status: string;
            description: string;
            visual_type: string;
            important_concepts: string;
            pedagogical_notes: string;
            uncertainty: string;
            media_type: string;
            width: number | null;
            height: number | null;
            location: string;
            relationship_kind: string;
            asset_content_origin: string;
            workspace_id: string;
            title: string;
            source_type: string;
            active_revision_id: string | null;
            availability: string;
          }
        | undefined;
      const location = binding ? (JSON.parse(binding.location) as Record<string, unknown>) : null;
      const context = reference.context;
      const expectedLocationLabel = binding
        ? location?.slideNumber
          ? `Slide ${location.slideNumber}`
          : location?.pageNumber
            ? `Page ${location.pageNumber}`
            : binding.source_type === 'image'
              ? 'Standalone image'
              : `Embedded visual ${
                  (
                    db
                      .prepare('SELECT idx FROM material_revision_assets WHERE id = ?')
                      .get(reference.assetId) as { idx: number }
                  ).idx + 1
                }`
        : null;
      if (
        !binding ||
        binding.workspace_id !== brief.workspaceId ||
        binding.material_id !== reference.materialId ||
        binding.material_revision_id !== reference.materialRevisionId ||
        binding.asset_id !== reference.assetId ||
        binding.asset_byte_hash !== reference.assetByteHash ||
        binding.identity_fingerprint !== reference.derivationIdentityFingerprint ||
        binding.content_origin !== 'derived_visual_description' ||
        binding.authority !== 'derived' ||
        binding.evidence_admissibility !== 'advisory_nonblocking' ||
        binding.validation_status !== 'accepted' ||
        binding.relationship_kind !== 'image' ||
        binding.asset_content_origin !== 'extracted_original' ||
        binding.active_revision_id !== reference.materialRevisionId ||
        binding.availability !== 'active' ||
        binding.title !== context.materialTitle ||
        (binding.source_type === 'image' ? 'standalone' : 'embedded') !==
          context.source.sourceKind ||
        binding.media_type !== context.source.mediaType ||
        binding.width !== context.source.width ||
        binding.height !== context.source.height ||
        (location?.pageNumber ?? null) !== context.source.location.pageNumber ||
        (location?.slideNumber ?? null) !== context.source.location.slideNumber ||
        expectedLocationLabel !== context.source.location.contextLabel ||
        binding.description !== context.explanation.text ||
        binding.visual_type !== context.explanation.visualType ||
        JSON.stringify(JSON.parse(binding.important_concepts)) !==
          JSON.stringify(context.explanation.importantConcepts) ||
        JSON.stringify(JSON.parse(binding.pedagogical_notes)) !==
          JSON.stringify(context.explanation.pedagogicalNotes) ||
        JSON.stringify(JSON.parse(binding.uncertainty)) !==
          JSON.stringify(context.explanation.uncertainty)
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Teaching Brief visual provenance is stale, foreign, or non-advisory.',
        );
      }
    }
    db.prepare(
      `INSERT INTO teaching_briefs
         (id, workspace_id, curriculum_id, study_plan_id, learning_unit_id,
          manifest_fingerprint, source_context_fingerprint, payload, provider,
          provider_model, prompt_version, created_at)
       VALUES
         (@id, @workspaceId, @curriculumVersionId, @studyPlanVersionId, @learningUnitId,
          @executionSourceManifestFingerprint, @sourceContextFingerprint, @payload, @provider,
          @providerModel, @promptVersion, @createdAt)`,
    ).run({ ...brief, payload: JSON.stringify(brief) });
    return get(brief.id)!;
  });

  return {
    get,
    findReusable,
    create: createTx,
    listForUnit(workspaceId: string, learningUnitId: string): TeachingBrief[] {
      return (
        db
          .prepare(
            `SELECT * FROM teaching_briefs
             WHERE workspace_id = ? AND learning_unit_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .all(workspaceId, learningUnitId) as TeachingBriefRow[]
      ).map(hydrate);
    },
  };
}

export type TeachingBriefsRepo = ReturnType<typeof createTeachingBriefsRepo>;
