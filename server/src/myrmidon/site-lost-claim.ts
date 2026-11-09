// server/src/myrmidon/site-lost-claim.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): the atomic claim that lets a run of a lost execution site be
// finalized as `site_lost`.
//
// A run of a bot on a dead site stays `running` with a frozen controller lease and a gateway run
// id that points at the dead site. Two other writers touch such a row: the gateway reattach sweep
// (it claims rows whose lease is expired and no reattach marker is set) and the orphan reaper.
// The claim below is one UPDATE that is a compare-and-swap on the row's own state:
//
//   - the run is still `running`;
//   - no reattach marker is in contextSnapshot (a reattach execution is not in flight);
//   - no siteLost marker is in contextSnapshot yet (the run is not already claimed);
//   - the controller lease is absent or expired.
//
// The winner writes the siteLost marker into contextSnapshot and takes a fresh 60 s lease under a
// new boot id, so a reattach sweep or reaper that reads the row a moment later sees a live
// controller. The loser gets `false` and does nothing: a run is finalized once.

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@myrmidon/db";
import { randomUUID } from "node:crypto";
import { REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY } from "./gateway-run-reattach.js";

/** contextSnapshot key carrying the claim: { site, at }. */
export const SITE_LOST_CONTEXT_KEY = "siteLost";

export async function claimRunForSiteLost(
  db: Db,
  run: { id: string; companyId: string },
  siteName: string,
  at: Date = new Date(),
): Promise<boolean> {
  const marker = JSON.stringify({ site: siteName, at: at.toISOString() });
  const [claimed] = await db
    .update(heartbeatRuns)
    .set({
      contextSnapshot: sql`(
        case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
          then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end
      ) || jsonb_build_object(${SITE_LOST_CONTEXT_KEY}::text, ${marker}::jsonb)`,
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.status, "running"),
        sql`coalesce((${heartbeatRuns.contextSnapshot} ->> ${REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY}::text), '') = ''`,
        sql`not (coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) ? ${SITE_LOST_CONTEXT_KEY}::text)`,
        or(isNull(heartbeatRuns.controllerLeaseExpiresAt), lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`)),
      ),
    )
    .returning({ id: heartbeatRuns.id });
  return Boolean(claimed);
}
