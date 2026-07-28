import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  type AddDocumentRequest,
  type DocumentDeletionResult,
  type DocumentSummary,
  type Material,
  type Workspace,
  type WorkspaceSummary,
} from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { AppError, notFound } from '../errors.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { ingestSource } from '../ingestion/ingest.js';
import { parseBinaryUpload } from '../ingestion/documents.js';
import { segmentMaterial } from '../ingestion/segment.js';
import type { MaterialService, MaterialWithBlocks } from './materials.js';

export interface WorkspaceServiceDeps {
  repos: Repositories;
  clock: Clock;
  materials: MaterialService;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  documents: DocumentSummary[];
}

export function createWorkspaceService({ repos, clock, materials }: WorkspaceServiceDeps) {
  function requireWorkspace(id: string): Workspace {
    const workspace = repos.workspaces.get(id);
    if (!workspace) throw notFound(`课程空间不存在:${id}`);
    return workspace;
  }

  function requireDocument(workspaceId: string, documentId: string): Material {
    const material = repos.materials.get(documentId);
    if (!material || material.workspaceId !== workspaceId) {
      throw notFound(`该课程空间下不存在此文档:${documentId}`);
    }
    return material;
  }

  return {
    create(input: unknown): Workspace {
      const parsed = CreateWorkspaceRequestSchema.parse(input);
      const now = clock.now().toISOString();
      const workspace: Workspace = {
        id: newId('ws'),
        name: parsed.name,
        description: parsed.description?.length ? parsed.description : null,
        activeGraphVersionId: null,
        // Deliberately created by the learner: preserved even when its final
        // document is deleted (unlike auto-created import workspaces).
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
      };
      repos.workspaces.insert(workspace);
      return workspace;
    },

    list(): WorkspaceSummary[] {
      return repos.workspaces.list();
    },

    get(id: string): WorkspaceDetail {
      const workspace = requireWorkspace(id);
      return { workspace, documents: repos.workspaces.listDocumentSummaries(id) };
    },

    rename(id: string, input: unknown): Workspace {
      const parsed = UpdateWorkspaceRequestSchema.parse(input);
      const updated = repos.workspaces.updateName(id, parsed.name, clock.now().toISOString());
      if (!updated) throw notFound(`课程空间不存在:${id}`);
      return updated;
    },

    delete(id: string): void {
      if (!repos.workspaces.delete(id)) throw notFound(`课程空间不存在:${id}`);
    },

    /**
     * Add a document to a workspace.
     *
     * Text sources reuse the legacy ingestion path; binary uploads (.pdf /
     * .docx) go through the material service's shared upload path (decode,
     * magic-byte check, parse with provenance, persist together with the
     * original bytes). A parsing failure rejects the request — nothing is
     * persisted.
     */
    async addDocument(
      workspaceId: string,
      request: AddDocumentRequest,
    ): Promise<MaterialWithBlocks> {
      requireWorkspace(workspaceId);

      if (request.kind === 'text') {
        return materials.create(
          { content: request.content, title: request.title, filename: request.filename },
          workspaceId,
        );
      }

      return materials.createFromUpload(request, workspaceId);
    },

    /**
     * Re-extract a document from its stored original source with the current
     * parser. DESTRUCTIVE for dependent data of this document (blocks,
     * concepts, quizzes, mistakes, mastery) and for workspace plans/graph
     * edges that referenced it — all replaced/removed in one transaction.
     */
    async reprocessDocument(workspaceId: string, documentId: string): Promise<MaterialWithBlocks> {
      const existing = requireDocument(workspaceId, documentId);
      const now = clock.now().toISOString();

      let content: string;
      let pageCount: number | null = null;
      let pageSpans: Array<{ pageNumber: number; startOffset: number; endOffset: number }> | null =
        null;
      let warnings: string[] = [];
      let parserVersion: string;

      if (existing.sourceType === 'pdf' || existing.sourceType === 'docx') {
        const original = repos.materials.getOriginalData(documentId);
        if (!original) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            '该文档没有保存原始文件,无法重新解析(旧版本导入的文档仅支持文本内容)。',
          );
        }
        const parsed = await parseBinaryUpload(existing.sourceType, original);
        content = parsed.content;
        pageCount = parsed.pageCount;
        pageSpans = parsed.pageSpans;
        warnings = parsed.warnings;
        parserVersion = parsed.parserVersion;
      } else {
        // Text sources: stored normalized content IS the original text.
        content = existing.content;
        parserVersion = existing.parserVersion ?? 'text-v1';
      }

      const normalized = ingestSource(content, { sourceType: existing.sourceType });
      const updated: Material = {
        ...existing,
        content: normalized.content,
        charCount: normalized.charCount,
        parseStatus: warnings.length > 0 ? 'parsed_with_warnings' : 'parsed',
        pageCount,
        extractionWarnings: warnings.slice(0, 50),
        parserVersion,
        updatedAt: now,
      };
      const blocks = segmentMaterial(documentId, normalized.content, {
        ...(pageSpans ? { pageSpans } : {}),
      });

      repos.workspaces.reprocessDocument(updated, blocks, now);
      return { material: updated, blocks };
    },

    /**
     * Delete one document and all dependent data (explicit + transactional).
     * When the document was the final one of a `material_import` workspace,
     * the workspace is retired in the same transaction; the structured
     * result reports it so clients can reconcile their state.
     */
    deleteDocument(workspaceId: string, documentId: string): DocumentDeletionResult {
      requireDocument(workspaceId, documentId);
      const outcome = repos.workspaces.deleteDocument(
        documentId,
        workspaceId,
        clock.now().toISOString(),
      );
      return { workspaceId, workspaceDeleted: outcome.workspaceDeleted };
    },

    listDocuments(workspaceId: string): DocumentSummary[] {
      requireWorkspace(workspaceId);
      return repos.workspaces.listDocumentSummaries(workspaceId);
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
