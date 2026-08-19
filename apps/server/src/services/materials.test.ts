import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from '../testing/fixtures.js';
import { AppError } from '../errors.js';
import { createMaterialService, type MaterialService } from './materials.js';
import { createSourceAuthorityService } from './sourceAuthority.js';

let db: SqliteDb;
let repos: Repositories;
let materials: MaterialService;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  repos = createRepositories(db);
  const clock = fixedClock(T0);
  const sourceAuthority = createSourceAuthorityService({
    sourceAuthority: repos.sourceAuthority,
    clock,
  });
  materials = createMaterialService({ repos, clock, sourceAuthority });
});

afterEach(() => {
  db.close();
});

describe('material service history management', () => {
  it('admits exact source text independently of later learner scope decisions', () => {
    const created = materials.create({
      title: 'Verbatim source',
      content: 'Working memory has limited capacity. Retrieval practice strengthens recall.',
    });
    const revisionId = created.material.activeRevisionId!;
    const authority = repos.sourceAuthority.findEligibleByBlock(
      created.material.workspaceId,
      revisionId,
      created.blocks[0]!.id,
    );

    expect(authority).toHaveLength(2);
    expect(authority.map((bundle) => bundle.record.policyBasis.premiseKind).sort()).toEqual([
      'expected_answer',
      'rubric_point',
    ]);
    expect(repos.learningContracts.list(created.material.workspaceId)).toEqual([]);
    expect(
      authority
        .flatMap((bundle) => bundle.claims)
        .every((claim) => created.blocks[0]!.content.includes(claim.claim)),
    ).toBe(true);
  });

  it('persists normalized units and structure-aware chunk identity', () => {
    const created = materials.create({
      filename: 'lesson.md',
      content: '# Retrieval\n\nA paragraph with grounded context.\n\n```ts\n# stays code\n```',
    });
    const revision = repos.materialRevisions.getActive(created.material.id)!;
    const units = repos.materialRevisions.getStructuralUnits(revision.id);
    expect(units.some((unit) => unit.kind === 'heading')).toBe(true);
    expect(units.some((unit) => unit.kind === 'code_block')).toBe(true);
    expect(created.blocks.every((block) => block.chunkerVersion === 'structure-aware-v1')).toBe(
      true,
    );
    expect(revision.parserFingerprint).toMatch(/^parser_[0-9a-f]{8}$/u);
    expect(revision.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      created.blocks.every(
        (block) =>
          block.content === created.material.content.slice(block.startOffset, block.endOffset),
      ),
    ).toBe(true);
  });

  it('imports source code as exact text with line-aware structural units', () => {
    const created = materials.create({
      filename: 'example.ts',
      content: '// comment\nfunction run() {\n  return 1;\n}',
    });
    expect(created.material.sourceType).toBe('source_code');
    expect(created.material.parserVersion).toBe('source-code-structure-v1');
    expect(created.blocks[0]!.content).toContain('function run');
    const units = repos.materialRevisions.getStructuralUnits(created.material.activeRevisionId!);
    expect(units.some((unit) => unit.kind === 'function')).toBe(true);
    expect(units.find((unit) => unit.kind === 'function')?.content).toBe(
      created.material.content.slice(
        units.find((unit) => unit.kind === 'function')!.startOffset,
        units.find((unit) => unit.kind === 'function')!.endOffset,
      ),
    );
  });

  it('normalizes and persists a title update without changing other material fields', () => {
    const created = materials.create({ title: '原标题', content: '一段学习资料。' });

    const updated = materials.updateTitle(created.material.id, '  新标题  ');

    expect(updated).toEqual({ ...created.material, title: '新标题' });
    expect(repos.materials.get(created.material.id)).toEqual(updated);
    expect(repos.materials.getBlocks(created.material.id)).toEqual(created.blocks);
  });

  it('applies title validation even when called outside the HTTP route', () => {
    const created = materials.create({ content: '一段学习资料。' });

    expect(() => materials.updateTitle(created.material.id, '   ')).toThrow();
    expect(() => materials.updateTitle(created.material.id, 'x'.repeat(121))).toThrow();
    expect(repos.materials.get(created.material.id)?.title).toBe(created.material.title);
  });

  it('reports missing materials for update and delete', () => {
    for (const operation of [
      () => materials.updateTitle('mat_missing', '新标题'),
      () => materials.delete('mat_missing'),
    ]) {
      try {
        operation();
        throw new Error('expected the operation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('NOT_FOUND');
      }
    }
  });

  it('retires an existing material without deleting revision history', () => {
    const created = materials.create({ content: '一段学习资料。' });
    const revision = repos.materialRevisions.getActive(created.material.id);

    const result = materials.delete(created.material.id);

    expect(result.workspaceDeleted).toBe(false);
    expect(materials.get(created.material.id)?.material.availability).toBe('retired');
    expect(repos.materialRevisions.get(revision!.id)).toEqual(revision);
    expect(materials.list()).toEqual([]);
  });
});
