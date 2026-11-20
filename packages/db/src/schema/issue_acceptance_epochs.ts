import { sql } from "drizzle-orm";
import { pgTable, uuid, bigint } from "drizzle-orm/pg-core";

/**
 * myrmidon(OPE-15134/OPE-15145): per-issue monotonic epoch for the
 * acceptance snapshot pin. Bumped by database triggers (migration 0489)
 * whenever anything relevant to the acceptance snapshot changes — the issue
 * row, its acceptance-scenarios link row (both sides of a transfer), the
 * bound document row, or its revision rows — so pin-tuple equality across
 * two reads of the atomic snapshot proves none of the pinned
 * identities/links/content changed in between, including A->B->A reverts.
 * The row deliberately has no foreign key to issues: it survives issue
 * delete+recreate, and a BEFORE UPDATE trigger plus an AFTER DELETE
 * trigger make any direct reset or deletion fail closed. `epoch` is read
 * through native bigint and exposed as a decimal string: generations beyond
 * 2^53 must stay exact for the reader's pin comparison.
 */
export const issueAcceptanceEpochs = pgTable("issue_acceptance_epochs", {
  issueId: uuid("issue_id").primaryKey(),
  epoch: bigint("epoch", { mode: "bigint" }).notNull().default(sql`0`),
});
