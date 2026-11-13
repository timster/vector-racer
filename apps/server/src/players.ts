import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Queryable } from './db/pool';

export const PLAYER_COOKIE = 'vr_player';
export const COOKIE_DAYS = 400;

// Letters, digits, spaces, _ and -. Names are free-form and need not be unique.
export const NAME_PATTERN = '^[A-Za-z0-9 _-]{1,16}$';
const NAME_RE = new RegExp(NAME_PATTERN);

export interface Player {
  id: number;
  displayName: string;
}

/** Trims and collapses spaces; undefined if the result isn't a valid name. */
export function normalizeName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : undefined;
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

// No 0/O, 1/I/L, so default names read back unambiguously.
const NAME_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomName(): string {
  let s = 'Racer-';
  for (let i = 0; i < 4; i++) s += NAME_ALPHABET[randomInt(NAME_ALPHABET.length)];
  return s;
}

/** Creates a player with a default name. The returned token goes in the cookie; only its hash is stored. */
export async function createPlayer(db: Queryable): Promise<{ player: Player; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ id: number; display_name: string }>(
    'INSERT INTO players (display_name, token_hash) VALUES ($1, $2) RETURNING id, display_name',
    [randomName(), sha256(token)],
  );
  return { player: { id: rows[0]!.id, displayName: rows[0]!.display_name }, token };
}

export async function playerByToken(db: Queryable, token: string): Promise<Player | undefined> {
  const { rows } = await db.query<{ id: number; display_name: string }>(
    'SELECT id, display_name FROM players WHERE token_hash = $1',
    [sha256(token)],
  );
  return rows[0] && { id: rows[0].id, displayName: rows[0].display_name };
}

/** Renames a player; every run of theirs shows the new name, since runs reference the player. */
export async function renamePlayer(db: Queryable, id: number, name: string): Promise<Player> {
  const { rows } = await db.query<{ id: number; display_name: string }>(
    'UPDATE players SET display_name = $2 WHERE id = $1 RETURNING id, display_name',
    [id, name],
  );
  return { id: rows[0]!.id, displayName: rows[0]!.display_name };
}
