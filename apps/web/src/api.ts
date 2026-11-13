// Thin typed wrappers over the server's JSON API. Same origin, so the racer cookie rides along.

export interface Player {
  id: number;
  displayName: string;
}

export interface ApiTrack {
  slug: string;
  version: number;
  name: string;
  maxTurns: number;
  par: number | null;
  map: string;
}

export interface SubmitResponse {
  score: number;
  par: number | null;
  /** This racer's best on the track, and its rank. */
  best: { rank: number; score: number } | null;
  isBest: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  playerName: string;
  score: number;
  createdAt: string;
  isMe: boolean;
}

export interface Leaderboard {
  track: { slug: string; version: number; par: number | null };
  entries: LeaderboardEntry[];
  me: { rank: number; score: number } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : 'error';
    const message = typeof data.message === 'string' ? data.message : res.statusText;
    throw new ApiError(res.status, code, message, data);
  }
  return data as T;
}

export const api = {
  tracks: () => call<ApiTrack[]>('GET', '/tracks'),
  /** This browser's racer, created with a default name on first visit. */
  player: () => call<Player>('POST', '/player'),
  rename: (displayName: string) => call<Player>('PATCH', '/player', { displayName }),
  submitRun: (slug: string, trackVersion: number, moves: number[]) =>
    call<SubmitResponse>('POST', `/tracks/${encodeURIComponent(slug)}/runs`, { trackVersion, moves }),
  leaderboard: (slug: string, limit = 50) =>
    call<Leaderboard>('GET', `/tracks/${encodeURIComponent(slug)}/leaderboard?limit=${limit}`),
};
