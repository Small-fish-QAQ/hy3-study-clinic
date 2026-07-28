import { describe, expect, it } from 'vitest';
import {
  AddDocumentRequestSchema,
  ConceptLearnerStateSchema,
  CreateWorkspaceRequestSchema,
  DocumentSummarySchema,
  GraphEdgeSchema,
  GraphProposalPayloadSchema,
  GraphRelationSchema,
  GraphValidationSummarySchema,
  GraphVersionSchema,
  MAX_DOCUMENT_FILE_BASE64_CHARS,
  MaterialSchema,
  ProposedGraphEdgeSchema,
  RemediationPlanProposalPayloadSchema,
  RemediationPlanSchema,
  SourceBlockSchema,
  WorkspaceSchema,
} from '../index.js';

const T = '2026-01-01T00:00:00.000Z';

const grounding = {
  blockId: 'blk_1',
  quote: '工作记忆的容量十分有限。',
  startOffset: 0,
  endOffset: 12,
  occurrenceCount: 1,
  reanchored: false,
};

describe('workspace and document schemas', () => {
  it('accepts a valid workspace and document', () => {
    expect(() =>
      WorkspaceSchema.parse({
        id: 'ws_1',
        name: '认知科学',
        description: null,
        activeGraphVersionId: null,
        origin: 'manual',
        createdAt: T,
        updatedAt: T,
      }),
    ).not.toThrow();

    // The origin is a controlled enum: every creation path must declare one
    // ('manual' | 'material_import' | 'unknown'), nothing else parses.
    for (const origin of ['manual', 'material_import', 'unknown'] as const) {
      expect(() =>
        WorkspaceSchema.parse({
          id: 'ws_1',
          name: '认知科学',
          description: null,
          activeGraphVersionId: null,
          origin,
          createdAt: T,
          updatedAt: T,
        }),
      ).not.toThrow();
    }
    expect(() =>
      WorkspaceSchema.parse({
        id: 'ws_1',
        name: '认知科学',
        description: null,
        activeGraphVersionId: null,
        origin: 'legacy_guessed',
        createdAt: T,
        updatedAt: T,
      }),
    ).toThrow();

    expect(() =>
      MaterialSchema.parse({
        id: 'mat_1',
        workspaceId: 'ws_1',
        title: '资料',
        sourceType: 'pdf',
        mediaType: 'application/pdf',
        originalFilename: 'a.pdf',
        content: '正文',
        charCount: 2,
        parseStatus: 'parsed_with_warnings',
        pageCount: 3,
        extractionWarnings: ['第 2 页未提取到文本'],
        parserVersion: 'pdf-unpdf-v1',
        createdAt: T,
        updatedAt: T,
      }),
    ).not.toThrow();
  });

  it('keeps source blocks backward compatible with nullable page numbers', () => {
    const block = SourceBlockSchema.parse({
      id: 'blk_1',
      materialId: 'mat_1',
      index: 0,
      heading: null,
      headingPath: [],
      pageNumber: null,
      content: '内容',
      startOffset: 0,
      endOffset: 2,
    });
    expect(block.pageNumber).toBeNull();
    // Legacy payloads without pageEnd (pre-page-range rows) default to null.
    expect(block.pageEnd).toBeNull();
    expect(() => SourceBlockSchema.parse({ ...block, pageNumber: 0 })).toThrow();
  });

  it('accepts page-range provenance and rejects non-positive page ends', () => {
    const base = {
      id: 'blk_1',
      materialId: 'mat_1',
      index: 0,
      heading: '章节',
      headingPath: ['章节'],
      pageNumber: 2,
      content: '内容',
      startOffset: 0,
      endOffset: 2,
    };
    expect(SourceBlockSchema.parse({ ...base, pageEnd: 3 }).pageEnd).toBe(3);
    expect(() => SourceBlockSchema.parse({ ...base, pageEnd: 0 })).toThrow();
  });

  it('rejects invalid workspace names and oversized uploads at the contract layer', () => {
    expect(CreateWorkspaceRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(CreateWorkspaceRequestSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(
      AddDocumentRequestSchema.safeParse({
        kind: 'file',
        filename: 'a.pdf',
        dataBase64: 'x'.repeat(MAX_DOCUMENT_FILE_BASE64_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      AddDocumentRequestSchema.safeParse({ kind: 'file', filename: '', dataBase64: 'aGk=' })
        .success,
    ).toBe(false);
    expect(AddDocumentRequestSchema.safeParse({ kind: 'text', content: '正文' }).success).toBe(
      true,
    );
  });

  it('bounds document summary warning lists', () => {
    const summary = {
      id: 'mat_1',
      workspaceId: 'ws_1',
      title: '资料',
      sourceType: 'txt',
      mediaType: 'text/plain',
      originalFilename: null,
      charCount: 10,
      blockCount: 1,
      conceptCount: 0,
      parseStatus: 'parsed',
      pageCount: null,
      extractionWarnings: Array.from({ length: 51 }, (_, i) => `w${i}`),
      parserVersion: 'text-v1',
      createdAt: T,
      updatedAt: T,
    };
    expect(DocumentSummarySchema.safeParse(summary).success).toBe(false);
  });
});

describe('graph schemas', () => {
  it('exposes exactly the six controlled relations', () => {
    expect(GraphRelationSchema.options).toEqual([
      'prerequisite',
      'part_of',
      'contrasts_with',
      'causes',
      'applies_to',
      'example_of',
    ]);
  });

  it('accepts a valid edge and rejects evidence-free or over-evidenced edges', () => {
    const edge = {
      id: 'ge_1',
      graphVersionId: 'gv_1',
      sourceConceptId: 'con_a',
      targetConceptId: 'con_b',
      relation: 'prerequisite',
      explanation: '先修关系。',
      evidence: [grounding],
      createdAt: T,
    };
    expect(GraphEdgeSchema.safeParse(edge).success).toBe(true);
    expect(GraphEdgeSchema.safeParse({ ...edge, evidence: [] }).success).toBe(false);
    expect(
      GraphEdgeSchema.safeParse({ ...edge, evidence: [grounding, grounding, grounding, grounding] })
        .success,
    ).toBe(false);
    expect(GraphEdgeSchema.safeParse({ ...edge, relation: 'related_to' }).success).toBe(false);
  });

  it('validates version status and summary shapes', () => {
    const version = {
      id: 'gv_1',
      workspaceId: 'ws_1',
      status: 'ready',
      provider: 'fake',
      providerModel: null,
      validationSummary: {
        candidateCount: 3,
        acceptedCount: 2,
        rejectedCount: 1,
        duplicateCount: 0,
        droppedEvidenceCount: 0,
        rejected: [{ sourceConceptId: 'a', targetConceptId: 'b', relation: 'causes', reason: 'x' }],
      },
      errorMessage: null,
      createdAt: T,
      updatedAt: T,
    };
    expect(GraphVersionSchema.safeParse(version).success).toBe(true);
    expect(GraphVersionSchema.safeParse({ ...version, status: 'archived' }).success).toBe(false);
    expect(
      GraphValidationSummarySchema.safeParse({
        ...version.validationSummary,
        rejected: Array.from({ length: 51 }, () => version.validationSummary.rejected[0]),
      }).success,
    ).toBe(false);
  });

  it('bounds proposal payloads (edge count, evidence count)', () => {
    const proposedEdge = {
      sourceConceptId: 'con_a',
      targetConceptId: 'con_b',
      relation: 'causes',
      explanation: '因果。',
      evidence: [{ blockId: 'blk_1', quote: '证据' }],
    };
    expect(ProposedGraphEdgeSchema.safeParse(proposedEdge).success).toBe(true);
    expect(
      GraphProposalPayloadSchema.safeParse({
        edges: Array.from({ length: 61 }, () => proposedEdge),
      }).success,
    ).toBe(false);
    expect(GraphProposalPayloadSchema.safeParse({ edges: [] }).success).toBe(false);
  });

  it('validates learner-state kinds', () => {
    const state = {
      conceptId: 'con_a',
      conceptName: '工作记忆',
      materialId: 'mat_1',
      state: 'weak',
      mastery: 0.4,
      hasEnoughActivity: true,
      attempts: 4,
      correctCount: 1,
      lastScore: 0.5,
      lastActivityAt: T,
      openMistakes: 2,
      resolvedMistakes: 1,
      treatAsWeak: true,
      prerequisiteConceptIds: ['con_b'],
    };
    expect(ConceptLearnerStateSchema.safeParse(state).success).toBe(true);
    expect(ConceptLearnerStateSchema.safeParse({ ...state, state: 'excellent' }).success).toBe(
      false,
    );
    expect(ConceptLearnerStateSchema.safeParse({ ...state, mastery: 1.5 }).success).toBe(false);
  });
});

describe('remediation plan schemas', () => {
  const target = {
    conceptId: 'con_a',
    conceptName: '工作记忆',
    reason: '存在未解决错题。',
    evidence: [grounding],
  };
  const plan = {
    id: 'plan_1',
    workspaceId: 'ws_1',
    conceptId: 'con_a',
    summary: '概述',
    weaknessHypothesis: '假设',
    strategy: 'prerequisite_repair',
    difficulty: 'medium',
    questionTypes: ['single_choice', 'short_answer'],
    steps: [{ index: 0, description: '第一步', conceptId: null }],
    targets: [target],
    provider: 'fake',
    createdAt: T,
  };

  it('accepts a valid plan', () => {
    expect(RemediationPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('enforces controlled strategy/difficulty/question-type vocabularies', () => {
    expect(RemediationPlanSchema.safeParse({ ...plan, strategy: 'hypnosis' }).success).toBe(false);
    expect(RemediationPlanSchema.safeParse({ ...plan, difficulty: 'impossible' }).success).toBe(
      false,
    );
    expect(RemediationPlanSchema.safeParse({ ...plan, questionTypes: ['essay'] }).success).toBe(
      false,
    );
  });

  it('bounds targets, steps and evidence', () => {
    expect(
      RemediationPlanSchema.safeParse({
        ...plan,
        targets: Array.from({ length: 5 }, (_, i) => ({ ...target, conceptId: `c${i}` })),
      }).success,
    ).toBe(false);
    expect(
      RemediationPlanSchema.safeParse({
        ...plan,
        steps: Array.from({ length: 7 }, (_, i) => ({
          index: i,
          description: '步骤',
          conceptId: null,
        })),
      }).success,
    ).toBe(false);
    expect(
      RemediationPlanSchema.safeParse({ ...plan, targets: [{ ...target, evidence: [] }] }).success,
    ).toBe(false);
  });

  it('bounds proposal payloads and rejects unknown structures', () => {
    const proposal = {
      summary: '概述',
      weaknessHypothesis: '假设',
      strategy: 'review',
      difficulty: 'easy',
      questionTypes: ['single_choice'],
      steps: [{ description: '复习' }],
      targets: [
        { conceptId: 'con_a', reason: '理由', evidence: [{ blockId: 'blk_1', quote: '证据' }] },
      ],
    };
    expect(RemediationPlanProposalPayloadSchema.safeParse(proposal).success).toBe(true);
    expect(
      RemediationPlanProposalPayloadSchema.safeParse({ ...proposal, targets: [] }).success,
    ).toBe(false);
    expect(
      RemediationPlanProposalPayloadSchema.safeParse({
        ...proposal,
        summary: 'x'.repeat(601),
      }).success,
    ).toBe(false);
  });
});
