import { replay } from '@vector-racer/sim';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TRACKS, getBuiltinTrack, parseMap, parseTrack, shortestRun, validateTrack } from '../src';

describe('parseMap', () => {
  it('parses a small map and ignores surrounding blank lines', () => {
    const t = parseMap('\n#####\n#S1F#\n#####\n', 40);
    expect(t.width).toBe(5);
    expect(t.height).toBe(3);
    expect(t.start).toEqual({ x: 1, y: 1 });
    expect(t.checkpointCount).toBe(1);
    expect(t.maxTurns).toBe(40);
  });

  it('rejects ragged rows, unknown characters and bad start counts', () => {
    expect(() => parseMap('S.F\n..')).toThrow(/width/);
    expect(() => parseMap('S.x')).toThrow(/unknown character/);
    expect(() => parseMap('..F')).toThrow(/no start/);
    expect(() => parseMap('S.S.F')).toThrow(/more than one start/);
  });
});

describe('validateTrack', () => {
  it('accepts a simple valid track', () => {
    expect(validateTrack(parseMap('S.1.F'))).toEqual([]);
  });

  it('reports missing finish, checkpoint gaps and unreachable targets', () => {
    expect(validateTrack(parseMap('S...'))).toContain('track has no finish cells');
    expect(validateTrack(parseMap('S.2.F'))).toEqual(['checkpoints must be numbered 1..2 with no gaps; 1 is missing']);
    expect(validateTrack(parseMap('S#F'))).toEqual(['finish is unreachable']);
    expect(validateTrack(parseMap('S.F#1'))).toEqual(['checkpoint 1 is unreachable']);
  });
});

describe('built-in tracks', () => {
  it('have unique slugs and get bigger', () => {
    const slugs = BUILTIN_TRACKS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const areas = BUILTIN_TRACKS.map((d) => {
      const t = parseTrack(d).track;
      return t.width * t.height;
    });
    expect([...areas].sort((a, b) => a - b)).toEqual(areas);
    expect(BUILTIN_TRACKS).toHaveLength(3);
  });

  for (const def of BUILTIN_TRACKS) {
    it(`${def.slug} is valid and can be finished in the sim`, () => {
      const { track } = parseTrack(def);
      expect(validateTrack(track)).toEqual([]);
      const moves = shortestRun(track);
      expect(moves).toBeDefined();
      const r = replay(track, moves);
      expect(r.valid).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(moves!.length);
    });
  }

  it('shortestRun finds the known optimum for each track', () => {
    const best = Object.fromEntries(
      BUILTIN_TRACKS.map((d) => {
        const { track } = parseTrack(d);
        return [d.slug, replay(track, shortestRun(track)).score];
      }),
    );
    expect(best).toEqual({ dogleg: 8, oval: 25, circuit: 44 });
  });

  it('getBuiltinTrack looks up by slug', () => {
    expect(getBuiltinTrack('oval')?.name).toBe('Oval');
    expect(getBuiltinTrack('nope')).toBeUndefined();
  });
});
