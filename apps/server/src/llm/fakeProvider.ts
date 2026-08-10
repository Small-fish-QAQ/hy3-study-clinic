import {
  clamp01,
  fnv1a32,
  normalizeConceptKey,
  type AlignmentProposalPayload,
  type AssessmentMode,
  type AssessmentProposalPayload,
  type Concept,
  type ConceptAnalysisPayload,
  type ConceptLessonPayload,
  type CurriculumProposalPayload,
  type GraphProposalPayload,
  type MisconceptionProposalPayload,
  type ProposedAlignment,
  type ProposedAssessmentItem,
  type ProposedConcept,
  type ProposedCurriculumNode,
  type ProposedGraphEdge,
  type ProposedQuestion,
  type ProposedRubricPoint,
  type ProposedStudyPlanItem,
  type QuestionType,
  type QuizGenerationPayload,
  type RemediationPlanProposalPayload,
  type RubricGrade,
  type SourceBlock,
  type StudyPlanProposalPayload,
  type TutorStepPayload,
} from '@hy3-clinic/shared';
import { ProviderError } from './errors.js';
import { alignPointToStem, charCoverageRatio } from '../grading/rubricAlignment.js';
import type {
  AlignmentProposalInput,
  AssessmentProposalInput,
  ConceptAnalysisInput,
  ConceptLessonInput,
  CurriculumProposalInput,
  GraphProposalInput,
  LlmProvider,
  MisconceptionProposalInput,
  ProviderCallOptions,
  QuizGenerationInput,
  RemediationInput,
  RemediationPlanInput,
  ShortAnswerGradingInput,
  StudyPlanProposalInput,
  TutorStepInput,
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
    const candidates: { name: string; block: SourceBlock }[] = [];

    for (const block of blocks) {
      const name = (block.heading ?? deriveName(block.content)).slice(0, 40);
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      candidates.push({ name, block });
    }

    // Representative document coverage: when there are more candidate
    // sections than the concept budget, sample them evenly across the WHOLE
    // input (deterministic stride) instead of only the leading pages. The
    // budget is an upper bound (size-aware, section extraction) — small
    // inputs legitimately yield fewer concepts, never padded duplicates.
    const budget = Math.min(8, input.maxConcepts ?? 8);
    let picked = candidates;
    if (candidates.length > budget && budget > 1) {
      const strided: typeof candidates = [];
      for (let i = 0; i < budget; i++) {
        const index = Math.round((i * (candidates.length - 1)) / (budget - 1));
        strided.push(candidates[index]!);
      }
      picked = [...new Map(strided.map((c) => [c.name, c])).values()];
    } else if (candidates.length > budget) {
      picked = candidates.slice(0, budget);
    }

    const concepts: ProposedConcept[] = picked.map((candidate, position) => ({
      name: candidate.name,
      summary: summarize(candidate.block.content),
      importance: position < 3 ? 'high' : position < 6 ? 'medium' : 'low',
      blockId: candidate.block.id,
      quote: pickQuote(candidate.block),
    }));

    if (concepts.length === 0 && input.maxConcepts === undefined) {
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
    const partial: number[] = [];
    input.rubricKeyPoints.forEach((point, i) => {
      const ratio = charCoverageRatio(point.text, answer);
      if (ratio >= 0.6) matched.push(i);
      else if (ratio >= 0.35) partial.push(i);
    });
    // Advisory score mirrors the server's deterministic rule: coverage of
    // REQUIRED points only; optional enrichment never reduces it.
    const required = input.rubricKeyPoints.filter((p) => p.required);
    const requiredFull = matched.filter((i) => input.rubricKeyPoints[i]!.required).length;
    const requiredPartial = partial.filter((i) => input.rubricKeyPoints[i]!.required).length;
    const score =
      required.length === 0 ? 0 : clamp01((requiredFull + 0.5 * requiredPartial) / required.length);
    // More confident at the extremes (clearly right / clearly wrong).
    const confidence = clamp01(0.6 + Math.abs(score - 0.5) * 0.6);

    return {
      matchedKeyPointIndexes: matched,
      partialKeyPointIndexes: partial,
      score,
      confidence,
      feedback: buildFeedback(matched, partial, input.rubricKeyPoints),
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

  /**
   * Deterministic alignment proposal: judges each locally-pruned candidate
   * pair by its normalized keys and languages. Bilingual pairs and malformed
   * concatenations become merge proposals; unrelated-looking pairs are
   * proposed as related_but_distinct. Evidence quotes are copied verbatim
   * from the concepts' own grounded blocks, so local validation accepts them.
   */
  async proposeConceptAlignment(
    input: AlignmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AlignmentProposalPayload> {
    await this.gate(opts);
    const blockById = new Map(input.blocks.map((b) => [b.id, b]));
    const proposals: ProposedAlignment[] = [];

    const evidenceOf = (concept: Concept) => {
      const block = blockById.get(concept.grounding.blockId);
      const quote = block ? pickQuote(block) : concept.grounding.quote;
      return { blockId: concept.grounding.blockId, quote };
    };

    for (const candidate of input.candidates.slice(0, 30)) {
      const { source, target } = candidate;
      const sourceKey = normalizeConceptKey(source.name);
      const targetKey = normalizeConceptKey(target.name);
      const crossLanguage =
        candidate.sourceLanguage !== candidate.targetLanguage &&
        candidate.sourceLanguage !== 'unknown' &&
        candidate.targetLanguage !== 'unknown';

      let relation: ProposedAlignment['relation'];
      let canonicalName: string;
      let rationale: string;

      if (sourceKey === targetKey) {
        relation = 'alias';
        canonicalName = cleanerName(source.name, target.name);
        rationale = `「${source.name}」与「${target.name}」规范化后完全一致,是同一概念的书写变体。`;
      } else if (sourceKey.includes(targetKey) || targetKey.includes(sourceKey)) {
        relation = 'equivalent';
        canonicalName = cleanerName(source.name, target.name);
        rationale = `「${source.name}」与「${target.name}」的名称高度重合,较短者疑似另一方的残缺拼写,应合并为同一概念。`;
      } else if (crossLanguage) {
        relation = 'equivalent';
        canonicalName = candidate.sourceLanguage === 'zh' ? source.name : target.name;
        rationale = `「${source.name}」与「${target.name}」是同一概念的中英文表述,资料中的描述互相对应。`;
      } else {
        relation = 'related_but_distinct';
        canonicalName = target.name;
        rationale = `「${source.name}」与「${target.name}」相关但含义不同,建议保留为两个概念。`;
      }

      proposals.push({
        sourceConceptId: source.id,
        targetConceptId: target.id,
        relation,
        canonicalName: canonicalName.slice(0, 80),
        rationale,
        evidence: [evidenceOf(source), evidenceOf(target)].slice(0, 2),
        sourceLanguage: candidate.sourceLanguage,
        targetLanguage: candidate.targetLanguage,
      });
    }
    return { proposals };
  }

  /**
   * Deterministic workspace-assessment proposal. Targets with aligned
   * siblings in other documents get a cross-document concept_comparison item
   * whose evidence spans both documents; other targets get grounded
   * single-document items. misconception_check mode produces one
   * discriminating single_choice whose distractor restates the hypothesis.
   */
  async proposeAssessment(
    input: AssessmentProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<AssessmentProposalPayload> {
    await this.gate(opts);
    const blockById = new Map(input.blocks.map((b) => [b.id, b]));
    const items: ProposedAssessmentItem[] = [];
    const blockOf = (concept: Concept): SourceBlock | undefined =>
      blockById.get(concept.grounding.blockId);

    if (input.mode === 'misconception_check' && input.misconception) {
      const target = input.targets[0];
      if (target) {
        const block = blockOf(target.concept) ?? input.blocks[0]!;
        const quote = pickQuote(block);
        const seed = fnv1a32(`${block.id}:mc:${input.misconception.id}`);
        const optionTexts = [quote, `资料认为:${input.misconception.hypothesis.slice(0, 160)}`];
        const order = seededOrder(optionTexts.length, seed);
        const options = order.map((origIdx, pos) => ({
          id: LETTERS[pos]!,
          text: optionTexts[origIdx]!,
        }));
        items.push({
          blueprint: {
            conceptIds: [target.concept.id],
            questionType: 'single_choice',
            difficulty: 'medium',
            learningObjective: `判别学习者是否存在「${target.concept.name}」的疑似误区。`,
            reasoningSteps: [
              { description: '对照原文判断哪种说法与资料一致。', evidenceIndexes: [0] },
            ],
          },
          question: {
            type: 'single_choice',
            stem: `关于「${target.concept.name}」,以下哪项说法与资料一致?(判别练习)`,
            options,
            correctOptionIds: [LETTERS[order.indexOf(0)]!],
            conceptId: target.concept.id,
            blockId: block.id,
            quote,
            explanation: `依据资料原文:「${quote}」`,
          },
          extraEvidence: [],
        });
      }
      return { items };
    }

    for (const target of input.targets) {
      if (items.length >= input.questionCount) break;
      const block = blockOf(target.concept);
      if (!block) continue;

      const sibling = target.alignedSiblings.find(
        (s) => s.concept.materialId !== target.concept.materialId && blockOf(s.concept),
      );

      if (
        sibling &&
        input.allowedTypes.includes('concept_comparison') &&
        (input.mode === 'cross_document' || input.mode === 'diagnostic' || input.mode === 'review')
      ) {
        const siblingBlock = blockOf(sibling.concept)!;
        const quoteA = pickQuote(block);
        const quoteB = pickQuote(siblingBlock);
        items.push({
          blueprint: {
            conceptIds: [target.concept.id, sibling.concept.id],
            questionType: 'concept_comparison',
            difficulty: 'medium',
            learningObjective: `综合《${target.documentTitle}》与《${sibling.documentTitle}》,贯通理解「${target.concept.name}」。`,
            reasoningSteps: [
              {
                description: `从《${target.documentTitle}》提取该概念的定义要点。`,
                evidenceIndexes: [0],
              },
              {
                description: `对照《${sibling.documentTitle}》的表述,归纳两处资料的共同点或差异。`,
                evidenceIndexes: [1],
              },
            ],
          },
          question: {
            type: 'concept_comparison',
            stem: `「${target.concept.name}」在《${target.documentTitle}》与《${sibling.documentTitle}》中均有描述。请结合两份资料,说明两处表述的共同要点,以及各自补充了什么信息。`,
            expectedAnswer: `${quoteA}${quoteB}`.slice(0, 900),
            rubricKeyPoints: [
              { text: quoteA.slice(0, 80), required: true },
              { text: quoteB.slice(0, 80), required: true },
            ],
            conceptId: target.concept.id,
            blockId: block.id,
            quote: quoteA,
            explanation: `两份资料分别指出:「${quoteA.slice(0, 100)}」与「${quoteB.slice(0, 100)}」。`,
          },
          extraEvidence: [{ blockId: siblingBlock.id, quote: quoteB }],
        });
        continue;
      }

      const type: QuestionType = input.allowedTypes.includes('single_choice')
        ? items.length % 2 === 0
          ? 'single_choice'
          : input.allowedTypes.includes('short_answer')
            ? 'short_answer'
            : 'single_choice'
        : (input.allowedTypes[0] ?? 'single_choice');
      const question = buildQuestion(
        type,
        { id: target.concept.id, name: target.concept.name },
        block,
        { difficulty: 'medium', variant: items.length },
      );
      items.push({
        blueprint: {
          conceptIds: [target.concept.id],
          questionType: type,
          difficulty: 'medium',
          learningObjective: `检验「${target.concept.name}」的原文理解。`,
          reasoningSteps: [{ description: '依据原文判断或复述概念要点。', evidenceIndexes: [0] }],
        },
        question,
        extraEvidence: [],
      });
    }
    return { items };
  }

  /**
   * Deterministic lesson card: teaches from the concept's own block. The
   * first explanation segment anchors the concept's verbatim source sentence
   * (verifies locally); every other segment is deliberately unanchored AI
   * teaching, so offline demos exercise BOTH provenance classes. Directives
   * vary the wording deterministically. No conflicts are fabricated.
   */
  async generateConceptLesson(
    input: ConceptLessonInput,
    opts?: ProviderCallOptions,
  ): Promise<ConceptLessonPayload> {
    await this.gate(opts);
    const concept = input.concept;
    const block = input.blocks.find((b) => b.id === concept.grounding.blockId) ?? input.blocks[0]!;
    const quote = pickQuote(block);
    const styled =
      input.directive === 'more_intuitive'
        ? '换一种更直观的说法:可以把它想象成日常生活中反复出现的场景,先抓住整体印象再看细节。'
        : input.directive === 'more_examples'
          ? '再看一个具体例子:先确定条件,再套用概念的定义,一步步检查结论是否成立。'
          : input.directive === 'deeper'
            ? '更进一步:从机制上看,它成立依赖于前提条件;当前提变化时,结论的适用范围也随之改变。'
            : `围绕「${concept.name}」,先记住课程给出的定义,再把它放进具体情境中理解。`;

    const neighborNote =
      input.neighbors.length > 0
        ? `在本课程的图谱中,它与「${input.neighbors[0]!.name}」等概念相关联,学习时可以对照理解。`
        : '它在本课程中相对独立,先单独吃透定义即可。';

    return {
      sections: [
        {
          kind: 'explanation',
          segments: [
            {
              text: `课程资料这样界定「${concept.name}」:${quote}`,
              anchor: { blockId: block.id, quote },
            },
            { text: `${concept.summary}${styled}` },
          ],
        },
        {
          kind: 'worked_example',
          segments: [
            {
              text: `一个练习思路:先用自己的话复述「${concept.name}」的定义,再找一个资料之外的场景检验这个定义是否仍然说得通。`,
            },
          ],
        },
        {
          kind: 'misconception_warning',
          segments: [
            {
              text: `常见误区:把「${concept.name}」当成孤立的名词去背,而不是回到它的适用条件。${neighborNote}`,
            },
          ],
        },
      ],
      conflicts: [],
    };
  }

  /**
   * Deterministic misconception proposal: a substantive wrong answer yields
   * a tentative hypothesis; a blank answer declines (no evidence of a
   * misunderstanding — just no answer).
   */
  async proposeMisconception(
    input: MisconceptionProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MisconceptionProposalPayload> {
    await this.gate(opts);
    const selected = input.learnerSelectedOptionIds
      .map((id) => input.options.find((o) => o.id === id)?.text)
      .filter((v): v is string => v !== undefined);
    const wroteText = (input.learnerText ?? '').trim().length > 0;

    if (selected.length === 0 && !wroteText) {
      return {
        applicable: false,
        category: 'unknown',
        hypothesis: '学习者未作答,暂无可判断的误区证据。',
        evidence: [],
      };
    }

    const picked = selected[0] ?? (input.learnerText ?? '').slice(0, 60);
    const category = selected.length > 0 ? 'definition_confusion' : 'undergeneralization';
    return {
      applicable: true,
      category,
      hypothesis:
        selected.length > 0
          ? `学习者可能把「${input.conceptName}」理解成了:${picked.slice(0, 120)}。与原文表述不符,需通过判别练习确认。`
          : `学习者对「${input.conceptName}」的表述遗漏了原文的关键限定,可能只掌握了部分含义,需判别确认。`,
      evidence: [{ blockId: input.blockId, quote: input.sourceQuote }],
    };
  }

  async proposeCurriculum(
    input: CurriculumProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumProposalPayload> {
    await this.gate(opts);
    const maxNodes = Math.min(input.limits.maxNodes, 1999);
    const maxObjectives = Math.min(input.limits.maxObjectives, 30_000);
    if (maxNodes < 3 || maxObjectives < 1) {
      throw ProviderError.invalidOutput(
        'Curriculum limits cannot represent one complete hierarchy',
      );
    }

    const manifestMaterialIds = new Set(
      input.executionSourceManifest.revisions.map((revision) => revision.materialId),
    );
    const manifestBlockIds = new Set(
      input.executionSourceManifest.revisions.flatMap(
        (revision) => revision.sourceBlockRevisionIds,
      ),
    );
    const scopedMaterials = input.contract.materials.filter(
      (material) =>
        material.disposition === 'included' && manifestMaterialIds.has(material.materialId),
    );
    const allowedBlocks = input.blocks.filter((block) => manifestBlockIds.has(block.id));
    const materialBudget = Math.min(
      scopedMaterials.length,
      maxObjectives,
      Math.max(0, Math.floor((maxNodes - 1) / 2)),
    );
    const materials = scopedMaterials.slice(0, materialBudget);
    if (materials.length === 0) {
      throw ProviderError.invalidOutput(
        'Curriculum proposal requires an included manifested Material',
      );
    }

    const nodes: ProposedCurriculumNode[] = [
      {
        key: 'chapter-course-materials',
        parentKey: null,
        kind: 'chapter',
        index: 0,
        title: input.workspaceName.slice(0, 300) || 'Course materials',
        structuralUnitIds: [],
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      },
    ];
    const unitByConceptId = new Map<string, ProposedCurriculumNode>();
    const learningUnits: ProposedCurriculumNode[] = [];
    let remainingUnitSlots = Math.min(maxObjectives, maxNodes - 1 - materials.length);

    for (const [materialIndex, material] of materials.entries()) {
      const sectionKey = `section-${materialIndex + 1}`;
      const materialOutline = input.outline
        .filter((item) => item.materialId === material.materialId)
        .sort(
          (a, b) =>
            a.index - b.index || (a.structuralUnitId ?? '').localeCompare(b.structuralUnitId ?? ''),
        );
      nodes.push({
        key: sectionKey,
        parentKey: 'chapter-course-materials',
        kind: 'section',
        index: materialIndex,
        title: material.title.slice(0, 300),
        structuralUnitIds: materialOutline
          .map((item) => item.structuralUnitId)
          .filter((id): id is string => id !== null)
          .slice(0, 500),
        sourceEvidence: [],
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [],
        prerequisiteUnitKeys: [],
        graphRelationIds: [],
      });

      const remainingMaterials = materials.length - materialIndex;
      const slotsForMaterial = Math.max(
        1,
        Math.floor(remainingUnitSlots / Math.max(1, remainingMaterials)),
      );
      const candidates = materialOutline.filter(
        (item) => item.kind !== 'document' && item.sourceBlockIds.length > 0,
      );
      const selected = (candidates.length > 0 ? candidates : materialOutline.slice(0, 1)).slice(
        0,
        slotsForMaterial,
      );
      const seeds =
        selected.length > 0
          ? selected
          : [
              {
                structuralUnitId: null,
                title: material.title,
                sourceBlockIds: allowedBlocks
                  .filter((block) => block.materialId === material.materialId)
                  .map((block) => block.id),
              },
            ];

      for (const [unitIndex, seed] of seeds.entries()) {
        if (remainingUnitSlots <= 0) break;
        const blockIds = new Set(seed.sourceBlockIds);
        const sourceBlock =
          allowedBlocks.find((block) => blockIds.has(block.id)) ??
          allowedBlocks.find((block) => block.materialId === material.materialId);
        const concepts = input.concepts
          .filter(
            (concept) =>
              concept.materialId === material.materialId &&
              (blockIds.size === 0 || blockIds.has(concept.grounding.blockId)),
          )
          .slice(0, 30);
        const unitNumber = learningUnits.length + 1;
        const unitKey = `unit-${unitNumber}`;
        const title = (seed.title || concepts[0]?.name || material.title).slice(0, 300);
        const evidence = sourceBlock
          ? [{ blockId: sourceBlock.id, quote: pickQuote(sourceBlock) }]
          : [];
        const unit: ProposedCurriculumNode = {
          key: unitKey,
          parentKey: sectionKey,
          kind: 'learning_unit',
          index: unitIndex,
          title,
          structuralUnitIds: materialOutline
            .filter(
              (item) =>
                seed.structuralUnitId !== null &&
                (item.structuralUnitId === seed.structuralUnitId ||
                  item.parentStructuralUnitId === seed.structuralUnitId),
            )
            .map((item) => item.structuralUnitId)
            .filter((id): id is string => id !== null)
            .slice(0, 500),
          sourceEvidence: evidence,
          conceptIds: concepts.map((concept) => concept.id),
          canonicalConceptIds: [],
          objectives: [
            {
              key: `objective-${unitNumber}`,
              title: `Understand ${title}`.slice(0, 300),
              description: `Explain and apply the central ideas in ${title}.`.slice(0, 1000),
              evidence,
            },
          ],
          prerequisiteUnitKeys: [],
          graphRelationIds: [],
        };
        for (const concept of concepts) unitByConceptId.set(concept.id, unit);
        learningUnits.push(unit);
        nodes.push(unit);
        remainingUnitSlots -= 1;
      }
    }

    for (const edge of input.graphEdges) {
      if (edge.relation !== 'prerequisite') continue;
      const prerequisite = unitByConceptId.get(edge.sourceConceptId);
      const dependent = unitByConceptId.get(edge.targetConceptId);
      if (!prerequisite || !dependent || prerequisite.key === dependent.key) continue;
      if (!dependent.prerequisiteUnitKeys.includes(prerequisite.key)) {
        dependent.prerequisiteUnitKeys.push(prerequisite.key);
      }
      if (!dependent.graphRelationIds.includes(edge.id)) dependent.graphRelationIds.push(edge.id);
    }

    return {
      nodes,
      synthesisGroups:
        learningUnits.length >= 2 && input.limits.maxSynthesisGroups > 0
          ? [
              {
                key: 'synthesis-course-1',
                title: 'Connect the course foundations',
                level: 'course',
                learningUnitKeys: learningUnits.map((unit) => unit.key).slice(0, 50),
                objectiveKeys: learningUnits
                  .flatMap((unit) => unit.objectives.map((objective) => objective.key))
                  .slice(0, 100),
              },
            ]
          : [],
    };
  }

  async proposeStudyPlan(
    input: StudyPlanProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<StudyPlanProposalPayload> {
    await this.gate(opts);
    const unitById = new Map(input.units.map((unit) => [unit.id, unit]));
    const requiredIds = [...new Set(input.requiredLearningUnitIds)].filter((id) =>
      unitById.has(id),
    );
    const required = new Set(requiredIds);
    const orderedIds: string[] = [];
    const pending = new Set(requiredIds);
    while (pending.size > 0) {
      const ready = requiredIds.filter((id) => {
        if (!pending.has(id)) return false;
        const unit = unitById.get(id)!;
        return unit.prerequisiteUnitIds.every(
          (prerequisiteId) => !required.has(prerequisiteId) || !pending.has(prerequisiteId),
        );
      });
      const selected = ready[0] ?? requiredIds.find((id) => pending.has(id));
      if (!selected) break;
      pending.delete(selected);
      orderedIds.push(selected);
    }

    const allowedDepth = input.allowedDepths.includes(input.contract.desiredDepth)
      ? input.contract.desiredDepth
      : input.allowedDepths[0];
    if (!allowedDepth) throw ProviderError.invalidOutput('StudyPlan requires an allowed depth');

    const items: ProposedStudyPlanItem[] = [];
    const deferrals: StudyPlanProposalPayload['deferrals'] = [];
    const routeGateByUnitId = new Map<string, string>();
    for (const unitId of orderedIds) {
      const unit = unitById.get(unitId)!;
      const capability = input.launchCapabilities.find(
        (candidate) => candidate.curriculumLearningUnitId === unitId,
      );
      const allowedKinds = (capability?.allowedItemKinds ?? []).filter((kind) =>
        input.allowedItemKinds.includes(kind),
      );
      const primaryKind = allowedKinds.includes('teach_unit')
        ? 'teach_unit'
        : allowedKinds.includes('informal_check')
          ? 'informal_check'
          : allowedKinds.includes('formal_checkpoint') &&
              (capability?.launchableAssessmentModes.length ?? 0) > 0
            ? 'formal_checkpoint'
            : null;
      if (!primaryKind) {
        if (input.contract.allowExplicitDeferral) {
          deferrals.push({
            curriculumLearningUnitId: unitId,
            objectiveIds: unit.objectiveIds,
            reason: 'No currently launchable route item is available.',
          });
          continue;
        }
        throw ProviderError.invalidOutput(`No launchable StudyPlan item for ${unitId}`);
      }

      const itemKey = `item-${items.length + 1}`;
      const prerequisiteItemKeys = unit.prerequisiteUnitIds
        .map((prerequisiteId) => routeGateByUnitId.get(prerequisiteId))
        .filter((key): key is string => Boolean(key));
      items.push({
        key: itemKey,
        phase: 'Core route',
        kind: primaryKind,
        curriculumLearningUnitId: unit.id,
        rationale: `Advance the accepted objective set for ${unit.title}.`,
        estimatedMinutes: primaryKind === 'teach_unit' ? 25 : 10,
        targetDepth: allowedDepth,
        objectiveIds: unit.objectiveIds,
        prerequisiteItemKeys,
      });
      routeGateByUnitId.set(unit.id, itemKey);

      if (
        primaryKind !== 'formal_checkpoint' &&
        allowedKinds.includes('formal_checkpoint') &&
        (capability?.launchableAssessmentModes.length ?? 0) > 0 &&
        unit.blockingEligibleObjectiveIds.length > 0
      ) {
        const checkpointKey = `item-${items.length + 1}`;
        items.push({
          key: checkpointKey,
          phase: 'Core route',
          kind: 'formal_checkpoint',
          curriculumLearningUnitId: unit.id,
          rationale: `Formally check eligible objectives for ${unit.title}.`,
          estimatedMinutes: 10,
          targetDepth: allowedDepth,
          objectiveIds: unit.blockingEligibleObjectiveIds,
          prerequisiteItemKeys: [itemKey],
        });
        routeGateByUnitId.set(unit.id, checkpointKey);
      }
    }

    if (items.length === 0) {
      throw ProviderError.invalidOutput('StudyPlan proposal requires at least one executable item');
    }
    return {
      rationale: 'Follow prerequisites first, then teach and formally check eligible objectives.',
      items,
      deferrals,
    };
  }

  /**
   * Deterministic bounded Tutor policy: inspect state → inspect the graph
   * neighborhood → look at mistakes or the review queue → retrieve evidence
   * → finalize a plan with a recommended activity. Pure function of the
   * observation count and the compact state summary.
   */
  async proposeTutorStep(
    input: TutorStepInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorStepPayload> {
    await this.gate(opts);
    const step = input.observations.length;
    const conceptId = input.selected.id;

    if (step === 0 && input.remainingToolCalls > 0) {
      return {
        action: 'call_tool',
        tool: 'inspect_learning_state',
        arguments: { conceptId },
        purpose: `查看「${input.selected.name}」当前的掌握度、错题与复习状态。`,
      };
    }
    if (step === 1 && input.remainingToolCalls > 0) {
      return {
        action: 'call_tool',
        tool: 'get_graph_neighborhood',
        arguments: { conceptId },
        purpose: '检查图谱邻域,寻找薄弱的前置概念。',
      };
    }
    if (step === 2 && input.remainingToolCalls > 0) {
      if (input.stateSummary.openMistakes > 0) {
        return {
          action: 'call_tool',
          tool: 'inspect_open_mistakes',
          arguments: { conceptId },
          purpose: '查看未解决错题,定位反复出错的点。',
        };
      }
      if (
        input.stateSummary.proposedMisconceptions + input.stateSummary.confirmedMisconceptions >
        0
      ) {
        return {
          action: 'call_tool',
          tool: 'inspect_misconceptions',
          arguments: { conceptId },
          purpose: '查看该概念的误区假设及其状态。',
        };
      }
      return {
        action: 'call_tool',
        tool: 'inspect_review_queue',
        arguments: {},
        purpose: '查看复习队列,判断遗忘风险。',
      };
    }
    if (step === 3 && input.remainingToolCalls > 0) {
      return {
        action: 'call_tool',
        tool: 'search_source_blocks',
        arguments: { query: input.selected.name.slice(0, 40), limit: 5 },
        purpose: `检索与「${input.selected.name}」相关的多文档原文依据。`,
      };
    }

    const strategy = input.stateSummary.openMistakes > 0 ? 'retrieval_practice' : 'review';
    // Deterministic policy over the modes the resolver marked launchable:
    // misconception repair first, then mistake practice, then the richest
    // remaining launchable mode. Falls back to concept_practice (always
    // launchable while the selected concept exists).
    const launchable = new Set(input.launchableModes.map((m) => m.mode));
    const boundMisconception = input.actionableMisconceptions[0];
    let activityMode: AssessmentMode = 'concept_practice';
    if (launchable.has('misconception_check') && boundMisconception) {
      activityMode = 'misconception_check';
    } else if (input.stateSummary.openMistakes > 0 && launchable.has('concept_practice')) {
      activityMode = 'concept_practice';
    } else {
      const preference: AssessmentMode[] = [
        'cross_document',
        'review',
        'prerequisite_repair',
        'concept_practice',
        'diagnostic',
      ];
      activityMode = preference.find((mode) => launchable.has(mode)) ?? 'concept_practice';
    }
    return {
      action: 'finalize',
      plan: {
        summary: `围绕「${input.selected.name}」的定向学习计划:先复核原文依据,再完成针对练习。`,
        weaknessHypothesis:
          input.stateSummary.openMistakes > 0
            ? `「${input.selected.name}」存在 ${input.stateSummary.openMistakes} 道未解决错题,可能混淆了原文中的关键限定条件。`
            : `「${input.selected.name}」的掌握证据不足或临近遗忘,需要一次检索式巩固。`,
        strategy,
        difficulty: (input.stateSummary.mastery ?? 0.5) < 0.4 ? 'easy' : 'medium',
        questionTypes: ['single_choice', 'short_answer'],
        steps: [
          {
            description: `重读「${input.selected.name}」的原文段落,对照引文确认理解。`,
            conceptId,
          },
          { description: '完成推荐的练习活动并提交判分。', conceptId },
        ],
        targets: [
          {
            conceptId,
            reason:
              input.stateSummary.openMistakes > 0
                ? `「${input.selected.name}」有未解决错题,需要针对性巩固。`
                : `「${input.selected.name}」的长期记忆状态需要一次主动检索来巩固。`,
            evidence: [
              { blockId: input.selected.grounding.blockId, quote: input.selected.grounding.quote },
            ],
          },
        ],
      },
      activity: {
        mode: activityMode,
        conceptIds: [conceptId],
        ...(activityMode === 'misconception_check' && boundMisconception
          ? { misconceptionId: boundMisconception.id }
          : {}),
      },
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

/**
 * Deterministically pick the better display name of a pair: Chinese beats
 * Latin (product language), a spaced multi-word name beats a concatenated
 * one, then the shorter name wins (ties break lexicographically).
 */
function cleanerName(a: string, b: string): string {
  const aCjk = /[一-鿿]/u.test(a);
  const bCjk = /[一-鿿]/u.test(b);
  if (aCjk !== bCjk) return aCjk ? a : b;
  const aSpaced = a.includes(' ');
  const bSpaced = b.includes(' ');
  if (aSpaced !== bSpaced) return aSpaced ? a : b;
  if (a.length !== b.length) return a.length < b.length ? a : b;
  return a < b ? a : b;
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
    const stem = `${prefix}请根据资料,简述「${concept.name}」的要点。`;
    return {
      ...base,
      type: 'short_answer',
      stem,
      expectedAnswer: summarize(block.content),
      rubricKeyPoints: rubricFrom(block, concept.name, stem),
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

function rubricFrom(block: SourceBlock, conceptName: string, stem: string): ProposedRubricPoint[] {
  const points = sentences(block.content).slice(0, 3);
  if (points.length === 0) return [{ text: `能说明「${conceptName}」的核心含义`, required: true }];
  // Question-aligned classification: evaluative sentences (advantages,
  // drawbacks, comparisons) are only required when the stem requests them.
  return points.map((p) => {
    const text = p.slice(0, 80);
    return { text, required: alignPointToStem(stem, { text, required: true }) };
  });
}

function buildFeedback(
  matched: number[],
  partial: number[],
  keyPoints: ProposedRubricPoint[],
): string {
  if (keyPoints.length === 0) return '暂无评分要点。';
  const covered = new Set([...matched, ...partial]);
  const requiredMissing = keyPoints
    .filter((p, i) => p.required && !covered.has(i))
    .map((p) => p.text);
  const requiredPartial = partial
    .filter((i) => keyPoints[i]!.required)
    .map((i) => keyPoints[i]!.text);
  const optionalMissing = keyPoints
    .filter((p, i) => !p.required && !covered.has(i))
    .map((p) => p.text);

  const parts: string[] = [];
  if (requiredMissing.length === 0 && requiredPartial.length === 0) {
    parts.push('回答覆盖了题目要求的全部要点,表述准确。');
  } else if (
    requiredPartial.length === 0 &&
    keyPoints.every((p, i) => !p.required || !covered.has(i))
  ) {
    parts.push(`回答未覆盖题目要求的关键要点。建议围绕:${requiredMissing.join('、')}。`);
  } else {
    if (requiredMissing.length > 0) parts.push(`仍需补充:${requiredMissing.join('、')}。`);
    if (requiredPartial.length > 0)
      parts.push(`以下要点只覆盖了一部分:${requiredPartial.join('、')}。`);
  }
  if (optionalMissing.length > 0) {
    parts.push(`可补充(不影响得分):${optionalMissing.join('、')}。`);
  }
  return parts.join('');
}
