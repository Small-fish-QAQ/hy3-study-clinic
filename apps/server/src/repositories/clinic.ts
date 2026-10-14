import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../errors.js';
import type { SqliteDb } from '../db/database.js';
import { canonical, sha256 } from '../util/canonical.js';
import type { CourseCommand } from '@hy3-clinic/shared';

export const newClinicId = (kind: string): string => `${kind}_${randomUUID()}`;
export class ClinicRepository {
  constructor(
    readonly db: SqliteDb,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}
  row<T extends object>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  rows<T extends object>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...args);
  }
  payload<T>(sql: string, ...args: unknown[]): T | undefined {
    const row = this.row<{ payload: string }>(sql, ...args);
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  payloads<T>(sql: string, ...args: unknown[]): T[] {
    return this.rows<{ payload: string }>(sql, ...args).map((row) => JSON.parse(row.payload) as T);
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }
  workspace(id: string): { id: string; title: string; created_at: string } {
    const row = this.row<{ id: string; title: string; created_at: string }>(
      'SELECT * FROM workspaces WHERE id=?',
      id,
    );
    if (!row) throw notFound('课程不存在。');
    return row;
  }
  owned<T>(table: string, id: string, workspaceId?: string): T {
    // table is always a code-owned literal, never supplied by HTTP input.
    const row = this.row<{ workspace_id: string; payload: string }>(
      `SELECT workspace_id,payload FROM ${table} WHERE id=?`,
      id,
    );
    if (!row || (workspaceId && row.workspace_id !== workspaceId))
      throw notFound('资源不存在或不属于该课程。');
    return JSON.parse(row.payload) as T;
  }
  command<T>(workspaceId: string, command: CourseCommand, input: unknown, action: () => T): T {
    this.workspace(workspaceId);
    const hash = sha256(input);
    return this.transaction(() => {
      const previous = this.row<{ request_hash: string; payload: string }>(
        'SELECT request_hash,payload FROM course_commands WHERE workspace_id=? AND idempotency_key=?',
        workspaceId,
        command.idempotencyKey,
      );
      if (previous) {
        if (previous.request_hash !== hash)
          throw new AppError('VERSION_CONFLICT', '同一命令标识对应了不同内容。请重新发起操作。');
        return JSON.parse(previous.payload) as T;
      }
      const result = action();
      this.run(
        'INSERT INTO course_commands VALUES(?,?,?,?,?,?)',
        workspaceId,
        command.idempotencyKey,
        command.commandId,
        hash,
        canonical(result),
        this.now(),
      );
      return result;
    });
  }
}
