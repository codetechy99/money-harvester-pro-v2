import { logger } from "./logger";
import {
  getHistoricalCandles,
  getLiveAccountSnapshot,
  getMetaApiHistoryDeals,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  moveMetaApiPositionStopToBreakEven,
  resolveMetaApiSymbol,
  type MetaApiHistoryDeal,
} from "./metaapi";
import {
  analyzeSymbol,
  evaluateTradeRisk,
  runPostExecutionPipeline,
  SUPPORTED_SYMBOLS,
} from "./strategy";
import { findProfile, hasSupabaseConfig, supabaseRequest } from "./supabase";

let running = false;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

type JournalRow = Record<string, unknown> & {
  id?: string;
  broker_position_id?: string | null;
  broker_order_id?: string | null;
  symbol?: string;
  real_symbol?: string | null;
  direction?: string;
  entry?: number | null;
  sl?: number | null;
  initial_sl?: number | null;
  lot?: number | null;
  status?: string;
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameNumber(left: unknown, right: unknown) {
  const a = numberValue(left);
  const b = numberValue(right);
  return a === b || (a !== null && b !== null && Math.abs(a - b) < 0.00000001);
}

function directionMatches(direction: unknown, positionType: string) {
  const normalizedDirection = String(direction ?? "").toUpperCase();
  const normalizedType = positionType.toUpperCase();
  return normalizedType.includes(normalizedDirection === "SELL" ? "SELL" : "BUY");
}

function findLivePosition(
  row: JournalRow,
  positions: Awaited<ReturnType<typeof getLiveAccountSnapshot>>["positions"],
) {
  if (row.broker_position_id) {
    return positions.find((position) => position.id === row.broker_position_id);
  }

  const candidates = positions.filter((position) => {
    if (
      position.symbol !== (row.real_symbol || row.symbol) ||
      !position.type ||
      !directionMatches(row.direction, position.type)
    ) {
      return false;
    }
    const entry = numberValue(row.entry);
    const lot = numberValue(row.lot);
    return (
      entry !== null &&
      position.openPrice !== null &&
      position.volume !== null &&
      Math.abs(position.openPrice - entry) < 0.0005 &&
      (lot === null || Math.abs(position.volume - lot) < 0.000001)
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isClosingDeal(deal: MetaApiHistoryDeal) {
  if (!deal.entryType) return false;
  const entry = deal.entryType.toUpperCase();
  return entry.includes("OUT") || entry.includes("CLOSE");
}

function findClosingDeals(row: JournalRow, deals: MetaApiHistoryDeal[]) {
  if (!row.broker_position_id && !row.broker_order_id) return [];
  return deals.filter(
    (deal) =>
      isClosingDeal(deal) &&
      ((row.broker_position_id && deal.positionId === row.broker_position_id) ||
        (row.broker_order_id && deal.orderId === row.broker_order_id)),
  );
}

function findPositionIdFromOrder(row: JournalRow, deals: MetaApiHistoryDeal[]) {
  if (row.broker_position_id || !row.broker_order_id) {
    return row.broker_position_id ?? null;
  }
  return (
    deals.find(
      (deal) =>
        deal.orderId === row.broker_order_id && typeof deal.positionId === "string",
    )?.positionId ?? null
  );
}

function realizedPnl(deals: MetaApiHistoryDeal[]) {
  return deals.reduce(
    (total, deal) =>
      total +
      (deal.profit ?? 0) +
      (deal.swap ?? 0) +
      (deal.commission ?? 0) +
      (deal.fee ?? 0),
    0,
  );
}

function rMultiple(row: JournalRow, deals: MetaApiHistoryDeal[]) {
  const entry = numberValue(row.entry);
  const initialStop = numberValue(row.initial_sl) ?? numberValue(row.sl);
  const risk = entry !== null && initialStop !== null ? Math.abs(entry - initialStop) : 0;
  if (entry === null || risk <= 0) return null;

  const pricedDeals = deals.filter(
    (deal): deal is MetaApiHistoryDeal & { price: number } =>
      typeof deal.price === "number" && (deal.volume ?? 0) > 0,
  );
  if (!pricedDeals.length) return null;
  const totalVolume = pricedDeals.reduce((sum, deal) => sum + (deal.volume ?? 0), 0);
  const exitPrice =
    pricedDeals.reduce(
      (sum, deal) => sum + (deal.price ?? 0) * (deal.volume ?? 0),
      0,
    ) / totalVolume;
  const direction = String(row.direction ?? "").toUpperCase();
  return Number(
    ((direction === "SELL" ? entry - exitPrice : exitPrice - entry) / risk).toFixed(4),
  );
}

function shouldMoveToBreakEven(
  row: JournalRow,
  position: Awaited<ReturnType<typeof getLiveAccountSnapshot>>["positions"][number],
) {
  const entry = numberValue(row.entry);
  const initialStop = numberValue(row.initial_sl) ?? numberValue(row.sl);
  const currentPrice = numberValue(position.currentPrice);
  if (entry === null || initialStop === null || currentPrice === null) return false;
  const risk = Math.abs(entry - initialStop);
  if (risk <= 0) return false;
  const direction = String(row.direction ?? "").toUpperCase();
  const r = direction === "SELL" ? (entry - currentPrice) / risk : (currentPrice - entry) / risk;
  if (r < 1) return false;
  if (position.stopLoss === null) return true;
  return direction === "SELL" ? position.stopLoss > entry : position.stopLoss < entry;
}

function hasChanges(row: JournalRow, patch: Record<string, unknown>) {
  return Object.entries(patch).some(([key, value]) => {
    if (key === "broker_updated_at") return true;
    if (!(key in row)) return true;
    return typeof value === "number"
      ? !sameNumber(row[key], value)
      : row[key] !== value;
  });
}

async function patchJournalRow(row: JournalRow, patch: Record<string, unknown>) {
  if (!row.id || !hasChanges(row, patch)) return false;
  await supabaseRequest("journal", {
    method: "PATCH",
    query: { id: `eq.${row.id}` },
    body: { ...patch, broker_updated_at: new Date().toISOString() },
  });
  return true;
}

export async function reconcileAccountJournal(
  accountId: string,
  metaApiAccountId: string,
  metadata: { brokerName?: string; server?: string } = {},
) {
  const live = await getLiveAccountSnapshot(metaApiAccountId, metadata);
  await supabaseRequest("profiles", {
    method: "PATCH",
    query: { id: `eq.${accountId}` },
    body: {
      balance: live.balance,
      equity: live.equity,
      leverage: live.leverage,
    },
  });
  if (live.balance !== null && live.equity !== null) {
    await supabaseRequest("equity_history", {
      method: "POST",
      body: { account_id: accountId, balance: live.balance, equity: live.equity },
    });
  }

  const openRows = await supabaseRequest<JournalRow[]>("journal", {
    query: {
      select: "*",
      account_id: `eq.${accountId}`,
      status: "eq.OPEN",
      order: "created_at.asc",
      limit: 500,
    },
  });
  let deals: MetaApiHistoryDeal[] = [];
  if (openRows.length) {
    try {
      deals = await getMetaApiHistoryDeals(metaApiAccountId);
    } catch (error) {
      logger.warn(
        { accountId, metaApiAccountId, error },
        "MetaApi history deals unavailable; open journal rows remain pending reconciliation",
      );
    }
  }
  let updated = 0;
  let closed = 0;
  let breakEvenMoves = 0;

  for (const row of openRows) {
    const position = findLivePosition(row, live.positions);
    if (position) {
      if (shouldMoveToBreakEven(row, position) && position.id) {
        const entryPrice = numberValue(row.entry) ?? position.openPrice;
        if (entryPrice === null) continue;
        await moveMetaApiPositionStopToBreakEven({
          accountId: metaApiAccountId,
          positionId: position.id,
          entryPrice,
          takeProfit: position.takeProfit,
        });
        breakEvenMoves += 1;
      }
      const patch: Record<string, unknown> = {
        broker_position_id: row.broker_position_id ?? position.id,
        broker_status: "OPEN",
        initial_sl: row.initial_sl ?? row.sl ?? null,
        pnl:
          position.profit === null && position.swap === null
            ? row.pnl ?? 0
            : (position.profit ?? 0) + (position.swap ?? 0),
        sl: position.stopLoss ?? row.sl ?? null,
        tp: position.takeProfit ?? row.tp ?? null,
        status: "OPEN",
      };
      if (await patchJournalRow(row, patch)) updated += 1;
      continue;
    }

    const recoveredPositionId = findPositionIdFromOrder(row, deals);
    const rowWithPositionId = recoveredPositionId
      ? { ...row, broker_position_id: recoveredPositionId }
      : row;
    const closingDeals = findClosingDeals(rowWithPositionId, deals);
    if (!closingDeals.length) continue;
    const latestClose = closingDeals
      .map((deal) => deal.time)
      .filter((time): time is string => Boolean(time))
      .sort()
      .at(-1);
    const patch: Record<string, unknown> = {
      status: "CLOSED",
      broker_status: "CLOSED",
      broker_position_id: recoveredPositionId,
      pnl: realizedPnl(closingDeals),
      r_multiple: rMultiple(rowWithPositionId, closingDeals),
      closed_at: latestClose ?? new Date().toISOString(),
    };
    if (await patchJournalRow(row, patch)) {
      updated += 1;
      closed += 1;
    }
  }

  return { account: live, updated, closed, breakEvenMoves };
}

async function runScheduledAnalysis() {
  if (running || !hasSupabaseConfig() || !process.env.METAAPI_TOKEN) return;
  running = true;
  try {
    const profiles = await supabaseRequest<
      Array<{ id?: string; metaapi_account_id?: string }>
    >("profiles", {
      query: { select: "id,metaapi_account_id", limit: 100 },
    });
    await Promise.all(
      profiles
        .filter(
          (profile): profile is { id: string; metaapi_account_id: string } =>
            typeof profile.id === "string" &&
            typeof profile.metaapi_account_id === "string",
        )
        .map(async (profile) => {
          await Promise.all(
            SUPPORTED_SYMBOLS.map(async (symbol) => {
              try {
                const result = await analyzeSymbol(profile.id, symbol);
                await supabaseRequest("states", {
                  method: "POST",
                  query: { on_conflict: "account_id,symbol" },
                  prefer: "resolution=merge-duplicates,return=representation",
                  body: {
                    account_id: profile.id,
                    symbol,
                    current_state: result.currentState,
                    liquidity_pool: result.liquidityPool,
                    poi: result.poi,
                    diagnostics_log: result.diagnostics,
                    htf_bias: result.htfBias,
                    htf_conflict: result.htfConflict,
                    updated_at: result.lastUpdated,
                  },
                });

                // Automated execution trigger check if state is EXECUTABLE and M1 micro confirmation is satisfied
                if (result.currentState === "EXECUTABLE" && result.m1Triggered && result.poi) {
                  const dbProfile = await findProfile(profile.id);
                  const riskRows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
                    query: { select: "*", account_id: `eq.${profile.id}`, limit: 1 },
                  });
                  const risk = riskRows[0] ?? {};
                  const live = await getLiveAccountSnapshot(profile.metaapi_account_id);
                  const realSymbol = result.realSymbol;
                  const [price, spec, candles] = await Promise.all([
                    getMetaApiSymbolPrice(profile.metaapi_account_id, realSymbol),
                    getMetaApiSymbolSpecification(profile.metaapi_account_id, realSymbol),
                    getHistoricalCandles(profile.metaapi_account_id, realSymbol, "15m", 40),
                  ]);

                  const direction: "BUY" | "SELL" = result.m1Direction ?? (result.poi.type === "OB_BULL" ? "BUY" : "SELL");
                  const entryPrice = direction === "BUY" ? price.ask : price.bid;

                  if (entryPrice !== null) {
                    const sl = direction === "BUY" ? result.poi.low : result.poi.high;
                    const slDist = Math.abs(entryPrice - sl);
                    const tp = direction === "BUY" ? entryPrice + slDist * 2.5 : entryPrice - slDist * 2.5;

                    const riskEval = await evaluateTradeRisk({
                      accountId: profile.id,
                      symbol,
                      realSymbol,
                      direction,
                      entryPrice,
                      sl,
                      tp,
                      profileMetrics: {
                        startingBalance: Number(dbProfile?.starting_balance ?? dbProfile?.balance ?? live.balance),
                        highestEquity: Number(dbProfile?.highest_equity ?? live.equity),
                        dailyStartingEquity: Number(dbProfile?.daily_starting_equity ?? live.equity),
                        maxDrawdownPct: Number(dbProfile?.max_drawdown_pct ?? 10),
                        dailyDrawdownPct: Number(dbProfile?.daily_drawdown_pct ?? 5),
                      },
                      riskSettings: {
                        riskPerTrade: Number(risk.risk_per_trade ?? 1),
                        dailyLoss: Number(risk.daily_loss ?? 3),
                        weeklyLoss: Number(risk.weekly_loss ?? 6),
                        spreadMultiplier: Number(risk.spread_multiplier ?? 2.5),
                        newsMinutes: Number(risk.news_minutes ?? 30),
                      },
                      liveAccount: live,
                      symbolSpec: spec,
                      symbolPrice: price,
                      recentCandles: candles,
                    });

                    if (riskEval.approved && riskEval.calculatedLot && riskEval.marginUsed) {
                      await runPostExecutionPipeline({
                        accountId: profile.id,
                        symbol,
                        realSymbol,
                        direction,
                        entryPrice,
                        sl,
                        tp,
                        lot: riskEval.calculatedLot,
                        poiType: result.poi.type,
                        bosMssTag: "AUTOMATED_M1_TRIGGER",
                        leverage: live.leverage!,
                        marginUsed: riskEval.marginUsed,
                      });
                      logger.info({ accountId: profile.id, symbol }, "Automated M1 trade execution completed successfully");
                    } else {
                      logger.info({ accountId: profile.id, symbol, reason: riskEval.reason }, "Automated trade risk evaluation rejected candidate setup");
                    }
                  }
                }
              } catch (error) {
                logger.warn(
                  { accountId: profile.id, symbol, error },
                  "Scheduled strategy pass failed",
                );
              }
            }),
          );
          try {
            const result = await reconcileAccountJournal(
              profile.id,
              profile.metaapi_account_id,
            );
            if (result.updated || result.breakEvenMoves) {
              logger.info(
                {
                  accountId: profile.id,
                  updated: result.updated,
                  closed: result.closed,
                  breakEvenMoves: result.breakEvenMoves,
                },
                "Broker journal reconciliation completed",
              );
            }
          } catch (error) {
            logger.warn(
              { accountId: profile.id, error },
              "Broker journal reconciliation failed",
            );
          }
        }),
    );
  } catch (error) {
    logger.warn({ error }, "Scheduled strategy pass failed");
  } finally {
    running = false;
  }
}

export function startEngineScheduler() {
  void runScheduledAnalysis();
  schedulerTimer = setInterval(() => void runScheduledAnalysis(), 60_000);
  schedulerTimer.unref?.();
}

export function stopEngineScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  }
}