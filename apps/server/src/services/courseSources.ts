import type {
  CourseSourceSpan,
  SourceType,
  NormalizedDocument,
  MediaType,
} from '@hy3-clinic/shared';
import type { ClinicRepository } from '../repositories/clinic.js';
import { newClinicId } from '../repositories/clinic.js';
import { AppError } from '../errors.js';
import { sha256, stableId, canonical } from '../util/canonical.js';
import { deriveTitle, ingestSource, sourceTypeForFilename } from '../ingestion/ingest.js';
import { parserForSourceType } from '../ingestion/normalized.js';
import {
  decodeUpload,
  parseBinaryUpload,
  uploadKindForFilename,
  validateUploadDeclaration,
} from '../ingestion/documents.js';
import { checkTextResources } from '../ingestion/resources.js';
import type { SourcePacketBlock } from '../llm/courseContract.js';
import { proofSourceContext } from './knowledgeSourceStructure.js';

export interface ClinicMaterial {
  id: string;
  workspaceId: string;
  title: string;
  revisionId: string;
  sourceType: SourceType;
  filename: string | null;
  warnings: string[];
  charCount: number;
  createdAt: string;
}
export interface ClinicRevision extends ClinicMaterial {
  content: string;
  hash: string;
  normalizedDocument: NormalizedDocument;
}
export class CourseSources {
  constructor(readonly repo: ClinicRepository) {}
  createWorkspace(title: string) {
    const id = newClinicId('workspace');
    const createdAt = this.repo.now();
    this.repo.run('INSERT INTO workspaces VALUES(?,?,?)', id, title, createdAt);
    return { id, title, createdAt };
  }
  workspaces() {
    return this.repo
      .rows<{ id: string; title: string; created_at: string }>(
        'SELECT * FROM workspaces ORDER BY created_at DESC',
      )
      .map((row) => {
        const plan = this.repo.payload<{ id: string; status: string; lessons: unknown[] }>(
          'SELECT payload FROM curriculum_versions WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          row.id,
        );
        const materials = this.materials(row.id);
        const activity =
          this.repo.row<{ at: string | null }>(
            `SELECT MAX(at) AS at FROM (
          SELECT created_at AS at FROM workspaces WHERE id=? UNION ALL
          SELECT created_at FROM materials WHERE workspace_id=? UNION ALL
          SELECT created_at FROM study_turns WHERE workspace_id=? UNION ALL
          SELECT json_extract(payload,'$.updatedAt') FROM agent_operations WHERE workspace_id=?
        )`,
            row.id,
            row.id,
            row.id,
            row.id,
          )?.at ?? row.created_at;
        return {
          id: row.id,
          title: row.title,
          createdAt: row.created_at,
          summary: {
            status: plan?.status ?? (materials.length ? 'materials_ready' : 'empty'),
            lessonCount: plan?.lessons.length ?? 0,
            completedLessons: plan
              ? this.repo.row<{ n: number }>(
                  'SELECT COUNT(DISTINCT lesson_id) AS n FROM lesson_execution_events WHERE workspace_id=? AND curriculum_id=?',
                  row.id,
                  plan.id,
                )!.n
              : 0,
            materialCount: materials.length,
            materialTitles: materials.slice(0, 2).map((m) => m.title),
            lastActivityAt: activity,
            activeOperations: this.repo.row<{ n: number }>(
              "SELECT COUNT(*) AS n FROM agent_operations WHERE workspace_id=? AND status IN ('queued','running')",
              row.id,
            )!.n,
          },
        };
      });
  }
  materials(workspaceId: string) {
    this.repo.workspace(workspaceId);
    return this.repo.payloads<ClinicMaterial>(
      'SELECT payload FROM materials WHERE workspace_id=? AND archived=0 ORDER BY created_at',
      workspaceId,
    );
  }
  summaries(workspaceId: string) {
    return this.materials(workspaceId).map((material) => {
      const revision = this.repo.owned<ClinicRevision>(
        'material_revisions',
        material.revisionId,
        workspaceId,
      );
      return {
        ...material,
        blockCount: this.repo.row<{ count: number }>(
          'SELECT COUNT(*) AS count FROM source_blocks WHERE revision_id=? AND workspace_id=?',
          material.revisionId,
          workspaceId,
        )!.count,
        pageCount: revision.normalizedDocument.units.filter(
          (unit) => unit.kind === 'page' || unit.kind === 'slide',
        ).length,
        parserVersion: revision.normalizedDocument.parserVersion,
      };
    });
  }
  rename(workspaceId: string, materialId: string, title: string) {
    const material = this.repo.owned<ClinicMaterial>('materials', materialId, workspaceId);
    if (
      this.repo.row<{ archived: number }>('SELECT archived FROM materials WHERE id=?', materialId)
        ?.archived
    )
      throw new AppError('VERSION_CONFLICT', '资料已移出课程，请刷新资料列表。');
    const updated = { ...material, title };
    this.repo.run(
      'UPDATE materials SET title=?,payload=? WHERE id=? AND workspace_id=? AND archived=0',
      title,
      canonical(updated),
      materialId,
      workspaceId,
    );
    return updated;
  }
  async import(
    workspaceId: string,
    input: {
      title?: string;
      content?: string;
      filename?: string;
      dataBase64?: string;
      mediaType?: string;
    },
    materialId?: string,
  ): Promise<ClinicMaterial> {
    this.repo.workspace(workspaceId);
    const old = materialId
      ? this.repo.owned<ClinicMaterial>('materials', materialId, workspaceId)
      : null;
    const id = old?.id ?? newClinicId('material');
    const revisionId = newClinicId('revision');
    let content: string;
    let document: NormalizedDocument;
    let sourceType: SourceType;
    let warnings: string[] = [];
    if (input.dataBase64 !== undefined) {
      if (!input.filename) throw new AppError('VALIDATION_ERROR', '文件名不能为空。');
      const kind = uploadKindForFilename(input.filename);
      if (input.mediaType) validateUploadDeclaration(kind, input.mediaType as MediaType);
      const parsed = await parseBinaryUpload(
        kind.sourceType,
        decodeUpload(input.dataBase64),
        id,
        revisionId,
        undefined,
        kind.mediaType,
      );
      content = ingestSource(parsed.content, { sourceType: kind.sourceType }).content;
      sourceType = kind.sourceType;
      warnings = parsed.warnings;
      document = parsed.normalizedDocument
        ? { ...parsed.normalizedDocument, materialRevisionId: revisionId }
        : parserForSourceType(sourceType).parse({
            revisionId,
            materialId: id,
            sourceType,
            mediaType: kind.mediaType,
            content,
            ...(parsed.pageSpans ? { pageSpans: parsed.pageSpans } : {}),
            warnings,
            filename: input.filename,
          });
    } else {
      sourceType = input.filename ? sourceTypeForFilename(input.filename) : 'paste';
      content = ingestSource(input.content ?? '', { sourceType }).content;
      document = parserForSourceType(sourceType).parse({
        revisionId,
        materialId: id,
        sourceType,
        mediaType: sourceType === 'html' ? 'text/html' : 'text/markdown',
        content,
      });
      warnings = document.warnings;
    }
    checkTextResources(content);
    const createdAt = this.repo.now();
    const material: ClinicMaterial = {
      id,
      workspaceId,
      title: input.title?.trim() || deriveTitle(content),
      revisionId,
      sourceType,
      filename: input.filename ?? null,
      warnings,
      charCount: content.length,
      createdAt,
    };
    const revision: ClinicRevision = {
      ...material,
      content,
      hash: sha256(content),
      normalizedDocument: document,
    };
    const blocks = this.structuralBlocks(revision);
    if (!blocks.length)
      throw new AppError('EMPTY_SOURCE', '材料缺少可教学正文，图像材料需要提供文字或补充说明。');
    this.repo.transaction(() => {
      if (!old)
        this.repo.run(
          'INSERT INTO materials(id,workspace_id,title,current_revision_id,payload,created_at) VALUES(?,?,?,?,?,?)',
          id,
          workspaceId,
          material.title,
          revisionId,
          canonical(material),
          createdAt,
        );
      else
        this.repo.run(
          'UPDATE materials SET title=?,current_revision_id=?,payload=? WHERE id=?',
          material.title,
          revisionId,
          canonical(material),
          id,
        );
      this.repo.run(
        'INSERT INTO material_revisions VALUES(?,?,?,?,?,?)',
        revisionId,
        id,
        workspaceId,
        revision.hash,
        canonical(revision),
        createdAt,
      );
      blocks.forEach((block, i) =>
        this.repo.run(
          'INSERT INTO source_blocks VALUES(?,?,?,?,?)',
          block.id,
          revisionId,
          workspaceId,
          i,
          canonical(block),
        ),
      );
    });
    return material;
  }
  blocks(workspaceId: string, revisionIds?: string[]): SourcePacketBlock[] {
    this.repo.workspace(workspaceId);
    const revisions = revisionIds ?? this.materials(workspaceId).map((m) => m.revisionId);
    return revisions.flatMap((id) => {
      this.repo.owned<ClinicRevision>('material_revisions', id, workspaceId);
      return this.repo.payloads<SourcePacketBlock>(
        'SELECT payload FROM source_blocks WHERE workspace_id=? AND revision_id=? ORDER BY position',
        workspaceId,
        id,
      );
    });
  }
  manifest(workspaceId: string) {
    return this.materials(workspaceId)
      .map((m) => ({
        materialId: m.id,
        revisionId: m.revisionId,
        hash: this.repo.owned<ClinicRevision>('material_revisions', m.revisionId, workspaceId).hash,
      }))
      .sort((a, b) => a.materialId.localeCompare(b.materialId));
  }
  scopeHash(workspaceId: string) {
    return sha256(this.manifest(workspaceId));
  }
  assertCurrent(workspaceId: string, scopeHash: string) {
    if (this.scopeHash(workspaceId) !== scopeHash)
      throw new AppError(
        'VERSION_CONFLICT',
        '资料已更新，本次候选保留但未发布。请根据当前资料重新准备。',
      );
  }
  assertRelevantCurrent(workspaceId: string, blocks: SourcePacketBlock[]) {
    const current = new Set(this.materials(workspaceId).map((m) => m.revisionId));
    if (blocks.some((block) => !current.has(block.revisionId)))
      throw new AppError('VERSION_CONFLICT', '本课引用的资料已更新，候选保留但不能发布。');
  }
  validateSpan(
    workspaceId: string,
    span: CourseSourceSpan,
    allowedRevisionIds?: Set<string>,
  ): string {
    const block = this.repo.owned<SourcePacketBlock>('source_blocks', span.blockId, workspaceId);
    if (
      block.revisionId !== span.revisionId ||
      (allowedRevisionIds && !allowedRevisionIds.has(span.revisionId)) ||
      span.start < block.start ||
      span.end > block.end ||
      span.start >= span.end
    )
      throw new AppError('GROUNDING_FAILED', '引文范围无效或不属于当前来源。');
    const revision = this.repo.owned<ClinicRevision>(
      'material_revisions',
      span.revisionId,
      workspaceId,
    );
    return revision.content.slice(span.start, span.end);
  }
  references(workspaceId: string, spans: CourseSourceSpan[]) {
    const selected = [...new Set(spans.map((s) => s.blockId))].map((id) =>
      this.repo.owned<SourcePacketBlock>('source_blocks', id, workspaceId),
    );
    return proofSourceContext(selected, this.blocks(workspaceId));
  }
  private structuralBlocks(revision: ClinicRevision): SourcePacketBlock[] {
    const units = revision.normalizedDocument.units
      .filter(
        (u) => !['document', 'page', 'slide', 'section', 'heading', 'list_item'].includes(u.kind),
      )
      .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const ranges: { start: number; end: number; headingPath: string[] }[] = [];
    for (const unit of units) {
      if (!unit.content.trim()) continue;
      const last = ranges.at(-1);
      if (last && unit.startOffset < last.end) {
        last.end = Math.max(last.end, unit.endOffset);
        continue;
      }
      ranges.push({ start: unit.startOffset, end: unit.endOffset, headingPath: unit.headingPath });
    }
    if (
      !ranges.length &&
      ['md', 'paste'].includes(revision.sourceType) &&
      !revision.content.split('\n').some((line) => line.trim() && !/^\s*#/u.test(line))
    )
      return [];
    if (!ranges.length && revision.content.trim())
      ranges.push({ start: 0, end: revision.content.length, headingPath: [] });
    // All source text, including whitespace and headings, belongs to a processed span.
    return ranges.map((range, i) => {
      const start = i === 0 ? 0 : range.start;
      const end = ranges[i + 1]?.start ?? revision.content.length;
      const text = revision.content.slice(start, end);
      return {
        id: stableId('block', { revision: revision.revisionId, start, end, text }),
        revisionId: revision.revisionId,
        text,
        headingPath: range.headingPath,
        start,
        end,
      };
    });
  }
}
