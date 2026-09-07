import { Router, type IRouter } from "express";
import { GetDashboardQueryParams } from "@workspace/api-zod";
import {
  getAccountCycleStatus,
  setEmergencyKillSwitch,
  reconcileAccountJournal,
  updateAccountCycleConfig,
} from "../lib/engine-scheduler";
import {
  evaluatePropSafety,
  evaluateContestMetrics,
  getDefaultPropRules,
  type AccountProfile,
  type AccountProfileMode,
} from "../lib/account-profile";
import { findProfile, hasSupabaseConfig, supabaseRequest } from "../lib/supabase";

const router: IRouter = Router();

function mapState(row: Record<string, unknown>) {
  const poi =
    row.poi && typeof row.poi === "object" && !Array.isArray(row.poi)
      ? (row.poi as Record<string, unknown>)
      : {};
  return {
    id: typeof row.id === "string" ? row.id : null,
    accountId: String(row.account_id ?? ""),
    symbol: String(row.symbol ?? ""),
    currentState: String(row.current_state ?? "SCANNING"),
    htfBias: typeof row.htf_bias === "string" ? row.htf_bias : null,
    htfConflict: Boolean(row.htf_conflict),
    trend: typeof row.trend === "string" ? row.trend : null,
    poiType: typeof poi.type === "string" ? poi.type : null,
    poiHigh: typeof poi.high === "number" ? poi.high : null,
    poiLow: typeof poi.low === "number" ? poi.low : null,
    diagnostics: Array.isArray(row.diagnostics_log)
      ? row.diagnostics_log.filter((item): item is string => typeof item === "string")
      : [],
    lastUpdated: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function mapJournal(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    accountId: String(row.account_id ?? ""),
    symbol: String(row.symbol ?? ""),
    realSymbol: typeof row.real_symbol === "string" ? row.real_symbol : null,
    direction: String(row.direction ?? ""),
    entry: typeof row.entry === "number" ? row.entry : null,
    sl: typeof row.sl === "number" ? row.sl : null,
    tp: typeof row.tp === "number" ? row.tp : null,
    lot: typeof row.lot === "number" ? row.lot : null,
    pnl: typeof row.pnl === "number" ? row.pnl : null,
    rMultiple: typeof row.r_multiple === "number" ? row.r_multiple : null,
    status: String(row.status ?? "UNKNOWN"),
    poiType: typeof row.poi_type === "string" ? row.poi_type : null,
    bosMssTag: typeof row.bos_mss_tag === "string" ? row.bos_mss_tag : null,
    htfBias: typeof row.htf_bias === "string" ? row.htf_bias : null,
    leverage: typeof row.leverage === "number" ? row.leverage : null,
    marginUsed: typeof row.margin_used === "number" ? row.margin_used : null,
    chartSnapshotUrl:
      typeof row.chart_snapshot_url === "string" ? row.chart_snapshot_url : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

function emptySnapshot(diagnostics: string[]) {
  return {
    account: null,
    dailyPnl: null,
    dailyPnlPercent: null,
    winRate: null,
    profitFactor: null,
    cycleStatus: null,
    accountProfile: null,
    propSafety: null,
    contestMetrics: null,
    states: [],
    journal: [],
    equityHistory: [],
    risk: null,
    liveData: false,
    diagnostics,
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const { accountId } = GetDashboardQueryParams.parse(req.query);
    const cycleStatus = getAccountCycleStatus(accountId);

    if (!hasSupabaseConfig()) {
      res.json(
        emptySnapshot([
          "Connect Supabase to persist profiles, states, journal, and equity history",
          "Live broker numbers are intentionally unavailable until a server-side account is connected",
        ]),
      );
      return;
    }
    const profile = await findProfile(accountId);
    if (!profile?.metaapi_account_id) {
      res.json(emptySnapshot(["No live broker account connected"]));
      return;
    }
    const reconciliation = await reconcileAccountJournal(
      accountId,
      String(profile.metaapi_account_id),
      {
        brokerName: typeof profile.broker_name === "string" ? profile.broker_name : undefined,
        server: typeof profile.server === "string" ? profile.server : undefined,
      },
    );
    const [account, states, journalRows, equityRows, riskRows] = await Promise.all([
      Promise.resolve(reconciliation.account),
      supabaseRequest<Record<string, unknown>[]>("states", {
        query: { select: "*", account_id: `eq.${accountId}`, order: "symbol.asc" },
      }),
      supabaseRequest<Record<string, unknown>[]>("journal", {
        query: { select: "*", account_id: `eq.${accountId}`, order: "created_at.desc", limit: 100 },
      }),
      supabaseRequest<Record<string, unknown>[]>("equity_history", {
        query: { select: "timestamp,balance,equity", account_id: `eq.${accountId}`, order: "timestamp.asc", limit: 500 },
      }),
      supabaseRequest<Record<string, unknown>[]>("risk_settings", {
        query: { select: "*", account_id: `eq.${accountId}`, limit: 1 },
      }),
    ]);
    const journal = journalRows.map(mapJournal);
    const closed = journal.filter((entry) => entry.status === "CLOSED");
    const winners = closed.filter((entry) => (entry.pnl ?? 0) > 0);
    const grossProfit = closed
      .filter((entry) => (entry.pnl ?? 0) > 0)
      .reduce((sum, entry) => sum + (entry.pnl ?? 0), 0);
    const grossLoss = Math.abs(
      closed
        .filter((entry) => (entry.pnl ?? 0) < 0)
        .reduce((sum, entry) => sum + (entry.pnl ?? 0), 0),
    );

    // Profile Mode & Prop/Contest Calculations
    const mode: AccountProfileMode = (typeof profile.mode === "string" ? profile.mode : "DEMO") as AccountProfileMode;
    const accountProfile: AccountProfile = {
      id: accountId,
      mode,
      startingBalance: typeof profile.starting_balance === "number" ? profile.starting_balance : account.balance ?? 10000,
      currentBalance: account.balance ?? 10000,
      currentEquity: account.equity ?? 10000,
      highestEquity: typeof profile.highest_equity === "number" ? profile.highest_equity : account.equity ?? 10000,
      dailyStartingEquity: typeof profile.daily_starting_equity === "number" ? profile.daily_starting_equity : account.equity ?? 10000,
      propRules: getDefaultPropRules(typeof profile.starting_balance === "number" ? profile.starting_balance : 100000),
    };

    const openPositionsLot = account.positions.reduce((sum, p) => sum + (p.volume ?? 0), 0);
    const propSafety = mode === "PROP" ? evaluatePropSafety(accountProfile, openPositionsLot) : null;
    const contestMetrics = mode === "CONTEST"
      ? evaluateContestMetrics(
          accountProfile,
          closed.map((c) => ({ pnl: c.pnl ?? 0, lot: c.lot ?? 0, isWin: (c.pnl ?? 0) > 0 })),
        )
      : null;

    res.json({
      account,
      dailyPnl: null,
      dailyPnlPercent: null,
      winRate: closed.length ? (winners.length / closed.length) * 100 : null,
      profitFactor: grossLoss ? grossProfit / grossLoss : null,
      cycleStatus,
      accountProfile,
      propSafety,
      contestMetrics,
      states: states.map(mapState),
      journal,
      equityHistory: equityRows.map((row) => ({
        timestamp: String(row.timestamp ?? ""),
        balance: Number(row.balance ?? 0),
        equity: Number(row.equity ?? 0),
      })),
      risk: riskRows[0]
        ? {
            accountId,
            riskPerTrade: Number(riskRows[0].risk_per_trade ?? 1),
            dailyLoss: Number(riskRows[0].daily_loss ?? 3),
            weeklyLoss: Number(riskRows[0].weekly_loss ?? 6),
            spreadMultiplier: Number(riskRows[0].spread_multiplier ?? 2.5),
            newsMinutes: Number(riskRows[0].news_minutes ?? 30),
          }
        : null,
      liveData: true,
      diagnostics: ["Live broker snapshot loaded from MetaApi"],
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load dashboard",
    });
  }
});

router.post("/dashboard/kill-switch", async (req, res) => {
  try {
    const accountId = String(req.body?.accountId ?? "").trim();
    const enabled = Boolean(req.body?.enabled);
    const reason = String(req.body?.reason ?? "Manual kill switch triggered").trim();

    if (!accountId) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }

    setEmergencyKillSwitch(accountId, enabled, reason);
    res.json({
      accountId,
      enabled,
      reason,
      status: getAccountCycleStatus(accountId),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to toggle kill switch",
    });
  }
});

router.post("/dashboard/cycle-config", async (req, res) => {
  try {
    const accountId = String(req.body?.accountId ?? "").trim();
    const activeMinutes = Number(req.body?.activeMinutes);
    const cooldownMinutes = Number(req.body?.cooldownMinutes);

    if (!accountId) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }

    updateAccountCycleConfig(accountId, {
      activeMinutes: Number.isFinite(activeMinutes) && activeMinutes > 0 ? activeMinutes : undefined,
      cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 ? cooldownMinutes : undefined,
    });

    res.json({
      accountId,
      status: getAccountCycleStatus(accountId),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update cycle config",
    });
  }
});

export default router;
