import type { Point } from './track';

/**
 * The cells a move enters, in order, grouped by grid step. Each group ends with the
 * cell on the main path. When the segment passes exactly through a cell corner, the
 * group is [sideA, sideB, diagonal]: both cells that share that corner count as touched,
 * so a car cannot squeeze diagonally between two walls that meet at a corner.
 *
 * This is a supercover line walk in pure integer arithmetic. The set of touched cells is
 * the same in both directions (A to B and B to A), unlike plain Bresenham.
 */
export function trace(x0: number, y0: number, x1: number, y1: number): Point[][] {
  const nx = Math.abs(x1 - x0);
  const ny = Math.abs(y1 - y0);
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  const groups: Point[][] = [];
  let x = x0;
  let y = y0;
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    // Compare where the segment next crosses a vertical vs a horizontal cell boundary.
    // Cells are unit squares centred on integer points, so boundaries sit at half steps.
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      groups.push([
        { x: x + sx, y },
        { x, y: y + sy },
        { x: x + sx, y: y + sy },
      ]);
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (decision < 0) {
      x += sx;
      ix++;
      groups.push([{ x, y }]);
    } else {
      y += sy;
      iy++;
      groups.push([{ x, y }]);
    }
  }
  return groups;
}
