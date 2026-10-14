import {
  COURSE_POLICY,
  type CourseQuestion,
  type CourseKnowledge,
  type CourseDemand,
} from '@hy3-clinic/shared';
import { stableId } from '../util/canonical.js';
import type { ProviderCallOptions } from './provider.js';
import { ProviderError } from './errors.js';
import type {
  CourseProvider,
  KnowledgeInput,
  PlanInput,
  KnowledgeReviewInput,
  LessonInput,
  LessonVerificationInput,
  QuestionsInput,
  SolveInput,
  RubricReviewInput,
  RepairRoundInput,
  ShortAnswerInput,
  CourseTutorInput,
  CoursePlanningOutput,
  PlanRevisionInput,
  PlanRevisionOutput,
} from './courseContract.js';

/** Deterministic offline demonstrations still pass through the production validators. */
export class CourseFakeProvider implements CourseProvider {
  readonly name = 'fake' as const;
  readonly model = 'offline-fixture';
  readonly endpointIdentity = 'local:fake';
  readonly runtimeIdentity = `fake:${COURSE_POLICY}`;
  get outputCap() {
    return 64_000;
  }
  readonly calls: Record<string, number> = {};
  private invoke(method: string, opts?: ProviderCallOptions) {
    if (opts?.signal?.aborted) throw ProviderError.cancelled();
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }
  async extractCourseKnowledge(input: KnowledgeInput, opts?: ProviderCallOptions) {
    this.invoke('extractCourseKnowledge', opts);
    const knowledge = input.blocks.map((block, i) => {
      const lines = block.text.split('\n').filter((s) => s.trim() && !/^#+\s/.test(s));
      const statement = lines.join('\n') || block.text;
      return {
        localRef: `k${i}`,
        title: block.headingPath.at(-1) ?? `知识${i + 1}`,
        statement,
        kind: (/例外|except/iu.test(statement)
          ? 'exception'
          : /如果|仅当|provided|unless/iu.test(statement)
            ? 'condition'
            : /步骤|procedure/iu.test(statement)
              ? 'procedure'
              : 'concept') as CourseKnowledge['kind'],
        origin: 'textbook' as const,
        sourceSpans: [
          { revisionId: block.revisionId, blockId: block.id, start: block.start, end: block.end },
        ],
        prerequisiteKnowledgeIds: [],
        relatedKnowledgeIds: [],
        uncertaintyCodes: [],
      };
    });
    return {
      knowledge,
      dispositions: input.blocks.map((block, i) => ({
        span: {
          revisionId: block.revisionId,
          blockId: block.id,
          start: block.start,
          end: block.end,
        },
        knowledgeIds: [`k${i}`],
        exclusion: null,
      })),
    };
  }
  async generateCoursePlan(
    input: PlanInput,
    opts?: ProviderCallOptions,
  ): Promise<CoursePlanningOutput> {
    this.invoke('generateCoursePlan', opts);
    if (input.mode === 'join') return { modules: [], links: [] };
    if (input.mode === 'outline')
      return {
        modules: Array.from({ length: Math.ceil(input.knowledge.length / 3) }, (_, i) => ({
          id: stableId(
            'module_outline',
            input.knowledge.slice(i * 3, i * 3 + 3).map((k) => k.id),
          ),
          title: input.knowledge[i * 3]!.title,
          knowledgeIds: input.knowledge.slice(i * 3, i * 3 + 3).map((k) => k.id),
        })),
        links: [],
      };
    const groups: CourseKnowledge[][] = [];
    // Fixture grouping is an offline curriculum example, not a product limit.
    for (let i = 0; i < input.knowledge.length; i += 3)
      groups.push(input.knowledge.slice(i, i + 3));
    const suffix = stableId(
      'scope',
      input.knowledge.map((k) => k.id),
    ).slice(-8);
    const moduleId = `module_${suffix}`;
    // The fake author follows the same selected-depth input contract.
    const requestedDemand: CourseDemand =
      input.preferences?.desiredDepth === 'advanced'
        ? 'design'
        : input.preferences?.desiredDepth === 'proficient'
          ? 'evaluate'
          : input.preferences?.desiredDepth === 'standard'
            ? 'apply'
            : 'understand';
    const lessons = groups.map((group, i) => ({
      id: `lesson_${suffix}_${i}`,
      moduleId,
      title: group.map((k) => k.title).join(' · '),
      summary: `理解并运用${group.map((k) => k.title).join('、')}。`,
      knowledgeIds: group.map((k) => k.id),
      objectives: [
        {
          id: `objective_${suffix}_${i}`,
          title: `解释${group[0]!.title}并保留适用条件`,
          knowledgeIds: group.map((k) => k.id),
          demand: requestedDemand,
        },
      ],
      prerequisiteLessonIds: i ? [`lesson_${suffix}_${i - 1}`] : [],
      recommendedDepth: 'standard' as const,
      selectedDepth: input.preferences?.desiredDepth ?? 'standard',
      estimatedMinutes: 20,
    }));
    const domains = lessons.map((lesson, i) => ({
      id: `domain_${suffix}_${i}`,
      title: lesson.title,
      knowledgeIds: lesson.knowledgeIds,
      coreObjectiveIds: lesson.objectives.map((o) => o.id),
      required: true,
      rationale: '按相关知识组成教学与考核领域。',
    }));
    const cells = lessons.map((lesson, i) => ({
      id: `cell_${suffix}_${i}`,
      domainId: domains[i]!.id,
      objectiveIds: lesson.objectives.map((o) => o.id),
      demand: requestedDemand,
      difficultyBand: 'standard' as const,
      mandatoryKnowledgeIds: [],
      representativeSets: [
        { id: `representative_${suffix}_${i}`, candidateKnowledgeIds: lesson.knowledgeIds },
      ],
      weight: 1,
      rationale: '通过代表命题测试解释能力，背景细节无需逐项出题。',
    }));
    return {
      title: input.title,
      modules: [{ id: moduleId, title: input.title }],
      lessons,
      assessmentDesign: { domains, cells, requiredCellIds: cells.map((c) => c.id) },
    };
  }
  async reviewKnowledgeScope(input: KnowledgeReviewInput, opts?: ProviderCallOptions) {
    this.invoke('reviewKnowledgeScope', opts);
    return { accepted: true, findings: [], checkedKnowledgeIds: input.knowledge.map((k) => k.id) };
  }
  async reviseCoursePlan(
    input: PlanRevisionInput,
    opts?: ProviderCallOptions,
  ): Promise<PlanRevisionOutput> {
    this.invoke('reviseCoursePlan', opts);
    return structuredClone(input.draft);
  }
  async generateLesson(input: LessonInput, opts?: ProviderCallOptions) {
    this.invoke('generateLesson', opts);
    const segments = input.knowledge.map((k, i) => ({
      id:
        input.revision?.draft.teachingCoverage.find((c) => c.knowledgeId === k.id)?.segmentId ??
        `segment_${i}`,
      kind: 'explanation' as const,
      text: `${k.title}：${k.statement}${
        {
          introductory: '\n先抓住这条关系，再用自己的话解释。',
          standard: '\n应用时先核对原文中的适用范围与条件，再推理新案例的结果。',
          proficient: '\n诊断失败时要辨析边界，比较相互作用的条件与约束取舍。',
          advanced: '\n在陌生情境中综合已有知识，逐项说明条件改变怎样影响迁移与设计判断。',
        }[input.lesson.selectedDepth]
      }`,
      origin: k.origin,
      sourceRefs: k.sourceSpans,
      uncertaintyCodes: [],
    }));
    return {
      title: input.lesson.title,
      segments,
      teachingCoverage: input.knowledge.map((k, i) => ({
        knowledgeId: k.id,
        objectiveIds: input.lesson.objectives
          .filter((o) => o.knowledgeIds.includes(k.id))
          .map((o) => o.id),
        segmentId: segments[i]!.id,
        teachingQuote: k.statement,
      })),
    };
  }
  async verifyLessonParts(input: LessonVerificationInput, opts?: ProviderCallOptions) {
    this.invoke('verifyLessonParts', opts);
    return {
      results: input.scopes.map((s) => ({
        scopeId: s.id,
        scopeHash: s.hash,
        accepted: true,
        findings: [],
        checkedKnowledgeIds: s.knowledgeIds,
      })),
    };
  }
  async generateQuestions(input: QuestionsInput, opts?: ProviderCallOptions) {
    this.invoke('generateQuestions', opts);
    return {
      questions: input.slots.map((slot) => {
        const selected = input.knowledge.filter((k) => slot.knowledgeIds.includes(k.id));
        const k = selected[0]!;
        const actual = input.blueprint?.objectiveRequirements ? selected : [k];
        const statement = actual.map((k) => k.statement).join('；');
        const nonce = stableId('context', {
          slot: slot.id,
          previous: input.previousQuestions.length,
        }).slice(-8);
        return {
          id: `question_${nonce}`,
          slotId: slot.id,
          type: 'single_choice' as const,
          prompt: `情境 ${nonce}：学习者复述“${k.title}”时，哪一项保留了原文命题与适用条件？`,
          options: [
            { id: 'A', text: statement },
            { id: 'B', text: '任何情况下都成立，无需检查条件。' },
            { id: 'C', text: '仅凭标题就能代替命题和条件。' },
          ],
          answer: ['A'],
          explanation: `正确复述为：${k.statement}`,
          rubric: [],
          knowledgeIds: actual.map((k) => k.id),
          sourceRefs: actual.flatMap((k) => k.sourceSpans),
          origin: k.origin,
          difficultyBand:
            input.blueprint?.cells.find((c) => slot.cellIds.includes(c.id))?.difficultyBand ??
            'standard',
          demand:
            input.blueprint?.cells.find((c) => slot.cellIds.includes(c.id))?.demand ?? 'understand',
          coverage: input.blueprint
            ? slot.cellIds.map((id) => {
                const cell = input.blueprint!.cells.find((c) => c.id === id)!;
                return {
                  cellId: id,
                  criterionIds: ['answer'],
                  assessedKnowledgeIds: actual.map((k) => k.id),
                  representativeSetIds: cell.representativeSets
                    .filter((s) => actual.some((k) => s.candidateKnowledgeIds.includes(k.id)))
                    .map((s) => s.id),
                  demand: cell.demand,
                  ...(input.blueprint!.objectiveRequirements
                    ? {
                        objectiveIds: input
                          .blueprint!.objectiveRequirements.filter(
                            (o) =>
                              cell.objectiveIds.includes(o.id) &&
                              actual.some((k) => o.knowledgeIds.includes(k.id)),
                          )
                          .map((o) => o.id),
                      }
                    : {}),
                };
              })
            : [],
        };
      }),
    };
  }
  async solveQuestion(input: SolveInput, opts?: ProviderCallOptions) {
    this.invoke('solveQuestion', opts);
    const matches = (text: string, statement: string) =>
      text === statement || (!!input.expectedObjectives && text.split('；').includes(statement));
    const correct = input.question.options.filter((o) =>
      input.requestedKnowledge.some((k) => matches(o.text, k.statement)),
    );
    const actual = input.requestedKnowledge
      .filter((k) => correct.some((o) => matches(o.text, k.statement)))
      .map((k) => k.id);
    return {
      solvable:
        correct.length > 0 && (input.question.type !== 'single_choice' || correct.length === 1),
      answer:
        input.question.type === 'short_answer'
          ? input.requestedKnowledge.map((k) => k.statement)
          : correct.map((o) => o.id),
      explanation: `应保留完整命题：${input.requestedKnowledge
        .filter((k) => actual.includes(k.id))
        .map((k) => k.statement)
        .join('；')}`,
      missingConditions: [],
      ambiguities: [],
      sourceSupported: input.requestedKnowledge.every(
        (k) => k.origin === 'extension' || k.sourceSpans.length > 0,
      ),
      uncertain: false,
      exposureCheck: {
        novel: true,
        reason: '离线夹具演示新的请求情境；真实语义新颖性须由实际模型核查。',
      },
      assessedKnowledgeIds: actual,
      ...(input.expectedObjectives
        ? {
            assessedObjectiveIds: input.expectedObjectives
              .filter((o) => actual.some((id) => o.knowledgeIds.includes(id)))
              .map((o) => o.id),
          }
        : {}),
      coverage: input.expectedCells
        .filter((c) =>
          actual.some(
            (id) =>
              c.mandatoryKnowledgeIds.includes(id) ||
              c.representativeSets.some((s) => s.candidateKnowledgeIds.includes(id)),
          ),
        )
        .map((c) => ({
          cellId: c.id,
          criterionIds: ['answer'],
          assessedKnowledgeIds: actual,
          representativeSetIds: c.representativeSets
            .filter((s) => actual.some((id) => s.candidateKnowledgeIds.includes(id)))
            .map((s) => s.id),
          demand: c.demand,
          ...(input.expectedObjectives
            ? {
                objectiveIds: input.expectedObjectives
                  .filter(
                    (o) =>
                      c.objectiveIds.includes(o.id) &&
                      actual.some((id) => o.knowledgeIds.includes(id)),
                  )
                  .map((o) => o.id),
              }
            : {}),
        })),
    };
  }
  async reviewQuestionRubric(input: RubricReviewInput, opts?: ProviderCallOptions) {
    this.invoke('reviewQuestionRubric', opts);
    return {
      accepted: true,
      uncertain: false,
      findings: [],
      criteria: input.rubric.map((c) => ({
        criterionId: c.id,
        supported: true,
        requiredByQuestion: true,
        alternativeChecks: c.acceptableAlternatives.map((text) => ({
          text,
          equivalent: true,
          reason: '与本机夹具的命题和条件等价',
        })),
        assessedKnowledgeIds: c.knowledgeIds,
      })),
      coverage: input.independentSolution.coverage,
    };
  }
  async generateRepairRound(input: RepairRoundInput, opts?: ProviderCallOptions) {
    this.invoke('generateRepairRound', opts);
    const questions = await this.fixtureRepairQuestion(input);
    return {
      explanation: `检查你上次忽略的命题与条件：${input.knowledge.map((k) => k.statement).join('；')}。随后用一个新情境再判断。`,
      sourceRefs: input.knowledge.flatMap((k) => k.sourceSpans),
      questions,
      teaching: {
        title: '本轮补救',
        segments: input.knowledge.map((k, i) => ({
          id: `repair_segment_${i}`,
          kind: 'explanation' as const,
          text: k.statement,
          origin: k.origin,
          sourceRefs: k.sourceSpans,
          uncertaintyCodes: [],
        })),
        teachingCoverage: input.knowledge.map((k, i) => ({
          knowledgeId: k.id,
          objectiveIds: [`repair_objective_${i}`],
          segmentId: `repair_segment_${i}`,
          teachingQuote: k.statement,
        })),
      },
    };
  }
  private async fixtureRepairQuestion(input: RepairRoundInput): Promise<CourseQuestion[]> {
    const count = this.calls.generateQuestions;
    const result = await this.generateQuestions({
      purpose: 'retest',
      slots: [{ id: input.slotId, knowledgeIds: input.knowledge.map((k) => k.id), cellIds: [] }],
      knowledge: input.knowledge,
      sources: input.sources,
      learnerVisibleContext: [],
      blueprint: null,
      previousQuestions: input.originalQuestions,
    });
    this.calls.generateQuestions = count ?? 0;
    return result.questions;
  }
  async gradeShortAnswer(input: ShortAnswerInput, opts?: ProviderCallOptions) {
    this.invoke('gradeShortAnswer', opts);
    const met = input.answer.some((a) => input.response.includes(a));
    return {
      criteria: input.rubric.map((c) => ({
        criterionId: c.id,
        met,
        reason: met ? '回答包含该要点。' : '尚未表达该要点。',
      })),
      feedback: met ? '回答满足评分要求。' : '请检查命题与适用条件。',
      confidence: 1,
      uncertain: false,
      evidenceFlags: [],
    };
  }
  async respondToTutorTurn(input: CourseTutorInput, opts?: ProviderCallOptions) {
    this.invoke('respondToTutorTurn', opts);
    return {
      text: `可以从当前讲解理解：${input.lesson.segments[0]?.text ?? ''}\n你问的是：${input.question}`,
      sourceRefs: input.lesson.segments[0]?.sourceRefs ?? [],
      includesExtension: false,
    };
  }
  async testConnection(opts?: ProviderCallOptions) {
    this.invoke('testConnection', opts);
  }
}
