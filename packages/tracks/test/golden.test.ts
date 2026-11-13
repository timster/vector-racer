import { replay, SIM_VERSION } from '@vector-racer/sim';
import { describe, expect, it } from 'vitest';
import { GOLDEN_CASES, GOLDEN_SIM_VERSION, goldenTrack } from '../src/golden';

describe('golden replay cases', () => {
  it('were recorded against the current sim version', () => {
    expect(GOLDEN_SIM_VERSION).toBe(SIM_VERSION);
  });

  for (const c of GOLDEN_CASES) {
    it(c.name, () => {
      const r = replay(goldenTrack(c), c.moves);
      if (c.expectedScore !== undefined) {
        expect(r).toMatchObject({ valid: true, score: c.expectedScore });
      } else {
        expect(r).toEqual({ valid: false, reason: c.expectedReason });
      }
    });
  }
});
