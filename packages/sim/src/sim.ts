import { RULES_V1, type Rules } from './rules';
import { trace } from './trace';
import { cellAt, CHECKPOINT_BASE, FINISH, WALL, type Point, type Track } from './track';

export type MoveIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface State {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Turns taken so far, including any crash penalties. */
  turn: number;
  /** The checkpoint that must be crossed next; > checkpointCount means the finish is open. */
  nextCheckpoint: number;
  finished: boolean;
  lastSafe: Point;
}

export type StepResult =
  | { ok: true; state: State; crashed: boolean }
  | { ok: false; reason: 'invalid_move' | 'already_finished' | 'turn_limit' };

export interface ReplayResult {
  valid: boolean;
  /** Final turn count. */
  score?: number;
  reason?: string;
  /** states[0] is the initial state; states[i] is the state after move i - 1. */
  states?: State[];
}

export function isMoveIndex(move: unknown): move is MoveIndex {
  return typeof move === 'number' && Number.isInteger(move) && move >= 0 && move <= 8;
}

/** index = (ay + 1) * 3 + (ax + 1) */
export function moveToAccel(move: MoveIndex): { ax: number; ay: number } {
  return { ax: (move % 3) - 1, ay: Math.floor(move / 3) - 1 };
}

export function accelToMove(ax: number, ay: number): MoveIndex {
  const move = (ay + 1) * 3 + (ax + 1);
  if (!isMoveIndex(move) || Math.abs(ax) > 1 || Math.abs(ay) > 1) {
    throw new Error(`invalid acceleration ${ax},${ay}`);
  }
  return move;
}

export function initialState(track: Track): State {
  return {
    x: track.start.x,
    y: track.start.y,
    vx: 0,
    vy: 0,
    turn: 0,
    nextCheckpoint: 1,
    finished: false,
    lastSafe: { x: track.start.x, y: track.start.y },
  };
}

export function step(track: Track, state: State, move: number, rules: Rules = RULES_V1): StepResult {
  if (!isMoveIndex(move)) return { ok: false, reason: 'invalid_move' };
  if (state.finished) return { ok: false, reason: 'already_finished' };
  if (state.turn >= track.maxTurns) return { ok: false, reason: 'turn_limit' };

  const { ax, ay } = moveToAccel(move);
  const vx = state.vx + ax;
  const vy = state.vy + ay;

  let x = state.x;
  let y = state.y;
  let nextCheckpoint = state.nextCheckpoint;
  let finished = false;
  let crashed = false;

  for (const group of trace(state.x, state.y, state.x + vx, state.y + vy)) {
    if (group.some((p) => cellAt(track, p.x, p.y) === WALL)) {
      crashed = true;
      break;
    }
    for (const p of group) {
      const cell = cellAt(track, p.x, p.y);
      if (nextCheckpoint <= track.checkpointCount && cell === CHECKPOINT_BASE + nextCheckpoint) {
        nextCheckpoint++;
      } else if (cell === FINISH && nextCheckpoint > track.checkpointCount) {
        finished = true;
      }
    }
    const main = group[group.length - 1]!;
    x = main.x;
    y = main.y;
    // The run ends where the path first crosses the line; anything beyond it is ignored.
    if (finished) break;
  }

  if (crashed) {
    const out = rules.onCollision({ stop: { x, y } });
    return {
      ok: true,
      crashed: true,
      state: {
        x: out.x,
        y: out.y,
        vx: out.vx,
        vy: out.vy,
        turn: state.turn + 1 + out.penalty,
        nextCheckpoint,
        finished: false,
        lastSafe: { x: out.x, y: out.y },
      },
    };
  }

  return {
    ok: true,
    crashed: false,
    state: { x, y, vx, vy, turn: state.turn + 1, nextCheckpoint, finished, lastSafe: { x, y } },
  };
}

/** Replays a full run and returns the score. Never trusts anything but the track and the moves. */
export function replay(track: Track, moves: unknown, rules: Rules = RULES_V1): ReplayResult {
  if (!Array.isArray(moves)) return { valid: false, reason: 'moves_not_array' };
  if (moves.length > track.maxTurns) return { valid: false, reason: 'too_many_moves' };

  let state = initialState(track);
  const states: State[] = [state];
  for (let i = 0; i < moves.length; i++) {
    if (state.finished) return { valid: false, reason: `moves_after_finish at move ${i}` };
    const result = step(track, state, moves[i], rules);
    if (!result.ok) return { valid: false, reason: `${result.reason} at move ${i}` };
    state = result.state;
    states.push(state);
  }
  if (!state.finished) return { valid: false, reason: 'did_not_finish' };
  return { valid: true, score: state.turn, states };
}
