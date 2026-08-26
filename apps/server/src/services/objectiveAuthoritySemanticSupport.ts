import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  ObjectiveAuthoritySemanticEvaluationInputSchema,
  ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthoritySemanticSupportSchema,
  type Curriculum,
  type CurriculumNode,
  type CurriculumObjective,
  type FormalAssessmentConstruct,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticEvaluationObjectiveInput,
  type ObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticObjectiveProposal,
  type ObjectiveAuthorityCapabilityRecoveryOrigin,
  type ObjectiveAuthorityRequiredCapabilityPreservation,
  type ObjectiveAuthoritySemanticSupport,
  type ObjectiveAuthoritySupportType,
  type SourceAuthorityBundle,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { ProviderCandidateValidation } from '../llm/provider.js';

export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY =
  'objective-authority-semantic-support-v1';
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH = 24;
/** Eight fixed evaluator batches; detail generation must stay below this before evaluation. */
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES = 192;

export interface ObjectiveAuthoritySemanticEvidenceAliasBinding {
  evidenceRef: string;
  sourceBlockId: string;
  authorityRecordIds: string[];
  authorityClaimIds: string[];
}

export interface ObjectiveAuthoritySemanticObjectiveAliasBinding {
  objectiveRef: string;
  objectiveId: string;
  proposition: string;
  construct: FormalAssessmentConstruct;
  boundAuthorityRecordIds: string[];
  boundSourceBlockIds: string[];
  boundAuthorityClaimIds: string[];
  evidenceByRef: Map<string, ObjectiveAuthoritySemanticEvidenceAliasBinding>;
}

export interface ObjectiveAuthoritySemanticEvaluationScope {
  input: ObjectiveAuthoritySemanticEvaluationObjectiveInput;
  aliasBinding: ObjectiveAuthoritySemanticObjectiveAliasBinding;
}

/** Serializable provider input paired with local-only aliases never sent to a provider. */
export interface ObjectiveAuthoritySemanticEvaluationBatch {
  input: ObjectiveAuthoritySemanticEvaluationInput;
  aliasBindings: Map<string, ObjectiveAuthoritySemanticObjectiveAliasBinding>;
}

export interface BuildObjectiveAuthoritySemanticEvaluationScopesInput {
  nodes: CurriculumNode[];
  sourceBlocks: SourceBlock[];
  authorityBundles: SourceAuthorityBundle[];
  isBlockingEligible: (authorityRecordId: string) => boolean;
  /**
   * Original failed-objective meaning to preserve during a fresh post-repair
   * evaluation. Keys are the newly materialized objective identities.
   */
  requiredCapabilityPreservationByObjectiveId?:
    ReadonlyMap<string, ObjectiveAuthorityRequiredCapabilityPreservation> | undefined;
}

export interface MaterializeObjectiveAuthoritySemanticSupportMetadata {
  evaluator: string;
  provider: string;
  providerModel: string | null;
  evaluatedAt: string;
  /** Local-only immutable predecessor lineage; never provider-authored. */
  recoveryOriginByObjectiveId?:
    ReadonlyMap<string, ObjectiveAuthorityCapabilityRecoveryOrigin> | undefined;
}

export interface ValidateCurriculumObjectiveAuthoritySemanticSupportOptions {
  isBlockingEligible?: ((authorityRecordId: string) => boolean) | undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function fingerprintObjectiveAuthorityProposition(proposition: string): string {
  return sha256(proposition);
}

export function fingerprintObjectiveAuthorityAuditValue(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function fingerprintObjectiveAuthorityBinding(input: {
  authorityRecordIds: readonly string[];
  sourceBlockIds: readonly string[];
  authorityClaimIds: readonly string[];
}): string {
  return sha256(
    JSON.stringify({
      authorityRecordIds: input.authorityRecordIds,
      sourceBlockIds: input.sourceBlockIds,
      authorityClaimIds: input.authorityClaimIds,
    }),
  );
}

export function curriculumObjectiveProposition(
  objective: Pick<CurriculumObjective, 'title' | 'description'>,
): string {
  return `${objective.title}\n${objective.description}`;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireUnique(values: readonly string[], label: string, objectiveId: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate identities for objective ${objectiveId}.`);
  }
}

function deriveBoundSourceBlockIds(
  objective: CurriculumObjective,
  authorityById: ReadonlyMap<string, SourceAuthorityBundle>,
): string[] {
  if (objective.authoritySourceBlockIds !== undefined) {
    return [...objective.authoritySourceBlockIds];
  }
  const formalEvidence = new Set(objective.formalEvidenceSourceBlockIds ?? []);
  const restrictToFormalEvidence = formalEvidence.size > 0;
  return uniqueInOrder(
    objective.truthAuthorityRecordIds.flatMap((authorityRecordId) => {
      const bundle = authorityById.get(authorityRecordId);
      if (!bundle) return [];
      return bundle.claims
        .map((claim) => claim.sourceBlockId)
        .filter((sourceBlockId) => !restrictToFormalEvidence || formalEvidence.has(sourceBlockId));
    }),
  );
}

interface MutableEvidenceOffer {
  text: string;
  claimKinds: ObjectiveAuthoritySemanticEvaluationObjectiveInput['evidence'][number]['claimKinds'];
  headingPath: string[];
  sourceBlockId: string;
  authorityRecordIds: string[];
  authorityClaimIds: string[];
}

function buildObjectiveEvidence(
  objective: CurriculumObjective,
  boundSourceBlockIds: readonly string[],
  boundAuthorityClaimIds: readonly string[],
  authorityById: ReadonlyMap<string, SourceAuthorityBundle>,
  sourceBlockById: ReadonlyMap<string, SourceBlock>,
  isBlockingEligible: (authorityRecordId: string) => boolean,
): {
  evidence: ObjectiveAuthoritySemanticEvaluationObjectiveInput['evidence'];
  evidenceByRef: Map<string, ObjectiveAuthoritySemanticEvidenceAliasBinding>;
} {
  const boundBlocks = new Set(boundSourceBlockIds);
  const boundClaims = new Set(boundAuthorityClaimIds);
  const grouped = new Map<string, MutableEvidenceOffer>();
  for (const authorityRecordId of objective.truthAuthorityRecordIds) {
    const bundle = authorityById.get(authorityRecordId);
    if (!bundle || !isBlockingEligible(authorityRecordId)) continue;
    const premiseKind = bundle.record.policyBasis.premiseKind;
    for (const claim of bundle.claims) {
      if (!boundBlocks.has(claim.sourceBlockId) || !boundClaims.has(claim.id)) continue;
      const block = sourceBlockById.get(claim.sourceBlockId);
      if (
        !block ||
        claim.startOffset < 0 ||
        claim.endOffset > block.content.length ||
        block.content.slice(claim.startOffset, claim.endOffset) !== claim.quote
      ) {
        continue;
      }
      const key = `${claim.sourceBlockId}\u0000${claim.startOffset}\u0000${claim.endOffset}\u0000${claim.quote}`;
      const current = grouped.get(key) ?? {
        text: claim.quote,
        claimKinds: [],
        headingPath: [...block.headingPath],
        sourceBlockId: claim.sourceBlockId,
        authorityRecordIds: [],
        authorityClaimIds: [],
      };
      if (!current.claimKinds.includes(premiseKind)) current.claimKinds.push(premiseKind);
      if (!current.authorityRecordIds.includes(authorityRecordId)) {
        current.authorityRecordIds.push(authorityRecordId);
      }
      if (!current.authorityClaimIds.includes(claim.id)) current.authorityClaimIds.push(claim.id);
      grouped.set(key, current);
    }
  }

  const evidenceByRef = new Map<string, ObjectiveAuthoritySemanticEvidenceAliasBinding>();
  const evidence = [...grouped.values()].map((offer, index) => {
    const evidenceRef = `evidence_${index + 1}`;
    evidenceByRef.set(evidenceRef, {
      evidenceRef,
      sourceBlockId: offer.sourceBlockId,
      authorityRecordIds: [...offer.authorityRecordIds],
      authorityClaimIds: [...offer.authorityClaimIds],
    });
    return {
      evidenceRef,
      text: offer.text,
      claimKinds: [...offer.claimKinds],
      headingPath: [...offer.headingPath],
    };
  });
  return { evidence, evidenceByRef };
}

/**
 * Build one local scope per Curriculum objective. Only exact, bound, current,
 * blocking-eligible claim aliases enter provider-visible input.
 */
export function buildObjectiveAuthoritySemanticEvaluationScopes(
  input: BuildObjectiveAuthoritySemanticEvaluationScopesInput,
): ObjectiveAuthoritySemanticEvaluationScope[] {
  const authorityById = new Map(
    input.authorityBundles.map((bundle) => [bundle.record.id, bundle] as const),
  );
  const sourceBlockById = new Map(input.sourceBlocks.map((block) => [block.id, block] as const));
  const objectives = input.nodes.flatMap((node) => node.learningUnit?.objectives ?? []);
  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  for (const objectiveId of input.requiredCapabilityPreservationByObjectiveId?.keys() ?? []) {
    if (!objectiveIds.has(objectiveId)) {
      throw new Error(
        `Capability-preservation requirement references foreign objective ${objectiveId}.`,
      );
    }
  }
  return objectives.map((objective, objectiveIndex) => {
    if (!objective.formalAssessmentConstruct) {
      throw new Error(
        `Objective ${objective.id} has no explicit Formal Assessment construct for semantic evaluation.`,
      );
    }
    requireUnique(objective.truthAuthorityRecordIds, 'Authority binding', objective.id);
    const boundSourceBlockIds = deriveBoundSourceBlockIds(objective, authorityById);
    requireUnique(boundSourceBlockIds, 'Source-block binding', objective.id);
    const boundAuthorityClaimIds = [...(objective.authorityClaimIds ?? [])];
    requireUnique(boundAuthorityClaimIds, 'Authority-claim binding', objective.id);
    const objectiveRef = `objective_${objectiveIndex + 1}`;
    const proposition = curriculumObjectiveProposition(objective);
    const { evidence, evidenceByRef } = buildObjectiveEvidence(
      objective,
      boundSourceBlockIds,
      boundAuthorityClaimIds,
      authorityById,
      sourceBlockById,
      input.isBlockingEligible,
    );
    const materializedAuthorityClaimIds = uniqueInOrder(
      [...evidenceByRef.values()].flatMap((evidence) => evidence.authorityClaimIds),
    );
    if (!sameOrderedStrings(materializedAuthorityClaimIds, boundAuthorityClaimIds)) {
      throw new Error(
        `Objective ${objective.id} exact authority-claim binding cannot be materialized from current selected evidence.`,
      );
    }
    const objectiveInput = ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.parse({
      objectiveRef,
      proposition,
      construct: objective.formalAssessmentConstruct,
      evidence,
      ...(input.requiredCapabilityPreservationByObjectiveId?.get(objective.id)
        ? {
            requiredCapabilityPreservation: input.requiredCapabilityPreservationByObjectiveId.get(
              objective.id,
            ),
          }
        : {}),
    });
    return {
      input: objectiveInput,
      aliasBinding: {
        objectiveRef,
        objectiveId: objective.id,
        proposition,
        construct: objective.formalAssessmentConstruct,
        boundAuthorityRecordIds: [...objective.truthAuthorityRecordIds],
        boundSourceBlockIds,
        boundAuthorityClaimIds,
        evidenceByRef,
      },
    };
  });
}

export function partitionObjectiveAuthoritySemanticEvaluationScopes(
  scopes: readonly ObjectiveAuthoritySemanticEvaluationScope[],
  maxBatchSize = OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
): ObjectiveAuthoritySemanticEvaluationBatch[] {
  if (
    !Number.isInteger(maxBatchSize) ||
    maxBatchSize < 1 ||
    maxBatchSize > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH
  ) {
    throw new Error(
      `Objective-authority semantic batch size must be between 1 and ${OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH}.`,
    );
  }
  const batches: ObjectiveAuthoritySemanticEvaluationBatch[] = [];
  for (let index = 0; index < scopes.length; index += maxBatchSize) {
    const slice = scopes.slice(index, index + maxBatchSize);
    const batchInput = ObjectiveAuthoritySemanticEvaluationInputSchema.parse({
      schemaVersion: 1,
      policyVersion: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
      objectives: slice.map((scope) => scope.input),
    });
    batches.push({
      input: batchInput,
      aliasBindings: new Map(
        slice.map((scope) => [scope.input.objectiveRef, scope.aliasBinding] as const),
      ),
    });
  }
  return batches;
}

export function buildObjectiveAuthoritySemanticEvaluationBatches(
  input: BuildObjectiveAuthoritySemanticEvaluationScopesInput,
  maxBatchSize = OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH,
): ObjectiveAuthoritySemanticEvaluationBatch[] {
  return partitionObjectiveAuthoritySemanticEvaluationScopes(
    buildObjectiveAuthoritySemanticEvaluationScopes(input),
    maxBatchSize,
  );
}

/** Audit identity for provider-visible input plus ordered local claim aliases. */
export function objectiveAuthoritySemanticEvaluationSourceFingerprint(
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
): string {
  const bindings = batch.input.objectives.map((objective) => {
    const binding = batch.aliasBindings.get(objective.objectiveRef);
    if (!binding) {
      throw new Error(`Missing semantic-evaluation audit binding for ${objective.objectiveRef}.`);
    }
    return {
      objectiveRef: objective.objectiveRef,
      objectiveId: binding.objectiveId,
      construct: binding.construct,
      boundAuthorityRecordIds: binding.boundAuthorityRecordIds,
      boundSourceBlockIds: binding.boundSourceBlockIds,
      boundAuthorityClaimIds: binding.boundAuthorityClaimIds,
      evidence: objective.evidence.map((offer) => {
        const evidence = binding.evidenceByRef.get(offer.evidenceRef);
        if (!evidence) {
          throw new Error(
            `Missing semantic-evaluation evidence audit binding for ${offer.evidenceRef}.`,
          );
        }
        return {
          evidenceRef: offer.evidenceRef,
          sourceBlockId: evidence.sourceBlockId,
          authorityRecordIds: evidence.authorityRecordIds,
          authorityClaimIds: evidence.authorityClaimIds,
        };
      }),
    };
  });
  const digest = fingerprintObjectiveAuthorityAuditValue({ input: batch.input, bindings });
  return `objective_authority_${digest.slice(0, 40)}`;
}

function providerInput(
  input: ObjectiveAuthoritySemanticEvaluationInput | ObjectiveAuthoritySemanticEvaluationBatch,
): ObjectiveAuthoritySemanticEvaluationInput {
  return 'input' in input ? input.input : input;
}

const IDENTIFY_CORE = new Set<ObjectiveAuthoritySupportType>([
  'recognition',
  'discrimination',
  'definition',
]);
const EXPLAIN_CORE = new Set<ObjectiveAuthoritySupportType>([
  'relationship',
  'mechanism',
  'reason',
  'consequence',
  'comparison',
  'positioning',
]);
const APPLY_CORE = new Set<ObjectiveAuthoritySupportType>([
  'procedure',
  'decision_rule',
  'condition',
  'state_transition',
]);

function allowedSupportTypes(
  construct: FormalAssessmentConstruct,
): Set<ObjectiveAuthoritySupportType> {
  if (construct === 'identify') return new Set([...IDENTIFY_CORE, 'qualification']);
  if (construct === 'explain') {
    return new Set([...IDENTIFY_CORE, ...EXPLAIN_CORE, 'qualification']);
  }
  if (construct === 'apply') {
    return new Set([...IDENTIFY_CORE, ...EXPLAIN_CORE, ...APPLY_CORE, 'qualification']);
  }
  return new Set([...IDENTIFY_CORE, ...EXPLAIN_CORE, ...APPLY_CORE, 'qualification']);
}

function requiredCore(
  construct: FormalAssessmentConstruct,
): ReadonlySet<ObjectiveAuthoritySupportType> {
  if (construct === 'identify') return IDENTIFY_CORE;
  if (construct === 'explain') return EXPLAIN_CORE;
  if (construct === 'apply') return APPLY_CORE;
  return new Set();
}

function validateConstructMapping(
  evaluation: ObjectiveAuthoritySemanticObjectiveProposal,
  add: (code: string, message: string) => void,
): void {
  const supportedTypes = evaluation.fragments.flatMap((fragment) =>
    fragment.status === 'supported' && fragment.supportType ? [fragment.supportType] : [],
  );
  const allowed = allowedSupportTypes(evaluation.construct);
  if (supportedTypes.some((supportType) => !allowed.has(supportType))) {
    add(
      'semantic_support_type_construct_mismatch',
      `Objective ${evaluation.objectiveRef} maps a support type outside its fixed construct.`,
    );
  }
  if (evaluation.verdict !== 'pass') return;
  if (evaluation.construct === 'design' || evaluation.construct === 'evaluate') {
    add(
      'semantic_construct_prohibited_v1',
      `Objective ${evaluation.objectiveRef} cannot pass the v1 semantic-support policy at its construct.`,
    );
    return;
  }
  const core = requiredCore(evaluation.construct);
  if (!supportedTypes.some((supportType) => core.has(supportType))) {
    add(
      'semantic_construct_core_missing',
      `Objective ${evaluation.objectiveRef} has no construct-specific core support mapping.`,
    );
  }
}

function validateCapabilityPreservation(
  expected: ObjectiveAuthoritySemanticEvaluationObjectiveInput,
  evaluation: ObjectiveAuthoritySemanticObjectiveProposal,
  add: (code: string, message: string) => void,
): void {
  const requirement = expected.requiredCapabilityPreservation;
  const preservation = evaluation.capabilityPreservation;
  if (!requirement && preservation) {
    add(
      'semantic_capability_preservation_unexpected',
      `Objective ${expected.objectiveRef} supplied capability preservation without a local requirement.`,
    );
    return;
  }
  if (requirement && !preservation) {
    add(
      'semantic_capability_preservation_missing',
      `Objective ${expected.objectiveRef} omitted the required original-capability preservation result.`,
    );
    return;
  }
  if (!requirement || !preservation) return;

  if (preservation.originalProposition !== requirement.originalProposition) {
    add(
      'semantic_capability_original_proposition_mismatch',
      `Objective ${expected.objectiveRef} changed the original proposition during preservation evaluation.`,
    );
  }
  if (preservation.mappings.length !== requirement.originalFragments.length) {
    add(
      'semantic_capability_original_fragment_set_mismatch',
      `Objective ${expected.objectiveRef} did not map every original capability fragment exactly once.`,
    );
  }
  const count = Math.min(preservation.mappings.length, requirement.originalFragments.length);
  const repairedFragmentIds = new Set(evaluation.fragments.map((fragment) => fragment.fragmentId));
  const coveredRepairedFragmentIds = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const mapping = preservation.mappings[index]!;
    const original = requirement.originalFragments[index]!;
    if (
      mapping.originalFragmentId !== original.fragmentId ||
      mapping.originalText !== original.text
    ) {
      add(
        'semantic_capability_original_fragment_mismatch',
        `Objective ${expected.objectiveRef} changed or reordered original capability fragment ${index + 1}.`,
      );
    }
    for (const repairedFragmentId of mapping.repairedFragmentIds) {
      if (!repairedFragmentIds.has(repairedFragmentId)) {
        add(
          'semantic_capability_repaired_fragment_foreign',
          `Objective ${expected.objectiveRef} maps an original capability to an unknown repaired fragment.`,
        );
      } else {
        coveredRepairedFragmentIds.add(repairedFragmentId);
      }
    }
  }
  if (
    evaluation.fragments.some((fragment) => !coveredRepairedFragmentIds.has(fragment.fragmentId))
  ) {
    add(
      'semantic_capability_repaired_fragment_coverage_incomplete',
      `Objective ${expected.objectiveRef} does not account for every repaired proposition fragment.`,
    );
  }
}

/** Validate provider structure and provenance scope without pretending to judge entailment lexically. */
export function validateObjectiveAuthoritySemanticEvaluationProposal(
  input: ObjectiveAuthoritySemanticEvaluationInput | ObjectiveAuthoritySemanticEvaluationBatch,
  proposal: ObjectiveAuthoritySemanticEvaluationProposal | unknown,
): ProviderCandidateValidation {
  const diagnostics: string[] = [];
  const diagnosticCodes: string[] = [];
  const add = (code: string, message: string): void => {
    diagnostics.push(message);
    diagnosticCodes.push(code);
  };
  const parsedInput = ObjectiveAuthoritySemanticEvaluationInputSchema.safeParse(
    providerInput(input),
  );
  if (!parsedInput.success) {
    add('semantic_evaluation_input_invalid', 'Semantic evaluation input is locally invalid.');
    return { valid: false, diagnostics, diagnosticCodes };
  }
  const parsedProposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) {
    add(
      'semantic_evaluation_schema_invalid',
      'Semantic evaluation proposal is structurally invalid.',
    );
    return { valid: false, diagnostics, diagnosticCodes };
  }
  const expectedObjectives = parsedInput.data.objectives;
  const evaluations = parsedProposal.data.evaluations;
  const invalidObjectiveRefs = new Set<string>();
  const markInvalid = (expectedRef: string | undefined, actualRef?: string): void => {
    if (expectedRef) invalidObjectiveRefs.add(expectedRef);
    if (actualRef) invalidObjectiveRefs.add(actualRef);
  };
  if (evaluations.length !== expectedObjectives.length) {
    add(
      'semantic_objective_set_mismatch',
      'Semantic evaluation proposal does not preserve the exact objective set.',
    );
    expectedObjectives
      .slice(evaluations.length)
      .forEach((objective) => markInvalid(objective.objectiveRef));
    evaluations.slice(expectedObjectives.length).forEach((evaluation) => {
      markInvalid(undefined, evaluation.objectiveRef);
    });
  }
  const count = Math.min(evaluations.length, expectedObjectives.length);
  for (let index = 0; index < count; index += 1) {
    const expected = expectedObjectives[index]!;
    const evaluation = evaluations[index]!;
    const addObjective = (code: string, message: string): void => {
      markInvalid(expected.objectiveRef, evaluation.objectiveRef);
      add(code, message);
    };
    if (evaluation.objectiveRef !== expected.objectiveRef) {
      addObjective(
        'semantic_objective_ref_mismatch',
        `Semantic evaluation changed objective identity at position ${index + 1}.`,
      );
    }
    if (evaluation.proposition !== expected.proposition) {
      addObjective(
        'semantic_proposition_mismatch',
        `Semantic evaluation changed the proposition for ${expected.objectiveRef}.`,
      );
    }
    if (evaluation.construct !== expected.construct) {
      addObjective(
        'semantic_construct_mismatch',
        `Semantic evaluation changed the construct for ${expected.objectiveRef}.`,
      );
    }
    if (evaluation.fragments.map((fragment) => fragment.text).join('') !== expected.proposition) {
      addObjective(
        'semantic_fragment_partition_incomplete',
        `Semantic fragments do not exactly partition ${expected.objectiveRef}.`,
      );
    }
    const fragmentIds = new Set(evaluation.fragments.map((fragment) => fragment.fragmentId));
    const allowedEvidenceRefs = new Set(expected.evidence.map((offer) => offer.evidenceRef));
    for (const fragment of evaluation.fragments) {
      if (fragment.status === 'unsupported') {
        if (fragment.supportType !== null || fragment.evidenceRefs.length > 0) {
          addObjective(
            'semantic_unsupported_mapping_invalid',
            `Unsupported fragment ${fragment.fragmentId} must not claim support or evidence.`,
          );
        }
      } else if (fragment.status === 'conflicted') {
        if (fragment.supportType !== null) {
          addObjective(
            'semantic_conflicted_mapping_invalid',
            `Conflicted fragment ${fragment.fragmentId} must not claim a support type.`,
          );
        }
      } else if (fragment.supportType === null || fragment.evidenceRefs.length === 0) {
        addObjective(
          'semantic_supported_mapping_incomplete',
          `Supported fragment ${fragment.fragmentId} lacks a support type or evidence.`,
        );
      }
      if (fragment.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef))) {
        addObjective(
          'semantic_unbound_evidence_ref',
          `Fragment ${fragment.fragmentId} cites evidence outside ${expected.objectiveRef}.`,
        );
      }
    }
    for (const row of [...evaluation.conflicts, ...evaluation.overreach]) {
      if (row.fragmentIds.some((fragmentId) => !fragmentIds.has(fragmentId))) {
        addObjective(
          'semantic_unknown_fragment_ref',
          `A semantic finding for ${expected.objectiveRef} cites an unknown fragment.`,
        );
      }
      if (row.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef))) {
        addObjective(
          'semantic_unbound_evidence_ref',
          `A semantic finding for ${expected.objectiveRef} cites unbound evidence.`,
        );
      }
    }
    validateCapabilityPreservation(expected, evaluation, addObjective);
    validateConstructMapping(evaluation, addObjective);
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, 100),
    diagnosticCodes: diagnosticCodes.slice(0, 100),
    ...(invalidObjectiveRefs.size > 0
      ? { targetedRepair: { invalidItemIds: [...invalidObjectiveRefs] } }
      : {}),
  };
}

function mapEvidenceRefs(
  evidenceRefs: readonly string[],
  binding: ObjectiveAuthoritySemanticObjectiveAliasBinding,
): { sourceBlockIds: string[]; authorityRecordIds: string[]; authorityClaimIds: string[] } {
  const mappings = evidenceRefs.map((evidenceRef) => {
    const mapping = binding.evidenceByRef.get(evidenceRef);
    if (!mapping) {
      throw new Error(
        `Semantic evaluation cites evidence outside objective scope: ${binding.objectiveRef}.`,
      );
    }
    return mapping;
  });
  return {
    sourceBlockIds: uniqueInOrder(mappings.map((mapping) => mapping.sourceBlockId)),
    authorityRecordIds: uniqueInOrder(mappings.flatMap((mapping) => mapping.authorityRecordIds)),
    authorityClaimIds: uniqueInOrder(mappings.flatMap((mapping) => mapping.authorityClaimIds)),
  };
}

export function materializeObjectiveAuthoritySemanticSupport(
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
  proposal: ObjectiveAuthoritySemanticEvaluationProposal,
  metadata: MaterializeObjectiveAuthoritySemanticSupportMetadata,
): Map<string, ObjectiveAuthoritySemanticSupport> {
  const validation = validateObjectiveAuthoritySemanticEvaluationProposal(batch, proposal);
  if (!validation.valid) {
    throw new Error(`Semantic evaluation proposal is invalid: ${validation.diagnostics.join(' ')}`);
  }
  const parsedProposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse(proposal);
  const result = new Map<string, ObjectiveAuthoritySemanticSupport>();
  for (const evaluation of parsedProposal.evaluations) {
    const binding = batch.aliasBindings.get(evaluation.objectiveRef);
    if (!binding) {
      throw new Error(`Missing local alias binding for ${evaluation.objectiveRef}.`);
    }
    const fragments = evaluation.fragments.map((fragment) => ({
      fragmentId: fragment.fragmentId,
      text: fragment.text,
      status: fragment.status,
      supportType: fragment.supportType,
      ...mapEvidenceRefs(fragment.evidenceRefs, binding),
      rationale: fragment.rationale,
    }));
    const conflicts = evaluation.conflicts.map((conflict) => ({
      kind: conflict.kind,
      fragmentIds: [...conflict.fragmentIds],
      ...mapEvidenceRefs(conflict.evidenceRefs, binding),
      rationale: conflict.rationale,
    }));
    const overreach = evaluation.overreach.map((item) => ({
      kind: item.kind,
      fragmentIds: [...item.fragmentIds],
      ...mapEvidenceRefs(item.evidenceRefs, binding),
      rationale: item.rationale,
    }));
    const artifact = ObjectiveAuthoritySemanticSupportSchema.parse({
      schemaVersion: 1,
      policyVersion: batch.input.policyVersion,
      evaluator: metadata.evaluator,
      provider: metadata.provider,
      providerModel: metadata.providerModel,
      independent: true,
      objectiveId: binding.objectiveId,
      proposition: binding.proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(binding.proposition),
      construct: binding.construct,
      boundAuthorityRecordIds: [...binding.boundAuthorityRecordIds],
      boundSourceBlockIds: [...binding.boundSourceBlockIds],
      boundAuthorityClaimIds: [...binding.boundAuthorityClaimIds],
      bindingFingerprint: fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: binding.boundAuthorityRecordIds,
        sourceBlockIds: binding.boundSourceBlockIds,
        authorityClaimIds: binding.boundAuthorityClaimIds,
      }),
      fragments,
      unsupportedFragmentIds: [...evaluation.unsupportedFragmentIds],
      conflicts,
      overreach,
      ...(evaluation.capabilityPreservation
        ? {
            capabilityPreservation: {
              originalProposition: evaluation.capabilityPreservation.originalProposition,
              originalPropositionFingerprint: fingerprintObjectiveAuthorityProposition(
                evaluation.capabilityPreservation.originalProposition,
              ),
              mappings: evaluation.capabilityPreservation.mappings.map((mapping) => ({
                ...mapping,
                repairedFragmentIds: [...mapping.repairedFragmentIds],
              })),
              lostOriginalFragmentIds: [
                ...evaluation.capabilityPreservation.lostOriginalFragmentIds,
              ],
              verdict: evaluation.capabilityPreservation.verdict,
              rationale: evaluation.capabilityPreservation.rationale,
              ...(metadata.recoveryOriginByObjectiveId?.has(binding.objectiveId)
                ? {
                    recoveryOrigin: metadata.recoveryOriginByObjectiveId.get(binding.objectiveId),
                  }
                : {}),
            },
          }
        : {}),
      verdict: evaluation.verdict,
      rationale: evaluation.rationale,
      evaluatedAt: metadata.evaluatedAt,
    });
    if (result.has(binding.objectiveId)) {
      throw new Error(`Duplicate persisted semantic support for objective ${binding.objectiveId}.`);
    }
    result.set(binding.objectiveId, artifact);
  }
  return result;
}

export function attachObjectiveAuthoritySemanticSupport(
  nodes: CurriculumNode[],
  supportByObjectiveId: ReadonlyMap<string, ObjectiveAuthoritySemanticSupport>,
): CurriculumNode[] {
  return nodes.map((node) => {
    if (!node.learningUnit) return { ...node };
    return {
      ...node,
      learningUnit: {
        ...node.learningUnit,
        objectives: node.learningUnit.objectives.map((objective) => {
          const semanticSupport =
            supportByObjectiveId.get(objective.id) ?? objective.semanticSupport;
          const clone: CurriculumObjective = {
            ...objective,
            ...(semanticSupport ? { semanticSupport } : {}),
          };
          if (objective.priority === 'required' || objective.formalAssessmentReady !== undefined) {
            clone.formalAssessmentReady =
              objective.formalAssessmentReady === true && semanticSupport?.verdict === 'pass';
          }
          return clone;
        }),
      },
    };
  });
}

function validatePersistedConstructMapping(
  artifact: ObjectiveAuthoritySemanticSupport,
  objectiveId: string,
  add: (code: string, message: string) => void,
): void {
  const supportedTypes = artifact.fragments.flatMap((fragment) =>
    fragment.status === 'supported' && fragment.supportType ? [fragment.supportType] : [],
  );
  if (artifact.construct === 'design' || artifact.construct === 'evaluate') {
    add(
      'semantic_construct_prohibited_v1',
      `Objective ${objectiveId} uses a construct prohibited by the v1 semantic-support gate.`,
    );
    return;
  }
  const allowed = allowedSupportTypes(artifact.construct);
  if (supportedTypes.some((supportType) => !allowed.has(supportType))) {
    add(
      'semantic_support_type_construct_mismatch',
      `Objective ${objectiveId} has a support type outside its fixed construct.`,
    );
  }
  const core = requiredCore(artifact.construct);
  if (!supportedTypes.some((supportType) => core.has(supportType))) {
    add(
      'semantic_construct_core_missing',
      `Objective ${objectiveId} has no construct-specific core support mapping.`,
    );
  }
}

function validateCurriculumObjectiveAuthoritySemanticSupportScope(
  curriculum: Curriculum,
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions = {},
  objectiveScope: ReadonlySet<CurriculumObjective> | null = null,
): ProviderCandidateValidation {
  const diagnostics: string[] = [];
  const diagnosticCodes: string[] = [];
  const add = (code: string, message: string): void => {
    diagnostics.push(message);
    diagnosticCodes.push(code);
  };
  for (const node of curriculum.nodes) {
    for (const objective of node.learningUnit?.objectives ?? []) {
      if (objectiveScope && !objectiveScope.has(objective)) continue;
      const proposition = curriculumObjectiveProposition(objective);
      if (!objective.formalAssessmentConstruct) {
        add(
          'semantic_construct_missing',
          `Objective ${objective.id} has no explicit assessment construct.`,
        );
      }
      if (objective.authoritySourceBlockIds === undefined) {
        add(
          'semantic_exact_block_binding_missing',
          `Objective ${objective.id} has no explicit exact source-block binding.`,
        );
      }
      if (objective.priority === 'required' && objective.formalAssessmentReady !== true) {
        add(
          'semantic_required_objective_not_ready',
          `Required objective ${objective.id} is not Formal-ready.`,
        );
      }
      const exactAuthoritySourceBlockIds = objective.authoritySourceBlockIds ?? [];
      const formalEvidenceSourceBlockIds = objective.formalEvidenceSourceBlockIds ?? [];
      const hasFormalAuthority =
        objective.formalAssessmentReady === true || formalEvidenceSourceBlockIds.length > 0;
      if (
        hasFormalAuthority &&
        (formalEvidenceSourceBlockIds.length === 0 ||
          !sameOrderedStrings(exactAuthoritySourceBlockIds, formalEvidenceSourceBlockIds))
      ) {
        add(
          'semantic_formal_authority_envelope_mismatch',
          `Objective ${objective.id} does not use one exact source-block envelope for semantic support, teaching, and Formal evidence.`,
        );
      }
      const parsed = ObjectiveAuthoritySemanticSupportSchema.safeParse(objective.semanticSupport);
      if (!parsed.success) {
        add(
          objective.semanticSupport ? 'semantic_support_malformed' : 'semantic_support_missing',
          `Objective ${objective.id} has no valid semantic-support artifact.`,
        );
        continue;
      }
      const artifact = parsed.data;
      if (artifact.policyVersion !== OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY) {
        add(
          'semantic_policy_stale',
          `Objective ${objective.id} uses a stale semantic-support policy.`,
        );
      }
      if (artifact.objectiveId !== objective.id) {
        add(
          'semantic_objective_identity_mismatch',
          `Objective ${objective.id} has a foreign semantic-support identity.`,
        );
      }
      if (artifact.proposition !== proposition) {
        add(
          'semantic_proposition_mismatch',
          `Objective ${objective.id} changed after semantic evaluation.`,
        );
      }
      if (
        artifact.propositionFingerprint !== fingerprintObjectiveAuthorityProposition(proposition)
      ) {
        add(
          'semantic_proposition_fingerprint_mismatch',
          `Objective ${objective.id} has a stale proposition fingerprint.`,
        );
      }
      if (
        !objective.formalAssessmentConstruct ||
        artifact.construct !== objective.formalAssessmentConstruct
      ) {
        add(
          'semantic_construct_mismatch',
          `Objective ${objective.id} changed construct after semantic evaluation.`,
        );
      }
      if (
        !sameOrderedStrings(artifact.boundAuthorityRecordIds, objective.truthAuthorityRecordIds)
      ) {
        add(
          'semantic_authority_binding_mismatch',
          `Objective ${objective.id} changed authority-record binding after evaluation.`,
        );
      }
      const expectedSourceBlockIds = exactAuthoritySourceBlockIds;
      if (!sameOrderedStrings(artifact.boundSourceBlockIds, expectedSourceBlockIds)) {
        add(
          'semantic_source_binding_mismatch',
          `Objective ${objective.id} changed exact source-block binding after evaluation.`,
        );
      }
      const expectedAuthorityClaimIds = objective.authorityClaimIds;
      if (!expectedAuthorityClaimIds) {
        add(
          'semantic_claim_binding_missing',
          `Objective ${objective.id} has no exact authority-claim identities for semantic support.`,
        );
      } else if (!sameOrderedStrings(artifact.boundAuthorityClaimIds, expectedAuthorityClaimIds)) {
        add(
          'semantic_claim_binding_mismatch',
          `Objective ${objective.id} changed exact authority-claim binding after evaluation.`,
        );
      }
      if (
        artifact.bindingFingerprint !==
        fingerprintObjectiveAuthorityBinding({
          authorityRecordIds: objective.truthAuthorityRecordIds,
          sourceBlockIds: expectedSourceBlockIds,
          authorityClaimIds: expectedAuthorityClaimIds ?? [],
        })
      ) {
        add(
          'semantic_binding_fingerprint_mismatch',
          `Objective ${objective.id} has a stale authority-binding fingerprint.`,
        );
      }
      if (artifact.fragments.map((fragment) => fragment.text).join('') !== proposition) {
        add(
          'semantic_fragment_partition_incomplete',
          `Objective ${objective.id} does not retain an exact proposition partition.`,
        );
      }
      const preservation = artifact.capabilityPreservation;
      if (preservation) {
        if (
          preservation.originalPropositionFingerprint !==
          fingerprintObjectiveAuthorityProposition(preservation.originalProposition)
        ) {
          add(
            'semantic_capability_original_fingerprint_mismatch',
            `Objective ${objective.id} has a stale original-capability fingerprint.`,
          );
        }
        if (
          preservation.mappings.map((mapping) => mapping.originalText).join('') !==
          preservation.originalProposition
        ) {
          add(
            'semantic_capability_original_partition_incomplete',
            `Objective ${objective.id} does not retain an exact original-capability partition.`,
          );
        }
        const repairedFragmentIds = new Set(
          artifact.fragments.map((fragment) => fragment.fragmentId),
        );
        const coveredRepairedFragmentIds = new Set<string>();
        for (const mapping of preservation.mappings) {
          for (const repairedFragmentId of mapping.repairedFragmentIds) {
            if (!repairedFragmentIds.has(repairedFragmentId)) {
              add(
                'semantic_capability_repaired_fragment_foreign',
                `Objective ${objective.id} retains a preservation mapping to an unknown repaired fragment.`,
              );
            } else {
              coveredRepairedFragmentIds.add(repairedFragmentId);
            }
          }
        }
        if (
          artifact.fragments.some(
            (fragment) => !coveredRepairedFragmentIds.has(fragment.fragmentId),
          )
        ) {
          add(
            'semantic_capability_repaired_fragment_coverage_incomplete',
            `Objective ${objective.id} does not retain preservation coverage for every repaired fragment.`,
          );
        }
        if (preservation.verdict !== 'pass') {
          add(
            'semantic_capability_preservation_failed',
            `Objective ${objective.id} lost part of its original learning capability during repair.`,
          );
        }
      }
      const boundRecordIds = new Set(artifact.boundAuthorityRecordIds);
      const boundSourceBlockIds = new Set(artifact.boundSourceBlockIds);
      const boundClaimIds = new Set(artifact.boundAuthorityClaimIds);
      const mappings = [...artifact.fragments, ...artifact.conflicts, ...artifact.overreach];
      if (
        mappings.some(
          (mapping) =>
            mapping.authorityRecordIds.some((id) => !boundRecordIds.has(id)) ||
            mapping.sourceBlockIds.some((id) => !boundSourceBlockIds.has(id)) ||
            mapping.authorityClaimIds.some((id) => !boundClaimIds.has(id)),
        )
      ) {
        add(
          'semantic_mapping_outside_binding',
          `Objective ${objective.id} maps semantic support outside its exact binding.`,
        );
      }
      if (artifact.verdict !== 'pass') {
        add(
          'semantic_support_failed',
          `Objective ${objective.id} did not pass objective-authority semantic support.`,
        );
      } else {
        validatePersistedConstructMapping(artifact, objective.id, add);
      }
      if (options.isBlockingEligible) {
        for (const authorityRecordId of objective.truthAuthorityRecordIds) {
          if (!options.isBlockingEligible(authorityRecordId)) {
            add(
              'semantic_authority_not_blocking_eligible',
              `Objective ${objective.id} references authority that is no longer blocking-eligible.`,
            );
          }
        }
      }
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.slice(0, 200),
    diagnosticCodes: diagnosticCodes.slice(0, 200),
  };
}

/** Canonical semantic-support rules for an explicit deterministic objective scope. */
export function validateObjectiveAuthoritySemanticSupport(
  curriculum: Curriculum,
  objectives: readonly CurriculumObjective[],
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions = {},
): ProviderCandidateValidation {
  return validateCurriculumObjectiveAuthoritySemanticSupportScope(
    curriculum,
    options,
    new Set(objectives),
  );
}

/** Defensive whole-Curriculum gate for proposal, acceptance, planning, and activation. */
export function validateCurriculumObjectiveAuthoritySemanticSupport(
  curriculum: Curriculum,
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions = {},
): ProviderCandidateValidation {
  return validateCurriculumObjectiveAuthoritySemanticSupportScope(curriculum, options);
}

export class CurriculumObjectiveAuthoritySemanticSupportError extends Error {
  readonly diagnostics: string[];
  readonly diagnosticCodes: string[];

  constructor(validation: ProviderCandidateValidation) {
    super(
      `Curriculum objective authority is not semantically supported: ${validation.diagnostics.join(' ')}`,
    );
    this.name = 'CurriculumObjectiveAuthoritySemanticSupportError';
    this.diagnostics = [...validation.diagnostics];
    this.diagnosticCodes = [...(validation.diagnosticCodes ?? [])];
  }
}

export function assertCurriculumObjectiveAuthoritySemanticSupport(
  curriculum: Curriculum,
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions = {},
): void {
  const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum, options);
  if (!validation.valid) throw new CurriculumObjectiveAuthoritySemanticSupportError(validation);
}

/** Translate the one canonical validator into a safe service-boundary error. */
export function assertCurrentCurriculumObjectiveAuthoritySemanticSupport(
  curriculum: Curriculum,
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions & {
    boundary: 'proposal' | 'acceptance' | 'study_plan' | 'route_activation';
  },
): void {
  const validation = validateCurriculumObjectiveAuthoritySemanticSupport(curriculum, options);
  assertCurrentObjectiveAuthoritySemanticSupportValidation(validation, options.boundary);
}

/** Validate all and only the objectives bound to the exact active Lesson route. */
export function assertCurrentLessonObjectiveAuthoritySemanticSupport(
  curriculum: Curriculum,
  objectives: readonly CurriculumObjective[],
  options: ValidateCurriculumObjectiveAuthoritySemanticSupportOptions,
): void {
  const validation = validateObjectiveAuthoritySemanticSupport(curriculum, objectives, options);
  assertCurrentObjectiveAuthoritySemanticSupportValidation(validation, 'lesson_provider');
}

function assertCurrentObjectiveAuthoritySemanticSupportValidation(
  validation: ProviderCandidateValidation,
  boundary: 'proposal' | 'acceptance' | 'study_plan' | 'route_activation' | 'lesson_provider',
): void {
  if (validation.valid) return;
  throw new AppError(
    ApiErrorCode.ValidationError,
    'Curriculum objective authority is not semantically supported for this operation.',
    {
      kind: 'objective_authority_semantic_support_invalid',
      boundary,
      diagnosticCodes: (validation.diagnosticCodes ?? []).slice(0, 50),
      diagnostics: validation.diagnostics.slice(0, 20),
    },
  );
}
