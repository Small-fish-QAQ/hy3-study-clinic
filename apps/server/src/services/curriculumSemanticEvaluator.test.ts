import { describe, expect, it } from 'vitest';
import type { Curriculum } from '@hy3-clinic/shared';
import {
  CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION,
  evaluateCurriculumSemantics,
  evaluateCurriculumWithBoundedRepair,
  hasCurriculumSemanticAnchor,
  type CurriculumSemanticSourceRegion,
} from './curriculumSemanticEvaluator.js';
import {
  HUMAN_SMOKE_LARGE_SOURCE_REGIONS,
  makeLargeCurriculum,
} from '../testing/curriculumQualityFixtures.js';

const evaluatedAt = '2026-08-23T00:00:00.000Z';

function curriculum(
  titles: string[],
  options: { unresolved?: boolean; requiredUnsupported?: boolean } = {},
): Curriculum {
  const nodes: Curriculum['nodes'] = [
    {
      id: 'course',
      parentId: null,
      kind: 'course',
      index: 0,
      title: 'Course',
      sourceReferences: [],
      learningUnit: null,
    },
    {
      id: 'chapter',
      parentId: 'course',
      kind: 'chapter',
      index: 0,
      title: 'Systems',
      sourceReferences: [],
      learningUnit: null,
    },
  ];
  titles.forEach((title, index) => {
    const blockId = `block-${index + 1}`;
    nodes.push({
      id: `unit-${index + 1}`,
      parentId: 'chapter',
      kind: 'learning_unit',
      index,
      title,
      sourceReferences: options.unresolved
        ? []
        : [
            {
              materialId: 'material',
              materialRevisionId: 'revision',
              structuralUnitId: null,
              sourceBlockId: blockId,
              sourceBlockRevisionFingerprint: `fingerprint-${blockId}`,
            },
          ],
      learningUnit: {
        conceptIds: [],
        canonicalConceptIds: [],
        objectives: [
          {
            id: `objective-${index + 1}`,
            title: title.replace(/^\d+[.)、:]?\s*/u, ''),
            description: `Explain ${title}`,
            truthPremiseStatus: options.requiredUnsupported ? 'unverified' : 'not_applicable',
            truthAuthorityRecordIds: [],
            ...(options.requiredUnsupported
              ? {
                  priority: 'required' as const,
                  formalAssessmentReady: false,
                }
              : {}),
          },
        ],
        prerequisiteUnitIds: [],
        graphRelationIds: [],
        riskIds: [],
      },
    });
  });
  return {
    id: 'curriculum',
    workspaceId: 'workspace',
    contractVersionId: 'contract',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'manifest',
      revisions: [
        {
          materialId: 'material',
          materialRevisionId: 'revision',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: titles.map((_title, index) => `block-${index + 1}`),
        },
      ],
    },
    nodes,
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: evaluatedAt,
    acceptedAt: null,
  };
}

function regions(count: number): CurriculumSemanticSourceRegion[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `region-${index + 1}`,
    materialId: 'material',
    materialRevisionId: 'revision',
    title: `Topic ${index + 1}`,
    sourceSectionIds: [`section-${index + 1}`],
    sourceBlockIds: [`block-${index + 1}`],
    charCount: 80,
  }));
}

describe('independent Curriculum semantic evaluator', () => {
  it('uses controlled domain aliases without equating retrieval with permissions', () => {
    expect(hasCurriculumSemanticAnchor('递归分隔符按优先级执行', ['文档切片原理'])).toBe(true);
    expect(hasCurriculumSemanticAnchor('解释忠实性与正确性区别', ['RAG 幻觉控制'])).toBe(true);
    expect(
      hasCurriculumSemanticAnchor('IVF query 搜索 centroid 与 nprobe', ['权限模型与后端安全']),
    ).toBe(false);
  });

  it('rejects unexplained discontinuous numbering such as 1 -> 3 -> 5 -> 7', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum([
        '1. System positioning',
        '3. Embedding',
        '5. RAG workflow',
        '7. Permissions',
      ]),
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(4),
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.evaluation.policyVersion).toBe(CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION);
    expect(result.evaluation.status).toBe('fail');
    expect(result.evaluation.findings.map((finding) => finding.code)).toContain(
      'structural_numbering_discontinuity',
    );
  });

  it('does not collapse decimal sibling numbering such as 7.1 -> 7.2 -> 7.3 into repeated 7s', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['7.1 Retrieval permissions', '7.2 Tool permissions', '7.3 Audit']),
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(3),
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.evaluation.findings.map((finding) => finding.code)).not.toContain(
      'structural_numbering_discontinuity',
    );
  });

  it('fails systematic mastery when meaningful source regions are unresolved', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['Topic 1'], { unresolved: true }),
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(3),
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    expect(result.coverage.unresolvedMeaningfulRegionIds).toHaveLength(3);
    expect(result.evaluation.status).toBe('fail');
  });

  it('rejects one semantic topic scattered across unrelated modules', () => {
    const candidate = curriculum(['Permissions model', 'Permissions boundaries']);
    candidate.nodes[1]!.id = 'chapter-foundations';
    candidate.nodes[1]!.title = 'Foundations';
    candidate.nodes[2]!.parentId = 'chapter-foundations';
    candidate.nodes.push({
      id: 'chapter-operations',
      parentId: 'course',
      kind: 'chapter',
      index: 1,
      title: 'Permissions operations',
      sourceReferences: [],
      learningUnit: null,
    });
    candidate.nodes[3]!.parentId = 'chapter-operations';
    const source = regions(2);
    source[0]!.title = 'Permissions model';
    source[1]!.title = 'Permissions boundaries';
    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    expect(result.evaluation.findings.map((finding) => finding.code)).toContain(
      'semantic_topic_scattering',
    );
    expect(result.evaluation.status).toBe('fail');
  });

  it('does not treat a shared single Han character as a semantic anchor', () => {
    const candidate = curriculum(['权限', '限额']);
    candidate.nodes[1]!.id = 'chapter-foundations';
    candidate.nodes[1]!.title = '甲类';
    candidate.nodes[2]!.parentId = 'chapter-foundations';
    candidate.nodes.push({
      id: 'chapter-operations',
      parentId: 'course',
      kind: 'chapter',
      index: 1,
      title: '乙类',
      sourceReferences: [],
      learningUnit: null,
    });
    candidate.nodes[3]!.parentId = 'chapter-operations';
    const source = regions(2);
    source[0]!.title = '权限';
    source[1]!.title = '限额';
    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.evaluation.findings.map((finding) => finding.code)).not.toContain(
      'semantic_topic_scattering',
    );
  });

  it('does not treat a corpus-wide domain label as focused topic scattering', () => {
    const candidate = curriculum(['RAG foundations', 'RAG retrieval', 'RAG evaluation']);
    candidate.nodes[1]!.id = 'chapter-foundations';
    candidate.nodes[1]!.title = 'RAG foundations';
    candidate.nodes[2]!.parentId = 'chapter-foundations';
    candidate.nodes.push(
      {
        id: 'chapter-retrieval',
        parentId: 'course',
        kind: 'chapter',
        index: 1,
        title: 'RAG retrieval',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'chapter-evaluation',
        parentId: 'course',
        kind: 'chapter',
        index: 2,
        title: 'RAG evaluation',
        sourceReferences: [],
        learningUnit: null,
      },
    );
    candidate.nodes[3]!.parentId = 'chapter-retrieval';
    candidate.nodes[4]!.parentId = 'chapter-evaluation';
    const source = regions(3);
    source[0]!.title = 'RAG foundations';
    source[1]!.title = 'RAG retrieval';
    source[2]!.title = 'RAG evaluation';

    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'systematic_mastery',
      evaluatedAt,
    });

    expect(result.evaluation.findings.map((finding) => finding.code)).not.toContain(
      'semantic_topic_scattering',
    );
    expect(result.evaluation.status).toBe('pass');
  });

  it('does not use the RAG domain label alone to merge two coherent source regions', () => {
    const candidate = curriculum(['系统定位与语义表示基础', 'RAG 流程与权限工程体系']);
    candidate.nodes[1]!.id = 'chapter-system';
    candidate.nodes[1]!.title = '系统定位与语义表示基础';
    candidate.nodes[2]!.parentId = 'chapter-system';
    candidate.nodes.push({
      id: 'chapter-rag-workflow',
      parentId: 'course',
      kind: 'chapter',
      index: 1,
      title: 'RAG 流程与权限工程体系',
      sourceReferences: [],
      learningUnit: null,
    });
    candidate.nodes[3]!.parentId = 'chapter-rag-workflow';
    const source = regions(2);
    source[0]!.title = '系统定位与 RAG 全景';
    source[1]!.title = 'RAG 流程与幻觉';

    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'systematic_mastery',
      evaluatedAt,
    });

    expect(result.evaluation.findings.map((finding) => finding.code)).not.toContain(
      'semantic_topic_scattering',
    );
    expect(result.evaluation.status).toBe('pass');
  });

  it('does not reject a concise coherent course solely for being small', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['Foundations', 'Application']),
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(2),
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.evaluation.status).toBe('pass');
  });

  it('accepts a meaningful region that is explicitly outside an intentionally narrowed scope', () => {
    const source = regions(2);
    source[1]!.defaultDisposition = 'explicitly_out_of_scope';
    source[1]!.defaultRationale = 'The learner explicitly narrowed this course to Topic 1.';
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['Topic 1']),
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.coverage.dispositionCounts.explicitly_out_of_scope).toBe(1);
    expect(result.coverage.unresolvedMeaningfulRegionIds).toHaveLength(0);
    expect(result.evaluation.status).toBe('pass');
  });

  it('allows an image-only or otherwise source-empty course to retain an empty accountability ledger', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['Image interpretation']),
      sourceMapFingerprint: 'source-map-empty',
      sourceRegions: [],
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.coverage.regions).toHaveLength(0);
    expect(result.coverage.meaningfulRegionCount).toBe(0);
    expect(result.evaluation.status).toBe('pass');
  });

  it('fails a required objective without independently authorized premises', () => {
    const result = evaluateCurriculumSemantics({
      curriculum: curriculum(['Permissions'], { requiredUnsupported: true }),
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(1),
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    expect(result.evaluation.findings.map((finding) => finding.code)).toContain(
      'required_objective_formal_authority_missing',
    );
  });

  it('rejects an over-compressed systematic route for a rich source', () => {
    const candidate = curriculum(['Overview']);
    candidate.nodes[2]!.sourceReferences = regions(8).map((region) => ({
      materialId: region.materialId,
      materialRevisionId: region.materialRevisionId,
      structuralUnitId: null,
      sourceBlockId: region.sourceBlockIds[0]!,
      sourceBlockRevisionFingerprint: `fingerprint-${region.sourceBlockIds[0]}`,
    }));
    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: regions(8),
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    expect(result.evaluation.findings.map((finding) => finding.code)).toContain(
      'over_compressed_systematic_route',
    );
  });

  it('keeps legitimate same-title distinct topics and explicitly excluded boilerplate auditable', () => {
    const candidate = curriculum(['Overview', 'Overview']);
    const source = regions(2);
    source[1]!.meaningful = false;
    source[1]!.defaultDisposition = 'boilerplate/navigation/non-learning-content';
    source[1]!.defaultRationale = 'Navigation heading only; it contains no learner-facing content.';
    const result = evaluateCurriculumSemantics({
      curriculum: candidate,
      sourceMapFingerprint: 'source-map',
      sourceRegions: source,
      scope: 'intentional_scope',
      evaluatedAt,
    });
    expect(result.evaluation.status).toBe('pass');
    expect(result.coverage.dispositionCounts['boilerplate/navigation/non-learning-content']).toBe(
      1,
    );
  });

  it('allows exactly one independent bounded repair reevaluation', () => {
    let repairs = 0;
    const result = evaluateCurriculumWithBoundedRepair(
      {
        curriculum: curriculum(['1. A', '3. B', '5. C']),
        sourceMapFingerprint: 'source-map',
        sourceRegions: regions(3),
        scope: 'intentional_scope',
        evaluatedAt,
      },
      (failed) => {
        repairs += 1;
        expect(failed.evaluation.status).toBe('fail');
        return curriculum(['A', 'B', 'C']);
      },
    );
    expect(repairs).toBe(1);
    expect(result.evaluation.boundedRepairAttempted).toBe(true);
    expect(result.evaluation.status).toBe('pass');
  });

  it('records explainable before/after metrics for a realistic large source', () => {
    const before = evaluateCurriculumSemantics({
      curriculum: makeLargeCurriculum(24),
      sourceMapFingerprint: 'large-source-map',
      sourceRegions: HUMAN_SMOKE_LARGE_SOURCE_REGIONS,
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    const after = evaluateCurriculumSemantics({
      curriculum: makeLargeCurriculum(4),
      sourceMapFingerprint: 'large-source-map',
      sourceRegions: HUMAN_SMOKE_LARGE_SOURCE_REGIONS,
      scope: 'systematic_mastery',
      evaluatedAt,
    });
    expect(HUMAN_SMOKE_LARGE_SOURCE_REGIONS).toHaveLength(24);
    expect(before.evaluation.status).toBe('fail');
    expect(after.evaluation.status).toBe('pass');
    expect(before.coverage.meaningfulRegionCount).toBe(24);
    expect(after.coverage.unresolvedMeaningfulRegionIds).toHaveLength(0);
    expect(before.evaluation.findings.map((finding) => finding.code)).toContain(
      'over_compressed_systematic_route',
    );
  });
});
