import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  UpdateMaterialTitleRequestSchema,
  type DocumentDeletionResult,
  type DocumentFilePayload,
  type Material,
  type MediaType,
  type SourceBlock,
  type SourceType,
  type Workspace,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { AppError, notFound } from '../errors.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { deriveTitle, ingestSource, sourceTypeForFilename } from '../ingestion/ingest.js';
import {
  decodeUpload,
  parseBinaryUpload,
  uploadKindForFilename,
  validateUploadDeclaration,
  TEXT_PARSER_VERSION,
} from '../ingestion/documents.js';
import {
  normalizedDocumentToSourceBlocks,
  parserForSourceType,
  STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
  STRUCTURE_AWARE_CHUNKER_VERSION,
} from '../ingestion/normalized.js';
import type { SourceAuthorityService } from './sourceAuthority.js';

export interface CreateMaterialInput {
  content: string;
  title?: string | undefined;
  filename?: string | undefined;
  originalData?: Buffer | null | undefined;
}

export interface MaterialWithBlocks {
  material: Material;
  blocks: SourceBlock[];
}

export interface MaterialServiceDeps {
  repos: Repositories;
  clock: Clock;
  sourceAuthority: Pick<SourceAuthorityService, 'ensureVerbatimAssessmentAuthority'>;
}

const MEDIA_TYPE_FOR_TEXT: Record<'paste' | 'md' | 'txt' | 'source_code', MediaType> = {
  paste: 'text/plain',
  md: 'text/markdown',
  txt: 'text/plain',
  source_code: 'text/x-source-code',
};

export function createMaterialService({ repos, clock, sourceAuthority }: MaterialServiceDeps) {
  /**
   * Resolve the workspace a new material belongs to.
   *
   * Compatibility path: without an explicit workspace (material-library
   * import), a dedicated workspace named after the material is created — the
   * same representation the migration gives pre-upgrade records — so every
   * document always belongs to a workspace.
   *
   * Call this only after every validation/segmentation step that can throw,
   * so a rejected import never leaves an orphan auto-created workspace.
   */
  function resolveTargetWorkspace(title: string, now: string, workspaceId?: string): string {
    if (workspaceId) {
      if (!repos.workspaces.get(workspaceId)) {
        throw notFound(`课程空间不存在:${workspaceId}`);
      }
      return workspaceId;
    }
    const workspace: Workspace = {
      id: newId('ws'),
      name: title.slice(0, 120),
      description: null,
      activeGraphVersionId: null,
      // Auto-created for this import. Material retirement preserves this
      // Course shell and its longitudinal history.
      origin: 'material_import',
      createdAt: now,
      updatedAt: now,
    };
    repos.workspaces.insert(workspace);
    return workspace.id;
  }

  /** Validate, normalize, segment, and persist a new text material. */
  function create(input: CreateMaterialInput, workspaceId?: string): MaterialWithBlocks {
    const sourceType: SourceType = input.filename ? sourceTypeForFilename(input.filename) : 'paste';
    const normalized = ingestSource(input.content, { sourceType });

    const id = newId('mat');
    const now = clock.now().toISOString();
    const title =
      input.title && input.title.trim().length > 0
        ? input.title.trim().slice(0, 100)
        : deriveTitle(normalized.content);

    const document = parserForSourceType(sourceType).parse({
      revisionId: `${id}:candidate`,
      materialId: id,
      sourceType,
      mediaType:
        sourceType === 'md' ||
        sourceType === 'txt' ||
        sourceType === 'paste' ||
        sourceType === 'source_code'
          ? MEDIA_TYPE_FOR_TEXT[sourceType]
          : 'text/plain',
      content: normalized.content,
      filename: input.filename ?? null,
    });
    const blocks = normalizedDocumentToSourceBlocks(id, document, {
      idSeed: id,
      materialRevisionId: `${id}:candidate`,
    });
    const targetWorkspaceId = resolveTargetWorkspace(title, now, workspaceId);

    const material: Material = {
      id,
      workspaceId: targetWorkspaceId,
      title,
      sourceType,
      mediaType:
        sourceType === 'pdf' || sourceType === 'docx' ? null : MEDIA_TYPE_FOR_TEXT[sourceType],
      originalFilename: input.filename?.trim() || null,
      content: normalized.content,
      charCount: normalized.charCount,
      parseStatus: 'parsed',
      pageCount: null,
      extractionWarnings: [],
      parserVersion: sourceType === 'source_code' ? document.parserVersion : TEXT_PARSER_VERSION,
      createdAt: now,
      updatedAt: now,
    };

    const originalData = input.originalData ?? Buffer.from(input.content, 'utf8');
    repos.materials.insertWithBlocks(material, blocks, originalData, document.units, {
      parserFingerprint: document.parserFingerprint,
      chunkerVersion: STRUCTURE_AWARE_CHUNKER_VERSION,
      chunkerFingerprint: STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
      sourceFingerprint: `sha256:${createHash('sha256').update(originalData).digest('hex')}`,
    });
    const stored = repos.materials.get(id)!;
    sourceAuthority.ensureVerbatimAssessmentAuthority(
      targetWorkspaceId,
      id,
      stored.activeRevisionId!,
    );
    repos.workspaces.touch(targetWorkspaceId, now);
    return { material: stored, blocks: repos.materials.getBlocks(id) };
  }

  /**
   * Validate, decode, parse, and persist an uploaded file (.md / .txt /
   * .pdf / .docx as base64). This is the single authoritative ingestion path
   * for binary documents — the workspace document upload and the
   * material-library import both land here.
   *
   * Binary uploads are magic-byte-checked and parsed with provenance (PDF
   * page spans, DOCX headings) and persisted together with the original
   * bytes (needed for reprocessing). A parsing failure rejects the request —
   * nothing is persisted.
   */
  async function createFromUpload(
    input: DocumentFilePayload,
    workspaceId?: string,
  ): Promise<MaterialWithBlocks> {
    const kind = uploadKindForFilename(input.filename);
    validateUploadDeclaration(kind, input.mediaType);
    const buffer = decodeUpload(input.dataBase64);

    if (kind.sourceType !== 'pdf' && kind.sourceType !== 'docx') {
      // Text file uploaded as base64: decode and reuse the text path.
      return create(
        {
          content: buffer.toString('utf8'),
          title: input.title,
          filename: input.filename,
          originalData: buffer,
        },
        workspaceId,
      );
    }

    const parsed = await parseBinaryUpload(kind.sourceType, buffer);
    // Reuse the shared size/emptiness limits on the EXTRACTED text.
    const normalized = ingestSource(parsed.content, { sourceType: kind.sourceType });

    const id = newId('mat');
    const now = clock.now().toISOString();
    const title =
      input.title && input.title.trim().length > 0
        ? input.title.trim().slice(0, 100)
        : deriveTitle(normalized.content) || input.filename.slice(0, 80);

    const document = parserForSourceType(kind.sourceType).parse({
      revisionId: `${id}:candidate`,
      materialId: id,
      sourceType: kind.sourceType,
      mediaType: kind.mediaType,
      content: normalized.content,
      filename: input.filename,
      ...(parsed.pageSpans ? { pageSpans: parsed.pageSpans } : {}),
    });
    const blocks = normalizedDocumentToSourceBlocks(id, document, {
      idSeed: id,
      materialRevisionId: `${id}:candidate`,
    });
    const targetWorkspaceId = resolveTargetWorkspace(title, now, workspaceId);

    const material: Material = {
      id,
      workspaceId: targetWorkspaceId,
      title,
      sourceType: kind.sourceType,
      mediaType: kind.mediaType,
      originalFilename: input.filename.trim(),
      content: normalized.content,
      charCount: normalized.charCount,
      parseStatus: parsed.warnings.length > 0 ? 'parsed_with_warnings' : 'parsed',
      pageCount: parsed.pageCount,
      extractionWarnings: parsed.warnings.slice(0, 50),
      parserVersion: parsed.parserVersion,
      createdAt: now,
      updatedAt: now,
    };

    repos.materials.insertWithBlocks(material, blocks, buffer, document.units, {
      parserFingerprint: document.parserFingerprint,
      chunkerVersion: STRUCTURE_AWARE_CHUNKER_VERSION,
      chunkerFingerprint: STRUCTURE_AWARE_CHUNKER_FINGERPRINT,
      sourceFingerprint: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
    });
    const stored = repos.materials.get(id)!;
    sourceAuthority.ensureVerbatimAssessmentAuthority(
      targetWorkspaceId,
      id,
      stored.activeRevisionId!,
    );
    repos.workspaces.touch(targetWorkspaceId, now);
    return { material: stored, blocks: repos.materials.getBlocks(id) };
  }

  return {
    create,
    createFromUpload,

    get(id: string): MaterialWithBlocks | undefined {
      const material = repos.materials.get(id);
      if (!material) return undefined;
      return { material, blocks: repos.materials.getBlocks(id) };
    },

    updateTitle(id: string, title: string): Material {
      const input = UpdateMaterialTitleRequestSchema.parse({ title });
      const material = repos.materials.updateTitle(id, input.title, clock.now().toISOString());
      if (!material) throw notFound(`学习资料不存在:${id}`);
      return material;
    },

    delete(id: string): DocumentDeletionResult {
      const material = repos.materials.get(id);
      if (!material) throw notFound(`学习资料不存在:${id}`);
      // Retire the stable Material without cascading through revisions or
      // longitudinal learning history.
      if (!repos.materialRevisions.retire(id, clock.now().toISOString())) {
        throw new AppError(ApiErrorCode.VersionConflict, 'Material is already retired.');
      }
      return { workspaceId: material.workspaceId, workspaceDeleted: false };
    },

    list() {
      return repos.materials.list();
    },
  };
}

export type MaterialService = ReturnType<typeof createMaterialService>;
