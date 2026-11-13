import type { MoveIndex } from '@vector-racer/sim';
import { BUILTIN_TRACKS, parseTrack, shortestRun, type ParsedTrack } from '@vector-racer/tracks';
import { Game, type Candidate } from './game';
import { loadSprites, Renderer, type Ghost, type Motion } from './render';

const MOVE_MS = 160;
/** Time per turn when watching the best lap. */
const WATCH_MS = 220;

// Numpad layout and QWE/ASD/ZXC both map to the 3x3 acceleration grid (y down).
const KEY_TO_MOVE: Record<string, MoveIndex> = {
  Numpad7: 0,
  Numpad8: 1,
  Numpad9: 2,
  Numpad4: 3,
  Numpad5: 4,
  Numpad6: 5,
  Numpad1: 6,
  Numpad2: 7,
  Numpad3: 8,
  KeyQ: 0,
  KeyW: 1,
  KeyE: 2,
  KeyA: 3,
  KeyS: 4,
  KeyD: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board');
const select = $<HTMLSelectElement>('track-select');
const toast = $<HTMLParagraphElement>('toast');
const finishPanel = $<HTMLElement>('finish');

const renderer = new Renderer(canvas, await loadSprites());
let game: Game;
let hover: Candidate | undefined;
let motion: Motion | undefined;
let toastTimer: number | undefined;

// Best line: computed in the browser with the same search the tests use, cached per track version.
const bestRuns = new Map<string, Game>();
let best: Game | undefined;
let showBest = false;
let watch: { index: number; motion?: Motion } | undefined;
let watchFrame = 0;

for (const def of BUILTIN_TRACKS) select.add(new Option(def.name, def.slug));

function loadTrack(slug: string): void {
  const def = BUILTIN_TRACKS.find((t) => t.slug === slug) ?? BUILTIN_TRACKS[0]!;
  select.value = def.slug;
  if (location.hash !== `#${def.slug}`) history.replaceState(null, '', `#${def.slug}`);
  game = new Game(parseTrack(def));
  renderer.setTrack(game.track.track);
  best = undefined;
  reset();
  // Let the board paint first; the search takes a moment on bigger tracks.
  const track = game.track;
  window.setTimeout(() => {
    if (game.track !== track) return;
    best = bestFor(track);
    update();
  }, 0);
}

function bestFor(track: ParsedTrack): Game | undefined {
  const key = `${track.slug}@${track.version}`;
  if (!bestRuns.has(key)) {
    const moves = shortestRun(track.track);
    if (!moves) return undefined;
    bestRuns.set(key, Game.fromMoves(track, moves));
  }
  return bestRuns.get(key);
}

function reset(): void {
  stopWatching();
  hover = undefined;
  motion = undefined;
  finishPanel.hidden = true;
  showToast('');
  update();
}

function restart(): void {
  game = new Game(game.track);
  reset();
}

function play(move: MoveIndex): void {
  if (motion || game.state.finished) return;
  stopWatching();
  const from = game.state;
  const r = game.play(move);
  if (!r.ok) return;
  hover = undefined;
  animate({ x: from.x, y: from.y }, { x: r.state.x, y: r.state.y });
  if (r.crashed) showToast('Hit the wall: speed reset, +3 turns.', true);
  else if (r.state.nextCheckpoint > from.nextCheckpoint && !r.state.finished) {
    showToast(`Checkpoint ${r.state.nextCheckpoint - 1} of ${game.track.track.checkpointCount}`);
  }
  update();
}

function undo(): void {
  if (motion || !game.undo()) return;
  stopWatching();
  finishPanel.hidden = true;
  showToast('');
  update();
}

function animate(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const start = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, Math.max(0, now - start) / MOVE_MS);
    motion = t < 1 ? { from, to, t: 1 - (1 - t) * (1 - t) } : undefined;
    draw();
    if (motion) requestAnimationFrame(frame);
    else if (game.state.finished) showFinish();
  };
  requestAnimationFrame(frame);
}

function update(): void {
  const s = game.state;
  const cps = game.track.track.checkpointCount;
  $('stat-turn').textContent = String(s.turn);
  $('stat-speed').textContent = `${s.vx}, ${s.vy}`;
  $('stat-cp').textContent = `${Math.min(s.nextCheckpoint - 1, cps)} / ${cps}`;
  $('stat-best').textContent = best ? String(best.state.turn) : '…';
  $<HTMLButtonElement>('btn-undo').disabled = game.moves.length === 0;
  $('btn-best').setAttribute('aria-pressed', String(showBest));
  $<HTMLButtonElement>('btn-best').disabled = !best;
  $<HTMLButtonElement>('btn-watch').disabled = !best;
  $('btn-watch').textContent = watch ? 'Stop' : 'Watch best';
  draw();
}

function draw(): void {
  renderer.draw(game, hover, motion, ghostView());
}

/** Watching plays the best lap on its own; otherwise the ghost keeps pace with the player's turn count. */
function ghostView(): Ghost | undefined {
  if (!best) return undefined;
  if (watch) return { run: best, ...watch };
  if (!showBest) return undefined;
  const index = best.indexAtTurn(game.state.turn);
  const prevState = game.states[game.states.length - 2];
  if (motion && prevState) {
    const prev = best.indexAtTurn(prevState.turn);
    if (prev !== index) {
      return { run: best, index, motion: { from: best.states[prev]!, to: best.states[index]!, t: motion.t } };
    }
  }
  return { run: best, index };
}

function toggleBest(): void {
  if (!best) return;
  showBest = !showBest;
  update();
}

function toggleWatch(): void {
  if (watch) {
    stopWatching();
    update();
    return;
  }
  const run = best;
  if (!run) return;
  const last = run.states.length - 1;
  const start = performance.now();
  const frame = (now: number) => {
    // rAF timestamps can be a little earlier than the performance.now() taken when scheduling.
    const f = Math.max(0, now - start) / WATCH_MS;
    const step = Math.floor(f);
    if (step >= last + 3) {
      // Held on the finish for a moment; hand back to the normal view.
      stopWatching();
      update();
      return;
    }
    if (step >= last) {
      watch = { index: last };
    } else {
      const t = f - step;
      watch = {
        index: step + 1,
        motion: { from: run.states[step]!, to: run.states[step + 1]!, t: 1 - (1 - t) * (1 - t) },
      };
    }
    draw();
    watchFrame = requestAnimationFrame(frame);
  };
  watch = { index: 0 };
  update();
  watchFrame = requestAnimationFrame(frame);
}

function stopWatching(): void {
  cancelAnimationFrame(watchFrame);
  watch = undefined;
}

function showFinish(): void {
  const crashes = game.crashed.filter(Boolean).length;
  $('finish-turns').textContent = String(game.state.turn);
  const par = best ? ` · best possible ${best.state.turn}` : '';
  $('finish-detail').textContent = `${game.track.name} · ${crashes} wall ${crashes === 1 ? 'hit' : 'hits'}${par}`;
  finishPanel.hidden = false;
}

function showToast(text: string, crash = false): void {
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = !text;
  toast.classList.toggle('crash', crash);
  if (text) toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
}

async function copyRun(): Promise<void> {
  try {
    await navigator.clipboard.writeText(game.exportRun());
    showToast('Run copied as JSON');
  } catch {
    showToast('Could not copy to clipboard');
  }
}

function pointer(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointermove', (e) => {
  if (motion) return;
  const p = pointer(e);
  const next = renderer.candidateAt(game.candidates(), p.x, p.y);
  if (next?.move !== hover?.move) {
    hover = next;
    canvas.style.cursor = hover ? 'pointer' : 'default';
    draw();
  }
});

canvas.addEventListener('pointerleave', () => {
  hover = undefined;
  draw();
});

canvas.addEventListener('click', (e) => {
  const p = pointer(e as PointerEvent);
  const c = renderer.candidateAt(game.candidates(), p.x, p.y);
  if (c) play(c.move);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.metaKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault();
      undo();
    }
    return;
  }
  const move = KEY_TO_MOVE[e.code];
  if (move !== undefined && !e.ctrlKey) {
    e.preventDefault();
    play(move);
  } else if (e.code === 'Backspace' || (e.ctrlKey && e.code === 'KeyZ')) {
    e.preventDefault();
    undo();
  } else if (e.code === 'KeyR' && !e.ctrlKey) {
    restart();
  } else if (e.code === 'KeyB' && !e.ctrlKey) {
    toggleBest();
  } else if (e.code === 'KeyG' && !e.ctrlKey) {
    toggleWatch();
  }
});

select.addEventListener('change', () => {
  loadTrack(select.value);
  select.blur();
});
window.addEventListener('hashchange', () => loadTrack(location.hash.slice(1)));
window.addEventListener('resize', () => {
  renderer.resize();
  draw();
});

$('btn-best').addEventListener('click', toggleBest);
$('btn-watch').addEventListener('click', toggleWatch);
$('btn-undo').addEventListener('click', undo);
$('btn-restart').addEventListener('click', restart);
$('btn-copy').addEventListener('click', copyRun);
$('finish-copy').addEventListener('click', copyRun);
$('finish-restart').addEventListener('click', restart);

loadTrack(location.hash.slice(1));
