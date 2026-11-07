import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@myrmidon/db";
import { issueRecoveryActionService } from "../../services/issue-recovery-actions.js";
import { resolveRecoveryOwner } from "../../services/recovery-factory/resolve-owner.js";
import {
  getAgentContainerOomEvents,
  type ContainerOomEvidenceEvent,
} from "./container-oom-store.js";

export type ContainerOomRecoveryDeps = {
  getRun: (runId: string) => Promise<{ id: string; agentId: string } | null>;
  getEvents: (agentId: string, runId: string) => Promise<ContainerOomEvidenceEvent[]>;
  getIssue: (runId: string) => Promise<{
    id: string;
    companyId: string;
    projectId: string | null;
  } | null>;
  getCandidates: (companyId: string) => Promise<{
    id: string;
    agentId: string;
    role: string;
    status: string;
  }[]>;
  ensureRecoveryIssue: (input: {
    kind: "resource.oom";
    sourceIssueId: string;
    dedupeKey: string;
    owner: { agentId: string };
    slaMinutes: number;
    nextCheckAt: string;
    evidence: Record<string, unknown>;
    runbookRef: string;
  }) => Promise<unknown>;
};

const databaseDeps = (db: Db): ContainerOomRecoveryDeps => ({
  getRun: async (runId) => {
    const [run] = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
    return run ?? null;
  },
  getEvents: (agentId, runId) => getAgentContainerOomEvents(db, agentId, runId),
  getIssue: async (runId) => {
    const [issue] = await db.select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
    }).from(issues).where(eq(issues.executionRunId, runId)).limit(1);
    return issue ?? null;
  },
  getCandidates: (companyId) => db.select({
    id: agents.id,
    agentId: agents.id,
    role: agents.role,
    status: agents.status,
  }).from(agents).where(eq(agents.companyId, companyId)),
  ensureRecoveryIssue: (input) => issueRecoveryActionService(db).ensureRecoveryIssue(input),
});

async function recoverContainerOom(
  deps: ContainerOomRecoveryDeps,
  runId: string,
) {
  const run = await deps.getRun(runId);
  if (!run) return null;
  const events = await deps.getEvents(run.agentId, run.id);
  if (!events.length) return null;

  const issue = await deps.getIssue(run.id);
  if (!issue) return null;

  const candidates = await deps.getCandidates(issue.companyId);
  const owner = resolveRecoveryOwner({ kind: "resource.oom", projectId: issue.projectId, candidates });
  return deps.ensureRecoveryIssue({
    kind: "resource.oom", sourceIssueId: issue.id, dedupeKey: `resource.oom:${run.id}`,
    owner: owner.owner as { agentId: string }, slaMinutes: owner.slaMinutes, nextCheckAt: owner.nextCheckAt,
    evidence: {
      runId: run.id, agentId: run.agentId,
      oomEvents: events.map(({ details }) => details),
    },
    runbookRef: "recovery/resource.oom",
  });
}

/** Test seam for the orchestration logic; production callers use recoverContainerOomForRun. */
export const containerOomRecoveryTestUtils = { recoverContainerOom };

/** Converts durable, run-correlated OOM evidence into a deduplicated typed action. */
export async function recoverContainerOomForRun(db: Db, runId: string) {
  return recoverContainerOom(databaseDeps(db), runId);
}
