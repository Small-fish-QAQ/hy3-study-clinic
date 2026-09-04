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
  type CourseMapProposalPayload,
  type CurriculumDetailProposalPayload,
  type CurriculumProposalPayload,
  type FormalAssessmentConstruct,
  type GraphProposalPayload,
  type MasteryChallengeProposalPayload,
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
  TeachingBriefProposalPayloadSchema,
  VisualDescriptionPayloadSchema,
  type TeachingBriefProposalPayload,
  LessonSlotContentProposalPayloadSchema,
  PracticeContentProposalPayloadSchema,
  ObjectiveAuthoritySemanticEvaluationProposalSchema,
  ObjectiveAuthoritySemanticRepairProposalSchema,
  type LessonSlotContentProposalPayload,
  type PracticeContentProposalPayload,
  type TutorStepPayload,
  type TutorTurnPayload,
  type TutorPedagogicalMove,
  type VisualDescriptionPayload,
  type RepairGenerationPayload,
  type ObjectiveAuthoritySemanticEvaluationProposal,
  type ObjectiveAuthoritySemanticRepairProposal,
  type ObjectiveAuthoritySemanticEvaluationInput,
  type ObjectiveAuthoritySemanticRepairInput,
  type ObjectiveAuthoritySupportType,
} from '@hy3-clinic/shared';
import { ProviderError } from './errors.js';
import { alignPointToStem, charCoverageRatio } from '../grading/rubricAlignment.js';
import type {
  AlignmentProposalInput,
  AssessmentProposalInput,
  ConceptAnalysisInput,
  ConceptLessonInput,
  CourseMapProposalInput,
  CurriculumDetailProposalInput,
  CurriculumOutlineItem,
  CurriculumProposalInput,
  GraphProposalInput,
  MasteryChallengeProposalInput,
  LlmProvider,
  MisconceptionProposalInput,
  ProviderCallOptions,
  QuizGenerationInput,
  RemediationInput,
  RemediationPlanInput,
  ShortAnswerGradingInput,
  StudyPlanProposalInput,
  TeachingBriefGenerationInput,
  LessonSlotContentGenerationInput,
  PracticeContentGenerationInput,
  TutorStepInput,
  TutorTurnInput,
  VisualDescriptionInput,
  RepairGenerationInput,
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

function normalizedFocusKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Offline-only deterministic stand-in for Hy3's semantic topic mapping. It can
 * select only text already offered for this exact source region, so an
 * unrelated or teaching-style request cannot invent a focused unit.
 */
function fakeCourseMapRegionFocus(
  focusRequest: string | null | undefined,
  region: CourseMapProposalInput['sourceRegions'][number],
): 'normal' | 'focused' {
  if (!focusRequest?.trim()) return 'normal';
  const requestKey = normalizedFocusKey(focusRequest);
  if (!requestKey) return 'normal';
  const pureTeachingStyleRequest =
    /^(?:giveme)?(?:lotsof|more)?examples?$|^(?:makeit)?(?:easy|easier|simple|simpler)$/iu.test(
      requestKey,
    ) || /^(?:多给|给我)?(?:一些|很多|更多)?例子$/u.test(requestKey);
  if (
    pureTeachingStyleRequest ||
    /(?:^|\D)(?:90|100)(?:分|points?|score)(?:$|\D)/iu.test(focusRequest)
  ) {
    return 'normal';
  }
  const candidates = [
    region.title,
    ...region.anchorOptions.flatMap((option) => [
      option.conceptName,
      option.canonicalConceptName ?? '',
    ]),
  ]
    .map(normalizedFocusKey)
    .filter((candidate) => candidate.length >= 2);
  return candidates.some(
    (candidate) =>
      requestKey.includes(candidate) || (requestKey.length >= 3 && candidate.includes(requestKey)),
  )
    ? 'focused'
    : 'normal';
}

/**
 * Parser-derived outline rows may split one headed topic into many
 * SourceBlocks. Explicit structural identities stay separate. Anonymous rows
 * coalesce only within the same revision and exact parser heading path;
 * headingless rows remain independent because no authoritative shared region
 * exists for them.
 */
function groupCurriculumOutline(items: CurriculumOutlineItem[]): CurriculumOutlineItem[][] {
  const groups: CurriculumOutlineItem[][] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const previousItem = previous?.at(-1);
    const sameHeadingPath =
      previousItem !== undefined &&
      previousItem.headingPath.length > 0 &&
      previousItem.headingPath.length === item.headingPath.length &&
      previousItem.headingPath.every((heading, index) => heading === item.headingPath[index]);
    const sameAnonymousTopic =
      previousItem !== undefined &&
      previousItem.structuralUnitId === null &&
      item.structuralUnitId === null &&
      previousItem.materialRevisionId === item.materialRevisionId &&
      previousItem.parentStructuralUnitId === item.parentStructuralUnitId &&
      previousItem.kind === item.kind &&
      sameHeadingPath &&
      (previousItem.title ?? '').trim().replace(/\s+/g, ' ') ===
        (item.title ?? '').trim().replace(/\s+/g, ' ');
    if (sameAnonymousTopic) previous!.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** Split text into sentence-like spans on Chinese/ASCII terminators. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。!?;!?;])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/** Keep Fake semantic-relation propositions distinct and verbatim-source compatible. */
function relationPropositions(text: string): [string, string] {
  const normalized = text.trim();
  const clauses = normalized
    .split(
      /(?:[.!?;。！？；]+|,\s*(?:and|but|so|then|while|whereas)\s+|，\s*(?:(?:而|但|并且?|所以|因此|然后)\s*)?|\s*(?:→|->)\s*)/iu,
    )
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 8);
  if (clauses.length >= 2) return [clauses[0]!, clauses.slice(1).join(' ')];

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length >= 4) {
    const windowSize = Math.max(2, Math.ceil(words.length * 0.6));
    return [words.slice(0, windowSize).join(' '), words.slice(-windowSize).join(' ')];
  }

  const characters = [...normalized];
  const windowSize = Math.max(2, Math.ceil(characters.length * 0.6));
  return [characters.slice(0, windowSize).join(''), characters.slice(-windowSize).join('')];
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

function normalizedFakeSemanticFixtureText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

function containsAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

/**
 * Exact offline simulation for the persisted B7C2 counterexample. This is
 * provider-side Fake behavior only; deterministic product validators never
 * infer entailment from these words. REAL_HY3 remains the semantic judge.
 */
function isB7C2IntegratedPositioningProposition(text: string): boolean {
  const normalized = normalizedFakeSemanticFixtureText(text);
  return (
    normalized.includes('weknora') &&
    containsAny(normalized, ['综合系统', '集成系统', '于一体', 'integrat']) &&
    containsAny(normalized, ['文档', 'document']) &&
    containsAny(normalized, ['搜索', 'search']) &&
    containsAny(normalized, ['大模型', 'llm', 'language model']) &&
    containsAny(normalized, ['权限', 'permission']) &&
    containsAny(normalized, ['工具调用', 'tool call', 'tool-call'])
  );
}

function isB7C2IntegratedPositioningEvidence(text: string): boolean {
  const normalized = normalizedFakeSemanticFixtureText(text);
  return (
    normalized.includes('weknora') &&
    containsAny(normalized, ['不是单纯', '而非单纯', 'not merely', 'not simply']) &&
    containsAny(normalized, ['文档', 'document']) &&
    containsAny(normalized, ['搜索', 'search']) &&
    containsAny(normalized, ['大模型', 'llm', 'language model']) &&
    containsAny(normalized, ['权限', 'permission']) &&
    containsAny(normalized, ['工具调用', 'tool call', 'tool-call'])
  );
}

const FAKE_EXACT_IDENTIFY_DESCRIPTION_PREFIX = 'Identify this exact source statement: ';

function isExactFakeIdentifyFixture(
  proposition: string,
  construct: string,
  evidence: string,
): boolean {
  if (construct !== 'identify') return false;
  const normalizedEvidence = normalizedFakeSemanticFixtureText(evidence);
  const propositionLines = proposition
    .split('\n')
    .map((line) => normalizedFakeSemanticFixtureText(line))
    .filter(Boolean);
  if (
    propositionLines.length > 0 &&
    propositionLines.every((line) => normalizedEvidence.includes(line))
  ) {
    return true;
  }
  if (propositionLines.length !== 2 || !propositionLines[0]!.startsWith('understand ')) {
    return false;
  }
  const titleStatement = propositionLines[0]!.slice('understand '.length).trim();
  const normalizedDescriptionPrefix = normalizedFakeSemanticFixtureText(
    FAKE_EXACT_IDENTIFY_DESCRIPTION_PREFIX,
  );
  if (!propositionLines[1]!.startsWith(normalizedDescriptionPrefix)) return false;
  const descriptionStatement = propositionLines[1]!
    .slice(normalizedDescriptionPrefix.length)
    .trim();
  return (
    titleStatement.length > 0 &&
    titleStatement === descriptionStatement &&
    normalizedEvidence.includes(titleStatement)
  );
}

function fakeFixtureEvidenceSupportsProposition(
  proposition: string,
  construct: string,
  evidence: string,
): boolean {
  return (
    isExactFakeIdentifyFixture(proposition, construct, evidence) ||
    (construct === 'explain' &&
      isB7C2IntegratedPositioningProposition(proposition) &&
      isB7C2IntegratedPositioningEvidence(evidence))
  );
}

function fakeSemanticEvidenceSupportRank(input: {
  proposition: string;
  construct: string;
  evidence: string;
}): number | null {
  if (input.evidence.includes('[UNSUPPORTED]')) return null;
  if (input.evidence.includes(`[SUPPORTS:${input.construct}]`)) return 0;
  if (fakeFixtureEvidenceSupportsProposition(input.proposition, input.construct, input.evidence)) {
    return 1;
  }
  return null;
}

function fakeVisibleEvidenceStatement(text: string, fallback: string): string {
  const visible = text
    .replace(/\[(?:SUPPORTS:[^\]]+|UNSUPPORTED)\]\s*/gu, '')
    .replace(/\s+/gu, ' ')
    .split(/(?<=[.!?。！？；;])\s*/u)[0]
    ?.trim();
  return (visible || fallback).slice(0, 240);
}

function fakeExactIdentifyObjective(text: string, fallback: string) {
  const statement = fakeVisibleEvidenceStatement(text, fallback);
  return {
    construct: 'identify' as const,
    title: `Understand ${statement}`.slice(0, 300),
    description: `${FAKE_EXACT_IDENTIFY_DESCRIPTION_PREFIX}${statement}`.slice(0, 1_000),
  };
}

/**
 * Determine whether every requirement from startIndex can still occupy one
 * bounded slot. Previous assignments are represented by reduced capacities.
 */
function hasResidualPlacement(
  candidateKeysByRequirement: readonly (readonly string[])[],
  startIndex: number,
  remainingCapacityByKey: ReadonlyMap<string, number>,
): boolean {
  const slotOwner = new Map<string, number>();
  const assign = (requirementIndex: number, visitedSlots: Set<string>): boolean => {
    for (const key of candidateKeysByRequirement[requirementIndex] ?? []) {
      const capacity = remainingCapacityByKey.get(key) ?? 0;
      for (let slotIndex = 0; slotIndex < capacity; slotIndex += 1) {
        const slot = `${key}\u0000${slotIndex}`;
        if (visitedSlots.has(slot)) continue;
        visitedSlots.add(slot);
        const owner = slotOwner.get(slot);
        if (owner === undefined || assign(owner, visitedSlots)) {
          slotOwner.set(slot, requirementIndex);
          return true;
        }
      }
    }
    return false;
  };
  for (let index = startIndex; index < candidateKeysByRequirement.length; index += 1) {
    if (!assign(index, new Set())) return false;
  }
  return true;
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
  /** Optional Tutor-only fault fixture used by offline contract tests. */
  tutorTurnFixture?: FakeTutorTurnFixture;
  /** Visual-only deterministic output/fault fixture. */
  visualDescriptionFixture?: FakeVisualDescriptionFixture;
  /** Repair-only semantic fault fixture for bounded-provider tests. */
  repairFixture?: FakeRepairFixture;
  /** Mastery Red Team semantic/schema fault fixture. */
  masteryRedTeamFixture?: FakeMasteryRedTeamFixture;
  /**
   * Force every proposed Curriculum objective to claim this construct.
   *
   * Exists so offline tests can drive the ORDINARY Formal lane with a construct
   * the deterministic policy cannot support - `design`/`evaluate` - and observe
   * the production refusal rather than a FakeProvider that only ever emits
   * happy-path constructs. Opt-in only; unset, the provider is unchanged.
   */
  curriculumObjectiveConstructFixture?: FormalAssessmentConstruct;
}

/** Distinct opening move per intervention mode, so a strategy change is visible. */
const REPAIR_STRATEGY_OPENERS: Record<string, string> = {
  TARGETED_PROMPT: '只补齐缺失的那一部分',
  CONTRAST: '把错误关系与资料中的正确关系并列对比',
  SCAFFOLD: '拆成可执行的步骤逐步完成',
  PREREQUISITE_REVIEW: '先复习前置概念再回到本题',
  RETEACH_RETRIEVAL: '重新讲一遍核心概念，然后回忆复述',
  NOTICE: '先指出表面问题',
  CLARIFY: '澄清这次回答中不确定的地方',
};

/**
 * Re-ask phrasings for an intent the local ladder has legally reused after
 * exhausting its alternatives. Indexed by how many times this learner has
 * already been asked this same intent, so a later round asks the same broad
 * thing a materially different way instead of replaying the earlier sentence.
 *
 * Index 0 is unused: on first use the base task below is returned verbatim, so
 * first-round output is unchanged. A real provider gets `priorCheckPrompts` and
 * an instruction not to replay them; this is the offline equivalent.
 */
const REPAIR_CHECK_REASK_TASKS: readonly string[] = [
  '',
  '这次请自己举一个具体情形，用它把同一个判断重新做一遍，并写出中间的推理步骤',
  '这次请先写下你使用的判断标准，再用这个标准去检验一个你认为最难判断的情形',
  '这次请把同一个判断改写成一段可以直接教给同学的说明，并标出最容易出错的地方',
];

/**
 * Upper bound on the rubric fragment appended to a fake check. The fragment is
 * shared by every check for one criterion, so an unbounded one dominates n-gram
 * overlap and can push two genuinely different task sentences over the
 * repetition fence. Bounding it here keeps the fixture honest; the production
 * overlap validation is unchanged.
 */
const FAKE_CHECK_CRITERION_CHARS = 32;

/** Distinct check task per assessment intent, so an intent change is visible. */
const REPAIR_CHECK_TASKS: Record<string, string> = {
  discriminative_follow_up: '请说明这个概念与最接近的相邻概念之间的判别依据',
  boundary_conditions: '请给出这个结论成立与不成立的边界条件',
  counterexample: '请举出一个反例并说明它为何是反例',
  near_neighbor_confusion: '请区分这两个容易混淆的相邻概念，并说明区分依据',
  error_diagnosis: '请找出下面这段处理中的错误步骤并说明为什么错',
  historical_misconception: '请指出这个常见误解错在哪里，并给出正确表述',
  representation_shift: '请换一种表示方式重新表达这个关系',
  transfer: '请把这个原理应用到一个新的情境中',
  hidden_premise_change: '请说明前提改变后结论会如何变化',
  plausible_alternative_refutation: '请反驳一个看起来合理但错误的替代解释',
  cross_learning_unit_synthesis: '请把这个概念与另一个学习单元的概念联系起来',
  adversarial_distractor: '请说明为什么最具吸引力的错误选项是错的',
};

/**
 * Repair faults. `wrong_mode_*` returns a mode the local contract did not ask
 * for; `repeated_*` returns output that is well-formed but repeats what the
 * learner already saw for this same mistake.
 */
export type FakeRepairFixture =
  | 'repair_once'
  | 'repair_exhausted'
  | 'wrong_mode_once'
  | 'wrong_mode_exhausted'
  | 'repeated_strategy_once'
  | 'repeated_strategy_exhausted'
  | 'repeated_intent_once'
  | 'repeated_intent_exhausted'
  | 'repeated_prompt_once'
  | 'repeated_prompt_exhausted';

export type FakeVisualDescriptionFixture =
  | 'photo'
  | 'diagram'
  | 'text_heavy'
  | 'chart'
  | 'embedded'
  | 'no_text'
  | 'uncertainty'
  | 'malformed_json'
  | 'invalid_schema'
  | 'too_long'
  | 'semantic_invalid'
  | 'repair_once'
  | 'repair_exhausted';

export type FakeTutorTurnFixture =
  | 'invalid_source_ref'
  | 'unsupported_move'
  | 'malformed_json'
  | 'semantic_invalid'
  | 'repair_once'
  | 'repair_exhausted';

export type FakeMasteryRedTeamFixture =
  | 'schema_failure'
  | 'candidate_repair_once'
  | 'candidate_repair_failure'
  | 'duplicate_candidates'
  | 'unsupported_source'
  | 'unfair_unanswerable'
  | 'trivial_candidate';

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  readonly endpointIdentity: string = 'local:fake';
  readonly runtimeIdentity: string = 'fake-provider-v1';
  readonly promptIdentity: string = 'fake-visual-description-v1';

  async testConnection(opts?: ProviderCallOptions): Promise<void> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
  }
  private readonly delayMs: number;
  private readonly tutorTurnFixture: FakeTutorTurnFixture | null;
  private readonly visualDescriptionFixture: FakeVisualDescriptionFixture | null;
  private readonly repairFixture: FakeRepairFixture | null;
  private tutorTurnFixtureCalls = 0;
  private readonly masteryRedTeamFixture: FakeMasteryRedTeamFixture | null;
  private masteryRedTeamCalls = 0;
  private readonly curriculumObjectiveConstructFixture: FormalAssessmentConstruct | null;

  constructor(options: FakeProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.tutorTurnFixture = options.tutorTurnFixture ?? null;
    this.visualDescriptionFixture = options.visualDescriptionFixture ?? null;
    this.repairFixture = options.repairFixture ?? null;
    this.masteryRedTeamFixture = options.masteryRedTeamFixture ?? null;
    this.curriculumObjectiveConstructFixture = options.curriculumObjectiveConstructFixture ?? null;
  }

  async describeVisual(
    input: VisualDescriptionInput,
    opts?: ProviderCallOptions,
  ): Promise<VisualDescriptionPayload> {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          opts?.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (outcome: 'delay' | 'timeout' | 'cancelled') => {
          if (settled) return;
          settled = true;
          clearTimeout(delay);
          cleanup();
          if (outcome === 'delay') resolve();
          else if (outcome === 'timeout') reject(ProviderError.timeout(opts!.timeoutMs!));
          else reject(ProviderError.cancelled());
        };
        const delay = setTimeout(() => finish('delay'), this.delayMs);
        const timeout =
          opts?.timeoutMs !== undefined
            ? setTimeout(() => finish('timeout'), opts.timeoutMs)
            : null;
        const onAbort = () => finish('cancelled');
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    const fixture = this.visualDescriptionFixture;
    const visualType =
      fixture === 'photo'
        ? 'photo'
        : fixture === 'diagram' || fixture === 'embedded'
          ? 'diagram'
          : fixture === 'chart'
            ? 'chart'
            : fixture === 'text_heavy'
              ? 'text_heavy'
              : 'other';
    const valid: VisualDescriptionPayload = {
      description:
        fixture === 'chart'
          ? 'A chart-like visual with labeled values and a visible comparison pattern.'
          : fixture === 'diagram' || fixture === 'embedded'
            ? 'A structured diagram connecting several visible learning concepts.'
            : fixture === 'photo'
              ? 'A photo-like visual showing one main subject and its surrounding context.'
              : fixture === 'text_heavy'
                ? 'A text-heavy visual containing a heading and several short content lines.'
                : 'A visual learning source with bounded descriptive context.',
      visualType,
      visibleText: fixture === 'no_text' || fixture === 'photo' ? null : 'Visible fixture text',
      importantConcepts: fixture === 'chart' ? ['comparison', 'trend'] : ['visual concept'],
      pedagogicalNotes: ['Use this visual as advisory teaching context.'],
      uncertainty:
        fixture === 'uncertainty' ? ['Some small labels may be difficult to distinguish.'] : [],
    };
    if (fixture === 'malformed_json') {
      opts?.onRepairAttempt?.('schema', 'JSON_PARSE_FAILURE');
      throw ProviderError.invalidOutput(
        'visual JSON remained malformed',
        'schema',
        'JSON_PARSE_FAILURE',
        true,
      );
    }
    const invalid: unknown =
      fixture === 'invalid_schema'
        ? { description: 'missing fields' }
        : fixture === 'too_long'
          ? { ...valid, description: 'x'.repeat(input.limits.maxDescriptionChars + 1) }
          : fixture === 'repair_once' || fixture === 'repair_exhausted'
            ? { ...valid, importantConcepts: ['Duplicate', ' duplicate '] }
            : valid;
    const first = VisualDescriptionPayloadSchema.safeParse(invalid);
    if (!first.success) {
      opts?.onRepairAttempt?.('schema', 'SCHEMA_VALIDATION_FAILURE');
      if (fixture === 'repair_once') return VisualDescriptionPayloadSchema.parse(valid);
      throw ProviderError.invalidOutput(
        first.error.message,
        'schema',
        'SCHEMA_VALIDATION_FAILURE',
        true,
      );
    }
    const candidate =
      fixture === 'semantic_invalid'
        ? { ...first.data, description: 'This image definitively grants mastery.' }
        : first.data;
    const validation = opts?.validateCandidate?.(candidate);
    if (validation && !validation.valid) {
      opts?.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
      if (fixture === 'repair_once') return valid;
      throw ProviderError.invalidOutput(
        validation.diagnostics.join('; '),
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        true,
      );
    }
    return candidate;
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

  async generateRepair(
    input: RepairGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<RepairGenerationPayload> {
    await this.gate(opts);
    const mode = input.requiredInterventionMode;
    // How many times this learner has already been asked this same intent. The
    // local ladder legally reuses its first intent once the alternatives are
    // exhausted, so keying the check on the intent alone would reproduce the
    // earlier round's sentence byte-for-byte and be correctly rejected as a
    // repeat. Derived from the bounded history the contract already supplies.
    const intentReuseCount = input.priorCheckIntents.filter(
      (intent) => intent === input.requiredCheckIntent,
    ).length;
    const baseTask = REPAIR_CHECK_TASKS[input.requiredCheckIntent] ?? '换一个角度作答';
    const task =
      intentReuseCount === 0
        ? baseTask
        : REPAIR_CHECK_REASK_TASKS[
            Math.min(intentReuseCount, REPAIR_CHECK_REASK_TASKS.length - 1)
          ]!;
    // Bounded so one long rubric criterion cannot dominate the comparison and
    // make two different task sentences look like a repeat. Marked when cut, so
    // a truncated fragment does not read as a corrupted criterion.
    const fullCriterion = input.affectedCriteria[0] ?? '该要点';
    const criterion =
      fullCriterion.length > FAKE_CHECK_CRITERION_CHARS
        ? `${fullCriterion.slice(0, FAKE_CHECK_CRITERION_CHARS)}…`
        : fullCriterion;
    // Deterministic per-(mode, intent, reuse) check so a differentiated round
    // produces a materially different prompt instead of a reworded copy of the
    // failure.
    const valid: RepairGenerationPayload = {
      interventionMode: mode,
      diagnosticCategory: input.diagnosticCategory,
      checkIntent: input.requiredCheckIntent,
      explanation:
        `${REPAIR_STRATEGY_OPENERS[mode] ?? '换一种方式说明'}：${input.gapSummary}`.slice(0, 1500),
      practicePrompt: `${task}（针对：${criterion}）`.slice(0, 1000),
      hints: input.affectedCriteria.slice(0, 2).map((criterion) => `检查是否说明了：${criterion}`),
    };
    const repeatedStrategy: RepairGenerationPayload = {
      ...valid,
      interventionMode: input.priorInterventionModes[0] ?? mode,
    };
    const repeatedIntent: RepairGenerationPayload = {
      ...valid,
      checkIntent: input.priorCheckIntents[0] ?? input.requiredCheckIntent,
    };
    const repeatedPrompt: RepairGenerationPayload = {
      ...valid,
      practicePrompt: (input.priorCheckPrompts[0] ?? input.failedPrompt).slice(0, 1000),
    };
    const invalid: RepairGenerationPayload =
      this.repairFixture === 'repeated_strategy_once' ||
      this.repairFixture === 'repeated_strategy_exhausted'
        ? repeatedStrategy
        : this.repairFixture === 'repeated_intent_once' ||
            this.repairFixture === 'repeated_intent_exhausted'
          ? repeatedIntent
          : this.repairFixture === 'repeated_prompt_once' ||
              this.repairFixture === 'repeated_prompt_exhausted'
            ? repeatedPrompt
            : {
                ...valid,
                interventionMode:
                  input.requiredInterventionMode === 'TARGETED_PROMPT'
                    ? 'CONTRAST'
                    : 'TARGETED_PROMPT',
              };
    const first = this.repairFixture ? invalid : valid;
    const firstValidation = opts?.validateCandidate?.(first);
    if (!firstValidation || firstValidation.valid) return first;
    opts?.onRepairAttempt?.('candidate');
    await this.gate(opts);
    const repaired = this.repairFixture?.endsWith('_exhausted') ? invalid : valid;
    const repairedValidation = opts?.validateCandidate?.(repaired);
    if (!repairedValidation || repairedValidation.valid) return repaired;
    throw ProviderError.invalidOutput(repairedValidation.diagnostics.join('; '), 'candidate');
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
          ...(input.objectiveCatalogue?.[0]
            ? { objectiveRef: input.objectiveCatalogue[0].objectiveRef }
            : {}),
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
          ...(input.objectiveCatalogue?.[0]
            ? {
                premises: [
                  {
                    premiseKey: 'source:0',
                    text: quote,
                    sourceRefs: [block.id],
                    teachingSurfaceRefs: [],
                    learnerVisible: true,
                    scenarioLocal: false,
                    visibilityBasis: 'cited_source' as const,
                  },
                ],
                requiresExternalKnowledge: false,
                ambiguity: 'none' as const,
                undefinedTerms: [],
              }
            : {}),
          extraEvidence: [],
        });
      }
      return { items };
    }

    for (const [targetIndex, target] of input.targets.entries()) {
      if (items.length >= input.questionCount) break;
      const block = blockOf(target.concept);
      if (!block) continue;
      const formalObjectiveRef =
        input.objectiveCatalogue?.[targetIndex]?.objectiveRef ??
        input.objectiveCatalogue?.[0]?.objectiveRef;

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
          ...(formalObjectiveRef ? { objectiveRef: formalObjectiveRef } : {}),
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
              { text: quoteA.slice(0, 80), required: true, sourceRefs: [block.id] },
              { text: quoteB.slice(0, 80), required: true, sourceRefs: [siblingBlock.id] },
            ],
            conceptId: target.concept.id,
            blockId: block.id,
            quote: quoteA,
            explanation: `两份资料分别指出:「${quoteA.slice(0, 100)}」与「${quoteB.slice(0, 100)}」。`,
          },
          ...(formalObjectiveRef
            ? {
                premises: [
                  {
                    premiseKey: 'source:1',
                    text: quoteA,
                    sourceRefs: [block.id],
                    teachingSurfaceRefs: [],
                    learnerVisible: true,
                    scenarioLocal: false,
                    visibilityBasis: 'cited_source' as const,
                  },
                  {
                    premiseKey: 'source:2',
                    text: quoteB,
                    sourceRefs: [siblingBlock.id],
                    teachingSurfaceRefs: [],
                    learnerVisible: true,
                    scenarioLocal: false,
                    visibilityBasis: 'cited_source' as const,
                  },
                ],
                requiresExternalKnowledge: false,
                ambiguity: 'none' as const,
                undefinedTerms: [],
              }
            : {}),
          extraEvidence: [{ blockId: siblingBlock.id, quote: quoteB }],
        });
        continue;
      }

      const type: QuestionType =
        input.mode === 'concept_practice' && input.allowedTypes.includes('short_answer')
          ? 'short_answer'
          : input.allowedTypes.includes('single_choice')
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
      if (question.rubricKeyPoints) {
        question.rubricKeyPoints = question.rubricKeyPoints.map((point) => ({
          ...(typeof point === 'string' ? { text: point, required: true } : point),
          sourceRefs: [block.id],
        }));
      }
      if (type === 'short_answer' && input.requestedChallengeFamily === 'representation_shift') {
        question.stem = `请用一个与直接复述不同的应用形式说明「${target.concept.name}」如何依据资料成立。`;
      }
      if (type === 'short_answer' && input.requestedChallengeFamily === 'transfer') {
        question.stem = `在表面情境改变但仍满足资料条件时，如何应用「${target.concept.name}」？请说明依据。`;
      }
      items.push({
        ...(formalObjectiveRef ? { objectiveRef: formalObjectiveRef } : {}),
        blueprint: {
          conceptIds: [target.concept.id],
          questionType: type,
          difficulty: 'medium',
          learningObjective:
            input.requestedChallengeFamily === 'representation_shift'
              ? `用不同表示检验「${target.concept.name}」的应用。`
              : input.requestedChallengeFamily === 'transfer'
                ? `检验「${target.concept.name}」在变化情境中的应用。`
                : `检验「${target.concept.name}」的原文理解。`,
          reasoningSteps: [
            {
              description: input.requestedChallengeFamily
                ? '识别资料条件，并将同一能力用于题目给出的变化形式。'
                : '依据原文判断或复述概念要点。',
              evidenceIndexes: [0],
            },
          ],
        },
        question,
        ...(formalObjectiveRef
          ? {
              premises: [
                {
                  premiseKey: 'source:0',
                  text: block ? pickQuote(block) : target.concept.name,
                  sourceRefs: block ? [block.id] : [],
                  teachingSurfaceRefs: [],
                  learnerVisible: true,
                  scenarioLocal: false,
                  visibilityBasis: 'cited_source' as const,
                },
              ],
              requiresExternalKnowledge: false,
              ambiguity: 'none' as const,
              undefinedTerms: [],
            }
          : {}),
        extraEvidence: [],
      });
    }
    return { items };
  }

  async proposeMasteryChallenges(
    input: MasteryChallengeProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<MasteryChallengeProposalPayload> {
    await this.gate(opts);
    const fixture = this.masteryRedTeamFixture;
    if (fixture === 'schema_failure') {
      opts?.onRepairAttempt?.('schema', 'SCHEMA_VALIDATION_FAILURE');
      throw ProviderError.invalidOutput(
        'mastery red team fixture schema failure',
        'schema',
        'SCHEMA_VALIDATION_FAILURE',
        true,
      );
    }
    const source = input.sources[0] ?? { sourceRef: 'S1', text: 'The offered source claim.' };
    const base = (ordinal: number): MasteryChallengeProposalPayload['candidates'][number] => ({
      candidateKey: `fake-${ordinal}`,
      family: input.selectedFamily,
      prompt:
        input.selectedFamily === 'discriminative_follow_up'
          ? `Contrast the unresolved prior reasoning with source-grounded condition ${ordinal}, then diagnose exactly which claim remains justified.`
          : `Using the source-grounded ${input.selectedFamily} case ${ordinal}, explain the answer and the condition that makes it hold.`,
      expectedAnswer: source.text,
      targetObjectiveRefs: ['O1'],
      sourceRefs: [source.sourceRef],
      expectedAnswerSourceRefs: [source.sourceRef],
      premises: [
        {
          text: 'Use only the supplied source claim.',
          sourceRefs: [source.sourceRef],
          learnerVisible: true,
        },
      ],
      rubric: [
        {
          key: `criterion-${ordinal}`,
          text: source.text.slice(0, 300),
          required: true,
          sourceRefs: [source.sourceRef],
        },
      ],
      requiresExternalKnowledge: false,
      ambiguity: 'none',
      undefinedTerms: [],
      rationale: `A bounded ${input.selectedFamily} challenge grounded in ${source.sourceRef}.`,
    });
    const valid = { candidates: [base(1), base(2), base(3)] };
    if (!fixture) return valid;
    const first = this.masteryRedTeamCalls++ === 0;
    const invalidCandidate = (ordinal: number) => {
      const candidate = base(ordinal);
      if (fixture === 'duplicate_candidates') {
        return {
          ...candidate,
          candidateKey: 'duplicate',
          prompt:
            'Use this identical source-grounded challenge to explain the claim and its condition.',
        };
      }
      if (fixture === 'unsupported_source') {
        return { ...candidate, sourceRefs: ['S99'], expectedAnswerSourceRefs: ['S99'] };
      }
      if (fixture === 'unfair_unanswerable')
        return { ...candidate, requiresExternalKnowledge: true };
      if (fixture === 'trivial_candidate') return { ...candidate, prompt: 'What is it?' };
      if (fixture === 'candidate_repair_once' || fixture === 'candidate_repair_failure') {
        return { ...candidate, requiresExternalKnowledge: true };
      }
      return candidate;
    };
    const invalid: MasteryChallengeProposalPayload = {
      candidates: [invalidCandidate(1), invalidCandidate(2), invalidCandidate(3)],
    };
    if (fixture === 'candidate_repair_once' && !first) return valid;
    const firstValidation = opts?.validateCandidate?.(invalid);
    if (!firstValidation || firstValidation.valid) return invalid;
    opts?.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
    await this.gate(opts);
    const repaired = fixture === 'candidate_repair_once' ? valid : invalid;
    const repairedValidation = opts?.validateCandidate?.(repaired);
    if (!repairedValidation || repairedValidation.valid) return repaired;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      true,
    );
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

  async generateTeachingBrief(
    input: TeachingBriefGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<TeachingBriefProposalPayload> {
    await this.gate(opts);
    const firstSource = input.sourceContext.offers[0];
    const firstVisual = input.visualContext.offers[0];
    const firstObjective = input.learningUnit.objectives[0];
    if ((!firstSource && !firstVisual) || !firstObjective) {
      throw ProviderError.invalidOutput(
        'Teaching Brief input requires source or visual context plus an objective offer.',
      );
    }
    const explanation = firstSource
      ? `Start from the course excerpt for ${input.learningUnit.title}. It matters because the stated conditions determine when the mechanism applies: ${firstSource.text}`
      : `Use the advisory visual explanation for ${input.learningUnit.title}. Explain how the represented parts relate and why that relationship changes the result: ${firstVisual!.explanation.text}`;
    const explanationAuthority = firstSource
      ? ('source_backed_teaching' as const)
      : ('ai_teaching_synthesis' as const);
    const sourceRefs = firstSource ? [firstSource.sourceRef] : [];
    const objectiveCapabilities = input.learningUnit.objectives
      .map((objective) => `${objective.title}: ${objective.description}`)
      .join('; ');
    const payload = TeachingBriefProposalPayloadSchema.parse({
      whyNow: `This lesson establishes ${input.learningUnit.title} before the next route step.`,
      prerequisites: input.prerequisites.map((prerequisite) => ({
        prerequisiteRef: prerequisite.prerequisiteRef,
        reason: `${prerequisite.title} supplies required context for this lesson.`,
        readinessHint: `Recall the main idea of ${prerequisite.title}.`,
      })),
      segments: [
        {
          purpose: 'objective_orientation',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `By the end, you will explain how ${input.learningUnit.title} works and use its stated conditions in a concrete decision. This is useful now because later route steps depend on that capability.`,
          explanationAuthority: 'ai_teaching_synthesis',
          sourceRefs,
        },
        {
          purpose: 'explanation',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `${explanation} The accepted objective capabilities are: ${objectiveCapabilities}`,
          explanationAuthority,
          sourceRefs,
        },
        {
          purpose: 'mechanism',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `The mechanism works by checking the source-stated conditions first; because those conditions bound the claim, the conclusion must stay within them. If a condition changes, the result can change as well.`,
          explanationAuthority,
          sourceRefs,
        },
        {
          purpose: 'worked_example',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `Worked reasoning: first identify the case facts, then compare each fact with the stated conditions, and finally choose the conclusion that follows. The result is justified because every step remains inside the sourced boundary.`,
          explanationAuthority: 'ai_teaching_synthesis',
          sourceRefs,
          example: {
            text: `Example: given a small case about ${input.learningUnit.title}, first mark the relevant condition, next trace its consequence, then reject the tempting alternative that ignores that condition.`,
            authority: 'ai_teaching_synthesis',
            sourceRefs: [],
          },
        },
        {
          purpose: 'contrast',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `Compare the defining mechanism of ${input.learningUnit.title} with a surface-similar description. The first explains how the conditions produce a result; the second merely repeats vocabulary without causal support.`,
          explanationAuthority: 'ai_teaching_synthesis',
          sourceRefs,
          contrast: {
            text: 'Teaching illustration: compare the mechanism with a near-neighbor that shares vocabulary but not the same conditions.',
            authority: 'ai_teaching_synthesis',
            sourceRefs: [],
          },
          misconception: {
            hypothesis:
              'A learner may memorize the label while missing the conditions that make the mechanism apply.',
            correction:
              'Return to the sourced definition, identify its conditions, and test them in the worked case.',
            sourceRefs,
          },
        },
        {
          purpose: 'guided_practice',
          objectiveRefs: input.learningUnit.objectives.map((objective) => objective.objectiveRef),
          explanation: `Now make the reasoning observable: explain why the stated condition changes the conclusion, then apply that reason to the small case. Commit your response before opening the coaching signal.`,
          explanationAuthority: 'ai_teaching_synthesis',
          sourceRefs,
          informalCheck: {
            kind: 'apply_simple_example',
            prompt: `Apply ${input.learningUnit.title}: explain which condition you would inspect first in a new small case and why it controls the next step.`,
            expectedSignal: `Name a source-stated condition, connect it causally to the result, and keep the claim within ${firstObjective.title}.`,
          },
        },
      ],
      formalOpportunities: firstSource
        ? [`A later formal assessment may align with ${firstObjective.title}.`]
        : [],
      summary: firstSource
        ? `The lesson links the sourced definition of ${input.learningUnit.title} to a worked application and an informal understanding check.`
        : `The lesson uses an advisory generated visual explanation for ${input.learningUnit.title} and keeps it separate from Formal Evidence.`,
      nextConnection: input.nextConnection
        ? `Next, connect this lesson to ${input.nextConnection.title}.`
        : null,
      practice: {
        items: (() => {
          const eligible = input.learningUnit.objectives.filter(
            (objective) =>
              objective.construct &&
              objective.practiceAuthority !== 'unavailable' &&
              (objective.practiceAuthority === 'advisory_visual' ||
                input.sourceContext.offers.some((offer) =>
                  offer.authorizedObjectiveRefs.includes(objective.objectiveRef),
                )),
          );
          const required = eligible.filter(
            (objective) => objective.priority === 'required' || objective.priority === 'high',
          );
          return (required.length > 0 ? required : eligible.slice(0, 1)).map((objective) => {
            const source = input.sourceContext.offers.find((offer) =>
              offer.authorizedObjectiveRefs.includes(objective.objectiveRef),
            );
            const visual = input.visualContext.offers[0];
            const action =
              objective.construct === 'apply'
                ? `Apply ${objective.title} in this scenario: a learner must choose the next step while preserving the source-stated condition. Which option best uses that condition?`
                : objective.construct === 'explain'
                  ? `Which explanation best accounts for how and why ${objective.title} works under the source-stated condition?`
                  : objective.construct === 'evaluate'
                    ? `Evaluate this case about ${objective.title}: which judgment is best justified by the source-stated condition?`
                    : objective.construct === 'design'
                      ? `Design a bounded plan for ${objective.title}: which option preserves every source-stated constraint?`
                      : `Identify which case correctly distinguishes ${objective.title} by its source-stated condition.`;
            return {
              objectiveRef: objective.objectiveRef,
              construct: objective.construct!,
              capabilityTested: `${objective.construct} ${objective.title} using the exact authorized source boundary.`,
              pedagogicalReason: `This reveals whether the learner can ${objective.construct} the objective rather than recall a source location.`,
              authority: source ? 'exact_source' : 'advisory_visual',
              sourceRefs: source ? [source.sourceRef] : [],
              visualRefs: source || !visual ? [] : [visual.referenceKey],
              initial: {
                prompt: action,
                options: [
                  {
                    optionRef: 'A',
                    text: 'Check the stated condition, trace its consequence, and choose only the bounded conclusion.',
                    feedbackIfSelected:
                      'Correct: this uses the condition as a reasoning constraint and keeps the conclusion bounded.',
                  },
                  {
                    optionRef: 'B',
                    text: 'Choose the option that repeats the most terms from the lesson without testing conditions.',
                    feedbackIfSelected:
                      'This relies on surface vocabulary. Recheck which condition actually changes the result.',
                  },
                  {
                    optionRef: 'C',
                    text: 'Assume the idea transfers to every context even when the stated conditions are absent.',
                    feedbackIfSelected:
                      'This overgeneralizes beyond the source boundary. Identify the required condition first.',
                  },
                ],
                correctOptionRef: 'A',
                hint: 'Look for the option that makes the condition do reasoning work, not merely appear as a label.',
                explanation:
                  'The correct reasoning checks the authorized condition and follows its consequence without expanding the claim.',
              },
              retry: {
                prompt: `In a changed case, ${objective.title} appears with one condition removed. Which decision best ${objective.construct}s the objective without overclaiming?`,
                options: [
                  {
                    optionRef: 'A',
                    text: 'Keep the original conclusion unchanged because the same label appears.',
                    feedbackIfSelected:
                      'The label alone is insufficient; the changed condition must affect the decision.',
                  },
                  {
                    optionRef: 'B',
                    text: 'Recheck the remaining conditions and narrow or withhold the conclusion accordingly.',
                    feedbackIfSelected:
                      'Correct: the changed surface still tests the same construct while respecting the authority boundary.',
                  },
                  {
                    optionRef: 'C',
                    text: 'Replace the source-stated procedure with an unrelated rule of thumb.',
                    feedbackIfSelected:
                      'An unrelated heuristic does not demonstrate the selected objective or construct.',
                  },
                ],
                correctOptionRef: 'B',
                hint: 'Ask what must change when a required condition is no longer present.',
                explanation:
                  'A valid retry response notices the changed condition and adjusts the conclusion within the exact source authority.',
              },
            };
          });
        })(),
      },
    });
    const validation = opts?.validateCandidate?.(payload);
    if (validation && !validation.valid) {
      throw ProviderError.invalidOutput(
        validation.diagnostics.join('; '),
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        validation.failureArtifact,
      );
    }
    return payload;
  }

  async generateLessonSlotContent(
    input: LessonSlotContentGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<LessonSlotContentProposalPayload> {
    await this.gate(opts);
    const sourceByRef = new Map(
      input.sourceContext.offers.map((offer) => [offer.sourceRef, offer]),
    );
    const objectiveByRef = new Map(
      input.skeleton.objectives.map((objective) => [objective.objectiveRef, objective]),
    );
    const depthInvestment = {
      pass_oriented: '先建立必要的心智模型，并用一个刻意保持简单的例子说明。',
      working_fluency: '接着把机制和重要边界连起来，再完整推演一个条件发生变化的案例。',
      high_performance: '还要用真实的失败模式、边界情况和相互竞争的取舍来检验这个机制。',
      deep_transfer: '进一步把机制连接到相邻概念，用反例检验它，并迁移到陌生情境。',
    }[input.courseDesign?.desiredDepth ?? 'working_fluency'];
    const focusInvestment =
      input.courseDesign?.unitFocus === 'focused'
        ? '这里会投入更多讲解，用更丰富的案例、影响结果的边界和有用的后续联系把它讲透。'
        : '我们会完整展开核心思路，同时避免无关岔路。';
    const payload = LessonSlotContentProposalPayloadSchema.parse({
      narrative: {
        whyNow: `现在学习“${input.skeleton.learningUnitTitle}”，是因为它能为后续判断建立可用的模型。${depthInvestment}`,
        summary: `现在，核心思路已经与证据、机制、边界和学习者需要作出的判断连在一起。${focusInvestment}`,
        forwardBridge: input.learningContext.nextConnection
          ? `接下来，用这个模型理解“${input.learningContext.nextConnection.title}”。`
          : '接下来把这个模型带入一个陌生案例，判断究竟是哪项条件改变了结果。',
      },
      slots: input.skeleton.lessonSlots.map((slot) => {
        const objective = objectiveByRef.get(slot.objectiveRefs[0]!);
        const sourceRef = slot.allowedSourceRefs[0];
        const visualRef = slot.allowedVisualRefs[0];
        const sourceText = sourceRef ? sourceByRef.get(sourceRef)?.text : undefined;
        const relationSourceText = sourceText?.slice(0, 560);
        const topic = objective?.title ?? input.skeleton.learningUnitTitle;
        const sourceRefs = sourceRef ? [sourceRef] : [];
        const visualRefs = sourceRef || !visualRef ? [] : [visualRef];
        const relationKind = slot.allowedRelations[0];
        const [fromProposition, toProposition] = relationSourceText
          ? relationPropositions(relationSourceText)
          : [
              `辅助图示呈现了“${topic}”的一个有限状态。`,
              `这个图示状态帮助我们对“${topic}”作出有限区分。`,
            ];
        const semanticRelations =
          slot.qualityContract === 'semantic_relation' && relationKind
            ? [
                {
                  kind: relationKind,
                  fromProposition,
                  toProposition,
                  relevanceToObjective: `这个联系说明了推理“${topic}”时，为什么该变化会影响结果。`,
                  sourceRefs,
                },
              ]
            : [];
        const workedProcess =
          slot.qualityContract === 'worked_process' && sourceRef && sourceText
            ? {
                startingState: `学习者位于资料所述“${topic}”流程的起点，案例中的限定事实都已明确。`,
                ruleOrProcedure: sourceText,
                steps: [
                  {
                    action: `检查当前“${topic}”案例的状态，找出资料中适用的条件。`,
                    reason: '该条件限定了资料允许进行哪一次状态转换。',
                    resultingState: `适用的“${topic}”条件和当前流程状态已经明确。`,
                  },
                  {
                    action: `选择资料所述“${topic}”的下一步动作，并在这个限定案例中执行。`,
                    reason: '这样是在应用规则，而不是只说出或复述规则。',
                    resultingState: `“${topic}”案例推进到流程所允许的结果。`,
                  },
                ],
                learnerDecision: `根据当前条件，判断接下来应执行资料所述“${topic}”中的哪项动作。`,
                result: `案例在没有添加无依据步骤的情况下，得到“${topic}”的限定结果。`,
                whyResultFollows: `先检查当前“${topic}”条件，再选择资料所述的下一项动作，案例才会推进到流程允许的限定结果。每一次转换都使用给定规则并保留其限定条件，因此结果确实由资料支持的流程推出。`,
                sourceRefs,
              }
            : null;
        const informalCheck = slot.learnerActionRequired
          ? objective?.construct === 'identify'
            ? {
                kind: 'choose_alternative' as const,
                prompt: `哪个案例真正具备“${topic}”的定义性特征？`,
                expectedSignal: '依据定义条件判断，不要只看熟悉的标签。',
                options: [
                  {
                    id: 'A',
                    text: '满足定义条件的案例。',
                    feedbackIfSelected: '正确。正是定义条件使它成为匹配的案例。',
                  },
                  {
                    id: 'B',
                    text: '重复主题名称、但缺少必要条件的案例。',
                    feedbackIfSelected: '熟悉的标签还不够；请检查必要条件是否真的存在。',
                  },
                ],
                correctOptionId: 'A',
              }
            : {
                kind:
                  objective?.construct === 'apply'
                    ? ('apply_simple_example' as const)
                    : ('own_words' as const),
                prompt:
                  objective?.construct === 'apply'
                    ? `根据“${topic}”的当前状态，选择下一项有依据的动作，并说明原因。`
                    : `请解释关键条件如何改变“${topic}”的结果。`,
                expectedSignal: '用自己的话把条件与由此产生的影响或判断连接起来。',
              }
          : undefined;
        const base = {
          slotId: slot.slotId,
          explanation:
            slot.qualityContract === 'orientation'
              ? `先从一个实际问题开始：当“${topic}”背后的关键条件改变时，什么会随之改变？${depthInvestment}${focusInvestment}`
              : sourceText
                ? `带着这个问题来看，资料给出了关于“${topic}”的这项限定事实：${sourceText}`
                : `辅助图示提供了一种理解“${topic}”的方式，但它属于补充讲解，不是资料证据。`,
          sourceRefs: slot.qualityContract === 'orientation' ? [] : sourceRefs,
          visualRefs,
          semanticRelations,
          workedProcess,
          ...(informalCheck ? { informalCheck } : {}),
        };
        if (slot.role === 'worked_example') {
          return {
            ...base,
            example: {
              text: workedProcess
                ? '现在改变案例中的一个条件，逐步追踪它如何改变可选动作，并检查最终结果是否仍然成立。'
                : `设想一个具体的“${topic}”案例，改变其中一个条件，再预测结果应如何变化。`,
              sourceRefs: [],
              visualRefs,
            },
          };
        }
        if (slot.role === 'contrast') {
          return {
            ...base,
            contrast: {
              text: `对“${topic}”的可靠解释会用支配条件预测结果；表面相似的回答只会重复标签。`,
              sourceRefs: [],
              visualRefs,
            },
          };
        }
        if (slot.role === 'misconception') {
          return {
            ...base,
            misconception: {
              hypothesis: `学习者可能只重复“${topic}”的标签，却没有使用资料所述的边界。`,
              correction: '回到支配条件，把它与结果连接起来，再检验条件改变后结论是否仍然成立。',
              sourceRefs: [],
              visualRefs,
            },
          };
        }
        return base;
      }),
    });
    const validation = opts?.validateCandidate?.(payload);
    if (validation && !validation.valid) {
      throw ProviderError.invalidOutput(
        validation.diagnostics.join('; '),
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        validation.failureArtifact,
      );
    }
    return payload;
  }

  async generatePracticeContent(
    input: PracticeContentGenerationInput,
    opts?: ProviderCallOptions,
  ): Promise<PracticeContentProposalPayload> {
    await this.gate(opts);
    const sourceByRef = new Map(
      input.sourceContext.offers.map((offer) => [offer.sourceRef, offer]),
    );
    const scenarioDemand = {
      pass_oriented: '在一个简单的新案例中',
      working_fluency: '在一个重要条件已经改变的新案例中',
      high_performance: '在一个存在相互竞争约束的真实失败案例中',
      deep_transfer: '在一个组合了两项相互作用约束的陌生迁移案例中',
    }[input.courseDesign?.desiredDepth ?? 'working_fluency'];
    const focusDetail =
      input.courseDesign?.unitFocus === 'focused'
        ? ' 请同时考虑会让那个看似诱人的选项失效的边界条件。'
        : '';
    const payload = PracticeContentProposalPayloadSchema.parse({
      items: input.skeleton.practicePlan.slots.map((slot) => {
        const sourceRef = slot.allowedSourceRefs[0];
        const visualRef = slot.allowedVisualRefs[0];
        const sourceRefs = sourceRef ? [sourceRef] : [];
        const visualRefs = sourceRef || !visualRef ? [] : [visualRef];
        const sourceText = sourceRef ? sourceByRef.get(sourceRef)?.text : undefined;
        const application =
          slot.construct === 'apply' && sourceText
            ? {
                startingState: '相关流程已经开始，学习者来到一个受条件约束的决策点。',
                sourceRuleOrProcedure: sourceText,
                decisionRequired: '根据当前流程状态，选择资料所述的下一项动作。',
                expectedAction:
                  '检查当前条件，在保留资料所述边界的前提下执行下一项允许的流程步骤。',
              }
            : null;
        const initialPrompt =
          slot.construct === 'apply'
            ? `${scenarioDemand}，${application?.startingState}根据支配条件，下一步应该做什么？${focusDetail}`
            : slot.construct === 'explain'
              ? `${scenarioDemand}，某个约束变化后，系统产生了不同结果。哪项解释最准确地把变化后的约束与结果连接起来？${focusDetail}`
              : `${scenarioDemand}，哪个案例应依据支配特征分类，而不是依据熟悉的标签分类？${focusDetail}`;
        const retryPrompt =
          slot.construct === 'apply'
            ? '另一个团队通过不同路径来到同一决策点，但现在缺少一项先决条件。他们下一步应该采取什么动作？'
            : slot.construct === 'explain'
              ? '另一个系统改变了不同的条件。现在，哪种机制最能解释新的后果？'
              : '一份故障排查报告保留了熟悉的标签，却去掉了一项必要条件。现在应该排除哪个候选？';
        return {
          practiceSlotId: slot.practiceSlotId,
          capabilityTested: slot.capabilityToObserve,
          pedagogicalReason: `学习者需要真正展示 ${slot.construct} 能力，而不是回忆资料位置或重复标签。`,
          sourceRefs,
          visualRefs,
          application,
          initial: {
            prompt: initialPrompt,
            options: [
              {
                optionRef: 'A',
                text:
                  slot.construct === 'apply'
                    ? application!.expectedAction
                    : '使用定义条件，把案例与限定结论连接起来。',
                feedbackIfSelected: '正确：这项回答确实利用给定边界完成了所需推理。',
              },
              {
                optionRef: 'B',
                text: '选择重复资料词汇最多、却没有使用其条件的回答。',
                feedbackIfSelected:
                  '这只是表面回忆。请判断给定条件会让你得出什么结论或采取什么动作。',
              },
              {
                optionRef: 'C',
                text: '即使缺少所述条件，也把这个想法推广到所有情境。',
                feedbackIfSelected: '这超出了依据边界。请回到给定条件。',
              },
            ],
            correctOptionRef: 'A',
            hint: '用条件作出判断，不要依赖熟悉的标签。',
            explanation: '正确回答会让资料所述边界真正参与可观察的推理。',
          },
          retry: {
            prompt: retryPrompt,
            options: [
              {
                optionRef: 'A',
                text: '主题标签没有变化，所以保留原答案。',
                feedbackIfSelected: '案例事实的变化会影响判断；仅凭标签无法证明原回答仍然成立。',
              },
              {
                optionRef: 'B',
                text:
                  slot.construct === 'apply'
                    ? '重新评估变化后的条件，再选择资料允许的下一项动作。'
                    : '重新评估变化后的条件，并把它连接到对应的限定结果。',
                feedbackIfSelected: '正确：这个新情境仍然检验同一种能力，并保留相同的依据边界。',
              },
              {
                optionRef: 'C',
                text: '使用无关的经验法则，避开对给定条件的检查。',
                feedbackIfSelected: '无关的经验法则不能展示这里要检验的能力。',
              },
            ],
            correctOptionRef: 'B',
            hint: '想一想：条件改变后，你的推理或动作应该怎样随之改变？',
            explanation: '重试仍限定在同一种能力上，但要求你在新情境中重新作出判断。',
          },
        };
      }),
    });
    const validation = opts?.validateCandidate?.(payload);
    if (validation && !validation.valid) {
      throw ProviderError.invalidOutput(
        validation.diagnostics.join('; '),
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        validation.failureArtifact,
      );
    }
    return payload;
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

  async proposeCourseMap(
    input: CourseMapProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CourseMapProposalPayload> {
    await this.gate(opts);
    if (input.sourceRegions.length === 0 || input.limits.maxModules < 1) {
      throw ProviderError.invalidOutput('Course Map requires bounded source regions');
    }
    const regionsPerModule = {
      pass_oriented: 5,
      working_fluency: 4,
      high_performance: 3,
      deep_transfer: 2,
    }[input.contract.desiredDepth];
    const moduleCount = Math.min(
      input.limits.maxModules,
      Math.max(1, Math.ceil(input.sourceRegions.length / regionsPerModule)),
    );
    const capabilityRequirementRefsByRegion = new Map<string, string[]>();
    const seenCapabilityRefs = new Set<string>();
    const capabilityRequirements = input.capabilityRecovery?.requirements ?? [];
    const recoveryEvidenceByRef = new Map(
      (input.capabilityRecovery?.evidenceOffers ?? []).map(
        (offer) => [offer.recoveryEvidenceRef, offer] as const,
      ),
    );
    const rankedCourseMapCandidates = capabilityRequirements.map((requirement) => {
      if (seenCapabilityRefs.has(requirement.capabilityRef)) {
        throw ProviderError.invalidOutput(
          `Duplicate Course Map recovery capability: ${requirement.capabilityRef}`,
        );
      }
      seenCapabilityRefs.add(requirement.capabilityRef);
      const allowedRegionRefs = new Set(requirement.allowedSourceRegionRefs);
      const allowedEvidenceRefs = new Set(requirement.allowedRecoveryEvidenceRefs);
      return input.sourceRegions
        .map((region, index) => {
          const exactPlacementEvidence = [...allowedEvidenceRefs]
            .map((evidenceRef) => recoveryEvidenceByRef.get(evidenceRef))
            .filter(
              (offer): offer is NonNullable<typeof offer> =>
                offer !== undefined && offer.sourceRegionRef === region.sourceRegionRef,
            );
          const supportRank = Math.min(
            ...exactPlacementEvidence.flatMap((offer) => {
              const rank = fakeSemanticEvidenceSupportRank({
                proposition: requirement.originalProposition,
                construct: requirement.construct,
                evidence: offer.text,
              });
              return rank === null ? [] : [rank];
            }),
          );
          return {
            region,
            index,
            supportRank,
          };
        })
        .filter(
          ({ region, supportRank }) =>
            allowedRegionRefs.has(region.sourceRegionRef) && Number.isFinite(supportRank),
        );
    });
    const firstUnplaceableRequirementIndex = rankedCourseMapCandidates.findIndex(
      (candidates) => candidates.length === 0,
    );
    if (firstUnplaceableRequirementIndex >= 0) {
      const requirement = capabilityRequirements[firstUnplaceableRequirementIndex]!;
      throw ProviderError.invalidOutput(
        `No semantically supported allowed Course Map evidence exists for recovery capability ${requirement.capabilityRef}`,
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        {
          kind: 'course_map_recovery_semantic_placement_unavailable',
          context: {
            capabilityRef: requirement.capabilityRef,
            construct: requirement.construct,
          },
          diagnostics: [
            {
              code: 'recovery_capability_semantic_evidence_unavailable',
              message:
                "The deterministic Fake provider has no explicit same-construct semantic fixture inside this capability's allowed recovery evidence.",
              facts: {
                capabilityRef: requirement.capabilityRef,
                construct: requirement.construct,
                allowedSourceRegionCount: requirement.allowedSourceRegionRefs.length,
                allowedEvidenceCount: requirement.allowedRecoveryEvidenceRefs.length,
              },
            },
          ],
        },
      );
    }
    const candidateKeysByRequirement = rankedCourseMapCandidates.map((candidates) =>
      candidates.map((candidate) => candidate.region.sourceRegionRef),
    );
    const remainingCapacityByRegionRef = new Map<string, number>(
      input.sourceRegions.map((region) => [region.sourceRegionRef, 4] as const),
    );
    for (const [requirementIndex, requirement] of capabilityRequirements.entries()) {
      const eligible = rankedCourseMapCandidates[requirementIndex]!.filter(
        ({ region }) => (remainingCapacityByRegionRef.get(region.sourceRegionRef) ?? 0) > 0,
      ).sort((left, right) => {
        const leftAssigned = capabilityRequirementRefsByRegion.get(left.region.sourceRegionRef);
        const rightAssigned = capabilityRequirementRefsByRegion.get(right.region.sourceRegionRef);
        return (
          left.supportRank - right.supportRank ||
          (leftAssigned?.length ?? 0) - (rightAssigned?.length ?? 0) ||
          left.index - right.index
        );
      });
      const selected = eligible.find(({ region }) => {
        const remaining = new Map(remainingCapacityByRegionRef);
        remaining.set(region.sourceRegionRef, remaining.get(region.sourceRegionRef)! - 1);
        return hasResidualPlacement(candidateKeysByRequirement, requirementIndex + 1, remaining);
      })?.region;
      if (!selected) {
        throw ProviderError.invalidOutput(
          `No allowed Course Map region has capacity for recovery capability ${requirement.capabilityRef}`,
        );
      }
      const assigned = capabilityRequirementRefsByRegion.get(selected.sourceRegionRef) ?? [];
      assigned.push(requirement.capabilityRef);
      capabilityRequirementRefsByRegion.set(selected.sourceRegionRef, assigned);
      remainingCapacityByRegionRef.set(
        selected.sourceRegionRef,
        remainingCapacityByRegionRef.get(selected.sourceRegionRef)! - 1,
      );
    }
    const modules: CourseMapProposalPayload['modules'] = [];
    const orderedRegionRefs: string[] = [];
    for (let moduleIndex = 0; moduleIndex < moduleCount; moduleIndex += 1) {
      const start = Math.floor((moduleIndex * input.sourceRegions.length) / moduleCount);
      const end = Math.floor(((moduleIndex + 1) * input.sourceRegions.length) / moduleCount);
      const sourceRegions = input.sourceRegions.slice(start, end);
      const title =
        sourceRegions.length === 1
          ? sourceRegions[0]!.title
          : `${sourceRegions[0]!.title} - ${sourceRegions.at(-1)!.title}`;
      const regions = sourceRegions.map((sourceRegion) => {
        orderedRegionRefs.push(sourceRegion.sourceRegionRef);
        const capabilityRequirementRefs = capabilityRequirementRefsByRegion.get(
          sourceRegion.sourceRegionRef,
        );
        return {
          sourceRegionRef: sourceRegion.sourceRegionRef,
          title: sourceRegion.title,
          learningIntent: `Build working understanding of ${sourceRegion.title}.`,
          approximateScope:
            sourceRegion.blockCount <= 2
              ? ('focused' as const)
              : sourceRegion.blockCount >= 12
                ? ('extended' as const)
                : ('standard' as const),
          focus: fakeCourseMapRegionFocus(input.contract.focusRequest, sourceRegion),
          anchorOptionRefs: sourceRegion.anchorOptions
            .slice(0, 1)
            .map((option) => option.anchorOptionId),
          ...(capabilityRequirementRefs && capabilityRequirementRefs.length > 0
            ? { capabilityRequirementRefs }
            : {}),
        };
      });
      modules.push({
        title: title.slice(0, 300),
        learningIntent: `Connect the source regions from ${title}.`.slice(0, 700),
        regions,
      });
    }
    const prerequisites: CourseMapProposalPayload['prerequisites'] = [];
    for (
      let index = 1;
      index < orderedRegionRefs.length &&
      input.limits.maxPrerequisiteDegree > 0 &&
      prerequisites.length < input.limits.maxPrerequisiteEdges;
      index += 1
    ) {
      prerequisites.push({
        prerequisiteRegionRef: orderedRegionRefs[index - 1]!,
        dependentRegionRef: orderedRegionRefs[index]!,
      });
    }
    const synthesisGroups: CourseMapProposalPayload['synthesisGroups'] = [];
    for (const module of modules) {
      if (module.regions.length < 2 || synthesisGroups.length >= input.limits.maxSynthesisGroups) {
        continue;
      }
      synthesisGroups.push({
        title: `Synthesize ${module.title}`.slice(0, 300),
        level: 'module',
        regionRefs: module.regions.map((region) => region.sourceRegionRef),
      });
    }
    if (modules.length >= 2 && synthesisGroups.length < input.limits.maxSynthesisGroups) {
      synthesisGroups.push({
        title: 'Connect the complete course structure',
        level: 'course',
        regionRefs: modules.map((module) => module.regions.at(-1)!.sourceRegionRef),
      });
    }
    const candidate: CourseMapProposalPayload = {
      modules,
      prerequisites,
      synthesisGroups,
      sourceDispositions: [],
    };
    const firstValidation = opts?.validateCandidate?.(candidate);
    if (!firstValidation || firstValidation.valid) return candidate;
    opts?.onRepairAttempt?.('candidate');
    await this.gate(opts);
    const repairedValidation = opts?.validateCandidate?.(candidate);
    if (!repairedValidation || repairedValidation.valid) return candidate;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      true,
      repairedValidation.failureArtifact,
    );
  }

  async proposeCurriculumDetails(
    input: CurriculumDetailProposalInput,
    opts?: ProviderCallOptions,
  ): Promise<CurriculumDetailProposalPayload> {
    await this.gate(opts);
    const seenCapabilityRefs = new Set<string>();
    const targetRequestsApplication = /(?:\bapply\b|应用)/iu.test(
      input.contract.targetOutcome.description,
    );
    const hasRequiredApplyRecovery = input.regions.some((region) =>
      (region.capabilityRequirements ?? []).some(
        (requirement) => requirement.construct === 'apply' && requirement.priority === 'required',
      ),
    );
    const explicitApplyRegions = targetRequestsApplication
      ? input.regions.filter((region) =>
          region.evidence.some(
            (offer) =>
              offer.text.includes('[SUPPORTS:apply]') &&
              offer.authorityEnvelope?.supportedConstructs.includes('apply'),
          ),
        )
      : [];
    const reservedGenericApplyRegionId =
      targetRequestsApplication && !hasRequiredApplyRecovery
        ? explicitApplyRegions.find(
            (region) =>
              (region.capabilityRequirements?.length ?? 0) < input.limits.maxObjectivesPerUnit,
          )?.regionId
        : undefined;
    if (
      !hasRequiredApplyRecovery &&
      explicitApplyRegions.length > 0 &&
      !reservedGenericApplyRegionId
    ) {
      throw ProviderError.invalidOutput(
        'No Curriculum detail objective slot remains for the required application target',
      );
    }
    const units = input.regions.map((region, index) => {
      const applyOffer = targetRequestsApplication
        ? region.evidence.find(
            (offer) =>
              offer.text.includes('[SUPPORTS:apply]') &&
              offer.authorityEnvelope?.supportedConstructs.includes('apply'),
          )
        : undefined;
      const explainOffer = region.evidence.find((offer) =>
        offer.text.includes('[SUPPORTS:explain]'),
      );
      const objectiveConstruct =
        this.curriculumObjectiveConstructFixture ??
        (applyOffer
          ? ('apply' as const)
          : explainOffer
            ? ('explain' as const)
            : ('identify' as const));
      const appendGenericApplyObjective =
        (region.capabilityRequirements?.length ?? 0) > 0 &&
        region.regionId === reservedGenericApplyRegionId;
      const selectedEvidence = region.sourceAllocationRegionIds.flatMap((sourceRegionId) => {
        const offer =
          (applyOffer?.sourceAllocationRegionId === sourceRegionId ? applyOffer : undefined) ??
          (explainOffer?.sourceAllocationRegionId === sourceRegionId ? explainOffer : undefined) ??
          region.evidence.find(
            (candidate) => candidate.sourceAllocationRegionId === sourceRegionId,
          );
        return offer ? [{ evidenceId: offer.evidenceId }] : [];
      });
      const sourceHint = region.evidence[0]?.text
        ?.split(/(?<=[.!?。！？；;])\s*/u)[0]
        ?.trim()
        .slice(0, 80);
      const title = (
        region.concepts[0]?.name ??
        region.canonicalConcepts[0]?.displayName ??
        sourceHint ??
        region.title
      ).slice(0, 300);
      const capabilityRequirements = region.capabilityRequirements ?? [];
      const objectiveCount =
        capabilityRequirements.length +
        (capabilityRequirements.length === 0 || appendGenericApplyObjective ? 1 : 0);
      if (objectiveCount > input.limits.maxObjectivesPerUnit) {
        throw ProviderError.invalidOutput(
          `Recovery capabilities exceed the objective budget for region ${region.regionId}`,
        );
      }
      const recoveryObjectives = capabilityRequirements.map((requirement, requirementIndex) => {
        if (seenCapabilityRefs.has(requirement.capabilityRef)) {
          throw ProviderError.invalidOutput(
            `Duplicate Curriculum detail recovery capability: ${requirement.capabilityRef}`,
          );
        }
        seenCapabilityRefs.add(requirement.capabilityRef);
        const allowedEvidenceIds = new Set(requirement.allowedEvidenceIds);
        const selectedOffer = region.evidence
          .flatMap((offer, offerIndex) => {
            if (!allowedEvidenceIds.has(offer.evidenceId)) return [];
            const supportRank = fakeSemanticEvidenceSupportRank({
              proposition: requirement.originalProposition,
              construct: requirement.construct,
              evidence: offer.text,
            });
            return supportRank === null ? [] : [{ offer, offerIndex, supportRank }];
          })
          .sort(
            (left, right) =>
              left.supportRank - right.supportRank || left.offerIndex - right.offerIndex,
          )[0]?.offer;
        if (!selectedOffer) {
          throw ProviderError.invalidOutput(
            `No semantically supported allowed evidence exists for recovery capability ${requirement.capabilityRef}`,
          );
        }
        return {
          key: `detail-recovery-objective-${index + 1}-${requirementIndex + 1}`,
          construct: requirement.construct,
          title: requirement.title,
          description: requirement.description,
          subjectClass: requirement.subjectClass ?? ('source_specific' as const),
          scopeOrigin: requirement.scopeOrigin ?? ('anchored' as const),
          evidence: [{ evidenceId: selectedOffer.evidenceId }],
          capabilityRequirementRef: requirement.capabilityRef,
          priority: requirement.priority,
          priorityRationale:
            'This objective preserves a non-optional predecessor capability for independent evaluation.',
        };
      });
      const exactIdentify = fakeExactIdentifyObjective(
        region.evidence.find((offer) =>
          selectedEvidence.some((selection) => selection.evidenceId === offer.evidenceId),
        )?.text ?? '',
        region.title,
      );
      const genericObjective = {
        key: `detail-objective-${index + 1}`,
        construct: objectiveConstruct,
        subjectClass: 'source_specific' as const,
        scopeOrigin: 'anchored' as const,
        title:
          objectiveConstruct === 'identify'
            ? exactIdentify.title
            : (applyOffer
                ? 'Apply the source-stated procedure'
                : `Understand ${region.title}`
              ).slice(0, 300),
        description:
          objectiveConstruct === 'identify'
            ? exactIdentify.description
            : (applyOffer
                ? 'Apply the exact ordered procedure within its source-stated context.'
                : region.learningIntent
              ).slice(0, 1_000),
        evidence: selectedEvidence.slice(0, 3),
        ...(applyOffer
          ? {
              priority: 'required' as const,
              priorityRationale:
                'The exact selected evidence exposes a locally bounded apply construct.',
            }
          : {}),
      };
      return {
        regionId: region.regionId,
        title,
        sourceEvidence: selectedEvidence,
        conceptIds: region.concepts.slice(0, 3).map((concept) => concept.id),
        canonicalConceptIds: region.canonicalConcepts.slice(0, 2).map((concept) => concept.id),
        objectives:
          recoveryObjectives.length === 0
            ? [genericObjective]
            : appendGenericApplyObjective
              ? [...recoveryObjectives, genericObjective]
              : recoveryObjectives,
      };
    });
    const candidate: CurriculumDetailProposalPayload = {
      courseMapId: input.courseMapId,
      sourceAllocationFingerprint: input.sourceAllocationFingerprint,
      units,
    };
    const firstValidation = opts?.validateCandidate?.(candidate);
    if (!firstValidation || firstValidation.valid) return candidate;
    opts?.onRepairAttempt?.('candidate');
    await this.gate(opts);
    const repairedValidation = opts?.validateCandidate?.(candidate);
    if (!repairedValidation || repairedValidation.valid) return candidate;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
    );
  }

  async evaluateObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticEvaluationInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticEvaluationProposal> {
    await this.gate(opts);
    const supportType = (
      construct: ObjectiveAuthoritySemanticEvaluationInput['objectives'][number]['construct'],
    ): ObjectiveAuthoritySupportType | null => {
      if (construct === 'identify') return 'definition';
      if (construct === 'explain') return 'relationship';
      if (construct === 'apply') return 'procedure';
      return null;
    };
    const candidate = ObjectiveAuthoritySemanticEvaluationProposalSchema.parse({
      schemaVersion: 2,
      evaluations: input.objectives.map((objective) => {
        const offered = objective.candidates.find(
          (offer) =>
            fakeSemanticEvidenceSupportRank({
              proposition: objective.proposition,
              construct: objective.construct,
              evidence: offer.text,
            }) !== null,
        );
        const type = supportType(objective.construct);
        const authoritySupported = Boolean(offered && type);
        const fragmentId = `${objective.objectiveRef}:F1`.slice(0, 100);
        const preservationRequirement = objective.requiredCapabilityPreservation;
        const capabilityPreserved =
          !preservationRequirement ||
          preservationRequirement.originalProposition === objective.proposition;
        const normalizedProposition = objective.proposition.toLowerCase();
        const generalSufficient =
          !normalizedProposition.includes('weknora') &&
          normalizedProposition.includes(
            'lexical and dense retrieval are complementary in hybrid retrieval',
          );
        return {
          objectiveRef: objective.objectiveRef,
          subjectDependency: generalSufficient
            ? ('general_sufficient' as const)
            : ('source_specific_required' as const),
          subjectDependencyRationale: generalSufficient
            ? 'The deterministic Fake fixture can complete this objective using stable public retrieval knowledge.'
            : 'The conservative deterministic Fake fixture requires source-specific truth unless an explicit general fixture matches.',
          candidateLabels: objective.candidates.map((candidateOffer) => ({
            evidenceRef: candidateOffer.evidenceRef,
            relation:
              fakeSemanticEvidenceSupportRank({
                proposition: objective.proposition,
                construct: objective.construct,
                evidence: candidateOffer.text,
              }) === null
                ? ('unrelated' as const)
                : ('relevant' as const),
          })),
          supportGroups:
            authoritySupported && offered && type
              ? [
                  {
                    evidenceRefs: [offered.evidenceRef],
                    supportType: type,
                    rationale:
                      'The deterministic fake fixture treats this exact candidate as sufficient source support.',
                  },
                ]
              : [],
          ...(preservationRequirement
            ? {
                fragments: [
                  {
                    fragmentId,
                    text: objective.proposition,
                    status: authoritySupported ? ('supported' as const) : ('unsupported' as const),
                    supportType: authoritySupported ? type : null,
                    evidenceRefs: authoritySupported && offered ? [offered.evidenceRef] : [],
                    rationale: authoritySupported
                      ? 'The deterministic fake fixture explicitly offers authority for this complete proposition.'
                      : 'The deterministic fake fixture does not offer same-construct semantic support.',
                  },
                ],
                capabilityPreservation: {
                  originalProposition: preservationRequirement.originalProposition,
                  mappings: preservationRequirement.originalFragments.map((original) => ({
                    originalFragmentId: original.fragmentId,
                    originalText: original.text,
                    repairedFragmentIds: [fragmentId],
                    status: capabilityPreserved ? ('preserved' as const) : ('lost' as const),
                    rationale: capabilityPreserved
                      ? 'The deterministic fake repair preserved the exact original proposition.'
                      : 'The repaired proposition differs from the required original capability.',
                  })),
                  lostOriginalFragmentIds: capabilityPreserved
                    ? []
                    : preservationRequirement.originalFragments.map(
                        (original) => original.fragmentId,
                      ),
                  verdict: capabilityPreserved ? ('pass' as const) : ('fail' as const),
                  rationale: capabilityPreserved
                    ? 'Every original capability fragment remains present in the repaired proposition.'
                    : 'The repair changed the original proposition and is rejected by the deterministic fake evaluator.',
                },
              }
            : {}),
        };
      }),
    });
    const firstValidation = opts?.validateCandidate?.(candidate);
    if (!firstValidation || firstValidation.valid) return candidate;
    opts?.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
    await this.gate(opts);
    const repairedValidation = opts?.validateCandidate?.(candidate);
    if (!repairedValidation || repairedValidation.valid) return candidate;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      true,
    );
  }

  async repairObjectiveAuthoritySupport(
    input: ObjectiveAuthoritySemanticRepairInput,
    opts?: ProviderCallOptions,
  ): Promise<ObjectiveAuthoritySemanticRepairProposal> {
    await this.gate(opts);
    const candidate = ObjectiveAuthoritySemanticRepairProposalSchema.parse({
      schemaVersion: 1,
      replacements: input.objectives.map((objective) => {
        const originalProposition = objective.requiredCapabilityPreservation?.originalProposition;
        const proposition = originalProposition ?? `${objective.title}\n${objective.description}`;
        const supporting = objective.allowedEvidence.find(
          (offer) =>
            fakeSemanticEvidenceSupportRank({
              proposition,
              construct: objective.construct,
              evidence: offer.text,
            }) !== null,
        );
        const current = objective.allowedEvidence.filter((offer) => offer.selected);
        const evidenceRefs = supporting
          ? [supporting.evidenceRef]
          : current.map((offer) => offer.evidenceRef).slice(0, 5);
        const propositionSeparator = originalProposition?.indexOf('\n') ?? -1;
        return {
          objectiveRef: objective.objectiveRef,
          title:
            originalProposition && propositionSeparator >= 0
              ? originalProposition.slice(0, propositionSeparator)
              : objective.title,
          description:
            originalProposition && propositionSeparator >= 0
              ? originalProposition.slice(propositionSeparator + 1)
              : objective.description,
          subjectClass: objective.subjectClass,
          scopeOrigin: objective.scopeOrigin,
          construct: objective.construct,
          evidenceRefs,
        };
      }),
    });
    const firstValidation = opts?.validateCandidate?.(candidate);
    if (!firstValidation || firstValidation.valid) return candidate;
    opts?.onRepairAttempt?.('candidate', 'SEMANTIC_VALIDATION_FAILURE');
    await this.gate(opts);
    const repairedValidation = opts?.validateCandidate?.(candidate);
    if (!repairedValidation || repairedValidation.valid) return candidate;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
      'SEMANTIC_VALIDATION_FAILURE',
      true,
    );
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
    const capabilityRequirements = input.capabilityRecovery?.requirements ?? [];
    if (capabilityRequirements.length > maxObjectives) {
      throw ProviderError.invalidOutput(
        'Curriculum recovery capabilities exceed the objective budget',
      );
    }
    const capabilityRefs = capabilityRequirements.map((requirement) => requirement.capabilityRef);
    if (new Set(capabilityRefs).size !== capabilityRefs.length) {
      throw ProviderError.invalidOutput('Curriculum recovery capability references must be unique');
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
    if (scopedMaterials.length === 0) {
      throw ProviderError.invalidOutput(
        'Curriculum proposal requires an included manifested Material',
      );
    }
    const authoritativeMaterialIds = new Set(allowedBlocks.map((block) => block.materialId));
    const sourceBackedMaterials = scopedMaterials.filter((material) =>
      authoritativeMaterialIds.has(material.materialId),
    );
    if (sourceBackedMaterials.length === 0) {
      const diagnostic =
        'Curriculum objectives require exact source evidence; advisory visual-only Materials cannot independently support or originate LearningUnit objectives.';
      throw ProviderError.invalidOutput(
        diagnostic,
        'candidate',
        'SEMANTIC_VALIDATION_FAILURE',
        false,
        {
          kind: 'curriculum_objective_authority_unavailable',
          context: {
            includedManifestedMaterialCount: scopedMaterials.length,
            authoritativeMaterialCount: 0,
          },
          diagnostics: [
            {
              code: 'visual_only_material_cannot_originate_objective',
              message: diagnostic,
            },
          ],
        },
      );
    }
    const materialBudget = Math.min(
      sourceBackedMaterials.length,
      maxObjectives,
      Math.max(0, Math.floor((maxNodes - 1) / 2)),
    );
    const materials = sourceBackedMaterials.slice(0, materialBudget);

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
      const materialVisuals =
        input.visualContext?.offers.filter((offer) => offer.materialTitle === material.title) ?? [];
      const primaryVisual = materialVisuals[0];
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
      const groupedCandidates = groupCurriculumOutline(
        candidates.length > 0 ? candidates : materialOutline.slice(0, 1),
      );
      const selected = groupedCandidates.slice(0, slotsForMaterial);
      const seeds =
        selected.length > 0
          ? selected
          : [
              [
                {
                  structuralUnitId: null,
                  materialId: material.materialId,
                  materialRevisionId:
                    input.executionSourceManifest.revisions.find(
                      (revision) => revision.materialId === material.materialId,
                    )?.materialRevisionId ?? '',
                  parentStructuralUnitId: null,
                  kind: 'section' as const,
                  index: 0,
                  title:
                    primaryVisual?.explanation.importantConcepts[0] ??
                    primaryVisual?.explanation.visualType ??
                    material.title,
                  sourceBlockIds: allowedBlocks
                    .filter((block) => block.materialId === material.materialId)
                    .map((block) => block.id),
                },
              ],
            ];

      for (const [unitIndex, seedItems] of seeds.entries()) {
        if (remainingUnitSlots <= 0) break;
        const seed = seedItems[0]!;
        const blockIds = new Set(seedItems.flatMap((item) => item.sourceBlockIds));
        const sourceBlocks = allowedBlocks.filter((block) => blockIds.has(block.id)).slice(0, 100);
        if (sourceBlocks.length === 0) {
          const fallback = allowedBlocks.find((block) => block.materialId === material.materialId);
          if (fallback) sourceBlocks.push(fallback);
        }
        const concepts = input.concepts
          .filter(
            (concept) =>
              concept.materialId === material.materialId &&
              (blockIds.size === 0 || blockIds.has(concept.grounding.blockId)),
          )
          .slice(0, 30);
        const unitNumber = learningUnits.length + 1;
        const unitKey = `unit-${unitNumber}`;
        const visual =
          materialVisuals.find(
            (offer) =>
              seed.title !== null &&
              [offer.explanation.text, ...offer.explanation.importantConcepts]
                .join(' ')
                .toLocaleLowerCase()
                .includes(seed.title.toLocaleLowerCase()),
          ) ?? primaryVisual;
        const title = (
          seed.title ||
          concepts[0]?.name ||
          visual?.explanation.importantConcepts[0] ||
          visual?.explanation.visualType ||
          material.title
        ).slice(0, 300);
        const sourceBlockIds = new Set(sourceBlocks.map((block) => block.id));
        const authorityEnvelope = input.authorityEnvelopes?.find((envelope) =>
          envelope.sourceBlockIds.some((blockId) => sourceBlockIds.has(blockId)),
        );
        const evidence = input.evidenceCatalog
          .filter((offer) => sourceBlockIds.has(offer.blockId))
          .filter(
            (offer, index, offers) =>
              offers.findIndex((candidate) => candidate.blockId === offer.blockId) === index,
          )
          .slice(0, 100)
          .map((offer) => ({ evidenceId: offer.id }));
        const primaryEvidenceOffer = input.evidenceCatalog.find(
          (offer) => offer.id === evidence[0]?.evidenceId,
        );
        const supportsExplain = Boolean(
          primaryEvidenceOffer?.quote.includes('[SUPPORTS:explain]') &&
          authorityEnvelope?.supportedConstructs.includes('explain'),
        );
        const exactIdentify = fakeExactIdentifyObjective(primaryEvidenceOffer?.quote ?? '', title);
        const objectiveTitle = supportsExplain
          ? `Understand ${title}`.slice(0, 300)
          : exactIdentify.title;
        const objectiveDescription = supportsExplain
          ? `Explain the source-supported ideas in ${title}.`
          : exactIdentify.description;
        const conceptIdSet = new Set(concepts.map((concept) => concept.id));
        const canonicalConceptIds = input.canonicalConcepts
          .filter((canonical) =>
            canonical.sourceConceptIds.some((conceptId) => conceptIdSet.has(conceptId)),
          )
          .map((canonical) => canonical.id)
          .slice(0, 20);
        const unit: ProposedCurriculumNode = {
          key: unitKey,
          parentKey: sectionKey,
          kind: 'learning_unit',
          index: unitIndex,
          title,
          structuralUnitIds: seedItems
            .flatMap((item) => [item.structuralUnitId, item.parentStructuralUnitId])
            .filter((id): id is string => id !== null)
            .filter((id, index, values) => values.indexOf(id) === index)
            .slice(0, 500),
          sourceEvidence: evidence,
          conceptIds: concepts.map((concept) => concept.id),
          canonicalConceptIds,
          objectives: [
            {
              key: `objective-${unitNumber}`,
              construct:
                this.curriculumObjectiveConstructFixture ??
                (supportsExplain ? ('explain' as const) : ('identify' as const)),
              title: objectiveTitle,
              description: objectiveDescription.slice(0, 1000),
              subjectClass: 'source_specific' as const,
              scopeOrigin: 'anchored' as const,
              evidence: evidence.slice(0, 5),
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

    const recoveryAssignments = new Map<
      ProposedCurriculumNode,
      Array<{
        requirement: (typeof capabilityRequirements)[number];
        evidenceId: string;
        requirementIndex: number;
      }>
    >();
    const evidenceOfferById = new Map(input.evidenceCatalog.map((offer) => [offer.id, offer]));
    const rankedLegacyCandidates = capabilityRequirements.map((requirement) => {
      const allowedEvidenceIds = new Set(requirement.allowedEvidenceIds);
      return learningUnits
        .map((unit, unitIndex) => {
          const unitSourceBlockIds = new Set(
            unit.sourceEvidence.flatMap((selection) => {
              const blockId = evidenceOfferById.get(selection.evidenceId)?.blockId;
              return blockId ? [blockId] : [];
            }),
          );
          const evidence = input.evidenceCatalog
            .flatMap((offer, evidenceIndex) => {
              const supportRank = fakeSemanticEvidenceSupportRank({
                proposition: requirement.originalProposition,
                construct: requirement.construct,
                evidence: offer.quote,
              });
              if (supportRank === null) return [];
              return [
                {
                  selection: { evidenceId: offer.id },
                  offer,
                  evidenceIndex,
                  supportRank,
                },
              ];
            })
            .filter(
              ({ selection, offer }) =>
                allowedEvidenceIds.has(selection.evidenceId) &&
                unitSourceBlockIds.has(offer.blockId),
            )
            .sort(
              (left, right) =>
                left.supportRank - right.supportRank || left.evidenceIndex - right.evidenceIndex,
            )[0];
          return {
            unit,
            unitIndex,
            evidence,
          };
        })
        .filter(
          (
            candidate,
          ): candidate is typeof candidate & { evidence: NonNullable<typeof candidate.evidence> } =>
            candidate.evidence !== undefined,
        );
    });
    const legacyCandidateKeysByRequirement = rankedLegacyCandidates.map((candidates) =>
      candidates.map((candidate) => candidate.unit.key),
    );
    const remainingCapacityByUnitKey = new Map<string, number>(
      learningUnits.map((unit) => [unit.key, 30] as const),
    );
    for (const [requirementIndex, requirement] of capabilityRequirements.entries()) {
      const eligible = rankedLegacyCandidates[requirementIndex]!.filter(
        ({ unit }) => (remainingCapacityByUnitKey.get(unit.key) ?? 0) > 0,
      ).sort((left, right) => {
        const leftAssigned = recoveryAssignments.get(left.unit)?.length ?? 0;
        const rightAssigned = recoveryAssignments.get(right.unit)?.length ?? 0;
        return (
          left.evidence.supportRank - right.evidence.supportRank ||
          Number(leftAssigned === 0) - Number(rightAssigned === 0) ||
          left.unitIndex - right.unitIndex
        );
      });
      const selected = eligible.find(({ unit }) => {
        const remaining = new Map(remainingCapacityByUnitKey);
        remaining.set(unit.key, remaining.get(unit.key)! - 1);
        return hasResidualPlacement(
          legacyCandidateKeysByRequirement,
          requirementIndex + 1,
          remaining,
        );
      });
      if (!selected?.evidence) {
        throw ProviderError.invalidOutput(
          `No eligible LearningUnit can preserve recovery capability ${requirement.capabilityRef}`,
        );
      }
      const assignments = recoveryAssignments.get(selected.unit) ?? [];
      assignments.push({
        requirement,
        evidenceId: selected.evidence.selection.evidenceId,
        requirementIndex,
      });
      recoveryAssignments.set(selected.unit, assignments);
      remainingCapacityByUnitKey.set(
        selected.unit.key,
        remainingCapacityByUnitKey.get(selected.unit.key)! - 1,
      );
    }
    let objectiveCount = 0;
    for (const unit of learningUnits) {
      const assignments = recoveryAssignments.get(unit);
      if (assignments && assignments.length > 0) {
        unit.objectives = assignments.map(({ requirement, evidenceId, requirementIndex }) => ({
          key: `recovery-objective-${requirementIndex + 1}`,
          title: requirement.title,
          description: requirement.description,
          construct: requirement.construct,
          subjectClass: requirement.subjectClass ?? ('source_specific' as const),
          scopeOrigin: requirement.scopeOrigin ?? ('anchored' as const),
          evidence: [{ evidenceId }],
          capabilityRequirementRef: requirement.capabilityRef,
          priority: requirement.priority,
          priorityRationale:
            'This objective preserves a non-optional predecessor capability for independent evaluation.',
        }));
      }
      objectiveCount += unit.objectives.length;
    }
    if (objectiveCount > maxObjectives) {
      throw ProviderError.invalidOutput(
        'Curriculum recovery placement exceeds the objective budget',
      );
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

    const candidate: CurriculumProposalPayload = {
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
    const firstValidation = opts?.validateCandidate?.(candidate);
    if (!firstValidation || firstValidation.valid) return candidate;

    opts?.onRepairAttempt?.('candidate');
    const repairedValidation = opts?.validateCandidate?.(candidate);
    if (!repairedValidation || repairedValidation.valid) return candidate;
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
    );
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

    const synthesisGroup = input.synthesisGroups.find((group) => {
      if (!input.allowedItemKinds.includes('synthesis') || group.learningUnitIds.length < 2) {
        return false;
      }
      const anchorId = group.learningUnitIds[0];
      const capability = input.launchCapabilities.find(
        (candidate) => candidate.curriculumLearningUnitId === anchorId,
      );
      return Boolean(
        capability?.allowedItemKinds.includes('synthesis') &&
        group.learningUnitIds.every((unitId) => routeGateByUnitId.has(unitId)),
      );
    });
    if (synthesisGroup) {
      const anchorId = synthesisGroup.learningUnitIds[0]!;
      const objectiveIds = synthesisGroup.objectiveIds
        .filter((objectiveId) =>
          synthesisGroup.learningUnitIds.some((unitId) =>
            unitById.get(unitId)?.objectiveIds.includes(objectiveId),
          ),
        )
        .slice(0, 30);
      items.push({
        key: `item-${items.length + 1}`,
        phase: 'Synthesis checkpoint',
        kind: 'synthesis',
        curriculumLearningUnitId: anchorId,
        rationale: `Integrate the linked units in ${synthesisGroup.title}.`,
        estimatedMinutes: 20,
        targetDepth: allowedDepth,
        objectiveIds,
        prerequisiteItemKeys: synthesisGroup.learningUnitIds
          .map((unitId) => routeGateByUnitId.get(unitId))
          .filter((key): key is string => Boolean(key)),
      });
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

  async respondToTutorTurn(
    input: TutorTurnInput,
    opts?: ProviderCallOptions,
  ): Promise<TutorTurnPayload> {
    await this.gate(opts);
    const focus = input.session.currentAgendaItem?.reason ?? 'the current study goal';
    const question = input.learnerMessage.trim();
    const lower = question.toLocaleLowerCase();
    const requested: TutorPedagogicalMove = /正式检验|正式检查|formal checkpoint/u.test(lower)
      ? 'FORMAL_CHECK_READY'
      : /举个例子|给个例子|例子|example|for example/u.test(lower)
        ? 'GIVE_EXAMPLE'
        : /区别|不同|对比|差异|versus/u.test(lower)
          ? 'CONTRAST'
          : /总结|概括|小结|summary|summarize/u.test(lower)
            ? 'SUMMARIZE'
            : /换个说法|换一种说法|通俗|简单点|没懂|不懂|不明白|看不懂|^\s*[?？]\s*$/u.test(lower)
              ? 'SIMPLIFY'
              : /^(?:继续|接着讲|下一段|继续学习|continue|next)\s*[.!。！!]*$/u.test(lower)
                ? 'RETURN_TO_ROUTE'
                : /顺便|另外|题外|side question/u.test(lower)
                  ? 'DETOUR'
                  : /直接告诉我答案|告诉我答案|just tell me the answer|为什么|为何|如何|怎么|why|how|什么是|what/u.test(
                        lower,
                      ) || /[?？]/u.test(question)
                    ? 'ANSWER_QUESTION'
                    : 'EXPLAIN_DEEPER';
    const move = input.allowedMoves.includes(requested)
      ? requested
      : requested === 'FORMAL_CHECK_READY' && input.allowedMoves.includes('ANSWER_QUESTION')
        ? 'ANSWER_QUESTION'
        : input.recentMoves.at(-1)?.move === requested
          ? requested === 'SIMPLIFY'
            ? 'GIVE_EXAMPLE'
            : 'EXPLAIN_DEEPER'
          : (input.allowedMoves[0] ?? 'ANSWER_QUESTION');
    const sourceRefs =
      input.offeredSourceRefs.length > 0 && move !== 'GIVE_ANALOGY'
        ? [input.offeredSourceRefs[0]!.referenceKey]
        : [];
    const teachingLead =
      move === 'GIVE_EXAMPLE'
        ? '先看一个具体例子'
        : move === 'CONTRAST'
          ? '把两个容易混淆的点并排比较'
          : move === 'SUMMARIZE'
            ? '先把这一段压缩成几个要点'
            : move === 'SIMPLIFY'
              ? '换一种更简单的说法'
              : move === 'RETURN_TO_ROUTE'
                ? '我们回到当前课程路线'
                : move === 'DETOUR'
                  ? '这个旁支问题和当前目标有关,我们先短暂展开'
                  : '直接回答你的问题';
    const validCandidate: TutorTurnPayload = {
      move,
      text: `${teachingLead}: ${focus}。你问的是“${question}”。${move === 'RETURN_TO_ROUTE' ? '接下来继续当前段落,不会改变学习路线。' : '我会把关键点讲清楚,再用一句话连接回当前目标。'}`,
      sourceRefs,
      routeSignal:
        move === 'DETOUR'
          ? 'detour_started'
          : move === 'RETURN_TO_ROUTE'
            ? 'return_to_route'
            : 'stay_on_route',
      summaryDelta: {
        learnerQuestions: [question.slice(0, 500)],
        unresolvedConfusion: [],
        explanationsTried: [`Responded to the learner question about ${focus}`.slice(0, 500)],
        learnerReactions: [],
        openActions: [],
        safetyFlags: [],
      },
      suggestedActions: [],
    };
    const fixture = this.tutorTurnFixture;
    if (!fixture) return validCandidate;
    const firstCall = this.tutorTurnFixtureCalls++ === 0;
    const invalidCandidate: unknown =
      fixture === 'invalid_source_ref'
        ? { ...validCandidate, sourceRefs: ['FOREIGN_REF'] }
        : fixture === 'unsupported_move'
          ? { ...validCandidate, move: 'UNSUPPORTED_MOVE' }
          : fixture === 'semantic_invalid'
            ? { ...validCandidate, move: 'SELF_EXPLANATION' }
            : fixture === 'malformed_json'
              ? '{"move":"ANSWER_QUESTION"'
              : fixture === 'repair_once' && firstCall
                ? { ...validCandidate, sourceRefs: ['FOREIGN_REF'] }
                : fixture === 'repair_exhausted'
                  ? { ...validCandidate, sourceRefs: ['FOREIGN_REF'] }
                  : validCandidate;
    const firstValidation = opts?.validateCandidate?.(invalidCandidate);
    if (!firstValidation || firstValidation.valid) return invalidCandidate as TutorTurnPayload;
    opts?.onRepairAttempt?.('candidate');
    await this.gate(opts);
    const repairedCandidate = fixture === 'repair_exhausted' ? invalidCandidate : validCandidate;
    const repairedValidation = opts?.validateCandidate?.(repairedCandidate);
    if (!repairedValidation || repairedValidation.valid) {
      return repairedCandidate as TutorTurnPayload;
    }
    throw ProviderError.invalidOutput(
      repairedValidation.diagnostics.join('; ').slice(0, 8_000),
      'candidate',
    );
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
