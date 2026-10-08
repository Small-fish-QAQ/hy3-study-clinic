import { createHash } from 'node:crypto';
import {
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  PRACTICE_GROUNDING_POLICY_VERSION,
  PracticeGroundingReviewSchema,
  PracticeContentProposalPayloadSchema,
  PracticeAnswerabilityReviewSchema,
  PracticeIntegrityReviewSchema,
  PracticeGroundingResultSchema,
  PracticeAnswerabilityResultSchema,
  PracticeIntegrityResultSchema,
  projectLearnerPracticeSurface,
  projectPracticePriorTeaching,
  type LearnerPracticeSolvingSurface,
  type PracticePriorTeaching,
  type PracticeContentProposalPayload,
  type PracticeQualityEvaluation,
  type TeachingContentReview,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import type {
  AuthoredTeachingContentReviewInput,
  PracticeAnswerabilityReviewInput,
  PracticeContentGenerationInput,
  PracticeGroundingReviewInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';
import { validatePracticeContentCandidate } from './teachingBriefContract.js';
import {
  hasCurrentPracticeAcceptancePolicy,
  practiceEvidenceContrastFinding,
} from './lessonPedagogyEvaluator.js';
import { compareLearnerPracticeTasks } from './practiceTaskCanonicalization.js';

export const practiceReviewHash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

type AuthoredSurface = PracticeContentProposalPayload['items'][number]['initial'];
type ProofSurface = LearnerPracticeSolvingSurface &
  Pick<AuthoredSurface, 'evidenceContrast'> & { key: string };
type ProofItem = { practiceSlotId: string; initial: ProofSurface; retry: ProofSurface };
type ReviewEvidence = Pick<
  PracticeQualityEvaluation,
  'contentReview' | 'groundingReview' | 'answerabilityReview' | 'integrityReview'
>;

/** Bind saved teaching claims through local ID materialization. Private operation
 * labels remain optional quality metadata under Phase 2C; the raw candidate and
 * review input hashes still bind those labels during preparation. */
export const practiceGroundingClaimsHash = (candidate: PracticeContentProposalPayload) => {
  const claims = PracticeContentProposalPayloadSchema.parse(candidate);
  for (const item of claims.items)
    for (const surface of [item.initial, item.retry]) delete surface.reasoningOperation;
  return practiceReviewHash(claims);
};

/** Grounding owns the whole artifact, not an amended blind-solving projection. */
export function preparePracticeGroundingReview(
  context: PracticeContentGenerationInput,
  candidate: PracticeContentProposalPayload,
) {
  const input: PracticeGroundingReviewInput = {
    purpose: 'practice_grounding',
    stage: 'practice',
    computedOutcomes: context.computedCases,
    desiredDepth: context.courseDesign?.desiredDepth ?? 'pass_oriented',
    objectives: context.skeleton.objectives.map(({ title, description }) => ({
      title,
      description,
    })),
    sources: structuredClone(context.sourceContext.offers),
    visualContext: structuredClone(context.visualContext),
    candidate: structuredClone(candidate),
    acceptedLesson: structuredClone(context.acceptedLesson),
    actionIds: [],
  };
  const fingerprint = () =>
    practiceReviewHash({
      acceptancePolicyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
      groundingPolicyVersion: PRACTICE_GROUNDING_POLICY_VERSION,
      input,
      // Selected review fields must not erase the current source/plan contract.
      context: {
        learnerLocale: context.learnerLocale,
        courseDesign: context.courseDesign,
        skeleton: context.skeleton,
        sourceContext: context.sourceContext,
        visualContext: context.visualContext,
      },
    });
  const inputHash = fingerprint();
  const ids = new Set(
    candidate.items.flatMap(({ practiceSlotId }) => [
      practiceSlotId,
      `${practiceSlotId}.initial`,
      `${practiceSlotId}.retry`,
    ]),
  );
  const validate = (raw: unknown) => {
    const parsed = PracticeGroundingResultSchema.safeParse(raw);
    const valid =
      fingerprint() === inputHash &&
      parsed.success &&
      parsed.data.decisions.length === 0 &&
      [...parsed.data.findings, ...(parsed.data.advisories ?? [])].every((finding) =>
        ids.has(finding.itemId),
      );
    return {
      valid,
      diagnostics: valid
        ? []
        : ['practice_grounding_inventory: return findings only for offered items.'],
      diagnosticCodes: valid ? [] : ['practice_grounding_inventory'],
    };
  };
  return {
    input,
    validate,
    candidateHash: practiceReviewHash(candidate),
    claimsHash: practiceGroundingClaimsHash(candidate),
    inputHash,
    findings: (result: TeachingContentReview) =>
      result.findings.map((finding) => ({ ...finding, itemId: finding.itemId.split('.')[0]! })),
  };
}

function savedGroundingCandidate(brief: TeachingBrief): PracticeContentProposalPayload {
  const items = savedProofItems(brief);
  return PracticeContentProposalPayloadSchema.parse({
    items: brief.practice!.items.map((item, index) => {
      const surface = (value: typeof item.initial, name: 'initial' | 'retry') => {
        const { correctOptionId: _key, ...claims } = value;
        return {
          ...claims,
          options: value.options.map(({ id, ...option }) => ({
            optionRef: id.slice(id.lastIndexOf('_') + 1),
            ...option,
          })),
          correctOptionRef: items[index]![name].key,
        };
      };
      return {
        practiceSlotId: items[index]!.practiceSlotId,
        capabilityTested: item.capabilityTested,
        pedagogicalReason: item.pedagogicalReason,
        sourceRefs: item.sourceRefIds,
        visualRefs: item.visualRefIds,
        application: item.application,
        initial: surface(item.initial, 'initial'),
        retry: surface(item.retry, 'retry'),
      };
    }),
  });
}

function savedGroundingContextHash(brief: TeachingBrief): string {
  return practiceReviewHash({
    workspaceId: brief.workspaceId,
    curriculumVersionId: brief.curriculumVersionId,
    studyPlanVersionId: brief.studyPlanVersionId,
    learningUnitId: brief.learningUnitId,
    executionSourceManifestFingerprint: brief.executionSourceManifestFingerprint,
    sourceContextFingerprint: brief.sourceContextFingerprint,
    sourceManifest: brief.sourceManifest,
    sourceReferences: brief.sourceReferences,
    visualReferences: brief.visualReferences,
    objective: brief.objective,
    prerequisites: brief.prerequisites,
    segments: brief.segments,
    summary: brief.summary,
    nextConnection: brief.nextConnection,
    composition: brief.composition,
    groundingProof: {
      policyVersion: brief.practice!.qualityEvaluation.groundingReview?.policyVersion,
      receipt: brief.practice!.qualityEvaluation.groundingReview?.rounds.at(-1),
    },
    practiceBindings: brief.practice!.items.map((item) => ({
      id: item.id,
      objectiveId: item.objectiveId,
      objectiveTitle: item.objectiveTitle,
      construct: item.construct,
      authority: item.authority,
    })),
  });
}

function groundingMatches(evidence: ReviewEvidence): boolean {
  const parsed = PracticeGroundingReviewSchema.safeParse(evidence.groundingReview);
  const receipts = evidence.contentReview;
  return (
    parsed.success &&
    parsed.data.policyVersion === PRACTICE_GROUNDING_POLICY_VERSION &&
    !!receipts?.length &&
    parsed.data.rounds.length === receipts.length &&
    parsed.data.rounds.every(
      (round, index) =>
        round.candidateHash === receipts[index]!.candidateHash &&
        round.logicalCallId === receipts[index]!.logicalCallId &&
        practiceReviewHash(round.result) === practiceReviewHash(receipts[index]!.result),
    )
  );
}

export function practiceProofItems(candidate: PracticeContentProposalPayload): ProofItem[] {
  return candidate.items.map((item) => {
    const surface = (value: AuthoredSurface): ProofSurface => ({
      ...projectLearnerPracticeSurface({
        prompt: value.prompt,
        options: value.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
      }),
      key: value.correctOptionRef,
      evidenceContrast: value.evidenceContrast,
    });
    return {
      practiceSlotId: item.practiceSlotId,
      initial: surface(item.initial),
      retry: surface(item.retry),
    };
  });
}

function savedProofItems(brief: TeachingBrief): ProofItem[] {
  const latest = brief.practice?.qualityEvaluation.answerabilityReview?.rounds.at(-1);
  return (brief.practice?.items ?? []).map((item, itemIndex) => {
    const actionId = latest?.solves.find(
      (solve) => solve.itemIndex === itemIndex && solve.surface === 'initial',
    )?.actionId;
    const surface = (value: typeof item.initial, name: 'initial' | 'retry'): ProofSurface => ({
      ...projectLearnerPracticeSurface({
        prompt: value.prompt,
        options: value.options.map(({ id, text }) => ({
          id: id.slice(id.lastIndexOf('_') + 1),
          text,
        })),
      }),
      key:
        value.options.some((option) => option.id === value.correctOptionId) &&
        value.options.every(
          (option) =>
            option.id === `${item.id}_${name}_${option.id.slice(option.id.lastIndexOf('_') + 1)}`,
        )
          ? value.correctOptionId.slice(value.correctOptionId.lastIndexOf('_') + 1)
          : '',
      evidenceContrast: value.evidenceContrast,
    });
    return {
      practiceSlotId: actionId?.slice(0, actionId.lastIndexOf('.')) ?? '',
      initial: surface(item.initial, 'initial'),
      retry: surface(item.retry, 'retry'),
    };
  });
}

export function preparePracticeAnswerabilityReview(
  surface: LearnerPracticeSolvingSurface,
  priorTeaching: PracticePriorTeaching,
  actionId: string,
  itemId: string,
) {
  const input: PracticeAnswerabilityReviewInput = {
    purpose: 'practice_answerability',
    stage: 'practice',
    candidate: { actionId, ...projectLearnerPracticeSurface(surface) },
    priorTeaching: structuredClone(priorTeaching),
    actionIds: [actionId],
  };
  // Bind the independent judgment to both the exact public surface and the
  // Practice-only policy that defines when it may clear a shallow-task warning.
  const inputHash = practiceReviewHash({
    acceptancePolicyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
    input,
  });
  const validate = (raw: unknown) => {
    const parsed = PracticeAnswerabilityResultSchema.safeParse(raw);
    const valid =
      parsed.success &&
      parsed.data.decisions.length === 1 &&
      parsed.data.decisions[0]!.actionId === actionId &&
      (parsed.data.advisories ?? []).every((finding) =>
        [actionId, itemId].includes(finding.itemId),
      );
    return {
      valid,
      diagnostics: valid
        ? []
        : ['practice_solve_inventory: cover the sole offered action exactly once.'],
      diagnosticCodes: valid ? [] : ['practice_solve_inventory'],
    };
  };
  return { input, inputHash, validate };
}

/** Comparison-only packet. It cannot supply an answer to the isolated blind solve. */
export function preparePracticeIntegrityReview(
  items: ProofItem[],
  priorTeaching: PracticePriorTeaching,
) {
  const input: AuthoredTeachingContentReviewInput = {
    purpose: 'practice_integrity',
    stage: 'practice',
    desiredDepth: 'pass_oriented',
    objectives: [],
    sources: [],
    candidate: {
      items: items.map((item) => ({
        practiceSlotId: item.practiceSlotId,
        initial: projectLearnerPracticeSurface(item.initial),
        retry: projectLearnerPracticeSurface(item.retry),
      })),
    },
    acceptedLesson: structuredClone(priorTeaching),
    actionIds: [],
  };
  const ids = new Set(
    items.flatMap(({ practiceSlotId }) => [
      practiceSlotId,
      `${practiceSlotId}.initial`,
      `${practiceSlotId}.retry`,
    ]),
  );
  const validate = (raw: unknown) => {
    const parsed = PracticeIntegrityResultSchema.safeParse(raw);
    const valid =
      parsed.success &&
      parsed.data.decisions.length === 0 &&
      [...parsed.data.findings, ...(parsed.data.advisories ?? [])].every((finding) =>
        ids.has(finding.itemId),
      );
    return {
      valid,
      diagnostics: valid
        ? []
        : [
            'practice_integrity_inventory: return concrete public replay/leakage findings only for offered tasks.',
          ],
      diagnosticCodes: valid ? [] : ['practice_integrity_inventory'],
    };
  };
  return {
    input,
    inputHash: practiceReviewHash({
      acceptancePolicyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
      input,
    }),
    validate,
  };
}

/** Public equality proves repetition; different/uncertain tokens never prove semantic novelty. */
function publicTaskDefects(items: ProofItem[], priorTeaching: PracticePriorTeaching): string[] {
  const taught = priorTeaching.segments
    .flatMap((segment) => [
      segment.workedProcess?.activity,
      segment.workedProcess?.transfer,
      segment.informalCheck,
    ])
    .filter((surface): surface is LearnerPracticeSolvingSurface => surface != null);
  return items.flatMap((item) => [
    ...(compareLearnerPracticeTasks(item.initial, item.retry) === 'equal'
      ? [`practice_public_retry_replay: ${item.practiceSlotId}`]
      : []),
    ...(['initial', 'retry'] as const).flatMap((name) =>
      taught.some((surface) => compareLearnerPracticeTasks(item[name], surface) === 'equal')
        ? [`practice_public_lesson_replay: ${item.practiceSlotId}.${name}`]
        : [],
    ),
  ]);
}

function reject(diagnostics: string[]): never {
  throw ProviderError.invalidOutput(
    diagnostics.join('; '),
    'candidate',
    'SEMANTIC_VALIDATION_FAILURE',
    false,
    {
      kind: 'practice_acceptance_rejection',
      diagnostics: diagnostics.map((message) => ({
        code: message.split(':')[0]!,
        message,
      })),
    },
  );
}

/** Every original, correction and fallback owes this contract, even with ignored callbacks. */
export function assertPracticeCandidate(
  candidate: PracticeContentProposalPayload,
  context: PracticeContentGenerationInput,
  priorTeaching: PracticePriorTeaching,
): void {
  const validation = validatePracticeContentCandidate(candidate, context);
  if (!validation.valid)
    throw ProviderError.invalidOutput(
      validation.diagnostics.join('; '),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      false,
      validation.failureArtifact,
    );
  const defects = publicTaskDefects(practiceProofItems(candidate), priorTeaching);
  if (defects.length) reject(defects);
}

function answerabilityMatches(
  items: ProofItem[],
  priorTeaching: PracticePriorTeaching,
  evidence: ReviewEvidence,
): boolean {
  const parsed = PracticeAnswerabilityReviewSchema.safeParse(evidence.answerabilityReview);
  const grounding = evidence.contentReview;
  if (
    !parsed.success ||
    parsed.data.policyVersion !== PRACTICE_ANSWERABILITY_POLICY_VERSION ||
    !grounding?.length ||
    parsed.data.rounds.length !== grounding.length ||
    parsed.data.rounds.some(
      (round, index) => round.candidateHash !== grounding[index]!.candidateHash,
    )
  )
    return false;
  const latest = parsed.data.rounds.at(-1)!;
  const lastGrounding = PracticeGroundingResultSchema.safeParse(grounding.at(-1)!.result);
  if (
    !lastGrounding.success ||
    lastGrounding.data.decisions.length ||
    lastGrounding.data.findings.length ||
    latest.solves.length !== items.length * 2 ||
    new Set(latest.solves.map((solve) => `${solve.itemIndex}.${solve.surface}`)).size !==
      latest.solves.length ||
    new Set(items.map((item) => item.practiceSlotId)).size !== items.length
  )
    return false;
  return latest.solves.every((solve) => {
    const item = items[solve.itemIndex];
    if (
      !item ||
      !/^PR[1-9][0-9]*$/u.test(item.practiceSlotId) ||
      solve.actionId !== `${item.practiceSlotId}.${solve.surface}`
    )
      return false;
    const surface = item[solve.surface];
    const prepared = preparePracticeAnswerabilityReview(
      surface,
      priorTeaching,
      solve.actionId,
      item.practiceSlotId,
    );
    const decision = solve.result.decisions[0];
    return (
      prepared.inputHash === solve.inputHash &&
      prepared.validate(solve.result).valid &&
      solve.result.findings.length === 0 &&
      surface.options.some(
        (option) => option.id === decision?.answerId && option.id === surface.key,
      )
    );
  });
}

function reviewEvidenceMatches(
  items: ProofItem[],
  priorTeaching: PracticePriorTeaching,
  evidence: ReviewEvidence,
): boolean {
  if (!groundingMatches(evidence) || !answerabilityMatches(items, priorTeaching, evidence))
    return false;
  // Only exact, current, independently solved public surfaces establish this
  // obligation. A missing private operation neither adds nor discharges it.
  if (
    evidence.answerabilityReview!.rounds.at(-1)!.solves.some((solve) => {
      const surface = items[solve.itemIndex]![solve.surface];
      return (
        practiceEvidenceContrastFinding(
          {
            ...surface,
            options: surface.options.map(({ id }) => ({ optionRef: id })),
            correctOptionRef: surface.key,
          },
          solve.result.decisions[0]!.requiresCaseInference,
        ) !== undefined
      );
    })
  )
    return false;
  const parsed = PracticeIntegrityReviewSchema.safeParse(evidence.integrityReview);
  const grounding = evidence.contentReview!;
  if (
    !parsed.success ||
    parsed.data.policyVersion !== PRACTICE_ACCEPTANCE_POLICY_VERSION ||
    parsed.data.rounds.length !== grounding.length ||
    parsed.data.rounds.some(
      (round, index) => round.candidateHash !== grounding[index]!.candidateHash,
    )
  )
    return false;
  const latest = parsed.data.rounds.at(-1)!;
  const prepared = preparePracticeIntegrityReview(items, priorTeaching);
  return (
    latest.inputHash === prepared.inputHash &&
    prepared.validate(latest.result).valid &&
    latest.result.findings.length === 0
  );
}

export function assertReviewedPracticeAcceptance(
  candidate: PracticeContentProposalPayload,
  context: PracticeContentGenerationInput,
  priorTeaching: PracticePriorTeaching,
  evidence: ReviewEvidence,
): void {
  assertPracticeCandidate(candidate, context, priorTeaching);
  const grounding = preparePracticeGroundingReview(context, candidate);
  const receipt = evidence.groundingReview?.rounds.at(-1);
  if (
    evidence.contentReview?.at(-1)?.candidateHash !== practiceReviewHash(candidate) ||
    receipt?.inputHash !== grounding.inputHash ||
    receipt?.claimsHash !== grounding.claimsHash ||
    !reviewEvidenceMatches(practiceProofItems(candidate), priorTeaching, evidence)
  )
    reject([
      'practice_acceptance_proof_missing_or_stale: require exact grounding, isolated solves and public integrity receipts.',
    ]);
}

/** Seal the local projection only after its exact authored/context proofs are current. */
export function bindPracticeGroundingToBrief(
  brief: TeachingBrief,
  candidate: PracticeContentProposalPayload,
  context: PracticeContentGenerationInput,
): void {
  const evidence = brief.practice!.qualityEvaluation;
  assertReviewedPracticeAcceptance(
    candidate,
    context,
    projectPracticePriorTeaching(brief),
    evidence,
  );
  if (
    context.sourceContext.offers.length !== brief.sourceReferences.length ||
    context.sourceContext.offers.some(
      (offer) =>
        !brief.sourceReferences.some(
          (reference) => reference.refId === offer.sourceRef && reference.quote === offer.text,
        ),
    )
  )
    reject(['practice_grounding_source_changed: saved excerpts differ from reviewed sources.']);
  if (
    practiceGroundingClaimsHash(savedGroundingCandidate(brief)) !==
    practiceGroundingClaimsHash(candidate)
  )
    reject(['practice_grounding_projection_changed: saved claims differ from reviewed claims.']);
  evidence.groundingReview!.savedContextHash = savedGroundingContextHash(brief);
}

/** Compatibility helper: answerability alone never grants current Practice acceptance. */
export function hasCurrentPracticeAnswerabilityReview(brief: TeachingBrief): boolean {
  return (
    !!brief.practice &&
    answerabilityMatches(
      savedProofItems(brief),
      projectPracticePriorTeaching(brief),
      brief.practice.qualityEvaluation,
    )
  );
}

/** Shared assembly, reuse and execution gate; historical receipts are never upgraded on read. */
export function hasCurrentPreparedPractice(brief: TeachingBrief): boolean {
  if (!brief.practice || !hasCurrentPracticeAcceptancePolicy(brief)) return false;
  const items = savedProofItems(brief);
  const priorTeaching = projectPracticePriorTeaching(brief);
  if (publicTaskDefects(items, priorTeaching).length) return false;
  const evidence = brief.practice.qualityEvaluation;
  if (!reviewEvidenceMatches(items, priorTeaching, evidence)) return false;
  try {
    return (
      evidence.groundingReview!.rounds.at(-1)!.claimsHash ===
        practiceGroundingClaimsHash(savedGroundingCandidate(brief)) &&
      evidence.groundingReview!.savedContextHash === savedGroundingContextHash(brief)
    );
  } catch {
    return false;
  }
}
