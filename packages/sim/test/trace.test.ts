import { describe, expect, it } from 'vitest';
import { trace, type Point } from '../src';

const key = (p: Point) => `${p.x},${p.y}`;
const touched = (x0: number, y0: number, x1: number, y1: number) =>
  new Set([`${x0},${y0}`, ...trace(x0, y0, x1, y1).flat().map(key)]);

describe('trace', () => {
  it('returns nothing for a zero-length move', () => {
    expect(trace(3, 4, 3, 4)).toEqual([]);
  });

  it('walks straight lines one cell at a time', () => {
    expect(trace(0, 0, 3, 0)).toEqual([[{ x: 1, y: 0 }], [{ x: 2, y: 0 }], [{ x: 3, y: 0 }]]);
    expect(trace(0, 2, 0, 0)).toEqual([[{ x: 0, y: 1 }], [{ x: 0, y: 0 }]]);
  });

  it('touches both side cells when passing exactly through a corner', () => {
    expect(trace(0, 0, 1, 1)).toEqual([
      [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    ]);
  });

  it('covers every cell a shallow line passes through', () => {
    // Cells are unit squares centred on integer points, so boundaries are at half steps.
    // (0,0) to (4,1) crosses y = 0.5 at x = 2, the middle of column 2: no corner.
    expect([...touched(0, 0, 4, 1)].sort()).toEqual(['0,0', '1,0', '2,0', '2,1', '3,1', '4,1']);
    // (0,0) to (3,1) crosses y = 0.5 at x = 1.5, exactly a corner: all four cells there count.
    expect([...touched(0, 0, 3, 1)].sort()).toEqual(['0,0', '1,0', '1,1', '2,0', '2,1', '3,1']);
  });

  it('is symmetric and 4-connected for many segments', () => {
    for (let x0 = -3; x0 <= 3; x0++)
      for (let y0 = -3; y0 <= 3; y0++)
        for (let x1 = -4; x1 <= 4; x1++)
          for (let y1 = -4; y1 <= 4; y1++) {
            const a = touched(x0, y0, x1, y1);
            const b = touched(x1, y1, x0, y0);
            expect([...a].sort()).toEqual([...b].sort());
            expect(a.has(`${x1},${y1}`)).toBe(true);

            // Every consecutive main-path cell is within one step, and a diagonal step
            // only happens through a corner group (so the touched set is 4-connected).
            let prev = { x: x0, y: y0 };
            for (const g of trace(x0, y0, x1, y1)) {
              const main = g[g.length - 1]!;
              const dx = Math.abs(main.x - prev.x);
              const dy = Math.abs(main.y - prev.y);
              expect(dx + dy === 1 || (dx === 1 && dy === 1 && g.length === 3)).toBe(true);
              prev = main;
            }
          }
  });
});
