import type { ProposedRubricPoint, RubricPoint } from '@hy3-clinic/shared';

/**
 * Local, deterministic alignment between a question's wording and its rubric.
 *
 * Providers CLASSIFY rubric points as required/optional, but their claim is
 * never trusted alone. This module enforces the core rule — only information
 * explicitly requested by the question (or logically necessary to answer it)
 * may be a required scoring criterion — with two bounded, documented checks:
 *
 * 1. Aspect alignment: evaluative content (advantages, drawbacks,
 *    comparisons) may only be required when the stem explicitly requests
 *    that aspect (「…及缺点」「比较优缺点」…). Unrequested evaluative points
 *    are demoted to optional enrichment; requested ones are promoted to
 *    required even if the provider marked them optional.
 * 2. Evidence grounding: a required point must be supported by the
 *    question's verified source blocks (character-coverage heuristic, CJK
 *    friendly). Ungrounded required points are demoted to optional.
 *
 * These are deliberately conservative keyword heuristics, not semantic
 * understanding: they catch the common failure (a reference answer's extra
 * sentence silently becoming a hidden grading requirement) without inventing
 * requirements of their own. A rubric that ends up with no required point
 * cannot score anything and is rejected.
 */

interface Aspect {
  /** Stem substrings that mean the question explicitly requests the aspect. */
  stemMarkers: readonly string[];
  /** Rubric-point pattern that marks the point as stating this aspect. */
  pointPattern: RegExp;
}

const ASPECTS: readonly Aspect[] = [
  {
    // Drawbacks / limitations, incl. contrastive clauses like 「快但易切断语义」.
    stemMarkers: [
      '缺点',
      '不足',
      '局限',
      '缺陷',
      '弊端',
      '劣势',
      '坏处',
      '风险',
      '优缺点',
      '优劣',
      '利弊',
    ],
    pointPattern: /(缺点|不足|局限|缺陷|弊端|劣势|坏处|风险)|但.{0,4}(易|难|会|可能|无法|不能|不)/u,
  },
  {
    stemMarkers: ['优点', '优势', '好处', '优缺点', '优劣', '利弊'],
    pointPattern: /(优点|优势|好处)/u,
  },
  {
    stemMarkers: ['比较', '对比', '异同', '区别', '差异', '共同', '相同', '不同'],
    pointPattern: /(相同|相似|共同|不同|区别|差异|异同)/u,
  },
];

/**
 * Share of a text's distinct meaningful characters found in `sourceText`.
 * Deterministic and CJK-friendly; also used by the fake provider's grading.
 */
export function charCoverageRatio(text: string, sourceText: string): number {
  const chars = [...new Set([...text.replace(/[\s,。!?;:、,.!?;:\-—()()「」《》*#]/gu, '')])];
  if (chars.length === 0) return 0;
  const hit = chars.filter((c) => sourceText.includes(c)).length;
  return hit / chars.length;
}

/** A required point counts as grounded above this evidence-coverage ratio. */
export const RUBRIC_GROUNDING_THRESHOLD = 0.5;

/** Classify one point's `required` flag against the stem's explicit wording. */
export function alignPointToStem(stem: string, point: ProposedRubricPoint): boolean {
  let matchedAnyAspect = false;
  for (const aspect of ASPECTS) {
    if (!aspect.pointPattern.test(point.text)) continue;
    matchedAnyAspect = true;
    if (aspect.stemMarkers.some((marker) => stem.includes(marker))) {
      return true; // aspect explicitly requested → required
    }
  }
  if (matchedAnyAspect) return false; // evaluative but unrequested → optional
  return point.required; // no aspect signal → keep the provider's claim
}

export type RubricAlignmentResult =
  { ok: true; keyPoints: RubricPoint[]; adjustments: string[] } | { ok: false; message: string };

/**
 * Normalize a proposed rubric into the persisted required/optional form.
 * `evidenceTexts` are the verified source-block contents backing the
 * question (primary grounding block plus verified extra evidence).
 */
export function alignRubricToQuestion(
  stem: string,
  proposed: readonly ProposedRubricPoint[],
  evidenceTexts: readonly string[],
): RubricAlignmentResult {
  const evidence = evidenceTexts.join('\n');
  const adjustments: string[] = [];
  const seen = new Set<string>();
  const keyPoints: RubricPoint[] = [];

  for (const point of proposed) {
    const text = point.text.trim();
    if (text.length === 0) continue;
    const dedupeKey = text.replace(/[\s,。!?;:、,.!?;:]/gu, '');
    if (seen.has(dedupeKey)) continue; // deduplicate normalized points
    seen.add(dedupeKey);

    let required = alignPointToStem(stem, { ...point, text });
    if (required !== point.required) {
      adjustments.push(
        required
          ? `要点「${text.slice(0, 40)}」被题干明确要求,已提升为必答要点。`
          : `要点「${text.slice(0, 40)}」未被题干要求,已降级为可补充要点。`,
      );
    }
    if (required && charCoverageRatio(text, evidence) < RUBRIC_GROUNDING_THRESHOLD) {
      required = false;
      adjustments.push(`要点「${text.slice(0, 40)}」缺少原文依据,已降级为可补充要点。`);
    }
    keyPoints.push({ text, required });
    if (keyPoints.length >= 6) break;
  }

  if (keyPoints.length === 0) {
    return { ok: false, message: '评分要点为空或全部重复,无法用于判分。' };
  }
  if (!keyPoints.some((p) => p.required)) {
    // Zero required weight cannot score anything. Repair by promoting the
    // grounded, non-evaluative points back to required (old semantics);
    // reject only if nothing qualifies.
    let promoted = 0;
    for (const point of keyPoints) {
      const evaluative = ASPECTS.some((a) => a.pointPattern.test(point.text));
      if (!evaluative && charCoverageRatio(point.text, evidence) >= RUBRIC_GROUNDING_THRESHOLD) {
        point.required = true;
        promoted++;
      }
    }
    if (promoted === 0) {
      return { ok: false, message: '评分要点没有任何有原文依据的必答项,无法判分。' };
    }
    adjustments.push('评分要点全部为可补充项,已把有原文依据的核心要点恢复为必答。');
  }
  return { ok: true, keyPoints, adjustments };
}
