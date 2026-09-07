import type { Candle, MetaApiSymbolSpecification } from "./metaapi";
import {
  atr,
  calculateSetupScore,
  detectBosMss,
  detectPoi,
  detectSwings,
  evaluateLiquiditySweeps,
  evaluateM5Confirmation,
  findPools,
} from "./strategy";

export type BacktestTrade = {
  direction: "BUY" | "SELL";
  entryTime: string;
  exitTime: string | null;
  entry: number;
  exit: number | null;
  sl: number;
  tp: number;
  lot: number;
  pnl: number | null;
  outcome: "WIN" | "LOSS" | "OPEN";
  m5Confirmed: boolean;
  m5ConfirmationEvaluated: boolean;
  m5Diagnostics: string;
  setupScore: number;
};

export type BacktestResult = {
  trades: BacktestTrade[];
  startingBalance: number;
  endingBalance: number;
  netPnl: number;
  maxDrawdown: number;
  winRate: number | null;
  profitFactor: number | null;
  candleCount: number;
  dataSource: string;
  m5ConfirmationEvaluated: boolean;
  m5Diagnostics: string;
};

function averageAtr(candles: Candle[], end: number, period = 14) {
  const start = Math.max(1, end - period + 1);
  const ranges = candles.slice(start, end + 1).map((candle, offset) => {
    const previous = candles[start + offset - 1]?.close ?? candle.open;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous),
      Math.abs(candle.low - previous),
    );
  });
  return ranges.length
    ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length
    : 0;
}

function floorVolume(value: number, specification: MetaApiSymbolSpecification) {
  if (
    specification.volumeMin === null ||
    specification.volumeMax === null ||
    specification.volumeStep === null
  ) {
    return null;
  }
  const lot = Math.floor(Math.min(value, specification.volumeMax) / specification.volumeStep) *
    specification.volumeStep;
  return lot >= specification.volumeMin ? lot : null;
}

export function runBacktest(input: {
  candles: Candle[];
  specification: MetaApiSymbolSpecification;
  startingBalance: number;
  riskPerTrade: number;
  spreadPoints: number;
  slippagePoints: number;
  commissionPerLot: number;
  timeframe?: string;
}): BacktestResult {
  const { candles, specification, timeframe = "5m" } = input;
  if (
    specification.tickSize === null ||
    specification.tickValue === null ||
    specification.volumeMin === null ||
    specification.volumeMax === null ||
    specification.volumeStep === null
  ) {
    throw new Error("Broker symbol specification is incomplete; backtest blocked");
  }

  const is5mTimeframe = timeframe === "5m" || timeframe === "1m";
  const m5ConfirmationEvaluated = is5mTimeframe;
  const globalM5Diagnostics = is5mTimeframe
    ? "M5 confirmation evaluated dynamically from historical M5/M1 candle sequence"
    : "M5 confirmation cannot be faithfully evaluated from the supplied historical dataset (higher timeframe supplied without sub-timeframe candles)";

  const trades: BacktestTrade[] = [];
  let balance = input.startingBalance;
  let peak = balance;
  let maxDrawdown = 0;

  // We evaluate trades candle-by-candle using strict strategy rules
  let index = 20;
  while (index < candles.length - 1) {
    const historicalSlice = candles.slice(0, index + 1);
    const candle = candles[index];

    // Compute strategy components on historical slice
    const currentAtr = averageAtr(candles, index);
    if (currentAtr <= 0) {
      index += 1;
      continue;
    }

    const swings = detectSwings(historicalSlice, 5);
    const rawPools = findPools(historicalSlice, swings, currentAtr);
    const { pools } = evaluateLiquiditySweeps(historicalSlice, rawPools);
    const isLiquiditySwept = pools.some((p) => p.swept);

    const bosMssResult = detectBosMss(historicalSlice, swings);
    const poi = detectPoi(historicalSlice, swings, currentAtr);

    let m5Confirmed = false;
    let m5Diagnostics = globalM5Diagnostics;

    if (is5mTimeframe) {
      if (poi) {
        // Evaluate M5 confirmation on historical slice using closed candles
        const m15LastTime = candles[Math.max(0, index - 3)].time;
        const evalResult = evaluateM5Confirmation(historicalSlice, m15LastTime, poi);
        m5Confirmed = evalResult.m5Confirmed;
        m5Diagnostics = evalResult.diagnostics;
      } else {
        m5Diagnostics = "No POI established for M5 confirmation";
      }
    }

    const scoreResult = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT", // Standard bias for candidate signal evaluation
      htfConflict: false,
      liquiditySwept: isLiquiditySwept,
      poiPresent: Boolean(poi),
      bosMssPresent: bosMssResult.detected,
      m5Confirmed,
    });

    // Valid setup criteria:
    // Buy signal: SSL sweep / bullish setup with valid POI & BOS or M5 confirmation if 5m
    // Sell signal: BSL sweep / bearish setup with valid POI & BOS or M5 confirmation if 5m
    const lookback = candles.slice(index - 10, index);
    const previousHigh = Math.max(...lookback.map((item) => item.high));
    const previousLow = Math.min(...lookback.map((item) => item.low));

    const sslSwept = candle.low <= previousLow && candle.close > previousLow;
    const bslSwept = candle.high >= previousHigh && candle.close < previousHigh;

    if (!sslSwept && !bslSwept) {
      index += 1;
      continue;
    }

    const direction: "BUY" | "SELL" = sslSwept ? "BUY" : "SELL";

    const spread = input.spreadPoints * specification.tickSize;
    const slippage = input.slippagePoints * specification.tickSize;
    const entry = direction === "BUY"
      ? candle.close + spread / 2 + slippage
      : candle.close - spread / 2 - slippage;

    const sl = direction === "BUY"
      ? candle.low - currentAtr * 0.2
      : candle.high + currentAtr * 0.2;

    const riskDistance = Math.abs(entry - sl);
    const lossPerLot = (riskDistance / specification.tickSize) * specification.tickValue;
    const riskMoney = balance * (input.riskPerTrade / 100);
    const lot = floorVolume(riskMoney / lossPerLot, specification);

    if (!lot) {
      index += 1;
      continue;
    }

    const tp = direction === "BUY"
      ? entry + riskDistance * 2.5
      : entry - riskDistance * 2.5;

    let exit: number | null = null;
    let exitTime: string | null = null;
    let outcome: BacktestTrade["outcome"] = "OPEN";

    for (let exitIndex = index + 1; exitIndex < candles.length; exitIndex += 1) {
      const future = candles[exitIndex];
      const stopHit = direction === "BUY" ? future.low <= sl : future.high >= sl;
      const targetHit = direction === "BUY" ? future.high >= tp : future.low <= tp;
      if (stopHit || targetHit) {
        exit = stopHit ? sl : tp;
        exitTime = future.time;
        outcome = stopHit ? "LOSS" : "WIN";
        break;
      }
    }

    const gross = exit === null
      ? null
      : ((direction === "BUY" ? exit - entry : entry - exit) / specification.tickSize) *
        specification.tickValue * lot;
    const costs = exit === null
      ? null
      : (input.spreadPoints + input.slippagePoints) * specification.tickValue * lot +
        input.commissionPerLot * lot;
    const pnl = gross === null || costs === null ? null : gross - costs;

    if (pnl !== null) {
      balance += pnl;
      peak = Math.max(peak, balance);
      maxDrawdown = Math.max(maxDrawdown, peak - balance);
    }

    trades.push({
      direction,
      entryTime: candle.time,
      exitTime,
      entry,
      exit,
      sl,
      tp,
      lot,
      pnl,
      outcome,
      m5Confirmed,
      m5ConfirmationEvaluated,
      m5Diagnostics,
      setupScore: scoreResult.totalScore,
    });

    index = exitTime
      ? candles.findIndex((item) => item.time === exitTime) + 1
      : candles.length;
  }

  const closed = trades.filter((trade) => trade.pnl !== null);
  const winners = closed.filter((trade) => (trade.pnl ?? 0) > 0);
  const grossProfit = winners.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const grossLoss = Math.abs(
    closed
      .filter((trade) => (trade.pnl ?? 0) < 0)
      .reduce((sum, trade) => sum + (trade.pnl ?? 0), 0),
  );

  return {
    trades,
    startingBalance: input.startingBalance,
    endingBalance: balance,
    netPnl: balance - input.startingBalance,
    maxDrawdown,
    winRate: closed.length ? (winners.length / closed.length) * 100 : null,
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
    candleCount: candles.length,
    dataSource: "MetaApi historical candles",
    m5ConfirmationEvaluated,
    m5Diagnostics: globalM5Diagnostics,
  };
}