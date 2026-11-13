import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import type { Config } from './config';
import type { Db } from './db/pool';
import { liveRoutes, MAX_MESSAGE_BYTES } from './live';
import { COOKIE_DAYS, PLAYER_COOKIE, playerByToken, type Player } from './players';
import { playerRoutes } from './routes/player';
import { trackRoutes } from './routes/tracks';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    // Declared as function properties (not methods): they are passed around as route hooks.
    limit: (name: string, max: number, timeWindow: string, by?: 'ip' | 'player') => preHandlerAsyncHookHandler;
    requirePlayer: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    setPlayerCookie: (reply: FastifyReply, token: string) => void;
  }
  interface FastifyRequest {
    player: Player | null;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
    // No type coercion: a move list must arrive exactly as sent. Unknown body fields are stripped.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: 'all' } },
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorateRequest('player', null);

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimits.globalPerMinute,
    timeWindow: '1 minute',
    // The plugin's default key crashes when a request has no remote address (in-process injection).
    keyGenerator: (req) => req.ip ?? 'unknown',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests; try again in ${Math.ceil(ctx.ttl / 1000)}s`,
    }),
  });

  // Route-specific limits (per IP or per player) on top of the global per-IP one. The plugin's own route hooks run only
  // once per request (the global hook wins), so these use createRateLimit directly. All limiters
  // share one store, so each key is prefixed with the limit's name.
  app.decorate('limit', (name: string, max: number, timeWindow: string, by: 'ip' | 'player' = 'ip') => {
    const check = app.createRateLimit({
      max,
      timeWindow,
      keyGenerator: (req) => `${name}:${by === 'player' ? `player:${req.player?.id}` : req.ip}`,
    });
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const result = await check(req);
      if (result.isAllowed || !result.isExceeded) return;
      req.log.warn({ limit: name, key: result.key }, 'rate limited');
      return reply
        .code(429)
        .header('retry-after', result.ttlInSeconds)
        .send({ error: 'rate_limited', message: `Too many requests; try again in ${result.ttlInSeconds}s` });
    };
  });

  app.decorate('setPlayerCookie', (reply: FastifyReply, token: string) => {
    reply.setCookie(PLAYER_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.production,
      sameSite: 'strict',
      maxAge: COOKIE_DAYS * 24 * 60 * 60,
    });
  });

  app.decorate('requirePlayer', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.player) return reply.code(401).send({ error: 'no_player', message: 'No racer on this browser yet' });
  });

  // Who is racing: the anonymous player this browser's cookie points to, if any.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[PLAYER_COOKIE];
    if (token && (req.url.startsWith('/api/') || req.url === '/ws')) {
      req.player = (await playerByToken(db, token)) ?? null;
    }
  });

  // Browsers on other sites can't post runs here. (Scripts can, which is why every run is replayed.)
  app.addHook('onRequest', async (req, reply) => {
    if (!UNSAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const expected = config.publicOrigin ?? `${req.protocol}://${req.headers.host}`;
    if (origin !== expected)
      return reply.code(403).send({ error: 'bad_origin', message: 'Cross-origin request refused' });
  });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown; message: string }, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  await app.register(
    async (api) => {
      await api.register(playerRoutes);
      await api.register(trackRoutes);
      api.setNotFoundHandler((_req, reply) =>
        reply.code(404).send({ error: 'not_found', message: 'No such endpoint' }),
      );
    },
    { prefix: '/api' },
  );

  await app.register(liveRoutes);

  if (config.staticDir) await app.register(fastifyStatic, { root: config.staticDir });

  return app;
}
