import test from "node:test";
import assert from "node:assert/strict";
import {
  atr,
  detectSwings,
  findPools,
  evaluateLiquiditySweeps,
  detectBosMss,
  detectPoi,
  evaluateM5Confirmation,
  calculateSetupScore,
  type Candle,
  type Swing,
  type Pool,
  type Poi,
} from "./strategy";

function floorLot(value: number, volumeStep: number) {
  const steps = Math.floor(Math.round((value / volumeStep) * 1e8) / 1e8);
  const decimals = (volumeStep.toString().split(".")[1] || "").length;
  return Number((steps * volumeStep).toFixed(decimals));
}

function directionMatches(direction: unknown, positionType: string) {
  const normalizedDirection = String(direction ?? "").toUpperCase();
  const normalizedType = positionType.toUpperCase();
  return normalizedType.includes(normalizedDirection === "SELL" ? "SELL" : "BUY");
}

function getPriceTolerance(symbol: string) {
  const activeSymbol = symbol.toUpperCase();
  return activeSymbol.includes("XAU") || activeSymbol.includes("GOLD")
    ? 0.5
    : activeSymbol.includes("US30") || activeSymbol.includes("NAS") || activeSymbol.includes("US100") || activeSymbol.includes("DJ30")
      ? 5.0
      : 0.0005;
}

test("floorLot prevents IEEE 754 precision loss on min lot and step sizing", () => {
  assert.equal(floorLot(0.01, 0.01), 0.01);
  assert.equal(floorLot(0.010000000000000002, 0.01), 0.01);
  assert.equal(floorLot(0.05999999999999999, 0.01), 0.06);
  assert.equal(floorLot(0.1, 0.1), 0.1);
  assert.equal(floorLot(0.05, 0.1), 0.0);
});

test("directionMatches correctly checks position types", () => {
  assert.equal(directionMatches("BUY", "POSITION_TYPE_BUY"), true);
  assert.equal(directionMatches("SELL", "POSITION_TYPE_SELL"), true);
  assert.equal(directionMatches("BUY", "POSITION_TYPE_SELL"), false);
});

test("getPriceTolerance assigns symbol-specific tolerances", () => {
  assert.equal(getPriceTolerance("EURUSD"), 0.0005);
  assert.equal(getPriceTolerance("GBPUSD"), 0.0005);
  assert.equal(getPriceTolerance("XAUUSD"), 0.5);
  assert.equal(getPriceTolerance("GOLD.m"), 0.5);
  assert.equal(getPriceTolerance("US30"), 5.0);
  assert.equal(getPriceTolerance("NAS100"), 5.0);
});

test("calculateSetupScore calculates correct breakdown and actions", () => {
  const perfect = calculateSetupScore({
    htfBias: "BULLISH_DISCOUNT",
    htfConflict: false,
    liquiditySwept: true,
    poiPresent: true,
    bosMssPresent: true,
    m5Confirmed: true,
  });

  assert.equal(perfect.score, 100);
  assert.equal(perfect.action, "STRONG_BUY");
  assert.equal(perfect.direction, "BUY");
  assert.deepEqual(perfect.breakdown, {
    htfAlignment: 25,
    liquiditySweep: 25,
    poiQuality: 20,
    bosMss: 15,
    m5Confirmation: 15,
  });

  const lowScore = calculateSetupScore({
    htfBias: null,
    htfConflict: true,
    liquiditySwept: false,
    poiPresent: false,
    bosMssPresent: false,
    m5Confirmed: false,
  });

  assert.equal(lowScore.score, 10);
  assert.equal(lowScore.action, "REJECT");
  assert.equal(lowScore.direction, null);
});

test("evaluateM5Confirmation requires genuine M5 closed candles and POI touch", () => {
  const poi: Poi = {
    high: 1.0850,
    low: 1.0830,
    creationIndex: 10,
    expiryIndex: 60,
    touched: false,
    type: "OB_BULL",
    creationTime: "2025-01-01T12:00:00.000Z",
  };

  const m5CandlesNoTouch: Candle[] = [
    { time: "2025-01-01T12:05:00.000Z", open: 1.0890, high: 1.0895, low: 1.0885, close: 1.0890 },
    { time: "2025-01-01T12:10:00.000Z", open: 1.0890, high: 1.0892, low: 1.0888, close: 1.0891 },
  ];

  const evalNoTouch = evaluateM5Confirmation(m5CandlesNoTouch, "2025-01-01T12:00:00.000Z", poi);
  assert.equal(evalNoTouch.poiTouched, false);
  assert.equal(evalNoTouch.m5Confirmed, false);

  const m5CandlesTouchAndDisplace: Candle[] = [
    { time: "2025-01-01T12:05:00.000Z", open: 1.0860, high: 1.0865, low: 1.0835, close: 1.0840 }, // touches POI
    { time: "2025-01-01T12:10:00.000Z", open: 1.0840, high: 1.0880, low: 1.0838, close: 1.0878 }, // bullish displacement body
    { time: "2025-01-01T12:15:00.000Z", open: 1.0878, high: 1.0890, low: 1.0875, close: 1.0888 },
  ];

  const evalTouch = evaluateM5Confirmation(m5CandlesTouchAndDisplace, "2025-01-01T12:00:00.000Z", poi);
  assert.equal(evalTouch.poiTouched, true);
  assert.equal(evalTouch.m5Confirmed, true);
});
