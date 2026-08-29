import { createHash } from 'node:crypto';
import type { RejectedGenerationArtifact } from './rejectedArtifact.js';

/**
 * Tier-2 redacted evaluation case.
 *
 * A pure, deterministic, allowlist projection of a Tier-1 artifact. Every field
 * is named and copied explicitly, so learner text, source text, prompt content,
 * credentials, and the rejected candidate body are mechanically incapable of
 * reaching this shape: no object spreading, no key iteration over model data,
 * and no pass-through of arbitrary nested values.
 *
 * Tier 3 boundary: producing a case does NOT make it publishable. Default is
 * exclusion; publication requires a later explicit per-case opt-in that this
 * slice deliberately does not implement.
 */

/** Closed vocabulary of local failure classifications. */
const FAILURE_CATEGORIES = [
  'TRANSPORT_FAILURE',
  'EMPTY_RESPONSE',
  'JSON_PARSE_FAILURE',
  'SCHEMA_VALIDATION_FAILURE',
  'SEMANTIC_VALIDATION_FAILURE',
  'TRUNCATED_OUTPUT',
  'REPAIR_EXHAUSTED',
  'PROVIDER_FORMAT_INCOMPATIBILITY',
] as const;

/** Closed vocabulary of retained-candidate shapes. */
const REPRESENTATIONS = [
  'json',
  'json_truncated',
  'text',
  'text_truncated',
  'unserializable',
] as const;

/** Closed vocabulary of physical attempt kinds. */
const ATTEMPT_KINDS = ['original', 'repair', 'retry', 'fallback'] as const;

/**
 * Findings carry a code and, for schema issues, a path. Both are drawn from
 * local schema/validator vocabularies rather than model content, but a Zod path
 * can contain a model-authored key (`z.record`) and a message can quote model
 * text, so paths are bounded and messages are never projected.
 */
const MAX_PROJECTED_FINDINGS = 24;
const MAX_FINDING_TOKEN_CHARS = 80;
/** Local operation kinds observed in this repository top out well below this. */
const MAX_OPERATION_KIND_CHARS = 64;
const MAX_SCHEMA_NAME_CHARS = 64;
const MAX_LOCAL_ID_CHARS = 64;

/** Closed vocabulary of local validation gates. */
export type RejectedEvaluationCaseValidationKind = 'schema' | 'candidate';
export type RejectedEvaluationCaseFailureCategory = (typeof FAILURE_CATEGORIES)[number] | 'other';
export type RejectedEvaluationCaseRepresentation = (typeof REPRESENTATIONS)[number] | 'other';
export type RejectedEvaluationCaseAttemptKind = (typeof ATTEMPT_KINDS)[number] | 'other';

export interface RejectedEvaluationCaseFinding {
  kind: 'schema' | 'semantic';
  /** Local code, or `other` when outside the recognized bounded length. */
  code: string;
  /** Schema issue path only, bounded; absent for semantic findings. */
  path?: string;
}

export interface RejectedEvaluationCase {
  artifactId: string;
  logicalCallId: string;
  attemptId: string;
  attemptNumber: number;
  attemptKind: RejectedEvaluationCaseAttemptKind;
  operationKind: string;
  schemaName: string;
  createdAt: string;
  validationKind: RejectedEvaluationCaseValidationKind;
  failureCategory: RejectedEvaluationCaseFailureCategory;
  repairExhausted: boolean;
  /** Shape metadata about the retained candidate. Never its content. */
  candidateRepresentation: RejectedEvaluationCaseRepresentation;
  candidateBytes: number;
  candidateTruncated: boolean;
  candidateContentHash: string | null;
  findingCount: number;
  findings: RejectedEvaluationCaseFinding[];
  promptFingerprint: string | null;
  schemaFingerprint: string | null;
  policyFingerprint: string | null;
  sourceFingerprint: string | null;
  validationFingerprint: string | null;
  /** Tier-3 boundary marker: nothing is publishable without explicit opt-in. */
  publishable: false;
}

/** Admit a value only when it is a member of a closed vocabulary. */
function closedVocabulary<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: 'other',
): T | 'other' {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Replace an unrecognized token with a stable digest rather than passing it
 * through. Correlation across cases survives; content does not.
 */
function hashToken(kind: string, value: string): string {
  return `<${kind}:sha256:${createHash('sha256').update(value).digest('hex')}>`;
}

/**
 * Admit a value only when it matches the shape local code actually produces.
 *
 * Shapes are deliberately narrow — narrower than "identifier-ish" — because a
 * permissive alphabet admits credential-shaped strings. Anything off-shape is
 * hashed, so no unrecognized text is ever reproduced verbatim.
 */
function safeShapedToken(value: string, kind: string, shape: RegExp, maxChars: number): string {
  if (value.length === 0 || value.length > maxChars) return hashToken(kind, value);
  return shape.test(value) ? value : hashToken(kind, value);
}

/** Local operation kinds are lowercase snake_case. */
const OPERATION_KIND_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
/** Local schema names are unpunctuated PascalCase/lowercase identifiers. */
const SCHEMA_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/u;
/** Local ids are a lowercase prefix, an underscore, then an opaque suffix. */
const LOCAL_ID_SHAPE = /^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,48}$/u;
/** Zod issue codes are lowercase snake_case. */
const ISSUE_CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
/** Zod paths are dotted segments with optional numeric indexes. */
const ISSUE_PATH_SHAPE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/u;

/** Admit a hex digest only; any other shape is dropped entirely. */
function safeDigest(value: string | null): string | null {
  if (value === null) return null;
  return /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

/** Admit an ISO-8601 instant only; any other shape is dropped. */
function safeTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value) ? value : '';
}

/** Admit a bounded non-negative integer only. */
function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Project a Tier-1 artifact into a Tier-2 case.
 *
 * Pure and deterministic: identical input always yields identical output, and
 * the function reads only the named fields below.
 */
export function toRejectedEvaluationCase(
  artifact: RejectedGenerationArtifact,
): RejectedEvaluationCase {
  const findings: RejectedEvaluationCaseFinding[] = [];
  for (const finding of artifact.findings.slice(0, MAX_PROJECTED_FINDINGS)) {
    if (finding.kind === 'schema') {
      findings.push({
        kind: 'schema',
        code: safeShapedToken(
          String(finding.code),
          'code',
          ISSUE_CODE_SHAPE,
          MAX_FINDING_TOKEN_CHARS,
        ),
        path: safeShapedToken(
          String(finding.path),
          'path',
          ISSUE_PATH_SHAPE,
          MAX_FINDING_TOKEN_CHARS,
        ),
      });
    } else if (finding.kind === 'semantic') {
      findings.push({
        kind: 'semantic',
        code: safeShapedToken(
          String(finding.code),
          'code',
          ISSUE_CODE_SHAPE,
          MAX_FINDING_TOKEN_CHARS,
        ),
      });
    }
  }
  return {
    artifactId: safeShapedToken(artifact.id, 'id', LOCAL_ID_SHAPE, MAX_LOCAL_ID_CHARS),
    logicalCallId: safeShapedToken(
      artifact.logicalCallId,
      'id',
      LOCAL_ID_SHAPE,
      MAX_LOCAL_ID_CHARS,
    ),
    attemptId: safeShapedToken(artifact.attemptId, 'id', LOCAL_ID_SHAPE, MAX_LOCAL_ID_CHARS),
    attemptNumber: safeCount(artifact.attemptNumber),
    attemptKind: closedVocabulary(String(artifact.attemptKind), ATTEMPT_KINDS, 'other'),
    operationKind: safeShapedToken(
      artifact.operationKind,
      'operation',
      OPERATION_KIND_SHAPE,
      MAX_OPERATION_KIND_CHARS,
    ),
    schemaName: safeShapedToken(
      artifact.schemaName,
      'schema',
      SCHEMA_NAME_SHAPE,
      MAX_SCHEMA_NAME_CHARS,
    ),
    createdAt: safeTimestamp(String(artifact.createdAt)),
    validationKind: artifact.validationKind === 'candidate' ? 'candidate' : ('schema' as const),
    failureCategory: closedVocabulary(
      String(artifact.failureCategory),
      FAILURE_CATEGORIES,
      'other',
    ),
    repairExhausted: artifact.repairExhausted === true,
    candidateRepresentation: closedVocabulary(
      String(artifact.candidate.representation),
      REPRESENTATIONS,
      'other',
    ),
    candidateBytes: safeCount(artifact.candidate.bytes),
    candidateTruncated: artifact.candidate.truncated === true,
    candidateContentHash: safeDigest(artifact.candidate.contentHash),
    findingCount: safeCount(artifact.findings.length),
    findings,
    promptFingerprint: safeDigest(artifact.promptFingerprint),
    schemaFingerprint: safeDigest(artifact.schemaFingerprint),
    policyFingerprint: safeDigest(artifact.policyFingerprint),
    sourceFingerprint: safeDigest(artifact.sourceFingerprint),
    validationFingerprint: safeDigest(artifact.validationFingerprint),
    publishable: false,
  };
}
