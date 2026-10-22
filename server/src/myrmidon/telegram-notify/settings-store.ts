// myrmidon(TG-NOTIFY-A): telegram-notify settings storage (part A).
//
// myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976, call map OPE-6629 point 69):
// the direct path of the core is deprecated. `services/instance-settings.ts`
// reaches `preserveTelegramNotifySettingsGeneralKey` through the bridge seam
// `channel-connectors/bridge/notify-settings-store.js` only; with the bridge
// flag on a registered channel connector serves the theme and this module stays
// behind the seam as the legacy fallback. The store internals
// (`dbTelegramNotifyStore`) stay in-family for the notify track. Do not add a
// new core importer; removal is the follow-up step, not this PR.
//
// State lives under our own key of `instance_settings.general`, keyed by
// companyId (the same rule as the autonomy and cloud-connector stores): the
// vendor settings service strips unknown keys, so this module reads and
// writes the raw row itself, under a row lock with `jsonb_set`. No
// migration, and an old image keeps working on the new schema.
//
// The document is company-scoped: `general` is a shared JSON column, so the
// key holds a map `{ [companyId]: document }` and every read/mutate touches
// only the caller's company slice.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  parseTelegramNotifyDocument,
  emptyTelegramNotifyDocument,
  type TelegramNotifyDocument,
} from "@paperclipai/shared";

// myrmidon(TG-NOTIFY-A): the owner settings live under their OWN key of
// `instance_settings.general`. The key `myrmidonTelegramNotify` already holds the
// job state (digest/escalation stamps) and the proactivity counters, each with
// its own shape; sharing one key would let one writer clobber another.
export const TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY = "myrmidonTelegramNotifySettings";
const TELEGRAM_NOTIFY_GENERAL_KEY = TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY;

/** Keep the settings key across vendor writes of `instance_settings.general`. */
export function preserveTelegramNotifySettingsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY]: value };
}

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

/**
 * The persisted shape of one company's document: the sections sit at the top
 * level next to the changelog — the shape `parseTelegramNotifyDocument` reads.
 * (The parsed document nests the sections under `settings`; writing that
 * nested form back would read as the defaults.)
 */
export function serializeTelegramNotifyDocument(doc: TelegramNotifyDocument): Record<string, unknown> {
  return { version: 1, ...doc.settings, changelog: doc.changelog };
}

function companyDocuments(raw: unknown): Record<string, TelegramNotifyDocument> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, TelegramNotifyDocument> = {};
  for (const [companyId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof companyId === "string" && companyId.length > 0) {
      out[companyId] = parseTelegramNotifyDocument(value);
    }
  }
  return out;
}

/** Read one company's document (defaults when nothing was ever stored). */
export async function readTelegramNotifySettingsDocument(db: Runner, companyId: string): Promise<TelegramNotifyDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return companyDocuments(row?.general?.[TELEGRAM_NOTIFY_GENERAL_KEY])[companyId] ?? emptyTelegramNotifyDocument();
}

/**
 * Read-modify-write of one company's slice under a row lock (the maintenance
 * store pattern): the change callback sees the current document and returns
 * the next one (or null to keep the stored value). Other companies' slices
 * and every other key of `general` are preserved byte for byte.
 */
export async function mutateTelegramNotifySettingsDocument<T>(
  db: Db,
  companyId: string,
  change: (current: TelegramNotifyDocument) => { next: TelegramNotifyDocument | null; result: T },
): Promise<{ doc: TelegramNotifyDocument; result: T; changed: boolean }> {
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
    const documents = companyDocuments(row.general?.[TELEGRAM_NOTIFY_GENERAL_KEY]);
    const current = documents[companyId] ?? emptyTelegramNotifyDocument();
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    documents[companyId] = next;
    const stored = Object.fromEntries(
      Object.entries(documents).map(([id, doc]) => [id, serializeTelegramNotifyDocument(doc)]),
    );
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${TELEGRAM_NOTIFY_GENERAL_KEY}}`}::text[], ${JSON.stringify(stored)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** The persistence seam: production uses the instance-settings row, tests use memory. */
export interface TelegramNotifyStore {
  read(companyId: string): Promise<TelegramNotifyDocument>;
  mutate<T>(
    companyId: string,
    change: (current: TelegramNotifyDocument) => { next: TelegramNotifyDocument | null; result: T },
  ): Promise<{ doc: TelegramNotifyDocument; result: T; changed: boolean }>;
}

export function dbTelegramNotifyStore(db: Db): TelegramNotifyStore {
  return {
    read: (companyId) => readTelegramNotifySettingsDocument(db, companyId),
    mutate: (companyId, change) => mutateTelegramNotifySettingsDocument(db, companyId, change),
  };
}

/** In-memory store (company-keyed): used by tests and read-only embeddings. */
export function memoryTelegramNotifyStore(
  initial?: Record<string, TelegramNotifyDocument>,
): TelegramNotifyStore {
  const documents = new Map<string, TelegramNotifyDocument>(Object.entries(initial ?? {}));
  return {
    read: async (companyId) => documents.get(companyId) ?? emptyTelegramNotifyDocument(),
    mutate: async (companyId, change) => {
      const current = documents.get(companyId) ?? emptyTelegramNotifyDocument();
      const { next, result } = change(current);
      if (next) documents.set(companyId, next);
      return { doc: next ?? current, result, changed: next !== null };
    },
  };
}
