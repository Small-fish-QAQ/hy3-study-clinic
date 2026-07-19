import {
  clamp01,
  fnv1a32,
  type Concept,
  type ConceptAnalysisPayload,
  type GraphProposalPayload,
  type ProposedConcept,
  type ProposedGraphEdge,
  type ProposedQuestion,
  type QuestionType,
  type QuizGenerationPayload,
  type RemediationPlanProposalPayload,
  type RubricGrade,
  type SourceBlock,
} from '@hy3-clinic/shared';
import { ProviderError } from './errors.js';
import type {
  ConceptAnalysisInput,
  GraphProposalInput,
  LlmProvider,
  ProviderCallOptions,
  QuizGenerationInput,
  RemediationInput,
  RemediationPlanInput,
  ShortAnswerGradingInput,
} from './provider.js';

/**
 * Deterministic, offline fake provider.
 *
 * Produces grounded concept analysis, quizzes, short-answer grades, and
 * remediation WITHOUT any network access. Output is a pure function of the
 * input (source blocks, concepts, config), so identical input always yields
 * identical output — making the whole app reproducible in tests and demos.
 * Every quote is copied verbatim from a real source block, so server-side
 * grounding verification always succeeds.
 *
 * An optional artificial delay makes loading/cancellation states visible in
 * the UI; it is 0 in tests by default.
 */

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/** Split text into sentence-like spans on Chinese/ASCII terminators. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。!?;!?;])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/** Pick the n-th (mod count) substantial sentence of a block, verbatim. */
function pickQuote(block: SourceBlock, n = 0): string {
  const parts = sentences(block.content).filter((s) => s.length <= 120);
  if (parts.length === 0) return block.content.slice(0, 120);
  return parts[n % parts.length]!;
}

/** Deterministic pseudo-shuffle (stable per seed). */
function seededOrder(n: number, seed: number): number[] {
  return Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => fnv1a32(`${seed}:${a}`) - fnv1a32(`${seed}:${b}`),
  );
}

function bodyBlocks(blocks: SourceBlock[]): SourceBlock[] {
  const body = blocks.filter((b) => b.content.length >= 12);
  return body.length > 0 ? body : blocks;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(ProviderError.cancelled());
      },
      { once: true },
    );
  });
}

export interface FakeProviderOptions {
  /** Simulated latency per call, for observable loading/cancel states. */
  delayMs?: number;
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  private readonly delayMs: number;

  constructor(options: FakeProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
  }

  private async gate(opts?: ProviderCallOptions): Promise<void> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    await sleep(this.delayMs, opts?.signal);
  }

  async analyzeConcepts(
    input: ConceptAnalysisInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptAnalysisPayload> {
    await this.gate(opts);
    const blocks = bodyBlocks(input.blocks);
    const seen = new Set<string>();
    const concepts: ProposedConcept[] = [];

    for (const block of blocks) {
      const name = (block.heading ?? deriveName(block.content)).slice(0, 40);
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      concepts.push({
        name,
        summary: summarize(block.content),
        importance: concepts.length < 3 ? 'high' : concepts.length < 6 ? 'medium' : 'low',
        blockId: block.id,
        quote: pickQuote(block),
      });
      if (concepts.length >= 8) break;
    }

    if (concepts.length === 0) {
      const first = input.blocks[0]!;
      concepts.push({
        name: input.materialTitle.slice(0, 40) || '核心内容',
        summary: summarize(first.content),
        importance: 'high',
        blockId: first.id,
        quote: pickQuote(first),
      });
    }
    return { concepts };
  }

  async generateQuiz(
    input: QuizGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    await this.gate(opts);
    const questions: ProposedQuestion[] = [];
    const concepts = input.concepts;
    if (concepts.length === 0) return { questions: [] };

    for (const type of input.config.types) {
      for (let n = 0; n < input.config.countPerType; n++) {
        const concept = concepts[(n + questions.length) % concepts.length]!;
        const block =
          input.blocks.find((b) => b.id === concept.grounding.blockId) ?? input.blocks[0]!;
        questions.push(
          buildQuestion(type, { id: concept.id, name: concept.name }, block, {
            difficulty: input.config.difficulty,
            variant: n,
          }),
        );
      }
    }
    return { questions };
  }

  async gradeShortAnswer(
    input: ShortAnswerGradingInput,
    opts?: ProviderCallOptions,
  ): Promise<RubricGrade> {
    await this.gate(opts);
    const answer = input.answerText.trim();
    const matched: number[] = [];
    input.rubricKeyPoints.forEach((point, i) => {
      if (keyPointCovered(answer, point)) matched.push(i);
    });
    const total = input.rubricKeyPoints.length;
    const coverage = total === 0 ? 0 : matched.length / total;
    const lengthFactor = clamp01(answer.length / Math.max(12, input.expectedAnswer.length * 0.5));
    const score = clamp01(coverage * 0.8 + Math.min(coverage, lengthFactor) * 0.2);
    // More confident at the extremes (clearly right / clearly wrong).
    const confidence = clamp01(0.6 + Math.abs(score - 0.5) * 0.6);

    return {
      matchedKeyPointIndexes: matched,
      score,
      confidence,
      feedback: buildFeedback(matched, input.rubricKeyPoints),
    };
  }

  async generateRemediation(
    input: RemediationInput,
    opts?: ProviderCallOptions,
  ): Promise<QuizGenerationPayload> {
    await this.gate(opts);
    const questions: ProposedQuestion[] = [];
    for (const target of input.targets) {
      const block =
        input.blocks.find((b) => b.id === target.concept.grounding.blockId) ?? input.blocks[0]!;
      for (let n = 0; n < input.questionsPerConcept; n++) {
        const type = n % 2 === 0 ? 'single_choice' : 'short_answer';
        questions.push(
          buildQuestion(type, { id: target.concept.id, name: target.concept.name }, block, {
            difficulty: 'medium',
            // Different variant than the original quiz → different sentence.
            variant: n + 1,
            remediation: true,
          }),
        );
      }
    }
    return { questions };
  }

  /**
   * Deterministic, realistic concept-graph proposal. Edges are a pure
   * function of the ordered concept list; every evidence quote is copied
   * verbatim from a real workspace block, so local validation accepts them.
   */
  async proposeGraphEdges(
    input: GraphProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<GraphProposalPayload> {
    await this.gate(opts);
    const concepts = input.concepts;
    const blockById = new Map(input.blocks.map((b) => [b.id, b]));
    const edges: ProposedGraphEdge[] = [];

    const evidenceFor = (concept: Concept, variant = 0) => {
      const block = blockById.get(concept.grounding.blockId);
      const quote = block ? pickQuote(block, variant) : concept.grounding.quote;
      return [{ blockId: concept.grounding.blockId, quote }];
    };

    // 1. Reading-order prerequisite chain (acyclic by construction).
    for (let i = 0; i + 1 < concepts.length && edges.length < input.maxEdges; i++) {
      const source = concepts[i]!;
      const target = concepts[i + 1]!;
      edges.push({
        sourceConceptId: source.id,
        targetConceptId: target.id,
        relation: 'prerequisite',
        explanation: `按资料展开顺序,先理解「${source.name}」才能理解「${target.name}」。`,
        evidence: evidenceFor(target),
      });
    }

    // 2. Every third concept is treated as part of the opening topic.
    for (let i = 2; i < concepts.length && edges.length < input.maxEdges; i += 3) {
      const part = concepts[i]!;
      const whole = concepts[0]!;
      edges.push({
        sourceConceptId: part.id,
        targetConceptId: whole.id,
        relation: 'part_of',
        explanation: `「${part.name}」是「${whole.name}」主题下的组成部分。`,
        evidence: evidenceFor(part, 1),
      });
    }

    // 3. A contrast pair, a causal link, and an example link when available.
    if (concepts.length >= 3 && edges.length < input.maxEdges) {
      const [a, b] = [concepts[1]!, concepts[2]!];
      edges.push({
        sourceConceptId: a.id,
        targetConceptId: b.id,
        relation: 'contrasts_with',
        explanation: `资料分别描述了「${a.name}」与「${b.name}」,二者可对比理解。`,
        evidence: evidenceFor(a, 1),
      });
    }
    if (concepts.length >= 4 && edges.length < input.maxEdges) {
      const [cause, effect] = [concepts[0]!, concepts[3]!];
      edges.push({
        sourceConceptId: cause.id,
        targetConceptId: effect.id,
        relation: 'causes',
        explanation: `依据资料,「${cause.name}」会影响「${effect.name}」的效果。`,
        evidence: evidenceFor(effect, 1),
      });
    }
    if (concepts.length >= 5 && edges.length < input.maxEdges) {
      const [example, general] = [concepts[concepts.length - 1]!, concepts[1]!];
      edges.push({
        sourceConceptId: example.id,
        targetConceptId: general.id,
        relation: 'example_of',
        explanation: `「${example.name}」可视为「${general.name}」的一个具体应用示例。`,
        evidence: evidenceFor(example, 2),
      });
    }

    if (edges.length === 0 && concepts.length >= 2) {
      const [a, b] = [concepts[0]!, concepts[1]!];
      edges.push({
        sourceConceptId: a.id,
        targetConceptId: b.id,
        relation: 'applies_to',
        explanation: `「${a.name}」的内容可应用于「${b.name}」。`,
        evidence: evidenceFor(a),
      });
    }

    return { edges: edges.slice(0, Math.min(input.maxEdges, 60)) };
  }

  /**
   * Deterministic remediation-plan proposal built only from the bounded
   * planner input: weak prerequisites first, otherwise focused retrieval
   * practice on the selected concept.
   */
  async proposeRemediationPlan(
    input: RemediationPlanInput,
    opts?: ProviderCallOptions,
  ): Promise<RemediationPlanProposalPayload> {
    await this.gate(opts);
    const blockById = new Map(input.blocks.map((b) => [b.id, b]));
    const masteryByConcept = new Map(input.masteryStates.map((m) => [m.conceptId, m]));
    const openByConcept = new Map<string, number>();
    for (const mistake of input.openMistakes) {
      openByConcept.set(mistake.conceptId, (openByConcept.get(mistake.conceptId) ?? 0) + 1);
    }

    const evidenceFor = (concept: Concept) => {
      const block = blockById.get(concept.grounding.blockId);
      const quote = block ? pickQuote(block) : concept.grounding.quote;
      return [{ blockId: concept.grounding.blockId, quote }];
    };

    const weakPrereqs = input.prerequisites
      .filter((p) => {
        const mastery = masteryByConcept.get(p.id)?.mastery;
        return (openByConcept.get(p.id) ?? 0) > 0 || (mastery !== undefined && mastery < 0.7);
      })
      .slice(0, 2);

    const selectedOpen = openByConcept.get(input.selected.id) ?? 0;
    const selectedMastery = masteryByConcept.get(input.selected.id)?.mastery;

    const targets = [
      {
        conceptId: input.selected.id,
        reason:
          selectedOpen > 0
            ? `「${input.selected.name}」目前有 ${selectedOpen} 道未解决错题,需要针对性巩固。`
            : `「${input.selected.name}」的掌握度尚不稳定,建议围绕原文依据重新梳理。`,
        evidence: evidenceFor(input.selected),
      },
      ...weakPrereqs.map((prereq) => ({
        conceptId: prereq.id,
        reason: `前置概念「${prereq.name}」薄弱,可能是「${input.selected.name}」出错的根源。`,
        evidence: evidenceFor(prereq),
      })),
    ].slice(0, 4);

    const strategy =
      weakPrereqs.length > 0
        ? 'prerequisite_repair'
        : selectedOpen > 0
          ? 'retrieval_practice'
          : 'review';

    const difficulty =
      selectedMastery === undefined || selectedMastery < 0.4
        ? 'easy'
        : selectedMastery < 0.75
          ? 'medium'
          : 'hard';

    const preferredTypes: QuestionType[] = ['single_choice', 'short_answer'];
    const usedSupported = input.usedQuestionTypes.filter((t) => preferredTypes.includes(t));
    const questionTypes = usedSupported.length > 0 ? [...new Set(usedSupported)] : preferredTypes;

    const steps = [
      {
        description: `重读「${input.selected.name}」的原文依据,对照引文确认自己的理解。`,
        conceptId: input.selected.id,
      },
      ...weakPrereqs.map((prereq) => ({
        description: `先修复前置概念「${prereq.name}」:阅读其原文段落并完成针对练习。`,
        conceptId: prereq.id,
      })),
      {
        description: '完成本计划附带的检索练习并提交判分,系统将据此更新错题与掌握度。',
        conceptId: input.selected.id,
      },
    ].slice(0, 6);

    return {
      summary: `围绕「${input.selected.name}」的${
        weakPrereqs.length > 0 ? '前置修复' : '定向巩固'
      }计划:共 ${targets.length} 个目标概念、${steps.length} 个步骤。`,
      weaknessHypothesis:
        selectedOpen > 0
          ? `学习者在「${input.selected.name}」上反复出错(${selectedOpen} 道未解决错题),可能混淆了原文中的关键限定条件。`
          : `学习者对「${input.selected.name}」的掌握度证据不足,尚未形成稳定理解。`,
      strategy,
      difficulty,
      questionTypes,
      steps,
      targets,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic content helpers
// ---------------------------------------------------------------------------

function deriveName(content: string): string {
  const first = sentences(content)[0] ?? content;
  return first.replace(/[\s,。!?;:、,.!?;:]/gu, '').slice(0, 16);
}

function summarize(content: string): string {
  const parts = sentences(content);
  const summary = parts.slice(0, 2).join('');
  return (summary || content).slice(0, 200);
}

interface QuestionParams {
  difficulty: 'easy' | 'medium' | 'hard';
  variant: number;
  remediation?: boolean;
}

function buildQuestion(
  type: ProposedQuestion['type'],
  concept: { id: string; name: string },
  block: SourceBlock,
  params: QuestionParams,
): ProposedQuestion {
  const quote = pickQuote(block, params.variant);
  const prefix = params.remediation ? '(巩固练习)' : '';
  const base = {
    conceptId: concept.id,
    blockId: block.id,
    quote,
    explanation: `依据资料原文:「${quote}」`,
  };

  if (type === 'short_answer') {
    return {
      ...base,
      type: 'short_answer',
      stem: `${prefix}请根据资料,简述「${concept.name}」的要点。`,
      expectedAnswer: summarize(block.content),
      rubricKeyPoints: rubricFrom(block, concept.name),
    };
  }

  const seed = fnv1a32(`${block.id}:${concept.name}:${params.variant}:${params.difficulty}`);
  const secondTrue = pickQuote(block, params.variant + 1);
  const distractors = buildDistractors(concept.name, params.difficulty);

  if (type === 'multiple_choice') {
    const correctTexts = secondTrue !== quote ? [quote, secondTrue] : [quote];
    const optionTexts = [...correctTexts, ...distractors].slice(0, 5);
    const order = seededOrder(optionTexts.length, seed);
    const options = order.map((origIdx, pos) => ({
      id: LETTERS[pos]!,
      text: optionTexts[origIdx]!,
    }));
    const correctIds = order
      .map((origIdx, pos) => (origIdx < correctTexts.length ? LETTERS[pos]! : null))
      .filter((v): v is (typeof LETTERS)[number] => v !== null)
      .sort();
    return {
      ...base,
      type: 'multiple_choice',
      stem: `${prefix}关于「${concept.name}」,以下哪些说法与资料一致?(多选)`,
      options,
      correctOptionIds: correctIds,
    };
  }

  const optionTexts = [quote, ...distractors];
  const order = seededOrder(optionTexts.length, seed);
  const options = order.map((origIdx, pos) => ({
    id: LETTERS[pos]!,
    text: optionTexts[origIdx]!,
  }));
  const correctId = LETTERS[order.indexOf(0)]!;
  return {
    ...base,
    type: 'single_choice',
    stem: `${prefix}关于「${concept.name}」,以下哪项表述与资料一致?`,
    options,
    correctOptionIds: [correctId],
  };
}

function buildDistractors(conceptName: string, difficulty: 'easy' | 'medium' | 'hard'): string[] {
  const pool = [
    `资料指出,${conceptName}对学习效果没有影响`,
    `资料认为${conceptName}只适用于少数人`,
    `资料并未讨论${conceptName},它属于其他学科的内容`,
  ];
  return difficulty === 'easy' ? pool.slice(0, 2) : pool;
}

function rubricFrom(block: SourceBlock, conceptName: string): string[] {
  const points = sentences(block.content).slice(0, 3);
  if (points.length === 0) return [`能说明「${conceptName}」的核心含义`];
  return points.map((p) => p.slice(0, 80));
}

function keyPointCovered(answer: string, keyPoint: string): boolean {
  // Coverage heuristic: share of the key point's distinct meaningful
  // characters present in the answer. Deterministic; suits CJK text.
  const chars = Array.from(new Set(Array.from(keyPoint.replace(/[\s,。!?;:、,.!?;:]/gu, ''))));
  if (chars.length === 0) return false;
  const hit = chars.filter((c) => answer.includes(c)).length;
  return hit / chars.length >= 0.6;
}

function buildFeedback(matched: number[], keyPoints: string[]): string {
  if (keyPoints.length === 0) return '暂无评分要点。';
  if (matched.length === keyPoints.length) return '回答覆盖了全部要点,表述准确。';
  if (matched.length === 0) return `回答未覆盖关键要点。建议围绕:${keyPoints.join('、')}。`;
  const missed = keyPoints.filter((_, i) => !matched.includes(i));
  return `已覆盖部分要点,仍需补充:${missed.join('、')}。`;
}
