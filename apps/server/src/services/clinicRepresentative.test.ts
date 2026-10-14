import { describe, it, expect } from 'vitest';
import { fixture, cmd } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type { PlanInput, QuestionsInput, SolveInput, PlanOutput } from '../llm/courseContract.js';
import { sha256 } from '../util/canonical.js';

describe('代表性整卷不逐教材K穷尽 A08/A09', () => {
  it.each(['course', 'module'])(
    '300个教学K、5个核心cell的%s卷保持代表抽样；重考轮换，旧成绩与未测K保留',
    async (scope) => {
      class Representative extends CourseFakeProvider {
        override get outputCap() {
          return 1_000_000;
        }
        override async generateCoursePlan(input: PlanInput): Promise<PlanOutput> {
          this.calls.generateCoursePlan = (this.calls.generateCoursePlan ?? 0) + 1;
          const groups = Array.from({ length: 5 }, (_, i) =>
            input.knowledge.slice(i * 60, (i + 1) * 60),
          );
          const lessons = groups.map((k, i) => ({
            id: `lesson${i}`,
            moduleId: 'm',
            title: `核心领域${i}`,
            summary: '整合关联命题的解释能力。',
            knowledgeIds: k.map((k) => k.id),
            objectives: [
              {
                id: `objective${i}`,
                title: `解释核心领域${i}`,
                knowledgeIds: k.map((k) => k.id),
                demand: 'understand' as const,
              },
            ],
            prerequisiteLessonIds: [],
            recommendedDepth: 'standard' as const,
            selectedDepth: 'standard' as const,
            estimatedMinutes: 60,
          }));
          const domains = groups.map((k, i) => ({
            id: `domain${i}`,
            title: `领域${i}`,
            knowledgeIds: k.map((k) => k.id),
            coreObjectiveIds: [`objective${i}`],
            required: true,
            rationale: '测试核心解释能力，细节作为代表抽样。',
          }));
          const cells = groups.map((k, i) => ({
            id: `cell${i}`,
            domainId: `domain${i}`,
            objectiveIds: [`objective${i}`],
            demand: 'understand' as const,
            difficultyBand: 'standard' as const,
            mandatoryKnowledgeIds: [k[0]!.id],
            representativeSets: [
              { id: `representative${i}`, candidateKnowledgeIds: k.slice(1).map((k) => k.id) },
            ],
            weight: 1,
            rationale: '关键命题加实质细节代表，范围和难度固定。',
          }));
          return {
            title: input.title,
            modules: [{ id: 'm', title: input.title }],
            lessons,
            assessmentDesign: { domains, cells, requiredCellIds: cells.map((c) => c.id) },
          };
        }
        override async generateQuestions(input: QuestionsInput) {
          this.calls.generateQuestions = (this.calls.generateQuestions ?? 0) + 1;
          return {
            questions: input.slots.map((slot) => {
              const knowledge = input.knowledge.filter((k) => slot.knowledgeIds.includes(k.id));
              const statement = knowledge.map((k) => k.statement).join('；');
              const cell = input.blueprint!.cells.find((c) => slot.cellIds.includes(c.id))!;
              return {
                id: `q_${slot.id}`,
                slotId: slot.id,
                type: 'single_choice' as const,
                prompt: `新情境 ${sha256({ slot: slot.id, prior: input.previousQuestions.length }).slice(0, 8)}：哪一项同时保持该领域的核心命题和选定代表的条件？`,
                options: [
                  { id: 'A', text: statement },
                  { id: 'B', text: '可以完全忽略条件。' },
                ],
                answer: ['A'],
                explanation: statement,
                rubric: [],
                knowledgeIds: slot.knowledgeIds,
                sourceRefs: knowledge.flatMap((k) => k.sourceSpans),
                origin: 'textbook' as const,
                difficultyBand: cell.difficultyBand,
                demand: cell.demand,
                coverage: [
                  {
                    cellId: cell.id,
                    criterionIds: ['answer'],
                    assessedKnowledgeIds: slot.knowledgeIds,
                    representativeSetIds: cell.representativeSets
                      .filter((set) =>
                        set.candidateKnowledgeIds.some((id) => slot.knowledgeIds.includes(id)),
                      )
                      .map((set) => set.id),
                    demand: cell.demand,
                    ...(input.blueprint!.objectiveRequirements
                      ? { objectiveIds: cell.objectiveIds }
                      : {}),
                  },
                ],
              };
            }),
          };
        }
        override async solveQuestion(input: SolveInput) {
          this.calls.solveQuestion = (this.calls.solveQuestion ?? 0) + 1;
          return {
            solvable: true,
            answer: ['A'],
            explanation: input.requestedKnowledge.map((k) => k.statement).join('；'),
            missingConditions: [],
            ambiguities: [],
            sourceSupported: true,
            uncertain: false,
            exposureCheck: { novel: true, reason: '测试夹具的新情境' },
            assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
            ...(input.expectedObjectives
              ? { assessedObjectiveIds: input.expectedObjectives.map((o) => o.id) }
              : {}),
            coverage: input.expectedCells.map((cell) => ({
              cellId: cell.id,
              criterionIds: ['answer'],
              assessedKnowledgeIds: input.requestedKnowledge.map((k) => k.id),
              representativeSetIds: cell.representativeSets
                .filter((s) =>
                  s.candidateKnowledgeIds.some((id) =>
                    input.requestedKnowledge.some((k) => k.id === id),
                  ),
                )
                .map((s) => s.id),
              demand: cell.demand,
              ...(input.expectedObjectives ? { objectiveIds: cell.objectiveIds } : {}),
            })),
          };
        }
      }
      const provider = new Representative();
      const f = fixture(provider);
      try {
        await f.c.sources.import(f.workspace.id, {
          content: Array.from(
            { length: 300 },
            (_, i) => `# 独立命题${i}\n\n命题${i}描述完整对象之间的关系，并保留相应的适用范围。`,
          ).join('\n\n'),
        });
        await f.settle(
          f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
            sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
          }),
        );
        const plan = f.accept(f.c.planning.get(f.workspace.id)!);
        expect(plan.teachingRequiredKnowledgeIds).toHaveLength(300);
        expect(plan.assessmentBlueprint.requiredCellIds).toHaveLength(5);
        const selections: string[][] = [];
        for (let i = 0; i < 2; i++) {
          const op = await f.settle(
            f.c.operations.start(
              f.workspace.id,
              cmd(),
              'prepareFormal',
              `formal:representative${i}`,
              'formal',
              {
                curriculumId: plan.id,
                blueprintId: plan.assessmentBlueprint.id,
                paperRequestId: `paper${i}`,
                ...(scope === 'module' ? { moduleId: 'm' } : {}),
              },
            ),
          );
          const paper = f.c.questions.get(f.workspace.id, op.resourceId!);
          expect(paper.items).toHaveLength(5);
          expect(paper.items.flatMap((q) => q.knowledgeIds)).toHaveLength(10);
          selections.push(
            paper.paperCoverageSelection.flatMap((s) =>
              s.representatives.map((r) => r.knowledgeId),
            ),
          );
          f.c.grading.startFormal(f.workspace.id, paper.id, cmd());
          await f.submit(paper, true);
        }
        expect(selections[0]).not.toEqual(selections[1]);
        expect(f.c.records(f.workspace.id).formalGrades).toHaveLength(2);
        expect(
          f.c.progress(f.workspace.id).knowledge.filter((k) => k.formalStatus === 'untested')
            .length,
        ).toBeGreaterThan(280);
        expect(provider.calls.gradeShortAnswer ?? 0).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
});
