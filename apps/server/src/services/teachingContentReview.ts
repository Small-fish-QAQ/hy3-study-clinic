import { createHash } from 'node:crypto';
import {
  ApiErrorCode,
  LessonContentReviewResultSchema,
  LESSON_CONTENT_REVIEW_POLICY_VERSION,
  PracticeGroundingResultSchema,
  PracticeAnswerabilityResultSchema,
  PracticeIntegrityResultSchema,
  TeachingQualityAdvisorySchema,
  MAX_TEACHING_CONTENT_REVIEWS,
  PRACTICE_ANSWERABILITY_POLICY_VERSION,
  projectLearnerPracticeSurface,
  type PracticePriorTeaching,
  type PracticeAnswerabilityReview,
  type PracticeIntegrityReview,
  type PracticeGroundingReview,
  PRACTICE_GROUNDING_POLICY_VERSION,
  PRACTICE_ACCEPTANCE_POLICY_VERSION,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type PracticeQualityFinding,
  type PracticeQualityImprovement,
  type PracticeQualityEvaluation,
  type TeachingContentReview,
  type LessonGroundingReview,
  type LessonPedagogyFinding,
  type LessonPedagogyEvaluation,
  LESSON_GROUNDING_POLICY_VERSION,
  LessonGroundingResultSchema,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  AuthoredTeachingContentReviewInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';
import {
  assertPracticeCandidate,
  assertReviewedPracticeAcceptance,
  preparePracticeAnswerabilityReview,
  preparePracticeIntegrityReview,
  preparePracticeGroundingReview,
  practiceProofItems,
} from './practiceAcceptance.js';
import { compareLearnerPracticeTasks } from './practiceTaskCanonicalization.js';
import { prepareLessonGroundingReview } from './lessonGrounding.js';
import {
  evaluatePlannedPracticeQuality,
  practiceEvidenceContrastFinding,
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

function withoutAuthorDeclarations(value: unknown, lessonVisibility = false): unknown {
  if (Array.isArray(value))
    return value.map((item) => withoutAuthorDeclarations(item, lessonVisibility));
  if (value === null || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value)
      // LessonExecutionPanel does not render these relations. Even an ambiguous
      // dependency's material review cannot use them as public availability.
      .filter(
        ([key]) => !AUTHOR_KEYS.has(key) && !(lessonVisibility && key === 'semanticRelations'),
      )
      .map(([key, child]) => [key, withoutAuthorDeclarations(child, lessonVisibility)]),
  );
  const original = value as Record<string, unknown>;
  if (original.activity && original.scaffold && original.transfer) {
    result.afterWrongGuidedResponse = {
      visibility:
        'Hint and scaffold are shown only AFTER a wrong guided answer is committed. They may explain that error. Hint and selected guided feedback precede the unanswered scaffold, and this entire assistance path can precede transfer. Check those later unanswered results independently.',
      hint: result.hint,
      scaffold: result.scaffold,
    };
    delete result.hint;
    delete result.scaffold;
    result.transfer = {
      ...(result.transfer as Record<string, unknown>),
      visibility:
        'Shown only when guided is resolved: after a correct guided response or any committed scaffold response. Continuation, result and guided debrief already precede transfer; final rationale does not.',
    };
  }
  const interaction = original.interaction as { pauseAfterStepIndex?: number } | undefined;
  if (Array.isArray(original.steps) && typeof interaction?.pauseAfterStepIndex === 'number') {
    result.steps = withoutAuthorDeclarations(
      original.steps.slice(0, interaction.pauseAfterStepIndex + 1),
      lessonVisibility,
    );
    result.afterGuidedResponse = {
      visibility:
        'Shown when guided is resolved (correct guided response or committed scaffold), BEFORE the unanswered transfer. Hidden before guided/scaffold responses.',
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
  if (lessonVisibility && original.kind && !Array.isArray(original.options))
    result.afterResponse = {
      visibility:
        'Coaching shown only after this open response is committed; it may precede later completed Lesson slots.',
    };
  return result;
}

/** Response-scoped public exposure, matching lessonExecution.projectWorkedProcess.
 * A task never receives its own feedback, private inference or future teaching.
 * Conditional branches can establish a later leak, but cannot fill missing
 * premises for a task which must also be answerable without that assistance. */
function lessonResponseContexts(
  candidate: LessonSlotContentProposalPayload,
  context: LessonSlotContentGenerationInput,
) {
  const prior = [
    ...context.skeleton.objectives.flatMap(({ title, description }) => [title, description]),
    candidate.narrative?.whyNow ?? '',
  ];
  const conditional: Array<{ visibility: string; texts: string[] }> = [];
  const responses: Array<{
    actionId: string;
    visibleBefore: string[];
    conditionalBefore: typeof conditional;
    prompt: string;
    options: Array<{ id: string; text: string }>;
  }> = [];
  const publicAction = (action: { prompt: string; options?: Array<{ text: string }> }) => [
    action.prompt,
    ...(action.options?.map(({ text }) => text) ?? []),
  ];
  const feedback = (
    action: {
      options?: Array<{
        id: string;
        feedbackIfSelected: string;
        misconception?: { hypothesis: string; whyTempting: string; correction: string } | null;
      }>;
    },
    stage: string,
  ) =>
    (action.options ?? []).map((option) => ({
      visibility: `Only if ${stage} option ${option.id} was committed. Hypotheses are proposed misconceptions, not teacher-endorsed facts.`,
      texts: [
        option.feedbackIfSelected,
        ...(option.misconception
          ? [
              `Misconception hypothesis: ${option.misconception.hypothesis}`,
              option.misconception.whyTempting,
              option.misconception.correction,
            ]
          : []),
      ],
    }));
  const add = (
    actionId: string,
    action: { prompt: string; options?: Array<{ id: string; text: string }> },
    visibleBefore: string[],
    conditionalBefore = conditional,
  ) =>
    responses.push({
      actionId,
      prompt: action.prompt,
      options: action.options?.map(({ id, text }) => ({ id, text })) ?? [],
      visibleBefore: [...visibleBefore],
      conditionalBefore: structuredClone(conditionalBefore),
    });
  for (const slot of candidate.slots) {
    const teaching = [
      slot.explanation,
      slot.example?.text ?? '',
      slot.contrast?.text ?? '',
      ...(slot.misconception
        ? [
            `Possible misconception: ${slot.misconception.hypothesis}`,
            slot.misconception.correction,
          ]
        : []),
    ];
    const before = [...prior, ...teaching];
    prior.push(...teaching);
    const process = slot.workedProcess;
    const graph = process?.interaction;
    const steps = (end?: number) =>
      process?.steps
        .slice(0, end)
        .flatMap((step) => [step.action, step.reason, step.resultingState]) ?? [];
    const model = process
      ? [process.startingState, ...(process.inputs ?? []), process.ruleOrProcedure]
      : [];
    if (graph && process) {
      const guidedBefore = [...before, ...model, ...steps(graph.pauseAfterStepIndex + 1)];
      add(`${slot.slotId}.guided`, graph.activity, guidedBefore);
      const guidedBranches = feedback(graph.activity, `${slot.slotId}.guided`);
      const wrongBranches = guidedBranches.filter(
        (_, index) => graph.activity.options[index]!.id !== graph.activity.correctOptionId,
      );
      add(
        `${slot.slotId}.scaffold`,
        graph.scaffold,
        [...guidedBefore, ...publicAction(graph.activity), graph.hint],
        [...conditional, ...wrongBranches],
      );
      const assistance = {
        visibility: `Only after a wrong ${slot.slotId}.guided response and a committed scaffold, before transfer. Scaffold hypotheses/options are proposed answers.`,
        texts: [graph.hint, ...publicAction(graph.scaffold), graph.scaffold.debrief],
      };
      const transferBranches = [
        ...conditional,
        ...guidedBranches,
        assistance,
        ...feedback(graph.scaffold, `${slot.slotId}.scaffold`),
      ];
      add(
        `${slot.slotId}.transfer`,
        graph.transfer,
        [
          ...before,
          ...model,
          ...steps(),
          process.result,
          ...publicAction(graph.activity),
          graph.activity.correctDebrief,
          graph.transfer.changedCondition,
        ],
        transferBranches,
      );
      conditional.push(
        ...guidedBranches,
        assistance,
        ...feedback(graph.scaffold, `${slot.slotId}.scaffold`),
        ...feedback(graph.transfer, `${slot.slotId}.transfer`),
      );
      prior.push(
        ...model,
        ...steps(),
        process.result,
        process.whyResultFollows,
        ...publicAction(graph.activity),
        graph.activity.correctDebrief,
        graph.transfer.changedCondition,
        ...publicAction(graph.transfer),
        graph.transfer.debrief,
      );
    } else if (process) {
      before.push(
        ...model,
        ...steps(),
        process.learnerDecision ?? '',
        process.result,
        process.whyResultFollows,
      );
      prior.push(
        ...model,
        ...steps(),
        process.learnerDecision ?? '',
        process.result,
        process.whyResultFollows,
      );
    }
    if (slot.informalCheck) {
      add(`${slot.slotId}.check`, slot.informalCheck, before);
      conditional.push(...feedback(slot.informalCheck, `${slot.slotId}.check`));
      prior.push(...publicAction(slot.informalCheck), slot.informalCheck.expectedSignal ?? '');
    }
  }
  return responses;
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
  lessonGrounding?: {
    reviewChoices: (candidate: LessonSlotContentProposalPayload) => boolean;
    onFindings?: (findings: TeachingContentReview['findings']) => void;
    review: (
      prepared: ReturnType<typeof prepareLessonGroundingReview>,
      round: number,
    ) => Promise<{ result: TeachingContentReview; logicalCallId: string }>;
  },
) {
  const receipts = [];
  const groundingReview: LessonGroundingReview = {
    policyVersion: LESSON_GROUNDING_POLICY_VERSION,
    rounds: [],
  };
  let previousFindings: TeachingContentReview['findings'] | undefined;
  let previousCandidateHash: string | undefined;
  for (let round = 0; round < MAX_TEACHING_CONTENT_REVIEWS; round += 1) {
    const prepared = prepareTeachingReview(context, candidate, computedItemIds);
    const grounding = lessonGrounding
      ? prepareLessonGroundingReview(
          context as LessonSlotContentGenerationInput,
          candidate as LessonSlotContentProposalPayload,
        )
      : undefined;
    const findings: TeachingContentReview['findings'] = [];
    const reviewChoices =
      !lessonGrounding ||
      lessonGrounding.reviewChoices(candidate as LessonSlotContentProposalPayload);
    if (reviewChoices) {
      const reviewed = await review(prepared, round);
      if (!prepared.validate(reviewed.result).valid)
        throw ProviderError.invalidOutput(
          'Teaching review did not cover its exact action inventory.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          false,
        );
      const result = LessonContentReviewResultSchema.parse(reviewed.result);
      receipts.push({ ...reviewed, result, candidateHash: prepared.candidateHash });
      findings.push(...prepared.findings(result));
    }
    if (grounding) {
      const reviewed = await lessonGrounding!.review(grounding, round);
      if (!grounding.validate(reviewed.result).valid)
        throw ProviderError.invalidOutput(
          'Lesson grounding did not review its exact current claims and context.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          false,
        );
      groundingReview.rounds.push({
        ...reviewed,
        result: LessonGroundingResultSchema.parse(reviewed.result),
        candidateHash: grounding.candidateHash,
        claimsHash: grounding.claimsHash,
        inputHash: grounding.inputHash,
      });
      findings.push(...grounding.findings(reviewed.result));
    }
    lessonGrounding?.onFindings?.(findings);
    if (!findings.length)
      return {
        candidate,
        // Prior-round public findings cannot certify or veto a corrected
        // candidate that no longer requires that review. Telemetry retains
        // those calls; complete current grounding remains mandatory.
        receipts: reviewChoices ? receipts : [],
        groundingReview: lessonGrounding ? groundingReview : undefined,
      };
    const findingKey = (finding: TeachingContentReview['findings'][number]) =>
      `${finding.itemId}\u0000${finding.code}`;
    const resolvedPriorDefect = previousFindings?.some(
      (prior) => !findings.some((current) => findingKey(current) === findingKey(prior)),
    );
    const changedDraft = round > 0 && previousCandidateHash !== prepared.candidateHash;
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
    previousCandidateHash = prepared.candidateHash;
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
    ...('slots' in candidate ? { purpose: 'lesson_public' as const } : {}),
    stage: 'slots' in candidate ? 'lesson' : 'practice',
    computedOutcomes: context.computedCases,
    ...(computedItemIds.size ? { computedItemIds: [...computedItemIds] } : {}),
    desiredDepth: context.courseDesign?.desiredDepth ?? 'pass_oriented',
    objectives: context.skeleton.objectives.map(({ title, description }) => ({
      title,
      description,
    })),
    sources: context.sourceContext.offers.map(({ sourceRef, text }) => ({ sourceRef, text })),
    candidate:
      'slots' in candidate
        ? {
            ...(withoutAuthorDeclarations(annotated, true) as Record<string, unknown>),
            responseContexts: lessonResponseContexts(
              candidate,
              context as LessonSlotContentGenerationInput,
            ),
          }
        : context.computedCases
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
  const fingerprint = () =>
    reviewHash({ policyVersion: LESSON_CONTENT_REVIEW_POLICY_VERSION, input });
  const inputHash = fingerprint();
  const validate = (raw: unknown) => {
    const parsed = LessonContentReviewResultSchema.safeParse(raw);
    const ids = parsed.success ? parsed.data.decisions.map((decision) => decision.actionId) : [];
    const valid =
      fingerprint() === inputHash &&
      parsed.success &&
      ((input.computedOutcomes && ids.length === 0) ||
        (ids.length === answers.size && new Set(ids).size === answers.size)) &&
      ids.every((id) => answers.has(id)) &&
      [...parsed.data.findings, ...(parsed.data.advisories ?? [])].every(
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
    ...review.findings.map((finding) => ({
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
      // Inference depth is quality. Material findings are never erased by code.
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

export function lessonReviewQualityFindings(
  candidate: LessonSlotContentProposalPayload,
  receipts: LessonPedagogyEvaluation['contentReview'],
): LessonPedagogyFinding[] {
  const result = LessonContentReviewResultSchema.safeParse(receipts?.at(-1)?.result);
  if (!result.success) return [];
  return (result.data.advisories ?? []).map((advisory) => ({
    severity: 'warning',
    criterion: 'learner_activity',
    code: `lesson_review_${advisory.code}`,
    message: advisory.problem,
    segmentIndexes: candidate.slots.flatMap((slot, index) =>
      slot.slotId === advisory.itemId.split('.')[0] ? [index] : [],
    ),
    objectiveRefs: [],
  }));
}

/** Diagnostics from the selected candidate's current proofs share the existing quality budget. */
export function practiceReviewQualityFindings(
  candidate: PracticeContentProposalPayload,
  context: PracticeContentGenerationInput,
  evidence: Pick<
    PracticeQualityEvaluation,
    'contentReview' | 'answerabilityReview' | 'integrityReview'
  >,
): PracticeQualityFinding[] {
  const advisories = [
    ...(evidence.contentReview?.at(-1)?.result.advisories ?? []),
    ...(evidence.integrityReview?.rounds.at(-1)?.result.advisories ?? []),
    ...(evidence.answerabilityReview?.rounds
      .at(-1)
      ?.solves.flatMap((solve) => solve.result.advisories ?? []) ?? []),
  ];
  const unique = new Map<string, PracticeQualityFinding>();
  for (const raw of advisories) {
    const advisory = TeachingQualityAdvisorySchema.parse(raw);
    const itemIndexes = candidate.items.flatMap((item, index) =>
      item.practiceSlotId === advisory.itemId.split('.')[0] ? [index] : [],
    );
    unique.set(JSON.stringify(advisory), {
      severity: 'warning',
      criterion: 'meaningful_action',
      code: `practice_review_${advisory.code}`,
      message: advisory.problem,
      repairInstruction: advisory.repairInstruction,
      itemIndexes,
      objectiveRefs: itemIndexes.map(
        (index) => context.skeleton.practicePlan.slots[index]!.objectiveRef,
      ),
    });
  }
  return [...unique.values()].slice(0, 100);
}

const initialPracticeSurface = (
  initial: PracticeContentProposalPayload['items'][number]['initial'],
) => ({
  prompt: initial.prompt,
  options: initial.options.map(({ optionRef, text }) => ({ id: optionRef, text })),
});

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
  const integrityReview: PracticeIntegrityReview = {
    policyVersion: PRACTICE_ACCEPTANCE_POLICY_VERSION,
    rounds: [],
  };
  const groundingReview: PracticeGroundingReview = {
    policyVersion: PRACTICE_GROUNDING_POLICY_VERSION,
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
        integrityReview: PracticeIntegrityReview;
        groundingReview: PracticeGroundingReview;
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
    assertReviewedPracticeAcceptance(original.candidate, context, priorTeaching, {
      contentReview: original.receipts,
      answerabilityReview: original.answerabilityReview,
      integrityReview: original.integrityReview,
      groundingReview: original.groundingReview,
    });
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
      integrityReview: original.integrityReview,
      groundingReview: original.groundingReview,
      qualityImprovement,
    };
  };
  for (let round = 0; round < MAX_TEACHING_CONTENT_REVIEWS; round += 1) {
    try {
      // Providers may ignore callbacks. Each original/revised candidate still
      // owes the complete current structural, authority and integrity contract.
      assertPracticeCandidate(candidate, context, priorTeaching);
      const prepared = preparePracticeGroundingReview(context, candidate);
      const grounded = await review(prepared, round);
      if (!prepared.validate(grounded.result).valid)
        throw ProviderError.invalidOutput(
          'Practice grounding review must return only findings for its exact inventory.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          false,
        );
      const groundingResult = PracticeGroundingResultSchema.parse(grounded.result);
      receipts.push({
        ...grounded,
        result: groundingResult,
        candidateHash: prepared.candidateHash,
      });
      groundingReview.rounds.push({
        ...grounded,
        result: groundingResult,
        candidateHash: prepared.candidateHash,
        inputHash: prepared.inputHash,
        claimsHash: prepared.claimsHash,
      });
      const findings = prepared.findings(grounded.result);
      const integrity = preparePracticeIntegrityReview(
        practiceProofItems(candidate),
        priorTeaching,
      );
      const inspected = await review(integrity, round);
      if (!integrity.validate(inspected.result).valid)
        throw ProviderError.invalidOutput(
          'Practice integrity review must establish only concrete public replay or leakage.',
          'candidate',
          'SEMANTIC_VALIDATION_FAILURE',
          false,
        );
      integrityReview.rounds.push({
        ...inspected,
        result: PracticeIntegrityResultSchema.parse(inspected.result),
        candidateHash: prepared.candidateHash,
        inputHash: integrity.inputHash,
      });
      findings.push(
        ...inspected.result.findings.map((finding) => ({
          ...finding,
          itemId: finding.itemId.split('.')[0]!,
        })),
      );
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
            result: PracticeAnswerabilityResultSchema.parse(solved.result),
            actionId,
            itemIndex,
            surface,
            inputHash: solve.inputHash,
          });
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
          else {
            const contrast = practiceEvidenceContrastFinding(
              authored,
              decision.requiresCaseInference,
            );
            if (contrast)
              findings.push({
                itemId: item.practiceSlotId,
                code: 'insufficient_evidence',
                problem: `${actionId}: ${contrast}. The independent public-task solve establishes case inference, so a valid decisive contrast is required.`,
                repairInstruction:
                  'Quote a visible decisive case fact, replace it with a genuinely changed fact, and identify the different offered answer that would then be correct.',
              });
          }
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
        assertReviewedPracticeAcceptance(candidate, context, priorTeaching, {
          contentReview: receipts,
          answerabilityReview,
          integrityReview,
          groundingReview,
        });
        const qualityFindings = [
          ...practiceQualityImprovementFindings(
            evaluatePlannedPracticeQuality(candidate, context, {
              evaluatedAt: '1970-01-01T00:00:00.000Z',
            }),
          ),
          ...practiceReviewQualityFindings(candidate, context, {
            contentReview: receipts,
            answerabilityReview,
            integrityReview,
          }),
        ].slice(0, 100);
        if (qualityFindings.length && qualityImprovement.attempts === 0) {
          qualityImprovement.findingsBefore = structuredClone(qualityFindings);
          if (improveQuality && round < MAX_TEACHING_CONTENT_REVIEWS - 1) {
            qualityImprovement.attempts = 1;
            original = {
              candidate: structuredClone(candidate),
              candidateHash: prepared.candidateHash,
              contextHash: reviewHash(context),
              priorTeachingHash: reviewHash(priorTeaching),
              computedCases: context.computedCases,
              receipts: structuredClone(receipts),
              answerabilityReview: structuredClone(answerabilityReview),
              integrityReview: structuredClone(integrityReview),
              groundingReview: structuredClone(groundingReview),
            };
            // Spend an existing review round, never add an outer retry budget.
            // The following round obtains fresh grounding, public comparison and isolated solves.
            candidate = await improveQuality(structuredClone(candidate), qualityFindings);
            continue;
          }
          qualityImprovement.outcome = improveQuality ? 'review_budget_exhausted' : 'retained';
        } else if (qualityImprovement.attempts === 1) {
          qualityImprovement.outcome = qualityFindings.length ? 'exhausted' : 'improved';
        }
        return {
          candidate,
          receipts,
          answerabilityReview,
          integrityReview,
          groundingReview,
          qualityImprovement,
        };
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

export {
  preparePracticeAnswerabilityReview,
  hasCurrentPracticeAnswerabilityReview,
} from './practiceAcceptance.js';
