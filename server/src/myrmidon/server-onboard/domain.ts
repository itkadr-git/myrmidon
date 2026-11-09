// myrmidon(SERVER-ONBOARD A): domain of the onboarding job.
//
// The board never runs SSH itself; a separate executor container claims a job
// through the API, pulls one-time secrets, runs the versioned step script on
// the node and reports after every step. This module owns the pure vocabulary:
// states, steps, log entries, transitions. Design: docs/myrmidon/design/
// server-onboard.md (issue OPE-3420), part A = connect, preflight, access,
// verify.

import { randomUUID } from "node:crypto";

export const ONBOARD_JOB_KINDS = ["onboard", "recheck", "decommission"] as const;
export type OnboardJobKind = (typeof ONBOARD_JOB_KINDS)[number];

export const ONBOARD_JOB_STATUSES = ["pending", "claimed", "running", "succeeded", "failed", "expired"] as const;
export type OnboardJobStatus = (typeof ONBOARD_JOB_STATUSES)[number];

export const ONBOARD_SERVER_ROLES = ["generic", "build-runner", "sandbox", "bot-host"] as const;
export type OnboardServerRole = (typeof ONBOARD_SERVER_ROLES)[number];

export const ONBOARD_SERVER_STATES = ["new", "onboarding", "ready", "needs_attention", "decommissioned"] as const;
export type OnboardServerState = (typeof ONBOARD_SERVER_STATES)[number];

/** Part-A step order. The executor reports each by key. */
export const ONBOARD_STEPS = ["connect", "preflight", "access", "verify"] as const;
export type OnboardStep = (typeof ONBOARD_STEPS)[number];

/** Version of the step set the executor ships; recorded on the server row. */
export const ONBOARD_BOOTSTRAP_VERSION = "a1";

export interface OnboardStepLogEntry {
  step: string;
  startedAt: string;
  finishedAt: string | null;
  result: "ok" | "skipped" | "failed";
  /** Short human output, secrets masked by the executor before it is sent. */
  detail: string | null;
}

export interface OnboardJob {
  id: string;
  companyId: string;
  serverId: string;
  kind: OnboardJobKind;
  status: OnboardJobStatus;
  step: string | null;
  stepLog: OnboardStepLogEntry[];
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function isOnboardJobActive(status: OnboardJobStatus): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

export function newOnboardJob(input: {
  companyId: string;
  serverId: string;
  kind: OnboardJobKind;
  createdBy: string | null;
  now?: Date;
}): OnboardJob {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    companyId: input.companyId,
    serverId: input.serverId,
    kind: input.kind,
    status: "pending",
    step: null,
    stepLog: [],
    error: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

/** Redaction guard for step detail: the executor masks, the board re-masks. */
const SECRET_LOOKALIKE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(pcp_[A-Za-z0-9]+)|(Bearer\s+[A-Za-z0-9._-]+)/g;

export function maskStepDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.replace(SECRET_LOOKALIKE, "<redacted>").slice(0, 500);
}

export function appendStepLog(log: OnboardStepLogEntry[], entry: OnboardStepLogEntry): OnboardStepLogEntry[] {
  const next = log.filter((item) => item.step !== entry.step);
  next.push({ ...entry, detail: maskStepDetail(entry.detail) });
  return next;
}

/** Terminal-state helper for the sweep that expires abandoned jobs. */
export function jobExpired(job: OnboardJob, now: Date, timeoutMs: number): boolean {
  if (!isOnboardJobActive(job.status)) return false;
  return now.getTime() - Date.parse(job.updatedAt) > timeoutMs;
}
