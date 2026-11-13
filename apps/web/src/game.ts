import { initialState, moveToAccel, step, type MoveIndex, type State, type StepResult } from '@vector-racer/sim';
import type { ParsedTrack } from '@vector-racer/tracks';

export interface Candidate {
  move: MoveIndex;
  /** Where the car aims for (position + velocity + acceleration), even if off the grid. */
  target: { x: number; y: number };
  /**
   * Where to draw the clickable dot: the target, except for a finishing move, which is pinned
   * to where the path first crosses the line (the target may be far past it, off the board).
   */
  dot: { x: number; y: number };
  result: StepResult;
}

/** One local run: the move list plus the states the shared sim produced from it. */
export class Game {
  readonly moves: MoveIndex[] = [];
  readonly states: State[];
  readonly crashed: boolean[] = [false];

  constructor(readonly track: ParsedTrack) {
    this.states = [initialState(track.track)];
  }

  /** Builds a finished run from a known move list, e.g. the best line. */
  static fromMoves(track: ParsedTrack, moves: readonly number[]): Game {
    const game = new Game(track);
    for (const m of moves) {
      if (!game.play(m as MoveIndex).ok) throw new Error(`move ${m} rejected on ${track.slug}`);
    }
    return game;
  }

  /** Index of the last state reached by the given turn (crash penalties make turns skip). */
  indexAtTurn(turn: number): number {
    let i = 0;
    while (i + 1 < this.states.length && this.states[i + 1]!.turn <= turn) i++;
    return i;
  }

  get state(): State {
    return this.states[this.states.length - 1]!;
  }

  /** The moves to offer as clickable dots. */
  candidates(): Candidate[] {
    const s = this.state;
    if (s.finished) return [];
    const out: Candidate[] = [];
    for (let m = 0; m <= 8; m++) {
      const move = m as MoveIndex;
      const { ax, ay } = moveToAccel(move);
      const target = { x: s.x + s.vx + ax, y: s.y + s.vy + ay };
      const result = step(this.track.track, s, move);
      const dot = result.ok && result.state.finished ? { x: result.state.x, y: result.state.y } : target;
      out.push({ move, target, dot, result });
    }
    // When some moves finish, those are the only ones worth offering.
    const finishing = out.filter((c) => c.result.ok && c.result.state.finished);
    return finishing.length ? finishing : out;
  }

  play(move: MoveIndex): StepResult {
    const r = step(this.track.track, this.state, move);
    if (r.ok) {
      this.moves.push(move);
      this.states.push(r.state);
      this.crashed.push(r.crashed);
    }
    return r;
  }

  undo(): boolean {
    if (this.moves.length === 0) return false;
    this.moves.pop();
    this.states.pop();
    this.crashed.pop();
    return true;
  }

  exportRun(): string {
    return JSON.stringify({ track: this.track.slug, trackVersion: this.track.version, moves: this.moves });
  }
}
