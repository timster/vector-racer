import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { testApp, connect, liveRun, newPlayer, submit, BEST } from './helpers';

const { app, db } = await testApp();

describe('live runs over a WebSocket (Phase 3)', () => {
  it('refuses a connection without a racer, or from another site (before upgrading)', async () => {
    // A real socket: the in-process WebSocket injector cannot observe a refused upgrade.
    const { app } = await testApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const status = (headers: Record<string, string>) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        ws.on('open', () => resolve('open'));
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      });
    const p = await newPlayer(app);
    expect(await status({})).toBe(401);
    expect(await status({ cookie: p.cookie, origin: 'https://evil.example' })).toBe(403);
    expect(await status({ cookie: p.cookie, origin: `http://127.0.0.1:${port}` })).toBe('open');
  });

  it('races a full run move by move, and the finished run is ranked', async () => {
    const p = await newPlayer(app);
    const live = await connect(app, p.cookie);
    let reply = await live.request({ type: 'start_run', trackSlug: 'dogleg', trackVersion: 1 });
    expect(reply).toMatchObject({ type: 'run_started', track: { slug: 'dogleg', version: 1 }, moves: [] });
    const nonces = new Set<unknown>();
    for (const [i, move] of BEST.dogleg.entries()) {
      nonces.add(reply.nonce);
      reply = await live.request({ type: 'move', move, nonce: reply.nonce });
      if (i < BEST.dogleg.length - 1) expect(reply).toMatchObject({ type: 'state', turn: i + 1, crashed: false });
    }
    expect(nonces.size).toBe(BEST.dogleg.length); // a fresh nonce for every move
    expect(reply).toMatchObject({ type: 'finished', score: 8, par: 8, best: { rank: 1, score: 8 }, isBest: true });

    const board = (await app.inject({ url: '/api/tracks/dogleg/leaderboard', headers: { cookie: p.cookie } })).json();
    expect(board.entries[0]).toMatchObject({ playerName: p.displayName, score: 8, isMe: true });
    const stored = await db.query('SELECT source, moves FROM runs WHERE player_id = $1', [p.id]);
    expect(stored.rows).toEqual([{ source: 'live', moves: BEST.dogleg }]);
    expect((await db.query('SELECT count(*) FROM live_runs WHERE player_id = $1', [p.id])).rows[0].count).toBe(0);
    live.close();
  });

  it('accepts the same line raced twice, and closes the live run both times', async () => {
    const p = await newPlayer(app);
    for (let i = 0; i < 2; i++) {
      expect(await liveRun(app, 'dogleg', BEST.dogleg, p.cookie)).toMatchObject({ type: 'finished', score: 8 });
      expect((await db.query('SELECT count(*) FROM live_runs WHERE player_id = $1', [p.id])).rows[0].count).toBe(0);
    }
    expect((await db.query('SELECT count(*) FROM runs WHERE player_id = $1', [p.id])).rows[0].count).toBe(2);
  });

  it('rejects a wrong, reused or missing nonce, and bad moves, without ending the run', async () => {
    const live = await connect(app, (await newPlayer(app)).cookie);
    const started = await live.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 1 });
    expect(await live.request({ type: 'move', move: 5, nonce: 'made-up' })).toMatchObject({ code: 'bad_nonce' });
    expect(await live.request({ type: 'move', move: 5 })).toMatchObject({ code: 'bad_nonce' });
    for (const move of [9, -1, 1.5, '5', null]) {
      expect(await live.request({ type: 'move', move, nonce: started.nonce })).toMatchObject({ code: 'invalid_move' });
    }
    const first = await live.request({ type: 'move', move: 5, nonce: started.nonce });
    expect(first.type).toBe('state');
    // The first nonce was used up: replaying it is refused.
    expect(await live.request({ type: 'move', move: 5, nonce: started.nonce })).toMatchObject({ code: 'bad_nonce' });
    expect((await live.request({ type: 'move', move: 5, nonce: first.nonce })).type).toBe('state');
    live.close();
  });

  it("refuses another racer's nonce", async () => {
    const a = await connect(app, (await newPlayer(app)).cookie);
    const b = await connect(app, (await newPlayer(app)).cookie);
    const aStart = await a.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 1 });
    await b.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 1 });
    expect(await b.request({ type: 'move', move: 5, nonce: aStart.nonce })).toMatchObject({ code: 'bad_nonce' });
    a.close();
    b.close();
  });

  it('carries on after the socket drops (or the browser closes), picking up the same run', async () => {
    const p = await newPlayer(app);
    const first = await connect(app, p.cookie);
    let reply = await first.request({ type: 'start_run', trackSlug: 'dogleg', trackVersion: 1 });
    for (const move of BEST.dogleg.slice(0, 4)) reply = await first.request({ type: 'move', move, nonce: reply.nonce });
    first.close();

    const again = await connect(app, p.cookie);
    const resumed = await again.request({ type: 'resume' });
    expect(resumed).toMatchObject({ type: 'run_resumed', moves: BEST.dogleg.slice(0, 4) });
    expect(resumed.nonce).not.toBe(reply.nonce); // the old connection's nonce no longer works
    reply = resumed;
    for (const move of BEST.dogleg.slice(4)) reply = await again.request({ type: 'move', move, nonce: reply.nonce });
    expect(reply).toMatchObject({ type: 'finished', score: 8 });
    expect(await again.request({ type: 'resume' })).toEqual({ type: 'no_run' });
    again.close();
  });

  it('survives a server restart: the open run is in the database, not in memory', async () => {
    const { app, db } = await testApp();
    const p = await newPlayer(app);
    const live = await connect(app, p.cookie);
    let reply = await live.request({ type: 'start_run', trackSlug: 'dogleg', trackVersion: 1 });
    for (const move of BEST.dogleg.slice(0, 5)) reply = await live.request({ type: 'move', move, nonce: reply.nonce });
    live.close();

    // A brand-new server process on the same database.
    const { buildApp } = await import('../src/app');
    const restarted = await buildApp(app.config, db);
    await restarted.ready();
    const back = await connect(restarted, p.cookie);
    reply = await back.request({ type: 'resume' });
    expect(reply).toMatchObject({ type: 'run_resumed', moves: BEST.dogleg.slice(0, 5) });
    for (const move of BEST.dogleg.slice(5)) reply = await back.request({ type: 'move', move, nonce: reply.nonce });
    expect(reply).toMatchObject({ type: 'finished', score: 8 });
    back.close();
    await restarted.close();
  });

  it('keeps one run per racer: starting a new one ends the old one and tells the other tab', async () => {
    const p = await newPlayer(app);
    const tab1 = await connect(app, p.cookie);
    const tab2 = await connect(app, p.cookie);
    const old = await tab1.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 1 });
    await tab2.request({ type: 'start_run', trackSlug: 'dogleg', trackVersion: 1 });
    expect(await tab1.next()).toMatchObject({ type: 'error', code: 'run_replaced' });
    expect(await tab1.request({ type: 'move', move: 5, nonce: old.nonce })).toMatchObject({ code: 'bad_nonce' });
    const open = await db.query(
      'SELECT t.slug FROM live_runs l JOIN tracks t ON t.id = l.track_id WHERE l.player_id = $1',
      [p.id],
    );
    expect(open.rows).toEqual([{ slug: 'dogleg' }]);
    tab1.close();
    tab2.close();
  });

  it('rejects unknown tracks, stale versions and malformed messages', async () => {
    const live = await connect(app, (await newPlayer(app)).cookie);
    expect(await live.request({ type: 'start_run', trackSlug: 'nope', trackVersion: 1 })).toMatchObject({
      code: 'unknown_track',
    });
    expect(await live.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 2 })).toMatchObject({
      code: 'stale_track_version',
      currentVersion: 1,
    });
    expect(await live.request({ type: 'move', move: 5, nonce: 'x' })).toMatchObject({ code: 'no_run' });
    expect(await live.request({ type: 'teleport' })).toMatchObject({ code: 'bad_message' });
    live.ws.send('not json');
    expect(await live.next()).toMatchObject({ code: 'bad_message' });
    live.close();
  });

  it('closes sockets that send oversized messages or flood', async () => {
    const big = await connect(app, (await newPlayer(app)).cookie);
    big.ws.send('x'.repeat(2000));
    expect((await big.closed).code).toBe(1009);

    const { app: strict } = await testApp({ liveMessagesPerSecond: 5 });
    const flood = await connect(strict, (await newPlayer(strict)).cookie);
    for (let i = 0; i < 10; i++) flood.send({ type: 'resume' });
    expect((await flood.closed).code).toBe(1008);
  });

  it('ranks only live runs: a whole move list posted at the end is stored but never ranked', async () => {
    const { app } = await testApp();
    const p = await newPlayer(app);
    const posted = await submit(app, 'oval', { trackVersion: 1, moves: BEST.oval }, p.cookie);
    expect(posted.json()).toMatchObject({ score: 25, best: null, isBest: false });
    expect((await app.inject({ url: '/api/tracks/oval/leaderboard' })).json().entries).toEqual([]);
    expect(await liveRun(app, 'oval', BEST.oval, p.cookie)).toMatchObject({ type: 'finished', score: 25 });
    expect((await app.inject({ url: '/api/tracks/oval/leaderboard' })).json().entries).toHaveLength(1);
  });
});

describe('live start rate limit', async () => {
  const { app: strict } = await testApp({ liveStartsPerMinute: 2 });

  it('limits run starts per racer', async () => {
    const live = await connect(strict, (await newPlayer(strict)).cookie);
    const replies = [];
    for (let i = 0; i < 3; i++)
      replies.push((await live.request({ type: 'start_run', trackSlug: 'oval', trackVersion: 1 })).type);
    expect(replies).toEqual(['run_started', 'run_started', 'error']);
    live.close();
  });
});
