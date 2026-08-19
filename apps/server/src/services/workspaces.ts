import { createHash } from 'node:crypto';
import {
  CreateWorkspaceRequestSchema,
  fnv1a32,
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
import {
  normalizedDocumentToSourceBlocks,
  parserForSourceType,
  STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
  STRUCTURE_AWARE_CHUNKER_VERSION,
} from '../ingestion/normalized.js';
import type { MaterialService, MaterialWithBlocks } from './materials.js';
import type { SourceAuthorityService } from './sourceAuthority.js';

export interface WorkspaceServiceDeps {
  repos: Repositories;
  clock: Clock;
  materials: MaterialService;
  sourceAuthority: Pick<SourceAuthorityService, 'ensureVerbatimAssessmentAuthority'>;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  documents: DocumentSummary[];
}

export function createWorkspaceService({
  repos,
  clock,
  materials,
  sourceAuthority,
}: WorkspaceServiceDeps) {
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
        // Deliberately created by the learner. Ordinary Material retirement
        // preserves this Course and its longitudinal history.
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
     * Re-extract into a staged immutable revision, then activate it. Parser
     * work happens before the transaction. Failure records an attempt and
     * leaves the previous active revision and longitudinal history intact.
     */
    async reprocessDocument(workspaceId: string, documentId: string): Promise<MaterialWithBlocks> {
      const existing = requireDocument(workspaceId, documentId);
      const now = clock.now().toISOString();
      const parserAttemptId = newId('parse');
      const revisionId = newId('rev');

      let content: string;
      let pageCount: number | null = null;
      let pageSpans: Array<{ pageNumber: number; startOffset: number; endOffset: number }> | null =
        null;
      let warnings: string[] = [];
      let parserVersion: string;
      let originalData: Buffer | null = null;

      try {
        const storedOriginal = repos.materials.getOriginalData(documentId);
        if (existing.sourceType === 'pdf' || existing.sourceType === 'docx') {
          const original = storedOriginal;
          if (!original) {
            throw new AppError(
              ApiErrorCode.ValidationError,
              '该文档没有保存原始文件,无法重新解析(旧版本导入的文档仅支持文本内容)。',
            );
          }
          originalData = original;
          const parsed = await parseBinaryUpload(existing.sourceType, original);
          content = parsed.content;
          pageCount = parsed.pageCount;
          pageSpans = parsed.pageSpans;
          warnings = parsed.warnings;
          parserVersion = parsed.parserVersion;
        } else {
          originalData = storedOriginal;
          content = storedOriginal ? storedOriginal.toString('utf8') : existing.content;
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
        const document = parserForSourceType(existing.sourceType).parse({
          revisionId,
          materialId: documentId,
          sourceType: existing.sourceType,
          mediaType: existing.mediaType,
          content: normalized.content,
          filename: existing.originalFilename,
          ...(pageSpans ? { pageSpans } : {}),
        });
        const blocks = normalizedDocumentToSourceBlocks(documentId, document, {
          idSeed: revisionId,
          materialRevisionId: revisionId,
        });
        const contentFingerprint = fnv1a32(normalized.content).toString(16).padStart(8, '0');
        const parserFingerprint = document.parserFingerprint;

        repos.materialRevisions.stage({
          revisionId,
          material: updated,
          blocks,
          originalData,
          parserFingerprint,
          contentFingerprint,
          chunkerVersion: STRUCTURE_AWARE_CHUNKER_VERSION,
          chunkerFingerprint: STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
          sourceFingerprint: `sha256:${createHash('sha256')
            .update(originalData ?? Buffer.from(normalized.content, 'utf8'))
            .digest('hex')}`,
          normalizedUnits: document.units,
          parserAttemptId,
          createdAt: now,
        });
        repos.materialRevisions.activate(documentId, revisionId, now);
        sourceAuthority.ensureVerbatimAssessmentAuthority(workspaceId, documentId, revisionId);
        return {
          material: repos.materials.get(documentId)!,
          blocks: repos.materials.getBlocks(documentId),
        };
      } catch (error) {
        if (!repos.materialRevisions.get(revisionId)) {
          repos.materialRevisions.recordFailedAttempt({
            id: parserAttemptId,
            materialId: documentId,
            parserVersion: existing.parserVersion,
            parserFingerprint: null,
            chunkerVersion: STRUCTURE_AWARE_CHUNKER_VERSION,
            chunkerFingerprint: STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
            errorCode: error instanceof AppError ? error.code : null,
            errorMessage: error instanceof Error ? error.message : String(error),
            startedAt: now,
            finishedAt: clock.now().toISOString(),
          });
        }
        throw error;
      }
    },

    /** Retire one stable Material while preserving revisions and learning history. */
    deleteDocument(workspaceId: string, documentId: string): DocumentDeletionResult {
      requireDocument(workspaceId, documentId);
      if (!repos.materialRevisions.retire(documentId, clock.now().toISOString())) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Material is already retired.');
      }
      return { workspaceId, workspaceDeleted: false };
    },

    listDocuments(workspaceId: string): DocumentSummary[] {
      requireWorkspace(workspaceId);
      return repos.workspaces.listDocumentSummaries(workspaceId);
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
