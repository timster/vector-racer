# Decisions

Choices made where SPEC.md left an option open. Newest at the bottom.

## Rules (rulesVersion `v1`, SIM_VERSION `1.0.0`)

- **Collision rule: stop at the edge, +3 penalty turns** (owner's call; 3 is the classic vector racing penalty). If the traced path touches a wall or leaves the grid, the car stops on the last clear cell before it, velocity becomes `0,0`, and the move costs 4 turns (its own plus 3). With no penalty walls were a free brake; with 1 they still paid off on the oval's tight ends (24 vs 25 clean); with 3 no optimal line on any built-in track uses a wall. Implemented as the pluggable `stopAtEdge` in `packages/sim/src/rules.ts`. SIM_VERSION 1.2.0 (no runs stored yet).
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
- A shortest-run search (bucket-queue Dijkstra, since crashes cost 4 turns) over `(x, y, vx, vy, nextCheckpoint)` lives in `packages/tracks/src/solve.ts`. Tests use it to prove tracks are finishable, and the client uses it for the best-line ghost. The Phase 4 par tool will wrap it. Current optimums: dogleg 8, oval 25, circuit 44, all without wall hits.
- **Tooling: oxlint + oxfmt** instead of ESLint + Prettier. oxlint runs the correctness category plus type-aware rules via `oxlint-tsgolint` (built on TS 7), and carries the sim purity rules. oxfmt was migrated from the Prettier config (single quotes, width 120) and formats the repo identically apart from one CSS line. oxfmt is pre-1.0, so it is pinned to an exact version.
- **Dependencies at latest** (checked 2026-11-13), including **TypeScript 7.0.2** (the native compiler). Dropping typescript-eslint, which capped TypeScript at `<6.1.0`, is what made 7 possible. Editor support uses the TypeScript Native Preview extension (`.vscode/settings.json`).
- CI runs on Node 26 (current LTS). `engines` stays `>=22`; local development on Node 24 is fine.

## Client

- Art: Kenney Racing Pack (CC0) for the car sprite and grass/asphalt textures, in `apps/web/public/assets/kenney/`. Curbs, finish checker and checkpoint bands are drawn in code. All colours in `THEME` in `apps/web/src/render.ts`.
- Local undo is allowed in the Phase 1 client. Phase 2 submissions only ever send the final move list, so undo has no effect on validation.
- "Copy run" exports `{ track, trackVersion, moves }`, which `npm run replay` accepts.
- **Best line ghost.** The client computes each track's optimal run on load (about 0.1 s on the largest track) instead of shipping precomputed runs, so it can never fall out of step with the rules. B toggles the line plus a ghost car that keeps pace with the player's turn count; G plays the full lap. Showing par openly matches SPEC Phase 4.
