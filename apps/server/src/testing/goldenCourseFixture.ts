import type { LearningContractDraftFields, MaterialRoleAssignment } from '@hy3-clinic/shared';
import { FakeProvider } from '../llm/fakeProvider.js';

/** Three separately imported notes: real source regions, without padding short headings. */
export const GOLDEN_UNITS = [
  {
    title: '工作记忆',
    paragraphs: [
      '工作记忆的容量有限；',
      '工作记忆暂时保持当前任务所需的信息；',
      '同时处理的内容过多会超过工作记忆容量；',
    ],
  },
  {
    title: '组块化',
    paragraphs: [
      '组块化把多个信息元素组织成一个有意义的整体；',
      '组块化依赖学习者已经掌握的知识结构；',
      '组块化减少需要同时保持的独立信息单元；',
    ],
  },
  {
    title: '复述',
    paragraphs: [
      '复述通过重复当前信息维持它在工作记忆中的可用性；',
      '复述维持信息但不会扩大工作记忆容量；',
      '停止复述后当前信息仍可能从工作记忆中丢失；',
    ],
  },
] as const;

/** Learner script over the existing, explicitly authored public Fake tasks.
 * Match visible text, never a position, private TeachingBrief, or saved answer key.
 */
export const GOLDEN_ANSWERS = {
  informal: '选择甲，完成请求并明确保留的误差风险。',
  guided: '乙继续等待，当前快照不足以支持它启动。',
  scaffold: '乙比当前空闲数多需要一个配额。',
  transfer: '由备用处理器接收乙，并在它自己的容量内分配资源。',
  practice: '完成处理没有归还配额，应检查完成事件到计数更新的链路。',
  wrongPractice: '新任务的优先级太低，只需提高优先级即可恢复配额。',
  wrongRetest: '两区都供水，因为水库仍有水。',
  retest: ['只有西区供水，因为西阀开启。', '不能派送，因为邮资未付。'],
} as const;

export function publicOptionId(
  options: ReadonlyArray<{ id: string; text: string }>,
  expectedText: string,
): string {
  const matching = options.filter((option) => option.text === expectedText);
  if (matching.length !== 1)
    throw new Error(`Expected one offered answer ${expectedText}: ${JSON.stringify(options)}`);
  return matching[0]!.id;
}

class GoldenCourseProvider extends FakeProvider {
  constructor(private readonly hooks: GoldenGenerationHooks = {}) {
    super();
  }

  override async generateLessonSlotContent(
    ...args: Parameters<FakeProvider['generateLessonSlotContent']>
  ) {
    await this.hooks.lesson?.();
    return super.generateLessonSlotContent(...args);
  }

  override async generatePracticeContent(
    ...args: Parameters<FakeProvider['generatePracticeContent']>
  ) {
    await this.hooks.practice?.();
    return super.generatePracticeContent(...args);
  }

  override async proposeCurriculumDetails(
    ...args: Parameters<FakeProvider['proposeCurriculumDetails']>
  ) {
    const result = await super.proposeCurriculumDetails(...args);
    // Use the authored source topic as the display name. Evidence and objectives
    // still come from the normal Fake proposal and production admission path.
    for (const unit of result.units) {
      const region = args[0].regions.find((candidate) => candidate.regionId === unit.regionId)!;
      const topic = GOLDEN_UNITS.find((candidate) =>
        region.evidence.some((offer) => offer.text.includes(candidate.paragraphs[0])),
      );
      if (!topic) throw new Error(`Unexpected Golden source region ${region.title}`);
      unit.title = topic.title;
    }
    return result;
  }
}

/** Narrow failure/gate injection for the same authored Golden Course. */
export interface GoldenGenerationHooks {
  lesson?: () => void | Promise<void>;
  practice?: () => void | Promise<void>;
}

/** Count external Provider invocations, including reviews; internal Fake helpers
 * run with the original receiver and are not mistaken for model requests.
 */
export function goldenProvider(hooks: GoldenGenerationHooks = {}) {
  const calls: Record<string, number> = {};
  const provider = new Proxy(new GoldenCourseProvider(hooks), {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { provider, calls };
}

export function goldenContractFields(roles: MaterialRoleAssignment[]): LearningContractDraftFields {
  return {
    intent: '学完工作记忆、组块化和复述三个主题。',
    targetOutcome: {
      description: '准确说明三份讲义中的基本事实。',
      targetScore: null,
      credential: null,
    },
    deadline: null,
    studyBudget: {
      minutesPerDay: 60,
      minutesPerWeek: null,
      preferredSessionMinutes: 20,
      unavailablePeriods: [],
    },
    desiredDepth: 'working_fluency',
    focusRequest: null,
    courseScope: {
      subjectBoundaries: ['工作记忆入门'],
      includedTopics: [],
      excludedTopics: [],
      materials: roles.map((role) => {
        if (role.role !== 'course_material' || role.status !== 'learner_confirmed')
          throw new Error('Golden source must have a confirmed course-material role.');
        return {
          materialId: role.materialId,
          materialRoleAssignmentId: role.id,
          materialRoleAssignmentVersion: role.version,
          role: role.role,
          disposition: 'included' as const,
        };
      }),
    },
    learnerSelfReport: null,
    examContext: null,
    riskTolerance: {
      description: null,
      allowExplicitDeferral: true,
      maximumUnresolvedPriority: 'high',
    },
  };
}
