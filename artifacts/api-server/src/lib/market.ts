import { logger } from "./logger";

const NEWS_SYMBOLS: Record<string, string[]> = {
  XAUUSD: ["USD"],
  NAS100: ["USD"],
  US30: ["USD"],
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
};

export function currenciesForSymbol(symbol: string) {
  return NEWS_SYMBOLS[symbol] ?? ["USD"];
}

export async function hasHighImpactNewsWithin(
  symbol: string,
  minutes: number,
) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    logger.warn("FINNHUB_API_KEY missing; skipping news blackout filter");
    return { blocked: false, event: null, warning: "Missing FINNHUB_API_KEY" };
  }
  const now = new Date();
  const end = new Date(now.getTime() + minutes * 60_000);
  const from = now.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  try {
    const response = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${encodeURIComponent(token)}`,
    );
    if (!response.ok) {
      logger.warn({ status: response.status }, "Finnhub calendar request failed");
      return { blocked: false, event: null, warning: "News service unavailable" };
    }
    const payload = (await response.json()) as {
      economicCalendar?: Array<{
        time?: string;
        impact?: string;
        country?: string;
        event?: string;
      }>;
    };
    const currencies = currenciesForSymbol(symbol);
    const nowMs = now.getTime();
    const windowMs = minutes * 60_000;
    const event = (payload.economicCalendar ?? []).find((candidate) => {
      const timeMs = candidate.time ? new Date(candidate.time).getTime() : NaN;
      return (
        candidate.impact?.toLowerCase() === "high" &&
        currencies.includes(candidate.country ?? "") &&
        Number.isFinite(timeMs) &&
        Math.abs(timeMs - nowMs) <= windowMs
      );
    });
    return event
      ? { blocked: true, event: event.event ?? "High impact event" }
      : { blocked: false, event: null };
  } catch (error) {
    logger.warn({ error }, "Error querying Finnhub economic calendar");
    return { blocked: false, event: null, warning: "News service error" };
  }
}
