import { logger } from "./logger";
import {
  executeMetaApiTrade,
  getHistoricalCandles,
  getLiveAccountSnapshot,
  getMetaApiHistoryDeals,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  isTradingHalted,
  moveMetaApiPositionStopToBreakEven,
  resolveMetaApiSymbol,
  type MetaApiHistoryDeal,
} from "./metaapi";
import { analyzeSymbol, SUPPORTED_SYMBOLS } from "./strategy";
import { hasHighImpactNewsWithin } from "./market";
import { findProfile, hasSupabaseConfig, supabaseRequest } from "./supabase";

let running = false;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

type JournalRow = Record<string, unknown> & {
  id?: string;
  account_id?: string;
  symbol?: string;
  real_symbol?: string | null;
  direction?: string;
  entry?: number | null;
  sl?: number | null;
  initial_sl?: number | null;
  lot?: number | null;
  status?: string;
  created_at?: string;
  broker_position_id?: string | null;
  broker_order_id?: string | null;
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
    const priceTolerance = entry !== null ? Math.max(0.0005, entry * 0.001) : 0.0005;
    return (
      entry !== null &&
      position.openPrice !== null &&
      position.volume !== null &&
      Math.abs(position.openPrice - entry) < priceTolerance &&
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
  profileId: string,
  metaApiAccountId: string,
  metadata: { brokerName?: string; server?: string } = {},
) {
  const live = await getLiveAccountSnapshot(metaApiAccountId, metadata);
  await supabaseRequest("profiles", {
    method: "PATCH",
    query: { id: `eq.${profileId}` },
    body: {
      balance: live.balance,
      equity: live.equity,
      leverage: live.leverage,
    },
  });
  if (live.balance !== null && live.equity !== null) {
    await supabaseRequest("equity_history", {
      method: "POST",
      body: { account_id: profileId, balance: live.balance, equity: live.equity },
    });
  }

  const openRows = await supabaseRequest<JournalRow[]>("journal", {
    query: {
      select: "*",
      account_id: `eq.${profileId}`,
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
        { profileId, metaApiAccountId, error },
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
        if (entryPrice !== null) {
          await moveMetaApiPositionStopToBreakEven({
            accountId: metaApiAccountId,
            positionId: position.id,
            entryPrice,
            takeProfit: position.takeProfit,
          });
          breakEvenMoves += 1;
        }
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

async function checkIdempotency(
  profileId: string,
  symbol: string,
  candleTimestamp: string,
  direction: "BUY" | "SELL",
): Promise<boolean> {
  const existingRows = await supabaseRequest<JournalRow[]>("journal", {
    query: {
      select: "*",
      account_id: `eq.${profileId}`,
      symbol: `eq.${symbol}`,
      direction: `eq.${direction}`,
      order: "created_at.desc",
      limit: 20,
    },
  });

  const nowMs = new Date(candleTimestamp).getTime();
  return existingRows.some((row) => {
    if (row.status === "OPEN") return true; // Block if open position exists
    const createdAtMs = new Date(String(row.created_at)).getTime();
    return Math.abs(nowMs - createdAtMs) < 15 * 60 * 1000; // Block if executed in same M15 bar
  });
}

async function recordGateDiagnosticAndState(
  profileId: string,
  symbol: string,
  analysis: Awaited<ReturnType<typeof analyzeSymbol>>,
  gateReason: string,
  logLevel: "info" | "warn" = "info",
) {
  const updatedDiagnostics = [...analysis.diagnostics, `GATE REJECT: ${gateReason}`];
  if (logLevel === "warn") {
    logger.warn({ profileId, symbol, reason: gateReason }, `Autonomous trade blocked — ${gateReason}`);
  } else {
    logger.info({ profileId, symbol, reason: gateReason }, `Autonomous trade skipped — ${gateReason}`);
  }
  await supabaseRequest("states", {
    method: "POST",
    query: { on_conflict: "account_id,symbol" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      account_id: profileId,
      symbol,
      current_state: analysis.currentState,
      liquidity_pool: analysis.liquidityPool,
      poi: analysis.poi,
      diagnostics_log: updatedDiagnostics,
      htf_bias: analysis.htfBias,
      htf_conflict: analysis.htfConflict,
      updated_at: new Date().toISOString(),
    },
  });
}

export async function evaluateAndAutoExecuteTrade(
  profileId: string,
  metaApiAccountId: string,
  symbol: string,
) {
  if (isTradingHalted(profileId) || isTradingHalted(metaApiAccountId)) {
    logger.info({ profileId, metaApiAccountId, symbol }, "Autonomous trade skipped — trading is halted");
    return;
  }

  const analysis = await analyzeSymbol(metaApiAccountId, symbol);

  await supabaseRequest("states", {
    method: "POST",
    query: { on_conflict: "account_id,symbol" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      account_id: profileId,
      symbol,
      current_state: analysis.currentState,
      liquidity_pool: analysis.liquidityPool,
      poi: analysis.poi,
      diagnostics_log: analysis.diagnostics,
      htf_bias: analysis.htfBias,
      htf_conflict: analysis.htfConflict,
      updated_at: analysis.lastUpdated,
    },
  });

  if (analysis.scoreAction === "REJECT" || analysis.setupScore < 55 || !analysis.direction || !analysis.suggestedSl || !analysis.suggestedTp) {
    logger.info(
      { profileId, symbol, setupScore: analysis.setupScore, scoreAction: analysis.scoreAction, direction: analysis.direction },
      "Autonomous trade skipped — setup score rejected or missing trade parameters",
    );
    return;
  }

  if (await checkIdempotency(profileId, symbol, analysis.candleTimestamp, analysis.direction)) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Idempotency block (trade already executed in current M15 bar or open position exists)");
    return;
  }

  const riskRows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
    query: { select: "*", account_id: `eq.${profileId}`, limit: 1 },
  });
  const risk = riskRows[0] ?? {
    risk_per_trade: 1,
    daily_loss: 3,
    weekly_loss: 6,
    news_minutes: 30,
  };

  const profile = await findProfile(profileId);
  const live = await getLiveAccountSnapshot(metaApiAccountId, {
    brokerName: typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
    server: typeof profile?.server === "string" ? profile.server : undefined,
  });

  if (!live.connected || !live.leverage || !live.equity) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Broker account disconnected or missing leverage/equity");
    return;
  }

  if (live.positions.some((pos) => pos.symbol === symbol)) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, `Position already open for symbol ${symbol}`);
    return;
  }

  const groups = [
    ["XAUUSD", "NAS100", "US30"],
    ["EURUSD", "GBPUSD"],
  ];
  const group = groups.find((members) => members.includes(symbol));
  if (group) {
    const activeGroupPositions = live.positions.filter((pos) => pos.symbol && group.includes(pos.symbol));
    if (activeGroupPositions.length >= 2) {
      await recordGateDiagnosticAndState(profileId, symbol, analysis, `Correlated position limit reached for group [${group.join(", ")}]`);
      return;
    }
  }

  const journalRows = await supabaseRequest<Record<string, unknown>[]>("journal", {
    query: {
      select: "pnl,status,created_at",
      account_id: `eq.${profileId}`,
      status: "eq.CLOSED",
      order: "created_at.desc",
      limit: 500,
    },
  });
  const now = Date.now();
  const dayPnl = journalRows
    .filter((row) => now - new Date(String(row.created_at ?? 0)).getTime() <= 86_400_000)
    .reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
  const weekPnl = journalRows
    .filter((row) => now - new Date(String(row.created_at ?? 0)).getTime() <= 7 * 86_400_000)
    .reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);

  if (live.equity > 0 && dayPnl <= -(live.equity * Number(risk.daily_loss ?? 3)) / 100) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, `Daily drawdown loss limit reached (${risk.daily_loss ?? 3}%)`);
    return;
  }

  if (live.equity > 0 && weekPnl <= -(live.equity * Number(risk.weekly_loss ?? 6)) / 100) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, `Weekly drawdown loss limit reached (${risk.weekly_loss ?? 6}%)`);
    return;
  }

  const day = new Date();
  if (day.getUTCDay() === 5 && (day.getUTCHours() > 21 || (day.getUTCHours() === 21 && day.getUTCMinutes() >= 45))) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Friday 21:45 GMT close filter active — no new trades allowed");
    return;
  }

  const news = await hasHighImpactNewsWithin(symbol, Number(risk.news_minutes ?? 30));
  if (news.blocked) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, `Blocked by high-impact news filter: ${news.event}`);
    return;
  }

  const realSymbol = await resolveMetaApiSymbol(metaApiAccountId, symbol);
  const [price, specification] = await Promise.all([
    getMetaApiSymbolPrice(metaApiAccountId, realSymbol),
    getMetaApiSymbolSpecification(metaApiAccountId, realSymbol),
  ]);

  if (!price.bid || !price.ask || !specification.tickSize || !specification.tickValue) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Broker live price or symbol specification incomplete");
    return;
  }

  if (specification.tradeMode && /DISABLED|CLOSEONLY/i.test(specification.tradeMode)) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, `Broker trade mode blocks new orders: ${specification.tradeMode}`);
    return;
  }

  const entryPrice = analysis.direction === "BUY" ? price.ask : price.bid;
  const slDistance = Math.abs(entryPrice - analysis.suggestedSl);
  if (slDistance <= 0) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Invalid stop loss distance <= 0");
    return;
  }

  const maxConfiguredRiskPercent = Number(risk.risk_per_trade ?? 1);
  const effectiveRiskPercent =
    analysis.scoreAction === "REDUCED_RISK"
      ? Math.min(maxConfiguredRiskPercent, maxConfiguredRiskPercent * 0.5)
      : maxConfiguredRiskPercent;

  const lossPerLot = (slDistance / specification.tickSize) * specification.tickValue;
  if (lossPerLot <= 0) {
    await recordGateDiagnosticAndState(profileId, symbol, analysis, "Invalid calculated loss per lot <= 0");
    return;
  }

  const monetaryRisk = live.equity * (effectiveRiskPercent / 100);
  const volumeStep = specification.volumeStep ?? 0.01;
  const rawLot = monetaryRisk / lossPerLot;
  const lot = Math.floor(rawLot / volumeStep) * volumeStep;

  if (lot < (specification.volumeMin ?? 0.01) || lot > (specification.volumeMax ?? 100)) {
    await recordGateDiagnosticAndState(
      profileId,
      symbol,
      analysis,
      `Calculated lot size (${lot}) outside broker limits [min: ${specification.volumeMin ?? 0.01}, max: ${specification.volumeMax ?? 100}]`,
      "warn",
    );
    return;
  }

  const contractSize = specification.contractSize ?? 100000;
  const marginUsed = (lot * contractSize * entryPrice) / live.leverage;
  if ((live.freeMargin !== null && marginUsed > live.freeMargin) || marginUsed > live.equity * 0.5) {
    await recordGateDiagnosticAndState(
      profileId,
      symbol,
      analysis,
      `Free margin protection blocked order (Margin required: ${marginUsed.toFixed(2)}, Free margin: ${live.freeMargin})`,
      "warn",
    );
    return;
  }

  const orderResult = await executeMetaApiTrade({
    accountId: metaApiAccountId,
    actionType: analysis.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    symbol: realSymbol,
    volume: lot,
    stopLoss: analysis.suggestedSl,
    takeProfit: analysis.suggestedTp,
  });

  const brokerPositionId = typeof orderResult.positionId === "string" ? orderResult.positionId : null;
  const brokerOrderId = typeof orderResult.orderId === "string" ? orderResult.orderId : null;

  await supabaseRequest("journal", {
    method: "POST",
    prefer: "return=representation",
    body: {
      account_id: profileId,
      symbol,
      real_symbol: realSymbol,
      direction: analysis.direction,
      entry: entryPrice,
      sl: analysis.suggestedSl,
      initial_sl: analysis.suggestedSl,
      tp: analysis.suggestedTp,
      lot,
      pnl: 0,
      r_multiple: 0,
      status: "OPEN",
      broker_position_id: brokerPositionId,
      broker_order_id: brokerOrderId,
      broker_status: "OPEN",
      poi_type: analysis.poiType,
      bos_mss_tag: analysis.poi?.type,
      htf_bias: analysis.htfBias,
      leverage: live.leverage,
      margin_used: marginUsed,
    },
  });

  logger.info(
    { profileId, metaApiAccountId, symbol, direction: analysis.direction, lot, entry: entryPrice, setupScore: analysis.setupScore },
    "Autonomous trade successfully executed",
  );
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
                await evaluateAndAutoExecuteTrade(
                  profile.id,
                  profile.metaapi_account_id,
                  symbol,
                );
              } catch (error) {
                logger.warn(
                  { profileId: profile.id, symbol, error },
                  "Scheduled trade evaluation failed",
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
                  profileId: profile.id,
                  updated: result.updated,
                  closed: result.closed,
                  breakEvenMoves: result.breakEvenMoves,
                },
                "Broker journal reconciliation completed",
              );
            }
          } catch (error) {
            logger.warn(
              { profileId: profile.id, error },
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
