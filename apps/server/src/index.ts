import 'dotenv/config';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createRepositories } from './repositories/index.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db);
const repos = createRepositories(db);

const app = buildApp({ repos, logger: true, providerName: config.provider });
app.addHook('onClose', async () => {
  db.close();
});

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    app.log.info(`Hy3 Study Clinic server listening at ${address} (provider=${config.provider})`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
