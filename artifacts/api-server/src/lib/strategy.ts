import {
  executeMetaApiTrade,
  getHistoricalCandles,
  getLiveAccountSnapshot,
  isTradingHalted,
  moveMetaApiPositionStopToBreakEven,
  type Candle,
  type MetaApiSymbolPrice,
  type MetaApiSymbolSpecification,
} from "./metaapi";
import { hasHighImpactNewsWithin } from "./market";
import { logger } from "./logger";
import { insertJournal } from "./db";

export { type Candle };

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
  type: "OB_BULL" | "OB_BEAR" | "FVG";
};

export type PropMetrics = {
  startingBalance?: number | null;
  highestEquity?: number | null;
  dailyStartingEquity?: number | null;
  maxDrawdownPct?: number | null;
  dailyDrawdownPct?: number | null;
};

export type SetupEvaluationInput = {
  htfBias?: string | null;
  htfConflict?: boolean;
  trend?: string | null;
  pools?: Pool[];
  sweep?: Pool | null;
  poi?: Poi | null;
  m5Triggered?: boolean;
  m1Triggered?: boolean;
  propSafety?: { safe: boolean; reason?: string; riskMultiplier?: number };
  newsBlocked?: boolean;
  spreadBlocked?: boolean;
  cooldownActive?: boolean;
  killSwitchActive?: boolean;
};

export type TradeRiskInput = {
  accountId: string;
  symbol: string;
  realSymbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  sl: number;
  tp: number;
  requestedLot?: number;
  profileMetrics?: PropMetrics | null;
  riskSettings?: {
    riskPerTrade?: number;
    dailyLoss?: number;
    weeklyLoss?: number;
    spreadMultiplier?: number;
    newsMinutes?: number;
  };
  liveAccount?: {
    equity: number | null;
    balance: number | null;
    freeMargin: number | null;
    leverage: number | null;
    connected: boolean;
    positions: Array<{ id?: string | null; symbol?: string | null; type?: string | null }>;
  };
  symbolSpec?: MetaApiSymbolSpecification;
  symbolPrice?: MetaApiSymbolPrice;
  recentCandles?: Candle[];
};

export type PostExecutionPipelineInput = {
  accountId: string;
  symbol: string;
  realSymbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  sl: number;
  tp: number;
  lot: number;
  poiType?: string | null;
  bosMssTag?: string | null;
  leverage: number;
  marginUsed: number;
};

export type PostExecutionPipelineDeps = {
  executeMetaApiTrade: typeof executeMetaApiTrade;
  getLiveAccountSnapshot: typeof getLiveAccountSnapshot;
  moveMetaApiPositionStopToBreakEven: typeof moveMetaApiPositionStopToBreakEven;
  insertJournal?: typeof insertJournal;
};

const defaultDeps: PostExecutionPipelineDeps = {
  executeMetaApiTrade,
  getLiveAccountSnapshot,
  moveMetaApiPositionStopToBreakEven,
  insertJournal,
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

/**
 * Requirement 3 & 1: M1 Micro Confirmation Evaluation
 * Strict mandatory M1 trigger using closed candles only (anti-lookahead).
 * Requires direction alignment, M1 displacement body, M1 MSS/BOS, and POI interaction.
 * Fallback to M5 confirmation is removed. Missing/insufficient M1 = false.
 */
export function analyzeM1Confirmation(input: {
  m1Candles?: Candle[] | null;
  poiType?: string | null;
  poiHigh?: number | null;
  poiLow?: number | null;
  m5Triggered?: boolean;
}): { m1Triggered: boolean; reason?: string; direction?: "BUY" | "SELL" } {
  const { m1Candles, poiType, poiHigh, poiLow, m5Triggered } = input;
  if (!m1Candles || !Array.isArray(m1Candles) || m1Candles.length === 0) {
    return { m1Triggered: false, reason: "M1 historical data unavailable" };
  }

  // Use closed M1 candles ONLY (ignore forming candle)
  const closedM1 = m1Candles.length > 1 ? m1Candles.slice(0, -1) : [];
  if (closedM1.length < 10) {
    return { m1Triggered: false, reason: "Insufficient M1 closed candles (minimum 10 required)" };
  }

  if (!m5Triggered) {
    return { m1Triggered: false, reason: "Missing M5 POI confirmation" };
  }

  if (!poiType || poiHigh === null || poiHigh === undefined || poiLow === null || poiLow === undefined) {
    return { m1Triggered: false, reason: "Missing POI parameters" };
  }

  const expectedDirection: "BUY" | "SELL" =
    poiType === "OB_BULL" || poiType.includes("BULL") ? "BUY" : "SELL";

  const m1Atr = atr(closedM1, 14);
  if (m1Atr <= 0) {
    return { m1Triggered: false, reason: "Invalid M1 ATR calculation" };
  }

  const lastClosed = closedM1[closedM1.length - 1];
  const lastBody = Math.abs(lastClosed.close - lastClosed.open);

  // 1. Direction alignment
  if (expectedDirection === "BUY" && lastClosed.close <= lastClosed.open) {
    return { m1Triggered: false, reason: "Latest closed M1 candle is not bullish" };
  }
  if (expectedDirection === "SELL" && lastClosed.close >= lastClosed.open) {
    return { m1Triggered: false, reason: "Latest closed M1 candle is not bearish" };
  }

  // 2. M1 Displacement
  if (lastBody < m1Atr * 0.7) {
    return { m1Triggered: false, reason: "M1 displacement body size below threshold" };
  }

  // 3. M1 Micro structure break / MSS / BOS
  const previousClosed = closedM1.slice(0, -1);
  const m1Swings = detectSwings(previousClosed, 2);
  if (expectedDirection === "BUY") {
    const swingHighs = m1Swings.filter((s) => s.type === "HIGH");
    if (!swingHighs.length) {
      return { m1Triggered: false, reason: "No M1 swing high found for bullish MSS" };
    }
    const recentHigh = Math.max(...swingHighs.slice(-3).map((s) => s.price));
    if (lastClosed.close <= recentHigh) {
      return { m1Triggered: false, reason: "M1 closed candle did not break recent swing high (no bullish MSS)" };
    }
  } else {
    const swingLows = m1Swings.filter((s) => s.type === "LOW");
    if (!swingLows.length) {
      return { m1Triggered: false, reason: "No M1 swing low found for bearish MSS" };
    }
    const recentLow = Math.min(...swingLows.slice(-3).map((s) => s.price));
    if (lastClosed.close >= recentLow) {
      return { m1Triggered: false, reason: "M1 closed candle did not break recent swing low (no bearish MSS)" };
    }
  }

  // 4. Interaction / rejection from M5-confirmed POI zone
  const zoneTouched = closedM1.slice(-5).some(
    (c) => c.high >= poiLow && c.low <= poiHigh,
  );
  if (!zoneTouched) {
    return { m1Triggered: false, reason: "No closed M1 candle interaction with M5 POI zone" };
  }

  return { m1Triggered: true, direction: expectedDirection };
}

/**
 * Requirement 2: Remove dangerous M1 default.
 * Missing/undefined/null M1 confirmation MUST resolve to false.
 * Strategy score MUST NEVER compensate for missing M1.
 */
export function evaluateStrategySetup(input: SetupEvaluationInput) {
  const m1Triggered = input.m1Triggered ?? false;
  const m5Triggered = input.m5Triggered ?? false;
  const htfConflict = Boolean(input.htfConflict);
  const sweep = input.sweep ?? null;
  const poi = input.poi ?? null;
  const cooldownActive = Boolean(input.cooldownActive);
  const killSwitchActive = Boolean(input.killSwitchActive);
  const newsBlocked = Boolean(input.newsBlocked);
  const spreadBlocked = Boolean(input.spreadBlocked);
  const propSafety = input.propSafety ?? { safe: false, reason: "PROP safety evaluation missing" };

  const failedConditions: string[] = [];

  if (!poi) failedConditions.push("Missing POI");
  if (!sweep) failedConditions.push("Missing liquidity sweep");
  if (htfConflict) failedConditions.push("HTF conflict active");
  if (!m5Triggered) failedConditions.push("Missing M5 POI confirmation");
  if (!m1Triggered) failedConditions.push("Missing M1 micro confirmation");
  if (!propSafety.safe) failedConditions.push(`PROP safety rejected: ${propSafety.reason ?? "Unsafe"}`);
  if (newsBlocked) failedConditions.push("High-impact news blackout active");
  if (spreadBlocked) failedConditions.push("Excessive broker spread");
  if (cooldownActive) failedConditions.push("Cooldown active");
  if (killSwitchActive) failedConditions.push("Kill switch / trading halt active");

  let score = 0;
  if (poi) score += 20;
  if (sweep) score += 20;
  if (!htfConflict && input.htfBias) score += 20;
  if (m5Triggered) score += 20;
  if (m1Triggered) score += 20;

  const executable = failedConditions.length === 0;

  return {
    score,
    m1Triggered,
    m5Triggered,
    executable,
    failedConditions,
    reason: executable ? "All mandatory strategy conditions satisfied" : failedConditions.join("; "),
  };
}

/**
 * Requirement 5: Fail-closed PROP safety evaluation.
 * Missing/invalid metrics = BLOCK.
 * Exceptions = BLOCK.
 */
export function evaluatePropSafety(
  profileMetrics: PropMetrics | null | undefined,
  accountEquity: number | null | undefined,
): { safe: boolean; reason?: string; riskMultiplier?: number; totalDrawdownPct?: number; dailyDrawdownPct?: number } {
  try {
    if (!profileMetrics || typeof profileMetrics !== "object") {
      return { safe: false, reason: "Missing PROP profile metrics" };
    }
    if (accountEquity === null || accountEquity === undefined || !Number.isFinite(accountEquity) || accountEquity <= 0) {
      return { safe: false, reason: "Invalid account equity" };
    }

    const startingBalance = Number(profileMetrics.startingBalance);
    const highestEquity = Number(profileMetrics.highestEquity);
    const dailyStartingEquity = Number(profileMetrics.dailyStartingEquity);
    const maxDrawdownLimit = Number(profileMetrics.maxDrawdownPct ?? 10);
    const dailyDrawdownLimit = Number(profileMetrics.dailyDrawdownPct ?? 5);

    if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
      return { safe: false, reason: "Invalid starting balance in PROP metrics" };
    }
    if (!Number.isFinite(highestEquity) || highestEquity <= 0) {
      return { safe: false, reason: "Invalid highest equity in PROP metrics" };
    }
    if (!Number.isFinite(dailyStartingEquity) || dailyStartingEquity <= 0) {
      return { safe: false, reason: "Invalid daily starting equity in PROP metrics" };
    }

    const totalDrawdownPct = ((highestEquity - accountEquity) / highestEquity) * 100;
    const dailyDrawdownPct = ((dailyStartingEquity - accountEquity) / dailyStartingEquity) * 100;

    if (totalDrawdownPct >= maxDrawdownLimit) {
      return {
        safe: false,
        reason: `Max drawdown limit breached (${totalDrawdownPct.toFixed(2)}% >= ${maxDrawdownLimit}%)`,
        totalDrawdownPct,
        dailyDrawdownPct,
      };
    }
    if (dailyDrawdownPct >= dailyDrawdownLimit) {
      return {
        safe: false,
        reason: `Daily drawdown limit breached (${dailyDrawdownPct.toFixed(2)}% >= ${dailyDrawdownLimit}%)`,
        totalDrawdownPct,
        dailyDrawdownPct,
      };
    }

    const isDefensive = totalDrawdownPct >= maxDrawdownLimit * 0.7 || dailyDrawdownPct >= dailyDrawdownLimit * 0.7;
    const riskMultiplier = isDefensive ? 0.5 : 1.0;

    return {
      safe: true,
      riskMultiplier,
      totalDrawdownPct,
      dailyDrawdownPct,
      reason: isDefensive ? "Defensive posture active (drawdown > 70% of limit)" : "PROP metrics within safe limits",
    };
  } catch (error) {
    return {
      safe: false,
      reason: `PROP safety evaluation exception: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Requirement 4 & 5: Authoritative Trade Risk Evaluation
 */
export async function evaluateTradeRisk(input: TradeRiskInput): Promise<{
  approved: boolean;
  reason?: string;
  calculatedLot?: number;
  marginUsed?: number;
  riskMultiplier?: number;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];

  if (isTradingHalted(input.accountId)) {
    return { approved: false, reason: "Trading halted by emergency stop", diagnostics: ["Trading halted"] };
  }

  const live = input.liveAccount;
  if (!live || !live.connected || !live.equity || live.equity <= 0 || !live.leverage) {
    return { approved: false, reason: "Real broker connection, leverage, and equity are required", diagnostics: ["Live broker snapshot invalid"] };
  }

  const propResult = evaluatePropSafety(input.profileMetrics, live.equity);
  if (!propResult.safe) {
    return { approved: false, reason: `PROP safety blocked: ${propResult.reason}`, diagnostics: [propResult.reason ?? "PROP safety failed"] };
  }

  const positions = live.positions.filter((p): p is typeof p & { symbol: string } => typeof p.symbol === "string");
  if (positions.some((p) => p.symbol === input.symbol || p.symbol === input.realSymbol)) {
    return { approved: false, reason: "Duplicate symbol position already open", diagnostics: ["Duplicate symbol blocked"] };
  }
  const correlatedGroups = [
    ["XAUUSD", "GOLD", "NAS100", "US100", "US30", "DJ30"],
    ["EURUSD", "GBPUSD"],
  ];
  const group = correlatedGroups.find((g) => g.includes(input.symbol) || g.includes(input.realSymbol));
  if (group && positions.filter((p) => group.some((gSymbol) => p.symbol.includes(gSymbol))).length >= 2) {
    return { approved: false, reason: "Correlated position limit reached", diagnostics: ["Correlated position limit reached"] };
  }

  const day = new Date();
  if (day.getUTCDay() === 5 && (day.getUTCHours() > 21 || (day.getUTCHours() === 21 && day.getUTCMinutes() >= 45))) {
    return { approved: false, reason: "Friday 21:45 GMT close — no new trades allowed", diagnostics: ["Friday cutoff blocked"] };
  }

  const newsMinutes = input.riskSettings?.newsMinutes ?? 30;
  try {
    const news = await hasHighImpactNewsWithin(input.symbol, newsMinutes);
    if (news.blocked) {
      return { approved: false, reason: `High-impact news blackout: ${news.event}`, diagnostics: [`News blocked: ${news.event}`] };
    }
  } catch (error) {
    logger.warn({ error, symbol: input.symbol }, "News check failed");
  }

  const spec = input.symbolSpec;
  const price = input.symbolPrice;
  if (!spec || !price || price.bid === null || price.ask === null) {
    return { approved: false, reason: "Broker symbol price or specification missing", diagnostics: ["Price/Spec missing"] };
  }

  const tickTime = price.time ? new Date(price.time).getTime() : NaN;
  if (Number.isNaN(tickTime) || Date.now() - tickTime > 30_000) {
    return { approved: false, reason: "Live price data is missing or stale (>30s)", diagnostics: ["Stale price"] };
  }

  if (spec.tradeMode && /DISABLED|CLOSEONLY/i.test(spec.tradeMode)) {
    return { approved: false, reason: `Broker symbol trade mode disabled: ${spec.tradeMode}`, diagnostics: ["Trade mode disabled"] };
  }

  const spread = price.ask - price.bid;
  const candles = input.recentCandles ?? [];
  const closedCandles = candles.length > 1 ? candles.slice(0, -1) : candles;
  const averageAtr = closedCandles.length >= 14
    ? closedCandles.slice(-14).reduce((sum, c) => sum + Math.abs(c.high - c.low), 0) / 14
    : 0;
  const tickSize = spec.tickSize ?? 0.00001;
  const spreadMultiplier = input.riskSettings?.spreadMultiplier ?? 2.5;
  const maxSpread = Math.max(tickSize, averageAtr * 0.1) * spreadMultiplier;
  if (spread > maxSpread) {
    return { approved: false, reason: `Spread (${spread.toFixed(5)}) exceeds threshold (${maxSpread.toFixed(5)})`, diagnostics: ["Spread threshold exceeded"] };
  }

  const entryPrice = input.entryPrice;
  const slDistance = Math.abs(entryPrice - input.sl);
  const tpDistance = Math.abs(input.tp - entryPrice);
  if (averageAtr > 0) {
    if (slDistance < averageAtr * 0.8 || slDistance > averageAtr * 2.5) {
      return { approved: false, reason: "SL distance must be between 0.8 ATR and 2.5 ATR", diagnostics: ["SL distance invalid"] };
    }
  }
  const rewardRisk = tpDistance / slDistance;
  if (rewardRisk < 2.0 || rewardRisk > 3.0) {
    return { approved: false, reason: `TP must target a 1:2 to 1:3 risk-to-reward ratio (current: 1:${rewardRisk.toFixed(2)})`, diagnostics: ["Invalid R:R ratio"] };
  }

  const baseRiskPct = (input.riskSettings?.riskPerTrade ?? 1) / 100;
  const effectiveRiskPct = baseRiskPct * (propResult.riskMultiplier ?? 1.0);
  const tickValue = spec.tickValue ?? 1;
  const lossPerLot = (slDistance / tickSize) * tickValue;
  if (lossPerLot <= 0) {
    return { approved: false, reason: "Invalid loss per lot calculation", diagnostics: ["Invalid loss per lot"] };
  }

  const requestedMoney = live.equity * effectiveRiskPct;
  const rawLot = requestedMoney / lossPerLot;
  const volumeStep = spec.volumeStep ?? 0.01;
  const calculatedLot = Math.floor(rawLot / volumeStep) * volumeStep;

  if (spec.volumeMin !== null && calculatedLot < spec.volumeMin) {
    return { approved: false, reason: "Calculated lot size is below broker minimum volume", diagnostics: ["Below min lot"] };
  }

  const finalLot = spec.volumeMax !== null ? Math.min(calculatedLot, spec.volumeMax) : calculatedLot;

  const contractSize = spec.contractSize ?? 100000;
  const marginUsed = (finalLot * contractSize * entryPrice) / live.leverage;
  if ((live.freeMargin !== null && marginUsed > live.freeMargin) || marginUsed > live.equity * 0.5) {
    return { approved: false, reason: "Broker free-margin or safety limit exceeded", diagnostics: ["Margin limit exceeded"] };
  }

  return {
    approved: true,
    calculatedLot: finalLot,
    marginUsed,
    riskMultiplier: propResult.riskMultiplier,
    diagnostics: ["Trade risk evaluation approved"],
  };
}

/**
 * Requirement 4: Post-Execution Pipeline & Journal Persistence
 */
export async function runPostExecutionPipeline(
  input: PostExecutionPipelineInput,
  deps: PostExecutionPipelineDeps = defaultDeps,
) {
  const actionType = input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const result = await deps.executeMetaApiTrade({
    accountId: input.accountId,
    actionType,
    symbol: input.realSymbol,
    volume: input.lot,
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

  const liveSnapshot = await deps.getLiveAccountSnapshot(input.accountId);
  const position = liveSnapshot.positions.find(
    (p) =>
      (brokerPositionId && p.id === brokerPositionId) ||
      (p.symbol === input.realSymbol && p.type && p.type.toUpperCase().includes(input.direction)),
  );

  if (!position) {
    throw new Error("Broker position verification failed: position not found on broker after execution");
  }

  let emergencyCorrection = false;
  if (
    (position.stopLoss !== null && Math.abs(position.stopLoss - input.sl) > 0.0001) ||
    (position.takeProfit !== null && Math.abs(position.takeProfit - input.tp) > 0.0001) ||
    position.stopLoss === null ||
    position.takeProfit === null
  ) {
    if (position.id) {
      try {
        await deps.moveMetaApiPositionStopToBreakEven({
          accountId: input.accountId,
          positionId: position.id,
          entryPrice: input.sl,
          takeProfit: input.tp,
        });
        emergencyCorrection = true;
      } catch (err) {
        logger.warn({ err, positionId: position.id }, "Emergency SL/TP correction failed");
      }
    }
  }

  // Journal Persistence
  const persistFunc = deps.insertJournal ?? insertJournal;
  try {
    await persistFunc({
      account_id: input.accountId,
      symbol: input.symbol,
      real_symbol: input.realSymbol,
      direction: input.direction,
      entry: input.entryPrice,
      sl: input.sl,
      initial_sl: input.sl,
      tp: input.tp,
      lot: input.lot,
      pnl: 0,
      r_multiple: 0,
      status: "OPEN",
      broker_position_id: brokerPositionId ?? position.id ?? null,
      broker_order_id: orderId,
      broker_status: "OPEN",
      poi_type: input.poiType ?? null,
      bos_mss_tag: input.bosMssTag ?? null,
      htf_bias: null,
      leverage: input.leverage,
      margin_used: input.marginUsed,
    });
  } catch (err) {
    logger.warn({ err, accountId: input.accountId, symbol: input.symbol }, "Journal persistence failed following order execution");
  }

  return {
    orderId,
    positionId: brokerPositionId ?? position.id,
    accountId: input.accountId,
    symbol: input.symbol,
    direction: input.direction,
    lot: input.lot,
    entry: input.entryPrice,
    sl: input.sl,
    tp: input.tp,
    leverage: input.leverage,
    marginUsed: input.marginUsed,
    status: "OPEN",
    emergencyCorrection,
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

  const [h4, daily, m5, m1] = await Promise.all([
    getHistoricalCandles(accountId, realSymbol, "4h", 120).catch(() => []),
    getHistoricalCandles(accountId, realSymbol, "1d", 60).catch(() => []),
    getHistoricalCandles(accountId, realSymbol, "5m", 80).catch(() => []),
    getHistoricalCandles(accountId, realSymbol, "1m", 120).catch(() => []),
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
      m5Triggered: false,
      m1Triggered: false,
    };
  }

  // ANTI-LOOKAHEAD: Use closed candles ONLY!
  const closedM15 = m15.length > 1 ? m15.slice(0, -1) : m15;
  const closedDaily = daily.length > 1 ? daily.slice(0, -1) : daily;
  const closedH4 = h4.length > 1 ? h4.slice(0, -1) : h4;
  const closedM5 = m5.length > 1 ? m5.slice(0, -1) : m5;

  const averageAtr = atr(closedM15);
  const externalSwings = detectSwings(closedM15, 10);
  const internalSwings = detectSwings(closedM15, 5);
  const trend = calculateTrend(externalSwings);
  const pools = findPools(closedM15, externalSwings, averageAtr);

  const lastClosedM15 = closedM15[closedM15.length - 1];
  const sweep = pools.find((pool) => {
    return pool.type === "BSL"
      ? lastClosedM15.high >= pool.avgPrice + averageAtr * 0.2 &&
          lastClosedM15.close < pool.avgPrice
      : lastClosedM15.low <= pool.avgPrice - averageAtr * 0.2 &&
          lastClosedM15.close > pool.avgPrice;
  });

  const displacement = inferPoi(closedM15, internalSwings, pools, averageAtr);
  const dailyTrend = calculateTrend(detectSwings(closedDaily, 3));
  const h4Trend = calculateTrend(detectSwings(closedH4, 5));

  const dailyHigh = Math.max(...closedDaily.slice(-50).map((candle) => candle.high));
  const dailyLow = Math.min(...closedDaily.slice(-50).map((candle) => candle.low));
  const equilibrium = (dailyHigh + dailyLow) / 2;
  const htfBias =
    dailyTrend === "BULLISH" && lastClosedM15.close <= equilibrium
      ? "BULLISH_DISCOUNT"
      : dailyTrend === "BEARISH" && lastClosedM15.close >= equilibrium
        ? "BEARISH_PREMIUM"
        : dailyTrend ?? null;

  const htfConflict =
    (dailyTrend === "BULLISH" && h4Trend === "BEARISH") ||
    (dailyTrend === "BEARISH" && h4Trend === "BULLISH");

  const poi = displacement.poi;

  // Closed M5 confirmation check
  const m5Triggered = Boolean(
    poi &&
    closedM5.some(
      (candle) =>
        candle.time > closedM15[closedM15.length - 1].time &&
        candle.high >= poi.low &&
        candle.low <= poi.high,
    ),
  );

  // M1 Micro confirmation evaluation
  const m1Result = analyzeM1Confirmation({
    m1Candles: m1,
    poiType: poi?.type,
    poiHigh: poi?.high,
    poiLow: poi?.low,
    m5Triggered,
  });

  const state = poi
    ? m1Result.m1Triggered
      ? "EXECUTABLE"
      : m5Triggered
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
    sweep ? `${sweep.type} sweep detected in latest closed M15 candle` : "Waiting for a valid liquidity sweep",
    poi
      ? `${poi.type} created at M15 index ${poi.creationIndex}; expires after 50 bars`
      : "Waiting for displacement body > 1.5 ATR and internal break",
    htfConflict
      ? "HTF conflict — risk must be reduced to 50%"
      : htfBias
        ? `HTF location ${htfBias}`
        : "HTF premium/discount not aligned",
    m5Triggered
      ? m1Result.m1Triggered
        ? "M1 micro confirmation satisfied — entry candidate"
        : `M5 POI touched; waiting for M1 micro confirmation (${m1Result.reason ?? "M1 pending"})`
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
    m5Triggered,
    m1Triggered: m1Result.m1Triggered,
    m1Reason: m1Result.reason,
    m1Direction: m1Result.direction,
  };
}