import {
  CurriculumCoverageAccountabilitySchema,
  CurriculumSemanticEvaluationSchema,
  type Curriculum,
  type CurriculumAuthorityCritique,
  type CurriculumCoverageAccountability,
  type CurriculumCoverageDisposition,
  type CurriculumQualityFinding,
  type CurriculumSemanticEvaluation,
} from '@hy3-clinic/shared';

export const CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION = 'curriculum-semantic-v1';

export interface CurriculumSemanticSourceRegion {
  id: string;
  materialId: string;
  materialRevisionId: string;
  title: string;
  sourceSectionIds: string[];
  sourceBlockIds: string[];
  charCount?: number;
  meaningful?: boolean;
  defaultDisposition?: CurriculumCoverageDisposition['disposition'];
  defaultRationale?: string;
}

export interface CurriculumSemanticEvaluationInput {
  curriculum: Curriculum;
  sourceMapFingerprint: string;
  sourceRegions: CurriculumSemanticSourceRegion[];
  scope: 'systematic_mastery' | 'intentional_scope';
  evaluatedAt: string;
}

export interface CurriculumSemanticEvaluationResult {
  coverage: CurriculumCoverageAccountability;
  evaluation: CurriculumSemanticEvaluation;
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function features(value: string): Set<string> {
  const normalizedValue = normalized(value);
  const result = new Set<string>(normalizedValue.match(/[a-z0-9]{3,}/g) ?? []);
  for (const match of normalizedValue.matchAll(/\p{Script=Han}+/gu)) {
    const han = [...match[0]];
    for (let index = 0; index + 1 < han.length; index += 1) {
      result.add(`${han[index]}${han[index + 1]}`);
    }
  }
  return result;
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

const SEMANTIC_STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'from',
  'into',
  'with',
  'that',
  'this',
  'their',
  'your',
  'overview',
  'introduction',
  'foundations',
  'system',
  'systems',
]);

function isMeaningful(region: CurriculumSemanticSourceRegion): boolean {
  if (region.meaningful !== undefined) return region.meaningful;
  if ((region.charCount ?? 0) < 24) return false;
  return !/^(?:contents?|table of contents|index|references?|navigation|目录|索引|参考文献)$/iu.test(
    normalized(region.title),
  );
}

function sourceRegionNodeIds(
  curriculum: Curriculum,
  regions: CurriculumSemanticSourceRegion[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const region of regions) {
    const blockIds = new Set(region.sourceBlockIds);
    const nodeIds = curriculum.nodes
      .filter((node) =>
        node.sourceReferences.some(
          (reference) => reference.sourceBlockId !== null && blockIds.has(reference.sourceBlockId),
        ),
      )
      .map((node) => node.id);
    result.set(region.id, nodeIds);
  }
  return result;
}

export function buildCurriculumCoverageAccountability(
  input: Pick<
    CurriculumSemanticEvaluationInput,
    'curriculum' | 'sourceMapFingerprint' | 'sourceRegions' | 'scope'
  >,
): CurriculumCoverageAccountability {
  const nodeIdsByRegion = sourceRegionNodeIds(input.curriculum, input.sourceRegions);
  const unitIds = new Set(
    input.curriculum.nodes.filter((node) => node.kind === 'learning_unit').map((node) => node.id),
  );
  const objectiveIdsByUnit = new Map(
    input.curriculum.nodes
      .filter((node) => node.kind === 'learning_unit' && node.learningUnit)
      .map(
        (node) =>
          [node.id, node.learningUnit!.objectives.map((objective) => objective.id)] as const,
      ),
  );
  const rows = input.sourceRegions.map((region): CurriculumCoverageDisposition => {
    const nodeIds = nodeIdsByRegion.get(region.id) ?? [];
    const unitNodeIds = nodeIds.filter((id) => unitIds.has(id));
    const curriculumNodeIds = unitNodeIds.length > 0 ? unitNodeIds : nodeIds;
    const disposition =
      region.defaultDisposition ??
      (unitNodeIds.length > 0
        ? 'represented_directly'
        : nodeIds.length > 0
          ? 'represented_by_parent_or_synthesis'
          : 'unresolved_candidate_gap');
    const meaningful = isMeaningful(region);
    const objectives = curriculumNodeIds.flatMap((id) => objectiveIdsByUnit.get(id) ?? []);
    return {
      sourceRegionId: region.id,
      materialId: region.materialId,
      materialRevisionId: region.materialRevisionId,
      sourceSectionIds: [...region.sourceSectionIds],
      sourceBlockIds: [...region.sourceBlockIds],
      meaningful,
      disposition,
      rationale:
        region.defaultRationale ??
        (disposition === 'unresolved_candidate_gap'
          ? '当前候选没有提供该精确来源区域的覆盖解释。'
          : disposition === 'represented_directly'
            ? '该来源区域由一个或多个 LearningUnit 直接承载。'
            : '该来源区域由上级结构或综合学习目标承载。'),
      curriculumNodeIds,
      objectiveIds: objectives,
    };
  });
  const dispositionCounts: Record<string, number> = {};
  for (const row of rows)
    dispositionCounts[row.disposition] = (dispositionCounts[row.disposition] ?? 0) + 1;
  return CurriculumCoverageAccountabilitySchema.parse({
    schemaVersion: 1,
    sourceMapFingerprint: input.sourceMapFingerprint,
    scope: input.scope,
    regions: rows,
    meaningfulRegionCount: rows.filter((row) => row.meaningful).length,
    dispositionCounts,
    unresolvedMeaningfulRegionIds: rows
      .filter((row) => row.meaningful && row.disposition === 'unresolved_candidate_gap')
      .map((row) => row.sourceRegionId),
  });
}

function finding(
  criterion: CurriculumQualityFinding['criterion'],
  severity: CurriculumQualityFinding['severity'],
  code: string,
  rationale: string,
  affectedCurriculumNodeIds: string[] = [],
  affectedSourceRegionIds: string[] = [],
): CurriculumQualityFinding {
  return {
    criterion,
    severity,
    code,
    affectedCurriculumNodeIds: affectedCurriculumNodeIds.slice(0, 100),
    affectedSourceRegionIds: affectedSourceRegionIds.slice(0, 100),
    rationale: rationale.slice(0, 800),
    repairDisposition: 'none',
  };
}

function leadingNumber(title: string): number | null {
  const match = title.trim().match(/^(\d{1,4})(?:[.)、:]|\s)/u);
  return match ? Number(match[1]) : null;
}

function siblingNumberingFindings(curriculum: Curriculum): CurriculumQualityFinding[] {
  const byParent = new Map<string, Curriculum['nodes']>();
  for (const node of curriculum.nodes) {
    const key = node.parentId ?? 'root';
    const siblings = byParent.get(key) ?? [];
    siblings.push(node);
    byParent.set(key, siblings);
  }
  const findings: CurriculumQualityFinding[] = [];
  for (const siblings of byParent.values()) {
    const numbered = siblings
      .map((node) => ({ node, number: leadingNumber(node.title) }))
      .filter(
        (item): item is { node: Curriculum['nodes'][number]; number: number } =>
          item.number !== null,
      );
    if (numbered.length < 3) continue;
    const values = numbered.map((item) => item.number);
    const discontinuity = values.some(
      (value, index) => index > 0 && value !== values[index - 1]! + 1,
    );
    if (discontinuity) {
      findings.push(
        finding(
          'sequencing',
          'error',
          'structural_numbering_discontinuity',
          `Sibling topics use a discontinuous numbering sequence (${values.join(' -> ')}), but the candidate provides no sequence rationale.`,
          numbered.map((item) => item.node.id),
        ),
      );
    }
  }
  return findings;
}

function prerequisiteFindings(curriculum: Curriculum): CurriculumQualityFinding[] {
  const byId = new Map(curriculum.nodes.map((node) => [node.id, node]));
  const order = new Map(
    curriculum.nodes
      .filter((node) => node.kind === 'learning_unit')
      .map((node, index) => [node.id, index] as const),
  );
  const findings: CurriculumQualityFinding[] = [];
  for (const node of curriculum.nodes) {
    for (const prerequisiteId of node.learningUnit?.prerequisiteUnitIds ?? []) {
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite || (order.get(prerequisiteId) ?? -1) >= (order.get(node.id) ?? -1)) {
        findings.push(
          finding(
            'sequencing',
            'error',
            'prerequisite_inversion',
            'A prerequisite appears after its dependent LearningUnit or does not resolve to a current unit.',
            [node.id, prerequisiteId],
          ),
        );
      }
    }
  }
  return findings;
}

function cohesionFindings(
  curriculum: Curriculum,
  sourceRegions: CurriculumSemanticSourceRegion[],
): CurriculumQualityFinding[] {
  const chapters = curriculum.nodes.filter((node) => node.kind === 'chapter');
  if (chapters.length < 2) return [];
  const childrenByParent = new Map<string, Curriculum['nodes']>();
  for (const node of curriculum.nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const descendantsByChapter = chapters.map((chapter) => {
    const descendants: Curriculum['nodes'] = [];
    const pending = [...(childrenByParent.get(chapter.id) ?? [])];
    while (pending.length > 0) {
      const node = pending.shift()!;
      descendants.push(node);
      pending.push(...(childrenByParent.get(node.id) ?? []));
    }
    return descendants;
  });
  const nodeIdsByRegion = sourceRegionNodeIds(curriculum, sourceRegions);
  const tokensByChapter = chapters.map((chapter, index) => {
    const descendants = descendantsByChapter[index]!;
    const descendantIds = new Set(descendants.map((node) => node.id));
    const sourceTitles = sourceRegions
      .filter((region) =>
        (nodeIdsByRegion.get(region.id) ?? []).some((nodeId) => descendantIds.has(nodeId)),
      )
      .map((region) => region.title);
    return features(
      [chapter.title, ...descendants.map((node) => node.title), ...sourceTitles].join(' '),
    );
  });
  const findings: CurriculumQualityFinding[] = [];
  for (let left = 0; left < chapters.length; left += 1) {
    for (let right = left + 1; right < chapters.length; right += 1) {
      const shared = [...tokensByChapter[left]!].filter((token) =>
        tokensByChapter[right]!.has(token),
      );
      const meaningfulShared = shared.filter(
        (token) =>
          !SEMANTIC_STOPWORDS.has(token) &&
          !/^(?:course|chapter|module|part|section|课程|章节|模块|内容)$/iu.test(token),
      );
      if (meaningfulShared.length === 0) continue;
      const leftIds = new Set(descendantsByChapter[left]!.map((node) => node.id));
      const rightIds = new Set(descendantsByChapter[right]!.map((node) => node.id));
      const explainedBySynthesis = curriculum.synthesisGroups.some(
        (group) =>
          group.learningUnitIds.some((id) => leftIds.has(id)) &&
          group.learningUnitIds.some((id) => rightIds.has(id)),
      );
      if (explainedBySynthesis) continue;
      const sourceRegionIds = sourceRegions
        .filter((region) => {
          const sourceFeatures = features(region.title);
          const mappedIds = nodeIdsByRegion.get(region.id) ?? [];
          return (
            mappedIds.some((id) => leftIds.has(id) || rightIds.has(id)) &&
            meaningfulShared.some((token) => sourceFeatures.has(token))
          );
        })
        .map((region) => region.id);
      if (sourceRegionIds.length === 0) continue;
      findings.push(
        finding(
          'conceptual_cohesion',
          'error',
          'semantic_topic_scattering',
          `The same semantic anchor appears in unrelated sibling modules (${meaningfulShared.slice(0, 3).join(', ')}); the candidate provides no synthesis or grouping rationale.`,
          [chapters[left]!.id, chapters[right]!.id],
          sourceRegionIds,
        ),
      );
    }
  }
  return findings;
}

function granularityFindings(
  curriculum: Curriculum,
  coverage: CurriculumCoverageAccountability,
): CurriculumQualityFinding[] {
  const meaningful = coverage.regions.filter((row) => row.meaningful);
  const units = curriculum.nodes.filter(
    (node) => node.kind === 'learning_unit' && node.learningUnit,
  );
  if (meaningful.length < 8 || units.length > Math.max(2, Math.ceil(meaningful.length / 4)))
    return [];
  const blockCountByUnit = units.map((unit) => {
    const refs = new Set(
      unit.sourceReferences.flatMap((reference) =>
        reference.sourceBlockId ? [reference.sourceBlockId] : [],
      ),
    );
    return meaningful.reduce(
      (count, row) => count + row.sourceBlockIds.filter((id) => refs.has(id)).length,
      0,
    );
  });
  const totalBlocks = meaningful.reduce((count, row) => count + row.sourceBlockIds.length, 0);
  const largestShare = totalBlocks === 0 ? 0 : Math.max(...blockCountByUnit) / totalBlocks;
  if (largestShare >= 0.55) {
    return [
      finding(
        'granularity',
        'error',
        'over_compressed_systematic_route',
        `A rich source corpus (${meaningful.length} meaningful regions) is compressed into ${units.length} units, with one unit carrying ${(largestShare * 100).toFixed(0)}% of meaningful source blocks.`,
        units.map((unit) => unit.id),
        meaningful.map((row) => row.sourceRegionId),
      ),
    ];
  }
  return [];
}

function objectiveFindings(
  curriculum: Curriculum,
  sourceRegions: CurriculumSemanticSourceRegion[],
): CurriculumQualityFinding[] {
  const regionFeatures = new Map(
    sourceRegions.map((region) => [region.id, features(region.title)]),
  );
  const findings: CurriculumQualityFinding[] = [];
  for (const unit of curriculum.nodes.filter(
    (node) => node.kind === 'learning_unit' && node.learningUnit,
  )) {
    const titleFeatures = features(unit.title);
    const sourceFeatures = new Set<string>();
    for (const region of sourceRegions) {
      if (
        unit.sourceReferences.some(
          (reference) =>
            reference.sourceBlockId && region.sourceBlockIds.includes(reference.sourceBlockId),
        )
      ) {
        for (const token of regionFeatures.get(region.id) ?? []) sourceFeatures.add(token);
      }
    }
    for (const objective of unit.learningUnit!.objectives) {
      const objectiveFeatures = features(`${objective.title} ${objective.description}`);
      if (
        objectiveFeatures.size > 0 &&
        !overlaps(objectiveFeatures, new Set([...titleFeatures, ...sourceFeatures]))
      ) {
        findings.push(
          finding(
            'objective_alignment',
            'warning',
            'objective_parent_topic_mismatch',
            `Objective “${objective.title}” has no meaningful semantic anchor in its parent unit title or exact source-region titles.`,
            [unit.id],
          ),
        );
      }
      if (
        objective.priority === 'required' &&
        (!objective.formalAssessmentReady || objective.truthAuthorityRecordIds.length === 0)
      ) {
        const affectedSourceBlockIds = unit.sourceReferences
          .map((reference) => reference.sourceBlockId)
          .filter((id): id is string => id !== null)
          .slice(0, 100);
        const authorityCritique: CurriculumAuthorityCritique = {
          objectiveId: objective.id,
          objectiveKey: null,
          currentClaim: `${objective.title}: ${objective.description}`,
          affectedSourceRegionIds: [],
          affectedSourceBlockIds,
          authorityTier: objective.authorityEnvelopeTier ?? 'unavailable',
          supportedConstructs: objective.formalAssessmentConstruct
            ? [objective.formalAssessmentConstruct]
            : [],
          narrowerClaim: null,
          reason:
            objective.formalAssessmentReadinessRationale ??
            'Required objective has no independently authorized Formal Assessment path.',
          protectedPriority: 'required',
        };
        findings.push({
          ...finding(
            'assessment_readiness_compatibility',
            'error',
            'required_objective_formal_authority_missing',
            `Required objective “${objective.title}” is broader than the exact independently authorized source premises available for Formal Assessment.`,
            [unit.id],
          ),
          authorityCritique,
        });
      }
    }
  }
  return findings;
}

export function evaluateCurriculumSemantics(
  input: CurriculumSemanticEvaluationInput,
  options: { boundedRepairAttempted?: boolean } = {},
): CurriculumSemanticEvaluationResult {
  const coverage = buildCurriculumCoverageAccountability(input);
  const findings: CurriculumQualityFinding[] = [];
  if (coverage.unresolvedMeaningfulRegionIds.length > 0) {
    findings.push(
      finding(
        'coverage_accountability',
        input.scope === 'systematic_mastery' ? 'error' : 'warning',
        'unresolved_meaningful_source_gap',
        `${coverage.unresolvedMeaningfulRegionIds.length} meaningful source regions have no explicit teach, synthesis, duplicate, boilerplate, or scope disposition.`,
        [],
        coverage.unresolvedMeaningfulRegionIds,
      ),
    );
  }
  findings.push(...siblingNumberingFindings(input.curriculum));
  findings.push(...prerequisiteFindings(input.curriculum));
  findings.push(...cohesionFindings(input.curriculum, input.sourceRegions));
  findings.push(...granularityFindings(input.curriculum, coverage));
  findings.push(...objectiveFindings(input.curriculum, input.sourceRegions));
  const evaluation = CurriculumSemanticEvaluationSchema.parse({
    schemaVersion: 1,
    policyVersion: CURRICULUM_SEMANTIC_EVALUATOR_POLICY_VERSION,
    evaluator: 'independent-deterministic-semantic-evaluator',
    independent: true,
    status: findings.some((item) => item.severity === 'error') ? 'fail' : 'pass',
    boundedRepairAttempted: options.boundedRepairAttempted ?? false,
    findings,
    evaluatedAt: input.evaluatedAt,
  });
  return { coverage, evaluation };
}

/** Run at most one critique/repair callback and re-evaluate the repaired artifact independently. */
export function evaluateCurriculumWithBoundedRepair(
  input: CurriculumSemanticEvaluationInput,
  repair?: (evaluation: CurriculumSemanticEvaluationResult) => Curriculum,
): CurriculumSemanticEvaluationResult {
  const initial = evaluateCurriculumSemantics(input);
  if (initial.evaluation.status === 'pass' || !repair) return initial;
  const repaired = repair(initial);
  return evaluateCurriculumSemantics(
    { ...input, curriculum: repaired },
    { boundedRepairAttempted: true },
  );
}
