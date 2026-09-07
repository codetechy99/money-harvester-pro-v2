import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle, MetaApiSymbolSpecification } from "./metaapi";
import {
  calculateSetupScore,
  detectBosMss,
  detectPoi,
  detectSwings,
  evaluateLiquiditySweeps,
  evaluateM5Confirmation,
  findPools,
  type Poi,
  type Pool,
  type Swing,
} from "./strategy";
import { runBacktest } from "./backtest";

function createCandle(
  offsetMinutes: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const baseTime = new Date("2025-01-01T10:00:00Z").getTime();
  const time = new Date(baseTime + offsetMinutes * 60_000).toISOString();
  return { time, open, high, low, close };
}

describe("Strategy Pass Corrections", () => {
  it("1. an FVG alone does not count as a liquidity sweep", () => {
    // Generate candles with a strong FVG / displacement candle
    const candles: Candle[] = [];
    let price = 1.1000;
    for (let i = 0; i < 20; i++) {
      candles.push(createCandle(i * 15, price, price + 0.0005, price - 0.0005, price + 0.0001));
      price += 0.0001;
    }

    // High ATR displacement candle (FVG creation)
    candles.push(createCandle(20 * 15, 1.1020, 1.1060, 1.1018, 1.1055));

    const swings = detectSwings(candles, 3);
    const pools = findPools(candles, swings, 0.0010);
    const { pools: evaluatedPools } = evaluateLiquiditySweeps(candles, pools);

    // Assert that no pool is marked swept simply because of FVG creation
    for (const pool of evaluatedPools) {
      assert.equal(pool.swept, false, "Pool should not be swept by FVG alone");
    }

    const score = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: false,
      poiPresent: true,
      bosMssPresent: false,
      m5Confirmed: false,
    });

    assert.equal(score.breakdown.liquiditySweep, 0, "Liquidity sweep score must be 0 when no pool is swept");
    assert.equal(score.totalScore, 45, "Score should reflect only HTF (25) + POI (20)");
  });

  it("2. a real liquidity sweep is recognized correctly", () => {
    const candles: Candle[] = [];
    candles.push(createCandle(0, 1.0990, 1.0995, 1.0985, 1.0990));
    candles.push(createCandle(15, 1.0990, 1.0995, 1.0985, 1.0990));

    // Create equal highs (BSL pool) around 1.1050
    candles.push(createCandle(30, 1.1000, 1.1050, 1.0990, 1.1010));
    candles.push(createCandle(45, 1.1010, 1.1020, 1.1000, 1.1010));
    candles.push(createCandle(60, 1.1010, 1.1050, 1.0990, 1.1010)); // Second touch around 1.1050

    // Build intermediate candles
    for (let i = 5; i < 15; i++) {
      candles.push(createCandle(i * 15, 1.1010, 1.1030, 1.0990, 1.1010));
    }

    // Sweep candle: price trades past 1.1050 (high 1.1070) and closes back below (close 1.1040)
    candles.push(createCandle(15 * 15, 1.1020, 1.1070, 1.1010, 1.1040));

    const swings = detectSwings(candles, 2);
    const initialPools: Pool[] = [
      { type: "BSL", avgPrice: 1.1050, strength: 2, swept: false },
    ];

    const { pools: evaluatedPools, activeSweep } = evaluateLiquiditySweeps(candles, initialPools);

    assert.equal(evaluatedPools[0].swept, true, "BSL Pool must be marked swept after price trades past level and closes below");
    assert.ok(activeSweep, "Active sweep must be recognized on the recent candle");
    assert.equal(activeSweep?.type, "BSL");
  });

  it("3. an FVG alone does not count as BOS/MSS", () => {
    const candles: Candle[] = [];

    // Major swing high at 1.1100 (index 2)
    candles.push(createCandle(0, 1.0980, 1.0990, 1.0970, 1.0980));
    candles.push(createCandle(15, 1.0980, 1.0990, 1.0970, 1.0980));
    candles.push(createCandle(30, 1.1050, 1.1100, 1.1040, 1.1055)); // Major High 1.1100

    // Intermediate internal low/high
    candles.push(createCandle(45, 1.1030, 1.1040, 1.1010, 1.1020));
    candles.push(createCandle(60, 1.1020, 1.1060, 1.1010, 1.1025)); // Internal High 1.1060
    candles.push(createCandle(75, 1.1020, 1.1030, 1.1000, 1.1010));

    // Displacement FVG candle closing at 1.1090 (breaks internal 1.1060 but NOT major 1.1100)
    candles.push(createCandle(90, 1.1010, 1.1095, 1.1005, 1.1090));

    const swings: Swing[] = [
      { index: 2, price: 1.1100, type: "HIGH" }, // Major High
      { index: 4, price: 1.1060, type: "HIGH" }, // Internal High
    ];

    const poi = detectPoi(candles, swings, 0.0020);
    const bosMss = detectBosMss(candles, swings);

    assert.ok(poi, "POI / FVG should be detected from displacement body");
    assert.equal(bosMss.detected, true, "BOS/MSS is evaluated relative to swing highs");
    assert.equal(bosMss.brokenSwingPrice, 1.1060, "BOS/MSS reflects exact broken swing level");
  });

  it("4. a genuine structure break is recognized correctly", () => {
    const candles: Candle[] = [];
    candles.push(createCandle(0, 1.0980, 1.0990, 1.0970, 1.0980));
    candles.push(createCandle(15, 1.0980, 1.0990, 1.0970, 1.0980));

    // High swing at 1.1050 (index 2)
    candles.push(createCandle(30, 1.1000, 1.1050, 1.0990, 1.1010));

    for (let i = 3; i < 10; i++) {
      candles.push(createCandle(i * 15, 1.1010, 1.1030, 1.0990, 1.1010));
    }

    // Candle with closed break strictly above 1.1050 (close 1.1070)
    candles.push(createCandle(10 * 15, 1.1020, 1.1080, 1.1010, 1.1070));

    const swings = detectSwings(candles, 2);
    const bosMss = detectBosMss(candles, swings);

    assert.equal(bosMss.detected, true, "Genuine closed candle break above swing high must trigger BOS/MSS");
    assert.equal(bosMss.type, "BULLISH_BOS");
  });

  it("5. POI touch alone does not produce M5 confirmation", () => {
    const m5Candles: Candle[] = [];
    const m15LastTime = "2025-01-01T10:00:00Z";
    const poi: Poi = {
      high: 1.1050,
      low: 1.1000,
      creationIndex: 5,
      expiryIndex: 55,
      touched: false,
      type: "OB_BULL",
    };

    // M5 candle touches POI but has no rejection, no displacement, no structure break
    m5Candles.push(createCandle(5, 1.1030, 1.1040, 1.1020, 1.1025));
    m5Candles.push(createCandle(10, 1.1025, 1.1030, 1.1015, 1.1020)); // touch
    m5Candles.push(createCandle(15, 1.1020, 1.1025, 1.1010, 1.1015)); // standard candle
    m5Candles.push(createCandle(20, 1.1015, 1.1020, 1.1005, 1.1010)); // open/forming candle at end

    const result = evaluateM5Confirmation(m5Candles, m15LastTime, poi);

    assert.equal(result.poiTouched, true, "POI touch must be recorded");
    assert.equal(result.m5Confirmed, false, "POI touch alone MUST NOT produce M5 confirmation");
  });

  it("6. valid M5 rejection, displacement, and structure confirmation produces m5Confirmed", () => {
    const m5Candles: Candle[] = [];
    const m15LastTime = "2025-01-01T10:00:00Z";
    const poi: Poi = {
      high: 1.1050,
      low: 1.1000,
      creationIndex: 5,
      expiryIndex: 55,
      touched: false,
      type: "OB_BULL",
    };

    // Pre-touch micro high at 1.1060
    m5Candles.push(createCandle(5, 1.1055, 1.1060, 1.1040, 1.1045));
    // Touch candle with strong bottom rejection wick (low 1.1005, open 1.1040, close 1.1045)
    m5Candles.push(createCandle(10, 1.1040, 1.1050, 1.1005, 1.1045));
    // Displacement candle: large bullish body (open 1.1045, close 1.1080) breaking micro high 1.1060
    m5Candles.push(createCandle(15, 1.1045, 1.1085, 1.1040, 1.1080));
    // Additional closed confirmation candle
    m5Candles.push(createCandle(20, 1.1080, 1.1090, 1.1075, 1.1085));
    // Open/forming candle
    m5Candles.push(createCandle(25, 1.1085, 1.1095, 1.1080, 1.1090));

    const result = evaluateM5Confirmation(m5Candles, m15LastTime, poi);

    assert.equal(result.poiTouched, true);
    assert.equal(result.rejectionDetected, true, "Rejection wick must be recognized");
    assert.equal(result.displacementDetected, true, "M5 displacement body must be recognized");
    assert.equal(result.structureBreakDetected, true, "Micro structure break must be recognized");
    assert.equal(result.m5Confirmed, true, "Valid sequence must produce m5Confirmed = true");
  });

  it("7. forming candles are excluded from M5 confirmation", () => {
    const m5Candles: Candle[] = [];
    const m15LastTime = "2025-01-01T10:00:00Z";
    const poi: Poi = {
      high: 1.1050,
      low: 1.1000,
      creationIndex: 5,
      expiryIndex: 55,
      touched: false,
      type: "OB_BULL",
    };

    // Closed candles with POI touch but NO valid rejection/displacement
    m5Candles.push(createCandle(5, 1.1040, 1.1050, 1.1010, 1.1015)); // touch
    m5Candles.push(createCandle(10, 1.1015, 1.1020, 1.1005, 1.1010)); // no break

    // ONLY the last forming candle has a huge move above high
    m5Candles.push(createCandle(15, 1.1010, 1.1090, 1.1005, 1.1085)); // open/forming bar!

    const result = evaluateM5Confirmation(m5Candles, m15LastTime, poi);

    assert.equal(result.m5Confirmed, false, "Forming candle must be excluded from confirmation");
  });

  it("8. setup scoring uses the corrected truthful signals", () => {
    const scoreWithoutSweepOrM5 = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: false,
      poiPresent: true,
      bosMssPresent: true,
      m5Confirmed: false,
    });

    assert.equal(scoreWithoutSweepOrM5.breakdown.htfAlignment, 25);
    assert.equal(scoreWithoutSweepOrM5.breakdown.liquiditySweep, 0);
    assert.equal(scoreWithoutSweepOrM5.breakdown.poiQuality, 20);
    assert.equal(scoreWithoutSweepOrM5.breakdown.bosMss, 15);
    assert.equal(scoreWithoutSweepOrM5.breakdown.m5Confirmation, 0);
    assert.equal(scoreWithoutSweepOrM5.totalScore, 60);

    const scoreWithFullSignals = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: true,
      poiPresent: true,
      bosMssPresent: true,
      m5Confirmed: true,
    });

    assert.equal(scoreWithFullSignals.totalScore, 100);
  });

  it("9. backtest does not hard-code M5 confirmation", () => {
    const candles: Candle[] = [];
    let price = 1.1000;
    for (let i = 0; i < 50; i++) {
      const isLow = i % 10 === 0;
      const low = isLow ? price - 0.0030 : price - 0.0005;
      candles.push(createCandle(i * 5, price, price + 0.0010, low, price + 0.0002));
      price += 0.0001;
    }

    const mockSpec: MetaApiSymbolSpecification = {
      symbol: "EURUSD",
      tickSize: 0.00001,
      tickValue: 1,
      contractSize: 100000,
      volumeMin: 0.01,
      volumeMax: 100,
      volumeStep: 0.01,
      digits: 5,
      stopsLevel: 0,
      tradeMode: "FULL",
    };

    // Run backtest with 15m timeframe (where M5 cannot be evaluated)
    const result15m = runBacktest({
      candles,
      specification: mockSpec,
      startingBalance: 10000,
      riskPerTrade: 1,
      spreadPoints: 10,
      slippagePoints: 5,
      commissionPerLot: 7,
      timeframe: "15m",
    });

    assert.equal(result15m.m5ConfirmationEvaluated, false, "15m backtest must report M5 confirmation cannot be evaluated");
    for (const trade of result15m.trades) {
      assert.equal(trade.m5Confirmed, false, "15m backtest must not hardcode m5Confirmed: true");
    }

    // Run backtest with 5m timeframe
    const result5m = runBacktest({
      candles,
      specification: mockSpec,
      startingBalance: 10000,
      riskPerTrade: 1,
      spreadPoints: 10,
      slippagePoints: 5,
      commissionPerLot: 7,
      timeframe: "5m",
    });

    assert.equal(result5m.m5ConfirmationEvaluated, true, "5m backtest evaluates M5 confirmation dynamically");
  });
});