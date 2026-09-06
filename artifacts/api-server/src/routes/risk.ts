import { Router, type IRouter } from "express";
import {
  GetRiskSettingsParams,
  UpdateRiskSettingsBody,
  UpdateRiskSettingsParams,
} from "@workspace/api-zod";
import { supabaseRequest } from "../lib/supabase";
import { requireAuth, requireAccountOwnership } from "../middlewares/auth";

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

router.get("/risk-settings/:accountId", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const { accountId: profileId } = GetRiskSettingsParams.parse(req.params);
    const rows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
      query: { select: "*", account_id: `eq.${profileId}`, limit: 1 },
    });
    res.json(mapRisk(rows[0] ?? {}, profileId));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load risk settings",
    });
  }
});

router.patch("/risk-settings/:accountId", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const { accountId: profileId } = UpdateRiskSettingsParams.parse(req.params);
    const input = UpdateRiskSettingsBody.parse(req.body);
    const rows = await supabaseRequest<Record<string, unknown>[]>("risk_settings", {
      method: "POST",
      query: { on_conflict: "account_id" },
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        account_id: profileId,
        risk_per_trade: input.riskPerTrade,
        daily_loss: input.dailyLoss,
        weekly_loss: input.weeklyLoss,
        spread_multiplier: input.spreadMultiplier,
        news_minutes: input.newsMinutes,
      },
    });
    res.json(mapRisk(rows[0] ?? {}, profileId));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to save risk settings",
    });
  }
});

export default router;
