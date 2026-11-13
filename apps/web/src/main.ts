import type { MoveIndex } from '@vector-racer/sim';
import { BUILTIN_TRACKS, parseTrack, type ParsedTrack } from '@vector-racer/tracks';
import { api, ApiError, type Player } from './api';
import { Game, type Candidate } from './game';
import { loadSprites, Renderer, type Ghost, type Motion } from './render';

const MOVE_MS = 160;
/** Time per turn when watching the best lap. */
const WATCH_MS = 220;
const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
/** The solver's best line is a testing aid, only in development builds (npm run dev). */
const DEV_TOOLS = import.meta.env.DEV;

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
const boardPanel = $<HTMLElement>('board-panel');
const nameButton = $<HTMLButtonElement>('btn-name');
const nameForm = $<HTMLFormElement>('name-form');
const nameInput = $<HTMLInputElement>('name-input');

const renderer = new Renderer(canvas, await loadSprites());

// Tracks come from the server when it's reachable; otherwise the built-ins, playable offline.
let tracks: ParsedTrack[] = BUILTIN_TRACKS.map(parseTrack);
/** Par per track slug, from the server. */
const pars = new Map<string, number | null>();
let online = false;
let player: Player | null = null;

let game: Game;
let hover: Candidate | undefined;
let motion: Motion | undefined;
let toastTimer: number | undefined;

// Dev only: the best line, computed in the browser with the solver, cached per track version.
const bestRuns = new Map<string, Game>();
let best: Game | undefined;
let showBest = false;
let watch: { index: number; motion?: Motion } | undefined;
let watchFrame = 0;

function loadTrack(slug: string): void {
  const track = tracks.find((t) => t.slug === slug) ?? tracks[0]!;
  select.value = track.slug;
  if (location.hash !== `#${track.slug}`) history.replaceState(null, '', `#${track.slug}`);
  game = new Game(track);
  renderer.setTrack(track.track);
  best = undefined;
  showBest = false;
  reset();
  if (!boardPanel.hidden) void refreshBoard();
}

/** Loads the best line for the current track the first time a dev tool asks for it. */
async function ensureBest(): Promise<Game | undefined> {
  const track = game.track;
  const run = best ?? (await bestFor(track));
  if (game.track !== track) return undefined;
  best = run;
  return run;
}

/**
 * Dev builds only. The solver is loaded on demand, so production bundles never include it
 * (import.meta.env.DEV is false there and this branch is removed at build time).
 */
async function bestFor(track: ParsedTrack): Promise<Game | undefined> {
  const key = `${track.slug}@${track.version}`;
  if (!bestRuns.has(key)) {
    const { shortestRun } = await import('@vector-racer/tracks/solve');
    // Let the board paint first; the search takes a moment on bigger tracks.
    await new Promise((r) => setTimeout(r, 0));
    const moves = shortestRun(track.track);
    if (!moves) return undefined;
    bestRuns.set(key, Game.fromMoves(track, moves));
  }
  return bestRuns.get(key);
}

function par(): number | undefined {
  return pars.get(game.track.slug) ?? best?.state.turn;
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
    else if (game.state.finished) void finish();
  };
  requestAnimationFrame(frame);
}

function update(): void {
  const s = game.state;
  const cps = game.track.track.checkpointCount;
  $('stat-turn').textContent = String(s.turn);
  $('stat-speed').textContent = `${s.vx}, ${s.vy}`;
  $('stat-cp').textContent = `${Math.min(s.nextCheckpoint - 1, cps)} / ${cps}`;
  $('stat-par').textContent = String(par() ?? '–');
  $<HTMLButtonElement>('btn-undo').disabled = game.moves.length === 0;
  for (const el of document.querySelectorAll<HTMLElement>('.dev-only')) el.hidden = !DEV_TOOLS;
  $('btn-best').setAttribute('aria-pressed', String(showBest));
  $('btn-watch').textContent = watch ? 'Stop' : 'Watch best';
  $('btn-board').setAttribute('aria-pressed', String(!boardPanel.hidden));
  nameButton.textContent = player?.displayName ?? (online ? '…' : 'offline');
  nameButton.disabled = !player;
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

async function toggleBest(): Promise<void> {
  if (!(await ensureBest())) return;
  stopWatching();
  showBest = !showBest;
  update();
}

async function toggleWatch(): Promise<void> {
  if (watch) {
    stopWatching();
    update();
    return;
  }
  const run = await ensureBest();
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

// --- Finishing: every finished run is submitted for this browser's racer --------------------

async function finish(): Promise<void> {
  const crashes = game.crashed.filter(Boolean).length;
  const p = par();
  $('finish-turns').textContent = String(game.state.turn);
  $('finish-detail').textContent =
    `${game.track.name} · ${crashes} wall ${crashes === 1 ? 'hit' : 'hits'}` + (p ? ` · par ${p}` : '');
  finishPanel.hidden = false;
  await submitRun(game);
}

function setSubmitStatus(text: string, error = false): void {
  const el = $('finish-submit');
  el.textContent = text;
  el.classList.toggle('error', error);
}

async function submitRun(run: Game): Promise<void> {
  if (!online || !player) {
    setSubmitStatus('Offline: this run was not submitted.', true);
    return;
  }
  setSubmitStatus('Submitting…');
  try {
    const res = await api.submitRun(run.track.slug, run.track.version, run.moves);
    if (game !== run) return;
    const rank = res.best ? `#${res.best.rank}` : 'unranked';
    setSubmitStatus(
      res.isBest
        ? `Verified ${res.score} turns: your best, ${rank} on the leaderboard.`
        : `Verified ${res.score} turns. Your best is ${res.best?.score} (${rank}).`,
    );
    if (!boardPanel.hidden) void refreshBoard();
  } catch (err) {
    if (game !== run) return;
    const e = err instanceof ApiError ? err : new ApiError(0, 'error', String(err));
    if (e.code === 'duplicate_run') setSubmitStatus('Already on the board: you submitted this exact run before.');
    else if (e.code === 'stale_track_version') {
      setSubmitStatus('This track was updated. Reload to race the new version.', true);
    } else setSubmitStatus(`Not submitted: ${e.message}`, true);
  }
}

// --- Racer name (top right): click to edit; applies to all of this racer's runs -------------

function normalizeName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : undefined;
}

function editName(): void {
  if (!player) return;
  nameButton.hidden = true;
  nameForm.hidden = false;
  nameInput.value = player.displayName;
  nameInput.focus();
  nameInput.select();
}

function closeNameEditor(): void {
  nameForm.hidden = true;
  nameButton.hidden = false;
}

nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = normalizeName(nameInput.value);
  if (!name) {
    showToast('Names are 1–16 letters, numbers, spaces, _ or -', true);
    return;
  }
  closeNameEditor();
  if (name === player?.displayName) return;
  try {
    player = await api.rename(name);
    showToast(`You’re racing as ${player.displayName}`);
    update();
    if (!boardPanel.hidden) void refreshBoard();
  } catch (err) {
    showToast(`Could not rename: ${err instanceof Error ? err.message : String(err)}`, true);
  }
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNameEditor();
});
nameInput.addEventListener('blur', () => {
  if (!nameForm.hidden) nameForm.requestSubmit();
});

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

// --- Leaderboard ---------------------------------------------------------------------------

function toggleBoard(open = boardPanel.hidden): void {
  boardPanel.hidden = !open;
  if (open) void refreshBoard();
  update();
}

async function refreshBoard(): Promise<void> {
  const track = game.track;
  const list = $('board-list');
  const sub = $('board-sub');
  const mine = $('board-me');
  if (!online) {
    list.replaceChildren();
    sub.textContent = 'The leaderboard needs the server, which is not reachable.';
    mine.textContent = '';
    return;
  }
  sub.textContent = `${track.name} · loading…`;
  try {
    const board = await api.leaderboard(track.slug);
    if (game.track !== track) return;
    const p = board.track.par ? ` · par ${board.track.par}` : '';
    sub.textContent =
      board.entries.length === 0
        ? `${track.name}: no runs yet. Finish a lap to take first place.`
        : `${track.name}${p}`;
    // Names are player-chosen: always set as text, never as HTML.
    list.replaceChildren(
      ...board.entries.map((e) => {
        const li = document.createElement('li');
        li.classList.toggle('me', e.isMe);
        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = String(e.rank);
        const who = document.createElement('span');
        who.className = 'name';
        who.textContent = e.isMe ? `${e.playerName} (you)` : e.playerName;
        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = String(e.score);
        li.append(rank, who, score);
        return li;
      }),
    );
    const shown = board.entries.some((e) => e.isMe);
    mine.textContent = board.me && !shown ? `Your best: ${board.me.score} turns, #${board.me.rank}` : '';
  } catch (err) {
    sub.textContent = `Could not load the leaderboard: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- Input --------------------------------------------------------------------------------

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
  if (e.target instanceof HTMLInputElement) return;
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
  } else if (e.ctrlKey) {
    return;
  } else if (e.code === 'KeyR') {
    restart();
  } else if (e.code === 'KeyL') {
    toggleBoard();
  } else if (e.code === 'Escape' && !boardPanel.hidden) {
    toggleBoard(false);
  } else if (DEV_TOOLS && e.code === 'KeyB') {
    void toggleBest();
  } else if (DEV_TOOLS && e.code === 'KeyG') {
    void toggleWatch();
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

$('btn-best').addEventListener('click', () => void toggleBest());
$('btn-watch').addEventListener('click', () => void toggleWatch());
$('btn-undo').addEventListener('click', undo);
$('btn-restart').addEventListener('click', restart);
$('btn-board').addEventListener('click', () => toggleBoard());
$('board-close').addEventListener('click', () => toggleBoard(false));
nameButton.addEventListener('click', editName);
$('finish-copy').addEventListener('click', copyRun);
$('finish-board').addEventListener('click', () => toggleBoard(true));
$('finish-restart').addEventListener('click', restart);

// --- Start --------------------------------------------------------------------------------

try {
  const [serverTracks, me] = await Promise.all([api.tracks(), api.player()]);
  tracks = serverTracks.map((t) =>
    parseTrack({ slug: t.slug, name: t.name, version: t.version, maxTurns: t.maxTurns, map: t.map }),
  );
  for (const t of serverTracks) pars.set(t.slug, t.par);
  player = me;
  online = true;
} catch {
  online = false;
}
for (const t of tracks) select.add(new Option(t.name, t.slug));
loadTrack(location.hash.slice(1));
if (!online) showToast('Server not reachable: playing offline, runs are not submitted');
