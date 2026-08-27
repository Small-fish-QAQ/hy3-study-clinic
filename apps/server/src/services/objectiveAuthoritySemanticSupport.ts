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
  type CurriculumSubjectClass,
  type FormalAssessmentConstruct,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticEvaluationObjectiveInput,
  type ObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticObjectiveProposal,
  type ObjectiveAuthoritySemanticPersistedCandidate,
  type ObjectiveAuthoritySemanticPersistedSupportGroup,
  type ObjectiveAuthorityCapabilityRecoveryOrigin,
  type ObjectiveAuthorityRequiredCapabilityPreservation,
  type ObjectiveAuthoritySemanticSupport,
  type ObjectiveAuthoritySupportType,
  type SourceAuthorityBundle,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { AppError } from '../errors.js';
import type { CurriculumEvidenceOffer, ProviderCandidateValidation } from '../llm/provider.js';

export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_V1_POLICY =
  'objective-authority-semantic-support-v1';
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY =
  'objective-authority-semantic-support-v2';
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_ACCEPTED_POLICIES = new Set([
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_V1_POLICY,
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
]);
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_BATCH = 24;
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_CANDIDATES = 12;
/** Eight fixed evaluator batches; detail generation must stay below this before evaluation. */
export const OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_OBJECTIVES = 192;

export interface ObjectiveAuthoritySemanticEvidenceAliasBinding {
  evidenceRef: string;
  evidenceId: string;
  candidateIndex: number;
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
  boundEvidenceRefs: string[];
  totalCandidateCount: number;
  candidateWindowTruncated: boolean;
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
  evidenceCatalog: readonly CurriculumEvidenceOffer[];
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
  /** Deterministic orchestration observations retained only for audit/telemetry. */
  localValidationDiagnosticCodesByObjectiveId?: ReadonlyMap<string, readonly string[]> | undefined;
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

/** Generator metadata and blind evaluator attestation must agree before local relaxation. */
export function deriveEffectiveObjectiveSubjectClass(
  objective: Pick<CurriculumObjective, 'subjectClass'>,
  semanticSupport:
    Partial<Pick<ObjectiveAuthoritySemanticSupport, 'subjectDependency'>> | null | undefined,
): CurriculumSubjectClass {
  return objective.subjectClass === 'general' &&
    semanticSupport?.subjectDependency === 'general_sufficient'
    ? 'general'
    : 'source_specific';
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
  evidenceId: string;
  startOffset: number;
  endOffset: number;
  documentPosition: number;
  text: string;
  claimKinds: ObjectiveAuthoritySemanticEvaluationObjectiveInput['candidates'][number]['claimKinds'];
  headingPath: string[];
  sourceBlockId: string;
  authorityRecordIds: string[];
  authorityClaimIds: string[];
}

function buildEligibleCandidates(
  evidenceCatalog: readonly CurriculumEvidenceOffer[],
  authorityById: ReadonlyMap<string, SourceAuthorityBundle>,
  sourceBlockById: ReadonlyMap<string, SourceBlock>,
  sourceBlockPositionById: ReadonlyMap<string, number>,
  isBlockingEligible: (authorityRecordId: string) => boolean,
): MutableEvidenceOffer[] {
  const grouped = new Map<string, MutableEvidenceOffer>();
  for (const offer of evidenceCatalog) {
    const block = sourceBlockById.get(offer.blockId);
    if (
      !block ||
      (block.contentOrigin !== undefined &&
        block.contentOrigin !== null &&
        block.contentOrigin !== 'extracted_original') ||
      block.materialId !== offer.materialId ||
      block.materialRevisionId !== offer.materialRevisionId ||
      offer.startOffset < 0 ||
      offer.endOffset > block.content.length ||
      block.content.slice(offer.startOffset, offer.endOffset) !== offer.quote
    ) {
      continue;
    }
    const key = `${offer.blockId}\u0000${offer.startOffset}\u0000${offer.endOffset}\u0000${offer.quote}`;
    const current: MutableEvidenceOffer = grouped.get(key) ?? {
      evidenceId: offer.id,
      startOffset: offer.startOffset,
      endOffset: offer.endOffset,
      documentPosition: sourceBlockPositionById.get(offer.blockId) ?? Number.MAX_SAFE_INTEGER,
      text: offer.quote,
      claimKinds: [],
      headingPath: [...block.headingPath],
      sourceBlockId: offer.blockId,
      authorityRecordIds: [],
      authorityClaimIds: [],
    };
    for (const [authorityRecordId, bundle] of authorityById) {
      const record = bundle.record;
      if (
        record.validationState !== 'validated' ||
        record.conflictState === 'unresolved' ||
        record.materialId !== offer.materialId ||
        record.materialRevisionId !== offer.materialRevisionId ||
        !isBlockingEligible(authorityRecordId)
      ) {
        continue;
      }
      const exactClaims = bundle.claims.filter(
        (claim) =>
          claim.sourceBlockId === offer.blockId &&
          claim.startOffset === offer.startOffset &&
          claim.endOffset === offer.endOffset &&
          claim.quote === offer.quote &&
          block.content.slice(claim.startOffset, claim.endOffset) === claim.quote,
      );
      if (exactClaims.length === 0) continue;
      const premiseKind = record.policyBasis.premiseKind;
      if (!current.claimKinds.includes(premiseKind)) current.claimKinds.push(premiseKind);
      if (!current.authorityRecordIds.includes(authorityRecordId)) {
        current.authorityRecordIds.push(authorityRecordId);
      }
      for (const claim of exactClaims) {
        if (!current.authorityClaimIds.includes(claim.id)) current.authorityClaimIds.push(claim.id);
      }
    }
    if (current.authorityClaimIds.length > 0) grouped.set(key, current);
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.documentPosition - right.documentPosition ||
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset ||
      left.evidenceId.localeCompare(right.evidenceId),
  );
}

function serializeCandidateWindow(
  candidates: readonly MutableEvidenceOffer[],
  boundAuthorityClaimIds: readonly string[],
): {
  candidates: ObjectiveAuthoritySemanticEvaluationObjectiveInput['candidates'];
  evidenceByRef: Map<string, ObjectiveAuthoritySemanticEvidenceAliasBinding>;
  boundEvidenceRefs: string[];
  truncated: boolean;
} {
  const boundClaimIds = new Set(boundAuthorityClaimIds);
  const boundCandidates = candidates.filter((candidate) =>
    candidate.authorityClaimIds.some((claimId) => boundClaimIds.has(claimId)),
  );
  if (boundCandidates.length > OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_CANDIDATES) {
    throw new Error('Objective bound evidence exceeds the semantic candidate-window limit.');
  }
  const retained =
    candidates.length <= OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_CANDIDATES
      ? [...candidates]
      : [
          ...boundCandidates,
          ...candidates
            .filter((candidate) => !boundCandidates.includes(candidate))
            .slice(0, OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_MAX_CANDIDATES - boundCandidates.length),
        ].sort(
          (left, right) =>
            left.documentPosition - right.documentPosition ||
            left.startOffset - right.startOffset ||
            left.endOffset - right.endOffset ||
            left.evidenceId.localeCompare(right.evidenceId),
        );
  const evidenceByRef = new Map<string, ObjectiveAuthoritySemanticEvidenceAliasBinding>();
  const boundEvidenceRefs: string[] = [];
  const serialized = retained.map((offer, index) => {
    const evidenceRef = `evidence_${index + 1}`;
    const bound = offer.authorityClaimIds.some((claimId) => boundClaimIds.has(claimId));
    if (bound) boundEvidenceRefs.push(evidenceRef);
    evidenceByRef.set(evidenceRef, {
      evidenceRef,
      evidenceId: offer.evidenceId,
      candidateIndex: index,
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
  return {
    candidates: serialized,
    evidenceByRef,
    boundEvidenceRefs,
    truncated: candidates.length > retained.length,
  };
}

/**
 * Build one local scope per Curriculum objective. Exact current candidates
 * come from the bound set plus the LearningUnit envelope; binding stays local.
 */
export function buildObjectiveAuthoritySemanticEvaluationScopes(
  input: BuildObjectiveAuthoritySemanticEvaluationScopesInput,
): ObjectiveAuthoritySemanticEvaluationScope[] {
  const authorityById = new Map(
    input.authorityBundles.map((bundle) => [bundle.record.id, bundle] as const),
  );
  const sourceBlockById = new Map(input.sourceBlocks.map((block) => [block.id, block] as const));
  const sourceBlockPositionById = new Map(
    input.sourceBlocks.map((block, index) => [block.id, index] as const),
  );
  const eligibleCandidates = buildEligibleCandidates(
    input.evidenceCatalog,
    authorityById,
    sourceBlockById,
    sourceBlockPositionById,
    input.isBlockingEligible,
  );
  const objectiveLocations = input.nodes.flatMap((node) =>
    (node.learningUnit?.objectives ?? []).map((objective) => ({ node, objective })),
  );
  const objectives = objectiveLocations.map((location) => location.objective);
  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  for (const objectiveId of input.requiredCapabilityPreservationByObjectiveId?.keys() ?? []) {
    if (!objectiveIds.has(objectiveId)) {
      throw new Error(
        `Capability-preservation requirement references foreign objective ${objectiveId}.`,
      );
    }
  }
  return objectiveLocations.map(({ node, objective }, objectiveIndex) => {
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
    const unitSourceBlockIds = new Set(
      node.sourceReferences.flatMap((reference) =>
        reference.sourceBlockId ? [reference.sourceBlockId] : [],
      ),
    );
    const boundClaimIds = new Set(boundAuthorityClaimIds);
    const candidateUniverse = eligibleCandidates.filter(
      (candidate) =>
        unitSourceBlockIds.has(candidate.sourceBlockId) ||
        candidate.authorityClaimIds.some((claimId) => boundClaimIds.has(claimId)),
    );
    const { candidates, evidenceByRef, boundEvidenceRefs, truncated } = serializeCandidateWindow(
      candidateUniverse,
      boundAuthorityClaimIds,
    );
    const materializedBoundClaimIds = new Set(
      [...evidenceByRef.values()]
        .filter((evidence) => boundEvidenceRefs.includes(evidence.evidenceRef))
        .flatMap((evidence) => evidence.authorityClaimIds),
    );
    if (boundAuthorityClaimIds.some((claimId) => !materializedBoundClaimIds.has(claimId))) {
      throw new Error(
        `Objective ${objective.id} exact authority-claim binding cannot be materialized from current selected evidence.`,
      );
    }
    const objectiveInput = ObjectiveAuthoritySemanticEvaluationObjectiveInputSchema.parse({
      objectiveRef,
      proposition,
      construct: objective.formalAssessmentConstruct,
      candidates,
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
        boundEvidenceRefs,
        totalCandidateCount: candidateUniverse.length,
        candidateWindowTruncated: truncated,
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
      schemaVersion: 2,
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
      candidates: objective.candidates.map((offer) => {
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

export interface ObjectiveAuthoritySemanticLocalDerivation {
  anchorValid: boolean;
  coverage: boolean;
  bindingMatch: boolean;
  misBinding: boolean;
  coreValid: boolean;
  contradiction: boolean;
  verdict: 'pass' | 'fail';
}

function isV1SemanticSupport(
  artifact: ObjectiveAuthoritySemanticSupport,
): artifact is Extract<ObjectiveAuthoritySemanticSupport, { schemaVersion: 1 }> {
  return artifact.schemaVersion === 1;
}

function persistedCandidateIsBound(
  candidate: ObjectiveAuthoritySemanticPersistedCandidate,
  artifact: Extract<ObjectiveAuthoritySemanticSupport, { schemaVersion: 2 }>,
): boolean {
  const boundSourceBlockIds = new Set(artifact.boundSourceBlockIds);
  const boundAuthorityClaimIds = new Set(artifact.boundAuthorityClaimIds);
  return (
    boundSourceBlockIds.has(candidate.sourceBlockId) &&
    candidate.authorityClaimIds.some((id) => boundAuthorityClaimIds.has(id))
  );
}

export function deriveObjectiveAuthoritySemanticSupportV2(
  artifact: Extract<ObjectiveAuthoritySemanticSupport, { schemaVersion: 2 }>,
): ObjectiveAuthoritySemanticLocalDerivation {
  const boundCandidateIndexes = new Set(
    artifact.candidateLabels
      .filter((candidate) => persistedCandidateIsBound(candidate, artifact))
      .map((candidate) => candidate.candidateIndex),
  );
  const boundSatisfiedGroups = artifact.supportGroups.filter((group) =>
    group.candidateIndexes.every((candidateIndex) => boundCandidateIndexes.has(candidateIndex)),
  );
  const anchorValid = artifact.candidateLabels.some(
    (candidate) =>
      boundCandidateIndexes.has(candidate.candidateIndex) && candidate.relation === 'relevant',
  );
  const coverage = artifact.supportGroups.length > 0;
  const bindingMatch = boundSatisfiedGroups.length > 0;
  const core = requiredCore(artifact.construct);
  const coreValid = boundSatisfiedGroups.some((group) => core.has(group.supportType));
  const contradiction = artifact.candidateLabels.some(
    (candidate) =>
      boundCandidateIndexes.has(candidate.candidateIndex) &&
      candidate.relation === 'contradicts_claim',
  );
  const capabilityPreserved = artifact.capabilityPreservation?.verdict !== 'fail';
  const verdict =
    bindingMatch && !contradiction && coreValid && capabilityPreserved ? 'pass' : 'fail';
  return {
    anchorValid,
    coverage,
    bindingMatch,
    misBinding: coverage && !bindingMatch,
    coreValid,
    contradiction,
    verdict,
  };
}

export function objectiveAuthoritySemanticallySupportedClaimIds(
  artifact: ObjectiveAuthoritySemanticSupport,
): string[] {
  if (isV1SemanticSupport(artifact)) {
    return uniqueInOrder(
      artifact.fragments
        .filter((fragment) => fragment.status === 'supported')
        .flatMap((fragment) => fragment.authorityClaimIds),
    );
  }
  const candidateByIndex = new Map(
    artifact.candidateLabels.map((candidate) => [candidate.candidateIndex, candidate] as const),
  );
  const boundGroups = artifact.supportGroups.filter((group) =>
    group.candidateIndexes.every((candidateIndex) => {
      const candidate = candidateByIndex.get(candidateIndex);
      return candidate ? persistedCandidateIsBound(candidate, artifact) : false;
    }),
  );
  return uniqueInOrder(
    boundGroups.flatMap((group) =>
      group.candidateIndexes.flatMap(
        (candidateIndex) => candidateByIndex.get(candidateIndex)?.authorityClaimIds ?? [],
      ),
    ),
  );
}

export function objectiveAuthoritySemanticProvenanceMappings(
  artifact: ObjectiveAuthoritySemanticSupport,
): Array<{
  sourceBlockIds: string[];
  authorityRecordIds: string[];
  authorityClaimIds: string[];
}> {
  if (isV1SemanticSupport(artifact)) {
    return [...artifact.fragments, ...artifact.conflicts, ...artifact.overreach];
  }
  return artifact.candidateLabels.map((candidate) => ({
    sourceBlockIds: [candidate.sourceBlockId],
    authorityRecordIds: candidate.authorityRecordIds,
    authorityClaimIds: candidate.authorityClaimIds,
  }));
}

/** The only failed-artifact shape eligible for the anchored general teaching lane. */
export function isConfinedGeneralTeachingLaneSemanticFailure(
  objective: Pick<CurriculumObjective, 'subjectClass' | 'scopeOrigin'>,
  artifact: ObjectiveAuthoritySemanticSupport | null | undefined,
): boolean {
  if (
    !artifact ||
    deriveEffectiveObjectiveSubjectClass(objective, artifact) !== 'general' ||
    objective.scopeOrigin !== 'anchored' ||
    artifact.verdict !== 'fail' ||
    artifact.capabilityPreservation?.verdict === 'fail' ||
    artifact.construct === 'design' ||
    artifact.construct === 'evaluate'
  ) {
    return false;
  }
  if (!isV1SemanticSupport(artifact)) {
    const derived = deriveObjectiveAuthoritySemanticSupportV2(artifact);
    return derived.anchorValid && !derived.contradiction && !derived.misBinding;
  }
  if (
    artifact.fragments.some((fragment) => fragment.status === 'conflicted') ||
    artifact.conflicts.length > 0
  ) {
    return false;
  }
  const allowed = allowedSupportTypes(artifact.construct);
  return !artifact.fragments.some(
    (fragment) =>
      fragment.status === 'supported' &&
      fragment.supportType !== null &&
      !allowed.has(fragment.supportType),
  );
}

function requiredCore(
  construct: FormalAssessmentConstruct,
): ReadonlySet<ObjectiveAuthoritySupportType> {
  if (construct === 'identify') return IDENTIFY_CORE;
  if (construct === 'explain') return EXPLAIN_CORE;
  if (construct === 'apply') return APPLY_CORE;
  return new Set();
}

function validateCapabilityPreservation(
  expected: ObjectiveAuthoritySemanticEvaluationObjectiveInput,
  evaluation: ObjectiveAuthoritySemanticObjectiveProposal,
  add: (code: string, message: string) => void,
): void {
  const requirement = expected.requiredCapabilityPreservation;
  const preservation =
    'capabilityPreservation' in evaluation ? evaluation.capabilityPreservation : undefined;
  const fragments = 'fragments' in evaluation ? evaluation.fragments : undefined;
  if (!requirement && preservation) {
    add(
      'semantic_capability_preservation_unexpected',
      `Objective ${expected.objectiveRef} supplied capability preservation without a local requirement.`,
    );
    return;
  }
  if (requirement && (!preservation || !fragments)) {
    add(
      'semantic_capability_preservation_missing',
      `Objective ${expected.objectiveRef} omitted the required original-capability preservation result.`,
    );
    return;
  }
  if (!requirement || !preservation || !fragments) return;

  if (fragments.map((fragment) => fragment.text).join('') !== expected.proposition) {
    add(
      'semantic_fragment_partition_incomplete',
      `Capability-recovery fragments do not exactly partition ${expected.objectiveRef}.`,
    );
  }

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
  const repairedFragmentIds = new Set(fragments.map((fragment) => fragment.fragmentId));
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
  if (fragments.some((fragment) => !coveredRepairedFragmentIds.has(fragment.fragmentId))) {
    add(
      'semantic_capability_repaired_fragment_coverage_incomplete',
      `Objective ${expected.objectiveRef} does not account for every repaired proposition fragment.`,
    );
  }
}

export interface ObjectiveAuthoritySemanticEvaluationDecision extends ObjectiveAuthoritySemanticLocalDerivation {
  objectiveRef: string;
  objectiveId: string;
  candidateWindowTruncated: boolean;
  validGroups: Array<{
    evidenceRefs: string[];
    supportType: ObjectiveAuthoritySupportType;
    rationale?: string | undefined;
  }>;
  validationDiagnosticCodes: string[];
  nonBoundContradictionCount: number;
}

function normalizedEvidenceRefSet(evidenceRefs: readonly string[]): string {
  return [...evidenceRefs].sort((left, right) => left.localeCompare(right)).join('\u0000');
}

function resolveObjectiveAuthoritySemanticEvaluation(
  expected: ObjectiveAuthoritySemanticEvaluationObjectiveInput,
  binding: ObjectiveAuthoritySemanticObjectiveAliasBinding,
  evaluation: ObjectiveAuthoritySemanticObjectiveProposal,
): ObjectiveAuthoritySemanticEvaluationDecision {
  const relationByRef = new Map(
    evaluation.candidateLabels.map((candidate) => [candidate.evidenceRef, candidate.relation]),
  );
  const structurallyConsistentGroups = evaluation.supportGroups.filter((group) =>
    group.evidenceRefs.every((evidenceRef) => relationByRef.get(evidenceRef) === 'relevant'),
  );
  const labelInconsistentCount =
    evaluation.supportGroups.length - structurallyConsistentGroups.length;
  const minimalGroups = structurallyConsistentGroups.filter((group, groupIndex) => {
    const refs = new Set(group.evidenceRefs);
    return !structurallyConsistentGroups.some(
      (other, otherIndex) =>
        otherIndex !== groupIndex &&
        other.evidenceRefs.length < group.evidenceRefs.length &&
        other.evidenceRefs.every((evidenceRef) => refs.has(evidenceRef)),
    );
  });
  const nonMinimalCount = structurallyConsistentGroups.length - minimalGroups.length;
  const candidatePosition = new Map(
    expected.candidates.map((candidate, index) => [candidate.evidenceRef, index] as const),
  );
  const validGroups = minimalGroups.map((group) => ({
    evidenceRefs: [...group.evidenceRefs].sort(
      (left, right) => candidatePosition.get(left)! - candidatePosition.get(right)!,
    ),
    supportType: group.supportType,
    ...(group.rationale ? { rationale: group.rationale } : {}),
  }));
  const boundRefs = new Set(binding.boundEvidenceRefs);
  const boundSatisfiedGroups = validGroups.filter((group) =>
    group.evidenceRefs.every((evidenceRef) => boundRefs.has(evidenceRef)),
  );
  const anchorValid = evaluation.candidateLabels.some(
    (candidate) => boundRefs.has(candidate.evidenceRef) && candidate.relation === 'relevant',
  );
  const coverage = validGroups.length > 0;
  const bindingMatch = boundSatisfiedGroups.length > 0;
  const core = requiredCore(binding.construct);
  const coreValid = boundSatisfiedGroups.some((group) => core.has(group.supportType));
  const contradiction = evaluation.candidateLabels.some(
    (candidate) =>
      boundRefs.has(candidate.evidenceRef) && candidate.relation === 'contradicts_claim',
  );
  const validationDiagnosticCodes = [
    ...(labelInconsistentCount > 0 ? ['semantic_support_group_label_inconsistent'] : []),
    ...(nonMinimalCount > 0 ? ['semantic_support_group_not_minimal'] : []),
  ];
  return {
    objectiveRef: evaluation.objectiveRef,
    objectiveId: binding.objectiveId,
    candidateWindowTruncated: binding.candidateWindowTruncated,
    validGroups,
    validationDiagnosticCodes,
    anchorValid,
    coverage,
    bindingMatch,
    misBinding: coverage && !bindingMatch,
    coreValid,
    contradiction,
    verdict:
      bindingMatch &&
      !contradiction &&
      coreValid &&
      (!('capabilityPreservation' in evaluation) ||
        evaluation.capabilityPreservation.verdict !== 'fail')
        ? 'pass'
        : 'fail',
    nonBoundContradictionCount: evaluation.candidateLabels.filter(
      (candidate) =>
        !boundRefs.has(candidate.evidenceRef) && candidate.relation === 'contradicts_claim',
    ).length,
  };
}

export function deriveObjectiveAuthoritySemanticEvaluationDecision(
  batch: ObjectiveAuthoritySemanticEvaluationBatch,
  objectiveRef: string,
  evaluation: ObjectiveAuthoritySemanticObjectiveProposal,
): ObjectiveAuthoritySemanticEvaluationDecision {
  const expected = batch.input.objectives.find(
    (objective) => objective.objectiveRef === objectiveRef,
  );
  const binding = batch.aliasBindings.get(objectiveRef);
  if (!expected || !binding || evaluation.objectiveRef !== objectiveRef) {
    throw new Error(`Cannot derive semantic authority for foreign objective ${objectiveRef}.`);
  }
  return resolveObjectiveAuthoritySemanticEvaluation(expected, binding, evaluation);
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
    const expectedCandidateRefs = expected.candidates.map((candidate) => candidate.evidenceRef);
    const actualCandidateRefs = evaluation.candidateLabels.map(
      (candidate) => candidate.evidenceRef,
    );
    if (
      actualCandidateRefs.length !== expectedCandidateRefs.length ||
      actualCandidateRefs.some(
        (evidenceRef, candidateIndex) => evidenceRef !== expectedCandidateRefs[candidateIndex],
      ) ||
      new Set(actualCandidateRefs).size !== actualCandidateRefs.length
    ) {
      addObjective(
        'semantic_candidate_label_set_mismatch',
        `Semantic evaluation did not label the exact ordered candidate set for ${expected.objectiveRef}.`,
      );
    }
    const allowedEvidenceRefs = new Set(expectedCandidateRefs);
    const normalizedGroups = evaluation.supportGroups.map((group) =>
      normalizedEvidenceRefSet(group.evidenceRefs),
    );
    if (new Set(normalizedGroups).size !== normalizedGroups.length) {
      addObjective(
        'semantic_support_group_duplicate',
        `Semantic evaluation returned a duplicate support group for ${expected.objectiveRef}.`,
      );
    }
    if (
      evaluation.supportGroups.some((group) =>
        group.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef)),
      )
    ) {
      addObjective(
        'semantic_support_group_unbound_evidence_ref',
        `A support group for ${expected.objectiveRef} cites an unoffered candidate.`,
      );
    }
    const allowed = allowedSupportTypes(expected.construct);
    if (evaluation.supportGroups.some((group) => !allowed.has(group.supportType))) {
      addObjective(
        'semantic_support_type_construct_mismatch',
        `A support group for ${expected.objectiveRef} maps outside its fixed construct.`,
      );
    }
    if ('fragments' in evaluation) {
      for (const fragment of evaluation.fragments) {
        if (fragment.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef))) {
          addObjective(
            'semantic_unbound_evidence_ref',
            `Capability fragment ${fragment.fragmentId} cites an unoffered candidate.`,
          );
        }
      }
    }
    validateCapabilityPreservation(expected, evaluation, addObjective);
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
    const expected = batch.input.objectives.find(
      (objective) => objective.objectiveRef === evaluation.objectiveRef,
    )!;
    const decision = resolveObjectiveAuthoritySemanticEvaluation(expected, binding, evaluation);
    const candidateLabels = evaluation.candidateLabels.map((candidate) => {
      const mapped = binding.evidenceByRef.get(candidate.evidenceRef)!;
      return {
        candidateIndex: mapped.candidateIndex,
        evidenceId: mapped.evidenceId,
        sourceBlockId: mapped.sourceBlockId,
        authorityRecordIds: [...mapped.authorityRecordIds],
        authorityClaimIds: [...mapped.authorityClaimIds],
        relation: candidate.relation,
        ...('rationale' in candidate && candidate.rationale
          ? { rationale: candidate.rationale }
          : {}),
      } satisfies ObjectiveAuthoritySemanticPersistedCandidate;
    });
    const supportGroups = decision.validGroups.map((group) => ({
      candidateIndexes: group.evidenceRefs.map(
        (evidenceRef) => binding.evidenceByRef.get(evidenceRef)!.candidateIndex,
      ),
      supportType: group.supportType,
      ...(group.rationale ? { rationale: group.rationale } : {}),
    })) satisfies ObjectiveAuthoritySemanticPersistedSupportGroup[];
    const fragments =
      'fragments' in evaluation
        ? evaluation.fragments.map((fragment) => ({
            fragmentId: fragment.fragmentId,
            text: fragment.text,
            status: fragment.status,
            supportType: fragment.supportType,
            ...mapEvidenceRefs(fragment.evidenceRefs, binding),
            rationale: fragment.rationale,
          }))
        : undefined;
    const capabilityPreservation =
      'capabilityPreservation' in evaluation ? evaluation.capabilityPreservation : undefined;
    const artifact = ObjectiveAuthoritySemanticSupportSchema.parse({
      schemaVersion: 2,
      policyVersion: batch.input.policyVersion,
      evaluator: metadata.evaluator,
      provider: metadata.provider,
      providerModel: metadata.providerModel,
      independent: true,
      objectiveId: binding.objectiveId,
      proposition: binding.proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(binding.proposition),
      construct: binding.construct,
      subjectDependency: evaluation.subjectDependency,
      subjectDependencyRationale: evaluation.subjectDependencyRationale,
      boundAuthorityRecordIds: [...binding.boundAuthorityRecordIds],
      boundSourceBlockIds: [...binding.boundSourceBlockIds],
      boundAuthorityClaimIds: [...binding.boundAuthorityClaimIds],
      bindingFingerprint: fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: binding.boundAuthorityRecordIds,
        sourceBlockIds: binding.boundSourceBlockIds,
        authorityClaimIds: binding.boundAuthorityClaimIds,
      }),
      candidateWindow: {
        totalCandidateCount: binding.totalCandidateCount,
        offeredCandidateCount: candidateLabels.length,
        truncated: binding.candidateWindowTruncated,
      },
      candidateLabels,
      supportGroups,
      validationDiagnosticCodes: uniqueInOrder([
        ...decision.validationDiagnosticCodes,
        ...(metadata.localValidationDiagnosticCodesByObjectiveId?.get(binding.objectiveId) ?? []),
      ]),
      ...(fragments && capabilityPreservation
        ? {
            fragments,
            capabilityPreservation: {
              originalProposition: capabilityPreservation.originalProposition,
              originalPropositionFingerprint: fingerprintObjectiveAuthorityProposition(
                capabilityPreservation.originalProposition,
              ),
              mappings: capabilityPreservation.mappings.map((mapping) => ({
                ...mapping,
                repairedFragmentIds: [...mapping.repairedFragmentIds],
              })),
              lostOriginalFragmentIds: [...capabilityPreservation.lostOriginalFragmentIds],
              verdict: capabilityPreservation.verdict,
              rationale: capabilityPreservation.rationale,
              ...(metadata.recoveryOriginByObjectiveId?.has(binding.objectiveId)
                ? {
                    recoveryOrigin: metadata.recoveryOriginByObjectiveId.get(binding.objectiveId),
                  }
                : {}),
            },
          }
        : {}),
      verdict: decision.verdict,
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
          if (isConfinedGeneralTeachingLaneSemanticFailure(objective, semanticSupport)) {
            clone.truthPremiseStatus = 'unverified';
            clone.formalEvidenceSourceBlockIds = [];
          }
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
  options: { skipCoreMissing?: boolean } = {},
): void {
  const supportedTypes = isV1SemanticSupport(artifact)
    ? artifact.fragments.flatMap((fragment) =>
        fragment.status === 'supported' && fragment.supportType ? [fragment.supportType] : [],
      )
    : artifact.supportGroups.map((group) => group.supportType);
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
  if (options.skipCoreMissing) return;
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
      const objectiveDiagnosticStart = diagnostics.length;
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
      const confinedGeneralFailure = isConfinedGeneralTeachingLaneSemanticFailure(
        objective,
        artifact,
      );
      const expectedPolicy = isV1SemanticSupport(artifact)
        ? OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_V1_POLICY
        : OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY;
      if (
        !OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_ACCEPTED_POLICIES.has(artifact.policyVersion) ||
        artifact.policyVersion !== expectedPolicy
      ) {
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
      if (
        isV1SemanticSupport(artifact) &&
        artifact.fragments.map((fragment) => fragment.text).join('') !== proposition
      ) {
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
        const recoveryFragments = artifact.fragments ?? [];
        const repairedFragmentIds = new Set(
          recoveryFragments.map((fragment) => fragment.fragmentId),
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
          recoveryFragments.some((fragment) => !coveredRepairedFragmentIds.has(fragment.fragmentId))
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
      if (isV1SemanticSupport(artifact)) {
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
      } else {
        const derived = deriveObjectiveAuthoritySemanticSupportV2(artifact);
        if (artifact.verdict !== derived.verdict) {
          add(
            'semantic_local_verdict_mismatch',
            `Objective ${objective.id} retains a verdict inconsistent with its local candidate and support-group derivation.`,
          );
        }
      }
      validatePersistedConstructMapping(artifact, objective.id, add, {
        skipCoreMissing: artifact.verdict !== 'pass',
      });
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
      if (
        artifact.verdict !== 'pass' &&
        (!confinedGeneralFailure || diagnostics.length > objectiveDiagnosticStart)
      ) {
        add(
          'semantic_support_failed',
          `Objective ${objective.id} did not pass objective-authority semantic support.`,
        );
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
