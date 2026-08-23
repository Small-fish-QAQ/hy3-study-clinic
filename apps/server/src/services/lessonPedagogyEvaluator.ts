import {
  LessonPedagogyEvaluationSchema,
  PracticeQualityEvaluationSchema,
  type LessonPedagogyEvaluation,
  type LessonPedagogyFinding,
  type PracticeQualityEvaluation,
  type PracticeQualityFinding,
  type TeachingBriefProposalPayload,
} from '@hy3-clinic/shared';
import type { TeachingBriefGenerationInput } from '../llm/provider.js';

export const LESSON_PEDAGOGY_POLICY_VERSION = 'lesson-pedagogy-v2';
export const PRACTICE_QUALITY_POLICY_VERSION = 'lesson-practice-v1';

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
  /(?:\b(?:page|slide|section|chapter|paragraph|line|block|document)\b.{0,35}\b(?:where|which|number|located|mention(?:ed)?)\b|\bsource\b.{0,35}\b(?:where|located|mention(?:ed)?|page|slide|section|chapter|paragraph|line|block)\b|\b(?:where|which)\b.{0,35}\b(?:document|source|page|slide|section|chapter|paragraph|line|block)\b|第.{0,8}(?:页|幻灯片|章节|段|行)|(?:哪一|哪个|何处|哪里).{0,12}(?:页|幻灯片|章节|段落|位置)|(?:原文|资料|文档|来源).{0,12}(?:哪里|何处|哪一页|第几页|哪个章节))/iu;

const EXPLANATION_REASONING =
  /(?:\b(?:because|therefore|so that|depends on|causes?|means that|works by|mechanism|why|how)\b|因为|所以|因此|从而|取决于|意味着|机制|原理|如何|为什么|通过)/iu;
const WORKED_REASONING =
  /(?:\b(?:first|next|then|finally|step|given|result|because|therefore|if|when)\b|首先|先|接着|然后|最后|步骤|已知|结果|因为|因此|如果|当)/iu;
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
      if (!EXPLANATION_REASONING.test(combined)) {
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
      if (!segment.example || !WORKED_REASONING.test(combined)) {
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
  if (
    input.plannedMinutes > minutes.max + 3 ||
    input.plannedMinutes < Math.max(1, minutes.min - 8)
  ) {
    findings.push(
      lessonFinding(
        'duration_plausibility',
        'agenda_duration_not_supported_by_learning_actions',
        `The ${input.plannedMinutes}-minute Agenda claim is not supported by the locally derived ${minutes.min}–${minutes.max}-minute activity range.`,
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
    if (
      overlapRatio(semanticTarget, semanticItem) === 0 ||
      !ACTION_LANGUAGE.test(item.initial.prompt) ||
      !CONSTRUCT_LANGUAGE[item.construct].test(item.initial.prompt)
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
