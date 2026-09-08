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
  resolveMetaApiSymbol,
} from "../lib/metaapi";
import { runBacktest } from "../lib/backtest";
import {
  analyzeSymbol,
  evaluateTradeRisk,
  runPostExecutionPipeline,
  SUPPORTED_SYMBOLS,
} from "../lib/strategy";
import {
  findProfile,
  saveState,
  selectRiskSettings,
  selectStates,
} from "../lib/db";

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
  const rows = await selectStates(accountId);
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
          await saveState({
            account_id: input.accountId,
            symbol,
            current_state: result.currentState,
            liquidity_pool: result.liquidityPool,
            poi: result.poi,
            diagnostics_log: result.diagnostics,
            htf_bias: result.htfBias,
            htf_conflict: result.htfConflict,
            updated_at: result.lastUpdated,
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
    const risk = (await selectRiskSettings(input.accountId)) ?? {
      risk_per_trade: 1,
      daily_loss: 3,
      weekly_loss: 6,
      news_minutes: 30,
      spread_multiplier: 2.5,
    };
    const live = await getLiveAccountSnapshot(input.accountId, {
      brokerName: typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });
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

    const entryPrice = input.direction === "BUY" ? price.ask : price.bid;
    if (entryPrice === null) {
      res.status(409).json({ error: "Live ask/bid price is null; order blocked" });
      return;
    }

    const riskEval = await evaluateTradeRisk({
      accountId: input.accountId,
      symbol: input.symbol,
      realSymbol,
      direction: input.direction,
      entryPrice,
      sl: input.sl,
      tp: input.tp,
      requestedLot: input.lot,
      profileMetrics: {
        startingBalance: Number(profile?.starting_balance ?? profile?.balance ?? live.balance),
        highestEquity: Number(profile?.highest_equity ?? live.equity),
        dailyStartingEquity: Number(profile?.daily_starting_equity ?? live.equity),
        maxDrawdownPct: Number(profile?.max_drawdown_pct ?? 10),
        dailyDrawdownPct: Number(profile?.daily_drawdown_pct ?? 5),
      },
      riskSettings: {
        riskPerTrade: Number(risk.risk_per_trade ?? 1),
        dailyLoss: Number(risk.daily_loss ?? 3),
        weeklyLoss: Number(risk.weekly_loss ?? 6),
        spreadMultiplier: Number(risk.spread_multiplier ?? 2.5),
        newsMinutes: Number(risk.news_minutes ?? 30),
      },
      liveAccount: live,
      symbolSpec: specification,
      symbolPrice: price,
      recentCandles: candles,
    });

    if (!riskEval.approved || !riskEval.calculatedLot || !riskEval.marginUsed) {
      res.status(409).json({ error: riskEval.reason ?? "Trade risk evaluation rejected order" });
      return;
    }

    const pipelineResult = await runPostExecutionPipeline({
      accountId: input.accountId,
      symbol: input.symbol,
      realSymbol,
      direction: input.direction,
      entryPrice,
      sl: input.sl,
      tp: input.tp,
      lot: riskEval.calculatedLot,
      poiType: input.poiType ?? null,
      bosMssTag: input.bosMssTag ?? null,
      leverage: live.leverage!,
      marginUsed: riskEval.marginUsed,
    });

    res.json(pipelineResult);
  } catch (error) {
    const message = errorMessage(error);
    const status = message.startsWith("Add ") ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

export default router;