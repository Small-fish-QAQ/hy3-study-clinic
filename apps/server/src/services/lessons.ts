import type {
  Concept,
  ConceptLesson,
  ConceptLessonPayload,
  GenerateLessonRequest,
  LessonConflict,
  LessonSection,
  VerifiedGrounding,
} from '@hy3-clinic/shared';
import { ApiErrorCode, GenerateLessonRequestSchema } from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import { verifyGrounding } from '../grounding/verify.js';
import { computeSections } from '../ingestion/sections.js';
import type { ConceptLessonInput, LlmProvider, ProviderCallOptions } from '../llm/provider.js';
import { searchSourceBlocks } from '../retrieval/lexical.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

export interface LessonsServiceDeps {
  repos: Repositories;
  provider: LlmProvider;
  clock: Clock;
  providerModel?: string | undefined;
}

/** Version tag stored with every lesson (bump when the prompt changes). */
export const LESSON_PROMPT_VERSION = 'lesson-v1';

/** Bounded lexical-retrieval context per lesson. */
const LESSON_RETRIEVAL_LIMIT = 8;
/** Bounded graph-neighbour context per lesson. */
const LESSON_NEIGHBOR_LIMIT = 6;

/**
 * Teaching-enrichment service: generate, validate, and persist ONE current
 * lesson card per concept.
 *
 * Deterministic responsibilities (never the model's):
 * - provenance: a segment is course-source-backed ONLY when its proposed
 *   anchor passes exact-quote verification here; failed anchors are dropped
 *   and the segment stays as labeled AI teaching;
 * - conflicts: an entry without a verifiable source quote is dropped whole —
 *   "the course text says X" is never displayed unverified;
 * - state safety: lessons touch no mastery/mistake/misconception/review
 *   rows, and a failed (re)generation preserves the previous valid card.
 */
export function createLessonsService({
  repos,
  provider,
  clock,
  providerModel,
}: LessonsServiceDeps) {
  function requireWorkspaceConcept(workspaceId: string, conceptId: string): Concept {
    if (!repos.workspaces.get(workspaceId)) throw notFound(`课程空间不存在:${workspaceId}`);
    const concept = repos.materials.getConcept(conceptId);
    if (!concept) throw notFound(`概念不存在:${conceptId}`);
    const material = repos.materials.get(concept.materialId);
    if (!material || material.workspaceId !== workspaceId) {
      throw notFound(`该课程空间下不存在此概念:${conceptId}`);
    }
    return concept;
  }

  /** Bounded generation context: own section + lexical hits + neighbours. */
  function buildInput(
    workspaceId: string,
    concept: Concept,
    directive: GenerateLessonRequest['directive'],
  ): ConceptLessonInput {
    const material = repos.materials.get(concept.materialId)!;
    const materialBlocks = repos.materials.getBlocks(concept.materialId);
    const outline = computeSections(materialBlocks);
    const ownSection = outline.find((section) =>
      section.blocks.some((block) => block.id === concept.grounding.blockId),
    );

    const contextBlocks = new Map<string, (typeof materialBlocks)[number]>();
    for (const block of ownSection?.blocks ?? []) contextBlocks.set(block.id, block);
    const workspaceBlocks = repos.materials.getBlocksByWorkspace(workspaceId);
    for (const hit of searchSourceBlocks(workspaceBlocks, concept.name.slice(0, 40), {
      limit: LESSON_RETRIEVAL_LIMIT,
    })) {
      const block = workspaceBlocks.find((b) => b.id === hit.blockId);
      if (block) contextBlocks.set(block.id, block);
    }
    // The concept's own grounded block is always present.
    const grounded = workspaceBlocks.find((b) => b.id === concept.grounding.blockId);
    if (grounded) contextBlocks.set(grounded.id, grounded);

    const neighbors: ConceptLessonInput['neighbors'] = [];
    const workspace = repos.workspaces.get(workspaceId)!;
    if (workspace.activeGraphVersionId) {
      for (const edge of repos.graph.getEdges(workspace.activeGraphVersionId)) {
        if (neighbors.length >= LESSON_NEIGHBOR_LIMIT) break;
        const isIn = edge.targetConceptId === concept.id;
        const isOut = edge.sourceConceptId === concept.id;
        if (!isIn && !isOut) continue;
        const other = repos.materials.getConcept(
          isIn ? edge.sourceConceptId : edge.targetConceptId,
        );
        if (!other) continue;
        neighbors.push({
          name: other.name,
          relation: edge.relation,
          direction: isIn ? 'in' : 'out',
        });
      }
    }

    return {
      concept,
      documentTitle: material.title,
      sectionTitle: ownSection?.title ?? null,
      blocks: [...contextBlocks.values()],
      neighbors,
      ...(directive ? { directive } : {}),
    };
  }

  /**
   * Deterministic validation of a proposed lesson. Anchors/conflict quotes
   * are verified against the OFFERED context blocks only — the model cannot
   * cite blocks it never saw.
   */
  function validatePayload(
    payload: ConceptLessonPayload,
    contextBlocks: ConceptLessonInput['blocks'],
  ): { sections: LessonSection[]; conflicts: LessonConflict[] } {
    const sections: LessonSection[] = [];
    for (const proposed of payload.sections.slice(0, 6)) {
      const segments = proposed.segments.slice(0, 10).map((segment) => {
        if (!segment.anchor) return { text: segment.text };
        const verification = verifyGrounding(contextBlocks, segment.anchor);
        // A failed anchor NEVER blocks the segment — it reclassifies it as
        // AI teaching (unanchored). Provenance stays server-decided.
        if (!verification.ok) return { text: segment.text };
        return { text: segment.text, anchor: verification.grounding };
      });
      if (segments.length > 0) sections.push({ kind: proposed.kind, segments });
    }
    if (sections.length === 0) {
      throw new AppError(
        ApiErrorCode.GroundingFailed,
        '讲解卡片生成结果为空,已保留原有讲解(如有)。请重试。',
      );
    }

    const conflicts: LessonConflict[] = [];
    for (const proposed of payload.conflicts.slice(0, 3)) {
      const verification = verifyGrounding(contextBlocks, {
        blockId: proposed.blockId,
        quote: proposed.quote,
      });
      // "The course text says otherwise" REQUIRES the verified quote; an
      // unverifiable conflict is dropped whole rather than shown.
      if (!verification.ok) continue;
      conflicts.push({ claim: proposed.claim, sourceQuote: verification.grounding });
    }
    return { sections, conflicts };
  }

  return {
    get(workspaceId: string, conceptId: string): ConceptLesson | null {
      requireWorkspaceConcept(workspaceId, conceptId);
      return repos.lessons.getByConcept(conceptId) ?? null;
    },

    /**
     * Generate (or regenerate, optionally with a fixed directive) the lesson
     * of one concept. Nothing persists unless full validation succeeds, so a
     * failure preserves the previous card.
     */
    async generate(
      workspaceId: string,
      conceptId: string,
      request: unknown,
      opts?: ProviderCallOptions,
    ): Promise<ConceptLesson> {
      const concept = requireWorkspaceConcept(workspaceId, conceptId);
      const { directive } = GenerateLessonRequestSchema.parse(request ?? {});
      const input = buildInput(workspaceId, concept, directive);
      const payload = await provider.generateConceptLesson(input, opts);
      const { sections, conflicts } = validatePayload(payload, input.blocks);

      const now = clock.now().toISOString();
      const previous = repos.lessons.getByConcept(conceptId);
      const lesson: ConceptLesson = {
        id: newId('les'),
        workspaceId,
        conceptId,
        content: { sections },
        conflicts,
        provider: provider.name,
        providerModel: provider.name === 'hy3' ? (providerModel ?? null) : null,
        promptVersion: LESSON_PROMPT_VERSION,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      repos.lessons.upsert(lesson);
      return repos.lessons.getByConcept(conceptId)!;
    },
  };
}

/** Count the verified source anchors of one lesson (mapping/telemetry). */
export function lessonAnchors(lesson: ConceptLesson): VerifiedGrounding[] {
  const anchors: VerifiedGrounding[] = [];
  for (const section of lesson.content.sections) {
    for (const segment of section.segments) {
      if (segment.anchor) anchors.push(segment.anchor);
    }
  }
  for (const conflict of lesson.conflicts) anchors.push(conflict.sourceQuote);
  return anchors;
}

export type LessonsService = ReturnType<typeof createLessonsService>;
