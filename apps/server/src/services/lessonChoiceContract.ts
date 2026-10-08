import { createHash } from 'node:crypto';
import {
  TeachingBriefInformalCheckSchema,
  type LessonPedagogyEvaluation,
} from '@hy3-clinic/shared';
import { ProviderError } from '../llm/errors.js';

const CHOICE_MESSAGES = {
  lesson_choice_check_missing_options:
    'A choose_alternative check requires two to five public choices and a key bound to an offered choice.',
  lesson_choice_check_invalid_structure:
    'The informal check must satisfy its schema, including valid unique option identities, choice count, feedback, and option/key pairing and binding.',
  lesson_choice_check_not_renderable:
    'Structured choices and their key require choose_alternative; other informal interaction kinds do not render those choices.',
  lesson_choice_reference_unavailable:
    'The task requires unavailable alternative content. Supply that content on a learner-visible surface or write a self-contained task.',
};

export type LessonChoiceIssue = {
  code: keyof typeof CHOICE_MESSAGES;
  message: string;
};

export function isLessonChoiceContractCode(code: string): boolean {
  return Object.hasOwn(CHOICE_MESSAGES, code);
}

/** This inventories printed identities, including literals; it says nothing about
 * whether the task needs their meaning. Verbs and quotation syntax cannot prove
 * that semantic dependency. Unresolved references belong to material review. */
function referencedAlternativeIds(prompt: string): string[] {
  const reference =
    /(?:\b[Oo]ptions?\s+|选项\s*)([A-E](?:\s*(?:[,/、]|\b(?:and|or|with|versus)\b|和|或|与)\s*(?:[Oo]ptions?\s+|选项\s*)?[A-E])*)\b/gu;
  return [
    ...new Set(
      [...prompt.matchAll(reference)].flatMap((match) => match[1]!.match(/[A-E]/gu) ?? []),
    ),
  ];
}
/** A labelled assignment supplies content, including natural inline predicates.
 * Inspect each rendered text separately: concatenating fields must not manufacture
 * a definition from an otherwise empty label and unrelated metadata. */
function publiclyDefinesAlternative(id: string, visibleTexts: readonly string[]): boolean {
  const definition = new RegExp(
    '(?:(?:\\b[Oo]ption\\s+|选项\\s*)' +
      id +
      '[*_\\x60]*[ \\t]*(?:[:：=＝—–-]|\\b(?:means|is|represents|denotes)\\b|是|表示|意味着)|(?:^|[\\n。！？.!?;；])\\s*(?:[-*]\\s*)?' +
      id +
      '[*_\\x60]*\\s*[.:：、)）])\\s*([^\\n。！？;；]+)',
    'mu',
  );
  return visibleTexts.some((text) => {
    const value = text.match(definition)?.[1]?.trim();
    return Boolean(value && /[\p{L}\p{N}]/u.test(value));
  });
}

export function lessonInformalChoiceIssues(
  check: unknown,
  _visibleBefore: readonly string[] = [],
): LessonChoiceIssue[] {
  if (check === undefined) return [];
  const parsed = TeachingBriefInformalCheckSchema.safeParse(check);
  if (!parsed.success)
    return [
      {
        code: 'lesson_choice_check_invalid_structure',
        message: CHOICE_MESSAGES.lesson_choice_check_invalid_structure,
      },
    ];
  const action = parsed.data;
  const issues: LessonChoiceIssue[] = [];
  const add = (code: LessonChoiceIssue['code']) =>
    issues.push({ code, message: CHOICE_MESSAGES[code] });
  if (action.kind === 'choose_alternative' && (!action.options || !action.correctOptionId))
    add('lesson_choice_check_missing_options');
  if (action.kind !== 'choose_alternative' && (action.options || action.correctOptionId))
    add('lesson_choice_check_not_renderable');
  return issues;
}

/** Availability of explicit content is separate from dependency. Even an
 * unresolved identity may be a perfectly answerable label-level task. */
export function lessonInformalChoiceReferences(
  check: unknown,
  visibleBefore: readonly string[] = [],
): { referenced: string[]; unresolved: string[] } {
  const parsed = TeachingBriefInformalCheckSchema.safeParse(check);
  if (!parsed.success) return { referenced: [], unresolved: [] };
  const action = parsed.data;
  const referenced = referencedAlternativeIds(action.prompt);
  const offered =
    action.kind === 'choose_alternative' ? (action.options?.map(({ id }) => id) ?? []) : [];
  return {
    referenced,
    unresolved: referenced.filter(
      (id) =>
        !offered.includes(id) && !publiclyDefinesAlternative(id, [...visibleBefore, action.prompt]),
    ),
  };
}

type LessonChoiceSurface = {
  lessonNarrative?: { whyNow: string };
  explanation?: string;
  example?: { text: string };
  contrast?: { text: string };
  misconception?: { hypothesis: string; correction: string };
  /** Serialized relations are not rendered by LessonExecutionPanel. */
  semanticRelations?: Array<{ fromProposition: string; toProposition: string }>;
  workedProcess?: {
    startingState: string;
    inputs?: string[];
    ruleOrProcedure: string;
    steps: Array<{ action: string; reason: string; resultingState: string }>;
    learnerDecision?: string | null;
    result: string;
    whyResultFollows: string;
    interaction?: {
      pauseAfterStepIndex: number;
      activity: {
        prompt: string;
        options: Array<{ id: string; text: string }>;
        correctDebrief?: string;
      };
      transfer: {
        changedCondition: string;
        prompt: string;
        options: Array<{ id: string; text: string }>;
        debrief?: string;
      };
    };
  } | null;
  informalCheck?: unknown;
};

/** The text rendered by TeachingSegmentContent, at an ordinary check or after
 * completing an earlier segment. Lesson execution stops at every interaction,
 * so only earlier completed surfaces may supply their continuation/transfer.
 * Keep this whitelist in sync with lessonExecution.projectLesson and the panel.
 * Conditional help, selected feedback, semantic metadata and unprinted IDs are
 * absent. The existing Practice projection describes a different exposure point. */
function lessonChoiceVisibleText(surface: LessonChoiceSurface, completed: boolean): string[] {
  const visible = [
    surface.explanation ?? '',
    surface.example?.text ?? '',
    surface.contrast?.text ?? '',
    surface.misconception?.hypothesis ?? '',
    surface.misconception?.correction ?? '',
  ];
  const process = surface.workedProcess;
  if (process) {
    const interaction = process.interaction;
    visible.push(
      process.startingState,
      ...(process.inputs ?? []),
      process.ruleOrProcedure,
      ...process.steps
        .slice(0, !interaction || completed ? undefined : interaction.pauseAfterStepIndex + 1)
        .flatMap((step) => [step.action, step.reason, step.resultingState]),
    );
    if (!interaction) visible.push(process.learnerDecision ?? '');
    if (!interaction || completed) visible.push(process.result, process.whyResultFollows);
    if (interaction) {
      visible.push(
        interaction.activity.prompt,
        ...interaction.activity.options.map(({ text }) => text),
      );
      if (completed)
        visible.push(
          interaction.activity.correctDebrief ?? '',
          interaction.transfer.changedCondition,
          interaction.transfer.prompt,
          ...interaction.transfer.options.map(({ text }) => text),
          interaction.transfer.debrief ?? '',
        );
    }
  }
  if (completed) {
    const parsed = TeachingBriefInformalCheckSchema.safeParse(surface.informalCheck);
    if (parsed.success) {
      visible.push(parsed.data.prompt, parsed.data.expectedSignal ?? '');
      if (parsed.data.kind === 'choose_alternative')
        visible.push(...(parsed.data.options?.map(({ text }) => text) ?? []));
    }
  }
  return visible;
}

/** Use the same ordinary-check contract for proposals, checkpoints and Briefs.
 * Historical bytes and evaluations are never changed by this read. */
export function lessonChoiceContractIssues(
  surfaces: readonly LessonChoiceSurface[],
  _visibleBefore: readonly string[] = [],
) {
  return surfaces.flatMap((surface, index) => {
    const issues = lessonInformalChoiceIssues(surface.informalCheck).map((issue) => ({
      ...issue,
      index,
    }));
    return issues;
  });
}

export function lessonChoiceReferences(
  surfaces: readonly LessonChoiceSurface[],
  visibleBefore: readonly string[] = [],
) {
  const prior = [...visibleBefore, surfaces[0]?.lessonNarrative?.whyNow ?? ''];
  return surfaces.map((surface, index) => {
    const references = lessonInformalChoiceReferences(surface.informalCheck, [
      ...prior,
      ...lessonChoiceVisibleText(surface, false),
    ]);
    prior.push(...lessonChoiceVisibleText(surface, true));
    return { ...references, index };
  });
}

export function lessonChoiceNeedsMaterialReview(
  surfaces: readonly LessonChoiceSurface[],
  visibleBefore: readonly string[] = [],
): boolean {
  return lessonChoiceReferences(surfaces, visibleBefore).some(
    ({ unresolved }) => unresolved.length > 0,
  );
}

/** Bind current acceptance to the same exposed context across proposal,
 * checkpoint and Brief shapes. Hidden fields cannot keep this proof valid when
 * defining text is removed from a rendered surface. This is server-generated. */
export function lessonChoiceContextFingerprint(
  surfaces: readonly LessonChoiceSurface[],
  visibleBefore: readonly string[] = [],
): string {
  const opening = [...visibleBefore, surfaces[0]?.lessonNarrative?.whyNow ?? ''].filter(Boolean);
  const context = {
    opening: [...new Set(opening)],
    surfaces: surfaces.map((surface) => ({
      current: lessonChoiceVisibleText(surface, false),
      completed: lessonChoiceVisibleText(surface, true),
      check: TeachingBriefInformalCheckSchema.safeParse(surface.informalCheck).data ?? null,
    })),
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

export function hasAcceptedLessonChoiceContract(
  surfaces: readonly LessonChoiceSurface[],
  evaluation: LessonPedagogyEvaluation,
  visibleBefore: readonly string[] = [],
): boolean {
  if (
    !hasValidLessonChoiceContract(surfaces) ||
    evaluation.choiceContextFingerprint !== lessonChoiceContextFingerprint(surfaces, visibleBefore)
  )
    return false;
  if (!lessonChoiceNeedsMaterialReview(surfaces, visibleBefore)) return true;
  const reviewed = evaluation.contentReview?.at(-1);
  return Boolean(reviewed && reviewed.result.findings.every(({ code }) => code === 'shallow_task'));
}

export function hasValidLessonChoiceContract(
  surfaces: readonly LessonChoiceSurface[],
  visibleBefore: readonly string[] = [],
): boolean {
  return lessonChoiceContractIssues(surfaces, visibleBefore).length === 0;
}

export function assertLessonChoiceContract(
  surfaces: readonly LessonChoiceSurface[],
  visibleBefore: readonly string[] = [],
): void {
  const issues = lessonChoiceContractIssues(surfaces, visibleBefore);
  if (issues.length)
    throw ProviderError.invalidOutput(
      issues.map(({ code, message }) => code + ': ' + message).join('; '),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      false,
      { kind: 'lesson_choice_contract_rejection', diagnostics: issues },
    );
}
