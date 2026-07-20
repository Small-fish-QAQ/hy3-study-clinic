import { z } from 'zod';
import {
  TUTOR_LIMITS,
  type Concept,
  type TutorEventKind,
  type TutorToolName,
} from '@hy3-clinic/shared';
import { searchSourceBlocks } from '../retrieval/lexical.js';
import { overdueDays } from '../review/scheduler.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';

/**
 * The Tutor tool whitelist: small, typed, runtime-validated, READ-ONLY.
 *
 * Security invariants (each covered by tests):
 * - the workspace scope comes from the SERVER context, never from model args;
 * - every id argument is checked to belong to that workspace — cross-
 *   workspace ids fail closed;
 * - executors only call repository read methods: no SQL strings, no
 *   filesystem, no network, no state mutation of any kind;
 * - every observation payload is bounded (`maxObservationChars`);
 * - unknown tools/arguments are rejected by Zod before any execution.
 */

export interface TutorToolContext {
  workspaceId: string;
  repos: Repositories;
  clock: Clock;
  /** The session's selected concept (used for graph expansion in search). */
  selected: Concept;
}

export interface TutorToolResult {
  /** Concise, display-safe Chinese summary for the timeline. */
  summary: string;
  /** Bounded structured observation returned to the model. */
  data: unknown;
  /** Optional semantic timeline event this tool maps to. */
  semanticEvent?: TutorEventKind;
  /** Result rows/items count, for the timeline detail. */
  resultCount?: number;
  /** Weak prerequisite concept names detected (drives gap_identified). */
  weakPrerequisites?: string[];
}

interface ToolDefinition {
  description: string;
  argsSchema: z.ZodTypeAny;
  execute: (ctx: TutorToolContext, args: Record<string, unknown>) => TutorToolResult;
}

function requireWorkspaceConcept(ctx: TutorToolContext, conceptId: string): Concept {
  const concept = ctx.repos.materials.getConcept(conceptId);
  if (!concept) throw new ToolValidationError(`概念不存在:${conceptId}`);
  const material = ctx.repos.materials.get(concept.materialId);
  if (!material || material.workspaceId !== ctx.workspaceId) {
    throw new ToolValidationError(`概念不属于当前课程空间:${conceptId}`);
  }
  return concept;
}

/**
 * Workspace-level display name of a concept: the canonical display name when
 * the concept has an alignment membership, else its own extracted name.
 * Timeline summaries use this so the Tutor speaks the same names the
 * canonical graph shows (aliases stay inspectable via the aliases tool).
 */
function displayNameOf(ctx: TutorToolContext, concept: Concept): string {
  const member = ctx.repos.alignment.getMemberBySource(concept.id);
  if (!member) return concept.name;
  return ctx.repos.alignment.getCanonical(member.canonicalConceptId)?.displayName ?? concept.name;
}

/** Raised when tool arguments fail validation (never executes the tool). */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

const ConceptArg = z.object({ conceptId: z.string().min(1) }).strict();
const OptionalConceptArg = z.object({ conceptId: z.string().min(1).optional() }).strict();

const TOOLS: Record<TutorToolName, ToolDefinition> = {
  inspect_learning_state: {
    description: '查看某概念的掌握度、作答次数、错题与复习状态。参数:{"conceptId":"..."}',
    argsSchema: ConceptArg,
    execute(ctx, args) {
      const concept = requireWorkspaceConcept(ctx, args.conceptId as string);
      const displayName = displayNameOf(ctx, concept);
      const mastery = ctx.repos.mastery.get(concept.materialId, concept.id);
      const mistakes = ctx.repos.mistakes
        .countsByConceptForWorkspace(ctx.workspaceId)
        .get(concept.id) ?? { open: 0, resolved: 0 };
      const misconceptions = ctx.repos.misconceptions
        .countsByConceptForWorkspace(ctx.workspaceId)
        .get(concept.id) ?? { conceptId: concept.id, proposed: 0, confirmed: 0 };
      const review = ctx.repos.review.get(ctx.workspaceId, concept.id);
      return {
        summary: `已检查「${displayName}」的学习状态:掌握度 ${
          mastery ? Math.round(mastery.mastery * 100) + '%' : '未评估'
        },未解决错题 ${mistakes.open} 道。`,
        semanticEvent: 'state_inspected',
        data: {
          conceptId: concept.id,
          name: concept.name,
          mastery: mastery?.mastery ?? null,
          attempts: mastery?.attempts ?? 0,
          openMistakes: mistakes.open,
          resolvedMistakes: mistakes.resolved,
          proposedMisconceptions: misconceptions.proposed,
          confirmedMisconceptions: misconceptions.confirmed,
          reviewDueAt: review?.dueAt ?? null,
          reviewOverdueDays: review ? overdueDays(review.dueAt, ctx.clock.now()) : null,
        },
      };
    },
  },

  inspect_concept: {
    description: '查看某概念的定义、重要性与原文出处。参数:{"conceptId":"..."}',
    argsSchema: ConceptArg,
    execute(ctx, args) {
      const concept = requireWorkspaceConcept(ctx, args.conceptId as string);
      const material = ctx.repos.materials.get(concept.materialId);
      return {
        summary: `已查看概念「${displayNameOf(ctx, concept)}」的定义与出处。`,
        data: {
          conceptId: concept.id,
          name: concept.name,
          summary: concept.summary,
          importance: concept.importance,
          documentTitle: material?.title ?? concept.materialId,
          quote: concept.grounding.quote,
          blockId: concept.grounding.blockId,
        },
      };
    },
  },

  inspect_canonical_aliases: {
    description: '查看某概念对齐后的规范名称、别名与来源文档。参数:{"conceptId":"..."}',
    argsSchema: ConceptArg,
    execute(ctx, args) {
      const concept = requireWorkspaceConcept(ctx, args.conceptId as string);
      const member = ctx.repos.alignment.getMemberBySource(concept.id);
      if (!member) {
        return {
          summary: `「${concept.name}」尚未建立跨文档对齐。`,
          data: { conceptId: concept.id, canonicalName: concept.name, aliases: [], documents: [] },
        };
      }
      const canonical = ctx.repos.alignment.getCanonical(member.canonicalConceptId);
      const members = ctx.repos.alignment.getMembers(member.canonicalConceptId);
      const titles = new Map(
        ctx.repos.materials.listByWorkspace(ctx.workspaceId).map((m) => [m.id, m.title]),
      );
      const aliases = [
        ...new Set(members.map((m) => m.originalName).filter((n) => n !== canonical?.displayName)),
      ];
      return {
        summary: `「${canonical?.displayName ?? concept.name}」共有 ${members.length} 个来源概念、${aliases.length} 个别名。`,
        data: {
          conceptId: concept.id,
          canonicalName: canonical?.displayName ?? concept.name,
          aliases: aliases.slice(0, 10),
          documents: [...new Set(members.map((m) => titles.get(m.materialId) ?? m.materialId))],
          memberConceptIds: members.map((m) => m.sourceConceptId).slice(0, 10),
        },
      };
    },
  },

  get_graph_neighborhood: {
    description: '查看某概念在图谱中的直接邻居及其学习状态。参数:{"conceptId":"..."}',
    argsSchema: ConceptArg,
    execute(ctx, args) {
      const concept = requireWorkspaceConcept(ctx, args.conceptId as string);
      const workspace = ctx.repos.workspaces.get(ctx.workspaceId)!;
      const neighbors: Array<Record<string, unknown>> = [];
      const weakPrerequisites: string[] = [];
      if (workspace.activeGraphVersionId) {
        const edges = ctx.repos.graph.getEdges(workspace.activeGraphVersionId);
        const mistakeCounts = ctx.repos.mistakes.countsByConceptForWorkspace(ctx.workspaceId);
        const masteryByConcept = new Map(
          ctx.repos.mastery.listByWorkspace(ctx.workspaceId).map((m) => [m.conceptId, m]),
        );
        for (const edge of edges) {
          if (neighbors.length >= 10) break;
          const isIn = edge.targetConceptId === concept.id;
          const isOut = edge.sourceConceptId === concept.id;
          if (!isIn && !isOut) continue;
          const otherId = isIn ? edge.sourceConceptId : edge.targetConceptId;
          const other = ctx.repos.materials.getConcept(otherId);
          if (!other) continue;
          const mastery = masteryByConcept.get(otherId)?.mastery ?? null;
          const open = mistakeCounts.get(otherId)?.open ?? 0;
          const weak = open > 0 || (mastery !== null && mastery < 0.7);
          const otherDisplay = displayNameOf(ctx, other);
          if (edge.relation === 'prerequisite' && isIn && weak) {
            weakPrerequisites.push(otherDisplay);
          }
          neighbors.push({
            conceptId: other.id,
            name: otherDisplay,
            relation: edge.relation,
            direction: isIn ? 'in' : 'out',
            mastery,
            openMistakes: open,
            weak,
          });
        }
      }
      return {
        summary: `已检查「${displayNameOf(ctx, concept)}」的图谱邻域:${neighbors.length} 个直接邻居${
          weakPrerequisites.length > 0 ? `,发现薄弱前置:${weakPrerequisites.join('、')}` : ''
        }。`,
        semanticEvent: 'neighborhood_inspected',
        resultCount: neighbors.length,
        weakPrerequisites,
        data: { conceptId: concept.id, neighbors },
      };
    },
  },

  get_prerequisite_path: {
    description: '沿 prerequisite 边向上追溯前置概念链(最多 3 层)。参数:{"conceptId":"..."}',
    argsSchema: ConceptArg,
    execute(ctx, args) {
      const concept = requireWorkspaceConcept(ctx, args.conceptId as string);
      const workspace = ctx.repos.workspaces.get(ctx.workspaceId)!;
      const path: Array<Record<string, unknown>> = [];
      const weakPrerequisites: string[] = [];
      if (workspace.activeGraphVersionId) {
        const edges = ctx.repos.graph
          .getEdges(workspace.activeGraphVersionId)
          .filter((e) => e.relation === 'prerequisite');
        const mistakeCounts = ctx.repos.mistakes.countsByConceptForWorkspace(ctx.workspaceId);
        const masteryByConcept = new Map(
          ctx.repos.mastery.listByWorkspace(ctx.workspaceId).map((m) => [m.conceptId, m]),
        );
        const visited = new Set<string>([concept.id]);
        let frontier = [concept.id];
        for (let depth = 1; depth <= 3 && path.length < 8; depth++) {
          const next: string[] = [];
          for (const nodeId of frontier) {
            for (const edge of edges) {
              if (edge.targetConceptId !== nodeId || visited.has(edge.sourceConceptId)) continue;
              visited.add(edge.sourceConceptId);
              const prereq = ctx.repos.materials.getConcept(edge.sourceConceptId);
              if (!prereq || path.length >= 8) continue;
              const mastery = masteryByConcept.get(prereq.id)?.mastery ?? null;
              const open = mistakeCounts.get(prereq.id)?.open ?? 0;
              const weak = open > 0 || (mastery !== null && mastery < 0.7);
              const prereqDisplay = displayNameOf(ctx, prereq);
              if (weak) weakPrerequisites.push(prereqDisplay);
              path.push({
                conceptId: prereq.id,
                name: prereqDisplay,
                depth,
                mastery,
                openMistakes: open,
                weak,
              });
              next.push(prereq.id);
            }
          }
          frontier = next;
        }
      }
      return {
        summary: `已追溯「${displayNameOf(ctx, concept)}」的前置链:${path.length} 个前置概念${
          weakPrerequisites.length > 0 ? `,其中薄弱:${weakPrerequisites.join('、')}` : ''
        }。`,
        resultCount: path.length,
        weakPrerequisites,
        data: { conceptId: concept.id, path },
      };
    },
  },

  search_source_blocks: {
    description:
      '按关键词检索全课程空间的原文段落(词法 + 图谱邻域扩展,最多 8 条)。参数:{"query":"...","limit":5}',
    argsSchema: z
      .object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(TUTOR_LIMITS.maxBlocksPerSearch).optional(),
      })
      .strict(),
    execute(ctx, args) {
      const blocks = ctx.repos.materials.getBlocksByWorkspace(ctx.workspaceId);
      const workspace = ctx.repos.workspaces.get(ctx.workspaceId)!;
      const neighborBlocks = new Set<string>();
      if (workspace.activeGraphVersionId) {
        for (const edge of ctx.repos.graph.getEdges(workspace.activeGraphVersionId)) {
          if (
            edge.sourceConceptId === ctx.selected.id ||
            edge.targetConceptId === ctx.selected.id
          ) {
            for (const ev of edge.evidence) neighborBlocks.add(ev.blockId);
          }
        }
      }
      const results = searchSourceBlocks(blocks, args.query as string, {
        limit: Math.min(
          (args.limit as number | undefined) ?? TUTOR_LIMITS.maxBlocksPerSearch,
          TUTOR_LIMITS.maxBlocksPerSearch,
        ),
        graphNeighborBlockIds: neighborBlocks,
      });
      const titles = new Map(
        ctx.repos.materials.listByWorkspace(ctx.workspaceId).map((m) => [m.id, m.title]),
      );
      const documents = [...new Set(results.map((r) => titles.get(r.materialId) ?? r.materialId))];
      return {
        summary: `检索「${String(args.query).slice(0, 30)}」:命中 ${results.length} 个原文段落(${documents.length} 份文档)。`,
        resultCount: results.length,
        data: {
          results: results.map((r) => ({
            blockId: r.blockId,
            document: titles.get(r.materialId) ?? r.materialId,
            page: r.pageNumber,
            heading: r.headingPath.join(' / ') || null,
            score: r.matchScore,
            source: r.source,
            excerpt: r.excerpt,
          })),
        },
      };
    },
  },

  read_source_block: {
    description: '读取一个源块的完整原文(仅限当前课程空间)。参数:{"blockId":"..."}',
    argsSchema: z.object({ blockId: z.string().min(1) }).strict(),
    execute(ctx, args) {
      const block = ctx.repos.materials.getBlock(args.blockId as string);
      if (!block) throw new ToolValidationError(`源块不存在:${String(args.blockId)}`);
      const material = ctx.repos.materials.get(block.materialId);
      if (!material || material.workspaceId !== ctx.workspaceId) {
        throw new ToolValidationError('源块不属于当前课程空间。');
      }
      return {
        summary: `已读取《${material.title}》的一个原文段落(${block.content.length} 字)。`,
        resultCount: 1,
        data: {
          blockId: block.id,
          document: material.title,
          page: block.pageNumber,
          heading: block.headingPath.join(' / ') || null,
          content: block.content.slice(0, Math.floor(TUTOR_LIMITS.maxObservationChars / 2)),
        },
      };
    },
  },

  inspect_open_mistakes: {
    description: '查看未解决错题的题干与得分(不含答案)。参数:{"conceptId":"..."} 可省略。',
    argsSchema: OptionalConceptArg,
    execute(ctx, args) {
      let mistakes = ctx.repos.mistakes.listOpenByWorkspace(ctx.workspaceId);
      if (typeof args.conceptId === 'string') {
        const concept = requireWorkspaceConcept(ctx, args.conceptId);
        mistakes = mistakes.filter((m) => m.conceptId === concept.id);
      }
      const bounded = mistakes.slice(0, 5);
      return {
        summary: `查看未解决错题:共 ${mistakes.length} 道,展示前 ${bounded.length} 道题干。`,
        resultCount: mistakes.length,
        data: {
          openMistakes: bounded.map((m) => ({
            conceptId: m.conceptId,
            conceptName: m.conceptName,
            stem: m.question.stem.slice(0, 200),
            score: m.score,
            createdAt: m.createdAt,
          })),
        },
      };
    },
  },

  inspect_misconceptions: {
    description: '查看误区假设(待确认/已确认优先)。参数:{"conceptId":"..."} 可省略。',
    argsSchema: OptionalConceptArg,
    execute(ctx, args) {
      let records = ctx.repos.misconceptions
        .listByWorkspace(ctx.workspaceId)
        .filter((r) => r.status === 'proposed' || r.status === 'confirmed');
      if (typeof args.conceptId === 'string') {
        const concept = requireWorkspaceConcept(ctx, args.conceptId);
        records = records.filter((r) => r.conceptId === concept.id);
      }
      // Confirmed misconceptions outrank one-off proposed hypotheses.
      records.sort((a, b) =>
        a.status === b.status
          ? a.createdAt.localeCompare(b.createdAt)
          : a.status === 'confirmed'
            ? -1
            : 1,
      );
      const bounded = records.slice(0, 5);
      return {
        summary: `查看误区假设:已确认 ${records.filter((r) => r.status === 'confirmed').length} 个,待确认 ${records.filter((r) => r.status === 'proposed').length} 个。`,
        semanticEvent: 'misconception_inspected',
        resultCount: records.length,
        data: {
          misconceptions: bounded.map((r) => ({
            id: r.id,
            conceptId: r.conceptId,
            conceptName: r.conceptName,
            status: r.status,
            category: r.category,
            hypothesis: r.hypothesis,
          })),
        },
      };
    },
  },

  inspect_review_queue: {
    description: '查看复习队列(到期与将到期的概念)。参数:{}',
    argsSchema: z.object({}).strict(),
    execute(ctx) {
      const now = ctx.clock.now();
      const items = ctx.repos.review.listByWorkspace(ctx.workspaceId).slice(0, 8);
      const due = items.filter((i) => new Date(i.dueAt).getTime() <= now.getTime());
      return {
        summary: `查看复习队列:${due.length} 个概念已到期复习。`,
        resultCount: items.length,
        data: {
          items: items.map((i) => ({
            conceptId: i.conceptId,
            conceptName: i.conceptName,
            dueAt: i.dueAt,
            overdueDays: overdueDays(i.dueAt, now),
            lastRating: i.lastRating,
            reviewCount: i.reviewCount,
            lapseCount: i.lapseCount,
          })),
        },
      };
    },
  },
};

export interface ToolCatalogEntry {
  name: TutorToolName;
  description: string;
}

export function toolCatalog(): ToolCatalogEntry[] {
  return (Object.keys(TOOLS) as TutorToolName[]).map((name) => ({
    name,
    description: TOOLS[name].description,
  }));
}

/**
 * Validate arguments and execute one whitelisted tool. Throws
 * ToolValidationError on invalid arguments or out-of-workspace references —
 * the tool never executes in that case.
 */
export function executeTutorTool(
  ctx: TutorToolContext,
  name: TutorToolName,
  args: Record<string, unknown>,
): TutorToolResult {
  const tool = TOOLS[name];
  if (!tool) throw new ToolValidationError(`未知工具:${name}`);
  const parsed = tool.argsSchema.safeParse(args);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ToolValidationError(`工具参数不合法:${summary}`);
  }
  return tool.execute(ctx, parsed.data as Record<string, unknown>);
}

/** Truncate an observation payload to the documented budget. */
export function boundObservation(data: unknown): string {
  const text = JSON.stringify(data);
  return text.length <= TUTOR_LIMITS.maxObservationChars
    ? text
    : `${text.slice(0, TUTOR_LIMITS.maxObservationChars)}…(截断)`;
}
