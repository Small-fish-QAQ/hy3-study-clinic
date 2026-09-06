import { ApiErrorCode } from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import { ProviderError } from './errors.js';
import type {
  PreparationFailureClassification,
  ProviderCandidateNormalization,
  ProviderNormalizationActionCode,
  ProviderTargetedRepairScope,
  StructuredOutputFailureCategory,
} from './provider.js';

const INTERNAL_TEACHING_ALIAS = /\b(?:PR|O|S|L)[1-9][0-9]*\b/iu;

const MECHANICAL_EMPTY_ARRAY_FIELDS = new Set(['visualRefs', 'semanticRelations']);
const MECHANICAL_NULLABLE_FIELDS = new Set([
  'application',
  'expectedSignal',
  'forwardBridge',
  'workedProcess',
]);
const OPTIONAL_NULL_LESSON_COMPONENTS = new Set([
  'example',
  'contrast',
  'misconception',
  'informalCheck',
]);

type SchemaIssueLike = {
  path: Array<string | number> | string;
  code: string;
  received?: unknown;
};

export function containsInternalTeachingAlias(value: string): boolean {
  return INTERNAL_TEACHING_ALIAS.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaPath(issue: SchemaIssueLike): string {
  return Array.isArray(issue.path) ? issue.path.join('.') : issue.path;
}

/**
 * Stable preparation taxonomy used by provider diagnostics and terminal
 * operation records. It deliberately classifies missing immutable slots as a
 * structural failure even though they are discovered by input-aware candidate
 * validation after Zod parsing.
 */
export function classifyStructuredPreparationFailure(
  category: StructuredOutputFailureCategory,
  semanticCodes: readonly string[] = [],
  schemaIssues: readonly SchemaIssueLike[] = [],
): PreparationFailureClassification {
  if (category === 'TRANSPORT_FAILURE') {
    return { failureClass: 'TRANSPORT', failureCode: 'provider_connection_failure' };
  }
  if (category === 'TRUNCATED_OUTPUT') {
    return { failureClass: 'OUTPUT', failureCode: 'truncated_output' };
  }
  if (category === 'EMPTY_RESPONSE') {
    return { failureClass: 'OUTPUT', failureCode: 'empty_output' };
  }
  if (category === 'JSON_PARSE_FAILURE') {
    return { failureClass: 'OUTPUT', failureCode: 'malformed_json' };
  }
  if (category === 'PROVIDER_FORMAT_INCOMPATIBILITY') {
    return { failureClass: 'OUTPUT', failureCode: 'provider_format_incompatibility' };
  }

  if (
    semanticCodes.some((code) => code === 'missing_lesson_slot' || code === 'missing_practice_slot')
  ) {
    return { failureClass: 'STRUCTURAL', failureCode: 'missing_immutable_slot' };
  }
  if (category === 'SCHEMA_VALIDATION_FAILURE') {
    if (
      schemaIssues.some(
        (issue) =>
          issue.received === 'null' &&
          /(?:^|\.)(?:example|contrast|misconception|informalCheck)$/u.test(schemaPath(issue)),
      )
    ) {
      return { failureClass: 'STRUCTURAL', failureCode: 'invalid_optional_null' };
    }
    if (
      schemaIssues.some(
        (issue) =>
          issue.received === 'undefined' &&
          [...MECHANICAL_EMPTY_ARRAY_FIELDS, ...MECHANICAL_NULLABLE_FIELDS].some((field) =>
            schemaPath(issue).endsWith(`.${field}`),
          ),
      )
    ) {
      return { failureClass: 'STRUCTURAL', failureCode: 'missing_mechanical_field' };
    }
    return { failureClass: 'STRUCTURAL', failureCode: 'schema_invalid' };
  }

  if (semanticCodes.some((code) => code.includes('internal_alias_leak'))) {
    return { failureClass: 'SEMANTIC', failureCode: 'internal_alias_leak' };
  }
  if (
    semanticCodes.some(
      (code) =>
        code.includes('source_alias') ||
        code.includes('visual_alias') ||
        code.includes('source_incompatible') ||
        code.includes('authority'),
    )
  ) {
    return { failureClass: 'SEMANTIC', failureCode: 'provenance_violation' };
  }
  if (
    semanticCodes.some(
      (code) =>
        code.includes('repeats_accepted_lesson') ||
        code.includes('retry_surface') ||
        code.includes('prompt_leaks_answer') ||
        code.includes('prompt_quotes_answer_source'),
    )
  ) {
    return { failureClass: 'SEMANTIC', failureCode: 'practice_novelty_violation' };
  }
  return { failureClass: 'SEMANTIC', failureCode: 'pedagogy_hard_violation' };
}

export function classifyPreparationError(
  error: unknown,
  boundary: 'route' | 'lesson' | 'checkpoint' | 'practice' | 'assembly',
): PreparationFailureClassification {
  if (error instanceof ProviderError) {
    if (error.code === ApiErrorCode.RequestCancelled) {
      return { failureClass: 'STATE', failureCode: 'operation_cancelled' };
    }
    if (error.code === ApiErrorCode.ProviderTimeout) {
      return { failureClass: 'TRANSPORT', failureCode: 'provider_timeout' };
    }
    if (error.code === ApiErrorCode.ProviderError) {
      return error.technicalHttpStatus === undefined
        ? { failureClass: 'TRANSPORT', failureCode: 'provider_connection_failure' }
        : { failureClass: 'TRANSPORT', failureCode: 'provider_http_failure' };
    }
    const structured =
      isRecord(error.details) && isRecord(error.details.structuredFailure)
        ? error.details.structuredFailure
        : null;
    if (
      structured &&
      isRecord(structured.preparationFailure) &&
      typeof structured.preparationFailure.failureClass === 'string' &&
      typeof structured.preparationFailure.failureCode === 'string'
    ) {
      return structured.preparationFailure as unknown as PreparationFailureClassification;
    }
    const category = structured?.failureCategory;
    if (typeof category === 'string') {
      return classifyStructuredPreparationFailure(
        category as StructuredOutputFailureCategory,
        structured && Array.isArray(structured.semanticIssueCodes)
          ? structured.semanticIssueCodes.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
      );
    }
  }
  if (error instanceof AppError) {
    if (error.code === ApiErrorCode.RequestCancelled) {
      return { failureClass: 'STATE', failureCode: 'operation_cancelled' };
    }
    if (error.code === ApiErrorCode.VersionConflict) {
      if (boundary === 'route') {
        return { failureClass: 'STATE', failureCode: 'stale_operation' };
      }
      if (boundary === 'checkpoint') {
        return { failureClass: 'STATE', failureCode: 'checkpoint_conflict' };
      }
      return { failureClass: 'STATE', failureCode: 'fencing_version_conflict' };
    }
  }
  if (boundary === 'checkpoint') {
    return { failureClass: 'STATE', failureCode: 'checkpoint_conflict' };
  }
  return { failureClass: 'SEMANTIC', failureCode: 'pedagogy_hard_violation' };
}

class NormalizationRecorder {
  private readonly paths = new Map<ProviderNormalizationActionCode, string[]>();

  add(code: ProviderNormalizationActionCode, path: string): void {
    const existing = this.paths.get(code) ?? [];
    if (existing.length < 50) existing.push(path);
    this.paths.set(code, existing);
  }

  result(candidate: unknown): ProviderCandidateNormalization {
    return {
      candidate,
      actions: [...this.paths].map(([code, paths]) => ({ code, paths })),
    };
  }
}

function omitOptionalNull(
  value: Record<string, unknown>,
  key: string,
  path: string,
  recorder: NormalizationRecorder,
): void {
  if (value[key] !== null) return;
  delete value[key];
  recorder.add('optional_null_omitted', path);
}

function defaultEmptyArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  recorder: NormalizationRecorder,
): void {
  if (Object.hasOwn(value, key)) return;
  value[key] = [];
  recorder.add('empty_array_defaulted', path);
}

function defaultNull(
  value: Record<string, unknown>,
  key: string,
  path: string,
  recorder: NormalizationRecorder,
): void {
  if (Object.hasOwn(value, key)) return;
  value[key] = null;
  recorder.add('nullable_field_defaulted', path);
}

function removeUnsupportedMisconceptionMappings(
  options: unknown,
  path: string,
  recorder: NormalizationRecorder,
): void {
  if (!Array.isArray(options)) return;
  for (const [index, option] of options.entries()) {
    if (!isRecord(option) || !Object.hasOwn(option, 'misconception')) continue;
    delete option.misconception;
    recorder.add('unsupported_optional_mapping_removed', `${path}.${index}.misconception`);
  }
}

function normalizeWorkedInteraction(
  process: Record<string, unknown>,
  path: string,
  recorder: NormalizationRecorder,
): void {
  const interaction = process.interaction;
  if (!isRecord(interaction)) return;
  const activity = interaction.activity;
  if (isRecord(activity)) {
    for (const key of ['hint', 'scaffold', 'transfer'] as const) {
      if (!Object.hasOwn(interaction, key) && Object.hasOwn(activity, key)) {
        interaction[key] = activity[key];
        delete activity[key];
        recorder.add(
          'worked_interaction_fields_relocated',
          `${path}.interaction.activity.${key}->${path}.interaction.${key}`,
        );
      }
    }
    if (Array.isArray(activity.options) && typeof activity.correctOptionId === 'string') {
      for (const [index, option] of activity.options.entries()) {
        if (
          isRecord(option) &&
          option.id === activity.correctOptionId &&
          !Object.hasOwn(option, 'misconception')
        ) {
          option.misconception = null;
          recorder.add(
            'nullable_field_defaulted',
            `${path}.interaction.activity.options.${index}.misconception`,
          );
        }
      }
    }
  }
  for (const key of ['activity', 'scaffold', 'transfer'] as const) {
    if (isRecord(interaction[key])) {
      omitNullReasoningDeclarations(interaction[key], `${path}.interaction.${key}`, recorder);
    }
  }
  if (isRecord(interaction.scaffold)) {
    removeUnsupportedMisconceptionMappings(
      interaction.scaffold.options,
      `${path}.interaction.scaffold.options`,
      recorder,
    );
  }
  if (isRecord(interaction.transfer)) {
    removeUnsupportedMisconceptionMappings(
      interaction.transfer.options,
      `${path}.interaction.transfer.options`,
      recorder,
    );
  }
}

/**
 * Normalize only representation choices whose absent form has one unambiguous
 * meaning. Source refs, explanations, objectives, citations, worked steps,
 * feedback, answers, and misconception mappings for distractors are never
 * invented here.
 */
export function normalizeLessonPreparationCandidate(
  candidate: unknown,
): ProviderCandidateNormalization {
  const normalized = structuredClone(candidate);
  const recorder = new NormalizationRecorder();
  if (!isRecord(normalized)) return recorder.result(normalized);

  if (normalized.narrative === null) {
    delete normalized.narrative;
    recorder.add('optional_null_omitted', 'narrative');
  }
  if (isRecord(normalized.narrative)) {
    defaultNull(normalized.narrative, 'forwardBridge', 'narrative.forwardBridge', recorder);
  }
  if (!Array.isArray(normalized.slots)) return recorder.result(normalized);

  for (const [slotIndex, slot] of normalized.slots.entries()) {
    if (!isRecord(slot)) continue;
    const basePath = `slots.${slotIndex}`;
    defaultEmptyArray(slot, 'visualRefs', `${basePath}.visualRefs`, recorder);
    defaultEmptyArray(slot, 'semanticRelations', `${basePath}.semanticRelations`, recorder);
    defaultNull(slot, 'workedProcess', `${basePath}.workedProcess`, recorder);
    for (const key of OPTIONAL_NULL_LESSON_COMPONENTS) {
      omitOptionalNull(slot, key, `${basePath}.${key}`, recorder);
    }
    for (const key of ['example', 'contrast', 'misconception'] as const) {
      const component = slot[key];
      if (isRecord(component)) {
        defaultEmptyArray(component, 'visualRefs', `${basePath}.${key}.visualRefs`, recorder);
      }
    }
    if (isRecord(slot.informalCheck)) {
      omitNullReasoningDeclarations(slot.informalCheck, `${basePath}.informalCheck`, recorder);
      defaultNull(
        slot.informalCheck,
        'expectedSignal',
        `${basePath}.informalCheck.expectedSignal`,
        recorder,
      );
      removeUnsupportedMisconceptionMappings(
        slot.informalCheck.options,
        `${basePath}.informalCheck.options`,
        recorder,
      );
    }
    if (isRecord(slot.workedProcess)) {
      normalizeWorkedInteraction(slot.workedProcess, `${basePath}.workedProcess`, recorder);
    }
  }
  return recorder.result(normalized);
}

export function normalizePracticePreparationCandidate(
  candidate: unknown,
): ProviderCandidateNormalization {
  const normalized = structuredClone(candidate);
  const recorder = new NormalizationRecorder();
  if (!isRecord(normalized) || !Array.isArray(normalized.items)) {
    return recorder.result(normalized);
  }
  for (const [itemIndex, item] of normalized.items.entries()) {
    if (!isRecord(item)) continue;
    const basePath = `items.${itemIndex}`;
    defaultEmptyArray(item, 'visualRefs', `${basePath}.visualRefs`, recorder);
    defaultNull(item, 'application', `${basePath}.application`, recorder);
    for (const key of ['initial', 'retry'] as const) {
      if (isRecord(item[key]))
        omitNullReasoningDeclarations(item[key], `${basePath}.${key}`, recorder);
    }
  }
  return recorder.result(normalized);
}

function omitNullReasoningDeclarations(
  action: Record<string, unknown>,
  path: string,
  recorder: NormalizationRecorder,
): void {
  for (const key of [
    'reasoningOperation',
    'requiredInference',
    'decisiveCondition',
    'evidenceContrast',
  ] as const) {
    omitOptionalNull(action, key, `${path}.${key}`, recorder);
  }
}

/**
 * Copy replacement text only where the original string actually leaked an
 * internal alias. Object keys, array shape, identities, answers, source/visual
 * refs, and unrelated strings remain byte-for-byte from the first candidate.
 */
const LEARNER_TEXT_KEYS = new Set([
  'action',
  'capabilityTested',
  'changedCondition',
  'correctDebrief',
  'correction',
  'debrief',
  'explanation',
  'feedbackIfSelected',
  'forwardBridge',
  'hint',
  'hypothesis',
  'inputs',
  'learnerDecision',
  'pedagogicalReason',
  'prompt',
  'reason',
  'relevanceToObjective',
  'result',
  'resultingState',
  'ruleOrProcedure',
  'startingState',
  'summary',
  'text',
  'toProposition',
  'fromProposition',
  'whyNow',
  'whyResultFollows',
  'whyTempting',
  'expectedSignal',
  // This private field quotes a learner-visible fact and must track alias-only corrections.
  'evidence',
]);

function mergeAliasTextLeaves(previous: unknown, repaired: unknown, parentKey: string): unknown {
  if (typeof previous === 'string') {
    return LEARNER_TEXT_KEYS.has(parentKey) &&
      containsInternalTeachingAlias(previous) &&
      typeof repaired === 'string'
      ? repaired
      : previous;
  }
  if (Array.isArray(previous)) {
    if (!Array.isArray(repaired) || repaired.length !== previous.length) return previous;
    return previous.map((value, index) => mergeAliasTextLeaves(value, repaired[index], parentKey));
  }
  if (!isRecord(previous) || !isRecord(repaired)) return previous;
  const merged = Object.fromEntries(
    Object.entries(previous).map(([key, value]) => [
      key,
      mergeAliasTextLeaves(value, repaired[key], key),
    ]),
  );
  for (const [key, value] of Object.entries(repaired)) {
    if (!Object.hasOwn(previous, key)) merged[key] = value;
  }
  return merged;
}

export function mergeLocalizedAliasRepair(
  previous: unknown,
  repaired: unknown,
  collectionKey: 'slots' | 'items',
  identityKey: 'slotId' | 'practiceSlotId',
  scope: NonNullable<ProviderTargetedRepairScope['localizedTextRepair']>,
): unknown {
  if (!isRecord(previous) || !isRecord(repaired)) return previous;
  const mergedRoot: Record<string, unknown> = { ...previous };
  if (scope.rootNarrative && isRecord(previous.narrative) && isRecord(repaired.narrative)) {
    mergedRoot.narrative = mergeAliasTextLeaves(
      previous.narrative,
      repaired.narrative,
      'narrative',
    );
  }
  const previousItems = previous[collectionKey];
  const repairedItems = repaired[collectionKey];
  if (!Array.isArray(previousItems) || !Array.isArray(repairedItems)) return mergedRoot;
  const repairedById = new Map<string, Record<string, unknown>>();
  for (const item of repairedItems) {
    if (isRecord(item) && typeof item[identityKey] === 'string') {
      repairedById.set(item[identityKey] as string, item);
    }
  }
  const scopeById = new Map(scope.items.map((item) => [item.itemId, item.components]));
  const previousIds = new Set(
    previousItems.flatMap((item) =>
      isRecord(item) && typeof item[identityKey] === 'string' ? [item[identityKey] as string] : [],
    ),
  );
  const mergedItems = previousItems.map((item) => {
    if (!isRecord(item) || typeof item[identityKey] !== 'string') return item;
    const components = scopeById.get(item[identityKey] as string);
    const replacement = repairedById.get(item[identityKey] as string);
    if (!components || !replacement) return item;
    const merged = { ...item };
    for (const component of components) {
      if (!Object.hasOwn(item, component)) continue;
      merged[component] = mergeAliasTextLeaves(item[component], replacement[component], component);
    }
    for (const [key, value] of Object.entries(replacement)) {
      if (!Object.hasOwn(item, key)) merged[key] = value;
    }
    return merged;
  });
  for (const item of repairedItems) {
    const identity = isRecord(item) ? item[identityKey] : undefined;
    if (typeof identity !== 'string' || !previousIds.has(identity)) mergedItems.push(item);
  }
  mergedRoot[collectionKey] = mergedItems;
  return mergedRoot;
}
