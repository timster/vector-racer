# Vector Racer

Turn-based vector racing in the browser. Every lap is raced live over a WebSocket and checked move by move by the server, which replays it with the same simulation the browser uses, so leaderboard scores can't be faked.

- `packages/sim`: the rules, pure and deterministic, shared by browser and server
- `packages/tracks`: track format, built-in tracks, and the solver that finds par
- `apps/server`: Fastify + Postgres: tracks, racers, live runs, leaderboard
- `apps/web`: the game (Vite, Canvas 2D)
- `SPEC.md` is the original plan; `DECISIONS.md` records where and why the build differs

## Run it locally

Needs Node 22+ and Docker.

```sh
npm install
cp .env.example .env
npm run db:up     # Postgres for dev (5432) and tests (5433)
npm run dev       # API on :3000 and the game on http://localhost:5173
```

`npm run check` runs lint, typecheck and all tests. In dev builds the Best line and Watch best buttons (B and G) show the solver's optimal line.

## Deploy to Railway

The repo deploys as one Railway project with two services: the game (built from the `Dockerfile`, configured by `railway.json`) and Postgres.

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, and pick the repo.
3. In the project: **New → Database → PostgreSQL**.
4. In the game service, **Settings → Networking → Generate Domain** (for example `vector-racer-production.up.railway.app`).
5. In the game service, **Variables**:

   | Variable        | Value                                                  |
   | --------------- | ------------------------------------------------------ |
   | `DATABASE_URL`  | `${{Postgres.DATABASE_URL}}`                           |
   | `PUBLIC_ORIGIN` | `https://` + the domain from step 4, no trailing slash |
   | `TRUST_PROXY`   | `true`                                                 |

   Railway sets `PORT` itself, and the image sets `NODE_ENV=production`.

6. Deploy. On start the server creates its tables and loads the built-in tracks; Railway waits for `/api/tracks` to answer before switching traffic over.

`PUBLIC_ORIGIN` must match the address in the browser exactly, or the server refuses the game's requests and live connections (403). With a custom domain, set it to that domain.

Once deployed, track maps are frozen: changing one means bumping its `version` in `packages/tracks/src/builtin.ts`, or the server refuses to start.
