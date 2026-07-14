import type { MasteryState, MistakeRecord } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { WeakConcept } from '../repositories/mistakes.js';

export interface MistakesServiceDeps {
  repos: Repositories;
}

export function createMistakesService({ repos }: MistakesServiceDeps) {
  function ensureMaterial(materialId: string): void {
    if (!repos.materials.get(materialId)) throw notFound(`学习资料不存在:${materialId}`);
  }

  return {
    listByMaterial(materialId: string): MistakeRecord[] {
      ensureMaterial(materialId);
      return repos.mistakes.listByMaterial(materialId);
    },

    weakConcepts(materialId: string): WeakConcept[] {
      ensureMaterial(materialId);
      return repos.mistakes.weakConcepts(materialId);
    },

    mastery(materialId: string): MasteryState[] {
      ensureMaterial(materialId);
      return repos.mastery.listByMaterial(materialId);
    },
  };
}

export type MistakesService = ReturnType<typeof createMistakesService>;
