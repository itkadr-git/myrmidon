// server/src/myrmidon/github-shared-identity/store.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the per-company access rules of the shared
// GitHub authorization, stored in the existing instance_settings JSON column —
// no migration (the same pattern as the STT and telegram-notify settings).
//
// The document lives under `general.myrmidonGithubSharedIdentity[companyId]`
// and is written with a jsonb_set read-modify-write under a row lock. The
// vendor write of `general` strips unknown keys, so
// `server/src/services/instance-settings.ts` carries the key over (the
// preserve line marked myrmidon(GITHUB-SHARED-IDENTITY) there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  GITHUB_SHARED_IDENTITY_GENERAL_KEY,
  parseStoredGitHubSharedIdentitySettings,
  type GitHubSharedIdentitySettings,
} from "./settings.js";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

function normalizeCompanyId(companyId: string): string {
  return companyId.trim().toLowerCase();
}

function readCompaniesMap(general: unknown): Record<string, unknown> {
  if (typeof general !== "object" || general === null) return {};
  const value = (general as Record<string, unknown>)[GITHUB_SHARED_IDENTITY_GENERAL_KEY];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The stored rules of one company; the default (off) when nothing is stored. */
export async function readGitHubSharedIdentitySettings(
  db: Runner,
  companyId: string,
): Promise<GitHubSharedIdentitySettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseStoredGitHubSharedIdentitySettings(readCompaniesMap(row?.general)[normalizeCompanyId(companyId)]);
}

/** Replace the rules of one company under a row lock. */
export async function writeGitHubSharedIdentitySettings(
  db: Db,
  companyId: string,
  next: GitHubSharedIdentitySettings,
): Promise<{ previous: GitHubSharedIdentitySettings; next: GitHubSharedIdentitySettings; changed: boolean }> {
  const key = normalizeCompanyId(companyId);
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
    const companies = readCompaniesMap(row.general);
    const previous = parseStoredGitHubSharedIdentitySettings(companies[key]);
    if (companies[key] !== undefined && JSON.stringify(previous) === JSON.stringify(next)) {
      return { previous, next, changed: false };
    }
    const companiesNext = { ...companies, [key]: next };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${GITHUB_SHARED_IDENTITY_GENERAL_KEY}}`}::text[], ${JSON.stringify(companiesNext)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { previous, next, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveGitHubSharedIdentityGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  const value = readCompaniesMap(storedGeneral);
  return Object.keys(value).length > 0 ? { [GITHUB_SHARED_IDENTITY_GENERAL_KEY]: value } : {};
}
