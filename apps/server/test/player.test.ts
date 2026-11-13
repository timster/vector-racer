import { describe, expect, it } from 'vitest';
import { BEST, newPlayer, submit, testApp } from './helpers';

const { app } = await testApp();

describe('players', () => {
  it('creates a racer with a default name and a strict, HttpOnly cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/player' });
    expect(res.statusCode).toBe(201);
    expect(res.json().displayName).toMatch(/^Racer-[2-9A-Z]{4}$/);
    const cookie = res.cookies.find((c) => c.name === 'vr_player')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns the same racer for a browser that already has one', async () => {
    const p = await newPlayer(app);
    const again = await app.inject({ method: 'POST', url: '/api/player', headers: { cookie: p.cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: p.id, displayName: p.displayName });
    expect((await app.inject({ url: '/api/player', headers: { cookie: p.cookie } })).json().id).toBe(p.id);
    expect((await app.inject({ url: '/api/player', headers: { cookie: 'vr_player=forged' } })).statusCode).toBe(401);
  });

  it('renames, and the new name shows on all of the racer’s runs', async () => {
    const { app } = await testApp();
    const p = await newPlayer(app);
    await submit(app, 'dogleg', { trackVersion: 1, moves: BEST.dogleg }, p.cookie);
    await submit(app, 'oval', { trackVersion: 1, moves: BEST.oval }, p.cookie);

    const rename = (displayName: unknown) =>
      app.inject({ method: 'PATCH', url: '/api/player', headers: { cookie: p.cookie }, payload: { displayName } });
    expect((await rename('  Lap   King ')).json().displayName).toBe('Lap King');
    for (const slug of ['dogleg', 'oval']) {
      const board = (
        await app.inject({ url: `/api/tracks/${slug}/leaderboard`, headers: { cookie: p.cookie } })
      ).json();
      expect(board.entries[0]).toMatchObject({ playerName: 'Lap King', isMe: true });
    }

    for (const bad of ['', '   ', 'x'.repeat(17), '<b>hi</b>', 'semi;colon', 'émoji']) {
      expect((await rename(bad)).json().error).toBe('invalid_name');
    }
    expect((await rename(42)).statusCode).toBe(400);
  });

  it('allows two racers to share a name (arcade style)', async () => {
    const a = await newPlayer(app);
    const b = await newPlayer(app);
    for (const p of [a, b]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/player',
        headers: { cookie: p.cookie },
        payload: { displayName: 'TIM' },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('player rate limits', async () => {
  const { app: strict } = await testApp({ playersPerHour: 2 });

  it('limits new racers per IP', async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await strict.inject({ method: 'POST', url: '/api/player' })).statusCode);
    expect(codes).toEqual([201, 201, 429]);
  });
});
