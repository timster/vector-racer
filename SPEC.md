# Vector Racing Game: Build Spec

Nov 13, 2026 · @Tim Shaffer

## Overview

Build a browser-based vector racing game where the server re-simulates every run, so leaderboard scores cannot be forged. The client never reports a score; it reports moves, and the server computes the result.

**Core principle.** Vector racing is turn-based and deterministic. A run is a list of acceleration choices, for example `[4, 5, 5, 2, 8, ...]`. Given a track and that list, the outcome is fully determined, so the server can replay it and trust only its own result.

**How to use this doc (for Claude Code).**

- Build in the phase order given below. Do not start Phase 3 or 4 until the previous phase's acceptance criteria pass.
- Keep the simulation a pure, shared module with no DOM, no I/O and no randomness. Everything else depends on this.
- Where this spec leaves a choice open, pick the simplest option, note it in `DECISIONS.md`, and continue. The owner's open questions are listed at the end.
- Never accept track data, scores or timings from the client as authoritative.

## Game rules (v1)

The v1 ruleset is classic grid-based vector racing with a turn count as the score. These rules live in one constants object and carry a `rulesVersion` so they can change later without corrupting old scores.

- **Grid.** The track is a rectangular grid of integer cells. Each cell is `road`, `wall`, `start`, `finish` or `checkpoint(n)`.
- **State.** `{ x, y, vx, vy, turn, nextCheckpoint, finished }`, all integers.
- **Move.** One of 9 accelerations, `ax, ay` each in `{-1, 0, 1}`, encoded as an index `0..8` (`index = (ay + 1) * 3 + (ax + 1)`).
- **Step.** `vx += ax; vy += ay; x += vx; y += vy; turn += 1`.
- **Collision.** Trace the segment from the old to the new position with an integer line algorithm (Bresenham). If it touches a `wall` cell or leaves the grid, the move is a crash.
- **Crash rule (v1).** Reset to the last safe position, set velocity to `0,0`, and add a 2-turn penalty to `turn`. Keep this as a pluggable function so the owner can swap in other rules later.
- **Checkpoints.** Optional per track. They must be crossed in order; crossing is detected on the same traced segment.
- **Finish.** The run ends when the traced segment crosses the finish line after all checkpoints. Crossing the line is checked on the segment, not just the landing cell.
- **Score.** The final `turn` count. Lower is better. Ties are broken by earlier submission time.
- **Run limit.** Reject runs longer than `track.maxTurns` (default 500) to bound server work.

## Stack and repo layout

Use Node and TypeScript end to end so the browser and the server run the same simulation file, with no port to keep in sync.

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript, strict mode | One language across client, server and shared code |
| Server | Node 22+, `ws`, Fastify for HTTP | No Socket.IO. Fastify serves the REST endpoints and auth |
| Database | Postgres | Use `pg` plus a small migration tool (`node-pg-migrate` or similar) |
| Auth | OAuth (Google/GitHub/Discord) plus anonymous guest accounts | Never store passwords. Guests can upgrade later |
| Frontend | Vite, Canvas 2D, no framework | Plain TS modules |
| Tests | Vitest | Shared sim gets the heaviest coverage |
| Hosting | Fly.io, Railway or a small VPS | Needs long-lived WebSocket support; avoid classic serverless for the game server |

Use an npm workspaces monorepo:

```
vector-racer/
  packages/
    sim/        # pure game logic, shared by client and server (no deps)
    tracks/     # track format, parser, validator, built-in tracks
  apps/
    server/     # Fastify + ws, auth, runs, leaderboard
    web/        # Vite client: renderer, input, UI, ghost playback
  tools/
    solver/     # BFS/A* par solver (Phase 4)
    replay-cli/ # replay a stored run from JSON, for debugging
  DECISIONS.md
```

`packages/sim` must not import anything from `apps/*` or touch `window`, `document`, `Date`, `Math.random` or `fetch`.

## Shared simulation module

`packages/sim` is the heart of the project: a pure, integer-only step function that both the browser and the server import. If it behaves identically in both places, replay validation is trustworthy.

```ts
export type MoveIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface State {
  x: number; y: number;      // integers
  vx: number; vy: number;    // integers
  turn: number;              // includes crash penalties
  nextCheckpoint: number;
  finished: boolean;
  lastSafe: { x: number; y: number };
}

export type StepResult =
  | { ok: true; state: State; crashed: boolean }
  | { ok: false; reason: 'invalid_move' | 'already_finished' | 'turn_limit' };

export function initialState(track: Track): State;
export function step(track: Track, state: State, move: MoveIndex): StepResult;

export interface ReplayResult {
  valid: boolean;
  score?: number;            // final turn count
  reason?: string;
  states?: State[];          // optional, for ghost playback
}
export function replay(track: Track, moves: number[]): ReplayResult;
```

**Determinism requirements.**

- Integers only for positions, velocities and the line trace. No floats, no `Math.sqrt`, no trig.
- No `Date`, no `Math.random`, no iteration over unordered collections in a way that affects results.
- `step` never mutates its inputs; it returns a new state.
- `replay` rejects any move that is not an integer in `0..8`, any move after finishing, and any run that never finishes.
- Export a `SIM_VERSION` string. Every stored run records the `simVersion` and `trackVersion` it was validated under.

**Tests (required before moving on).**

- Hand-built tiny tracks with known optimal runs, asserted move by move.
- Wall-crossing cases: diagonal squeeze between two wall corners, fast moves that would skip over a thin wall, moves that leave the grid.
- Checkpoint order, finish-line crossing on a segment (not just the landing cell), and crash penalty accounting.
- A property test: random legal move sequences replayed twice give identical states.
- A golden-file test: a JSON file of `{track, moves, expectedScore}` cases that the server tests also run, so client and server can never drift.

## Data model

Five Postgres tables cover everything through Phase 4. Store the full move list with every run so ghosts, review and re-validation after a rules change come for free.

| Table | Key columns | Purpose |
| --- | --- | --- |
| `users` | `id`, `display_name`, `oauth_provider`, `oauth_subject`, `is_guest`, `created_at`, `standing` | Accounts. `standing` is `good`, `pending` or `banned` |
| `tracks` | `id`, `slug`, `version`, `rules_version`, `grid` (JSON), `max_turns`, `par` (nullable), `release_at`, `created_at` | Server-owned tracks. Never accept track data from clients |
| `runs` | `id`, `user_id`, `track_id`, `track_version`, `sim_version`, `moves` (`smallint[]`), `score`, `source` (`replay` or `live`), `created_at` | Validated runs. Repeats of the same move list are allowed |
| `run_timings` | `run_id`, `move_times_ms` (`int[]`), `session_id` | Server-side per-move timestamps from live sessions (Phase 3) |
| `flags` | `id`, `run_id`, `kind`, `detail` (JSON), `status`, `created_at` | Suspicious-run reports from heuristics or players (Phase 4) |

Leaderboard query: best score per user per track, with ties broken by earliest `created_at`. Index `runs` on `(track_id, score, created_at)` and filter on `users.standing` as needed.

Only the server writes to `runs`. The score column is always computed by `replay`, never taken from the request body.

## Phases 1 and 2: playable game, then a trustworthy leaderboard

Phase 2 alone already gives a secure leaderboard. Everything after it layers on top without rework.

### Phase 1: local playable game (no server)

1. Scaffold the monorepo, TypeScript config, Vitest and lint.
2. Build `packages/sim` and its tests (see the simulation section).
3. Build `packages/tracks`: a text format (one character per cell, for example `#` wall, `.` road, `S` start, `F` finish, digits for checkpoints), a parser, a validator (start exists, finish reachable), and 3 built-in tracks of increasing size.
4. Build `apps/web`: Canvas renderer with grid and track, car and trail, the 9 legal next positions shown as clickable dots, crash feedback, turn counter, restart, and track select.

Acceptance: a person can finish all three tracks in the browser, and the same moves replayed through `replay()` in a Node script give the same score.

### Phase 2: server replay validation and leaderboard

1. Set up Postgres, migrations and the tables from the data model.
2. Add auth: OAuth login plus guest accounts, session cookies, `GET /me`.
3. Add `GET /tracks` and `GET /tracks/:slug`. Tracks are loaded from the database by the server only.
4. Add `POST /tracks/:slug/runs` with body `{ trackVersion, moves }`. The server loads the track, calls `replay`, rejects invalid runs with a clear reason, and stores `score` from the replay result.
5. Add `GET /tracks/:slug/leaderboard?limit=50` (best run per user) and `GET /runs/:id` (returns the move list for ghost playback).
6. Rate-limit submissions per account and per IP.
7. In the client, add submit-on-finish, a leaderboard page, and ghost playback of a chosen run.

Acceptance:

- A forged request with a fake `score` field is ignored and the stored score matches the replay.
- An illegal move list (wall hit treated as legal, bad index, extra moves after finish, too long) is rejected.
- A request with a stale `trackVersion` is rejected with a clear error.
- The golden-file tests pass on both client and server.

## Phase 3: live WebSocket sessions

In a live session the server watches every move as it happens, so a script can no longer submit a finished run in one request. The Phase 2 replay endpoint stays for imports and as a fallback.

&#91;embedded content: live session message flow · 1 loop\]

The client cannot send move N+1 until the server has processed move N and returned the next nonce.

**Protocol.** JSON text frames, each with a `type` field.

| Message | Direction | Fields |
| --- | --- | --- |
| `hello` | client to server | `auth` (session credential) |
| `start_run` | client to server | `trackSlug`, `trackVersion` |
| `run_started` | server to client | `sessionId`, `state`, `nonce` |
| `move` | client to server | `move` (0 to 8), `nonce` |
| `state` | server to client | `state`, `crashed`, `nonce` |
| `finished` | server to client | `score`, `runId` |
| `resume` | client to server | `sessionId` |
| `error` | server to client | `code`, `message` |

**Per-move nonce.** The server issues a fresh random value with every reply, and the client must echo it with its next `move`. There is no signing and no JWT library: the server already holds the session state, so the nonce only has to be unguessable and single-use. Generate 16 random bytes with `crypto.randomBytes(16)` (base64url) and compare in constant time. Per session, the server stores:

| Field | Meaning |
| --- | --- |
| `nonce` | The one value accepted next; replaced on every reply |
| `turn` | The turn the nonce authorizes; must equal the session's expected turn |
| `issuedAt` | Server time the nonce was issued, used for pacing |
| `sid`, user id | The session and account; the socket must belong to this session |

Pacing comes from `issuedAt`: reject a move sent sooner than `MIN_THINK_MS` after the nonce was issued (config, start at 250 ms), and expire the session when `MAX_THINK_MS` passes with no move (config, start at 60 s). If the server ever runs on more than one instance, keep this state in Redis, or derive the nonce as a truncated `HMAC(secret, sid || turn || issuedAt)` so any instance can verify it.

**Server rules.**

- One active session per user. Starting a new run closes the old one.
- On each `move`: check the nonce, turn and `MIN_THINK_MS`, apply `step()` from the shared sim, record the server-side arrival time, store the new state, and reply with the next nonce.
- On finish: save the run with `source = 'live'`, write the move times to `run_timings`, and close the session.
- `resume`: an authenticated user can reattach to an active session before `MAX_THINK_MS` runs out; the server re-sends the current state and a fresh nonce. Without this, honest players on flaky connections lose runs.
- Keep session state in memory for now; see the note above on running more than one instance.

Acceptance:

- A nonce from an earlier turn, or one already used, is rejected.
- A move sent before `MIN_THINK_MS` has passed is rejected with a `too_fast` error and the session continues.
- Dropping the socket mid-run and resuming continues the same run.
- A nonce presented from another user's session is rejected.
- A finished live run appears on the leaderboard with its timings stored.

## Phase 4: making cheating costly and visible

Nothing here can fully stop a determined solver. The goal is to make scripted runs expensive, detectable and separable from human ones. Build these in order, and only once real players are using the game.

1. **Par solver.** In `tools/solver`, write a BFS or A\* solver over the state space `(x, y, vx, vy, nextCheckpoint)`. Run it on each track at publish time and store the optimal turn count in `tracks.par`. Show par to players openly.
2. **Flagging.** After each live run, compute signals and write rows to `flags` for review. Never auto-ban on these alone:
   - score equals par on a large track
   - very low variance in per-move think time
   - no extra hesitation before hard corners compared with straights
   - total duration implausibly short for the number of moves
3. **Tiered leaderboards.** `verified` = live-session runs from accounts in good standing. `all` = everything, including replay-submitted runs. New accounts start as `pending`, and their runs show only on `all` until they have some history.
4. **Rate limits and bot friction.** Per-account and per-IP limits on session starts and submissions. Add a CAPTCHA (Cloudflare Turnstile or hCaptcha) on session start if abuse appears.
5. **Review tooling.** An admin-only page listing flagged runs with ghost playback and a timing chart, plus buttons to clear a flag or mark a run invalid. Player-facing "report this run" writes a `flags` row with `kind = 'report'`.
6. **Optional, if solvers become a real problem:** rotating daily tracks released at a fixed time so solutions cannot be precomputed, or a hidden-information mode (fog of war, hazards revealed one turn ahead from a server-held seed). Both change gameplay, so treat them as separate game modes, not defaults.

Skip client-side obfuscation and anti-debugging. A solver only needs the rules, which it can reimplement, so obfuscation mainly hurts your own debugging.

Acceptance: the solver's par for each built-in track matches a hand-verified optimum, flagged runs appear in the review page, and `verified` excludes replay-submitted and pending-account runs.

## Security, testing and open decisions

**Security checklist.**

- The server never reads a score, time or track from a request body. Scores come from `replay` or the live session only.
- Validate every input: move indices are integers in `0..8`, move lists are capped at `track.maxTurns`, request bodies have a size limit.
- Secrets (OAuth secrets, session cookie key, database URL) come from environment variables and are never committed.
- Use parameterized queries only. Set strict CORS and secure, `HttpOnly`, `SameSite` cookies.
- Generate nonces with `crypto.randomBytes` and compare them in constant time.
- Log rejected runs with the reason, so abuse patterns are visible.

**Testing priorities.**

1. `packages/sim` unit and property tests, plus the shared golden-file cases (highest priority).
2. Server integration tests for every Phase 2 acceptance case, using a throwaway Postgres.
3. WebSocket tests for the Phase 3 cases: token reuse, early move, resume, wrong-socket token.
4. A CI workflow that runs lint, type-check and all tests on every push.

**Open decisions for the owner.** Claude Code should pick the default shown, record it in `DECISIONS.md`, and keep going unless told otherwise.

| Decision | Default if unanswered |
| --- | --- |
| Crash rule: reset with penalty, or stop at the wall | Reset to last safe position, 2-turn penalty |
| Score metric: turns only, or turns plus real time | Turns only; wall-clock time is cosmetic |
| Guests allowed on the leaderboard | Yes, shown as guest, upgradeable |
| Hosting target | Fly.io with managed Postgres |
| Track creation: built-in only, or a player track editor | Built-in only for v1 |
| Name and visual style | Neutral placeholder, easy to rename |
