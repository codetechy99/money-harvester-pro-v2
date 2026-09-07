import { Router, type IRouter } from "express";
import {
  ExecuteTradeBody,
  GetEngineStatesQueryParams,
  RunEngineBody,
} from "@workspace/api-zod";
import {
  executeMetaApiTrade,
  getHistoricalCandles,
  getLiveAccountSnapshot,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  isTradingHalted,
  resolveMetaApiSymbol,
} from "../lib/metaapi";
import { runBacktest } from "../lib/backtest";
import { hasHighImpactNewsWithin } from "../lib/market";
import { analyzeSymbol, SUPPORTED_SYMBOLS } from "../lib/strategy";
import { findProfile, resolveMetaApiAccountId, supabaseRequest } from "../lib/supabase";
import { requireAuth, requireAccountOwnership } from "../middlewares/auth";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected engine error";
}

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

async function loadStates(profileId: string) {
  const rows = await supabaseRequest<Record<string, unknown>[]>("states", {
    query: {
      select: "*",
      account_id: `eq.${profileId}`,
      order: "symbol.asc",
    },
  });
  return rows.map(mapState);
}

router.get("/engine/states", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const { accountId: profileId } = GetEngineStatesQueryParams.parse(req.query);
    res.json(await loadStates(profileId));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/engine/run", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const input = RunEngineBody.parse(req.body);
    const profileId = input.accountId;
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const symbols = input.symbols.filter((symbol) =>
      (SUPPORTED_SYMBOLS as readonly string[]).includes(symbol),
    );
    if (!symbols.length) {
      res.status(400).json({ error: "No supported symbols supplied" });
      return;
    }
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const result = await analyzeSymbol(metaApiAccountId, symbol);
          await supabaseRequest("states", {
            method: "POST",
            query: { on_conflict: "account_id,symbol" },
            prefer: "resolution=merge-duplicates,return=representation",
            body: {
              account_id: profileId,
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
          return {
            accountId: profileId,
            symbol,
            currentState: result.currentState,
            htfBias: result.htfBias,
            htfConflict: result.htfConflict,
            trend: result.trend,
            poiType: result.poiType,
            poiHigh: result.poiHigh,
            poiLow: result.poiLow,
            diagnostics: result.diagnostics,
            lastUpdated: result.lastUpdated,
          };
        } catch (error) {
          return {
            accountId: profileId,
            symbol,
            currentState: "SCANNING",
            htfBias: null,
            htfConflict: false,
            trend: null,
            poiType: null,
            poiHigh: null,
            poiLow: null,
            diagnostics: [`SCANNING — ${errorMessage(error)}`],
            lastUpdated: new Date().toISOString(),
          };
        }
      }),
    );
    res.json(results);
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Add ") ? 400 : 502).json({ error: message });
  }
});

router.post("/engine/backtest", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const profileId = String(req.body?.accountId ?? "").trim();
    const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
    const timeframe = String(req.body?.timeframe ?? "5m").trim();
    const startTime = String(req.body?.startTime ?? "").trim();
    const endTime = String(req.body?.endTime ?? "").trim();
    const startingBalance = Number(req.body?.startingBalance);
    const riskPerTrade = Number(req.body?.riskPerTrade);
    const spreadPoints = Number(req.body?.spreadPoints);
    const slippagePoints = Number(req.body?.slippagePoints);
    const commissionPerLot = Number(req.body?.commissionPerLot);
    if (
      !profileId ||
      !symbol ||
      !startTime ||
      !endTime ||
      !Number.isFinite(startingBalance) ||
      startingBalance <= 0 ||
      !Number.isFinite(riskPerTrade) ||
      riskPerTrade <= 0 ||
      !Number.isFinite(spreadPoints) ||
      spreadPoints < 0 ||
      !Number.isFinite(slippagePoints) ||
      slippagePoints < 0 ||
      !Number.isFinite(commissionPerLot) ||
      commissionPerLot < 0
    ) {
      res.status(400).json({ error: "Complete backtest inputs are required; spread, slippage, and commission must be explicit" });
      return;
    }
    if (!["1m", "5m", "15m", "1h", "4h", "1d"].includes(timeframe)) {
      res.status(400).json({ error: "Unsupported backtest timeframe" });
      return;
    }
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const realSymbol = await resolveMetaApiSymbol(metaApiAccountId, symbol);
    const [candles, specification] = await Promise.all([
      getHistoricalCandles(metaApiAccountId, realSymbol, timeframe, 5000, { startTime, endTime }),
      getMetaApiSymbolSpecification(metaApiAccountId, realSymbol),
    ]);
    if (candles.length < 21) {
      res.status(409).json({ error: "Not enough real historical candles returned by MetaApi" });
      return;
    }
    res.json({
      symbol,
      realSymbol,
      timeframe,
      startTime,
      endTime,
      ...runBacktest({
        candles,
        specification,
        startingBalance,
        riskPerTrade,
        spreadPoints,
        slippagePoints,
        commissionPerLot,
      }),
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(message.startsWith("Add ") ? 400 : 502).json({ error: message });
  }
});

async function tradeGate(
  profileId: string,
  symbol: string,
  risk: Record<string, unknown>,
  positions: Array<{ symbol: string }>,
) {
  const diagnostics: string[] = [];
  if (positions.some((position) => position.symbol === symbol)) {
    diagnostics.push("Duplicate symbol blocked");
  }
  const groups = [
    ["XAUUSD", "NAS100", "US30"],
    ["EURUSD", "GBPUSD"],
  ];
  const group = groups.find((members) => members.includes(symbol));
  if (group && positions.filter((position) => group.includes(position.symbol)).length >= 2) {
    diagnostics.push("Correlated position limit reached");
  }
  const day = new Date();
  if (day.getUTCDay() === 5 && (day.getUTCHours() > 21 || (day.getUTCHours() === 21 && day.getUTCMinutes() >= 45))) {
    diagnostics.push("Friday 21:45 GMT close — no new trades");
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
  const equity = Number(risk.__equity ?? 0);
  if (equity > 0 && dayPnl <= -(equity * Number(risk.daily_loss ?? 3)) / 100) {
    diagnostics.push(`Daily loss limit reached (${risk.daily_loss ?? 3}%)`);
  }
  if (equity > 0 && weekPnl <= -(equity * Number(risk.weekly_loss ?? 6)) / 100) {
    diagnostics.push(`Weekly loss limit reached (${risk.weekly_loss ?? 6}%)`);
  }
  const news = await hasHighImpactNewsWithin(
    symbol,
    Number(risk.news_minutes ?? 30),
  );
  if (news.blocked) diagnostics.push(`High-impact news blocked: ${news.event}`);
  return diagnostics;
}

router.post("/engine/execute", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const input = ExecuteTradeBody.parse(req.body);
    const profileId = input.accountId;
    const profile = await findProfile(profileId);
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const riskRows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
      query: { select: "*", account_id: `eq.${profileId}`, limit: 1 },
    });
    const risk = riskRows[0] ?? {
      risk_per_trade: 1,
      daily_loss: 3,
      weekly_loss: 6,
      news_minutes: 30,
    };
    const live = await getLiveAccountSnapshot(metaApiAccountId, {
      brokerName: typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });
    if (isTradingHalted(profileId)) {
      res.status(409).json({ error: "Trading halted by emergency stop; reconnect and explicitly re-arm the account" });
      return;
    }
    if (!live.connected || !live.leverage || !live.equity) {
      res.status(409).json({ error: "Real broker leverage and equity are required before trading" });
      return;
    }
    const diagnostics = await tradeGate(
      profileId,
      input.symbol,
      { ...risk, __equity: live.equity },
      live.positions.filter(
        (position): position is typeof position & { symbol: string } =>
          typeof position.symbol === "string",
      ),
    );
    if (diagnostics.length) {
      res.status(409).json({ error: diagnostics.join("; ") });
      return;
    }
    const realSymbol = await resolveMetaApiSymbol(
      metaApiAccountId,
      input.symbol,
      input.realSymbol,
    );
    const [price, specification, candles] = await Promise.all([
      getMetaApiSymbolPrice(metaApiAccountId, realSymbol),
      getMetaApiSymbolSpecification(metaApiAccountId, realSymbol),
      getHistoricalCandles(metaApiAccountId, realSymbol, "15m", 40),
    ]);
    const tickTime = price.time ? new Date(price.time).getTime() : NaN;
    if (
      price.bid === null ||
      price.ask === null ||
      !Number.isFinite(tickTime) ||
      Date.now() - tickTime > 30_000
    ) {
      res.status(409).json({ error: "Live bid/ask data is missing or stale; order blocked" });
      return;
    }
    if (
      specification.tickSize === null ||
      specification.tickValue === null ||
      specification.contractSize === null ||
      specification.volumeMin === null ||
      specification.volumeMax === null ||
      specification.volumeStep === null
    ) {
      res.status(409).json({ error: "Broker symbol specification is incomplete; order blocked" });
      return;
    }
    if (specification.tradeMode && /DISABLED|CLOSEONLY/i.test(specification.tradeMode)) {
      res.status(409).json({ error: `Broker market status blocks trading: ${specification.tradeMode}` });
      return;
    }
    const entryPrice = input.direction === "BUY" ? price.ask : price.bid;
    if (input.direction === "BUY" && (input.sl >= entryPrice || input.tp <= entryPrice)) {
      res.status(409).json({ error: "BUY orders require SL below and TP above the live ask" });
      return;
    }
    if (input.direction === "SELL" && (input.sl <= entryPrice || input.tp >= entryPrice)) {
      res.status(409).json({ error: "SELL orders require SL above and TP below the live bid" });
      return;
    }
    const last = candles.slice(0, -1).at(-1);
    const averageAtr =
      candles.length > 15
        ? candles.slice(-14).reduce((sum, candle) => sum + candle.high - candle.low, 0) / 14
        : 0;
    if (!last || averageAtr <= 0) {
      res.status(409).json({ error: "Live candle data unavailable; order blocked" });
      return;
    }
    const slDistance = Math.abs(entryPrice - input.sl);
    if (slDistance < averageAtr * 0.8 || slDistance > averageAtr * 2.5) {
      res.status(409).json({
        error: `SL distance (${slDistance.toFixed(5)}) must be between 0.8 ATR (${(averageAtr * 0.8).toFixed(5)}) and 2.5 ATR (${(averageAtr * 2.5).toFixed(5)})`,
      });
      return;
    }
    const tpDistance = Math.abs(input.tp - entryPrice);
    const rewardRisk = tpDistance / slDistance;
    if (rewardRisk < 2 || rewardRisk > 3) {
      res.status(409).json({
        error: `TP must target a 1:2 to 1:3 risk-to-reward ratio (current ratio: 1:${rewardRisk.toFixed(2)})`,
      });
      return;
    }
    const spread = price.ask - price.bid;
    const maxSpread = Math.max(specification.tickSize, averageAtr * 0.1) *
      Number(risk.spread_multiplier ?? 2.5);
    if (spread > maxSpread) {
      res.status(409).json({
        error: `Current broker spread (${spread.toFixed(5)}) exceeds maximum allowed threshold (${maxSpread.toFixed(5)})`,
      });
      return;
    }
    const riskPercent = Number(risk.risk_per_trade ?? 1) / 100;
    const lossPerLot = (slDistance / specification.tickSize) * specification.tickValue;
    const requestedLot = (live.equity * riskPercent) / lossPerLot;
    const volumeStep = specification.volumeStep;
    const floorLot = (value: number) => {
      const steps = Math.floor(Math.round((value / volumeStep) * 1e8) / 1e8);
      const decimals = (volumeStep.toString().split(".")[1] || "").length;
      return Number((steps * volumeStep).toFixed(decimals));
    };
    const lot = floorLot(Math.min(input.lot, requestedLot, specification.volumeMax));
    if (lot < specification.volumeMin) {
      res.status(409).json({
        error: `Calculated lot (${lot}) is below broker minimum volume (${specification.volumeMin}); requested risk (${(riskPercent * 100).toFixed(1)}%) allows max lot ${requestedLot.toFixed(2)}`,
      });
      return;
    }
    const marginUsed = (lot * specification.contractSize * entryPrice) / live.leverage;
    if (
      (live.freeMargin !== null && marginUsed > live.freeMargin) ||
      marginUsed > live.equity * 0.5
    ) {
      res.status(409).json({ error: "Broker free-margin protection blocked this order" });
      return;
    }
    const result = await executeMetaApiTrade({
      accountId: metaApiAccountId,
      actionType: input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      symbol: realSymbol,
      volume: lot,
      stopLoss: input.sl,
      takeProfit: input.tp,
    });
    const orderId =
      typeof result.orderId === "string"
        ? result.orderId
        : typeof result.positionId === "string"
          ? result.positionId
          : null;
    const brokerPositionId =
      typeof result.positionId === "string" ? result.positionId : null;
    await supabaseRequest("journal", {
      method: "POST",
      prefer: "return=representation",
      body: {
        account_id: profileId,
        symbol: input.symbol,
        real_symbol: realSymbol,
        direction: input.direction,
        entry: entryPrice,
        sl: input.sl,
        initial_sl: input.sl,
        tp: input.tp,
        lot,
        pnl: 0,
        r_multiple: 0,
        status: "OPEN",
        broker_position_id: brokerPositionId,
        broker_order_id: typeof result.orderId === "string" ? result.orderId : null,
        broker_status: "OPEN",
        poi_type: input.poiType ?? null,
        bos_mss_tag: input.bosMssTag ?? null,
        htf_bias: null,
        leverage: live.leverage,
        margin_used: marginUsed,
      },
    });
    res.json({
      orderId,
      positionId: brokerPositionId,
      accountId: profileId,
      symbol: input.symbol,
      direction: input.direction,
      lot,
      entry: entryPrice,
      sl: input.sl,
      tp: input.tp,
      leverage: live.leverage,
      marginUsed,
      status: "OPEN",
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = message.startsWith("Add ") ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

export default router;
