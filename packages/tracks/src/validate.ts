import { cellAt, CHECKPOINT_BASE, FINISH, WALL, type Point, type Track } from '@vector-racer/sim';

/**
 * Checks a parsed track for problems the sim does not catch on its own.
 * Returns a list of human-readable errors; an empty list means the track is valid.
 */
export function validateTrack(track: Track): string[] {
  const errors: string[] = [];

  const finish = cellsWhere(track, (c) => c === FINISH);
  if (finish.length === 0) errors.push('track has no finish cells');

  for (let n = 1; n <= track.checkpointCount; n++) {
    if (cellsWhere(track, (c) => c === CHECKPOINT_BASE + n).length === 0) {
      errors.push(`checkpoints must be numbered 1..${track.checkpointCount} with no gaps; ${n} is missing`);
    }
  }
  if (errors.length) return errors;

  // Reachability, stage by stage: start -> cp1 -> cp2 -> ... -> finish.
  // A car's traced path always covers a 4-connected chain of cells, and a 4-connected
  // chain of open cells can always be driven at speed 1, so 4-connectivity is exact here.
  let from: Point[] = [track.start];
  for (let n = 1; n <= track.checkpointCount + 1; n++) {
    const isTarget =
      n <= track.checkpointCount ? (c: number) => c === CHECKPOINT_BASE + n : (c: number) => c === FINISH;
    const reached = flood(track, from).filter((p) => isTarget(cellAt(track, p.x, p.y)));
    if (reached.length === 0) {
      errors.push(n <= track.checkpointCount ? `checkpoint ${n} is unreachable` : 'finish is unreachable');
      break;
    }
    from = reached;
  }
  return errors;
}

function cellsWhere(track: Track, pred: (cell: number) => boolean): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < track.height; y++)
    for (let x = 0; x < track.width; x++) if (pred(cellAt(track, x, y))) out.push({ x, y });
  return out;
}

function flood(track: Track, seeds: Point[]): Point[] {
  const seen = new Uint8Array(track.width * track.height);
  const queue = [...seeds];
  for (const p of seeds) seen[p.y * track.width + p.x] = 1;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (cellAt(track, x, y) === WALL || seen[y * track.width + x]) continue;
      seen[y * track.width + x] = 1;
      queue.push({ x, y });
    }
  }
  return queue;
}
