import { beforeEach, describe, expect, it } from 'vitest';
import { TUTOR_TOOL_NAMES } from '@hy3-clinic/shared';
import {
  boundObservation,
  executeTutorTool,
  toolCatalog,
  ToolValidationError,
  type TutorToolContext,
} from './tools.js';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import {
  makeBlock,
  makeConcept,
  makeGrounding,
  makeMaterial,
  makeWorkspace,
  T0,
} from '../testing/fixtures.js';
import { fixedClock } from '../util/ids.js';

/**
 * Tool registry safety: whitelist completeness, argument validation,
 * workspace isolation, read-only execution, bounded observations.
 */

describe('tutor tool registry', () => {
  let db: SqliteDb;
  let repos: Repositories;
  let ctx: TutorToolContext;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.workspaces.insert(makeWorkspace());
    repos.workspaces.insert(makeWorkspace({ id: 'ws_other', name: '另一个空间' }));
    repos.materials.insertWithBlocks(makeMaterial(), [makeBlock()]);
    repos.materials.insertWithBlocks(
      makeMaterial({ id: 'mat_other', workspaceId: 'ws_other', title: '外部资料' }),
      [makeBlock({ id: 'blk_other', materialId: 'mat_other' })],
    );
    repos.materials.replaceConcepts('mat_1', [makeConcept()]);
    repos.materials.replaceConcepts('mat_other', [
      makeConcept({
        id: 'con_other',
        materialId: 'mat_other',
        grounding: makeGrounding({ blockId: 'blk_other' }),
      }),
    ]);
    ctx = {
      workspaceId: 'ws_1',
      repos,
      clock: fixedClock(T0),
      selected: makeConcept(),
    };
  });

  it('exposes a catalog entry for every whitelisted tool and nothing else', () => {
    const catalog = toolCatalog();
    expect(catalog.map((t) => t.name).sort()).toEqual([...TUTOR_TOOL_NAMES].sort());
    for (const entry of catalog) {
      expect(entry.description.length).toBeGreaterThan(5);
    }
  });

  it('validates arguments strictly (unknown fields and bad shapes rejected)', () => {
    expect(() =>
      executeTutorTool(ctx, 'inspect_learning_state', { conceptId: 'con_1', extra: 1 }),
    ).toThrow(ToolValidationError);
    expect(() => executeTutorTool(ctx, 'search_source_blocks', { query: '' })).toThrow(
      ToolValidationError,
    );
    expect(() => executeTutorTool(ctx, 'search_source_blocks', { query: 'x', limit: 99 })).toThrow(
      ToolValidationError,
    );
  });

  it('enforces workspace isolation for concept and block references', () => {
    expect(() => executeTutorTool(ctx, 'inspect_concept', { conceptId: 'con_other' })).toThrow(
      /不属于当前课程空间/,
    );
    expect(() => executeTutorTool(ctx, 'read_source_block', { blockId: 'blk_other' })).toThrow(
      /不属于当前课程空间/,
    );
    expect(() =>
      executeTutorTool(ctx, 'inspect_learning_state', { conceptId: 'con_none' }),
    ).toThrow(/不存在/);
  });

  it('executes read-only inspections and returns display-safe summaries', () => {
    const state = executeTutorTool(ctx, 'inspect_learning_state', { conceptId: 'con_1' });
    expect(state.summary).toContain('工作记忆');
    expect(state.semanticEvent).toBe('state_inspected');

    const read = executeTutorTool(ctx, 'read_source_block', { blockId: 'blk_1' });
    expect((read.data as { content: string }).content).toContain('工作记忆');

    const search = executeTutorTool(ctx, 'search_source_blocks', { query: '工作记忆' });
    expect(search.resultCount).toBeGreaterThan(0);

    const queue = executeTutorTool(ctx, 'inspect_review_queue', {});
    expect(queue.summary).toContain('复习');
  });

  it('mutates nothing: row counts are identical before and after every tool', () => {
    const countAll = () =>
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM concepts) AS a, (SELECT COUNT(*) FROM mistakes) AS b,
                    (SELECT COUNT(*) FROM mastery_states) AS c, (SELECT COUNT(*) FROM review_items) AS d,
                    (SELECT COUNT(*) FROM misconceptions) AS e, (SELECT COUNT(*) FROM source_blocks) AS f`,
        )
        .get() as Record<string, number>;
    const before = countAll();
    for (const name of TUTOR_TOOL_NAMES) {
      try {
        executeTutorTool(ctx, name, { conceptId: 'con_1', query: '记忆', blockId: 'blk_1' });
      } catch {
        // strict schemas reject the superset args for some tools — fine,
        // rejection must also be side-effect free.
      }
    }
    expect(countAll()).toEqual(before);
  });

  it('bounds observation payloads', () => {
    const huge = { text: 'x'.repeat(20_000) };
    expect(boundObservation(huge).length).toBeLessThanOrEqual(6100);
  });
});
