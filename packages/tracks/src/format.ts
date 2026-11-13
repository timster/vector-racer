import {
  CHECKPOINT_BASE,
  createTrack,
  DEFAULT_MAX_TURNS,
  FINISH,
  ROAD,
  START,
  WALL,
  type Track,
} from '@vector-racer/sim';

/**
 * Text track format: one character per cell, one line per row.
 *   #  wall      .  road      S  start (exactly one)
 *   F  finish    1-9  checkpoint n (crossed in order before the finish counts)
 * Leading and trailing blank lines are ignored; every row must have the same width.
 */
export interface TrackDef {
  slug: string;
  name: string;
  /** Bump whenever the map or maxTurns changes; stored runs record it. */
  version: number;
  maxTurns?: number;
  map: string;
}

export interface ParsedTrack {
  slug: string;
  name: string;
  version: number;
  track: Track;
}

const CHAR_TO_CELL: Record<string, number> = { '#': WALL, '.': ROAD, S: START, F: FINISH };

export function parseMap(map: string, maxTurns: number = DEFAULT_MAX_TURNS): Track {
  const rows = map.replace(/\r/g, '').split('\n');
  while (rows.length && rows[0]!.trim() === '') rows.shift();
  while (rows.length && rows[rows.length - 1]!.trim() === '') rows.pop();
  if (rows.length === 0) throw new Error('empty map');

  const width = rows[0]!.length;
  const cells: number[] = [];
  rows.forEach((row, y) => {
    if (row.length !== width) throw new Error(`row ${y} has width ${row.length}, expected ${width}`);
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch >= '1' && ch <= '9') cells.push(CHECKPOINT_BASE + Number(ch));
      else if (ch in CHAR_TO_CELL) cells.push(CHAR_TO_CELL[ch]!);
      else throw new Error(`unknown character '${ch}' at ${x},${y}`);
    }
  });
  return createTrack(width, rows.length, cells, maxTurns);
}

export function parseTrack(def: TrackDef): ParsedTrack {
  return { slug: def.slug, name: def.name, version: def.version, track: parseMap(def.map, def.maxTurns) };
}
