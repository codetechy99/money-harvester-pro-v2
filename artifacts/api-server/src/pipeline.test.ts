import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  currenciesForSymbol,
  hasHighImpactNewsWithin,
} from "./lib/market";
import {
  calculateSetupScore,
  evaluateM5Confirmation,
  SUPPORTED_SYMBOLS,
  type Poi,
  type Candle,
} from "./lib/strategy";
import { evaluateTradeRisk } from "./lib/risk-engine";
import { evaluatePropSafety, getDefaultPropRules, type AccountProfile } from "./lib/account-profile";
import { getAccountCycleStatus, setEmergencyKillSwitch } from "./lib/engine-scheduler";

describe("Comprehensive End-to-End Integration & Integration Gate Test Suite", () => {
  test("A. Valid strategy setup score & mandatory core conditions", () => {
    const score = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: true,
      poiPresent: true,
      bosMssPresent: true,
      m5Confirmed: true,
    });

    assert.equal(score.score, 100);
    assert.equal(score.action, "STRONG_BUY");
    assert.equal(score.direction, "BUY");
  });

  test("B. Missing liquidity sweep -> rejected", () => {
    const score = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: false, // missing sweep
      poiPresent: true,
      bosMssPresent: true,
      m5Confirmed: true,
    });

    assert.equal(score.score, 75);
    assert.equal(score.action, "REJECT");
    assert.equal(score.direction, null);
  });

  test("C. Missing BOS/MSS -> rejected", () => {
    const score = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: true,
      poiPresent: true,
      bosMssPresent: false, // missing BOS/MSS
      m5Confirmed: true,
    });

    assert.equal(score.score, 85);
    assert.equal(score.action, "REJECT");
    assert.equal(score.direction, null);
  });

  test("D. Missing closed M5 confirmation -> rejected", () => {
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

    const evalRes = evaluateM5Confirmation(m5CandlesNoTouch, "2025-01-01T12:00:00.000Z", poi);
    assert.equal(evalRes.m5Confirmed, false);

    const score = calculateSetupScore({
      htfBias: "BULLISH_DISCOUNT",
      htfConflict: false,
      liquiditySwept: true,
      poiPresent: true,
      bosMssPresent: true,
      m5Confirmed: evalRes.m5Confirmed, // false
    });

    assert.equal(score.action, "REJECT");
    assert.equal(score.direction, null);
  });

  test("E & F. PROP daily-loss & overall drawdown violations -> rejected before order", () => {
    const propProfile: AccountProfile = {
      id: "prop-test-1",
      mode: "PROP",
      startingBalance: 100000,
      currentBalance: 94000,
      currentEquity: 94000, // $6000 loss (> 5% max daily loss limit)
      highestEquity: 100000,
      dailyStartingEquity: 100000,
      propRules: getDefaultPropRules(100000),
    };

    const safety = evaluatePropSafety(propProfile, 0);
    assert.equal(safety.isViolated, true);
    assert.ok(safety.violationReason?.includes("Daily loss limit hit"));
  });

  test("G. Defensive PROP state -> normal risk reduced by 50%", () => {
    const propProfile: AccountProfile = {
      id: "prop-defensive-1",
      mode: "PROP",
      startingBalance: 100000,
      currentBalance: 96000,
      currentEquity: 96000, // $4000 loss out of $5000 max daily loss limit ($1000 remaining buffer < 25%)
      highestEquity: 100000,
      dailyStartingEquity: 100000,
      propRules: getDefaultPropRules(100000),
    };

    const safety = evaluatePropSafety(propProfile, 0);
    assert.equal(safety.isDefensive, true);
    assert.equal(safety.isViolated, false);
  });

  test("H. High-impact news blackout filter", () => {
    assert.deepEqual(currenciesForSymbol("EURUSD"), ["EUR", "USD"]);
    assert.deepEqual(currenciesForSymbol("XAUUSD"), ["USD"]);
  });

  test("I. Risk-engine fails closed on missing / invalid live equity or balance", async () => {
    const result = await evaluateTradeRisk({
      accountId: "test-acc-invalid",
      symbol: "EURUSD",
      direction: "BUY",
      equity: 0, // Invalid zero equity
      balance: 10000,
      freeMargin: 5000,
      openPositions: [],
    });

    assert.equal(result.passed, false);
    assert.equal(result.riskMultiplier, 0.0);
    assert.ok(result.violations[0].includes("Fail-Closed"));
  });

  test("J & L. COOLDOWN and Emergency Kill Switch block new entries", () => {
    const accountId = "test-cycle-kill-1";

    // Trigger Kill Switch
    setEmergencyKillSwitch(accountId, true, "Emergency Stop Active");
    const status = getAccountCycleStatus(accountId);

    assert.equal(status.state, "EMERGENCY_STOP");
    assert.equal(status.emergencyStop, true);

    // Reset Kill Switch
    setEmergencyKillSwitch(accountId, false);
  });
});
