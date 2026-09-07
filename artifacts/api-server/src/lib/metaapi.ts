import { logger } from "./logger";

const PROVISIONING_API =
  "https://mt-provisioning-api-v1.agiliumtrade.ai";
const CLIENT_API = "https://mt-client-api-v1.agiliumtrade.ai";

type MetaApiAccount = {
  id?: string;
  login?: string | number;
  server?: string;
  state?: string;
  connectionStatus?: string;
  type?: string;
};

type MetaApiAccountInfo = {
  leverage?: number;
  balance?: number;
  equity?: number;
  currency?: string;
  margin?: number;
  freeMargin?: number;
  marginLevel?: number;
};

export type MetaApiPosition = Record<string, unknown> & {
  id?: string | null;
  symbol?: string | null;
  type?: string | null;
  volume?: number | null;
  openPrice?: number | null;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  profit?: number | null;
  swap?: number | null;
  time?: string | null;
};

export type MetaApiSymbolPrice = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  time: string | null;
  brokerTime: string | null;
};

export type MetaApiSymbolSpecification = {
  symbol: string;
  digits: number | null;
  tickSize: number | null;
  tickValue: number | null;
  contractSize: number | null;
  volumeMin: number | null;
  volumeMax: number | null;
  volumeStep: number | null;
  stopsLevel: number | null;
  tradeMode: string | null;
};

const haltedAccounts = new Set<string>();

export function isTradingHalted(accountId: string) {
  return haltedAccounts.has(accountId);
}

export function clearTradingHalt(accountId: string) {
  haltedAccounts.delete(accountId);
}

export function haltTrading(accountId: string) {
  haltedAccounts.add(accountId);
}

export type MetaApiHistoryDeal = {
  id: string | null;
  orderId: string | null;
  positionId: string | null;
  symbol: string | null;
  entryType: string | null;
  volume: number | null;
  price: number | null;
  profit: number | null;
  swap: number | null;
  commission: number | null;
  fee: number | null;
  time: string | null;
};

function getToken() {
  const token = process.env.METAAPI_TOKEN;
  if (!token) throw new Error("Add METAAPI_TOKEN in Secrets");
  return token;
}

async function metaapiFetch<T>(
  base: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "auth-token": getToken(),
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : `MetaApi request failed (${response.status})`;
    const error = new Error(message);
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  return payload as T;
}

async function listAccounts() {
  return metaapiFetch<MetaApiAccount[]>(
    PROVISIONING_API,
    "/users/current/accounts",
  );
}

function serverSuggestions(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const values = [
    record.suggestions,
    record.servers,
    record.serverSuggestions,
    (record.details as Record<string, unknown> | undefined)?.suggestions,
  ];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map((value) =>
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "server" in value
          ? String((value as { server: unknown }).server)
          : null,
    )
    .filter((value): value is string => Boolean(value))
    .slice(0, 10);
}

export async function getMetaApiAccount(accountId: string) {
  return metaapiFetch<MetaApiAccount>(
    PROVISIONING_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}`,
  );
}

export async function connectMetaApiAccount(input: {
  login: string;
  password: string;
  server: string;
  brokerName: string;
}) {
  if (!/^\d{3,20}$/.test(input.login.trim())) {
    throw new Error("MT5 login must contain only 3–20 digits");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._! -]{0,63}$/.test(input.server.trim())) {
    throw new Error("MT5 server name has an invalid format");
  }
  if (!input.brokerName.trim()) {
    throw new Error("Broker name is required");
  }
  let account = (await listAccounts()).find(
    (candidate) =>
      String(candidate.login) === input.login &&
      candidate.server === input.server,
  );

  if (!account?.id) {
    try {
      account = await metaapiFetch<MetaApiAccount>(
        PROVISIONING_API,
        "/users/current/accounts",
        {
          method: "POST",
          body: JSON.stringify({
            name: `MH-${input.brokerName}-${input.login}`,
            login: input.login,
            password: input.password,
            server: input.server,
            platform: "mt5",
            magic: 100001,
          }),
        },
      );
    } catch (error) {
      const typedError = error as {
        status?: number;
        payload?: unknown;
      };
      const payload =
        typedError.payload && typeof typedError.payload === "object"
          ? (typedError.payload as Record<string, unknown>)
          : {};
      if (
        payload.code === "E_SRV_NOT_FOUND" ||
        String(payload.message ?? "").includes("E_SRV_NOT_FOUND")
      ) {
        const suggestions = serverSuggestions(typedError.payload);
        throw new Error(
          `MetaApi could not find server "${input.server}".${
            suggestions.length
              ? ` Try an exact server name from MetaApi: ${suggestions.join(", ")}`
              : " Enter the exact MT5 server name and retry."
          }`,
        );
      }
      if (typedError.status !== 409) throw error;
      account = (await listAccounts()).find(
        (candidate) =>
          String(candidate.login) === input.login &&
          candidate.server === input.server,
      );
    }
  }

  if (!account?.id) {
    throw new Error("MetaApi account was not found for the supplied MT5 login and server");
  }

  await metaapiFetch(
    PROVISIONING_API,
    `/users/current/accounts/${encodeURIComponent(account.id)}/deploy`,
    { method: "POST" },
  );

  const deadline = Date.now() + 120_000;
  let status = account;
  while (Date.now() < deadline) {
    status = await getMetaApiAccount(account.id);
    if (
      status.state === "DEPLOYED" &&
      status.connectionStatus === "CONNECTED"
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  if (
    status.state !== "DEPLOYED" ||
    status.connectionStatus !== "CONNECTED"
  ) {
    throw new Error(
      "MetaApi bridge did not connect in time. Check server name: Exness-Real, Weltrade-Real, Headway-Real",
    );
  }

  return getLiveAccountSnapshot(account.id, {
    brokerName: input.brokerName,
    server: input.server,
  });
}

function mapPosition(position: Record<string, unknown>): MetaApiPosition {
  const openPrice =
    typeof position.openPrice === "number"
      ? position.openPrice
      : typeof position.price === "number"
        ? position.price
        : null;
  return {
    id: typeof position.id === "string" ? position.id : null,
    symbol: typeof position.symbol === "string" ? position.symbol : null,
    type: typeof position.type === "string" ? position.type : null,
    volume:
      typeof position.volume === "number"
        ? position.volume
        : typeof position.currentVolume === "number"
          ? position.currentVolume
          : null,
    openPrice,
    currentPrice:
      typeof position.currentPrice === "number"
        ? position.currentPrice
        : null,
    stopLoss:
      typeof position.stopLoss === "number" ? position.stopLoss : null,
    takeProfit:
      typeof position.takeProfit === "number" ? position.takeProfit : null,
    profit: typeof position.profit === "number" ? position.profit : null,
    swap: typeof position.swap === "number" ? position.swap : null,
    time: typeof position.time === "string" ? position.time : null,
  };
}

export async function getLiveAccountSnapshot(
  accountId: string,
  metadata: { brokerName?: string; server?: string } = {},
) {
  const [account, info, rawPositions] = await Promise.all([
    getMetaApiAccount(accountId),
    metaapiFetch<MetaApiAccountInfo>(
      CLIENT_API,
      `/users/current/accounts/${encodeURIComponent(accountId)}/accountInformation`,
    ),
    metaapiFetch<Array<Record<string, unknown>>>(
      CLIENT_API,
      `/users/current/accounts/${encodeURIComponent(accountId)}/positions`,
    ),
  ]);
  const leverage =
    typeof info.leverage === "number" && info.leverage > 0
      ? Math.round(info.leverage)
      : null;
  return {
    accountId,
    brokerName: metadata.brokerName ?? null,
    server: metadata.server ?? account.server ?? null,
    accountType: account.type ?? null,
    connectionState: account.connectionStatus ?? null,
    balance: typeof info.balance === "number" ? info.balance : null,
    equity: typeof info.equity === "number" ? info.equity : null,
    leverage,
    leverageDisplay: leverage ? `1:${leverage}` : null,
    currency: typeof info.currency === "string" ? info.currency : null,
    margin: typeof info.margin === "number" ? info.margin : null,
    freeMargin: typeof info.freeMargin === "number" ? info.freeMargin : null,
    marginLevel:
      typeof info.marginLevel === "number" ? info.marginLevel : null,
    connected:
      account.state === "DEPLOYED" && account.connectionStatus === "CONNECTED",
    dataSource: "MetaApi",
    positions: rawPositions.map(mapPosition),
  };
}

export async function getMetaApiSymbolInventory(accountId: string) {
  return metaapiFetch<Array<Record<string, unknown>>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/symbols`,
  );
}

export async function resolveMetaApiSymbol(
  accountId: string,
  displaySymbol: string,
  requestedSymbol?: string,
) {
  const inventory = await getMetaApiSymbolInventory(accountId);
  const symbols = inventory
    .map((item) =>
      typeof item.symbol === "string"
        ? item.symbol
        : typeof item.name === "string"
          ? item.name
          : null,
    )
    .filter((symbol): symbol is string => Boolean(symbol));
  const display = displaySymbol.toUpperCase();
  const aliases =
    display === "XAUUSD"
      ? ["XAUUSD", "GOLD"]
      : display === "NAS100"
        ? ["NAS100", "US100"]
        : display === "US30"
          ? ["US30", "DJ30"]
          : [display];
  const requested = requestedSymbol?.trim();
  const exact = requested
    ? symbols.find((symbol) => symbol.toUpperCase() === requested.toUpperCase())
    : undefined;
  if (exact) return exact;
  const candidate = symbols.find((symbol) => {
    const upper = symbol.toUpperCase();
    return aliases.some(
      (alias) =>
        upper === alias ||
        upper.startsWith(`${alias}.`) ||
        upper.startsWith(`${alias}!`),
    );
  });
  if (!candidate) {
    throw new Error(`Broker symbol not found for ${displaySymbol}`);
  }
  return candidate;
}

export async function getMetaApiSymbolPrice(accountId: string, symbol: string) {
  const raw = await metaapiFetch<Record<string, unknown>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/symbols/${encodeURIComponent(symbol)}/price`,
  );
  return {
    symbol,
    bid: typeof raw.bid === "number" ? raw.bid : null,
    ask: typeof raw.ask === "number" ? raw.ask : null,
    time:
      typeof raw.time === "string"
        ? raw.time
        : typeof raw.time === "number"
          ? new Date(raw.time).toISOString()
          : null,
    brokerTime: typeof raw.brokerTime === "string" ? raw.brokerTime : null,
  } satisfies MetaApiSymbolPrice;
}

export async function getMetaApiSymbolSpecification(
  accountId: string,
  symbol: string,
) {
  const raw = await metaapiFetch<Record<string, unknown>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/symbols/${encodeURIComponent(symbol)}/specification`,
  );
  return {
    symbol,
    digits: typeof raw.digits === "number" ? raw.digits : null,
    tickSize: typeof raw.tickSize === "number" ? raw.tickSize : null,
    tickValue: typeof raw.tickValue === "number" ? raw.tickValue : null,
    contractSize:
      typeof raw.contractSize === "number" ? raw.contractSize : null,
    volumeMin: typeof raw.minVolume === "number" ? raw.minVolume : null,
    volumeMax: typeof raw.maxVolume === "number" ? raw.maxVolume : null,
    volumeStep: typeof raw.volumeStep === "number" ? raw.volumeStep : null,
    stopsLevel: typeof raw.stopsLevel === "number" ? raw.stopsLevel : null,
    tradeMode: typeof raw.tradeMode === "string" ? raw.tradeMode : null,
  } satisfies MetaApiSymbolSpecification;
}

export async function getMetaApiHistoryDeals(
  accountId: string,
  startTime = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  endTime = new Date().toISOString(),
) {
  const raw = await metaapiFetch<
    Array<Record<string, unknown>> | { deals?: Array<Record<string, unknown>> }
  >(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/history-deals?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&limit=1000`,
  );
  const deals = Array.isArray(raw) ? raw : raw.deals ?? [];
  return deals.map((deal): MetaApiHistoryDeal => ({
    id:
      typeof deal.id === "string"
        ? deal.id
        : typeof deal.dealId === "string"
          ? deal.dealId
          : null,
    orderId: typeof deal.orderId === "string" ? deal.orderId : null,
    positionId: typeof deal.positionId === "string" ? deal.positionId : null,
    symbol: typeof deal.symbol === "string" ? deal.symbol : null,
    entryType:
      typeof deal.entryType === "string"
        ? deal.entryType
        : typeof deal.entry === "string"
          ? deal.entry
          : null,
    volume:
      typeof deal.volume === "number"
        ? deal.volume
        : typeof deal.currentVolume === "number"
          ? deal.currentVolume
          : null,
    price:
      typeof deal.price === "number"
        ? deal.price
        : typeof deal.executionPrice === "number"
          ? deal.executionPrice
          : null,
    profit:
      typeof deal.profit === "number"
        ? deal.profit
        : typeof deal.realizedProfit === "number"
          ? deal.realizedProfit
          : null,
    swap: typeof deal.swap === "number" ? deal.swap : null,
    commission: typeof deal.commission === "number" ? deal.commission : null,
    fee: typeof deal.fee === "number" ? deal.fee : null,
    time:
      typeof deal.time === "string"
        ? deal.time
        : typeof deal.executionTime === "string"
          ? deal.executionTime
          : typeof deal.time === "number"
            ? new Date(deal.time).toISOString()
            : typeof deal.executionTime === "number"
              ? new Date(deal.executionTime).toISOString()
              : null,
  }));
}

export async function modifyMetaApiPosition(input: {
  accountId: string;
  positionId: string;
  stopLoss: number | null;
  takeProfit: number | null;
}) {
  return metaapiFetch<Record<string, unknown>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(input.accountId)}/trade`,
    {
      method: "POST",
      body: JSON.stringify({
        actionType: "POSITION_MODIFY_ID",
        positionId: input.positionId,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        comment: "MH-V2 PROTECTION CORRECTION",
      }),
    },
  );
}

export async function moveMetaApiPositionStopToBreakEven(input: {
  accountId: string;
  positionId: string;
  entryPrice: number;
  takeProfit: number | null;
}) {
  return metaapiFetch<Record<string, unknown>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(input.accountId)}/trade`,
    {
      method: "POST",
      body: JSON.stringify({
        actionType: "POSITION_MODIFY_ID",
        positionId: input.positionId,
        stopLoss: input.entryPrice,
        takeProfit: input.takeProfit,
        comment: "MH-V2 BREAK-EVEN",
      }),
    },
  );
}

export async function closeAllMetaApiPositions(accountId: string, positions: Array<{ id?: string | null }>) {
  haltTrading(accountId);
  const closable = positions.filter((position): position is { id: string } => typeof position.id === "string" && Boolean(position.id));
  const outcomes = await Promise.all(
    closable.map(async (position) => {
      try {
        await metaapiFetch(
          CLIENT_API,
          `/users/current/accounts/${encodeURIComponent(accountId)}/trade`,
          {
            method: "POST",
            body: JSON.stringify({
              actionType: "POSITION_CLOSE_ID",
              positionId: position.id,
              comment: "MH-V2 EMERGENCY STOP",
            }),
          },
        );
        return { positionId: position.id, ok: true, error: null };
      } catch (error) {
        return {
          positionId: position.id,
          ok: false,
          error: error instanceof Error ? error.message : "Close failed",
        };
      }
    }),
  );
  let remaining: string[] = [];
  try {
    const verified = await getLiveAccountSnapshot(accountId);
    remaining = verified.positions
      .map((position) => position.id)
      .filter((id): id is string => typeof id === "string" && Boolean(id));
    if (!remaining.length) clearTradingHalt(accountId);
  } catch {
    // Keep the halt active when flatness cannot be verified.
  }
  return {
    requested: closable.length,
    closed: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok),
    remaining,
    halted: isTradingHalted(accountId),
  };
}

export async function disconnectMetaApiAccount(accountId: string) {
  await metaapiFetch(
    PROVISIONING_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/undeploy`,
    { method: "POST" },
  );
  const status = await getMetaApiAccount(accountId);
  clearTradingHalt(accountId);
  return {
    accountId,
    state: status.state ?? null,
    connectionStatus: status.connectionStatus ?? null,
    connected: status.state === "DEPLOYED" && status.connectionStatus === "CONNECTED",
  };
}

export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export async function getHistoricalCandles(
  accountId: string,
  symbol: string,
  timeframe = "15m",
  limit = 240,
  range: { startTime?: string; endTime?: string } = {},
) {
  const endTime = range.endTime ?? new Date().toISOString();
  const startTime =
    range.startTime ??
    new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
  const raw = await metaapiFetch<
    Array<Record<string, unknown>> | { candles?: Array<Record<string, unknown>> }
  >(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(accountId)}/historical-candles/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&limit=${limit}`,
  );
  const candles = Array.isArray(raw) ? raw : raw.candles ?? [];
  return candles
    .map((item) => ({
      time:
        typeof item.time === "string"
          ? item.time
          : new Date(Number(item.time ?? Date.now())).toISOString(),
      open: Number(item.open ?? 0),
      high: Number(item.high ?? item.open ?? 0),
      low: Number(item.low ?? item.open ?? 0),
      close: Number(item.close ?? item.open ?? 0),
      volume: typeof item.volume === "number" ? item.volume : undefined,
    }))
    .filter((candle) => candle.high > 0 && candle.low > 0);
}

export async function executeMetaApiTrade(input: {
  accountId: string;
  actionType: "ORDER_TYPE_BUY" | "ORDER_TYPE_SELL";
  symbol: string;
  volume: number;
  stopLoss: number;
  takeProfit: number;
}) {
  return metaapiFetch<Record<string, unknown>>(
    CLIENT_API,
    `/users/current/accounts/${encodeURIComponent(input.accountId)}/trade`,
    {
      method: "POST",
      body: JSON.stringify({
        actionType: input.actionType,
        symbol: input.symbol,
        volume: input.volume,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        comment: "MH-V2",
      }),
    },
  );
}
