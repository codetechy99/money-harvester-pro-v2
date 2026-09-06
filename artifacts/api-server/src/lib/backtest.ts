import type { Candle, MetaApiSymbolSpecification } from "./metaapi";
import {
  atr,
  calculateSetupScore,
  calculateTrend,
  detectSwings,
  findPools,
  inferPoi,
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
};

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
}) {
  const { candles, specification } = input;
  if (
    specification.tickSize === null ||
    specification.tickValue === null ||
    specification.volumeMin === null ||
    specification.volumeMax === null ||
    specification.volumeStep === null
  ) {
    throw new Error("Broker symbol specification is incomplete; backtest blocked");
  }
  const trades: BacktestTrade[] = [];
  let balance = input.startingBalance;
  let peak = balance;
  let maxDrawdown = 0;

  // Backtest iterates over historical closed candles
  let index = 30;
  while (index < candles.length - 1) {
    const historicalWindow = candles.slice(0, index + 1);
    const closedCandles = historicalWindow.slice(0, -1);
    const currentCandle = historicalWindow[historicalWindow.length - 1];

    const averageAtr = atr(closedCandles);
    if (averageAtr <= 0) {
      index += 1;
      continue;
    }

    const externalSwings = detectSwings(closedCandles, 10);
    const internalSwings = detectSwings(closedCandles, 5);
    const trend = calculateTrend(externalSwings);
    const pools = findPools(closedCandles, externalSwings, averageAtr);

    const sweep = pools.find((pool) => {
      const candle = closedCandles[closedCandles.length - 1];
      return pool.type === "BSL"
        ? candle.high >= pool.avgPrice + averageAtr * 0.15 && candle.close < pool.avgPrice
        : candle.low <= pool.avgPrice - averageAtr * 0.15 && candle.close > pool.avgPrice;
    });

    const displacement = inferPoi(closedCandles, internalSwings, pools, averageAtr);

    const { score: setupScore, action: scoreAction } = calculateSetupScore({
      htfBias: trend,
      htfConflict: false,
      sweep: sweep ?? null,
      displacement,
      trend,
      m5Confirmed: true,
    });

    if (scoreAction === "REJECT" || setupScore < 55 || !displacement.poi) {
      index += 1;
      continue;
    }

    const poi = displacement.poi;
    const isBull = poi.type === "OB_BULL" || poi.type === "FVG_BULL";
    const direction = isBull ? "BUY" : "SELL";

    const spread = input.spreadPoints * specification.tickSize;
    const slippage = input.slippagePoints * specification.tickSize;
    const entry = direction === "BUY"
      ? currentCandle.close + spread / 2 + slippage
      : currentCandle.close - spread / 2 - slippage;

    const sl = direction === "BUY"
      ? poi.low - averageAtr * 0.2
      : poi.high + averageAtr * 0.2;

    const riskDistance = Math.abs(entry - sl);
    if (riskDistance <= 0) {
      index += 1;
      continue;
    }

    const lossPerLot = (riskDistance / specification.tickSize) * specification.tickValue;
    if (lossPerLot <= 0) {
      index += 1;
      continue;
    }

    const effectiveRiskPercent = scoreAction === "REDUCED_RISK"
      ? Math.min(input.riskPerTrade, input.riskPerTrade * 0.5)
      : input.riskPerTrade;

    const riskMoney = balance * (effectiveRiskPercent / 100);
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
      entryTime: currentCandle.time,
      exitTime,
      entry,
      exit,
      sl,
      tp,
      lot,
      pnl,
      outcome,
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
  };
}
