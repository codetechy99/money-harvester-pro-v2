import { getHistoricalCandles, type Candle } from "./metaapi";

export type { Candle };

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
  expiryIndex: number;
  touched: boolean;
  type: "OB_BULL" | "OB_BEAR" | "FVG_BULL" | "FVG_BEAR";
  creationTime?: string;
};

export type SetupScoreResult = {
  score: number;
  breakdown: {
    htfAlignment: number;
    liquiditySweep: number;
    poiQuality: number;
    bosMss: number;
    m5Confirmation: number;
  };
  action: "STRONG_BUY" | "BUY" | "STRONG_SELL" | "SELL" | "REJECT";
  direction: "BUY" | "SELL" | null;
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

export function findPools(candles: Candle[], swings: Swing[], averageAtr: number): Pool[] {
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

export function evaluateLiquiditySweeps(candles: Candle[], pools: Pool[]): { pools: Pool[]; activeSweep: Pool | null } {
  if (!candles.length) return { pools, activeSweep: null };
  const closedCandles = candles.slice(0, -1);
  const averageAtr = atr(closedCandles.length ? closedCandles : candles);

  let activeSweep: Pool | null = null;
  const updatedPools = pools.map((pool) => {
    let isSwept = pool.swept;
    for (const candle of closedCandles) {
      const sweptThisCandle =
        pool.type === "BSL"
          ? candle.high >= pool.avgPrice + averageAtr * 0.15 && candle.close < pool.avgPrice
          : candle.low <= pool.avgPrice - averageAtr * 0.15 && candle.close > pool.avgPrice;
      if (sweptThisCandle) {
        isSwept = true;
        if (candle === closedCandles[closedCandles.length - 1]) {
          activeSweep = { ...pool, swept: true };
        }
      }
    }
    return { ...pool, swept: isSwept };
  });

  return { pools: updatedPools, activeSweep };
}

export function detectBosMss(candles: Candle[], internalSwings: Swing[]) {
  const closed = candles.slice(0, -1);
  if (closed.length < 2) {
    return { detected: false, type: null, tag: null };
  }
  const lastClosed = closed[closed.length - 1];
  const prevClosed = closed[closed.length - 2];

  const recentHighSwings = internalSwings.filter((s) => s.type === "HIGH" && s.index < closed.length - 1);
  const recentLowSwings = internalSwings.filter((s) => s.type === "LOW" && s.index < closed.length - 1);

  const lastHigh = recentHighSwings.at(-1);
  const lastLow = recentLowSwings.at(-1);

  if (lastHigh && lastClosed.close > lastHigh.price && prevClosed.close <= lastHigh.price) {
    return { detected: true, type: "BULLISH_BOS", tag: "BOS_BULL" };
  }
  if (lastLow && lastClosed.close < lastLow.price && prevClosed.close >= lastLow.price) {
    return { detected: true, type: "BEARISH_BOS", tag: "BOS_BEAR" };
  }

  return { detected: false, type: null, tag: null };
}

export function calculateTrend(swings: Swing[]) {
  const highs = swings.filter((swing) => swing.type === "HIGH").slice(-2);
  const lows = swings.filter((swing) => swing.type === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) {
    return "BULLISH";
  }
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) {
    return "BEARISH";
  }
  return "RANGING";
}

export function detectPoi(
  candles: Candle[],
  internalSwings: Swing[],
  averageAtr: number,
): Poi | null {
  const closed = candles.slice(0, -1);
  const recent = closed.slice(-5);

  for (let offset = recent.length - 1; offset >= 0; offset -= 1) {
    const candleIndex = closed.length - recent.length + offset;
    const candle = recent[offset];
    const body = Math.abs(candle.close - candle.open);

    const breaksOpposite = internalSwings.some(
      (swing) =>
        swing.index < candleIndex &&
        ((candle.close > swing.price && swing.type === "HIGH") ||
          (candle.close < swing.price && swing.type === "LOW")),
    );

    if (body > averageAtr * 1.2 && breaksOpposite) {
      const isBull = candle.close > candle.open;

      // Check for FVG in 3-candle sequence
      if (candleIndex >= 2 && candleIndex < closed.length) {
        const prevCandle = closed[candleIndex - 1];
        const nextCandle = closed[candleIndex + 1];
        if (nextCandle) {
          if (isBull && nextCandle.low > prevCandle.high) {
            return {
              high: nextCandle.low,
              low: prevCandle.high,
              creationIndex: candleIndex,
              expiryIndex: candleIndex + 50,
              touched: false,
              type: "FVG_BULL",
              creationTime: candle.time,
            };
          }
          if (!isBull && nextCandle.high < prevCandle.low) {
            return {
              high: prevCandle.low,
              low: nextCandle.high,
              creationIndex: candleIndex,
              expiryIndex: candleIndex + 50,
              touched: false,
              type: "FVG_BEAR",
              creationTime: candle.time,
            };
          }
        }
      }

      return {
        high: candle.high,
        low: candle.low,
        creationIndex: candleIndex,
        expiryIndex: candleIndex + 50,
        touched: false,
        type: isBull ? "OB_BULL" : "OB_BEAR",
        creationTime: candle.time,
      };
    }
  }

  return null;
}

export function evaluateM5Confirmation(
  m5Candles: Candle[],
  m15LastTime: string,
  poi: Poi | null,
) {
  if (!m5Candles.length) {
    return {
      evaluated: false,
      m5Confirmed: false,
      poiTouched: false,
      reason: "No M5 candles returned by MetaApi",
      diagnostics: "M5 confirmation skipped: missing M5 data",
    };
  }

  const closedM5 = m5Candles.slice(0, -1);
  if (!closedM5.length) {
    return {
      evaluated: false,
      m5Confirmed: false,
      poiTouched: false,
      reason: "Insufficient closed M5 candles",
      diagnostics: "M5 confirmation skipped: waiting for closed M5 candle",
    };
  }

  if (!poi) {
    return {
      evaluated: true,
      m5Confirmed: false,
      poiTouched: false,
      reason: "No active POI detected",
      diagnostics: "M5 confirmation evaluated: no POI present",
    };
  }

  const poiTouched = closedM5.some((candle) => {
    const afterPoiTime = poi.creationTime ? candle.time >= poi.creationTime : candle.time >= m15LastTime;
    return afterPoiTime && candle.high >= poi.low && candle.low <= poi.high;
  });

  if (!poiTouched) {
    return {
      evaluated: true,
      m5Confirmed: false,
      poiTouched: false,
      reason: "M15 POI not touched on M5",
      diagnostics: `M5 confirmation evaluated: POI [${poi.type} ${poi.low}-${poi.high}] untouched`,
    };
  }

  // Micro structure confirmation on M5 after POI touch
  const isBullPoi = poi.type === "OB_BULL" || poi.type === "FVG_BULL";
  const m5Swings = detectSwings(closedM5, 3);
  const lastM5Swings = m5Swings.slice(-2);

  let microConfirmed = false;
  if (lastM5Swings.length >= 2) {
    if (isBullPoi) {
      const highSwings = lastM5Swings.filter((s) => s.type === "HIGH");
      if (highSwings.length >= 2 && highSwings[1].price > highSwings[0].price) {
        microConfirmed = true;
      }
    } else {
      const lowSwings = lastM5Swings.filter((s) => s.type === "LOW");
      if (lowSwings.length >= 2 && lowSwings[1].price < lowSwings[0].price) {
        microConfirmed = true;
      }
    }
  }

  // Fallback micro displacement candle check on M5 if swing detection is early
  if (!microConfirmed && closedM5.length >= 2) {
    const recentM5 = closedM5.slice(-3);
    const avgM5Atr = atr(closedM5, 10);
    const microDisplacement = recentM5.some((c) => {
      const body = Math.abs(c.close - c.open);
      return isBullPoi ? c.close > c.open && body > avgM5Atr * 1.1 : c.close < c.open && body > avgM5Atr * 1.1;
    });
    if (microDisplacement) {
      microConfirmed = true;
    }
  }

  return {
    evaluated: true,
    m5Confirmed: microConfirmed,
    poiTouched: true,
    reason: microConfirmed ? "M5 micro-structure displacement confirmed" : "M5 POI touched, waiting micro confirmation",
    diagnostics: microConfirmed
      ? "M5 confirmation evaluated: micro MSS/displacement confirmed"
      : "M5 confirmation evaluated: POI touched, awaiting micro displacement",
  };
}

export function calculateSetupScore(input: {
  htfBias: string | null;
  htfConflict: boolean;
  liquiditySwept?: boolean;
  sweep?: Pool | null;
  poiPresent?: boolean;
  displacement?: { poi: Poi | null; swept: boolean };
  bosMssPresent?: boolean;
  trend?: string | null;
  m5Confirmed: boolean;
}): SetupScoreResult {
  const htfAlignment = input.htfConflict
    ? 0
    : input.htfBias
      ? 25
      : 10;

  const sweepDone = input.liquiditySwept ?? Boolean(input.sweep);
  const liquiditySweep = sweepDone ? 25 : 0;

  const poiPresent = input.poiPresent ?? Boolean(input.displacement?.poi);
  const poiQuality = poiPresent ? 20 : 0;

  const bosMss = input.bosMssPresent ? 15 : 10;
  const m5Confirmation = input.m5Confirmed ? 15 : 0;

  const score = htfAlignment + liquiditySweep + poiQuality + bosMss + m5Confirmation;

  const poiType = input.displacement?.poi?.type;
  let isBullish = poiType === "OB_BULL" || poiType === "FVG_BULL" || input.htfBias?.includes("BULLISH") || input.trend === "BULLISH";
  if (poiType === "OB_BEAR" || poiType === "FVG_BEAR" || input.htfBias?.includes("BEARISH") || input.trend === "BEARISH") {
    isBullish = false;
  }

  let action: SetupScoreResult["action"] = "REJECT";
  let direction: "BUY" | "SELL" | null = null;

  if (score >= 80) {
    action = isBullish ? "STRONG_BUY" : "STRONG_SELL";
    direction = isBullish ? "BUY" : "SELL";
  } else if (score >= 60) {
    action = isBullish ? "BUY" : "SELL";
    direction = isBullish ? "BUY" : "SELL";
  }

  return {
    score,
    breakdown: {
      htfAlignment,
      liquiditySweep,
      poiQuality,
      bosMss,
      m5Confirmation,
    },
    action,
    direction,
  };
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
      // Missing symbol expected during suffix discovery
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
      bosMssTag: null,
    };
  }

  const closedM15 = m15.slice(0, -1);
  const formingCandle = m15[m15.length - 1];

  const averageAtr = atr(closedM15);
  const externalSwings = detectSwings(closedM15, 10);
  const internalSwings = detectSwings(closedM15, 5);
  const trend = calculateTrend(externalSwings);

  // 1. Independent Liquidity Pool & Sweep Evaluation
  const rawPools = findPools(closedM15, externalSwings, averageAtr);
  const { pools, activeSweep } = evaluateLiquiditySweeps(closedM15, rawPools);

  // 2. Independent BOS / MSS Detection
  const bosMssResult = detectBosMss(closedM15, internalSwings);

  // 3. POI / FVG Detection
  const poi = detectPoi(closedM15, internalSwings, averageAtr);

  // 4. HTF Trend & Alignment
  const dailyTrend = calculateTrend(detectSwings(daily, 3));
  const h4Trend = calculateTrend(detectSwings(h4, 5));
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

  // 5. M5 Confirmation Evaluation (Genuinely calculated from market data)
  const lastM15Time = closedM15[closedM15.length - 1].time;
  const m5Eval = evaluateM5Confirmation(m5, lastM15Time, poi);

  if (poi) {
    poi.touched = m5Eval.poiTouched;
  }

  // 6. Setup Score Calculation
  const isLiquiditySwept = pools.some((p) => p.swept);
  const setupScoreObj = calculateSetupScore({
    htfBias,
    htfConflict,
    liquiditySwept: isLiquiditySwept,
    poiPresent: Boolean(poi),
    bosMssPresent: bosMssResult.detected,
    m5Confirmed: m5Eval.m5Confirmed,
    displacement: poi ? { poi, swept: isLiquiditySwept } : undefined,
    trend,
  });

  // 7. State Machine
  let state = "SCANNING";
  if (poi) {
    if (m5Eval.m5Confirmed) {
      state = "LTF_CONFIRM_M5";
    } else if (m5Eval.poiTouched) {
      state = "WAITING_POI_TOUCH";
    } else {
      state = "DISPLACEMENT_CONFIRMED";
    }
  } else if (activeSweep) {
    state = "SWEPT";
  } else if (pools.length) {
    state = "LIQUIDITY_FOUND";
  }

  let direction: "BUY" | "SELL" | null = setupScoreObj.direction;
  let suggestedEntry: number | null = null;
  let suggestedSl: number | null = null;
  let suggestedTp: number | null = null;

  if (poi && direction) {
    const isBull = direction === "BUY";
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

  const activeSweepPool: Pool | null = activeSweep;
  const diagnostics = [
    `M15 trend ${trend ?? "UNKNOWN"}; daily ${dailyTrend ?? "UNKNOWN"}; H4 ${h4Trend ?? "UNKNOWN"}`,
    pools.length
      ? `${pools.length} liquidity pool${pools.length === 1 ? "" : "s"} detected (${pools.filter((p) => p.swept).length} swept)`
      : "No equal-high/equal-low pool within threshold",
    activeSweepPool
      ? `${activeSweepPool.type} sweep confirmed on closed candle`
      : isLiquiditySwept
        ? "Historical liquidity sweep present on active pool"
        : "Waiting for a valid liquidity sweep",
    bosMssResult.detected
      ? `Structure break detected: ${bosMssResult.type}`
      : "No structural break (BOS/MSS) confirmed on closed candle",
    poi
      ? `${poi.type} created at M15 index ${poi.creationIndex}`
      : "Waiting for displacement body > 1.2 ATR and internal break",
    htfConflict
      ? "HTF conflict — risk must be reduced to 50%"
      : htfBias
        ? `HTF location ${htfBias}`
        : "HTF premium/discount not aligned",
    m5Eval.diagnostics,
    `Setup Score: ${setupScoreObj.score}/100 (${setupScoreObj.action})`,
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
    setupScore: setupScoreObj.score,
    scoreAction: setupScoreObj.action,
    direction,
    suggestedEntry,
    suggestedSl,
    suggestedTp,
    candleTimestamp: formingCandle.time,
    diagnostics,
    lastUpdated: new Date().toISOString(),
    liquidityPool: pools,
    poi,
    bosMssTag: bosMssResult.tag,
  };
}
