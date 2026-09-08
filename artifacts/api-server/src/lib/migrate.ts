import { pool } from "@workspace/db";
import { logger } from "./logger";

const bootstrapSql = `
CREATE TABLE public.equity_history (
    id bigint NOT NULL,
    account_id text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    balance numeric NOT NULL,
    equity numeric NOT NULL
);
CREATE SEQUENCE public.equity_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.equity_history_id_seq OWNED BY public.equity_history.id;
CREATE TABLE public.journal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id text NOT NULL,
    symbol text NOT NULL,
    real_symbol text,
    direction text NOT NULL,
    entry numeric,
    sl numeric,
    initial_sl numeric,
    tp numeric,
    lot numeric,
    pnl numeric,
    r_multiple numeric,
    status text DEFAULT 'OPEN'::text NOT NULL,
    broker_position_id text,
    broker_order_id text,
    broker_status text,
    broker_updated_at timestamp with time zone,
    poi_type text,
    bos_mss_tag text,
    htf_bias text,
    spread numeric,
    slippage numeric,
    chart_snapshot_url text,
    leverage integer,
    margin_used numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);
CREATE TABLE public.profiles (
    id text NOT NULL,
    metaapi_account_id text NOT NULL,
    broker_name text,
    server text,
    login text,
    account_type text,
    connection_state text DEFAULT 'DISCONNECTED'::text NOT NULL,
    leverage integer,
    balance numeric,
    equity numeric,
    starting_balance numeric,
    highest_equity numeric,
    daily_starting_equity numeric,
    max_drawdown_pct numeric,
    daily_drawdown_pct numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.risk_settings (
    account_id text NOT NULL,
    risk_per_trade numeric DEFAULT 1 NOT NULL,
    daily_loss numeric DEFAULT 3 NOT NULL,
    weekly_loss numeric DEFAULT 6 NOT NULL,
    spread_multiplier numeric DEFAULT 2.5 NOT NULL,
    news_minutes integer DEFAULT 30 NOT NULL
);
CREATE TABLE public.states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id text NOT NULL,
    symbol text NOT NULL,
    current_state text DEFAULT 'SCANNING'::text NOT NULL,
    liquidity_pool jsonb DEFAULT '[]'::jsonb NOT NULL,
    poi jsonb,
    diagnostics_log text[] DEFAULT '{}'::text[] NOT NULL,
    htf_bias text,
    htf_conflict boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.equity_history ALTER COLUMN id SET DEFAULT nextval('public.equity_history_id_seq'::regclass);
ALTER TABLE ONLY public.equity_history
    ADD CONSTRAINT equity_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.journal
    ADD CONSTRAINT journal_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_metaapi_account_id_unique UNIQUE (metaapi_account_id);
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_pkey PRIMARY KEY (account_id);
ALTER TABLE ONLY public.states
    ADD CONSTRAINT states_pkey PRIMARY KEY (id);
CREATE INDEX equity_history_account_time_idx ON public.equity_history USING btree (account_id, "timestamp");
CREATE INDEX journal_account_created_idx ON public.journal USING btree (account_id, created_at);
CREATE UNIQUE INDEX states_account_symbol_idx ON public.states USING btree (account_id, symbol);
ALTER TABLE ONLY public.equity_history
    ADD CONSTRAINT equity_history_account_id_profiles_id_fk FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.journal
    ADD CONSTRAINT journal_account_id_profiles_id_fk FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_account_id_profiles_id_fk FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.states
    ADD CONSTRAINT states_account_id_profiles_id_fk FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
`;

export async function ensureSchema(): Promise<void> {
  const result = await pool.query(
    "SELECT to_regclass('public.profiles') AS table_name",
  );
  if (result.rows[0]?.table_name) {
    logger.info("Database schema already present, skipping bootstrap");
    return;
  }
  await pool.query(bootstrapSql);
  logger.info("Database schema created");
}