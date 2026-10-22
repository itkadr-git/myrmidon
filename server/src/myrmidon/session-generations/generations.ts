// server/src/myrmidon/session-generations/generations.ts
//
// myrmidon(PERF-DIET-K): the pure core of issue-scoped session generations.
//
// Why: a container bot's task conversation lives in the bot's own Hermes state
// (`state.db`) and is addressed by the session key. With
// `sessionKeyStrategy=issue` (the default) that key never changed, so one
// task's session grew for the task's whole life — measured at 80-110 MB of
// `state.db` on a long task. The board bounds it by putting a generation into
// the key: `paperclip:company:<cid>:agent:<aid>:issue:<iid>:g<N>`. A new
// generation starts when the current one passes its age or activity threshold;
// Hermes then opens an empty session for the new key, and the wake that starts
// it carries the board's existing continuation summary, so the task keeps its
// context without keeping the whole transcript.
//
// Generation 1 is the first generation and carries no suffix: until a threshold
// is crossed the session key is byte-for-byte the vendor's, which is what keeps
// the default behaviour — and every already-running session — unchanged.
//
// Everything in this file is pure. The database is behind the reader in
// store.ts and the thresholds are in settings.ts.

/** The generation suffix, as the board writes it into the session key. */
export const SESSION_KEY_GENERATION_PATTERN = /:g(\d+)$/;

/** The generation of an issue-scoped session key; 1 when it has no suffix. */
export function sessionKeyGeneration(sessionKey: string): number {
  const match = SESSION_KEY_GENERATION_PATTERN.exec(sessionKey.trim());
  if (!match) return 1;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

/**
 * `sessionKey` with the generation suffix set to `generation` — generation 1
 * (and anything unreadable) removes the suffix, so the first generation and the
 * vendor's key are the same string.
 */
export function withSessionGeneration(sessionKey: string, generation: number): string {
  const base = sessionKey.trim().replace(SESSION_KEY_GENERATION_PATTERN, "");
  if (!Number.isFinite(generation) || generation <= 1) return base;
  return `${base}:g${Math.floor(generation)}`;
}

/** One heartbeat run of the task, as the reader selects it. */
export interface SessionGenerationRunRow {
  id: string;
  createdAt: Date | string;
  sessionIdAfter: string | null;
  sessionIdBefore: string | null;
  resultSummary?: string | null;
}

/** The state of the task's current session generation. */
export interface SessionGenerationState {
  /** The generation the recorded runs belong to; 1 = no suffix on the key. */
  generation: number;
  /** The session key of that generation, or null when no run is recorded. */
  sessionKey: string | null;
  /** The first recorded run of that generation. */
  startedAt: Date | null;
  /** Runs (wakes) recorded in that generation. */
  messages: number;
  /** The newest recorded run of the task, for the handoff note. */
  latestRunId: string | null;
  latestRunSummary: string | null;
}

export interface SessionGenerationThresholds {
  enabled: boolean;
  maxMessages: number;
  maxDays: number;
}

export interface SessionGenerationDecision {
  /** The generation the NEXT run belongs to (current, or current + 1). */
  generation: number;
  rotate: boolean;
  reason: string | null;
  /** Runs recorded in the generation the decision was taken on. */
  messages: number;
  ageDays: number | null;
}

function readRowKey(row: SessionGenerationRunRow, prefix: string): string | null {
  for (const candidate of [row.sessionIdAfter, row.sessionIdBefore]) {
    if (typeof candidate === "string" && candidate.startsWith(prefix)) return candidate;
  }
  return null;
}

function readDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reduce the task's runs (newest first, as the reader orders them) to the state
 * of its current generation.
 *
 * A run belongs to a generation when one of its session ids is the session key
 * of that generation — the gateway adapter persists exactly the key it used
 * (`heartbeat_runs.session_id_after`), which is what makes the state derivable
 * without a table of our own. Runs whose ids do not carry the task's key prefix
 * (another strategy, another adapter, another task) are ignored. With no run
 * recorded at all the task is in generation 1 with nothing behind it.
 */
export function reduceSessionGenerationRows(input: {
  rows: readonly SessionGenerationRunRow[];
  sessionKeyPrefix: string;
}): SessionGenerationState {
  const { rows, sessionKeyPrefix } = input;
  const byGeneration = new Map<number, { messages: number; startedAt: Date | null; key: string | null }>();
  let latestRunId: string | null = null;
  let latestRunSummary: string | null = null;
  for (const row of rows) {
    const key = readRowKey(row, sessionKeyPrefix);
    if (!key) continue;
    if (latestRunId === null) {
      latestRunId = row.id;
      latestRunSummary = row.resultSummary ?? null;
    }
    const generation = sessionKeyGeneration(key);
    const entry = byGeneration.get(generation) ?? { messages: 0, startedAt: null, key: null };
    entry.messages += 1;
    entry.key = entry.key ?? key;
    const createdAt = readDate(row.createdAt);
    if (createdAt && (entry.startedAt === null || createdAt.getTime() < entry.startedAt.getTime())) {
      entry.startedAt = createdAt;
    }
    byGeneration.set(generation, entry);
  }
  if (byGeneration.size === 0) {
    return {
      generation: 1,
      sessionKey: null,
      startedAt: null,
      messages: 0,
      latestRunId: null,
      latestRunSummary: null,
    };
  }
  const generation = Math.max(...byGeneration.keys());
  const entry = byGeneration.get(generation)!;
  return {
    generation,
    sessionKey: entry.key,
    startedAt: entry.startedAt,
    messages: entry.messages,
    latestRunId,
    latestRunSummary,
  };
}

/** Whole days between `startedAt` and `now`, or null without a start time. */
export function sessionGenerationAgeDays(startedAt: Date | null, now: Date): number | null {
  if (!startedAt) return null;
  const ms = now.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms) / (1000 * 60 * 60 * 24);
}

/**
 * The generation the next run belongs to.
 *
 * Activity first, then age — both strict `>` against the threshold, so a
 * generation that sits exactly on its threshold is still continued and a
 * threshold change (or a request to stop here) is never off by one. With the
 * feature off, or with neither threshold crossed, the current generation
 * continues.
 */
export function decideSessionGeneration(input: {
  state: SessionGenerationState;
  thresholds: SessionGenerationThresholds;
  now: Date;
}): SessionGenerationDecision {
  const { state, thresholds, now } = input;
  const ageDays = sessionGenerationAgeDays(state.startedAt, now);
  if (!thresholds.enabled) {
    return { generation: state.generation, rotate: false, reason: null, messages: state.messages, ageDays };
  }
  if (state.messages > thresholds.maxMessages) {
    return {
      generation: state.generation + 1,
      rotate: true,
      reason: `session generation reached ${state.messages} messages (threshold ${thresholds.maxMessages})`,
      messages: state.messages,
      ageDays,
    };
  }
  if (ageDays !== null && ageDays > thresholds.maxDays) {
    return {
      generation: state.generation + 1,
      rotate: true,
      reason: `session generation age reached ${Math.floor(ageDays)} days (threshold ${thresholds.maxDays})`,
      messages: state.messages,
      ageDays,
    };
  }
  return { generation: state.generation, rotate: false, reason: null, messages: state.messages, ageDays };
}

/**
 * The handoff note the new generation's first wake carries: the vendor's
 * session-handoff shape, so the adapter renders it the same way as a rotation
 * the vendor itself decided. The task's own continuation summary is appended by
 * the caller when it has one.
 */
export function renderSessionGenerationHandoff(input: {
  previousSessionKey: string | null;
  issueId: string;
  generation: number;
  reason: string;
  messages: number;
  latestRunSummary: string | null;
  continuationSummary?: string | null;
}): string {
  const lines = [
    "session generation handoff:",
    input.previousSessionKey ? `- Previous session: ${input.previousSessionKey}` : "",
    `- Issue: ${input.issueId}`,
    `- Rotation reason: ${input.reason}`,
    `- Messages in the previous generation: ${input.messages}`,
    input.latestRunSummary ? `- Last run summary: ${input.latestRunSummary.slice(0, 1_500)}` : "",
    input.continuationSummary ? `- Issue continuation summary: ${input.continuationSummary.slice(0, 1_500)}` : "",
    `- This run starts session generation g${input.generation}; earlier turns of the task are no longer in the session.`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}