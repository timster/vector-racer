export interface Point {
  x: number;
  y: number;
}

// Cell codes. Checkpoint n (1..9) is stored as CHECKPOINT_BASE + n.
export const ROAD = 0;
export const WALL = 1;
export const START = 2;
export const FINISH = 3;
export const CHECKPOINT_BASE = 10;
export const MAX_CHECKPOINTS = 9;

export const DEFAULT_MAX_TURNS = 500;

export interface Track {
  readonly width: number;
  readonly height: number;
  /** Row-major cell codes, length width * height. */
  readonly cells: readonly number[];
  readonly start: Point;
  /** Checkpoints are numbered 1..checkpointCount and must be crossed in order. */
  readonly checkpointCount: number;
  readonly maxTurns: number;
}

export function checkpointNumber(cell: number): number {
  return cell > CHECKPOINT_BASE && cell <= CHECKPOINT_BASE + MAX_CHECKPOINTS ? cell - CHECKPOINT_BASE : 0;
}

/** Cells outside the grid behave as walls. */
export function cellAt(track: Track, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= track.width || y >= track.height) return WALL;
  return track.cells[y * track.width + x]!;
}

/**
 * Builds a Track from raw cells, enforcing the structural invariants the sim relies on:
 * integer dimensions, known cell codes, exactly one start cell and a positive turn limit.
 * Reachability and checkpoint numbering are checked by the tracks package validator.
 */
export function createTrack(
  width: number,
  height: number,
  cells: readonly number[],
  maxTurns: number = DEFAULT_MAX_TURNS,
): Track {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`invalid track size ${width}x${height}`);
  }
  if (cells.length !== width * height) {
    throw new Error(`expected ${width * height} cells, got ${cells.length}`);
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`invalid maxTurns ${maxTurns}`);
  }
  let start: Point | undefined;
  let checkpointCount = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const cp = checkpointNumber(c);
    if (c !== ROAD && c !== WALL && c !== START && c !== FINISH && cp === 0) {
      throw new Error(`unknown cell code ${c} at index ${i}`);
    }
    if (c === START) {
      if (start) throw new Error('track has more than one start cell');
      start = { x: i % width, y: Math.floor(i / width) };
    }
    if (cp > checkpointCount) checkpointCount = cp;
  }
  if (!start) throw new Error('track has no start cell');
  return { width, height, cells: [...cells], start, checkpointCount, maxTurns };
}
