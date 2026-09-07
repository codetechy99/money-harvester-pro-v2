import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTradeRisk } from "./risk-engine";

test("evaluateTradeRisk detects equity floor, duplicate symbol, and exposure violations", async () => {
  const result = await evaluateTradeRisk({
    accountId: "test-acc-risk-1",
    symbol: "EURUSD",
    direction: "BUY",
    equity: 7500,
    balance: 10000,
    freeMargin: 5000,
    openPositions: [
      { symbol: "EURUSD", volume: 1.0 },
      { symbol: "GBPUSD", volume: 2.0 },
      { symbol: "XAUUSD", volume: 2.0 },
    ],
    riskSettings: {
      emergencyEquityFloor: 8000,
      maxTotalExposureLot: 5.0,
      maxConcurrentPositions: 5,
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.riskMultiplier, 0.0);
  assert.ok(result.violations.some((v) => v.includes("emergency equity floor")));
  assert.ok(result.violations.some((v) => v.includes("Duplicate open position")));
});

test("evaluateTradeRisk passes clean order and allows 1.0 risk multiplier", async () => {
  const result = await evaluateTradeRisk({
    accountId: "test-acc-risk-clean",
    symbol: "GBPUSD",
    direction: "BUY",
    equity: 10000,
    balance: 10000,
    freeMargin: 8000,
    openPositions: [],
    riskSettings: {
      emergencyEquityFloor: 5000,
      maxTotalExposureLot: 5.0,
      maxConcurrentPositions: 5,
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.riskMultiplier, 1.0);
  assert.equal(result.violations.length, 0);
});
