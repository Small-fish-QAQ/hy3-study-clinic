import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Curriculum,
  ObjectiveAuthorityCapabilityRecoveryOrigin,
  ObjectiveAuthoritySemanticSupport,
} from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import {
  CurriculumObjectiveAuthoritySemanticSupportError,
  curriculumObjectiveProposition,
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
} from '../services/objectiveAuthoritySemanticSupport.js';
import { fingerprintCurriculumCapabilitySourceEnvelope } from '../services/curriculumCapabilityRecovery.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { CurriculumCapabilityRecoveryLineageError } from './curricula.js';
import { createRepositories, type Repositories } from './index.js';

let db: SqliteDb;
let repos: Repositories;
let materialRevisionId: string;

const OBJECTIVE_TITLE = 'Explain capacity';
const OBJECTIVE_DESCRIPTION = 'Explain the stated working-memory capacity relationship.';
const OBJECTIVE_PROPOSITION = curriculumObjectiveProposition({
  title: OBJECTIVE_TITLE,
  description: OBJECTIVE_DESCRIPTION,
});
const SECOND_BLOCK_CONTENT = 'Long-term memory has a different retrieval relationship.';
const THIRD_BLOCK_CONTENT = 'This exact claim exists outside the Curriculum manifest.';

function semanticSupport(
  objectiveId = 'objective_1',
  objective: { title: string; description: string } = {
    title: OBJECTIVE_TITLE,
    description: OBJECTIVE_DESCRIPTION,
  },
): ObjectiveAuthoritySemanticSupport {
  const authorityRecordIds = ['authority_1'];
  const sourceBlockIds = ['blk_1'];
  const authorityClaimIds = ['claim_1'];
  const proposition = curriculumObjectiveProposition(objective);
  return {
    schemaVersion: 1,
    policyVersion: 'objective-authority-semantic-support-v1',
    evaluator: 'independent-semantic-evaluator-v1',
    provider: 'fake',
    providerModel: null,
    independent: true,
    objectiveId,
    proposition,
    propositionFingerprint: fingerprintObjectiveAuthorityProposition(proposition),
    construct: 'explain',
    boundAuthorityRecordIds: authorityRecordIds,
    boundSourceBlockIds: sourceBlockIds,
    boundAuthorityClaimIds: authorityClaimIds,
    bindingFingerprint: fingerprintObjectiveAuthorityBinding({
      authorityRecordIds,
      sourceBlockIds,
      authorityClaimIds,
    }),
    fragments: [
      {
        fragmentId: 'fragment_1',
        text: proposition,
        status: 'supported',
        supportType: 'relationship',
        sourceBlockIds: ['blk_1'],
        authorityRecordIds: ['authority_1'],
        authorityClaimIds: ['claim_1'],
        rationale: 'The exact bound claim states the requested relationship.',
      },
    ],
    unsupportedFragmentIds: [],
    conflicts: [],
    overreach: [],
    verdict: 'pass',
    rationale: 'Every proposition fragment maps to exact bound authority.',
    evaluatedAt: T0,
  };
}

function rebindSemanticSupport(
  input: ObjectiveAuthoritySemanticSupport,
  authorityRecordIds: string[],
  sourceBlockIds: string[],
  authorityClaimIds: string[] = input.boundAuthorityClaimIds,
): ObjectiveAuthoritySemanticSupport {
  const rebound = structuredClone(input);
  rebound.boundAuthorityRecordIds = [...authorityRecordIds];
  rebound.boundSourceBlockIds = [...sourceBlockIds];
  rebound.boundAuthorityClaimIds = [...authorityClaimIds];
  rebound.bindingFingerprint = fingerprintObjectiveAuthorityBinding({
    authorityRecordIds,
    sourceBlockIds,
    authorityClaimIds,
  });
  for (const fragment of rebound.fragments) {
    fragment.authorityRecordIds = [...authorityRecordIds];
    fragment.sourceBlockIds = [...sourceBlockIds];
    fragment.authorityClaimIds = [...authorityClaimIds];
  }
  return rebound;
}

function recoveryOrigin(
  predecessor: Curriculum,
  overrides: Partial<ObjectiveAuthorityCapabilityRecoveryOrigin> = {},
): ObjectiveAuthorityCapabilityRecoveryOrigin {
  const predecessorNode = predecessor.nodes[1]!;
  const predecessorObjective = predecessorNode.learningUnit!.objectives[0]!;
  return {
    predecessorCurriculumId: predecessor.id,
    predecessorCurriculumVersion: predecessor.version,
    predecessorLearningUnitId: predecessorNode.id,
    predecessorObjectiveId: predecessorObjective.id,
    predecessorPriority: 'normal',
    contractVersionId: predecessor.contractVersionId,
    executionSourceManifestFingerprint: predecessor.executionSourceManifest.fingerprint,
    sourceEnvelopeFingerprint: fingerprintCurriculumCapabilitySourceEnvelope(predecessorNode),
    ...overrides,
  };
}

function recoverySemanticSupport(
  predecessor: Curriculum,
  objectiveId = 'objective_2',
  originOverrides: Partial<ObjectiveAuthorityCapabilityRecoveryOrigin> = {},
): ObjectiveAuthoritySemanticSupport {
  const support = semanticSupport(objectiveId);
  support.capabilityPreservation = {
    originalProposition: OBJECTIVE_PROPOSITION,
    originalPropositionFingerprint: fingerprintObjectiveAuthorityProposition(OBJECTIVE_PROPOSITION),
    mappings: [
      {
        originalFragmentId: 'recovery_capability_1:F1',
        originalText: OBJECTIVE_PROPOSITION,
        repairedFragmentIds: ['fragment_1'],
        status: 'preserved',
        rationale: 'The successor preserves the complete accepted predecessor capability.',
      },
    ],
    lostOriginalFragmentIds: [],
    verdict: 'pass',
    rationale: 'The accepted predecessor capability is preserved exactly once.',
    recoveryOrigin: recoveryOrigin(predecessor, originOverrides),
  };
  return support;
}

function curriculum(
  options: {
    id?: string;
    semanticSupport?: ObjectiveAuthoritySemanticSupport | null;
  } = {},
): Curriculum {
  const objectiveSupport =
    options.semanticSupport === undefined ? semanticSupport() : options.semanticSupport;
  return {
    id: options.id ?? 'curriculum_1',
    workspaceId: 'ws_1',
    contractVersionId: 'contract_1',
    version: 1,
    predecessorId: null,
    status: 'proposed',
    executionSourceManifest: {
      fingerprint: 'manifest-fingerprint-1',
      revisions: [
        {
          materialId: 'mat_1',
          materialRevisionId,
          parserVersion: 'text-v1',
          parserFingerprint: null,
          sourceBlockRevisionIds: ['blk_1', 'blk_2'],
        },
      ],
    },
    nodes: [
      {
        id: 'root_1',
        parentId: null,
        kind: 'course',
        index: 0,
        title: 'Memory course',
        sourceReferences: [],
        learningUnit: null,
      },
      {
        id: 'unit_1',
        parentId: 'root_1',
        kind: 'learning_unit',
        index: 0,
        title: 'Working-memory capacity',
        sourceReferences: [
          {
            materialId: 'mat_1',
            materialRevisionId,
            structuralUnitId: null,
            sourceBlockId: 'blk_1',
            sourceBlockRevisionFingerprint: 'block-fingerprint-1',
          },
        ],
        learningUnit: {
          conceptIds: [],
          canonicalConceptIds: [],
          objectives: [
            {
              id: 'objective_1',
              title: OBJECTIVE_TITLE,
              description: OBJECTIVE_DESCRIPTION,
              truthPremiseStatus: 'independently_verified',
              truthAuthorityRecordIds: ['authority_1'],
              authorityClaimIds: ['claim_1'],
              formalAssessmentReady: true,
              formalAssessmentReadinessRationale: 'Exact source authority is available.',
              formalAssessmentConstruct: 'explain',
              authorityEnvelopeTier: 'formal_sufficient',
              authoritySourceBlockIds: ['blk_1'],
              formalEvidenceSourceBlockIds: ['blk_1'],
              ...(objectiveSupport ? { semanticSupport: objectiveSupport } : {}),
            },
          ],
          prerequisiteUnitIds: [],
          graphRelationIds: [],
          riskIds: [],
        },
      },
    ],
    synthesisGroups: [],
    validation: { valid: true, errors: [], warnings: [], unmappedStructuralUnitIds: [] },
    provider: 'fake',
    providerModel: null,
    createdAt: T0,
    acceptedAt: null,
  };
}

function recoverySuccessor(
  predecessor: Curriculum,
  options: {
    id?: string;
    originOverrides?: Partial<ObjectiveAuthorityCapabilityRecoveryOrigin>;
    semanticSupport?: ObjectiveAuthoritySemanticSupport;
  } = {},
): Curriculum {
  const objectiveId = 'objective_2';
  const successor = curriculum({
    id: options.id ?? 'curriculum_2',
    semanticSupport:
      options.semanticSupport ??
      recoverySemanticSupport(predecessor, objectiveId, options.originOverrides),
  });
  successor.version = predecessor.version + 1;
  successor.predecessorId = predecessor.id;
  successor.nodes[0]!.id = 'root_2';
  successor.nodes[1]!.id = 'unit_2';
  successor.nodes[1]!.parentId = 'root_2';
  successor.nodes[1]!.learningUnit!.objectives[0]!.id = objectiveId;
  return successor;
}

function createVersion(
  input: Curriculum,
  capabilityRecoveryPredecessorId: string | null = null,
): Curriculum {
  return repos.curricula.createVersion(
    input,
    {
      id: `event_${input.id}`,
      eventType: 'proposed',
      actor: 'local',
      payload: {},
      createdAt: T0,
    },
    { capabilityRecoveryPredecessorId },
  );
}

function acceptVersion(id: string): Curriculum {
  return repos.curricula.accept(id, T0, {
    id: `event_accept_${id}`,
    eventType: 'accepted',
    actor: 'learner',
    payload: {},
    createdAt: T0,
  });
}

function createSecondAuthority(): void {
  repos.sourceAuthority.createVersion({
    id: 'authority_2',
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_authority_2',
    materialId: 'mat_1',
    materialRevisionId,
    predecessorId: null,
    premiseScope: 'long-term-memory-relationship',
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'claim',
      basis: 'exact-source',
    },
    validationState: 'validated',
    conflictState: 'none',
    actor: 'local_validator',
    createdAt: T0,
    updatedAt: T0,
    claims: [
      {
        id: 'claim_2',
        sourceBlockId: 'blk_2',
        claim: SECOND_BLOCK_CONTENT,
        quote: SECOND_BLOCK_CONTENT,
        startOffset: 0,
        endOffset: SECOND_BLOCK_CONTENT.length,
        occurrenceCount: 1,
        createdAt: T0,
      },
    ],
    event: {
      id: 'authority_event_2',
      eventType: 'validated',
      actor: 'local_validator',
      payload: {},
      createdAt: T0,
    },
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
  repos.materials.insertWithBlocks(makeMaterial(), [
    makeBlock(),
    makeBlock({
      id: 'blk_2',
      index: 1,
      heading: 'Long-term memory',
      headingPath: ['Long-term memory'],
      content: SECOND_BLOCK_CONTENT,
      startOffset: 22,
      endOffset: 22 + SECOND_BLOCK_CONTENT.length,
    }),
    makeBlock({
      id: 'blk_3',
      index: 2,
      heading: 'Outside manifest',
      headingPath: ['Outside manifest'],
      content: THIRD_BLOCK_CONTENT,
      startOffset: 22 + SECOND_BLOCK_CONTENT.length,
      endOffset: 22 + SECOND_BLOCK_CONTENT.length + THIRD_BLOCK_CONTENT.length,
    }),
  ]);
  materialRevisionId = repos.materialRevisions.getActive('mat_1')!.id;
  db.prepare(
    `INSERT INTO learning_contract_versions
       (id, workspace_id, version, status, payload, created_at)
     VALUES ('contract_1', 'ws_1', 1, 'learner_confirmed', '{}', ?)`,
  ).run(T0);
  repos.sourceAuthority.createVersion({
    id: 'authority_1',
    workspaceId: 'ws_1',
    logicalSourceId: 'logical_authority_1',
    materialId: 'mat_1',
    materialRevisionId,
    predecessorId: null,
    premiseScope: 'working-memory-capacity',
    policyBasis: {
      policyVersion: 'truth-v1',
      premiseKind: 'claim',
      basis: 'exact-source',
    },
    validationState: 'validated',
    conflictState: 'none',
    actor: 'local_validator',
    createdAt: T0,
    updatedAt: T0,
    claims: [
      {
        id: 'claim_1',
        sourceBlockId: 'blk_1',
        claim: 'Working memory has limited capacity.',
        quote: makeBlock().content,
        startOffset: 0,
        endOffset: makeBlock().content.length,
        occurrenceCount: 1,
        createdAt: T0,
      },
    ],
    event: {
      id: 'authority_event_1',
      eventType: 'validated',
      actor: 'local_validator',
      payload: {},
      createdAt: T0,
    },
  });
  repos.curricula.createManifest('manifest_1', 'ws_1', curriculum().executionSourceManifest, T0);
});

function expectNoCurriculumPersistence(): void {
  expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_node_index').get()).toEqual({
    count: 0,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_index').get()).toEqual({
    count: 0,
  });
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support').get(),
  ).toEqual({ count: 0 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_events').get()).toEqual({ count: 0 });
}

describe('Curriculum objective semantic-support persistence', () => {
  it('persists support atomically outside aggregate JSON and hydrates canonical rows', () => {
    const expectedSupport = semanticSupport();

    const stored = createVersion(curriculum({ semanticSupport: expectedSupport }));

    expect(repos.curricula.getObjectiveSemanticSupport(stored.id)).toEqual([expectedSupport]);
    expect(stored.nodes[1]?.learningUnit?.objectives[0]?.semanticSupport).toEqual(expectedSupport);
    expect(repos.curricula.get(stored.id)).toEqual(stored);
    expect(repos.curricula.list('ws_1')).toEqual([stored]);
    const accepted = repos.curricula.accept(stored.id, T0, {
      id: 'event_accept_curriculum_1',
      eventType: 'accepted',
      actor: 'learner',
      payload: {},
      createdAt: T0,
    });
    expect(accepted.nodes[1]?.learningUnit?.objectives[0]?.semanticSupport).toEqual(
      expectedSupport,
    );
    const aggregate = JSON.parse(
      (
        db.prepare('SELECT payload FROM curriculum_versions WHERE id = ?').get(stored.id) as {
          payload: string;
        }
      ).payload,
    ) as Curriculum;
    expect(aggregate.nodes[1]?.learningUnit?.objectives[0]?.semanticSupport).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT policy_version, evaluator, provider, provider_model, status,
                  proposition_fingerprint, binding_fingerprint, evaluated_at
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .get(stored.id, 'objective_1'),
    ).toEqual({
      policy_version: expectedSupport.policyVersion,
      evaluator: expectedSupport.evaluator,
      provider: expectedSupport.provider,
      provider_model: expectedSupport.providerModel,
      status: expectedSupport.verdict,
      proposition_fingerprint: expectedSupport.propositionFingerprint,
      binding_fingerprint: expectedSupport.bindingFingerprint,
      evaluated_at: expectedSupport.evaluatedAt,
    });
  });

  it('rejects missing, failed, or stale semantic support without leaving partial rows', () => {
    const cases: Array<[string, ObjectiveAuthoritySemanticSupport | null]> = [
      ['missing support', null],
      ['foreign objective identity', semanticSupport('different_objective')],
      [
        'failed support',
        {
          ...semanticSupport(),
          fragments: [
            {
              ...semanticSupport().fragments[0]!,
              status: 'unsupported',
              supportType: null,
              sourceBlockIds: [],
              authorityRecordIds: [],
              authorityClaimIds: [],
            },
          ],
          unsupportedFragmentIds: ['fragment_1'],
          verdict: 'fail',
        },
      ],
      ['stale policy', { ...semanticSupport(), policyVersion: 'obsolete-policy' }],
      ['stale proposition fingerprint', { ...semanticSupport(), propositionFingerprint: 'stale' }],
      ['stale binding fingerprint', { ...semanticSupport(), bindingFingerprint: 'stale' }],
    ];

    for (const [label, support] of cases) {
      expect(() => createVersion(curriculum({ semanticSupport: support })), label).toThrow(
        CurriculumObjectiveAuthoritySemanticSupportError,
      );
      expectNoCurriculumPersistence();
    }

    db.exec(`
      CREATE TRIGGER force_semantic_support_insert_failure
      BEFORE INSERT ON curriculum_objective_semantic_support
      BEGIN SELECT RAISE(ABORT, 'forced semantic-support insert failure'); END;
    `);
    expect(() => createVersion(curriculum())).toThrow(/forced semantic-support insert failure/);
    expectNoCurriculumPersistence();
  });

  it('rejects proposition, construct, and binding mismatches at the persistence boundary', () => {
    const changedText = curriculum();
    changedText.nodes[1]!.learningUnit!.objectives[0]!.description = 'Explain a changed claim.';
    expect(() => createVersion(changedText)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );

    const changedConstruct = curriculum();
    changedConstruct.nodes[1]!.learningUnit!.objectives[0]!.formalAssessmentConstruct = 'identify';
    expect(() => createVersion(changedConstruct)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );

    const changedAuthorityBinding = curriculum();
    changedAuthorityBinding.nodes[1]!.learningUnit!.objectives[0]!.truthAuthorityRecordIds = [
      'authority_foreign',
    ];
    expect(() => createVersion(changedAuthorityBinding)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );

    const changedBlockBinding = curriculum();
    changedBlockBinding.nodes[1]!.learningUnit!.objectives[0]!.authoritySourceBlockIds = ['blk_2'];
    expect(() => createVersion(changedBlockBinding)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );
    expectNoCurriculumPersistence();
  });

  it('rejects forged exact source-authority mappings and blocks outside the manifest', () => {
    const forged = curriculum({
      semanticSupport: rebindSemanticSupport(semanticSupport(), ['authority_1'], ['blk_2']),
    });
    forged.nodes[1]!.learningUnit!.objectives[0]!.authoritySourceBlockIds = ['blk_2'];
    forged.nodes[1]!.learningUnit!.objectives[0]!.formalEvidenceSourceBlockIds = ['blk_2'];
    expect(() => createVersion(forged)).toThrow(
      /authority claim falls outside its mapped record or block/u,
    );

    const outsideManifest = curriculum({
      semanticSupport: rebindSemanticSupport(semanticSupport(), ['authority_1'], ['blk_3']),
    });
    outsideManifest.nodes[1]!.learningUnit!.objectives[0]!.authoritySourceBlockIds = ['blk_3'];
    outsideManifest.nodes[1]!.learningUnit!.objectives[0]!.formalEvidenceSourceBlockIds = ['blk_3'];
    db.prepare(
      `INSERT INTO truth_authority_claims
         (id, authority_record_id, source_block_id, claim, quote, start_offset, end_offset,
          occurrence_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
    ).run(
      'claim_3',
      'authority_1',
      'blk_3',
      THIRD_BLOCK_CONTENT,
      THIRD_BLOCK_CONTENT,
      THIRD_BLOCK_CONTENT.length,
      T0,
    );
    expect(() => createVersion(outsideManifest)).toThrow(/outside its manifest/);
    expectNoCurriculumPersistence();
  });

  it('rejects bogus or substituted claim identities even when the record and block have exact claims', () => {
    const exact = makeBlock().content;
    db.prepare(
      `INSERT INTO truth_authority_claims
         (id, authority_record_id, source_block_id, claim, quote, start_offset, end_offset,
          occurrence_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
    ).run('claim_2', 'authority_1', 'blk_1', exact, exact, exact.length, T0);

    const substituted = curriculum({
      semanticSupport: rebindSemanticSupport(
        semanticSupport(),
        ['authority_1'],
        ['blk_1'],
        ['claim_2'],
      ),
    });
    expect(() => createVersion(substituted)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );
    expectNoCurriculumPersistence();

    const bogus = curriculum({
      semanticSupport: rebindSemanticSupport(
        semanticSupport(),
        ['authority_1'],
        ['blk_1'],
        ['claim_bogus'],
      ),
    });
    bogus.nodes[1]!.learningUnit!.objectives[0]!.authorityClaimIds = ['claim_bogus'];
    expect(() => createVersion(bogus)).toThrow(/missing or inexact authority claim/u);
    expectNoCurriculumPersistence();
  });

  it('rejects a generated mapped claim even when the authority also has an original claim', () => {
    db.prepare(
      `INSERT INTO truth_authority_claims
         (id, authority_record_id, source_block_id, claim, quote, start_offset, end_offset,
          occurrence_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
    ).run(
      'claim_generated',
      'authority_1',
      'blk_2',
      SECOND_BLOCK_CONTENT,
      SECOND_BLOCK_CONTENT,
      SECOND_BLOCK_CONTENT.length,
      T0,
    );
    db.prepare(
      `UPDATE source_blocks SET content_origin = 'derived_visual_description' WHERE id = ?`,
    ).run('blk_2');
    const generatedMapping = curriculum({
      semanticSupport: rebindSemanticSupport(semanticSupport(), ['authority_1'], ['blk_2']),
    });
    generatedMapping.nodes[1]!.learningUnit!.objectives[0]!.authoritySourceBlockIds = ['blk_2'];
    generatedMapping.nodes[1]!.learningUnit!.objectives[0]!.formalEvidenceSourceBlockIds = [
      'blk_2',
    ];

    expect(() => createVersion(generatedMapping)).toThrow(
      /authority claim falls outside its mapped record or block/u,
    );
    expectNoCurriculumPersistence();
  });

  it('rejects mapped claims whose authority record does not own the Curriculum workspace', () => {
    repos.workspaces.insert(makeWorkspace({ id: 'ws_2', name: 'Other course' }));
    db.prepare(`UPDATE truth_authority_records SET workspace_id = 'ws_2' WHERE id = ?`).run(
      'authority_1',
    );

    expect(() => createVersion(curriculum())).toThrow(
      /truth authority is outside its Course source manifest/,
    );
    expectNoCurriculumPersistence();
  });

  it('rejects mapped claims whose authority material or revision does not own the SourceBlock', () => {
    repos.materials.insertWithBlocks(makeMaterial({ id: 'mat_2', title: 'Other material' }), [
      makeBlock({ id: 'blk_foreign', materialId: 'mat_2' }),
    ]);
    const foreignRevisionId = repos.materialRevisions.getActive('mat_2')!.id;

    db.prepare(`UPDATE source_blocks SET material_id = 'mat_2' WHERE id = ?`).run('blk_1');
    const wrongMaterial = curriculum();
    wrongMaterial.nodes[1]!.sourceReferences = [];
    expect(() => createVersion(wrongMaterial)).toThrow(/missing or inexact authority claim/u);
    expectNoCurriculumPersistence();

    db.prepare(
      `UPDATE source_blocks
       SET material_id = 'mat_1', material_revision_id = ?
       WHERE id = ?`,
    ).run(foreignRevisionId, 'blk_1');
    const wrongRevision = curriculum();
    wrongRevision.nodes[1]!.sourceReferences = [];
    expect(() => createVersion(wrongRevision)).toThrow(/missing or inexact authority claim/u);
    expectNoCurriculumPersistence();
  });

  it('rejects semantic support whose authority is no longer blocking-eligible', () => {
    db.prepare(
      `UPDATE truth_authority_records
       SET validation_state = 'stale'
       WHERE id = 'authority_1'`,
    ).run();
    const unverified = curriculum();
    unverified.nodes[1]!.learningUnit!.objectives[0]!.truthPremiseStatus = 'unverified';

    expect(() => createVersion(unverified)).toThrow(
      CurriculumObjectiveAuthoritySemanticSupportError,
    );
    expectNoCurriculumPersistence();
  });

  it('revalidates canonical semantic support before repository acceptance', () => {
    const stored = createVersion(curriculum());
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_update');
    const failed = semanticSupport();
    failed.fragments = [
      {
        ...failed.fragments[0]!,
        status: 'unsupported',
        supportType: null,
        sourceBlockIds: [],
        authorityRecordIds: [],
        authorityClaimIds: [],
      },
    ];
    failed.unsupportedFragmentIds = ['fragment_1'];
    failed.verdict = 'fail';
    db.prepare(
      `UPDATE curriculum_objective_semantic_support
       SET status = 'fail', payload = ?
       WHERE curriculum_id = ? AND objective_id = ?`,
    ).run(JSON.stringify(failed), stored.id, 'objective_1');

    expect(() =>
      repos.curricula.accept(stored.id, T0, {
        id: 'event_accept_invalid',
        eventType: 'accepted',
        actor: 'learner',
        payload: {},
        createdAt: T0,
      }),
    ).toThrow(CurriculumObjectiveAuthoritySemanticSupportError);
    expect(repos.curricula.get(stored.id)?.status).toBe('proposed');
    expect(repos.curricula.listEvents(stored.id)).toHaveLength(1);
  });

  it('rechecks blocking authority eligibility before repository acceptance', () => {
    const stored = createVersion(curriculum());
    db.prepare(
      `UPDATE truth_authority_records
       SET validation_state = 'stale'
       WHERE id = 'authority_1'`,
    ).run();

    expect(() =>
      repos.curricula.accept(stored.id, T0, {
        id: 'event_accept_stale_authority',
        eventType: 'accepted',
        actor: 'learner',
        payload: {},
        createdAt: T0,
      }),
    ).toThrow(CurriculumObjectiveAuthoritySemanticSupportError);
    expect(repos.curricula.get(stored.id)?.status).toBe('proposed');
    expect(repos.curricula.listEvents(stored.id)).toHaveLength(1);
  });

  it('fails closed when an accepted current Curriculum claim loses its exact offset', () => {
    const accepted = acceptVersion(createVersion(curriculum()).id);
    db.prepare('UPDATE truth_authority_claims SET start_offset = 1 WHERE id = ?').run('claim_1');

    expect(() => repos.curricula.get(accepted.id)).toThrow(/missing or inexact authority claim/u);
    expect(() => repos.curricula.list('ws_1')).toThrow(/missing or inexact authority claim/u);
    expect(
      db.prepare('SELECT status FROM curriculum_versions WHERE id = ?').get(accepted.id),
    ).toEqual({ status: 'accepted' });
  });

  it('does not let another valid same-record claim mask a missing selected claim on hydration', () => {
    const accepted = acceptVersion(createVersion(curriculum()).id);
    const exact = makeBlock().content;
    db.prepare(
      `INSERT INTO truth_authority_claims
         (id, authority_record_id, source_block_id, claim, quote, start_offset, end_offset,
          occurrence_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
    ).run('claim_mask', 'authority_1', 'blk_1', exact, exact, exact.length, T0);
    db.prepare('DELETE FROM truth_authority_claims WHERE id = ?').run('claim_1');

    expect(repos.sourceAuthority.isBlockingEligible('authority_1')).toBe(true);
    expect(() => repos.curricula.get(accepted.id)).toThrow(/missing or inexact authority claim/u);
    expect(() => repos.curricula.list('ws_1')).toThrow(/missing or inexact authority claim/u);
  });

  it("does not let another eligible claim mask a selected claim's changed record ownership", () => {
    const accepted = acceptVersion(createVersion(curriculum()).id);
    const exact = makeBlock().content;
    db.prepare(
      `INSERT INTO truth_authority_claims
         (id, authority_record_id, source_block_id, claim, quote, start_offset, end_offset,
          occurrence_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
    ).run('claim_mask', 'authority_1', 'blk_1', exact, exact, exact.length, T0);
    repos.sourceAuthority.createVersion({
      id: 'authority_2',
      workspaceId: 'ws_1',
      logicalSourceId: 'logical_authority_2',
      materialId: 'mat_1',
      materialRevisionId,
      predecessorId: null,
      premiseScope: 'different-capacity-claim',
      policyBasis: {
        policyVersion: 'truth-v1',
        premiseKind: 'claim',
        basis: 'exact-source',
      },
      validationState: 'validated',
      conflictState: 'none',
      actor: 'local_validator',
      createdAt: T0,
      updatedAt: T0,
      claims: [
        {
          id: 'claim_authority_2',
          sourceBlockId: 'blk_1',
          claim: 'A different exact claim.',
          quote: exact,
          startOffset: 0,
          endOffset: exact.length,
          occurrenceCount: 1,
          createdAt: T0,
        },
      ],
      event: {
        id: 'authority_event_2',
        eventType: 'validated',
        actor: 'local_validator',
        payload: {},
        createdAt: T0,
      },
    });
    db.prepare(
      `UPDATE truth_authority_claims
       SET authority_record_id = ?
       WHERE id = ?`,
    ).run('authority_2', 'claim_1');

    expect(repos.sourceAuthority.isBlockingEligible('authority_1')).toBe(true);
    expect(repos.sourceAuthority.isBlockingEligible('authority_2')).toBe(true);
    expect(() => repos.curricula.get(accepted.id)).toThrow(
      /missing or inexact authority claim ownership/u,
    );
    expect(() => repos.curricula.list('ws_1')).toThrow(
      /missing or inexact authority claim ownership/u,
    );
  });

  it('rejects direct mutation and deletion while allowing the owning Curriculum cascade', () => {
    const stored = createVersion(curriculum());

    expect(() =>
      db
        .prepare(
          `UPDATE curriculum_objective_semantic_support SET status = 'fail'
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .run(stored.id, 'objective_1'),
    ).toThrow(/semantic support is immutable/i);
    expect(() =>
      db
        .prepare(
          `DELETE FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? AND objective_id = ?`,
        )
        .run(stored.id, 'objective_1'),
    ).toThrow(/semantic support is immutable/i);

    expect(() =>
      db.prepare('DELETE FROM curriculum_versions WHERE id = ?').run(stored.id),
    ).not.toThrow();
    expect(repos.curricula.getObjectiveSemanticSupport(stored.id)).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('Curriculum capability-recovery lineage persistence', () => {
  it('round-trips one exact accepted-ancestor recovery origin', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const expected = recoverySuccessor(predecessor);

    const stored = createVersion(expected, predecessor.id);

    expect(stored).toEqual(expected);
    expect(repos.curricula.get(stored.id)).toEqual(expected);
    expect(repos.curricula.list('ws_1')).toEqual([predecessor, expected]);
    expect(repos.curricula.getObjectiveSemanticSupport(stored.id)).toEqual([
      recoverySemanticSupport(predecessor),
    ]);
    expect(
      stored.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation!
        .recoveryOrigin,
    ).toEqual(recoveryOrigin(predecessor));
  });

  it('rejects B acceptance after C persists with A recovery lineage', () => {
    const acceptedAncestor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_accepted_ancestor' })).id,
    );
    const intermediate = createVersion(
      recoverySuccessor(acceptedAncestor, { id: 'curriculum_intermediate' }),
      acceptedAncestor.id,
    );
    const descendantCandidate = recoverySuccessor(acceptedAncestor, {
      id: 'curriculum_descendant',
    });
    descendantCandidate.version = intermediate.version + 1;
    descendantCandidate.predecessorId = intermediate.id;
    const descendant = createVersion(descendantCandidate, acceptedAncestor.id);
    expect(acceptedAncestor.status).toBe('accepted');
    expect(intermediate).toMatchObject({
      predecessorId: acceptedAncestor.id,
      status: 'proposed',
    });
    expect(descendant).toMatchObject({ predecessorId: intermediate.id, status: 'proposed' });
    expect(
      descendant.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation!
        .recoveryOrigin?.predecessorCurriculumId,
    ).toBe(acceptedAncestor.id);
    const descendantSnapshot = structuredClone(descendant);
    const persistedDescendantBefore = {
      aggregate: db
        .prepare(
          'SELECT status, accepted_at, hex(payload) AS payload FROM curriculum_versions WHERE id = ?',
        )
        .get(descendant.id),
      semanticSupport: db
        .prepare(
          `SELECT objective_id, hex(payload) AS payload
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(descendant.id),
    };

    expect(() => acceptVersion(intermediate.id)).toThrow(
      /Only the latest Curriculum version may be accepted/u,
    );

    expect(repos.curricula.get(intermediate.id)?.status).toBe('proposed');
    expect(repos.curricula.listEvents(intermediate.id)).toHaveLength(1);
    expect(repos.curricula.get(descendant.id)).toEqual(descendantSnapshot);
    expect(repos.curricula.list('ws_1')).toEqual([
      acceptedAncestor,
      intermediate,
      descendantSnapshot,
    ]);
    expect({
      aggregate: db
        .prepare(
          'SELECT status, accepted_at, hex(payload) AS payload FROM curriculum_versions WHERE id = ?',
        )
        .get(descendant.id),
      semanticSupport: db
        .prepare(
          `SELECT objective_id, hex(payload) AS payload
           FROM curriculum_objective_semantic_support
           WHERE curriculum_id = ? ORDER BY objective_id`,
        )
        .all(descendant.id),
    }).toEqual(persistedDescendantBefore);
  });

  it.each(['superseded', 'rejected'] as const)(
    'hydrates recovery lineage after the accepted predecessor becomes %s',
    (status) => {
      const predecessor = acceptVersion(
        createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
      );
      const successor = createVersion(recoverySuccessor(predecessor), predecessor.id);

      if (status === 'rejected') {
        repos.curricula.reject(predecessor.id, 'Historical artifact is no longer active.', {
          id: 'event_reject_predecessor',
          eventType: 'rejected',
          actor: 'learner',
          payload: {},
          createdAt: T0,
        });
      } else {
        const row = db
          .prepare('SELECT payload FROM curriculum_versions WHERE id = ?')
          .get(predecessor.id) as { payload: string };
        const aggregate = JSON.parse(row.payload) as Curriculum;
        db.prepare(
          `UPDATE curriculum_versions SET status = 'superseded', payload = ? WHERE id = ?`,
        ).run(JSON.stringify({ ...aggregate, status: 'superseded' }), predecessor.id);
      }

      expect(
        db
          .prepare('SELECT status, accepted_at FROM curriculum_versions WHERE id = ?')
          .get(predecessor.id),
      ).toEqual({ status, accepted_at: T0 });
      expect(repos.curricula.get(successor.id)).toEqual(successor);
      expect(repos.curricula.list('ws_1').at(-1)).toEqual(successor);
    },
  );

  it('rejects every forged accepted-predecessor origin field atomically', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const cases: Array<{
      label: string;
      overrides: Partial<ObjectiveAuthorityCapabilityRecoveryOrigin>;
    }> = [
      {
        label: 'predecessor version',
        overrides: { predecessorCurriculumVersion: predecessor.version + 1 },
      },
      {
        label: 'LearningUnit identity',
        overrides: { predecessorLearningUnitId: 'unit_forged' },
      },
      {
        label: 'objective identity',
        overrides: { predecessorObjectiveId: 'objective_forged' },
      },
      { label: 'priority', overrides: { predecessorPriority: 'high' } },
      { label: 'Contract identity', overrides: { contractVersionId: 'contract_forged' } },
      {
        label: 'manifest fingerprint',
        overrides: { executionSourceManifestFingerprint: 'manifest_forged' },
      },
      {
        label: 'source-envelope fingerprint',
        overrides: { sourceEnvelopeFingerprint: 'source_envelope_forged' },
      },
    ];

    for (const testCase of cases) {
      expect(
        () =>
          createVersion(
            recoverySuccessor(predecessor, { originOverrides: testCase.overrides }),
            predecessor.id,
          ),
        testCase.label,
      ).toThrow(CurriculumCapabilityRecoveryLineageError);
      expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
        count: 1,
      });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM curriculum_objective_semantic_support').get(),
      ).toEqual({ count: 1 });
    }
  });

  it('fails hydration when a persisted origin is changed to an existing non-ancestor', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const successor = createVersion(recoverySuccessor(predecessor), predecessor.id);
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_update');
    const row = db
      .prepare(
        `SELECT payload FROM curriculum_objective_semantic_support
         WHERE curriculum_id = ? AND objective_id = ?`,
      )
      .get(successor.id, 'objective_2') as { payload: string };
    const support = JSON.parse(row.payload) as ObjectiveAuthoritySemanticSupport;
    support.capabilityPreservation!.recoveryOrigin!.predecessorCurriculumId = successor.id;
    db.prepare(
      `UPDATE curriculum_objective_semantic_support SET payload = ?
       WHERE curriculum_id = ? AND objective_id = ?`,
    ).run(JSON.stringify(support), successor.id, 'objective_2');

    expect(() => repos.curricula.get(successor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(() => repos.curricula.list('ws_1')).toThrow(CurriculumCapabilityRecoveryLineageError);
    expect(
      db.prepare('SELECT predecessor_id FROM curriculum_versions WHERE id = ?').get(successor.id),
    ).toEqual({ predecessor_id: predecessor.id });
  });

  it('rejects an older compatible accepted ancestor when a nearer accepted predecessor exists', () => {
    const oldest = acceptVersion(createVersion(curriculum({ id: 'curriculum_predecessor' })).id);
    const nearest = acceptVersion(createVersion(recoverySuccessor(oldest), oldest.id).id);
    const successor = recoverySuccessor(nearest, {
      id: 'curriculum_3',
      originOverrides: recoveryOrigin(oldest),
    });

    expect(() => createVersion(successor, nearest.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 2,
    });
  });

  it('rejects a recovery-shaped full frontier when every local origin is stripped', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const support = recoverySemanticSupport(predecessor);
    delete support.capabilityPreservation!.recoveryOrigin;

    expect(() =>
      createVersion(recoverySuccessor(predecessor, { semanticSupport: support }), predecessor.id),
    ).toThrow(CurriculumCapabilityRecoveryLineageError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it.each(['priority', 'preserved proposition'] as const)(
    'rejects stripped origins even when the forged successor changes %s',
    (field) => {
      const predecessor = acceptVersion(
        createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
      );
      const support = recoverySemanticSupport(predecessor);
      delete support.capabilityPreservation!.recoveryOrigin;
      const successor = recoverySuccessor(predecessor, { semanticSupport: support });
      const objective = successor.nodes[1]!.learningUnit!.objectives[0]!;
      if (field === 'priority') {
        objective.priority = 'high';
      } else {
        const forged = 'A forged replacement capability.';
        support.capabilityPreservation!.originalProposition = forged;
        support.capabilityPreservation!.originalPropositionFingerprint =
          fingerprintObjectiveAuthorityProposition(forged);
        support.capabilityPreservation!.mappings[0]!.originalText = forged;
      }

      expect(() => createVersion(successor, predecessor.id)).toThrow(
        CurriculumCapabilityRecoveryLineageError,
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
        count: 1,
      });
    },
  );

  it('rejects a current successor that strips the full recovery preservation from a legacy-invalid predecessor', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
    db.prepare('DELETE FROM curriculum_objective_semantic_support WHERE curriculum_id = ?').run(
      predecessor.id,
    );
    expect(
      repos.curricula.get(predecessor.id)!.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport,
    ).toBeUndefined();
    const support = recoverySemanticSupport(predecessor);
    delete support.capabilityPreservation;

    expect(() =>
      createVersion(recoverySuccessor(predecessor, { semanticSupport: support }), predecessor.id),
    ).toThrow(CurriculumCapabilityRecoveryLineageError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it('does not invent recovery lineage for optional objectives on a legacy-invalid predecessor', () => {
    const predecessorCandidate = curriculum({ id: 'curriculum_predecessor' });
    predecessorCandidate.nodes[1]!.learningUnit!.objectives[0]!.priority = 'optional';
    const predecessor = acceptVersion(createVersion(predecessorCandidate).id);
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
    db.prepare('DELETE FROM curriculum_objective_semantic_support WHERE curriculum_id = ?').run(
      predecessor.id,
    );
    const legacyPredecessor = repos.curricula.get(predecessor.id)!;
    const predecessorSnapshot = structuredClone(legacyPredecessor);
    const successor = recoverySuccessor(predecessor, {
      semanticSupport: semanticSupport('objective_2'),
    });

    const stored = createVersion(successor, null);

    expect(
      stored.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation,
    ).toBeUndefined();
    expect(repos.curricula.get(predecessor.id)).toEqual(predecessorSnapshot);
    expect(repos.curricula.get(stored.id)).toEqual(stored);
  });

  it('rejects an originless successor when local preflight requires recovery from a semantically valid predecessor', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const originlessSupport = semanticSupport('objective_2');
    const successor = recoverySuccessor(predecessor, {
      semanticSupport: originlessSupport,
    });

    expect(() => createVersion(successor, predecessor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_events').get()).toEqual({
      count: 2,
    });
  });

  it('rejects a partial originless preservation frontier from a legacy-invalid predecessor', () => {
    const predecessorCandidate = curriculum({ id: 'curriculum_predecessor' });
    const secondTitle = 'Explain retrieval';
    const secondDescription = 'Explain the stated long-term-memory retrieval relationship.';
    const secondObjective = structuredClone(
      predecessorCandidate.nodes[1]!.learningUnit!.objectives[0]!,
    );
    secondObjective.id = 'objective_predecessor_2';
    secondObjective.title = secondTitle;
    secondObjective.description = secondDescription;
    secondObjective.semanticSupport = semanticSupport(secondObjective.id, {
      title: secondTitle,
      description: secondDescription,
    });
    predecessorCandidate.nodes[1]!.learningUnit!.objectives.push(secondObjective);
    const predecessor = acceptVersion(createVersion(predecessorCandidate).id);

    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
    db.prepare('DELETE FROM curriculum_objective_semantic_support WHERE curriculum_id = ?').run(
      predecessor.id,
    );

    const firstSupport = recoverySemanticSupport(predecessor);
    delete firstSupport.capabilityPreservation!.recoveryOrigin;
    const successor = recoverySuccessor(predecessor, { semanticSupport: firstSupport });
    const ordinarySecondObjective = structuredClone(secondObjective);
    ordinarySecondObjective.id = 'objective_successor_2';
    ordinarySecondObjective.semanticSupport = semanticSupport(ordinarySecondObjective.id, {
      title: secondTitle,
      description: secondDescription,
    });
    successor.nodes[1]!.learningUnit!.objectives.push(ordinarySecondObjective);

    expect(() => createVersion(successor, predecessor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it('rejects coordinated proposition and objective rewrites with stripped origins from a legacy-invalid predecessor', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    db.exec('DROP TRIGGER prevent_curriculum_objective_semantic_support_delete');
    db.prepare('DELETE FROM curriculum_objective_semantic_support WHERE curriculum_id = ?').run(
      predecessor.id,
    );

    const support = recoverySemanticSupport(predecessor);
    delete support.capabilityPreservation!.recoveryOrigin;
    const successor = recoverySuccessor(predecessor, { semanticSupport: support });
    const objective = successor.nodes[1]!.learningUnit!.objectives[0]!;
    objective.title = 'Explain a forged replacement';
    objective.description = 'Explain a different relationship while hiding its recovery origin.';
    const forgedProposition = curriculumObjectiveProposition(objective);
    support.proposition = forgedProposition;
    support.propositionFingerprint = fingerprintObjectiveAuthorityProposition(forgedProposition);
    support.fragments[0]!.text = forgedProposition;
    support.capabilityPreservation!.originalProposition = forgedProposition;
    support.capabilityPreservation!.originalPropositionFingerprint =
      fingerprintObjectiveAuthorityProposition(forgedProposition);
    support.capabilityPreservation!.mappings[0]!.originalText = forgedProposition;

    expect(() => createVersion(successor, predecessor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it('rejects successor authority that escapes the predecessor LearningUnit envelope', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    createSecondAuthority();
    const support = rebindSemanticSupport(
      recoverySemanticSupport(predecessor),
      ['authority_2'],
      ['blk_2'],
      ['claim_2'],
    );
    const successor = recoverySuccessor(predecessor, { semanticSupport: support });
    const objective = successor.nodes[1]!.learningUnit!.objectives[0]!;
    objective.truthAuthorityRecordIds = ['authority_2'];
    objective.authorityClaimIds = ['claim_2'];
    objective.authoritySourceBlockIds = ['blk_2'];
    objective.formalEvidenceSourceBlockIds = ['blk_2'];

    expect(() => createVersion(successor, predecessor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it('rejects duplicate successor origins for one predecessor capability', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const successor = recoverySuccessor(predecessor);
    const duplicate = structuredClone(successor.nodes[1]!.learningUnit!.objectives[0]!);
    duplicate.id = 'objective_3';
    duplicate.semanticSupport = recoverySemanticSupport(predecessor, duplicate.id);
    successor.nodes[1]!.learningUnit!.objectives.push(duplicate);

    expect(() => createVersion(successor, predecessor.id)).toThrow(
      CurriculumCapabilityRecoveryLineageError,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM curriculum_versions').get()).toEqual({
      count: 1,
    });
  });

  it('leaves ordinary non-recovery semantic-support artifacts unaffected', () => {
    const proposed = createVersion(curriculum());

    expect(
      proposed.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation,
    ).toBeUndefined();
    expect(repos.curricula.get(proposed.id)).toEqual(proposed);
    const accepted = acceptVersion(proposed.id);
    expect(repos.curricula.get(accepted.id)).toEqual(accepted);
    expect(repos.curricula.list('ws_1')).toEqual([accepted]);
  });

  it('keeps an originless bounded semantic repair when local persistence declares no recovery frontier', () => {
    const predecessor = acceptVersion(
      createVersion(curriculum({ id: 'curriculum_predecessor' })).id,
    );
    const support = recoverySemanticSupport(predecessor);
    delete support.capabilityPreservation!.recoveryOrigin;
    const ordinaryRepair = recoverySuccessor(predecessor, { semanticSupport: support });

    const stored = createVersion(ordinaryRepair, null);

    expect(
      stored.nodes[1]!.learningUnit!.objectives[0]!.semanticSupport!.capabilityPreservation,
    ).toEqual(support.capabilityPreservation);
    expect(repos.curricula.get(stored.id)).toEqual(stored);
  });
});
