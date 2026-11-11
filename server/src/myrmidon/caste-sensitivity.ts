// server/src/myrmidon/caste-sensitivity.ts
//
// myrmidon(1.6.6 K-3): the one place that reads which castes are sensitive.
// A rule that governs a sensitive caste is the owner's to approve, so a failed
// read must never quietly fall back to the built-in list (that would lower the
// grade a rule needs): the error propagates and the caller refuses.

import { eq } from "drizzle-orm";
import { agentCastes, type Db } from "@myrmidon/db";
import { BUILTIN_SENSITIVE_CASTES } from "@myrmidon/shared";
import type { CasteSensitivity } from "./knowledge/rules.js";

/**
 * The company's caste directory. A company that has no directory rows yet
 * (never seeded) uses the built-in sensitive castes; a failing read throws.
 */
export async function resolveCasteSensitivity(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<CasteSensitivity> {
  const rows = await db
    .select({ key: agentCastes.key, sensitive: agentCastes.sensitive })
    .from(agentCastes)
    .where(eq(agentCastes.companyId, companyId));
  if (rows.length > 0) {
    return { sensitive: new Set(rows.filter((r) => r.sensitive).map((r) => r.key)) };
  }
  return { sensitive: new Set<string>(BUILTIN_SENSITIVE_CASTES) };
}
