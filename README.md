# Money Harvester Pro

<p align="center">
  <img src="artifacts/money-harvester-pro/public/favicon.jpg" width="120" height="120" alt="Money Harvester Pro logo">
</p>

> Built by Toxic Tech · advanced by VYLUX TECH

A self-hosted trading control room for MetaTrader accounts via MetaApi. It
runs a live MetaApi connection, a market-structure analysis engine, protected
(order-ticket) execution, risk-mitigation settings, an equity tracker and a
broker-side trade journal — served as one deployable unit.

## Features

- **Real-time broker link** — connect any MetaTrader 4/5 account through
  MetaApi (server, login, password); live balance/equity, leverage, open
  positions and symbol specifications are reconciled continuously.
- **State machine trading engine** — each watched symbol is analyzed
  (liquidity pools / points of interest, HTF bias, diagnostics) and its state
  is persisted to the database.
- **Protected execution** — opening a trade runs through server-side risk
  gates (daily/weekly loss limits, news blackout, spread filtering) before the
  order is sent to MetaApi; stops are moved to break-even when safe.
- **Risk settings** — per-account risk-per-trade, daily/weekly loss limits,
  spread multiplier and news filter window.
- **Trade journal** — auto-recorded entries with broker position/order IDs,
  P&L and R-multiple; live positions are reconciled and closed rows updated.
- **Equity history** — balance/equity snapshots recorded on every reconcile
  tick; exposed to the dashboard's equity chart.
- **Scheduled engine** — background sweeps run analysis and reconciliation on
  a fixed interval once a MetaApi token is configured.

## Monorepo layout

- `artifacts/api-server` — Express 5 API server (`src/routes/*`), the trading
  engine, MetaApi glue and the engine scheduler. Bundled to a single ESM file
  with esbuild (`dist/index.mjs`) and also serves the built frontend.
- `artifacts/money-harvester-pro` — React 19 + TypeScript + Vite 7 frontend
  (build output: `dist/public`). In dev it proxies `/api` to `localhost:8080`.
- `lib/db` — Drizzle ORM schema (`src/schema`) + a node-postgres pool.
- `lib/api-zod` / `lib/api-client-react` — shared REST contracts and the
  React API client used by the frontend.
- `scripts` — workspace tooling; `docker-compose.yml` — local Postgres 16.

## Tech stack

Node 22 · TypeScript · Express 5 · pnpm workspaces · Drizzle ORM + Postgres 16 ·
React 19 · Tailwind CSS 4 · Vite 7 · esbuild · pino

## Prerequisites

- Node.js 22+
- pnpm 11 (`corepack enable`)
- Docker (for local Postgres) — or any PostgreSQL 16 you can reach via
  `DATABASE_URL`

## Local development

```bash
# 1. Start the local Postgres
docker compose up -d

# 2. Create the schema (or let the api-server auto-bootstrap on first boot)
DATABASE_URL=postgresql://money:money@localhost:5432/moneyharvester \
  pnpm --filter @workspace/db run push

# 3. Configure secrets
cp artifacts/api-server/.env.example artifacts/api-server/.env
#    set METAAPI_TOKEN (from app.metaapi.cloud → Account → API access)

# 4. Run the API server (default http://localhost:8080)
pnpm --filter @workspace/api-server run dev

# 5. In another terminal, run the frontend dev server with proxy
pnpm --filter @workspace/money-harvester-pro run dev
```

## Environment variables

Set these in `artifacts/api-server/.env` for local dev, or as Render
environment variables in production.

| Variable        | Required | Description                                                        |
| --------------- | :------: | ------------------------------------------------------------------ |
| `PORT`          |   yes    | HTTP port for the API server (Render injects this automatically)   |
| `METAAPI_TOKEN` |   yes    | MetaApi API token                                                  |
| `DATABASE_URL`  |   yes    | Postgres connection string                                         |
| `BASE_PATH`     |    no    | Vite base path (default `/`) — only used during frontend builds    |
| `FINNHUB_API_KEY` |   no   | Used by the news filter when checking high-impact events           |

## Deploy to Render (self-contained)

The repo ships a Render Blueprint (`render.yaml`). It builds the whole
monorepo, provisions a free managed Postgres, links it as `DATABASE_URL`, and
runs the API server which also serves the built frontend.

1. Push the repository to GitHub.
2. In Render: **New → Blueprint** → select the repo.
3. Render creates the web service + Postgres automatically.
4. Add the `METAAPI_TOKEN` secret (Services → your service → Environment).
5. The database schema is bootstrapped automatically on first boot — no
   manual migration step needed.

First deploy builds assets with `pnpm install --frozen-lockfile && pnpm run
build` and starts with `node artifacts/api-server/dist/index.mjs`.

## API overview

All routes are mounted under `/api`. Changes are validated against zod
contracts at the boundary.

- `GET/POST /api/broker/connect` — register/express-broker-link an account.
- `GET /api/dashboard?accountId=...` — account snapshot, states, journal,
  equity history and risk settings in one payload.
- `GET/POST /api/engine/run` and `/api/engine/execute` — run the analysis
  engine / execute a protected order.
- `GET/PATCH /api/risk-settings/:accountId` — risk configuration.
- `GET /api/journal?accountId=...` and `GET /api/equity-history?accountId=...`
  — journal entries and balance/equity snapshots.

## Security

- `artifacts/api-server/.env` is gitignored — never commit it.
- API tokens pasted into chat or logs should be treated as compromised and
  rotated (MetaApi: Account → API access; GitHub: Settings → Developer
  settings → Personal access tokens).
- The schema-bootstrap SQL only runs when the `profiles` table does not exist,
  so it is safe to restart against an existing database.

## Scripts

| Command                                          | What it does                                  |
| ------------------------------------------------ | --------------------------------------------- |
| `pnpm run build`                                 | Typecheck all, then build API + frontend      |
| `pnpm run typecheck`                             | Typecheck the whole workspace                 |
| `pnpm --filter @workspace/api-server run dev`    | Rebuild and run the API server                |
| `pnpm --filter @workspace/db run push`           | Push the Drizzle schema to the database       |
| `pnpm --filter @workspace/money-harvester-pro run dev` | Run the frontend dev server (proxies `/api` → `localhost:8080`) |