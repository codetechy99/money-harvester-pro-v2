import { getHistoricalCandles, type Candle } from "./metaapi";

export const SUPPORTED_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "XAUUSD",
  "NAS100",
  "US30",
] as const;

type Swing = { index: number; price: number; type: "HIGH" | "LOW" };
type Pool = {
  type: "BSL" | "SSL";
  avgPrice: number;
  strength: number;
  swept: boolean;
};
type Poi = {
  high: number;
  low: number;
  creationIndex: number;
  expiryIndex: number;
  touched: boolean;
  type: "OB_BULL" | "OB_BEAR" | "FVG";
};

function atr(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return 0;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const recent = ranges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function detectSwings(candles: Candle[], radius: number): Swing[] {
  const result: Swing[] = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - radius, index);
    const right = candles.slice(index + 1, index + radius + 1);
    if (
      left.every((item) => candle.high >= item.high) &&
      right.every((item) => candle.high >= item.high)
    ) {
      result.push({ index, price: candle.high, type: "HIGH" });
    }
    if (
      left.every((item) => candle.low <= item.low) &&
      right.every((item) => candle.low <= item.low)
    ) {
      result.push({ index, price: candle.low, type: "LOW" });
    }
  }
  return result;
}

function findPools(candles: Candle[], swings: Swing[], averageAtr: number) {
  const pools: Pool[] = [];
  const threshold = averageAtr * 0.15;
  const highs = swings.filter((swing) => swing.type === "HIGH");
  const lows = swings.filter((swing) => swing.type === "LOW");
  for (const [type, candidates] of [
    ["BSL", highs],
    ["SSL", lows],
  ] as const) {
    for (let index = 0; index < candidates.length; index += 1) {
      const current = candidates[index];
      const matches = candidates.filter(
        (candidate) =>
          Math.abs(candidate.index - current.index) >= 5 &&
          Math.abs(candidate.index - current.index) <= 50 &&
          Math.abs(candidate.price - current.price) <= threshold,
      );
      if (matches.length) {
        const prices = [current, ...matches].map((item) => item.price);
        const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        if (
          !pools.some(
            (pool) =>
              pool.type === type &&
              Math.abs(pool.avgPrice - avgPrice) <= threshold / 2,
          )
        ) {
          pools.push({
            type,
            avgPrice,
            strength: prices.length,
            swept: false,
          });
        }
      }
    }
  }
  return pools;
}

function calculateTrend(swings: Swing[]) {
  const highs = swings.filter((swing) => swing.type === "HIGH").slice(-2);
  const lows = swings.filter((swing) => swing.type === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (
    highs[1].price > highs[0].price &&
    lows[1].price > lows[0].price
  ) {
    return "BULLISH";
  }
  if (
    highs[1].price < highs[0].price &&
    lows[1].price < lows[0].price
  ) {
    return "BEARISH";
  }
  return "RANGING";
}

function inferPoi(
  candles: Candle[],
  internalSwings: Swing[],
  pools: Pool[],
  averageAtr: number,
) {
  const recent = candles.slice(-3);
  for (let offset = recent.length - 1; offset >= 0; offset -= 1) {
    const candleIndex = candles.length - recent.length + offset;
    const candle = recent[offset];
    const body = Math.abs(candle.close - candle.open);
    const sameColorBefore = candles
      .slice(Math.max(0, candleIndex - 2), candleIndex)
      .filter((item) => Math.sign(item.close - item.open) === Math.sign(candle.close - candle.open))
      .length;
    const breaksOpposite = internalSwings.some(
      (swing) =>
        swing.index < candleIndex &&
        ((candle.close > swing.price && swing.type === "HIGH") ||
          (candle.close < swing.price && swing.type === "LOW")),
    );
    const activeSweep = pools.find((pool) => {
      const wick =
        pool.type === "BSL"
          ? candle.high >= pool.avgPrice + averageAtr * 0.2
          : candle.low <= pool.avgPrice - averageAtr * 0.2;
      const closeBack =
        pool.type === "BSL"
          ? candle.close < pool.avgPrice
          : candle.close > pool.avgPrice;
      const candleBody = Math.abs(candle.close - candle.open);
      const wickLength =
        pool.type === "BSL"
          ? candle.high - Math.max(candle.open, candle.close)
          : Math.min(candle.open, candle.close) - candle.low;
      return wick && closeBack && wickLength > candleBody;
    });
    if (body > averageAtr * 1.5 && sameColorBefore >= 2 && breaksOpposite) {
      const bullish = candle.close > candle.open;
      return {
        poi: {
          high: candle.high,
          low: candle.low,
          creationIndex: candleIndex,
          expiryIndex: candleIndex + 50,
          touched: false,
          type: bullish ? "OB_BULL" : "OB_BEAR",
        } satisfies Poi,
        swept: Boolean(activeSweep),
      };
    }
  }
  return { poi: null, swept: false };
}

export async function analyzeSymbol(accountId: string, baseSymbol: string) {
  const candidates = [
    baseSymbol,
    `${baseSymbol}.m`,
    `${baseSymbol}!.m`,
    baseSymbol === "XAUUSD" ? "GOLD.m" : baseSymbol,
    baseSymbol === "NAS100" ? "US100" : baseSymbol,
    baseSymbol === "US30" ? "DJ30" : baseSymbol,
  ];
  let realSymbol = baseSymbol;
  let m15: Candle[] = [];
  for (const candidate of candidates) {
    try {
      const result = await getHistoricalCandles(accountId, candidate, "15m", 320);
      if (result.length) {
        realSymbol = candidate;
        m15 = result;
        break;
      }
    } catch {
      // A missing symbol is expected during suffix discovery; try the next one.
    }
  }
  const [h4, daily, m5] = await Promise.all([
    getHistoricalCandles(accountId, realSymbol, "4h", 120),
    getHistoricalCandles(accountId, realSymbol, "1d", 60),
    getHistoricalCandles(accountId, realSymbol, "5m", 80),
  ]);
  if (m15.length < 40) {
    return {
      realSymbol,
      currentState: "SCANNING",
      htfBias: null,
      htfConflict: false,
      trend: null,
      poiType: null,
      poiHigh: null,
      poiLow: null,
      diagnostics: ["SCANNING — not enough live M15 candles returned by MetaApi"],
      lastUpdated: new Date().toISOString(),
      liquidityPool: [],
      poi: null,
    };
  }

  const averageAtr = atr(m15);
  const externalSwings = detectSwings(m15, 10);
  const internalSwings = detectSwings(m15, 5);
  const trend = calculateTrend(externalSwings);
  const pools = findPools(m15, externalSwings, averageAtr);
  const sweep = pools.find((pool) => {
    const candle = m15[m15.length - 1];
    return pool.type === "BSL"
      ? candle.high >= pool.avgPrice + averageAtr * 0.2 &&
          candle.close < pool.avgPrice
      : candle.low <= pool.avgPrice - averageAtr * 0.2 &&
          candle.close > pool.avgPrice;
  });
  const displacement = inferPoi(m15, internalSwings, pools, averageAtr);
  const dailyTrend = calculateTrend(detectSwings(daily, 3));
  const h4Trend = calculateTrend(detectSwings(h4, 5));
  const current = m15[m15.length - 1];
  const dailyHigh = Math.max(...daily.slice(-50).map((candle) => candle.high));
  const dailyLow = Math.min(...daily.slice(-50).map((candle) => candle.low));
  const equilibrium = (dailyHigh + dailyLow) / 2;
  const htfBias =
    dailyTrend === "BULLISH" && current.close <= equilibrium
      ? "BULLISH_DISCOUNT"
      : dailyTrend === "BEARISH" && current.close >= equilibrium
        ? "BEARISH_PREMIUM"
        : dailyTrend ?? null;
  const htfConflict =
    (dailyTrend === "BULLISH" && h4Trend === "BEARISH") ||
    (dailyTrend === "BEARISH" && h4Trend === "BULLISH");
  const poi = displacement.poi;
  const poiTouched =
    poi &&
    m5.some(
      (candle) =>
        candle.time > m15[m15.length - 1].time &&
        candle.high >= poi.low &&
        candle.low <= poi.high,
    );
  const state = poi
    ? poiTouched
      ? "LTF_CONFIRM_M5"
      : displacement.swept
        ? "DISPLACEMENT_CONFIRMED"
        : "WAITING_POI_TOUCH"
    : sweep
      ? "SWEPT"
      : pools.length
        ? "LIQUIDITY_FOUND"
        : "SCANNING";
  const diagnostics = [
    `M15 trend ${trend ?? "UNKNOWN"}; daily ${dailyTrend ?? "UNKNOWN"}; H4 ${h4Trend ?? "UNKNOWN"}`,
    pools.length
      ? `${pools.length} liquidity pool${pools.length === 1 ? "" : "s"} detected`
      : "No equal-high/equal-low pool within 0.15 ATR14",
    sweep ? `${sweep.type} sweep detected in latest M15 candle` : "Waiting for a valid liquidity sweep",
    poi
      ? `${poi.type} created at M15 index ${poi.creationIndex}; expires after 50 bars`
      : "Waiting for displacement body > 1.5 ATR and internal break",
    htfConflict
      ? "HTF conflict — risk must be reduced to 50%"
      : htfBias
        ? `HTF location ${htfBias}`
        : "HTF premium/discount not aligned",
    state === "LTF_CONFIRM_M5"
      ? "M15 POI touched; waiting for M5 micro MSS confirmation"
      : "No executable confirmation yet",
  ];
  return {
    realSymbol,
    currentState: state,
    htfBias,
    htfConflict,
    trend,
    poiType: poi?.type ?? null,
    poiHigh: poi?.high ?? null,
    poiLow: poi?.low ?? null,
    diagnostics,
    lastUpdated: new Date().toISOString(),
    liquidityPool: pools,
    poi,
  };
}