import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  TeachingContentReviewSchema,
  MAX_TEACHING_CONTENT_REVIEWS,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  projectLearnerPracticeSurface,
  projectPracticePriorTeaching,
  type LearnerPracticeSolvingSurface,
  type PracticePriorTeaching,
  type PracticeAnswerabilityReview,
  type TeachingBrief,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type PracticeQualityFinding,
  type PracticeQualityImprovement,
  type PracticeQualityEvaluation,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  AuthoredTeachingContentReviewInput,
  PracticeAnswerabilityReviewInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';
import { validatePracticeContentCandidate } from './teachingBriefContract.js';
import { compareLearnerPracticeTasks } from './practiceTaskCanonicalization.js';
import {
  evaluatePlannedPracticeQuality,
  practiceQualityImprovementFindings,
} from './lessonPedagogyEvaluator.js';

const AUTHOR_KEYS = new Set([
  'relevanceToObjective',
  'reasoningOperation',
  'requiredInference',
  'decisiveCondition',
  'evidenceContrast',
  'correctOptionId',
  'correctOptionRef',
  'feedbackIfSelected',
  'correctDebrief',
  'debrief',
  'expectedSignal',
]);

function withoutAuthorDeclarations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAuthorDeclarations);
  if (value === null || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !AUTHOR_KEYS.has(key))
      .map(([key, child]) => [key, withoutAuthorDeclarations(child)]),
  );
  const original = value as Record<string, unknown>;
  if (original.activity && original.scaffold && original.transfer) {
    result.afterWrongGuidedResponse = {
      visibility:
        'Hint and scaffold are shown only AFTER a wrong guided answer is committed. They may explain that error. Judge scaffold sufficiency independently; do not classify this delayed assistance as a pre-guided-answer leak.',
      hint: result.hint,
      scaffold: result.scaffold,
    };
    delete result.hint;
    delete result.scaffold;
  }
  const interaction = original.interaction as { pauseAfterStepIndex?: number } | undefined;
  if (Array.isArray(original.steps) && typeof interaction?.pauseAfterStepIndex === 'number') {
    result.steps = withoutAuthorDeclarations(
      original.steps.slice(0, interaction.pauseAfterStepIndex + 1),
    );
    result.afterGuidedResponse = {
      visibility:
        'Continuation and result withheld from independent solution. The learner sees these only after the guided response.',
    };
    result.afterTransferResponse = {
      visibility: 'HIDDEN until the learner answers transfer.',
    };
    delete result.result;
    delete result.whyResultFollows;
    // The actual worked-interaction projection always sets this author-only
    // description to null, including before the guided response.
    delete result.learnerDecision;
  }
  if (Array.isArray(original.options)) {
    result.options = original.options.map((option: Record<string, unknown>) => ({
      id: option.id ?? option.optionRef,
      text: option.text,
    }));
    result.afterResponse = {
      visibility:
        'Author solutions and feedback withheld. Independently solve this question from its visible facts.',
    };
    for (const key of ['correctDebrief', 'debrief', 'explanation', 'expectedSignal'])
      delete result[key];
  }
  return result;
}

/** Calculated traces repeat the same rule graph in every option's feedback.
 * Review the authored model and actual tasks, not duplicate arithmetic proofs. */
function compactComputedReview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactComputedReview);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'optionFeedback',
            'semanticRelations',
            'afterGuidedResponse',
            'afterTransferResponse',
            'inputs',
          ].includes(key),
      )
      .map(([key, child]) => [key, compactComputedReview(child)]),
  );
}

export async function verifyPreparedTeaching<
  T extends LessonSlotContentProposalPayload | PracticeContentProposalPayload,
>(
  context: LessonSlotContentGenerationInput | PracticeContentGenerationInput,
  candidate: T,
  review: (
    prepared: ReturnType<typeof prepareTeachingReview>,
    round: number,
  ) => Promise<{ result: TeachingContentReview; logicalCallId: string }>,
  revise: (draft: T, findings: TeachingContentReview['findings']) => Promise<T>,
  computedItemIds: ReadonlySet<string> = new Set(),
) {
  const receipts = [];
  let previousFindings: TeachingContentReview['findings'] | undefined;
  for (let round = 0; round < MAX_TEACHING_CONTENT_REVIEWS; round += 1) {
    const prepared = prepareTeachingReview(context, candidate, computedItemIds);
    const reviewed = await review(prepared, round);
    if (!prepared.validate(reviewed.result).valid)
      throw ProviderError.invalidOutput(
        'Teaching review did not cover its exact action inventory.',
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
      );
    receipts.push({ ...reviewed, candidateHash: prepared.candidateHash });
    const findings = prepared.findings(reviewed.result);
    if (!findings.length) return { candidate, receipts };
    const findingKey = (finding: TeachingContentReview['findings'][number]) =>
      `${finding.itemId}\u0000${finding.code}`;
    const resolvedPriorDefect = previousFindings?.some(
      (prior) => !findings.some((current) => findingKey(current) === findingKey(prior)),
    );
    const changedDraft = round > 0 && receipts[round - 1]!.candidateHash !== prepared.candidateHash;
    // One extra correction is worthwhile when the first revision demonstrably
    // resolved a defect and revealed another. Never reroll unchanged material
    // or keep asking the reviewer until a still-failing draft gets a pass.
    if (
      round === MAX_TEACHING_CONTENT_REVIEWS - 1 ||
      (round === 1 && (!changedDraft || !resolvedPriorDefect))
    )
      throw ProviderError.invalidOutput(
        'Teaching content still has material defects after its bounded revision.',
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        true,
        {
          kind: 'teaching_content_review_failed',
          diagnostics: findings.map(({ code, problem }) => ({ code, message: problem })),
        },
      );
    previousFindings = findings;
    candidate = await revise(candidate, findings);
  }
  throw new Error('Unreachable teaching review state.');
}

export function prepareTeachingReview(
  context: LessonSlotContentGenerationInput | PracticeContentGenerationInput,
  candidate: LessonSlotContentProposalPayload | PracticeContentProposalPayload,
  computedItemIds: ReadonlySet<string> = new Set(),
) {
  const answers = new Map<string, { itemId: string; answerId: string }>();
  const annotated = structuredClone(candidate);
  if ('slots' in annotated) {
    for (const slot of annotated.slots) {
      if (computedItemIds.has(slot.slotId)) continue;
      const interaction = slot.workedProcess?.interaction;
      const actions = [
        ['guided', interaction?.activity],
        ['scaffold', interaction?.scaffold],
        ['transfer', interaction?.transfer],
        ['check', slot.informalCheck],
      ] as const;
      for (const [name, action] of actions) {
        if (!action?.options?.length || !action.correctOptionId) continue;
        const actionId = `${slot.slotId}.${name}`;
        Object.assign(action, { actionId });
        answers.set(actionId, { itemId: slot.slotId, answerId: action.correctOptionId });
      }
    }
  } else {
    for (const item of annotated.items)
      for (const name of ['initial', 'retry'] as const) {
        const actionId = `${item.practiceSlotId}.${name}`;
        Object.assign(item[name], { actionId });
        answers.set(actionId, {
          itemId: item.practiceSlotId,
          answerId: item[name].correctOptionRef,
        });
      }
  }
  const input: AuthoredTeachingContentReviewInput = {
    stage: 'slots' in candidate ? 'lesson' : 'practice',
    computedOutcomes: context.computedCases,
    ...(computedItemIds.size ? { computedItemIds: [...computedItemIds] } : {}),
    desiredDepth: context.courseDesign?.desiredDepth ?? 'pass_oriented',
    objectives: context.skeleton.objectives.map(({ title, description }) => ({
      title,
      description,
    })),
    sources: context.sourceContext.offers.map(({ sourceRef, text }) => ({ sourceRef, text })),
    candidate: context.computedCases
      ? compactComputedReview(withoutAuthorDeclarations(annotated))
      : withoutAuthorDeclarations(annotated),
    ...('acceptedLesson' in context
      ? {
          acceptedLesson: context.computedCases
            ? compactComputedReview(withoutAuthorDeclarations(context.acceptedLesson))
            : withoutAuthorDeclarations(context.acceptedLesson),
        }
      : {}),
    actionIds: [...answers.keys()],
  };
  const itemIds =
    'slots' in candidate
      ? candidate.slots.map((s) => s.slotId)
      : candidate.items.map((s) => s.practiceSlotId);
  const validate = (raw: unknown) => {
    const parsed = TeachingContentReviewSchema.safeParse(raw);
    const ids = parsed.success ? parsed.data.decisions.map((decision) => decision.actionId) : [];
    const valid =
      parsed.success &&
      ((context.computedCases && ids.length === 0) ||
        (ids.length === answers.size && new Set(ids).size === answers.size)) &&
      ids.every((id) => answers.has(id)) &&
      parsed.data.findings.every(
        (finding) => itemIds.includes(finding.itemId) || answers.has(finding.itemId),
      );
    return {
      valid,
      diagnostics: valid
        ? []
        : [
            'teaching_review_inventory: cover every offered actionId exactly once and use only offered itemIds.',
          ],
      diagnosticCodes: valid ? [] : ['teaching_review_inventory'],
    };
  };
  const findings = (review: TeachingContentReview): TeachingContentReview['findings'] => [
    ...review.findings
      .filter((finding) => finding.code !== 'shallow_task')
      .map((finding) => ({
        ...finding,
        itemId: answers.get(finding.itemId)?.itemId ?? finding.itemId,
      })),
    ...review.decisions.flatMap<TeachingContentReview['findings'][number]>((decision) => {
      const expected = answers.get(decision.actionId)!;
      if (decision.answerId !== expected.answerId)
        return [
          {
            itemId: expected.itemId,
            code: 'insufficient_evidence' as const,
            problem: `${decision.actionId}: independent reading selects ${decision.answerId ?? 'no unique answer'}, not the authored key. ${decision.evidenceUsed}`,
            repairInstruction:
              'Make the visible evidence sufficient and the keyed answer unambiguous; recompute all feedback and subsequent states.',
          },
        ];
      // Difficulty opinions remain in the receipt, including explicit shallow_task
      // findings. REAL review repeatedly called rule application "copying" and
      // moved that rejection between unchanged actions. Deterministic cognitive
      // contracts and browser acceptance own that claim; correctness, grounding,
      // leakage and the remaining concrete defects still fail closed here.
      return [];
    }),
  ];
  return {
    input,
    validate,
    findings,
    candidateHash: `sha256:${createHash('sha256').update(JSON.stringify(candidate)).digest('hex')}`,
  };
}

const reviewHash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const initialPracticeSurface = (
  initial: PracticeContentProposalPayload['items'][number]['initial'],
) => ({
  prompt: initial.prompt,
  options: initial.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
});

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
  const inputHash = reviewHash({
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

type PracticeReviewRequest = {
  input: TeachingContentReviewInput;
  validate: ReturnType<typeof preparePracticeAnswerabilityReview>['validate'];
};

/** Practice-only gate. Rich grounding results never supply independent answers. */
export async function verifyPreparedPractice(
  context: PracticeContentGenerationInput,
  candidate: PracticeContentProposalPayload,
  priorTeaching: PracticePriorTeaching,
  review: (
    prepared: PracticeReviewRequest,
    round: number,
  ) => Promise<{ result: TeachingContentReview; logicalCallId: string }>,
  revise: (
    draft: PracticeContentProposalPayload,
    findings: TeachingContentReview['findings'],
  ) => Promise<PracticeContentProposalPayload>,
  improveQuality?: (
    draft: PracticeContentProposalPayload,
    findings: PracticeQualityFinding[],
  ) => Promise<PracticeContentProposalPayload>,
  assertOriginalCurrent?: () => void | Promise<void>,
) {
  const receipts: NonNullable<PracticeQualityEvaluation['contentReview']> = [];
  const answerabilityReview: PracticeAnswerabilityReview = {
    policyVersion: PRACTICE_ANSWERABILITY_POLICY_VERSION,
    rounds: [],
  };
  let previousFindings: TeachingContentReview['findings'] | undefined;
  const qualityImprovement: PracticeQualityImprovement = {
    attempts: 0,
    outcome: 'not_needed',
    findingsBefore: [],
  };
  let original:
    | {
        candidate: PracticeContentProposalPayload;
        candidateHash: string;
        contextHash: string;
        priorTeachingHash: string;
        computedCases: boolean | undefined;
        receipts: typeof receipts;
        answerabilityReview: PracticeAnswerabilityReview;
      }
    | undefined;
  const acceptOriginal = async (error: unknown) => {
    if (!original) throw error;
    // Only this unchanged computed candidate may recover its own execution proof.
    context.computedCases = original.computedCases;
    await assertOriginalCurrent?.();
    if (
      reviewHash(original.candidate) !== original.candidateHash ||
      reviewHash(context) !== original.contextHash ||
      reviewHash(priorTeaching) !== original.priorTeachingHash ||
      original.answerabilityReview.policyVersion !== PRACTICE_ANSWERABILITY_POLICY_VERSION ||
      original.answerabilityReview.rounds.at(-1)?.candidateHash !== original.candidateHash ||
      original.receipts.at(-1)?.candidateHash !== original.candidateHash
    )
      throw ProviderError.invalidOutput(
        'The original Practice proof no longer matches its current acceptance context.',
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        {
          kind: 'practice_quality_fallback_rejection',
          diagnostics: [
            {
              code: 'practice_original_proof_stale',
              message: 'Original candidate, sources, plan or prior teaching changed after review.',
            },
          ],
        },
      );
    const validation = validatePracticeContentCandidate(original.candidate, context);
    if (!validation.valid)
      throw ProviderError.invalidOutput(
        validation.diagnostics.join('; '),
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        validation.failureArtifact,
      );
    qualityImprovement.outcome =
      error instanceof ProviderError && error.code === ApiErrorCode.ProviderInvalidOutput
        ? 'rejected'
        : 'failed';
    qualityImprovement.failureCode =
      error instanceof ProviderError
        ? (error.technicalFailureCode ?? error.code)
        : 'QUALITY_IMPROVEMENT_FAILED';
    // Failed/partial reviews of the rewrite never certify the selected original.
    return {
      candidate: original.candidate,
      receipts: original.receipts,
      answerabilityReview: original.answerabilityReview,
      qualityImprovement,
    };
  };
  for (let round = 0; round < MAX_TEACHING_CONTENT_REVIEWS; round += 1) {
    try {
      // Providers may ignore callbacks. Each original/revised candidate still
      // owes the complete current structural, authority and integrity contract.
      if (improveQuality) {
        const validation = validatePracticeContentCandidate(candidate, context);
        if (!validation.valid)
          throw ProviderError.invalidOutput(
            validation.diagnostics.join('; '),
            'candidate',
            'SEMANTIC_VALIDATION_FAILURE',
            false,
            validation.failureArtifact,
          );
      }
      const prepared = prepareTeachingReview(context, candidate);
      const allowedIds = new Set([
        ...candidate.items.map((item) => item.practiceSlotId),
        ...prepared.input.actionIds,
      ]);
      const groundingInput: AuthoredTeachingContentReviewInput = {
        ...prepared.input,
        purpose: 'practice_grounding',
        actionIds: [],
      };
      const validateGrounding = (raw: unknown) => {
        const parsed = TeachingContentReviewSchema.safeParse(raw);
        const valid =
          parsed.success &&
          parsed.data.decisions.length === 0 &&
          parsed.data.findings.every((finding) => allowedIds.has(finding.itemId));
        return {
          valid,
          diagnostics: valid
            ? []
            : ['practice_grounding_inventory: return findings only for offered items.'],
          diagnosticCodes: valid ? [] : ['practice_grounding_inventory'],
        };
      };
      const grounded = await review({ input: groundingInput, validate: validateGrounding }, round);
      if (!validateGrounding(grounded.result).valid)
        throw ProviderError.invalidOutput(
          'Practice grounding review must return only findings for its exact inventory.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          false,
        );
      receipts.push({ ...grounded, candidateHash: prepared.candidateHash });
      const findings = prepared.findings(grounded.result);
      const solves: PracticeAnswerabilityReview['rounds'][number]['solves'] = [];
      for (const [itemIndex, item] of candidate.items.entries()) {
        for (const surface of ['initial', 'retry'] as const) {
          const authored = item[surface];
          const visible = projectLearnerPracticeSurface({
            prompt: authored.prompt,
            options: authored.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
          });
          const actionId = `${item.practiceSlotId}.${surface}`;
          const solve = preparePracticeAnswerabilityReview(
            visible,
            priorTeaching,
            actionId,
            item.practiceSlotId,
          );
          const solved = await review(solve, round);
          if (!solve.validate(solved.result).valid)
            throw ProviderError.invalidOutput(
              'Practice independent solve did not cover its sole action inventory.',
              'candidate',
              'SEMANTIC_VALIDATION_FAILURE',
              false,
            );
          solves.push({
            ...solved,
            actionId,
            itemIndex,
            surface,
            inputHash: solve.inputHash,
          });
          findings.push(
            ...solved.result.findings
              .filter((finding) => finding.code !== 'shallow_task')
              .map((finding) => ({ ...finding, itemId: item.practiceSlotId })),
          );
          const decision = solved.result.decisions[0]!;
          if (
            !visible.options.some((option) => option.id === decision.answerId) ||
            decision.answerId !== authored.correctOptionRef
          )
            findings.push({
              itemId: item.practiceSlotId,
              code: 'insufficient_evidence',
              problem: `${actionId}: learner-visible independent reading selects ${decision.answerId ?? 'no unique answer'}, not the offered authored key. ${decision.evidenceUsed}`,
              repairInstruction:
                'Make this unanswered surface and its prior public teaching sufficient for one offered answer; correct the saved key and feedback if necessary. Do not rely on private application data or future questions.',
            });
        }
      }
      answerabilityReview.rounds.push({ candidateHash: prepared.candidateHash, solves });
      if (!findings.length) {
        // Only a rewrite resolving this contextual warning owes a changed public
        // task and independent confirmation of case inference. Aggregate policy
        // and originals remain untouched; a rejected rewrite recovers its original.
        if (original) {
          for (const finding of qualityImprovement.findingsBefore) {
            if (finding.code !== 'practice_initial_recognition_at_depth') continue;
            for (const index of finding.itemIndexes) {
              const before = original.candidate.items[index]!;
              const itemIndex = candidate.items.findIndex(
                (item) => item.practiceSlotId === before.practiceSlotId,
              );
              const after = candidate.items[itemIndex]!;
              const solved = solves.find(
                (solve) => solve.itemIndex === itemIndex && solve.surface === 'initial',
              )!;
              if (
                compareLearnerPracticeTasks(
                  initialPracticeSurface(before.initial),
                  initialPracticeSurface(after.initial),
                ) !== 'different' ||
                !solved.result.decisions[0]!.requiresCaseInference
              )
                throw ProviderError.invalidOutput(
                  'A shallow Practice rewrite must change the visible task beyond cosmetics and independently require case inference, not merely change its operation label.',
                  'candidate',
                  'SEMANTIC_VALIDATION_FAILURE',
                  false,
                  {
                    kind: 'practice_quality_improvement_rejection',
                    diagnostics: [
                      {
                        code: 'practice_shallow_reasoning_relabel',
                        message: `${before.practiceSlotId}.initial did not establish a deeper public reasoning task.`,
                      },
                    ],
                  },
                );
            }
          }
        }
        const qualityFindings = practiceQualityImprovementFindings(
          evaluatePlannedPracticeQuality(candidate, context, {
            evaluatedAt: '1970-01-01T00:00:00.000Z',
          }),
        );
        if (improveQuality && qualityFindings.length && qualityImprovement.attempts === 0) {
          qualityImprovement.findingsBefore = structuredClone(qualityFindings);
          if (round < MAX_TEACHING_CONTENT_REVIEWS - 1) {
            qualityImprovement.attempts = 1;
            original = {
              candidate: structuredClone(candidate),
              candidateHash: prepared.candidateHash,
              contextHash: reviewHash(context),
              priorTeachingHash: reviewHash(priorTeaching),
              computedCases: context.computedCases,
              receipts: structuredClone(receipts),
              answerabilityReview: structuredClone(answerabilityReview),
            };
            // Spend an existing review round, never add an outer retry budget.
            // The following round obtains fresh grounding and visible solves.
            candidate = await improveQuality(structuredClone(candidate), qualityFindings);
            continue;
          }
          qualityImprovement.outcome = 'review_budget_exhausted';
        } else if (qualityImprovement.attempts === 1) {
          qualityImprovement.outcome = qualityFindings.length ? 'exhausted' : 'improved';
        }
        return { candidate, receipts, answerabilityReview, qualityImprovement };
      }
      const findingKey = (finding: TeachingContentReview['findings'][number]) =>
        `${finding.itemId}\u0000${finding.code}`;
      const resolvedPriorDefect = previousFindings?.some(
        (prior) => !findings.some((current) => findingKey(current) === findingKey(prior)),
      );
      const changedDraft =
        round > 0 && receipts[round - 1]!.candidateHash !== prepared.candidateHash;
      if (
        round === MAX_TEACHING_CONTENT_REVIEWS - 1 ||
        (round === 1 && (!changedDraft || !resolvedPriorDefect))
      )
        throw ProviderError.invalidOutput(
          'Practice content still has material defects after its bounded revision.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          true,
          {
            kind: 'teaching_content_review_failed',
            diagnostics: findings.map(({ code, problem }) => ({ code, message: problem })),
          },
        );
      previousFindings = findings;
      candidate = await revise(candidate, findings);
    } catch (error) {
      if (error instanceof ProviderError && error.code === ApiErrorCode.RequestCancelled)
        throw error;
      if (!original) throw error;
      return acceptOriginal(error);
    }
  }
  throw new Error('Unreachable Practice review state.');
}

/** Bind the current gate to the saved visible surfaces, keys and prior teaching. */
export function hasCurrentPracticeAnswerabilityReview(brief: TeachingBrief): boolean {
  const practice = brief.practice;
  const proof = practice?.qualityEvaluation.answerabilityReview;
  const grounding = practice?.qualityEvaluation.contentReview;
  if (
    !practice ||
    !proof ||
    proof.policyVersion !== PRACTICE_ANSWERABILITY_POLICY_VERSION ||
    !grounding?.length ||
    proof.rounds.length !== grounding.length ||
    proof.rounds.some((round, index) => round.candidateHash !== grounding[index]!.candidateHash)
  )
    return false;
  const latest = proof.rounds.at(-1)!;
  const lastGrounding = grounding.at(-1)!.result;
  if (
    lastGrounding.decisions.length ||
    lastGrounding.findings.some((finding) => finding.code !== 'shallow_task') ||
    latest.solves.length !== practice.items.length * 2 ||
    new Set(latest.solves.map((solve) => `${solve.itemIndex}.${solve.surface}`)).size !==
      latest.solves.length
  )
    return false;
  const priorTeaching = projectPracticePriorTeaching(brief);
  return latest.solves.every((solve) => {
    const item = practice.items[solve.itemIndex];
    if (!item || !solve.actionId.endsWith(`.${solve.surface}`)) return false;
    const surface = item[solve.surface];
    const options = surface.options.map(({ id, text }) => ({
      id: id.slice(id.lastIndexOf('_') + 1),
      text,
    }));
    const input = preparePracticeAnswerabilityReview(
      { prompt: surface.prompt, options },
      priorTeaching,
      solve.actionId,
      solve.actionId.slice(0, solve.actionId.lastIndexOf('.')),
    );
    const decision = solve.result.decisions[0];
    const selected = surface.options.find(
      (_option, index) => options[index]!.id === decision?.answerId,
    );
    return (
      input.inputHash === solve.inputHash &&
      input.validate(solve.result).valid &&
      !solve.result.findings.some((finding) => finding.code !== 'shallow_task') &&
      selected !== undefined &&
      selected.id === surface.correctOptionId
    );
  });
}
