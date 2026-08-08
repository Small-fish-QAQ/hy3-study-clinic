import type { SourceBlock } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import { computeSections } from '../ingestion/sections.js';
import type { Repositories } from '../repositories/index.js';

/**
 * Structural document mapping — honest metrics only.
 *
 * Everything here is deterministic bookkeeping over persisted rows: which
 * sections have extracted concepts, and which blocks are cited by at least
 * one verified anchor (concept groundings, active-graph edge evidence, and —
 * once teaching enrichment exists — lesson anchors). It measures MAPPING and
 * evidence anchoring, NOT semantic course coverage: a section with one
 * anchored concept is "mapped", which never claims every idea inside it was
 * captured. Semantic recall lives in the evaluation suite against
 * hand-authored must-find labels, not in this endpoint.
 */

export interface SectionMapping {
  key: string;
  title: string;
  fromHeading: boolean;
  blockCount: number;
  charCount: number;
  /** Concepts whose verified grounding lies in this section. */
  conceptCount: number;
  /** Blocks of this section cited by at least one verified anchor. */
  anchoredBlockCount: number;
  anchoredCharCount: number;
  /** True when at least one concept is grounded here. */
  mapped: boolean;
}

export interface DocumentMapping {
  materialId: string;
  title: string;
  totals: {
    blockCount: number;
    charCount: number;
    conceptCount: number;
    mappedSectionCount: number;
    sectionCount: number;
    anchoredBlockCount: number;
    anchoredCharCount: number;
  };
  sections: SectionMapping[];
}

export interface MappingServiceDeps {
  repos: Repositories;
}

export function createMappingService({ repos }: MappingServiceDeps) {
  /** Every block id cited by a verified anchor relevant to this material. */
  function anchoredBlockIds(materialId: string, workspaceId: string): Set<string> {
    const anchored = new Set<string>();
    for (const concept of repos.materials.getConcepts(materialId)) {
      anchored.add(concept.grounding.blockId);
    }
    const workspace = repos.workspaces.get(workspaceId);
    if (workspace?.activeGraphVersionId) {
      for (const edge of repos.graph.getEdges(workspace.activeGraphVersionId)) {
        for (const evidence of edge.evidence) anchored.add(evidence.blockId);
      }
    }
    return anchored;
  }

  return {
    documentMapping(materialId: string): DocumentMapping {
      const material = repos.materials.get(materialId);
      if (!material) throw notFound(`学习资料不存在:${materialId}`);
      const blocks = repos.materials.getBlocks(materialId);
      const concepts = repos.materials.getConcepts(materialId);
      const anchored = anchoredBlockIds(materialId, material.workspaceId);

      const conceptBlockCounts = new Map<string, number>();
      for (const concept of concepts) {
        conceptBlockCounts.set(
          concept.grounding.blockId,
          (conceptBlockCounts.get(concept.grounding.blockId) ?? 0) + 1,
        );
      }

      const sections = computeSections(blocks).map((section): SectionMapping => {
        let conceptCount = 0;
        let anchoredBlockCount = 0;
        let anchoredCharCount = 0;
        for (const block of section.blocks) {
          conceptCount += conceptBlockCounts.get(block.id) ?? 0;
          if (anchored.has(block.id)) {
            anchoredBlockCount += 1;
            anchoredCharCount += block.content.length;
          }
        }
        return {
          key: section.key,
          title: section.title,
          fromHeading: section.fromHeading,
          blockCount: section.blocks.length,
          charCount: section.charCount,
          conceptCount,
          anchoredBlockCount,
          anchoredCharCount,
          mapped: conceptCount > 0,
        };
      });

      const totals = {
        blockCount: blocks.length,
        charCount: blocks.reduce(
          (sum: number, block: SourceBlock) => sum + block.content.length,
          0,
        ),
        conceptCount: concepts.length,
        mappedSectionCount: sections.filter((s) => s.mapped).length,
        sectionCount: sections.length,
        anchoredBlockCount: sections.reduce((sum, s) => sum + s.anchoredBlockCount, 0),
        anchoredCharCount: sections.reduce((sum, s) => sum + s.anchoredCharCount, 0),
      };
      return { materialId, title: material.title, totals, sections };
    },
  };
}

export type MappingService = ReturnType<typeof createMappingService>;
