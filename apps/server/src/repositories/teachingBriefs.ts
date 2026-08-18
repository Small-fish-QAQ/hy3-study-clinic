import { TeachingBriefSchema, type TeachingBrief } from '@hy3-clinic/shared';
import type { SqliteDb } from '../db/database.js';
import { curriculumSourceBlockFingerprint } from '../grounding/sourceFingerprint.js';

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
      throw new Error('Teaching Brief persistence requires its exact accepted Course route.');
    }
    for (const reference of brief.sourceReferences) {
      const block = db
        .prepare(
          `SELECT b.id, b.idx, b.content, b.start_offset, b.end_offset,
                  b.material_id, b.material_revision_id, m.workspace_id
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
          },
          block.material_revision_id,
        ) !== reference.sourceBlockRevisionFingerprint ||
        block.content.slice(reference.startOffset, reference.endOffset) !== reference.quote
      ) {
        throw new Error('Teaching Brief source provenance is stale, foreign, or inexact.');
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
