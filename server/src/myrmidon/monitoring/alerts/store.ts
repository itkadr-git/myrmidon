// server/src/myrmidon/monitoring/alerts/store.ts
// myrmidon(1.6.6-ALERTS): the dedup registry, stored in the JSON column
// instance_settings.general under our key (no new table, no migration). The
// registry maps alert identities to the board issue they own. A periodic
// sweep (sweep.ts) drops closed entries by age.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { alertIdentity, type AlertSource } from "./domain.js";
import { ALERT_ROUTES_GENERAL_KEY } from "./settings.js";

export const ALERT_DEDUP_GENERAL_KEY = "myrmidonAlertDedup";
const SINGLETON_KEY = "default";

export interface DedupEntry {
  /** `${source}:${key}` from domain.ts. */
  id: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

type Runner = Pick<Db, "select" | "insert" | "update">;

function parseRegistry(raw: unknown): Record<string, DedupEntry> {
  if (typeof raw !== "object" || raw === null) return {};
  const entries: Record<string, DedupEntry> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<DedupEntry>;
    if (typeof entry.id !== "string" || typeof entry.issueId !== "string") continue;
    entries[id] = {
      id: entry.id,
      companyId: String(entry.companyId ?? ""),
      issueId: entry.issueId,
      issueIdentifier: typeof entry.issueIdentifier === "string" ? entry.issueIdentifier : null,
      issueStatus: String(entry.issueStatus ?? "open"),
      createdAt: String(entry.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(entry.updatedAt ?? new Date(0).toISOString()),
      resolvedAt: typeof entry.resolvedAt === "string" ? entry.resolvedAt : null,
    };
  }
  return entries;
}

async function readRegistry(db: Runner): Promise<Record<string, DedupEntry>> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseRegistry(row?.general?.[ALERT_DEDUP_GENERAL_KEY]);
}

/** Read-modify-write of the registry under a row lock, like the maintenance key. */
async function mutateRegistry<T>(
  db: Db,
  change: (current: Record<string, DedupEntry>) => { next: Record<string, DedupEntry> | null; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseRegistry(row.general?.[ALERT_DEDUP_GENERAL_KEY]);
    const { next, result } = change(current);
    if (next) {
      await tx
        .update(instanceSettings)
        .set({
          general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${ALERT_DEDUP_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
        })
        .where(eq(instanceSettings.id, row.id));
    }
    return result;
  });
}

export interface AlertDedupStore {
  get(companyId: string, source: AlertSource, key: string): Promise<DedupEntry | null>;
  upsert(companyId: string, source: AlertSource, key: string, issue: { issueId: string; issueIdentifier: string | null }): Promise<DedupEntry>;
  markResolved(companyId: string, source: AlertSource, key: string, resolvedAt: string): Promise<DedupEntry | null>;
  /** Drops entries whose issue is closed and whose updatedAt is older than maxAgeMs. Returns the count. */
  sweepClosedOlderThan(now: Date, maxAgeMs: number): Promise<number>;
}

export function createDbAlertDedupStore(db: Db): AlertDedupStore {
  return {
    async get(companyId, source, key) {
      const registry = await readRegistry(db);
      const entry = registry[alertIdentity({ source, key })];
      return entry && entry.companyId === companyId ? entry : null;
    },
    async upsert(companyId, source, key, issue) {
      return mutateRegistry(db, (current) => {
        const id = alertIdentity({ source, key });
        const now = new Date().toISOString();
        const entry: DedupEntry = {
          id,
          companyId,
          issueId: issue.issueId,
          issueIdentifier: issue.issueIdentifier,
          issueStatus: "open",
          createdAt: current[id]?.createdAt ?? now,
          updatedAt: now,
          resolvedAt: null,
        };
        return { next: { ...current, [id]: entry }, result: entry };
      });
    },
    async markResolved(companyId, source, key, resolvedAt) {
      return mutateRegistry(db, (current) => {
        const id = alertIdentity({ source, key });
        const entry = current[id];
        if (!entry || entry.companyId !== companyId) return { next: null, result: null };
        const updated: DedupEntry = { ...entry, issueStatus: "resolved", updatedAt: new Date().toISOString(), resolvedAt };
        return { next: { ...current, [id]: updated }, result: updated };
      });
    },
    async sweepClosedOlderThan(now, maxAgeMs) {
      return mutateRegistry(db, (current) => {
        const cutoff = now.getTime() - maxAgeMs;
        let removed = 0;
        const next: Record<string, DedupEntry> = {};
        for (const [id, entry] of Object.entries(current)) {
          const closed = entry.issueStatus !== "open";
          const stale = Date.parse(entry.updatedAt) < cutoff;
          if (closed && stale) removed += 1;
          else next[id] = entry;
        }
        return { next: removed > 0 ? next : null, result: removed };
      });
    },
  };
}
