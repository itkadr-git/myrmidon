// server/src/myrmidon/litellm-workers/settings.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): where the target number of LiteLLM worker
// processes lives.
//
// Storage choice: per company, in `instance_settings.general` under one key
// (`myrmidonLitellmWorkersCompanies`) mapping companyId to a document — the
// same shape the budget projection of the same gateway already uses. Two
// reasons: the route the ticket asks for is company-scoped
// (`/api/myrmidon/companies/:companyId/litellm/workers`), so a per-company
// document keeps the API and the storage one-to-one; and the container's shape
// (cores, memory) is a property of the HOST, not of the company, so it is read
// from the instance environment rather than repeated per company.
//
// The document is written under the instance settings row lock, in one
// transaction, read-modify-write: two admins resizing two companies at once
// must not overwrite each other's map. A hand-edited `general` is tolerated —
// every value is normalised on the way in, so unreadable content reads as
// "not set" instead of as a number the gateway would be told to obey.

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  LITELLM_WORKERS_COMPANIES_KEY,
  normalizeLitellmWorkersSettings,
  type LitellmWorkersStoredSettings,
} from "@paperclipai/shared";

/** The single row of `instance_settings`. */
export const LITELLM_WORKERS_SINGLETON_KEY = "default";

/**
 * A `Db` or an open transaction handle — the subset of query builders this
 * module's write runs on, so the read-modify-write can hold the row lock.
 */
type LitellmWorkersTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What one company's document holds, once it is written. */
export type LitellmWorkersDocument = LitellmWorkersStoredSettings & {
  /** When the board last wrote this document, ISO-8601. */
  updatedAt?: string;
};

/** The store the routes and the service talk to, so a test needs no database. */
export interface LitellmWorkersStore {
  /** One company's document; the empty document when nothing was ever set. */
  read(companyId: string): Promise<LitellmWorkersStoredSettings>;
  /**
   * Reads, changes and writes one company's document, holding the instance
   * settings row lock for the whole read-modify-write. `change` gets the
   * normalised current document and returns the document to store plus
   * whatever the caller wants back.
   */
  mutate<T>(
    companyId: string,
    change: (current: LitellmWorkersStoredSettings) => { next: LitellmWorkersStoredSettings; result: T },
  ): Promise<{ doc: LitellmWorkersStoredSettings; result: T }>;
}

/** The whole map of companyId -> document, as `general` holds it. */
function readCompanies(general: unknown): Record<string, unknown> {
  if (typeof general !== "object" || general === null || Array.isArray(general)) return {};
  const companies = (general as Record<string, unknown>)[LITELLM_WORKERS_COMPANIES_KEY];
  if (typeof companies !== "object" || companies === null || Array.isArray(companies)) return {};
  return { ...(companies as Record<string, unknown>) };
}

/** `general` with this module's key replaced by the given map. */
function mergeGeneral(general: unknown, companies: Record<string, unknown>): unknown {
  const base = typeof general === "object" && general !== null && !Array.isArray(general) ? { ...(general as Record<string, unknown>) } : {};
  base[LITELLM_WORKERS_COMPANIES_KEY] = companies;
  return base;
}

/** The database-backed store. */
export function drizzleLitellmWorkersStore(db: Db): LitellmWorkersStore {
  return {
    async read(companyId: string): Promise<LitellmWorkersStoredSettings> {
      const [row] = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, LITELLM_WORKERS_SINGLETON_KEY))
        .limit(1);
      return normalizeLitellmWorkersSettings(readCompanies(row?.general)[companyId]);
    },

    async mutate<T>(
      companyId: string,
      change: (current: LitellmWorkersStoredSettings) => { next: LitellmWorkersStoredSettings; result: T },
    ): Promise<{ doc: LitellmWorkersStoredSettings; result: T }> {
      return db.transaction(async (tx: LitellmWorkersTransaction) => {
        const [row] = await tx
          .select({ id: instanceSettings.id, general: instanceSettings.general })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, LITELLM_WORKERS_SINGLETON_KEY))
          .limit(1)
          .for("update");
        const companies = readCompanies(row?.general);
        const before = normalizeLitellmWorkersSettings(companies[companyId]);
        const { next, result } = change(before);
        const document: LitellmWorkersDocument = { ...next, updatedAt: new Date().toISOString() };
        companies[companyId] = document;
        const general = mergeGeneral(row?.general, companies) as Record<string, unknown>;
        if (row) {
          await tx.update(instanceSettings).set({ general }).where(eq(instanceSettings.id, row.id));
        } else {
          await tx
            .insert(instanceSettings)
            .values({ singletonKey: LITELLM_WORKERS_SINGLETON_KEY, general })
            .onConflictDoUpdate({
              target: [instanceSettings.singletonKey],
              set: { general },
            });
        }
        return { doc: next, result };
      });
    },
  };
}

/** An in-process store — what a test uses instead of a database. */
export function memoryLitellmWorkersStore(
  seed: Record<string, LitellmWorkersStoredSettings> = {},
): LitellmWorkersStore {
  const documents = new Map<string, LitellmWorkersStoredSettings>(Object.entries(seed));
  return {
    async read(companyId) {
      return documents.get(companyId) ?? { target: null, observed: null };
    },
    async mutate(companyId, change) {
      const before = documents.get(companyId) ?? { target: null, observed: null };
      const { next, result } = change(before);
      documents.set(companyId, next);
      return { doc: next, result };
    },
  };
}

/**
 * Keeps this module's key while `instance_settings.general` is replaced
 * wholesale by another writer.
 *
 * The instance settings service lets a caller set the whole `general` object;
 * whoever does that would silently drop the target of every company. The
 * service spreads this hook into its own value, so the key survives a write
 * this module never sees. Same contract as the budget projection's
 * `preserveBudgetProjectionGeneralKey`.
 */
export function preserveLitellmWorkersGeneralKey(
  storedGeneral: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const companies = storedGeneral?.[LITELLM_WORKERS_COMPANIES_KEY];
  if (typeof companies !== "object" || companies === null || Array.isArray(companies)) return {};
  return { [LITELLM_WORKERS_COMPANIES_KEY]: companies };
}

/** Exported for the tests and for a future sweep that wants the raw map. */
export const litellmWorkersSettingsInternals = { readCompanies, mergeGeneral };