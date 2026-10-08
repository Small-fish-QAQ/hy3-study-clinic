import { createHash } from 'node:crypto';
import {
  PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
  PracticeRepairAcceptanceSchema,
  PracticeRepairContextSchema,
  PracticeRepairGroundingResultSchema,
  PracticeRepairIntegrityResultSchema,
  TeachingContentReviewSchema,
  projectLearnerPracticeSurface,
  type PracticeRepairAcceptance,
  type PracticeRepairContent,
  type PracticeRecoveryState,
  type TeachingBrief,
  type LessonExecutionState,
} from '@hy3-clinic/shared';
import type {
  PracticeRepairInput,
  PracticeRepairGroundingReviewInput,
  PracticeRepairAnswerabilityReviewInput,
  PracticeRepairIntegrityReviewInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';

// JSON hydration may reorder keys; every value and array order remains significant.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}
export const practiceRepairHash = (value: unknown) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;

const teaching = (content: PracticeRepairContent) => [
  content.diagnosis.observation,
  content.diagnosis.gap,
  content.explanation,
  content.workedExample.prompt,
  ...content.workedExample.steps,
  content.workedExample.conclusion,
  content.contrast,
];

export function preparePracticeRepairReviews(
  request: PracticeRepairInput,
  content: PracticeRepairContent,
) {
  const { revision: _revision, ...rawContext } = request;
  const context = PracticeRepairContextSchema.parse(rawContext);
  // Neither the original author key nor ANY saved Retest feedback is prior teaching.
  // Failed feedback explicitly rendered by the UI is supplied by visibleFeedback.
  const priorTeaching = [
    ...context.teachingContext,
    ...(context.visibleFeedback ?? []),
    ...context.priorRounds.flatMap(teaching),
    ...(context.tutorExplanations ?? []),
    ...teaching(content),
  ];
  const grounding: PracticeRepairGroundingReviewInput = {
    purpose: 'repair_grounding',
    stage: 'practice',
    desiredDepth: context.desiredDepth,
    objective: context.objective,
    evidence: structuredClone(context),
    candidate: structuredClone(content),
    actionIds: [],
  };
  const solves: PracticeRepairAnswerabilityReviewInput[] = content.retest.map((surface, index) => ({
    purpose: 'repair_answerability',
    stage: 'practice',
    candidate: { actionId: `retest${index}.check`, ...projectLearnerPracticeSurface(surface) },
    priorTeaching: structuredClone(priorTeaching),
    actionIds: [`retest${index}.check`],
  }));
  const integrity: PracticeRepairIntegrityReviewInput = {
    purpose: 'repair_integrity',
    stage: 'practice',
    candidate: content.retest.map((surface, index) => ({
      itemId: `retest${index}`,
      ...projectLearnerPracticeSurface(surface),
    })),
    priorTeaching: structuredClone(priorTeaching),
    comparisonPrompts: [
      context.failedPrompt,
      ...context.unseenPracticePrompts,
      ...context.archivedRetestPrompts,
      ...context.priorRounds.flatMap((round) => [
        round.workedExample.prompt,
        ...round.retest.map((surface) => surface.prompt),
      ]),
      content.workedExample.prompt,
    ],
    actionIds: [],
  };
  const inputHash = (input: unknown) =>
    practiceRepairHash({ policyVersion: PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION, input });
  const ids = new Set(['repair', 'retest0', 'retest1']);
  const validateGrounding = (raw: unknown) => {
    const result = PracticeRepairGroundingResultSchema.parse(raw);
    if ([...result.findings, ...(result.advisories ?? [])].some(({ itemId }) => !ids.has(itemId)))
      throw ProviderError.invalidOutput('Repair grounding used an unoffered item identity.');
    return result;
  };
  const validateSolve = (raw: unknown, index: number) => {
    const result = TeachingContentReviewSchema.parse(raw);
    if (
      result.decisions.length !== 1 ||
      result.findings.length ||
      result.decisions[0]!.actionId !== solves[index]!.candidate.actionId ||
      (result.decisions[0]!.answerId !== null &&
        !solves[index]!.candidate.options.some(({ id }) => id === result.decisions[0]!.answerId))
    )
      throw ProviderError.invalidOutput(
        'Retest solve must cover only its own action with an offered answer or null.',
      );
    return result;
  };
  const validateIntegrity = (raw: unknown) => {
    const result = PracticeRepairIntegrityResultSchema.parse(raw);
    if ([...result.findings, ...(result.advisories ?? [])].some(({ itemId }) => !ids.has(itemId)))
      throw ProviderError.invalidOutput('Repair integrity used an unoffered item identity.');
    return result;
  };
  return {
    context,
    grounding,
    solves,
    integrity,
    inputHash,
    validateGrounding,
    validateSolve,
    validateIntegrity,
  };
}

/** Stable current authority binding, excluding progressing round responses and leases. */
export function practiceRepairBindingHash(
  brief: TeachingBrief,
  state: LessonExecutionState,
  itemIndex: number,
  design: Pick<PracticeRepairInput, 'desiredDepth' | 'unitFocus' | 'tutorExplanations'>,
) {
  const attempt = state.practiceInteractions.findLast(
    (entry) => entry.itemIndex === itemIndex && !entry.correct,
  );
  if (!attempt) return '';
  const { recovery: _recovery, ...failedAttempt } = attempt;
  return practiceRepairHash({
    policyVersion: PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION,
    brief,
    state: {
      id: state.id,
      sessionId: state.sessionId,
      agendaItemId: state.agendaItemId,
      curriculumVersionId: state.curriculumVersionId,
      studyPlanVersionId: state.studyPlanVersionId,
      learningUnitId: state.learningUnitId,
      sourceContextFingerprint: state.sourceContextFingerprint,
      executionSourceManifestFingerprint: state.executionSourceManifestFingerprint,
      informalInteractions: state.informalInteractions,
    },
    itemIndex,
    failedAttempt,
    design,
  });
}

export function practiceRepairAcceptanceFindings(
  content: PracticeRepairContent,
  proof: PracticeRepairAcceptance,
): string[] {
  const findings = [...proof.grounding.result.findings, ...proof.integrity.result.findings].map(
    (finding) => `${finding.code}: ${finding.problem} ${finding.repairInstruction}`,
  );
  for (const [index, surface] of content.retest.entries()) {
    const solve = proof.solves.find((entry) => entry.index === index);
    if (solve?.result.decisions[0]?.answerId !== surface.correctOptionId)
      findings.push(
        `Retest ${index + 1} lacks a unique independently confirmed offered answer. ${solve?.result.decisions[0]?.evidenceUsed ?? ''}`,
      );
  }
  return findings;
}

/** Reconstruct purpose inputs on every admission; a cache hit or call ID is never proof. */
export function hasPracticeRepairProof(
  content: PracticeRepairContent,
  value: unknown,
): value is PracticeRepairAcceptance {
  const parsed = PracticeRepairAcceptanceSchema.safeParse(value);
  if (!parsed.success) return false;
  const proof = parsed.data;
  if (
    proof.policyVersion !== PRACTICE_REPAIR_ACCEPTANCE_POLICY_VERSION ||
    proof.candidateHash !== practiceRepairHash(content)
  )
    return false;
  try {
    const prepared = preparePracticeRepairReviews(proof.context, content);
    return (
      proof.grounding.inputHash === prepared.inputHash(prepared.grounding) &&
      prepared.validateGrounding(proof.grounding.result).findings.length === 0 &&
      new Set(proof.solves.map((solve) => solve.index)).size === 2 &&
      proof.solves.every(
        (solve) =>
          solve.inputHash === prepared.inputHash(prepared.solves[solve.index]) &&
          prepared.validateSolve(solve.result, solve.index).decisions[0]!.answerId ===
            content.retest[solve.index]!.correctOptionId,
      ) &&
      proof.integrity.inputHash === prepared.inputHash(prepared.integrity) &&
      prepared.validateIntegrity(proof.integrity.result).findings.length === 0
    );
  } catch {
    return false;
  }
}

export function hasCurrentPracticeRepair(
  round: PracticeRecoveryState['rounds'][number],
  bindingHash: string,
  previous: PracticeRecoveryState['rounds'] = [],
): boolean {
  if (
    !hasPracticeRepairProof(round.content, round.acceptance) ||
    round.acceptance.bindingHash !== bindingHash ||
    round.learnerNote !== round.acceptance.context.learnerNote ||
    round.reviewLogicalCallId !== round.acceptance.grounding.logicalCallId ||
    (round.responses.length > 0 && !round.startedAt) ||
    round.responses.some((response, index) => {
      const surface = round.content.retest[index]!;
      const option = surface.options.find(({ id }) => id === response.selectedOptionId);
      return (
        !option ||
        response.correct !== (option.id === surface.correctOptionId) ||
        response.feedback !== `${option.feedbackIfSelected} ${surface.explanation}`
      );
    })
  )
    return false;
  // Retained history must still equal the immutable preparation snapshot. The
  // existing three-round cap may have archived its oldest prefix.
  const prior = round.acceptance.context.priorRounds;
  const retained = previous;
  if (retained.some((entry) => !hasPracticeRepairProof(entry.content, entry.acceptance)))
    return false;
  return (
    retained.length <= prior.length &&
    retained.every(
      (entry, index) =>
        practiceRepairHash(entry.content) ===
        practiceRepairHash(prior[prior.length - retained.length + index]),
    )
  );
}

export function assertPracticeRepairAcceptance(
  content: PracticeRepairContent,
  proof: PracticeRepairAcceptance,
  bindingHash: string,
): void {
  if (!hasPracticeRepairProof(content, proof) || proof.bindingHash !== bindingHash)
    throw ProviderError.invalidOutput('Repair acceptance proof is missing, rejected or stale.');
}
