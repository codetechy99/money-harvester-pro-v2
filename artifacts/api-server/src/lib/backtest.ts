import type { Candle, MetaApiSymbolSpecification } from "./metaapi";

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
  let index = 20;
  while (index < candles.length - 1) {
    const candle = candles[index];
    const lookback = candles.slice(index - 10, index);
    const previousHigh = Math.max(...lookback.map((item) => item.high));
    const previousLow = Math.min(...lookback.map((item) => item.low));
    const atr = averageAtr(candles, index);
    if (atr <= 0) {
      index += 1;
      continue;
    }
    const buySignal = candle.low <= previousLow && candle.close > previousLow;
    const sellSignal = candle.high >= previousHigh && candle.close < previousHigh;
    if (!buySignal && !sellSignal) {
      index += 1;
      continue;
    }
    const direction = buySignal ? "BUY" : "SELL";
    const spread = input.spreadPoints * specification.tickSize;
    const slippage = input.slippagePoints * specification.tickSize;
    const entry = direction === "BUY"
      ? candle.close + spread / 2 + slippage
      : candle.close - spread / 2 - slippage;
    const sl = direction === "BUY"
      ? candle.low - atr * 0.2
      : candle.high + atr * 0.2;
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
        // If both are touched in one OHLC bar, choose the stop first.
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