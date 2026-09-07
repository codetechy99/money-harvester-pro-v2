import { getHistoricalCandles, type Candle } from "./metaapi";

export const SUPPORTED_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "XAUUSD",
  "NAS100",
  "US30",
] as const;

export type Swing = { index: number; price: number; type: "HIGH" | "LOW" };
export type Pool = {
  type: "BSL" | "SSL";
  avgPrice: number;
  strength: number;
  swept: boolean;
};
export type Poi = {
  high: number;
  low: number;
  creationIndex: number;
  creationTime: string;
  expiryIndex: number;
  touched: boolean;
  type: "OB_BULL" | "OB_BEAR" | "FVG_BULL" | "FVG_BEAR";
};

export type AnalysisResult = {
  realSymbol: string;
  currentState:
    | "SCANNING"
    | "LIQUIDITY_FOUND"
    | "SWEPT"
    | "WAITING_POI_TOUCH"
    | "DISPLACEMENT_CONFIRMED"
    | "LTF_CONFIRM_M5";
  htfBias: string | null;
  htfConflict: boolean;
  trend: string | null;
  poiType: string | null;
  poiHigh: number | null;
  poiLow: number | null;
  setupScore: number;
  scoreAction: "REJECT" | "REDUCED_RISK" | "NORMAL_RISK";
  direction: "BUY" | "SELL" | null;
  suggestedEntry: number | null;
  suggestedSl: number | null;
  suggestedTp: number | null;
  candleTimestamp: string;
  diagnostics: string[];
  lastUpdated: string;
  liquidityPool: Pool[];
  poi: Poi | null;
};

export function atr(candles: Candle[], period = 14) {
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

export function detectSwings(candles: Candle[], radius: number): Swing[] {
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

export function findPools(candles: Candle[], swings: Swing[], averageAtr: number) {
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

export function calculateTrend(swings: Swing[]) {
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

export function inferPoi(
  closedCandles: Candle[],
  internalSwings: Swing[],
  pools: Pool[],
  averageAtr: number,
) {
  // 1. Detect Fair Value Gaps (FVG) across recent 3-candle windows
  for (let i = closedCandles.length - 1; i >= 2; i--) {
    const candle1 = closedCandles[i - 2];
    const candle2 = closedCandles[i - 1];
    const candle3 = closedCandles[i];

    // Bullish FVG: Candle 1 High < Candle 3 Low
    if (candle3.low > candle1.high) {
      const gapSize = candle3.low - candle1.high;
      if (gapSize >= averageAtr * 0.2) {
        return {
          poi: {
            high: candle3.low,
            low: candle1.high,
            creationIndex: i - 1,
            creationTime: candle2.time,
            expiryIndex: i - 1 + 50,
            touched: false,
            type: "FVG_BULL" as const,
          },
          swept: true,
          fvg: { high: candle3.low, low: candle1.high },
          bosMss: "BOS_BULL",
        };
      }
    }

    // Bearish FVG: Candle 1 Low > Candle 3 High
    if (candle1.low > candle3.high) {
      const gapSize = candle1.low - candle3.high;
      if (gapSize >= averageAtr * 0.2) {
        return {
          poi: {
            high: candle1.low,
            low: candle3.high,
            creationIndex: i - 1,
            creationTime: candle2.time,
            expiryIndex: i - 1 + 50,
            touched: false,
            type: "FVG_BEAR" as const,
          },
          swept: true,
          fvg: { high: candle1.low, low: candle3.high },
          bosMss: "BOS_BEAR",
        };
      }
    }
  }

  // 2. Detect Order Blocks (OB) based on strong displacement & internal structure break
  const recent = closedCandles.slice(-5);
  for (let offset = recent.length - 1; offset >= 0; offset -= 1) {
    const candleIndex = closedCandles.length - recent.length + offset;
    const candle = recent[offset];
    const body = Math.abs(candle.close - candle.open);
    const sameColorBefore = closedCandles
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
          ? candle.high >= pool.avgPrice + averageAtr * 0.1
          : candle.low <= pool.avgPrice - averageAtr * 0.1;
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

    if (body > averageAtr * 1.2 && sameColorBefore >= 1 && breaksOpposite) {
      const bullish = candle.close > candle.open;
      return {
        poi: {
          high: candle.high,
          low: candle.low,
          creationIndex: candleIndex,
          creationTime: candle.time,
          expiryIndex: candleIndex + 50,
          touched: false,
          type: bullish ? ("OB_BULL" as const) : ("OB_BEAR" as const),
        },
        swept: Boolean(activeSweep),
        fvg: null,
        bosMss: bullish ? "MSS_BULL" : "MSS_BEAR",
      };
    }
  }

  return { poi: null, swept: false, fvg: null, bosMss: null };
}

/**
 * Setup Score Engine (0 - 100):
 * Evaluates setup quality based on objective SMC evidence.
 */
export function calculateSetupScore(params: {
  htfBias: string | null;
  htfConflict: boolean;
  sweep: Pool | null;
  displacement: ReturnType<typeof inferPoi>;
  trend: string | null;
  m5Confirmed: boolean;
}): { score: number; action: "REJECT" | "REDUCED_RISK" | "NORMAL_RISK" } {
  let score = 0;

  // HTF Bias alignment (+25)
  if (params.htfBias && !params.htfConflict) {
    score += 25;
  } else if (params.htfBias && params.htfConflict) {
    score += 10;
  }

  // Liquidity Sweep (+20)
  if (params.sweep) {
    score += 20;
  } else if (params.displacement.swept) {
    score += 15;
  }

  // Displacement Candle (+20)
  if (params.displacement.poi) {
    score += 20;
  }

  // Structure Break (BOS/MSS) (+15)
  if (params.displacement.bosMss) {
    score += 15;
  }

  // POI Type (FVG / OB) (+10)
  if (params.displacement.poi?.type.startsWith("FVG")) {
    score += 10;
  } else if (params.displacement.poi?.type.startsWith("OB")) {
    score += 8;
  }

  // LTF Micro Confirmation (+10)
  if (params.m5Confirmed) {
    score += 10;
  }

  // Score Tiers:
  // < 55: REJECT
  // 55 - 69: REDUCED_RISK (0.5x risk)
  // 70+: NORMAL_RISK (1.0x risk - MUST NOT exceed configured max risk)
  let action: "REJECT" | "REDUCED_RISK" | "NORMAL_RISK" = "REJECT";
  if (score >= 70) {
    action = "NORMAL_RISK";
  } else if (score >= 55) {
    action = "REDUCED_RISK";
  } else {
    action = "REJECT";
  }

  return { score, action };
}

export async function analyzeSymbol(metaApiAccountId: string, baseSymbol: string): Promise<AnalysisResult> {
  const candidates = [
    baseSymbol,
    `${baseSymbol}.m`,
    `${baseSymbol}!.m`,
    baseSymbol === "XAUUSD" ? "GOLD.m" : baseSymbol,
    baseSymbol === "NAS100" ? "US100" : baseSymbol,
    baseSymbol === "US30" ? "DJ30" : baseSymbol,
  ];
  let realSymbol = baseSymbol;
  let rawM15: Candle[] = [];
  for (const candidate of candidates) {
    try {
      const result = await getHistoricalCandles(metaApiAccountId, candidate, "15m", 320);
      if (result.length) {
        realSymbol = candidate;
        rawM15 = result;
        break;
      }
    } catch {
      // Missing symbol expected during suffix discovery
    }
  }

  const [h4, daily, m5] = await Promise.all([
    getHistoricalCandles(metaApiAccountId, realSymbol, "4h", 120),
    getHistoricalCandles(metaApiAccountId, realSymbol, "1d", 60),
    getHistoricalCandles(metaApiAccountId, realSymbol, "5m", 80),
  ]);

  if (rawM15.length < 40) {
    return {
      realSymbol,
      currentState: "SCANNING",
      htfBias: null,
      htfConflict: false,
      trend: null,
      poiType: null,
      poiHigh: null,
      poiLow: null,
      setupScore: 0,
      scoreAction: "REJECT",
      direction: null,
      suggestedEntry: null,
      suggestedSl: null,
      suggestedTp: null,
      candleTimestamp: new Date().toISOString(),
      diagnostics: ["SCANNING — not enough live M15 candles returned by MetaApi"],
      lastUpdated: new Date().toISOString(),
      liquidityPool: [],
      poi: null,
    };
  }

  // Enforce CLOSED CANDLE RULE for structural calculations:
  // Operating on closed candles rawM15.slice(0, -1)
  const closedM15 = rawM15.slice(0, -1);
  const formingCandle = rawM15[rawM15.length - 1];

  const averageAtr = atr(closedM15);
  const externalSwings = detectSwings(closedM15, 10);
  const internalSwings = detectSwings(closedM15, 5);
  const trend = calculateTrend(externalSwings);
  const pools = findPools(closedM15, externalSwings, averageAtr);

  // Check liquidity sweep on closed candles or forming candle wick
  const sweep = pools.find((pool) => {
    const candle = closedM15[closedM15.length - 1];
    return pool.type === "BSL"
      ? candle.high >= pool.avgPrice + averageAtr * 0.15 && candle.close < pool.avgPrice
      : candle.low <= pool.avgPrice - averageAtr * 0.15 && candle.close > pool.avgPrice;
  });

  const displacement = inferPoi(closedM15, internalSwings, pools, averageAtr);
  const dailyTrend = calculateTrend(detectSwings(daily.slice(0, -1), 3));
  const h4Trend = calculateTrend(detectSwings(h4.slice(0, -1), 5));

  const currentClose = formingCandle.close;
  const dailyHigh = Math.max(...daily.slice(-50).map((candle) => candle.high));
  const dailyLow = Math.min(...daily.slice(-50).map((candle) => candle.low));
  const equilibrium = (dailyHigh + dailyLow) / 2;

  const htfBias =
    dailyTrend === "BULLISH" && currentClose <= equilibrium
      ? "BULLISH_DISCOUNT"
      : dailyTrend === "BEARISH" && currentClose >= equilibrium
        ? "BEARISH_PREMIUM"
        : dailyTrend ?? null;

  const htfConflict =
    (dailyTrend === "BULLISH" && h4Trend === "BEARISH") ||
    (dailyTrend === "BEARISH" && h4Trend === "BULLISH");

  const poi = displacement.poi;

  const poiCreationTime =
    poi && (poi.creationTime ?? (closedM15[poi.creationIndex] ? closedM15[poi.creationIndex].time : null));

  const poiTouched =
    poi &&
    m5.some(
      (candle) =>
        (poiCreationTime
          ? candle.time >= poiCreationTime
          : candle.time > closedM15[closedM15.length - 1].time) &&
        candle.high >= poi.low &&
        candle.low <= poi.high,
    );

  const m5Confirmed = Boolean(poiTouched);

  const { score: setupScore, action: scoreAction } = calculateSetupScore({
    htfBias,
    htfConflict,
    sweep: sweep ?? null,
    displacement,
    trend,
    m5Confirmed,
  });

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

  let direction: "BUY" | "SELL" | null = null;
  let suggestedEntry: number | null = null;
  let suggestedSl: number | null = null;
  let suggestedTp: number | null = null;

  if (poi) {
    const isBull = poi.type === "OB_BULL" || poi.type === "FVG_BULL";
    direction = isBull ? "BUY" : "SELL";
    suggestedEntry = currentClose;
    if (isBull) {
      suggestedSl = poi.low - averageAtr * 0.2;
      const slDistance = Math.abs(suggestedEntry - suggestedSl);
      suggestedTp = suggestedEntry + slDistance * 2.5;
    } else {
      suggestedSl = poi.high + averageAtr * 0.2;
      const slDistance = Math.abs(suggestedEntry - suggestedSl);
      suggestedTp = suggestedEntry - slDistance * 2.5;
    }
  }

  const diagnostics = [
    `M15 trend ${trend ?? "UNKNOWN"}; daily ${dailyTrend ?? "UNKNOWN"}; H4 ${h4Trend ?? "UNKNOWN"}`,
    pools.length
      ? `${pools.length} liquidity pool${pools.length === 1 ? "" : "s"} detected`
      : "No equal-high/equal-low pool within 0.15 ATR14",
    sweep ? `${sweep.type} sweep detected` : "Waiting for a valid liquidity sweep",
    poi
      ? `${poi.type} detected at bar ${poi.creationIndex}; expires after 50 bars`
      : "Waiting for displacement body > 1.2 ATR and internal break",
    htfConflict
      ? "HTF conflict — risk reduced to 50%"
      : htfBias
        ? `HTF location ${htfBias}`
        : "HTF premium/discount not aligned",
    `Setup Score: ${setupScore}/100 (${scoreAction})`,
    state === "LTF_CONFIRM_M5"
      ? "M15 POI touched; M5 micro confirmation active"
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
    setupScore,
    scoreAction,
    direction,
    suggestedEntry,
    suggestedSl,
    suggestedTp,
    candleTimestamp: formingCandle.time,
    diagnostics,
    lastUpdated: new Date().toISOString(),
    liquidityPool: pools,
    poi,
  };
}
