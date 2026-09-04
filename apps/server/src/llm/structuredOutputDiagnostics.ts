import { createHash } from 'node:crypto';
import type { ZodIssue } from 'zod';
import type {
  ProviderNormalizationAction,
  ProviderRecoveryAction,
  StructuredOutputDiagnostic,
  StructuredOutputFailureCategory,
} from './provider.js';
import { classifyStructuredPreparationFailure } from './preparationRecovery.js';

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
  'application',
  'activity',
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
  'forwardBridge',
  'graphRelationIds',
  'groups',
  'hint',
  'hypothesis',
  'importance',
  'index',
  'informalCheck',
  'initial',
  'inputs',
  'items',
  'key',
  'kind',
  'learningIntent',
  'learningUnitKeys',
  'level',
  'modules',
  'misconception',
  'narrative',
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
  'scaffold',
  'segments',
  'semanticRelations',
  'sectionCount',
  'sourceAllocationFingerprint',
  'sourceEvidence',
  'sourceRefs',
  'sourceRegionIds',
  'sourceRegionRef',
  'slots',
  'structuralUnitIds',
  'summary',
  'synthesisGroups',
  'title',
  'text',
  'transfer',
  'units',
  'visualRefs',
  'whyNow',
  'workedProcess',
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
  'invalid_lesson_slot_content_shape',
  'invalid_or_duplicate_practice_options',
  'invalid_practice_content_shape',
  'invalid_region_order',
  'invalid_synthesis_boundary',
  'lesson_internal_alias_leak',
  'lesson_advisory_visual_authority_invalid',
  'lesson_attempted_local_authority_mutation',
  'lesson_choice_check_missing_options',
  'lesson_exact_source_slot_has_no_source',
  'lesson_planning_language_leak',
  'lesson_slot_content_not_objective_aligned',
  'lesson_slot_content_not_substantive',
  'lesson_slot_order_mismatch',
  'lesson_source_alias_outside_slot_authority',
  'lesson_source_location_trivia',
  'lesson_visual_alias_outside_slot_authority',
  'isolated_regions',
  'missing_material_representation',
  'missing_lesson_slot',
  'missing_lesson_narrative',
  'missing_focused_worked_interaction',
  'missing_planned_boundary_work',
  'missing_planned_learner_action',
  'missing_practice_slot',
  'missing_typed_semantic_relation',
  'missing_typed_worked_process',
  'missing_synthesis_boundary',
  'module_limit_exceeded',
  'near_duplicate_region_intent',
  'prerequisite_cycle',
  'prerequisite_degree_exceeded',
  'prerequisite_edge_limit_exceeded',
  'prerequisite_wrong_order',
  'practice_internal_alias_leak',
  'practice_advisory_visual_authority_invalid',
  'practice_application_missing_real_state_or_action',
  'practice_application_not_observable_in_surface',
  'practice_application_outside_planned_construct',
  'practice_application_relevance_uncertain',
  'practice_application_source_incompatible',
  'practice_apply_missing_typed_application',
  'practice_attempted_local_authority_mutation',
  'practice_capability_not_objective_aligned',
  'practice_content_not_substantive',
  'practice_exact_source_slot_has_no_source',
  'practice_feedback_not_contingent',
  'practice_planning_language_leak',
  'practice_promotes_construct',
  'practice_prompt_leaks_answer',
  'practice_prompt_quotes_answer_source',
  'practice_repeats_accepted_lesson',
  'practice_source_alias_outside_slot_authority',
  'practice_slot_order_mismatch',
  'practice_surface_not_objective_aligned',
  'practice_visual_alias_outside_slot_authority',
  'retry_surface_not_meaningfully_changed',
  'region_limit_exceeded',
  'region_set_or_order_mismatch',
  'required_objective_formal_authority_missing',
  'required_objective_parent_topic_mismatch',
  'required_target_apply_missing',
  'semantic_relation_not_objective_relevant',
  'semantic_relation_not_substantive',
  'semantic_relation_outside_slot_contract',
  'semantic_relation_source_incompatible',
  'semantically_redundant_lesson_slots',
  'semantically_redundant_practice_items',
  'source_allocation_concentration',
  'source_allocation_fingerprint_mismatch',
  'source_allocation_omitted',
  'unallocated_source_region',
  'unknown_anchor_option',
  'unknown_lesson_slot',
  'unknown_practice_slot',
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
  'unplanned_lesson_learner_action',
  'unplanned_worked_process',
  'worked_interaction_missing_required_structure',
  'worked_interaction_relevance_uncertain',
  'worked_interaction_transfer_not_changed',
  'worked_process_application_relevance_uncertain',
  'worked_process_has_no_real_transition',
  'worked_process_missing_application_decision',
  'worked_process_missing_interaction',
  'worked_process_missing_required_structure',
  'worked_process_relevance_uncertain',
  'worked_process_result_not_justified',
  'worked_process_source_incompatible',
]);

/**
 * Zod's own structural type vocabulary. `expected` and `received` are drawn from
 * this closed set for the codes that carry them, so they are safe to disclose and
 * to persist: they name a JSON shape and can never carry model-authored scalar
 * content, unknown key names, or source text. Anything outside the set (for
 * example a literal value on `invalid_literal`) is dropped.
 */
const ZOD_STRUCTURAL_TYPES = new Set([
  'array',
  'bigint',
  'boolean',
  'date',
  'float',
  'function',
  'integer',
  'map',
  'nan',
  'never',
  'null',
  'number',
  'object',
  'promise',
  'set',
  'string',
  'symbol',
  'undefined',
  'unknown',
  'void',
]);

/** Issues at or below this count are disclosed individually, exactly as before. */
const SCHEMA_ISSUE_DISCLOSURE_LIMIT = 10;
const MAX_DISCLOSED_ISSUE_CLASSES = 24;
const MAX_DISCLOSED_CLASS_INDEXES = 60;
const MAX_DISCLOSED_CLASS_PATHS = 6;
const MAX_SCHEMA_SUMMARY_CHARS = 8_000;

export function safeStructuralTypeTag(value: unknown): string | undefined {
  return typeof value === 'string' && ZOD_STRUCTURAL_TYPES.has(value) ? value : undefined;
}

function safePathSegments(issue: ZodIssue): string[] {
  return issue.path.map((part) =>
    typeof part === 'number' ? String(part) : safeStructuralKey(String(part)),
  );
}

interface SchemaIssueClass {
  shape: string;
  code: string;
  expected: string | undefined;
  received: string | undefined;
  /** Distinct values seen at each numeric position of the shape, in path order. */
  slots: Array<Set<number>>;
  paths: string[];
  occurrences: number;
  unknownKeyCount: number;
}

function classify(issues: readonly ZodIssue[]): SchemaIssueClass[] {
  const classes = new Map<string, SchemaIssueClass>();
  for (const issue of issues) {
    const segments = safePathSegments(issue);
    const numeric = issue.path
      .map((part, position) => ({ part, position }))
      .filter(
        (entry): entry is { part: number; position: number } => typeof entry.part === 'number',
      );
    const shape = segments
      .map((segment, position) => (typeof issue.path[position] === 'number' ? '{index}' : segment))
      .join('.');
    const expected = safeStructuralTypeTag((issue as { expected?: unknown }).expected);
    const received = safeStructuralTypeTag((issue as { received?: unknown }).received);
    const key = [issue.code, shape, expected ?? '-', received ?? '-'].join('|');
    const existing = classes.get(key);
    const bucket: SchemaIssueClass = existing ?? {
      shape,
      code: issue.code,
      expected,
      received,
      slots: numeric.map(() => new Set<number>()),
      paths: [],
      occurrences: 0,
      unknownKeyCount: 0,
    };
    numeric.forEach((entry, slot) => bucket.slots[slot]?.add(entry.part));
    bucket.occurrences += 1;
    if (bucket.paths.length < MAX_DISCLOSED_CLASS_PATHS + 1) bucket.paths.push(segments.join('.'));
    if (issue.code === 'unrecognized_keys') {
      bucket.unknownKeyCount += (issue as { keys?: readonly string[] }).keys?.length ?? 0;
    }
    if (!existing) classes.set(key, bucket);
  }
  return [...classes.values()];
}

function renderIndexes(values: Set<number>): string {
  const sorted = [...values].sort((a, b) => a - b);
  const shown = sorted.slice(0, MAX_DISCLOSED_CLASS_INDEXES);
  const remaining = sorted.length - shown.length;
  return `{${shown.join(',')}${remaining > 0 ? `,+${remaining} more` : ''}}`;
}

/**
 * Render one class as a single line naming every affected location. When exactly
 * one numeric position varies, the indexes are expanded inline so the complete
 * affected set stays visible in one line; otherwise concrete paths are listed so
 * a multi-index class is never described as a misleading cross product.
 */
function renderClass(bucket: SchemaIssueClass): string {
  const varying = bucket.slots.filter((slot) => slot.size > 1).length;
  let location: string;
  if (varying <= 1) {
    let slot = -1;
    location = bucket.shape
      .split('.')
      .map((segment) => {
        if (segment !== '{index}') return segment;
        slot += 1;
        const values = bucket.slots[slot];
        if (!values) return segment;
        return values.size === 1 ? String([...values][0]) : renderIndexes(values);
      })
      .join('.');
  } else {
    const shown = bucket.paths.slice(0, MAX_DISCLOSED_CLASS_PATHS);
    const remaining = bucket.occurrences - shown.length;
    location = `${shown.join(' / ')}${remaining > 0 ? ` / +${remaining} more` : ''}`;
  }
  const tags = [
    bucket.code,
    ...(bucket.expected ? [`expected ${bucket.expected}`] : []),
    ...(bucket.received ? [`received ${bucket.received}`] : []),
    ...(bucket.code === 'unrecognized_keys' ? [`${bucket.unknownKeyCount} unknown keys`] : []),
    `${bucket.occurrences} ${bucket.occurrences === 1 ? 'occurrence' : 'occurrences'}`,
  ].join(', ');
  return `${location}: ${tags}`;
}

export interface SchemaIssueDisclosure {
  summary: string;
  /** True when the summary is grouped by structural class rather than per issue. */
  grouped: boolean;
  /** True when every validation class present in the issue list is represented. */
  complete: boolean;
}

/**
 * Build the schema-failure text handed to a bounded repair turn.
 *
 * Small issue lists keep the historical per-issue rendering verbatim. Once one
 * systematic mistake produces more issues than can be listed individually, the
 * list is grouped by structural class so every class survives disclosure with its
 * complete affected-index set, its occurrence count, and its expected/received
 * structural tags. Silently truncating to the first N issues while instructing
 * the model to fix only what it was shown cannot converge, because the
 * undisclosed remainder is explicitly placed out of scope.
 *
 * Nothing model-authored is emitted: path segments run through the same safe-key
 * whitelist as persisted diagnostics, unknown key names are reduced to a count,
 * and only closed-vocabulary Zod type tags are named.
 */
export function summarizeSchemaIssuesForRepair(issues: readonly ZodIssue[]): SchemaIssueDisclosure {
  if (issues.length <= SCHEMA_ISSUE_DISCLOSURE_LIMIT) {
    return {
      summary: issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      grouped: false,
      complete: true,
    };
  }
  const classes = classify(issues);
  const disclosed = classes.slice(0, MAX_DISCLOSED_ISSUE_CLASSES);
  let complete = disclosed.length === classes.length;
  const lines: string[] = [];
  let length = 0;
  for (const bucket of disclosed) {
    const line = renderClass(bucket);
    if (length + line.length + 2 > MAX_SCHEMA_SUMMARY_CHARS) {
      complete = false;
      break;
    }
    lines.push(line);
    length += line.length + 2;
  }
  return { summary: lines.join('; '), grouped: true, complete };
}

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
  normalizationRan?: boolean | undefined;
  normalizationActions?: ProviderNormalizationAction[] | undefined;
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
  attemptKind: 'original' | 'repair' | 'retry';
  model: string;
  response: StructuredResponseMetadata;
  parse: StructuredParseMetadata;
  repairAction: StructuredOutputDiagnostic['repairAction'];
  recovery?:
    | {
        action: ProviderRecoveryAction;
        localized: boolean;
        immutableItemIds: string[];
        affectedItemIds: string[];
        affectedComponents: string[];
      }
    | undefined;
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
    // Closed-vocabulary Zod type tags only. They distinguish a missing required
    // array from a wrongly typed one, which a bare code cannot, and they can
    // never carry model-authored content.
    ...(safeStructuralTypeTag((issue as { expected?: unknown }).expected)
      ? { expected: safeStructuralTypeTag((issue as { expected?: unknown }).expected)! }
      : {}),
    ...(safeStructuralTypeTag((issue as { received?: unknown }).received)
      ? { received: safeStructuralTypeTag((issue as { received?: unknown }).received)! }
      : {}),
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
    ...(input.parse.failureCategory && input.recovery
      ? {
          preparationFailure: classifyStructuredPreparationFailure(
            input.parse.failureCategory,
            input.parse.semanticIssueCodes ?? [],
            input.parse.schemaIssues ?? [],
          ),
        }
      : {}),
    ...(input.recovery ? { recoveryAction: input.recovery.action } : {}),
    ...(input.parse.normalizationRan !== undefined
      ? { normalizationRan: input.parse.normalizationRan }
      : {}),
    ...(input.parse.normalizationActions
      ? { normalizationActions: input.parse.normalizationActions }
      : {}),
    ...(input.recovery
      ? {
          localizedRepair: input.recovery.localized,
          immutableItemIds: input.recovery.immutableItemIds,
          affectedItemIds: input.recovery.affectedItemIds,
          affectedComponents: input.recovery.affectedComponents,
        }
      : {}),
    structuralPreview,
  };
}
