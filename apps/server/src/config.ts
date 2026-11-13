export interface RateLimits {
  /** Requests per minute per IP across the whole API. */
  globalPerMinute: number;
  /** New players per hour per IP (one is created per browser on first visit). */
  playersPerHour: number;
  /** Run submissions per minute, per player and per IP. */
  runsPerMinutePerPlayer: number;
  runsPerMinutePerIp: number;
  /** Live runs started per minute per racer. */
  liveStartsPerMinute: number;
  /** Messages per second on one live socket before it is closed (a reconnect may flush queued moves). */
  liveMessagesPerSecond: number;
}

export interface Config {
  production: boolean;
  host: string;
  port: number;
  databaseUrl: string;
  /** Expected Origin for state-changing requests, e.g. https://vector-racer.fly.dev. Unset: must match Host. */
  publicOrigin: string | undefined;
  /** Trust X-Forwarded-For from the platform's proxy (Fly, etc.) for per-IP rate limits. */
  trustProxy: boolean;
  /** Built client to serve, if any (apps/web/dist in production). */
  staticDir: string | undefined;
  logLevel: string;
  rateLimits: RateLimits;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  globalPerMinute: 300,
  playersPerHour: 20,
  runsPerMinutePerPlayer: 20,
  runsPerMinutePerIp: 60,
  liveStartsPerMinute: 30,
  liveMessagesPerSecond: 50,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)');
  if (production && !env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required in production');
  return {
    production,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    publicOrigin: env.PUBLIC_ORIGIN,
    trustProxy: env.TRUST_PROXY === 'true',
    staticDir: env.STATIC_DIR,
    logLevel: env.LOG_LEVEL ?? 'info',
    rateLimits: DEFAULT_RATE_LIMITS,
  };
}
