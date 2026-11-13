import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, expect, inject } from 'vitest';
import { buildApp } from '../src/app';
import { DEFAULT_RATE_LIMITS, type Config, type RateLimits } from '../src/config';
import { createPool, type Db } from '../src/db/pool';
import { databaseUrl } from './global-setup';

const GENEROUS: RateLimits = {
  globalPerMinute: 100_000,
  playersPerHour: 100_000,
  runsPerMinutePerPlayer: 100_000,
  runsPerMinutePerIp: 100_000,
};

/**
 * A fresh app on its own database, cloned from the migrated template. Torn down after the file.
 * Rate limits are effectively off unless a test passes its own.
 */
export async function testApp(rateLimits: Partial<RateLimits> = {}): Promise<{ app: FastifyInstance; db: Db }> {
  const { adminUrl, template } = inject('testDb');
  const name = `${template.replace(/_template$/, '')}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Concurrent clones of one template can briefly collide; retry.
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (err) {
      if (attempt >= 20 || !String(err).includes('being accessed by other users')) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }

  const db = createPool(databaseUrl(adminUrl, name));
  const config: Config = {
    production: false,
    host: '127.0.0.1',
    port: 0,
    databaseUrl: databaseUrl(adminUrl, name),
    publicOrigin: undefined,
    trustProxy: false,
    staticDir: undefined,
    logLevel: 'silent',
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...GENEROUS, ...rateLimits },
  };
  const app = await buildApp(config, db);

  afterAll(async () => {
    await app.close();
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { app, db };
}

/** Creates a player (as a browser's first visit does) and returns the Cookie header for it. */
export async function newPlayer(app: FastifyInstance): Promise<{ cookie: string; id: number; displayName: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/player' });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === 'vr_player')!.value;
  return { cookie: `vr_player=${token}`, ...res.json<{ id: number; displayName: string }>() };
}

/** Submits a run as the given player, or as a brand-new one. */
export async function submit(app: FastifyInstance, slug: string, body: Record<string, unknown>, cookie?: string) {
  cookie ??= (await newPlayer(app)).cookie;
  return app.inject({ method: 'POST', url: `/api/tracks/${slug}/runs`, headers: { cookie }, payload: body });
}

// Known best runs under the current rules (see packages/tracks/golden/cases.json).
export const BEST = {
  dogleg: [5, 4, 8, 8, 8, 1, 2, 2],
  oval: [2, 5, 8, 4, 5, 4, 6, 6, 6, 3, 3, 1, 0, 0, 0, 3, 7, 8, 2, 2, 2, 2, 5, 5, 8],
};
