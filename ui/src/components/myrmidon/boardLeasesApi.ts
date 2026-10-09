// Leader-lease block of the "Processes" panel (myrmidon 1.6.6 PROCS-1.7 B,
// design the board-processes design §5.1/§7.2): what the board holds a lease on right now, read
// from the API without restarting anything.
//
// DATA CONTRACT — part A of part A of the lease-route task owns the route; this module is its only
// UI-side reader. Mocked with docs/myrmidon/board-leases-contract/*.json until
// part A merges (the two part branches do not touch the same files: A is
// server/, B is ui/).
//
//   GET /api/myrmidon/processes/leases
//   200 {
//     "leases": [
//       {
//         "name": "scheduler",                    // board_leases.name (PK)
//         "holderBootId": "boot-aaa111",           // board_leases.holder_boot_id
//         "epoch": 12,                             // board_leases.epoch (bigint; a string is accepted)
//         "acquiredAt": "2026-10-08T21:00:00.000Z",// board_leases.acquired_at
//         "expiresAt": "2026-10-08T21:00:30.000Z", // board_leases.expires_at
//         "expired": false,                        // optional: the block derives it from expiresAt
//         "isSelf": true,                          // optional: the process answering this request holds it
//         "holder": {                              // join of board_processes, null when the row is gone
//           "bootId": "boot-aaa111",
//           "role": "worker",
//           "pid": 4242,
//           "hostname": "board-1",
//           "container": "myrmidon-api-1",
//           "version": "1.6.5",
//           "lastSeenAt": "2026-10-08T21:00:28.000Z"
//         }
//       }
//     ],
//     "selfBootId": "boot-aaa111",                  // optional
//     "serverTime": "2026-10-08T21:00:30.000Z"      // optional; expiry math without browser clock skew
//   }
//
// The reader is deliberately tolerant, so a field part A names differently
// degrades to "no data for that cell" instead of an exception: a bare array is
// accepted in place of the envelope, `epoch` may arrive as a numeric string,
// `holder` may be absent, and every leaf may be null (a lease whose owning
// process is gone). Nothing here throws on a malformed body.
import { api } from "@/api/client";

export const BOARD_LEASES_PATH = "/myrmidon/processes/leases";
export const boardLeasesQueryKey = ["myrmidon", "processes", "leases"] as const;
/** The block polls instead of holding a socket: a handover is visible within
 *  one interval (design the board-processes design §7.2). */
export const BOARD_LEASES_REFETCH_MS = 10_000;
/** Live event the API may publish on a handover; the block invalidates on it in
 *  addition to polling. Not in LIVE_EVENT_TYPES yet — hence the defensive
 *  string check in isLeaderChangedEvent(). */
export const BOARD_LEASES_LIVE_EVENT = "leader_changed";

export interface BoardLeaseHolder {
  bootId: string | null;
  role: string | null;
  pid: number | null;
  hostname: string | null;
  container: string | null;
  version: string | null;
  lastSeenAt: string | null;
}

export interface BoardLease {
  name: string;
  holderBootId: string | null;
  epoch: number | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  /** Server-side verdict when present; the block falls back to expiresAt. */
  expired: boolean | null;
  /** Server-side verdict when present; the block falls back to selfBootId. */
  isSelf: boolean | null;
  holder: BoardLeaseHolder | null;
}

export interface BoardLeasesState {
  leases: BoardLease[];
  selfBootId: string | null;
  serverTime: string | null;
}

export type LeaseExpiryState = "active" | "expired" | "unknown";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** board_leases.epoch is a bigint on the wire: accept "12" as well as 12. */
export function readEpoch(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function parseHolder(raw: unknown): BoardLeaseHolder | null {
  const holder = asRecord(raw);
  if (!holder) return null;
  return {
    bootId: readString(holder.bootId),
    role: readString(holder.role),
    pid: readNumber(holder.pid),
    hostname: readString(holder.hostname),
    container: readString(holder.container),
    version: readString(holder.version),
    lastSeenAt: readString(holder.lastSeenAt),
  };
}

/** A lease row without a name is unusable and is dropped; everything else is
 *  optional, so a partially-written row still shows up. */
export function parseBoardLease(raw: unknown): BoardLease | null {
  const lease = asRecord(raw);
  if (!lease) return null;
  const name = readString(lease.name);
  if (!name) return null;
  return {
    name,
    holderBootId: readString(lease.holderBootId),
    epoch: readEpoch(lease.epoch),
    acquiredAt: readString(lease.acquiredAt),
    expiresAt: readString(lease.expiresAt),
    expired: readBoolean(lease.expired),
    isSelf: readBoolean(lease.isSelf),
    holder: parseHolder(lease.holder),
  };
}

export function parseBoardLeasesState(raw: unknown): BoardLeasesState {
  const envelope = Array.isArray(raw) ? { leases: raw } : asRecord(raw);
  if (!envelope) return { leases: [], selfBootId: null, serverTime: null };
  const rows = Array.isArray(envelope.leases) ? envelope.leases : [];
  return {
    leases: rows
      .map(parseBoardLease)
      .filter((lease): lease is BoardLease => lease !== null),
    selfBootId: readString(envelope.selfBootId),
    serverTime: readString(envelope.serverTime),
  };
}

/** Active, expired, or nothing to compare against (no expiry written yet). */
export function leaseExpiryState(
  lease: Pick<BoardLease, "expired" | "expiresAt">,
  nowMs: number,
): LeaseExpiryState {
  const expiresAtMs = lease.expiresAt ? Date.parse(lease.expiresAt) : Number.NaN;
  if (lease.expired === true) return "expired";
  if (Number.isFinite(expiresAtMs)) return expiresAtMs <= nowMs ? "expired" : "active";
  return lease.expired === false ? "active" : "unknown";
}

/** "I am the leader" is about the process answering the request: the server's
 *  isSelf wins, selfBootId is the fallback, and neither being present is
 *  reported as unknown rather than guessed. */
export function leaseIsSelf(
  lease: Pick<BoardLease, "isSelf" | "holderBootId">,
  selfBootId: string | null,
): boolean | null {
  if (lease.isSelf !== null) return lease.isSelf;
  if (lease.holderBootId && selfBootId) return lease.holderBootId === selfBootId;
  return null;
}

export function shortBootId(value: string | null): string | null {
  return value ? value.slice(0, 8) : null;
}

/** Rendered in UTC with an explicit suffix: the panel reads the same in every
 *  browser timezone, and a lease timeline is compared against server logs. */
export function formatLeaseTimestamp(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The live-event half of the subscription. Unknown event types are ignored. */
export function isLeaderChangedEvent(event: unknown): boolean {
  const record = asRecord(event);
  return record !== null && record.type === BOARD_LEASES_LIVE_EVENT;
}

export const boardLeasesApi = {
  get: async (): Promise<BoardLeasesState> =>
    parseBoardLeasesState(await api.get<unknown>(BOARD_LEASES_PATH)),
};