import { replay, RULES_V1, type Track } from '@vector-racer/sim';
import { BUILTIN_TRACKS, parseMap, parseTrack, validateTrack, type TrackDef } from '@vector-racer/tracks';
import { shortestRun } from '@vector-racer/tracks/solve';
import { withTransaction, type Db, type Queryable } from './db/pool';

export interface StoredTrack {
  id: number;
  slug: string;
  version: number;
  name: string;
  rulesVersion: string;
  /** The map text, one string per row. */
  rows: string[];
  maxTurns: number;
  par: number | null;
  track: Track;
}

interface TrackRow {
  id: number;
  slug: string;
  version: number;
  name: string;
  rules_version: string;
  grid: { rows: string[] };
  max_turns: number;
  par: number | null;
}

const COLUMNS = 'id, slug, version, name, rules_version, grid, max_turns, par';

// Parsing is cheap but runs on every submission; cache by content so it is safe across databases.
const parsed = new Map<string, Track>();

function fromRow(row: TrackRow): StoredTrack {
  const key = `${row.max_turns}\n${row.grid.rows.join('\n')}`;
  let track = parsed.get(key);
  if (!track) {
    track = parseMap(row.grid.rows.join('\n'), row.max_turns);
    parsed.set(key, track);
  }
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    name: row.name,
    rulesVersion: row.rules_version,
    rows: row.grid.rows,
    maxTurns: row.max_turns,
    par: row.par,
    track,
  };
}

/** Current (latest released) version of every track, in display order. */
export async function listTracks(db: Queryable): Promise<StoredTrack[]> {
  const { rows } = await db.query<TrackRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (slug) ${COLUMNS}, position FROM tracks
       WHERE release_at <= now() ORDER BY slug, version DESC
     ) t ORDER BY position, slug`,
  );
  return rows.map(fromRow);
}

export async function currentTrack(db: Queryable, slug: string): Promise<StoredTrack | undefined> {
  const { rows } = await db.query<TrackRow>(
    `SELECT ${COLUMNS} FROM tracks WHERE slug = $1 AND release_at <= now() ORDER BY version DESC LIMIT 1`,
    [slug],
  );
  return rows[0] && fromRow(rows[0]);
}

export async function trackById(db: Queryable, id: number): Promise<StoredTrack | undefined> {
  const { rows } = await db.query<TrackRow>(`SELECT ${COLUMNS} FROM tracks WHERE id = $1`, [id]);
  return rows[0] && fromRow(rows[0]);
}

function mapRows(def: TrackDef): string[] {
  const rows = def.map.replace(/\r/g, '').split('\n');
  while (rows.length && rows[0]!.trim() === '') rows.shift();
  while (rows.length && rows[rows.length - 1]!.trim() === '') rows.pop();
  return rows;
}

export interface SyncOptions {
  /**
   * Before launch, tracks stay at v1 while their maps change. With this set, a changed map
   * overwrites the stored one and that track's runs are deleted (they no longer replay).
   * Off in production: there a changed map without a version bump stops startup instead.
   */
  replaceChanged?: boolean;
}

/**
 * Inserts any built-in track version the database doesn't have yet, with its par.
 * In production a stored version is never edited: if a built-in map changed without a version
 * bump, startup fails rather than silently changing a track that has runs against it.
 */
export async function syncBuiltinTracks(
  db: Db,
  defs: readonly TrackDef[] = BUILTIN_TRACKS,
  options: SyncOptions = {},
): Promise<string[]> {
  const changes: string[] = [];
  for (const [position, def] of defs.entries()) {
    const { track } = parseTrack(def);
    const errors = validateTrack(track);
    if (errors.length) throw new Error(`built-in track ${def.slug} is invalid: ${errors.join('; ')}`);
    const rows = mapRows(def);

    const existing = await db.query<{
      id: number;
      name: string;
      position: number;
      grid: { rows: string[] };
      max_turns: number;
    }>('SELECT id, name, position, grid, max_turns FROM tracks WHERE slug = $1 AND version = $2', [
      def.slug,
      def.version,
    ]);
    const stored = existing.rows[0];
    const best = () => {
      const moves = shortestRun(track);
      return moves ? (replay(track, moves).score ?? null) : null;
    };
    if (stored) {
      const mapChanged = stored.grid.rows.join('\n') !== rows.join('\n') || stored.max_turns !== track.maxTurns;
      if (mapChanged && !options.replaceChanged) {
        throw new Error(`built-in track ${def.slug} v${def.version} differs from the database; bump its version`);
      }
      if (mapChanged) {
        await withTransaction(db, async (tx) => {
          await tx.query('DELETE FROM runs WHERE track_id = $1', [stored.id]);
          await tx.query('DELETE FROM live_runs WHERE track_id = $1', [stored.id]);
          await tx.query('UPDATE tracks SET grid = $2, max_turns = $3, par = $4, rules_version = $5 WHERE id = $1', [
            stored.id,
            { rows },
            track.maxTurns,
            best(),
            RULES_V1.rulesVersion,
          ]);
        });
        changes.push(`${def.slug} v${def.version} map replaced, its runs deleted`);
      }
      if (stored.name !== def.name || stored.position !== position) {
        await db.query('UPDATE tracks SET name = $2, position = $3 WHERE id = $1', [stored.id, def.name, position]);
      }
      continue;
    }

    await db.query(
      `INSERT INTO tracks (slug, version, name, position, rules_version, grid, max_turns, par)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [def.slug, def.version, def.name, position, RULES_V1.rulesVersion, { rows }, track.maxTurns, best()],
    );
    changes.push(`${def.slug} v${def.version} added`);
  }
  return changes;
}
