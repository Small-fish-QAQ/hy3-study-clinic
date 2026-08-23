import {
  LessonPedagogyEvaluationSchema,
  PracticeQualityEvaluationSchema,
  type LessonPedagogyEvaluation,
  type LessonPedagogyFinding,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type PracticeQualityEvaluation,
  type PracticeQualityFinding,
  type ProposedPracticeSlotContent,
  type TeachingBriefProposalPayload,
  type TeachingLessonSlotContent,
  type TeachingSkeletonSlot,
} from '@hy3-clinic/shared';
import type {
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TeachingBriefGenerationInput,
} from '../llm/provider.js';

export const LESSON_PEDAGOGY_POLICY_VERSION = 'lesson-pedagogy-v2';
export const PRACTICE_QUALITY_POLICY_VERSION = 'lesson-practice-v1';
export const COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION = 'lesson-pedagogy-v3-compositional';
export const COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION = 'lesson-practice-v2-compositional';

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function features(value: string): Set<string> {
  const result = new Set(normalized(value).match(/[a-z0-9]{3,}/gu) ?? []);
  for (const match of normalized(value).matchAll(/\p{Script=Han}+/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      result.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return result;
}

function overlapRatio(left: string, right: string): number {
  const a = features(left);
  const b = features(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

const SOURCE_LOCATION_TRIVIA =
  /(?:\b(?:page|slide|section|chapter|paragraph|line|block|document)\b.{0,35}\b(?:where|which|number|located|mention(?:ed)?)\b|\bsource\b.{0,35}\b(?:where|located|mention(?:ed)?|page|slide|section|chapter|paragraph|line|block)\b|\bwhere\b.{0,35}\b(?:document|source|page|slide|section|chapter|paragraph|line|block)\b|\bwhich\b.{0,35}\b(?:document|page|slide|section|chapter|paragraph|line|block)\b|\bwhich\s+source\b|第.{0,8}(?:页|幻灯片|章节|段|行)|(?:哪一|哪个|何处|哪里).{0,12}(?:页|幻灯片|章节|段落|位置)|(?:原文|资料|文档|来源).{0,12}(?:哪里|何处|哪一页|第几页|哪个章节))/iu;

const EXPLANATION_REASONING =
  /(?:\b(?:because|therefore|so that|depends on|causes?|means that|works by|mechanism|why|how)\b|因为|因|所以|故|因此|从而|导致|前提|必要|取决于|意味着|机制|原理|如何|为什么|通过)/iu;
const WORKED_REASONING =
  /(?:\b(?:first|next|then|finally|step|given|result|because|therefore|if|when)\b|首先|先|接着|然后|最后|步骤|已知|结果|因为|因此|如果|当)/iu;
const WORKED_START =
  /(?:\b(?:given|input|case|starting|initial|known|state)\b|已知|给定|输入|起始|状态|案例)/iu;
const WORKED_PROCEDURE =
  /(?:\b(?:first|next|then|finally|step|apply|inspect|compare|trace|calculate)\b|首先|先|接着|然后|最后|步骤|下一步|应用|检查|比较|追踪|计算)/iu;
const WORKED_DECISION =
  /(?:\b(?:choose|select|decide|reject|infer|determine|if|when|condition|transition)\b|选择|选取|判断|决策|决定|拒绝|推断|确定|如果|当|条件|转变)/iu;
const WORKED_RESULT =
  /(?:\b(?:result|therefore|consequence|follows|outcome|because)\b|结果|因此|后果|结论|所以|从而)/iu;
const ACTION_LANGUAGE =
  /(?:\b(?:choose|select|decide|predict|explain|explanation|apply|diagnose|compare|order|identify|evaluate|design|classify|which|best)\b|选择|判断|预测|解释|应用|诊断|比较|排序|识别|评估|设计|归类|哪一|最)/iu;
const CONSTRUCT_LANGUAGE = {
  identify: /(?:\b(?:identify|recognize|classify|distinguish|which)\b|识别|判断|归类|区分|哪一)/iu,
  explain:
    /(?:\b(?:explain|explains|explanation|why|how|reason|mechanism|account|accounts)\b|解释|为什么|如何|原因|机制|最能说明)/iu,
  apply:
    /(?:\b(?:apply|scenario|case|given|next step|result|use)\b|应用|情境|场景|案例|给定|下一步|结果|使用)/iu,
  design: /(?:\b(?:design|construct|plan|configure|propose)\b|设计|构建|规划|配置|提出方案)/iu,
  evaluate:
    /(?:\b(?:evaluate|judge|critique|best|trade-?off|justify)\b|评估|评价|判断|权衡|论证|最合适)/iu,
} as const;
const APPLY_OBSERVABLE =
  /(?:\b(?:next step|order|sequence|missing step|wrong step|complete|diagnose|condition.{0,50}(?:choose|select|action|step|result)|choose.{0,50}(?:step|action|result))\b|下一步|排序|顺序|缺少.{0,12}步骤|错误.{0,12}步骤|完成.{0,12}(?:流程|序列)|诊断.{0,30}(?:失败|原因)|条件.{0,30}(?:选择|行动|步骤|结果)|选择.{0,30}(?:步骤|行动|结果))/iu;

/**
 * Legacy combined payloads predate typed relation/application fields. These
 * lexical signals may locate candidate structure, but acceptance additionally
 * requires distinct domain-bearing semantic moves below.
 */
const LEGACY_AUXILIARY_LANGUAGE =
  /\b(?:because|therefore|so that|depends on|causes?|means that|works by|mechanism|why|how|first|next|then|finally|step|given|if|when|input|case|starting|initial|known|apply|inspect|compare|trace|calculate|choose|select|decide|reject|infer|determine|transition|action|sequence|complete|diagnose|identify|recognize|classify|distinguish|explain|evaluate|design|which|best|use)\b|因为|所以|因此|从而|导致|前提|必要|取决于|意味着|机制|原理|如何|为什么|通过|首先|接着|然后|最后|步骤|已知|给定|输入|起始|案例|下一步|应用|检查|比较|追踪|计算|选择|选取|判断|决策|决定|拒绝|推断|确定|如果|转变|后果|结论|行动|排序|顺序|完成|诊断|识别|评估|设计|归类/giu;

const LEGACY_GENERIC_FEATURES = new Set([
  'about',
  'content',
  'details',
  'example',
  'important',
  'idea',
  'lesson',
  'objective',
  'process',
  'response',
  'source',
  'thing',
  'topic',
]);

function legacySemanticFeatures(value: string): Set<string> {
  const result = features(value.replace(LEGACY_AUXILIARY_LANGUAGE, ' '));
  for (const generic of LEGACY_GENERIC_FEATURES) result.delete(generic);
  return result;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function legacySemanticClauses(value: string): Set<string>[] {
  return value
    .split(
      /[.!?;:。！？；：]|,|，|\b(?:because|therefore|so that|then|finally|if|when)\b|因为|所以|因此|从而|导致|然后|最后|如果|当/giu,
    )
    .map((clause) => legacySemanticFeatures(clause))
    .filter((clause) => clause.size > 0);
}

function distinctLegacyClauseCount(value: string): number {
  const signatures = legacySemanticClauses(value).map((clause) =>
    [...clause].sort((left, right) => left.localeCompare(right, 'en-US')).join('|'),
  );
  return new Set(signatures).size;
}

function legacyObjectiveTarget(
  objectiveRefs: string[],
  input: TeachingBriefGenerationInput,
): string {
  return input.learningUnit.objectives
    .filter((objective) => objectiveRefs.includes(objective.objectiveRef))
    .map((objective) => `${objective.title} ${objective.description}`)
    .join(' ');
}

function legacySourceTarget(sourceRefs: string[], input: TeachingBriefGenerationInput): string {
  const selected = new Set(sourceRefs);
  return input.sourceContext.offers
    .filter((offer) => selected.has(offer.sourceRef))
    .map((offer) => offer.text)
    .join(' ');
}

function hasLegacySemanticRelation(
  content: string,
  objectiveRefs: string[],
  sourceRefs: string[],
  input: TeachingBriefGenerationInput,
): boolean {
  const contentFeatures = legacySemanticFeatures(content);
  const authorityTarget = `${legacyObjectiveTarget(objectiveRefs, input)} ${legacySourceTarget(sourceRefs, input)}`;
  return (
    contentFeatures.size >= 4 &&
    distinctLegacyClauseCount(content) >= 2 &&
    intersects(contentFeatures, legacySemanticFeatures(authorityTarget))
  );
}

function hasLegacyWorkedProgression(
  content: string,
  objectiveRefs: string[],
  sourceRefs: string[],
  input: TeachingBriefGenerationInput,
): boolean {
  if (
    legacySemanticFeatures(content).size < 6 ||
    distinctLegacyClauseCount(content) < 3 ||
    !intersects(
      legacySemanticFeatures(content),
      legacySemanticFeatures(
        `${legacyObjectiveTarget(objectiveRefs, input)} ${legacySourceTarget(sourceRefs, input)}`,
      ),
    )
  ) {
    return false;
  }
  return true;
}

function hasLegacyMeaningfulPracticeSurface(
  prompt: string,
  correctOptionText: string,
  objectiveTarget: string,
  construct: keyof typeof CONSTRUCT_LANGUAGE,
): boolean {
  const promptFeatures = legacySemanticFeatures(prompt);
  const answerFeatures = legacySemanticFeatures(correctOptionText);
  const targetFeatures = legacySemanticFeatures(objectiveTarget);
  const substantiveClauseCount = legacySemanticClauses(prompt).filter(
    (clause) => clause.size >= 2,
  ).length;
  const largestClauseSize = Math.max(
    0,
    ...legacySemanticClauses(prompt).map((clause) => clause.size),
  );
  return (
    promptFeatures.size >= 3 &&
    answerFeatures.size >= 2 &&
    intersects(promptFeatures, targetFeatures) &&
    largestClauseSize >= 3 &&
    (construct !== 'apply' || substantiveClauseCount >= 2)
  );
}

function lessonFinding(
  criterion: LessonPedagogyFinding['criterion'],
  code: string,
  message: string,
  segmentIndexes: number[] = [],
  objectiveRefs: string[] = [],
  severity: LessonPedagogyFinding['severity'] = 'error',
): LessonPedagogyFinding {
  return { criterion, severity, code, message, segmentIndexes, objectiveRefs };
}

function practiceFinding(
  criterion: PracticeQualityFinding['criterion'],
  code: string,
  message: string,
  itemIndexes: number[] = [],
  objectiveRefs: string[] = [],
  severity: PracticeQualityFinding['severity'] = 'error',
): PracticeQualityFinding {
  return { criterion, severity, code, message, itemIndexes, objectiveRefs };
}

function lessonMinutes(payload: TeachingBriefProposalPayload): { min: number; max: number } {
  const purposeMinutes: Record<
    TeachingBriefProposalPayload['segments'][number]['purpose'],
    number
  > = {
    objective_orientation: 1,
    explanation: 3,
    mechanism: 3,
    worked_example: 4,
    contrast: 2,
    misconception: 2,
    guided_practice: 3,
  };
  const min = payload.segments.reduce(
    (total, segment) =>
      total +
      purposeMinutes[segment.purpose] +
      (segment.example ? 2 : 0) +
      (segment.contrast ? 1 : 0) +
      (segment.misconception ? 1 : 0) +
      (segment.informalCheck ? 2 : 0),
    0,
  );
  return { min, max: Math.ceil(min * 1.25) };
}

export function evaluateLessonPedagogy(
  payload: TeachingBriefProposalPayload,
  input: TeachingBriefGenerationInput,
  options: { evaluatedAt: string; boundedRepairAttempted?: boolean },
): LessonPedagogyEvaluation {
  const findings: LessonPedagogyFinding[] = [];
  const purposes = new Set(payload.segments.map((segment) => segment.purpose));
  const explanatory = payload.segments.filter(
    (segment) => segment.purpose === 'explanation' || segment.purpose === 'mechanism',
  );
  const worked = payload.segments.filter((segment) => segment.purpose === 'worked_example');
  const active = payload.segments.filter(
    (segment) => segment.purpose === 'guided_practice' && segment.informalCheck,
  );
  if (!purposes.has('objective_orientation')) {
    findings.push(
      lessonFinding(
        'objective_alignment',
        'missing_objective_orientation',
        'Orient the learner to what capability this Lesson develops and why it matters now.',
      ),
    );
  }
  if (explanatory.length === 0) {
    findings.push(
      lessonFinding(
        'explanation_reasoning',
        'missing_explanation_or_mechanism',
        'Include an explanatory or mechanism segment that teaches why or how the idea works.',
      ),
    );
  } else {
    for (const segment of explanatory) {
      const combined = [segment.explanation, segment.example?.text, segment.contrast?.text]
        .filter(Boolean)
        .join(' ');
      if (
        !EXPLANATION_REASONING.test(combined) ||
        !hasLegacySemanticRelation(
          combined,
          segment.objectiveRefs,
          [
            ...segment.sourceRefs,
            ...(segment.example?.sourceRefs ?? []),
            ...(segment.contrast?.sourceRefs ?? []),
          ],
          input,
        )
      ) {
        findings.push(
          lessonFinding(
            'explanation_reasoning',
            'declarative_explanation_without_reasoning',
            `Segment ${payload.segments.indexOf(segment)} states content but does not explain a cause, condition, mechanism, or consequence.`,
            [payload.segments.indexOf(segment)],
            segment.objectiveRefs,
          ),
        );
      }
    }
  }
  if (worked.length === 0) {
    findings.push(
      lessonFinding(
        'worked_example',
        'missing_worked_example',
        'Include a worked example that makes intermediate reasoning visible.',
      ),
    );
  } else {
    for (const segment of worked) {
      const combined = `${segment.explanation} ${segment.example?.text ?? ''}`;
      if (
        !segment.example ||
        !WORKED_REASONING.test(combined) ||
        !WORKED_START.test(combined) ||
        !WORKED_PROCEDURE.test(combined) ||
        !WORKED_DECISION.test(combined) ||
        !WORKED_RESULT.test(combined) ||
        !hasLegacyWorkedProgression(
          combined,
          segment.objectiveRefs,
          [...segment.sourceRefs, ...(segment.example?.sourceRefs ?? [])],
          input,
        )
      ) {
        findings.push(
          lessonFinding(
            'worked_example',
            'worked_example_has_no_visible_reasoning',
            'The worked example must show a sequence, decision, condition, or result rather than merely naming an example.',
            [payload.segments.indexOf(segment)],
            segment.objectiveRefs,
          ),
        );
      }
    }
  }
  if (active.length === 0) {
    findings.push(
      lessonFinding(
        'learner_activity',
        'missing_deliberate_learner_activity',
        'Include a guided learner action whose answer is committed before coaching is revealed.',
      ),
    );
  }
  for (const segment of payload.segments) {
    if (segment.informalCheck && SOURCE_LOCATION_TRIVIA.test(segment.informalCheck.prompt)) {
      findings.push(
        lessonFinding(
          'learner_activity',
          'lesson_source_location_trivia',
          'An informal Lesson check must test the objective, not recall of where source text appears.',
          [payload.segments.indexOf(segment)],
          segment.objectiveRefs,
        ),
      );
    }
  }
  if (!purposes.has('contrast') && !purposes.has('misconception')) {
    findings.push(
      lessonFinding(
        'misconception_or_contrast',
        'missing_boundary_or_misconception_work',
        'Include either a meaningful contrast or misconception correction to define the idea’s boundaries.',
      ),
    );
  }

  for (const objective of input.learningUnit.objectives) {
    const segments = payload.segments.filter((segment) =>
      segment.objectiveRefs.includes(objective.objectiveRef),
    );
    const hasExplanation = segments.some((segment) =>
      ['explanation', 'mechanism', 'worked_example'].includes(segment.purpose),
    );
    const hasAction = segments.some((segment) => Boolean(segment.informalCheck));
    const combined = segments.map((segment) => segment.explanation).join(' ');
    if (
      !hasExplanation ||
      !hasAction ||
      overlapRatio(combined, `${objective.title} ${objective.description}`) === 0
    ) {
      findings.push(
        lessonFinding(
          'objective_alignment',
          'objective_lacks_explanation_and_action',
          `Objective ${objective.objectiveRef} needs semantically anchored explanation plus learner action.`,
          segments.map((segment) => payload.segments.indexOf(segment)),
          [objective.objectiveRef],
        ),
      );
    }
  }

  for (let left = 0; left < payload.segments.length; left += 1) {
    for (let right = left + 1; right < payload.segments.length; right += 1) {
      if (
        payload.segments[left]!.purpose === payload.segments[right]!.purpose &&
        overlapRatio(payload.segments[left]!.explanation, payload.segments[right]!.explanation) >=
          0.82
      ) {
        findings.push(
          lessonFinding(
            'semantic_nonredundancy',
            'semantically_redundant_lesson_segments',
            'Two segments repeat the same teaching intent instead of advancing the learner’s understanding.',
            [left, right],
          ),
        );
      }
    }
  }

  const sourceBacked = payload.segments.filter(
    (segment) =>
      segment.explanationAuthority === 'source_backed_teaching' && segment.sourceRefs.length > 0,
  );
  if (input.sourceContext.offers.length > 0 && sourceBacked.length < 2) {
    findings.push(
      lessonFinding(
        'source_grounding',
        'insufficient_source_grounded_teaching',
        'A text-backed Lesson needs multiple source-grounded teaching moves, not one token citation.',
      ),
    );
  }

  const minutes = lessonMinutes(payload);
  const durationTarget = input.durationBudget?.targetMinutes ?? input.plannedMinutes;
  const acceptableActiveMinutes = input.durationBudget?.acceptableActiveMinutes ?? {
    min: Math.max(1, durationTarget - 8),
    max: durationTarget + 3,
  };
  if (minutes.min > acceptableActiveMinutes.max || minutes.max < acceptableActiveMinutes.min) {
    findings.push(
      lessonFinding(
        'duration_plausibility',
        'agenda_duration_not_supported_by_learning_actions',
        `The ${durationTarget}-minute Agenda claim is not supported by the locally derived ${minutes.min}–${minutes.max}-minute activity range (target window ${acceptableActiveMinutes.min}–${acceptableActiveMinutes.max}).`,
      ),
    );
  }

  return LessonPedagogyEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: LESSON_PEDAGOGY_POLICY_VERSION,
    evaluator: 'independent-deterministic-lesson-evaluator',
    independent: true,
    status: findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
    boundedRepairAttempted: options.boundedRepairAttempted ?? false,
    estimatedActiveMinutes: minutes,
    claimedAgendaMinutes: input.plannedMinutes,
    findings,
    evaluatedAt: options.evaluatedAt,
  });
}

export function evaluatePracticeQuality(
  payload: TeachingBriefProposalPayload,
  input: TeachingBriefGenerationInput,
  options: { evaluatedAt: string; boundedRepairAttempted?: boolean },
): PracticeQualityEvaluation {
  const findings: PracticeQualityFinding[] = [];
  const objectives = new Map(
    input.learningUnit.objectives.map((objective) => [objective.objectiveRef, objective]),
  );
  const sources = new Map(input.sourceContext.offers.map((offer) => [offer.sourceRef, offer]));
  const visualRefs = new Set(
    (input.visualContext?.offers ?? []).map((offer) => offer.referenceKey),
  );
  const seenObjectives = new Set<string>();

  for (const [itemIndex, item] of payload.practice.items.entries()) {
    const objective = objectives.get(item.objectiveRef);
    if (!objective) {
      findings.push(
        practiceFinding(
          'objective_construct_alignment',
          'unknown_practice_objective',
          `Practice item ${itemIndex} references an unknown objective.`,
          [itemIndex],
          [item.objectiveRef],
        ),
      );
      continue;
    }
    seenObjectives.add(item.objectiveRef);
    const practiceEnvelope = objective.practiceEnvelope;
    if (practiceEnvelope) {
      if (
        practiceEnvelope.targetConstruct !== item.construct ||
        practiceEnvelope.authorityMode === 'unavailable' ||
        (practiceEnvelope.authorityMode === 'exact_source' && item.authority !== 'exact_source') ||
        (practiceEnvelope.authorityMode === 'advisory_visual' &&
          item.authority !== 'advisory_visual')
      ) {
        findings.push(
          practiceFinding(
            'objective_construct_alignment',
            'practice_construct_exceeds_objective_authority',
            `Practice item ${itemIndex} must preserve the exact provider-visible construct and authority envelope for ${item.objectiveRef}.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
      const offeredEvidence = new Set(
        practiceEnvelope.evidenceAliases.map((alias) => alias.sourceRef),
      );
      if (
        practiceEnvelope.authorityMode === 'exact_source' &&
        item.sourceRefs.some((sourceRef) => !offeredEvidence.has(sourceRef))
      ) {
        findings.push(
          practiceFinding(
            'authority_alignment',
            'practice_source_outside_objective_authority',
            `Practice item ${itemIndex} selects an evidence alias outside the objective-scoped Practice envelope.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
    }
    if (
      !objective.construct ||
      objective.construct !== item.construct ||
      objective.practiceAuthority === 'unavailable'
    ) {
      findings.push(
        practiceFinding(
          'objective_construct_alignment',
          'practice_construct_exceeds_objective_authority',
          `Practice item ${itemIndex} must preserve the exact locally authorized construct for ${item.objectiveRef}.`,
          [itemIndex],
          [item.objectiveRef],
        ),
      );
    }
    if (item.authority === 'exact_source') {
      if (
        objective.practiceAuthority === 'advisory_visual' ||
        item.sourceRefs.length === 0 ||
        item.visualRefs.length > 0
      ) {
        findings.push(
          practiceFinding(
            'authority_alignment',
            'practice_source_outside_objective_authority',
            `Practice item ${itemIndex} does not preserve its exact source authority boundary.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
      for (const sourceRef of item.sourceRefs) {
        const source = sources.get(sourceRef);
        if (!source || !source.authorizedObjectiveRefs.includes(item.objectiveRef)) {
          findings.push(
            practiceFinding(
              'authority_alignment',
              'practice_source_outside_objective_authority',
              `Practice item ${itemIndex} uses a source outside the objective’s exact authority envelope.`,
              [itemIndex],
              [item.objectiveRef],
            ),
          );
        }
      }
    } else if (
      objective.practiceAuthority !== 'advisory_visual' ||
      (item.construct !== 'identify' && item.construct !== 'explain') ||
      item.visualRefs.length === 0 ||
      item.sourceRefs.length > 0 ||
      item.visualRefs.some((ref) => !visualRefs.has(ref))
    ) {
      findings.push(
        practiceFinding(
          'authority_alignment',
          'practice_visual_authority_invalid',
          `Advisory visual Practice item ${itemIndex} must remain identify/explain-only and cite an offered V* context.`,
          [itemIndex],
          [item.objectiveRef],
        ),
      );
    }
    const semanticTarget = `${objective.title} ${objective.description}`;
    const semanticItem = `${item.capabilityTested} ${item.pedagogicalReason} ${item.initial.prompt}`;
    const initialCorrectText = item.initial.options.find(
      (option) => option.optionRef === item.initial.correctOptionRef,
    )?.text;
    if (
      overlapRatio(semanticTarget, semanticItem) === 0 ||
      !ACTION_LANGUAGE.test(item.initial.prompt) ||
      !CONSTRUCT_LANGUAGE[item.construct].test(item.initial.prompt) ||
      (item.construct === 'apply' && !APPLY_OBSERVABLE.test(item.initial.prompt)) ||
      !hasLegacyMeaningfulPracticeSurface(
        item.initial.prompt,
        initialCorrectText ?? '',
        semanticTarget,
        item.construct,
      )
    ) {
      findings.push(
        practiceFinding(
          'meaningful_action',
          'practice_does_not_elicit_authorized_capability',
          `Practice item ${itemIndex} does not make the ${item.construct} capability observable.`,
          [itemIndex],
          [item.objectiveRef],
        ),
      );
    }
    for (const [surfaceName, surface] of [
      ['initial', item.initial] as const,
      ['retry', item.retry] as const,
    ]) {
      if (SOURCE_LOCATION_TRIVIA.test(surface.prompt)) {
        findings.push(
          practiceFinding(
            'source_location_trivia',
            'source_location_trivia',
            `Practice ${surfaceName} item ${itemIndex} asks where text appears rather than testing the learning objective.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
      const optionRefs = surface.options.map((option) => option.optionRef);
      const optionTexts = surface.options.map((option) => normalized(option.text));
      if (
        new Set(optionRefs).size !== optionRefs.length ||
        new Set(optionTexts).size !== optionTexts.length ||
        !optionRefs.includes(surface.correctOptionRef)
      ) {
        findings.push(
          practiceFinding(
            'item_validity',
            'invalid_or_duplicate_practice_options',
            `Practice ${surfaceName} item ${itemIndex} needs unique options and exactly one referenced answer.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
      const correctText = surface.options.find(
        (option) => option.optionRef === surface.correctOptionRef,
      )?.text;
      if (correctText && normalized(surface.prompt).includes(normalized(correctText))) {
        findings.push(
          practiceFinding(
            'item_validity',
            'practice_prompt_leaks_answer',
            `Practice ${surfaceName} item ${itemIndex} repeats the complete correct option in its prompt.`,
            [itemIndex],
            [item.objectiveRef],
          ),
        );
      }
    }
    if (
      normalized(item.initial.prompt) === normalized(item.retry.prompt) ||
      overlapRatio(item.initial.prompt, item.retry.prompt) >= 0.85
    ) {
      findings.push(
        practiceFinding(
          'retry_validity',
          'retry_surface_not_meaningfully_changed',
          `Practice item ${itemIndex} must retry the same construct in a changed context, not repeat the original item.`,
          [itemIndex],
          [item.objectiveRef],
        ),
      );
    }
  }

  for (const objective of input.learningUnit.objectives) {
    if (
      (objective.priority === 'required' || objective.priority === 'high') &&
      objective.construct &&
      objective.practiceAuthority !== 'unavailable' &&
      !seenObjectives.has(objective.objectiveRef)
    ) {
      findings.push(
        practiceFinding(
          'objective_construct_alignment',
          'required_objective_has_no_practice',
          `Required/high objective ${objective.objectiveRef} needs one construct-valid Practice item.`,
          [],
          [objective.objectiveRef],
        ),
      );
    }
  }

  for (let left = 0; left < payload.practice.items.length; left += 1) {
    for (let right = left + 1; right < payload.practice.items.length; right += 1) {
      if (
        payload.practice.items[left]!.objectiveRef ===
          payload.practice.items[right]!.objectiveRef &&
        overlapRatio(
          payload.practice.items[left]!.initial.prompt,
          payload.practice.items[right]!.initial.prompt,
        ) >= 0.82
      ) {
        findings.push(
          practiceFinding(
            'semantic_nonredundancy',
            'semantically_redundant_practice_items',
            'Two Practice items repeat the same task instead of sampling the objective differently.',
            [left, right],
          ),
        );
      }
    }
  }

  return PracticeQualityEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: PRACTICE_QUALITY_POLICY_VERSION,
    evaluator: 'independent-deterministic-practice-evaluator',
    independent: true,
    status: findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
    boundedRepairAttempted: options.boundedRepairAttempted ?? false,
    findings,
    evaluatedAt: options.evaluatedAt,
  });
}

const FIELD_LABEL_ONLY =
  /^(?:(?:the|a|an) )?(?:(?:starting|initial|resulting) state|input|rule(?: or procedure)?|procedure|transition|action|reason|result|why(?: the)? result follows|learner decision|decision|required decision|expected action|example|placeholder|details?|起始状态|初始状态|输入|规则|流程|步骤|转变|行动|原因|结果|结论|为什么|学习者决策|决策|预期行动)$/iu;

const GENERIC_SEMANTIC_FEATURES = new Set([
  'about',
  'action',
  'after',
  'and',
  'apply',
  'are',
  'as',
  'before',
  'because',
  'but',
  'can',
  'concept',
  'could',
  'decision',
  'details',
  'does',
  'during',
  'each',
  'every',
  'example',
  'explain',
  'for',
  'from',
  'has',
  'have',
  'how',
  'important',
  'into',
  'is',
  'its',
  'lesson',
  'may',
  'not',
  'objective',
  'only',
  'procedure',
  'reason',
  'result',
  'rule',
  'source',
  'state',
  'step',
  'should',
  'than',
  'that',
  'the',
  'their',
  'then',
  'therefore',
  'these',
  'they',
  'this',
  'those',
  'through',
  'topic',
  'under',
  'was',
  'when',
  'where',
  'were',
  'which',
  'while',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const PROMOTED_CONSTRUCT_LANGUAGE = {
  identify: CONSTRUCT_LANGUAGE.identify,
  explain: CONSTRUCT_LANGUAGE.explain,
  apply:
    /(?:\b(?:apply|next step|order|sequence|diagnose|use (?:the )?(?:rule|procedure))\b|应用|下一步|排序|顺序|诊断|使用.{0,8}(?:规则|流程))/iu,
  design: CONSTRUCT_LANGUAGE.design,
  evaluate: CONSTRUCT_LANGUAGE.evaluate,
} as const;

type CompositionSourceContext = LessonSlotContentGenerationInput['sourceContext'];

function meaningfulFeatures(value: string): Set<string> {
  const result = features(value);
  for (const generic of GENERIC_SEMANTIC_FEATURES) result.delete(generic);
  return result;
}

function sharedMeaningfulFeatureCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared;
}

function hasMeaningfulOverlap(left: string, right: string): boolean {
  const leftFeatures = meaningfulFeatures(left);
  const rightFeatures = meaningfulFeatures(right);
  return sharedMeaningfulFeatureCount(leftFeatures, rightFeatures) >= 2;
}

/**
 * Rejects typed claims whose substantive vocabulary is mostly outside the
 * locally bounded objective/source text. This is necessary compatibility
 * evidence only: lexical anchoring cannot prove complete semantic entailment.
 */
function hasBoundedSemanticCompatibility(candidate: string, boundedContext: string): boolean {
  const candidateFeatures = meaningfulFeatures(candidate);
  const contextFeatures = meaningfulFeatures(boundedContext);
  const shared = sharedMeaningfulFeatureCount(candidateFeatures, contextFeatures);
  return shared >= 2 && shared * 3 >= candidateFeatures.size;
}

function isSubstantiveText(value: string | null | undefined): value is string {
  if (!value) return false;
  const compact = normalized(value);
  if (compact.length < 8 || FIELD_LABEL_ONLY.test(compact)) return false;
  const hanCount = [...compact.matchAll(/\p{Script=Han}/gu)].length;
  return meaningfulFeatures(value).size >= 2 || hanCount >= 4;
}

function isSemanticallyDistinct(left: string, right: string): boolean {
  if (normalized(left) === normalized(right)) return false;
  return overlapRatio(left, right) < 0.9;
}

function sourceTextForRefs(context: CompositionSourceContext, refs: string[]): string {
  const requested = new Set(refs);
  return context.offers
    .filter((offer) => requested.has(offer.sourceRef))
    .map((offer) => offer.text)
    .join(' ');
}

function objectiveTargetForSlot(
  slot: TeachingSkeletonSlot,
  input: LessonSlotContentGenerationInput,
): string {
  return input.skeleton.objectives
    .filter((objective) => slot.objectiveRefs.includes(objective.objectiveRef))
    .map((objective) => `${objective.title} ${objective.description}`)
    .join(' ');
}

function allLessonSourceRefs(content: TeachingLessonSlotContent): string[] {
  return [
    ...content.sourceRefs,
    ...content.semanticRelations.flatMap((relation) => relation.sourceRefs),
    ...(content.workedProcess?.sourceRefs ?? []),
    ...(content.example?.sourceRefs ?? []),
    ...(content.contrast?.sourceRefs ?? []),
    ...(content.misconception?.sourceRefs ?? []),
  ];
}

function allLessonText(content: TeachingLessonSlotContent): string {
  return [
    content.explanation,
    ...content.semanticRelations.flatMap((relation) => [
      relation.fromProposition,
      relation.toProposition,
      relation.relevanceToObjective,
    ]),
    content.workedProcess?.startingState,
    content.workedProcess?.ruleOrProcedure,
    ...(content.workedProcess?.steps.flatMap((step) => [
      step.action,
      step.reason,
      step.resultingState,
    ]) ?? []),
    content.workedProcess?.learnerDecision,
    content.workedProcess?.result,
    content.workedProcess?.whyResultFollows,
    content.example?.text,
    content.contrast?.text,
    content.misconception?.hypothesis,
    content.misconception?.correction,
    content.informalCheck?.prompt,
    content.informalCheck?.expectedSignal,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function relationIssueCodes(
  relation: TeachingLessonSlotContent['semanticRelations'][number],
  slot: TeachingSkeletonSlot,
  objectiveTarget: string,
  input: LessonSlotContentGenerationInput,
): string[] {
  const issues: string[] = [];
  if (!slot.allowedRelations.includes(relation.kind)) {
    issues.push('semantic_relation_outside_slot_contract');
  }
  if (
    !isSubstantiveText(relation.fromProposition) ||
    !isSubstantiveText(relation.toProposition) ||
    !isSemanticallyDistinct(relation.fromProposition, relation.toProposition)
  ) {
    issues.push('semantic_relation_not_substantive');
  }
  if (
    !isSubstantiveText(relation.relevanceToObjective) ||
    !hasBoundedSemanticCompatibility(
      relation.relevanceToObjective,
      `${objectiveTarget} ${slot.purpose}`,
    )
  ) {
    issues.push('semantic_relation_not_objective_relevant');
  }
  if (slot.authorityMode === 'exact_source') {
    const citedSource = sourceTextForRefs(input.sourceContext, relation.sourceRefs);
    if (
      relation.sourceRefs.length === 0 ||
      !hasBoundedSemanticCompatibility(relation.fromProposition, citedSource) ||
      !hasBoundedSemanticCompatibility(relation.toProposition, citedSource)
    ) {
      issues.push('semantic_relation_source_incompatible');
    }
  }
  if (slot.authorityMode === 'advisory_visual' && relation.sourceRefs.length > 0) {
    issues.push('semantic_relation_source_incompatible');
  }
  return [...new Set(issues)];
}

function workedProcessIssueCodes(
  content: TeachingLessonSlotContent,
  slot: TeachingSkeletonSlot,
  objectiveTarget: string,
  input: LessonSlotContentGenerationInput,
): string[] {
  const process = content.workedProcess;
  if (!process) return ['missing_typed_worked_process'];
  const issues: string[] = [];
  const citedSource = sourceTextForRefs(input.sourceContext, process.sourceRefs);
  const domainTarget = `${objectiveTarget} ${citedSource}`;
  const requiredTexts = [
    process.startingState,
    process.ruleOrProcedure,
    process.result,
    process.whyResultFollows,
    ...process.steps.flatMap((step) => [step.action, step.reason, step.resultingState]),
  ];
  if (
    requiredTexts.some((value) => !isSubstantiveText(value)) ||
    !hasMeaningfulOverlap(process.startingState, domainTarget) ||
    !hasMeaningfulOverlap(process.ruleOrProcedure, domainTarget) ||
    !hasMeaningfulOverlap(process.result, domainTarget) ||
    process.steps.some(
      (step) => !hasMeaningfulOverlap(`${step.action} ${step.resultingState}`, domainTarget),
    ) ||
    !isSemanticallyDistinct(process.startingState, process.result)
  ) {
    issues.push('worked_process_missing_required_structure');
  }
  let precedingState = process.startingState;
  for (const step of process.steps) {
    if (
      !isSemanticallyDistinct(precedingState, step.resultingState) ||
      !isSemanticallyDistinct(step.action, step.resultingState)
    ) {
      issues.push('worked_process_has_no_real_transition');
      break;
    }
    precedingState = step.resultingState;
  }
  const processTrace = `${process.ruleOrProcedure} ${process.steps
    .flatMap((step) => [step.action, step.reason, step.resultingState])
    .join(' ')} ${process.result}`;
  if (!hasBoundedSemanticCompatibility(process.whyResultFollows, processTrace)) {
    issues.push('worked_process_result_not_justified');
  }
  if (
    slot.authorityMode !== 'exact_source' ||
    process.sourceRefs.length === 0 ||
    !hasBoundedSemanticCompatibility(process.ruleOrProcedure, citedSource)
  ) {
    issues.push('worked_process_source_incompatible');
  }
  if (
    (slot.construct === 'apply' || slot.construct === 'design' || slot.construct === 'evaluate') &&
    (!isSubstantiveText(process.learnerDecision) ||
      !hasMeaningfulOverlap(process.learnerDecision, domainTarget))
  ) {
    issues.push('worked_process_missing_application_decision');
  }
  return [...new Set(issues)];
}

function lessonIssueMessage(code: string, slotId: string): string {
  const messages: Record<string, string> = {
    lesson_slot_content_not_objective_aligned: `${slotId} content is not meaningfully anchored to its locally planned objective or source.`,
    lesson_slot_content_not_substantive: `${slotId} needs substantive instructional content rather than a field label or placeholder.`,
    lesson_source_location_trivia: `${slotId} asks where source text appears instead of eliciting the planned capability.`,
    missing_planned_learner_action: `${slotId} must contain the learner action required by the immutable skeleton.`,
    unplanned_lesson_learner_action: `${slotId} cannot add a learner action outside the immutable skeleton budget.`,
    missing_planned_boundary_work: `${slotId} must fill the planned contrast or misconception boundary role.`,
    missing_typed_semantic_relation: `${slotId} requires a typed relation between two meaningful source-compatible propositions.`,
    semantic_relation_outside_slot_contract: `${slotId} uses a relation kind outside its immutable controlled relation set.`,
    semantic_relation_not_substantive: `${slotId} relation must contain two distinct, meaningful propositions or states.`,
    semantic_relation_not_objective_relevant: `${slotId} relation does not explain its relevance to the locally planned objective.`,
    semantic_relation_source_incompatible: `${slotId} relation is not compatible with a locally allowed cited source.`,
    missing_typed_worked_process: `${slotId} requires a typed worked process with start, rule, transitions, result, and justification.`,
    worked_process_missing_required_structure: `${slotId} worked process contains labels or generic fields instead of an observable start/rule/transition/result path.`,
    worked_process_has_no_real_transition: `${slotId} worked process does not change state through its stated actions.`,
    worked_process_result_not_justified: `${slotId} worked process does not connect its final result to the rule and transitions.`,
    worked_process_source_incompatible: `${slotId} worked process does not use an exact locally allowed source-stated rule or procedure.`,
    worked_process_missing_application_decision: `${slotId} worked process needs a source-bounded learner decision for the planned higher-order construct.`,
    unplanned_worked_process: `${slotId} cannot add a worked process outside the immutable skeleton role.`,
  };
  return messages[code] ?? `${slotId} does not satisfy its immutable Lesson quality contract.`;
}

function lessonCriterionForCode(code: string): LessonPedagogyFinding['criterion'] {
  if (code.includes('worked_process')) return 'worked_example';
  if (code.includes('learner_action') || code === 'lesson_source_location_trivia') {
    return 'learner_activity';
  }
  if (code.includes('boundary')) return 'misconception_or_contrast';
  if (code.includes('semantic_relation')) return 'explanation_reasoning';
  return 'objective_alignment';
}

/**
 * Independent evaluation of provider-filled content against a frozen local
 * Teaching Skeleton. Typed relations/processes are authoritative here;
 * lexical connectors are deliberately not acceptance evidence.
 */
export function evaluateLessonSlotPedagogy(
  payload: LessonSlotContentProposalPayload,
  input: LessonSlotContentGenerationInput,
  options: { evaluatedAt: string; boundedRepairAttempted?: boolean },
): LessonPedagogyEvaluation {
  const findings: LessonPedagogyFinding[] = [];
  const contentById = new Map(payload.slots.map((content) => [content.slotId, content]));

  for (const [slotIndex, slot] of input.skeleton.lessonSlots.entries()) {
    const content = contentById.get(slot.slotId);
    if (!content) continue;
    const objectiveTarget = objectiveTargetForSlot(slot, input);
    const citedSource = sourceTextForRefs(input.sourceContext, allLessonSourceRefs(content));
    const domainTarget = `${objectiveTarget} ${slot.purpose} ${citedSource}`;
    const codes = new Set<string>();

    if (!isSubstantiveText(content.explanation)) {
      codes.add('lesson_slot_content_not_substantive');
    }
    if (!hasMeaningfulOverlap(allLessonText(content), domainTarget)) {
      codes.add('lesson_slot_content_not_objective_aligned');
    }

    let validRelationCount = 0;
    for (const relation of content.semanticRelations) {
      const relationIssues = relationIssueCodes(relation, slot, objectiveTarget, input);
      if (relationIssues.length === 0) validRelationCount += 1;
      else relationIssues.forEach((code) => codes.add(code));
    }
    if (slot.qualityContract === 'semantic_relation' && validRelationCount === 0) {
      codes.add('missing_typed_semantic_relation');
    }

    if (slot.qualityContract === 'worked_process') {
      workedProcessIssueCodes(content, slot, objectiveTarget, input).forEach((code) =>
        codes.add(code),
      );
    } else if (content.workedProcess) {
      codes.add('unplanned_worked_process');
    }

    if (slot.learnerActionRequired) {
      if (
        !content.informalCheck ||
        !isSubstantiveText(content.informalCheck.prompt) ||
        !hasMeaningfulOverlap(content.informalCheck.prompt, domainTarget)
      ) {
        codes.add('missing_planned_learner_action');
      } else if (SOURCE_LOCATION_TRIVIA.test(content.informalCheck.prompt)) {
        codes.add('lesson_source_location_trivia');
      }
    } else if (content.informalCheck) {
      codes.add('unplanned_lesson_learner_action');
    }

    if (slot.qualityContract === 'boundary_work') {
      const boundaryTexts = [
        content.contrast?.text,
        content.misconception
          ? `${content.misconception.hypothesis} ${content.misconception.correction}`
          : undefined,
      ].filter((value): value is string => Boolean(value));
      const hasSubstantiveContrast = isSubstantiveText(content.contrast?.text);
      const hasSubstantiveMisconception =
        isSubstantiveText(content.misconception?.hypothesis) &&
        isSubstantiveText(content.misconception?.correction);
      if (!hasSubstantiveContrast && !hasSubstantiveMisconception) {
        codes.add('missing_planned_boundary_work');
      } else if (boundaryTexts.some((text) => !hasMeaningfulOverlap(text, domainTarget))) {
        codes.add('lesson_slot_content_not_objective_aligned');
      }
    }

    for (const code of codes) {
      findings.push(
        lessonFinding(
          lessonCriterionForCode(code),
          code,
          lessonIssueMessage(code, slot.slotId),
          [slotIndex],
          slot.objectiveRefs,
        ),
      );
    }
  }

  for (let left = 0; left < input.skeleton.lessonSlots.length; left += 1) {
    const leftSlot = input.skeleton.lessonSlots[left]!;
    const leftContent = contentById.get(leftSlot.slotId);
    if (!leftContent) continue;
    for (let right = left + 1; right < input.skeleton.lessonSlots.length; right += 1) {
      const rightSlot = input.skeleton.lessonSlots[right]!;
      const rightContent = contentById.get(rightSlot.slotId);
      if (
        rightContent &&
        leftSlot.qualityContract === rightSlot.qualityContract &&
        overlapRatio(leftContent.explanation, rightContent.explanation) >= 0.9
      ) {
        findings.push(
          lessonFinding(
            'semantic_nonredundancy',
            'semantically_redundant_lesson_slots',
            `${leftSlot.slotId} and ${rightSlot.slotId} repeat content instead of filling their distinct immutable roles.`,
            [left, right],
            [...new Set([...leftSlot.objectiveRefs, ...rightSlot.objectiveRefs])],
          ),
        );
      }
    }
  }

  const plannedMinutes = input.skeleton.plannedActivityBudget;
  if (
    plannedMinutes.minMinutes > input.skeleton.acceptableActiveMinutes.maxMinutes ||
    plannedMinutes.maxMinutes < input.skeleton.acceptableActiveMinutes.minMinutes
  ) {
    findings.push(
      lessonFinding(
        'duration_plausibility',
        'skeleton_duration_outside_agenda_window',
        'The immutable Teaching Skeleton activity range is incompatible with the accepted Agenda window.',
      ),
    );
  }

  return LessonPedagogyEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: COMPOSITIONAL_LESSON_PEDAGOGY_POLICY_VERSION,
    evaluator: 'independent-deterministic-lesson-evaluator',
    independent: true,
    status: findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
    boundedRepairAttempted: options.boundedRepairAttempted ?? false,
    estimatedActiveMinutes: {
      min: plannedMinutes.minMinutes,
      max: plannedMinutes.maxMinutes,
    },
    claimedAgendaMinutes: input.skeleton.targetMinutes,
    findings,
    evaluatedAt: options.evaluatedAt,
  });
}

type PlannedPracticeSlot =
  PracticeContentGenerationInput['skeleton']['practicePlan']['slots'][number];

function practiceObjectiveTarget(
  slot: PlannedPracticeSlot,
  input: PracticeContentGenerationInput,
): string {
  const objective = input.skeleton.objectives.find(
    (candidate) => candidate.objectiveRef === slot.objectiveRef,
  );
  return objective ? `${objective.title} ${objective.description}` : '';
}

function correctOptionText(item: ProposedPracticeSlotContent, surface: 'initial' | 'retry') {
  const selected = item[surface];
  return (
    selected.options.find((option) => option.optionRef === selected.correctOptionRef)?.text ?? ''
  );
}

function applicationIssueCodes(
  item: ProposedPracticeSlotContent,
  slot: PlannedPracticeSlot,
  objectiveTarget: string,
  input: PracticeContentGenerationInput,
): string[] {
  if (slot.construct !== 'apply') {
    return item.application ? ['practice_application_outside_planned_construct'] : [];
  }
  const application = item.application;
  if (!application) return ['practice_apply_missing_typed_application'];
  const issues: string[] = [];
  const citedSource = sourceTextForRefs(input.sourceContext, item.sourceRefs);
  const domainTarget = `${objectiveTarget} ${slot.capabilityToObserve} ${citedSource}`;
  const requiredTexts = [
    application.startingState,
    application.sourceRuleOrProcedure,
    application.decisionRequired,
    application.expectedAction,
  ];
  if (
    requiredTexts.some((value) => !isSubstantiveText(value)) ||
    !hasBoundedSemanticCompatibility(application.startingState, domainTarget) ||
    !hasBoundedSemanticCompatibility(application.expectedAction, domainTarget) ||
    !isSemanticallyDistinct(application.startingState, application.expectedAction)
  ) {
    issues.push('practice_application_missing_real_state_or_action');
  }
  if (
    slot.authorityMode !== 'exact_source' ||
    item.sourceRefs.length === 0 ||
    !hasBoundedSemanticCompatibility(application.sourceRuleOrProcedure, citedSource)
  ) {
    issues.push('practice_application_source_incompatible');
  }
  const applicationTrace = `${application.startingState} ${application.sourceRuleOrProcedure} ${application.decisionRequired} ${application.expectedAction}`;
  for (const surfaceName of ['initial', 'retry'] as const) {
    const surface = item[surfaceName];
    const correctText = correctOptionText(item, surfaceName);
    if (
      !hasMeaningfulOverlap(`${surface.prompt} ${correctText}`, applicationTrace) ||
      !hasBoundedSemanticCompatibility(
        `${correctText} ${surface.explanation}`,
        `${application.expectedAction} ${application.sourceRuleOrProcedure}`,
      )
    ) {
      issues.push('practice_application_not_observable_in_surface');
      break;
    }
  }
  return [...new Set(issues)];
}

function practiceIssueMessage(code: string, practiceSlotId: string): string {
  const messages: Record<string, string> = {
    practice_capability_not_objective_aligned: `${practiceSlotId} does not make its locally planned objective capability observable.`,
    practice_content_not_substantive: `${practiceSlotId} contains labels or placeholders instead of a substantive Practice item.`,
    practice_promotes_construct: `${practiceSlotId} asks for a construct that the immutable Practice plan explicitly prohibits.`,
    source_location_trivia: `${practiceSlotId} asks where source text appears rather than testing the planned capability.`,
    invalid_or_duplicate_practice_options: `${practiceSlotId} needs unique options and a correct answer that references an offered option.`,
    practice_prompt_leaks_answer: `${practiceSlotId} repeats the complete correct option in its prompt.`,
    practice_surface_not_objective_aligned: `${practiceSlotId} prompt and answer are not meaningfully anchored to its objective or selected source.`,
    practice_feedback_not_contingent: `${practiceSlotId} must give option-contingent feedback rather than the same response for every choice.`,
    retry_surface_not_meaningfully_changed: `${practiceSlotId} retry must test the same construct in a materially changed context.`,
    practice_apply_missing_typed_application: `${practiceSlotId} cannot satisfy APPLY with lexical apply/next-step wording; it needs typed state, source rule, decision, and expected action data.`,
    practice_application_missing_real_state_or_action: `${practiceSlotId} application fields must describe a real starting state and observable action rather than labels.`,
    practice_application_source_incompatible: `${practiceSlotId} application does not use an exact locally selected source-stated rule or procedure.`,
    practice_application_not_observable_in_surface: `${practiceSlotId} prompt and action options do not expose the typed application decision.`,
    practice_application_outside_planned_construct: `${practiceSlotId} cannot add an application contract outside the immutable planned construct.`,
  };
  return messages[code] ?? `${practiceSlotId} does not satisfy its immutable Practice contract.`;
}

function practiceCriterionForCode(code: string): PracticeQualityFinding['criterion'] {
  if (code === 'source_location_trivia') return 'source_location_trivia';
  if (code.includes('retry')) return 'retry_validity';
  if (code.includes('source_incompatible')) return 'authority_alignment';
  if (
    code.includes('option') ||
    code.includes('leaks') ||
    code.includes('feedback') ||
    code.includes('substantive')
  ) {
    return 'item_validity';
  }
  if (code.includes('promotes') || code.includes('outside_planned_construct')) {
    return 'objective_construct_alignment';
  }
  return 'meaningful_action';
}

/**
 * Independent Practice-only evaluation against the immutable local Practice
 * Plan. In particular, APPLY acceptance is based on typed application facts
 * and source-compatible use, never on apply/next-step vocabulary alone.
 */
export function evaluatePlannedPracticeQuality(
  payload: PracticeContentProposalPayload,
  input: PracticeContentGenerationInput,
  options: { evaluatedAt: string; boundedRepairAttempted?: boolean },
): PracticeQualityEvaluation {
  const findings: PracticeQualityFinding[] = [];
  const contentById = new Map(payload.items.map((item) => [item.practiceSlotId, item]));

  for (const [slotIndex, slot] of input.skeleton.practicePlan.slots.entries()) {
    const item = contentById.get(slot.practiceSlotId);
    if (!item) continue;
    const objectiveTarget = practiceObjectiveTarget(slot, input);
    const citedSource = sourceTextForRefs(input.sourceContext, item.sourceRefs);
    const domainTarget = `${objectiveTarget} ${citedSource}`;
    const codes = new Set<string>();

    if (!isSubstantiveText(item.capabilityTested) || !isSubstantiveText(item.pedagogicalReason)) {
      codes.add('practice_content_not_substantive');
    }
    const itemSemantics = `${item.capabilityTested} ${item.pedagogicalReason} ${item.initial.prompt} ${correctOptionText(item, 'initial')} ${item.initial.explanation}`;
    if (!hasMeaningfulOverlap(itemSemantics, domainTarget)) {
      codes.add('practice_capability_not_objective_aligned');
    }

    for (const prohibited of slot.prohibitedStrongerConstructs) {
      if (PROMOTED_CONSTRUCT_LANGUAGE[prohibited].test(itemSemantics)) {
        codes.add('practice_promotes_construct');
        break;
      }
    }

    applicationIssueCodes(item, slot, objectiveTarget, input).forEach((code) => codes.add(code));

    for (const surfaceName of ['initial', 'retry'] as const) {
      const surface = item[surfaceName];
      if (SOURCE_LOCATION_TRIVIA.test(surface.prompt)) codes.add('source_location_trivia');
      const optionRefs = surface.options.map((option) => option.optionRef);
      const optionTexts = surface.options.map((option) => normalized(option.text));
      const correctText = correctOptionText(item, surfaceName);
      if (
        new Set(optionRefs).size !== optionRefs.length ||
        new Set(optionTexts).size !== optionTexts.length ||
        !optionRefs.includes(surface.correctOptionRef)
      ) {
        codes.add('invalid_or_duplicate_practice_options');
      }
      if (correctText && normalized(surface.prompt).includes(normalized(correctText))) {
        codes.add('practice_prompt_leaks_answer');
      }
      if (
        !isSubstantiveText(surface.prompt) ||
        !isSubstantiveText(correctText) ||
        !isSubstantiveText(surface.explanation) ||
        (!surface.prompt.includes('?') &&
          !surface.prompt.includes('？') &&
          !ACTION_LANGUAGE.test(surface.prompt)) ||
        !hasMeaningfulOverlap(
          `${surface.prompt} ${correctText} ${surface.explanation}`,
          domainTarget,
        )
      ) {
        codes.add('practice_surface_not_objective_aligned');
      }
      const feedback = surface.options.map((option) => normalized(option.feedbackIfSelected));
      if (feedback.length > 1 && new Set(feedback).size === 1) {
        codes.add('practice_feedback_not_contingent');
      }
    }

    if (
      normalized(item.initial.prompt) === normalized(item.retry.prompt) ||
      overlapRatio(item.initial.prompt, item.retry.prompt) >= 0.85
    ) {
      codes.add('retry_surface_not_meaningfully_changed');
    }

    for (const code of codes) {
      findings.push(
        practiceFinding(
          practiceCriterionForCode(code),
          code,
          practiceIssueMessage(code, slot.practiceSlotId),
          [slotIndex],
          [slot.objectiveRef],
        ),
      );
    }
  }

  for (let left = 0; left < input.skeleton.practicePlan.slots.length; left += 1) {
    const leftSlot = input.skeleton.practicePlan.slots[left]!;
    const leftItem = contentById.get(leftSlot.practiceSlotId);
    if (!leftItem) continue;
    for (let right = left + 1; right < input.skeleton.practicePlan.slots.length; right += 1) {
      const rightSlot = input.skeleton.practicePlan.slots[right]!;
      const rightItem = contentById.get(rightSlot.practiceSlotId);
      if (
        rightItem &&
        leftSlot.objectiveRef === rightSlot.objectiveRef &&
        overlapRatio(leftItem.initial.prompt, rightItem.initial.prompt) >= 0.82
      ) {
        findings.push(
          practiceFinding(
            'semantic_nonredundancy',
            'semantically_redundant_practice_items',
            `${leftSlot.practiceSlotId} and ${rightSlot.practiceSlotId} repeat the same task instead of sampling the objective differently.`,
            [left, right],
            [leftSlot.objectiveRef],
          ),
        );
      }
    }
  }

  return PracticeQualityEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: COMPOSITIONAL_PRACTICE_QUALITY_POLICY_VERSION,
    evaluator: 'independent-deterministic-practice-evaluator',
    independent: true,
    status: findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
    boundedRepairAttempted: options.boundedRepairAttempted ?? false,
    findings,
    evaluatedAt: options.evaluatedAt,
  });
}

/** Map compositional Lesson findings back to stable immutable slot identities. */
export function lessonEvaluationInvalidSlotIds(
  evaluation: LessonPedagogyEvaluation,
  input: LessonSlotContentGenerationInput,
): string[] {
  const ids = evaluation.findings
    .filter((finding) => finding.severity === 'error')
    .flatMap((finding) =>
      finding.segmentIndexes.map((index) => input.skeleton.lessonSlots[index]?.slotId),
    )
    .filter((slotId): slotId is string => Boolean(slotId));
  return [...new Set(ids)];
}

/** Map compositional Practice findings back to stable immutable slot identities. */
export function practiceEvaluationInvalidSlotIds(
  evaluation: PracticeQualityEvaluation,
  input: PracticeContentGenerationInput,
): string[] {
  const ids = evaluation.findings
    .filter((finding) => finding.severity === 'error')
    .flatMap((finding) =>
      finding.itemIndexes.map((index) => input.skeleton.practicePlan.slots[index]?.practiceSlotId),
    )
    .filter((slotId): slotId is string => Boolean(slotId));
  return [...new Set(ids)];
}
