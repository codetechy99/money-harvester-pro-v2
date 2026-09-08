import { Router, type IRouter } from "express";
import {
  GetRiskSettingsParams,
  UpdateRiskSettingsBody,
  UpdateRiskSettingsParams,
} from "@workspace/api-zod";
import { saveRiskSettings, selectRiskSettings } from "../lib/db";

const router: IRouter = Router();

function mapRisk(row: Record<string, unknown>, accountId: string) {
  return {
    accountId,
    riskPerTrade: Number(row.risk_per_trade ?? 1),
    dailyLoss: Number(row.daily_loss ?? 3),
    weeklyLoss: Number(row.weekly_loss ?? 6),
    spreadMultiplier: Number(row.spread_multiplier ?? 2.5),
    newsMinutes: Number(row.news_minutes ?? 30),
  };
}

router.get("/risk-settings/:accountId", async (req, res) => {
  try {
    const { accountId } = GetRiskSettingsParams.parse(req.params);
    const row = await selectRiskSettings(accountId);
    res.json(mapRisk(row ?? {}, accountId));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load risk settings",
    });
  }
});

router.patch("/risk-settings/:accountId", async (req, res) => {
  try {
    const { accountId } = UpdateRiskSettingsParams.parse(req.params);
    const input = UpdateRiskSettingsBody.parse(req.body);
    const row = await saveRiskSettings({
      account_id: accountId,
      risk_per_trade: input.riskPerTrade,
      daily_loss: input.dailyLoss,
      weekly_loss: input.weeklyLoss,
      spread_multiplier: input.spreadMultiplier,
      news_minutes: input.newsMinutes,
    });
    res.json(mapRisk(row ?? {}, accountId));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to save risk settings",
    });
  }
});

export default router;