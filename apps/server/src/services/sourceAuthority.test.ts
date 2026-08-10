import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createMaterialsRepo } from '../repositories/materials.js';
import {
  createSourceAuthorityRepo,
  type SourceAuthorityRepo,
} from '../repositories/sourceAuthority.js';
import { createWorkspacesRepo } from '../repositories/workspaces.js';
import { makeBlock, makeMaterial, makeWorkspace, T0 } from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';
import { createSourceAuthorityService, type SourceAuthorityService } from './sourceAuthority.js';

const MATERIAL_ID = 'mat_authority';
const BLOCK_ID = 'blk_authority';
const REVISION_ID = 'rev_authority_1';
const LOGICAL_SOURCE_ID = `material:${MATERIAL_ID}`;
const QUOTE = '工作记忆容量有限';

let db: SqliteDb;
let repo: SourceAuthorityRepo;
let service: SourceAuthorityService;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  createWorkspacesRepo(db).insert(makeWorkspace());
  createMaterialsRepo(db).insertWithBlocks(
    makeMaterial({
      id: MATERIAL_ID,
      content: `${QUOTE}，需要通过复述维持。`,
      charCount: `${QUOTE}，需要通过复述维持。`.length,
    }),
    [
      makeBlock({
        id: BLOCK_ID,
        materialId: MATERIAL_ID,
        content: `${QUOTE}，需要通过复述维持。`,
        startOffset: 0,
        endOffset: `${QUOTE}，需要通过复述维持。`.length,
      }),
    ],
  );

  const material = db
    .prepare('SELECT active_revision_id FROM materials WHERE id = ?')
    .get(MATERIAL_ID) as { active_revision_id: string | null };
  if (material.active_revision_id === null) {
    db.prepare(
      `INSERT INTO material_revisions (
        id, material_id, revision_number, predecessor_revision_id, status,
        source_type, media_type, original_filename, content, char_count,
        parse_status, page_count, extraction_warnings, parser_version,
        parser_fingerprint, content_fingerprint, original_data, failure_code,
        failure_message, created_at, activated_at
      ) VALUES (?, ?, 1, NULL, 'active', 'paste', NULL, NULL, ?, ?, 'parsed',
                NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      REVISION_ID,
      MATERIAL_ID,
      `${QUOTE}，需要通过复述维持。`,
      `${QUOTE}，需要通过复述维持。`.length,
      T0,
      T0,
    );
    db.prepare('UPDATE materials SET active_revision_id = ? WHERE id = ?').run(
      REVISION_ID,
      MATERIAL_ID,
    );
    db.prepare('UPDATE source_blocks SET material_revision_id = ? WHERE id = ?').run(
      REVISION_ID,
      BLOCK_ID,
    );
  } else {
    db.prepare('UPDATE source_blocks SET material_revision_id = ? WHERE id = ?').run(
      material.active_revision_id,
      BLOCK_ID,
    );
  }

  repo = createSourceAuthorityRepo(db);
  service = createSourceAuthorityService({ sourceAuthority: repo, clock: fixedClock(T0) });
});

function candidateInput(overrides: Record<string, unknown> = {}): unknown {
  const active = db
    .prepare('SELECT active_revision_id FROM materials WHERE id = ?')
    .get(MATERIAL_ID) as { active_revision_id: string };
  return {
    workspaceId: 'ws_1',
    logicalSourceId: LOGICAL_SOURCE_ID,
    materialId: MATERIAL_ID,
    materialRevisionId: active.active_revision_id,
    premiseScope: 'working-memory capacity claims',
    policyBasis: {
      policyVersion: 'source-authority-v1',
      premiseKind: 'claim',
      basis: 'Exact accepted course-source quotation verified locally.',
    },
    actor: 'local_validator',
    claims: [
      {
        claim: 'Working memory has limited capacity.',
        grounding: { blockId: BLOCK_ID, quote: QUOTE },
      },
    ],
    ...overrides,
  };
}

describe('source truth/premise authority', () => {
  it('does not let learner-confirmed material scope or role create truth authority', () => {
    const priorRole = db
      .prepare(
        `SELECT id, version FROM material_role_versions
         WHERE material_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(MATERIAL_ID) as { id: string; version: number } | undefined;
    db.prepare(
      `INSERT INTO material_role_versions (
        id, material_id, version, predecessor_id, role, scope_included,
        learner_confirmed, actor, reason, created_at
      ) VALUES ('role_authority', ?, ?, ?, 'course_material', 1, 1,
                'learner', 'Learner included the textbook.', ?)`,
    ).run(MATERIAL_ID, (priorRole?.version ?? 0) + 1, priorRole?.id ?? null, T0);

    expect(repo.listHistory(LOGICAL_SOURCE_ID)).toEqual([]);
    expect(() => service.createCandidate(candidateInput({ actor: 'learner' }))).toThrow(
      'Learner scope authority cannot create or validate truth authority.',
    );
    expect(repo.listHistory(LOGICAL_SOURCE_ID)).toEqual([]);
  });

  it('requires the exact MaterialRevision and locally verified revision-owned SourceBlock quote', () => {
    expect(() =>
      service.createCandidate(candidateInput({ materialRevisionId: 'rev_not_active' })),
    ).toThrow('exact MaterialRevision');
    expect(() =>
      service.createCandidate(
        candidateInput({
          claims: [
            {
              claim: 'An unsupported claim.',
              grounding: { blockId: 'blk_from_another_revision', quote: QUOTE },
            },
          ],
        }),
      ),
    ).toThrow('源块不存在');
    expect(() =>
      service.createCandidate(
        candidateInput({
          claims: [
            {
              claim: 'An unsupported claim.',
              grounding: { blockId: BLOCK_ID, quote: '资料中不存在的句子' },
            },
          ],
        }),
      ),
    ).toThrow('引文未能在源材料中找到');

    const created = service.createCandidate(candidateInput());
    const active = db
      .prepare('SELECT active_revision_id FROM materials WHERE id = ?')
      .get(MATERIAL_ID) as { active_revision_id: string };
    expect(created.record).toMatchObject({
      materialId: MATERIAL_ID,
      materialRevisionId: active.active_revision_id,
      validationState: 'candidate',
    });
    expect(created.claims).toEqual([
      expect.objectContaining({
        sourceBlockId: BLOCK_ID,
        quote: QUOTE,
        startOffset: 0,
        endOffset: QUOTE.length,
      }),
    ]);
    expect(service.blockingDecision(created.record.id)).toEqual({
      eligible: false,
      reason: 'candidate_not_validated',
    });
  });

  it('keeps unresolved conflicts blocking and records the rejected validation attempt', () => {
    const conflicted = service.createCandidate(candidateInput({ conflictState: 'unresolved' }));

    expect(service.blockingDecision(conflicted.record.id)).toEqual({
      eligible: false,
      reason: 'unresolved_conflict',
    });
    expect(() =>
      service.validate(conflicted.record.id, conflicted.record.version, 'operator'),
    ).toThrow('Unresolved source conflict blocks');
    expect(service.get(conflicted.record.id).record.validationState).toBe('candidate');
    expect(service.get(conflicted.record.id).events.map((event) => event.eventType)).toEqual([
      'candidate_created',
      'validation_blocked',
    ]);
    expect(service.history(LOGICAL_SOURCE_ID)).toHaveLength(1);
  });

  it('retains immutable predecessor versions, copied verified claims, and per-version audit', () => {
    const candidate = service.createCandidate(candidateInput());
    const validated = service.validate(candidate.record.id, 1, 'operator');

    expect(validated.record).toMatchObject({
      version: 2,
      predecessorId: candidate.record.id,
      validationState: 'validated',
      conflictState: 'none',
    });
    expect(service.blockingDecision(validated.record.id)).toEqual({
      eligible: true,
      reason: 'validated_authority',
    });
    expect(service.history(LOGICAL_SOURCE_ID).map((entry) => entry.record.version)).toEqual([1, 2]);
    expect(service.history(LOGICAL_SOURCE_ID)[0]!.record.validationState).toBe('candidate');
    expect(validated.claims.map((claim) => claim.quote)).toEqual([QUOTE]);
    expect(validated.events.map((event) => event.eventType)).toEqual(['validated']);
    expect(() => service.validate(validated.record.id, 1, 'operator')).toThrow('version is stale');
    expect(service.history(LOGICAL_SOURCE_ID)).toHaveLength(2);

    db.prepare("UPDATE material_revisions SET status = 'retired' WHERE id = ?").run(
      validated.record.materialRevisionId,
    );
    expect(service.blockingDecision(validated.record.id)).toEqual({
      eligible: false,
      reason: 'authority_stale',
    });
    expect(service.history(LOGICAL_SOURCE_ID)).toHaveLength(2);
  });
});
