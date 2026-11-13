import { CHECKPOINT_BASE, createTrack, FINISH, ROAD, START, WALL, type State, type Track } from '../src';

// A minimal grid builder for tests. The real text format lives in @vector-racer/tracks;
// the sim cannot depend on it, so tests use this small copy of the character mapping.
export function grid(rows: string[], maxTurns?: number): Track {
  const width = rows[0]!.length;
  const cells: number[] = [];
  for (const row of rows) {
    if (row.length !== width) throw new Error('ragged test grid');
    for (const ch of row) {
      if (ch === '#') cells.push(WALL);
      else if (ch === '.') cells.push(ROAD);
      else if (ch === 'S') cells.push(START);
      else if (ch === 'F') cells.push(FINISH);
      else if (ch >= '1' && ch <= '9') cells.push(CHECKPOINT_BASE + Number(ch));
      else throw new Error(`bad test char ${ch}`);
    }
  }
  return createTrack(width, rows.length, cells, maxTurns);
}

export function at(state: State) {
  return { x: state.x, y: state.y, vx: state.vx, vy: state.vy };
}

// Move indices by direction, y down: index = (ay + 1) * 3 + (ax + 1).
export const M = {
  UL: 0,
  U: 1,
  UR: 2,
  L: 3,
  COAST: 4,
  R: 5,
  DL: 6,
  D: 7,
  DR: 8,
} as const;

/** Small deterministic PRNG for property tests (tests may be random; the sim may not). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
