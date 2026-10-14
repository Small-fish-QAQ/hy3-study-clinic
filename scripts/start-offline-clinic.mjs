import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../apps/server/dist/app.js';
import { openDatabase } from '../apps/server/dist/db/database.js';
import { CourseFakeProvider } from '../apps/server/dist/llm/courseFakeProvider.js';
import { ProviderRuntime } from '../apps/server/dist/services/providerRuntime.js';
import { loadConfig } from '../apps/server/dist/config.js';
globalThis.fetch = () =>
  Promise.reject(new Error('Offline verification prohibits external requests.'));
const dir = path.resolve('output/architecture-implementation/browser');
mkdirSync(dir, { recursive: true });
const config = loadConfig({
  LLM_PROVIDER: 'fake',
  VISUAL_PROVIDER: 'disabled',
  DATABASE_PATH: path.join(dir, 'clinic.sqlite'),
  AUTOMATION_EXPECT_PROVIDER: 'fake',
  PORT: '8787',
});
const db = openDatabase(config.databasePath);
const provider = new CourseFakeProvider();
const runtime = new ProviderRuntime({ startup: config, initialProvider: provider });
const app = buildApp({ db, provider, providerRuntime: runtime });
app.addHook('onClose', async () => db.close());
console.log(await app.listen({ host: '127.0.0.1', port: config.port }));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
