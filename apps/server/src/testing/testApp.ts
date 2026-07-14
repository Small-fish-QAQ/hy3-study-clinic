import type { FastifyInstance } from 'fastify';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { buildApp } from '../app.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { LlmProvider } from '../llm/provider.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from './fixtures.js';

export interface TestApp {
  app: FastifyInstance;
  db: SqliteDb;
  repos: Repositories;
  provider: LlmProvider;
}

/** Build a fully-wired app on an in-memory database with a fixed clock. */
export function buildTestApp(options: { provider?: LlmProvider } = {}): TestApp {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db);
  const provider = options.provider ?? new FakeProvider();
  const app = buildApp({ repos, provider, clock: fixedClock(T0) });
  app.addHook('onClose', async () => {
    db.close();
  });
  return { app, db, repos, provider };
}
