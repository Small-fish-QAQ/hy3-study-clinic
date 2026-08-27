import {
  CurriculumProposalPayloadSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthorityRequiredCapabilityPreservationSchema,
  ObjectiveAuthoritySemanticRepairInputSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  type AuthorityPremiseKind,
  type CurriculumProposalPayload,
  type CurriculumScopeOrigin,
  type CurriculumSubjectClass,
  type FormalAssessmentConstruct,
  type ObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthorityRequiredCapabilityPreservation,
  type ObjectiveAuthoritySemanticRepairInput,
  type ObjectiveAuthoritySemanticRepairProposal,
  type SourceAuthorityBundle,
} from '@hy3-clinic/shared';
import type {
  CurriculumEvidenceOffer,
  ProviderCandidateFailureArtifact,
  ProviderCandidateFailureValue,
  ProviderCandidateValidation,
} from '../llm/provider.js';
import type { CurriculumDeterministicCoverageMembership } from './curriculumValidation.js';
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
  curriculumObjectiveProposition,
  deriveObjectiveAuthoritySemanticEvaluationDecision,
  fingerprintObjectiveAuthorityAuditValue,
  validateObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticEvaluationBatch,
  type ObjectiveAuthoritySemanticEvaluationDecision,
  type ObjectiveAuthoritySemanticObjectiveAliasBinding,
} from './objectiveAuthoritySemanticSupport.js';

const MAX_REPAIR_EVIDENCE_OFFERS = 32;

interface RepairDiagnostic {
  code: string;
  message: string;
  facts?: Record<string, ProviderCandidateFailureValue> | undefined;
}

export interface ObjectiveAuthoritySemanticFirstPassBatch {
  /** One completed batch from the first independent semantic-support pass. */
  batch: ObjectiveAuthoritySemanticEvaluationBatch;
  proposal: ObjectiveAuthoritySemanticEvaluationProposal | unknown;
}

export interface ObjectiveAuthoritySemanticRepairContext {
  workspaceId: string;
  evidenceCatalog: readonly CurriculumEvidenceOffer[];
  authorityBundles: readonly SourceAuthorityBundle[];
  isAuthorityBlockingEligible: (authorityRecordId: string) => boolean;
  /**
   * Exact Course Map membership when available. Without it, the candidate
   * LearningUnit's own source/objective selections are the closed envelope.
   */
  deterministicCoverageByNodeKey?:
    ReadonlyMap<string, CurriculumDeterministicCoverageMembership> | undefined;
}

export interface PrepareObjectiveAuthoritySemanticRepairInput {
  candidate: CurriculumProposalPayload | unknown;
  /** Local IDs assigned by the exact first materialization of `candidate`. */
  objectiveIdByProposalKey: ReadonlyMap<string, string>;
  firstPass: readonly ObjectiveAuthoritySemanticFirstPassBatch[];
  /** Predecessor capability requirements already enforced in the first pass. */
  requiredCapabilityPreservationByObjectiveId?:
    ReadonlyMap<string, ObjectiveAuthorityRequiredCapabilityPreservation> | undefined;
  /**
   * Local-only frozen recovery scope. Course Map units may merge disjoint
   * capability envelopes, while legacy candidates may not select every offer
   * that recovery is allowed to use.
   */
  recoveryEvidenceScopeByObjectiveId?:
    ReadonlyMap<string, ObjectiveAuthoritySemanticRepairEvidenceScope> | undefined;
  context: ObjectiveAuthoritySemanticRepairContext;
}

export interface ObjectiveAuthoritySemanticRepairEvidenceScope {
  /** Exact operation-scoped evidence identities frozen for one capability. */
  allowedEvidenceIds: readonly string[];
  /** Complete predecessor LearningUnit source envelope behind those offers. */
  allowedSourceBlockIds: readonly string[];
}

export interface ObjectiveAuthoritySemanticRepairAliasBinding {
  objectiveRef: string;
  objectiveId: string;
  objectiveKey: string;
  nodeKey: string;
  subjectClass: CurriculumSubjectClass;
  scopeOrigin: CurriculumScopeOrigin;
  construct: FormalAssessmentConstruct;
  priority: 'required' | 'high' | 'normal' | 'optional';
  currentEvidenceIds: string[];
  allowedEvidenceIds: string[];
  /** Local source envelope retained without exposing persistent identities. */
  allowedSourceBlockIds: string[];
  /** Provider-visible repair alias to exact operation-scoped evidence ID. */
  evidenceIdByRef: ReadonlyMap<string, string>;
  /** Ordered exact SourceAuthorityClaim identities behind each repair alias. */
  authorityClaimIdsByRef: ReadonlyMap<string, readonly string[]>;
}

/** Provider input paired with the immutable local candidate and alias truth. */
export interface ObjectiveAuthoritySemanticRepairBatch {
  input: ObjectiveAuthoritySemanticRepairInput;
  candidate: CurriculumProposalPayload;
  aliasBindings: ReadonlyMap<string, ObjectiveAuthoritySemanticRepairAliasBinding>;
  /** Local-only original meaning, keyed by immutable proposal objective key. */
  requiredCapabilityPreservationByObjectiveKey: ReadonlyMap<
    string,
    ObjectiveAuthorityRequiredCapabilityPreservation
  >;
}

export interface ObjectiveAuthoritySemanticRepairPreparation {
  validation: ProviderCandidateValidation;
  /** Null means either no first-pass failures or a failed local preparation. */
  batch: ObjectiveAuthoritySemanticRepairBatch | null;
}

export interface ObjectiveAuthoritySemanticRepairApplication {
  validation: ProviderCandidateValidation;
  payload: CurriculumProposalPayload | null;
}

/** Audit identity for provider-visible repair input plus ordered local claim aliases. */
export function objectiveAuthoritySemanticRepairSourceFingerprint(
  batch: ObjectiveAuthoritySemanticRepairBatch,
): string {
  const bindings = batch.input.objectives.map((objective) => {
    const binding = batch.aliasBindings.get(objective.objectiveRef);
    if (!binding) {
      throw new Error(`Missing semantic-repair audit binding for ${objective.objectiveRef}.`);
    }
    return {
      objectiveRef: objective.objectiveRef,
      objectiveId: binding.objectiveId,
      objectiveKey: binding.objectiveKey,
      nodeKey: binding.nodeKey,
      currentEvidenceIds: binding.currentEvidenceIds,
      allowedEvidenceIds: binding.allowedEvidenceIds,
      allowedSourceBlockIds: binding.allowedSourceBlockIds,
      evidence: objective.allowedEvidence.map((offer) => {
        const evidenceId = binding.evidenceIdByRef.get(offer.evidenceRef);
        const authorityClaimIds = binding.authorityClaimIdsByRef.get(offer.evidenceRef);
        if (!evidenceId || !authorityClaimIds) {
          throw new Error(
            `Missing semantic-repair evidence audit binding for ${offer.evidenceRef}.`,
          );
        }
        return { evidenceRef: offer.evidenceRef, evidenceId, authorityClaimIds };
      }),
    };
  });
  const digest = fingerprintObjectiveAuthorityAuditValue({ input: batch.input, bindings });
  return `objective_authority_repair_${digest.slice(0, 40)}`;
}

interface CandidateObjectiveLocation {
  node: CurriculumProposalPayload['nodes'][number];
  objective: CurriculumProposalPayload['nodes'][number]['objectives'][number];
  objectiveId: string;
}

interface EligibleEvidence {
  offer: CurriculumEvidenceOffer;
  claimKinds: AuthorityPremiseKind[];
  authorityRecordIds: string[];
  authorityClaimIds: string[];
}

interface FailedEvaluationLocation extends CandidateObjectiveLocation {
  evaluation: ObjectiveAuthoritySemanticEvaluationProposal['evaluations'][number];
  evaluationInput: ObjectiveAuthoritySemanticEvaluationBatch['input']['objectives'][number];
  evaluationBinding: ObjectiveAuthoritySemanticObjectiveAliasBinding;
  decision: ObjectiveAuthoritySemanticEvaluationDecision;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function successfulValidation(): ProviderCandidateValidation {
  return { valid: true, diagnostics: [], diagnosticCodes: [] };
}

function failedValidation(
  kind: string,
  diagnostics: readonly RepairDiagnostic[],
): ProviderCandidateValidation {
  const bounded = diagnostics.slice(0, 100);
  const failureDiagnostics: ProviderCandidateFailureArtifact['diagnostics'] = bounded
    .slice(0, 20)
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.facts ? { facts: diagnostic.facts } : {}),
    }));
  return {
    valid: false,
    diagnostics: bounded.map((diagnostic) => diagnostic.message),
    diagnosticCodes: bounded.map((diagnostic) => diagnostic.code),
    failureArtifact: { kind, diagnostics: failureDiagnostics },
  };
}

function schemaDiagnostics(
  code: string,
  message: string,
  issues: readonly { path: PropertyKey[]; message: string; code: string }[],
): RepairDiagnostic[] {
  return [
    { code, message },
    ...issues.slice(0, 20).map((issue) => ({
      code: `${code}_${issue.code}`,
      message: `${issue.path.map(String).join('.') || 'payload'}: ${issue.message}`,
      facts: { path: issue.path.map(String) },
    })),
  ];
}

function buildEligibleEvidence(
  offer: CurriculumEvidenceOffer,
  context: ObjectiveAuthoritySemanticRepairContext,
): EligibleEvidence | null {
  const claimKinds: AuthorityPremiseKind[] = [];
  const authorityRecordIds: string[] = [];
  const authorityClaimIds: string[] = [];
  for (const bundle of context.authorityBundles) {
    const record = bundle.record;
    if (
      record.workspaceId !== context.workspaceId ||
      record.materialId !== offer.materialId ||
      record.materialRevisionId !== offer.materialRevisionId ||
      record.validationState !== 'validated' ||
      record.conflictState === 'unresolved' ||
      !context.isAuthorityBlockingEligible(record.id)
    ) {
      continue;
    }
    const exactClaims = bundle.claims.filter(
      (claim) =>
        claim.sourceBlockId === offer.blockId &&
        claim.quote === offer.quote &&
        claim.startOffset === offer.startOffset &&
        claim.endOffset === offer.endOffset,
    );
    if (exactClaims.length === 0) continue;
    if (!claimKinds.includes(record.policyBasis.premiseKind)) {
      claimKinds.push(record.policyBasis.premiseKind);
    }
    authorityRecordIds.push(record.id);
    authorityClaimIds.push(...exactClaims.map((claim) => claim.id));
  }
  return claimKinds.length === 0
    ? null
    : {
        offer,
        claimKinds,
        authorityRecordIds: uniqueInOrder(authorityRecordIds),
        authorityClaimIds: uniqueInOrder(authorityClaimIds),
      };
}

function selectedUnitEvidenceIds(node: CurriculumProposalPayload['nodes'][number]): string[] {
  return uniqueInOrder([
    ...node.sourceEvidence.map((selection) => selection.evidenceId),
    ...node.objectives.flatMap((objective) =>
      objective.evidence.map((selection) => selection.evidenceId),
    ),
  ]);
}

function translateEvidenceRefs(
  refs: readonly string[],
  translation: ReadonlyMap<string, string>,
): string[] {
  return uniqueInOrder(refs.map((ref) => translation.get(ref) ?? ref));
}

function appendFirstPassValidation(
  diagnostics: RepairDiagnostic[],
  validation: ProviderCandidateValidation,
): void {
  validation.diagnostics.forEach((message, index) => {
    diagnostics.push({
      code: validation.diagnosticCodes?.[index] ?? 'semantic_repair_first_pass_invalid',
      message,
    });
  });
}

export interface ObjectiveAuthoritySemanticDeterministicRebindApplication {
  validation: ProviderCandidateValidation;
  payload: CurriculumProposalPayload | null;
  reboundObjectiveIds: string[];
  reboundObjectiveKeys: string[];
}

function compareCandidatePositionTuples(left: readonly number[], right: readonly number[]): number {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

/** Apply only locally detected mis-bindings; objective meaning remains byte-preserved. */
export function applyObjectiveAuthoritySemanticDeterministicRebind(input: {
  candidate: CurriculumProposalPayload | unknown;
  objectiveIdByProposalKey: ReadonlyMap<string, string>;
  firstPass: readonly ObjectiveAuthoritySemanticFirstPassBatch[];
}): ObjectiveAuthoritySemanticDeterministicRebindApplication {
  const parsedCandidate = CurriculumProposalPayloadSchema.safeParse(input.candidate);
  if (!parsedCandidate.success) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_rebind_failed',
        schemaDiagnostics(
          'semantic_rebind_candidate_schema_invalid',
          'The Curriculum candidate is invalid before deterministic rebinding.',
          parsedCandidate.error.issues,
        ),
      ),
      payload: null,
      reboundObjectiveIds: [],
      reboundObjectiveKeys: [],
    };
  }
  const candidate = structuredClone(parsedCandidate.data);
  const objectiveById = new Map<
    string,
    CurriculumProposalPayload['nodes'][number]['objectives'][number]
  >();
  const objectiveKeyById = new Map<string, string>();
  const diagnostics: RepairDiagnostic[] = [];
  for (const node of candidate.nodes) {
    for (const objective of node.objectives) {
      const objectiveId = input.objectiveIdByProposalKey.get(objective.key);
      if (!objectiveId || objectiveById.has(objectiveId)) {
        diagnostics.push({
          code: objectiveId
            ? 'semantic_rebind_objective_binding_duplicate'
            : 'semantic_rebind_objective_binding_missing',
          message: objectiveId
            ? `Deterministic rebind objective identity ${objectiveId} is not unique.`
            : `Deterministic rebind is missing the local objective binding for ${objective.key}.`,
        });
        continue;
      }
      objectiveById.set(objectiveId, objective);
      objectiveKeyById.set(objectiveId, objective.key);
    }
  }
  const seenObjectiveIds = new Set<string>();
  const reboundObjectiveIds: string[] = [];
  const reboundObjectiveKeys: string[] = [];
  for (const firstPass of input.firstPass) {
    const validation = validateObjectiveAuthoritySemanticEvaluationProposal(
      firstPass.batch,
      firstPass.proposal,
    );
    if (!validation.valid) {
      appendFirstPassValidation(diagnostics, validation);
      continue;
    }
    const proposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse(firstPass.proposal);
    for (const [index, evaluation] of proposal.evaluations.entries()) {
      const evaluationInput = firstPass.batch.input.objectives[index]!;
      const binding = firstPass.batch.aliasBindings.get(evaluation.objectiveRef);
      if (!binding || seenObjectiveIds.has(binding.objectiveId)) {
        diagnostics.push({
          code: binding
            ? 'semantic_rebind_first_pass_objective_duplicate'
            : 'semantic_rebind_first_pass_alias_missing',
          message: binding
            ? `Deterministic rebind received duplicate objective ${binding.objectiveId}.`
            : `Deterministic rebind is missing local aliases for ${evaluation.objectiveRef}.`,
        });
        continue;
      }
      seenObjectiveIds.add(binding.objectiveId);
      const objective = objectiveById.get(binding.objectiveId);
      if (
        !objective ||
        curriculumObjectiveProposition(objective) !== binding.proposition ||
        objective.construct !== binding.construct
      ) {
        diagnostics.push({
          code: 'semantic_rebind_first_pass_candidate_mismatch',
          message: `Deterministic rebind received a stale objective ${evaluation.objectiveRef}.`,
        });
        continue;
      }
      const decision = deriveObjectiveAuthoritySemanticEvaluationDecision(
        firstPass.batch,
        evaluation.objectiveRef,
        evaluation,
      );
      if (!decision.misBinding) continue;
      const positionByRef = new Map(
        evaluationInput.candidates.map((candidateOffer, candidateIndex) => [
          candidateOffer.evidenceRef,
          candidateIndex,
        ]),
      );
      const selectedGroup = [...decision.validGroups].sort((left, right) => {
        if (left.evidenceRefs.length !== right.evidenceRefs.length) {
          return left.evidenceRefs.length - right.evidenceRefs.length;
        }
        return compareCandidatePositionTuples(
          left.evidenceRefs.map((evidenceRef) => positionByRef.get(evidenceRef)!),
          right.evidenceRefs.map((evidenceRef) => positionByRef.get(evidenceRef)!),
        );
      })[0];
      const evidenceIds = selectedGroup?.evidenceRefs.map(
        (evidenceRef) => binding.evidenceByRef.get(evidenceRef)?.evidenceId,
      );
      if (
        !selectedGroup ||
        !evidenceIds ||
        evidenceIds.some((evidenceId) => !evidenceId) ||
        new Set(evidenceIds).size !== evidenceIds.length ||
        evidenceIds.length > 5
      ) {
        diagnostics.push({
          code: 'semantic_rebind_support_group_unresolvable',
          message: `The selected support group for ${evaluation.objectiveRef} cannot be resolved to exact evidence identities.`,
        });
        continue;
      }
      objective.evidence = evidenceIds.map((evidenceId) => ({ evidenceId: evidenceId! }));
      reboundObjectiveIds.push(binding.objectiveId);
      reboundObjectiveKeys.push(objectiveKeyById.get(binding.objectiveId)!);
    }
  }
  if (seenObjectiveIds.size !== objectiveById.size) {
    diagnostics.push({
      code: 'semantic_rebind_first_pass_objective_set_mismatch',
      message: 'Deterministic rebind requires one complete first-pass result per objective.',
    });
  }
  if (diagnostics.length > 0) {
    return {
      validation: failedValidation('objective_authority_semantic_rebind_failed', diagnostics),
      payload: null,
      reboundObjectiveIds: [],
      reboundObjectiveKeys: [],
    };
  }
  const rebound = CurriculumProposalPayloadSchema.safeParse(candidate);
  if (!rebound.success) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_rebind_failed',
        schemaDiagnostics(
          'semantic_rebind_result_schema_invalid',
          'The deterministically rebound Curriculum candidate is invalid.',
          rebound.error.issues,
        ),
      ),
      payload: null,
      reboundObjectiveIds: [],
      reboundObjectiveKeys: [],
    };
  }
  return {
    validation: successfulValidation(),
    payload: rebound.data,
    reboundObjectiveIds,
    reboundObjectiveKeys,
  };
}

/**
 * Validate the complete first pass and expose repair scope only for its failed
 * objectives. Unbound evidence can enter only through the same LearningUnit's
 * exact source envelope; every alias retains a local evidence-ID binding.
 */
export function prepareObjectiveAuthoritySemanticRepair(
  input: PrepareObjectiveAuthoritySemanticRepairInput,
): ObjectiveAuthoritySemanticRepairPreparation {
  const parsedCandidate = CurriculumProposalPayloadSchema.safeParse(input.candidate);
  if (!parsedCandidate.success) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_repair_preparation_failed',
        schemaDiagnostics(
          'semantic_repair_candidate_schema_invalid',
          'The Curriculum candidate is invalid before semantic repair.',
          parsedCandidate.error.issues,
        ),
      ),
      batch: null,
    };
  }
  const candidate = parsedCandidate.data;
  const diagnostics: RepairDiagnostic[] = [];
  const evidenceById = new Map<string, CurriculumEvidenceOffer>();
  for (const offer of input.context.evidenceCatalog) {
    if (evidenceById.has(offer.id)) {
      diagnostics.push({
        code: 'semantic_repair_evidence_catalog_duplicate',
        message: `Semantic repair evidence catalog contains duplicate identity ${offer.id}.`,
      });
    }
    evidenceById.set(offer.id, offer);
  }

  const candidateLocations: CandidateObjectiveLocation[] = [];
  const candidateKeys = new Set<string>();
  const objectiveIds = new Set<string>();
  for (const node of candidate.nodes) {
    for (const objective of node.objectives) {
      candidateKeys.add(objective.key);
      const objectiveId = input.objectiveIdByProposalKey.get(objective.key);
      if (!objectiveId) {
        diagnostics.push({
          code: 'semantic_repair_objective_binding_missing',
          message: `Semantic repair is missing the local objective binding for ${objective.key}.`,
        });
        continue;
      }
      if (objectiveIds.has(objectiveId)) {
        diagnostics.push({
          code: 'semantic_repair_objective_binding_duplicate',
          message: `Semantic repair local objective identity ${objectiveId} is not unique.`,
        });
      }
      objectiveIds.add(objectiveId);
      candidateLocations.push({ node, objective, objectiveId });
    }
  }
  for (const key of input.objectiveIdByProposalKey.keys()) {
    if (!candidateKeys.has(key)) {
      diagnostics.push({
        code: 'semantic_repair_objective_binding_foreign',
        message: `Semantic repair contains a local binding for foreign objective key ${key}.`,
      });
    }
  }
  const candidateByObjectiveId = new Map(
    candidateLocations.map((location) => [location.objectiveId, location] as const),
  );
  for (const objectiveId of input.requiredCapabilityPreservationByObjectiveId?.keys() ?? []) {
    if (!candidateByObjectiveId.has(objectiveId)) {
      diagnostics.push({
        code: 'semantic_repair_capability_preservation_objective_foreign',
        message: `Semantic repair received a predecessor capability for foreign objective ${objectiveId}.`,
      });
    }
    if (!input.recoveryEvidenceScopeByObjectiveId?.has(objectiveId)) {
      diagnostics.push({
        code: 'semantic_repair_recovery_evidence_scope_missing',
        message: `Semantic repair is missing the frozen recovery evidence scope for ${objectiveId}.`,
      });
    }
  }
  for (const objectiveId of input.recoveryEvidenceScopeByObjectiveId?.keys() ?? []) {
    if (!candidateByObjectiveId.has(objectiveId)) {
      diagnostics.push({
        code: 'semantic_repair_recovery_evidence_scope_objective_foreign',
        message: `Semantic repair received a frozen evidence scope for foreign objective ${objectiveId}.`,
      });
    }
    if (!input.requiredCapabilityPreservationByObjectiveId?.has(objectiveId)) {
      diagnostics.push({
        code: 'semantic_repair_recovery_evidence_scope_unbound',
        message: `Semantic repair received a frozen evidence scope without a predecessor capability for ${objectiveId}.`,
      });
    }
  }

  const seenObjectiveIds: string[] = [];
  const failed: FailedEvaluationLocation[] = [];
  for (const firstPass of input.firstPass) {
    const validation = validateObjectiveAuthoritySemanticEvaluationProposal(
      firstPass.batch,
      firstPass.proposal,
    );
    if (!validation.valid) {
      appendFirstPassValidation(diagnostics, validation);
      continue;
    }
    if (firstPass.batch.input.policyVersion !== OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY) {
      diagnostics.push({
        code: 'semantic_repair_policy_mismatch',
        message: 'Semantic repair cannot consume a first pass from a different policy.',
      });
      continue;
    }
    const proposal = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse(firstPass.proposal);
    for (const [index, evaluation] of proposal.evaluations.entries()) {
      const evaluationInput = firstPass.batch.input.objectives[index]!;
      const evaluationBinding = firstPass.batch.aliasBindings.get(evaluation.objectiveRef);
      if (!evaluationBinding) {
        diagnostics.push({
          code: 'semantic_repair_first_pass_alias_missing',
          message: `First-pass objective ${evaluation.objectiveRef} has no local alias binding.`,
        });
        continue;
      }
      const location = candidateByObjectiveId.get(evaluationBinding.objectiveId);
      if (!location) {
        diagnostics.push({
          code: 'semantic_repair_first_pass_objective_foreign',
          message: `First-pass objective ${evaluation.objectiveRef} is outside the candidate.`,
        });
        continue;
      }
      const proposition = curriculumObjectiveProposition(location.objective);
      const requiredCapabilityPreservation = input.requiredCapabilityPreservationByObjectiveId?.get(
        location.objectiveId,
      );
      if (
        evaluationBinding.objectiveRef !== evaluation.objectiveRef ||
        evaluationBinding.proposition !== proposition ||
        evaluationBinding.construct !== location.objective.construct ||
        evaluationInput.proposition !== proposition ||
        evaluationInput.construct !== location.objective.construct
      ) {
        diagnostics.push({
          code: 'semantic_repair_first_pass_candidate_mismatch',
          message: `First-pass objective ${evaluation.objectiveRef} is stale for the candidate.`,
        });
        continue;
      }
      if (
        requiredCapabilityPreservation &&
        JSON.stringify(evaluationInput.requiredCapabilityPreservation) !==
          JSON.stringify(requiredCapabilityPreservation)
      ) {
        diagnostics.push({
          code: 'semantic_repair_capability_preservation_requirement_mismatch',
          message: `First-pass objective ${evaluation.objectiveRef} changed its required predecessor capability.`,
        });
        continue;
      }
      const inputEvidenceRefs = evaluationInput.candidates.map((offer) => offer.evidenceRef);
      const aliasEvidenceRefs = [...evaluationBinding.evidenceByRef.keys()];
      const boundEvidenceRefs = evaluationBinding.boundEvidenceRefs;
      const boundSourceBlockIds = new Set(evaluationBinding.boundSourceBlockIds);
      const boundAuthorityRecordIds = new Set(evaluationBinding.boundAuthorityRecordIds);
      if (
        aliasEvidenceRefs.length !== inputEvidenceRefs.length ||
        aliasEvidenceRefs.some(
          (evidenceRef, evidenceIndex) => evidenceRef !== inputEvidenceRefs[evidenceIndex],
        ) ||
        new Set(boundEvidenceRefs).size !== boundEvidenceRefs.length ||
        boundEvidenceRefs.some((evidenceRef) => !inputEvidenceRefs.includes(evidenceRef)) ||
        boundEvidenceRefs.some((evidenceRef) => {
          const evidence = evaluationBinding.evidenceByRef.get(evidenceRef);
          return (
            !evidence ||
            !boundSourceBlockIds.has(evidence.sourceBlockId) ||
            evidence.authorityRecordIds.some(
              (authorityRecordId) => !boundAuthorityRecordIds.has(authorityRecordId),
            )
          );
        })
      ) {
        diagnostics.push({
          code: 'semantic_repair_first_pass_alias_invalid',
          message: `First-pass aliases for ${evaluation.objectiveRef} do not retain its exact private binding.`,
        });
        continue;
      }
      const decision = deriveObjectiveAuthoritySemanticEvaluationDecision(
        firstPass.batch,
        evaluation.objectiveRef,
        evaluation,
      );
      seenObjectiveIds.push(location.objectiveId);
      const confinedGeneralFailure =
        location.objective.subjectClass === 'general' &&
        evaluation.subjectDependency === 'general_sufficient' &&
        location.objective.scopeOrigin === 'anchored' &&
        location.objective.construct !== 'design' &&
        location.objective.construct !== 'evaluate' &&
        (!('capabilityPreservation' in evaluation) ||
          evaluation.capabilityPreservation.verdict !== 'fail') &&
        decision.anchorValid &&
        !decision.contradiction &&
        !decision.misBinding;
      if (decision.verdict === 'fail' && !confinedGeneralFailure) {
        failed.push({
          ...location,
          evaluation,
          evaluationInput,
          evaluationBinding,
          decision,
        });
      }
    }
  }
  const expectedObjectiveIds = candidateLocations.map((location) => location.objectiveId);
  if (
    seenObjectiveIds.length !== expectedObjectiveIds.length ||
    seenObjectiveIds.some((id, index) => id !== expectedObjectiveIds[index]) ||
    new Set(seenObjectiveIds).size !== seenObjectiveIds.length
  ) {
    diagnostics.push({
      code: 'semantic_repair_first_pass_objective_set_mismatch',
      message: 'Semantic repair requires one complete, ordered first-pass result per objective.',
      facts: { expectedObjectiveIds, actualObjectiveIds: seenObjectiveIds },
    });
  }
  if (diagnostics.length > 0) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_repair_preparation_failed',
        diagnostics,
      ),
      batch: null,
    };
  }
  if (failed.length === 0) return { validation: successfulValidation(), batch: null };

  const repairObjectives: ObjectiveAuthoritySemanticRepairInput['objectives'] = [];
  const aliasBindings = new Map<string, ObjectiveAuthoritySemanticRepairAliasBinding>();
  const requiredCapabilityPreservationByObjectiveKey = new Map<
    string,
    ObjectiveAuthorityRequiredCapabilityPreservation
  >();
  for (const location of failed) {
    if (location.decision.misBinding) {
      diagnostics.push({
        code: 'semantic_repair_misbinding_requires_local_rebind',
        message: `Objective ${location.objective.key} has usable semantic coverage and must be rebound locally before provider repair.`,
      });
      continue;
    }
    const recoveryEvidenceScope = input.recoveryEvidenceScopeByObjectiveId?.get(
      location.objectiveId,
    );
    const coverage = input.context.deterministicCoverageByNodeKey?.get(location.node.key);
    if (input.context.deterministicCoverageByNodeKey && !coverage) {
      diagnostics.push({
        code: 'semantic_repair_unit_envelope_missing',
        message: `Semantic repair has no deterministic source envelope for ${location.node.key}.`,
      });
      continue;
    }
    const candidateEnvelopeIds = selectedUnitEvidenceIds(location.node);
    const candidateEnvelopeOffers = candidateEnvelopeIds.flatMap((evidenceId) => {
      const offer = evidenceById.get(evidenceId);
      if (!offer) {
        diagnostics.push({
          code: 'semantic_repair_unit_evidence_unknown',
          message: `LearningUnit ${location.node.key} contains unknown evidence ${evidenceId}.`,
        });
        return [];
      }
      return [offer];
    });
    const coverageBlocks = coverage ? new Set(coverage.sourceBlockIds) : null;
    if (
      coverageBlocks &&
      candidateEnvelopeOffers.some((offer) => !coverageBlocks.has(offer.blockId))
    ) {
      diagnostics.push({
        code: 'semantic_repair_current_evidence_outside_unit',
        message: `LearningUnit ${location.node.key} selects evidence outside its source envelope.`,
      });
      continue;
    }
    let allowedSourceBlockIds: string[];
    let envelopeOffers: CurriculumEvidenceOffer[];
    if (recoveryEvidenceScope) {
      const uniqueAllowedEvidenceIds = uniqueInOrder(recoveryEvidenceScope.allowedEvidenceIds);
      const uniqueAllowedSourceBlockIds = uniqueInOrder(
        recoveryEvidenceScope.allowedSourceBlockIds,
      );
      if (uniqueAllowedEvidenceIds.length !== recoveryEvidenceScope.allowedEvidenceIds.length) {
        diagnostics.push({
          code: 'semantic_repair_recovery_evidence_scope_duplicate',
          message: `Recovery evidence scope for ${location.objective.key} repeats an exact evidence identity.`,
        });
        continue;
      }
      if (
        uniqueAllowedSourceBlockIds.length !== recoveryEvidenceScope.allowedSourceBlockIds.length
      ) {
        diagnostics.push({
          code: 'semantic_repair_recovery_source_scope_duplicate',
          message: `Recovery source scope for ${location.objective.key} repeats a source block identity.`,
        });
        continue;
      }
      if (uniqueAllowedEvidenceIds.length === 0 || uniqueAllowedSourceBlockIds.length === 0) {
        diagnostics.push({
          code: 'semantic_repair_recovery_evidence_scope_empty',
          message: `Recovery evidence scope for ${location.objective.key} must remain non-empty.`,
        });
        continue;
      }
      if (uniqueAllowedEvidenceIds.length > MAX_REPAIR_EVIDENCE_OFFERS) {
        diagnostics.push({
          code: 'semantic_repair_recovery_evidence_limit_exceeded',
          message: `Recovery evidence scope for ${location.objective.key} exceeds the bounded semantic repair evidence limit.`,
          facts: {
            offeredEvidenceCount: uniqueAllowedEvidenceIds.length,
            limit: MAX_REPAIR_EVIDENCE_OFFERS,
          },
        });
        continue;
      }
      const frozenSourceBlocks = new Set(uniqueAllowedSourceBlockIds);
      const frozenOffers: CurriculumEvidenceOffer[] = [];
      let frozenScopeInvalid = false;
      for (const evidenceId of uniqueAllowedEvidenceIds) {
        const offer = evidenceById.get(evidenceId);
        if (!offer) {
          diagnostics.push({
            code: 'semantic_repair_recovery_evidence_unknown',
            message: `Recovery evidence scope for ${location.objective.key} contains unknown evidence ${evidenceId}.`,
          });
          frozenScopeInvalid = true;
          continue;
        }
        if (!frozenSourceBlocks.has(offer.blockId)) {
          diagnostics.push({
            code: 'semantic_repair_recovery_evidence_outside_source_scope',
            message: `Recovery evidence ${evidenceId} is outside the frozen source scope for ${location.objective.key}.`,
          });
          frozenScopeInvalid = true;
          continue;
        }
        if (!coverageBlocks || coverageBlocks.has(offer.blockId)) frozenOffers.push(offer);
      }
      if (frozenScopeInvalid) continue;
      allowedSourceBlockIds = uniqueAllowedSourceBlockIds;
      envelopeOffers = frozenOffers;
    } else {
      allowedSourceBlockIds = coverageBlocks
        ? [...coverageBlocks]
        : uniqueInOrder(candidateEnvelopeOffers.map((offer) => offer.blockId));
      envelopeOffers = coverageBlocks
        ? input.context.evidenceCatalog.filter((offer) => coverageBlocks.has(offer.blockId))
        : candidateEnvelopeOffers;
    }
    const eligible = envelopeOffers.flatMap((offer) => {
      const entry = buildEligibleEvidence(offer, input.context);
      return entry ? [entry] : [];
    });
    if (eligible.length > MAX_REPAIR_EVIDENCE_OFFERS) {
      diagnostics.push({
        code: 'semantic_repair_unit_evidence_limit_exceeded',
        message: `LearningUnit ${location.node.key} exceeds the bounded semantic repair evidence limit.`,
        facts: { offeredEvidenceCount: eligible.length, limit: MAX_REPAIR_EVIDENCE_OFFERS },
      });
      continue;
    }
    const currentEvidenceIds = location.objective.evidence.map((selection) => selection.evidenceId);
    if (new Set(currentEvidenceIds).size !== currentEvidenceIds.length) {
      diagnostics.push({
        code: 'semantic_repair_current_evidence_duplicate',
        message: `Objective ${location.objective.key} has duplicate exact evidence selections.`,
      });
      continue;
    }
    const eligibleById = new Map(eligible.map((entry) => [entry.offer.id, entry] as const));
    if (currentEvidenceIds.some((evidenceId) => !eligibleById.has(evidenceId))) {
      diagnostics.push({
        code: 'semantic_repair_current_evidence_ineligible',
        message: `Objective ${location.objective.key} has current evidence outside its eligible repair envelope.`,
      });
      continue;
    }

    const evidenceIdByRef = new Map<string, string>();
    const evidenceRefById = new Map<string, string>();
    const authorityClaimIdsByRef = new Map<string, readonly string[]>();
    for (const [index, entry] of eligible.entries()) {
      const evidenceRef = `repair_evidence_${index + 1}`;
      evidenceIdByRef.set(evidenceRef, entry.offer.id);
      evidenceRefById.set(entry.offer.id, evidenceRef);
      authorityClaimIdsByRef.set(evidenceRef, [...entry.authorityClaimIds]);
    }
    const firstPassRefTranslation = new Map<string, string>();
    for (const [firstPassRef, firstPassBinding] of location.evaluationBinding.evidenceByRef) {
      const repairRef = evidenceRefById.get(firstPassBinding.evidenceId);
      if (!repairRef) {
        diagnostics.push({
          code: 'semantic_repair_first_pass_evidence_unresolved',
          message: `First-pass evidence ${firstPassRef} cannot be resolved uniquely inside ${location.node.key}.`,
        });
        continue;
      }
      firstPassRefTranslation.set(firstPassRef, repairRef);
    }
    if (diagnostics.length > 0) continue;

    const recoveryFragments =
      'fragments' in location.evaluation ? location.evaluation.fragments : undefined;
    const repairFragments = recoveryFragments ?? [
      {
        fragmentId: `${location.evaluation.objectiveRef}:F1`.slice(0, 100),
        text: location.evaluationInput.proposition,
        status: 'unsupported' as const,
        supportType: null,
        evidenceRefs: [],
        rationale:
          'Local candidate-group evaluation found no usable support under the current objective.',
      },
    ];

    repairObjectives.push({
      objectiveRef: location.evaluation.objectiveRef,
      title: location.objective.title,
      description: location.objective.description,
      subjectClass: location.objective.subjectClass,
      scopeOrigin: location.objective.scopeOrigin,
      construct: location.objective.construct,
      priority: location.objective.priority ?? 'normal',
      currentEvidenceRefs: currentEvidenceIds.map((evidenceId) => evidenceRefById.get(evidenceId)!),
      allowedEvidence: eligible.map((entry) => ({
        evidenceRef: evidenceRefById.get(entry.offer.id)!,
        text: entry.offer.quote,
        claimKinds: [...entry.claimKinds],
        headingPath: [...entry.offer.headingPath],
        selected: currentEvidenceIds.includes(entry.offer.id),
      })),
      fragments: repairFragments.map((fragment) => ({
        ...fragment,
        evidenceRefs: translateEvidenceRefs(fragment.evidenceRefs, firstPassRefTranslation),
      })),
      unsupportedFragmentIds: repairFragments
        .filter((fragment) => fragment.status === 'unsupported')
        .map((fragment) => fragment.fragmentId),
      conflicts: [],
      overreach: [],
      verdict: 'fail',
      rationale: location.decision.candidateWindowTruncated
        ? 'The bounded candidate window was truncated and exposed no usable support group; wider repair remains conservative.'
        : 'The local evaluator found no usable support group for the current source-specific objective.',
      ...(location.evaluationInput.requiredCapabilityPreservation
        ? {
            requiredCapabilityPreservation: location.evaluationInput.requiredCapabilityPreservation,
          }
        : {}),
    });
    aliasBindings.set(location.evaluation.objectiveRef, {
      objectiveRef: location.evaluation.objectiveRef,
      objectiveId: location.objectiveId,
      objectiveKey: location.objective.key,
      nodeKey: location.node.key,
      subjectClass: location.objective.subjectClass,
      scopeOrigin: location.objective.scopeOrigin,
      construct: location.objective.construct,
      priority: location.objective.priority ?? 'normal',
      currentEvidenceIds: [...currentEvidenceIds],
      allowedEvidenceIds: eligible.map((entry) => entry.offer.id),
      allowedSourceBlockIds,
      evidenceIdByRef,
      authorityClaimIdsByRef,
    });
    requiredCapabilityPreservationByObjectiveKey.set(
      location.objective.key,
      location.evaluationInput.requiredCapabilityPreservation ??
        ObjectiveAuthorityRequiredCapabilityPreservationSchema.parse({
          originalProposition: location.evaluationInput.proposition,
          originalFragments: repairFragments.map((fragment) => ({
            fragmentId: fragment.fragmentId,
            text: fragment.text,
          })),
        }),
    );
  }
  if (diagnostics.length > 0) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_repair_preparation_failed',
        diagnostics,
      ),
      batch: null,
    };
  }
  const parsedRepairInput = ObjectiveAuthoritySemanticRepairInputSchema.safeParse({
    schemaVersion: 1,
    policyVersion: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
    objectives: repairObjectives,
  });
  if (!parsedRepairInput.success) {
    return {
      validation: failedValidation(
        'objective_authority_semantic_repair_preparation_failed',
        schemaDiagnostics(
          'semantic_repair_input_schema_invalid',
          'Locally prepared semantic repair input is invalid.',
          parsedRepairInput.error.issues,
        ),
      ),
      batch: null,
    };
  }
  return {
    validation: successfulValidation(),
    batch: {
      input: parsedRepairInput.data,
      candidate,
      aliasBindings,
      requiredCapabilityPreservationByObjectiveKey,
    },
  };
}

/** Validate provider repair output against the exact failed-objective scope. */
export function validateObjectiveAuthoritySemanticRepairProposal(
  batch: ObjectiveAuthoritySemanticRepairBatch,
  proposal: ObjectiveAuthoritySemanticRepairProposal | unknown,
): ProviderCandidateValidation {
  const parsed = ObjectiveAuthoritySemanticRepairProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return failedValidation(
      'objective_authority_semantic_repair_proposal_failed',
      schemaDiagnostics(
        'semantic_repair_proposal_schema_invalid',
        'Semantic repair proposal is structurally invalid.',
        parsed.error.issues,
      ),
    );
  }
  const diagnostics: RepairDiagnostic[] = [];
  const expectedRefs = batch.input.objectives.map((objective) => objective.objectiveRef);
  const actualRefs = parsed.data.replacements.map((replacement) => replacement.objectiveRef);
  if (
    actualRefs.length !== expectedRefs.length ||
    actualRefs.some((objectiveRef, index) => objectiveRef !== expectedRefs[index])
  ) {
    diagnostics.push({
      code: 'semantic_repair_objective_set_or_order_mismatch',
      message: 'Semantic repair must replace the exact failed objective set in order.',
      facts: { expectedObjectiveRefs: expectedRefs, actualObjectiveRefs: actualRefs },
    });
  }
  for (const replacement of parsed.data.replacements) {
    const binding = batch.aliasBindings.get(replacement.objectiveRef);
    if (!binding) {
      diagnostics.push({
        code: 'semantic_repair_unrelated_objective',
        message: `Semantic repair attempted to replace unrelated objective ${replacement.objectiveRef}.`,
      });
      continue;
    }
    if (replacement.construct !== binding.construct) {
      diagnostics.push({
        code: 'semantic_repair_construct_changed',
        message: `Semantic repair changed the frozen construct for ${replacement.objectiveRef}.`,
      });
    }
    if (replacement.subjectClass !== binding.subjectClass) {
      diagnostics.push({
        code: 'semantic_repair_subject_class_changed',
        message: `Semantic repair changed the frozen subject class for ${replacement.objectiveRef}.`,
      });
    }
    if (replacement.scopeOrigin !== binding.scopeOrigin) {
      diagnostics.push({
        code: 'semantic_repair_scope_origin_changed',
        message: `Semantic repair changed the frozen scope origin for ${replacement.objectiveRef}.`,
      });
    }
    if (replacement.evidenceRefs.length > 5) {
      diagnostics.push({
        code: 'semantic_repair_evidence_limit_exceeded',
        message: `Semantic repair selected too much evidence for ${replacement.objectiveRef}.`,
      });
    }
    if (new Set(replacement.evidenceRefs).size !== replacement.evidenceRefs.length) {
      diagnostics.push({
        code: 'semantic_repair_evidence_duplicate',
        message: `Semantic repair selected duplicate evidence for ${replacement.objectiveRef}.`,
      });
    }
    if (replacement.evidenceRefs.some((evidenceRef) => !binding.evidenceIdByRef.has(evidenceRef))) {
      diagnostics.push({
        code: 'semantic_repair_evidence_outside_unit',
        message: `Semantic repair selected foreign or out-of-unit evidence for ${replacement.objectiveRef}.`,
      });
    }
  }
  return diagnostics.length === 0
    ? successfulValidation()
    : failedValidation('objective_authority_semantic_repair_proposal_failed', diagnostics);
}

/**
 * Apply a validated proposal to the locally retained candidate snapshot.
 * Passing objectives and every non-objective field are preserved unchanged.
 */
export function applyObjectiveAuthoritySemanticRepairProposal(
  batch: ObjectiveAuthoritySemanticRepairBatch,
  proposal: ObjectiveAuthoritySemanticRepairProposal | unknown,
): ObjectiveAuthoritySemanticRepairApplication {
  const validation = validateObjectiveAuthoritySemanticRepairProposal(batch, proposal);
  if (!validation.valid) return { validation, payload: null };
  const parsed = ObjectiveAuthoritySemanticRepairProposalSchema.parse(proposal);
  const replacementByObjectiveKey = new Map(
    parsed.replacements.map((replacement) => {
      const binding = batch.aliasBindings.get(replacement.objectiveRef)!;
      return [binding.objectiveKey, { replacement, binding }] as const;
    }),
  );
  const nodes = batch.candidate.nodes.map((node) => {
    let changed = false;
    const objectives = node.objectives.map((objective) => {
      const scoped = replacementByObjectiveKey.get(objective.key);
      if (!scoped) return objective;
      changed = true;
      return {
        ...objective,
        title: scoped.replacement.title,
        description: scoped.replacement.description,
        subjectClass: scoped.replacement.subjectClass,
        scopeOrigin: scoped.replacement.scopeOrigin,
        evidence: scoped.replacement.evidenceRefs.map((evidenceRef) => ({
          evidenceId: scoped.binding.evidenceIdByRef.get(evidenceRef)!,
        })),
      };
    });
    return changed ? { ...node, objectives } : node;
  });
  return {
    validation,
    payload: { nodes, synthesisGroups: batch.candidate.synthesisGroups },
  };
}
