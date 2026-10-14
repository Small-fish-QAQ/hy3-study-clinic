import { describe, it, expect } from 'vitest';
import {
  CourseCommandSchema,
  CourseRepairRoundSchema,
  LessonAuthorSchema,
  CoursePlanSchema,
} from './course.js';
import {
  SchedulerConfigurationSchema,
  REVIEW_ALGORITHM_GENERATION,
  REVIEW_PACKAGE_NAME,
  REVIEW_PACKAGE_VERSION,
  REVIEW_ADAPTER_VERSION,
  REVIEW_RATING_POLICY_VERSION,
} from './review.js';
describe('当前合同与资源边界', () => {
  it('命令严格拒绝客户端成绩/authority', () => {
    expect(
      CourseCommandSchema.safeParse({ commandId: 'c', idempotencyKey: 'k', score: 1 }).success,
    ).toBe(false);
  });
  it('Repair ordinal没有终身三次上限，系统与学习结果分离', () => {
    const round = {
      id: 'r',
      workspaceId: 'w',
      originKind: 'submission',
      originId: 's',
      targetItemIds: ['q'],
      ordinal: 10,
      status: 'failed',
      learnerOutcome: null,
      explanation: '',
      retestQuizId: null,
      retestSubmissionId: null,
      operationId: 'op',
      version: 1,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
    };
    expect(CourseRepairRoundSchema.parse(round).ordinal).toBe(10);
    expect(CourseRepairRoundSchema.safeParse({ ...round, ordinal: 0 }).success).toBe(false);
  });
  it('Lesson段数不继承12段业务上限', () => {
    const lesson = {
      title: '完整讲解',
      segments: Array.from({ length: 31 }, (_, i) => ({
        id: `s${i}`,
        kind: 'explanation',
        text: '短而完整的命题说明。',
        origin: 'extension',
        sourceRefs: [],
        uncertaintyCodes: [],
      })),
      teachingCoverage: [
        {
          knowledgeId: 'k',
          objectiveIds: ['o'],
          segmentId: 's0',
          teachingQuote: '短而完整的命题说明。',
        },
      ],
    };
    expect(LessonAuthorSchema.parse(lesson).segments).toHaveLength(31);
  });
  it('持久FSRS配置允许不同retention与horizon，回放必须使用该配置', () => {
    const c = SchedulerConfigurationSchema.parse({
      version: 'custom',
      algorithmGeneration: REVIEW_ALGORITHM_GENERATION,
      packageName: REVIEW_PACKAGE_NAME,
      packageVersion: REVIEW_PACKAGE_VERSION,
      localAdapterVersion: REVIEW_ADAPTER_VERSION,
      ratingPolicyVersion: REVIEW_RATING_POLICY_VERSION,
      requestedRetention: 0.8,
      configHash: 'custom',
      fuzz: false,
      shortTerm: false,
      maximumDueHorizonDays: 100,
      effectiveAt: '2026-10-12T00:00:00.000Z',
      retiredAt: null,
    });
    expect(c.requestedRetention).toBe(0.8);
  });
  it('旧规划payload无法通过当前单一decoder', () => {
    expect(CoursePlanSchema.safeParse({ formatVersion: 1, nodes: [] }).success).toBe(false);
  });
});
