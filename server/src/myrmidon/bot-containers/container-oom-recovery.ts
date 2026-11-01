import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@myrmidon/db";
import { issueRecoveryActionService } from "../../services/issue-recovery-actions.js";
import { resolveRecoveryOwner } from "../../services/recovery-factory/resolve-owner.js";
import { getAgentContainerOomEvents } from "./container-oom-store.js";

/** Converts durable, run-correlated OOM evidence into a deduplicated typed action. */
export async function recoverContainerOomForRun(db: Db, runId: string) {
  const [run] = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
  if (!run) return null;
  const events = await getAgentContainerOomEvents(db, run.agentId, run.id);
  if (!events.length) return null;

  const [issue] = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
  }).from(issues).where(eq(issues.executionRunId, run.id)).limit(1);
  if (!issue) return null;

  const candidates = await db.select({
    id: agents.id,
    agentId: agents.id,
    role: agents.role,
    status: agents.status,
  }).from(agents).where(eq(agents.companyId, issue.companyId));
  const owner = resolveRecoveryOwner({ kind: "resource.oom", projectId: issue.projectId, candidates });
  return issueRecoveryActionService(db).ensureRecoveryIssue({
    kind: "resource.oom", sourceIssueId: issue.id, dedupeKey: `resource.oom:${run.id}`,
    owner: owner.owner, slaMinutes: owner.slaMinutes, nextCheckAt: owner.nextCheckAt,
    evidence: {
      runId: run.id, agentId: run.agentId,
      oomEvents: events.map(({ details }) => details),
    },
    runbookRef: "recovery/resource.oom",
  });
}
