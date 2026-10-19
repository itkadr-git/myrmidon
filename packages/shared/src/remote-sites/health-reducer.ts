export type SiteHealthResult = "success" | "timeout" | "invalid_certificate" | "incompatible_protocol";
export type SiteHealthState = "unknown" | "healthy" | "degraded" | "unreachable" | "draining" | "quarantined";
export type SiteHealthIntent = "drain" | "failover" | "quarantine";

export interface SiteHealthSnapshot {
  state: SiteHealthState;
  lastSeenAt: number | null;
  missCount: number;
  unavailableSince: number | null;
  manualDrain: boolean;
  pinnedBotCount: number;
  failoverIssued: boolean;
}

export interface SiteHealthInput {
  previous: SiteHealthSnapshot;
  now: number;
  result: SiteHealthResult;
  resourceDegraded?: boolean;
}

export interface SiteHealthOutput extends SiteHealthSnapshot {
  intents: SiteHealthIntent[];
}

export const SITE_HEALTH_POLL_INTERVAL_MS = 30_000;
export const SITE_HEALTH_TIMEOUT_MS = 5_000;
export const SITE_HEALTH_MISS_THRESHOLD = 3;
export const SITE_HEALTH_FAILOVER_AFTER_MS = 10 * 60_000;

const EMPTY_INTENTS: SiteHealthIntent[] = [];

/** Pure transition function. Callers own polling, persistence, and intent execution. */
export function reduceSiteHealth(input: SiteHealthInput): SiteHealthOutput {
  const { previous, now, result, resourceDegraded = false } = input;
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp");
  const intents: SiteHealthIntent[] = [];
  let state = previous.state;
  let lastSeenAt = previous.lastSeenAt;
  let missCount = previous.missCount;
  let unavailableSince = previous.unavailableSince;

  if (result === "invalid_certificate" || result === "incompatible_protocol") {
    state = "quarantined";
    if (previous.state !== "quarantined") intents.push("quarantine");
    return { ...previous, state, failoverIssued: previous.failoverIssued, intents };
  }

  if (result === "success") {
    lastSeenAt = now;
    missCount = 0;
    unavailableSince = null;
    if (!previous.manualDrain && previous.state !== "quarantined") {
      state = resourceDegraded ? "degraded" : "healthy";
    }
    return { ...previous, state, lastSeenAt, missCount, unavailableSince, failoverIssued: false, intents };
  }

  unavailableSince ??= now;
  missCount += 1;
  if (missCount >= SITE_HEALTH_MISS_THRESHOLD && state !== "quarantined") {
    state = previous.manualDrain ? "draining" : "unreachable";
    if (!previous.manualDrain && previous.state !== "unreachable" && previous.state !== "draining") intents.push("drain");
  }
  if (now - unavailableSince >= SITE_HEALTH_FAILOVER_AFTER_MS && previous.pinnedBotCount === 0 && !previous.failoverIssued) {
    intents.push("failover");
  }
  return {
    ...previous,
    state,
    missCount,
    unavailableSince,
    failoverIssued: previous.failoverIssued || intents.includes("failover"),
    intents: intents.length ? intents : EMPTY_INTENTS,
  };
}

export function createSiteHealthSnapshot(overrides: Partial<SiteHealthSnapshot> = {}): SiteHealthSnapshot {
  return { state: "unknown", lastSeenAt: null, missCount: 0, unavailableSince: null, manualDrain: false, pinnedBotCount: 0, failoverIssued: false, ...overrides };
}
