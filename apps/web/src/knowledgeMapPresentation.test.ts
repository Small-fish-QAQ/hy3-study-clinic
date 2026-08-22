import { describe, expect, it } from 'vitest';
import {
  primaryNodeCue,
  visibleKnowledgeMapEdges,
  visibleKnowledgeMapNodeIds,
} from './knowledgeMapPresentation.js';
import { knowledgeMapProjection } from './test/knowledgeMapFixture.js';

describe('Knowledge Map projection presentation', () => {
  it('uses the projected primary state directly in Progress mode', () => {
    const projection = knowledgeMapProjection();
    const reviewDue = projection.nodes.find((node) => node.label === '工作记忆基础')!;
    expect(reviewDue.weaknesses.map((item) => item.kind)).toContain('review_due');
    expect(primaryNodeCue(reviewDue, 'learning_progress')).toEqual({
      label: '有正式证据支持',
      tone: 'evidence_backed',
    });
  });

  it('keeps Repair, Formal failure, due Review, and advisory wording distinct', () => {
    const projection = knowledgeMapProjection();
    const repair = projection.nodes.find((node) => node.label === '认知负荷应用')!;
    const due = projection.nodes.find((node) => node.label === '工作记忆基础')!;
    const advisory = projection.nodes.find((node) => node.label === '间隔效应')!;
    expect(primaryNodeCue(repair, 'weakness_map')).toEqual({
      label: '修复进行中',
      tone: 'repair',
    });
    expect(primaryNodeCue(due, 'weakness_map')).toEqual({
      label: '复习到期',
      tone: 'review-due',
    });
    expect(primaryNodeCue(advisory, 'weakness_map')).toEqual({
      label: '可能缺口（提示）',
      tone: 'advisory',
    });
  });

  it('filters by server-projected mode and retains the selected node', () => {
    const projection = knowledgeMapProjection();
    const routeIds = visibleKnowledgeMapNodeIds(projection, 'learning_route', null);
    expect(routeIds.has('learning-unit:advisory')).toBe(false);
    const selectedRouteIds = visibleKnowledgeMapNodeIds(
      projection,
      'learning_route',
      'learning-unit:advisory',
    );
    expect(selectedRouteIds.has('learning-unit:advisory')).toBe(true);
    const routeEdges = visibleKnowledgeMapEdges(projection, 'learning_route', routeIds);
    expect(routeEdges).toHaveLength(3);
  });

  it('keeps inspectable substrate hidden until a deterministic parent expansion', () => {
    const projection = knowledgeMapProjection();
    const parent = projection.nodes.find((node) => node.label === '认知负荷应用')!;
    const child = {
      ...projection.nodes.find((node) => node.label === '间隔效应')!,
      learnerVisible: false,
    };
    projection.nodes = [
      ...projection.nodes.filter((node) => node.id !== child.id),
      child,
      {
        ...parent,
        id: 'curriculum:test-region',
        label: '测试课程区域',
        kind: 'curriculum_region',
        childNodeIds: [child.id],
        learningUnitNodeIds: [child.id],
        conceptNodeIds: [],
        objectiveIds: parent.objectiveIds,
        curriculumKind: 'section',
      } as typeof parent,
    ];
    const defaultIds = visibleKnowledgeMapNodeIds(projection, 'knowledge_structure', null);
    expect(defaultIds.has(child.id)).toBe(false);
    const expandedIds = visibleKnowledgeMapNodeIds(
      projection,
      'knowledge_structure',
      null,
      new Set(['curriculum:test-region']),
    );
    expect(expandedIds.has(child.id)).toBe(true);
  });
});
