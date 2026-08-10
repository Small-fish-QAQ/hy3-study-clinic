import {
  CoverageRiskEntrySchema,
  fnv1a32,
  type CoverageRiskEntry,
  type Curriculum,
  type LearningContract,
} from '@hy3-clinic/shared';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';

interface CoverageRiskAgentDeps {
  repos: Repositories;
  clock: Clock;
}

function stableRiskId(contractId: string, key: string): string {
  return `risk_${fnv1a32(`${contractId}:${key}`).toString(16).padStart(8, '0')}`;
}

function blockFingerprint(content: string): string {
  return `block_${fnv1a32(content).toString(16).padStart(8, '0')}`;
}

function scopeFingerprint(contract: LearningContract): string {
  return `scope_${fnv1a32(JSON.stringify(contract.courseScope)).toString(16).padStart(8, '0')}`;
}

/** Deterministic Phase-2 risks only. Semantic discovery remains a later phase. */
export function createCoverageRiskAgentService({ repos, clock }: CoverageRiskAgentDeps) {
  function seedCurriculum(contract: LearningContract, curriculum: Curriculum): CoverageRiskEntry[] {
    const now = clock.now().toISOString();
    const created: CoverageRiskEntry[] = [];
    const materialByRevision = new Map(
      curriculum.executionSourceManifest.revisions.map((revision) => [
        revision.materialRevisionId,
        revision.materialId,
      ]),
    );
    const referencedBlocks = new Set(
      curriculum.nodes.flatMap((node) =>
        node.sourceReferences.flatMap((reference) =>
          reference.sourceBlockId ? [reference.sourceBlockId] : [],
        ),
      ),
    );

    const persist = (risk: CoverageRiskEntry): void => {
      const existing = repos.coverageRisks.get(risk.id);
      if (existing) {
        created.push(existing);
        return;
      }
      created.push(
        repos.coverageRisks.create(risk, {
          id: newId('risk_evt'),
          eventType: 'deterministic_risk_seeded',
          actor: 'local',
          payload: { curriculumId: curriculum.id },
          createdAt: now,
        }),
      );
    };

    for (const revision of curriculum.executionSourceManifest.revisions) {
      for (const blockId of revision.sourceBlockRevisionIds) {
        if (referencedBlocks.has(blockId)) continue;
        const block = repos.materials
          .getBlocks(revision.materialId)
          .find((item) => item.id === blockId);
        if (!block) continue;
        persist(
          CoverageRiskEntrySchema.parse({
            id: stableRiskId(contract.id, `unmapped-block:${blockId}`),
            workspaceId: contract.workspaceId,
            contractVersionId: contract.id,
            stableScopeFingerprint: scopeFingerprint(contract),
            materialId: revision.materialId,
            topicId: null,
            objectiveId: null,
            facets: ['present_in_course_material', 'unresolved_unverified_risk'],
            scopeAuthorityStatus: 'in_scope',
            truthPremiseStatus: 'not_applicable',
            truthAuthorityRecordIds: [],
            referencedCurriculumNodeIds: [],
            referencedConceptIds: [],
            referencedEvidenceIds: [],
            origin: 'deterministic',
            status: 'open',
            severity: 'medium',
            priority: 60,
            contractSensitive: true,
            claim: `An active source block is not mapped into Curriculum ${curriculum.version}.`,
            uncertainty:
              'This is a structural omission signal, not proof that a semantic topic is missing.',
            observations: [
              {
                id: newId('risk_obs'),
                materialRevisionId: revision.materialRevisionId,
                sourceBlockId: block.id,
                sourceBlockRevisionFingerprint: blockFingerprint(block.content),
                executionSourceManifestFingerprint: curriculum.executionSourceManifest.fingerprint,
                reconciliationStatus: 'current',
                observedAt: now,
                lastVerifiedAt: now,
              },
            ],
            resolutionEvidenceIds: [],
            learnerDecisionId: null,
            provider: null,
            providerModel: null,
            promptVersion: null,
            firstObservedAt: now,
            updatedAt: now,
          }),
        );
      }
    }

    for (const node of curriculum.nodes) {
      if (!node.learningUnit) continue;
      for (const objective of node.learningUnit.objectives) {
        if (objective.truthPremiseStatus === 'independently_verified') continue;
        const reference = node.sourceReferences[0] ?? null;
        const materialRevisionId = reference?.materialRevisionId ?? null;
        persist(
          CoverageRiskEntrySchema.parse({
            id: stableRiskId(contract.id, `unverified-objective:${objective.id}`),
            workspaceId: contract.workspaceId,
            contractVersionId: contract.id,
            stableScopeFingerprint: scopeFingerprint(contract),
            materialId:
              reference?.materialId ??
              (materialRevisionId ? (materialByRevision.get(materialRevisionId) ?? null) : null),
            topicId: node.id,
            objectiveId: objective.id,
            facets: ['included_in_curriculum', 'unresolved_unverified_risk'],
            scopeAuthorityStatus: 'in_scope',
            truthPremiseStatus: objective.truthPremiseStatus,
            truthAuthorityRecordIds: objective.truthAuthorityRecordIds,
            referencedCurriculumNodeIds: [node.id],
            referencedConceptIds: node.learningUnit.conceptIds,
            referencedEvidenceIds: [],
            origin: 'deterministic',
            status: 'open',
            severity: 'medium',
            priority: 65,
            contractSensitive: true,
            claim: `Curriculum objective is in learner scope but lacks independently authorized assessment premises: ${objective.title}`,
            uncertainty:
              'The objective may be taught as AI Teaching but cannot block formal progression yet.',
            observations: reference
              ? [
                  {
                    id: newId('risk_obs'),
                    materialRevisionId: reference.materialRevisionId,
                    sourceBlockId: reference.sourceBlockId,
                    sourceBlockRevisionFingerprint: reference.sourceBlockRevisionFingerprint,
                    executionSourceManifestFingerprint:
                      curriculum.executionSourceManifest.fingerprint,
                    reconciliationStatus: 'current',
                    observedAt: now,
                    lastVerifiedAt: now,
                  },
                ]
              : [],
            resolutionEvidenceIds: [],
            learnerDecisionId: null,
            provider: null,
            providerModel: null,
            promptVersion: null,
            firstObservedAt: now,
            updatedAt: now,
          }),
        );
      }
    }
    return created;
  }

  return { seedCurriculum };
}

export type CoverageRiskAgentService = ReturnType<typeof createCoverageRiskAgentService>;
