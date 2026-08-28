import { createHash } from 'node:crypto';
import type { ZodIssue } from 'zod';
import type { StructuredOutputDiagnostic, StructuredOutputFailureCategory } from './provider.js';

const MAX_PREVIEW_DEPTH = 4;
const MAX_PREVIEW_KEYS = 12;
const MAX_PREVIEW_ITEMS = 3;
const MAX_TOP_LEVEL_KEYS = 30;
const MAX_UNKNOWN_KEY_TOKENS = 5;

// Only locally declared structured-output schema keys may be shown verbatim.
// Provider-controlled unknown keys are hashed so a malformed key cannot copy
// source or learner text into a diagnostic envelope.
const SAFE_STRUCTURAL_KEYS = new Set([
  'approximateScope',
  'anchorOptionId',
  'anchorOptionRefs',
  'anchorOptions',
  'authority',
  'blockCount',
  'capabilityTested',
  'canonicalConceptIds',
  'canonicalConceptName',
  'charCount',
  'conceptIds',
  'conceptName',
  'conceptSummary',
  'concepts',
  'construct',
  'contrast',
  'correctOptionRef',
  'correction',
  'courseMapId',
  'dependentRegionKey',
  'dependentRegionRef',
  'description',
  'explanation',
  'explanationAuthority',
  'evaluations',
  'evidence',
  'evidenceId',
  'example',
  'expectedSignal',
  'feedbackIfSelected',
  'formalOpportunities',
  'graphRelationIds',
  'groups',
  'hint',
  'hypothesis',
  'importance',
  'index',
  'informalCheck',
  'initial',
  'items',
  'key',
  'kind',
  'learningIntent',
  'learningUnitKeys',
  'level',
  'modules',
  'misconception',
  'name',
  'nextConnection',
  'nodes',
  'objectiveKeys',
  'objectiveRef',
  'objectiveRefs',
  'objectives',
  'optionRef',
  'options',
  'parentKey',
  'pedagogicalReason',
  'prerequisiteRegionKey',
  'prerequisiteRegionRef',
  'prerequisiteRef',
  'prerequisites',
  'prerequisiteUnitKeys',
  'practice',
  'prompt',
  'purpose',
  'quote',
  'readinessHint',
  'reason',
  'regionId',
  'regionKeys',
  'regionRefs',
  'regions',
  'retry',
  'segments',
  'sectionCount',
  'sourceAllocationFingerprint',
  'sourceEvidence',
  'sourceRefs',
  'sourceRegionIds',
  'sourceRegionRef',
  'structuralUnitIds',
  'summary',
  'synthesisGroups',
  'title',
  'text',
  'units',
  'visualRefs',
  'whyNow',
]);

const SAFE_SEMANTIC_CODES = new Set([
  'anchor_option_outside_region',
  'candidate_validation_failed',
  'canonical_anchor_outside_allocation',
  'concept_anchor_outside_allocation',
  'curriculum_candidate_invalid',
  'duplicate_prerequisite',
  'duplicate_region_intent',
  'duplicate_source_allocation',
  'duplicate_synthesis_group',
  'duplicate_synthesis_region',
  'external_candidate_validation_failed',
  'flat_hierarchy',
  'foreign_course_map',
  'invalid_module_order',
  'invalid_region_order',
  'invalid_synthesis_boundary',
  'isolated_regions',
  'missing_material_representation',
  'missing_synthesis_boundary',
  'module_limit_exceeded',
  'near_duplicate_region_intent',
  'prerequisite_cycle',
  'prerequisite_degree_exceeded',
  'prerequisite_edge_limit_exceeded',
  'prerequisite_wrong_order',
  'region_limit_exceeded',
  'region_set_or_order_mismatch',
  'required_objective_formal_authority_missing',
  'required_objective_parent_topic_mismatch',
  'required_target_apply_missing',
  'source_allocation_concentration',
  'source_allocation_fingerprint_mismatch',
  'source_allocation_omitted',
  'unallocated_source_region',
  'unknown_anchor_option',
  'unknown_canonical_anchor',
  'unknown_canonical_concept',
  'unknown_concept',
  'unknown_concept_anchor',
  'unknown_evidence',
  'unknown_prerequisite_region',
  'unknown_region',
  'unknown_source_region',
  'unknown_synthesis_region',
  'unsupported_region',
]);

export interface StructuredResponseMetadata {
  transportSuccess: boolean;
  httpStatus: number | null;
  responseBodyBytes: number | null;
  contentType: StructuredOutputDiagnostic['contentType'];
  contentBytes: number | null;
  contentFingerprint: string | null;
  finishReason: StructuredOutputDiagnostic['finishReason'];
  truncated: boolean;
  possiblyIncomplete: boolean;
}

export interface StructuredParseMetadata {
  jsonParseSuccess: boolean;
  jsonFormat: StructuredOutputDiagnostic['jsonFormat'];
  parsed: unknown;
  schemaIssues?: ZodIssue[] | undefined;
  semanticIssueCodes?: string[] | undefined;
  failureCategory: StructuredOutputFailureCategory | null;
}

function valueType(value: unknown): NonNullable<StructuredOutputDiagnostic['topLevelType']> {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

function hashToken(kind: 'key' | 'code', value: string): string {
  return `<${kind}:sha256:${createHash('sha256').update(value).digest('hex')}>`;
}

function safeStructuralKey(key: string): string {
  return SAFE_STRUCTURAL_KEYS.has(key) ? key : hashToken('key', key);
}

function safeSemanticCode(code: string): string {
  return SAFE_SEMANTIC_CODES.has(code) ? code : hashToken('code', code);
}

function preview(value: unknown, depth = 0): unknown {
  if (value === null) return '<null>';
  if (typeof value === 'string') return '<string>';
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value !== 'object') return `<${typeof value}>`;
  if (depth >= MAX_PREVIEW_DEPTH) return Array.isArray(value) ? '<array>' : '<object>';
  if (Array.isArray(value)) {
    return {
      $type: 'array',
      $length: value.length,
      $items: value.slice(0, MAX_PREVIEW_ITEMS).map((item) => preview(item, depth + 1)),
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_PREVIEW_KEYS)) {
    result[safeStructuralKey(key)] = preview(item, depth + 1);
  }
  if (entries.length > MAX_PREVIEW_KEYS) {
    result.$omittedKeys = entries.length - MAX_PREVIEW_KEYS;
  }
  return result;
}

export function contentShape(value: unknown): StructuredOutputDiagnostic['contentType'] {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'object') return 'object';
  return 'other';
}

export function safeFinishReason(value: unknown): StructuredOutputDiagnostic['finishReason'] {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'sensitive' ||
    value === 'content_filter' ||
    value === 'tool_calls' ||
    value === 'function_call'
  ) {
    return value;
  }
  return typeof value === 'string' ? 'unknown' : null;
}

export function buildStructuredOutputDiagnostic(input: {
  schemaName: string;
  operationType: string | null;
  attemptNumber: 1 | 2 | 3;
  attemptKind: 'original' | 'repair';
  model: string;
  response: StructuredResponseMetadata;
  parse: StructuredParseMetadata;
  repairAction: StructuredOutputDiagnostic['repairAction'];
}): StructuredOutputDiagnostic {
  const parsed = input.parse.jsonParseSuccess ? input.parse.parsed : undefined;
  const structuralPreview = parsed === undefined ? null : preview(parsed);
  const topLevelType = parsed === undefined ? null : valueType(parsed);
  const topLevelKeys =
    parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object'
      ? Object.keys(parsed as Record<string, unknown>)
          .slice(0, MAX_TOP_LEVEL_KEYS)
          .map(safeStructuralKey)
      : [];
  const schemaIssues = (input.parse.schemaIssues ?? []).slice(0, 20).map((issue) => ({
    path: issue.path
      .map((part) => (typeof part === 'number' ? String(part) : safeStructuralKey(part)))
      .join('.')
      .slice(0, 500),
    code: issue.code,
    // Unknown keys are model-authored, so only a bounded count and hashed
    // tokens are exposed. The names themselves are never persisted.
    ...(issue.code === 'unrecognized_keys'
      ? {
          unknownKeyCount: issue.keys.length,
          unknownKeyTokens: issue.keys
            .slice(0, MAX_UNKNOWN_KEY_TOKENS)
            .map((key) => hashToken('key', key)),
        }
      : {}),
  }));
  const semanticIssueCodes = [...new Set(input.parse.semanticIssueCodes ?? [])]
    .slice(0, 20)
    .map(safeSemanticCode);

  return {
    schemaName: input.schemaName,
    operationType: input.operationType,
    attemptNumber: input.attemptNumber,
    attemptKind: input.attemptKind,
    provider: 'hy3',
    model: input.model,
    ...input.response,
    contentFingerprint:
      structuralPreview === null
        ? null
        : `sha256:${createHash('sha256').update(JSON.stringify(structuralPreview)).digest('hex')}`,
    jsonParseSuccess: input.parse.jsonParseSuccess,
    jsonFormat: input.parse.jsonFormat,
    topLevelType,
    topLevelKeys,
    schemaIssueCount: input.parse.schemaIssues?.length ?? 0,
    schemaIssues,
    semanticIssueCodes,
    failureCategory: input.parse.failureCategory,
    repairAction: input.repairAction,
    structuralPreview,
  };
}
