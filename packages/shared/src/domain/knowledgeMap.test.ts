import { describe, expect, it } from 'vitest';
import {
  aggregateKnowledgeMapPrimaryState,
  KnowledgeMapProjectionSchema,
  KnowledgeMapProjectionResponseSchema,
  KNOWLEDGE_MAP_PRECEDENCE_POLICY,
  KNOWLEDGE_MAP_PROJECTION_VERSION,
} from '../index.js';

const T = '2026-01-01T00:00:00.000Z';

describe('Knowledge Map projection contract', () => {
  it('aggregates grouped state conservatively without creating authority', () => {
    expect(aggregateKnowledgeMapPrimaryState(['evidence_backed', 'repair'])).toBe('repair');
    expect(aggregateKnowledgeMapPrimaryState(['mastered', 'evidence_backed'])).toBe(
      'evidence_backed',
    );
    expect(aggregateKnowledgeMapPrimaryState([])).toBe('not_started');
  });
  it('requires the versioned contract and all four modes', () => {
    const parsed = KnowledgeMapProjectionSchema.safeParse({
      schemaVersion: 1,
      projectionVersion: KNOWLEDGE_MAP_PROJECTION_VERSION,
      precedencePolicyVersion: KNOWLEDGE_MAP_PRECEDENCE_POLICY,
      workspaceId: 'ws_1',
      generatedAt: T,
      status: 'unconfigured',
      route: {
        current: false,
        courseExecutionVersion: 0,
        executionStatus: 'stopped',
        validationStatus: 'unconfigured',
        contractVersionId: null,
        curriculumVersionId: null,
        studyPlanVersionId: null,
        agendaId: null,
        executionSourceManifestFingerprint: null,
        unknownReasons: [],
      },
      modes: ['knowledge_structure', 'learning_progress', 'learning_route', 'weakness_map'],
      nodes: [],
      edges: [],
      history: {
        supersededCurriculumIds: [],
        supersededStudyPlanIds: [],
        historicalFormalEvidenceIds: [],
        historicalAssessmentEvidenceIds: [],
        truncated: false,
      },
      limits: {
        maxNodes: 2000,
        maxEdges: 4000,
        totalNodeCandidates: 0,
        totalEdgeCandidates: 0,
        nodesTruncated: false,
        edgesTruncated: false,
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      KnowledgeMapProjectionResponseSchema.safeParse({
        projection: parsed.success ? parsed.data : null,
      }).success,
    ).toBe(true);
  });

  it('rejects edges that point outside the projected node set', () => {
    const result = KnowledgeMapProjectionSchema.safeParse({
      schemaVersion: 1,
      projectionVersion: KNOWLEDGE_MAP_PROJECTION_VERSION,
      precedencePolicyVersion: KNOWLEDGE_MAP_PRECEDENCE_POLICY,
      workspaceId: 'ws_1',
      generatedAt: T,
      status: 'partial',
      route: {
        current: false,
        courseExecutionVersion: 0,
        executionStatus: 'stopped',
        validationStatus: 'unconfigured',
        contractVersionId: null,
        curriculumVersionId: null,
        studyPlanVersionId: null,
        agendaId: null,
        executionSourceManifestFingerprint: null,
        unknownReasons: ['stale_graph_binding'],
      },
      modes: ['knowledge_structure', 'learning_progress', 'learning_route', 'weakness_map'],
      nodes: [],
      edges: [
        {
          id: 'edge_1',
          sourceNodeId: 'missing',
          targetNodeId: 'missing_2',
          kind: 'prerequisite',
          modes: ['knowledge_structure'],
          current: false,
          authority: 'validated_concept_graph',
          sourceRecordIds: ['graph_edge_1'],
          explanation: 'validated relation',
          provenance: [],
        },
      ],
      history: {
        supersededCurriculumIds: [],
        supersededStudyPlanIds: [],
        historicalFormalEvidenceIds: [],
        historicalAssessmentEvidenceIds: [],
        truncated: false,
      },
      limits: {
        maxNodes: 2000,
        maxEdges: 4000,
        totalNodeCandidates: 0,
        totalEdgeCandidates: 1,
        nodesTruncated: false,
        edgesTruncated: false,
      },
    });
    expect(result.success).toBe(false);
  });
});
