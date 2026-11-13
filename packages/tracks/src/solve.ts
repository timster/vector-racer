import { initialState, step, type State, type Track } from '@vector-racer/sim';

/**
 * Shortest-run search over (x, y, vx, vy, nextCheckpoint) using the real step().
 * Moves cost 1 turn plus any crash penalty, so states are expanded in turn order
 * (a bucket queue, i.e. Dijkstra with small integer costs); the first finish popped is optimal.
 * Used by tests and by the client's best-line ghost; the Phase 4 par tool (tools/solver) will wrap it.
 */
export function shortestRun(track: Track): number[] | undefined {
  const VMAX = 32;
  const key = (s: State) =>
    ((s.nextCheckpoint * track.height + s.y) * track.width + s.x) * (2 * VMAX) ** 2 +
    (s.vx + VMAX) * 2 * VMAX +
    (s.vy + VMAX);

  const start = initialState(track);
  const best = new Map<number, { turn: number; prev: number; move: number }>([
    [key(start), { turn: 0, prev: -1, move: -1 }],
  ]);
  const buckets: State[][] = [[start]];
  for (let turn = 0; turn < buckets.length; turn++) {
    for (const s of buckets[turn] ?? []) {
      const k = key(s);
      if (best.get(k)!.turn !== turn) continue; // stale entry
      if (s.finished) {
        const moves: number[] = [];
        for (let cur = k; best.get(cur)!.prev !== -1; cur = best.get(cur)!.prev) moves.push(best.get(cur)!.move);
        return moves.reverse();
      }
      for (let m = 0; m <= 8; m++) {
        const r = step(track, s, m);
        if (!r.ok) continue;
        const nk = key(r.state);
        const known = best.get(nk);
        if (known && known.turn <= r.state.turn) continue;
        best.set(nk, { turn: r.state.turn, prev: k, move: m });
        (buckets[r.state.turn] ??= []).push(r.state);
      }
    }
  }
  return undefined;
}
