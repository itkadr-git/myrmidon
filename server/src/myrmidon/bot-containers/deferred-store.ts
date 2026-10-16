// myrmidon(BOT-ROLLOUT): the deferred bot rollout applies — the
// `myrmidonBotRolloutDeferred` key of instance_settings.general, the same
// pattern the maintenance mode (R3, maintenance/store.ts) and the bot image
// canary (R5-B, canary-store.ts) use. The vendor settings service strips
// unknown keys, so this module reads and writes the raw row itself and
// instance-settings.ts carries the key over a vendor write (see
// preserveBotRolloutDeferredGeneralKey and the myrmidon(BOT-ROLLOUT) call
// site there).
//
// A record lands here when a reconcile pass that had a real change to apply
// (a template drift — image, limits, network — or a restart-class profile
// change) could not touch the live container: the agent is under a window
// the reconciler did not open, or its owner is in a chat conversation. The
// card already holds the new image; the record is what makes the deferred
// drift converge without waiting for the next deploy: the watcher in
// deferred-reconciler.ts retries the apply on every reconcile sweep and
// removes the record on success.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

export const BOT_ROLLOUT_DEFERRED_GENERAL_KEY = "myrmidonBotRolloutDeferred";
const SINGLETON_KEY = "default";

/** One deferred apply, keyed by botKey (which is the agent id). */
export interface BotRolloutDeferredRecord {
  botKey: string;
  agentId: string;
  /** The image the pass tried to apply (the spec's, which is the rollout's
   *  image when the canary drives the pass). Recomputed from the live card on
   *  every retry: this field is diagnostic. */
  targetImage: string;
  /** ISO timestamp of the first deferral; the max-wait clock starts here. */
  firstDeferredAt: string;
  /** How many times the watcher re-attempted the apply. */
  attempts: number;
  /** The last deferral reason the reconciler returned. */
  lastReason: string;
  /** Set when the backstop retired the record (grace exhausted): the record
   *  is dropped from the active list and kept nowhere else — this field only
   *  exists on the audit payload, not on a stored record. */
  error?: string;
}

export interface BotRolloutDeferredDocument {
  version: 1;
  records: BotRolloutDeferredRecord[];
}

export function emptyBotRolloutDeferredDocument(): BotRolloutDeferredDocument {
  return { version: 1, records: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(raw: unknown): BotRolloutDeferredRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.botKey !== "string" || typeof raw.agentId !== "string") return null;
  if (typeof raw.firstDeferredAt !== "string" || !raw.firstDeferredAt) return null;
  return {
    botKey: raw.botKey,
    agentId: raw.agentId,
    targetImage: typeof raw.targetImage === "string" ? raw.targetImage : "",
    firstDeferredAt: raw.firstDeferredAt,
    attempts: typeof raw.attempts === "number" && Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastReason: typeof raw.lastReason === "string" ? raw.lastReason : "",
  };
}

/** Read the stored document defensively: anything malformed drops out. */
export function parseBotRolloutDeferredDocument(raw: unknown): BotRolloutDeferredDocument {
  if (!isRecord(raw) || !Array.isArray(raw.records)) return emptyBotRolloutDeferredDocument();
  const records: BotRolloutDeferredRecord[] = [];
  for (const item of raw.records) {
    const record = parseRecord(item);
    if (record) records.push(record);
  }
  return { version: 1, records };
}

type Runner = Pick<Db, "select">;

export async function readBotRolloutDeferredDocument(db: Runner): Promise<BotRolloutDeferredDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseBotRolloutDeferredDocument(row?.general?.[BOT_ROLLOUT_DEFERRED_GENERAL_KEY]);
}

/**
 * Read-modify-write the document under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateBotRolloutDeferredDocument<T>(
  db: Db,
  change: (current: BotRolloutDeferredDocument) => { next: BotRolloutDeferredDocument | null; result: T },
): Promise<{ doc: BotRolloutDeferredDocument; result: T; changed: boolean }> {
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
    const current = parseBotRolloutDeferredDocument(row.general?.[BOT_ROLLOUT_DEFERRED_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BOT_ROLLOUT_DEFERRED_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveBotRolloutDeferredGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BOT_ROLLOUT_DEFERRED_GENERAL_KEY];
  return value === undefined ? {} : { [BOT_ROLLOUT_DEFERRED_GENERAL_KEY]: value };
}

/**
 * The pure side of the store: the mutations deferred-reconciler.ts and
 * index.ts need, each an idempotent document-to-document step. A fresh target
 * image restarts the record's clock (the previous deferral was about a
 * superseded image); the same image only refreshes the reason.
 */
export function upsertBotRolloutDeferredRecord(
  doc: BotRolloutDeferredDocument,
  entry: { botKey: string; agentId: string; targetImage: string; reason: string; attempts?: number },
  now: Date,
): BotRolloutDeferredDocument {
  const existing = doc.records.find((r) => r.botKey === entry.botKey);
  if (existing && existing.targetImage === entry.targetImage) {
    return {
      ...doc,
      records: doc.records.map((r) =>
        r.botKey === entry.botKey
          ? { ...r, attempts: entry.attempts ?? r.attempts, lastReason: entry.reason }
          : r,
      ),
    };
  }
  const record: BotRolloutDeferredRecord = {
    botKey: entry.botKey,
    agentId: entry.agentId,
    targetImage: entry.targetImage,
    firstDeferredAt: now.toISOString(),
    attempts: entry.attempts ?? 0,
    lastReason: entry.reason,
  };
  return { ...doc, records: [...doc.records.filter((r) => r.botKey !== entry.botKey), record] };
}

/** Drop the record of one bot (a successful apply, or the backstop's retire). */
export function removeBotRolloutDeferredRecord(
  doc: BotRolloutDeferredDocument,
  botKey: string,
): BotRolloutDeferredDocument {
  if (!doc.records.some((r) => r.botKey === botKey)) return doc;
  return { ...doc, records: doc.records.filter((r) => r.botKey !== botKey) };
}

/** Bump the attempt counter of one record (the watcher retried the apply). */
export function bumpBotRolloutDeferredAttempt(
  doc: BotRolloutDeferredDocument,
  botKey: string,
  reason: string,
): BotRolloutDeferredDocument {
  return {
    ...doc,
    records: doc.records.map((r) =>
      r.botKey === botKey ? { ...r, attempts: r.attempts + 1, lastReason: reason } : r,
    ),
  };
}
