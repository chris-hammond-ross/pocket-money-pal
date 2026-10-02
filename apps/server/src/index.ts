import { dirname, join } from 'node:path';
import { paydayReadyPushText, PAYDAY_PUSH_URL } from '@pmp/shared';
import { buildApp } from './app';
import { ServerClock } from './clock';
import { loadConfig } from './config';
import { openDb } from './db/client';
import { watchExternalWrites } from './db/watch';
import { lanAddresses } from './net';
import { startScheduler } from './scheduler';

const config = loadConfig();
const { db, close } = openDb(config.dbPath, config.migrationsDir);
const clock = new ServerClock();
const devClock = config.devClock ? clock : null;
// The app tells the scheduler when the payday settings change; it starts after the app.
let rescheduleNow = (): void => undefined;
const app = await buildApp({
  db,
  now: clock.now,
  devClock,
  webDist: config.webDist,
  publicUrl: config.publicUrl,
  secureUrl: config.secureUrl,
  vapidSubject: config.vapidSubject,
  imagesDir: join(dirname(config.dbPath), 'images'),
  onScheduleChanged: () => rescheduleNow(),
  logger: { level: process.env.PMP_LOG_LEVEL ?? 'info' },
});

await app.listen({ port: config.port, host: config.host });

const scheduler = startScheduler({
  db,
  now: clock.now,
  onNewDay: (result) => {
    app.log.info(result, 'Scheduler: new day');
    app.hub.broadcast({ type: 'day.changed', date: result.date });
  },
  onPayday: (result) => {
    app.log.info(result, 'Scheduler: payday');
    app.hub.broadcast({ type: 'payday.done', paydayId: result.paydayId });
  },
  onPaydayWaiting: (slot) => {
    app.log.info({ slot }, 'Scheduler: payday is waiting for a grown-up');
    app.hub.broadcast({ type: 'payday.waiting', slot });
    app.notifier.notifyAll({ ...paydayReadyPushText(), url: PAYDAY_PUSH_URL });
  },
  onError: (err) => app.log.error({ err }, 'Scheduler run failed; retrying in a minute'),
});

// New payday settings, or a moved dev clock (which may move the date), take effect at once.
rescheduleNow = () => void scheduler.runNow();
clock.onChange(rescheduleNow);

// A write from outside the server (e.g. editing a chore in a SQLite tool) refreshes screens.
const stopWatching = watchExternalWrites(db, () => {
  app.log.info('Database changed outside the server');
  app.hub.broadcast({ type: 'data.changed' });
});

const lanUrls = lanAddresses().map((address) => `http://${address}:${config.port}`);
app.log.info(
  {
    db: config.dbPath,
    web: config.webDist ?? '(not built: use the Vite dev server)',
    devClock: config.devClock,
    lan: lanUrls,
  },
  'Pocket Money Pal server ready',
);

const shutdown = async () => {
  stopWatching();
  scheduler.stop();
  await app.close();
  close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
