import { SIM_VERSION } from '@vector-racer/sim';
import { parseMap } from '@vector-racer/tracks';
import { GOLDEN_CASES, GOLDEN_SIM_VERSION } from '@vector-racer/tracks/golden';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrations';
import { syncBuiltinTracks } from '../src/tracks';
import { BEST, submit, testApp } from './helpers';

const { app, db } = await testApp();

describe('tracks', () => {
  it('lists the built-in tracks from the database with par', async () => {
    const list = (await app.inject({ url: '/api/tracks' })).json();
    expect(list.map((t: { slug: string; version: number; par: number }) => [t.slug, t.version, t.par])).toEqual([
      ['dogleg', 1, 8],
      ['bend', 1, 14],
      ['oval', 1, 25],
      ['figure8', 1, 38],
      ['hairpin', 1, 44],
      ['street', 1, 44],
    ]);
    expect(parseMap(list[0].map).width).toBe(30);
    expect((await app.inject({ url: '/api/tracks/nope' })).statusCode).toBe(404);
  });

  it('serves whatever the database holds, so a new version replaces the old one', async () => {
    const { app, db } = await testApp();
    await db.query(
      `INSERT INTO tracks (slug, version, name, rules_version, grid, max_turns, par)
       VALUES ('dogleg', 2, 'Dogleg', 'v1', $1, 500, 1)`,
      [{ rows: ['S.F'] }],
    );
    expect((await app.inject({ url: '/api/tracks/dogleg' })).json()).toMatchObject({ version: 2, map: 'S.F' });
    const old = await submit(app, 'dogleg', { trackVersion: 1, moves: [5, 4, 8, 8, 8, 1, 2, 2] });
    expect(old.json()).toMatchObject({ error: 'stale_track_version', currentVersion: 2 });
    expect((await submit(app, 'dogleg', { trackVersion: 2, moves: [5, 5] })).json().score).toBe(2);
  });

  it('migrations and track sync are idempotent; a changed map stops startup in production', async () => {
    expect(await migrate(db)).toEqual([]);
    expect(await syncBuiltinTracks(db)).toEqual([]);
    await expect(syncBuiltinTracks(db, [{ slug: 'oval', name: 'Oval', version: 1, map: 'S.F' }])).rejects.toThrow(
      /bump its version/,
    );
  });

  it('before launch, a changed map replaces the stored one and clears that track’s runs', async () => {
    const { app, db } = await testApp();
    await submit(app, 'dogleg', { trackVersion: 1, moves: [5, 4, 8, 8, 8, 1, 2, 2] });
    await submit(app, 'oval', { trackVersion: 1, moves: BEST.oval });

    const changes = await syncBuiltinTracks(db, [{ slug: 'dogleg', name: 'Dogleg', version: 1, map: 'S..F' }], {
      replaceChanged: true,
    });
    expect(changes).toEqual(['dogleg v1 map replaced, its runs deleted']);
    expect((await app.inject({ url: '/api/tracks/dogleg' })).json()).toMatchObject({ version: 1, map: 'S..F', par: 2 });
    const runs = await db.query<{ slug: string }>('SELECT t.slug FROM runs r JOIN tracks t ON t.id = r.track_id');
    expect(runs.rows.map((r) => r.slug)).toEqual(['oval']);
  });
});

describe('golden replay cases through the API', () => {
  it('were recorded against the current sim version', () => {
    expect(GOLDEN_SIM_VERSION).toBe(SIM_VERSION);
  });

  for (const [i, c] of GOLDEN_CASES.entries()) {
    it(c.name, async () => {
      let slug = c.slug!;
      let version = c.trackVersion!;
      if (c.map !== undefined) {
        // Inline cases become real tracks in this test database.
        slug = `golden-${i}`;
        version = 1;
        await db.query(
          `INSERT INTO tracks (slug, version, name, rules_version, grid, max_turns)
           VALUES ($1, 1, $1, 'v1', $2, $3)`,
          [slug, { rows: c.map.split('\n') }, c.maxTurns ?? 500],
        );
      }
      const res = await submit(app, slug, { trackVersion: version, moves: c.moves });
      if (c.expectedScore !== undefined) {
        expect(res.statusCode).toBe(201);
        expect(res.json().score).toBe(c.expectedScore);
      } else {
        expect(res.statusCode).toBe(422);
        expect(res.json().reason).toBe(c.expectedReason);
      }
    });
  }
});
