import { replay } from '@vector-racer/sim';
import { getBuiltinTrack } from '@vector-racer/tracks';
import { describe, expect, it } from 'vitest';
import { BEST, liveRun, newPlayer, submit, testApp } from './helpers';

const { app, db } = await testApp();

describe('POST /tracks/:slug/runs (Phase 2 acceptance)', () => {
  it('ignores a forged score; the stored score is the replay result', async () => {
    const p = await newPlayer(app);
    const res = await submit(app, 'oval', { trackVersion: 1, moves: BEST.oval, score: 1, turns: 1 }, p.cookie);
    expect(res.statusCode).toBe(201);
    // Posted runs are verified and stored, but only live runs are ranked.
    expect(res.json()).toEqual({ score: 25, par: 25, best: null, isBest: false });

    const row = await db.query('SELECT score, moves, sim_version, source FROM runs WHERE player_id = $1', [p.id]);
    const expected = replay(getBuiltinTrack('oval')!.track, BEST.oval).score;
    expect(row.rows).toEqual([{ score: expected, moves: BEST.oval, sim_version: 1, source: 'replay' }]);
  });

  it('rejects illegal move lists with a clear reason', async () => {
    const cheater = await newPlayer(app);
    const cases: [unknown[], string][] = [
      // Straight at the wall: only "finishes" if walls were passable.
      [[5, 5, 5, 5, 5, 5, 5, 5], 'did_not_finish'],
      [[5, 9], 'invalid_move at move 1'],
      [[5, -1], 'invalid_move at move 1'],
      [[5, 1.5], 'invalid_move at move 1'],
      [[5, '5'], 'invalid_move at move 1'],
      [[5, null], 'invalid_move at move 1'],
      [[...BEST.dogleg, 4], 'moves_after_finish at move 8'],
      [Array(501).fill(4), 'too_many_moves'],
    ];
    for (const [moves, reason] of cases) {
      const res = await submit(app, 'dogleg', { trackVersion: 1, moves }, cheater.cookie);
      expect({ moves: JSON.stringify(moves).slice(0, 40), status: res.statusCode }).toMatchObject({ status: 422 });
      expect(res.json()).toMatchObject({ error: 'invalid_run', reason });
    }
    const count = await db.query('SELECT count(*) FROM runs WHERE player_id = $1', [cheater.id]);
    expect(count.rows[0].count).toBe(0);
  });

  it('rejects malformed bodies before replay', async () => {
    for (const body of [
      { moves: BEST.dogleg },
      { trackVersion: '1', moves: BEST.dogleg },
      { trackVersion: 1, moves: 'nope' },
      { trackVersion: 1, moves: Array(2001).fill(4) },
    ]) {
      expect((await submit(app, 'dogleg', body)).statusCode).toBe(400);
    }
  });

  it('needs a racer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tracks/dogleg/runs',
      payload: { trackVersion: 1, moves: BEST.dogleg },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale track version with the current version', async () => {
    const res = await submit(app, 'dogleg', { trackVersion: 2, moves: BEST.dogleg });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'stale_track_version', currentVersion: 1 });
  });

  it('rejects an exact duplicate run from the same racer, but not from another racer', async () => {
    const a = await newPlayer(app);
    expect((await submit(app, 'dogleg', { trackVersion: 1, moves: BEST.dogleg }, a.cookie)).statusCode).toBe(201);
    const dup = await submit(app, 'dogleg', { trackVersion: 1, moves: BEST.dogleg }, a.cookie);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('duplicate_run');
    expect((await submit(app, 'dogleg', { trackVersion: 1, moves: BEST.dogleg })).statusCode).toBe(201);
  });

  it('needs a real track, and refuses oversized bodies', async () => {
    expect((await submit(app, 'nope', { trackVersion: 1, moves: [1] })).statusCode).toBe(404);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tracks/dogleg/runs',
      headers: { 'content-type': 'application/json', cookie: (await newPlayer(app)).cookie },
      payload: JSON.stringify({ trackVersion: 1, moves: BEST.dogleg, pad: 'x'.repeat(20_000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('refuses submissions from another origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tracks/dogleg/runs',
      headers: { origin: 'https://evil.example', host: 'localhost', cookie: (await newPlayer(app)).cookie },
      payload: { trackVersion: 1, moves: BEST.dogleg },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('leaderboard', () => {
  it('shows each racer once with their best run; ties to the earlier run', async () => {
    const { app } = await testApp();
    const rename = (cookie: string, displayName: string) =>
      app.inject({ method: 'PATCH', url: '/api/player', headers: { cookie }, payload: { displayName } });
    const [slow, fast, tie] = [await newPlayer(app), await newPlayer(app), await newPlayer(app)];
    await rename(slow.cookie, 'slow');
    await rename(fast.cookie, 'fast');
    await rename(tie.cookie, 'Tie');
    const slower = [4, ...BEST.dogleg]; // coast once first: 9 turns
    await liveRun(app, 'dogleg', slower, slow.cookie);
    await liveRun(app, 'dogleg', slower, fast.cookie);
    await liveRun(app, 'dogleg', BEST.dogleg, fast.cookie);
    await liveRun(app, 'dogleg', BEST.dogleg, tie.cookie);

    const board = (await app.inject({ url: '/api/tracks/dogleg/leaderboard', headers: { cookie: tie.cookie } })).json();
    expect(board.track).toEqual({ slug: 'dogleg', version: 1, par: 8 });
    expect(
      board.entries.map((e: { rank: number; playerName: string; score: number; isMe: boolean }) => [
        e.rank,
        e.playerName,
        e.score,
        e.isMe,
      ]),
    ).toEqual([
      [1, 'fast', 8, false],
      [2, 'Tie', 8, true],
      [3, 'slow', 9, false],
    ]);
    expect(board.me).toEqual({ rank: 2, score: 8 });
    // Other racers' moves are never exposed.
    expect(JSON.stringify(board)).not.toMatch(/moves|runId|playerId/);

    expect((await app.inject({ url: '/api/tracks/dogleg/leaderboard?limit=1' })).json().entries).toHaveLength(1);
    expect((await app.inject({ url: '/api/tracks/dogleg/leaderboard?limit=abc' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/runs/1' })).statusCode).toBe(404);
  });
});

describe('submission rate limits', async () => {
  const { app: strict } = await testApp({ runsPerMinutePerPlayer: 2 });

  it('limits run submissions per racer', async () => {
    const p = await newPlayer(strict);
    const codes = [];
    for (const extra of [[4], [4, 4], [4, 4, 4]]) {
      codes.push(
        (await submit(strict, 'dogleg', { trackVersion: 1, moves: [...extra, ...BEST.dogleg] }, p.cookie)).statusCode,
      );
    }
    expect(codes).toEqual([201, 201, 429]);
  });
});
