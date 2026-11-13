import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { WebSocket } from 'ws';
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
  liveStartsPerMinute: 100_000,
  liveMessagesPerSecond: 100_000,
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
    logLevel: process.env.TEST_LOG ?? 'silent',
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

type Message = { type: string; [key: string]: unknown };

/** A test WebSocket client: send JSON, await the next message, see when it closes. */
export class LiveClient {
  private readonly queue: Message[] = [];
  private readonly waiters: ((m: Message) => void)[] = [];
  closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as Message;
      const waiter = this.waiters.shift();
      if (waiter) waiter(m);
      else this.queue.push(m);
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })),
    );
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  next(): Promise<Message> {
    const m = this.queue.shift();
    return m ? Promise.resolve(m) : new Promise((resolve) => this.waiters.push(resolve));
  }

  async request(message: object): Promise<Message> {
    this.send(message);
    return this.next();
  }

  close(): void {
    this.ws.terminate();
  }
}

export async function connect(app: FastifyInstance, cookie?: string, headers: Record<string, string> = {}) {
  // Listen from the moment the socket exists: the server may close it before it even opens.
  let client!: LiveClient;
  await app.injectWS(
    '/ws',
    { headers: { ...headers, ...(cookie ? { cookie } : {}) } },
    {
      onInit: (ws) => (client = new LiveClient(ws)),
    },
  );
  return client;
}

/** Races a whole run over a live session and returns the server's last reply. */
export async function liveRun(app: FastifyInstance, slug: string, moves: number[], cookie?: string) {
  cookie ??= (await newPlayer(app)).cookie;
  const live = await connect(app, cookie);
  let reply = await live.request({ type: 'start_run', trackSlug: slug, trackVersion: 1 });
  for (const move of moves) {
    if (reply.type === 'error') break;
    reply = await live.request({ type: 'move', move, nonce: reply.nonce });
  }
  live.close();
  return reply;
}
