import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createRepositories } from './repositories/index.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { JsonProviderConfigStore, ProviderRuntime } from './services/providerRuntime.js';

// Always load the repository-root .env file.
// Existing process environment variables keep higher priority.
loadDotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
});

const config = loadConfig(process.env, { allowIncompleteProvider: true });
const db = openDatabase(config.databasePath);

migrate(db);

const repos = createRepositories(db);
const providerRuntime = new ProviderRuntime({
  startup: config,
  store: new JsonProviderConfigStore(config.providerConfigPath),
});

const app = buildApp({
  repos,
  provider: providerRuntime.provider,
  providerRuntime,
  startupConfig: config,
  logger: true,
  providerModel: config.hy3Model,
});

app.addHook('onClose', async () => {
  db.close();
});

app
  .listen({
    port: config.port,
    host: config.host,
  })
  .then((address) => {
    app.log.info(
      `Hy3 Study Clinic server listening at ${address} (provider=${providerRuntime.safeConfig().provider})`,
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
