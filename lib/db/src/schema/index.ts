import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  metaapi_account_id: text("metaapi_account_id").notNull().unique(),
  broker_name: text("broker_name"),
  server: text("server"),
  login: text("login"),
  account_type: text("account_type"),
  connection_state: text("connection_state").notNull().default("DISCONNECTED"),
  leverage: integer("leverage"),
  balance: numeric("balance", { mode: "number" }),
  equity: numeric("equity", { mode: "number" }),
  starting_balance: numeric("starting_balance", { mode: "number" }),
  highest_equity: numeric("highest_equity", { mode: "number" }),
  daily_starting_equity: numeric("daily_starting_equity", { mode: "number" }),
  max_drawdown_pct: numeric("max_drawdown_pct", { mode: "number" }),
  daily_drawdown_pct: numeric("daily_drawdown_pct", { mode: "number" }),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const states = pgTable(
  "states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    current_state: text("current_state").notNull().default("SCANNING"),
    liquidity_pool: jsonb("liquidity_pool")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    poi: jsonb("poi").$type<unknown>(),
    diagnostics_log: text("diagnostics_log")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    htf_bias: text("htf_bias"),
    htf_conflict: boolean("htf_conflict").notNull().default(false),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("states_account_symbol_idx").on(table.account_id, table.symbol),
  ],
);

export const journal = pgTable(
  "journal",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    real_symbol: text("real_symbol"),
    direction: text("direction").notNull(),
    entry: numeric("entry", { mode: "number" }),
    sl: numeric("sl", { mode: "number" }),
    initial_sl: numeric("initial_sl", { mode: "number" }),
    tp: numeric("tp", { mode: "number" }),
    lot: numeric("lot", { mode: "number" }),
    pnl: numeric("pnl", { mode: "number" }),
    r_multiple: numeric("r_multiple", { mode: "number" }),
    status: text("status").notNull().default("OPEN"),
    broker_position_id: text("broker_position_id"),
    broker_order_id: text("broker_order_id"),
    broker_status: text("broker_status"),
    broker_updated_at: timestamp("broker_updated_at", {
      withTimezone: true,
      mode: "string",
    }),
    poi_type: text("poi_type"),
    bos_mss_tag: text("bos_mss_tag"),
    htf_bias: text("htf_bias"),
    spread: numeric("spread", { mode: "number" }),
    slippage: numeric("slippage", { mode: "number" }),
    chart_snapshot_url: text("chart_snapshot_url"),
    leverage: integer("leverage"),
    margin_used: numeric("margin_used", { mode: "number" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    closed_at: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [index("journal_account_created_idx").on(table.account_id, table.created_at)],
);

export const riskSettings = pgTable("risk_settings", {
  account_id: text("account_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  risk_per_trade: numeric("risk_per_trade", { mode: "number" }).notNull().default(1),
  daily_loss: numeric("daily_loss", { mode: "number" }).notNull().default(3),
  weekly_loss: numeric("weekly_loss", { mode: "number" }).notNull().default(6),
  spread_multiplier: numeric("spread_multiplier", { mode: "number" })
    .notNull()
    .default(2.5),
  news_minutes: integer("news_minutes").notNull().default(30),
});

export const equityHistory = pgTable(
  "equity_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    balance: numeric("balance", { mode: "number" }).notNull(),
    equity: numeric("equity", { mode: "number" }).notNull(),
  },
  (table) => [
    index("equity_history_account_time_idx").on(table.account_id, table.timestamp),
  ],
);