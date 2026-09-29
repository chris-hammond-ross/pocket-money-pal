import { networkInterfaces } from 'node:os';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db/client';

const config = loadConfig();
const { db, close } = openDb(config.dbPath, config.migrationsDir);
const app = await buildApp({
  db,
  webDist: config.webDist,
  logger: { level: process.env.PMP_LOG_LEVEL ?? 'info' },
});

await app.listen({ port: config.port, host: config.host });

const lanUrls = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${config.port}`);
app.log.info(
  {
    db: config.dbPath,
    web: config.webDist ?? '(not built: use the Vite dev server)',
    lan: lanUrls,
  },
  'Pocket Money Pal server ready',
);

const shutdown = async () => {
  await app.close();
  close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
