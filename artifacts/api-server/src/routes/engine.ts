import { Router, type IRouter } from "express";
import {
  ExecuteTradeBody,
  GetEngineStatesQueryParams,
  RunEngineBody,
} from "@workspace/api-zod";
import {
  getHistoricalCandles,
  getLiveAccountSnapshot,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  isTradingHalted,
  resolveMetaApiSymbol,
} from "../lib/metaapi";
import { runBacktest } from "../lib/backtest";
import { evaluateTradeRisk } from "../lib/risk-engine";
import { runPostExecutionPipeline } from "../lib/execution-pipeline";
import { analyzeSymbol, SUPPORTED_SYMBOLS } from "../lib/strategy";
import { findProfile, supabaseRequest } from "../lib/supabase";

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

async function loadStates(accountId: string) {
  const rows = await supabaseRequest<Record<string, unknown>[]>("states", {
    query: {
      select: "*",
      account_id: `eq.${accountId}`,
      order: "symbol.asc",
    },
  });
  return rows.map(mapState);
}

router.get("/engine/states", async (req, res) => {
  try {
    const { accountId } = GetEngineStatesQueryParams.parse(req.query);
    res.json(await loadStates(accountId));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/engine/run", async (req, res) => {
  try {
    const input = RunEngineBody.parse(req.body);
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
          const result = await analyzeSymbol(input.accountId, symbol);
          await supabaseRequest("states", {
            method: "POST",
            query: { on_conflict: "account_id,symbol" },
            prefer: "resolution=merge-duplicates,return=representation",
            body: {
              account_id: input.accountId,
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
            accountId: input.accountId,
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
            accountId: input.accountId,
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

router.post("/engine/backtest", async (req, res) => {
  try {
    const accountId = String(req.body?.accountId ?? "").trim();
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
      !accountId ||
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
    const realSymbol = await resolveMetaApiSymbol(accountId, symbol);
    const [candles, specification] = await Promise.all([
      getHistoricalCandles(accountId, realSymbol, timeframe, 5000, { startTime, endTime }),
      getMetaApiSymbolSpecification(accountId, realSymbol),
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

router.post("/engine/execute", async (req, res) => {
  try {
    const input = ExecuteTradeBody.parse(req.body);
    const profile = await findProfile(input.accountId);
    const riskRows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
      query: { select: "*", account_id: `eq.${input.accountId}`, limit: 1 },
    });
    const riskRow = riskRows[0] ?? {};
    const riskSettings = {
      riskPerTrade: Number(riskRow.risk_per_trade ?? 1),
      dailyLoss: Number(riskRow.daily_loss ?? 3),
      weeklyLoss: Number(riskRow.weekly_loss ?? 6),
      spreadMultiplier: Number(riskRow.spread_multiplier ?? 2.5),
      newsMinutes: Number(riskRow.news_minutes ?? 30),
    };

    if (isTradingHalted(input.accountId)) {
      res.status(409).json({ error: "Trading halted by emergency stop; reconnect and explicitly re-arm the account" });
      return;
    }

    const live = await getLiveAccountSnapshot(input.accountId, {
      brokerName: typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });

    if (!live.connected || !live.leverage || !live.equity || !live.balance) {
      res.status(409).json({ error: "Real broker connection, leverage, balance, and equity are required before trading" });
      return;
    }

    const realSymbol = await resolveMetaApiSymbol(
      input.accountId,
      input.symbol,
      input.realSymbol,
    );

    const [price, specification, candles] = await Promise.all([
      getMetaApiSymbolPrice(input.accountId, realSymbol),
      getMetaApiSymbolSpecification(input.accountId, realSymbol),
      getHistoricalCandles(input.accountId, realSymbol, "15m", 40),
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

    const averageAtr =
      candles.length > 15
        ? candles.slice(-14).reduce((sum, candle) => sum + candle.high - candle.low, 0) / 14
        : 0;

    const spread = price.ask - price.bid;
    const maxSpread = Math.max(specification.tickSize, averageAtr * 0.1) *
      riskSettings.spreadMultiplier;

    // Authoritative Pre-Trade Risk Gate Call
    const riskCheck = await evaluateTradeRisk({
      accountId: input.accountId,
      symbol: input.symbol,
      direction: input.direction,
      equity: live.equity,
      balance: live.balance,
      freeMargin: live.freeMargin,
      openPositions: live.positions.map((p) => ({
        id: p.id ?? undefined,
        symbol: p.symbol ?? input.symbol,
        volume: p.volume,
        openPrice: p.openPrice,
      })),
      spreadInfo: {
        currentSpread: spread,
        maxAllowedSpread: maxSpread,
      },
      riskSettings,
    });

    if (!riskCheck.passed) {
      res.status(409).json({ error: riskCheck.violations.join("; ") });
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

    const slDistance = Math.abs(entryPrice - input.sl);
    if (slDistance < averageAtr * 0.8 || slDistance > averageAtr * 2.5) {
      res.status(409).json({ error: "SL distance must be between 0.8 ATR and 2.5 ATR" });
      return;
    }

    const tpDistance = Math.abs(input.tp - entryPrice);
    const rewardRisk = tpDistance / slDistance;
    if (rewardRisk < 2 || rewardRisk > 3) {
      res.status(409).json({ error: "TP must target a 1:2 to 1:3 risk-to-reward ratio" });
      return;
    }

    const effectiveRiskPercent = (riskSettings.riskPerTrade / 100) * riskCheck.riskMultiplier;
    const lossPerLot = (slDistance / specification.tickSize) * specification.tickValue;
    const requestedLot = (live.equity * effectiveRiskPercent) / lossPerLot;
    const volumeStep = specification.volumeStep;
    const floorLot = (value: number) =>
      Math.floor(value / volumeStep) * volumeStep;
    const lot = floorLot(Math.min(input.lot, requestedLot, specification.volumeMax));

    if (lot < specification.volumeMin) {
      res.status(409).json({ error: "Broker minimum volume would exceed the configured risk" });
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

    // Route order through runPostExecutionPipeline
    const pipelineResult = await runPostExecutionPipeline({
      accountId: input.accountId,
      symbol: input.symbol,
      realSymbol,
      direction: input.direction,
      lot,
      sl: input.sl,
      tp: input.tp,
      poiType: input.poiType ?? undefined,
      bosMssTag: input.bosMssTag ?? undefined,
      leverage: live.leverage,
      marginUsed,
    });

    if (!pipelineResult.success) {
      res.status(502).json({ error: pipelineResult.error ?? "Order execution pipeline failed" });
      return;
    }

    res.json({
      orderId: pipelineResult.orderId,
      positionId: pipelineResult.positionId,
      accountId: input.accountId,
      symbol: input.symbol,
      direction: input.direction,
      lot,
      entry: entryPrice,
      sl: input.sl,
      tp: input.tp,
      leverage: live.leverage,
      marginUsed,
      slVerified: pipelineResult.slVerified,
      tpVerified: pipelineResult.tpVerified,
      status: "OPEN",
      logs: pipelineResult.logs,
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = message.startsWith("Add ") ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

export default router;
