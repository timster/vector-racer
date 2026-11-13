import { replay, RULES_V1, SIM_VERSION } from '@vector-racer/sim';
import { isUniqueViolation, type Queryable } from './db/pool';
import { sha256 } from './players';
import type { StoredTrack } from './tracks';

export type SubmitResult =
  | { ok: true; runId: number; score: number }
  | { ok: false; status: 409 | 422; error: string; reason?: string; currentVersion?: number };

/**
 * Validates a run by replaying it against the server's copy of the track and stores it.
 * The score always comes from replay(); nothing from the request is trusted but the moves.
 */
export async function submitRun(
  db: Queryable,
  playerId: number,
  track: StoredTrack,
  trackVersion: number,
  moves: unknown[],
  source: 'replay' | 'live' = 'replay',
): Promise<SubmitResult> {
  if (trackVersion !== track.version) {
    return { ok: false, status: 409, error: 'stale_track_version', currentVersion: track.version };
  }
  const result = replay(track.track, moves);
  if (!result.valid) return { ok: false, status: 422, error: 'invalid_run', reason: result.reason };

  // replay() accepted every move, so they are all integers 0..8.
  const valid = moves as number[];
  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO runs (player_id, track_id, track_version, sim_version, rules_version, moves, score, move_hash, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        playerId,
        track.id,
        track.version,
        SIM_VERSION,
        RULES_V1.rulesVersion,
        valid,
        result.score,
        sha256(Buffer.from(valid)),
        source,
      ],
    );
    return { ok: true, runId: rows[0]!.id, score: result.score! };
  } catch (err) {
    if (isUniqueViolation(err, 'runs_unique_moves')) return { ok: false, status: 409, error: 'duplicate_run' };
    throw err;
  }
}

export interface LeaderboardEntry {
  rank: number;
  runId: number;
  playerId: number;
  playerName: string;
  score: number;
  createdAt: Date;
}

// Each player's best live run on a track: lowest score, then earliest. Only runs raced over a
// live session are ranked; whole move lists posted at the end (source 'replay') never are.
const BEST_PER_PLAYER = `
  SELECT DISTINCT ON (player_id) id, player_id, score, created_at
  FROM runs
  WHERE track_id = $1 AND source = 'live'
  ORDER BY player_id, score, created_at, id`;

export async function leaderboard(db: Queryable, trackId: number, limit: number): Promise<LeaderboardEntry[]> {
  const { rows } = await db.query<{
    rank: number;
    id: number;
    player_id: number;
    display_name: string;
    score: number;
    created_at: Date;
  }>(
    `SELECT row_number() OVER (ORDER BY b.score, b.created_at, b.id) AS rank,
            b.id, b.player_id, p.display_name, b.score, b.created_at
     FROM (${BEST_PER_PLAYER}) b JOIN players p ON p.id = b.player_id
     ORDER BY b.score, b.created_at, b.id
     LIMIT $2`,
    [trackId, limit],
  );
  return rows.map((r) => ({
    rank: r.rank,
    runId: r.id,
    playerId: r.player_id,
    playerName: r.display_name,
    score: r.score,
    createdAt: r.created_at,
  }));
}

/** A player's best run on a track and its leaderboard rank, if they have one. */
export async function bestForPlayer(
  db: Queryable,
  trackId: number,
  playerId: number,
): Promise<{ rank: number; runId: number; score: number } | undefined> {
  const { rows } = await db.query<{ rank: number; id: number; score: number }>(
    `WITH best AS (${BEST_PER_PLAYER})
     SELECT (SELECT count(*) FROM best o WHERE (o.score, o.created_at, o.id) < (b.score, b.created_at, b.id)) + 1 AS rank,
            b.id, b.score
     FROM best b WHERE b.player_id = $2`,
    [trackId, playerId],
  );
  const r = rows[0];
  return r && { rank: r.rank, runId: r.id, score: r.score };
}
