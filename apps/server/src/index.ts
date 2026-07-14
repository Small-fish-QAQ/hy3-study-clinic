import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp({ logger: true });

app
  .listen({ port, host })
  .then((address) => {
    app.log.info(`Hy3 Study Clinic server listening at ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
