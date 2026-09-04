import {
  AlignmentProposalPayloadSchema,
  AssessmentProposalPayloadSchema,
  FormalAssessmentProposalPayloadSchema,
  ConceptAnalysisPayloadSchema,
  ConceptLessonPayloadSchema,
  CourseMapProposalPayloadSchema,
  CurriculumDetailProposalPayloadSchema,
  CurriculumProposalPayloadSchema,
  GraphProposalPayloadSchema,
  GroupedStudyPlanProposalPayloadSchema,
  MisconceptionProposalPayloadSchema,
  MasteryChallengeProposalPayloadSchema,
  QuizGenerationPayloadSchema,
  RepairGenerationPayloadSchema,
  RemediationPlanProposalPayloadSchema,
  StudyPlanProposalPayloadSchema,
  TeachingBriefProposalPayloadSchema,
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthoritySemanticObjectiveProposalSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  ProposedPracticeSlotContentSchema,
  RubricGradeSchema,
  TeachingLessonSlotContentSchema,
  TutorStepPayloadSchema,
  TutorTurnPayloadSchema,
  type AlignmentProposalPayload,
  type AssessmentProposalPayload,
  type ConceptAnalysisPayload,
  type ConceptLessonPayload,
  type CourseMapProposalPayload,
  type CurriculumDetailProposalPayload,
  type ProviderAuthoredCurriculumProposal,
  type GraphProposalPayload,
  type GroupedStudyPlanProposalPayload,
  type MisconceptionProposalPayload,
  type MasteryChallengeProposalPayload,
  type QuizGenerationPayload,
  type RemediationPlanProposalPayload,
  type StudyPlanProposalPayload,
  type TeachingBriefProposalPayload,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type RubricGrade,
  type TutorStepPayload,
  type TutorTurnPayload,
  type VisualDescriptionPayload,
  type RepairGenerationPayload,
  type ObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticRepairProposal,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticRepairInput,
} from '@hy3-clinic/shared';
import { createHash } from 'node:crypto';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { ProviderError } from './errors.js';
import { extractJsonWithFormat, JsonExtractionError } from './json.js';
import {
  alignmentProposalMessages,
  assessmentProposalMessages,
  conceptAnalysisMessages,
  conceptLessonMessages,
  courseMapProposalMessages,
  CURRICULUM_NODE_KEY_PRESENCE_RULES,
  curriculumDetailProposalMessages,
  curriculumProposalMessages,
  graphProposalMessages,
  groupedStudyPlanProposalMessages,
  misconceptionProposalMessages,
  masteryChallengeProposalMessages,
  quizGenerationMessages,
  remediationMessages,
  remediationPlanMessages,
  shortAnswerGradingMessages,
  repairGenerationMessages,
  studyPlanProposalMessages,
  tutorStepMessages,
  tutorTurnMessages,
  teachingBriefMessages,
  lessonSlotContentMessages,
  practiceContentMessages,
  objectiveAuthoritySemanticEvaluationMessages,
  objectiveAuthoritySemanticRepairMessages,
  OBJECTIVE_AUTHORITY_SEMANTIC_CLOSED_KEY_RULES,
  OBJECTIVE_AUTHORITY_SEMANTIC_VOCABULARY_RULES,
  type ChatMessage,
} from './prompts.js';
import type {
  AlignmentProposalInput,
  AssessmentProposalInput,
  ConceptAnalysisInput,
  ConceptLessonInput,
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
  CurriculumProposalInput,
  GraphProposalInput,
  LlmProvider,
  MisconceptionProposalInput,
  MasteryChallengeProposalInput,
  ProviderCandidateFailureArtifact,
  ProviderCandidateNormalizer,
  ProviderCandidatePreprocessor,
  ProviderCallOptions,
  ProviderRecoveryAction,
  ProviderTargetedRepairScope,
  QuizGenerationInput,
  RejectedCandidateFinding,
  RemediationInput,
  RepairGenerationInput,
  RemediationPlanInput,
  ShortAnswerGradingInput,
  StudyPlanProposalInput,
  TeachingBriefGenerationInput,
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  VisualDescriptionInput,
  StructuredOutputDiagnostic,
  StructuredOutputFailureCategory,
  TutorStepInput,
  TutorTurnInput,
} from './provider.js';
import {
  mergeLocalizedAliasRepair,
  normalizeLessonPreparationCandidate,
  normalizePracticePreparationCandidate,
} from './preparationRecovery.js';
import {
  buildStructuredOutputDiagnostic,
  contentShape,
  safeFinishReason,
  summarizeSchemaIssuesForRepair,
  type SchemaIssueDisclosure,
  type StructuredParseMetadata,
  type StructuredResponseMetadata,
} from './structuredOutputDiagnostics.js';
import { detailedStudyPlanSchema, detailedStudyPlanScopeFromInput } from './studyPlanContract.js';

/** One rejected parse attempt: local validation refused the model candidate. */
interface TryParseFailure<T = unknown> {
  ok: false;
  error: string;
  /** Present only for schema failures whose issue list was summarized. */
  disclosure?: SchemaIssueDisclosure | undefined;
  reason: 'schema' | 'candidate';
  category: StructuredOutputFailureCategory;
  repairable: boolean;
  candidateFailure?: ProviderCandidateFailureArtifact | undefined;
  candidate?: T | undefined;
  targetedRepair?: ProviderTargetedRepairScope | undefined;
  parse: StructuredParseMetadata;
}

const REJECTED_FINDING_LIMIT = 50;
const REJECTED_FINDING_MESSAGE_LIMIT = 500;
const REJECTED_FINDING_PATH_LIMIT = 200;

/**
 * Project bounded local validation findings for one rejected candidate.
 *
 * Findings describe what local deterministic code objected to. Schema paths and
 * codes come from Zod; semantic codes come from the local candidate validator.
 */
function rejectedCandidateFindings(
  failure: TryParseFailure,
  diagnostic: StructuredOutputDiagnostic,
): RejectedCandidateFinding[] {
  const findings: RejectedCandidateFinding[] = [];
  if (diagnostic.preparationFailure) {
    findings.push({
      kind: 'recovery',
      ...diagnostic.preparationFailure,
      recoveryAction: diagnostic.recoveryAction ?? 'none',
      normalizationRan: diagnostic.normalizationRan ?? false,
      normalizationActions: diagnostic.normalizationActions ?? [],
      localized: diagnostic.localizedRepair ?? false,
      immutableItemIds: diagnostic.immutableItemIds ?? [],
      affectedItemIds: diagnostic.affectedItemIds ?? [],
      affectedComponents: diagnostic.affectedComponents ?? [],
    });
  }
  for (const issue of failure.parse.schemaIssues ?? []) {
    if (findings.length >= REJECTED_FINDING_LIMIT) break;
    findings.push({
      kind: 'schema',
      path: issue.path.join('.').slice(0, REJECTED_FINDING_PATH_LIMIT),
      code: String(issue.code).slice(0, REJECTED_FINDING_PATH_LIMIT),
      message: String(issue.message ?? '').slice(0, REJECTED_FINDING_MESSAGE_LIMIT),
    });
  }
  for (const code of failure.parse.semanticIssueCodes ?? []) {
    if (findings.length >= REJECTED_FINDING_LIMIT) break;
    findings.push({ kind: 'semantic', code: String(code).slice(0, REJECTED_FINDING_PATH_LIMIT) });
  }
  if (findings.length === 0) {
    findings.push({
      kind: 'semantic',
      code: failure.category,
      message: failure.error.slice(0, REJECTED_FINDING_MESSAGE_LIMIT),
    });
  }
  return findings;
}

/**
 * Digest the exact outbound message sequence of one physical provider attempt, so a
 * rejected candidate can be correlated with the request that produced it. Repair
 * attempts send a longer sequence than the original and therefore digest differently;
 * grouping the attempts of one logical call is owned by logical_call_id, not by this
 * digest. SECURITY: the digest never carries message content, and provider config,
 * base URL, headers, and credentials are not part of the input.
 */
function promptFingerprintOf(messages: ChatMessage[]): string {
  const digest = createHash('sha256');
  for (const message of messages) {
    // Length-prefix each part so no content can forge a field boundary.
    digest.update(`${message.role}:${message.content.length}:${message.content}`);
  }
  return digest.digest('hex');
}

export interface Hy3ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Observed Curriculum responses peaked at 10,962 tokens; retain bounded headroom. */
export const CURRICULUM_MAX_OUTPUT_TOKENS = 16_000;
export const COURSE_MAP_MAX_OUTPUT_TOKENS = 8_000;
/** Semantic evaluation hit the former 12,000-token cap; reuse the existing bounded Curriculum budget. */
export const OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS =
  CURRICULUM_MAX_OUTPUT_TOKENS;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ChatCompletionResult {
  content: string;
  response: StructuredResponseMetadata;
  /**
   * Digest of the message sequence this physical attempt actually sent. Null when no
   * rejected-candidate observer is attached, since nothing would consume it.
   */
  promptFingerprint: string | null;
  envelopeFailure?:
    | {
        category: 'PROVIDER_FORMAT_INCOMPATIBILITY';
        summary: string;
      }
    | undefined;
}

/**
 * Close the repair turn honestly.
 *
 * "Repair only these problems" is correct only while the disclosed list is the
 * whole list. When one systematic mistake is summarized by structural class, the
 * model must be told to fix every listed class at every occurrence and to
 * revalidate the entire output, otherwise the classes that were folded into a
 * count would be read as out of scope.
 */
function repairScopeInstruction(
  disclosure: SchemaIssueDisclosure | undefined,
  final: boolean,
): string[] {
  if (!disclosure?.grouped) {
    return [
      final
        ? '这是最后一次有界修复。请仅修复当前问题,重新输出符合要求的 JSON。仍然只输出 JSON,不要解释。'
        : '请仅修复这些问题,重新输出符合要求的 JSON。仍然只输出 JSON,不要解释。',
    ];
  }
  return [
    disclosure.complete
      ? '以上按结构类别归纳的清单已覆盖本次全部校验失败类别,没有被省略的类别。请修复其中每一个类别在输出中的每一次出现,不要只修复被点名的前几个位置。'
      : '以上清单已按结构类别归纳,但类别数量超出可披露上限,仍可能存在未列出的失败。请修复其中每一个类别在输出中的每一次出现,并同时修正任何其他不符合要求结构的地方。',
    '重新输出完整 JSON 前,请用原始要求的 JSON 结构重新校验整个输出:每个必需键都存在,每个必需数组都是 JSON 数组,没有键被省略或写成 null。',
    final ? '这是最后一次有界修复。仍然只输出 JSON,不要解释。' : '仍然只输出 JSON,不要解释。',
  ];
}

interface TargetedRepairCollection {
  collectionKey: 'slots' | 'items' | 'evaluations';
  identityKey: 'slotId' | 'practiceSlotId' | 'objectiveRef';
  itemSchema: ZodType<unknown, ZodTypeDef, unknown>;
}

function stripCapabilityRecoveryRefs(candidate: unknown): unknown {
  if (Array.isArray(candidate)) return candidate.map(stripCapabilityRecoveryRefs);
  if (!isRecord(candidate)) return candidate;
  return Object.fromEntries(
    Object.entries(candidate)
      .filter(([key]) => key !== 'capabilityRequirementRef' && key !== 'capabilityRequirementRefs')
      .map(([key, value]) => [key, stripCapabilityRecoveryRefs(value)]),
  );
}

function normalizeTargetedRepairScope(
  scope: ProviderTargetedRepairScope,
  collection: TargetedRepairCollection,
): ProviderTargetedRepairScope | null {
  const pattern =
    collection.collectionKey === 'slots'
      ? /^L[1-9][0-9]*$/u
      : collection.collectionKey === 'items'
        ? /^PR[1-9][0-9]*$/u
        : /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u;
  const limit =
    collection.collectionKey === 'slots' ? 24 : collection.collectionKey === 'items' ? 16 : 24;
  const invalidItemIds = [...new Set(scope.invalidItemIds)]
    .filter((id) => pattern.test(id))
    .slice(0, limit);
  if (invalidItemIds.length === 0) return null;
  const invalid = new Set(invalidItemIds);
  const allowedComponents =
    collection.collectionKey === 'slots'
      ? new Set([
          'explanation',
          'semanticRelations',
          'workedProcess',
          'example',
          'contrast',
          'misconception',
          'informalCheck',
        ])
      : collection.collectionKey === 'items'
        ? new Set(['capabilityTested', 'pedagogicalReason', 'initial', 'retry'])
        : new Set<string>();
  const localizedTextRepair = scope.localizedTextRepair
    ? {
        rootNarrative:
          collection.collectionKey === 'slots' && scope.localizedTextRepair.rootNarrative,
        items: scope.localizedTextRepair.items.flatMap((item) => {
          if (!invalid.has(item.itemId)) return [];
          const components = [...new Set(item.components)].filter((component) =>
            allowedComponents.has(component),
          );
          return components.length > 0 ? [{ itemId: item.itemId, components }] : [];
        }),
      }
    : undefined;
  return {
    invalidItemIds,
    ...(localizedTextRepair &&
    (localizedTextRepair.rootNarrative || localizedTextRepair.items.length > 0)
      ? { localizedTextRepair }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replace representation-only detail objective keys with deterministic local
 * identities before the strict detail schema or candidate validator sees them.
 *
 * Region identity and order come from the server-owned detail offer. Objective
 * order remains exactly as proposed. If the response does not preserve that
 * unambiguous unit structure, leave it untouched so the existing validators
 * fail closed instead of guessing a mapping.
 */
function normalizeCurriculumDetailObjectiveKeys(
  input: CurriculumDetailProposalInput,
  candidate: unknown,
): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.units)) return candidate;
  const expectedRegionIds = input.regions.map((region) => region.regionId);
  if (
    candidate.units.length !== expectedRegionIds.length ||
    new Set(expectedRegionIds).size !== expectedRegionIds.length
  ) {
    return candidate;
  }

  const alignedUnits: Array<{
    unit: Record<string, unknown>;
    objectives: Record<string, unknown>[];
    regionId: string;
  }> = [];
  for (const [unitIndex, value] of candidate.units.entries()) {
    const regionId = expectedRegionIds[unitIndex]!;
    if (!isRecord(value) || value.regionId !== regionId || !Array.isArray(value.objectives)) {
      return candidate;
    }
    const objectives: Record<string, unknown>[] = [];
    for (const objective of value.objectives) {
      if (!isRecord(objective)) return candidate;
      objectives.push(objective);
    }
    alignedUnits.push({ unit: value, objectives, regionId });
  }

  return {
    ...candidate,
    units: alignedUnits.map(({ unit, objectives, regionId }) => ({
      ...unit,
      objectives: objectives.map((objective, objectiveIndex) => ({
        ...objective,
        key: `detail-objective-${regionId}-${objectiveIndex + 1}`,
      })),
    })),
  };
}

function curriculumDetailCandidatePreprocessor(
  input: CurriculumDetailProposalInput,
): ProviderCandidatePreprocessor {
  const stripUnsolicitedRecoveryRefs = !input.regions.some(
    (region) => (region.capabilityRequirements?.length ?? 0) > 0,
  );
  return (candidate) =>
    normalizeCurriculumDetailObjectiveKeys(
      input,
      stripUnsolicitedRecoveryRefs ? stripCapabilityRecoveryRefs(candidate) : candidate,
    );
}

/**
 * Recover stable, individually valid peers from a schema-invalid collection.
 * This is intentionally narrower than permissive root parsing: every item
 * must still expose one unique well-formed local identity, and at least one
 * peer must already pass its complete item schema. Otherwise repair falls
 * back to the ordinary full-response boundary.
 */
function schemaTargetedRepairBase(
  parsed: unknown,
  collection: TargetedRepairCollection,
): { candidate: unknown; scope: ProviderTargetedRepairScope } | null {
  if (!isRecord(parsed)) return null;
  const items = parsed[collection.collectionKey];
  if (!Array.isArray(items) || items.length < 2) return null;
  const pattern =
    collection.collectionKey === 'slots'
      ? /^L[1-9][0-9]*$/u
      : collection.collectionKey === 'items'
        ? /^PR[1-9][0-9]*$/u
        : /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u;
  const seen = new Set<string>();
  const invalidItemIds: string[] = [];
  let validItemCount = 0;
  for (const item of items) {
    if (!isRecord(item)) return null;
    const identity = item[collection.identityKey];
    if (typeof identity !== 'string' || !pattern.test(identity) || seen.has(identity)) return null;
    seen.add(identity);
    if (collection.itemSchema.safeParse(item).success) validItemCount += 1;
    else invalidItemIds.push(identity);
  }
  if (validItemCount === 0 || invalidItemIds.length === 0) return null;
  return { candidate: parsed, scope: { invalidItemIds } };
}

/**
 * Keep every valid first-pass compositional item byte-for-byte stable while
 * accepting replacements only for locally identified failures. Unknown
 * repaired identities are retained so the candidate validator can reject
 * them instead of silently dropping a provider authority escape.
 */
function mergeTargetedRepairCandidate(
  previous: unknown,
  repaired: unknown,
  collection: TargetedRepairCollection,
  scope: ProviderTargetedRepairScope,
): unknown {
  if (
    scope.localizedTextRepair &&
    (collection.collectionKey === 'slots' || collection.collectionKey === 'items') &&
    (collection.identityKey === 'slotId' || collection.identityKey === 'practiceSlotId')
  ) {
    return mergeLocalizedAliasRepair(
      previous,
      repaired,
      collection.collectionKey,
      collection.identityKey,
      scope.localizedTextRepair,
    );
  }
  if (!isRecord(previous) || !isRecord(repaired)) return repaired;
  const previousItems = previous[collection.collectionKey];
  const repairedItems = repaired[collection.collectionKey];
  if (!Array.isArray(previousItems) || !Array.isArray(repairedItems)) return repaired;
  const invalidIds = new Set(scope.invalidItemIds);
  const repairedById = new Map<string, unknown>();
  for (const item of repairedItems) {
    if (!isRecord(item)) continue;
    const itemId = item[collection.identityKey];
    if (typeof itemId !== 'string') continue;
    repairedById.set(itemId, item);
  }
  const previousIds = new Set<string>();
  const merged = previousItems.flatMap((item) => {
    if (!isRecord(item)) return [item];
    const id = item[collection.identityKey];
    if (typeof id !== 'string') return [item];
    previousIds.add(id);
    if (!invalidIds.has(id)) return [item];
    const replacement = repairedById.get(id);
    return replacement === undefined ? [] : [replacement];
  });
  for (const item of repairedItems) {
    const itemId = isRecord(item) ? item[collection.identityKey] : undefined;
    if (typeof itemId !== 'string' || !previousIds.has(itemId)) {
      merged.push(item);
    }
  }
  // Targeted repairs may intentionally return only the repaired collection.
  // Preserve immutable whole-response fields (for example the Lesson narrative)
  // unless the repair explicitly supplies a replacement.
  return { ...previous, ...repaired, [collection.collectionKey]: merged };
}

function recoveryScopeDiagnostic(
  scope: ProviderTargetedRepairScope | undefined,
  immutableItemIds: string[],
  action: ProviderRecoveryAction,
) {
  const localized = scope?.localizedTextRepair;
  return {
    action,
    localized: Boolean(localized),
    immutableItemIds,
    affectedItemIds: scope?.invalidItemIds ?? [],
    affectedComponents: localized
      ? [
          ...(localized.rootNarrative ? ['narrative'] : []),
          ...localized.items.flatMap((item) =>
            item.components.map((component) => `${item.itemId}.${component}`),
          ),
        ]
      : [],
  };
}

function selectRecoveryAction(
  failure: TryParseFailure,
  scope: ProviderTargetedRepairScope | undefined,
): ProviderRecoveryAction {
  if (!failure.repairable) return 'none';
  if (failure.category === 'TRUNCATED_OUTPUT' || failure.category === 'EMPTY_RESPONSE') {
    return 'clean_regeneration';
  }
  if (scope?.localizedTextRepair) return 'localized_alias_repair';
  if (scope) return 'targeted_repair';
  return 'structured_repair';
}

function immutableInventoryInstruction(
  ids: readonly string[],
  partialReplacementAllowed = false,
): string[] {
  return ids.length > 0
    ? [
        partialReplacementAllowed
          ? `Immutable final item inventory and exact order: ${ids.join(', ')}. Local reassembly preserves every frozen peer; return only the named replacement identities. Never add, rename, combine, split, or reorder the final inventory.`
          : `Immutable item inventory and exact order: ${ids.join(', ')}. Every identity must remain present exactly once; do not add, remove, rename, combine, split, or reorder identities.`,
      ]
    : [];
}

function localizedRepairInstruction(scope: ProviderTargetedRepairScope | undefined): string[] {
  const localized = scope?.localizedTextRepair;
  if (!localized) return [];
  const components = [
    ...(localized.rootNarrative ? ['narrative'] : []),
    ...localized.items.flatMap((item) =>
      item.components.map((component) => `${item.itemId}.${component}`),
    ),
  ];
  return [
    `Localized learner-text repair components: ${components.join(', ')}. Rewrite only learner-facing strings that expose an internal alias. Preserve all sourceRefs, visualRefs, identities, option identities, correct answers, object/array shape, and every unrelated string; local code will ignore all other changes.`,
  ];
}

const GROUPED_STUDY_PLAN_KINDS = [
  'teach_unit',
  'informal_check',
  'formal_checkpoint',
  'targeted_repair',
  'due_review',
] as const;

function groupedStudyPlanSchema(
  input: StudyPlanProposalInput,
): ZodType<GroupedStudyPlanProposalPayload, ZodTypeDef, unknown> {
  const requiredIds = new Set(input.requiredLearningUnitIds);
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  const capabilitiesById = new Map(
    input.launchCapabilities.map((capability) => [capability.curriculumLearningUnitId, capability]),
  );
  return GroupedStudyPlanProposalPayloadSchema.superRefine((payload, ctx) => {
    const accounted = new Set<string>();
    const placed = new Set<string>();
    for (const [groupIndex, group] of payload.groups.entries()) {
      if (!input.allowedDepths.includes(group.targetDepth)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', groupIndex, 'targetDepth'],
          message: `unavailable depth; allowed values: ${input.allowedDepths.join(', ')}`,
        });
      }
      for (const [unitIndex, unitId] of group.curriculumLearningUnitIds.entries()) {
        const unit = unitsById.get(unitId);
        const path = ['groups', groupIndex, 'curriculumLearningUnitIds', unitIndex];
        if (!unit || !requiredIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `unknown or non-required LearningUnit: ${unitId}`,
          });
          continue;
        }
        const allowedKinds = capabilitiesById
          .get(unitId)
          ?.allowedItemKinds.filter((kind) =>
            GROUPED_STUDY_PLAN_KINDS.includes(kind as (typeof GROUPED_STUDY_PLAN_KINDS)[number]),
          );
        if (!allowedKinds?.includes(group.kind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['groups', groupIndex, 'kind'],
            message:
              allowedKinds && allowedKinds.length > 0
                ? `${group.kind} is unavailable for LearningUnit ${unitId}; allowed values: ${allowedKinds.join(', ')}`
                : `${group.kind} is unavailable for LearningUnit ${unitId}; allowed values: none, defer this unit`,
          });
        }
        const missingPrerequisite = unit.prerequisiteUnitIds.find(
          (prerequisiteId) => requiredIds.has(prerequisiteId) && !placed.has(prerequisiteId),
        );
        if (missingPrerequisite) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `prerequisite ${missingPrerequisite} must appear earlier`,
          });
        }
        placed.add(unitId);
        accounted.add(unitId);
      }
    }
    for (const [deferralIndex, deferral] of payload.deferrals.entries()) {
      if (!input.contract.allowExplicitDeferral) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deferrals', deferralIndex],
          message: 'deferrals are not allowed by the Contract',
        });
      }
      for (const [unitIndex, unitId] of deferral.curriculumLearningUnitIds.entries()) {
        if (!unitsById.has(unitId) || !requiredIds.has(unitId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deferrals', deferralIndex, 'curriculumLearningUnitIds', unitIndex],
            message: `unknown or non-required LearningUnit: ${unitId}`,
          });
          continue;
        }
        accounted.add(unitId);
      }
    }
    for (const unitId of input.requiredLearningUnitIds) {
      if (!accounted.has(unitId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups'],
          message: `required LearningUnit is omitted: ${unitId}`,
        });
      }
    }
  });
}

function studyPlanRepairGuidance(input: StudyPlanProposalInput, grouped: boolean): string {
  const supported: ReadonlyArray<StudyPlanProposalInput['allowedItemKinds'][number]> = grouped
    ? GROUPED_STUDY_PLAN_KINDS
    : [
        'teach_unit',
        'informal_check',
        'formal_checkpoint',
        'synthesis',
        'targeted_repair',
        'due_review',
      ];
  const offered = supported.filter((kind) => input.allowedItemKinds.includes(kind));
  return [
    `Allowed kind literals for this request: ${offered.join(', ')}.`,
    'A kind is valid for an item or group only when the exact literal appears in every referenced LearningUnit allowedItemKinds list.',
    input.contract.allowExplicitDeferral
      ? 'A LearningUnit with no allowed kind must be moved to deferrals.'
      : 'Deferrals are forbidden; every LearningUnit must use an explicitly allowed kind.',
    'Never invent, combine, translate, or paraphrase a kind literal. Preserve every otherwise-valid field and exact supplied ID.',
  ].join('\n');
}

/**
 * OpenAI-compatible HTTP adapter for Hy3.
 *
 * Not tied to any specific commercial endpoint — baseUrl/model/key all come
 * from server-side env config. Enforces per-call timeout + external
 * cancellation, extracts JSON safely, validates with Zod, and grants exactly
 * fixed, independent schema/candidate repair budgets before failing with a
 * structured ProviderError.
 * The API key is only ever sent in the Authorization header; it is never
 * logged or included in any thrown message.
 */
export class Hy3Provider implements LlmProvider {
  readonly name = 'hy3' as const;
  get model(): string {
    return this.config.model;
  }
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: Hy3ProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Deliberate, minimal connectivity probe used only by Settings. */
  async testConnection(opts?: ProviderCallOptions): Promise<void> {
    const result = await this.chat(
      [
        { role: 'system', content: '只回复 OK。不要调用工具,不要生成学习内容。' },
        { role: 'user', content: 'OK' },
      ],
      { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 15_000, 15_000) },
      { temperature: 0, maxTokens: 1 },
    );
    if (result.envelopeFailure) {
      throw ProviderError.invalidOutput(
        result.envelopeFailure.summary,
        undefined,
        result.envelopeFailure.category,
      );
    }
    if (result.content.trim().length === 0) {
      throw ProviderError.invalidOutput('响应缺少 message.content。', undefined, 'EMPTY_RESPONSE');
    }
  }

  async describeVisual(
    _input: VisualDescriptionInput,
    opts?: ProviderCallOptions,
  ): Promise<VisualDescriptionPayload> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    // Hy3 is the text-only language/pedagogy provider. Visual requests use the
    // separately configured documented TokenHub vision adapter.
    throw ProviderError.invalidOutput(
      'Hy3 visual input transport is not configured.',
      undefined,
      'PROVIDER_FORMAT_INCOMPATIBILITY',
    );
  }

  async analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload> {
    return this.complete(
      conceptAnalysisMessages(input.materialTitle, input.blocks, {
        ...(input.sectionTitle !== undefined ? { sectionTitle: input.sectionTitle } : {}),
        ...(input.maxConcepts !== undefined ? { maxConcepts: input.maxConcepts } : {}),
      }),
      ConceptAnalysisPayloadSchema,
      opts,
    );
  }

  async generateQuiz(
    input: QuizGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    return this.complete(
      quizGenerationMessages(input.materialTitle, input.blocks, input.concepts, input.config),
      QuizGenerationPayloadSchema,
      opts,
    );
  }

  async gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade> {
    return this.complete(
      shortAnswerGradingMessages(
        input.stem,
        input.expectedAnswer,
        input.rubricKeyPoints,
        input.quote,
        input.answerText,
      ),
      RubricGradeSchema,
      opts,
    );
  }

  async generateRemediation(
    input: RemediationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    return this.complete(
      remediationMessages(
        input.materialTitle,
        input.blocks,
        input.targets,
        input.questionsPerConcept,
      ),
      QuizGenerationPayloadSchema,
      opts,
    );
  }

  async generateRepair(
    input: RepairGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<RepairGenerationPayload> {
    return this.complete(
      repairGenerationMessages(input),
      RepairGenerationPayloadSchema,
      opts,
      [
        `本地契约要求 diagnosticCategory=${input.diagnosticCategory}、interventionMode=${input.requiredInterventionMode} 且 checkIntent=${input.requiredCheckIntent}；这三个值不可更改。`,
        `请保持 interventionMode=${input.requiredInterventionMode}，不要将其替换为 TARGETED_PROMPT 或任何其他模式；只修复校验报告中的字段。`,
        '如果校验报告指出讲解策略、考查意图或检查题与之前重复，请真正改变对应内容本身，而不是改写措辞：换教学动作、换考查方式、换检查任务。',
        '保留已经有效的源约束和教学内容，仅提供一个最小充分、不可授予正式学分的修复步骤。',
      ].join('\n'),
    );
  }

  async proposeGraphEdges(
    input: GraphProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<GraphProposalPayload> {
    return this.complete(
      graphProposalMessages(input.workspaceName, input.blocks, input.concepts, input.maxEdges),
      GraphProposalPayloadSchema,
      opts,
    );
  }

  async proposeRemediationPlan(
    input: RemediationPlanInput,
    opts?: ProviderCallOptions,
  ): Promise<RemediationPlanProposalPayload> {
    return this.complete(
      remediationPlanMessages(input),
      RemediationPlanProposalPayloadSchema,
      opts,
    );
  }

  async proposeConceptAlignment(
    input: AlignmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AlignmentProposalPayload> {
    return this.complete(alignmentProposalMessages(input), AlignmentProposalPayloadSchema, opts);
  }

  async proposeAssessment(
    input: AssessmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AssessmentProposalPayload> {
    return this.complete(
      assessmentProposalMessages(input),
      input.objectiveCatalogue?.length
        ? FormalAssessmentProposalPayloadSchema
        : AssessmentProposalPayloadSchema,
      opts,
    );
  }

  async proposeMasteryChallenges(
    input: MasteryChallengeProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MasteryChallengeProposalPayload> {
    return this.complete(
      masteryChallengeProposalMessages(input),
      MasteryChallengeProposalPayloadSchema,
      opts,
      [
        `Keep exactly three distinct candidates and preserve selectedFamily=${input.selectedFamily}.`,
        'Use only the offered O* and S* aliases. Bind every required claim and learner-visible premise to offered sources.',
        'Remove external knowledge, hidden premises, ambiguity, undefined terms, answer leakage, and overlap with prior prompts.',
      ].join('\n'),
    );
  }

  async proposeMisconception(
    input: MisconceptionProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MisconceptionProposalPayload> {
    return this.complete(
      misconceptionProposalMessages(input),
      MisconceptionProposalPayloadSchema,
      opts,
    );
  }

  async generateConceptLesson(
    input: ConceptLessonInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptLessonPayload> {
    return this.complete(conceptLessonMessages(input), ConceptLessonPayloadSchema, opts);
  }

  async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<TeachingBriefProposalPayload> {
    return this.complete(
      teachingBriefMessages(input),
      TeachingBriefProposalPayloadSchema,
      opts,
      'Repair only the cited Lesson/Practice failures. Every segments item must retain purpose, objectiveRefs, explanation, explanationAuthority, and sourceRefs; example, contrast, misconception, and informalCheck are the only optional nested segment components. Always include nextConnection as a string or JSON null. Use offered O*, P*, and S* aliases; preserve exact construct/authorizedObjectiveRefs boundaries; add real reasoning and learner action rather than padding; replace source-location trivia; make the retry a changed context. For each apply failure, rewrite the initial and retry prompts as a concrete source-stated state-to-action decision: name the given state or completed steps, ask which next step/action follows or which bounded step is missing, and make the options represent distinct procedural decisions. Do not merely repeat the procedure name or definition. Return the full corrected object.',
      { maxTokens: 12_000, schemaName: 'teaching-brief-proposal-v2-pedagogy-practice' },
    );
  }

  async generateLessonSlotContent(
    input: LessonSlotContentGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<LessonSlotContentProposalPayload> {
    return this.complete(
      lessonSlotContentMessages(input),
      LessonSlotContentProposalPayloadSchema,
      opts,
      [
        'Repair only locally identified L* slots. Every other first-pass slot is frozen and cannot be changed, deleted, or reordered.',
        'Preserve the whole-Lesson narrative unless a diagnostic explicitly identifies it. Return only slotId plus bounded content fields for repaired slots. Never output objective refs, construct, role, duration, protection, authority mode, Practice, Formal Evidence, mastery, or progression.',
        'Use only the slot-specific offered S*/V* aliases. A semantic relation needs two distinct propositions and objective relevance; keywords alone never prove reasoning.',
        'For a worked-process failure, provide a concrete starting state, transitions with reasons, result, and why it follows. Cite an offered source only for source-backed claims; supplementary worked cases keep sourceRefs empty. If the repaired slot has learnerActionRequired=true, also provide an aligned pre-guidance informalCheck that requires the learner to decide/predict/act before any explanation. choose_alternative checks require structured choices and one correct option. Do not substitute a label or generic checklist.',
        'Remove internal aliases and planning vocabulary from every learner-visible string. Citations belong only in structured sourceRefs/visualRefs arrays, never in prose as O1/S1/L1/PR1-style or parenthetical aliases. Write as the same coherent teacher voice as the frozen Lesson.',
        'Return a slots object containing only replacements for the named invalid L* identities. Local code will reassemble it with every frozen valid slot exactly.',
      ].join('\n'),
      {
        maxTokens: 10_000,
        schemaName: 'lesson-slot-content-v2-teacher-narrative',
        candidateNormalizer: normalizeLessonPreparationCandidate,
        immutableItemIds: input.skeleton.lessonSlots.map((slot) => slot.slotId),
        targetedRepairCollection: {
          collectionKey: 'slots',
          identityKey: 'slotId',
          itemSchema: TeachingLessonSlotContentSchema,
        },
        allowIndependentRepair: false,
        allowLocalizedAliasRepairAfterStructuralRepair: true,
      },
    );
  }

  async generatePracticeContent(
    input: PracticeContentGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<PracticeContentProposalPayload> {
    return this.complete(
      practiceContentMessages(input),
      PracticeContentProposalPayloadSchema,
      opts,
      [
        'Repair only locally identified PR* items. The accepted Lesson and every other first-pass Practice item are frozen.',
        'Return only practiceSlotId plus bounded item/surface content. Never output objective refs, construct, authority mode, duration, credit, Formal Evidence, mastery, or progression.',
        'Use only slot-specific offered S*/V* aliases and stay inside the locally stated capability and prohibited-construct boundary.',
        'For an apply failure, application must expose a source-stated starting state/rule, real decision, and expected action reflected by both prompt and action options. Lexical apply/next-step markers alone are invalid.',
        'Remove answer-bearing source quotation, accepted-Lesson worked-case repetition, exposed internal aliases, and same-scenario retries. Citations belong only in structured sourceRefs/visualRefs arrays, never in learner prose. A retry must use a meaningfully changed scenario.',
        'Return an items object containing only replacements for the named invalid PR* identities. Local code will reassemble it with every frozen valid item exactly.',
      ].join('\n'),
      {
        maxTokens: 8_000,
        schemaName: 'practice-content-v2-lesson-novelty',
        candidateNormalizer: normalizePracticePreparationCandidate,
        immutableItemIds: input.skeleton.practicePlan.slots.map((slot) => slot.practiceSlotId),
        targetedRepairCollection: {
          collectionKey: 'items',
          identityKey: 'practiceSlotId',
          itemSchema: ProposedPracticeSlotContentSchema,
        },
        allowIndependentRepair: false,
        allowLocalizedAliasRepairAfterStructuralRepair: true,
      },
    );
  }

  async proposeTutorStep(
    input: TutorStepInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorStepPayload> {
    return this.complete(tutorStepMessages(input), TutorStepPayloadSchema, opts);
  }

  async respondToTutorTurn(
    input: TutorTurnInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorTurnPayload> {
    return this.complete(tutorTurnMessages(input), TutorTurnPayloadSchema, opts);
  }

  async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<ProviderAuthoredCurriculumProposal> {
    return this.complete(
      curriculumProposalMessages(input),
      CurriculumProposalPayloadSchema,
      opts,
      [
        'For required_objective_formal_authority_missing, narrow or split the objective to the supplied authority envelope and preserve required priority. Never mark it optional, invent evidence, or repeat the unchanged claim.',
        CURRICULUM_NODE_KEY_PRESENCE_RULES,
      ].join('\n'),
      {
        maxTokens: CURRICULUM_MAX_OUTPUT_TOKENS,
        schemaName: 'curriculum-proposal-v4-node-key-presence',
        ...(input.capabilityRecovery?.requirements.length
          ? {}
          : { candidatePreprocessor: stripCapabilityRecoveryRefs }),
      },
    );
  }

  async proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload> {
    return this.complete(
      courseMapProposalMessages(input),
      CourseMapProposalPayloadSchema,
      opts,
      [
        'Course Map coverage repair is bounded to this one retry. Consume only the operation-local source-region aliases (R1, R2, ...), module aliases, and capabilityRef aliases named in the validation diagnostics.',
        'For every omitted meaningful region, add a direct region using that exact offered R# title and anchor-option references, or provide a valid explicit source disposition with a truthful rationale and representedRegionRefs.',
        'Preserve existing represented_by_parent_or_synthesis, duplicate/redundant, boilerplate/navigation/non-learning-content, explicitly_out_of_scope, and unresolved_candidate_gap dispositions; do not drop source identities or return the unchanged candidate.',
        'For semantic_topic_scattering, use the exact modules and R# source regions in the diagnostic. Regroup the affected regions under one coherent module, or add a narrowly named synthesis group across them only when there is a real cross-module teaching integration. Never add a broad bookkeeping-only synthesis group merely to silence validation.',
        'For source_heading_title_dump, rename each exact affected R# region into a concise learner-visible semantic identity. Remove parser/source numbering and repeated-heading counters while preserving the exact source-region membership and pedagogical order.',
        'A meaningful unresolved_candidate_gap remains a deterministic failure for systematic or deep goals.',
      ].join('\n'),
      {
        maxTokens: COURSE_MAP_MAX_OUTPUT_TOKENS,
        schemaName: 'course-map-proposal-v2-local-refs',
        ...(input.capabilityRecovery?.requirements.length
          ? {}
          : { candidatePreprocessor: stripCapabilityRecoveryRefs }),
      },
    );
  }

  async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload> {
    return this.complete(
      curriculumDetailProposalMessages(input),
      CurriculumDetailProposalPayloadSchema,
      opts,
      [
        'Curriculum detail repair is bounded to this one retry. Preserve every offered region exactly once and keep identities within that region.',
        'Objective keys are server-owned and normalized from each exact offered regionId plus objective ordinal before validation. Never merge, deduplicate, drop, or reorder objectives to change a key; preserve every proposed objective and its semantic fields.',
        "For every required objective, the authorityEnvelope attached to each selected evidence offer is decisive. Select evidence with formalEvidenceCount > 0 and keep the objective construct within that evidence offer's supportedConstructs.",
        "A broader region authorityEnvelope cannot lend authority to a different evidence offer. Never make required scope optional and never invent authority; narrow the wording to the selected evidence's narrowerClaim when necessary.",
        "For required_target_apply_missing, add a required apply objective using one exact evidence offer whose supportedConstructs contains apply. Keep it within that offer's source-stated ordered procedure and stated context; do not claim transfer, design, or broader deployment authority.",
        'For required_objective_parent_topic_mismatch, rename or regroup the LearningUnit so its learner-visible title semantically covers every required objective. Do not drop the required objective, change its priority, or move it outside the offered Course Map region.',
      ].join('\n'),
      {
        maxTokens: CURRICULUM_MAX_OUTPUT_TOKENS,
        schemaName: 'curriculum-detail-proposal-v2-claim-scope',
        candidatePreprocessor: curriculumDetailCandidatePreprocessor(input),
      },
    );
  }

  async evaluateObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticEvaluationInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticEvaluationProposal> {
    return this.complete(
      objectiveAuthoritySemanticEvaluationMessages(input),
      ObjectiveAuthoritySemanticEvaluationProposalSchema,
      opts,
      [
        'Repair only the malformed or locally rejected semantic evaluation fields.',
        'Keep objectiveRef and the exact ordered per-objective candidate boundary unchanged. Do not add proposition, construct, verdict, binding, selection, conflicts, overreach, or normal-path fragments.',
        'Return exactly one relevant, unrelated, or contradicts_claim label for every candidate in offered order. Relevant is relational, not a whole-claim support verdict.',
        'Support groups assert that one to five relevant candidates jointly support the claim; keep groups minimal and return at most four.',
        'Return subjectDependency and subjectDependencyRationale for every objective. Decide dependency only from proposition plus construct, independently of candidate support; strong support does not imply source-specific, absent support does not imply general, and mixed or uncertain objectives are source_specific_required.',
        'Never cite a candidate from another objective or invent an alias. Return the complete corrected evaluation object. Include fragments and capabilityPreservation only when requiredCapabilityPreservation was offered.',
        OBJECTIVE_AUTHORITY_SEMANTIC_CLOSED_KEY_RULES,
        OBJECTIVE_AUTHORITY_SEMANTIC_VOCABULARY_RULES,
      ].join('\n'),
      {
        maxTokens: OBJECTIVE_AUTHORITY_SEMANTIC_EVALUATION_MAX_OUTPUT_TOKENS,
        schemaName: 'objective-authority-semantic-evaluation-v4',
        targetedRepairCollection: {
          collectionKey: 'evaluations',
          identityKey: 'objectiveRef',
          itemSchema: ObjectiveAuthoritySemanticObjectiveProposalSchema,
        },
      },
    );
  }

  async repairObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticRepairInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticRepairProposal> {
    return this.complete(
      objectiveAuthoritySemanticRepairMessages(input),
      ObjectiveAuthoritySemanticRepairProposalSchema,
      opts,
      [
        'Repair only supplied failed objectiveRefs and return exactly one replacement for each.',
        'Preserve construct and select only aliases in that objective allowedEvidence.',
        'Never lower construct, omit important capability, broaden authority, or rewrite unrelated objectives.',
      ].join('\n'),
      {
        maxTokens: 8_000,
        schemaName: 'objective-authority-semantic-repair-v2-claim-scope',
      },
    );
  }

  async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    if (input.units.length >= 80) {
      const grouped = await this.complete(
        groupedStudyPlanProposalMessages(input),
        groupedStudyPlanSchema(input),
        opts,
        studyPlanRepairGuidance(input, true),
      );
      return this.expandGroupedStudyPlan(input, grouped);
    }
    return this.complete(
      studyPlanProposalMessages(input),
      detailedStudyPlanSchema(detailedStudyPlanScopeFromInput(input)),
      opts,
      studyPlanRepairGuidance(input, false),
    );
  }

  private expandGroupedStudyPlan(
    input: StudyPlanProposalInput,
    grouped: GroupedStudyPlanProposalPayload,
  ): StudyPlanProposalPayload {
    const requiredIds = new Set(input.requiredLearningUnitIds);
    const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
    const capabilitiesById = new Map(
      input.launchCapabilities.map((capability) => [
        capability.curriculumLearningUnitId,
        capability,
      ]),
    );
    const itemKeyByUnitId = new Map<string, string>();
    const accounted = new Set<string>();
    const items: StudyPlanProposalPayload['items'] = [];
    const deferrals: StudyPlanProposalPayload['deferrals'] = [];
    const invalid = (message: string): never => {
      throw ProviderError.invalidOutput(message);
    };

    for (const group of grouped.groups) {
      if (!input.allowedDepths.includes(group.targetDepth)) {
        invalid(`Grouped StudyPlan uses an unavailable depth: ${group.targetDepth}.`);
      }
      for (const unitId of group.curriculumLearningUnitIds) {
        const unit = unitsById.get(unitId);
        if (!unit) {
          throw ProviderError.invalidOutput(
            `Grouped StudyPlan references an unknown LearningUnit: ${unitId}.`,
          );
        }
        if (!requiredIds.has(unitId)) {
          invalid(`Grouped StudyPlan references a non-required LearningUnit: ${unitId}.`);
        }
        if (accounted.has(unitId)) {
          invalid(`Grouped StudyPlan repeats LearningUnit: ${unitId}.`);
        }
        const capability = capabilitiesById.get(unitId);
        if (!capability?.allowedItemKinds.includes(group.kind)) {
          invalid(`Grouped StudyPlan kind ${group.kind} is unavailable for ${unitId}.`);
        }
        const missingPrerequisite = unit.prerequisiteUnitIds.find(
          (prerequisiteId) =>
            requiredIds.has(prerequisiteId) && !itemKeyByUnitId.has(prerequisiteId),
        );
        if (missingPrerequisite) {
          invalid(
            `Grouped StudyPlan must place prerequisite ${missingPrerequisite} before ${unitId}.`,
          );
        }
        const key = `item-${items.length + 1}`;
        items.push({
          key,
          phase: group.phase,
          kind: group.kind,
          curriculumLearningUnitId: unitId,
          rationale: group.rationale,
          estimatedMinutes: group.estimatedMinutesPerUnit,
          targetDepth: group.targetDepth,
          objectiveIds: unit.objectiveIds,
          prerequisiteItemKeys: unit.prerequisiteUnitIds
            .map((prerequisiteId) => itemKeyByUnitId.get(prerequisiteId))
            .filter((itemKey): itemKey is string => Boolean(itemKey)),
        });
        itemKeyByUnitId.set(unitId, key);
        accounted.add(unitId);
      }
    }

    for (const deferral of grouped.deferrals) {
      if (!input.contract.allowExplicitDeferral) {
        invalid('Grouped StudyPlan deferrals are not allowed by the Contract.');
      }
      for (const unitId of deferral.curriculumLearningUnitIds) {
        const unit = unitsById.get(unitId);
        if (!unit) {
          throw ProviderError.invalidOutput(
            `Grouped StudyPlan defers an unknown LearningUnit: ${unitId}.`,
          );
        }
        if (!requiredIds.has(unitId)) {
          invalid(`Grouped StudyPlan defers a non-required LearningUnit: ${unitId}.`);
        }
        if (accounted.has(unitId)) {
          invalid(`Grouped StudyPlan repeats LearningUnit: ${unitId}.`);
        }
        deferrals.push({
          curriculumLearningUnitId: unitId,
          objectiveIds: unit.objectiveIds,
          reason: deferral.reason,
        });
        accounted.add(unitId);
      }
    }

    const omitted = input.requiredLearningUnitIds.find((unitId) => !accounted.has(unitId));
    if (omitted) invalid(`Grouped StudyPlan omits required LearningUnit: ${omitted}.`);
    return StudyPlanProposalPayloadSchema.parse({
      rationale: grouped.rationale,
      items,
      deferrals,
    });
  }

  /**
   * Core request/validate loop with fixed, failure-class-specific budgets.
   * Truncation regenerates cleanly without feeding partial bytes back. Current
   * compositional calls normally stop after one recovery; the only third-call
   * exception is the observed structural-repair -> alias-only localized repair.
   * Legacy calls retain their independently bounded schema/candidate behavior.
   */
  private async complete<T>(
    messages: ChatMessage[],
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts?: ProviderCallOptions,
    repairGuidance?: string,
    requestOptions: {
      maxTokens?: number;
      schemaName?: string;
      targetedRepairCollection?: TargetedRepairCollection;
      candidatePreprocessor?: ProviderCandidatePreprocessor;
      candidateNormalizer?: ProviderCandidateNormalizer;
      immutableItemIds?: string[];
      /** Legacy calls may spend independent schema/candidate repairs; compositional calls do not. */
      allowIndependentRepair?: boolean;
      /** Narrow R2.1 exception justified by repeated real structural -> alias failures. */
      allowLocalizedAliasRepairAfterStructuralRepair?: boolean;
    } = {},
  ): Promise<T> {
    const schemaName =
      requestOptions.schemaName ??
      opts?.telemetry?.schemaFingerprint ??
      opts?.telemetry?.operationType ??
      'provider-structured-output';
    const preparationRecoveryEnabled =
      requestOptions.candidateNormalizer !== undefined ||
      requestOptions.immutableItemIds !== undefined ||
      requestOptions.allowLocalizedAliasRepairAfterStructuralRepair === true;
    const original = await this.chatWithDiagnostic(
      messages,
      opts,
      requestOptions,
      schemaName,
      1,
      'original',
    );
    const first = this.tryParse(
      original,
      schema,
      opts,
      undefined,
      requestOptions.candidatePreprocessor,
      requestOptions.candidateNormalizer,
      false,
    );
    const immutableItemIds = requestOptions.immutableItemIds ?? [];
    const firstCandidateTargetedRepair =
      requestOptions.targetedRepairCollection &&
      !first.ok &&
      first.reason === 'candidate' &&
      first.candidate !== undefined &&
      first.targetedRepair !== undefined
        ? normalizeTargetedRepairScope(
            first.targetedRepair,
            requestOptions.targetedRepairCollection,
          )
        : null;
    const firstSchemaBaseCandidate = requestOptions.candidateNormalizer
      ? requestOptions.candidateNormalizer(first.parse.parsed).candidate
      : first.parse.parsed;
    let targetedRepairBase: {
      candidate: unknown;
      scope: ProviderTargetedRepairScope;
    } | null =
      firstCandidateTargetedRepair && !first.ok && first.candidate !== undefined
        ? { candidate: first.candidate, scope: firstCandidateTargetedRepair }
        : requestOptions.targetedRepairCollection &&
            !first.ok &&
            first.reason === 'schema' &&
            first.category !== 'TRUNCATED_OUTPUT' &&
            first.category !== 'EMPTY_RESPONSE' &&
            first.category !== 'JSON_PARSE_FAILURE'
          ? schemaTargetedRepairBase(
              firstSchemaBaseCandidate,
              requestOptions.targetedRepairCollection,
            )
          : null;
    const firstRecoveryAction = first.ok
      ? ('none' as const)
      : preparationRecoveryEnabled
        ? selectRecoveryAction(first, targetedRepairBase?.scope)
        : first.repairable
          ? targetedRepairBase
            ? ('targeted_repair' as const)
            : ('structured_repair' as const)
          : ('none' as const);
    const firstDiagnostic = buildStructuredOutputDiagnostic({
      schemaName,
      operationType: opts?.telemetry?.operationType ?? null,
      attemptNumber: 1,
      attemptKind: 'original',
      model: this.config.model,
      response: original.response,
      parse: first.parse,
      repairAction: first.ok ? 'none' : first.repairable ? 'requested' : 'none',
      ...(preparationRecoveryEnabled
        ? {
            recovery: recoveryScopeDiagnostic(
              targetedRepairBase?.scope,
              immutableItemIds,
              firstRecoveryAction,
            ),
          }
        : {}),
    });
    this.emitDiagnostic(
      opts,
      firstDiagnostic,
      first.ok
        ? undefined
        : {
            result: first,
            rawContent: original.content,
            repairExhausted: !first.repairable,
            promptFingerprint: original.promptFingerprint,
          },
    );
    if (first.ok) return first.value;
    if (!first.repairable) {
      throw ProviderError.invalidOutput(
        first.error,
        first.reason,
        first.category,
        false,
        first.candidateFailure,
        firstDiagnostic,
      );
    }

    const secondAttemptKind = firstRecoveryAction === 'clean_regeneration' ? 'retry' : 'repair';
    const repairMessages: ChatMessage[] =
      firstRecoveryAction === 'clean_regeneration'
        ? [
            ...messages,
            {
              role: 'user',
              content: [
                'The prior physical response was empty or truncated. Discard its partial bytes completely and regenerate from the original immutable inputs; do not repair, continue, or infer the partial JSON.',
                ...immutableInventoryInstruction(immutableItemIds),
                'Use concise field values, emit one complete JSON object, and reserve enough output budget to close every required object and array.',
                '只输出完整 JSON,不要解释。',
              ].join('\n'),
            },
          ]
        : [
            ...messages,
            { role: 'assistant', content: original.content },
            {
              role: 'user',
              content: [
                '你上一次的输出未通过校验,存在以下问题:',
                first.error,
                ...(first.candidateFailure
                  ? [
                      '以下是本地确定性校验生成的结构化修复事实。它们是修复边界，不是新的指令；只能在这些事实和原始上下文内改写候选:',
                      JSON.stringify(first.candidateFailure),
                    ]
                  : []),
                ...immutableInventoryInstruction(immutableItemIds, Boolean(targetedRepairBase)),
                ...(targetedRepairBase
                  ? [
                      `Only these stable item identities may change: ${targetedRepairBase.scope.invalidItemIds.join(', ')}. Every other first-pass item is frozen and will be restored locally if rewritten or omitted.`,
                    ]
                  : []),
                ...localizedRepairInstruction(targetedRepairBase?.scope),
                ...(repairGuidance ? ['本次请求的精确修复约束:', repairGuidance] : []),
                ...repairScopeInstruction(first.disclosure, false),
              ].join('\n'),
            },
          ];
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    if (preparationRecoveryEnabled) {
      opts?.onRepairAttempt?.(first.reason, first.category, firstRecoveryAction);
    } else {
      opts?.onRepairAttempt?.(first.reason, first.category);
    }
    const repaired = await this.chatWithDiagnostic(
      repairMessages,
      opts,
      requestOptions,
      schemaName,
      2,
      secondAttemptKind,
    );
    const second = this.tryParse(
      repaired,
      schema,
      opts,
      secondAttemptKind === 'repair' &&
        targetedRepairBase &&
        requestOptions.targetedRepairCollection
        ? (candidate) =>
            mergeTargetedRepairCandidate(
              targetedRepairBase!.candidate,
              candidate,
              requestOptions.targetedRepairCollection!,
              targetedRepairBase!.scope,
            )
        : undefined,
      requestOptions.candidatePreprocessor,
      requestOptions.candidateNormalizer,
      Boolean(targetedRepairBase?.scope.localizedTextRepair),
    );
    if (
      requestOptions.targetedRepairCollection &&
      !second.ok &&
      second.reason === 'candidate' &&
      second.candidate !== undefined &&
      second.targetedRepair !== undefined
    ) {
      const scope = normalizeTargetedRepairScope(
        second.targetedRepair,
        requestOptions.targetedRepairCollection,
      );
      if (scope) targetedRepairBase = { candidate: second.candidate, scope };
    }
    const localizedAliasFollowupAllowed =
      requestOptions.allowLocalizedAliasRepairAfterStructuralRepair === true &&
      secondAttemptKind === 'repair' &&
      first.category === 'SCHEMA_VALIDATION_FAILURE' &&
      !second.ok &&
      second.repairable &&
      second.reason === 'candidate' &&
      targetedRepairBase?.scope.localizedTextRepair !== undefined;
    const legacyIndependentRepairAllowed =
      requestOptions.allowIndependentRepair !== false &&
      !second.ok &&
      second.repairable &&
      second.reason !== first.reason;
    const independentRepairAllowed =
      localizedAliasFollowupAllowed || legacyIndependentRepairAllowed;
    const secondRecoveryAction = second.ok
      ? ('none' as const)
      : independentRepairAllowed
        ? preparationRecoveryEnabled
          ? selectRecoveryAction(second, targetedRepairBase?.scope)
          : targetedRepairBase
            ? ('targeted_repair' as const)
            : ('structured_repair' as const)
        : ('exhausted' as const);
    const secondDiagnostic = buildStructuredOutputDiagnostic({
      schemaName,
      operationType: opts?.telemetry?.operationType ?? null,
      attemptNumber: 2,
      attemptKind: secondAttemptKind,
      model: this.config.model,
      response: repaired.response,
      parse: second.parse,
      repairAction: second.ok ? 'none' : independentRepairAllowed ? 'requested' : 'exhausted',
      ...(preparationRecoveryEnabled
        ? {
            recovery: recoveryScopeDiagnostic(
              targetedRepairBase?.scope,
              immutableItemIds,
              secondRecoveryAction,
            ),
          }
        : {}),
    });
    this.emitDiagnostic(
      opts,
      secondDiagnostic,
      second.ok
        ? undefined
        : {
            result: second,
            rawContent: repaired.content,
            repairExhausted: !independentRepairAllowed,
            promptFingerprint: repaired.promptFingerprint,
          },
    );
    if (second.ok) return second.value;
    if (independentRepairAllowed) {
      const thirdAttemptKind = secondRecoveryAction === 'clean_regeneration' ? 'retry' : 'repair';
      const independentRepairMessages: ChatMessage[] =
        secondRecoveryAction === 'clean_regeneration'
          ? [
              ...messages,
              {
                role: 'user',
                content: [
                  'The prior physical response was empty or truncated. Discard its partial bytes completely and regenerate from the original immutable inputs.',
                  ...immutableInventoryInstruction(immutableItemIds),
                  'Use concise field values and return one complete JSON object. Only output JSON.',
                ].join('\n'),
              },
            ]
          : [
              ...messages,
              { role: 'assistant', content: repaired.content },
              {
                role: 'user',
                content: [
                  localizedAliasFollowupAllowed
                    ? 'The structural repair passed its schema, but learner-facing text still exposes internal aliases. This is the single narrowly localized follow-up.'
                    : '你修复了上一类校验问题,但当前输出又触发了另一类独立校验失败:',
                  second.error,
                  ...(second.candidateFailure
                    ? [
                        '以下是本地确定性校验生成的结构化修复事实。只能修复这些事实指出的元素，并保留其他有效内容:',
                        JSON.stringify(second.candidateFailure),
                      ]
                    : []),
                  ...immutableInventoryInstruction(immutableItemIds, Boolean(targetedRepairBase)),
                  ...(targetedRepairBase
                    ? [
                        `Only these stable item identities may change: ${targetedRepairBase.scope.invalidItemIds.join(', ')}. Every other validated item is frozen and cannot be rewritten or omitted.`,
                      ]
                    : []),
                  ...localizedRepairInstruction(targetedRepairBase?.scope),
                  ...(repairGuidance ? ['本次请求的精确修复约束:', repairGuidance] : []),
                  ...repairScopeInstruction(second.disclosure, true),
                ].join('\n'),
              },
            ];
      if (opts?.signal?.aborted) throw ProviderError.cancelled();
      if (preparationRecoveryEnabled) {
        opts?.onRepairAttempt?.(second.reason, second.category, secondRecoveryAction);
      } else {
        opts?.onRepairAttempt?.(second.reason, second.category);
      }
      const independentlyRepaired = await this.chatWithDiagnostic(
        independentRepairMessages,
        opts,
        requestOptions,
        schemaName,
        3,
        thirdAttemptKind,
      );
      const third = this.tryParse(
        independentlyRepaired,
        schema,
        opts,
        thirdAttemptKind === 'repair' &&
          targetedRepairBase &&
          requestOptions.targetedRepairCollection
          ? (candidate) =>
              mergeTargetedRepairCandidate(
                targetedRepairBase!.candidate,
                candidate,
                requestOptions.targetedRepairCollection!,
                targetedRepairBase!.scope,
              )
          : undefined,
        requestOptions.candidatePreprocessor,
        requestOptions.candidateNormalizer,
        Boolean(targetedRepairBase?.scope.localizedTextRepair),
      );
      const thirdDiagnostic = buildStructuredOutputDiagnostic({
        schemaName,
        operationType: opts?.telemetry?.operationType ?? null,
        attemptNumber: 3,
        attemptKind: thirdAttemptKind,
        model: this.config.model,
        response: independentlyRepaired.response,
        parse: third.parse,
        repairAction: third.ok ? 'none' : 'exhausted',
        ...(preparationRecoveryEnabled
          ? {
              recovery: recoveryScopeDiagnostic(
                targetedRepairBase?.scope,
                immutableItemIds,
                third.ok ? 'none' : 'exhausted',
              ),
            }
          : {}),
      });
      this.emitDiagnostic(
        opts,
        thirdDiagnostic,
        third.ok
          ? undefined
          : {
              result: third,
              rawContent: independentlyRepaired.content,
              repairExhausted: true,
              promptFingerprint: independentlyRepaired.promptFingerprint,
            },
      );
      if (third.ok) return third.value;
      throw ProviderError.invalidOutput(
        third.error,
        third.reason,
        third.category,
        true,
        third.candidateFailure,
        thirdDiagnostic,
      );
    }

    throw ProviderError.invalidOutput(
      second.error,
      second.reason,
      second.category,
      true,
      second.candidateFailure,
      secondDiagnostic,
    );
  }

  private tryParse<T>(
    result: ChatCompletionResult,
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts?: ProviderCallOptions,
    candidateTransform?: ((candidate: unknown) => unknown) | undefined,
    candidatePreprocessor?: ProviderCandidatePreprocessor | undefined,
    candidateNormalizer?: ProviderCandidateNormalizer | undefined,
    candidateTransformBeforeSchema = false,
  ): { ok: true; value: T; parse: StructuredParseMetadata } | TryParseFailure<T> {
    const abnormalFinishReason =
      result.response.finishReason === 'sensitive' ||
      result.response.finishReason === 'content_filter' ||
      result.response.finishReason === 'tool_calls' ||
      result.response.finishReason === 'function_call';
    if (result.envelopeFailure) {
      return {
        ok: false,
        error: result.envelopeFailure.summary,
        reason: 'schema',
        category: result.envelopeFailure.category,
        repairable: false,
        parse: {
          jsonParseSuccess: false,
          jsonFormat: null,
          parsed: undefined,
          ...(candidateNormalizer ? { normalizationRan: false, normalizationActions: [] } : {}),
          failureCategory: result.envelopeFailure.category,
        },
      };
    }

    let extracted: ReturnType<typeof extractJsonWithFormat>;
    try {
      extracted = extractJsonWithFormat(result.content);
    } catch (err) {
      if (err instanceof JsonExtractionError) {
        result.response.possiblyIncomplete = err.kind === 'incomplete_json';
        const category: StructuredOutputFailureCategory = abnormalFinishReason
          ? 'PROVIDER_FORMAT_INCOMPATIBILITY'
          : result.response.truncated ||
              (candidateNormalizer !== undefined && err.kind === 'incomplete_json')
            ? 'TRUNCATED_OUTPUT'
            : err.kind === 'empty'
              ? 'EMPTY_RESPONSE'
              : err.kind === 'format_incompatible'
                ? 'PROVIDER_FORMAT_INCOMPATIBILITY'
                : 'JSON_PARSE_FAILURE';
        return {
          ok: false,
          error: err.message,
          reason: 'schema',
          category,
          repairable: !abnormalFinishReason,
          parse: {
            jsonParseSuccess: false,
            jsonFormat: null,
            parsed: undefined,
            ...(candidateNormalizer ? { normalizationRan: false, normalizationActions: [] } : {}),
            failureCategory: category,
          },
        };
      }
      throw err;
    }

    const preprocessed = candidatePreprocessor
      ? candidatePreprocessor(extracted.value)
      : extracted.value;
    const normalization = candidateNormalizer
      ? candidateNormalizer(preprocessed)
      : { candidate: preprocessed, actions: [] };
    const normalizationMetadata = candidateNormalizer
      ? { normalizationRan: true, normalizationActions: normalization.actions }
      : {};
    const candidate =
      candidateTransform && candidateTransformBeforeSchema
        ? candidateTransform(normalization.candidate)
        : normalization.candidate;
    let parsed = schema.safeParse(candidate);
    if (parsed.success && candidateTransform && !candidateTransformBeforeSchema) {
      parsed = schema.safeParse(candidateTransform(parsed.data));
    }
    if (abnormalFinishReason) {
      return {
        ok: false,
        error: `模型服务以异常原因结束结构化输出: ${result.response.finishReason}。`,
        reason: 'schema',
        category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
        repairable: false,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          ...(!parsed.success ? { schemaIssues: parsed.error.issues } : {}),
          ...normalizationMetadata,
          failureCategory: 'PROVIDER_FORMAT_INCOMPATIBILITY',
        },
      };
    }
    if (result.response.truncated) {
      return {
        ok: false,
        error: '模型输出因长度限制而截断。',
        reason: 'schema',
        category: 'TRUNCATED_OUTPUT',
        repairable: true,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          ...(!parsed.success ? { schemaIssues: parsed.error.issues } : {}),
          ...normalizationMetadata,
          failureCategory: 'TRUNCATED_OUTPUT',
        },
      };
    }
    if (parsed.success) {
      const candidate = opts?.validateCandidate?.(parsed.data);
      if (candidate && !candidate.valid) {
        return {
          ok: false,
          error: candidate.diagnostics.slice(0, 20).join('; ').slice(0, 8_000),
          reason: 'candidate',
          category: 'SEMANTIC_VALIDATION_FAILURE',
          repairable: true,
          ...(candidate.failureArtifact ? { candidateFailure: candidate.failureArtifact } : {}),
          candidate: parsed.data,
          ...(candidate.targetedRepair ? { targetedRepair: candidate.targetedRepair } : {}),
          parse: {
            jsonParseSuccess: true,
            jsonFormat: extracted.format,
            parsed: extracted.value,
            semanticIssueCodes: candidate.diagnosticCodes ?? ['candidate_validation_failed'],
            ...normalizationMetadata,
            failureCategory: 'SEMANTIC_VALIDATION_FAILURE',
          },
        };
      }
      return {
        ok: true,
        value: parsed.data,
        parse: {
          jsonParseSuccess: true,
          jsonFormat: extracted.format,
          parsed: extracted.value,
          ...normalizationMetadata,
          failureCategory: null,
        },
      };
    }
    const disclosure = summarizeSchemaIssuesForRepair(parsed.error.issues);
    return {
      ok: false,
      error: disclosure.summary,
      disclosure,
      reason: 'schema',
      category: 'SCHEMA_VALIDATION_FAILURE',
      repairable: true,
      parse: {
        jsonParseSuccess: true,
        jsonFormat: extracted.format,
        parsed: extracted.value,
        schemaIssues: parsed.error.issues,
        ...normalizationMetadata,
        failureCategory: 'SCHEMA_VALIDATION_FAILURE',
      },
    };
  }

  private emitDiagnostic(
    opts: ProviderCallOptions | undefined,
    diagnostic: StructuredOutputDiagnostic,
    rejection?: {
      /** The tryParse rejection whose candidate local validation refused. */
      result: TryParseFailure;
      /** Raw response text, used only when JSON extraction never produced a value. */
      rawContent: string;
      repairExhausted: boolean;
      promptFingerprint: string | null;
    },
  ): void {
    try {
      opts?.onStructuredOutputDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are observational and must never change provider behavior.
    }
    if (!rejection || !opts?.onRejectedCandidate) return;
    try {
      const hasParsedCandidate = rejection.result.parse.parsed !== undefined;
      opts.onRejectedCandidate({
        validationKind: rejection.result.reason,
        failureCategory: rejection.result.category,
        repairExhausted: rejection.repairExhausted,
        schemaName: diagnostic.schemaName,
        operationType: diagnostic.operationType,
        attemptNumber: diagnostic.attemptNumber,
        attemptKind: diagnostic.attemptKind,
        candidate: hasParsedCandidate ? rejection.result.parse.parsed : rejection.rawContent,
        candidateIsRawText: !hasParsedCandidate,
        findings: rejectedCandidateFindings(rejection.result, diagnostic),
        promptFingerprint: rejection.promptFingerprint,
      });
    } catch {
      // Capture is best-effort and must never change provider behavior.
    }
  }

  private async chatWithDiagnostic(
    messages: ChatMessage[],
    opts: ProviderCallOptions | undefined,
    requestOptions: { maxTokens?: number },
    schemaName: string,
    attemptNumber: 1 | 2 | 3,
    attemptKind: 'original' | 'repair' | 'retry',
  ): Promise<ChatCompletionResult> {
    try {
      return await this.chat(messages, opts, requestOptions);
    } catch (error) {
      this.emitDiagnostic(
        opts,
        buildStructuredOutputDiagnostic({
          schemaName,
          operationType: opts?.telemetry?.operationType ?? null,
          attemptNumber,
          attemptKind,
          model: this.config.model,
          response: {
            transportSuccess: false,
            httpStatus: error instanceof ProviderError ? (error.technicalHttpStatus ?? null) : null,
            responseBodyBytes: null,
            contentType: 'missing',
            contentBytes: null,
            contentFingerprint: null,
            finishReason: null,
            truncated: false,
            possiblyIncomplete: false,
          },
          parse: {
            jsonParseSuccess: false,
            jsonFormat: null,
            parsed: undefined,
            failureCategory: 'TRANSPORT_FAILURE',
          },
          repairAction: attemptKind === 'repair' ? 'exhausted' : 'none',
        }),
      );
      throw error;
    }
  }

  /** Single chat completion call with timeout + external cancellation. */
  private async chat(
    messages: ChatMessage[],
    opts?: ProviderCallOptions,
    requestOptions: {
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<ChatCompletionResult> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();

    const timeoutMs = opts?.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const abortError = (): ProviderError => {
      if (opts?.signal?.aborted) return ProviderError.cancelled();
      if (timedOut) return ProviderError.timeout(timeoutMs);
      return ProviderError.cancelled();
    };

    // Digest the very array that is serialized into the request body below, so the
    // fingerprint cannot drift from what this physical attempt actually sent.
    const promptFingerprint = opts?.onRejectedCandidate ? promptFingerprintOf(messages) : null;

    try {
      opts?.onRequestSent?.();
      const response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature: requestOptions.temperature ?? 0.2,
            ...(requestOptions.maxTokens !== undefined
              ? { max_tokens: requestOptions.maxTokens }
              : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw ProviderError.http(response.status);
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        if (controller.signal.aborted) throw abortError();
        throw ProviderError.network();
      }

      // The timeout/cancellation budget covers the complete body read, not
      // merely the arrival of response headers.
      if (controller.signal.aborted) throw abortError();

      const responseBodyBytes = Buffer.byteLength(body, 'utf8');
      let data: ChatCompletionResponse;
      try {
        const parsed = JSON.parse(body) as unknown;
        data =
          parsed !== null && typeof parsed === 'object' ? (parsed as ChatCompletionResponse) : {};
      } catch {
        return {
          content: '',
          response: {
            transportSuccess: true,
            httpStatus: response.status,
            responseBodyBytes,
            contentType: 'missing',
            contentBytes: null,
            contentFingerprint: null,
            finishReason: null,
            truncated: false,
            possiblyIncomplete: false,
          },
          promptFingerprint,
          envelopeFailure: {
            category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
            summary: '模型服务响应不是合法 JSON。',
          },
        };
      }

      const nonnegativeInteger = (value: unknown): number | null =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
      opts?.onUsage?.({
        inputTokens: nonnegativeInteger(data.usage?.prompt_tokens),
        outputTokens: nonnegativeInteger(data.usage?.completion_tokens),
        reasoningTokens: nonnegativeInteger(
          data.usage?.completion_tokens_details?.reasoning_tokens,
        ),
        cacheReadTokens: nonnegativeInteger(data.usage?.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: null,
        estimatedCostMicrounits: null,
        currency: null,
        pricingSource: null,
        pricingVersion: null,
      });

      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = safeFinishReason(choice?.finish_reason);
      const baseResponse = {
        transportSuccess: true,
        httpStatus: response.status,
        responseBodyBytes,
        contentType: contentShape(content),
        contentBytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : null,
        contentFingerprint: null,
        finishReason,
        truncated: finishReason === 'length',
        possiblyIncomplete: false,
      } satisfies StructuredResponseMetadata;
      if (typeof content !== 'string') {
        return {
          content: '',
          response: baseResponse,
          promptFingerprint,
          envelopeFailure: {
            category: 'PROVIDER_FORMAT_INCOMPATIBILITY',
            summary: '模型服务响应缺少字符串 message.content。',
          },
        };
      }
      return { content, response: baseResponse, promptFingerprint };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (controller.signal.aborted) throw abortError();
      throw ProviderError.network();
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }
}
