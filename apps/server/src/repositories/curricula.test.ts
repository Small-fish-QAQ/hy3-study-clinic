import { beforeEach, describe, expect, it } from 'vitest';
import type { Curriculum, ObjectiveAuthoritySemanticSupport } from '@hy3-clinic/shared';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import {
  CurriculumObjectiveAuthoritySemanticSupportError,
  curriculumObjectiveProposition,
  fingerprintObjectiveAuthorityBinding,
  fingerprintObjectiveAuthorityProposition,
} from '../services/objectiveAuthoritySemanticSupport.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
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

function semanticSupport(objectiveId = 'objective_1'): ObjectiveAuthoritySemanticSupport {
  const authorityRecordIds = ['authority_1'];
  const sourceBlockIds = ['blk_1'];
  const authorityClaimIds = ['claim_1'];
  return {
    schemaVersion: 1,
    policyVersion: 'objective-authority-semantic-support-v1',
    evaluator: 'independent-semantic-evaluator-v1',
    provider: 'fake',
    providerModel: null,
    independent: true,
    objectiveId,
    proposition: OBJECTIVE_PROPOSITION,
    propositionFingerprint: fingerprintObjectiveAuthorityProposition(OBJECTIVE_PROPOSITION),
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
        text: OBJECTIVE_PROPOSITION,
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

function createVersion(input: Curriculum): Curriculum {
  return repos.curricula.createVersion(input, {
    id: `event_${input.id}`,
    eventType: 'proposed',
    actor: 'local',
    payload: {},
    createdAt: T0,
  });
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
