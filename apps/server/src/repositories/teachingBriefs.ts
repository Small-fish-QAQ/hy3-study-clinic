import {
  ApiErrorCode,
  LessonPedagogyEvaluationSchema,
  StudyPlanItemSchema,
  TeachingBriefSchema,
  TeachingLessonSlotContentsSchema,
  TeachingSkeletonSchema,
  teachingBriefMatchesAcceptedLessonProjection,
  type TeachingBrief,
} from '@hy3-clinic/shared';
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

function parseObjectiveIds(payload: string): string[] | undefined {
  try {
    const parsed = StudyPlanItemSchema.shape.objectiveIds.safeParse(JSON.parse(payload));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
    acceptedLessonCheckpointId: string;
  }): TeachingBrief | undefined {
    const rows = db
      .prepare(
        `SELECT * FROM teaching_briefs
         WHERE workspace_id = @workspaceId
           AND curriculum_id = @curriculumVersionId
           AND study_plan_id = @studyPlanVersionId
           AND learning_unit_id = @learningUnitId
           AND manifest_fingerprint = @manifestFingerprint
           AND source_context_fingerprint = @sourceContextFingerprint
         ORDER BY created_at DESC, id DESC`,
      )
      .all(input) as TeachingBriefRow[];
    for (const row of rows) {
      const brief = hydrate(row);
      if (brief.composition?.acceptedLessonCheckpointId === input.acceptedLessonCheckpointId) {
        return brief;
      }
    }
    return undefined;
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
    if (brief.composition) {
      const predecessor = db
        .prepare(
          `SELECT workspace_id, curriculum_id, study_plan_id, learning_unit_id,
                  study_session_id,
                  study_plan_item_id,
                  manifest_fingerprint, source_context_fingerprint,
                  skeleton_version, skeleton_fingerprint, operation_id,
                  lesson_logical_call_id, skeleton_payload, lesson_payload,
                  lesson_evaluation_payload, prompt_version
           FROM accepted_lesson_checkpoints WHERE id = ?`,
        )
        .get(brief.composition.acceptedLessonCheckpointId) as
        | {
            workspace_id: string;
            curriculum_id: string;
            study_plan_id: string;
            learning_unit_id: string;
            study_session_id: string;
            study_plan_item_id: string;
            manifest_fingerprint: string;
            source_context_fingerprint: string;
            skeleton_version: number;
            skeleton_fingerprint: string;
            operation_id: string;
            lesson_logical_call_id: string | null;
            skeleton_payload: string;
            lesson_payload: string;
            lesson_evaluation_payload: string;
            prompt_version: string;
          }
        | undefined;
      const practiceOperation = db
        .prepare(`SELECT workspace_id, status, operation_type FROM agent_operations WHERE id = ?`)
        .get(brief.composition.practiceOperationId) as
        { workspace_id: string; status: string; operation_type: string } | undefined;
      const practiceLogicalCall = brief.composition.practiceLogicalCallId
        ? (db
            .prepare(
              `SELECT operation_id, workspace_id, study_session_id, learning_unit_id,
                      operation_type, schema_fingerprint, source_fingerprint, status
                 FROM model_logical_calls WHERE id = ?`,
            )
            .get(brief.composition.practiceLogicalCallId) as
            | {
                operation_id: string | null;
                workspace_id: string | null;
                study_session_id: string | null;
                learning_unit_id: string | null;
                operation_type: string;
                schema_fingerprint: string | null;
                source_fingerprint: string | null;
                status: string;
              }
            | undefined)
        : undefined;
      const planItem = predecessor
        ? (db
            .prepare(
              `SELECT objective_ids FROM study_plan_items
               WHERE plan_id = ? AND plan_item_id = ?
                 AND curriculum_learning_unit_id = ?`,
            )
            .get(
              predecessor.study_plan_id,
              predecessor.study_plan_item_id,
              predecessor.learning_unit_id,
            ) as { objective_ids: string } | undefined)
        : undefined;
      const objectiveIds = planItem ? parseObjectiveIds(planItem.objective_ids) : undefined;
      const hasLogicalCallProvenance =
        brief.composition.lessonLogicalCallId !== undefined &&
        brief.composition.practiceLogicalCallId !== undefined;
      const requiresLogicalCallProvenance = brief.promptVersion.startsWith(
        'teaching-brief-v3-compositional',
      );
      const matchesAcceptedLessonProjection =
        predecessor && objectiveIds
          ? teachingBriefMatchesAcceptedLessonProjection(
              brief,
              {
                id: brief.composition.acceptedLessonCheckpointId,
                skeleton: TeachingSkeletonSchema.parse(JSON.parse(predecessor.skeleton_payload)),
                lessonContent: TeachingLessonSlotContentsSchema.parse(
                  JSON.parse(predecessor.lesson_payload),
                ),
                lessonEvaluation: LessonPedagogyEvaluationSchema.parse(
                  JSON.parse(predecessor.lesson_evaluation_payload),
                ),
                promptVersion: predecessor.prompt_version,
              },
              objectiveIds,
            )
          : false;
      const jointIds = predecessor
        ? LessonPedagogyEvaluationSchema.parse(JSON.parse(predecessor.lesson_evaluation_payload))
            .jointAuthoring?.logicalCallIds
        : undefined;
      const practiceFromAcceptedCapsule = Boolean(
        jointIds?.includes(brief.composition.practiceLogicalCallId!) &&
        practiceLogicalCall?.schema_fingerprint === 'teaching-capsule-v1' &&
        practiceLogicalCall.operation_id === predecessor?.operation_id,
      );
      if (
        !predecessor ||
        predecessor.workspace_id !== brief.workspaceId ||
        predecessor.curriculum_id !== brief.curriculumVersionId ||
        predecessor.study_plan_id !== brief.studyPlanVersionId ||
        predecessor.learning_unit_id !== brief.learningUnitId ||
        predecessor.manifest_fingerprint !== brief.executionSourceManifestFingerprint ||
        predecessor.source_context_fingerprint !== brief.sourceContextFingerprint ||
        predecessor.skeleton_version !== brief.composition.skeletonSchemaVersion ||
        predecessor.skeleton_fingerprint !== brief.composition.skeletonFingerprint ||
        predecessor.operation_id !== brief.composition.lessonOperationId ||
        !matchesAcceptedLessonProjection ||
        !practiceOperation ||
        practiceOperation.workspace_id !== brief.workspaceId ||
        practiceOperation.status !== 'running' ||
        practiceOperation.operation_type !== 'prepare_teaching_brief' ||
        (requiresLogicalCallProvenance && !hasLogicalCallProvenance) ||
        (hasLogicalCallProvenance &&
          (predecessor.lesson_logical_call_id !== brief.composition.lessonLogicalCallId ||
            !practiceLogicalCall ||
            (!practiceFromAcceptedCapsule &&
              practiceLogicalCall.operation_id !== brief.composition.practiceOperationId) ||
            practiceLogicalCall.workspace_id !== brief.workspaceId ||
            practiceLogicalCall.study_session_id !== predecessor.study_session_id ||
            practiceLogicalCall.learning_unit_id !== brief.learningUnitId ||
            practiceLogicalCall.operation_type !== 'prepare_teaching_brief' ||
            (!practiceFromAcceptedCapsule &&
              practiceLogicalCall.schema_fingerprint !== 'practice-content-proposal-v1') ||
            practiceLogicalCall.source_fingerprint !== brief.sourceContextFingerprint ||
            practiceLogicalCall.status !== 'completed'))
      ) {
        throw new AppError(
          ApiErrorCode.VersionConflict,
          'Compositional Teaching Brief persistence requires its exact accepted Lesson predecessor and active Practice operation.',
        );
      }
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
