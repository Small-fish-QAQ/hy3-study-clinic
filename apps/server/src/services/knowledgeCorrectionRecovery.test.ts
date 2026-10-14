import { expect, it } from 'vitest';
import { fixture, cmd, GOLDEN_TEXT } from '../testing/clinicFixture.js';
import { CourseFakeProvider } from '../llm/courseFakeProvider.js';
import type {
  KnowledgeInput,
  KnowledgeOutput,
  KnowledgeReviewInput,
} from '../llm/courseContract.js';
import type { CourseKnowledgeInventory } from '@hy3-clinic/shared';
import { sha256 } from '../util/canonical.js';

it.each([false, true])(
  '知识与Lesson责任分开；仅更正指定K并保留旧版本，legacy判定反转=%s',
  async (legacy) => {
    class CrossPacket extends CourseFakeProvider {
      corrections: KnowledgeInput[] = [];
      reviewInputs: KnowledgeReviewInput[] = [];
      positive = false;
      override async extractCourseKnowledge(input: KnowledgeInput) {
        const generated = await super.extractCourseKnowledge(input);
        if (input.revision?.localRefs) {
          this.corrections.push(input);
          const draft = input.revision.draft as KnowledgeOutput;
          return {
            ...draft,
            knowledge: draft.knowledge.map((k, i) => ({
              ...k,
              statement: input.revision!.localRefs!.includes(k.localRef)
                ? input.blocks[i]!.text.trim()
                : '不应采用的健康知识改写',
              uncertaintyCodes: [],
            })),
          };
        }
        generated.knowledge[0]!.statement += '（本包后续内容缺失）';
        generated.knowledge[0]!.kind = 'condition';
        return generated;
      }
      override async reviewKnowledgeScope(input: KnowledgeReviewInput) {
        this.reviewInputs.push(input);
        const value = await super.reviewKnowledgeScope(input);
        const wrong = input.knowledge.find((k) => k.statement.includes('本包后续'));
        return input.lessons && wrong && !this.positive
          ? {
              ...value,
              accepted: false,
              findings: ['工作包的可见范围不能变成教材事实'],
              issues: [
                {
                  ...(legacy ? {} : { target: 'knowledge' as const }),
                  code: 'false_statement' as const,
                  knowledgeIds: [wrong.id],
                  lessonIds: [input.lessons[0]!.id],
                  message: '工作包的可见范围不能变成教材事实',
                },
              ],
            }
          : value;
      }
    }
    const provider = new CrossPacket(),
      f = fixture(provider);
    try {
      await f.c.sources.import(f.workspace.id, { content: GOLDEN_TEXT });
      const op = f.c.operations.start(f.workspace.id, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash: f.c.sources.scopeHash(f.workspace.id),
      });
      await f.c.operations.idle();
      const failed = f.c.operations.get(f.workspace.id, op.id);
      expect(failed.status).toBe('failed');
      const old = f.c.repo.payload<CourseKnowledgeInventory>(
        'SELECT payload FROM course_knowledge_inventories',
      )!;
      const oldHash = sha256(old);
      const candidate = f.c.repo.payload<{ value: unknown; findings: { code: string }[] }>(
        'SELECT payload FROM course_plan_candidates ORDER BY rowid DESC LIMIT 1',
      )!;
      expect(candidate.findings[0]!.code).toBe(
        legacy ? 'semantic_plan' : 'knowledge_requires_revision',
      );
      if (legacy) {
        // Reproduce a later complete positive judgment on unchanged content.
        // The first negative remains physical evidence; it must not be erased.
        provider.positive = true;
        const input = provider.reviewInputs.find((v) => v.lessons)!;
        await f.c.generation.stage(
          {
            workspaceId: f.workspace.id,
            operationId: null,
            provider,
            signal: new AbortController().signal,
            check() {},
          },
          'reviewKnowledgeScope',
          input,
          sha256(input.blocks),
          (await import('../llm/courseContract.js')).ScopeReviewSchema,
          (opts) => provider.reviewKnowledgeScope(input, opts),
        );
      }
      await f.settle(f.c.operations.retry(f.workspace.id, failed.id, cmd(), failed.version));
      const plan = f.c.planning.get(f.workspace.id)!;
      const corrected = f.c.planning.inventory(plan);
      expect(corrected.id).not.toBe(old.id);
      expect(corrected.knowledge.map((k) => k.id)).toEqual(old.knowledge.map((k) => k.id));
      expect(corrected.knowledge.slice(1)).toEqual(old.knowledge.slice(1));
      expect(corrected.knowledge[0]!.statement).not.toContain('本包后续');
      expect(sha256(f.c.repo.owned('course_knowledge_inventories', old.id, f.workspace.id))).toBe(
        oldHash,
      );
      expect(provider.calls.extractCourseKnowledge).toBe(2);
      expect(provider.calls.generateCoursePlan).toBe(1);
      expect(provider.calls.reviseCoursePlan).toBeUndefined();
      expect(provider.corrections[0]!.revision!.localRefs).toHaveLength(1);
      expect(provider.corrections[0]!.referenceText).toContain('跨章关系');
      const rebound = f.c.repo.payload<{ value: unknown }>(
        'SELECT payload FROM course_plan_candidates WHERE inventory_id=? ORDER BY rowid DESC LIMIT 1',
        corrected.id,
      )!;
      expect(rebound.value).toEqual(candidate.value);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
