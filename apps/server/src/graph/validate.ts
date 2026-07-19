import {
  ACYCLIC_RELATIONS,
  MAX_EDGE_EVIDENCE,
  MAX_GRAPH_EDGES,
  type Concept,
  type GraphRelation,
  type GraphValidationSummary,
  type ProposedGraphEdge,
  type RejectedEdge,
  type SourceBlock,
  type VerifiedGrounding,
} from '@hy3-clinic/shared';
import { verifyGrounding } from '../grounding/verify.js';

/**
 * Deterministic local validation of model-proposed graph edges — the trust
 * boundary between provider output and the persisted concept graph.
 *
 * Candidates are processed in payload order; each edge is judged
 * independently so one invalid candidate never rejects valid siblings.
 * Rules enforced here (each covered by tests):
 *  - both concepts must exist AND belong to the graph's workspace
 *    (references to concepts of other workspaces are rejected explicitly);
 *  - source and target must differ (no self-links);
 *  - the relation must be one of the controlled enum values (schema-checked
 *    upstream; re-checked here for defense in depth);
 *  - every evidence quote must pass the existing exact-quote grounding rules
 *    against the workspace's source blocks; unverifiable evidence records are
 *    dropped, and an edge with NO surviving evidence is rejected;
 *  - normalized duplicates (source, target, relation) are removed;
 *  - `prerequisite` and `part_of` must stay acyclic: an edge that would close
 *    a cycle among already-accepted edges of the same relation is rejected;
 *  - at most MAX_GRAPH_EDGES edges are accepted.
 *
 * NOTE: exact-quote verification proves the quote exists at the claimed
 * source position; it does not by itself prove the RELATIONSHIP is
 * semantically entailed. The UI labels edge explanations as model-proposed.
 */

export interface AcceptedEdgeCandidate {
  sourceConceptId: string;
  targetConceptId: string;
  relation: GraphRelation;
  explanation: string;
  evidence: VerifiedGrounding[];
}

export interface GraphValidationContext {
  /** Concepts belonging to the workspace (the only legal node set). */
  workspaceConcepts: Concept[];
  /** All source blocks of the workspace (evidence search space). */
  blocks: SourceBlock[];
  /** Returns true when a concept id exists in ANOTHER workspace. */
  conceptExistsElsewhere?: (conceptId: string) => boolean;
  /** Override for tests; defaults to MAX_GRAPH_EDGES. */
  maxEdges?: number;
}

export interface GraphValidationResult {
  accepted: AcceptedEdgeCandidate[];
  summary: GraphValidationSummary;
}

/** Would adding source→target close a cycle in `edges` of one relation? */
function closesCycle(
  edges: Array<{ source: string; target: string }>,
  source: string,
  target: string,
): boolean {
  // Cycle exists iff `source` is reachable FROM `target` via existing edges.
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  const stack = [target];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === source) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

export function validateProposedEdges(
  candidates: ProposedGraphEdge[],
  ctx: GraphValidationContext,
): GraphValidationResult {
  const conceptIds = new Set(ctx.workspaceConcepts.map((c) => c.id));
  const maxEdges = ctx.maxEdges ?? MAX_GRAPH_EDGES;

  const accepted: AcceptedEdgeCandidate[] = [];
  const rejected: RejectedEdge[] = [];
  const seenNormalized = new Set<string>();
  const acceptedByRelation = new Map<GraphRelation, Array<{ source: string; target: string }>>();
  let duplicateCount = 0;
  let droppedEvidenceCount = 0;

  const reject = (candidate: ProposedGraphEdge, reason: string) => {
    if (rejected.length < 50) {
      rejected.push({
        sourceConceptId: candidate.sourceConceptId || null,
        targetConceptId: candidate.targetConceptId || null,
        relation: candidate.relation || null,
        reason,
      });
    }
  };

  for (const candidate of candidates) {
    const missing = [candidate.sourceConceptId, candidate.targetConceptId].find(
      (id) => !conceptIds.has(id),
    );
    if (missing !== undefined) {
      const elsewhere = ctx.conceptExistsElsewhere?.(missing) ?? false;
      reject(candidate, elsewhere ? `概念属于其他课程空间:${missing}` : `未知概念:${missing}`);
      continue;
    }
    if (candidate.sourceConceptId === candidate.targetConceptId) {
      reject(candidate, '起点与终点相同(自环)。');
      continue;
    }

    const normalizedKey = `${candidate.sourceConceptId}→${candidate.targetConceptId}:${candidate.relation}`;
    if (seenNormalized.has(normalizedKey)) {
      duplicateCount++;
      continue;
    }

    const verifiedEvidence: VerifiedGrounding[] = [];
    for (const proposed of candidate.evidence.slice(0, MAX_EDGE_EVIDENCE)) {
      const verification = verifyGrounding(ctx.blocks, {
        blockId: proposed.blockId,
        quote: proposed.quote,
      });
      if (verification.ok) verifiedEvidence.push(verification.grounding);
      else droppedEvidenceCount++;
    }
    if (verifiedEvidence.length === 0) {
      reject(candidate, '所有依据引文均未通过原文校验。');
      continue;
    }

    if (ACYCLIC_RELATIONS.includes(candidate.relation)) {
      const existing = acceptedByRelation.get(candidate.relation) ?? [];
      if (closesCycle(existing, candidate.sourceConceptId, candidate.targetConceptId)) {
        reject(candidate, `接受该边将使 ${candidate.relation} 关系形成环,已拒绝。`);
        continue;
      }
    }

    if (accepted.length >= maxEdges) {
      reject(candidate, `已达到图谱边数上限(${maxEdges})。`);
      continue;
    }

    seenNormalized.add(normalizedKey);
    if (ACYCLIC_RELATIONS.includes(candidate.relation)) {
      const list = acceptedByRelation.get(candidate.relation) ?? [];
      list.push({ source: candidate.sourceConceptId, target: candidate.targetConceptId });
      acceptedByRelation.set(candidate.relation, list);
    }
    accepted.push({
      sourceConceptId: candidate.sourceConceptId,
      targetConceptId: candidate.targetConceptId,
      relation: candidate.relation,
      explanation: candidate.explanation,
      evidence: verifiedEvidence,
    });
  }

  return {
    accepted,
    summary: {
      candidateCount: candidates.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      duplicateCount,
      droppedEvidenceCount,
      rejected,
    },
  };
}
