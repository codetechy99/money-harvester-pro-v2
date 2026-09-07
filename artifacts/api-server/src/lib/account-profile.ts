export type AccountProfileMode = "DEMO" | "STANDARD" | "PROP" | "CONTEST";

export type PropRules = {
  startingBalance: number;
  profitTargetPercent: number; // e.g. 10 for 10%
  maxDailyLossPercent: number; // e.g. 5 for 5%
  maxOverallDrawdownPercent: number; // e.g. 10 for 10%
  trailingDrawdown: boolean;
  maxPositions: number;
  maxTotalExposureLot: number;
  maxSymbolExposureLot: number;
  minTradingDays: number;
  maxLotSize: number;
  allowedSymbols: string[];
  newsRestrictions: boolean;
  weekendRestrictions: boolean;
};

export type ContestObjective =
  | "PROFIT"
  | "ROI"
  | "VOLUME"
  | "LOTS_TRADED"
  | "RANKING"
  | "RISK_ADJUSTED_RETURN"
  | "CUSTOM";

export type ContestRules = {
  objective: ContestObjective;
  targetLots?: number;
  targetProfit?: number;
  minWinRatePercent?: number;
  maxDrawdownPercent: number;
  rankingMetric?: string;
};

export type AccountProfile = {
  id: string;
  mode: AccountProfileMode;
  startingBalance: number;
  currentBalance: number;
  currentEquity: number;
  highestEquity: number;
  dailyStartingEquity: number;
  propRules?: Partial<PropRules>;
  contestRules?: Partial<ContestRules>;
};

export type PropSafetyStatus = {
  currentEquity: number;
  currentDrawdownPercent: number;
  remainingDailyLossBuffer: number;
  remainingDailyLossPercent: number;
  remainingOverallDrawdownBuffer: number;
  remainingOverallDrawdownPercent: number;
  distanceToProfitTarget: number;
  distanceToProfitTargetPercent: number;
  currentExposureLot: number;
  remainingSafeExposureLot: number;
  isDefensive: boolean; // True when within 25% of any limit
  isViolated: boolean;
  violationReason: string | null;
};

export type ContestMetrics = {
  objective: ContestObjective;
  profit: number;
  roiPercent: number;
  lotsTraded: number;
  tradeCount: number;
  maxDrawdownPercent: number;
  winRatePercent: number;
  objectiveProgressPercent: number;
};

export function getDefaultPropRules(startingBalance = 100000): PropRules {
  return {
    startingBalance,
    profitTargetPercent: 10,
    maxDailyLossPercent: 5,
    maxOverallDrawdownPercent: 10,
    trailingDrawdown: false,
    maxPositions: 5,
    maxTotalExposureLot: 5.0,
    maxSymbolExposureLot: 2.0,
    minTradingDays: 5,
    maxLotSize: 2.0,
    allowedSymbols: ["EURUSD", "GBPUSD", "XAUUSD", "NAS100", "US30"],
    newsRestrictions: true,
    weekendRestrictions: true,
  };
}

export function getDefaultContestRules(): ContestRules {
  return {
    objective: "ROI",
    targetProfit: 2000,
    targetLots: 50,
    minWinRatePercent: 55,
    maxDrawdownPercent: 15,
  };
}

export function evaluatePropSafety(
  profile: AccountProfile,
  openPositionsLot = 0,
): PropSafetyStatus {
  const rules = { ...getDefaultPropRules(profile.startingBalance), ...profile.propRules };
  const starting = rules.startingBalance > 0 ? rules.startingBalance : profile.startingBalance || 100000;
  const equity = profile.currentEquity;
  const dailyStart = profile.dailyStartingEquity > 0 ? profile.dailyStartingEquity : starting;
  const highestEq = Math.max(profile.highestEquity, equity, starting);

  // 1. Daily Loss Buffer
  const maxDailyLossAmount = dailyStart * (rules.maxDailyLossPercent / 100);
  const currentDailyLoss = Math.max(0, dailyStart - equity);
  const remainingDailyLossBuffer = Math.max(0, maxDailyLossAmount - currentDailyLoss);
  const remainingDailyLossPercent = (remainingDailyLossBuffer / dailyStart) * 100;

  // 2. Overall Drawdown Buffer
  const baseForOverall = rules.trailingDrawdown ? highestEq : starting;
  const maxOverallDrawdownAmount = baseForOverall * (rules.maxOverallDrawdownPercent / 100);
  const currentOverallDrawdown = Math.max(0, baseForOverall - equity);
  const remainingOverallDrawdownBuffer = Math.max(0, maxOverallDrawdownAmount - currentOverallDrawdown);
  const remainingOverallDrawdownPercent = (remainingOverallDrawdownBuffer / baseForOverall) * 100;

  // 3. Profit Target
  const targetEquity = starting * (1 + rules.profitTargetPercent / 100);
  const distanceToProfitTarget = Math.max(0, targetEquity - equity);
  const distanceToProfitTargetPercent = (distanceToProfitTarget / starting) * 100;

  // 4. Current Drawdown %
  const currentDrawdownPercent = ((highestEq - equity) / highestEq) * 100;

  // 5. Exposure
  const remainingSafeExposureLot = Math.max(0, rules.maxTotalExposureLot - openPositionsLot);

  // Defensive condition: remaining buffer is less than 25% of allowed limit
  const isDefensive =
    remainingDailyLossBuffer < maxDailyLossAmount * 0.25 ||
    remainingOverallDrawdownBuffer < maxOverallDrawdownAmount * 0.25;

  let isViolated = false;
  let violationReason: string | null = null;

  if (currentDailyLoss >= maxDailyLossAmount) {
    isViolated = true;
    violationReason = `Prop rule violation: Daily loss limit hit ($${currentDailyLoss.toFixed(2)} >= $${maxDailyLossAmount.toFixed(2)})`;
  } else if (currentOverallDrawdown >= maxOverallDrawdownAmount) {
    isViolated = true;
    violationReason = `Prop rule violation: Overall drawdown limit hit ($${currentOverallDrawdown.toFixed(2)} >= $${maxOverallDrawdownAmount.toFixed(2)})`;
  }

  return {
    currentEquity: equity,
    currentDrawdownPercent,
    remainingDailyLossBuffer,
    remainingDailyLossPercent,
    remainingOverallDrawdownBuffer,
    remainingOverallDrawdownPercent,
    distanceToProfitTarget,
    distanceToProfitTargetPercent,
    currentExposureLot: openPositionsLot,
    remainingSafeExposureLot,
    isDefensive,
    isViolated,
    violationReason,
  };
}

export function evaluateContestMetrics(
  profile: AccountProfile,
  closedTrades: Array<{ pnl: number; lot: number; isWin: boolean }> = [],
): ContestMetrics {
  const rules = { ...getDefaultContestRules(), ...profile.contestRules };
  const starting = profile.startingBalance || 10000;
  const profit = profile.currentEquity - starting;
  const roiPercent = (profit / starting) * 100;

  const totalLots = closedTrades.reduce((sum, t) => sum + (t.lot || 0), 0);
  const tradeCount = closedTrades.length;
  const winCount = closedTrades.filter((t) => t.isWin).length;
  const winRatePercent = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;

  const highestEq = Math.max(profile.highestEquity, profile.currentEquity, starting);
  const maxDrawdownPercent = ((highestEq - profile.currentEquity) / highestEq) * 100;

  let objectiveProgressPercent = 0;
  switch (rules.objective) {
    case "PROFIT":
      objectiveProgressPercent = rules.targetProfit && rules.targetProfit > 0
        ? Math.min(100, Math.max(0, (profit / rules.targetProfit) * 100))
        : Math.max(0, roiPercent);
      break;
    case "ROI":
      objectiveProgressPercent = Math.min(100, Math.max(0, roiPercent));
      break;
    case "VOLUME":
    case "LOTS_TRADED":
      objectiveProgressPercent = rules.targetLots && rules.targetLots > 0
        ? Math.min(100, (totalLots / rules.targetLots) * 100)
        : 100;
      break;
    case "RISK_ADJUSTED_RETURN":
      const riskAdj = maxDrawdownPercent > 0 ? roiPercent / maxDrawdownPercent : roiPercent;
      objectiveProgressPercent = Math.min(100, Math.max(0, riskAdj * 10));
      break;
    default:
      objectiveProgressPercent = Math.min(100, Math.max(0, roiPercent));
  }

  return {
    objective: rules.objective,
    profit,
    roiPercent,
    lotsTraded: totalLots,
    tradeCount,
    maxDrawdownPercent,
    winRatePercent,
    objectiveProgressPercent,
  };
}
