// Board self-deploy (myrmidon 1.7 AUTO-UPDATE-SETTINGS B): the policy of an
// update — WHEN it may run (the maintenance window), WHO starts it (the
// operator's click, or the release tag after a human approval) and HOW the bot
// fleet follows it (the canary batch first, the rest only when that batch is
// healthy).
//
// Everything in this file is pure: settings parsing, the window arithmetic, the
// canary plan and the canary verdict. No clock reads, no I/O — the caller
// passes `now`. The values come from the interface
// (instance_settings.general.myrmidonAutoUpdate) with MYRMIDON_DEPLOY_UPDATE_*
// as a forced override, and every knob carries where its value came from
// (AutoUpdateValueSource), because the settings screen shows the source of each
// value.
//
// The scheduler half lives in service.ts: a verified job whose window is shut
// waits in `waiting_window` (it is not a timeout — the window may be days
// away), and a board that switched healthy hands the fleet to the canary batch
// before the rest may follow.
//
// Design: docs/myrmidon/design/deploy-from-ui.md.
// Guide: docs/myrmidon/guides/deploy-auto-update.md.

export type AutoUpdateMode = "manual" | "auto_release";

export const AUTO_UPDATE_MODES: readonly AutoUpdateMode[] = ["manual", "auto_release"];

/**
 * The weekly maintenance window: the days it opens on and the UTC clock hours
 * it covers. `days: []` is deliberately the default and means "no window is
 * set" — an instance that never configured one keeps deploying whenever the
 * operator clicks, exactly as before this setting existed.
 */
export interface AutoUpdateWindow {
  /** Weekdays the window opens on: 0 = Sunday … 6 = Saturday. Empty = no window. */
  days: number[];
  /** Window start, minutes from midnight UTC (0..1439). */
  fromMinute: number;
  /** Window end, minutes from midnight UTC (0..1439). Below fromMinute = it crosses midnight. */
  toMinute: number;
}

export interface AutoUpdateCanary {
  /** Split the fleet: the canary batch first, the rest only when it is healthy. */
  enabled: boolean;
  /** Share of the fleet in the first (canary) batch, percent 1..100. */
  sharePercent: number;
  /** The canary batch never holds fewer bots than this (at least one). */
  minBots: number;
  /** The canary batch never holds more bots than this. */
  maxBots: number;
  /** Seconds the canary batch's health is watched before the rest may follow. */
  healthSettleSec: number;
}

/**
 * A release a human approved by hand (the autonomy matrix: a production deploy
 * is confirmed by a person). The digest is what the approval pins — the tag
 * alone is a moving name. `jobId` is filled by the scheduler when the approved
 * release actually started, so an approval starts exactly one job.
 */
export interface AutoUpdateApproval {
  tag: string;
  digest: string;
  version: string | null;
  approvedBy: { actorType: string; actorId: string };
  approvedAt: string;
  jobId: string | null;
}

export interface AutoUpdateSettings {
  mode: AutoUpdateMode;
  window: AutoUpdateWindow;
  canary: AutoUpdateCanary;
  /** Newest first; bounded by AUTO_UPDATE_APPROVAL_LIMIT. */
  approvals: AutoUpdateApproval[];
}

export const AUTO_UPDATE_APPROVAL_LIMIT = 10;

export function defaultAutoUpdateSettings(): AutoUpdateSettings {
  return {
    mode: "manual",
    // Sunday 03:00–05:00 UTC is the fleet's own maintenance hour, but nothing
    // is gated until an operator picks days: see the window docs above.
    window: { days: [], fromMinute: 3 * 60, toMinute: 5 * 60 },
    canary: { enabled: true, sharePercent: 25, minBots: 1, maxBots: 4, healthSettleSec: 300 },
    approvals: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
  }
  return fallback;
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Weekdays as a sorted, de-duplicated 0..6 list; anything else drops out. */
export function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = new Set<number>();
  for (const item of value) {
    const parsed = typeof item === "number" ? item : typeof item === "string" ? Number(item.trim()) : Number.NaN;
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 6) days.add(parsed);
  }
  return [...days].sort((a, b) => a - b);
}

/** "HH:MM" (or minutes) as minutes from midnight, or null when it is not one. */
export function parseClock(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 1439 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** "HH:MM" for the interface and the logs. */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Mon,Wed 03:00–05:00 UTC" — the one line the screen and the job steps share. */
export function describeWindow(window: AutoUpdateWindow): string {
  if (window.days.length === 0) return "no maintenance window";
  const days = window.days.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join(",");
  const overnight = window.toMinute < window.fromMinute ? " (overnight)" : "";
  const wholeDay = window.toMinute === window.fromMinute ? " (the whole day)" : "";
  return `${days} ${formatClock(window.fromMinute)}–${formatClock(window.toMinute)} UTC${overnight}${wholeDay}`;
}

/** Read the stored document defensively: anything malformed falls back to its default. */
export function parseAutoUpdateSettings(raw: unknown): AutoUpdateSettings {
  const defaults = defaultAutoUpdateSettings();
  if (!isRecord(raw)) return defaults;
  const mode = AUTO_UPDATE_MODES.includes(raw.mode as AutoUpdateMode) ? (raw.mode as AutoUpdateMode) : defaults.mode;
  const rawWindow = isRecord(raw.window) ? raw.window : {};
  const rawCanary = isRecord(raw.canary) ? raw.canary : {};
  const window: AutoUpdateWindow = {
    days: rawWindow.days === undefined ? defaults.window.days : normalizeDays(rawWindow.days),
    fromMinute: readInt(rawWindow.fromMinute, defaults.window.fromMinute, 0, 1439),
    toMinute: readInt(rawWindow.toMinute, defaults.window.toMinute, 0, 1439),
  };
  const canary: AutoUpdateCanary = {
    enabled: readBool(rawCanary.enabled, defaults.canary.enabled),
    sharePercent: readInt(rawCanary.sharePercent, defaults.canary.sharePercent, 1, 100),
    minBots: readInt(rawCanary.minBots, defaults.canary.minBots, 1, 100),
    maxBots: readInt(rawCanary.maxBots, defaults.canary.maxBots, 1, 100),
    healthSettleSec: readInt(rawCanary.healthSettleSec, defaults.canary.healthSettleSec, 0, 86_400),
  };
  if (canary.minBots > canary.maxBots) canary.maxBots = canary.minBots;
  const approvals: AutoUpdateApproval[] = Array.isArray(raw.approvals)
    ? raw.approvals.filter(isRecord).map(parseApproval).filter((a): a is AutoUpdateApproval => a !== null)
    : [];
  return { mode, window, canary, approvals: approvals.slice(0, AUTO_UPDATE_APPROVAL_LIMIT) };
}

function parseApproval(raw: Record<string, unknown>): AutoUpdateApproval | null {
  const tag = typeof raw.tag === "string" ? raw.tag.trim() : "";
  const digest = typeof raw.digest === "string" ? raw.digest.trim() : "";
  if (!tag || !digest) return null;
  const by = isRecord(raw.approvedBy) ? raw.approvedBy : {};
  return {
    tag,
    digest,
    version: typeof raw.version === "string" ? raw.version : null,
    approvedBy: { actorType: String(by.actorType ?? ""), actorId: String(by.actorId ?? "") },
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : "",
    jobId: typeof raw.jobId === "string" ? raw.jobId : null,
  };
}

export interface WindowState {
  /** false when the instance has no window: the deploy may start at any time. */
  configured: boolean;
  open: boolean;
  /** ISO time the window next opens; null when no window is configured or it is open. */
  opensAt: string | null;
  /** ISO time the open window closes; null when the window is not open. */
  closesAt: string | null;
  /** One line for the interface and the job steps. */
  reason: string;
}

function minutesOfDay(at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

function startOfUtcDay(at: Date, dayOffset: number): number {
  const base = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + dayOffset, 0, 0, 0, 0);
  return base;
}

/**
 * Where the maintenance window stands at `now`, and when it opens next. A
 * window that crosses midnight belongs to the day it OPENS on: `days: [1]`,
 * `23:00–01:00` opens Monday 23:00 and closes Tuesday 01:00. `fromMinute ===
 * toMinute` is the whole listed day (a 24-hour window), never an empty one — a
 * configuration that could never open would silently stop every deploy.
 */
export function windowState(window: AutoUpdateWindow, now: Date): WindowState {
  const days = normalizeDays(window.days);
  if (days.length === 0) {
    return {
      configured: false,
      open: true,
      opensAt: null,
      closesAt: null,
      reason: "no maintenance window set: the deploy may start at any time",
    };
  }
  const from = window.fromMinute;
  const to = window.toMinute;
  const duration = to > from ? to - from : 1440 - from + to;
  const here = now.getTime();

  let opensAt: number | null = null;
  for (let offset = -1; offset <= 8; offset += 1) {
    const dayStart = startOfUtcDay(now, offset);
    const weekday = new Date(dayStart).getUTCDay();
    if (!days.includes(weekday)) continue;
    const start = dayStart + from * 60_000;
    const end = start + (duration === 1440 ? 86_400_000 : duration * 60_000);
    if (here >= start && here < end) {
      return {
        configured: true,
        open: true,
        opensAt: null,
        closesAt: new Date(end).toISOString(),
        reason: `inside the maintenance window (${describeWindow(window)}): the deploy may start`,
      };
    }
    if (start > here && (opensAt === null || start < opensAt)) opensAt = start;
  }
  return {
    configured: true,
    open: false,
    opensAt: opensAt === null ? null : new Date(opensAt).toISOString(),
    closesAt: null,
    reason:
      opensAt === null
        ? `outside the maintenance window (${describeWindow(window)}): it never opens again — check the days`
        : `outside the maintenance window (${describeWindow(window)}): it opens ${new Date(opensAt).toISOString()}`,
  };
}

export interface CanaryPlan {
  enabled: boolean;
  /** Bots of the canary batch: they switch first. */
  canary: string[];
  /** Bots that may only follow a healthy canary batch. */
  rest: string[];
  /** The share actually applied, in percent of the fleet. */
  sharePercent: number;
  reason: string;
}

/**
 * Split the fleet into the canary batch and the rest (B-2: "first a share of
 * the bots / one instance, then the rest when it is healthy"). The share is a
 * percentage of the fleet clamped by min/max, and the batch is never the whole
 * fleet unless the settings ask for it (share 100 or maxBots >= the fleet):
 * that case is honest but useless as a canary, and the screen says so.
 */
export function canaryPlan(targets: readonly string[], canary: AutoUpdateCanary): CanaryPlan {
  const fleet = [...new Set(targets.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (!canary.enabled || fleet.length === 0) {
    return {
      enabled: false,
      canary: [],
      rest: fleet,
      sharePercent: 0,
      reason:
        fleet.length === 0
          ? "the fleet is empty: nothing to run a canary on"
          : "the canary is off: the fleet moves in one batch",
    };
  }
  const share = Math.min(Math.max(canary.sharePercent, 1), 100);
  let size = Math.ceil((fleet.length * share) / 100);
  size = Math.max(size, Math.max(canary.minBots, 1));
  size = Math.min(size, canary.maxBots, fleet.length);
  const reason =
    size >= fleet.length
      ? `the canary batch covers the whole fleet (${fleet.length} bot(s)): nothing follows it — lower the share or the max bots for a real canary`
      : `canary batch of ${size} of ${fleet.length} bot(s) at ${share}% first; the rest follows only when it is healthy`;
  return {
    enabled: size > 0,
    canary: fleet.slice(0, size),
    rest: fleet.slice(size),
    sharePercent: share,
    reason,
  };
}

export type CanaryPhase = "running" | "healthy" | "failed";

export interface CanaryVerdict {
  /** May the rest of the fleet move? */
  proceed: boolean;
  /** Set when the plan STOPPED: the rest never moves (the failing canary). */
  stopReason: string | null;
  detail: string;
}

/**
 * The acceptance rule of B-2: a canary batch that failed does not let the rest
 * of the fleet through. `running` is not a verdict — the caller keeps waiting.
 */
export function canaryVerdict(input: {
  phase: CanaryPhase;
  canary: readonly string[];
  rest: readonly string[];
  detail?: string | null;
}): CanaryVerdict {
  const rest = input.rest.length;
  if (input.phase === "running") {
    return { proceed: false, stopReason: null, detail: `the canary batch (${input.canary.length} bot(s)) is still being watched` };
  }
  if (input.phase === "failed") {
    return {
      proceed: false,
      stopReason: `the canary batch failed${input.detail ? `: ${input.detail}` : ""}; the remaining ${rest} bot(s) were NOT switched`,
      detail: "canary failed: the rest of the fleet does not move",
    };
  }
  return {
    proceed: true,
    stopReason: null,
    detail: `the canary batch is healthy${input.detail ? ` (${input.detail})` : ""}; the remaining ${rest} bot(s) may follow`,
  };
}

export interface AutoUpdateStart {
  /** May the scheduler itself start a job right now? */
  allowed: boolean;
  reason: string;
  window: WindowState;
  /** The approved release that has not started a job yet, when the mode allows one. */
  candidate: AutoUpdateApproval | null;
}

/**
 * The scheduler's half of "auto by release tag after an approval": in `manual`
 * mode nothing starts without a click; in `auto_release` mode the oldest
 * approval that has not started a job waits for the window, and only an open
 * window lets the scheduler create the job. The click path is unaffected — an
 * operator may deploy by hand in either mode.
 */
export function autoUpdateStart(input: { settings: AutoUpdateSettings; now: Date }): AutoUpdateStart {
  const window = windowState(input.settings.window, input.now);
  if (input.settings.mode !== "auto_release") {
    return {
      allowed: false,
      reason: "manual mode: the deploy starts from the interface, not by the release tag",
      window,
      candidate: null,
    };
  }
  const candidate = input.settings.approvals.find((approval) => approval.jobId === null) ?? null;
  if (!candidate) {
    return { allowed: false, reason: "auto mode: no approved release is waiting", window, candidate: null };
  }
  if (!window.open) {
    return {
      allowed: false,
      reason: `release ${candidate.tag} is approved and waits for the window: ${window.reason}`,
      window,
      candidate,
    };
  }
  return {
    allowed: true,
    reason: `release ${candidate.tag} is approved and the window is open: starting the deploy`,
    window,
    candidate,
  };
}

// ---------------------------------------------------------------------------
// Where a value came from: the interface, a forced override, or the default.
// ---------------------------------------------------------------------------

export type AutoUpdateValueSource = "ui" | "env" | "default";

export interface AutoUpdateResolution {
  settings: AutoUpdateSettings;
  sources: {
    mode: AutoUpdateValueSource;
    window: AutoUpdateValueSource;
    canary: AutoUpdateValueSource;
  };
  /** The env variables that are overriding an interface value, for the screen. */
  overridden: string[];
}

function readEnvBool(env: NodeJS.ProcessEnv, name: string): boolean | null {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function readEnvInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * The settings as they will be executed: the interface value, overridden by
 * MYRMIDON_DEPLOY_UPDATE_* when that variable is set (a forced override is for
 * the host that cannot be edited from the screen — the screen shows it and the
 * value cannot be changed there). The approvals are never overridable: a human
 * approval is either recorded or not.
 */
export function resolveAutoUpdateSettings(stored: AutoUpdateSettings, env: NodeJS.ProcessEnv = process.env): AutoUpdateResolution {
  const defaults = defaultAutoUpdateSettings();
  const settings: AutoUpdateSettings = {
    mode: stored.mode,
    window: { ...stored.window, days: [...stored.window.days] },
    canary: { ...stored.canary },
    approvals: stored.approvals,
  };
  const sources = { mode: "ui", window: "ui", canary: "ui" } as AutoUpdateResolution["sources"];
  const overridden: string[] = [];

  const envMode = env.MYRMIDON_DEPLOY_UPDATE_MODE?.trim().toLowerCase();
  if (envMode) {
    if (AUTO_UPDATE_MODES.includes(envMode as AutoUpdateMode)) {
      settings.mode = envMode as AutoUpdateMode;
      sources.mode = "env";
      overridden.push("MYRMIDON_DEPLOY_UPDATE_MODE");
    }
  } else if (stored.mode === defaults.mode) {
    sources.mode = "default";
  }

  const envDays = env.MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS?.trim();
  const envFrom = parseClock(env.MYRMIDON_DEPLOY_UPDATE_WINDOW_FROM?.trim() ?? "");
  const envTo = parseClock(env.MYRMIDON_DEPLOY_UPDATE_WINDOW_TO?.trim() ?? "");
  if (envDays !== undefined && envDays !== "") {
    settings.window.days = normalizeDays(envDays.split(",").map((day) => day.trim()));
    sources.window = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_WINDOW_DAYS");
  }
  if (envFrom !== null) {
    settings.window.fromMinute = envFrom;
    sources.window = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_WINDOW_FROM");
  }
  if (envTo !== null) {
    settings.window.toMinute = envTo;
    sources.window = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_WINDOW_TO");
  }
  if (sources.window === "ui" && sameWindow(stored.window, defaults.window)) sources.window = "default";

  const envCanary = readEnvBool(env, "MYRMIDON_DEPLOY_UPDATE_CANARY");
  const envShare = readEnvInt(env, "MYRMIDON_DEPLOY_UPDATE_CANARY_SHARE", 1, 100);
  const envMin = readEnvInt(env, "MYRMIDON_DEPLOY_UPDATE_CANARY_MIN_BOTS", 1, 100);
  const envMax = readEnvInt(env, "MYRMIDON_DEPLOY_UPDATE_CANARY_MAX_BOTS", 1, 100);
  const envSettle = readEnvInt(env, "MYRMIDON_DEPLOY_UPDATE_CANARY_SETTLE_SEC", 0, 86_400);
  if (envCanary !== null) {
    settings.canary.enabled = envCanary;
    sources.canary = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_CANARY");
  }
  if (envShare !== null) {
    settings.canary.sharePercent = envShare;
    sources.canary = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_CANARY_SHARE");
  }
  if (envMin !== null) {
    settings.canary.minBots = envMin;
    sources.canary = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_CANARY_MIN_BOTS");
  }
  if (envMax !== null) {
    settings.canary.maxBots = envMax;
    sources.canary = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_CANARY_MAX_BOTS");
  }
  if (envSettle !== null) {
    settings.canary.healthSettleSec = envSettle;
    sources.canary = "env";
    overridden.push("MYRMIDON_DEPLOY_UPDATE_CANARY_SETTLE_SEC");
  }
  if (settings.canary.minBots > settings.canary.maxBots) settings.canary.maxBots = settings.canary.minBots;
  if (sources.canary === "ui" && sameCanary(stored.canary, defaults.canary)) sources.canary = "default";

  return { settings, sources, overridden };
}

function sameWindow(a: AutoUpdateWindow, b: AutoUpdateWindow): boolean {
  return a.fromMinute === b.fromMinute && a.toMinute === b.toMinute && a.days.length === b.days.length && a.days.every((day, index) => day === b.days[index]);
}

function sameCanary(a: AutoUpdateCanary, b: AutoUpdateCanary): boolean {
  return (
    a.enabled === b.enabled &&
    a.sharePercent === b.sharePercent &&
    a.minBots === b.minBots &&
    a.maxBots === b.maxBots &&
    a.healthSettleSec === b.healthSettleSec
  );
}