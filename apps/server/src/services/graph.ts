import {
  ApiErrorCode,
  MAX_GRAPH_EDGES,
  MIN_SUPPORTED_ATTEMPTS,
  STABLE_MASTERY_THRESHOLD,
  WEAK_MASTERY_THRESHOLD,
  type Concept,
  type ConceptLearnerState,
  type ConceptLearnerStateKind,
  type GraphEdge,
  type GraphVersion,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { validateProposedEdges } from '../graph/validate.js';
import type { LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface GraphServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  /** Model identifier persisted as provider metadata (real provider only). */
  providerModel?: string | undefined;
}

export interface WorkspaceGraph {
  version: GraphVersion | null;
  edges: GraphEdge[];
  concepts: Concept[];
}

export interface GraphGenerationResult {
  version: GraphVersion;
  edges: GraphEdge[];
}

/** Above this many workspace blocks the proposal prompt is context-bounded. */
export const GRAPH_CONTEXT_BLOCK_LIMIT = 120;

export function createGraphService({ repos, provider, clock, providerModel }: GraphServiceDeps) {
  function requireWorkspace(workspaceId: string) {
    const workspace = repos.workspaces.get(workspaceId);
    if (!workspace) throw notFound(`课程空间不存在:${workspaceId}`);
    return workspace;
  }

  return {
    /**
     * Generate (or regenerate) the concept graph for a workspace.
     *
     * A new version row is created per attempt; the previously active
     * version is NEVER touched until the new one has fully validated, been
     * persisted, and been activated — all inside one transaction. Provider
     * failures and fully-rejected proposals mark the new version `failed`
     * and leave the active graph unchanged.
     */
    async generate(
      workspaceId: string,
      opts?: ProviderCallOptions,
    ): Promise<GraphGenerationResult> {
      const workspace = requireWorkspace(workspaceId);
      const concepts = repos.materials.getConceptsByWorkspace(workspaceId);
      if (concepts.length < 2) {
        throw new AppError(
          ApiErrorCode.ValidationError,
          '生成图谱前,请先为课程空间中的文档提取至少 2 个概念。',
        );
      }
      const allBlocks = repos.materials.getBlocksByWorkspace(workspaceId);
      // Context bounding for large workspaces: the proposal prompt gets the
      // evidence-bearing blocks (every concept's grounded block plus its
      // immediate neighbours for context) instead of the whole corpus. The
      // VALIDATOR still verifies quotes against ALL workspace blocks, so
      // nothing about acceptance rules changes — only the prompt size.
      let blocks = allBlocks;
      if (allBlocks.length > GRAPH_CONTEXT_BLOCK_LIMIT) {
        const wanted = new Set<string>();
        const byMaterial = new Map<string, typeof allBlocks>();
        for (const block of allBlocks) {
          const list = byMaterial.get(block.materialId) ?? [];
          list.push(block);
          byMaterial.set(block.materialId, list);
        }
        for (const concept of concepts) {
          const grounded = allBlocks.find((b) => b.id === concept.grounding.blockId);
          if (!grounded) continue;
          const siblings = byMaterial.get(grounded.materialId) ?? [];
          const at = siblings.findIndex((b) => b.id === grounded.id);
          for (const neighbour of siblings.slice(Math.max(0, at - 1), at + 2)) {
            wanted.add(neighbour.id);
          }
        }
        blocks = allBlocks.filter((b) => wanted.has(b.id));
        if (blocks.length === 0) blocks = allBlocks.slice(0, GRAPH_CONTEXT_BLOCK_LIMIT);
      }

      const now = clock.now().toISOString();
      const version: GraphVersion = {
        id: newId('gv'),
        workspaceId,
        status: 'generating',
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (provider.model ?? providerModel ?? null) : null,
        validationSummary: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      repos.graph.insertVersion(version);

      let payload;
      try {
        payload = await provider.proposeGraphEdges(
          {
            workspaceName: workspace.name,
            blocks,
            concepts,
            maxEdges: MAX_GRAPH_EDGES,
          },
          {
            ...opts,
            telemetry: { workspaceId, operationType: 'propose_graph_edges' },
          },
        );
      } catch (error) {
        repos.graph.markFailed(
          version.id,
          null,
          error instanceof Error ? error.message : '图谱生成失败。',
          clock.now().toISOString(),
        );
        throw error;
      }

      const { accepted, summary } = validateProposedEdges(payload.edges, {
        workspaceConcepts: concepts,
        blocks: allBlocks,
        conceptExistsElsewhere: (conceptId) => repos.materials.getConcept(conceptId) !== undefined,
      });

      const finishedAt = clock.now().toISOString();
      if (accepted.length === 0) {
        repos.graph.markFailed(
          version.id,
          summary,
          '模型提出的概念关系均未通过本地校验,原有图谱保持不变。',
          finishedAt,
        );
        throw new AppError(
          ApiErrorCode.GroundingFailed,
          '生成的概念关系均未通过本地校验(概念、引文或结构不合法),原有图谱未被修改。请重试。',
          { summary },
        );
      }

      const edges: GraphEdge[] = accepted.map((edge) => ({
        id: newId('ge'),
        graphVersionId: version.id,
        sourceConceptId: edge.sourceConceptId,
        targetConceptId: edge.targetConceptId,
        relation: edge.relation,
        explanation: edge.explanation,
        evidence: edge.evidence,
        createdAt: finishedAt,
      }));

      repos.graph.finalizeReady(version.id, workspaceId, edges, summary, finishedAt);
      const stored = repos.graph.getVersion(version.id)!;
      return { version: stored, edges: repos.graph.getEdges(version.id) };
    },

    /** The active graph (or empty structure when none exists yet). */
    getActive(workspaceId: string): WorkspaceGraph {
      const workspace = requireWorkspace(workspaceId);
      const concepts = repos.materials.getConceptsByWorkspace(workspaceId);
      if (!workspace.activeGraphVersionId) {
        return { version: null, edges: [], concepts };
      }
      const version = repos.graph.getVersion(workspace.activeGraphVersionId);
      if (!version) return { version: null, edges: [], concepts };
      return { version, edges: repos.graph.getEdges(version.id), concepts };
    },

    listVersions(workspaceId: string): GraphVersion[] {
      requireWorkspace(workspaceId);
      return repos.graph.listVersions(workspaceId);
    },

    /** One version with its edges (any status) — also the status endpoint. */
    getVersion(workspaceId: string, versionId: string): GraphGenerationResult {
      requireWorkspace(workspaceId);
      const version = repos.graph.getVersion(versionId);
      if (!version || version.workspaceId !== workspaceId) {
        throw notFound(`图谱版本不存在:${versionId}`);
      }
      return { version, edges: repos.graph.getEdges(versionId) };
    },

    /** Point the workspace at an existing ready version (transactional). */
    activate(workspaceId: string, versionId: string): GraphVersion {
      requireWorkspace(workspaceId);
      const version = repos.graph.getVersion(versionId);
      if (!version || version.workspaceId !== workspaceId) {
        throw notFound(`图谱版本不存在:${versionId}`);
      }
      if (version.status !== 'ready') {
        throw new AppError(
          ApiErrorCode.ValidationError,
          `只能激活状态为 ready 的图谱版本(当前:${version.status})。`,
        );
      }
      repos.graph.activate(workspaceId, versionId, clock.now().toISOString());
      return repos.graph.getVersion(versionId)!;
    },

    /**
     * Deterministic learner-state overlay for every workspace concept,
     * derived ONLY from existing mastery rows and mistake records (single
     * source of truth — nothing here re-computes or re-stores mastery).
     */
    learnerOverlay(workspaceId: string): ConceptLearnerState[] {
      const workspace = requireWorkspace(workspaceId);
      const concepts = repos.materials.getConceptsByWorkspace(workspaceId);
      const masteryByConcept = new Map(
        repos.mastery.listByWorkspace(workspaceId).map((m) => [m.conceptId, m]),
      );
      const mistakeCounts = repos.mistakes.countsByConceptForWorkspace(workspaceId);

      const prerequisitesByTarget = new Map<string, string[]>();
      if (workspace.activeGraphVersionId) {
        const edges = repos.graph.getEdges(workspace.activeGraphVersionId);
        for (const edge of edges) {
          if (edge.relation !== 'prerequisite') continue;
          const list = prerequisitesByTarget.get(edge.targetConceptId) ?? [];
          list.push(edge.sourceConceptId);
          prerequisitesByTarget.set(edge.targetConceptId, list);
        }
      }

      return concepts.map((concept) => {
        const mastery = masteryByConcept.get(concept.id);
        const counts = mistakeCounts.get(concept.id) ?? { open: 0, resolved: 0 };
        const attempts = mastery?.attempts ?? 0;

        let state: ConceptLearnerStateKind;
        if (attempts === 0) {
          state = 'unassessed';
        } else if (counts.open > 0 || (mastery?.mastery ?? 0) < WEAK_MASTERY_THRESHOLD) {
          state = 'weak';
        } else if (
          attempts >= MIN_SUPPORTED_ATTEMPTS &&
          (mastery?.mastery ?? 0) >= STABLE_MASTERY_THRESHOLD
        ) {
          state = 'stable';
        } else {
          state = 'developing';
        }

        return {
          conceptId: concept.id,
          conceptName: concept.name,
          materialId: concept.materialId,
          state,
          mastery: mastery ? mastery.mastery : null,
          hasEnoughActivity: attempts >= MIN_SUPPORTED_ATTEMPTS,
          attempts,
          correctCount: mastery?.correctCount ?? 0,
          lastScore: mastery?.lastScore ?? null,
          lastActivityAt: mastery?.updatedAt ?? null,
          openMistakes: counts.open,
          resolvedMistakes: counts.resolved,
          treatAsWeak: state === 'weak',
          prerequisiteConceptIds: (prerequisitesByTarget.get(concept.id) ?? []).slice(0, 50),
        };
      });
    },
  };
}

export type GraphService = ReturnType<typeof createGraphService>;
