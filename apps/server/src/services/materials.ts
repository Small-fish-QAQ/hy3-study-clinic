import type { Material, SourceBlock, SourceType } from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import { deriveTitle, ingestSource, sourceTypeForFilename } from '../ingestion/ingest.js';
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

export function createMaterialService({ repos, clock }: MaterialServiceDeps) {
  return {
    /** Validate, normalize, segment, and persist a new material. */
    create(input: CreateMaterialInput): MaterialWithBlocks {
      const sourceType: SourceType = input.filename
        ? sourceTypeForFilename(input.filename)
        : 'paste';
      const normalized = ingestSource(input.content, { sourceType });

      const id = newId('mat');
      const title =
        input.title && input.title.trim().length > 0
          ? input.title.trim().slice(0, 100)
          : deriveTitle(normalized.content);

      const material: Material = {
        id,
        title,
        sourceType,
        content: normalized.content,
        charCount: normalized.charCount,
        createdAt: clock.now().toISOString(),
      };
      const blocks = segmentMaterial(id, normalized.content);

      repos.materials.insertWithBlocks(material, blocks);
      return { material, blocks };
    },

    get(id: string): MaterialWithBlocks | undefined {
      const material = repos.materials.get(id);
      if (!material) return undefined;
      return { material, blocks: repos.materials.getBlocks(id) };
    },

    list() {
      return repos.materials.list();
    },
  };
}

export type MaterialService = ReturnType<typeof createMaterialService>;
