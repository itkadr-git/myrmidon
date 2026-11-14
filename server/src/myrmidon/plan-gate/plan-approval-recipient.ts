import { eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents } from "@myrmidon/db";
import { isAgentStatusInvokable } from "@myrmidon/shared";

type DbReader = Pick<Db, "select">;

/** Agent roles that may approve an engineering plan. */
export const PLAN_APPROVER_ROLES = ["lead", "architect"] as const;

// Last-resort fallback only (same convention as run-guard-escalation): the
// agent named `adm`. This is the single place where a name is used.
const PLAN_APPROVAL_FALLBACK_AGENT_NAME = "adm";

type AgentRow = { id: string; name?: string | null; status: string; pausedAt: Date | null; role?: string | null; reportsTo?: string | null };

function isUsable(row: AgentRow, executorAgentId: string | null | undefined): boolean {
  return (
    row.id !== executorAgentId &&
    isAgentStatusInvokable(row.status) &&
    !row.pausedAt &&
    row.status !== "paused" &&
    row.status !== "terminated"
  );
}

function isApproverRole(role: string | null | undefined): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  return (PLAN_APPROVER_ROLES as readonly string[]).includes(normalized);
}

/**
 * Who approves the plan: the executor's manager chain first (first invokable
 * agent with role lead/architect), then any invokable lead/architect of the
 * company, then the fallback agent `adm`. Never the executor. `null` if none.
 */
export async function resolvePlanApprovalRecipient(
  db: DbReader,
  companyId: string,
  _projectId: string | null | undefined,
  executorAgentId: string | null | undefined,
): Promise<string | null> {
  const rows: AgentRow[] = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      pausedAt: agents.pausedAt,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Manager chain of the executor.
  const seen = new Set<string>();
  let cursor = executorAgentId ? byId.get(executorAgentId)?.reportsTo ?? null : null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const manager = byId.get(cursor);
    if (!manager) break;
    if (isApproverRole(manager.role) && isUsable(manager, executorAgentId)) return manager.id;
    cursor = manager.reportsTo ?? null;
  }

  // Any invokable lead/architect in the company.
  const approver = rows.find((row) => isApproverRole(row.role) && isUsable(row, executorAgentId));
  if (approver) return approver.id;

  // Single place where the agent name is allowed.
  const fallback = rows.find(
    (row) =>
      (row.name ?? "").trim().toLowerCase() === PLAN_APPROVAL_FALLBACK_AGENT_NAME &&
      isUsable(row, executorAgentId),
  );
  return fallback?.id ?? null;
}
