import { randomBytes, timingSafeEqual } from 'node:crypto';
import { initialState, isMoveIndex, step, type State } from '@vector-racer/sim';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction, type Db, type Queryable } from './db/pool';
import type { Player } from './players';
import { bestForPlayer, submitRun } from './runs';
import { currentTrack, trackById, type StoredTrack } from './tracks';

/**
 * Live runs over a WebSocket: the server applies every move as it is made, so a finished run
 * cannot be submitted in one go. Rules:
 * - The racer comes from the cookie on the upgrade request; pages from other origins are refused.
 * - One live run per racer. It starts with the racer's first move on a track; starting one (in any
 *   tab) ends the previous one.
 * - Each move must echo the single-use nonce from the server's previous reply, so moves arrive
 *   strictly in order. No think-time limits.
 * - Open runs are stored in Postgres (`live_runs`), so they survive the browser closing, the
 *   connection dropping and the server restarting. On connecting, the client asks for its open
 *   run and carries on. Runs untouched for 30 days are cleaned up.
 * - A finished run is saved as a `live` run; only live runs are ranked.
 * - Messages are capped at 1 KB, and a socket sending too many per second is closed.
 */

export const MAX_MESSAGE_BYTES = 1024;
const ABANDONED_DAYS = 30;
const SWEEP_MS = 60 * 60 * 1000;

export type ClientMessage =
  | { type: 'start_run'; trackSlug: string; trackVersion: number }
  | { type: 'move'; move: number; nonce: string }
  | { type: 'resume' };

interface LiveRunRow {
  id: string;
  player_id: number;
  track_id: number;
  moves: number[];
  nonce: string;
}

function token(): string {
  return randomBytes(16).toString('base64url');
}

function sameNonce(a: string, b: unknown): boolean {
  if (typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(socket: WebSocket | undefined, message: object): void {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function error(socket: WebSocket, code: string, message: string, extra: object = {}): void {
  send(socket, { type: 'error', code, message, ...extra });
}

/** Rebuilds a run's state from its moves (they were all accepted by step() when made). */
function stateAfter(track: StoredTrack, moves: number[]): State {
  let state = initialState(track.track);
  for (const m of moves) {
    const r = step(track.track, state, m);
    if (!r.ok) throw new Error(`stored live run does not replay: ${r.reason}`);
    state = r.state;
  }
  return state;
}

export class LiveRuns {
  /** Sockets on this server, by racer, to tell a tab when its run was taken over elsewhere. */
  private readonly sockets = new Map<number, Set<WebSocket>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly allowStart: (req: FastifyRequest) => Promise<boolean>,
    private readonly messagesPerSecond: number,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
    this.sockets.clear();
  }

  /** Handles one racer's socket for as long as it stays open. */
  attach(socket: WebSocket, player: Player, req: FastifyRequest): void {
    const mine = this.sockets.get(player.id) ?? new Set();
    mine.add(socket);
    this.sockets.set(player.id, mine);

    let windowStart = Date.now();
    let count = 0;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > this.messagesPerSecond) {
        error(socket, 'rate_limited', 'Too many messages');
        socket.close(1008, 'too many messages');
        return;
      }
      let msg: ClientMessage;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        error(socket, 'bad_message', 'Messages must be JSON text');
        return;
      }
      this.handle(socket, player, req, msg).catch((err: unknown) => {
        this.log.error({ err, playerId: player.id }, 'live message failed');
        error(socket, 'internal', 'Something went wrong');
      });
    });

    socket.on('close', () => {
      mine.delete(socket);
      if (mine.size === 0) this.sockets.delete(player.id);
    });
  }

  private async handle(socket: WebSocket, player: Player, req: FastifyRequest, msg: ClientMessage): Promise<void> {
    if (msg?.type === 'start_run') return this.start(socket, player, req, msg);
    if (msg?.type === 'move') return this.move(socket, player, msg);
    if (msg?.type === 'resume') return this.resume(socket, player);
    error(socket, 'bad_message', 'Unknown message type');
  }

  private async start(
    socket: WebSocket,
    player: Player,
    req: FastifyRequest,
    msg: Extract<ClientMessage, { type: 'start_run' }>,
  ): Promise<void> {
    if (!(await this.allowStart(req))) {
      error(socket, 'rate_limited', 'Too many runs started; wait a moment');
      return;
    }
    const track = typeof msg.trackSlug === 'string' ? await currentTrack(this.db, msg.trackSlug) : undefined;
    if (!track) {
      error(socket, 'unknown_track', 'No such track');
      return;
    }
    if (msg.trackVersion !== track.version) {
      error(socket, 'stale_track_version', `${track.name} is now version ${track.version}; reload to race it`, {
        currentVersion: track.version,
      });
      return;
    }

    // One live run per racer: this replaces any open one.
    const id = token();
    const nonce = token();
    await this.db.query(
      `INSERT INTO live_runs (id, player_id, track_id, nonce) VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id) DO UPDATE
         SET id = excluded.id, track_id = excluded.track_id, moves = '{}', nonce = excluded.nonce,
             created_at = now(), updated_at = now()`,
      [id, player.id, track.id, nonce],
    );
    this.notifyOthers(player.id, socket, 'You started a new run somewhere else');
    send(socket, {
      type: 'run_started',
      sessionId: id,
      track: { slug: track.slug, version: track.version },
      state: initialState(track.track),
      moves: [],
      nonce,
    });
  }

  private async move(socket: WebSocket, player: Player, msg: Extract<ClientMessage, { type: 'move' }>): Promise<void> {
    if (!isMoveIndex(msg.move)) {
      error(socket, 'invalid_move', 'Moves are whole numbers from 0 to 8');
      return;
    }
    // Lock the racer's run row so two sockets can't both use the same nonce.
    const outcome = await withTransaction(this.db, async (tx) => {
      const { rows } = await tx.query<LiveRunRow>('SELECT * FROM live_runs WHERE player_id = $1 FOR UPDATE', [
        player.id,
      ]);
      const run = rows[0];
      if (!run) return { kind: 'error' as const, code: 'no_run', message: 'No live run open; start one' };
      if (!sameNonce(run.nonce, msg.nonce)) {
        return { kind: 'error' as const, code: 'bad_nonce', message: 'That move is out of order' };
      }
      const track = await this.trackFor(tx, run);
      if (!track) {
        await tx.query('DELETE FROM live_runs WHERE id = $1', [run.id]);
        return {
          kind: 'error' as const,
          code: 'stale_track_version',
          message: 'This track changed; reload to race it',
        };
      }

      const result = step(track.track, stateAfter(track, run.moves), msg.move);
      if (!result.ok) {
        // Only turn_limit can happen here (the move is valid and the run isn't finished): the run ends.
        await tx.query('DELETE FROM live_runs WHERE id = $1', [run.id]);
        return { kind: 'error' as const, code: result.reason, message: 'Out of turns: this run is over' };
      }
      const moves = [...run.moves, msg.move];

      if (!result.state.finished) {
        const nonce = token();
        await tx.query('UPDATE live_runs SET moves = $2, nonce = $3, updated_at = now() WHERE id = $1', [
          run.id,
          moves,
          nonce,
        ]);
        return { kind: 'state' as const, moves, state: result.state, crashed: result.crashed, nonce };
      }

      // Finished: store it like any run (replayed again from the moves), as a live run.
      await tx.query('DELETE FROM live_runs WHERE id = $1', [run.id]);
      const saved = await submitRun(tx, player.id, track, track.version, moves, 'live');
      if (!saved.ok) return { kind: 'error' as const, code: saved.error, message: saved.reason ?? saved.error };
      const best = await bestForPlayer(tx, track.id, player.id);
      this.log.info(
        { playerId: player.id, track: track.slug, runId: saved.runId, score: saved.score },
        'live run finished',
      );
      return {
        kind: 'finished' as const,
        state: result.state,
        crashed: result.crashed,
        score: saved.score,
        par: track.par,
        best: best ? { rank: best.rank, score: best.score } : null,
        isBest: best?.runId === saved.runId,
      };
    });

    if (outcome.kind === 'error') error(socket, outcome.code, outcome.message);
    else if (outcome.kind === 'state') {
      send(socket, {
        type: 'state',
        turn: outcome.moves.length,
        state: outcome.state,
        crashed: outcome.crashed,
        nonce: outcome.nonce,
      });
    } else {
      const { kind: _kind, ...finished } = outcome;
      send(socket, { type: 'finished', ...finished });
    }
  }

  /** Sends the racer's open run, if any, with a fresh nonce (any older nonce stops working). */
  private async resume(socket: WebSocket, player: Player): Promise<void> {
    const nonce = token();
    const { rows } = await this.db.query<LiveRunRow>(
      'UPDATE live_runs SET nonce = $2, updated_at = now() WHERE player_id = $1 RETURNING *',
      [player.id, nonce],
    );
    const run = rows[0];
    const track = run && (await this.trackFor(this.db, run));
    if (!run || !track) {
      if (run) await this.db.query('DELETE FROM live_runs WHERE id = $1', [run.id]);
      send(socket, { type: 'no_run' });
      return;
    }
    this.notifyOthers(player.id, socket, 'This run was picked up somewhere else');
    send(socket, {
      type: 'run_resumed',
      sessionId: run.id,
      track: { slug: track.slug, version: track.version },
      state: stateAfter(track, run.moves),
      moves: run.moves,
      nonce,
    });
  }

  /** The run's track, if it is still the current version (a run on an old version is void). */
  private async trackFor(db: Queryable, run: LiveRunRow): Promise<StoredTrack | undefined> {
    const track = await trackById(db, run.track_id);
    if (!track) return undefined;
    const current = await currentTrack(db, track.slug);
    return current?.id === track.id ? track : undefined;
  }

  private notifyOthers(playerId: number, except: WebSocket, message: string): void {
    for (const s of this.sockets.get(playerId) ?? []) {
      if (s !== except) error(s, 'run_replaced', message);
    }
  }

  private async sweep(): Promise<void> {
    try {
      await this.db.query(`DELETE FROM live_runs WHERE updated_at < now() - make_interval(days => $1)`, [
        ABANDONED_DAYS,
      ]);
    } catch (err) {
      this.log.error({ err }, 'live run sweep failed');
    }
  }
}

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  const limits = app.config.rateLimits;
  const startsPerPlayer = app.createRateLimit({
    max: limits.liveStartsPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => `live-start:player:${req.player?.id}`,
  });
  // createRateLimit reports isAllowed only for allow-listed keys; the limit is hit when isExceeded.
  const allowStart = async (req: FastifyRequest) => {
    const r = await startsPerPlayer(req);
    return r.isAllowed || !r.isExceeded;
  };
  const runs = new LiveRuns(app.db, app.log, allowStart, limits.liveMessagesPerSecond);
  app.addHook('onClose', async () => runs.close());

  app.get(
    '/ws',
    {
      websocket: true,
      // Refuse before upgrading, so a bad connection never opens.
      preValidation: async (req, reply) => {
        // Browsers always send Origin on WebSocket upgrades; refuse pages from other sites.
        const origin = req.headers.origin;
        const expected = app.config.publicOrigin ?? `${req.protocol}://${req.headers.host}`;
        if (origin !== undefined && origin !== expected) {
          return reply.code(403).send({ error: 'bad_origin', message: 'Cross-origin connection refused' });
        }
        if (!req.player) return reply.code(401).send({ error: 'no_player', message: 'No racer on this browser yet' });
      },
    },
    (socket, req) => runs.attach(socket, req.player!, req),
  );
}
