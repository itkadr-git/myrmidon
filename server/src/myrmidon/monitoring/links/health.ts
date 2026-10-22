// server/src/myrmidon/monitoring/links/health.ts
//
// myrmidon(1.6.6 MONITORING E): what "this link is alive" means, as pure data.
//
// A linking component (Zabbix aggregator, Alertmanager webhook, collector)
// holds its own board key with a `monitoring_link` scope. Liveness is measured
// from that key: a key that is revoked or past its expiry is dead on arrival,
// and a key nobody has used for `staleAfterSec` means the link stopped talking
// to the board. Both are exactly the failure that left the High aggregator
// blind for four days — a key that died quietly while every downstream trigger
// kept having "no data" and nobody owned the silence.
//
// This file holds no I/O: the caller passes the key rows and the clock, which
// is what lets the watchdog tests pin the detection latency instead of waiting
// ten real minutes for it.

import type { MonitoringLinkScope } from "@paperclipai/shared";

/** The subset of a board key row a link's liveness depends on. */
export interface MonitoringLinkKeyRow {
  keyId: string;
  keyName: string;
  scope: MonitoringLinkScope;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** Health of the key itself, independent of how recently it was used. */
export type MonitoringLinkKeyState = "ok" | "expired" | "revoked";

/** Why a link is unhealthy; "healthy" is the only non-alarming verdict. */
export type MonitoringLinkVerdict = "healthy" | "key_revoked" | "key_expired" | "no_pulse";

/** The verdicts that raise the High alarm, strongest first. */
export const MONITORING_LINK_ALERT_VERDICTS = [
  "key_revoked",
  "key_expired",
  "no_pulse",
] as const;

export type MonitoringLinkAlertVerdict = (typeof MONITORING_LINK_ALERT_VERDICTS)[number];

export interface MonitoringLinkHealth {
  keyId: string;
  keyName: string;
  linkKey: string;
  companyId: string;
  staleAfterSec: number;
  alertAssigneeAgentId: string | null;
  keyState: MonitoringLinkKeyState;
  /** When the board last heard from the link; null when it never has. */
  lastPulseAt: string | null;
  /** Seconds since the last pulse, or since the key was issued. */
  pulseAgeSec: number;
  verdict: MonitoringLinkVerdict;
  unhealthy: boolean;
}

function secondsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 1000));
}

export function monitoringLinkKeyState(
  row: Pick<MonitoringLinkKeyRow, "expiresAt" | "revokedAt">,
  now: Date,
): MonitoringLinkKeyState {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}

/**
 * The instant a link was last known to be alive: its last use of its own key,
 * or the moment the key was issued when it has never been used. Counting the
 * issue time as the baseline is what makes "the key was never wired up" alarm
 * too, instead of looking healthy forever because no pulse ever went stale.
 */
export function monitoringLinkPulseBaseline(
  row: Pick<MonitoringLinkKeyRow, "createdAt" | "lastUsedAt">,
): Date {
  return row.lastUsedAt ?? row.createdAt;
}

export function evaluateMonitoringLink(
  row: MonitoringLinkKeyRow,
  now: Date,
): MonitoringLinkHealth {
  const keyState = monitoringLinkKeyState(row, now);
  const baseline = monitoringLinkPulseBaseline(row);
  const pulseAgeSec = secondsBetween(baseline.getTime(), now.getTime());
  const staleAfterSec = row.scope.staleAfterSec;

  let verdict: MonitoringLinkVerdict = "healthy";
  if (keyState === "revoked") verdict = "key_revoked";
  else if (keyState === "expired") verdict = "key_expired";
  else if (pulseAgeSec > staleAfterSec) verdict = "no_pulse";

  return {
    keyId: row.keyId,
    keyName: row.keyName,
    linkKey: row.scope.linkKey,
    companyId: row.scope.companyId,
    staleAfterSec,
    alertAssigneeAgentId: row.scope.alertAssigneeAgentId ?? null,
    keyState,
    lastPulseAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    pulseAgeSec,
    verdict,
    unhealthy: verdict !== "healthy",
  };
}

export function evaluateMonitoringLinks(
  rows: MonitoringLinkKeyRow[],
  now: Date,
): MonitoringLinkHealth[] {
  return rows
    .map((row) => evaluateMonitoringLink(row, now))
    .sort((a, b) => a.linkKey.localeCompare(b.linkKey));
}

/**
 * One alarm per (key, reason): a link that stays broken through a hundred
 * sweeps keeps one open task, while a link that fails for a new reason (it
 * stopped pulsing, then the key expired) gets a second one instead of burying
 * the new reason under the old task.
 */
export function monitoringLinkAlertIdempotencyKey(
  keyId: string,
  verdict: MonitoringLinkAlertVerdict,
): string {
  return `monitoring-link:${keyId}:${verdict}`;
}