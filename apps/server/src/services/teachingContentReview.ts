import { createHash } from 'node:crypto';
import {
  TeachingContentReviewSchema,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type TeachingContentReview,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingContentReviewInput,
} from '../llm/provider.js';
import { ProviderError } from '../llm/errors.js';

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
  for (let round = 0; round < 2; round += 1) {
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
    if (round === 1)
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
  const input: TeachingContentReviewInput = {
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
