# Money Harvester Pro

Live MetaApi trading control room with broker-sourced account data, market-structure diagnostics, protected execution gates, Supabase persistence, Finnhub news protection, and an honest no-data state until credentials are configured.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets for live operation: `METAAPI_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `FINNHUB_API_KEY`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/money-harvester-pro` — responsive control-room frontend
- `artifacts/api-server/src/lib/metaapi.ts` — server-only MetaApi provisioning, polling, live account data, candles, and trades
- `artifacts/api-server/src/lib/strategy.ts` — M15/H4/Daily/M5 market-structure analysis
- `artifacts/api-server/src/routes` — broker, dashboard, engine, journal, and risk routes
- `supabase/schema.sql` — requested Supabase tables and indexes
- `lib/api-spec/openapi.yaml` — typed API source of truth

## Architecture decisions

- MetaApi and Supabase calls stay on the API server; browser code only uses generated API hooks.
- Missing live credentials fail closed; no balances, leverage, candles, or fills are fabricated.
- Broker leverage is read from MetaApi account information and is never inferred from the selected broker card.
- The engine scheduler runs a server-side strategy pass every 60 seconds when live secrets and profiles exist.

## Product

Users can connect a real MT5 account, inspect broker-confirmed balance/equity/leverage/margin and positions, review strategy states and diagnostics for supported symbols, configure risk limits, inspect the journal/equity history, and send only SL/TP-protected orders that pass server-side gates.

## User preferences

- Live-money mode only; do not replace broker data with demo values or assumed leverage.

## Gotchas

- Run `supabase/schema.sql` in the target Supabase project before connecting an account.
- The generated Zod client in this workspace currently expects OpenAPI `number` for integer-like fields; using OpenAPI `integer` causes `zod.int()` output that is incompatible with the installed Zod 3 runtime.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
