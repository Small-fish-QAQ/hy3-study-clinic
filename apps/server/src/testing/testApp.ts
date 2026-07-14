import type { FastifyInstance } from 'fastify';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { buildApp } from '../app.js';
import { fixedClock } from '../util/ids.js';
import { T0 } from './fixtures.js';

export interface TestApp {
  app: FastifyInstance;
  db: SqliteDb;
  repos: Repositories;
}

/** Build a fully-wired app on an in-memory database with a fixed clock. */
export function buildTestApp(): TestApp {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db);
  const app = buildApp({ repos, clock: fixedClock(T0), providerName: 'fake' });
  app.addHook('onClose', async () => {
    db.close();
  });
  return { app, db, repos };
}
