import type { FastifyInstance } from 'fastify';
import { openDatabase, type SqliteDb } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../repositories/index.js';
import { buildApp } from '../app.js';
import { FakeProvider } from '../llm/fakeProvider.js';
import type { LlmProvider, VisualDescriptionProvider } from '../llm/provider.js';
import { fixedClock, type Clock } from '../util/ids.js';
import { makeWorkspace, T0 } from './fixtures.js';
import type { ProviderConfigStore, ProviderRuntime } from '../services/providerRuntime.js';

export interface TestApp {
  app: FastifyInstance;
  db: SqliteDb;
  repos: Repositories;
  provider: LlmProvider;
}

/** Build a fully-wired app with a fixed clock; memory by default, optionally file-backed. */
export function buildTestApp(
  options: {
    provider?: LlmProvider;
    visualProvider?: VisualDescriptionProvider;
    clock?: Clock;
    providerConfigStore?: ProviderConfigStore | null;
    providerRuntime?: ProviderRuntime;
    databasePath?: string;
  } = {},
): TestApp {
  const db = openDatabase(options.databasePath ?? ':memory:');
  migrate(db);
  const repos = createRepositories(db);
  // Documents always belong to a workspace; seed the default fixture one so
  // tests may insert `makeMaterial()` rows directly through the repos.
  if (!repos.workspaces.get('ws_1')) repos.workspaces.insert(makeWorkspace());
  const provider = options.provider ?? new FakeProvider();
  const app = buildApp({
    repos,
    provider,
    visualProvider: options.visualProvider,
    providerRuntime: options.providerRuntime,
    providerConfigStore: options.providerConfigStore,
    clock: options.clock ?? fixedClock(T0),
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  return { app, db, repos, provider };
}
