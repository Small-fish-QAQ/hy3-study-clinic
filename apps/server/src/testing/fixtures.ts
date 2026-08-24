import type {
  Concept,
  CurriculumObjective,
  Material,
  MistakeRecord,
  ObjectiveAuthoritySemanticSupport,
  ObjectiveAuthoritySupportType,
  Question,
  Quiz,
  SourceBlock,
  VerifiedGrounding,
  Workspace,
} from '@hy3-clinic/shared';
import { ObjectiveAuthoritySemanticSupportSchema } from '@hy3-clinic/shared';
import {
  OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
  curriculumObjectiveProposition,
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
} from '../services/objectiveAuthoritySemanticSupport.js';

/** Deterministic domain-object builders shared by server tests. */

export const T0 = '2026-01-01T00:00:00.000Z';

type CurrentCurriculumObjective = Omit<
  CurriculumObjective,
  'semanticSupport' | 'formalAssessmentConstruct' | 'authoritySourceBlockIds' | 'authorityClaimIds'
> & {
  formalAssessmentConstruct: NonNullable<CurriculumObjective['formalAssessmentConstruct']>;
  authoritySourceBlockIds: string[];
  authorityClaimIds: string[];
};

/** Build a current passing objective while retaining exact production fingerprints. */
export function makeSemanticallySupportedObjective(
  objective: CurrentCurriculumObjective,
  supportType: ObjectiveAuthoritySupportType,
): CurriculumObjective {
  const proposition = curriculumObjectiveProposition(objective);
  const semanticSupport: ObjectiveAuthoritySemanticSupport =
    ObjectiveAuthoritySemanticSupportSchema.parse({
      schemaVersion: 1,
      policyVersion: OBJECTIVE_AUTHORITY_SEMANTIC_SUPPORT_POLICY,
      evaluator: 'test-independent-semantic-evaluator',
      provider: 'fake',
      providerModel: null,
      independent: true,
      objectiveId: objective.id,
      proposition,
      propositionFingerprint: fingerprintObjectiveAuthorityProposition(proposition),
      construct: objective.formalAssessmentConstruct,
      boundAuthorityRecordIds: [...objective.truthAuthorityRecordIds],
      boundSourceBlockIds: [...objective.authoritySourceBlockIds],
      boundAuthorityClaimIds: [...objective.authorityClaimIds],
      bindingFingerprint: fingerprintObjectiveAuthorityBinding({
        authorityRecordIds: objective.truthAuthorityRecordIds,
        sourceBlockIds: objective.authoritySourceBlockIds,
        authorityClaimIds: objective.authorityClaimIds,
      }),
      fragments: [
        {
          fragmentId: 'fragment_1',
          text: proposition,
          status: 'supported',
          supportType,
          sourceBlockIds: [...objective.authoritySourceBlockIds],
          authorityRecordIds: [...objective.truthAuthorityRecordIds],
          authorityClaimIds: [...objective.authorityClaimIds],
          rationale: 'The exact bound source authority directly supports this test objective.',
        },
      ],
      unsupportedFragmentIds: [],
      conflicts: [],
      overreach: [],
      verdict: 'pass',
      rationale: 'All proposition fragments are supported by the exact bound source authority.',
      evaluatedAt: T0,
    });
  return { ...objective, semanticSupport };
}

export function makeGrounding(overrides: Partial<VerifiedGrounding> = {}): VerifiedGrounding {
  return {
    blockId: 'blk_1',
    quote: '工作记忆的容量十分有限。',
    startOffset: 0,
    endOffset: 12,
    occurrenceCount: 1,
    reanchored: false,
    ...overrides,
  };
}

export function makeMaterial(overrides: Partial<Material> = {}): Material {
  return {
    id: 'mat_1',
    workspaceId: 'ws_1',
    title: '认知科学入门:记忆与学习',
    sourceType: 'paste',
    mediaType: 'text/plain',
    originalFilename: null,
    content: '# 记忆的类型\n\n工作记忆的容量十分有限。',
    charCount: 20,
    parseStatus: 'parsed',
    pageCount: null,
    extractionWarnings: [],
    parserVersion: 'text-v1',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws_1',
    name: '认知科学课程',
    description: null,
    activeGraphVersionId: null,
    origin: 'manual',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeBlock(overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: 'blk_1',
    materialId: 'mat_1',
    index: 0,
    heading: '记忆的类型',
    headingPath: ['记忆的类型'],
    pageNumber: null,
    pageEnd: null,
    content: '工作记忆的容量十分有限。',
    startOffset: 9,
    endOffset: 21,
    ...overrides,
  };
}

export function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: 'con_1',
    materialId: 'mat_1',
    name: '工作记忆',
    summary: '工作记忆是容量有限的短时信息加工系统。',
    importance: 'high',
    grounding: makeGrounding(),
    createdAt: T0,
    ...overrides,
  };
}

export function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'que_1',
    quizId: 'qz_1',
    index: 0,
    type: 'single_choice',
    stem: '根据资料,工作记忆的容量特点是?',
    options: [
      { id: 'A', text: '十分有限' },
      { id: 'B', text: '无限大' },
      { id: 'C', text: '与长时记忆相同' },
    ],
    correctOptionIds: ['A'],
    conceptId: 'con_1',
    conceptName: '工作记忆',
    grounding: makeGrounding(),
    explanation: '资料明确指出工作记忆的容量十分有限。',
    points: 1,
    ...overrides,
  } as Question;
}

export function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 'qz_1',
    materialId: 'mat_1',
    kind: 'standard',
    config: { difficulty: 'medium', types: ['single_choice'], countPerType: 1 },
    questions: [makeQuestion()],
    createdAt: T0,
    ...overrides,
  };
}

export function makeMistake(overrides: Partial<MistakeRecord> = {}): MistakeRecord {
  return {
    id: 'mis_1',
    materialId: 'mat_1',
    quizId: 'qz_1',
    questionId: 'que_1',
    conceptId: 'con_1',
    conceptName: '工作记忆',
    question: makeQuestion(),
    userAnswer: { questionId: 'que_1', type: 'single_choice', selectedOptionIds: ['B'] },
    score: 0,
    feedback: '正确答案是 A。',
    status: 'open',
    remediationCount: 0,
    createdAt: T0,
    resolvedAt: null,
    ...overrides,
  };
}
