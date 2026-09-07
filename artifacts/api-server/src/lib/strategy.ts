import { getHistoricalCandles, type Candle } from "./metaapi";

export const SUPPORTED_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "XAUUSD",
  "NAS100",
  "US30",
] as const;

export type Swing = { index: number; price: number; type: "HIGH" | "LOW"; time?: string };

export type Pool = {
  type: "BSL" | "SSL";
  avgPrice: number;
  strength: number;
  swept: boolean;
  sweptAtTime?: string | null;
};

export type Poi = {
  high: number;
  low: number;
  creationIndex: number;
  expiryIndex: number;
  touched: boolean;
  type: "OB_BULL" | "OB_BEAR" | "FVG";
};

export type BosMssResult = {
  detected: boolean;
  type: "BULLISH_BOS" | "BULLISH_MSS" | "BEARISH_BOS" | "BEARISH_MSS" | null;
  brokenSwingIndex: number | null;
  brokenSwingPrice: number | null;
  candleIndex: number | null;
  tag: string | null;
};

export type M5ConfirmationResult = {
  poiTouched: boolean;
  rejectionDetected: boolean;
  displacementDetected: boolean;
  structureBreakDetected: boolean;
  m5Confirmed: boolean;
  diagnostics: string;
};

export type SetupScoreResult = {
  totalScore: number;
  breakdown: {
    htfAlignment: number;
    liquiditySweep: number;
    poiQuality: number;
    bosMss: number;
    m5Confirmation: number;
  };
};

export function atr(candles: Candle[], period = 14): number {
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

    const isHigh =
      left.every((item) => candle.high >= item.high) &&
      right.every((item) => candle.high >= item.high) &&
      (left.some((item) => candle.high > item.high) ||
        right.some((item) => candle.high > item.high));

    if (isHigh) {
      result.push({ index, price: candle.high, type: "HIGH", time: candle.time });
    }

    const isLow =
      left.every((item) => candle.low <= item.low) &&
      right.every((item) => candle.low <= item.low) &&
      (left.some((item) => candle.low < item.low) ||
        right.some((item) => candle.low < item.low));

    if (isLow) {
      result.push({ index, price: candle.low, type: "LOW", time: candle.time });
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

export function evaluateLiquiditySweeps(
  candles: Candle[],
  pools: Pool[],
): { pools: Pool[]; activeSweep: Pool | null } {
  const updatedPools = pools.map((p) => ({ ...p }));
  let activeSweep: Pool | null = null;

  // Evaluate against closed candles only
  for (const pool of updatedPools) {
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      let isSwept = false;
      if (pool.type === "BSL") {
        // BSL sweep: price trades above the level and closes back below it
        if (candle.high >= pool.avgPrice && candle.close < pool.avgPrice) {
          isSwept = true;
        }
      } else if (pool.type === "SSL") {
        // SSL sweep: price trades below the level and closes back above it
        if (candle.low <= pool.avgPrice && candle.close > pool.avgPrice) {
          isSwept = true;
        }
      }

      if (isSwept) {
        pool.swept = true;
        pool.sweptAtTime = candle.time;
        if (index >= candles.length - 3) {
          activeSweep = pool;
        }
      }
    }
  }

  return { pools: updatedPools, activeSweep };
}

export function detectBosMss(candles: Candle[], swings: Swing[]): BosMssResult {
  const highs = swings.filter((s) => s.type === "HIGH");
  const lows = swings.filter((s) => s.type === "LOW");

  // Search recent closed candles for genuine structure break
  for (let index = candles.length - 1; index >= Math.max(0, candles.length - 20); index -= 1) {
    const candle = candles[index];

    // Bullish BOS/MSS: closed candle closes strictly above relevant prior swing high
    const brokenHigh = highs.find(
      (h) => h.index < index && candle.close > h.price,
    );
    if (brokenHigh) {
      return {
        detected: true,
        type: "BULLISH_BOS",
        brokenSwingIndex: brokenHigh.index,
        brokenSwingPrice: brokenHigh.price,
        candleIndex: index,
        tag: "BULLISH_BOS",
      };
    }

    // Bearish BOS/MSS: closed candle closes strictly below relevant prior swing low
    const brokenLow = lows.find(
      (l) => l.index < index && candle.close < l.price,
    );
    if (brokenLow) {
      return {
        detected: true,
        type: "BEARISH_BOS",
        brokenSwingIndex: brokenLow.index,
        brokenSwingPrice: brokenLow.price,
        candleIndex: index,
        tag: "BEARISH_BOS",
      };
    }
  }

  return {
    detected: false,
    type: null,
    brokenSwingIndex: null,
    brokenSwingPrice: null,
    candleIndex: null,
    tag: null,
  };
}

export function detectPoi(
  candles: Candle[],
  internalSwings: Swing[],
  averageAtr: number,
): Poi | null {
  const recent = candles.slice(-5);
  for (let offset = recent.length - 1; offset >= 0; offset -= 1) {
    const candleIndex = candles.length - recent.length + offset;
    const candle = recent[offset];
    const body = Math.abs(candle.close - candle.open);

    const breaksOpposite = internalSwings.some(
      (swing) =>
        swing.index < candleIndex &&
        ((candle.close > swing.price && swing.type === "HIGH") ||
          (candle.close < swing.price && swing.type === "LOW")),
    );

    if (body > averageAtr * 1.2 && breaksOpposite) {
      const bullish = candle.close > candle.open;
      return {
        high: candle.high,
        low: candle.low,
        creationIndex: candleIndex,
        expiryIndex: candleIndex + 50,
        touched: false,
        type: bullish ? "OB_BULL" : "OB_BEAR",
      };
    }
  }
  return null;
}

export function calculateTrend(swings: Swing[]): "BULLISH" | "BEARISH" | "RANGING" | null {
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

export function evaluateM5Confirmation(
  m5Candles: Candle[],
  m15LastTime: string,
  poi: Poi | null,
): M5ConfirmationResult {
  if (!poi || m5Candles.length < 3) {
    return {
      poiTouched: false,
      rejectionDetected: false,
      displacementDetected: false,
      structureBreakDetected: false,
      m5Confirmed: false,
      diagnostics: "No POI established for M5 confirmation",
    };
  }

  // EXCLUDE currently forming candle: use CLOSED M5 candles only
  const closedM5 = m5Candles.slice(0, -1);
  if (closedM5.length < 2) {
    return {
      poiTouched: false,
      rejectionDetected: false,
      displacementDetected: false,
      structureBreakDetected: false,
      m5Confirmed: false,
      diagnostics: "Not enough closed M5 candles to evaluate confirmation",
    };
  }

  // Prerequisite 1: Find POI Touch on CLOSED M5 candles
  const touchIndex = closedM5.findIndex(
    (candle) =>
      candle.time > m15LastTime &&
      candle.high >= poi.low &&
      candle.low <= poi.high,
  );

  if (touchIndex === -1) {
    return {
      poiTouched: false,
      rejectionDetected: false,
      displacementDetected: false,
      structureBreakDetected: false,
      m5Confirmed: false,
      diagnostics: "POI not yet touched on closed M5 candles",
    };
  }

  const postTouchCandles = closedM5.slice(touchIndex);
  const m5Atr = atr(closedM5, 10) || 0.0001;
  const isBullishSetup = poi.type === "OB_BULL" || poi.type === "FVG";

  // Check 1: Rejection / Reaction from POI
  let rejectionDetected = false;
  for (const c of postTouchCandles) {
    const totalRange = c.high - c.low;
    if (totalRange <= 0) continue;
    if (isBullishSetup) {
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (lowerWick >= 0.3 * totalRange || (c.close > c.open && lowerWick >= 0.2 * totalRange)) {
        rejectionDetected = true;
        break;
      }
    } else {
      const upperWick = c.high - Math.max(c.open, c.close);
      if (upperWick >= 0.3 * totalRange || (c.close < c.open && upperWick >= 0.2 * totalRange)) {
        rejectionDetected = true;
        break;
      }
    }
  }

  // Check 2: M5 Displacement in setup direction
  let displacementDetected = false;
  for (const c of postTouchCandles) {
    const body = Math.abs(c.close - c.open);
    if (isBullishSetup) {
      if (c.close > c.open && body >= 0.8 * m5Atr) {
        displacementDetected = true;
        break;
      }
    } else {
      if (c.close < c.open && body >= 0.8 * m5Atr) {
        displacementDetected = true;
        break;
      }
    }
  }

  // Check 3: M5 Structure Break / Micro MSS
  let structureBreakDetected = false;
  const m5Swings = detectSwings(closedM5, 3);
  if (isBullishSetup) {
    const m5Highs = m5Swings.filter((s) => s.type === "HIGH" && s.index <= touchIndex + 3);
    const lastHigh = m5Highs.at(-1);
    if (lastHigh) {
      structureBreakDetected = postTouchCandles.some((c) => c.close > lastHigh.price);
    } else {
      // Fallback to highest high during touch
      const touchHigh = Math.max(...closedM5.slice(Math.max(0, touchIndex - 3), touchIndex + 1).map((c) => c.high));
      structureBreakDetected = postTouchCandles.some((c) => c.close > touchHigh);
    }
  } else {
    const m5Lows = m5Swings.filter((s) => s.type === "LOW" && s.index <= touchIndex + 3);
    const lastLow = m5Lows.at(-1);
    if (lastLow) {
      structureBreakDetected = postTouchCandles.some((c) => c.close < lastLow.price);
    } else {
      const touchLow = Math.min(...closedM5.slice(Math.max(0, touchIndex - 3), touchIndex + 1).map((c) => c.low));
      structureBreakDetected = postTouchCandles.some((c) => c.close < touchLow);
    }
  }

  const m5Confirmed = rejectionDetected && displacementDetected && structureBreakDetected;
  const diagnostics = m5Confirmed
    ? "M5 confirmation verified: POI touched, rejection, displacement, and micro MSS confirmed"
    : `M5 POI touched; pending full confirmation (rejection: ${rejectionDetected}, displacement: ${displacementDetected}, micro MSS: ${structureBreakDetected})`;

  return {
    poiTouched: true,
    rejectionDetected,
    displacementDetected,
    structureBreakDetected,
    m5Confirmed,
    diagnostics,
  };
}

export function calculateSetupScore(input: {
  htfBias: string | null;
  htfConflict: boolean;
  liquiditySwept: boolean;
  poiPresent: boolean;
  bosMssPresent: boolean;
  m5Confirmed: boolean;
}): SetupScoreResult {
  let htfAlignment = 0;
  if (input.htfBias && !input.htfConflict) {
    htfAlignment = 25;
  } else if (input.htfBias && input.htfConflict) {
    htfAlignment = 12;
  }

  const liquiditySweep = input.liquiditySwept ? 25 : 0;
  const poiQuality = input.poiPresent ? 20 : 0;
  const bosMss = input.bosMssPresent ? 15 : 0;
  const m5Confirmation = input.m5Confirmed ? 15 : 0;

  const totalScore = htfAlignment + liquiditySweep + poiQuality + bosMss + m5Confirmation;

  return {
    totalScore,
    breakdown: {
      htfAlignment,
      liquiditySweep,
      poiQuality,
      bosMss,
      m5Confirmation,
    },
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
      bosMssTag: null,
      setupScore: 0,
    };
  }

  const averageAtr = atr(m15);
  const externalSwings = detectSwings(m15, 10);
  const internalSwings = detectSwings(m15, 5);
  const trend = calculateTrend(externalSwings);

  // 1. Independent Liquidity Pool & Sweep Evaluation
  const rawPools = findPools(m15, externalSwings, averageAtr);
  const { pools, activeSweep } = evaluateLiquiditySweeps(m15, rawPools);

  // 2. Independent BOS / MSS Detection
  const bosMssResult = detectBosMss(m15, internalSwings);

  // 3. POI / FVG Detection
  const poi = detectPoi(m15, internalSwings, averageAtr);

  // 4. HTF Trend & Alignment
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

  // 5. M5 Confirmation Evaluation (Closed candles only)
  const lastM15Time = m15[m15.length - 1].time;
  const m5Eval = evaluateM5Confirmation(m5, lastM15Time, poi);

  if (poi) {
    poi.touched = m5Eval.poiTouched;
  }

  // 6. Setup Score Calculation with Truthful Inputs
  const isLiquiditySwept = pools.some((p) => p.swept);
  const setupScore = calculateSetupScore({
    htfBias,
    htfConflict,
    liquiditySwept: isLiquiditySwept,
    poiPresent: Boolean(poi),
    bosMssPresent: bosMssResult.detected,
    m5Confirmed: m5Eval.m5Confirmed,
  });

  // 7. State Machine determination
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

  const diagnostics = [
    `M15 trend ${trend ?? "UNKNOWN"}; daily ${dailyTrend ?? "UNKNOWN"}; H4 ${h4Trend ?? "UNKNOWN"}`,
    pools.length
      ? `${pools.length} liquidity pool${pools.length === 1 ? "" : "s"} detected (${pools.filter((p) => p.swept).length} swept)`
      : "No equal-high/equal-low pool within threshold",
    activeSweep
      ? `${activeSweep.type} sweep confirmed on closed candle`
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
    `Setup Score: ${setupScore.totalScore}/100`,
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
    bosMssTag: bosMssResult.tag,
    setupScore: setupScore.totalScore,
  };
}