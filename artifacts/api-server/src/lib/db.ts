import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  equityHistory,
  journal,
  profiles,
  riskSettings,
  states,
} from "@workspace/db/schema";

export type Row = Record<string, unknown>;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export async function listProfileRefs() {
  const rows = await db
    .select({ id: profiles.id, metaapi_account_id: profiles.metaapi_account_id })
    .from(profiles)
    .limit(100);
  return rows.map((row) => ({ ...row }));
}

export async function findProfile(accountId: string) {
  const rows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.id, accountId))
    .limit(1);
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function saveProfile(values: typeof profiles.$inferInsert) {
  const { id: _exclude, ...avatar } = values;
  const rows = await db
    .insert(profiles)
    .values(values)
    .onConflictDoUpdate({
      target: profiles.id,
      set: { ...avatar, updated_at: new Date().toISOString() },
    })
    .returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function updateProfile(
  accountId: string,
  patch: Partial<typeof profiles.$inferInsert>,
) {
  const rows = await db
    .update(profiles)
    .set({ ...patch, updated_at: new Date().toISOString() })
    .where(eq(profiles.id, accountId))
    .returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function saveState(values: typeof states.$inferInsert) {
  const { account_id: _exclude1, symbol: _exclude2, ...avatar } = values;
  const rows = await db
    .insert(states)
    .values(values)
    .onConflictDoUpdate({
      target: [states.account_id, states.symbol],
      set: { ...avatar, updated_at: new Date().toISOString() },
    })
    .returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function selectStates(accountId: string) {
  const rows = await db
    .select()
    .from(states)
    .where(eq(states.account_id, accountId))
    .orderBy(asc(states.symbol));
  return rows.map((row) => ({ ...row }));
}

export async function insertJournal(values: typeof journal.$inferInsert) {
  const rows = await db.insert(journal).values(values).returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function selectJournal(accountId: string, limit = 100) {
  const rows = await db
    .select()
    .from(journal)
    .where(eq(journal.account_id, accountId))
    .orderBy(desc(journal.created_at))
    .limit(limit);
  return rows.map((row) => ({ ...row }));
}

export async function selectOpenJournalRows(accountId: string) {
  const rows = await db
    .select()
    .from(journal)
    .where(and(eq(journal.account_id, accountId), eq(journal.status, "OPEN")))
    .orderBy(asc(journal.created_at))
    .limit(500);
  return rows.map((row) => ({ ...row }));
}

export async function updateJournal(id: string, patch: Partial<typeof journal.$inferInsert>) {
  const rows = await db
    .update(journal)
    .set({ ...patch, broker_updated_at: new Date().toISOString() })
    .where(eq(journal.id, id))
    .returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function selectRiskSettings(accountId: string) {
  const rows = await db
    .select()
    .from(riskSettings)
    .where(eq(riskSettings.account_id, accountId))
    .limit(1);
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function saveRiskSettings(values: typeof riskSettings.$inferInsert) {
  const { account_id: _exclude, ...avatar } = values;
  const rows = await db
    .insert(riskSettings)
    .values(values)
    .onConflictDoUpdate({
      target: riskSettings.account_id,
      set: avatar,
    })
    .returning();
  return rows[0] ? ({ ...rows[0] } as Row) : null;
}

export async function insertEquityPoint(
  accountId: string,
  balance: number | null,
  equity: number | null,
) {
  if (balance === null || equity === null) return;
  await db.insert(equityHistory).values({ account_id: accountId, balance, equity });
}

export async function selectEquityHistory(accountId: string) {
  const rows = await db
    .select({
      timestamp: equityHistory.timestamp,
      balance: equityHistory.balance,
      equity: equityHistory.equity,
    })
    .from(equityHistory)
    .where(eq(equityHistory.account_id, accountId))
    .orderBy(asc(equityHistory.timestamp))
    .limit(500);
  return rows.map((row) => ({ ...row }));
}