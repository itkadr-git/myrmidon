// server/src/myrmidon/litellm-fallback-signal/attention.ts
//
// myrmidon(BOT-RUNTIME-TUNING D): the attention signal behind "the bot was
// silently served a different model".
//
// A quiet model swap is invisible on the agent card: the bot asks for model X,
// the gateway's router falls back to model Y, and both the bot and the board
// keep believing X was used. The gateway's spend log is the one place where
// the swap leaves a trace: every row carries the api_key (sha256 of the
// caller's virtual key) and the model the request was billed under. The
// discriminator chosen from the live probe (see the issue thread): a spend row
// is a FALLBACK for an agent when its model is not in the agent's card model
// set (model + models.vision/video/stt/tts + models.fallbacks, the same
// normalization agent-model-validation.ts applies: trim, drop "default"/"auto").
// When more than N% of the agent's calls in the window are fallbacks, the
// agent gets one attention card; when the share drops below N/2, the card
// disappears.
//
// This module owns the pure policy and the process-level registry the feed
// reads; the sweep (sweep.ts) keeps the registry fresh on a timer, the same
// split tracing-health uses. No new table: the feed recomputes on every list.

import type { AttentionSeverity } from "@paperclipai/shared";
// myrmidon(BOT-RUNTIME-TUNING D2): the settings contract of the signal (stored
// instance settings over environment over defaults).
import {
  DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC,
  DEFAULT_FALLBACK_SIGNAL_MIN_CALLS,
  DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT,
  DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC,
  FALLBACK_SIGNAL_ENV_KEYS,
  fallbackSignalIntervalMs,
  fallbackSignalWindowMs,
  readFallbackSignalSettingsFromEnv,
  type FallbackSignalSettings as StoredFallbackSignalSettings,
} from "@paperclipai/shared";

export const FALLBACK_ATTENTION_DEDUP_PREFIX = "model_fallback:";
export const FALLBACK_ATTENTION_ACTION_TRANSITION = "myrmidon.model_fallback.signal";

/** Stable per-agent dedup key: one card per agent regardless of window churn. */
export function fallbackDedupKey(agentId: string): string {
  return `${FALLBACK_ATTENTION_DEDUP_PREFIX}${agentId}`;
}

// ---------------------------------------------------------------------------
// Settings (resolved by the sweep and the settings API, not here)
// ---------------------------------------------------------------------------
//
// myrmidon(BOT-RUNTIME-TUNING D2): the values now come from the shared contract
// — the stored instance settings, then a set environment variable, then the
// built-in default (see `@paperclipai/shared`, myrmidon-fallback-signal). This
// module keeps the millisecond shape the sweep works in, and the names the
// deployment already uses keep their meaning.

export const FALLBACK_ENABLED_ENV = FALLBACK_SIGNAL_ENV_KEYS.enabled;
export const FALLBACK_THRESHOLD_PCT_ENV = FALLBACK_SIGNAL_ENV_KEYS.thresholdPct;
export const FALLBACK_MIN_CALLS_ENV = FALLBACK_SIGNAL_ENV_KEYS.minCalls;
export const FALLBACK_WINDOW_SEC_ENV = FALLBACK_SIGNAL_ENV_KEYS.windowSec;
export const FALLBACK_INTERVAL_SEC_ENV = FALLBACK_SIGNAL_ENV_KEYS.intervalSec;

export const DEFAULT_FALLBACK_THRESHOLD_PCT = DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT;
export const DEFAULT_FALLBACK_MIN_CALLS = DEFAULT_FALLBACK_SIGNAL_MIN_CALLS;
export const DEFAULT_FALLBACK_WINDOW_SEC = DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC;
export const DEFAULT_FALLBACK_SWEEP_INTERVAL_SEC = DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC;

export interface FallbackSignalSettings {
  /** Master switch; off unless explicitly "1"/"true" — deployment values default off. */
  enabled: boolean;
  /** Window in ms the share is computed over. */
  windowMs: number;
  /** Fallback share (percent) at which the card appears. */
  thresholdPct: number;
  /** Minimum attributed calls in the window before the agent is evaluated. */
  minCalls: number;
  /** Sweep period in ms. */
  intervalMs: number;
}

/** The shared contract's seconds into the milliseconds the sweep counts in. */
export function toFallbackSignalSettings(stored: StoredFallbackSignalSettings): FallbackSignalSettings {
  return {
    enabled: stored.enabled,
    windowMs: fallbackSignalWindowMs(stored),
    thresholdPct: stored.thresholdPct,
    minCalls: stored.minCalls,
    intervalMs: fallbackSignalIntervalMs(stored),
  };
}

/**
 * Effective settings from the environment alone, with the built-in defaults.
 * The sweep uses the stored-aware resolver (settings.ts) instead; this stays
 * for callers that only have an environment — and it is the reader the module
 * had before the stored settings existed, unchanged in behaviour.
 */
export function readFallbackSignalSettings(env: NodeJS.ProcessEnv = process.env): FallbackSignalSettings {
  return toFallbackSignalSettings(readFallbackSignalSettingsFromEnv(env));
}

// ---------------------------------------------------------------------------
// Pure policy: card model set + fallback share
// ---------------------------------------------------------------------------

/** Values that mean "let the adapter decide" and never count as a model. */
const SPECIAL_MODEL_VALUES = ["default", "auto"];

function normalizedNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !SPECIAL_MODEL_VALUES.includes(item.toLowerCase()));
}

function readPath(config: Record<string, unknown> | null | undefined, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * The card's model allowlist: the primary model, the auxiliary model fields
 * and the fallback chain. A spend row whose model is outside this set was
 * served a model the card never asked for.
 */
export function cardModelSet(adapterConfig: Record<string, unknown> | null | undefined): Set<string> {
  const models = new Set<string>();
  if (!adapterConfig || typeof adapterConfig !== "object") return models;
  for (const field of ["model", "models.vision", "models.video", "models.stt", "models.tts", "models.fallbacks"]) {
    for (const name of normalizedNames(readPath(adapterConfig, field))) models.add(name);
  }
  return models;
}

/** One attributed gateway call, as the fallback policy sees it. */
export interface FallbackCall {
  agentId: string;
  model: string;
  startTime: string;
}

export interface FallbackShare {
  agentId: string;
  total: number;
  fallbacks: number;
  sharePct: number;
  /** Models that served the fallback calls, most frequent first. */
  servedModels: string[];
}

/**
 * The fallback share per agent over the window, counting only calls with a
 * known model set. Agents whose card carries no model names at all (a card
 * that lets the adapter decide) are never evaluated: every model would count
 * as a fallback and the card would fire on a healthy bot.
 */
export function fallbackShares(
  calls: FallbackCall[],
  modelSetByAgent: Map<string, Set<string>>,
): FallbackShare[] {
  interface Tally { total: number; fallbacks: number; byModel: Map<string, number> }
  const tallies = new Map<string, Tally>();
  for (const call of calls) {
    const models = modelSetByAgent.get(call.agentId);
    if (!models || models.size === 0) continue; // card decides: nothing to compare against
    const model = typeof call.model === "string" && call.model.trim() ? call.model.trim() : "";
    if (!model) continue;
    const tally = tallies.get(call.agentId) ?? { total: 0, fallbacks: 0, byModel: new Map<string, number>() };
    tally.total += 1;
    if (!models.has(model)) {
      tally.fallbacks += 1;
      tally.byModel.set(model, (tally.byModel.get(model) ?? 0) + 1);
    }
    tallies.set(call.agentId, tally);
  }
  const shares: FallbackShare[] = [];
  for (const [agentId, tally] of tallies) {
    const servedModels = [...tally.byModel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
    shares.push({
      agentId,
      total: tally.total,
      fallbacks: tally.fallbacks,
      sharePct: tally.total === 0 ? 0 : Math.round((tally.fallbacks / tally.total) * 100),
      servedModels,
    });
  }
  return shares.sort((a, b) => b.sharePct - a.sharePct || a.agentId.localeCompare(b.agentId));
}

/**
 * Entry: the share is at or above the threshold and the call count clears
 * min-calls. Exit: below half the threshold (hysteresis — a share hovering
 * around the threshold must not blink the card) or under min-calls.
 */
export function shareTripsSignal(share: FallbackShare, settings: FallbackSignalSettings): boolean {
  if (share.total < settings.minCalls) return false;
  return share.sharePct >= settings.thresholdPct;
}

export function shareClearsSignal(share: FallbackShare, settings: FallbackSignalSettings): boolean {
  if (share.total < settings.minCalls) return true;
  return share.sharePct < settings.thresholdPct / 2;
}

// ---------------------------------------------------------------------------
// The signal object the attention feed turns into a card
// ---------------------------------------------------------------------------

export interface ModelFallbackAttentionSignal {
  dedupKey: string;
  agentId: string;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  summaryExcerpt: string;
  sharePct: number;
  fallbacks: number;
  total: number;
  servedModels: string[];
  /** ISO timestamp of the sweep that produced the signal. */
  activityAt: string;
}

/** The card text: share, threshold and the models that actually served. */
export function fallbackWhyNow(share: FallbackShare, settings: FallbackSignalSettings): string {
  const served = share.servedModels.slice(0, 3).join(", ");
  const servedSuffix = share.servedModels.length > 3 ? ` (+${share.servedModels.length - 3} more)` : "";
  return (
    `${share.sharePct}% of this bot's ${share.total} gateway calls in the last window were served by a model ` +
    `outside its card (threshold ${settings.thresholdPct}%): served by ${served}${servedSuffix}. ` +
    "Check the gateway router's fallback topology and the card's model list."
  );
}

export function fallbackSignalForShare(
  share: FallbackShare,
  settings: FallbackSignalSettings,
  activityAt: string,
): ModelFallbackAttentionSignal {
  return {
    dedupKey: fallbackDedupKey(share.agentId),
    agentId: share.agentId,
    severity: "medium",
    title: "Model fallback above threshold",
    whyNow: fallbackWhyNow(share, settings),
    summaryExcerpt: `${share.fallbacks}/${share.total} calls served by ${share.servedModels.slice(0, 3).join(", ")}`,
    sharePct: share.sharePct,
    fallbacks: share.fallbacks,
    total: share.total,
    servedModels: share.servedModels,
    activityAt,
  };
}

// ---------------------------------------------------------------------------
// Process-level registry the attention feed reads
// ---------------------------------------------------------------------------

const signalByCompany = new Map<string, ModelFallbackAttentionSignal[]>();

/** Records one sweep's signals for a company; an empty list clears them. */
export function recordModelFallbackSignals(companyId: string, signals: ModelFallbackAttentionSignal[]): void {
  if (signals.length === 0) {
    signalByCompany.delete(companyId);
    return;
  }
  signalByCompany.set(companyId, signals);
}

/** The company's current signals, or an empty array when none. */
export function readModelFallbackSignals(companyId: string): ModelFallbackAttentionSignal[] {
  return signalByCompany.get(companyId) ?? [];
}

/** Forget every recorded signal: the sweep's switch went off, and tests. */
export function resetModelFallbackSignals(): void {
  signalByCompany.clear();
}
