// server/src/myrmidon/tool-policy-cache/loader.ts
//
// myrmidon(DB-PERF-C-P4): the database half of the policy cache. One load per
// company per TTL window instead of four reads per gateway call.
//
// The loader runs only on a miss: it reads every binding, profile and entry of
// the company plus its enabled policies in evaluation order. The gateway then
// applies the same in-memory selections it applied to the per-request queries
// (candidate profile ids, active profile ids), so a cached decision sees the
// same rows as an uncached one.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { ToolPolicySnapshotLoader } from "./cache.js";
import type { ToolPolicyCacheRows } from "./snapshot.js";

export function createToolPolicySnapshotLoader(db: Db): ToolPolicySnapshotLoader {
  return async (companyId: string): Promise<ToolPolicyCacheRows> => {
    const bindings = await db
      .select()
      .from(toolProfileBindings)
      .where(eq(toolProfileBindings.companyId, companyId));
    const profiles = await db
      .select()
      .from(toolProfiles)
      .where(eq(toolProfiles.companyId, companyId));
    const entries = await db
      .select()
      .from(toolProfileEntries)
      .where(eq(toolProfileEntries.companyId, companyId));
    const policies = await db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, companyId), eq(toolPolicies.enabled, true)))
      .orderBy(asc(toolPolicies.priority), asc(toolPolicies.createdAt));
    return { bindings, profiles, entries, policies };
  };
}