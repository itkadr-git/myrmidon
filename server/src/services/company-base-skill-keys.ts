// myrmidon(1.6.5 BASE-SKILLS): the pure half of the base-skills registry — the
// read of the company list and the merge of that list into one agent's skill
// selection.
//
// It is deliberately dependency-free (database tables + adapter-utils only, no
// service imports), because `agentService.create` calls it on every agent
// creation path — the routes, the built-in agents and the approval flow — and
// must not pull a service cycle behind it. The registry mutations live in
// `./company-base-skills.js`.

import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyBaseSkills } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";

/** The shape `paperclipSkillSync.desiredSkills` stores per skill. */
export interface DesiredSkillEntry {
  key: string;
  versionId: string | null;
}

/**
 * The company's base skill keys in declaration order. An empty list means the
 * company has not declared base skills yet, and nothing is added to any agent.
 */
export async function readCompanyBaseSkillKeys(dbClient: Db, companyId: string): Promise<string[]> {
  const rows = await dbClient
    .select({ key: companyBaseSkills.key })
    .from(companyBaseSkills)
    .where(eq(companyBaseSkills.companyId, companyId))
    .orderBy(asc(companyBaseSkills.createdAt), asc(companyBaseSkills.key));
  return rows.map((row) => row.key);
}

/**
 * Every base skill key that the given selection is missing, in the order the
 * base list declares them.
 */
export function missingCompanyBaseSkillKeys(
  keys: readonly string[],
  entries: readonly DesiredSkillEntry[],
): string[] {
  if (keys.length === 0) return [];
  const present = new Set(entries.map((entry) => entry.key));
  return keys.filter((key) => !present.has(key));
}

/**
 * The selection with every base skill appended. The caller's own entries keep
 * their position and version pins; a base skill that is already selected is not
 * duplicated and not repinned.
 */
export function unionCompanyBaseSkillEntries(
  keys: readonly string[],
  entries: readonly DesiredSkillEntry[],
): DesiredSkillEntry[] {
  const missing = missingCompanyBaseSkillKeys(keys, entries);
  if (missing.length === 0) return [...entries];
  return [...entries, ...missing.map((key) => ({ key, versionId: null }))];
}

/**
 * The agent's adapter config with the company base skills added to its
 * `paperclipSkillSync` selection.
 *
 * Returns the very same object when the selection already carries every base
 * skill, so callers can compare references and skip a write that would only
 * churn the config revision history.
 */
export function mergeCompanyBaseSkillsIntoAgentConfig(
  adapterConfig: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  if (keys.length === 0) return adapterConfig;
  const preference = readPaperclipSkillSyncPreference(adapterConfig);
  if (missingCompanyBaseSkillKeys(keys, preference.desiredSkillEntries).length === 0) {
    return adapterConfig;
  }
  return writePaperclipSkillSyncPreference(
    adapterConfig,
    unionCompanyBaseSkillEntries(keys, preference.desiredSkillEntries),
  );
}