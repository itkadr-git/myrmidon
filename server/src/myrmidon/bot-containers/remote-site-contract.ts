// server/src/myrmidon/bot-containers/remote-site-contract.ts
//
// myrmidon(1.6.6-REMOTE-SITES): Request/response schemas, state validation,
// and health/error parsing for remote execution sites (e.g. fleetd on myr-vm1).
//
// The board (management plane on vm-core) manages remote containers through
// an authenticated, one-way HTTP/mTLS client. This module provides strict
// schemas and parsers for the site-agent contract:
//   - GET /v1/health -> RemoteSiteHealthResponse
//   - POST /v1/leases/claim -> RemoteSiteLeaseClaimResponse
//   - POST /v1/leases/release -> void
//   - GET /v1/bots/{botKey}/status -> RemoteSiteBotStatus
//   - Pinned image digests (sha256) and enrollment limit checks
//
// Strict error discipline: zero secrets, no raw paths, bounded lengths.

import type { BotContainerState } from "./driver.js";

export const VALID_SITE_STATUSES = [
  "healthy",
  "degraded",
  "unavailable",
  "fenced",
  "recovering",
] as const;

export type RemoteSiteStatus = (typeof VALID_SITE_STATUSES)[number];

export interface RemoteSiteCapacity {
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
}

export interface RemoteSiteAllocated {
  cpuCores: number;
  memoryMb: number;
  pids: number;
  containersCount: number;
}

export interface RemoteSiteEgressCheck {
  ok: boolean;
  timestamp: string;
  failedTargets?: readonly string[];
}

export interface RemoteSiteActiveLease {
  executionId: string;
  botKey: string;
  leaseEpoch: number;
  expiresAt: string;
}

export interface RemoteSiteHealthResponse {
  siteId: string;
  epoch: number;
  status: RemoteSiteStatus;
  capacity: RemoteSiteCapacity;
  allocated?: RemoteSiteAllocated;
  egressCheck?: RemoteSiteEgressCheck;
  activeLeases?: readonly RemoteSiteActiveLease[];
  version?: string;
}

export interface RemoteSiteLeaseClaimRequest {
  executionId: string;
  botKey: string;
  leaseEpoch: number;
  ttlSec: number;
}

export interface RemoteSiteLeaseClaimResponse {
  acquired: boolean;
  leaseEpoch: number;
  expiresAt: string;
  fenced: boolean;
  reason?: string;
}

export interface RemoteSiteLeaseReleaseRequest {
  executionId: string;
  botKey: string;
  leaseEpoch: number;
}

export interface RemoteSiteBotStatus {
  botKey: string;
  state: BotContainerState;
  image?: string;
  restartHash?: string;
  filesHash?: string;
  gatewayPort?: number;
  maxConcurrentRuns?: number;
}

export interface RemoteSiteEnrollmentLimits {
  maxMemoryMb: number;
  maxCpus: number;
  maxPids: number;
}

export class RemoteSiteContractError extends Error {
  constructor(
    readonly status: number,
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ? `site-agent ${status} ${reasonCode}: ${message}` : `site-agent ${status} ${reasonCode}`);
    this.name = "RemoteSiteContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PINNED_DIGEST_PATTERN = /^[a-zA-Z0-9_.:/-]+@sha256:[a-f0-9]{64}$/;

/**
 * Checks whether an image reference is pinned by a full sha256 digest.
 * Tag-only references (e.g. `:latest` or `:v1.0.0`) are rejected.
 */
export function isPinnedImageDigest(image: string): boolean {
  if (typeof image !== "string") return false;
  return PINNED_DIGEST_PATTERN.test(image.trim());
}

/**
 * Validates an image against an allowlist of glob/prefix patterns.
 * If allowlist is empty, nothing is allowed.
 */
export function checkImageAllowlist(image: string, allowlist: readonly string[]): boolean {
  const trimmed = image.trim();
  if (!isPinnedImageDigest(trimmed)) return false;
  if (!allowlist || allowlist.length === 0) return false;

  for (const pattern of allowlist) {
    const pat = pattern.trim();
    if (!pat) continue;
    if (pat === "*") return true;
    if (pat.endsWith("*")) {
      const prefix = pat.slice(0, -1);
      if (trimmed.startsWith(prefix)) return true;
    } else if (trimmed === pat) {
      return true;
    }
  }
  return false;
}

/**
 * Validates bot container resource limits against enrolled site quotas.
 */
export function checkEnrolledLimits(
  spec: { memoryMb: number; cpus: number; pidsLimit: number },
  enrolled: RemoteSiteEnrollmentLimits,
): { ok: boolean; violation?: string } {
  if (spec.memoryMb > enrolled.maxMemoryMb) {
    return { ok: false, violation: "limit_exceeds_memory_enrollment" };
  }
  if (spec.cpus > enrolled.maxCpus) {
    return { ok: false, violation: "limit_exceeds_cpu_enrollment" };
  }
  if (spec.pidsLimit > enrolled.maxPids) {
    return { ok: false, violation: "limit_exceeds_pids_enrollment" };
  }
  return { ok: true };
}

/**
 * Strictly parses and validates GET /v1/health response payload.
 */
export function parseRemoteSiteHealthResponse(raw: unknown): RemoteSiteHealthResponse {
  if (!isRecord(raw)) {
    throw new RemoteSiteContractError(502, "invalid_health_shape", "health response must be an object");
  }

  const siteId = typeof raw.siteId === "string" ? raw.siteId.trim() : "";
  if (!siteId) {
    throw new RemoteSiteContractError(502, "missing_site_id", "health response missing valid siteId");
  }

  const epoch = raw.epoch;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    throw new RemoteSiteContractError(502, "invalid_epoch", "health epoch must be a non-negative integer");
  }

  const status = raw.status as RemoteSiteStatus;
  if (!VALID_SITE_STATUSES.includes(status)) {
    throw new RemoteSiteContractError(502, "invalid_site_status", `unknown site status: ${String(raw.status)}`);
  }

  if (!isRecord(raw.capacity)) {
    throw new RemoteSiteContractError(502, "missing_capacity", "health response missing capacity");
  }
  const cap = raw.capacity;
  const cpuCores = typeof cap.cpuCores === "number" && cap.cpuCores >= 0 ? cap.cpuCores : -1;
  const memoryMb = typeof cap.memoryMb === "number" && Number.isInteger(cap.memoryMb) && cap.memoryMb >= 0 ? cap.memoryMb : -1;
  const diskGb = typeof cap.diskGb === "number" && cap.diskGb >= 0 ? cap.diskGb : -1;
  if (cpuCores < 0 || memoryMb < 0 || diskGb < 0) {
    throw new RemoteSiteContractError(502, "invalid_capacity_values", "capacity fields must be non-negative numbers");
  }

  const result: RemoteSiteHealthResponse = {
    siteId,
    epoch,
    status,
    capacity: { cpuCores, memoryMb, diskGb },
  };

  if (isRecord(raw.allocated)) {
    const alloc = raw.allocated;
    result.allocated = {
      cpuCores: typeof alloc.cpuCores === "number" ? alloc.cpuCores : 0,
      memoryMb: typeof alloc.memoryMb === "number" ? alloc.memoryMb : 0,
      pids: typeof alloc.pids === "number" ? alloc.pids : 0,
      containersCount: typeof alloc.containersCount === "number" ? alloc.containersCount : 0,
    };
  }

  if (isRecord(raw.egressCheck)) {
    result.egressCheck = {
      ok: raw.egressCheck.ok === true,
      timestamp: typeof raw.egressCheck.timestamp === "string" ? raw.egressCheck.timestamp : new Date().toISOString(),
      ...(Array.isArray(raw.egressCheck.failedTargets)
        ? { failedTargets: raw.egressCheck.failedTargets.filter((x): x is string => typeof x === "string") }
        : {}),
    };
  }

  if (Array.isArray(raw.activeLeases)) {
    result.activeLeases = raw.activeLeases
      .filter(isRecord)
      .map((l) => ({
        executionId: typeof l.executionId === "string" ? l.executionId : "",
        botKey: typeof l.botKey === "string" ? l.botKey : "",
        leaseEpoch: typeof l.leaseEpoch === "number" ? l.leaseEpoch : 0,
        expiresAt: typeof l.expiresAt === "string" ? l.expiresAt : "",
      }))
      .filter((l) => l.executionId && l.botKey);
  }

  if (typeof raw.version === "string") {
    result.version = raw.version.trim();
  }

  return result;
}

/**
 * Validates a lease claim request before transmitting to site-agent.
 */
export function validateRemoteSiteLeaseClaimRequest(raw: unknown): RemoteSiteLeaseClaimRequest {
  if (!isRecord(raw)) {
    throw new RemoteSiteContractError(400, "invalid_lease_request", "lease claim request must be an object");
  }

  const executionId = typeof raw.executionId === "string" ? raw.executionId.trim() : "";
  if (!executionId) {
    throw new RemoteSiteContractError(400, "missing_execution_id", "executionId is required");
  }

  const botKey = typeof raw.botKey === "string" ? raw.botKey.trim() : "";
  if (!botKey || !BOT_KEY_PATTERN.test(botKey)) {
    throw new RemoteSiteContractError(400, "invalid_bot_key", `invalid botKey: ${String(raw.botKey)}`);
  }

  const leaseEpoch = raw.leaseEpoch;
  if (typeof leaseEpoch !== "number" || !Number.isInteger(leaseEpoch) || leaseEpoch <= 0) {
    throw new RemoteSiteContractError(400, "invalid_lease_epoch", "leaseEpoch must be a positive integer");
  }

  const ttlSec = raw.ttlSec;
  if (typeof ttlSec !== "number" || !Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > 3600) {
    throw new RemoteSiteContractError(400, "invalid_ttl", "ttlSec must be between 1 and 3600");
  }

  return { executionId, botKey, leaseEpoch, ttlSec };
}

/**
 * Parses POST /v1/leases/claim response from site-agent.
 */
export function parseRemoteSiteLeaseClaimResponse(raw: unknown): RemoteSiteLeaseClaimResponse {
  if (!isRecord(raw)) {
    throw new RemoteSiteContractError(502, "invalid_lease_response", "lease response must be an object");
  }

  const acquired = raw.acquired === true;
  const fenced = raw.fenced === true;
  const leaseEpoch = typeof raw.leaseEpoch === "number" ? raw.leaseEpoch : 0;
  const expiresAt = typeof raw.expiresAt === "string" ? raw.expiresAt : "";
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 200) : undefined;

  return { acquired, leaseEpoch, expiresAt, fenced, ...(reason ? { reason } : {}) };
}

/**
 * Parses and validates bot container status returned by site-agent.
 */
export function validateRemoteSiteBotStatus(raw: unknown): RemoteSiteBotStatus {
  if (!isRecord(raw)) {
    throw new RemoteSiteContractError(502, "invalid_status_shape", "status response must be an object");
  }

  const botKey = typeof raw.botKey === "string" ? raw.botKey.trim() : "";
  if (!botKey || !BOT_KEY_PATTERN.test(botKey)) {
    throw new RemoteSiteContractError(502, "invalid_bot_key", "botKey in status is invalid");
  }

  const state = raw.state;
  if (state !== "running" && state !== "stopped" && state !== "missing" && state !== "unhealthy") {
    throw new RemoteSiteContractError(502, "invalid_state", `unknown state: ${String(state)}`);
  }

  const res: RemoteSiteBotStatus = { botKey, state };

  if (typeof raw.image === "string") res.image = raw.image;
  if (typeof raw.restartHash === "string") res.restartHash = raw.restartHash;
  if (typeof raw.filesHash === "string") res.filesHash = raw.filesHash;
  if (typeof raw.maxConcurrentRuns === "number") res.maxConcurrentRuns = raw.maxConcurrentRuns;

  if (raw.gatewayPort !== undefined && raw.gatewayPort !== null) {
    const port = raw.gatewayPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new RemoteSiteContractError(502, "invalid_gateway_port", `gatewayPort must be valid port: ${String(port)}`);
    }
    res.gatewayPort = port;
  }

  return res;
}

/**
 * Formats a canonical one-line error code according to site-agent error discipline.
 */
export function formatRemoteSiteError(status: number, reason: string): string {
  const code = reason.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 100);
  return `${status} ${code}\n`;
}

/**
 * Parses an error response from site-agent, extracting the reason code.
 */
export function parseRemoteSiteError(status: number, rawBody: string): { status: number; reason: string } {
  const line = (rawBody || "").split("\n")[0].trim().slice(0, 200);
  return { status, reason: line || "unknown_site_error" };
}
