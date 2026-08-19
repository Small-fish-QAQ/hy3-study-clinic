import { createHash } from 'node:crypto';
import type {
  EmbeddedAsset,
  Material,
  NormalizedDocumentUnit,
  SourceBlock,
} from '@hy3-clinic/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { makeWorkspace, T0 } from '../testing/fixtures.js';
import { createRepositories, type Repositories } from './index.js';

let db: SqliteDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.workspaces.insert(makeWorkspace());
});

afterEach(() => db.close());

function hash(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function material(id: string, content = 'Slide source content'): Material {
  return {
    id,
    workspaceId: 'ws_1',
    title: `Deck ${id}`,
    sourceType: 'pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    originalFilename: `${id}.pptx`,
    content,
    charCount: content.length,
    parseStatus: 'parsed',
    pageCount: null,
    extractionWarnings: [],
    parserVersion: 'pptx-ooxml-v1',
    createdAt: T0,
    updatedAt: T0,
  };
}

function unit(revisionId: string, content: string, slideNumber = 3): NormalizedDocumentUnit {
  return {
    id: 'source_slide',
    materialRevisionId: revisionId,
    parentUnitId: null,
    kind: 'slide',
    index: 0,
    title: `Slide ${slideNumber}`,
    content,
    startOffset: 0,
    endOffset: content.length,
    headingPath: [],
    location: { slideNumber },
    contentOrigin: 'extracted_original',
    derivation: 'source_text',
  };
}

function block(materialId: string, content: string, slideNumber = 3): SourceBlock {
  return {
    id: `block_${materialId}_${slideNumber}`,
    materialId,
    index: 0,
    heading: null,
    headingPath: [],
    pageNumber: null,
    pageEnd: null,
    slideNumber,
    content,
    startOffset: 0,
    endOffset: content.length,
    structuralUnitId: 'source_slide',
    chunkerVersion: 'structure-aware-v1',
    contentOrigin: 'extracted_original',
  };
}

function asset(
  materialId: string,
  revisionId: string,
  bytes: Buffer,
  slideNumber = 3,
  byteHash = hash(bytes),
): EmbeddedAsset & { bytes: Buffer } {
  return {
    id: `source_asset_${materialId}_${slideNumber}`,
    materialId,
    materialRevisionId: revisionId,
    index: 0,
    parentStructuralUnitId: 'source_slide',
    sourcePath: 'ppt/media/image1.png',
    mediaType: 'image/png',
    byteHash,
    byteLength: bytes.length,
    width: 320,
    height: 200,
    location: { slideNumber, domPath: 'ppt/media/image1.png' },
    relationshipKind: 'image',
    contentOrigin: 'extracted_original',
    parserVersion: 'pptx-ooxml-v1',
    bytes,
  };
}

function insertRichMaterial(id: string, bytes: Buffer, slideNumber = 3): string {
  const source = material(id);
  const candidateRevisionId = `${id}:candidate`;
  repos.materials.insertWithBlocks(
    source,
    [block(id, source.content, slideNumber)],
    Buffer.from('original deck'),
    [unit(candidateRevisionId, source.content, slideNumber)],
    {
      parserFingerprint: `parser_${id}`,
      chunkerVersion: 'structure-aware-v1',
      chunkerFingerprint: 'chunker_test',
      sourceFingerprint: hash(Buffer.from(`source:${id}`)),
    },
    [asset(id, candidateRevisionId, bytes, slideNumber)],
  );
  return repos.materials.get(id)!.activeRevisionId!;
}

describe('rich asset repository persistence', () => {
  it('persists an asset-only initial revision with zero characters and no SourceBlocks', () => {
    const source = material('mat_asset_only', '');
    const candidateRevisionId = 'mat_asset_only:candidate';
    const bytes = Buffer.from('original visual bytes');
    repos.materials.insertWithBlocks(
      source,
      [],
      Buffer.from('original deck'),
      [],
      { sourceFingerprint: hash(Buffer.from('original deck')) },
      [{ ...asset(source.id, candidateRevisionId, bytes), parentStructuralUnitId: null }],
    );
    expect(repos.materials.get(source.id)).toMatchObject({ content: '', charCount: 0 });
    expect(repos.materials.getBlocks(source.id)).toEqual([]);
    expect(repos.materials.getAssets(source.id)).toHaveLength(1);
  });

  it('deduplicates exact blobs while retaining revision-local metadata and no child Material', () => {
    const bytes = Buffer.from('same embedded PNG bytes');
    const firstRevision = insertRichMaterial('mat_deck_a', bytes, 2);
    const secondRevision = insertRichMaterial('mat_deck_b', bytes, 5);

    expect(db.prepare('SELECT COUNT(*) AS count FROM source_asset_blobs').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM material_revision_assets').get()).toEqual({
      count: 2,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM materials').get()).toEqual({ count: 2 });

    const first = repos.materialRevisions.getAssets(firstRevision)[0]!;
    const second = repos.materialRevisions.getAssets(secondRevision)[0]!;
    expect(first).toMatchObject({
      materialId: 'mat_deck_a',
      materialRevisionId: firstRevision,
      location: { slideNumber: 2 },
      byteHash: hash(bytes),
      contentOrigin: 'extracted_original',
    });
    expect(second).toMatchObject({
      materialId: 'mat_deck_b',
      materialRevisionId: secondRevision,
      location: { slideNumber: 5 },
      byteHash: first.byteHash,
    });
    expect(first.id).not.toBe(second.id);
    expect(repos.materialRevisions.getAssetBytes(first.id)).toEqual(bytes);
    expect(repos.materialRevisions.getAssetBytes(second.id)).toEqual(bytes);
  });

  it('keeps old assets and blobs immutable when a staged revision becomes active', () => {
    const oldBytes = Buffer.from('old embedded asset');
    const oldRevision = insertRichMaterial('mat_history', oldBytes, 1);
    const oldAssets = repos.materialRevisions.getAssets(oldRevision);
    const nextRevision = 'rev_history_2';
    const nextContent = 'Replacement slide content';
    const nextBytes = Buffer.from('new embedded asset');
    const nextMaterial = material('mat_history', nextContent);

    repos.materialRevisions.stage({
      revisionId: nextRevision,
      material: nextMaterial,
      blocks: [block('mat_history', nextContent, 4)],
      originalData: Buffer.from('replacement deck'),
      parserFingerprint: 'parser_history_2',
      contentFingerprint: 'content_history_2',
      chunkerVersion: 'structure-aware-v1',
      chunkerFingerprint: 'chunker_history_2',
      sourceFingerprint: hash(Buffer.from('replacement source')),
      normalizedUnits: [unit(nextRevision, nextContent, 4)],
      embeddedAssets: [asset('mat_history', nextRevision, nextBytes, 4)],
      parserAttemptId: 'attempt_history_2',
      createdAt: '2026-08-19T00:01:00.000Z',
    });

    expect(repos.materials.get('mat_history')!.activeRevisionId).toBe(oldRevision);
    expect(repos.materials.getAssets('mat_history')).toEqual(oldAssets);
    expect(repos.materialRevisions.getAssets(nextRevision)[0]).toMatchObject({
      materialRevisionId: nextRevision,
      location: { slideNumber: 4 },
    });

    repos.materialRevisions.activate('mat_history', nextRevision, '2026-08-19T00:02:00.000Z');

    expect(repos.materials.getAssets('mat_history')).toEqual(
      repos.materialRevisions.getAssets(nextRevision),
    );
    expect(repos.materialRevisions.getAssets(oldRevision)).toEqual(oldAssets);
    expect(repos.materialRevisions.getAssetBytes(oldAssets[0]!.id)).toEqual(oldBytes);
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_asset_blobs').get()).toEqual({
      count: 2,
    });
    expect(repos.materialRevisions.list('mat_history').map((revision) => revision.status)).toEqual([
      'active',
      'retired',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM materials').get()).toEqual({ count: 1 });
  });

  it('rejects first-seen bytes whose claimed SHA-256 identity is false on initial insert', () => {
    const bytes = Buffer.from('untrusted bytes');
    const source = material('mat_bad_hash');
    const candidateRevisionId = 'mat_bad_hash:candidate';

    expect(() =>
      repos.materials.insertWithBlocks(
        source,
        [block(source.id, source.content)],
        null,
        [unit(candidateRevisionId, source.content)],
        {},
        [asset(source.id, candidateRevisionId, bytes, 3, `sha256:${'0'.repeat(64)}`)],
      ),
    ).toThrow(/hash/i);
    expect(repos.materials.get(source.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_asset_blobs').get()).toEqual({
      count: 0,
    });
  });

  it('rejects false SHA-256 identity and foreign revision ownership atomically when staging', () => {
    insertRichMaterial('mat_stage_guard', Buffer.from('original'));
    const source = material('mat_stage_guard', 'new content');
    const revisionId = 'rev_stage_guard_2';
    const common = {
      revisionId,
      material: source,
      blocks: [{ ...block(source.id, source.content), id: 'block_stage_guard_2' }],
      originalData: null,
      parserFingerprint: 'parser_stage_guard',
      contentFingerprint: 'content_stage_guard',
      normalizedUnits: [unit(revisionId, source.content)],
      parserAttemptId: 'attempt_stage_guard',
      createdAt: '2026-08-19T00:01:00.000Z',
    };

    expect(() =>
      repos.materialRevisions.stage({
        ...common,
        embeddedAssets: [
          asset(source.id, revisionId, Buffer.from('forged'), 3, `sha256:${'f'.repeat(64)}`),
        ],
      }),
    ).toThrow(/hash/i);
    expect(repos.materialRevisions.get(revisionId)).toBeUndefined();

    expect(() =>
      repos.materialRevisions.stage({
        ...common,
        parserAttemptId: 'attempt_stage_guard_foreign',
        embeddedAssets: [asset(source.id, 'rev_foreign', Buffer.from('valid'))],
      }),
    ).toThrow(/ownership mismatch/i);
    expect(repos.materialRevisions.get(revisionId)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM material_revision_assets').get()).toEqual({
      count: 1,
    });
  });

  it('rejects stale reprocessing before staging a successor revision', () => {
    const activeRevisionId = insertRichMaterial('mat_stale', Buffer.from('original'));
    const source = material('mat_stale', 'new content');
    expect(() =>
      repos.materialRevisions.stage({
        revisionId: 'rev_stale_2',
        material: source,
        blocks: [{ ...block(source.id, source.content), id: 'block_stale_2' }],
        originalData: null,
        parserFingerprint: 'parser_stale',
        contentFingerprint: 'content_stale',
        normalizedUnits: [unit('rev_stale_2', source.content)],
        parserAttemptId: 'attempt_stale',
        createdAt: '2026-08-19T00:01:00.000Z',
        expectedActiveRevisionId: 'rev_other',
      }),
    ).toThrow('STALE_REPROCESS_ACTIVATION');
    expect(repos.materialRevisions.get('rev_stale_2')).toBeUndefined();
    expect(repos.materials.get(source.id)!.activeRevisionId).toBe(activeRevisionId);
  });

  it('rejects a staged successor when another revision activates first', () => {
    const activeRevisionId = insertRichMaterial('mat_activation_race', Buffer.from('original'));
    const source = material('mat_activation_race', 'replacement content');
    const stage = (revisionId: string, suffix: string) =>
      repos.materialRevisions.stage({
        revisionId,
        material: source,
        blocks: [
          {
            ...block(source.id, source.content),
            id: `block_activation_race_${suffix}`,
          },
        ],
        originalData: null,
        parserFingerprint: `parser_activation_race_${suffix}`,
        contentFingerprint: `content_activation_race_${suffix}`,
        normalizedUnits: [unit(revisionId, source.content)],
        parserAttemptId: `attempt_activation_race_${suffix}`,
        createdAt: `2026-08-19T00:0${suffix}:00.000Z`,
        expectedActiveRevisionId: activeRevisionId,
      });

    stage('rev_activation_race_a', '1');
    stage('rev_activation_race_b', '2');
    repos.materialRevisions.activate(
      source.id,
      'rev_activation_race_b',
      '2026-08-19T00:03:00.000Z',
      activeRevisionId,
    );

    expect(() =>
      repos.materialRevisions.activate(
        source.id,
        'rev_activation_race_a',
        '2026-08-19T00:04:00.000Z',
        activeRevisionId,
      ),
    ).toThrow('STALE_REPROCESS_ACTIVATION');
    expect(repos.materials.get(source.id)!.activeRevisionId).toBe('rev_activation_race_b');
    expect(repos.materialRevisions.get('rev_activation_race_a')!.status).toBe('ready');
  });

  it('removes an unreferenced blob on destructive purge but keeps shared bytes', () => {
    const sharedBytes = Buffer.from('shared bytes');
    insertRichMaterial('mat_purge_a', sharedBytes);
    insertRichMaterial('mat_purge_b', sharedBytes);

    expect(repos.materials.purge('mat_purge_a')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_asset_blobs').get()).toEqual({
      count: 1,
    });

    expect(repos.materials.purge('mat_purge_b')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_asset_blobs').get()).toEqual({
      count: 0,
    });
  });
});
