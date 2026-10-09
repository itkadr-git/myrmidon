// server/src/myrmidon/swarm-claim/events.ts
//
// myrmidon(1.6.5 OPE-6608, review item 2 / design §3.5): the event hooks of the
// matcher. The services that change the facts (issues: a task appeared or became
// available; agents: a pause was lifted) call `notifySwarmIssueEvent` /
// `notifySwarmAgentEvent`; the heartbeat service, the only place that owns the
// wake admission path, installs the sink that turns an event into
// `matcher.forIssue` / `matcher.forAgent`.
//
// Rules of the hooks:
//  - never throw into the caller: an issue write or a resume must not fail
//    because a pairing did (the periodic `forCompany` pass is the safety net);
//  - never block the caller: the pairing runs after the caller returns;
//  - the switch is read by the matcher per event, so a swarm turned off stops
//    matching at once, with no restart.

import { SWARM_CLAIM_QUEUE_ISSUE_STATUSES } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { SwarmMatcherPair } from "./matcher.js";

/** What the heartbeat service installs: one matcher call per event. */
export interface SwarmEventSink {
  forIssue(issueId: string): Promise<SwarmMatcherPair | null>;
  forAgent(agentId: string): Promise<SwarmMatcherPair | null>;
}

let sink: SwarmEventSink | null = null;

/** Install (or, with null, remove) the sink. The last installer wins: every heartbeat service reads the same database. */
export function setSwarmEventSink(next: SwarmEventSink | null): void {
  sink = next;
}

export function getSwarmEventSink(): SwarmEventSink | null {
  return sink;
}

/**
 * Why an issue write counts as "the task became available for the board to
 * pair": it was created ready, or a change made a task ready (status into a
 * queue status, the owner taken off, its caste label or its blockers changed).
 */
export interface SwarmIssueEventInput {
  issueId: string;
  status: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  /** Which fields the write touched (`create` passes none and `created: true`). */
  created?: boolean;
  touched?: readonly string[];
}

const AVAILABILITY_FIELDS = new Set([
  "status",
  "assigneeAgentId",
  "assigneeUserId",
  "labelIds",
  "blockedByIssueIds",
  "executionState",
]);

const READY_STATUSES = new Set<string>(SWARM_CLAIM_QUEUE_ISSUE_STATUSES);

/** Pure: does this write make a task available for the matcher? */
export function issueEventMakesTaskAvailable(input: SwarmIssueEventInput): boolean {
  if (input.assigneeAgentId) return false;
  if (!input.status || !READY_STATUSES.has(input.status)) return false;
  if (input.created) return true;
  return (input.touched ?? []).some((field) => AVAILABILITY_FIELDS.has(field));
}

function dispatch(label: string, id: string, run: (s: SwarmEventSink) => Promise<unknown>, delayMs: number) {
  const current = sink;
  if (!current) return;
  const fire = () => {
    // A sink replaced or removed in the meantime is honoured: the call goes to
    // whoever is installed when the event is delivered.
    const live = sink;
    if (!live) return;
    // `Promise.resolve().then` so a sink that throws before it returns a promise
    // is caught here too, not raised out of the microtask as an unhandled error.
    void Promise.resolve().then(() => run(live)).catch((err) => {
      logger.warn({ err, id }, `swarm matcher failed on ${label}`);
    });
  };
  if (delayMs > 0) {
    const timer = setTimeout(fire, delayMs);
    timer.unref?.();
  } else {
    queueMicrotask(fire);
  }
}

/**
 * The issue service calls this after a create or update. `deferMs` is for a
 * write inside the caller's own transaction, whose commit this function cannot
 * see: the pairing then waits a moment (a task the matcher cannot see yet
 * matches nothing, and the periodic pass catches it).
 */
export function notifySwarmIssueEvent(input: SwarmIssueEventInput, opts: { deferMs?: number } = {}): void {
  try {
    if (!issueEventMakesTaskAvailable(input)) return;
    dispatch("issue event", input.issueId, (s) => s.forIssue(input.issueId), opts.deferMs ?? 0);
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "swarm issue event dropped");
  }
}

/** The agent was freed by something other than a run end (a pause lifted). */
export function notifySwarmAgentEvent(agentId: string, opts: { deferMs?: number } = {}): void {
  try {
    dispatch("agent event", agentId, (s) => s.forAgent(agentId), opts.deferMs ?? 0);
  } catch (err) {
    logger.warn({ err, agentId }, "swarm agent event dropped");
  }
}
