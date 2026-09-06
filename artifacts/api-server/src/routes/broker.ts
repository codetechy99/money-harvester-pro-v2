import { Router, type IRouter } from "express";
import {
  ConnectBrokerBody,
  CloseAllPositionsBody,
  GetBrokerBalanceQueryParams,
} from "@workspace/api-zod";
import {
  closeAllMetaApiPositions,
  connectMetaApiAccount,
  disconnectMetaApiAccount,
  getLiveAccountSnapshot,
  getHistoricalCandles,
  getMetaApiSymbolPrice,
  getMetaApiSymbolSpecification,
  resolveMetaApiSymbol,
} from "../lib/metaapi";
import { findProfile, resolveMetaApiAccountId, supabaseRequest } from "../lib/supabase";
import { requireAuth, requireAccountOwnership } from "../middlewares/auth";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected broker error";
}

function errorStatus(error: unknown, message: string) {
  if (Array.isArray((error as { issues?: unknown })?.issues)) return 400;
  return message.startsWith("Add ") ? 400 : 502;
}

router.post("/broker/connect", requireAuth, async (req, res) => {
  try {
    const input = ConnectBrokerBody.parse(req.body);
    const snapshot = await connectMetaApiAccount(input);
    const profileId = input.login;
    await supabaseRequest("profiles", {
      method: "POST",
      query: { on_conflict: "id" },
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        id: profileId,
        metaapi_account_id: snapshot.accountId,
        broker_name: input.brokerName,
        server: input.server,
        login: input.login,
        leverage: snapshot.leverage,
        balance: snapshot.balance,
        equity: snapshot.equity,
        account_type: snapshot.accountType,
        connection_state: snapshot.connectionState ?? "CONNECTED",
      },
    });
    res.json(snapshot);
  } catch (error) {
    const message = errorMessage(error);
    const status = errorStatus(error, message);
    res.status(status).json({ error: message });
  }
});

router.get("/broker/balance", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    if (typeof req.query.accountId !== "string" || !req.query.accountId.trim()) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const { accountId: profileId } = GetBrokerBalanceQueryParams.parse(req.query);
    const profile = await findProfile(profileId);
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const live = await getLiveAccountSnapshot(metaApiAccountId, {
      brokerName:
        typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });
    await supabaseRequest("profiles", {
      method: "PATCH",
      query: { id: `eq.${profileId}` },
      body: {
        balance: live.balance,
        equity: live.equity,
        leverage: live.leverage,
      },
    });
    if (live.balance !== null && live.equity !== null) {
      await supabaseRequest("equity_history", {
        method: "POST",
        body: {
          account_id: profileId,
          balance: live.balance,
          equity: live.equity,
        },
      });
    }
    res.json(live);
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.get("/broker/positions", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    if (typeof req.query.accountId !== "string" || !req.query.accountId.trim()) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const { accountId: profileId } = GetBrokerBalanceQueryParams.parse(req.query);
    const profile = await findProfile(profileId);
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const live = await getLiveAccountSnapshot(metaApiAccountId, {
      brokerName:
        typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });
    res.json(live.positions);
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.get("/broker/market-data", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const profileId = String(req.query.accountId ?? "").trim();
    const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
    const requestedRealSymbol = String(req.query.realSymbol ?? "").trim() || undefined;
    if (!profileId || !symbol) {
      res.status(400).json({ error: "accountId and symbol are required" });
      return;
    }
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const realSymbol = await resolveMetaApiSymbol(
      metaApiAccountId,
      symbol,
      requestedRealSymbol,
    );
    const [price, specification, candles] = await Promise.all([
      getMetaApiSymbolPrice(metaApiAccountId, realSymbol),
      getMetaApiSymbolSpecification(metaApiAccountId, realSymbol),
      getHistoricalCandles(metaApiAccountId, realSymbol, "5m", 2),
    ]);
    const lastTickMs = price.time ? new Date(price.time).getTime() : NaN;
    const dataAgeSeconds = Number.isFinite(lastTickMs)
      ? Math.max(0, (Date.now() - lastTickMs) / 1000)
      : null;
    const spread =
      price.bid !== null && price.ask !== null ? price.ask - price.bid : null;
    const spreadPoints =
      spread !== null && specification.tickSize
        ? spread / specification.tickSize
        : null;
    const status =
      price.bid !== null &&
      price.ask !== null &&
      candles.length > 0 &&
      dataAgeSeconds !== null &&
      dataAgeSeconds <= 30
        ? "LIVE"
        : price.bid !== null && price.ask !== null
          ? "STALE"
          : "ERROR";
    res.json({
      symbol,
      realSymbol,
      bid: price.bid,
      ask: price.ask,
      spread,
      spreadPoints,
      lastTick: price.time,
      lastCandle: candles.at(-1)?.time ?? null,
      dataSource: "MetaApi",
      dataAgeSeconds,
      status,
      marketStatus: specification.tradeMode,
      specification,
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.post("/broker/disconnect", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const { accountId: profileId } = CloseAllPositionsBody.parse(req.body);
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const result = await disconnectMetaApiAccount(metaApiAccountId);
    await supabaseRequest("profiles", {
      method: "PATCH",
      query: { id: `eq.${profileId}` },
      body: { connection_state: "DISCONNECTED" },
    });
    res.json({ ok: true, message: "MetaApi account undeployed", count: 0, ...result });
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.post("/broker/close-all", requireAuth, requireAccountOwnership, async (req, res) => {
  try {
    const { accountId: profileId } = CloseAllPositionsBody.parse(req.body);
    const metaApiAccountId = await resolveMetaApiAccountId(profileId);
    const live = await getLiveAccountSnapshot(metaApiAccountId);
    const result = await closeAllMetaApiPositions(metaApiAccountId, live.positions, profileId);
    res.json({
      ok: result.failed.length === 0 && result.remaining.length === 0,
      message: result.remaining.length
        ? `Emergency stop incomplete: ${result.remaining.length} position(s) remain open`
        : result.closed
          ? `Emergency stop verified for ${result.closed} live position${result.closed === 1 ? "" : "s"}`
          : "No live positions to close",
      count: result.closed,
      failed: result.failed,
      remaining: result.remaining,
      halted: result.halted,
    });
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

export default router;
