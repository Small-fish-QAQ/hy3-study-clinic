import type { Concept } from '@hy3-clinic/shared';
import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface AnalysisServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

export function createAnalysisService({ repos, provider, clock }: AnalysisServiceDeps) {
  return {
    /**
     * Run concept analysis for a material and persist the verified concepts
     * (replacing any previous analysis).
     *
     * Every model-proposed concept must pass deterministic grounding
     * verification; concepts whose quote cannot be located are DROPPED, and
     * if none survive the request fails with GROUNDING_FAILED.
     */
    async analyze(materialId: string, opts?: ProviderCallOptions): Promise<Concept[]> {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      const blocks = repos.materials.getBlocks(materialId);

      const payload = await provider.analyzeConcepts(
        { materialTitle: material.title, blocks },
        opts,
      );

      const createdAt = clock.now().toISOString();
      const concepts: Concept[] = [];
      const rejected: string[] = [];
      for (const proposed of payload.concepts) {
        const verification = verifyGrounding(blocks, {
          blockId: proposed.blockId,
          quote: proposed.quote,
        });
        if (!verification.ok) {
          rejected.push(`${proposed.name}(${verification.message})`);
          continue;
        }
        concepts.push({
          id: newId('con'),
          materialId,
          name: proposed.name,
          summary: proposed.summary,
          importance: proposed.importance,
          grounding: verification.grounding,
          createdAt,
        });
      }

      if (concepts.length === 0) {
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          '概念分析结果均未通过原文引证校验,已拒绝写入。请重试。',
          { rejected },
        );
      }

      repos.materials.replaceConcepts(materialId, concepts);
      return concepts;
    },

    /** Stored concepts for a material (may be empty before analysis). */
    list(materialId: string): Concept[] {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      return repos.materials.getConcepts(materialId);
    },
  };
}

export type AnalysisService = ReturnType<typeof createAnalysisService>;
