import { logger } from "./logger";

type SupabaseOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  prefer?: string;
};

export function getConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Add Supabase secrets in Secrets");
  }
  return { url: url.replace(/\/$/, ""), key };
}

export async function supabaseRequest<T>(
  table: string,
  options: SupabaseOptions = {},
): Promise<T> {
  const { url, key } = getConfig();
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) query.set(name, String(value));
  }

  const response = await fetch(
    `${url}/rest/v1/${table}${query.size ? `?${query}` : ""}`,
    {
      method: options.method ?? "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: options.prefer ?? "return=representation",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );

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
    logger.warn(
      { table, status: response.status, payload },
      "Supabase request failed",
    );
    throw new Error(
      typeof payload === "object" &&
        payload !== null &&
        "message" in payload &&
        typeof payload.message === "string"
        ? payload.message
        : `Supabase request failed (${response.status})`,
    );
  }
  return payload as T;
}

export function hasSupabaseConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY,
  );
}

export async function findProfile(accountId: string) {
  const rows = await supabaseRequest<Record<string, unknown>[]>("profiles", {
    query: { select: "*", id: `eq.${accountId}`, limit: 1 },
  });
  return rows[0] ?? null;
}
