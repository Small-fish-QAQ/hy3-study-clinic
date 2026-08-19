import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from './database.js';
import { migrate } from './migrate.js';
import { createRepositories } from '../repositories/index.js';

const AT = '2026-08-19T00:00:00.000Z';
let db: SqliteDb | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function columnNames(table: string): string[] {
  return (db!.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function seedVersion23Document(): void {
  db!
    .prepare(
      `INSERT INTO workspaces
       (id, name, description, active_graph_version_id, created_at, updated_at, origin)
     VALUES ('ws_legacy_rich', 'Legacy rich course', NULL, NULL, ?, ?, 'manual')`,
    )
    .run(AT, AT);
  db!
    .prepare(
      `INSERT INTO materials
       (id, title, source_type, content, char_count, created_at, workspace_id,
        media_type, original_filename, parse_status, page_count, extraction_warnings,
        parser_version, original_data, updated_at, active_revision_id, availability, retired_at)
     VALUES ('mat_legacy_rich', 'Legacy document', 'pdf', 'Legacy content', 14, ?,
       'ws_legacy_rich', 'application/pdf', 'legacy.pdf', 'parsed', 1, '[]',
       'pdf-layout-v2', NULL, ?, NULL, 'active', NULL)`,
    )
    .run(AT, AT);
  db!
    .prepare(
      `INSERT INTO material_revisions
       (id, material_id, revision_number, predecessor_revision_id, status,
        source_type, media_type, original_filename, content, char_count, parse_status,
        page_count, extraction_warnings, parser_version, parser_fingerprint,
        content_fingerprint, original_data, failure_code, failure_message, created_at,
        activated_at, chunker_version, chunker_fingerprint, source_fingerprint)
     VALUES ('rev_legacy_rich', 'mat_legacy_rich', 1, NULL, 'active', 'pdf',
       'application/pdf', 'legacy.pdf', 'Legacy content', 14, 'parsed', 1, '[]',
       'pdf-layout-v2', 'parser_legacy', 'content_legacy', NULL, NULL, NULL, ?, ?,
       'structure-aware-v1', 'chunker_legacy', 'sha256:legacy')`,
    )
    .run(AT, AT);
  db!
    .prepare(
      `INSERT INTO normalized_structural_units
       (id, material_revision_id, parent_id, unit_type, idx, title, start_offset,
        end_offset, page_number, metadata, line_start, line_end, page_end,
        heading_path, content_origin, chunker_version)
     VALUES ('unit_legacy_rich', 'rev_legacy_rich', NULL, 'page', 0, 'Page 1', 0, 14,
       1, '{"derivation":"source_text"}', NULL, NULL, 1, '[]',
       'extracted_original', 'structure-aware-v1')`,
    )
    .run();
  db!
    .prepare(
      `INSERT INTO source_blocks
       (id, material_id, idx, heading, heading_path, content, start_offset, end_offset,
        page_number, page_end, material_revision_id, structural_unit_id,
        chunker_version, content_origin)
     VALUES ('blk_legacy_rich', 'mat_legacy_rich', 0, NULL, '[]', 'Legacy content',
       0, 14, 1, 1, 'rev_legacy_rich', 'unit_legacy_rich',
       'structure-aware-v1', 'extracted_original')`,
    )
    .run();
  db!
    .prepare(
      `UPDATE materials SET active_revision_id = 'rev_legacy_rich'
     WHERE id = 'mat_legacy_rich'`,
    )
    .run();
}

describe('migration 24 rich asset persistence', () => {
  it('adds asset tables and nullable slide provenance without reinterpreting legacy rows', () => {
    db = openDatabase(':memory:');
    migrate(db, { toVersion: 23 });
    seedVersion23Document();

    expect(columnNames('source_blocks')).not.toContain('slide_number');
    expect(columnNames('normalized_structural_units')).not.toContain('slide_number');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'material_revision_assets'").get(),
    ).toBeUndefined();

    migrate(db, { toVersion: 24 });

    expect(columnNames('source_blocks')).toContain('slide_number');
    expect(columnNames('normalized_structural_units')).toContain('slide_number');
    expect(columnNames('source_asset_blobs')).toEqual([
      'byte_hash',
      'media_type',
      'byte_length',
      'original_data',
    ]);
    expect(columnNames('material_revision_assets')).toContain('material_revision_id');
    const repos = createRepositories(db);
    expect(repos.materials.getBlocks('mat_legacy_rich')).toEqual([
      expect.objectContaining({
        id: 'blk_legacy_rich',
        materialRevisionId: 'rev_legacy_rich',
        pageNumber: 1,
        slideNumber: null,
      }),
    ]);
    expect(repos.materialRevisions.getStructuralUnits('rev_legacy_rich')).toEqual([
      expect.objectContaining({ id: 'unit_legacy_rich', kind: 'page', pageEnd: 1 }),
    ]);
    expect(repos.materialRevisions.getStructuralUnits('rev_legacy_rich')[0]).not.toHaveProperty(
      'slideNumber',
    );
    expect(repos.materials.getAssets('mat_legacy_rich')).toEqual([]);
    expect(repos.materialRevisions.getAssets('rev_legacy_rich')).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces blob byte lengths and revision-local asset provenance in SQLite', () => {
    db = openDatabase(':memory:');
    migrate(db);
    expect(() =>
      db!
        .prepare(
          `INSERT INTO source_asset_blobs
           (byte_hash, media_type, byte_length, original_data)
         VALUES (?, 'image/png', 9, ?)`,
        )
        .run(`sha256:${'a'.repeat(64)}`, Buffer.from('tiny')),
    ).toThrow();
  });
});
