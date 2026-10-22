// server/src/myrmidon/litellm-fallback-signal/status.ts
//
// myrmidon(BOT-RUNTIME-TUNING D2): the live per-agent view of the last sweep.
//
// The attention signal (`attention.ts`) exists only while an agent is above the
// threshold; the agent card needs the other half too — "this bot's calls were
// served from outside its card N% of the window" — so an operator can see the
// number before it becomes a card, and can tell a healthy bot from a bot that
// was never evaluated.
//
// The sweep records one snapshot per company per pass, keyed by company, in the
// process. This is a status view, not a store: the board reads it from the
// endpoint, the gateway spend log stays the single truth, and no table is added
// (the same decision the signal registry makes). A snapshot older than the
// sweep interval simply means the sweep is off or the company has no attributed
// calls — the view reports `evaluatedAt` instead of hiding that.
//
// The effective numbers in the view come from the resolved settings of the
// request, so the agent card shows the threshold the sweep itself will obey.

import type {
  FallbackSignalSettingKey,
  FallbackSignalSettingSource,
  ResolvedFallbackSignalSettings,
} from "@paperclipai/shared";
import { shareTripsSignal, type FallbackShare, type FallbackSignalSettings } from "./attention.js";

export interface FallbackStatusRow {
  agentId: string;
  /** Attributed gateway calls of the agent in the window. */
  total: number;
  /** Of those, calls served by a model outside the agent's card. */
  fallbacks: number;
  sharePct: number;
  /** Models that served the fallback calls, most frequent first. */
  servedModels: string[];
  /** The signal is up for this agent: at or above the threshold with enough calls. */
  aboveThreshold: boolean;
}

export interface FallbackStatusSnapshot {
  /** ISO timestamp of the sweep that produced the rows. */
  at: string;
  thresholdPct: number;
  minCalls: number;
  windowSec: number;
  rows: FallbackStatusRow[];
}

/** One row per evaluated agent; agents whose card decides are not in the list. */
export function buildFallbackStatusRows(
  shares: FallbackShare[],
  settings: FallbackSignalSettings,
): FallbackStatusRow[] {
  return shares.map((share) => ({
    agentId: share.agentId,
    total: share.total,
    fallbacks: share.fallbacks,
    sharePct: share.sharePct,
    servedModels: share.servedModels,
    aboveThreshold: shareTripsSignal(share, settings),
  }));
}

const statusByCompany = new Map<string, FallbackStatusSnapshot>();

/** Records one sweep's rows for a company; an empty pass replaces the old rows. */
export function recordFallbackStatus(companyId: string, snapshot: FallbackStatusSnapshot): void {
  statusByCompany.set(companyId, snapshot);
}

/** The company's last snapshot, or null when it was never swept. */
export function readFallbackStatus(companyId: string): FallbackStatusSnapshot | null {
  return statusByCompany.get(companyId) ?? null;
}

/** Drops one company's snapshot (the signal is off for it, or it was deleted). */
export function clearFallbackStatus(companyId: string): void {
  statusByCompany.delete(companyId);
}

/** Test helper and the "the signal was switched off" path: forget every snapshot. */
export function resetFallbackStatus(): void {
  statusByCompany.clear();
}

/** What `GET /api/myrmidon/companies/:companyId/model-fallback/status` returns. */
export interface FallbackStatusView extends FallbackStatusSnapshot {
  companyId: string;
  /** The effective switch: with it off the sweep records nothing and rows go stale. */
  enabled: boolean;
  /** Sweep period in seconds, so a reader can tell how old a snapshot may be. */
  intervalSec: number;
  /** Where each effective value came from (`settings`, `env` or `default`). */
  sources: Record<FallbackSignalSettingKey, FallbackSignalSettingSource>;
  /** ISO timestamp of the last sweep, or null when this company was never swept. */
  evaluatedAt: string | null;
}

export function fallbackStatusView(
  companyId: string,
  resolved: ResolvedFallbackSignalSettings,
): FallbackStatusView {
  const snapshot = readFallbackStatus(companyId);
  return {
    companyId,
    enabled: resolved.settings.enabled,
    thresholdPct: resolved.settings.thresholdPct,
    minCalls: resolved.settings.minCalls,
    windowSec: resolved.settings.windowSec,
    intervalSec: resolved.settings.intervalSec,
    sources: resolved.sources,
    evaluatedAt: snapshot?.at ?? null,
    at: snapshot?.at ?? new Date(0).toISOString(),
    rows: snapshot?.rows ?? [],
  };
}