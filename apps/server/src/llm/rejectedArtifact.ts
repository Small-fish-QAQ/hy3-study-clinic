import { createHash } from 'node:crypto';
import type { RejectedCandidateCapture, RejectedCandidateFinding } from './provider.js';

/**
 * Tier-1 local retained generation artifact.
 *
 * Serialization of a rejected model candidate for local diagnosis only. This
 * boundary is deliberately the ONLY place that keeps exact candidate content.
 *
 * SECURITY / SCOPE:
 * - local only; never returned by normal API responses; never auto-exported;
 * - observational: never learner-authoritative, never touches mastery or
 *   progression, and a failure here never alters generation;
 * - carries no credentials, no provider configuration, no request headers, and
 *   no raw prompt text (`promptFingerprint` is a digest, never content).
 */

/**
 * Ceiling on retained candidate bytes.
 *
 * Sized well above every observed provider payload so the Slice-2 question —
 * whether rejected worked-process candidates are sound paraphrase or genuinely
 * deficient — stays answerable from the retained body. When the ceiling does
 * bite, truncation is recorded explicitly and the content hash plus original
 * byte length are retained so the artifact never silently misrepresents itself.
 */
export const MAX_RETAINED_CANDIDATE_BYTES = 256 * 1024;

/** Depth ceiling guarding against deeply nested or self-referential candidates. */
const MAX_CANDIDATE_DEPTH = 64;

export type CandidateRepresentation =
  'json' | 'json_truncated' | 'text' | 'text_truncated' | 'unserializable';

export interface SerializedRejectedCandidate {
  representation: CandidateRepresentation;
  /** Exact retained candidate, or null when serialization was impossible. */
  body: string | null;
  /** Byte length of the candidate before any ceiling was applied. */
  bytes: number;
  truncated: boolean;
  /** sha256 of the full pre-truncation body; null when nothing was serialized. */
  contentHash: string | null;
}

export interface RejectedGenerationArtifactInput {
  logicalCallId: string;
  attemptId: string;
  attemptNumber: number;
  attemptKind: 'original' | 'repair' | 'retry' | 'fallback';
  operationKind: string;
  schemaName: string;
  createdAt: string;
  validationKind: 'schema' | 'candidate';
  failureCategory: string;
  repairExhausted: boolean;
  candidate: SerializedRejectedCandidate;
  findings: RejectedCandidateFinding[];
  promptFingerprint: string | null;
  schemaFingerprint: string | null;
  policyFingerprint: string | null;
  sourceFingerprint: string | null;
  validationFingerprint: string | null;
}

export interface RejectedGenerationArtifact extends RejectedGenerationArtifactInput {
  id: string;
}

/**
 * Detect binary content that would corrupt a text column or defeat diagnosis.
 * Lone surrogates and NUL bytes are the practical markers.
 */
function looksBinary(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Reject candidates whose nesting exceeds the depth ceiling. Cycles are caught
 * by `JSON.stringify` itself; this guards the non-cyclic-but-absurd case.
 */
function exceedsDepth(value: unknown, depth: number): boolean {
  if (depth > MAX_CANDIDATE_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((item) => exceedsDepth(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      exceedsDepth(item, depth + 1),
    );
  }
  return false;
}

function applyCeiling(
  body: string,
  exact: Extract<CandidateRepresentation, 'json' | 'text'>,
  truncatedForm: Extract<CandidateRepresentation, 'json_truncated' | 'text_truncated'>,
): SerializedRejectedCandidate {
  const bytes = Buffer.byteLength(body, 'utf8');
  const contentHash = createHash('sha256').update(body).digest('hex');
  if (bytes <= MAX_RETAINED_CANDIDATE_BYTES) {
    return { representation: exact, body, bytes, truncated: false, contentHash };
  }
  const retained = Buffer.from(body, 'utf8')
    .subarray(0, MAX_RETAINED_CANDIDATE_BYTES)
    .toString('utf8');
  return { representation: truncatedForm, body: retained, bytes, truncated: true, contentHash };
}

/**
 * Serialize the exact rejected candidate.
 *
 * Parsed JSON candidates are stringified verbatim; raw text candidates are kept
 * verbatim. Unserializable input (cyclic, binary, absurdly nested, non-finite)
 * degrades to a recorded `unserializable` marker rather than throwing, because
 * capture must never disturb the operation that produced it.
 */
export function serializeRejectedCandidate(
  candidate: unknown,
  isRawText: boolean,
): SerializedRejectedCandidate {
  const unserializable: SerializedRejectedCandidate = {
    representation: 'unserializable',
    body: null,
    bytes: 0,
    truncated: false,
    contentHash: null,
  };
  try {
    if (isRawText) {
      const text = typeof candidate === 'string' ? candidate : String(candidate);
      if (looksBinary(text)) return unserializable;
      return applyCeiling(text, 'text', 'text_truncated');
    }
    if (exceedsDepth(candidate, 0)) return unserializable;
    const json = JSON.stringify(candidate);
    if (typeof json !== 'string') return unserializable;
    if (looksBinary(json)) return unserializable;
    return applyCeiling(json, 'json', 'json_truncated');
  } catch {
    return unserializable;
  }
}

/** Assemble a Tier-1 artifact input from a provider capture plus local identity. */
export function buildRejectedArtifactInput(
  capture: RejectedCandidateCapture,
  identity: {
    logicalCallId: string;
    attemptId: string;
    operationKind: string;
    createdAt: string;
    schemaFingerprint: string | null;
    policyFingerprint: string | null;
    sourceFingerprint: string | null;
    validationFingerprint: string | null;
  },
): RejectedGenerationArtifactInput {
  return {
    logicalCallId: identity.logicalCallId,
    attemptId: identity.attemptId,
    attemptNumber: capture.attemptNumber,
    attemptKind: capture.attemptKind,
    operationKind: identity.operationKind,
    schemaName: capture.schemaName,
    createdAt: identity.createdAt,
    validationKind: capture.validationKind,
    failureCategory: capture.failureCategory,
    repairExhausted: capture.repairExhausted,
    candidate: serializeRejectedCandidate(capture.candidate, capture.candidateIsRawText),
    findings: capture.findings,
    promptFingerprint: capture.promptFingerprint,
    schemaFingerprint: identity.schemaFingerprint,
    policyFingerprint: identity.policyFingerprint,
    sourceFingerprint: identity.sourceFingerprint,
    validationFingerprint: identity.validationFingerprint,
  };
}
