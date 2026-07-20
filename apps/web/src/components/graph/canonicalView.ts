import type {
  CanonicalConceptView,
  Concept,
  ConceptLearnerState,
  GraphEdge,
} from '@hy3-clinic/shared';
import {
  MIN_SUPPORTED_ATTEMPTS,
  STABLE_MASTERY_THRESHOLD,
  WEAK_MASTERY_THRESHOLD,
} from '@hy3-clinic/shared';

/**
 * Canonical display projection of the workspace graph.
 *
 * Pure derivation (no persistence, no second source of truth): source
 * concepts, edges, and per-source learner states stay untouched; this module
 * only computes what the graph should RENDER once alignment merged concepts:
 * - one node per canonical group, named by the canonical display name,
 *   anchored on a stable representative source concept (so node ids, saved
 *   positions, selection and plan APIs keep working);
 * - edges re-anchored to representatives, self-loops dropped, (source,
 *   target, relation) duplicates collapsed while remembering the underlying
 *   edges for the inspector;
 * - learner overlay aggregated across group members with the SAME thresholds
 *   as the server-side per-concept derivation.
 */

export interface CanonicalDisplayGraph {
  concepts: Concept[];
  edges: GraphEdge[];
  /** source concept id → representative (display node) concept id. */
  representativeByConcept: Map<string, string>;
  /** representative id → underlying edges collapsed into each display edge. */
  underlyingEdgesByDisplayEdge: Map<string, GraphEdge[]>;
  /** representative id → canonical group view (members, aliases, documents). */
  canonicalByRepresentative: Map<string, CanonicalConceptView>;
}

export function buildCanonicalDisplayGraph(
  concepts: Concept[],
  edges: GraphEdge[],
  canonical: CanonicalConceptView[],
): CanonicalDisplayGraph {
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const representativeByConcept = new Map<string, string>();
  const canonicalByRepresentative = new Map<string, CanonicalConceptView>();
  const displayConcepts: Concept[] = [];
  const consumed = new Set<string>();

  for (const group of canonical) {
    const memberConcepts = group.members
      .map((m) => conceptById.get(m.sourceConceptId))
      .filter((c): c is Concept => c !== undefined);
    if (memberConcepts.length === 0) continue;
    const representative = memberConcepts[0]!;
    for (const member of memberConcepts) {
      representativeByConcept.set(member.id, representative.id);
      consumed.add(member.id);
    }
    canonicalByRepresentative.set(representative.id, group);
    displayConcepts.push(
      representative.name === group.displayName
        ? representative
        : { ...representative, name: group.displayName },
    );
  }

  // Concepts without canonical membership (baseline not yet built) pass through.
  for (const concept of concepts) {
    if (consumed.has(concept.id)) continue;
    representativeByConcept.set(concept.id, concept.id);
    displayConcepts.push(concept);
  }

  const displayEdges: GraphEdge[] = [];
  const underlyingEdgesByDisplayEdge = new Map<string, GraphEdge[]>();
  const displayEdgeByKey = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const source = representativeByConcept.get(edge.sourceConceptId) ?? edge.sourceConceptId;
    const target = representativeByConcept.get(edge.targetConceptId) ?? edge.targetConceptId;
    if (source === target) continue; // intra-group edge → nothing to draw
    const key = `${source}→${target}:${edge.relation}`;
    const existing = displayEdgeByKey.get(key);
    if (existing) {
      underlyingEdgesByDisplayEdge.get(existing.id)!.push(edge);
      continue;
    }
    const display: GraphEdge =
      source === edge.sourceConceptId && target === edge.targetConceptId
        ? edge
        : { ...edge, sourceConceptId: source, targetConceptId: target };
    displayEdgeByKey.set(key, display);
    displayEdges.push(display);
    underlyingEdgesByDisplayEdge.set(display.id, [edge]);
  }

  return {
    concepts: displayConcepts,
    edges: displayEdges,
    representativeByConcept,
    underlyingEdgesByDisplayEdge,
    canonicalByRepresentative,
  };
}

/**
 * Aggregate per-source learner states into per-display-node states, using
 * the same thresholds as the server-side single-concept derivation.
 */
export function aggregateOverlay(
  overlay: Map<string, ConceptLearnerState>,
  display: CanonicalDisplayGraph,
): Map<string, ConceptLearnerState> {
  const memberStates = new Map<string, ConceptLearnerState[]>();
  for (const [conceptId, state] of overlay) {
    const representative = display.representativeByConcept.get(conceptId) ?? conceptId;
    const list = memberStates.get(representative) ?? [];
    list.push(state);
    memberStates.set(representative, list);
  }

  const aggregated = new Map<string, ConceptLearnerState>();
  for (const concept of display.concepts) {
    const states = memberStates.get(concept.id) ?? [];
    if (states.length === 0) continue;
    if (states.length === 1) {
      const only = states[0]!;
      aggregated.set(
        concept.id,
        only.conceptId === concept.id ? only : { ...only, conceptId: concept.id },
      );
      continue;
    }

    const attempts = states.reduce((sum, s) => sum + s.attempts, 0);
    const openMistakes = states.reduce((sum, s) => sum + s.openMistakes, 0);
    const resolvedMistakes = states.reduce((sum, s) => sum + s.resolvedMistakes, 0);
    const correctCount = states.reduce((sum, s) => sum + s.correctCount, 0);
    const assessed = states.filter((s) => s.attempts > 0 && s.mastery !== null);
    const mastery =
      attempts === 0 || assessed.length === 0
        ? null
        : assessed.reduce((sum, s) => sum + s.mastery! * s.attempts, 0) /
          assessed.reduce((sum, s) => sum + s.attempts, 0);
    const lastActive = states
      .filter((s) => s.lastActivityAt !== null)
      .sort((a, b) => (a.lastActivityAt! < b.lastActivityAt! ? 1 : -1))[0];

    let state: ConceptLearnerState['state'];
    if (attempts === 0) {
      state = 'unassessed';
    } else if (openMistakes > 0 || (mastery ?? 0) < WEAK_MASTERY_THRESHOLD) {
      state = 'weak';
    } else if (attempts >= MIN_SUPPORTED_ATTEMPTS && (mastery ?? 0) >= STABLE_MASTERY_THRESHOLD) {
      state = 'stable';
    } else {
      state = 'developing';
    }

    aggregated.set(concept.id, {
      conceptId: concept.id,
      conceptName: concept.name,
      materialId: concept.materialId,
      state,
      mastery: mastery === null ? null : Math.round(mastery * 10_000) / 10_000,
      hasEnoughActivity: attempts >= MIN_SUPPORTED_ATTEMPTS,
      attempts,
      correctCount,
      lastScore: lastActive?.lastScore ?? null,
      lastActivityAt: lastActive?.lastActivityAt ?? null,
      openMistakes,
      resolvedMistakes,
      treatAsWeak: state === 'weak',
      prerequisiteConceptIds: [],
    });
  }
  return aggregated;
}
