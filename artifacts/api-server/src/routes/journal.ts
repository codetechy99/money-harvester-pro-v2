import { Router, type IRouter } from "express";
import {
  GetEquityHistoryQueryParams,
  GetJournalQueryParams,
} from "@workspace/api-zod";
import {
  findProfile,
  selectEquityHistory,
  selectJournal,
} from "../lib/db";
import { logger } from "../lib/logger";
import { reconcileAccountJournal } from "../lib/engine-scheduler";

const router: IRouter = Router();

function mapJournal(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    accountId: String(row.account_id ?? ""),
    symbol: String(row.symbol ?? ""),
    realSymbol: typeof row.real_symbol === "string" ? row.real_symbol : null,
    direction: String(row.direction ?? ""),
    entry: typeof row.entry === "number" ? row.entry : null,
    sl: typeof row.sl === "number" ? row.sl : null,
    tp: typeof row.tp === "number" ? row.tp : null,
    lot: typeof row.lot === "number" ? row.lot : null,
    pnl: typeof row.pnl === "number" ? row.pnl : null,
    rMultiple: typeof row.r_multiple === "number" ? row.r_multiple : null,
    status: String(row.status ?? "UNKNOWN"),
    poiType: typeof row.poi_type === "string" ? row.poi_type : null,
    bosMssTag: typeof row.bos_mss_tag === "string" ? row.bos_mss_tag : null,
    htfBias: typeof row.htf_bias === "string" ? row.htf_bias : null,
    leverage: typeof row.leverage === "number" ? row.leverage : null,
    marginUsed: typeof row.margin_used === "number" ? row.margin_used : null,
    chartSnapshotUrl:
      typeof row.chart_snapshot_url === "string"
        ? row.chart_snapshot_url
        : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

router.get("/journal", async (req, res) => {
  try {
    const { accountId } = GetJournalQueryParams.parse(req.query);
    const profile = await findProfile(accountId);
    if (typeof profile?.metaapi_account_id === "string") {
      try {
        await reconcileAccountJournal(accountId, profile.metaapi_account_id, {
          brokerName:
            typeof profile.broker_name === "string" ? profile.broker_name : undefined,
          server: typeof profile.server === "string" ? profile.server : undefined,
        });
      } catch (error) {
        logger.warn({ accountId, error }, "Journal refresh reconciliation failed");
      }
    }
    const rows = await selectJournal(accountId, 100);
    res.json(rows.map(mapJournal));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load journal",
    });
  }
});

router.get("/equity-history", async (req, res) => {
  try {
    const { accountId } = GetEquityHistoryQueryParams.parse(req.query);
    const rows = await selectEquityHistory(accountId);
    res.json(
      rows.map((row) => ({
        timestamp: String(row.timestamp ?? ""),
        balance: Number(row.balance ?? 0),
        equity: Number(row.equity ?? 0),
      })),
    );
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : "Unable to load equity history",
    });
  }
});

export default router;