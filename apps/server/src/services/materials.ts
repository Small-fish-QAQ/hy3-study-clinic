import {
  UpdateMaterialTitleRequestSchema,
  type Material,
  type MediaType,
  type SourceBlock,
  type SourceType,
  type Workspace,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import { notFound } from '../errors.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { deriveTitle, ingestSource, sourceTypeForFilename } from '../ingestion/ingest.js';
import { TEXT_PARSER_VERSION } from '../ingestion/documents.js';
import { segmentMaterial } from '../ingestion/segment.js';

export interface CreateMaterialInput {
  content: string;
  title?: string | undefined;
  filename?: string | undefined;
}

export interface MaterialWithBlocks {
  material: Material;
  blocks: SourceBlock[];
}

export interface MaterialServiceDeps {
  repos: Repositories;
  clock: Clock;
}

const MEDIA_TYPE_FOR_TEXT: Record<'paste' | 'md' | 'txt', MediaType> = {
  paste: 'text/plain',
  md: 'text/markdown',
  txt: 'text/plain',
};

export function createMaterialService({ repos, clock }: MaterialServiceDeps) {
  return {
    /**
     * Validate, normalize, segment, and persist a new text material.
     *
     * Compatibility path: this legacy entry point (paste / .md / .txt without
     * an explicit workspace) creates a dedicated workspace named after the
     * material — the same representation the migration gives pre-upgrade
     * records — so every document always belongs to a workspace.
     */
    create(input: CreateMaterialInput, workspaceId?: string): MaterialWithBlocks {
      const sourceType: SourceType = input.filename
        ? sourceTypeForFilename(input.filename)
        : 'paste';
      const normalized = ingestSource(input.content, { sourceType });

      const id = newId('mat');
      const now = clock.now().toISOString();
      const title =
        input.title && input.title.trim().length > 0
          ? input.title.trim().slice(0, 100)
          : deriveTitle(normalized.content);

      let targetWorkspaceId = workspaceId;
      if (!targetWorkspaceId) {
        const workspace: Workspace = {
          id: newId('ws'),
          name: title.slice(0, 120),
          description: null,
          activeGraphVersionId: null,
          createdAt: now,
          updatedAt: now,
        };
        repos.workspaces.insert(workspace);
        targetWorkspaceId = workspace.id;
      } else if (!repos.workspaces.get(targetWorkspaceId)) {
        throw notFound(`课程空间不存在:${targetWorkspaceId}`);
      }

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
        parserVersion: TEXT_PARSER_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      const blocks = segmentMaterial(id, normalized.content);

      repos.materials.insertWithBlocks(material, blocks);
      repos.workspaces.touch(targetWorkspaceId, now);
      return { material, blocks };
    },

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

    delete(id: string): void {
      const material = repos.materials.get(id);
      if (!material) throw notFound(`学习资料不存在:${id}`);
      // Route through the workspace-aware delete so graph edges / plans that
      // depend on this document are cleaned up in the same transaction.
      repos.workspaces.deleteDocument(id, material.workspaceId, clock.now().toISOString());
    },

    list() {
      return repos.materials.list();
    },
  };
}

export type MaterialService = ReturnType<typeof createMaterialService>;
