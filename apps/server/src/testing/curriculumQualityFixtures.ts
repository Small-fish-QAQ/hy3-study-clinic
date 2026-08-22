import type { Curriculum } from '@hy3-clinic/shared';
import type { CurriculumSemanticSourceRegion } from '../services/curriculumSemanticEvaluator.js';

const TOPICS = [
  'System positioning',
  'Embedding foundations',
  'Embedding indexes',
  'Similarity search',
  'Retrieval filters',
  'RAG workflow',
  'Context windows',
  'Grounded prompting',
  'Citation validation',
  'Evaluation design',
  'Failure analysis',
  'Permissions model',
  'Permission boundaries',
  'Workspace isolation',
  'Role transitions',
  'Audit logging',
  'Operations lifecycle',
  'Retries and cancellation',
  'Cost budgets',
  'Security controls',
  'Synthesis patterns',
  'Transfer cases',
  'Capstone architecture',
  'Troubleshooting',
];

export const HUMAN_SMOKE_LARGE_SOURCE_REGIONS: CurriculumSemanticSourceRegion[] = TOPICS.map(
  (title, index) => ({
    id: `large-region-${index + 1}`,
    materialId: 'large-material',
    materialRevisionId: 'large-revision',
    title,
    sourceSectionIds: [`large-section-${index + 1}`],
    sourceBlockIds: [`large-block-${index + 1}`],
    charCount: 420 + index * 11,
  }),
);

export function makeLargeCurriculum(groupSize: number): Curriculum {
  const units = Array.from(
    { length: Math.ceil(TOPICS.length / groupSize) },
    (_value, unitIndex) => {
      const start = unitIndex * groupSize;
      const topicRows = HUMAN_SMOKE_LARGE_SOURCE_REGIONS.slice(start, start + groupSize);
      return {
        id: `large-unit-${unitIndex + 1}`,
        parentId: `large-chapter-${Math.floor(unitIndex / 2) + 1}`,
        kind: 'learning_unit' as const,
        index: unitIndex % 2,
        title: topicRows.map((row) => row.title).join(' / '),
        sourceReferences: topicRows.map((row) => ({
          materialId: row.materialId,
          materialRevisionId: row.materialRevisionId,
          structuralUnitId: null,
          sourceBlockId: row.sourceBlockIds[0]!,
          sourceBlockRevisionFingerprint: `fingerprint-${row.sourceBlockIds[0]}`,
        })),
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              id: `large-objective-${unitIndex + 1}`,
              title: topicRows[0]?.title ?? `Unit ${unitIndex + 1}`,
              description: `Explain and apply ${topicRows.map((row) => row.title).join(', ')}.`,
              truthPremiseStatus: 'not_applicable' as const,
              truthAuthorityRecordIds: [],
            },
          ],
          prerequisiteUnitIds: unitIndex > 0 ? [`large-unit-${unitIndex}`] : [],
          graphRelationIds: [],
          riskIds: [],
        },
      };
    },
  );
  const chapters = Array.from({ length: Math.ceil(units.length / 2) }, (_value, chapterIndex) => ({
    id: `large-chapter-${chapterIndex + 1}`,
    parentId: 'large-course',
    kind: 'chapter' as const,
    index: chapterIndex,
    title:
      [
        'Foundations and retrieval',
        'Grounding, evaluation, and permissions',
        'Operations, security, and transfer',
        'Advanced applications',
      ][chapterIndex] ?? `Module ${chapterIndex + 1}`,
    sourceReferences: [],
    learningUnit: null,
  }));
  return {
    id: `large-curriculum-${groupSize}`,
    workspaceId: 'large-workspace',
    contractVersionId: 'large-contract',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'large-manifest',
      revisions: [
        {
          materialId: 'large-material',
          materialRevisionId: 'large-revision',
          parserVersion: null,
          parserFingerprint: null,
          sourceBlockRevisionIds: HUMAN_SMOKE_LARGE_SOURCE_REGIONS.flatMap(
            (row) => row.sourceBlockIds,
          ),
        },
      ],
    },
    nodes: [
      {
        id: 'large-course',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Human Smoke shaped systems course',
        sourceReferences: [],
        learningUnit: null,
      },
      ...chapters,
      ...units,
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    acceptedAt: null,
  };
}
