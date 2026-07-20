import { z } from 'zod';
import { VerifiedGroundingSchema } from './material.js';

/**
 * Canonical cross-document concept alignment.
 *
 * Terminology used consistently across schema, server, and UI:
 * - source concept mention: an original per-document `Concept` row (never
 *   destroyed or rewritten by alignment);
 * - canonical workspace concept: the workspace-level identity one or more
 *   source concepts resolve to;
 * - membership: the link "source concept X belongs to canonical concept C";
 * - accepted alias: any distinct original member name of a canonical concept;
 * - alignment proposal: a candidate relation between two source concepts,
 *   generated locally or by Hy3, awaiting a local decision.
 *
 * Learner history (attempts, mistakes, mastery) stays keyed to SOURCE
 * concepts — canonical concepts are an alignment layer plus display identity,
 * never a second source of truth for learning state.
 */

/** Controlled alignment relations a proposal may carry. */
export const AlignmentRelationSchema = z.enum([
  'equivalent',
  'alias',
  'broader',
  'narrower',
  'related_but_distinct',
]);
export type AlignmentRelation = z.infer<typeof AlignmentRelationSchema>;

/** Relations whose acceptance merges the two concepts into one canonical. */
export const MERGING_ALIGNMENT_RELATIONS: readonly AlignmentRelation[] = ['equivalent', 'alias'];

/** Lifecycle of one alignment proposal. */
export const AlignmentProposalStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'kept_separate',
]);
export type AlignmentProposalStatus = z.infer<typeof AlignmentProposalStatusSchema>;

/** Where a proposal came from (deterministic local rule vs. Hy3). */
export const AlignmentOriginSchema = z.enum(['local_rule', 'provider']);
export type AlignmentOrigin = z.infer<typeof AlignmentOriginSchema>;

/** Optional BCP-47-ish language tag ('zh' | 'en' are the common values). */
export const AlignmentLanguageSchema = z.enum(['zh', 'en', 'mixed', 'unknown']);
export type AlignmentLanguage = z.infer<typeof AlignmentLanguageSchema>;

/** Upper bound on candidate pairs offered to the provider per request. */
export const MAX_ALIGNMENT_CANDIDATES = 30;
/** Upper bound on evidence records retained per proposal. */
export const MAX_ALIGNMENT_EVIDENCE = 2;

/** One canonical workspace concept. */
export const CanonicalConceptSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Learner-editable display name shown on the graph node. */
  displayName: z.string().min(1).max(80),
  /** Deterministic normalized key of the display name (see normalizeConceptKey). */
  normalizedKey: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CanonicalConcept = z.infer<typeof CanonicalConceptSchema>;

/** Membership of one source concept in a canonical concept. */
export const CanonicalMemberSchema = z.object({
  sourceConceptId: z.string().min(1),
  canonicalConceptId: z.string().min(1),
  /** The original extracted concept name (preserved verbatim). */
  originalName: z.string().min(1).max(80),
  /** Document the source concept was extracted from. */
  materialId: z.string().min(1),
  language: AlignmentLanguageSchema,
  /** Proposal that produced this membership; null for singleton baselines. */
  viaProposalId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type CanonicalMember = z.infer<typeof CanonicalMemberSchema>;

/** A locally-validated alignment proposal awaiting (or after) a decision. */
export const AlignmentProposalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceConceptId: z.string().min(1),
  targetConceptId: z.string().min(1),
  relation: AlignmentRelationSchema,
  /** Proposed canonical display name for merging relations. */
  proposedCanonicalName: z.string().min(1).max(80),
  /** Concise rationale (local rule text or validated model rationale). */
  rationale: z.string().min(1).max(500),
  /** Server-verified evidence quotes backing the proposal. */
  evidence: z.array(VerifiedGroundingSchema).max(MAX_ALIGNMENT_EVIDENCE),
  origin: AlignmentOriginSchema,
  status: AlignmentProposalStatusSchema,
  sourceLanguage: AlignmentLanguageSchema,
  targetLanguage: AlignmentLanguageSchema,
  provider: z.string().min(1).max(40),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});
export type AlignmentProposal = z.infer<typeof AlignmentProposalSchema>;

/** Canonical concept plus its members, as returned by the alignment API. */
export const CanonicalConceptViewSchema = CanonicalConceptSchema.extend({
  members: z.array(CanonicalMemberSchema).min(1),
  /** Distinct member names that differ from the display name. */
  aliases: z.array(z.string()).max(20),
  /** Distinct source documents backing this canonical concept. */
  materialIds: z.array(z.string()).min(1),
});
export type CanonicalConceptView = z.infer<typeof CanonicalConceptViewSchema>;

/** Runtime contract for PATCH …/canonical/:canonicalId (rename). */
export const RenameCanonicalConceptRequestSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, '规范概念名称不能为空。')
      .max(80, '规范概念名称不能超过 80 个字符。'),
  })
  .strict();
export type RenameCanonicalConceptRequest = z.infer<typeof RenameCanonicalConceptRequestSchema>;

/** Runtime contract for the accept-proposal request body. */
export const AcceptAlignmentRequestSchema = z
  .object({
    /** Optional learner-corrected canonical name (repairs malformed names). */
    canonicalName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type AcceptAlignmentRequest = z.infer<typeof AcceptAlignmentRequestSchema>;

/**
 * Deterministic normalized key used for exact-alias detection and candidate
 * generation. Rules (each covered by tests):
 * 1. Unicode NFKC normalization;
 * 2. case folding (lower case);
 * 3. removal of ALL whitespace and common CJK/ASCII punctuation;
 * 4. safe English plural folding on Latin-only keys of length >= 4:
 *    "…ies" → "…y", "…sses/shes/ches/xes/zes" → drop "es", otherwise a
 *    trailing "s" (but never "ss") is dropped — so "processes"/"process"
 *    and "concepts"/"concept" collide while "class" stays intact.
 *
 * The key intentionally ignores word boundaries so "Spaced repetition" and
 * "Spacedrepetition" collide — exactly the malformed-name case alignment
 * must repair. It performs NO translation: bilingual pairs never collide here
 * and always require review.
 */
export function normalizeConceptKey(name: string): string {
  const folded = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,。、,.;;::!!??\-–—_·•"'"'()()[\]【】《》<>/\\]+/gu, '');
  if (!/^[a-z0-9]+$/.test(folded) || folded.length < 4) return folded;
  if (folded.endsWith('ies') && folded.length >= 5) return `${folded.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z)es$/.test(folded)) return folded.slice(0, -2);
  if (folded.endsWith('s') && !folded.endsWith('ss')) return folded.slice(0, -1);
  return folded;
}

/** Deterministic language guess for a concept name (display metadata only). */
export function guessConceptLanguage(name: string): AlignmentLanguage {
  const hasCjk = /[一-鿿]/u.test(name);
  const hasLatin = /[a-zA-Z]/u.test(name);
  if (hasCjk && hasLatin) return 'mixed';
  if (hasCjk) return 'zh';
  if (hasLatin) return 'en';
  return 'unknown';
}
