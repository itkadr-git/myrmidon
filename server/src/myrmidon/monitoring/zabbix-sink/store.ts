// server/src/myrmidon/monitoring/zabbix-sink/store.ts
// myrmidon(1.7-ZABBIX-SINK): the sink dedup registry, stored in the JSON column
// instance_settings.general under our key (no new table, no migration). The
// registry maps a Zabbix eventid to the draft task it owns; the same eventid
// seen again returns the existing draft instead of creating a second task.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@myrmidon/db";

export const ZABBIX_SINK_DEDUP_GENERAL_KEY = "myrmidonZabbixSinkDedup";
const SINGLETON_KEY = "default";

export interface SinkDedupEntry {
  /** `zabbix-sink:<eventid>`. */
  id: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string;
  createdAt: string;
  updatedAt: string;
}

type Runner = Pick<Db, "select" | "insert" | "update">;

function parseRegistry(raw: unknown): Record<string, SinkDedupEntry> {
  if (typeof raw !== "object" || raw === null) return {};
  const entries: Record<string, SinkDedupEntry> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<SinkDedupEntry>;
    if (typeof entry.id !== "string" || typeof entry.issueId !== "string") continue;
    entries[id] = {
      id: entry.id,
      companyId: String(entry.companyId ?? ""),
      issueId: entry.issueId,
      issueIdentifier: typeof entry.issueIdentifier === "string" ? entry.issueIdentifier : null,
      issueStatus: String(entry.issueStatus ?? "open"),
      createdAt: String(entry.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(entry.updatedAt ?? new Date(0).toISOString()),
    };
  }
  return entries;
}

async function readRegistry(db: Runner): Promise<Record<string, SinkDedupEntry>> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseRegistry(row?.general?.[ZABBIX_SINK_DEDUP_GENERAL_KEY]);
}

async function mutateRegistry<T>(
  db: Db,
  change: (current: Record<string, SinkDedupEntry>) => { next: Record<string, SinkDedupEntry> | null; result: T },
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
    const current = parseRegistry(row.general?.[ZABBIX_SINK_DEDUP_GENERAL_KEY]);
    const { next, result } = change(current);
    if (next) {
      await tx
        .update(instanceSettings)
        .set({
          general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${ZABBIX_SINK_DEDUP_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
        })
        .where(eq(instanceSettings.id, row.id));
    }
    return result;
  });
}

/** Registry identity for one Zabbix event: `zabbix-sink:<eventid>`. */
export function sinkDedupId(eventId: string): string {
  return `zabbix-sink:${eventId}`;
}

export interface ZabbixSinkDedupStore {
  get(companyId: string, eventId: string): Promise<SinkDedupEntry | null>;
  upsert(companyId: string, eventId: string, issue: { issueId: string; issueIdentifier: string | null }): Promise<SinkDedupEntry>;
}

export function createDbZabbixSinkDedupStore(db: Db): ZabbixSinkDedupStore {
  return {
    async get(companyId, eventId) {
      const registry = await readRegistry(db);
      const entry = registry[sinkDedupId(eventId)];
      return entry && entry.companyId === companyId ? entry : null;
    },
    async upsert(companyId, eventId, issue) {
      return mutateRegistry(db, (current) => {
        const id = sinkDedupId(eventId);
        const now = new Date().toISOString();
        const entry: SinkDedupEntry = {
          id,
          companyId,
          issueId: issue.issueId,
          issueIdentifier: issue.issueIdentifier,
          issueStatus: "todo",
          createdAt: current[id]?.createdAt ?? now,
          updatedAt: now,
        };
        return { next: { ...current, [id]: entry }, result: entry };
      });
    },
  };
}
