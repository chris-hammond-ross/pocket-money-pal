import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { openDb } from './db/client';

const migrationsDir = resolve(import.meta.dirname, '../drizzle');

describe('server app', () => {
  let app: FastifyInstance;
  let close: () => void;

  beforeEach(async () => {
    const opened = openDb(':memory:', migrationsDir);
    close = opened.close;
    app = await buildApp({ db: opened.db, webDist: null });
  });

  afterEach(async () => {
    await app.close();
    close();
  });

  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('seeds default family settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      familyName: 'Our Family',
      currency: 'GBP',
      centsPerPoint: 5,
      timezone: 'Europe/London',
      volume: 80,
      pause: null,
      quietHours: { from: '20:00', until: '07:00' },
      payday: { day: 0, time: '18:00', auto: true },
    });
  });

  it('validates ping requests', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/ping', payload: {} });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'POST', url: '/api/ping', payload: { from: 'test' } });
    expect(good.json()).toEqual({ ok: true, clients: 0 });
  });
});

describe('serving the web app', () => {
  let dir: string;
  let app: FastifyInstance;
  let close: () => void;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pmp-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'index-NEW.js'), 'console.log(1)');
    const opened = openDb(':memory:', resolve(import.meta.dirname, '../drizzle'));
    close = opened.close;
    app = await buildApp({ db: opened.db, webDist: dir });
  });
  afterEach(async () => {
    await app.close();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers client routes with the page', async () => {
    for (const url of ['/kiosk', '/parent', '/parent?tab=payday', '/parent/pair']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
  });

  it('answers a missing file with 404, never the page (a service worker would cache it)', async () => {
    expect((await app.inject({ method: 'GET', url: '/assets/index-NEW.js' })).statusCode).toBe(200);
    for (const url of ['/assets/index-OLD.js', '/assets/index-OLD.css?v=1', '/sounds/gone.ogg']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).not.toContain('text/html');
    }
  });
});
