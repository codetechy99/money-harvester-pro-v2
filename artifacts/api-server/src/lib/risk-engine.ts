import { logger } from "./logger";
import { hasHighImpactNewsWithin } from "./market";
import { supabaseRequest } from "./supabase";

export type RiskCheckInput = {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  equity: number;
  balance: number;
  freeMargin: number | null;
  openPositions: Array<{
    id?: string;
    symbol: string;
    volume?: number | null;
    openPrice?: number | null;
  }>;
  riskSettings?: {
    riskPerTrade?: number; // e.g. 1 (%)
    dailyLoss?: number; // e.g. 3 (%)
    weeklyLoss?: number; // e.g. 6 (%)
    maxTotalExposureLot?: number; // e.g. 5.0
    maxSymbolExposureLot?: number; // e.g. 2.0
    maxConcurrentPositions?: number; // e.g. 5
    consecutiveLossLimit?: number; // e.g. 3
    symbolCooldownMinutes?: number; // e.g. 15
    newsMinutes?: number; // e.g. 30
    spreadMultiplier?: number; // e.g. 2.5
    emergencyEquityFloor?: number; // e.g. 8000
  };
};

export type RiskCheckResult = {
  passed: boolean;
  violations: string[];
  warnings: string[];
  riskMultiplier: number; // 1.0 = normal, 0.5 = reduced, 0.0 = blocked
};

export async function evaluateTradeRisk(input: RiskCheckInput): Promise<RiskCheckResult> {
  const violations: string[] = [];
  const warnings: string[] = [];
  let riskMultiplier = 1.0;

  const {
    accountId,
    symbol,
    equity,
    balance,
    openPositions,
    riskSettings = {},
  } = input;

  const dailyLossLimitPct = riskSettings.dailyLoss ?? 3;
  const weeklyLossLimitPct = riskSettings.weeklyLoss ?? 6;
  const maxTotalExposure = riskSettings.maxTotalExposureLot ?? 5.0;
  const maxSymbolExposure = riskSettings.maxSymbolExposureLot ?? 2.0;
  const maxConcurrentPositions = riskSettings.maxConcurrentPositions ?? 5;
  const consecutiveLossLimit = riskSettings.consecutiveLossLimit ?? 3;
  const symbolCooldownMinutes = riskSettings.symbolCooldownMinutes ?? 15;
  const newsMinutes = riskSettings.newsMinutes ?? 30;
  const emergencyEquityFloor = riskSettings.emergencyEquityFloor ?? 0;

  // 1. Emergency Equity Floor
  if (emergencyEquityFloor > 0 && equity <= emergencyEquityFloor) {
    violations.push(`Account equity ($${equity.toFixed(2)}) is at or below emergency equity floor ($${emergencyEquityFloor.toFixed(2)})`);
  }

  // 2. Duplicate Symbol & Duplicate Order Check
  const symbolOpenPositions = openPositions.filter((p) => p.symbol === symbol);
  if (symbolOpenPositions.length > 0) {
    violations.push(`Duplicate open position on symbol ${symbol} already exists`);
  }

  // 3. Max Concurrent Positions
  if (openPositions.length >= maxConcurrentPositions) {
    violations.push(`Maximum concurrent positions limit (${maxConcurrentPositions}) reached`);
  }

  // 4. Max Total Exposure & Max Symbol Exposure
  const totalOpenLot = openPositions.reduce((sum, p) => sum + (p.volume ?? 0), 0);
  if (totalOpenLot >= maxTotalExposure) {
    violations.push(`Maximum total exposure lot limit (${maxTotalExposure} lots) reached (current: ${totalOpenLot.toFixed(2)})`);
  }

  const symbolOpenLot = symbolOpenPositions.reduce((sum, p) => sum + (p.volume ?? 0), 0);
  if (symbolOpenLot >= maxSymbolExposure) {
    violations.push(`Maximum symbol exposure lot limit (${maxSymbolExposure} lots) reached on ${symbol}`);
  }

  // 5. Friday Market Close Session Filter
  const day = new Date();
  if (day.getUTCDay() === 5 && (day.getUTCHours() > 21 || (day.getUTCHours() === 21 && day.getUTCMinutes() >= 45))) {
    violations.push("Friday 21:45 GMT session cutoff — no new positions allowed before weekend");
  }

  // 6. Journal History Checks (Daily/Weekly Loss, Consecutive Losses, Symbol Cooldown)
  try {
    const journalRows = await supabaseRequest<Record<string, unknown>[]>("journal", {
      query: {
        select: "symbol,pnl,status,created_at,closed_at",
        account_id: `eq.${accountId}`,
        status: "eq.CLOSED",
        order: "closed_at.desc",
        limit: 100,
      },
    });

    const now = Date.now();

    // Daily & Weekly PnL
    const dayPnl = journalRows
      .filter((row) => now - new Date(String(row.closed_at ?? row.created_at ?? 0)).getTime() <= 86_400_000)
      .reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);

    const weekPnl = journalRows
      .filter((row) => now - new Date(String(row.closed_at ?? row.created_at ?? 0)).getTime() <= 7 * 86_400_000)
      .reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);

    const maxDailyLossAmount = (equity * dailyLossLimitPct) / 100;
    if (dayPnl <= -maxDailyLossAmount) {
      violations.push(`Daily loss limit reached ($${Math.abs(dayPnl).toFixed(2)} >= $${maxDailyLossAmount.toFixed(2)} max)`);
    }

    const maxWeeklyLossAmount = (equity * weeklyLossLimitPct) / 100;
    if (weekPnl <= -maxWeeklyLossAmount) {
      violations.push(`Weekly loss limit reached ($${Math.abs(weekPnl).toFixed(2)} >= $${maxWeeklyLossAmount.toFixed(2)} max)`);
    }

    // Symbol Cooldown
    const lastSymbolTrade = journalRows.find((row) => row.symbol === symbol);
    if (lastSymbolTrade?.closed_at) {
      const closedAtMs = new Date(String(lastSymbolTrade.closed_at)).getTime();
      const elapsedMinutes = (now - closedAtMs) / (1000 * 60);
      if (elapsedMinutes < symbolCooldownMinutes) {
        violations.push(`Symbol ${symbol} re-entry cooldown active (closed ${elapsedMinutes.toFixed(1)} mins ago, required: ${symbolCooldownMinutes} mins)`);
      }
    }

    // Consecutive Loss Protection (Anti-Martingale)
    let consecutiveLosses = 0;
    for (const row of journalRows) {
      const pnl = Number(row.pnl ?? 0);
      if (pnl < 0) {
        consecutiveLosses += 1;
      } else if (pnl > 0) {
        break;
      }
    }

    if (consecutiveLosses >= consecutiveLossLimit) {
      warnings.push(`${consecutiveLosses} consecutive losses detected; reducing trade risk by 50%`);
      riskMultiplier *= 0.5;
    }
  } catch (error) {
    logger.warn({ accountId, error }, "Risk engine journal history check skipped due to query error");
  }

  // 7. High-Impact News Filter
  try {
    const news = await hasHighImpactNewsWithin(symbol, newsMinutes);
    if (news.blocked) {
      violations.push(`High-impact news event active: ${news.event}`);
    }
  } catch (error) {
    logger.warn({ symbol, error }, "News filter check error in risk engine");
  }

  const passed = violations.length === 0;
  if (!passed) {
    riskMultiplier = 0.0;
  }

  return {
    passed,
    violations,
    warnings,
    riskMultiplier,
  };
}
