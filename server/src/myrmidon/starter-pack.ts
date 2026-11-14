// myrmidon(OPE-13095): the starter-pack scout.
//
// A new task of an engineer used to start the engineer's first run cold: the
// engineer spent its first turns finding the files and the entry points. With
// `general.starterPackAgentId` set, the board wakes that scout agent first. The
// scout only reads the code and writes the task document `starter-pack`
// (markdown). After the scout's run the board wakes the assignee with the usual
// `issue_assigned` wake, with the document or without it, so a task never hangs
// on the scout: there is no timeout, the end of the scout's run is the signal.
// Delivering the document to the engineer is another change (OPE-13086).
//
// The setting is absent by default: nothing here changes the behaviour then. The
// scout is not placed when the task already has a `starter-pack` document or the
// heading `### Стартовый пакет` in its description, or the assignee is not an
// engineer (`agents.role`).
//
// The assignee is woken once per task after the scout: the wake after the
// document and the wake after the end of the scout's run share one idempotency
// key and `wakeAssigneeAfterStarterPack` skips the second one.

import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, instanceSettings, issueDocuments, type Db } from "@myrmidon/db";

export const STARTER_PACK_DOCUMENT_KEY = "starter-pack";
export const STARTER_PACK_SCOUT_WAKE_REASON = "starter_pack_scout";
export const STARTER_PACK_SCOUT_SOURCE = "myrmidon.starter_pack";
/** `contextSource` of the assignee's wake after the scout. */
export const STARTER_PACK_READY_SOURCE = "starter_pack.ready";
/** Heading that marks a description which already carries a starter pack. */
export const STARTER_PACK_DESCRIPTION_HEADING = "### Стартовый пакет";
const ENGINEER_ROLE = "engineer";

export function buildStarterPackScoutWakeIdempotencyKey(issueId: string): string {
  return `${STARTER_PACK_SCOUT_SOURCE}:scout:${issueId}`;
}

/** One key for the assignee's wake after the document and after the end of the scout's run. */
export function buildStarterPackReadyWakeIdempotencyKey(issueId: string): string {
  return `${STARTER_PACK_READY_SOURCE}:${issueId}`;
}

/**
 * `general.starterPackAgentId`, or null when it is not set (or is not a string).
 * Read straight from the stored row so that a run dispatch inside a transaction
 * can ask it too.
 */
export async function readStarterPackAgentId(db: Db): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: sql<string | null>`${instanceSettings.general} ->> 'starterPackAgentId'` })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .limit(1);
    const value = row?.value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Pure decision: place the scout before the assignee's first run, or not. */
export function shouldPlaceStarterPackScout(input: {
  scoutAgentId: string | null;
  assigneeAgentId: string | null;
  assigneeRole: string | null;
  description: string | null | undefined;
  hasStarterPackDocument: boolean;
}): boolean {
  if (!input.scoutAgentId || !input.assigneeAgentId) return false;
  if (input.scoutAgentId === input.assigneeAgentId) return false;
  if (input.assigneeRole !== ENGINEER_ROLE) return false;
  if (input.hasStarterPackDocument) return false;
  if ((input.description ?? "").includes(STARTER_PACK_DESCRIPTION_HEADING)) return false;
  return true;
}

export async function hasStarterPackDocument(db: Db, input: { companyId: string; issueId: string }): Promise<boolean> {
  const [row] = await db
    .select({ id: issueDocuments.id })
    .from(issueDocuments)
    .where(
      and(
        eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, input.issueId),
        eq(issueDocuments.key, STARTER_PACK_DOCUMENT_KEY),
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface StarterPackIssue {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  description?: string | null;
  status?: string | null;
}

type EnqueueWakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "system";
    requestedByActorId: null;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * The scout to place for this new task, or null (setting absent, no engineer
 * assignee, the task already has a document or the heading).
 */
export async function resolveStarterPackScoutId(db: Db, issue: StarterPackIssue): Promise<string | null> {
  // The assignee's own first wake is skipped for these statuses too, so no scout either.
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return null;
  const scoutAgentId = await readStarterPackAgentId(db);
  if (!scoutAgentId || !issue.assigneeAgentId) return null;
  const rows = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, issue.assigneeAgentId)))
    .limit(1);
  const assignee = rows[0];
  if (!assignee) return null;
  const scout = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, scoutAgentId)))
    .limit(1);
  if (!scout[0]) return null;
  const hasDocument = await hasStarterPackDocument(db, { companyId: issue.companyId, issueId: issue.id });
  return shouldPlaceStarterPackScout({
    scoutAgentId,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeRole: assignee.role,
    description: issue.description,
    hasStarterPackDocument: hasDocument,
  })
    ? scoutAgentId
    : null;
}

/**
 * Wake the scout of a new task. Returns true when the scout was placed: the caller
 * then does not wake the assignee (the end of the scout's run does). Returns false
 * when nothing was placed (the caller wakes the assignee as before) and also when
 * the wake request was not queued, so that a broken scout never holds a task.
 */
export async function maybeWakeStarterPackScout(
  db: Db,
  enqueueWakeup: EnqueueWakeup,
  issue: StarterPackIssue,
): Promise<boolean> {
  try {
    const scoutId = await resolveStarterPackScoutId(db, issue);
    if (!scoutId) return false;
    const queued = await enqueueWakeup(scoutId, {
      source: "automation",
      triggerDetail: "system",
      reason: STARTER_PACK_SCOUT_WAKE_REASON,
      payload: { issueId: issue.id, assigneeAgentId: issue.assigneeAgentId },
      idempotencyKey: buildStarterPackScoutWakeIdempotencyKey(issue.id),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: STARTER_PACK_SCOUT_WAKE_REASON,
        source: STARTER_PACK_SCOUT_SOURCE,
      },
    });
    // A wake the board did not queue (a paused scout, a refused wake) places no
    // scout: the assignee is woken at once instead of waiting for a run that never is.
    return Boolean(queued);
  } catch {
    return false;
  }
}

/**
 * True when `agentId` is the configured scout and the issue's assignee is another
 * agent. The run dispatch asks it before it lets a non-assignee run start on the
 * assignee's issue.
 */
export async function isStarterPackScoutWake(
  db: Db,
  input: { companyId: string; assigneeAgentId: string | null; agentId: string },
): Promise<boolean> {
  if (!input.assigneeAgentId || input.assigneeAgentId === input.agentId) return false;
  const scoutAgentId = await readStarterPackAgentId(db);
  if (!scoutAgentId || scoutAgentId !== input.agentId) return false;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
    .limit(1);
  return rows.length > 0;
}

/** True when the assignee was already woken for this task after the scout. */
export async function hasStarterPackReadyWake(
  db: Db,
  input: { companyId: string; issueId: string; assigneeAgentId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.assigneeAgentId),
        eq(agentWakeupRequests.idempotencyKey, buildStarterPackReadyWakeIdempotencyKey(input.issueId)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Wake the assignee after the scout (the document is written, or the scout's run
 * ended without one). One wake per task: the second caller finds the request of the
 * first one and does nothing. `queueWake` is `queueIssueAssignmentWakeup` bound to
 * the idempotency key it is handed. Returns true when the wake was queued here.
 */
export async function wakeAssigneeAfterStarterPack(
  db: Db,
  issue: { id: string; companyId: string; assigneeAgentId: string | null },
  queueWake: (idempotencyKey: string) => unknown,
): Promise<boolean> {
  if (!issue.assigneeAgentId) return false;
  if (
    await hasStarterPackReadyWake(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      assigneeAgentId: issue.assigneeAgentId,
    })
  ) {
    return false;
  }
  await queueWake(buildStarterPackReadyWakeIdempotencyKey(issue.id));
  return true;
}
