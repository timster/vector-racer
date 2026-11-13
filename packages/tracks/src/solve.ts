import { initialState, step, type State, type Track } from '@vector-racer/sim';

/**
 * Shortest-run search over (x, y, vx, vy, nextCheckpoint) using the real step().
 * Moves cost 1 turn plus any crash penalty, so states are expanded in turn order
 * (a bucket queue, i.e. Dijkstra with small integer costs). Among runs with the best score,
 * it returns one with the fewest wall hits, so the best line is clean whenever a clean one ties.
 * Used by tests and by the client's best-line ghost; the Phase 4 par tool (tools/solver) will wrap it.
 */
export function shortestRun(track: Track): number[] | undefined {
  const VMAX = 32;
  const key = (s: State) =>
    ((s.nextCheckpoint * track.height + s.y) * track.width + s.x) * (2 * VMAX) ** 2 +
    (s.vx + VMAX) * 2 * VMAX +
    (s.vy + VMAX);

  const start = initialState(track);
  const best = new Map<number, { turn: number; hits: number; prev: number; move: number }>([
    [key(start), { turn: 0, hits: 0, prev: -1, move: -1 }],
  ]);
  const buckets: State[][] = [[start]];
  for (let turn = 0; turn < buckets.length; turn++) {
    // Every move costs at least one turn, so by the time a bucket is reached its states'
    // (turn, hits) are final. Each state is expanded once; duplicates in the bucket are skipped.
    const expanded = new Set<number>();
    let finish: number | undefined;
    for (const s of buckets[turn] ?? []) {
      const k = key(s);
      if (best.get(k)!.turn !== turn || expanded.has(k)) continue;
      expanded.add(k);
      if (s.finished) {
        if (finish === undefined || best.get(k)!.hits < best.get(finish)!.hits) finish = k;
        continue;
      }
      const hits = best.get(k)!.hits;
      for (let m = 0; m <= 8; m++) {
        const r = step(track, s, m);
        if (!r.ok) continue;
        const nk = key(r.state);
        const nextHits = hits + (r.crashed ? 1 : 0);
        const known = best.get(nk);
        if (known && (known.turn < r.state.turn || (known.turn === r.state.turn && known.hits <= nextHits))) continue;
        best.set(nk, { turn: r.state.turn, hits: nextHits, prev: k, move: m });
        (buckets[r.state.turn] ??= []).push(r.state);
      }
    }
    if (finish !== undefined) {
      const moves: number[] = [];
      for (let cur = finish; best.get(cur)!.prev !== -1; cur = best.get(cur)!.prev) moves.push(best.get(cur)!.move);
      return moves.reverse();
    }
  }
  return undefined;
}
