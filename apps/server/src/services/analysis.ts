import type { Concept, ProposedConcept } from '@hy3-clinic/shared';
import { ApiErrorCode, MAX_CONCEPTS_PER_DOCUMENT, normalizeConceptKey } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { computeSections, conceptBudgetFor } from '../ingestion/sections.js';
import type { DocumentSection } from '../ingestion/sections.js';
import { ProviderError } from '../llm/errors.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface AnalysisServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
}

/** Per-section outcome of one extraction run (transient, not persisted). */
export interface SectionExtractionReport {
  key: string;
  title: string;
  charCount: number;
  status: 'extracted' | 'empty' | 'failed' | 'skipped_existing' | 'skipped_cap';
  conceptsAdded: number;
}

export interface ExtractionRunReport {
  sections: SectionExtractionReport[];
  conceptsAdded: number;
  conceptTotal: number;
  /** True when the document-level concept ceiling stopped further sections. */
  capReached: boolean;
}

export interface AnalyzeOutcome {
  concepts: Concept[];
  /** Present when this call actually ran extraction (initial or deepen). */
  extraction: ExtractionRunReport | null;
}

export function createAnalysisService({ repos, provider, clock }: AnalysisServiceDeps) {
  /**
   * Run extraction over ONE section: bounded provider call, exact-quote
   * verification, normalized-key dedup against everything already accepted.
   * Returns the verified NEW concepts (may legitimately be empty).
   *
   * `sectioned` distinguishes real section extraction (size-aware 0..N
   * budget, Amendment E) from the single-section case — a document small
   * enough to be one section keeps the legacy whole-document prompt.
   */
  async function extractSection(
    materialId: string,
    materialTitle: string,
    section: DocumentSection,
    sectioned: boolean,
    seenKeys: Set<string>,
    remainingBudget: number,
    opts?: ProviderCallOptions,
  ): Promise<Concept[]> {
    const payload = await provider.analyzeConcepts(
      {
        materialTitle,
        blocks: section.blocks,
        ...(sectioned
          ? {
              sectionTitle: section.title,
              maxConcepts: Math.min(conceptBudgetFor(section), remainingBudget),
            }
          : {}),
      },
      opts,
    );

    const createdAt = clock.now().toISOString();
    const accepted: Concept[] = [];
    const consider = (proposed: ProposedConcept): void => {
      if (accepted.length >= remainingBudget) return;
      const key = normalizeConceptKey(proposed.name);
      if (seenKeys.has(key)) return;
      const verification = verifyGrounding(section.blocks, {
        blockId: proposed.blockId,
        quote: proposed.quote,
      });
      if (!verification.ok) return;
      seenKeys.add(key);
      accepted.push({
        id: newId('con'),
        materialId,
        name: proposed.name,
        summary: proposed.summary,
        importance: proposed.importance,
        grounding: verification.grounding,
        createdAt,
      });
    };
    for (const proposed of payload.concepts) consider(proposed);
    return accepted;
  }

  async function runSections(
    materialId: string,
    materialTitle: string,
    sections: DocumentSection[],
    sectioned: boolean,
    existing: Concept[],
    opts?: ProviderCallOptions,
  ): Promise<ExtractionRunReport> {
    const seenKeys = new Set(existing.map((c) => normalizeConceptKey(c.name)));
    let total = existing.length;
    let added = 0;
    let capReached = false;
    const reports: SectionExtractionReport[] = [];

    for (const section of sections) {
      // Cancellation between sections: everything accepted so far stays
      // persisted (additive); the request itself reports cancelled.
      if (opts?.signal?.aborted) throw ProviderError.cancelled();
      if (total >= MAX_CONCEPTS_PER_DOCUMENT) {
        capReached = true;
        reports.push({
          key: section.key,
          title: section.title,
          charCount: section.charCount,
          status: 'skipped_cap',
          conceptsAdded: 0,
        });
        continue;
      }
      try {
        const accepted = await extractSection(
          materialId,
          materialTitle,
          section,
          sectioned,
          seenKeys,
          MAX_CONCEPTS_PER_DOCUMENT - total,
          opts,
        );
        if (accepted.length > 0) {
          repos.materials.addConcepts(accepted);
          total += accepted.length;
          added += accepted.length;
        }
        reports.push({
          key: section.key,
          title: section.title,
          charCount: section.charCount,
          status: accepted.length > 0 ? 'extracted' : 'empty',
          conceptsAdded: accepted.length,
        });
      } catch (error) {
        // Cancellation aborts the whole run (accepted sections stay
        // persisted); any other per-section failure is partial, retryable
        // state and never blocks the remaining sections.
        if (error instanceof ProviderError && error.code === 'REQUEST_CANCELLED') throw error;
        reports.push({
          key: section.key,
          title: section.title,
          charCount: section.charCount,
          status: 'failed',
          conceptsAdded: 0,
        });
      }
    }

    return { sections: reports, conceptsAdded: added, conceptTotal: total, capReached };
  }

  return {
    /**
     * Section-aware concept extraction.
     *
     * Initial run (no concepts yet, no section named): every section of the
     * deterministic outline is extracted sequentially with a size-aware
     * budget; verified concepts are APPENDED per section, so a mid-run
     * failure or cancellation keeps everything accepted so far. When
     * concepts already exist the call returns them unchanged (legacy
     * behavior — dependent ids never regenerate).
     *
     * Deepen run (`section` key named): extraction runs over exactly that
     * section and APPENDS new (deduplicated) concepts. Existing concept
     * rows are never modified or deleted by any extraction path.
     */
    async analyze(
      materialId: string,
      opts?: ProviderCallOptions,
      options?: { section?: string },
    ): Promise<AnalyzeOutcome> {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      const blocks = repos.materials.getBlocks(materialId);
      const existing = repos.materials.getConcepts(materialId);

      if (options?.section) {
        const outline = computeSections(blocks);
        const section = outline.find((s) => s.key === options.section);
        if (!section) {
          throw new AppError(
            ApiErrorCode.ValidationError,
            '指定的小节不存在(文档可能已被重新解析),请刷新映射后重试。',
          );
        }
        const extraction = await runSections(
          materialId,
          material.title,
          [section],
          outline.length > 1,
          existing,
          opts,
        );
        return { concepts: repos.materials.getConcepts(materialId), extraction };
      }

      if (existing.length > 0) return { concepts: existing, extraction: null };

      const sections = computeSections(blocks);
      const extraction = await runSections(
        materialId,
        material.title,
        sections,
        sections.length > 1,
        [],
        opts,
      );
      const concepts = repos.materials.getConcepts(materialId);
      if (concepts.length === 0) {
        const failedCount = extraction.sections.filter((s) => s.status === 'failed').length;
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          failedCount === extraction.sections.length
            ? '概念提取失败:所有小节的提取请求均未成功,请重试。'
            : '概念分析结果均未通过原文引证校验,已拒绝写入。请重试。',
          { sections: extraction.sections },
        );
      }
      return { concepts, extraction };
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
