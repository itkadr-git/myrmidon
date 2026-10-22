import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolPolicies, toolProfileBindings, toolProfiles } from "@paperclipai/db";

/**
 * Company-scoped policy snapshot row set, loaded once per tools/list request
 * (OPE-4129). Lives in a separate module so the perf test can import the real
 * loader without pulling the full tool-gateway dependency graph.
 */
export type ToolPolicySnapshot = {
  profiles: (typeof toolProfiles.$inferSelect)[];
  profileBindings: (typeof toolProfileBindings.$inferSelect)[];
  policies: (typeof toolPolicies.$inferSelect)[];
};

/**
 * Loads the company policy snapshot in exactly 3 queries:
 *   tool_profiles          where company_id = ?
 *   tool_profile_bindings  where company_id = ?
 *   tool_policies          where company_id = ? and enabled = true
 *                          order by priority asc, created_at asc
 * The policies query matches tool-access-policy.decide() exactly (only
 * enabled policies, deterministic priority order).
 */
export async function loadToolPolicySnapshot(
  db: Db,
  companyId: string,
): Promise<ToolPolicySnapshot> {
  const [profiles, profileBindings, policies] = await Promise.all([
    db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId)),
    db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId)),
    db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, companyId), eq(toolPolicies.enabled, true)))
      .orderBy(asc(toolPolicies.priority), asc(toolPolicies.createdAt)),
  ]);
  return { profiles, profileBindings, policies };
}
