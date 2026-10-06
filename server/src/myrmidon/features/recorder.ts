// myrmidon(FEATURES): in-process outcome recorder.
//
// A module that runs on a timer and has no table of its own (the bot disk
// sweep, the cost collection pass, the swarm sweeper) reports each pass here:
// "this pass worked, here is what it did" or "this pass failed, here is why".
// The features page turns the record into the last successful run, the error
// count and the effect metric over 24 hours.
//
// State is per process and bounded; it is lost on a restart, and the health
// step then says "no pass since start" instead of guessing. Durable signals
// (activity_log, run tables) are read by the definitions directly.

import { FEATURE_HEALTH_WINDOW_MS } from "@paperclipai/shared";
import { redactSensitiveText } from "../../redaction.js";

/** Cap on the stored events per feature: a pass every second for 24 h would be 86 400. */
const MAX_EVENTS_PER_FEATURE = 2_000;
const MAX_MESSAGE_CHARS = 300;

export interface FeatureOutcomeInput {
  ok: boolean;
  /** Why the pass failed. Redacted and truncated before it is stored. */
  error?: string;
  /** How much the pass did, in the unit of the feature's effect metric (summed over 24 h). */
  effect?: number;
  /** Free-form facts of the pass for the definition to read back (last pass only). */
  detail?: Record<string, unknown>;
  at?: Date;
}

interface StoredEvent {
  at: number;
  ok: boolean;
  effect: number;
}

interface FeatureRecord {
  events: StoredEvent[];
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastDetail: Record<string, unknown> | null;
  errorTimes: number[];
}

export interface OutcomeSummary {
  /** The last pass of any outcome, or null when no pass ran since the process started. */
  lastRunAt: Date | null;
  lastOk: boolean | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  errors24h: number;
  runs24h: number;
  effect24h: number;
  lastDetail: Record<string, unknown> | null;
}

const records = new Map<string, FeatureRecord>();

function recordFor(key: string): FeatureRecord {
  let record = records.get(key);
  if (!record) {
    record = {
      events: [],
      lastRunAt: null,
      lastOk: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      lastDetail: null,
      errorTimes: [],
    };
    records.set(key, record);
  }
  return record;
}

/** Strip secrets and bound the length: the text reaches the board UI. */
export function sanitizeOutcomeMessage(message: string): string {
  let text = message;
  try {
    text = redactSensitiveText(message);
  } catch {
    text = "error (message withheld)";
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

export function recordFeatureOutcome(key: string, input: FeatureOutcomeInput): void {
  const at = (input.at ?? new Date()).getTime();
  const record = recordFor(key);
  record.lastRunAt = at;
  record.lastOk = input.ok;
  record.lastDetail = input.detail ?? null;
  record.events.push({ at, ok: input.ok, effect: Math.max(0, input.effect ?? 0) });
  if (record.events.length > MAX_EVENTS_PER_FEATURE) record.events.shift();
  if (input.ok) {
    record.lastSuccessAt = at;
    return;
  }
  record.lastErrorAt = at;
  record.lastError = sanitizeOutcomeMessage(input.error ?? "unknown error");
  record.errorTimes.push(at);
  if (record.errorTimes.length > MAX_EVENTS_PER_FEATURE) record.errorTimes.shift();
}

/** Convenience for a catch block. */
export function recordFeatureFailure(key: string, err: unknown): void {
  recordFeatureOutcome(key, { ok: false, error: err instanceof Error ? err.message : String(err) });
}

export function summarizeFeatureOutcomes(key: string, now: Date = new Date()): OutcomeSummary {
  const record = records.get(key);
  if (!record) {
    return {
      lastRunAt: null,
      lastOk: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      errors24h: 0,
      runs24h: 0,
      effect24h: 0,
      lastDetail: null,
    };
  }
  const since = now.getTime() - FEATURE_HEALTH_WINDOW_MS;
  while (record.events.length > 0 && record.events[0]!.at < since) record.events.shift();
  while (record.errorTimes.length > 0 && record.errorTimes[0]! < since) record.errorTimes.shift();
  let effect = 0;
  for (const event of record.events) effect += event.effect;
  return {
    lastRunAt: record.lastRunAt === null ? null : new Date(record.lastRunAt),
    lastOk: record.lastOk,
    lastSuccessAt: record.lastSuccessAt === null ? null : new Date(record.lastSuccessAt),
    lastErrorAt: record.lastErrorAt === null ? null : new Date(record.lastErrorAt),
    lastError: record.lastError,
    errors24h: record.errorTimes.length,
    runs24h: record.events.length,
    effect24h: effect,
    lastDetail: record.lastDetail,
  };
}

/** Test helper: forget everything. */
export function resetFeatureOutcomes(): void {
  records.clear();
}
