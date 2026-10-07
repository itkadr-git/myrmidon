// myrmidon(W2b): bot container status and "Apply now" for the agent card.
// GET/POST /api/myrmidon/agents/:id/bot-container/{status,apply}
// (server/src/myrmidon/bot-containers/routes.ts).
// myrmidon(1.6.5 ASYNC-BOT-APPLY-UI): apply is asynchronous — POST answers
// 202 { applyId, status } and the outcome is polled through
// GET .../apply/:applyId (part A: ope-5403a-async-bot-apply).
import { api, ApiError } from "@/api/client";

export type BotContainerState = "running" | "stopped" | "missing" | "unhealthy";

/** myrmidon(CONCURRENCY-SYNC): the board's concurrency limit against the one the bot's
 *  gateway was actually given (server/src/myrmidon/bot-containers/concurrency-sync.ts). */
export interface GatewayConcurrencyStatus {
  board: number;
  applied: number | null;
  diverged: boolean;
  checkedAt: string;
}

/** myrmidon(1.6.4-BOT-CONTAINER-CARD): how the release bot-image rollout treats this bot. */
export type BotImageTracking =
  | { category: "tracks_release"; image: string }
  | { category: "pinned"; image: string | null; reason: string }
  | { category: "not_applicable"; image: null; reason: string };

export interface BotContainerStatus {
  /** The instance switch for bot containers is on. */
  enabled: boolean;
  /** The instance has a container runtime wired. */
  runtimeConfigured: boolean;
  /** The SAVED card is an enabled, complete container config. */
  eligible: boolean;
  /** Why the saved card is not eligible. */
  reason: string | null;
  /** Image patterns this instance allows; empty means no image is allowed. */
  imageAllowlist: string[];
  /** Whether the saved image matches the allowlist; null without a saved image. */
  imageAllowed: boolean | null;
  container: { state: BotContainerState; image: string | null } | null;
  containerError: string | null;
  /** Tracks the release / pinned (with the image) / not applicable (with why). Absent on an older server. */
  imageTracking?: BotImageTracking;
  /** myrmidon(BOT-ROLLOUT): the release rollout verdict — on the release image, or why
   *  not (busy / no release image configured / pinned / not applicable). Absent on an
   *  older server. targetImage is null: the rollout resolves the exact release image
   *  from the registry at deploy time, so the server has none to report. */
  imageRollout?: { onReleaseImage: boolean; targetImage: string | null; reason: string | null };
  /** runtimeConfig.heartbeat.maxConcurrentRuns, normalized by the server. */
  boardMaxConcurrentRuns: number;
  /** Board value against the applied one; null when there is nothing to compare. */
  gatewayConcurrency: GatewayConcurrencyStatus | null;
  /** Why gatewayConcurrency is null, or a caveat about its value. */
  gatewayConcurrencyNote: string | null;
  /** The gateway limits runs below the board's limit (unmanaged gateway, recently 429). */
  gatewayConcurrencyWarning: string | null;
}

export type BotContainerApplyOutcome =
  | { kind: "created" }
  | { kind: "applied_files" }
  | { kind: "applied_restart" }
  | { kind: "unchanged" }
  | { kind: "deferred"; reason: string }
  | { kind: "error"; message: string };

/**
 * myrmidon(1.6.5 ASYNC-BOT-APPLY-UI): the journal status of one background
 * apply pass (server apply-jobs.ts; part A ope-5403a-async-bot-apply).
 */
export type BotApplyJobStatus = "pending" | "running" | "succeeded" | "failed";

/** The 202 body of POST .../apply. `outcome` is only present on a server that
 *  predates ASYNC-BOT-APPLY (the synchronous route answered 200 with it); the
 *  UI keeps working with both so part B can merge before part A. */
export interface BotApplyAccepted {
  applyId?: string;
  status?: BotApplyJobStatus;
  outcome?: BotContainerApplyOutcome;
}

/** The GET .../apply/:applyId body — read from the database only. */
export interface BotApplyStatusResponse {
  status: BotApplyJobStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export const botContainerStatusKey = (agentId: string) => ["myrmidon", "bot-container", agentId, "status"] as const;

const base = (agentId: string) => `/myrmidon/agents/${encodeURIComponent(agentId)}/bot-container`;

export const botContainerApi = {
  status: (agentId: string) => api.get<BotContainerStatus>(`${base(agentId)}/status`),
  apply: (agentId: string) => api.post<BotApplyAccepted>(`${base(agentId)}/apply`, {}),
  applyStatus: (agentId: string, applyId: string) =>
    api.get<BotApplyStatusResponse>(`${base(agentId)}/apply/${encodeURIComponent(applyId)}`),
};

export type ApplyFeedback = { kind: "ok" | "warn" | "error"; message: string };

export function describeApplyOutcome(outcome: BotContainerApplyOutcome): ApplyFeedback {
  switch (outcome.kind) {
    case "created":
      return { kind: "ok", message: "Container created and started." };
    case "applied_files":
      return { kind: "ok", message: "Profile files updated in the running container." };
    case "applied_restart":
      return { kind: "ok", message: "Profile updated and the gateway restarted." };
    case "unchanged":
      return { kind: "ok", message: "Nothing to change: the container already matches the card." };
    case "deferred":
      return { kind: "warn", message: `Not applied yet: ${outcome.reason}` };
    default:
      return { kind: "error", message: `Apply failed: ${outcome.message}` };
  }
}

/** The request failed before or instead of an outcome. The server's own message is
 *  kept for the cases where it says something the person can act on. */
export function describeApplyError(error: unknown): ApplyFeedback {
  if (error instanceof ApiError) {
    const code = typeof (error.body as { code?: unknown } | null)?.code === "string"
      ? (error.body as { code: string }).code
      : null;
    if (code === "bot_containers_disabled") {
      return { kind: "error", message: "Bot containers are not enabled on this instance." };
    }
    if (code === "bot_container_runtime_unavailable") {
      return { kind: "error", message: "The bot container runtime is not configured on this instance." };
    }
    if (error.status === 502) return { kind: "error", message: `Apply failed: ${error.message}` };
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: error instanceof Error ? error.message : "Apply failed." };
}

// --- myrmidon(1.6.5 ASYNC-BOT-APPLY-UI) --------------------------------------
//
// "Apply now" is queued, not awaited (part A, ASYNC-BOT-APPLY): the POST
// answers 202 + applyId and the pass runs in the background. The UI polls
// GET .../apply/:applyId every APPLY_POLL_INTERVAL_MS, for at most
// APPLY_POLL_TIMEOUT_MS, and shows the outcome — the failure text included —
// on the card. The live apply id is kept in sessionStorage so a page reload
// in the first minutes resumes the same job instead of losing its outcome;
// APPLY_JOB_RESUME_WINDOW_MS bounds how long a stored job may be resumed.

export const APPLY_POLL_INTERVAL_MS = 2000;
export const APPLY_POLL_TIMEOUT_MS = 120_000;
export const APPLY_JOB_RESUME_WINDOW_MS = 10 * 60_000;

export const APPLY_PROGRESS_TEXT =
  "Applying… the pass runs in the background; the result appears here when it finishes.";
export const APPLY_TIMEOUT_TEXT =
  "The apply is still running after two minutes. Check again in a few minutes.";

export interface StoredApplyJob {
  applyId: string;
  /** Wall-clock ms of the POST that produced (or resumed) this job — the
   *  deadline of the current polling round counts from it. */
  startedAtMs: number;
}

export function applyJobStorageKey(agentId: string): string {
  return `myrmidon.bot-apply-job.${encodeURIComponent(agentId)}`;
}

function sessionStorageSafe(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function storeApplyJob(agentId: string, applyId: string, startedAtMs: number): void {
  sessionStorageSafe()?.setItem(applyJobStorageKey(agentId), JSON.stringify({ applyId, startedAtMs }));
}

export function clearStoredApplyJob(agentId: string): void {
  try {
    sessionStorageSafe()?.removeItem(applyJobStorageKey(agentId));
  } catch {
    /* a storage that throws on remove is as dead as one without the key */
  }
}

/** The job a reload should resume polling for: the stored one when it is a
 *  well-formed id inside the resume window, null otherwise (a corrupt or
 *  stale entry is dropped, never trusted). */
export function readStoredApplyJob(agentId: string, nowMs: number): StoredApplyJob | null {
  const raw = sessionStorageSafe()?.getItem(applyJobStorageKey(agentId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { applyId?: unknown; startedAtMs?: unknown };
    if (typeof parsed.applyId !== "string" || parsed.applyId.length === 0) return null;
    if (typeof parsed.startedAtMs !== "number" || !Number.isFinite(parsed.startedAtMs)) return null;
    if (nowMs - parsed.startedAtMs > APPLY_JOB_RESUME_WINDOW_MS) return null;
    return { applyId: parsed.applyId, startedAtMs: parsed.startedAtMs };
  } catch {
    return null;
  }
}

function formatApplyTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

/** The card feedback a polled job answers with, or null while the pass is
 *  still live (`pending`/`running`) and polling must continue. `failed`
 *  carries the server's error text — the outcome a presser needs is shown
 *  on screen, not only logged. */
export function describeApplyJobStatus(job: BotApplyStatusResponse): ApplyFeedback | null {
  switch (job.status) {
    case "succeeded":
      return {
        kind: "ok",
        message: job.finishedAt ? `Applied at ${formatApplyTime(job.finishedAt)}.` : "Applied.",
      };
    case "failed":
      return {
        kind: "error",
        message: `Apply failed: ${job.error ?? "the apply job did not record a reason."}`,
      };
    default:
      return null;
  }
}
