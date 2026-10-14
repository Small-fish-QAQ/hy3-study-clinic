import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/database.js';
import { initializeClinic } from './db/schema.js';
import { acquireDatabaseLock } from './db/processLock.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { JsonProviderConfigStore, ProviderRuntime } from './services/providerRuntime.js';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const config = loadConfig(process.env, { allowIncompleteProvider: true });
const release = acquireDatabaseLock(config.databasePath);
try {
  const db = openDatabase(config.databasePath);
  initializeClinic(db);
  const runtime = new ProviderRuntime({
    startup: config,
    store: new JsonProviderConfigStore(config.providerConfigPath),
  });
  const app = buildApp({
    db,
    provider: runtime.provider,
    providerRuntime: runtime,
    logger: true,
    concurrency: config.providerConcurrency,
    leaseMs: config.operationLeaseMs,
    heartbeatMs: config.operationHeartbeatMs,
  });
  app.addHook('onClose', async () => {
    db.close();
    release();
  });
  const address = await app.listen({ port: config.port, host: config.host });
  app.log.info(`Study Clinic v2: ${address} (provider=${runtime.providerName})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
} catch (error) {
  release();
  throw error;
}
