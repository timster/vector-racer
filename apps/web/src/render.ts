import { cellAt, checkpointNumber, FINISH, WALL, type Point, type Track } from '@vector-racer/sim';
import type { Candidate, Game } from './game';

// All colours in one place so a re-skin is a one-file change.
const THEME = {
  bg: '#14171c',
  grid: 'rgba(30, 50, 60, 0.12)',
  curbA: '#e5484d',
  curbB: '#f4f4f4',
  checkpointNext: 'rgba(245, 197, 66, 0.55)',
  checkpointLater: 'rgba(245, 197, 66, 0.16)',
  checkpointDone: 'rgba(70, 200, 120, 0.22)',
  label: '#1d2128',
  trail: '#ff6a3d',
  crash: '#e5484d',
  dotOk: '#ffffff',
  dotFinish: '#f5c542',
  dotEdge: 'rgba(20, 23, 28, 0.85)',
  ghost: 'rgba(74, 163, 255, 0.75)',
};

/** Grass tile covers this many cells, so the texture stays readable on small grids. */
const TEXTURE_CELLS = 4;
const PAD = 16;

export interface Sprites {
  grass: HTMLImageElement;
  asphalt: HTMLImageElement;
  car: HTMLImageElement;
  ghost: HTMLImageElement;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

export async function loadSprites(): Promise<Sprites> {
  const [grass, asphalt, car, ghost] = await Promise.all([
    loadImage('/assets/kenney/grass.png'),
    loadImage('/assets/kenney/asphalt.png'),
    loadImage('/assets/kenney/car_red.png'),
    loadImage('/assets/kenney/car_blue.png'),
  ]);
  return { grass, asphalt, car, ghost };
}

/** In-flight car movement between two turns, in grid coordinates. */
/** The best line, drawn behind the player with a ghost car at `index`. */
export interface Ghost {
  run: Game;
  index: number;
  /** Set while the ghost is moving between `index - 1` and `index`. */
  motion?: Motion;
}

export interface Motion {
  from: Point;
  to: Point;
  /** 0..1 */
  t: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly layer = document.createElement('canvas');
  private track: Track | undefined;
  private initialHeading = 0;
  private cpLabels = new Map<number, Point>();
  private dpr = 1;
  cell = 10;
  private ox = 0;
  private oy = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sprites: Sprites,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  setTrack(track: Track): void {
    this.track = track;
    this.initialHeading = startHeading(track);
    // Label each checkpoint line at the cell nearest its centre.
    const sums = new Map<number, { x: number; y: number; n: number; cells: Point[] }>();
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++) {
        const n = checkpointNumber(cellAt(track, x, y));
        if (!n) continue;
        const s = sums.get(n) ?? { x: 0, y: 0, n: 0, cells: [] };
        s.x += x;
        s.y += y;
        s.n++;
        s.cells.push({ x, y });
        sums.set(n, s);
      }
    this.cpLabels = new Map(
      [...sums].map(([n, s]) => {
        const cx = s.x / s.n;
        const cy = s.y / s.n;
        const best = s.cells.reduce((a, b) =>
          Math.hypot(b.x - cx, b.y - cy) < Math.hypot(a.x - cx, a.y - cy) ? b : a,
        );
        return [n, best];
      }),
    );
    this.resize();
  }

  resize(): void {
    const track = this.track;
    if (!track) return;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.cell = Math.max(
      4,
      Math.floor(Math.min((rect.width - 2 * PAD) / track.width, (rect.height - 2 * PAD) / track.height)),
    );
    this.ox = Math.floor((rect.width - this.cell * track.width) / 2);
    this.oy = Math.floor((rect.height - this.cell * track.height) / 2);
    this.buildLayer(rect.width, rect.height);
  }

  /** Centre of a grid cell in CSS pixels. */
  toPx(p: Point): Point {
    return { x: this.ox + (p.x + 0.5) * this.cell, y: this.oy + (p.y + 0.5) * this.cell };
  }

  candidateAt(candidates: Candidate[], px: number, py: number): Candidate | undefined {
    let best: Candidate | undefined;
    let bestD = this.cell * 0.6;
    for (const c of candidates) {
      const p = this.toPx(c.dot);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  // Static track art: drawn once per resize into an offscreen canvas.
  private buildLayer(cssW: number, cssH: number): void {
    const track = this.track!;
    const { cell, ox, oy } = this;
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    const g = this.layer.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = THEME.bg;
    g.fillRect(0, 0, cssW, cssH);

    const scale = (cell * TEXTURE_CELLS) / this.sprites.grass.width;
    const pattern = (img: HTMLImageElement) => {
      const p = g.createPattern(img, 'repeat')!;
      p.setTransform(new DOMMatrix().translate(ox, oy).scale(scale));
      return p;
    };

    g.fillStyle = pattern(this.sprites.grass);
    g.fillRect(ox, oy, cell * track.width, cell * track.height);

    g.fillStyle = pattern(this.sprites.asphalt);
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++)
        if (cellAt(track, x, y) !== WALL) g.fillRect(ox + x * cell, oy + y * cell, cell, cell);

    // Faint grid on the road so players can count cells.
    g.strokeStyle = THEME.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++) {
        if (cellAt(track, x, y) === WALL) continue;
        g.rect(ox + x * cell + 0.5, oy + y * cell + 0.5, cell, cell);
      }
    g.stroke();

    // Finish line: checkered, 2x2 squares per cell.
    const half = cell / 2;
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++) {
        if (cellAt(track, x, y) !== FINISH) continue;
        for (let i = 0; i < 2; i++)
          for (let j = 0; j < 2; j++) {
            g.fillStyle = (x + y + i + j) % 2 ? '#111' : '#f4f4f4';
            g.fillRect(ox + x * cell + i * half, oy + y * cell + j * half, half, half);
          }
      }

    // Red and white curbs wherever road meets wall. Not along the map's outer edge: a road that
    // reaches it reads as running on off the map (it is still a wall to the sim).
    const curb = Math.max(2, Math.round(cell * 0.16));
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < track.width && y < track.height;
    const wallAt = (x: number, y: number) => inside(x, y) && cellAt(track, x, y) === WALL;
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++) {
        if (cellAt(track, x, y) === WALL) continue;
        g.fillStyle = (x + y) % 2 ? THEME.curbA : THEME.curbB;
        const px = ox + x * cell;
        const py = oy + y * cell;
        if (wallAt(x, y - 1)) g.fillRect(px, py, cell, curb);
        if (wallAt(x, y + 1)) g.fillRect(px, py + cell - curb, cell, curb);
        if (wallAt(x - 1, y)) g.fillRect(px, py, curb, cell);
        if (wallAt(x + 1, y)) g.fillRect(px + cell - curb, py, curb, cell);
      }
  }

  draw(game: Game, hover: Candidate | undefined, motion: Motion | undefined, ghost?: Ghost): void {
    const track = this.track;
    if (!track) return;
    const ctx = this.ctx;
    const { cell } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.drawCheckpoints(game.state.nextCheckpoint);
    if (ghost) this.drawGhost(ghost);

    // Trail: one segment per turn, with a dot at each position and a ring where the car stopped on a wall.
    const pts = game.states.map((s) => this.toPx(s));
    const shown = motion ? pts.length - 1 : pts.length;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = THEME.trail;
    ctx.lineWidth = Math.max(1.5, cell * 0.12);
    ctx.beginPath();
    for (let i = 0; i < shown; i++) {
      if (i === 0) ctx.moveTo(pts[i]!.x, pts[i]!.y);
      else ctx.lineTo(pts[i]!.x, pts[i]!.y);
    }
    const car = motion ? lerpPx(this.toPx(motion.from), this.toPx(motion.to), motion.t) : pts[pts.length - 1]!;
    if (motion) ctx.lineTo(car.x, car.y);
    ctx.stroke();
    for (let i = 0; i < shown; i++) {
      dot(ctx, pts[i]!, Math.max(2, cell * 0.14), THEME.trail);
      if (game.crashed[i]) ring(ctx, pts[i]!, cell * 0.42, THEME.crash, Math.max(1.5, cell * 0.1));
    }

    if (!motion) this.drawCandidates(game.candidates(), hover, game.state);
    this.drawCar(this.sprites.car, car, heading(game.states, game.states.length - 1, this.initialHeading));
  }

  private drawGhost({ run, index, motion }: Ghost): void {
    const { ctx, cell } = this;
    const pts = run.states.map((s) => this.toPx(s));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = THEME.ghost;
    ctx.lineWidth = Math.max(1, cell * 0.08);
    ctx.setLineDash([cell * 0.35, cell * 0.2]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach((p, i) => {
      dot(ctx, p, Math.max(1.5, cell * 0.1), THEME.ghost);
      if (run.crashed[i]) ring(ctx, p, cell * 0.38, THEME.ghost, Math.max(1, cell * 0.08));
    });
    const at = motion ? lerpPx(this.toPx(motion.from), this.toPx(motion.to), motion.t) : pts[index]!;
    ctx.save();
    ctx.globalAlpha = 0.8;
    this.drawCar(this.sprites.ghost, at, heading(run.states, index, this.initialHeading));
    ctx.restore();
  }

  private drawCheckpoints(next: number): void {
    const track = this.track!;
    const { ctx, cell, ox, oy } = this;
    for (let y = 0; y < track.height; y++)
      for (let x = 0; x < track.width; x++) {
        const n = checkpointNumber(cellAt(track, x, y));
        if (!n) continue;
        ctx.fillStyle = n < next ? THEME.checkpointDone : n === next ? THEME.checkpointNext : THEME.checkpointLater;
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    const r = Math.max(7, cell * 0.45);
    ctx.font = `700 ${Math.round(r * 1.2)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [n, p] of this.cpLabels) {
      const c = this.toPx(p);
      dot(ctx, c, r, n < next ? '#46c878' : n === next ? '#f5c542' : 'rgba(245, 197, 66, 0.5)');
      ctx.fillStyle = THEME.label;
      ctx.fillText(String(n), c.x, c.y + 1);
    }
  }

  private drawCandidates(candidates: Candidate[], hover: Candidate | undefined, from: Point): void {
    const { ctx, cell } = this;

    // Hovered move: dashed path to the target; for a crash, mark where the car would stop.
    if (hover && hover.result.ok) {
      const stop = this.toPx(hover.result.state);
      const prev = this.toPx(from);
      const aim = this.toPx(hover.dot);
      ctx.lineWidth = Math.max(1.5, cell * 0.1);
      ctx.strokeStyle = hover.result.crashed ? THEME.crash : THEME.dotOk;
      ctx.setLineDash([cell * 0.3, cell * 0.25]);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(aim.x, aim.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hover.result.crashed) {
        ring(ctx, stop, cell * 0.42, THEME.crash, Math.max(1.5, cell * 0.12));
        cross(ctx, aim, cell * 0.3, THEME.crash);
      }
    }

    for (const c of candidates) {
      if (!c.result.ok) continue;
      const p = this.toPx(c.dot);
      const big = c === hover;
      const r = cell * (big ? 0.36 : 0.26);
      if (c.result.crashed) {
        ring(ctx, p, r, THEME.crash, Math.max(1.5, cell * 0.1));
      } else {
        dot(ctx, p, r + Math.max(1, cell * 0.06), THEME.dotEdge);
        dot(ctx, p, r, c.result.state.finished ? THEME.dotFinish : THEME.dotOk);
      }
    }
  }

  private drawCar(img: HTMLImageElement, at: Point, angle: number): void {
    const { ctx, cell } = this;
    const h = Math.max(12, cell * 1.35);
    const w = (h * img.width) / img.height;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(angle + Math.PI / 2); // sprite faces up
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = cell * 0.4;
    ctx.shadowOffsetY = cell * 0.1;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

/** Direction of the most recent movement up to states[upto], or `initial` before the first move. */
function heading(states: readonly Point[], upto: number, initial: number): number {
  for (let i = upto; i > 0; i--) {
    const s = states[i]!;
    const p = states[i - 1]!;
    if (s.x !== p.x || s.y !== p.y) return Math.atan2(s.y - p.y, s.x - p.x);
  }
  return initial;
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

/**
 * Which way the car faces on the grid before it moves: away from the finish line when the start
 * sits just past it (loops), otherwise along the longest open straight from the start.
 */
function startHeading(track: Track): number {
  const { x: sx, y: sy } = track.start;
  let nearest: Point | undefined;
  let nearestD = Infinity;
  for (let y = 0; y < track.height; y++)
    for (let x = 0; x < track.width; x++) {
      const d = Math.abs(x - sx) + Math.abs(y - sy);
      if (cellAt(track, x, y) === FINISH && d < nearestD) {
        nearest = { x, y };
        nearestD = d;
      }
    }
  if (nearest && nearestD <= 3) {
    const dx = sx - nearest.x;
    const dy = sy - nearest.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : Math.PI) : dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  let best = 0;
  let bestRun = -1;
  for (const [dx, dy] of DIRECTIONS) {
    let run = 0;
    while (cellAt(track, sx + dx * (run + 1), sy + dy * (run + 1)) !== WALL) run++;
    if (run > bestRun) {
      bestRun = run;
      best = Math.atan2(dy, dx);
    }
  }
  return best;
}

function lerpPx(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function dot(ctx: CanvasRenderingContext2D, p: Point, r: number, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, p: Point, r: number, stroke: string, width: number): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function cross(ctx: CanvasRenderingContext2D, p: Point, r: number, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1.5, r * 0.4);
  ctx.beginPath();
  ctx.moveTo(p.x - r, p.y - r);
  ctx.lineTo(p.x + r, p.y + r);
  ctx.moveTo(p.x + r, p.y - r);
  ctx.lineTo(p.x - r, p.y + r);
  ctx.stroke();
}
