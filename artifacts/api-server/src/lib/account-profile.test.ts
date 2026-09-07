import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePropSafety,
  evaluateContestMetrics,
  getDefaultPropRules,
  getDefaultContestRules,
  type AccountProfile,
} from "./account-profile";

test("evaluatePropSafety correctly calculates buffers and detects violations / defensive posture", () => {
  const profile: AccountProfile = {
    id: "prop-acc-1",
    mode: "PROP",
    startingBalance: 100000,
    currentBalance: 98000,
    currentEquity: 97000, // $3000 loss from starting, $3000 loss from daily start
    highestEquity: 100000,
    dailyStartingEquity: 100000,
    propRules: getDefaultPropRules(100000),
  };

  const status = evaluatePropSafety(profile, 1.5);

  assert.equal(status.currentEquity, 97000);
  assert.equal(status.remainingDailyLossBuffer, 2000); // $5000 max - $3000 loss = $2000 remaining
  assert.equal(status.remainingOverallDrawdownBuffer, 7000); // $10000 max - $3000 loss = $7000 remaining
  assert.equal(status.isViolated, false);
  assert.equal(status.isDefensive, false); // 2000 / 5000 = 40% > 25%
  assert.equal(status.remainingSafeExposureLot, 3.5); // 5.0 - 1.5 = 3.5

  // Defensive condition when equity drops close to daily loss limit ($4000 loss out of $5000 limit)
  const defensiveProfile: AccountProfile = {
    ...profile,
    currentEquity: 96000, // $1000 remaining buffer (< 25% of $5000 = $1250)
  };
  const defensiveStatus = evaluatePropSafety(defensiveProfile);
  assert.equal(defensiveStatus.isDefensive, true);

  // Violate daily loss limit
  const violatedProfile: AccountProfile = {
    ...profile,
    currentEquity: 94000, // $6000 loss (> 5% max daily loss)
  };

  const violatedStatus = evaluatePropSafety(violatedProfile);
  assert.equal(violatedStatus.isViolated, true);
  assert.ok(violatedStatus.violationReason?.includes("Daily loss limit hit"));
});

test("evaluateContestMetrics calculates ROI and progress based on objective", () => {
  const profile: AccountProfile = {
    id: "contest-acc-1",
    mode: "CONTEST",
    startingBalance: 10000,
    currentBalance: 12000,
    currentEquity: 12000, // +$2000 (+20%)
    highestEquity: 12500,
    dailyStartingEquity: 11500,
    contestRules: {
      objective: "PROFIT",
      targetProfit: 4000,
    },
  };

  const trades = [
    { pnl: 1000, lot: 2.0, isWin: true },
    { pnl: 1000, lot: 2.0, isWin: true },
  ];

  const metrics = evaluateContestMetrics(profile, trades);

  assert.equal(metrics.profit, 2000);
  assert.equal(metrics.roiPercent, 20);
  assert.equal(metrics.lotsTraded, 4.0);
  assert.equal(metrics.tradeCount, 2);
  assert.equal(metrics.winRatePercent, 100);
  assert.equal(metrics.objectiveProgressPercent, 50); // $2000 / $4000 = 50%
});
