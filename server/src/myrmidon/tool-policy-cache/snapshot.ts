// server/src/myrmidon/tool-policy-cache/snapshot.ts
//
// myrmidon(DB-PERF-C-P4): the row sets behind the tool gateway's access
// decision, and the pure selections the gateway applies to them.
//
// A snapshot holds exactly the rows the gateway reads today: every profile
// binding of the company, every profile of the company, every profile entry of
// the company, and the enabled policies of the company in evaluation order.
// The gateway applies the same in-memory filters it applied to the per-request
// queries (candidate profile ids, active profile ids), so a cached read returns
// the same rows as a fresh one.

import type {
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";

export type ToolPolicyBindingRow = typeof toolProfileBindings.$inferSelect;
export type ToolPolicyProfileRow = typeof toolProfiles.$inferSelect;
export type ToolPolicyProfileEntryRow = typeof toolProfileEntries.$inferSelect;
export type ToolPolicyRow = typeof toolPolicies.$inferSelect;

export interface ToolPolicyCacheRows {
  bindings: ToolPolicyBindingRow[];
  profiles: ToolPolicyProfileRow[];
  entries: ToolPolicyProfileEntryRow[];
  /** Enabled policies of the company, in the order the decision evaluates them. */
  policies: ToolPolicyRow[];
}

/** One cached read: the rows plus the moment they were loaded. */
export interface ToolPolicySnapshot extends ToolPolicyCacheRows {
  cachedAt: number;
}

/** The company profiles a decision may use, in the order the call asked for. */
export function selectProfilesByIds(
  profiles: ToolPolicyProfileRow[],
  profileIds: string[],
): ToolPolicyProfileRow[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return profileIds
    .map((profileId) => byId.get(profileId) ?? null)
    .filter((profile): profile is ToolPolicyProfileRow => profile !== null);
}

/** The company entries that belong to the active profiles of this decision. */
export function selectEntriesForProfiles(
  entries: ToolPolicyProfileEntryRow[],
  profileIds: string[],
): ToolPolicyProfileEntryRow[] {
  if (profileIds.length === 0) return [];
  const wanted = new Set(profileIds);
  return entries.filter((entry) => wanted.has(entry.profileId));
}