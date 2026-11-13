import type { Db } from './pool';

/**
 * Ordered, append-only schema migrations. Never edit one that has shipped; add a new one.
 * Kept as TS strings (not .sql files) so the server bundles to a single file.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE tracks (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        slug text NOT NULL,
        version int NOT NULL,
        name text NOT NULL,
        position int NOT NULL DEFAULT 0,
        rules_version text NOT NULL,
        grid jsonb NOT NULL,
        max_turns int NOT NULL,
        par int,
        release_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (slug, version)
      );

      -- No login: a player is an anonymous identity held by one browser's cookie. Names are
      -- free-form and need not be unique; renaming a player renames all of their runs.
      CREATE TABLE players (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        display_name text NOT NULL,
        -- sha256 of the cookie token, so a database leak does not leak identities
        token_hash bytea NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE runs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        player_id bigint NOT NULL REFERENCES players (id) ON DELETE CASCADE,
        track_id bigint NOT NULL REFERENCES tracks (id),
        track_version int NOT NULL,
        sim_version int NOT NULL,
        rules_version text NOT NULL,
        moves smallint[] NOT NULL,
        score int NOT NULL,
        move_hash bytea NOT NULL,
        source text NOT NULL CHECK (source IN ('replay', 'live')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX runs_unique_moves ON runs (player_id, track_id, source, move_hash);
      CREATE INDEX runs_leaderboard ON runs (track_id, score, created_at);

      -- A live run in progress: at most one per racer. Stored so a run survives the browser closing,
      -- the connection dropping and the server restarting. The state is rebuilt by replaying moves.
      CREATE TABLE live_runs (
        id text PRIMARY KEY,
        player_id bigint NOT NULL UNIQUE REFERENCES players (id) ON DELETE CASCADE,
        track_id bigint NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
        moves smallint[] NOT NULL DEFAULT '{}',
        -- The single-use value the next move must echo back.
        nonce text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

/** Applies pending migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7261001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7261001)').catch(() => {});
    client.release();
  }
  return applied;
}
