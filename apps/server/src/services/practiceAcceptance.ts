import { createHash } from 'node:crypto';
import {
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  PracticeAnswerabilityReviewSchema,
  PracticeIntegrityReviewSchema,
  TeachingContentReviewSchema,
  projectLearnerPracticeSurface,
  projectPracticePriorTeaching,
  type LearnerPracticeSolvingSurface,
  type PracticePriorTeaching,
  type PracticeContentProposalPayload,
  type PracticeQualityEvaluation,
  type TeachingBrief,
} from '@hy3-clinic/shared';
import type {
  AuthoredTeachingContentReviewInput,
  PracticeAnswerabilityReviewInput,
  PracticeContentGenerationInput,
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
  'contentReview' | 'answerabilityReview' | 'integrityReview'
>;

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
    const parsed = TeachingContentReviewSchema.safeParse(raw);
    const valid =
      parsed.success &&
      parsed.data.decisions.length === 1 &&
      parsed.data.decisions[0]!.actionId === actionId &&
      parsed.data.findings.every((finding) => [actionId, itemId].includes(finding.itemId));
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
    const parsed = TeachingContentReviewSchema.safeParse(raw);
    const valid =
      parsed.success &&
      parsed.data.decisions.length === 0 &&
      parsed.data.findings.every(
        (finding) =>
          ids.has(finding.itemId) &&
          (finding.code === 'practice_replay' || finding.code === 'answer_leak'),
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
  const lastGrounding = TeachingContentReviewSchema.safeParse(grounding.at(-1)!.result);
  if (
    !lastGrounding.success ||
    lastGrounding.data.decisions.length ||
    lastGrounding.data.findings.some((finding) => finding.code !== 'shallow_task') ||
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
      !solve.result.findings.some((finding) => finding.code !== 'shallow_task') &&
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
  if (!answerabilityMatches(items, priorTeaching, evidence)) return false;
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
  if (
    evidence.contentReview?.at(-1)?.candidateHash !== practiceReviewHash(candidate) ||
    !reviewEvidenceMatches(practiceProofItems(candidate), priorTeaching, evidence)
  )
    reject([
      'practice_acceptance_proof_missing_or_stale: require exact grounding, isolated solves and public integrity receipts.',
    ]);
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
  return reviewEvidenceMatches(items, priorTeaching, brief.practice.qualityEvaluation);
}
