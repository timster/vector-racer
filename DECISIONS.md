# Decisions

Choices made where SPEC.md left an option open. Newest at the bottom.

## Rules (rulesVersion `v1`, SIM_VERSION `1`)

- **Collision rule: stop at the edge, +3 penalty turns** (owner's call; 3 is the classic vector racing penalty). If the traced path touches a wall or leaves the grid, the car stops on the last clear cell before it, velocity becomes `0,0`, and the move costs 4 turns (its own plus 3). With no penalty walls were a free brake; with 1 they still paid off on the oval's tight ends (24 vs 25 clean); with 3 no optimal line on any built-in track uses a wall. Implemented as the pluggable `stopAtEdge` in `packages/sim/src/rules.ts`. SIM_VERSION is a plain integer (1, then 2, …), bumped when step() behaviour changes in a way that could change a score.
- **Finish requires all checkpoints** (owner's call). The finish line only counts once checkpoints `1..n` have been crossed in order. Loop tracks therefore need at least one checkpoint (built-ins use 2–3 so driving backwards is never shorter). Point-to-point tracks may have none.
- **Score is the whole turn** on which the path crosses the finish (owner's call). The car's recorded position is the first finish cell on the path; anything beyond is ignored, including a would-be crash.
- **Line trace: supercover, not plain Bresenham.** Every cell the segment passes through counts, and passing exactly through a corner touches both side cells. So squeezing diagonally between two walls that meet at a corner is a collision, and the touched cell set is the same in both directions. Pure integer arithmetic.
- Checkpoints and the finish are also detected on corner-touched cells, consistent with walls.
- **Exactly one `S` cell per track.** A start-cell choice would be an input outside the move list.
- **`maxTurns`** bounds both the move list length and the turn count.
- Coasting at zero speed is legal (the car stays put, the turn still counts).
- Coordinates are y-down; move index `(ay + 1) * 3 + (ax + 1)` so 0 is up-left and 8 is down-right.

## Code layout

- Packages are consumed as TypeScript source (`exports: ./src/index.ts`); no build step for internal packages. Vite, Vitest and `tsx` all handle TS directly.
- `packages/sim` typechecks with `lib: ES2022` and no `@types/node`, so `window`, `document`, `fetch` and `process` don't exist there. oxlint additionally bans `Date`, `Math.random`, `Math.sqrt` and any non-relative import in `packages/sim/src`.
- The `Track` type and cell codes live in `sim` (it has no deps); the text format, parser and validator live in `tracks`.
- Track validator uses 4-connected flood fill per stage (start → cp1 → … → finish). A car's traced path always covers a 4-connected chain, so this is exact for reachability.
- Golden replay cases live in `packages/tracks/golden/cases.json` (they need the parser and built-in tracks). The server will import the same file in Phase 2.
- A shortest-run search (bucket-queue Dijkstra, since crashes cost 4 turns) over `(x, y, vx, vy, nextCheckpoint)` lives in `packages/tracks/src/solve.ts`. Tests use it to prove tracks are finishable, and the client uses it for the best-line ghost. The Phase 4 par tool will wrap it. Ties are broken toward fewer wall hits, so the best line is clean whenever a clean run scores the same. Current optimums: Dogleg 8, Oval 25, Hairpin 44, Figure8 38, Street 44, all without wall hits.
- **Tooling: oxlint + oxfmt** instead of ESLint + Prettier. oxlint runs the correctness category plus type-aware rules via `oxlint-tsgolint` (built on TS 7), and carries the sim purity rules. oxfmt was migrated from the Prettier config (single quotes, width 120) and formats the repo identically apart from one CSS line. oxfmt is pre-1.0, so it is pinned to an exact version.
- **Dependencies at latest** (checked 2026-11-13), including **TypeScript 7.0.2** (the native compiler). Dropping typescript-eslint, which capped TypeScript at `<6.1.0`, is what made 7 possible. Editor support uses the TypeScript Native Preview extension (`.vscode/settings.json`).
- CI runs on Node 26 (current LTS). `engines` stays `>=22`; local development on Node 24 is fine.

## Client

- Art: Kenney Racing Pack (CC0) for the car sprite and grass/asphalt textures, in `apps/web/public/assets/kenney/`. Curbs, finish checker and checkpoint bands are drawn in code. All colours in `THEME` in `apps/web/src/render.ts`.
- Local undo is allowed in the Phase 1 client. Phase 2 submissions only ever send the final move list, so undo has no effect on validation.
- "Copy run" exports `{ track, trackVersion, moves }`, which `npm run replay` accepts.
- **Best line ghost.** The client computes each track's optimal run on load (about 0.1 s on the largest track) instead of shipping precomputed runs, so it can never fall out of step with the rules. B toggles the line plus a ghost car that keeps pace with the player's turn count; G plays the full lap. Showing par openly matches SPEC Phase 4.

## Server (Phase 2)

- **Anonymous racers, no login** (owner's call, replaces the spec's OAuth accounts). A browser's first visit creates a racer named `Racer-XXXX` and an `HttpOnly`, `SameSite=Strict` cookie (`vr_player`, 400 days) holding a random token; only the token's sha256 is stored. The name shows top right and can be changed any time; runs reference the racer, so a rename applies to all of their runs. Names are free-form and not unique (1–16 of letters, digits, spaces, `_`, `-`; trimmed, spaces collapsed). No way to move a racer to another browser (an account-key design was built and dropped as too much friction).
- Every finished run is submitted automatically for the browser's racer. The leaderboard keeps each racer's best run, ties to the earlier run; the same move list from the same racer is a duplicate.
- **Other racers' runs stay a mystery** (owner's call): the leaderboard serves names and scores only, and the spec's `GET /runs/:id` (move lists for ghosts) is not exposed.
- **Par is shown to everyone; the best line is dev-only** (owner's call). Best line and Watch best exist only when `import.meta.env.DEV` (Vite dev server). The solver is imported dynamically on first use, so production bundles contain neither it nor the golden cases (the tracks package exposes them as separate entry points, `@vector-racer/tracks/solve` and `/golden`). Hiding it is not security: the sim is public, so anyone could compute the line.
- Schema: `players` (`display_name`, `token_hash`) instead of the spec's `users`; `runs` gains `player_id`, `rules_version` and a `hidden` flag for moderation (in place of per-user `standing`).
- **One process** serves `/api`, and in production the built client (`STATIC_DIR`). Same origin, so no CORS. Vite proxies `/api` in development and keeps the browser's `Host` so the same-origin check matches.
- **Request hardening**: 16 KB body limit; Ajv with no type coercion and unknown fields stripped (a client `score` never reaches the handler); requests from another site's pages (foreign `Origin`) get 403; parameterized queries only.
- **Rate limits** (`DEFAULT_RATE_LIMITS`): 300 req/min per IP overall; 20 new racers/hour per IP; run submissions 20/min per racer and 60/min per IP. The rate-limit plugin runs only one limiter per request, so route limits use `createRateLimit` with a per-limit key prefix.
- **Migrations** are a ~40-line runner over TS strings (`apps/server/src/db/migrations.ts`) with an advisory lock, instead of node-pg-migrate: no extra dependency and the server bundles to one file. The server migrates and syncs built-in tracks on start.
- **Track sync** inserts built-in track versions the database lacks, with `par` from the solver. **Until the first deploy every track stays at v1** (owner's call): outside production a changed map overwrites the stored one and deletes that track's runs. In production a stored version is never edited, and startup fails if a map changed without a version bump. Clients get tracks from `GET /api/tracks`; the built-ins are only an offline fallback.
- **Leaderboard** shows the current track version only.
- **Tests** run against a RAM-only Postgres (`docker compose up -d db-test`): a migrated template database per run, cloned per test file.
- Postgres 18 (current stable as of 2026-11-13).

## Tracks

- Five built-ins, in the owner's order: Dogleg, Oval, Hairpin (was "Hairpin Circuit", slug `circuit` → `hairpin`; renamed before any real runs existed), Figure8 (two square loops crossing at a plus-shaped intersection, square corners throughout; 4 checkpoints, one on each half of both crossing roads' loops; replaced an earlier curved version), Street (one route around city blocks; streets carry on past corners as dead-end runoffs, several running off the edge of the map; earlier drafts were a full street grid with route choices, then short runoffs only).
- Curbs are not drawn along the map's outer edge, so a road reaching it looks like it continues off the map. The sim still treats leaving the grid as hitting a wall.
- Move dots for a finishing move are drawn where the path first crosses the line, not at the (possibly off-board) target.
