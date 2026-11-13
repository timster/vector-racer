import { describe, expect, it } from 'vitest';
import { accelToMove, initialState, moveToAccel, replay, step, type MoveIndex, type State, type Track } from '../src';
import { at, grid, M, mulberry32 } from './helpers';

function must(track: Track, state: State, move: number) {
  const r = step(track, state, move);
  if (!r.ok) throw new Error(`step failed: ${r.reason}`);
  return r;
}

function run(track: Track, moves: number[]) {
  let s = initialState(track);
  const out = [{ state: s, crashed: false }];
  for (const m of moves) {
    const r = must(track, s, m);
    s = r.state;
    out.push({ state: s, crashed: r.crashed });
  }
  return out;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('move encoding', () => {
  it('round-trips all 9 accelerations', () => {
    for (let m = 0; m <= 8; m++) {
      const { ax, ay } = moveToAccel(m as MoveIndex);
      expect(accelToMove(ax, ay)).toBe(m);
    }
    expect(moveToAccel(M.COAST)).toEqual({ ax: 0, ay: 0 });
    expect(moveToAccel(M.UL)).toEqual({ ax: -1, ay: -1 });
    expect(moveToAccel(M.DR)).toEqual({ ax: 1, ay: 1 });
  });
});

describe('known optimal runs', () => {
  it('straight corridor: 3 turns, finishing before the off-grid landing', () => {
    const t = grid(['S....F']);
    const [, s1, s2, s3] = run(t, [M.R, M.R, M.R]);
    expect(at(s1!.state)).toEqual({ x: 1, y: 0, vx: 1, vy: 0 });
    expect(at(s2!.state)).toEqual({ x: 3, y: 0, vx: 2, vy: 0 });
    // Target x = 6 is off the grid, but the path crosses F at x = 5 first.
    expect(s3!.crashed).toBe(false);
    expect(s3!.state.finished).toBe(true);
    expect(at(s3!.state)).toEqual({ x: 5, y: 0, vx: 3, vy: 0 });
    expect(replay(t, [M.R, M.R, M.R])).toMatchObject({ valid: true, score: 3 });
  });

  // Optimum is 5: column 3 can only be entered from (3,0) with vx = 0 after the
  // turn, and the earliest that happens is turn 3, then 2 turns to drop 3 rows.
  const lBend = grid([
    'S...#', //
    '###.#',
    '###.#',
    '###F#',
  ]);

  it('L-bend: coast to the corner, then turn down (5 turns)', () => {
    const moves = [M.R, M.COAST, M.COAST, M.DL, M.D];
    const states = run(lBend, moves).map((r) => at(r.state));
    expect(states).toEqual([
      { x: 0, y: 0, vx: 0, vy: 0 },
      { x: 1, y: 0, vx: 1, vy: 0 },
      { x: 2, y: 0, vx: 1, vy: 0 },
      { x: 3, y: 0, vx: 1, vy: 0 },
      { x: 3, y: 1, vx: 0, vy: 1 },
      { x: 3, y: 3, vx: 0, vy: 2 },
    ]);
    expect(replay(lBend, moves)).toMatchObject({ valid: true, score: 5 });
  });

  it('L-bend: overshooting into the wall costs 3 penalty turns (8 turns)', () => {
    const moves = [M.R, M.R, M.DR, M.D, M.D];
    const r = run(lBend, moves);
    expect(r[3]!.crashed).toBe(true);
    expect(at(r[3]!.state)).toEqual({ x: 3, y: 0, vx: 0, vy: 0 });
    expect(r[3]!.state.turn).toBe(6);
    expect(replay(lBend, moves)).toMatchObject({ valid: true, score: 8 });
  });

  it('L-bend: cutting the corner diagonally crashes at the corner', () => {
    // From (2,0) with v(1,0), accel down gives v(1,1): the path passes the corner
    // shared by (3,0) road and (2,1) wall, so it stops at (2,0).
    const r = run(lBend, [M.R, M.COAST, M.D]);
    expect(r[3]!.crashed).toBe(true);
    expect(at(r[3]!.state)).toEqual({ x: 2, y: 0, vx: 0, vy: 0 });
  });
});

describe('walls and grid edges', () => {
  it('cannot squeeze diagonally between two wall corners', () => {
    const t = grid(['S#', '#F']);
    const r = must(t, initialState(t), M.DR);
    expect(r.crashed).toBe(true);
    expect(r.state.finished).toBe(false);
    expect(at(r.state)).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });

    const open = grid(['S.', '.F']);
    expect(must(open, initialState(open), M.DR).state.finished).toBe(true);
  });

  it('a fast move cannot skip over a thin wall', () => {
    const t = grid(['S.#....F']);
    const fast: State = { ...initialState(t), vx: 4 };
    const r = must(t, fast, M.R); // v = 5, target x = 5, beyond the wall at x = 2
    expect(r.crashed).toBe(true);
    expect(at(r.state)).toEqual({ x: 1, y: 0, vx: 0, vy: 0 });
  });

  it('leaving the grid counts as hitting a wall', () => {
    const t = grid(['S..']);
    const r = run(t, [M.R, M.R]); // second move targets x = 3, off the grid
    expect(r[2]!.crashed).toBe(true);
    expect(at(r[2]!.state)).toEqual({ x: 2, y: 0, vx: 0, vy: 0 });

    const up = must(t, initialState(t), M.U);
    expect(up.crashed).toBe(true);
    expect(at(up.state)).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
  });

  it('a crash costs the move plus 3 penalty turns and keeps checkpoints crossed before the wall', () => {
    const t = grid(['S1.#F']);
    const r = run(t, [M.R, M.R]);
    expect(r[1]!.state.nextCheckpoint).toBe(2);
    expect(r[2]!.crashed).toBe(true);
    expect(r[2]!.state.turn).toBe(5);
    expect(r[2]!.state.nextCheckpoint).toBe(2);
    expect(r[2]!.state.lastSafe).toEqual({ x: 2, y: 0 });
  });

  it('coasting at zero speed stays put and still costs a turn', () => {
    const t = grid(['S.F']);
    const r = must(t, initialState(t), M.COAST);
    expect(r.crashed).toBe(false);
    expect(at(r.state)).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
    expect(r.state.turn).toBe(1);
  });
});

describe('checkpoints and finish', () => {
  it('checkpoints only count in order, and the finish only opens after the last one', () => {
    const t = grid(['S.2.1.F']);
    const moves = [M.R, M.R, M.COAST, M.R, M.L, M.L, M.L, M.R, M.R, M.R, M.R];
    const r = run(t, moves);
    // Move 2 passes cp2 at x = 2, which is ignored because cp1 is next; move 3 passes cp1.
    expect(r[2]!.state.nextCheckpoint).toBe(1);
    expect(r[3]!.state.nextCheckpoint).toBe(2);
    // Move 4 crosses F with cp2 still pending, then leaves the grid.
    expect(r[4]!.crashed).toBe(true);
    expect(r[4]!.state.finished).toBe(false);
    expect(at(r[4]!.state)).toEqual({ x: 6, y: 0, vx: 0, vy: 0 });
    // Moves 5-7 drive back across cp2.
    expect(r[7]!.state.nextCheckpoint).toBe(3);
    expect(at(r[7]!.state)).toEqual({ x: 0, y: 0, vx: -3, vy: 0 });
    // Move 8 brakes into the left edge; moves 9-11 accelerate across F.
    expect(r[8]!.crashed).toBe(true);
    expect(r[11]!.state.finished).toBe(true);
    // 11 moves plus 2 wall hits at 3 penalty turns each.
    expect(replay(t, moves)).toMatchObject({ valid: true, score: 17 });
  });

  it('can cross several checkpoints and the finish in one move', () => {
    const t = grid(['S12F..']);
    const fast: State = { ...initialState(t), vx: 3 };
    const r = must(t, fast, M.COAST); // path 1 (cp1), 2 (cp2), 3 (F)
    expect(r.state.finished).toBe(true);
    expect(r.state.nextCheckpoint).toBe(3);
    expect(r.state.x).toBe(3);
    expect(replay(t, [M.R, M.R])).toMatchObject({ valid: true, score: 2 });
    expect(replay(t, [M.R, M.R, M.COAST])).toEqual({ valid: false, reason: 'moves_after_finish at move 2' });
  });

  it('detects the finish on the segment, not the landing cell', () => {
    const t = grid(['S...F...']);
    const r = run(t, [M.R, M.R, M.R]); // lands target x = 6, crossing F at x = 4
    expect(r[3]!.state.finished).toBe(true);
    expect(r[3]!.state.x).toBe(4);
  });
});

describe('input validation', () => {
  const t = grid(['S.....F'], 2);

  it('rejects anything but an integer 0..8', () => {
    for (const bad of [9, -1, 1.5, '3', NaN, null, undefined, Infinity]) {
      expect(step(t, initialState(t), bad as number)).toEqual({ ok: false, reason: 'invalid_move' });
    }
  });

  it('rejects moves after finishing and past the turn limit', () => {
    const done: State = { ...initialState(t), finished: true };
    expect(step(t, done, M.R)).toEqual({ ok: false, reason: 'already_finished' });
    const late: State = { ...initialState(t), turn: 2 };
    expect(step(t, late, M.R)).toEqual({ ok: false, reason: 'turn_limit' });
  });

  it('replay rejects bad runs with a reason', () => {
    expect(replay(t, 'nope')).toEqual({ valid: false, reason: 'moves_not_array' });
    expect(replay(t, [M.R, M.R, M.R])).toEqual({ valid: false, reason: 'too_many_moves' });
    expect(replay(t, [M.R, 12])).toEqual({ valid: false, reason: 'invalid_move at move 1' });
    expect(replay(t, [M.R, M.R])).toEqual({ valid: false, reason: 'did_not_finish' });
    expect(replay(grid(['SF']), [M.R, M.L])).toEqual({ valid: false, reason: 'moves_after_finish at move 1' });
  });
});

describe('purity and determinism', () => {
  const open = grid(['..........', '.S......#.', '....##....', '..1.##..2.', '..........', '.....F....']);

  it('step does not mutate its inputs', () => {
    const track = deepFreeze(open);
    const s = deepFreeze(initialState(track));
    const r = must(track, s, M.DR);
    expect(r.state).not.toBe(s);
    expect(s).toEqual(initialState(open));
  });

  it('random move sequences replay identically', () => {
    const rand = mulberry32(12345);
    for (let i = 0; i < 300; i++) {
      const moves = Array.from({ length: 1 + Math.floor(rand() * 40) }, () => Math.floor(rand() * 9));
      // Trim at the finish so every sequence is a legal prefix.
      let s = initialState(open);
      const legal: number[] = [];
      for (const m of moves) {
        if (s.finished) break;
        s = must(open, s, m).state;
        legal.push(m);
      }
      const first = JSON.stringify(run(open, legal));
      const second = JSON.stringify(run(open, legal));
      expect(second).toBe(first);
      if (s.finished) {
        const r = replay(open, legal);
        expect(r.valid).toBe(true);
        expect(r.score).toBe(s.turn);
        expect(JSON.stringify(r.states)).toBe(JSON.stringify(run(open, legal).map((x) => x.state)));
      }
    }
  });
});
