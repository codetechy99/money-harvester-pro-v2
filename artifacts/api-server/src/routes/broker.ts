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
import { findProfile, insertEquityPoint, saveProfile, updateProfile } from "../lib/db";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected broker error";
}

function errorStatus(error: unknown, message: string) {
  if (Array.isArray((error as { issues?: unknown })?.issues)) return 400;
  return message.startsWith("Add ") ? 400 : 502;
}

router.post("/broker/connect", async (req, res) => {
  try {
    const input = ConnectBrokerBody.parse(req.body);
    const account = await connectMetaApiAccount(input);
    await saveProfile({
      id: account.accountId,
      metaapi_account_id: account.accountId,
      broker_name: input.brokerName,
      server: input.server,
      login: input.login,
      leverage: account.leverage,
      balance: account.balance,
      equity: account.equity,
      account_type: account.accountType,
      connection_state: account.connectionState ?? "CONNECTED",
    });
    res.json(account);
  } catch (error) {
    const message = errorMessage(error);
    const status = errorStatus(error, message);
    res.status(status).json({ error: message });
  }
});

router.get("/broker/balance", async (req, res) => {
  try {
    if (typeof req.query.accountId !== "string" || !req.query.accountId.trim()) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const { accountId } = GetBrokerBalanceQueryParams.parse(req.query);
    const profile = await findProfile(accountId);
    const live = await getLiveAccountSnapshot(accountId, {
      brokerName:
        typeof profile?.broker_name === "string" ? profile.broker_name : undefined,
      server: typeof profile?.server === "string" ? profile.server : undefined,
    });
    await updateProfile(accountId, {
      balance: live.balance,
      equity: live.equity,
      leverage: live.leverage,
    });
    if (live.balance !== null && live.equity !== null) {
      await insertEquityPoint(accountId, live.balance, live.equity);
    }
    res.json(live);
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.get("/broker/positions", async (req, res) => {
  try {
    if (typeof req.query.accountId !== "string" || !req.query.accountId.trim()) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const { accountId } = GetBrokerBalanceQueryParams.parse(req.query);
    const profile = await findProfile(accountId);
    const live = await getLiveAccountSnapshot(accountId, {
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

router.get("/broker/market-data", async (req, res) => {
  try {
    const accountId = String(req.query.accountId ?? "").trim();
    const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
    const requestedRealSymbol = String(req.query.realSymbol ?? "").trim() || undefined;
    if (!accountId || !symbol) {
      res.status(400).json({ error: "accountId and symbol are required" });
      return;
    }
    const realSymbol = await resolveMetaApiSymbol(
      accountId,
      symbol,
      requestedRealSymbol,
    );
    const [price, specification, candles] = await Promise.all([
      getMetaApiSymbolPrice(accountId, realSymbol),
      getMetaApiSymbolSpecification(accountId, realSymbol),
      getHistoricalCandles(accountId, realSymbol, "5m", 2),
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

router.post("/broker/disconnect", async (req, res) => {
  try {
    const { accountId } = CloseAllPositionsBody.parse(req.body);
    const result = await disconnectMetaApiAccount(accountId);
    await updateProfile(accountId, { connection_state: "DISCONNECTED" });
    res.json({ ok: true, message: "MetaApi account undeployed", count: 0, ...result });
  } catch (error) {
    const message = errorMessage(error);
    res.status(errorStatus(error, message)).json({ error: message });
  }
});

router.post("/broker/close-all", async (req, res) => {
  try {
    const { accountId } = CloseAllPositionsBody.parse(req.body);
    const live = await getLiveAccountSnapshot(accountId);
    const result = await closeAllMetaApiPositions(accountId, live.positions);
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