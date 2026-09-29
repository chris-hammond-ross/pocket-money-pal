import { resolve } from 'node:path';
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
    });
  });

  it('validates ping requests', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/ping', payload: {} });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'POST', url: '/api/ping', payload: { from: 'test' } });
    expect(good.json()).toEqual({ ok: true, clients: 0 });
  });
});
